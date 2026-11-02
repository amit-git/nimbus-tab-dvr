// Copyright (C) 2026 Niels Joubert
// SPDX-License-Identifier: MIT

// What Chrome plays natively and what MediaRecorder emits under five option sets.
// Usage, from the repository root: node docs/reports/2026-11-02-1024-hls-dash-comparison/probe.mjs WORKDIR
// WORKDIR holds timed.webm, hls2/ and dash/, written by the commands in the report.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const repo = process.cwd();
const require = createRequire(`${repo}/package.json`);
const { chromium } = require('@playwright/test');
const root = path.resolve(process.argv[2] ?? '.');

const types = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.mpd': 'application/dash+xml',
  '.webm': 'video/webm',
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/blank.html') {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>probe</title><body></body>');
    return;
  }
  const file = path.join(root, url.pathname);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const body = fs.readFileSync(file);
  res.setHeader('content-type', types[path.extname(file)] ?? 'application/octet-stream');
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

const configs = [
  { name: 'webm-vp9-default', mimeType: 'video/webm;codecs=vp9,opus', extra: {} },
  { name: 'webm-vp9-kf2s', mimeType: 'video/webm;codecs=vp9,opus', extra: { videoKeyFrameIntervalDuration: 2000 } },
  { name: 'mp4-avc1-default', mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', extra: {} },
  { name: 'mp4-avc1-kf2s', mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', extra: { videoKeyFrameIntervalDuration: 2000 } },
  { name: 'mp4-vp9-kf2s', mimeType: 'video/mp4;codecs=vp9,opus', extra: { videoKeyFrameIntervalDuration: 2000 } },
];

function boxes(buffer) {
  const out = [];
  let at = 0;
  while (at + 8 <= buffer.length && out.length < 12) {
    const size = buffer.readUInt32BE(at);
    const type = buffer.toString('latin1', at + 4, at + 8);
    if (!/^[a-z0-9 ]{4}$/.test(type) || size < 8) {
      out.push(`?@${at}`);
      break;
    }
    out.push(type);
    at += size;
  }
  return { list: out, endsOnBoundary: at === buffer.length };
}

function sh(command) {
  try {
    return execSync(command, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch (error) {
    return `ERR ${String(error.stderr).trim().split('\n').slice(-1)[0]}`;
  }
}

async function run(label, launch) {
  console.log(`\n===== ${label}`);
  const browser = await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
    ...launch,
  });
  console.log('version', browser.version());
  const page = await browser.newPage();
  await page.goto(`${base}/blank.html`);

  const caps = await page.evaluate((configs) => {
    const v = document.createElement('video');
    return {
      canPlay: Object.fromEntries(
        ['application/vnd.apple.mpegurl', 'application/x-mpegURL', 'application/dash+xml', 'video/webm;codecs=vp9,opus'].map((t) => [t, v.canPlayType(t)]),
      ),
      mse: Object.fromEntries(
        ['video/mp4; codecs="vp09.00.40.08"', 'audio/mp4; codecs="opus"', 'video/mp4; codecs="avc1.42E01E"', 'video/webm; codecs="vp9"'].map((t) => [t, MediaSource.isTypeSupported(t)]),
      ),
      recorder: Object.fromEntries(configs.map((c) => [c.mimeType, MediaRecorder.isTypeSupported(c.mimeType)])),
    };
  }, configs);
  console.log(JSON.stringify(caps, null, 1));

  for (const asset of ['timed.webm', 'hls2/index.m3u8', 'dash/index.mpd']) {
    const result = await page.evaluate(async (url) => {
      const v = document.createElement('video');
      v.muted = true;
      document.body.append(v);
      const out = {};
      out.load = await new Promise((resolve) => {
        v.onloadedmetadata = () => resolve('metadata');
        v.onerror = () => resolve(`error ${v.error?.code} ${v.error?.message}`);
        setTimeout(() => resolve('timeout'), 8000);
        v.src = url;
      });
      out.duration = v.duration;
      if (out.load === 'metadata') {
        await v.play().catch((e) => (out.playError = String(e)));
        await new Promise((r) => setTimeout(r, 1500));
        out.playedTo = v.currentTime;
        v.currentTime = 20;
        await new Promise((r) => {
          v.onseeked = r;
          setTimeout(r, 4000);
        });
        out.afterSeek = v.currentTime;
        out.frames = v.getVideoPlaybackQuality().totalVideoFrames;
      }
      v.remove();
      return out;
    }, `${base}/${asset}`);
    console.log(asset, JSON.stringify(result));
  }

  const recorded = await page.evaluate(async (configs) => {
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
    const recs = configs
      .filter((cfg) => MediaRecorder.isTypeSupported(cfg.mimeType))
      .map((cfg) => {
        const parts = [];
        const r = new MediaRecorder(stream, { mimeType: cfg.mimeType, videoBitsPerSecond: 3e6, ...cfg.extra });
        r.ondataavailable = (e) => {
          if (e.data.size) parts.push(e.data);
        };
        r.start(2000);
        return { cfg, r, parts };
      });
    await new Promise((r) => setTimeout(r, 13000));
    await Promise.all(
      recs.map(
        ({ r }) =>
          new Promise((resolve) => {
            r.onstop = resolve;
            r.stop();
          }),
      ),
    );
    clearInterval(tick);
    const out = {};
    for (const { cfg, parts } of recs) {
      out[cfg.name] = await Promise.all(
        parts.map(async (blob) => {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let s = '';
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(s);
        }),
      );
    }
    return out;
  }, configs);
  await browser.close();

  for (const [name, parts] of Object.entries(recorded)) {
    const dir = path.join(root, 'rec', label, name);
    fs.mkdirSync(dir, { recursive: true });
    const buffers = parts.map((b) => Buffer.from(b, 'base64'));
    buffers.forEach((b, i) => fs.writeFileSync(path.join(dir, `${String(i + 1).padStart(6, '0')}.chunk`), b));
    const all = path.join(dir, 'all.bin');
    fs.writeFileSync(all, Buffer.concat(buffers));
    console.log(`\n--- ${name}: ${buffers.length} chunks, sizes ${buffers.map((b) => b.length).join(' ')}`);
    const packets = sh(`ffprobe -v error -select_streams v:0 -show_entries packet=pts_time,flags -of csv=p=0 "${all}"`).split('\n');
    const keys = packets.filter((p) => p.includes('K')).map((p) => p.split(',')[0]);
    console.log(`video packets ${packets.length}, keyframes at ${keys.join(' ')}`);
    const isMp4 = name.startsWith('mp4');
    let init = null;
    if (isMp4) {
      const first = buffers[0];
      let at = 0;
      while (at + 8 <= first.length) {
        const size = first.readUInt32BE(at);
        const type = first.toString('latin1', at + 4, at + 8);
        if (type === 'moof') break;
        at += size;
      }
      init = first.subarray(0, at);
      console.log(`init bytes ${init.length}`);
    }
    buffers.forEach((b, i) => {
      const head = isMp4 ? JSON.stringify(boxes(b)) : b.subarray(0, 4).toString('hex');
      const lone = path.join(dir, `lone-${i + 1}.bin`);
      fs.writeFileSync(lone, init && i > 0 ? Buffer.concat([init, b]) : b);
      const first = sh(`ffprobe -v error -select_streams v:0 -show_entries packet=pts_time,flags -of csv=p=0 "${lone}" | head -1`);
      const count = sh(`ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "${lone}"`);
      console.log(`chunk ${i + 1}: ${head} | first packet ${first.split('\n')[0]} | decoded ${count.split('\n')[0]}`);
    });
  }
}

try {
  await run('playwright-chromium', {});
} catch (error) {
  console.log('playwright-chromium failed', String(error).slice(0, 300));
}
try {
  await run('google-chrome', { channel: 'chrome' });
} catch (error) {
  console.log('google-chrome failed', String(error).slice(0, 300));
}
server.close();
