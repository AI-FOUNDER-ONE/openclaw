import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../config/config.js";
import { isLocalDirectRequest } from "./auth.js";
import {
  readJsonBodyOrError,
  sendJson,
  sendMethodNotAllowed,
  sendUnauthorized,
} from "./http-common.js";

const TASK_EXECUTE_PATH = "/api/task/execute";
const CI_FIX_PATH = "/api/ci-fix";
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function authorizeAutodevHttpRequest(
  req: IncomingMessage,
  trustedProxies: string[] | undefined,
  allowRealIpFallback: boolean,
): boolean {
  const cfg = loadConfig();
  const secret = cfg.autodev?.httpSecret?.trim();
  if (secret) {
    const auth = req.headers.authorization?.trim() ?? "";
    return auth === `Bearer ${secret}`;
  }
  return isLocalDirectRequest(req, trustedProxies, allowRealIpFallback);
}

function defaultBridgeUrl(cfg: ReturnType<typeof loadConfig>): string {
  const u = cfg.autodev?.bridgeUrl?.trim();
  return (u && u.length > 0 ? u : "http://localhost:8080").replace(/\/$/, "");
}

/**
 * Autodev HTTP routes (`/api/task/execute`, `/api/ci-fix`).
 * Auth: `autodev.httpSecret` as Bearer token, or direct loopback when secret is unset.
 *
 * Task execution loads `runTaskPipeline` via dynamic `import()` so tsdown does not
 * statically bundle the full autodev graph into the gateway entry chunk.
 */
export async function handleAutodevHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestPath: string,
  opts: {
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
  },
): Promise<boolean> {
  if (requestPath !== TASK_EXECUTE_PATH && requestPath !== CI_FIX_PATH) {
    return false;
  }

  const cfg = loadConfig();
  if (cfg.autodev?.enabled === false) {
    sendJson(res, 503, {
      ok: false,
      error: { message: "autodev is disabled", type: "service_unavailable" },
    });
    return true;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  const trustedProxies = opts.trustedProxies ?? cfg.gateway?.trustedProxies;
  const allowRealIpFallback = opts.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback === true;
  if (!authorizeAutodevHttpRequest(req, trustedProxies, allowRealIpFallback)) {
    sendUnauthorized(res);
    return true;
  }

  if (requestPath === TASK_EXECUTE_PATH) {
    const rawBody = await readJsonBodyOrError(req, res, MAX_BODY_BYTES);
    if (rawBody === undefined) {
      return true;
    }
    const body = rawBody as Record<string, unknown>;
    const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
    if (!taskId) {
      sendJson(res, 400, { error: "taskId is required" });
      return true;
    }

    const planVersionRaw = body.planVersion;
    const planVersion =
      typeof planVersionRaw === "number" && Number.isFinite(planVersionRaw)
        ? Math.trunc(planVersionRaw)
        : typeof planVersionRaw === "string"
          ? Number.parseInt(planVersionRaw, 10)
          : 1;
    const notionPageId = typeof body.notionPageId === "string" ? body.notionPageId.trim() : "";

    sendJson(res, 202, { accepted: true, taskId });
    console.log(`[gateway/autodev] /api/task/execute accepted taskId=${taskId}`);

    const bridgeUrl = defaultBridgeUrl(cfg);

    void (async () => {
      try {
        let planContent = "";
        let taskTitle = taskId;
        if (notionPageId) {
          try {
            const resp = await fetch(`${bridgeUrl}/api/task/plan`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ taskId, notionPageId }),
            });
            if (resp.ok) {
              const data = (await resp.json()) as {
                planContent?: string;
                title?: string;
              };
              if (typeof data.planContent === "string") {
                planContent = data.planContent;
              }
              if (typeof data.title === "string" && data.title.trim()) {
                taskTitle = data.title.trim();
              }
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[autodev/http] Bridge plan fetch failed: ${msg}`);
          }
        }

        const { runTaskPipeline } = await import("../autodev/task-pipeline.js");
        await runTaskPipeline({
          taskId,
          planVersion: Number.isFinite(planVersion) && planVersion > 0 ? planVersion : 1,
          notionPageId,
          planContent,
          taskTitle: taskTitle !== taskId ? taskTitle : undefined,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[autodev/http] Pipeline failed for ${taskId}: ${message}`);
        try {
          await fetch(`${bridgeUrl}/api/status-update`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              taskId,
              status: "Blocked",
              errorReason: `Pipeline launch error: ${message}`,
            }),
          });
        } catch {
          /* ignore */
        }
      }
    })();

    return true;
  }

  sendJson(res, 503, {
    ok: false,
    error: {
      message:
        "Autodev CI fix HTTP is not available in this gateway build (use dynamic import wiring if needed).",
      type: "service_unavailable",
    },
  });
  return true;
}
