// Copyright (C) 2026 Niels Joubert
// SPDX-License-Identifier: MIT

// The capture feasibility spike, as a test. It loads the built extension unpacked into a
// Chromium of Playwright's, drives the demo application, and prints every finding with a
// FINDING: prefix so the report can quote the run.
//
// Playwright cannot click the toolbar, so the invocation Chrome demands is attempted three
// ways in turn: a shortcut through Playwright's keyboard, the same shortcut as a real macOS
// keystroke through System Events, and a System Events click on the toolbar button.
//
// Chromium's tab_capture_api.cc accepts one thing in place of the invocation: the extension
// id on the command line as --allowlisted-extension-id. The test launches with it by default,
// which is how the steps downstream of the grant run on a machine that cannot send keystrokes;
// NIMBUS_ALLOWLIST=0 drops the flag and runs the gesture ladder instead.

import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const EXTENSION = resolve('dist/extension');
const DEMO = 'http://localhost:5173/';
const HEADLESS = Boolean(process.env.CI);
const OUT = resolve('test-results/spike');
const RECORD_SECONDS = 6;
const TIMESLICE_MS = 2000;
const ALLOWLIST = process.env.NIMBUS_ALLOWLIST !== '0';

// Chrome derives an extension's id from the public key in its manifest: the first 16 bytes
// of the key's SHA-256, each nibble written as a letter from a to p.
function idFromManifestKey(): string {
  const manifest = JSON.parse(readFileSync(join(EXTENSION, 'manifest.json'), 'utf8')) as { key: string };
  const hex = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

let context: BrowserContext;
let extensionId: string;

function finding(text: string): void {
  console.log(`FINDING: ${text}`);
  test.info().annotations.push({ type: 'finding', description: text });
}

test.beforeAll(async () => {
  test.skip(!existsSync(join(EXTENSION, 'manifest.json')), 'dist/extension is missing; run ./build.sh first');
  mkdirSync(OUT, { recursive: true });
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'nimbus-tab-dvr-')), {
    channel: 'chromium',
    headless: HEADLESS,
    // Tab capture records the viewport, so the window is tall enough for the demo's canvas
    // and its YouTube player to both be in the footage.
    viewport: { width: 1440, height: 1100 },
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      '--autoplay-policy=no-user-gesture-required',
      ...(ALLOWLIST ? [`--allowlisted-extension-id=${idFromManifestKey()}`] : []),
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
  const version = context.browser()?.version() ?? 'unknown';
  finding(
    `Chromium ${version} (Playwright channel "chromium", headless=${HEADLESS}, allowlisted=${ALLOWLIST}), extension id ${extensionId}`,
  );
});

test.afterAll(async () => {
  await context?.close();
});

async function openLanding(page: Page, timesliceMs = TIMESLICE_MS, audio = false): Promise<void> {
  await page.goto(DEMO);
  await expect(page.locator('#extension')).toHaveAttribute('data-state', 'found', { timeout: 10_000 });
  await page.locator('#timeslice').fill(String(timesliceMs));
  await page.locator('#audio').setChecked(audio);
}

async function probe(page: Page): Promise<{ ok: boolean; detail: string }> {
  const out = page.locator('#probe-result');
  await page.locator('#probe').click();
  await expect(out).toHaveAttribute('data-done', '1', { timeout: 10_000 });
  return { ok: (await out.getAttribute('data-ok')) === '1', detail: (await out.textContent()) ?? '' };
}

async function statusReply(page: Page): Promise<Record<string, unknown>> {
  const status = page.locator('#status');
  await expect(status).not.toHaveAttribute('data-type', '', { timeout: 20_000 });
  return JSON.parse((await status.textContent()) ?? '{}') as Record<string, unknown>;
}

async function startFromLanding(page: Page): Promise<Record<string, unknown>> {
  await page.locator('#start').click();
  await page.waitForURL(/record\.html/);
  return statusReply(page);
}

// The recording page leaves for the landing page once the backend finalizes, or after ten
// seconds if it never does, so the wait here outlasts that fallback.
async function done(page: Page): Promise<Record<string, unknown>> {
  await page.locator('#done').click();
  await expect(page.locator('#status')).toHaveAttribute('data-type', /RECORDING_(STOPPED|FINALIZED|ERROR)/, { timeout: 20_000 });
  const reply = JSON.parse((await page.locator('#status').textContent()) ?? '{}') as Record<string, unknown>;
  if (reply.type === 'RECORDING_FINALIZED') reply.type = 'RECORDING_STOPPED';
  await page.waitForURL(/index\.html|\/$/, { timeout: 15_000 });
  return reply;
}

function osascript(script: string): { ok: boolean; output: string } {
  const run = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
  return { ok: run.status === 0, output: (run.stdout + run.stderr).trim() };
}

const SHORTCUT = process.platform === 'darwin' ? 'Meta+Shift+KeyY' : 'Control+Shift+KeyY';

