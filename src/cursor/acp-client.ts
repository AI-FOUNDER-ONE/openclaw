import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { logDebug, logError } from "../logger.js";

const REQUEST_TIMEOUT_MS = 120_000;
const AGENT_COMMAND = "agent";

export type ACPClientOptions = {
  workDir: string;
  /** Override the agent binary path. */
  agentPath?: string;
  /** Per-request timeout (ms). Default: 120 000. */
  timeoutMs?: number;
};

type CollectedOutput = {
  text: string;
  updates: SessionNotification[];
};

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export class ACPClient {
  private workDir: string;
  private agentPath: string | undefined;
  private timeoutMs: number;

  private child: ChildProcess | null = null;
  private conn: ClientSideConnection | null = null;
  private collected: CollectedOutput = { text: "", updates: [] };

  constructor(opts: ACPClientOptions) {
    this.workDir = opts.workDir;
    this.agentPath = opts.agentPath;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async connect(): Promise<void> {
    const command = this.agentPath ?? AGENT_COMMAND;
    const args = ["acp"];

    logDebug(`Spawning ACP agent: ${command} ${args.join(" ")} (cwd: ${this.workDir})`);

    this.child = spawn(command, args, {
      cwd: this.workDir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.child.on("error", (err) => {
      logError(`ACP agent process error: ${err.message}`);
    });

    // Redirect agent stderr to our debug log
    this.child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        logDebug(`[agent stderr] ${text}`);
      }
    });

    const childStdin = this.child.stdin;
    const childStdout = this.child.stdout;
    if (!childStdin || !childStdout) {
      throw new Error("Failed to open stdio pipes to agent process");
    }

    const output = Writable.toWeb(childStdin);
    const input = Readable.toWeb(childStdout) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(output, input);

    const collected = this.collected;
    this.conn = new ClientSideConnection((_agent) => {
      const client: Client = {
        async requestPermission(
          params: RequestPermissionRequest,
        ): Promise<RequestPermissionResponse> {
          // Auto-approve in headless mode: pick the first allow option
          const options = params.options ?? [];
          const allow =
            options.find((o) => o.kind === "allow_once") ??
            options.find((o) => o.kind === "allow_always") ??
            options[0];
          if (!allow) {
            return { outcome: { outcome: "cancelled" } };
          }
          return { outcome: { outcome: "selected", optionId: allow.optionId } };
        },
        async sessionUpdate(params: SessionNotification): Promise<void> {
          collected.updates.push(params);
          const update = params.update;
          if (
            update.sessionUpdate === "agent_message_chunk" &&
            update.content.type === "text"
          ) {
            collected.text += update.content.text;
          }
        },
      };
      return client;
    }, stream);

    const initResponse = await withTimeout(
      this.conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "openclaw-autodev", version: "1.0.0" },
        clientCapabilities: {},
      }),
      this.timeoutMs,
      "ACP initialize",
    );

    logDebug(`ACP initialized: protocol ${initResponse.protocolVersion}`);
  }

  async authenticate(): Promise<void> {
    if (!this.conn) {
      throw new Error("Not connected — call connect() first");
    }
    await withTimeout(
      this.conn.authenticate({ methodId: "cursor_login" }),
      this.timeoutMs,
      "ACP authenticate",
    );
  }

  async createSession(): Promise<string> {
    if (!this.conn) {
      throw new Error("Not connected — call connect() first");
    }
    const response = await withTimeout(
      this.conn.newSession({ cwd: this.workDir, mcpServers: [] }),
      this.timeoutMs,
      "ACP newSession",
    );
    logDebug(`ACP session created: ${response.sessionId}`);
    return response.sessionId;
  }

  async sendPrompt(sessionId: string, prompt: string): Promise<string> {
    if (!this.conn) {
      throw new Error("Not connected — call connect() first");
    }

    this.collected = { text: "", updates: [] };

    const response = await withTimeout(
      this.conn.prompt({
        sessionId,
        messageId: crypto.randomUUID(),
        prompt: [{ type: "text", text: prompt }],
      }),
      this.timeoutMs,
      "ACP prompt",
    );

    logDebug(`ACP prompt completed: stopReason=${response.stopReason}`);
    return this.collected.text || `[completed: ${response.stopReason}]`;
  }

  async createPlan(
    sessionId: string,
    description: string,
  ): Promise<{ plan: string; stopReason: string }> {
    const planPrompt =
      `Create a detailed implementation plan for the following task. ` +
      `List the files to modify, the changes to make, and the order of operations.\n\n${description}`;
    const result = await this.sendPrompt(sessionId, planPrompt);
    return {
      plan: result,
      stopReason: "completed",
    };
  }

  async close(): Promise<void> {
    if (this.child) {
      this.child.stdin?.end();
      this.child.kill("SIGTERM");

      // Wait briefly for graceful exit, then force kill
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.child?.kill("SIGKILL");
          resolve();
        }, 3_000);
        this.child?.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });

      this.child = null;
    }
    this.conn = null;
  }
}
