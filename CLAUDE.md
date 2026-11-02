# Nimbus Tab DVR: notes for agents

A digital video recorder for a browser tab: a Manifest V3 Chrome extension in TypeScript that records the tab a host web application asks it to, and a demo application that stands in for that host.
The capture feasibility spike is proven and reported, and the demo that sells the concept is built: each chunk uploads to a demo backend in Go that publishes HLS for playback with hls.js; the application contract waits behind it.
[README.md](README.md) is the user-facing description; read it first and keep it true when behaviour changes.
This file is the rest: how to work here, and what has already been decided.

A sibling of `../nimbus-net-bar`, `../nimbus-leviton-bar`, `../nimbus-dmx-helper` and `../nimbus-updater`, which share these conventions and whose own CLAUDE.md files carry the traps each one has found.

## Your rhetorical style

State the substantive point directly.
Do not announce or characterize what follows, and do not tell the reader that something is important, interesting, or worth noting; explain it.

## Writing style

**Everything written here follows [docs/WRITING_STYLE.md](docs/WRITING_STYLE.md): terse and formal, one sentence per line in committed markdown, no em or en dashes.**
The prek hook enforces the line rule; the rest is on you.

## Ground rules

- **Grill me relentlessly.** Before building a feature, ask every question whose answer would change the work, with the facts already checked, and prefer `AskUserQuestion` for crisp either-or calls.
- **Be concise.** Short reports, no repetition, the salient facts only.
- **Decisions, not options.** Surface the alternatives you rejected in one line each, then recommend.
- **`prek` must pass.** `./provision.sh` installs the hooks; `./build.sh check` runs them over every file and then `tsc`, and it must pass before you claim done.
  `prek run --all-files` means every tracked file, so `git add` a new file before `./build.sh check` or the commit hook will be the first thing to see it.
- **The dependency budget is TypeScript, Vite, Playwright and hls.js**, plus type-only packages, and for the backend the Go standard library and nothing else.
  Adding anything else is a decision to raise, not a line in `package.json` or `go.mod`.
  `ffmpeg` is a tool on the Mac that `provision.sh` installs, used only by the capture spike tests, not a package.
- **Never disable a hook to get past it.** Shellcheck runs at its default severity, so `A && B || true` is flagged; write an `if`.
- **Documentation tasks are documentation-only.** When the task is to record something, the deliverable is the document; offer the implementation as a next step and wait.
- **The unanswered questions in [docs/GRILLING.md](docs/GRILLING.md) are unanswered.** Do not build past one; ask it.

## Working style: single developer project

- **Minimum work.** Do only what the task needs.
- **Refactor the system rather than layering on top of it.** Changing an interface is cheap in a single-developer repository; carrying two ways to do one thing is not.
- **Support standard commands, do not wrap them.** A script helps after `git commit`; it does not replace it.
- **Every script reads its own `# Usage:` header for help**, so the help and the file cannot disagree.
- **There is no Makefile.** The targets would be wrappers with no dependency graph, and the sibling repositories on this machine use scripts.

## Coding principles

1. **Conventional commits** (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `ci:`, `chore:`) with an imperative subject under 72 characters, in the house style.
2. **No process trail in code.** A comment explains what the code does and why; ticket numbers, dates and conversation history live in `docs/` and in git.
3. **Let naming carry the meaning.** Keep comments few; a field in a struct should not need one.
4. **A licence header on every new source file**, carrying `Copyright (C) 2026 Niels Joubert` and `SPDX-License-Identifier: MIT`.
   The project is MIT, the permissive end of the nimbus family, so do not vendor code under a licence that would force the whole thing to be something else.
5. **Comments explain the trap, not the syntax.** The comment worth writing is the one that says why the obvious version was wrong.

## Layout

