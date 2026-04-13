import type { ReadinessChecker, ReadinessResult } from "../gateway/server/readiness.js";

export type HealthLivenessBody = {
  status: "ok";
};

export type HealthReadinessOkBody = {
  status: "ready";
};

export type HealthCheckEntry = {
  /** Logical dependency group (for example managed messaging channels). */
  name: string;
  /** Non-sensitive identifier (for example channel id). */
  id?: string;
  ok: boolean;
  /** Safe, operator-facing reason code — never connection strings or secrets. */
  reason?: string;
};

export type HealthReadinessNotReadyBody = {
  status: "not_ready";
  checks?: HealthCheckEntry[];
};

export class HealthHandler {
  getHealth(): HealthLivenessBody {
    return { status: "ok" };
  }

  /**
   * Evaluates readiness using the optional checker (managed channels, etc.).
   * When no checker is configured, the gateway reports ready — there is nothing to verify.
   */
  getReady(params: {
    getReadiness?: ReadinessChecker;
    includeDetails: boolean;
  }): { statusCode: number; body: HealthReadinessOkBody | HealthReadinessNotReadyBody } {
    if (!params.getReadiness) {
      return { statusCode: 200, body: { status: "ready" } };
    }

    let result: ReadinessResult;
    try {
      result = params.getReadiness();
    } catch {
      if (params.includeDetails) {
        return {
          statusCode: 503,
          body: {
            status: "not_ready",
            checks: [{ name: "readiness", ok: false, reason: "internal" }],
          },
        };
      }
      return { statusCode: 503, body: { status: "not_ready" } };
    }

    if (result.ready) {
      return { statusCode: 200, body: { status: "ready" } };
    }

    if (params.includeDetails) {
      const checks: HealthCheckEntry[] = result.failing.map((id) => ({
        name: "managed_channel",
        id,
        ok: false,
      }));
      return { statusCode: 503, body: { status: "not_ready", checks } };
    }

    return { statusCode: 503, body: { status: "not_ready" } };
  }
}
