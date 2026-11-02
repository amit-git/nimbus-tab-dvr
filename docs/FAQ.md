# Nimbus Tab DVR: questions and answers

The questions a reader asks after the demo, answered against what the code does and what was measured.
Where something is not measured, the answer says so.
[How it works](how-it-works.svg) is the picture; [GRILLING.md](GRILLING.md) holds the design decisions behind these answers.

## How does the page tell the extension to start recording?

By posting a message on its own window, not by calling an API the extension injects.
The extension puts no object into the page; it injects a content script on the origins the configuration allows, and that script relays messages between the page's window and the extension's service worker.
The page posts `{ type: 'START_RECORDING', recordingKey, requestId }` with `window.postMessage`, and the reply, `RECORDING_STARTED` or `RECORDING_ERROR`, comes back on the same window carrying the same `requestId`.
`STOP_RECORDING` and `GET_RECORDING_STATUS` work the same way, and the extension posts two messages unasked, `RECORDING_FINALIZED` and `RECORDING_ENDED`.
The demo's [bridge.ts](../src/demo/bridge.ts) wraps this in a `request()` function that returns a promise; it is forty lines, and it is the whole client a host application needs.
Every message is validated in the service worker before it is acted on, and a message from an origin outside the configuration is refused, because the page is the trust boundary.

## What happens if the page crashes or navigates away?

The recording does not belong to the page.
It belongs to the tab, and it is held by two extension contexts that outlive any page: the service worker, which keeps the recording's identity in `chrome.storage.session`, and the offscreen document, an extension page whose lifetime is the extension's, which holds the capture stream and the encoder and writes every chunk to IndexedDB as it is produced.

- **A reload, or a navigation within the same origin:** the recording continues without a gap.
  The new page asks `GET_RECORDING_STATUS` on load, learns the recording is live, and rejoins it under the same key; measured in the test, the chunk count keeps climbing across the reload.
- **The tab is closed:** the captured track ends, the offscreen document flushes the encoder, writes the last chunk, uploads it, posts stop to the backend, and the backend closes the HLS playlist.
  Measured: finalized 280 ms after the close, with every chunk.
- **A navigation to another origin:** Chrome's documentation says this revokes the capture, so the recording ends the same way a close does.
  Not measured; the client's application does not do it.
- **The page's renderer crashes:** not measured.
  The tab still exists, so the expectation is that capture continues on the crash page until the tab is reloaded or closed; it needs a test before the answer is given to a client.
- **The extension's own offscreen document is killed:** the chunks already written stay in IndexedDB, and the loss is at most one timeslice plus what the encoder held.
  Measured in the spike: 4.93 of about 6 seconds kept at a two second timeslice.

## Do operators need to do something to enable the recording?

Yes, once per tab, and this is the answer most likely to be given wrong.
`chrome.tabCapture` grants capture only to a tab the user has invoked the extension on, and the spike established that force-install, the `<all_urls>` permission and every policy tried change nothing about that.
The invocation is one press of the extension's shortcut, Cmd+Shift+Y, or one click on its toolbar button, on the tab to be recorded; the grant then lasts for the life of the tab and survives reloads, so an operator presses it once when the application opens and never again for that tab.
The recording page shows this instruction when it is needed and nothing when it is not.

The one thing that removes the press is launching Chrome with `--allowlisted-extension-id` naming the extension, which was measured to work on Google Chrome 153.
That is how the demo and the tests run, and it is available to a fleet only if Chrome is started through a launcher the client controls; a Chrome the operator opens from the Dock gets no flag.
Managed installation is still what puts the extension on the fleet without anyone installing it; it is the capture grant it does not provide.
If neither the press nor a launcher is acceptable, the extension is the wrong shape, and the alternatives are recorded under 2b in [GRILLING.md](GRILLING.md).

## How is the page actually video-recorded?

Chrome hands the extension a media stream of the tab's composited output: the frames Chrome itself draws for that tab, with every cross-origin iframe, canvas and video in place, plus the tab's audio.
It is not a screenshot loop and the page is not asked to render anything twice; the compositor feeds the frames it already produces into a video track, at most `targetFps` per second, 15 by default, and at most 1920 by 1080.
`MediaRecorder` encodes that track in the offscreen document, H.265 video and preferably AAC audio in fragmented MP4, at 3 Mbit/s by default.
Frame rate, size and bitrate are configurable; recording requires H.265 MP4 support.

**The cost has not been profiled.**
What is known is where it lands: the capture adds a frame copy on the compositor for that tab, and the encoder runs in the extension's offscreen process rather than in the page's renderer, so the page's own JavaScript is not blocked, but the two share the machine's CPU.
The encoder now uses H.265; hardware acceleration and its actual CPU cost depend on the browser and machine and have not been profiled.
The measurement to make before any claim is a recording of the client's actual application, watched in Chrome's task manager and Activity Monitor, and the frame rate and codec adjusted from there.

## Where are the frames stored, and how are they encoded?

Frames are never stored.
The encoder consumes them as they arrive and emits fragmented MP4 at recorder callbacks, 5 seconds by default and 2 in the demo, and each complete fragment is written to IndexedDB, which is on disk, before anything else happens to it.
The extension buffers incomplete MP4 boxes until a complete fragment arrives; slow uploads can also accumulate pending data.
The encoding is Chrome's own, `MediaRecorder` in the offscreen document; nothing is transcoded, and the extension separates initialization data and media fragments without changing their bytes.
Once a chunk is durable it is uploaded, in sequence, one in flight at a time, and its record in IndexedDB moves from queued to uploaded.
The backend stores those bytes unchanged and publishes an HLS event playlist with fractional sample durations and an end marker after the final upload.
The extension also sends callback timing from `performance.now()`; media sample durations drive the playlist so callback delays do not distort playback.
The demo uses hls.js to play both live and completed recordings with the full timeline available for seeking.
The backend runs no remuxer or encoder; [`backend/`](../backend/) is the reference implementation, using only Go's standard library.

## Chunks arrive on the server; what if the server is down or slammed?

Today, the recording survives and the upload does not.
Uploads go one at a time in order, so a slow server is throttled naturally and chunks accumulate in IndexedDB behind it.
A failed upload marks its chunk failed and logs it, the recording carries on locally, and because a chunk is missing the extension never posts stop, so the backend never finalizes that recording.
The chunks are all in IndexedDB and the extension's console page can assemble them into a file by hand, but nothing retries, nothing resumes after the server comes back, and there is no authorization on the upload.
Retries with backoff, resumption, short-lived upload authorization and a bounded spool are the upload phase in [the sketch](plans/2026-09-09-tab-recording-sidecar-sketch.md), not yet built, because the demo did not need them and the client's backend shapes them.

## What are the big unknowns left?

- **The performance cost on the real application**, unprofiled; the levers are frame rate, resolution and codec.
- **Whether one press per tab is acceptable to the client**, or whether Chrome can be started through a launcher that passes the flag; nothing in policy removes the press.
- **The upload path under failure**, which today has no retry, no resume and no authorization.
- **The client's backend contract**: the HLS storage, upload authorization and who finalizes; the demo backend is a stand-in.
- **Long recordings.** The design assumes under one hour and nothing longer than seconds has been recorded in a test.
- **Chrome releases.** The grant rule is one condition in Chrome's source, re-tested per release; a change there changes the answer above.
