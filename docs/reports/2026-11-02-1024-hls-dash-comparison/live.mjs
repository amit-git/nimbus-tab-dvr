// Copyright (C) 2026 Niels Joubert
// SPDX-License-Identifier: MIT

// MediaRecorder chunks served unmodified as live HLS to native players opened at different moments.
// Usage, from the repository root: node docs/reports/2026-11-02-1024-hls-dash-comparison/live.mjs WORKDIR
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const repo = process.cwd();
const require = createRequire(`${repo}/package.json`);
const { chromium } = require('@playwright/test');
const root = path.join(path.resolve(process.argv[2] ?? '.'), 'live');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

const header = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:0\n';
const segments = [];
let ended = false;
const eventPlaylist = () =>
  `${header}#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI="init.mp4"\n` +
  segments.map((s) => `#EXTINF:${s.duration.toFixed(3)},\n${s.name}\n`).join('') +
  (ended ? '#EXT-X-ENDLIST\n' : '');
const holePlaylist = () =>
  `${header}#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="init.mp4"\n` +
  segments
    .map((s, i) => (i === 3 ? '#EXT-X-DISCONTINUITY\n' : `#EXTINF:${s.duration.toFixed(3)},\n${s.name}\n`))
    .join('') +
  '#EXT-X-ENDLIST\n';

function measure(file) {
  const lines = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file])
    .toString()
    .trim()
    .split('\n')
    .map((l) => parseFloat(l));
  return { first: lines[0], duration: lines[lines.length - 1] - lines[0] + 1 / 15, frames: lines.length };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('cache-control', 'no-store');
  if (url.pathname === '/blank.html') {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>probe</title><body></body>');
    return;
  }
  if (req.method === 'POST' && url.pathname === '/live/end') {
    ended = true;
    res.end('ok');
    return;
  }
  if (req.method === 'POST') {
    const n = Number(url.pathname.split('/')[2]);
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      if (n === 1) {
        fs.writeFileSync(path.join(root, 'init.mp4'), body);
      } else {
        const name = `s${String(n).padStart(4, '0')}.m4s`;
        fs.writeFileSync(path.join(root, name), body);
        const probe = path.join(root, 'probe.bin');
        fs.writeFileSync(probe, Buffer.concat([fs.readFileSync(path.join(root, 'init.mp4')), body]));
        const m = measure(probe);
        segments.push({ name, ...m, bytes: body.length });
      }
      res.end('ok');
    });
    return;
  }
  if (url.pathname.endsWith('.m3u8')) {
    res.setHeader('content-type', 'application/vnd.apple.mpegurl');
    if (url.pathname.endsWith('hole.m3u8')) res.end(holePlaylist());
    else if (url.pathname.endsWith('plain.m3u8')) res.end(eventPlaylist().replace('#EXT-X-PLAYLIST-TYPE:EVENT\n', ''));
    else res.end(eventPlaylist());
    return;
  }
  const file = path.join(root, url.pathname.replace('/live/', ''));
  if (!fs.existsSync(file)) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader('content-type', file.endsWith('.m4s') ? 'video/iso.segment' : 'video/mp4');
  const body = fs.readFileSync(file);
  res.setHeader('accept-ranges', 'bytes');
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : body.length - 1;
    res.statusCode = 206;
    res.setHeader('content-range', `bytes ${start}-${end}/${body.length}`);
    res.end(body.subarray(start, end + 1));
    return;
  }
  res.end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
console.log('version', browser.version());
const page = await browser.newPage();
await page.goto(`${base}/blank.html`);

