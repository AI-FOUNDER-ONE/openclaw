import { loadConfig } from "../config/config.js";

const BRIDGE_TIMEOUT_MS = 30_000;

const DEFAULT_BRIDGE = "http://127.0.0.1:8080";

export function resolveAutodevBridgeBaseUrl(): string {
  const cfg = loadConfig();
  const url = cfg.autodev?.bridgeUrl?.trim();
  if (!url) {
    return DEFAULT_BRIDGE;
  }
  return url.replace(/\/$/, "");
}

/**
 * POST status and metadata to autodev-system (bridge).
 */
export async function postAutodevBridgeStatus(body: Record<string, unknown>): Promise<void> {
  const base = resolveAutodevBridgeBaseUrl();
  const url = `${base}/api/status-update`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Bridge status-update failed (${res.status}): ${text.slice(0, 500)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load full plan text from autodev-system (Notion-backed).
 */
export async function fetchAutodevPlanContent(params: {
  taskId: string;
  notionPageId: string;
}): Promise<string> {
  const base = resolveAutodevBridgeBaseUrl();
  const url = `${base}/api/task/plan`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: params.taskId,
        notionPageId: params.notionPageId,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Bridge plan fetch failed (${res.status}): ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as { planContent?: string };
    if (typeof data.planContent !== "string" || !data.planContent.trim()) {
      throw new Error("Bridge plan response missing planContent");
    }
    return data.planContent;
  } finally {
    clearTimeout(timer);
  }
}
