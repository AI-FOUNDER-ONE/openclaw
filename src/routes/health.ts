/**
 * Gateway HTTP probe routes (Node raw HTTP server — wired in `src/gateway/server-http.ts`).
 * These paths bypass gateway auth; responses are JSON with `Content-Type: application/json`.
 */

export const GATEWAY_LIVENESS_PATHS = ["/health", "/healthz"] as const;
export const GATEWAY_READINESS_PATHS = ["/ready", "/readyz"] as const;

const LIVENESS_SET = new Set<string>(GATEWAY_LIVENESS_PATHS);
const READINESS_SET = new Set<string>(GATEWAY_READINESS_PATHS);

export type GatewayProbeKind = "live" | "ready";

/**
 * Returns probe mode for a pathname, or null when the path is not a built-in probe route.
 */
export function resolveGatewayProbeMode(pathname: string): GatewayProbeKind | null {
  if (LIVENESS_SET.has(pathname)) {
    return "live";
  }
  if (READINESS_SET.has(pathname)) {
    return "ready";
  }
  return null;
}

export function isGatewayLivenessPath(pathname: string): boolean {
  return LIVENESS_SET.has(pathname);
}
