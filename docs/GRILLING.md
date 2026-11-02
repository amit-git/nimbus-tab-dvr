# Nimbus Tab DVR: design interrogation

Questions raised against the shape of the project before research and planning.
Answer inline under each **Answer:** marker.
"Don't know" is a valid answer.

Sections are ordered by how much damage a wrong answer does.
A question that has been answered stays here with its answer, because the reason for a decision is worth more later than the decision is.

---

## 1. What it is

**1a.** What does "tab DVR" record: a browser tab's rendered video, its audio, the whole tab as a screen capture, or a stream it is playing?

**Answer:** The rendered video of one tab, composited, so a cross-origin iframe such as a YouTube embed is in the frame.
The tab's audio can be captured with it as an Opus track, shown by the spike on 2026-09-09; whether it is on by default is a deployment setting.
Not a screen capture and not a stream the tab is playing.

**1b.** Who is it for, and how many of them are there?

**Answer:** A client's web application, running on a managed macOS Chrome fleet whose size is not known yet.
The demo application in this repository stands in for it.
The repository is a handoff: the extension and the demo are here, the client's backend stays theirs.

**1c.** What does the user do with a recording once it exists?

**Answer:** Nothing, locally.
The extension produces H.264 fragmented MP4 and uploads initialization data, complete media fragments and timing metadata to the client's backend.
The backend stores those bytes unchanged and publishes an HLS event playlist; hls.js provides playback and seeking.

---

## 2. The load-bearing assumption

**2a.** Which capture interface is this built on, and does it give what the design needs on the platforms in scope?

**Answer:** `chrome.tabCapture.getMediaStreamId` from a Manifest V3 service worker, consumed by an offscreen document.
Proven by [the spike report](reports/2026-09-09-2343-capture-feasibility-spike.md): Chrome grants capture to a tab the user has invoked the extension on, or to an extension whose id Chrome was launched with as `--allowlisted-extension-id`, and nothing else lifts that.
One click per tab was accepted on 2026-09-09; the flag is the zero-click path where a launcher starts Chrome.
Decided 2026-09-10: for demo and development, Chrome is launched with the flag, which is what the test does; in deployment the fleet's Chrome is not launched with a flag, so a recording needs one invocation per tab.
Measured 2026-09-10 in [the gesture ladder report](reports/2026-09-10-0005-gesture-ladder.md): the invocation is one press of the manifest's `commands` shortcut, Cmd+Shift+Y, and the grant it earns survives a reload of the page.
Measured 2026-09-10 on Google Chrome 153.0.8010.37 with the extension loaded unpacked: the branded Chrome honours `--allowlisted-extension-id` too, so the demo runs in the fleet's browser with no press.

**2b.** What happens when that interface is unavailable, denied by the user, or changed by a browser update?

**Answer:** A browser update changing the grant rule is a risk this project accepts and re-tests per Chrome release; the rule is one condition in `tab_capture_api.cc`.
If neither one click per tab nor a launcher passing `--allowlisted-extension-id` is acceptable to the client, the extension is the wrong shape, and the alternatives are a DevTools-protocol screencast of a controlled Chrome or a native capture of the Chrome window.

---

## 3. Shape and constraints

**3a.** Is this a browser extension, a native app, a service, or a library?

**Answer:** A Manifest V3 Chrome extension, plus a demo web application in the same repository that is the host during development.

**3b.** Which platforms and which versions, and which of those are actually tested?

**Answer:** Managed Chrome on macOS, installed through the admin console or Jamf.
The spike ran the pipeline on Playwright's Chromium 153.0.8010.12 and the packing and policy checks on Google Chrome 150.0.7871.101; the branded Chrome ignores `--load-extension`, so the pipeline on Chrome 150 itself is unverified until the extension reaches it by force-install or by hand.
Windows and ChromeOS are out of scope.

**3c.** What is the dependency budget, and what is the licence?

**Answer:** TypeScript, Vite and Playwright, plus the type-only packages `@types/chrome` and `@types/node`.
No formatter yet.
The licence is MIT.

---

## 4. Failure and scale

**4a.** How long is the longest recording it must survive, and what bounds the disk it uses?

**Answer:** Under one hour.
The spool bound is a safety net rather than a design driver, and it is not set in the spike.

**4b.** What is the acceptable loss when the process dies mid-recording?

**Answer:** Up to one timeslice plus what the encoder holds.
Measured on 2026-09-09: a killed offscreen document kept 4.93 of about 6 seconds at a two second timeslice.

---

## 5. Distribution

**5a.** How does a user install it, and how does it update itself?

**Answer:** Force-installed by policy on the managed fleet.
Chrome force-installs an extension that is not on the Chrome Web Store only on a machine it detects as enterprise managed, which on macOS means MDM enrolment; the spike recorded the refusal verbatim.
Decided 2026-09-10: the client pushes the extension with Jamf to its managed Chrome installs, so the machines are MDM-enrolled and the path is a self-hosted `.crx` and update manifest force-installed by policy, with the managed configuration alongside it.
The Web Store is not needed.
Updates come from the same update manifest.

**5b.** What is signed, notarized, or reviewed by a store, and who holds the credentials?

**Answer:** The `.crx` is signed with the RSA key in `.signing/nimbus-tab-dvr.pem`, whose public half is the `key` in the manifest and fixes the extension id `oibiheibjolbkmifdocjhkfalginaofm`.
Who holds it for the fleet, and whether a Web Store review is wanted, is the client's call.
