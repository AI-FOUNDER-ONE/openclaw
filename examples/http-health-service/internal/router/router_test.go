package router

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/openclaw/openclaw/examples/http-health-service/internal/handler"
)

func TestRouter_healthzNoAuthRequired(t *testing.T) {
	h := handler.NewHealthHandler(nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	srv := httptest.NewServer(New(Options{HealthHandler: h, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}))
	t.Cleanup(srv.Close)

	res, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	var body map[string]any
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "ok" {
		t.Fatalf("body = %v", body)
	}
}

func TestRouter_healthzNotRateLimitedByExampleMiddleware(t *testing.T) {
	h := handler.NewHealthHandler(nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	srv := httptest.NewServer(New(Options{HealthHandler: h}))
	t.Cleanup(srv.Close)

	for range 20 {
		res, err := http.Get(srv.URL + "/healthz")
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("status = %d", res.StatusCode)
		}
	}
}