// System Events addresses the browser by its process name, which is the executable's name:
// "Google Chrome for Testing" for Playwright's build, "Google Chrome" for the real one.
const PROCESS_NAME = basename(chromium.executablePath());
const SYSTEM_EVENTS_PROCESS = `(first process whose name is "${PROCESS_NAME}")`;

const invocations: { name: string; run: (page: Page) => Promise<string> }[] = [
  {
    name: 'Playwright keyboard shortcut',
    run: async (page) => {
      await page.bringToFront();
      await page.keyboard.press(SHORTCUT);
      return `pressed ${SHORTCUT} through Playwright`;
    },
  },
  {
    name: 'System Events keystroke',
    run: async (page) => {
      if (process.platform !== 'darwin' || HEADLESS) return 'skipped: needs a headed Chromium on macOS';
      await page.bringToFront();
      const result = osascript(
        `tell application "System Events" to tell ${SYSTEM_EVENTS_PROCESS} to set frontmost to true\n` +
          'delay 0.3\n' +
          'tell application "System Events" to keystroke "y" using {command down, shift down}',
      );
      return `${result.ok ? 'sent' : 'failed'}: ${result.output || 'Cmd+Shift+Y via System Events'}`;
    },
  },
  {
    name: 'System Events toolbar click',
    run: async (page) => {
      if (process.platform !== 'darwin' || HEADLESS) return 'skipped: needs a headed Chromium on macOS';
      await page.bringToFront();
      const result = osascript(
        `tell application "System Events" to tell ${SYSTEM_EVENTS_PROCESS}\n` +
          '  set frontmost to true\n' +
          '  delay 0.3\n' +
          '  set found to (every button of toolbar 1 of window 1 whose description contains "Nimbus")\n' +
          '  if (count of found) is 0 then\n' +
          '    click (first button of toolbar 1 of window 1 whose description is "Extensions")\n' +
          '    delay 0.5\n' +
          '    click (first menu item of menu 1 of first pop up button of window 1 whose name contains "Nimbus")\n' +
          '    return "clicked through the Extensions menu"\n' +
          '  end if\n' +
          '  click item 1 of found\n' +
          '  return "clicked the toolbar button"\n' +
          'end tell',
      );
      return `${result.ok ? 'sent' : 'failed'}: ${result.output}`;
    },
  },
];

// Tries each way in turn and returns the name of the first one after which Chrome hands out
// a stream id, or null if none did.
async function invoke(page: Page): Promise<string | null> {
  const already = await probe(page);
  if (already.ok) {
    finding(`no gesture needed: the probe was granted before any invocation (${already.detail})`);
    return ALLOWLIST ? 'launch flag --allowlisted-extension-id' : 'nothing: granted on a fresh tab';
  }
  for (const method of invocations) {
    const how = await method.run(page);
    await page.waitForTimeout(500);
    const after = await probe(page);
    finding(`${method.name}: ${how}; probe after it: ${after.ok ? 'GRANTED' : 'refused'} (${after.detail})`);
    if (after.ok) return method.name;
  }
  return null;
}

interface Probed {
  format: string;
  streams: string[];
  packets: number;
  lastSeconds: number;
}

// The raw recording is measured by reading its packets:
// how many packets ffprobe can parse and the timestamp of the last one.
function ffprobe(path: string): Probed | null {
  const run = spawnSync(
    'ffprobe',
    ['-v', 'error', '-count_packets', '-show_entries', 'format=format_name:stream=codec_type,codec_name,nb_read_packets', '-of', 'json', path],
    { encoding: 'utf8' },
  );
  if (run.error || run.status !== 0) {
    finding(`ffprobe on ${path}: ${run.error?.message ?? run.stderr.trim()}`);
    return null;
  }
  const parsed = JSON.parse(run.stdout) as {
    format: { format_name: string };
    streams: { codec_type: string; codec_name: string; nb_read_packets: string }[];
  };
  const last = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', path],
    { encoding: 'utf8' },
  );
  const times = last.stdout.split('\n').map(Number).filter((n) => Number.isFinite(n));
  return {
    format: parsed.format.format_name,
    streams: parsed.streams.map((s) => `${s.codec_type}:${s.codec_name}`),
    packets: parsed.streams.reduce((n, s) => n + Number(s.nb_read_packets), 0),
    lastSeconds: times.length ? Math.max(...times) : 0,
  };
}

async function downloadRecording(recordingId: string, name: string): Promise<string> {
  const consolePage = await context.newPage();
  await consolePage.goto(`chrome-extension://${extensionId}/console.html`);
  const row = consolePage.locator(`tr[data-recording-id="${recordingId}"]`);
  await expect(row).toBeVisible();
  const [download] = await Promise.all([consolePage.waitForEvent('download'), row.locator('button.download').click()]);
  const path = join(OUT, `${name}.mp4`);
  await download.saveAs(path);
  await consolePage.close();
  const probed = ffprobe(path);
  if (probed) {
    finding(
      `${name}.mp4: ${probed.format}, streams [${probed.streams.join(', ')}], ${probed.packets} packets, last video packet at ${probed.lastSeconds.toFixed(2)} s`,
    );
    expect(probed.packets).toBeGreaterThan(0);
    expect(probed.lastSeconds).toBeGreaterThan(0);
  }
  return path;
}