```text
build.sh                  build | test | fmt | check | clean; `./build.sh nonsense` prints help
provision.sh              a development Mac: the toolchain, npm, Go, Playwright's Chromium, the git hooks
backend/                  the demo backend in Go, standard library only: the recordings API, the HLS event playlist, the demo pages embedded
  static/                 where build.sh copies dist/demo for go:embed; only .gitkeep is tracked
src/
  shared/protocol.ts      the messages between page, content script, service worker and offscreen document
  extension/              the Manifest V3 extension: service worker, content script, offscreen document, console page
    public/manifest.json  the manifest, with the public key that fixes the extension id
  demo/                   the demo host application: a landing page that lists and plays the backend's recordings, and a recording page
tests/spike.spec.ts       the capture feasibility spike, as a Playwright test that prints FINDING: lines
tests/demo.spec.ts        the demo's beats as a test: chunks landing, stop finalizing, reload rejoining, tab close landing
vite.extension.config.ts  four entries by name, no plugin
vite.demo.config.ts       two pages
scripts/
  gh-agent.sh                      runs `gh` as njoubert-agents, for anything that writes
  pr-review.sh                     fetch a review's inline threads, and reply into one
  check-protected-branch.sh        the main guard, wired into prek at commit and push
  check-one-sentence-per-line.sh   the markdown line rule, wired into prek
  lib/output.sh                    the shared print_* helpers every script sources
  lib/one-sentence-per-line.awk    the check itself, in awk so it needs no toolchain
  demo/chrome.sh                   a real Chrome on a throwaway profile, the extension's id allowlisted for capture
  spike/pack.sh                    packs a .crx with Chrome and writes the update manifest
  spike/policy.sh                  install | show | remove the force-install policy on this Mac
  spike/managed-probe.mjs          reads what a real Chrome made of the policies, over the DevTools protocol
docs/
  how-it-works.svg        the system diagram the README embeds, hand-authored SVG with its own background so it reads on GitHub in both themes
  WRITING_STYLE.md        binds everything written here
  GRILLING.md             the design questions and their answers
  FAQ.md                  the questions a reader asks after the demo, answered against the code and what was measured
  plans/                  what will be built, agreed before it is built
  reports/                what happened, dated and never updated
  research/               what was established from primary sources, maintained
.github/
  workflows/ci.yml        the same checks CI runs
  pull_request_template.md  the sections every pull request fills in
```

## Project scripts

| Script | What it does |
| ------ | ------------ |
| `./provision.sh` | Installs the Homebrew tools, the git hooks, and both GitHub logins |
| `./provision.sh check` | Reports what is installed and what is missing, and exits nonzero on a gap |
| `scripts/gh-agent.sh <gh args>` | Runs `gh` as `njoubert-agents` for one call, without switching the active account |
| `scripts/pr-review.sh fetch [PR]` | The inline review threads `gh pr view --comments` does not show |
| `scripts/pr-review.sh reply THREAD_ID BODY` | Answers one thread, as the agent account |
| `./build.sh` | Vite builds the extension into `dist/extension` and the demo into `dist/demo`, then Go builds the backend into `dist/backend` with the demo embedded |
| `./build.sh test` | Playwright runs `tests/`, headed, against the built extension; `NIMBUS_ALLOWLIST=0` runs the gesture ladder instead of the launch flag |
| `./build.sh check` | The gate CI runs: `prek run --all-files`, then `tsc --noEmit`, then `gofmt -l` and `go vet` over the backend |
| `./build.sh fmt` | `gofmt` over the backend; nothing for TypeScript or markdown yet |
| `./build.sh clean` | Removes `dist`, `test-results` and `playwright-report` |
| `dist/backend/nimbus-demo-backend` | The demo backend, which Playwright also starts for the tests; recordings live in `.build-demo/recordings/`, and `-static dist/demo` serves the pages from disk while editing them |
| `scripts/demo/chrome.sh` | Google Chrome on a throwaway profile with the allowlist flag; the extension is loaded unpacked by hand, once |
| `scripts/demo/chrome.sh --chromium` | The same demo in Playwright's Chromium, for a managed Mac whose Chrome policy blocks extensions |
| `scripts/spike/*` | The managed-path tools; each reads its own `# Usage:` header |

