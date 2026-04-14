package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type okDB struct{}

func (okDB) PingContext(context.Context) error { return nil }

type failDB struct{}

func (failDB) PingContext(context.Context) error { return errors.New("dial tcp 10.0.0.1:5432: connection refused") }

type okCache struct{}

func (okCache) Ping(context.Context) error { return nil }

func TestHealthHandler_Check_allHealthy(t *testing.T) {
	h := NewHealthHandler(okDB{}, okCache{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	h.ProbeTimeout = time.Second

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	h.Check(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "ok" {
		t.Fatalf("status field = %v, want ok", body["status"])
	}
	if len(body) != 1 {
		t.Fatalf("unexpected fields: %v", body)
	}
}

func TestHealthHandler_Check_databaseDown(t *testing.T) {
	h := NewHealthHandler(failDB{}, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	h.ProbeTimeout = time.Second

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	h.Check(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "unavailable" {
		t.Fatalf("status = %v", body["status"])
	}
	reason, _ := body["reason"].(string)
	if reason != "database connection failed" {
		t.Fatalf("reason = %q", reason)
	}
	raw := rec.Body.String()
	if strings.Contains(raw, "10.0.0.1") || strings.Contains(raw, "5432") || strings.Contains(raw, "password") {
		t.Fatalf("response leaks sensitive detail: %s", raw)
	}
}

type failCache struct{}

func (failCache) Ping(context.Context) error {
	return errors.New("redis: connection reset by peer at 192.168.1.1:6379")
}

func TestHealthHandler_Check_cacheDown(t *testing.T) {
	h := NewHealthHandler(okDB{}, failCache{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	h.ProbeTimeout = time.Second

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	h.Check(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", rec.Code)
	}
	ct := rec.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("Content-Type = %q", ct)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body) != 2 {
		t.Fatalf("want exactly status+reason, got %v", body)
	}
	if body["status"] != "unavailable" || body["reason"] != "cache unavailable" {
		t.Fatalf("body = %v", body)
	}
	raw := rec.Body.String()
	if strings.Contains(raw, "192.168") || strings.Contains(raw, "6379") {
		t.Fatalf("response leaks host/port: %s", raw)
	}
}

func TestHealthHandler_Check_methodNotAllowed(t *testing.T) {
	h := NewHealthHandler(nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	req := httptest.NewRequest(http.MethodPost, "/healthz", nil)
	rec := httptest.NewRecorder()
	h.Check(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d", rec.Code)
	}
}

// Probes should stay fast for orchestrators; local mocked deps should finish well under 100ms.
func TestHealthHandler_Check_latencyBudget(t *testing.T) {
	h := NewHealthHandler(okDB{}, okCache{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	start := time.Now()
	h.Check(rec, req)
	elapsed := time.Since(start)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if elapsed > 100*time.Millisecond {
		t.Fatalf("health check took %s, want < 100ms for probe suitability", elapsed)
	}
}

func TestHealthHandler_Check_JSONShapeNoExtraSensitiveKeys(t *testing.T) {
	h := NewHealthHandler(failDB{}, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	h.ProbeTimeout = time.Second
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	h.Check(rec, req)
	raw := rec.Body.String()
	var body map[string]any
	if err := json.Unmarshal([]byte(raw), &body); err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"password", "secret", "dsn", "host", "addr", "ip", "token"} {
		if _, ok := body[forbidden]; ok {
			t.Fatalf("unexpected key %q in body", forbidden)
		}
	}
	if strings.Contains(strings.ToLower(raw), "10.0.0.1") {
		t.Fatal("response must not echo internal addresses")
	}
}
