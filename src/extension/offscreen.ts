// Copyright (C) 2026 Niels Joubert
// SPDX-License-Identifier: MIT

// The data plane. It turns a stream id into a MediaStream, encodes it with MediaRecorder,
// writes every timeslice to IndexedDB as it arrives, and uploads each one to the backend in
// order once it is durable. One recording at a time; a stopped recording's upload tail runs
// on after the next one starts.

import type { CaptureOptions, ToOffscreen, ToServiceWorker } from '../shared/protocol';
import { MP4Segments, type MP4Part } from './mp4';
import { putChunk, putRecording, updateChunk, updateRecording } from './db';

const LOG = '[nimbus-tab-dvr offscreen]';

const MIME_CANDIDATES = ['video/mp4;codecs=avc1.42001E,mp4a.40.2', 'video/mp4;codecs=avc1.42001E,opus'];

interface Active {
  recordingId: string;
  recordingKey: string;
  apiBaseUrl: string;
  stream: MediaStream;
  recorder: MediaRecorder;
  audioContext?: AudioContext;
  mimeType: string;
  sequence: number;
  bytes: number;
  uploaded: number;
  writes: Promise<void>[];
  uploads: Promise<void>;
  ended: boolean;
  processing: Promise<void>;
  segments: MP4Segments;
  startedAt: number;
  lastChunkAt: number;
}

let active: Active | undefined;

function pickMimeType(preferred: string | undefined, audio: boolean): string {
  const candidates = MIME_CANDIDATES.map((type) => audio ? type : type.split(',')[0]);
  if (preferred && !candidates.includes(preferred)) throw new Error('Recording requires H.264 fragmented MP4');
  const mimeType = (preferred ? [preferred] : candidates).find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error('H.264 MP4 recording is not supported by this browser');
  return mimeType;
}

// Chrome's tab-capture constraints are the legacy `mandatory` form, which the DOM types do not
// know about, so the object is built untyped on purpose.
function constraints(streamId: string, options: CaptureOptions): MediaStreamConstraints {
  const source = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
  return {
    audio: options.audio ? { mandatory: { ...source } } : false,
    video: {
      mandatory: {
        ...source,
        maxWidth: options.maxWidth,
        maxHeight: options.maxHeight,
        maxFrameRate: options.targetFps,
      },
    },
  } as unknown as MediaStreamConstraints;
}

async function tellServiceWorker(message: ToServiceWorker['message']): Promise<void> {
  const envelope: ToServiceWorker = { target: 'service-worker', message };
  await chrome.runtime.sendMessage(envelope);
}

