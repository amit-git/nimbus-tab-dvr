<h1 align="center">Nimbus Tab DVR</h1>

<p align="center">
  A digital video recorder for a browser tab.
</p>

<p align="center">
  A Manifest V3 Chrome extension that records the tab a host web application asks it to, with a demo application standing in for the host.
  The capture feasibility spike is done and <a href="docs/reports/2026-09-09-2343-capture-feasibility-spike.md">reported</a>, and the demo is built: every chunk lands on a demo backend as it is encoded, the backend publishes an ongoing HLS playlist without remuxing or encoding, and the demo plays it through hls.js with seeking.
  The application contract waits behind the demo, and the client deploys through Jamf to managed Chrome.
</p>

```
./provision.sh            # a development Mac: the toolchain, npm, the git hooks, both GitHub logins
./build.sh                # Vite builds the extension and the demo into dist/
./build.sh test           # Playwright drives the extension in a real Chromium and prints its findings
./build.sh check          # the gate CI runs: prek over every file, then tsc
./build.sh clean          # remove build products
dist/backend/nimbus-demo-backend   # the demo backend, Go: the demo pages embedded, the recordings API on 5173, the packed extension on 8765
scripts/demo/chrome.sh        # a real Chrome on a throwaway profile, with the extension's id allowlisted for capture; --chromium for a managed Mac
```

Work reaches `main` through a pull request, which prek enforces at commit and push time.
An agent opens and answers it as `njoubert-agents` through `scripts/gh-agent.sh`, so a review carries Approve and Request changes rather than only Comment.
See [CLAUDE.md, "Landing work"](CLAUDE.md#landing-work-branches-and-pull-requests).

`./build.sh` with an unknown command prints its own help, which is the header of the file itself.

## How it works

![How a recording moves: the page asks through the content script, the service worker gets a stream id from Chrome and hands it to the offscreen document, which encodes, spools every chunk to IndexedDB and uploads it in order to the demo backend, which publishes an HLS playlist the landing page plays with hls.js](docs/how-it-works.svg)

The page never holds a channel to the extension: it posts a message on its own window, the content script relays it, and the service worker validates the origin and the message before anything happens.
Capture is granted per tab, by one press of Cmd+Shift+Y or by the allowlist flag at launch; the offscreen document owns the stream, the encoder and the spool, and every chunk is durable locally before it is uploaded.

## What is here

| Path | What it is |
| ---- | ---------- |
| [`build.sh`](build.sh) | Build, test, format, check, clean |
| [`provision.sh`](provision.sh) | Everything a fresh machine needs, re-runnable |
| [`src/extension/`](src/extension/) | The extension: service worker, content script, offscreen recorder, IndexedDB spool, console page |
| [`src/demo/`](src/demo/) | The demo host: a landing page that lists and plays the backend's recordings, then a page with a canvas, a YouTube embed and a Done button |
| [`backend/`](backend/) | The demo backend in Go, the reference implementation of the upload contract |
| [`scripts/demo/`](scripts/demo/) | The Chrome launcher for the demo |
| [`tests/`](tests/) | The spike and the demo as Playwright tests |
| [`scripts/`](scripts/) | The checks, the two-account GitHub wrappers, the spike's packing and policy tools, and the shared output helpers |
| [`docs/`](docs/) | The writing style, the design questions, the system diagram, [the FAQ](docs/FAQ.md), and the plans, reports and research |
| [`CLAUDE.md`](CLAUDE.md) | How to work in this repository |

## Running the demo

1. `./build.sh`, then `dist/backend/nimbus-demo-backend` in a terminal that stays open.
2. `scripts/demo/chrome.sh` launches Google Chrome on a throwaway profile with the extension's id allowlisted for tab capture.
   The branded Chrome ignores `--load-extension`, so on the first launch it opens `chrome://extensions`: turn on Developer mode, press Load unpacked and pick `dist/extension`, once; the profile remembers it.
3. On the landing page press Start.
   The recording page records itself; a second tab on the landing page shows the chunks landing; a reload of the recording page rejoins its recording; closing the tab still lands it; Play streams it while recording, Done adds the end marker, and the player keeps the full timeline for seeking.

On a managed Mac whose Chrome policy blocks extensions, `scripts/demo/chrome.sh --chromium` runs the demo in Playwright's Chromium instead, which takes the extension from the command line and reads no Google Chrome policy; every Google Chrome channel or copy on that Mac would read the same policies and inherit the block.
The demo backend is one Go binary with the demo pages embedded; it keeps its recordings in `.build-demo/recordings/` and requires no media processing tools.
It is also the reference implementation of the upload contract, written in the client's language so their backend can be read against it: [`backend/`](backend/), standard library only.
A fleet's Chrome is not launched with the flag; there, one press of Cmd+Shift+Y on the tab is what allows capture, and the recording page says so when it is needed.

## Recording and playback contract

The extension records H.264 in fragmented MP4, preferring AAC audio and falling back to Opus if AAC recording is unavailable.
It refuses unsupported codecs rather than falling back to VP9 or WebM.
The extension separates the MP4 initialization data and complete `moof`/`mdat` fragments without changing their bytes, then spools and uploads them in order.
`timesliceMs` controls recorder callbacks; callbacks can contain partial boxes or multiple fragments, so callback counts and uploaded segment counts can differ.

`POST /api/recordings/{id}/chunks/{sequence}` uploads one initialization or media segment with these headers:

| Header | Value |
| ------ | ----- |
| `Content-Type` | The selected MP4 codec MIME type |
| `X-Recording-Key` | The recording key |
| `X-Chunk-Kind` | `init` for sequence 1, then `media` |
| `X-Chunk-Duration-Ms` | Fractional milliseconds from MP4 sample durations; zero for initialization |
| `X-Chunk-Start-Ms`, `X-Chunk-End-Ms` | Recorder callback interval from `performance.now()`, relative to capture start |

Callback timing measures elapsed capture time independently of upload delay and is kept alongside each segment.
If a callback yields multiple fragments, those fragments share its callback interval; HLS `EXTINF` uses each fragment's media duration to avoid drift from callback scheduling.
The recorder requests keyframes every two seconds, and the backend accepts media fragments up to ten seconds so `EXT-X-TARGETDURATION:10` stays constant throughout the recording.
The backend stores the uploaded bytes unchanged and atomically updates a stored `index.m3u8` after each upload, served at `/api/recordings/{id}/index.m3u8`, with `EXT-X-MAP`, fractional `EXTINF` durations and `PLAYLIST-TYPE:EVENT`.
All segments remain in the playlist for DVR seeking.
`meta.json` retains recording identity and upload bookkeeping; playback reads the stored playlist directly.
On server restart, playlists are recovered from metadata, including recordings created before playlists were stored on disk.
`POST /api/recordings/{id}/stop` takes `{ chunks, bytes, reason? }`, checks that all uploads arrived and adds `EXT-X-ENDLIST`.
The demo uses bundled hls.js, with native HLS as a fallback, for both ongoing and finalized playback.
Existing WebM recordings are not converted to HLS.

## What is not here yet

**No retries, no authorization, no application contract beyond what the demo speaks, no formatter.**
The backend in this repository stands in for the client's and shows the contract theirs implements; a backend that is down leaves the recording in IndexedDB, where the console page can still assemble it.
[docs/FAQ.md](docs/FAQ.md) answers the questions a reader asks after the demo, [docs/GRILLING.md](docs/GRILLING.md) holds the design questions with their answers so far, and [docs/plans/](docs/plans/) holds what is built next.

## Licence

MIT.
See [LICENSE](LICENSE).
