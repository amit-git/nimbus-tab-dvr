// Copyright (C) 2026 Niels Joubert
// SPDX-License-Identifier: MIT

// The demo, as a test: a recording's chunks land on the backend as they are produced, a stop
// finalizes into a file with a duration, a reloaded page rejoins its recording, and a closed
// tab still lands. It runs against the built extension in Playwright's Chromium with the
// allowlist flag, and the backend Playwright starts from scripts/demo/serve.mjs.

import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EXTENSION = resolve('dist/extension');
const DEMO = 'http://localhost:5173/';
const HEADLESS = Boolean(process.env.CI);
const OUT = resolve('test-results/demo');
const TIMESLICE_MS = 1000;

interface BackendRecording {
  id: string;
  key: string;
  state: string;
  chunks: number;
  bytes: number;
  durationSeconds?: number | null;
  reason?: string;
  url?: string;
}

function idFromManifestKey(): string {
  const manifest = JSON.parse(readFileSync(join(EXTENSION, 'manifest.json'), 'utf8')) as { key: string };
  const hex = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

let context: BrowserContext;

function finding(text: string): void {
  console.log(`FINDING: ${text}`);
  test.info().annotations.push({ type: 'finding', description: text });
}

test.beforeAll(async () => {
  test.skip(!existsSync(join(EXTENSION, 'manifest.json')), 'dist/extension is missing; run ./build.sh first');
  mkdirSync(OUT, { recursive: true });
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'nimbus-tab-dvr-demo-')), {
    channel: 'chromium',
    headless: HEADLESS,
    viewport: { width: 1440, height: 1100 },
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      '--autoplay-policy=no-user-gesture-required',
      `--allowlisted-extension-id=${idFromManifestKey()}`,
    ],
  });
  await (context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker')));
});

test.afterAll(async () => {
  await context?.close();
});

async function backendRecording(id: string): Promise<BackendRecording | undefined> {
  const response = await context.request.get(`${DEMO}api/recordings`);
  const all = (await response.json()) as BackendRecording[];
  return all.find((r) => r.id === id);
}

async function waitForBackendState(id: string, state: string, timeoutMs: number): Promise<BackendRecording> {
  const deadline = Date.now() + timeoutMs;
  let last: BackendRecording | undefined;
  while (Date.now() < deadline) {
    last = await backendRecording(id);
    if (last?.state === state) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`recording ${id} is ${last?.state ?? 'absent'} on the backend, not ${state}, after ${timeoutMs} ms`);
}

async function statusJson(page: Page, pattern: RegExp): Promise<Record<string, unknown>> {
  const status = page.locator('#status');
  await expect(status).toHaveAttribute('data-type', pattern, { timeout: 20_000 });
  return JSON.parse((await status.textContent()) ?? '{}') as Record<string, unknown>;
}

async function startRecording(page: Page, audio = true): Promise<Record<string, unknown>> {
  await page.goto(DEMO);
  await expect(page.locator('#extension')).toHaveAttribute('data-state', 'found', { timeout: 10_000 });
  await expect(page.locator('#backend')).toHaveAttribute('data-state', 'up', { timeout: 10_000 });
  await page.locator('#timeslice').fill(String(TIMESLICE_MS));
  await page.locator('#audio').setChecked(audio);
  await page.locator('#start').click();
  await page.waitForURL(/record\.html/);
  const started = await statusJson(page, /RECORDING_(STARTED|ERROR)/);
  expect(started.type).toBe('RECORDING_STARTED');
  return started;
}

test.describe.configure({ mode: 'serial' });

