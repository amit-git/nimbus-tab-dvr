// Copyright (C) 2026 Niels Joubert
// SPDX-License-Identifier: MIT

// The messages between the host application and the extension, and between the extension's
// own contexts. Types only: the content script imports this file, and a content script is a
// classic script that cannot import code, so nothing here may survive compilation.

export type AppSource = 'nimbus-tab-dvr/app';
export type ExtensionSource = 'nimbus-tab-dvr/extension';

export interface CaptureOptions {
  audio: boolean;
  targetFps: number;
  maxWidth: number;
  maxHeight: number;
  videoBitsPerSecond: number;
  timesliceMs: number;
  mimeType?: string;
}

// What the application sends. `options` is accepted only so the demo can vary the capture
// from the page; a deployment takes them from managed configuration.
export type AppRequest =
  | { type: 'PING'; requestId: string }
  | { type: 'PROBE_CAPTURE'; requestId: string }
  | { type: 'GET_RECORDING_STATUS'; requestId: string }
  | {
      type: 'START_RECORDING';
      requestId: string;
      recordingKey: string;
      metadata?: Record<string, unknown>;
      options?: Partial<CaptureOptions>;
    }
  | { type: 'STOP_RECORDING'; requestId: string; recordingKey: string };

export type ErrorCode =
  | 'ORIGIN_NOT_ALLOWED'
  | 'NO_TAB'
  | 'ALREADY_RECORDING'
  | 'NOT_RECORDING'
  | 'CAPTURE_FAILED'
  | 'RECORDER_FAILED'
  | 'OFFSCREEN_GONE'
  | 'EXTENSION_UNREACHABLE';

// The life of a recording as the tab sees it. RECORDING is live; STOPPED and ENDED are the
// two ways it left that state, by request or by the extension; FINALIZED means the backend
// has the whole of it.
export type RecordingState = 'IDLE' | 'RECORDING' | 'STOPPED' | 'ENDED' | 'FINALIZED';

export type ExtensionReply =
  | { type: 'PONG'; requestId: string; extensionVersion: string; extensionId: string }
  | { type: 'CAPTURE_PROBED'; requestId: string; ok: boolean; detail: string }
  | {
      type: 'RECORDING_STATUS';
      requestId: string;
      state: RecordingState;
      recordingKey?: string;
      recordingId?: string;
      startedAt?: number;
      mimeType?: string;
      chunks?: number;
      bytes?: number;
      uploaded?: number;
      reason?: string;
      url?: string;
    }
  | {
      type: 'RECORDING_STARTED';
      requestId: string;
      recordingKey: string;
      recordingId: string;
      mimeType: string;
      video: { width?: number; height?: number; frameRate?: number };
      audio: boolean;
    }
  | {
      type: 'RECORDING_STOPPED';
      requestId: string;
      recordingKey: string;
      recordingId: string;
      chunks: number;
      bytes: number;
    }
  | {
      type: 'RECORDING_ERROR';
      requestId: string;
      recordingKey?: string;
      code: ErrorCode;
      detail: string;
      recoverable: boolean;
    };

// What the extension posts to the page unasked. Lost without consequence if no page is there,
// because GET_RECORDING_STATUS carries the same facts.
export type ExtensionEvent =
  | { type: 'RECORDING_FINALIZED'; recordingKey: string; recordingId: string; chunks: number; bytes: number; url: string }
  | { type: 'RECORDING_ENDED'; recordingKey: string; recordingId: string; reason: string };

// The envelope on the page's window. Both directions carry a `source` so a page script can
// tell its own messages from the extension's.
export type AppMessage = AppRequest & { source: AppSource };
export type ExtensionMessage = (ExtensionReply | ExtensionEvent) & { source: ExtensionSource };

// Inside the extension every runtime message names its target, because the service worker,
// the offscreen document, the content script and the console page all listen on the same channel.
export type ToServiceWorker = {
  target: 'service-worker';
  message:
    | AppRequest
    | { type: 'CAPTURE_ENDED'; recordingId: string; reason: string }
    | { type: 'RECORDING_FINALIZED'; recordingId: string; chunks: number; bytes: number; url: string }
    | { type: 'STATUS' };
};

export type ToOffscreen = {
  target: 'offscreen';
  message:
    | {
        type: 'start';
        streamId: string;
        recordingId: string;
        recordingKey: string;
        options: CaptureOptions;
        apiBaseUrl: string;
      }
    | { type: 'stop'; recordingId: string; reason?: string }
    | { type: 'status'; recordingId: string };
};

export type ToContentScript = {
  target: 'content-script';
  message: ExtensionEvent;
};

export interface RecordingRecord {
  recordingId: string;
  recordingKey: string;
  createdAt: number;
  mimeType: string;
  audio: boolean;
  state: 'RECORDING' | 'STOPPED' | 'ENDED' | 'FINALIZED';
  chunks: number;
  bytes: number;
  uploaded: number;
  endedReason?: string;
  url?: string;
}

export interface ChunkRecord {
  recordingId: string;
  recordingKey: string;
  sequence: number;
  createdAt: number;
  mimeType: string;
  byteLength: number;
  payload: Blob;
  kind?: 'init' | 'media';
  durationMs?: number;
  startMs?: number;
  endMs?: number;
  uploadState: 'queued' | 'uploaded' | 'failed';
  retryCount: number;
}

export interface TabRecording {
  recordingId: string;
  recordingKey: string;
  tabId: number;
  origin: string;
  startedAt: number;
  mimeType: string;
}

// What a tab's last recording became, kept so a status question after the fact has an answer.
export interface FinishedRecording extends TabRecording {
  state: 'STOPPED' | 'ENDED' | 'FINALIZED';
  chunks: number;
  bytes: number;
  reason?: string;
  url?: string;
}

export interface Status {
  extensionVersion: string;
  chrome: string;
  recordings: Record<string, TabRecording>;
  finished: Record<string, FinishedRecording>;
  invocations: { tabId: number; how: string; at: number }[];
  allowedOrigins: string[];
  apiBaseUrl: string;
  managedConfig: unknown;
  offscreen: boolean;
}
