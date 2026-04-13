import { spawn } from "node:child_process";
import { ACPClient } from "./acp-client.js";

const DEFAULT_ACP_PROMPT_MS = 60_000;

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
    timeoutMs: opts?.timeoutMs ?? DEFAULT_ACP_PROMPT_MS,
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
): Promise<RunCursorOutcome> {
  const bin = resolveAgentBinary();
  return new Promise((resolve) => {
    const child = spawn(bin, ["-p", "-"], {
      cwd: workDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      resolve({ ok: false, output: err.message });
    });
    child.on("close", (code) => {
      const out = stdout.trim() || stderr.trim() || `(exit ${code ?? "unknown"})`;
      resolve({ ok: code === 0, output: out });
    });
    child.stdin?.write(instruction);
    child.stdin?.end();
  });
}
