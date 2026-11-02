// Copyright (C) 2026 Niels Joubert
// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Recording is what the backend knows about one recording: its meta.json, and the shape the
// landing page reads. Times are milliseconds since the epoch, as JavaScript writes them.
type Chunk struct {
	Sequence   int     `json:"sequence"`
	Kind       string  `json:"kind"`
	DurationMs float64 `json:"durationMs"`
	StartMs    float64 `json:"startMs"`
	EndMs      float64 `json:"endMs"`
	Bytes      int64   `json:"bytes"`
}

type Recording struct {
	Parts           []Chunk  `json:"parts,omitempty"`
	ID              string   `json:"id"`
	Key             string   `json:"key"`
	MimeType        string   `json:"mimeType"`
	StartedAt       int64    `json:"startedAt"`
	State           string   `json:"state"`
	Chunks          int      `json:"chunks"`
	Bytes           int64    `json:"bytes"`
	LastChunkAt     int64    `json:"lastChunkAt,omitempty"`
	FinalizedAt     int64    `json:"finalizedAt,omitempty"`
	DurationSeconds *float64 `json:"durationSeconds,omitempty"`
	Reason          string   `json:"reason,omitempty"`
	URL             string   `json:"url,omitempty"`
}

const (
	StateRecording = "recording"
	StateFinalized = "finalized"
)

var validID = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

var errNotFound = errors.New("no such recording")

// Store keeps the HLS playlist, initialization and media segments together.
// Metadata retains recording identity and upload bookkeeping across server restarts.
type Store struct {
	root string
	mu   sync.Mutex
}

func newStore(root string) (*Store, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	s := &Store{root: root}
	// Recover playlists after an interrupted update and materialize older dynamic playlists.
	recs, err := s.List()
	if err != nil {
		return nil, err
	}
	for _, rec := range recs {
		if strings.HasSuffix(rec.URL, "/index.m3u8") {
			if err := s.writeManifest(rec); err != nil {
				return nil, err
			}
		}
	}
	return s, nil
}

func (s *Store) dir(id string) string { return filepath.Join(s.root, id) }

func (s *Store) read(id string) (*Recording, error) {
	raw, err := os.ReadFile(filepath.Join(s.dir(id), "meta.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	var rec Recording
	if err := json.Unmarshal(raw, &rec); err != nil {
		return nil, err
	}
	return &rec, nil
}

func (s *Store) write(rec *Recording) error {
	raw, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	if err := atomicWrite(filepath.Join(s.dir(rec.ID), "meta.json"), raw); err != nil {
		return err
	}
	return s.writeManifest(rec)
}

var errInvalid = errors.New("invalid upload")

// PutChunk stores browser-produced init and media bytes verbatim. Uploads are ordered and
// retries must match, so a playlist never advertises a gap or double counts a duration.
func (s *Store) PutChunk(id string, sequence int, key, mimeType string, payload []byte, part Chunk) (*Recording, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, err := s.read(id)
	if errors.Is(err, errNotFound) {
		rec = &Recording{ID: id, Key: key, MimeType: mimeType, StartedAt: now(), State: StateRecording,
			URL: "/api/recordings/" + id + "/index.m3u8"}
	} else if err != nil {
		return nil, err
	}
	if rec.State != StateRecording || rec.Key != key || rec.MimeType != mimeType {
		return nil, errInvalid
	}
	if sequence < 1 || part.Sequence != sequence || part.Bytes != int64(len(payload)) {
		return nil, errInvalid
	}
	if sequence <= len(rec.Parts) {
		old := rec.Parts[sequence-1]
		existing, err := os.ReadFile(filepath.Join(s.dir(id), chunkName(old)))
		if err != nil {
			return nil, err
		}
		if old != part || !bytes.Equal(existing, payload) {
			return nil, errInvalid
		}
		return rec, s.writeManifest(rec)
	}
	if sequence != len(rec.Parts)+1 || len(payload) == 0 || !strings.HasPrefix(mimeType, "video/mp4") ||
		(sequence == 1 && part.Kind != "init") || (sequence > 1 && part.Kind != "media") ||
		math.IsNaN(part.DurationMs) || math.IsInf(part.DurationMs, 0) ||
		(part.Kind == "init" && part.DurationMs != 0) || (part.Kind == "media" && (part.DurationMs <= 0 || part.DurationMs > 10000)) ||
		math.IsNaN(part.StartMs) || math.IsInf(part.StartMs, 0) || math.IsNaN(part.EndMs) || math.IsInf(part.EndMs, 0) || part.StartMs < 0 || part.EndMs < part.StartMs {
		return nil, errInvalid
	}
	if err := os.MkdirAll(s.dir(id), 0755); err != nil {
		return nil, err
	}
	if err := atomicWrite(filepath.Join(s.dir(id), chunkName(part)), payload); err != nil {
		return nil, err
	}
	rec.Parts = append(rec.Parts, part)
	rec.Chunks = len(rec.Parts)
	rec.Bytes += int64(len(payload))
	duration := 0.0
	for _, p := range rec.Parts {
		duration += p.DurationMs / 1000
	}
	rec.DurationSeconds = &duration
	rec.LastChunkAt = now()
	if err := s.write(rec); err != nil {
		return nil, err
	}
	return rec, nil
}

func chunkName(part Chunk) string {
	if part.Kind == "init" {
		return "init.mp4"
	}
	return fmt.Sprintf("%06d.m4s", part.Sequence)
}
func atomicWrite(path string, data []byte) error {
	if err := os.WriteFile(path+".tmp", data, 0644); err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}

// EVENT retains the complete timeline for DVR seeking. TARGETDURATION stays fixed for the
// life of the playlist; uploads exceeding the ten-second contract are rejected.
func (s *Store) writeManifest(rec *Recording) error {
	var out strings.Builder
	out.WriteString("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI=\"init.mp4\"\n")
	for _, part := range rec.Parts {
		if part.Kind != "media" {
			continue
		}
		fmt.Fprintf(&out, "#EXTINF:%.6f,\n%s\n", part.DurationMs/1000, chunkName(part))
	}
	if rec.State == StateFinalized {
		out.WriteString("#EXT-X-ENDLIST\n")
	}
	return atomicWrite(filepath.Join(s.dir(rec.ID), "index.m3u8"), []byte(out.String()))
}

func (s *Store) Finalize(id, reason string, chunks int, totalBytes int64) (*Recording, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, err := s.read(id)
	if err != nil {
		return nil, err
	}
	if rec.Chunks != chunks || rec.Bytes != totalBytes || len(rec.Parts) < 2 {
		return nil, errInvalid
	}
	if rec.State == StateFinalized {
		return rec, s.writeManifest(rec)
	}
	rec.State = StateFinalized
	rec.FinalizedAt = now()
	rec.Reason = reason
	return rec, s.write(rec)
}

// List returns every recording, newest first.
func (s *Store) List() ([]*Recording, error) {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return nil, err
	}
	recs := []*Recording{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		rec, err := s.read(e.Name())
		if err != nil {
			continue
		}
		recs = append(recs, rec)
	}
	sort.Slice(recs, func(i, j int) bool { return recs[i].StartedAt > recs[j].StartedAt })
	return recs, nil
}

func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return os.RemoveAll(s.dir(id))
}

func now() int64 { return time.Now().UnixMilli() }
