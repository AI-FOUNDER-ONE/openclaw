package router

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/openclaw/openclaw/examples/http-health-service/internal/handler"
)

// Options configures global HTTP behavior.
type Options struct {
	HealthHandler *handler.HealthHandler
	// Logger is used for request logging; verbosity follows slog level (e.g. WARN to reduce noise).
	Logger *slog.Logger
}

// New builds the application router: /healthz is public (no auth, no rate limit); other routes use middleware.
func New(opts Options) http.Handler {
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}

	r := chi.NewRouter()

	// Short timeouts for probes; separate from API routes if needed later.
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)

	// Liveness: no auth, no rate limit, no API timeout wrapper (handler uses its own probe deadline).
	// Optional debug access log only (set LOG_LEVEL=debug in main); avoids noisy probe lines at info.
	if opts.HealthHandler != nil {
		r.With(healthAccessLog(log)).Get("/healthz", opts.HealthHandler.Check)
	}

	r.Group(func(r chi.Router) {
		r.Use(middleware.Timeout(60 * time.Second))
		r.Use(requestLogger(log))
		r.Use(exampleAuth)
		r.Use(exampleRateLimit)

		r.Get("/api/example", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("ok"))
		})
	})

	return r
}

func healthAccessLog(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			start := time.Now()
			next.ServeHTTP(ww, r)
			log.Debug("healthz",
				"method", r.Method,
				"path", r.URL.Path,
				"status", ww.Status(),
				"duration", time.Since(start),
			)
		})
	}
}

func requestLogger(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			start := time.Now()
			defer func() {
				log.Debug("request",
					"method", r.Method,
					"path", r.URL.Path,
					"status", ww.Status(),
					"bytes", ww.BytesWritten(),
					"duration", time.Since(start),
				)
			}()
			next.ServeHTTP(ww, r)
		})
	}
}

func exampleAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Api-Key") == "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// exampleRateLimit is a placeholder; /healthz never hits this middleware.
func exampleRateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Intentionally permissive: real deployments should use httprate or similar on this group only.
		next.ServeHTTP(w, r)
	})
}