// One chunk to the backend. A failure is recorded and logged and the recording carries on;
// the demo has no retry, so a backend that is down shows up as failed chunks in the console.
async function upload(state: Active, sequence: number, part: MP4Part, startMs: number, endMs: number): Promise<void> {
  const url = `${state.apiBaseUrl}/api/recordings/${state.recordingId}/chunks/${sequence}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      body: part.data,
      headers: {
        'content-type': state.mimeType,
        'x-recording-key': state.recordingKey,
        'x-chunk-kind': part.kind,
        'x-chunk-duration-ms': String(part.durationMs),
        'x-chunk-start-ms': String(startMs),
        'x-chunk-end-ms': String(endMs),
      },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    state.uploaded += 1;
    await updateChunk(state.recordingId, sequence, { uploadState: 'uploaded' });
    await updateRecording(state.recordingId, { uploaded: state.uploaded });
  } catch (error) {
    console.error(LOG, 'upload failed', sequence, error);
    await updateChunk(state.recordingId, sequence, { uploadState: 'failed', retryCount: 1 });
  }
}

async function start(message: Extract<ToOffscreen['message'], { type: 'start' }>): Promise<Record<string, unknown>> {
  if (active) return { ok: false, detail: `already recording ${active.recordingId}` };

  const mimeType = pickMimeType(message.options.mimeType, message.options.audio);
  const stream = await navigator.mediaDevices.getUserMedia(constraints(message.streamId, message.options));
  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0];

  // Capturing a tab's audio takes it away from the speakers. Playing the captured track back
  // through an AudioContext is what gives it back, and Q3 of the spike measures whether it does.
  let audioContext: AudioContext | undefined;
  if (audioTrack) {
    audioContext = new AudioContext();
    audioContext.createMediaStreamSource(stream).connect(audioContext.destination);
  }

  const recorderOptions = {
    mimeType,
    videoBitsPerSecond: message.options.videoBitsPerSecond,
    videoKeyFrameIntervalDuration: 2000,
  };
  const recorder = new MediaRecorder(stream, recorderOptions);

  const state: Active = {
    recordingId: message.recordingId,
    recordingKey: message.recordingKey,
    apiBaseUrl: message.apiBaseUrl.replace(/\/$/, ''),
    stream,
    recorder,
    audioContext,
    mimeType: recorder.mimeType || mimeType,
    sequence: 0,
    bytes: 0,
    uploaded: 0,
    writes: [],
    uploads: Promise.resolve(),
    ended: false,
    processing: Promise.resolve(),
    segments: new MP4Segments(),
    startedAt: 0,
    lastChunkAt: 0,
  };
  active = state;

  await putRecording({
    recordingId: state.recordingId,
    recordingKey: state.recordingKey,
    createdAt: Date.now(),
    mimeType: state.mimeType,
    audio: Boolean(audioTrack),
    state: 'RECORDING',
    chunks: 0,
    bytes: 0,
    uploaded: 0,
  });

  recorder.ondataavailable = ({ data }) => {
    if (data.size === 0) return;
    const endMs = performance.now() - state.startedAt;
    const startMs = state.lastChunkAt;
    state.lastChunkAt = endMs;
    state.processing = state.processing.then(async () => {
      for (const part of await state.segments.push(data)) {
        const sequence = ++state.sequence;
        state.bytes += part.data.size;
        const write = putChunk({
          recordingId: state.recordingId, recordingKey: state.recordingKey, sequence,
          createdAt: Date.now(), mimeType: state.mimeType, byteLength: part.data.size,
          payload: part.data, kind: part.kind, durationMs: part.durationMs, startMs, endMs,
          uploadState: 'queued', retryCount: 0,
        }).then(() => updateRecording(state.recordingId, { chunks: state.sequence, bytes: state.bytes }));
        state.writes.push(write);
        state.uploads = state.uploads.then(() => write).then(() => upload(state, sequence, part, startMs, endMs));
        await write;
      }
    });
    void state.processing.catch((error: unknown) => console.error(LOG, 'MP4 processing failed', error));
  };

  recorder.onerror = (event) => {
    console.error(LOG, 'recorder error', event);
  };

  // The tab closing, or Chrome revoking the capture, ends the track. The recorder is told
  // to flush what it has and the service worker is told the recording is over.
  videoTrack.addEventListener('ended', () => {
    void endBecause('capture-ended');
  });

  state.startedAt = performance.now();
  recorder.start(message.options.timesliceMs);
  console.log(LOG, 'recording', state.recordingId, state.mimeType, videoTrack.getSettings());

  const settings = videoTrack.getSettings();
  return {
    ok: true,
    mimeType: state.mimeType,
    audio: Boolean(audioTrack),
    video: { width: settings.width, height: settings.height, frameRate: settings.frameRate },
  };
}

async function finish(state: Active): Promise<{ chunks: number; bytes: number }> {
  if (state.recorder.state !== 'inactive') {
    await new Promise<void>((resolve) => {
      state.recorder.addEventListener('stop', () => resolve(), { once: true });
      state.recorder.stop();
    });
  }
  try {
    await state.processing;
    state.segments.finish();
  } finally {
    for (const track of state.stream.getTracks()) track.stop();
    await state.audioContext?.close();
  }
  await Promise.all(state.writes);
  return { chunks: state.sequence, bytes: state.bytes };
}

// The tail after a stop: wait for the last upload, tell the backend it has everything, and
// tell the service worker the recording is finalized. Runs after the stop reply has gone out.
async function finalize(state: Active, totals: { chunks: number; bytes: number }, reason: string | undefined): Promise<void> {
  await state.uploads;
  if (state.uploaded !== totals.chunks) {
    console.warn(LOG, 'not finalizing', state.recordingId, `${state.uploaded} of ${totals.chunks} chunks uploaded`);
    return;
  }
  try {
    const response = await fetch(`${state.apiBaseUrl}/api/recordings/${state.recordingId}/stop`, {
      method: 'POST',
      body: JSON.stringify({ ...totals, reason }),
      headers: { 'content-type': 'application/json' },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const meta = (await response.json()) as { url?: string };
    const url = `${state.apiBaseUrl}${meta.url ?? ''}`;
    await updateRecording(state.recordingId, { state: 'FINALIZED', url });
    await tellServiceWorker({ type: 'RECORDING_FINALIZED', recordingId: state.recordingId, ...totals, url });
    console.log(LOG, 'finalized', state.recordingId, url);
  } catch (error) {
    console.error(LOG, 'finalize failed', state.recordingId, error);
  }
}

async function stop(message: Extract<ToOffscreen['message'], { type: 'stop' }>): Promise<Record<string, unknown>> {
  const state = active;
  if (!state || state.recordingId !== message.recordingId) {
    return { ok: false, detail: state ? `recording ${state.recordingId}, not ${message.recordingId}` : 'not recording' };
  }
  active = undefined;
  state.ended = true;
  const totals = await finish(state);
  await updateRecording(state.recordingId, {
    state: message.reason ? 'ENDED' : 'STOPPED',
    endedReason: message.reason,
    ...totals,
  });
  console.log(LOG, 'stopped', state.recordingId, message.reason ?? 'by request', totals);
  void finalize(state, totals, message.reason);
  return { ok: true, ...totals, uploaded: state.uploaded };
}

async function endBecause(reason: string): Promise<void> {
  const state = active;
  if (!state || state.ended) return;
  state.ended = true;
  active = undefined;
  const totals = await finish(state);
  await updateRecording(state.recordingId, { state: 'ENDED', endedReason: reason, ...totals });
  await tellServiceWorker({ type: 'CAPTURE_ENDED', recordingId: state.recordingId, reason });
  await finalize(state, totals, reason);
}

function status(message: Extract<ToOffscreen['message'], { type: 'status' }>): Record<string, unknown> {
  const state = active;
  if (!state || state.recordingId !== message.recordingId) return { ok: false, detail: 'not recording' };
  return { ok: true, chunks: state.sequence, bytes: state.bytes, uploaded: state.uploaded, mimeType: state.mimeType };
}

chrome.runtime.onMessage.addListener((envelope: unknown, _sender, sendResponse) => {
  const typed = envelope as Partial<ToOffscreen> | null;
  if (!typed || typed.target !== 'offscreen' || !typed.message) return false;
  const message = typed.message;
  const work =
    message.type === 'start' ? start(message) : message.type === 'stop' ? stop(message) : Promise.resolve(status(message));
  work.then(sendResponse, (error: unknown) => {
    console.error(LOG, message.type, 'failed', error);
    sendResponse({ ok: false, detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  });
  return true;
});
