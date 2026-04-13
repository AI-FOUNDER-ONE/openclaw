import { describe, expect, it, vi } from "vitest";
import type { ReadinessChecker } from "../gateway/server/readiness.js";
import { HealthHandler } from "./health.js";

describe("HealthHandler", () => {
  const handler = new HealthHandler();

  it("getHealth returns ok payload", () => {
    expect(handler.getHealth()).toEqual({ status: "ok" });
  });

  it("getReady without checker reports ready", () => {
    expect(handler.getReady({ includeDetails: true })).toEqual({
      statusCode: 200,
      body: { status: "ready" },
    });
  });

  it("getReady maps failing channels to checks when details are allowed", () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord", "telegram"],
      uptimeMs: 1,
    });
    expect(handler.getReady({ getReadiness, includeDetails: true })).toEqual({
      statusCode: 503,
      body: {
        status: "not_ready",
        checks: [
          { name: "managed_channel", id: "discord", ok: false },
          { name: "managed_channel", id: "telegram", ok: false },
        ],
      },
    });
  });

  it("getReady omits checks for unauthenticated-style callers", () => {
    const getReadiness: ReadinessChecker = () => ({
      ready: false,
      failing: ["discord"],
      uptimeMs: 1,
    });
    expect(handler.getReady({ getReadiness, includeDetails: false })).toEqual({
      statusCode: 503,
      body: { status: "not_ready" },
    });
  });

  it("getReady treats thrown readiness as internal failure", () => {
    const getReadiness: ReadinessChecker = () => {
      throw new Error("boom");
    };
    expect(handler.getReady({ getReadiness, includeDetails: true })).toEqual({
      statusCode: 503,
      body: {
        status: "not_ready",
        checks: [{ name: "readiness", ok: false, reason: "internal" }],
      },
    });
    expect(handler.getReady({ getReadiness, includeDetails: false })).toEqual({
      statusCode: 503,
      body: { status: "not_ready" },
    });
  });

  it("getReady does not invoke checker when absent", () => {
    const getReadiness = vi.fn<ReadinessChecker>(() => ({
      ready: true,
      failing: [],
      uptimeMs: 0,
    }));
    handler.getReady({ includeDetails: false });
    expect(getReadiness).not.toHaveBeenCalled();
  });
});
