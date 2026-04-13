import { spawn } from "node:child_process";
import { ACPClient } from "./acp-client.js";

/** Wall-clock budget for one ACP session (connect → prompt); child is killed when exceeded. */
export const ACP_SESSION_TIMEOUT_MS = 90_000;

/** Wall-clock budget for `agent -p -` CLI fallback. */
export const CLI_TIMEOUT_MS = 180_000;

export type RunCursorOutcome = {
  ok: boolean;
  output: string;
};

/**
 * Run Cursor via ACP (`agent acp`).
 */
export async function runWithACP(
  workDir: string,
  instruction: string,
  opts?: { timeoutMs?: number },
): Promise<RunCursorOutcome> {
  const client = new ACPClient({
    workDir,
    sessionTimeoutMs: opts?.timeoutMs ?? ACP_SESSION_TIMEOUT_MS,
  });
  try {
    await client.connect();
    await client.authenticate();
    const sessionId = await client.createSession();
    const out = await client.sendPrompt(sessionId, instruction);
    await client.close();
    return { ok: true, output: out };
  } catch (e) {
    await client.close().catch(() => undefined);
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, output: msg };
  }
}

function resolveAgentBinary(): string {
  const fromEnv = process.env.OPENCLAW_CURSOR_AGENT_BIN?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return "agent";
}

/**
 * CLI fallback: `agent -p -` with instruction on stdin.
 */
export async function runCursorCLI(
  workDir: string,
  instruction: string,
  opts?: { timeoutMs?: number },
): Promise<RunCursorOutcome> {
  const bin = resolveAgentBinary();
  const timeoutMs = opts?.timeoutMs ?? CLI_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let sigkillTimer: NodeJS.Timeout | null = null;

    const finish = (outcome: RunCursorOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(wallTimer);
      if (sigkillTimer) {
        clearTimeout(sigkillTimer);
        sigkillTimer = null;
      }
      resolve(outcome);
    };

    const child = spawn(bin, ["-p", "-"], {
      cwd: workDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    });

    const wallTimer = setTimeout(() => {
      console.warn(`[autodev/coder] CLI timeout after ${timeoutMs}ms, killing subprocess`);
      child.kill("SIGTERM");
      sigkillTimer = setTimeout(() => {
        sigkillTimer = null;
        if (!child.killed) {
          child.kill("SIGKILL");
        }
        finish({ ok: false, output: `CLI timed out after ${timeoutMs}ms` });
      }, 5_000);
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      finish({ ok: false, output: err.message });
    });
    child.on("close", (code) => {
      const out = stdout.trim() || stderr.trim() || `(exit ${code ?? "unknown"})`;
      finish({ ok: code === 0, output: out });
    });
    child.stdin?.write(instruction);
    child.stdin?.end();
  });
}