test.describe.configure({ mode: 'serial' });

test('Q1a: with no invocation, START_RECORDING is refused unless Chrome was launched with the allowlist flag', async () => {
  const page = await context.newPage();
  await openLanding(page);
  const before = await probe(page);
  finding(`probe on a fresh tab with no invocation: ${before.ok ? 'GRANTED' : 'refused'} (${before.detail})`);
  const reply = await startFromLanding(page);
  finding(`START_RECORDING with no invocation: ${JSON.stringify(reply)}`);
  if (ALLOWLIST) {
    expect(before.ok).toBe(true);
    expect(reply.type).toBe('RECORDING_STARTED');
    await page.waitForTimeout(2000);
    const stopped = await done(page);
    expect(stopped.type).toBe('RECORDING_STOPPED');
  } else {
    expect(before.ok).toBe(false);
    expect(reply.type).toBe('RECORDING_ERROR');
    expect(reply.code).toBe('CAPTURE_FAILED');
    expect(String(reply.detail)).toContain('has not been invoked');
  }
  await page.close();
});

test('Q1b to Q3: one invocation, then unattended cycles, reload, kill, and audio', async () => {
  const page = await context.newPage();
  await openLanding(page);

  const granted = await invoke(page);
  test.skip(granted === null, 'no automated invocation was accepted; Q1b runs by hand, see the findings');
  finding(`invocation that worked: ${granted}`);

  await test.step('three start and stop cycles with no further click', async () => {
    for (let cycle = 1; cycle <= 3; cycle++) {
      const started = await startFromLanding(page);
      finding(`cycle ${cycle} start: ${JSON.stringify(started)}`);
      expect(started.type).toBe('RECORDING_STARTED');
      await page.waitForTimeout(RECORD_SECONDS * 1000);
      const stopped = await done(page);
      finding(`cycle ${cycle} stop: ${JSON.stringify(stopped)}`);
      expect(stopped.type).toBe('RECORDING_STOPPED');
      expect(Number(stopped.chunks)).toBeGreaterThanOrEqual(Math.floor((RECORD_SECONDS * 1000) / TIMESLICE_MS) - 1);
      if (cycle === 1) await downloadRecording(String(stopped.recordingId), 'cycle-1');
    }
  });

  await test.step('the recording and the grant across a reload of the recording page', async () => {
    const started = await startFromLanding(page);
    expect(started.type).toBe('RECORDING_STARTED');
    await page.waitForTimeout(2000);
    await page.reload();
    const afterReload = await statusReply(page);
    finding(`the reloaded page asked for status and got: ${JSON.stringify(afterReload)}`);
    expect(afterReload.type).toBe('RECORDING_STATUS');
    expect(afterReload.state).toBe('RECORDING');
    expect(afterReload.recordingId).toBe(started.recordingId);
    const during = await probe(page);
    finding(`probe while the reloaded page's recording is live: ${during.ok ? 'GRANTED' : 'refused'} (${during.detail})`);
    await page.waitForTimeout(2000);
    // Done navigates back to the landing page, where the probe answers for the same tab.
    const stopped = await done(page);
    finding(`stop from the reloaded page: ${JSON.stringify(stopped)}`);
    expect(stopped.type).toBe('RECORDING_STOPPED');
    const after = await probe(page);
    finding(`probe after the reload, once the stream is released: ${after.ok ? 'GRANTED' : 'refused'} (${after.detail})`);
  });

  await test.step('Q2: a killed offscreen document leaves the committed chunks', async () => {
    const started = await startFromLanding(page);
    expect(started.type).toBe('RECORDING_STARTED');
    await page.waitForTimeout(RECORD_SECONDS * 1000);
    const consolePage = await context.newPage();
    await consolePage.goto(`chrome-extension://${extensionId}/console.html`);
    await consolePage.locator('#close-offscreen').click();
    await expect(consolePage.locator('#note')).toHaveText('closed');
    await consolePage.close();
    await page.bringToFront();
    const stopped = await done(page);
    finding(`stop after the offscreen document was killed: ${JSON.stringify(stopped)}`);
    expect(stopped.type).toBe('RECORDING_ERROR');
    expect(stopped.code).toBe('OFFSCREEN_GONE');
    await downloadRecording(String(started.recordingId), 'killed');
  });

  await test.step('Q3: the same recording with the tab audio captured', async () => {
    await page.locator('#audio').setChecked(true);
    const started = await startFromLanding(page);
    finding(`start with audio: ${JSON.stringify(started)}`);
    expect(started.type).toBe('RECORDING_STARTED');
    expect(started.audio).toBe(true);
    await page.waitForTimeout(RECORD_SECONDS * 1000);
    const stopped = await done(page);
    expect(stopped.type).toBe('RECORDING_STOPPED');
    await downloadRecording(String(stopped.recordingId), 'audio');
  });

  await page.close();
});
