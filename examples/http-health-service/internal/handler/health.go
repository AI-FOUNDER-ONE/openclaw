package handler

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"
)

// DefaultProbeTimeout bounds dependency checks so probes stay suitable for k8s/load balancers.
const DefaultProbeTimeout = 50 * time.Millisecond

// DBPinger is satisfied by *sql.DB and test doubles.
type DBPinger interface {
	PingContext(ctx context.Context) error
}

// CachePinger is satisfied by Redis clients and test doubles.
type CachePinger interface {
	Ping(ctx context.Context) error
}

// HealthHandler runs shallow dependency checks and returns JSON without sensitive details.
type HealthHandler struct {
	DB            DBPinger
	Cache         CachePinger
	ProbeTimeout  time.Duration
	Log           *slog.Logger
	safeReasonMap map[string]string
}

// NewHealthHandler returns a handler with safe, user-facing reason strings only.
func NewHealthHandler(db DBPinger, cache CachePinger, log *slog.Logger) *HealthHandler {
	if log == nil {
		log = slog.Default()
	}
	return &HealthHandler{
		DB:           db,
		Cache:        cache,
		ProbeTimeout: DefaultProbeTimeout,
		Log:          log,
		safeReasonMap: map[string]string{
			"database": "database connection failed",
			"cache":    "cache unavailable",
		},
	}
}

type healthOKResponse struct {
	Status string `json:"status"`
}

type healthFailResponse struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
}

// Check implements GET /healthz: 200 + {"status":"ok"} or 503 + safe reason.
func (h *HealthHandler) Check(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
		return
	}

	timeout := h.ProbeTimeout
	if timeout <= 0 {
		timeout = DefaultProbeTimeout
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()

	if h.DB != nil {
		if err := h.DB.PingContext(ctx); err != nil {
			h.writeUnavailable(w, r, "database", err)
			return
		}
	}
	if h.Cache != nil {
		if err := h.Cache.Ping(ctx); err != nil {
			h.writeUnavailable(w, r, "cache", err)
			return
		}
	}

	h.Log.Debug("health check ok")

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(healthOKResponse{Status: "ok"})
}

func (h *HealthHandler) writeUnavailable(w http.ResponseWriter, r *http.Request, key string, err error) {
	h.Log.Warn("health check failed", "component", key, "err", err)

	reason, ok := h.safeReasonMap[key]
	if !ok {
		reason = "dependency unavailable"
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(healthFailResponse{
		Status: "unavailable",
		Reason: reason,
	})
}
