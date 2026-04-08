import crypto from "crypto";
import fs from "fs";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { WordEditParams, WordEditResult } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RELAY_PORT = 18800;

let bridgeWs: WebSocket | null = null;
let bridgeConnected = false;

// 等待 Word Bridge 响应的请求队列
const pendingRequests = new Map<
  string,
  {
    resolve: (result: WordEditResult) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }
>();

// ========== 中继服务 ==========

let wss: WebSocketServer | null = null;

function shouldStartRelayInThisProcess(): boolean {
  const argv = process.argv.slice(2).join(" ").toLowerCase();
  // Relay is only required in the long-running gateway process.
  // Skip one-shot CLI commands (e.g. plugins list / health) to avoid port races.
  return argv.includes("gateway");
}

export function startRelayServer(): void {
  if (!shouldStartRelayInThisProcess()) {
    return;
  }

  // 防重入：如果已经启动过，直接返回
  if (wss) {
    return;
  }

  const certCandidates = [
    path.join(process.cwd(), "extensions", "word-bridge"),
    path.join(__dirname, "..", "word-bridge"),
    path.join(__dirname, "..", "..", "word-bridge"),
  ];
  const certDir =
    certCandidates.find((dir) => fs.existsSync(path.join(dir, "127.0.0.1+1.pem"))) ||
    certCandidates[0];
  const certPath = path.join(certDir, "127.0.0.1+1.pem");
  const keyPath = path.join(certDir, "127.0.0.1+1-key.pem");
  let httpsServer: https.Server;
  try {
    httpsServer = https.createServer({
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[Word Edit Relay] 读取证书失败（路径应含 extensions/word-bridge/*.pem）:", msg);
    throw e;
  }

  httpsServer.on("error", function (err: NodeJS.ErrnoException) {
    if (err?.code === "EADDRINUSE") {
      // Another OpenClaw process may already own the relay port.
      // Do not crash secondary CLI processes like `plugins list`.
      console.warn(
        `[Word Edit Relay] 端口 ${RELAY_PORT} 已被占用，当前进程跳过中继启动（通常是另一个网关实例已在运行）`,
      );
      wss = null;
      return;
    }
    console.error("[Word Edit Relay] HTTPS 监听错误:", err.message);
  });

  try {
    httpsServer.listen(RELAY_PORT);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "EADDRINUSE") {
      console.warn(
        `[Word Edit Relay] 端口 ${RELAY_PORT} 已被占用，当前进程跳过中继启动（通常是另一个网关实例已在运行）`,
      );
      return;
    }
    throw err;
  }

  wss = new WebSocketServer({ server: httpsServer });

  wss.on("connection", (ws, req) => {
    const url = req.url || "";

    if (url.includes("/bridge")) {
      // Word Bridge Add-in 连接
      bridgeWs = ws;
      bridgeConnected = true;
      console.log("📝 Word Bridge 已连接");

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "word_edit_result" && msg.requestId) {
            const pending = pendingRequests.get(msg.requestId);
            if (pending) {
              clearTimeout(pending.timeout);
              pendingRequests.delete(msg.requestId);
              pending.resolve(msg.result);
            }
          }
        } catch (e) {
          console.error("[Relay] 消息解析失败:", e);
        }
      });

      ws.on("close", () => {
        bridgeConnected = false;
        bridgeWs = null;
        console.log("📝 Word Bridge 已断开");
        // 拒绝所有等待中的请求
        for (const [id, pending] of pendingRequests) {
          clearTimeout(pending.timeout);
          pending.reject(new Error("Word Bridge 连接断开"));
        }
        pendingRequests.clear();
      });
    }
  });

  console.log(`📡 Word Edit Relay: wss://127.0.0.1:${RELAY_PORT}`);
  console.log(`📝 Word Bridge 端点: wss://127.0.0.1:${RELAY_PORT}/bridge`);
}

// ========== 供 Tool 调用的接口 ==========

export function isBridgeConnected(): boolean {
  return bridgeConnected;
}

/** 供 get_status / 排障：不依赖 Word 是否已连上 */
export function getWordEditRelayStatus(): {
  relayListening: boolean;
  bridgeConnected: boolean;
  relayWssUrl: string;
} {
  return {
    relayListening: wss !== null,
    bridgeConnected,
    relayWssUrl: `wss://127.0.0.1:${RELAY_PORT}/bridge`,
  };
}

export async function sendToWordBridge(params: WordEditParams): Promise<WordEditResult> {
  if (!bridgeWs || !bridgeConnected) {
    const relay = getWordEditRelayStatus();
    const extra = !relay.relayListening
      ? "（中继未监听：word-edit 插件可能未加载或启动失败，请查网关日志是否含「Word Edit Relay」；证书缺失时插件会崩溃）"
      : "（中继已监听，等待 Word 任务窗格连上 " + relay.relayWssUrl + "）";
    return {
      success: false,
      action: params.action,
      error:
        "Word Bridge 未连接。请确认：1) 本机 OpenClaw 网关已启动且 openclaw.json 中 word-edit 插件已启用 2) Word 已打开 3) 已打开并停留在 Word Bridge 任务窗格（侧栏红点变绿）4) 若刚重启过网关，需切换回任务窗格触发自动重连" +
        extra,
    };
  }

  const requestId = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve({
        success: false,
        action: params.action,
        error: "Word Bridge 响应超时（30秒），请检查 Word 是否卡住",
      });
    }, 30000);

    pendingRequests.set(requestId, { resolve, reject, timeout });

    bridgeWs!.send(
      JSON.stringify({
        type: "word_edit_command",
        requestId,
        data: params,
      }),
    );
  });
}
