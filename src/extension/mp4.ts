// Copyright (C) 2026 Niels Joubert
// SPDX-License-Identifier: MIT

interface Box { type: string; data: Uint8Array; header: number }

function boxes(data: Uint8Array): Box[] {
  const result: Box[] = [];
  for (let offset = 0; offset + 8 <= data.length;) {
    const view = new DataView(data.buffer, data.byteOffset + offset);
    let size = view.getUint32(0);
    const header = size === 1 ? 16 : 8;
    if (size === 1) {
      if (view.byteLength < 16) break;
      size = Number(view.getBigUint64(8));
    }
    if (size === 0) size = data.length - offset;
    if (size < header) throw new Error('Invalid MP4 box size');
    if (offset + size > data.length) break;
    result.push({ type: String.fromCharCode(...data.subarray(offset + 4, offset + 8)), data: data.slice(offset, offset + size), header });
    offset += size;
  }
  return result;
}

function children(box: Box): Box[] { return boxes(box.data.subarray(box.header)); }
function view(box: Box): DataView { return new DataView(box.data.buffer, box.data.byteOffset + box.header, box.data.length - box.header); }

export interface MP4Part { data: Blob; durationMs: number; kind: 'init' | 'media' }

// Recorder timeslices can cut through boxes. Preserve the original bytes, and only publish
// complete moof/mdat pairs. EXTINF follows media sample durations rather than callback jitter.
export class MP4Segments {
  private pending = new Uint8Array(0);
  private init: Uint8Array[] = [];
  private fragment?: Box;
  private tracks = new Map<number, { scale: number; duration: number; video: boolean }>();

  async push(blob: Blob): Promise<MP4Part[]> {
    const incoming = new Uint8Array(await blob.arrayBuffer());
    const combined = new Uint8Array(this.pending.length + incoming.length);
    combined.set(this.pending);
    combined.set(incoming, this.pending.length);
    const complete = boxes(combined);
    this.pending = combined.slice(complete.reduce((size, box) => size + box.data.length, 0));
    const parts: MP4Part[] = [];
    for (const box of complete) {
      if (box.type === 'ftyp' || box.type === 'moov') {
        this.init.push(box.data);
        if (box.type === 'moov') {
          this.readTracks(box);
          parts.push({ kind: 'init', data: new Blob(this.init.map((data) => data.slice().buffer), { type: 'video/mp4' }), durationMs: 0 });
          this.init = [];
        }
      } else if (box.type === 'moof') {
        if (this.fragment) throw new Error('Missing MP4 media data');
        this.fragment = box;
      } else if (box.type === 'mdat') {
        if (!this.fragment) throw new Error('Missing MP4 fragment header');
        const durationMs = this.duration(this.fragment);
        if (!(durationMs > 0)) throw new Error('MP4 fragment has no sample duration');
        parts.push({ kind: 'media', data: new Blob([this.fragment.data.slice().buffer, box.data.slice().buffer], { type: 'video/mp4' }), durationMs });
        this.fragment = undefined;
      }
    }
    return parts;
  }

  finish(): void {
    if (this.pending.length || this.fragment || this.init.length) throw new Error('Incomplete MP4 recording');
  }

  private readTracks(moov: Box): void {
    for (const trak of children(moov).filter((box) => box.type === 'trak')) {
      const tkhd = children(trak).find((box) => box.type === 'tkhd')!;
      const tk = view(tkhd);
      const id = tk.getUint32(tk.getUint8(0) === 1 ? 20 : 12);
      const mdia = children(trak).find((box) => box.type === 'mdia')!;
      const mdhd = view(children(mdia).find((box) => box.type === 'mdhd')!);
      const hdlr = view(children(mdia).find((box) => box.type === 'hdlr')!);
      this.tracks.set(id, { scale: mdhd.getUint32(mdhd.getUint8(0) === 1 ? 20 : 12), duration: 0, video: hdlr.getUint32(8) === 0x76696465 });
    }
    const mvex = children(moov).find((box) => box.type === 'mvex');
    for (const trex of mvex ? children(mvex).filter((box) => box.type === 'trex') : []) {
      const v = view(trex);
      const track = this.tracks.get(v.getUint32(4));
      if (track) track.duration = v.getUint32(12);
    }
  }

  private duration(moof: Box): number {
    let video = 0;
    let longest = 0;
    for (const traf of children(moof).filter((box) => box.type === 'traf')) {
      const tfhd = view(children(traf).find((box) => box.type === 'tfhd')!);
      const flags = tfhd.getUint32(0) & 0xffffff;
      const track = this.tracks.get(tfhd.getUint32(4));
      if (!track) throw new Error('Unknown MP4 track');
      let offset = 8 + (flags & 1 ? 8 : 0) + (flags & 2 ? 4 : 0);
      const defaultDuration = flags & 8 ? tfhd.getUint32(offset) : track.duration;
      let ticks = 0;
      for (const run of children(traf).filter((box) => box.type === 'trun')) {
        const v = view(run);
        const f = v.getUint32(0) & 0xffffff;
        const count = v.getUint32(4);
        offset = 8 + (f & 1 ? 4 : 0) + (f & 4 ? 4 : 0);
        for (let sample = 0; sample < count; sample++) {
          ticks += f & 0x100 ? v.getUint32(offset) : defaultDuration;
          offset += (f & 0x100 ? 4 : 0) + (f & 0x200 ? 4 : 0) + (f & 0x400 ? 4 : 0) + (f & 0x800 ? 4 : 0);
        }
      }
      const duration = ticks * 1000 / track.scale;
      if (track.video) video = duration;
      longest = Math.max(longest, duration);
    }
    return video || longest;
  }
}
