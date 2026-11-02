// Copyright (C) 2026 Niels Joubert
// SPDX-License-Identifier: MIT

import Hls from 'hls.js';
import type { BackendRecording } from './bridge';
import { announceExtension, formatBytes, listBackendRecordings, log, onExtensionEvent, showReply, wireProbe } from './bridge';

const last = sessionStorage.getItem('lastReply');
if (last) {
  const el = document.querySelector<HTMLElement>('#last')!;
  el.textContent = `last reply: ${last}`;
  el.dataset.type = JSON.parse(last).type;
}

document.querySelector<HTMLButtonElement>('#start')!.addEventListener('click', () => {
  const audio = document.querySelector<HTMLInputElement>('#audio')!.checked ? '1' : '0';
  const timeslice = document.querySelector<HTMLInputElement>('#timeslice')!.value;
  log(`starting audio=${audio} timeslice=${timeslice}`);
  window.location.href = `record.html?audio=${audio}&timeslice=${timeslice}`;
});

// A recording started in another tab finishes while this page is open, so the event shows
// here as well as on the page that asked for it.
onExtensionEvent((event) => {
  showReply(document.querySelector<HTMLElement>('#last')!, event);
  void refresh();
});

const tbody = document.querySelector<HTMLTableSectionElement>('#recordings tbody')!;
const player = document.querySelector<HTMLVideoElement>('#player')!;
const playing = document.querySelector<HTMLElement>('#playing')!;
const backend = document.querySelector<HTMLElement>('#backend')!;

function cell(text: string, className = ''): HTMLTableCellElement {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

let hls: Hls | undefined;

function play(recording: BackendRecording): void {
  hls?.destroy();
  hls = undefined;
  const url = recording.url ?? '';
  if (Hls.isSupported()) {
    hls = new Hls({ startPosition: 0 });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) playing.textContent = `Playback failed: ${data.details}`;
    });
    hls.loadSource(url);
    hls.attachMedia(player);
    hls.on(Hls.Events.MANIFEST_PARSED, () => void player.play().catch((error: unknown) => log(String(error))));
  } else if (player.canPlayType('application/vnd.apple.mpegurl')) {
    player.src = url;
    void player.play().catch((error: unknown) => log(String(error)));
  } else {
    playing.textContent = 'HLS playback is not supported in this browser';
    return;
  }
  player.dataset.recordingId = recording.id;
  playing.textContent = `${recording.key} (${recording.id.slice(0, 8)}), ${recording.durationSeconds?.toFixed(1) ?? '?'} s`;

}

async function remove(recording: BackendRecording): Promise<void> {
  await fetch(`/api/recordings/${recording.id}`, { method: 'DELETE' });
  if (player.dataset.recordingId === recording.id) {
    hls?.destroy();
    hls = undefined;
    player.removeAttribute('src');
    player.load();
    playing.textContent = '';
  }
  await refresh();
}

function render(recordings: BackendRecording[]): void {
  tbody.replaceChildren();
  for (const recording of recordings) {
    const tr = document.createElement('tr');
    tr.dataset.recordingId = recording.id;
    tr.dataset.state = recording.state;
    const duration = recording.durationSeconds != null ? `${recording.durationSeconds.toFixed(1)} s` : '';
    tr.append(
      cell(recording.key),
      cell(new Date(recording.startedAt).toLocaleTimeString()),
      cell(recording.state + (recording.reason ? ` (${recording.reason})` : ''), 'state'),
      cell(String(recording.chunks), 'chunks'),
      cell(formatBytes(recording.bytes), 'bytes'),
      cell(duration, 'duration'),
    );
    const actions = document.createElement('td');
    if (recording.url?.endsWith('.m3u8') && recording.chunks > 1) {
      const playButton = document.createElement('button');
      playButton.textContent = 'Play';
      playButton.className = 'play';
      playButton.onclick = () => play(recording);
      actions.append(playButton);
    }
    const deleteButton = document.createElement('button');
    deleteButton.textContent = 'Delete';
    deleteButton.className = 'delete';
    deleteButton.onclick = () => void remove(recording);
    actions.append(deleteButton);
    tr.append(actions);
    tbody.append(tr);
  }
}

// Polls every second: the backend is on this origin and the count ticking is the point.
async function refresh(): Promise<void> {
  try {
    const recordings = await listBackendRecordings();
    render(recordings);
    const live = recordings.filter((r) => r.state === 'recording').length;
    backend.dataset.state = 'up';
    backend.textContent = live ? `backend is up, ${live} recording live` : `backend is up, ${recordings.length} recordings`;
  } catch (error) {
    backend.dataset.state = 'down';
    backend.textContent = `backend is not answering: ${String(error)}`;
  }
}

wireProbe();
void announceExtension();
void refresh();
setInterval(() => void refresh(), 1000);
