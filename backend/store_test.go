// Copyright (C) 2026 Niels Joubert
// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEventPlaylistLifecycle(t *testing.T) {
	root := t.TempDir()
	store, err := newStore(root)
	if err != nil {
		t.Fatal(err)
	}
	upload := func(sequence int, kind string, duration float64) *Recording {
		t.Helper()
		payload := []byte{byte(sequence), 2, 3}
		part := Chunk{Sequence: sequence, Kind: kind, DurationMs: duration, StartMs: 0.125, EndMs: 2000.375, Bytes: 3}
		rec, err := store.PutChunk("test", sequence, "key", "video/mp4;codecs=avc1", payload, part)
		if err != nil {
			t.Fatal(err)
		}
		saved, err := os.ReadFile(filepath.Join(root, "test", chunkName(part)))
		if err != nil || !bytes.Equal(saved, payload) {
			t.Fatalf("segment changed: %v", err)
		}
		return rec
	}
	upload(1, "init", 0)
	upload(2, "media", 1234.56789)
	rec := upload(2, "media", 1234.56789)
	if rec.Chunks != 2 || rec.Bytes != 6 {
		t.Fatal("retry counted twice")
	}
	manifest, err := os.ReadFile(filepath.Join(root, "test", "index.m3u8"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(manifest), "#EXTINF:1.234568,") || strings.Contains(string(manifest), "ENDLIST") {
		t.Fatalf("bad live playlist: %s", manifest)
	}
	// Recover a missing playlist after restart, then extend the same event timeline.
	if err := os.Remove(filepath.Join(root, "test", "index.m3u8")); err != nil {
		t.Fatal(err)
	}
	store, err = newStore(root)
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := os.ReadFile(filepath.Join(root, "test", "index.m3u8"))
	if err != nil || !bytes.Equal(recovered, manifest) {
		t.Fatalf("playlist recovery: %v", err)
	}
	rec = upload(3, "media", 999.125)
	if math.Abs(*rec.DurationSeconds-2.23369289) > 0.00000001 {
		t.Fatal(*rec.DurationSeconds)
	}
	if _, err = store.Finalize("test", "", 2, 6); !errors.Is(err, errInvalid) {
		t.Fatal("accepted missing final upload")
	}
	rec, err = store.Finalize("test", "capture-ended", 3, 9)
	if err != nil {
		t.Fatal(err)
	}
	if rec.Reason != "capture-ended" || rec.State != StateFinalized {
		t.Fatal(rec)
	}
	manifest, err = os.ReadFile(filepath.Join(root, "test", "index.m3u8"))
	if err != nil || !strings.HasSuffix(string(manifest), "#EXT-X-ENDLIST\n") {
		t.Fatalf("not ended: %s %v", manifest, err)
	}
	if _, err = store.Finalize("test", "", 3, 9); err != nil {
		t.Fatal(err)
	}
	// Serving the playlist requires only the stored file, independent of JSON metadata.
	if err := os.Remove(filepath.Join(root, "test", "meta.json")); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	registerAPI(mux, store)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest("GET", "/api/recordings/test/index.m3u8", nil))
	if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), manifest) {
		t.Fatalf("stored playlist response: %d %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Content-Type") != "application/vnd.apple.mpegurl" || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(response.Header())
	}

}

func TestInvalidChunks(t *testing.T) {
	for _, test := range []struct {
		name     string
		sequence int
		part     Chunk
	}{
		{"gap", 2, Chunk{Kind: "media", DurationMs: 1000}},
		{"media before init", 1, Chunk{Kind: "media", DurationMs: 1000}},
		{"NaN", 1, Chunk{Kind: "init", DurationMs: math.NaN()}},
		{"invalid clock", 1, Chunk{Kind: "init", StartMs: 2, EndMs: 1}},
	} {
		t.Run(test.name, func(t *testing.T) {
			store, err := newStore(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			test.part.Sequence = test.sequence
			test.part.Bytes = 1
			_, err = store.PutChunk("test", test.sequence, "key", "video/mp4", []byte{1}, test.part)
			if !errors.Is(err, errInvalid) {
				t.Fatalf("accepted invalid chunk: %v", err)
			}
		})
	}
}