test('chunks land live and HLS finalizes with duration and seeking', async () => {
  const page = await context.newPage();
  const started = await startRecording(page);
  const id = String(started.recordingId);

  await expect
    .poll(async () => (await backendRecording(id))?.chunks ?? 0, { timeout: 15_000, message: 'chunks landing' })
    .toBeGreaterThanOrEqual(2);
  expect(String(started.mimeType)).toContain('avc1');
  const live = await backendRecording(id);
  finding(`while recording: backend has ${live?.chunks} chunks, ${live?.bytes} bytes, state ${live?.state}`);
  expect(live?.state).toBe('recording');
  const liveManifest = await context.request.get(`${DEMO}${live!.url!.slice(1)}`);
  expect(await liveManifest.text()).toContain('#EXTINF:');
  expect(await liveManifest.text()).not.toContain('#EXT-X-ENDLIST');

  const stopAt = Date.now();
  await page.locator('#done').click();
  // The finalized event can land before the assertion sees the stop reply, so either is accepted here.
  const stopped = await statusJson(page, /RECORDING_(STOPPED|FINALIZED|ERROR)/);
  expect(stopped.type).toMatch(/RECORDING_(STOPPED|FINALIZED)/);
  const finalized = await statusJson(page, /RECORDING_FINALIZED/);
  finding(`finalized ${Date.now() - stopAt} ms after Done: ${JSON.stringify(finalized)}`);
  expect(finalized.recordingId).toBe(id);
  expect(Number(finalized.chunks)).toBe(Number(stopped.chunks));

  const backend = await waitForBackendState(id, 'finalized', 5000);
  expect(backend.chunks).toBe(Number(finalized.chunks));
  expect(backend.bytes).toBe(Number(finalized.bytes));
  expect(backend.durationSeconds).toBeGreaterThan(0);

  const manifest = await context.request.get(`${DEMO}${backend.url!.slice(1)}`);
  const text = await manifest.text();
  expect(text).toContain('#EXT-X-ENDLIST');
  expect(text).toContain('#EXT-X-MAP:URI="init.mp4"');
  const durations = [...text.matchAll(/#EXTINF:([0-9.]+)/g)].map((m) => Number(m[1]));
  expect(durations.reduce((a, b) => a + b, 0)).toBeCloseTo(backend.durationSeconds!, 4);

  await page.waitForURL(/index\.html|\/$/, { timeout: 10_000 });
  const row = page.locator(`tr[data-recording-id="${id}"]`);
  await expect(row).toHaveAttribute('data-state', 'finalized');
  await row.locator('button.play').click();
  const video = page.locator('#player');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => Number.isFinite(v.duration) ? v.duration : 0), { timeout: 15000 }).toBeGreaterThan(0);
  const duration = await video.evaluate((v: HTMLVideoElement) => { v.pause(); return v.duration; });
  expect(duration).toBeCloseTo(backend.durationSeconds!, 0);
  // Seek forwards and backwards, including a position in a later fragment.
  for (const target of [duration * 0.75, duration * 0.15]) {
    await video.evaluate((v: HTMLVideoElement, time) => { v.currentTime = time; }, target);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2), { timeout: 10000 }).toBe(true);
    expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(target, 1);
  }
  finding(`HLS duration ${duration.toFixed(3)} s; forward and backward seeking passed`);
  await page.close();
});

test('live HLS grows, permits seeking, and becomes finite after stop without reloading the player', async () => {
  const capture = await context.newPage();
  const started = await startRecording(capture);
  const id = String(started.recordingId);
  await expect.poll(async () => (await backendRecording(id))?.chunks ?? 0, { timeout: 15000 }).toBeGreaterThanOrEqual(3);
  const viewer = await context.newPage();
  await viewer.goto(DEMO);
  await viewer.locator(`tr[data-recording-id="${id}"] button.play`).click();
  const video = viewer.locator('#player');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15000 }).toBeGreaterThanOrEqual(2);
  const initial = await video.evaluate((v: HTMLVideoElement) => { v.pause(); return v.duration; });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.duration), { timeout: 20000 }).toBeGreaterThan(initial + 1);
  await video.evaluate((v: HTMLVideoElement) => { v.currentTime = 0.5; });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.seeking && v.readyState >= 2)).toBe(true);
  await capture.locator('#done').click();
  const rec = await waitForBackendState(id, 'finalized', 10000);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.duration), { timeout: 25000 }).toBeCloseTo(rec.durationSeconds!, 0);
  await video.evaluate((v: HTMLVideoElement) => { v.currentTime = v.duration - 0.5; void v.play(); });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.ended), { timeout: 15000 }).toBe(true);
  finding(`live HLS grew from ${initial.toFixed(3)} s to ${rec.durationSeconds!.toFixed(3)} s and ended without a player reload`);
  await viewer.close();
  await capture.close();
});

