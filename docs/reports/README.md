# Reports

One-off investigations, decisions and analyses.
A report is a snapshot of what was known and decided at a moment; it is not maintained afterwards.

## Naming

```text
YYYY-MM-DD-HHMM-short-slug.md
```

**A report is named for when it was written**, because that is what a reader most needs to know about one and what a title never says.
A conclusion is only trustworthy against what was measured when it was written, and a filename carrying the timestamp makes a stale conclusion visible before it is acted on rather than after.

## Reports are not living documents

**A report is never edited to stay current.**
When its conclusion is overtaken, write a new report and link back to it; the old one keeps its date and its reasoning, which is what makes the pair readable.

Anything that should stay current is maintained and rewritten in place instead: [README.md](../../README.md), [CLAUDE.md](../../CLAUDE.md), [docs/GRILLING.md](../GRILLING.md), the plans in [docs/plans/](../plans/), and the notes in [docs/research/](../research/).

## A report is two files

**A report is two files with one basename**: the markdown, which is the record, and an HTML page authored exactly as a Claude artifact is.
Where the two disagree, the markdown is right.

**Nothing renders the page from the markdown; it is composed.**
A renderer would produce a document with the shape of a report and none of its judgment: a chart is drawn because a reader needs to see a distribution, not because a table happened to be there.
Composing the page is the same work as writing the report, done for the eye rather than the file.

The page:

- **Is authored with the artifact skills.** Load `artifact-design`, plus `dataviz` for charts and `artifact-diagramming` for diagrams.
- **Is self-contained.** No external request of any kind, so it opens from disk and from the published URL identically.
- **Carries no `<!doctype>`, `<html>`, `<head>` or `<body>`.** The Artifact tool wraps the file; publishing also takes a `favicon` emoji and a one-sentence `description`, neither of which lives in the file.
- **Works in both themes**, light and dark, from one token palette.
- **Draws its charts from the report's own tables**, each chart sitting above the table it came from, and the table kept as the chart's table view.
- **Draws diagrams as inline SVG**, not as a mermaid fence: a fence renders on GitHub but not in a file opened from disk, and the page must read the same in both places.
  Committed markdown, pull-request bodies and reviews keep mermaid, per [docs/WRITING_STYLE.md](../WRITING_STYLE.md).
- **Links to GitHub** for every file and commit it names.
- **Ends in a colophon** naming the markdown's path and the commit the report was written at.

## What a report contains

**The voice is [docs/WRITING_STYLE.md, "The voice of a report"](../WRITING_STYLE.md#the-voice-of-a-report)**, which holds the heading, structure and terminology rules; what follows is what must be in one.

- **An executive summary first**, one paragraph for a non-technical reader: what was found and what it changes, before any method or table.
- **Its working.** The numbers, the commands or the suite that produced them, the controls that were run, and any that failed and how that was caught.
  Length is not the constraint.
- **A verified-versus-unverified section**, the habit [docs/research/README.md](../research/README.md) already requires: a report that carries its working carries the limits of that working too.
- **Provenance for every measurement**: the commit, the toolchain `./provision.sh` installed, and the command that produced the numbers.

## Why the page is an artifact rather than a GitHub Pages site

**GitHub Pages cannot serve these privately.**
GitHub Free publishes Pages from public repositories only, and a Pro site published from a private repository is still public on the internet.

**github.com does not render HTML from a repository either**, private or public: it shows the source.
The markdown record does render natively, which is why every report links to its page from the first line.

An artifact is private by default, carries one stable URL per report that survives a republish, and is shared deliberately rather than by default.

## How one is made

1. Write the markdown into this directory with the timestamped name.
2. Compose the `.html` beside it, same basename, per the rules above.
3. Publish it with the Artifact tool, which returns a URL.
4. Put that URL in three places: the second line of the markdown, so a reader on github.com can reach the page; the index row below; and the pull-request body.
   For a report landed without a pull request, the commit body carries it.

## Index

| Report | Date | Page |
| ------ | ---- | ---- |
| [Capture feasibility spike](2026-09-09-2343-capture-feasibility-spike.md) | 2026-09-09 23:43 | https://claude.ai/code/artifact/c9d29648-ee7e-4662-abe3-80c48762b6c3 |
| [Gesture ladder](2026-09-10-0005-gesture-ladder.md) | 2026-09-10 00:05 | https://claude.ai/code/artifact/646b302a-a64a-437b-ad01-d1b178b19def |
| [The demo](2026-09-13-1302-demo.md) | 2026-09-13 13:02 | https://claude.ai/code/artifact/72cf4f61-014a-4794-8329-123e2b2f4f46 |
| [HLS and DASH comparison](2026-11-02-1024-hls-dash-comparison.md) | 2026-11-02 10:24 | https://claude.ai/artifact/EZUt3U4oyhmfj5zZDG59AN |
