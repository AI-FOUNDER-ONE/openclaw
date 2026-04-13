import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
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

const DEFAULT_SESSION_TIMEOUT_MS = 90_000;
const AGENT_COMMAND = "agent";

export type ACPClientOptions = {
  workDir: string;
  /** Override the agent binary path. */
  agentPath?: string;
  /**
   * Total wall-clock budget (ms) for connect → authenticate → createSession → sendPrompt.
   * Each step uses the remaining budget; on expiry the `agent acp` child is killed.
   */
  sessionTimeoutMs?: number;
  /** @deprecated Use sessionTimeoutMs (same value is accepted as alias). */
  timeoutMs?: number;
};

type CollectedOutput = {
  text: string;
  updates: SessionNotification[];
};

export class ACPClient {
  private workDir: string;
  private agentPath: string | undefined;
  private sessionTimeoutMs: number;
  /** Absolute time (ms) when the ACP session must finish; set at start of connect(). */
  private sessionEndsAt = 0;

  private child: ChildProcess | null = null;
  private conn: ClientSideConnection | null = null;
  private collected: CollectedOutput = { text: "", updates: [] };
  private sigkillFollowUp: NodeJS.Timeout | null = null;

  constructor(opts: ACPClientOptions) {
    this.workDir = opts.workDir;
    this.agentPath = opts.agentPath;
    this.sessionTimeoutMs = opts.sessionTimeoutMs ?? opts.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  }

  private remainingMs(): number {
    return Math.max(1, this.sessionEndsAt - Date.now());
  }

  /**
   * Kill the `agent acp` child (SIGTERM, then SIGKILL after 5s). Safe to call multiple times.
   */
  killAcpSubprocess(reason: string): void {
    const child = this.child;
    if (!child || child.killed) {
      return;
    }
    logDebug(`ACP: killing agent subprocess (${reason})`);
    if (this.sigkillFollowUp) {
      clearTimeout(this.sigkillFollowUp);
      this.sigkillFollowUp = null;
    }
    child.kill("SIGTERM");
    this.sigkillFollowUp = setTimeout(() => {
      this.sigkillFollowUp = null;
      if (this.child && !this.child.killed) {
        this.child.kill("SIGKILL");
      }
    }, 5_000);
  }

  private clearSigkillFollowUp(): void {
    if (this.sigkillFollowUp) {
      clearTimeout(this.sigkillFollowUp);
      this.sigkillFollowUp = null;
    }
  }

  /** Race `promise` against remaining session budget; on timeout kill child and reject. */
  private withSessionTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    const ms = this.remainingMs();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const sec = Math.round(this.sessionTimeoutMs / 1000);
        console.warn(
          `[autodev/coder] ACP timeout after ${sec}s (${this.sessionTimeoutMs}ms session budget), killing subprocess (${label})`,
        );
        this.killAcpSubprocess(`timeout:${label}`);
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

  async connect(): Promise<void> {
    this.sessionEndsAt = Date.now() + this.sessionTimeoutMs;

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
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            collected.text += update.content.text;
          }
        },
      };
      return client;
    }, stream);

    const initResponse = await this.withSessionTimeout(
      this.conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "openclaw-autodev", version: "1.0.0" },
        clientCapabilities: {},
      }),
      "ACP initialize",
    );

    logDebug(`ACP initialized: protocol ${initResponse.protocolVersion}`);
  }

  async authenticate(): Promise<void> {
    if (!this.conn) {
      throw new Error("Not connected — call connect() first");
    }
    await this.withSessionTimeout(
      this.conn.authenticate({ methodId: "cursor_login" }),
      "ACP authenticate",
    );
  }

  async createSession(): Promise<string> {
    if (!this.conn) {
      throw new Error("Not connected — call connect() first");
    }
    const response = await this.withSessionTimeout(
      this.conn.newSession({ cwd: this.workDir, mcpServers: [] }),
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

    const response = await this.withSessionTimeout(
      this.conn.prompt({
        sessionId,
        messageId: crypto.randomUUID(),
        prompt: [{ type: "text", text: prompt }],
      }),
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
    this.clearSigkillFollowUp();
    if (this.child) {
      this.child.stdin?.end();
      if (!this.child.killed) {
        this.child.kill("SIGTERM");
      }

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
