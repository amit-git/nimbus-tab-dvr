// Copyright (C) 2026 Niels Joubert
// SPDX-License-Identifier: MIT

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
)

// The page shares this origin and needs no CORS; the extension's origin is
// chrome-extension://<id>, which does, and any origin is answered because the demo backend
// authorises nothing.
func cors(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Content-Type, X-Recording-Key, X-Chunk-Kind, X-Chunk-Duration-Ms, X-Chunk-Start-Ms, X-Chunk-End-Ms")
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	cors(w)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("writing response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func recordingID(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.PathValue("id")
	if !validID.MatchString(id) {
		writeError(w, http.StatusBadRequest, errors.New("bad recording id"))
		return "", false
	}
	return id, true
}

var validSegment = regexp.MustCompile(`^[0-9]{6,}\.m4s$`)

func registerAPI(mux *http.ServeMux, store *Store) {
	mux.HandleFunc("OPTIONS /api/", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		w.WriteHeader(http.StatusNoContent)
	})

	mux.HandleFunc("GET /api/recordings", func(w http.ResponseWriter, r *http.Request) {
		recs, err := store.List()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, recs)
	})

	mux.HandleFunc("POST /api/recordings/{id}/chunks/{sequence}", func(w http.ResponseWriter, r *http.Request) {
		id, ok := recordingID(w, r)
		if !ok {
			return
		}
		sequence, err := strconv.Atoi(r.PathValue("sequence"))
		if err != nil || sequence < 1 {
			writeError(w, http.StatusBadRequest, errors.New("bad sequence"))
			return
		}
		part := Chunk{Sequence: sequence, Kind: r.Header.Get("X-Chunk-Kind")}
		values := []*float64{&part.DurationMs, &part.StartMs, &part.EndMs}
		for i, name := range []string{"X-Chunk-Duration-Ms", "X-Chunk-Start-Ms", "X-Chunk-End-Ms"} {
			value, err := strconv.ParseFloat(r.Header.Get(name), 64)
			if err != nil {
				writeError(w, http.StatusBadRequest, fmt.Errorf("invalid %s", name))
				return
			}
			*values[i] = value
		}
		payload, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<20))
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		part.Bytes = int64(len(payload))
		rec, err := store.PutChunk(id, sequence, r.Header.Get("X-Recording-Key"), r.Header.Get("Content-Type"), payload, part)
		if err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, errInvalid) {
				status = http.StatusConflict
			}
			writeError(w, status, err)
			return
		}
		writeJSON(w, http.StatusOK, rec)
	})

	mux.HandleFunc("POST /api/recordings/{id}/stop", func(w http.ResponseWriter, r *http.Request) {
		id, ok := recordingID(w, r)
		if !ok {
			return
		}
		var body struct {
			Reason string `json:"reason"`
			Chunks int    `json:"chunks"`
			Bytes  int64  `json:"bytes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		rec, err := store.Finalize(id, body.Reason, body.Chunks, body.Bytes)
		switch {
		case errors.Is(err, errNotFound):
			writeError(w, http.StatusNotFound, err)
		case errors.Is(err, errInvalid):
			writeError(w, http.StatusConflict, err)
		case err != nil:
			log.Printf("finalize %s: %v", id, err)
			writeJSON(w, http.StatusInternalServerError, rec)
		default:
			log.Printf("finalized %s: %d chunks, %d bytes, %v s", id, rec.Chunks, rec.Bytes, deref(rec.DurationSeconds))
			writeJSON(w, http.StatusOK, rec)
		}
	})

	mux.HandleFunc("GET /api/recordings/{id}/{asset}", func(w http.ResponseWriter, r *http.Request) {
		id, ok := recordingID(w, r)
		if !ok {
			return
		}
		asset := r.PathValue("asset")
		cors(w)
		w.Header().Set("Cache-Control", "no-store")
		if asset != "index.m3u8" && asset != "init.mp4" && !validSegment.MatchString(asset) {
			http.NotFound(w, r)
			return
		}
		path := filepath.Join(store.dir(id), asset)
		if _, err := os.Stat(path); err != nil {
			http.NotFound(w, r)
			return
		}
		if asset == "index.m3u8" {
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		} else {
			w.Header().Set("Content-Type", "video/mp4")
		}
		http.ServeFile(w, r, path)
	})

	mux.HandleFunc("DELETE /api/recordings/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, ok := recordingID(w, r)
		if !ok {
			return
		}
		if err := store.Delete(id); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"deleted": id})
	})
}

func deref(f *float64) any {
	if f == nil {
		return nil
	}
	return *f
}