**`fmt` runs `gofmt` and nothing else**, because no TypeScript or markdown formatter is in the budget; the rest is a TODO in that function in `build.sh`.

**Traps the spike found**, each with its record in [docs/reports/2026-09-09-2343-capture-feasibility-spike.md](docs/reports/2026-09-09-2343-capture-feasibility-spike.md):

- `chrome.tabCapture` grants capture only to a tab the user has invoked the extension on, or to the id in Chrome's `--allowlisted-extension-id` flag; force-install, `<all_urls>` and policy change nothing.
- The branded Google Chrome ignores `--load-extension`; the test runs in Playwright's Chromium for that reason, and a real Chrome gets the extension only from the Web Store, a managed force-install, or developer mode by hand.
- Chrome force-installs an off-store extension only on a machine it detects as enterprise managed, and a user-level `defaults write` arrives as a Recommended policy, not a Mandatory one.
- Recording requires H.265 fragmented MP4; the extension splits complete fragments and reads sample durations, and the backend stores bytes unchanged and builds HLS.
- `osascript` keystrokes need an Accessibility grant for the terminal, which an agent cannot give itself; with it, a real press of the `commands` shortcut is the invocation Chrome wants, and Playwright's keyboard never is.
- A content script is a classic script: it may import types and nothing else, and `build.sh` fails the build if an import survives.

**Traps the demo found**, on 2026-09-10:

- A closing tab ends the captured track before `tabs.onRemoved` fires, so the service worker's stop on that path finds the offscreen document already finished; both paths end in the same finished record, and neither may treat the other's win as a failure.
- The demo backend and the demo application share one origin on purpose, so the page needs no CORS; the extension's `chrome-extension://` origin does, and `host_permissions` for localhost is what lets the offscreen document post there.
- Every Google Chrome channel and copy on a Mac reads the policies written for `com.google.Chrome`, so a second Chrome does not escape a managed block on extensions; Playwright's Chromium, a Chrome for Testing build, did not read a marker policy written there when measured on 2026-09-10, and it takes `--load-extension`.

**Script output follows `../weshootfilm/provision.sh`**, so every script on this machine reads the same.
`print_header` opens a section, `print_success` (✓), `print_warning` (⚠), `print_error` (✗) and `print_info` carry the lines, and the EXIT trap prints a closing banner so no run can end on an ambiguous note.
The headline carries the glyph and detail lines sit indented under it; warnings and errors go to stderr so a failure survives a pipe.
An ERR trap names the failing stage, so call `stage "..."` before anything long and `result "..."` to say what the green banner reports.
All of it lives in [scripts/lib/output.sh](scripts/lib/output.sh); a new script sources that rather than copying it.

## Where plans, research and reports live

**Three directories, three lifetimes**, each with a README holding its own convention.

- **[docs/plans/](docs/plans/README.md)** is what will be built, rewritten while it is argued about and frozen when the work starts.
- **[docs/reports/](docs/reports/README.md)** is what happened, named `YYYY-MM-DD-HHMM-slug.md`, never edited afterwards, and paired with an HTML page published as an artifact.
- **[docs/research/](docs/research/README.md)** is what primary sources say, maintained in place, and every note ends with what it verified and what it did not.

Read the README of a directory before writing into it rather than copying the shape of the file beside yours.

## Landing work: branches and pull requests

**`main` is protected, and work reaches it through a pull request Niels reviews.**
He reviews on GitHub in the browser; the work happens locally.
Reviewing his own agents' code is the point of this flow, so routing around it defeats the purpose rather than saving time.

- **Never commit, never create a branch, and never judge whether a change is too large or too small for a pull request.**
  All three are Niels's calls, and there is deliberately no size or change-type threshold for an agent to apply.
