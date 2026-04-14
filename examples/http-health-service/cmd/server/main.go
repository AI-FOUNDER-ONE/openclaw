package main

import (
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/openclaw/openclaw/examples/http-health-service/internal/handler"
	"github.com/openclaw/openclaw/examples/http-health-service/internal/router"
)

func main() {
	logLevel := slog.LevelInfo
	if os.Getenv("LOG_LEVEL") == "debug" {
		logLevel = slog.LevelDebug
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel}))

	// Demo: no DB/cache wired; health returns200. Production should pass real *sql.DB / Redis.
	h := handler.NewHealthHandler(nil, nil, log)

	addr := ":8080"
	if p := os.Getenv("PORT"); p != "" {
		addr = ":" + p
	}

	srv := &http.Server{
		Addr: addr,
		Handler:           router.New(router.Options{HealthHandler: h, Logger: log}),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Info("listening", "addr", addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Error("server error", "err", err)
		os.Exit(1)
	}
}