const live = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const c = document.createElement('canvas');
  c.width = 1280;
  c.height = 720;
  const g = c.getContext('2d');
  let n = 0;
  const tick = setInterval(() => {
    n += 1;
    g.fillStyle = `hsl(${(n * 3) % 360} 70% 50%)`;
    g.fillRect(0, 0, 1280, 720);
    g.fillStyle = '#fff';
    g.font = '120px sans-serif';
    g.fillText(String(n), 100 + (n * 7) % 600, 300);
  }, 66);
  const stream = c.captureStream(15);
  const audio = new AudioContext();
  const osc = audio.createOscillator();
  const dest = audio.createMediaStreamDestination();
  osc.connect(dest);
  osc.start();
  stream.addTrack(dest.stream.getAudioTracks()[0]);

  const players = [
    { label: 'event@chunk3', url: '/live/index.m3u8', after: 3 },
    { label: 'event@chunk6', url: '/live/index.m3u8', after: 6 },
    { label: 'event@chunk10', url: '/live/index.m3u8', after: 10 },
    { label: 'plain@chunk10', url: '/live/plain.m3u8', after: 10 },
  ].map((p) => {
    const v = document.createElement('video');
    v.muted = true;
    document.body.append(v);
    return { ...p, v, openedAt: null, firstPlayingAt: null };
  });
  const rec = new MediaRecorder(stream, { mimeType: 'video/mp4;codecs=vp9,opus', videoBitsPerSecond: 3e6, videoKeyFrameIntervalDuration: 2000 });
  let seq = 0;
  let uploads = Promise.resolve();
  const t0 = performance.now();
  const elapsed = () => (performance.now() - t0) / 1000;
  for (const p of players) {
    p.v.addEventListener('timeupdate', () => {
      if (p.firstPlayingAt === null && p.v.currentTime > 0) p.firstPlayingAt = elapsed();
    });
  }
  rec.ondataavailable = (e) => {
    if (!e.data.size) return;
    const i = ++seq;
    uploads = uploads
      .then(() => fetch(`/live/${i}`, { method: 'POST', body: e.data }))
      .then(() => {
        for (const p of players) {
          if (p.after === i) {
            p.openedAt = elapsed();
            p.v.src = p.url;
            p.v.play().catch(() => undefined);
          }
        }
      });
  };
  rec.start(2000);
  const samples = [];
  const sampler = setInterval(() => {
    const at = elapsed();
    samples.push(
      `t=${at.toFixed(0)} ` +
        players
          .map((p) => `${p.label}: ${p.v.error ? 'ERR' : `cur=${p.v.currentTime.toFixed(1)} behind=${(at - p.v.currentTime).toFixed(1)} rs=${p.v.readyState}`}`)
          .join(' | '),
    );
  }, 5000);
  await sleep(40000);
  await new Promise((resolve) => {
    rec.onstop = resolve;
    rec.stop();
  });
  clearInterval(tick);
  await uploads;
  await fetch('/live/end', { method: 'POST' });
  await sleep(14000);
  clearInterval(sampler);
  const final = players.map((p) => ({
    label: p.label,
    openedAt: p.openedAt,
    firstPlayingAt: p.firstPlayingAt,
    cur: p.v.currentTime,
    duration: p.v.duration,
    ended: p.v.ended,
    err: p.v.error?.message,
  }));
  for (const p of players) p.v.remove();
  return { samples, final };
});
for (const s of live.samples) console.log(s);
for (const p of live.final) console.log(JSON.stringify(p));
console.log('segments', segments.length, 'durations', segments.map((s) => s.duration.toFixed(2)).join(' '));

// A lost segment, and the concatenation played as one plain file.
const all = path.join(root, 'all.mp4');
fs.writeFileSync(all, Buffer.concat([fs.readFileSync(path.join(root, 'init.mp4')), ...segments.map((s) => fs.readFileSync(path.join(root, s.name)))]));
console.log('streams in all.mp4', execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'csv=p=0', all]).toString().trim().replace(/\n/g, ' '));
console.log('format duration', execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', all]).toString().trim());
for (const [label, url, seekTo] of [
  ['one segment missing (s0005)', '/live/hole.m3u8', 15],
  ['concatenation as one file', '/live/all.mp4', 15],
]) {
  const result = await page.evaluate(
    async ({ url, seekTo }) => {
      const v = document.createElement('video');
      v.muted = true;
      document.body.append(v);
      const out = {};
      out.load = await new Promise((resolve) => {
        v.onloadedmetadata = () => resolve('metadata');
        v.onerror = () => resolve(`error ${v.error?.message}`);
        setTimeout(() => resolve('timeout'), 8000);
        v.src = url;
      });
      out.duration = v.duration;
      out.seekableEnd = v.seekable.length ? v.seekable.end(v.seekable.length - 1) : null;
      if (out.load === 'metadata') {
        v.currentTime = seekTo;
        await new Promise((r) => {
          v.onseeked = r;
          setTimeout(r, 4000);
        });
        out.afterSeek = v.currentTime;
        await v.play().catch((e) => (out.playError = String(e)));
        await new Promise((r) => setTimeout(r, 2000));
        out.playedTo = v.currentTime;
        out.err = v.error?.message;
      }
      v.remove();
      return out;
    },
    { url, seekTo },
  );
  console.log(label, JSON.stringify(result));
}
await browser.close();
server.close();