- **Make the edits, report what changed, and stop there.**
  He then says "just land it", or asks for a pull request, or takes it from there himself.
- **Ask when you do not know which he wants**, because asking costs one sentence and guessing costs a branch, a pull request, and a review he did not want to do.
- **A branch he has already asked for is the standing exception**, where a direct request authorizes committing and pushing to that branch, and to that branch only.
- **When he does ask for a pull request, branch first with plain git**, since `main` is protected: `git switch -c feat/short-description`, commit, then `git push -u origin <branch>`.
  One branch is one pull request.
- **Never commit while `main` is checked out, and never push to `main`.**
- **[scripts/check-protected-branch.sh](scripts/check-protected-branch.sh) enforces this** from prek at the pre-commit and pre-push stages.
  Treat a rejected commit as the answer, not as an obstacle to work around.
- **The guard is a redirect, not a seal**, and `--no-verify` defeats it.
- **`ALLOW_MAIN=1` is the named exception, and it belongs to Niels rather than to an agent.**

**An agent posts as `njoubert-agents`, never as Niels.**
Push with your own credential, so commits stay authored by him, but route every `gh` call that **writes** something a reader will attribute to a person through **[scripts/gh-agent.sh](scripts/gh-agent.sh)**: `pr create`, `pr comment`, `pr edit`, and the replies `scripts/pr-review.sh` sends.
This is not cosmetic.
GitHub refuses Approve and Request changes on your own pull request, so one Niels opens can only ever be `COMMENTED`, and he loses the two verbs a review is made of.
**Never run `gh auth switch`**, which changes the active account for everything he types afterwards; the wrapper reads the agent token without disturbing it.

**Opening the pull request.**
Push the branch, then `scripts/gh-agent.sh pr create`.
Pull requests land as merge commits, so every commit on the branch reaches `main` and each one takes a conventional-commit subject under 72 characters in the house style, not only the last.
The pull-request title becomes the merge commit subject, so it says what the branch did as a whole.

**Every pull request an agent opens requests a review from Niels**, so it reaches him as a request rather than as a page he has to remember to visit.
The wrapper appends `--reviewer njoubert` to `pr create` itself, so pass the flag only to name someone else.
Override the handle with `REVIEW_GH_USER`, and set it empty to request nothing.

**Open it once it exists**, with `gh pr view <PR> --web`, so the review is waiting in the browser rather than a URL he has to copy.
Run that as a plain `gh` call rather than through the agent wrapper, since opening a browser is a read and belongs on his session.

**Fill [.github/pull_request_template.md](.github/pull_request_template.md), and never pass `--fill`**, which replaces the template with commit messages and so drops the design-decisions section entirely.
`gh` populates the template only in interactive and `--web` runs, so an agent reads that file itself and passes the completed text as `--body-file`.
**Design decisions is the section that matters**: it records the choices raised under "Grill me relentlessly" above, each one naming what it was chosen over and what it costs.
**Write each paragraph of the body as one unwrapped line**, since GitHub renders a newline there as a line break, and draw the shape in a mermaid fence rather than in ASCII art.

**Reading a review back.**
Use `scripts/pr-review.sh fetch`, never `gh pr view --comments`, which shows only the timeline and silently omits every comment anchored to a file and line.
Reply where the comment was left, with `scripts/pr-review.sh reply THREAD_ID BODY`, which posts as the agent account.

## What is not decided yet

**The audio default, the upload path and the application contract are open**, and [docs/GRILLING.md](docs/GRILLING.md) holds the questions with the answers so far.
The language, the runtime, the capture interface and the distribution channel are settled there: development launches Chrome with `--allowlisted-extension-id`, and the client deploys through Jamf to managed Chrome, where a recording needs one invocation per tab.
When another one is settled, the answer goes in that file, the affected code grows its real implementation, and this section shrinks.