test('a reloaded page rejoins its recording and the count keeps climbing', async () => {
  const page = await context.newPage();
  const started = await startRecording(page);
  const id = String(started.recordingId);
  await expect.poll(async () => (await backendRecording(id))?.chunks ?? 0, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  const before = (await backendRecording(id))!.chunks;

  await page.reload();
  const rejoined = await statusJson(page, /RECORDING_STATUS|RECORDING_STARTED|RECORDING_ERROR/);
  finding(`after reload: ${JSON.stringify(rejoined)}`);
  expect(rejoined.type).toBe('RECORDING_STATUS');
  expect(rejoined.state).toBe('RECORDING');
  expect(rejoined.recordingId).toBe(id);

  await expect.poll(async () => (await backendRecording(id))?.chunks ?? 0, { timeout: 15_000 }).toBeGreaterThan(before);
  await page.locator('#done').click();
  const stopped = await statusJson(page, /RECORDING_(STOPPED|FINALIZED|ERROR)/);
  expect(stopped.type).toMatch(/RECORDING_(STOPPED|FINALIZED)/);
  expect(stopped.recordingId).toBe(id);
  await statusJson(page, /RECORDING_FINALIZED/);
  const backend = await waitForBackendState(id, 'finalized', 5000);
  finding(`the one recording across the reload: ${backend.chunks} chunks, ${backend.durationSeconds} s`);
  expect(backend.chunks).toBeGreaterThan(before);
  await page.close();
});

test('a closed tab ends the recording and its last chunks still land', async () => {
  const page = await context.newPage();
  const started = await startRecording(page);
  const id = String(started.recordingId);
  await expect.poll(async () => (await backendRecording(id))?.chunks ?? 0, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

  const closeAt = Date.now();
  await page.close();
  const backend = await waitForBackendState(id, 'finalized', 15_000);
  finding(
    `tab closed: finalized ${Date.now() - closeAt} ms later with ${backend.chunks} chunks, ${backend.durationSeconds} s, reason ${backend.reason}`,
  );
  expect(backend.chunks).toBeGreaterThanOrEqual(2);
  expect(backend.reason).toMatch(/tab-closed|capture-ended/);
  expect(backend.durationSeconds).toBeGreaterThan(0);

  const landing = await context.newPage();
  await landing.goto(DEMO);
  await expect(landing.locator(`tr[data-recording-id="${id}"]`)).toHaveAttribute('data-state', 'finalized', { timeout: 5000 });
  await landing.close();
});

test('H.264 video-only recording plays through HLS', async () => {
  const page = await context.newPage();
  const started = await startRecording(page, false);
  expect(started.audio).toBe(false);
  const id = String(started.recordingId);
  await expect.poll(async () => (await backendRecording(id))?.chunks ?? 0, { timeout: 15000 }).toBeGreaterThanOrEqual(3);
  await page.locator('#done').click();
  const rec = await waitForBackendState(id, 'finalized', 10000);
  await page.waitForURL(/index\.html|\/$/);
  await page.locator(`tr[data-recording-id="${id}"] button.play`).click();
  await expect.poll(() => page.locator('#player').evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15000 }).toBeGreaterThanOrEqual(2);
  expect(await page.locator('#player').evaluate((v: HTMLVideoElement) => v.duration)).toBeCloseTo(rec.durationSeconds!, 0);
  await page.close();
});
