import {
  ACP_SESSION_TIMEOUT_MS,
  CLI_TIMEOUT_MS,
  runCursorCLI,
  runWithACP,
} from "../../cursor/runner.js";
import { getChangedFiles } from "../../infra/git-branch.js";
import type { CoderInput, CoderOutput, RoleResult } from "./types.js";

const MAX_ACP_ATTEMPTS = 3;

function isAcpTimeoutMessage(output: string): boolean {
  return /timed out after \d+ms/i.test(output);
}

export async function execute(input: CoderInput): Promise<RoleResult<CoderOutput>> {
  const { tasks, workDir, repairInstruction, roundIndex } = input;
  if (tasks.length === 0) {
    return { success: false, error: "Coder received no tasks" };
  }

  const roundLabel = roundIndex ?? 1;
  const parts: string[] = [];
  if (repairInstruction?.trim()) {
    parts.push(`## Repair instructions (from validator)\n${repairInstruction.trim()}`);
  }
  for (const t of tasks) {
    parts.push(`## ${t.title}\n${t.cursorInstruction}`);
  }
  const instruction = parts.join("\n\n");

  console.log(`[autodev/coder] Round ${roundLabel}/3: starting`);

  let acpOk = false;
  let lastAcpOutput = "";
  for (let attempt = 1; attempt <= MAX_ACP_ATTEMPTS; attempt++) {
    console.log(
      `[autodev/coder] Round ${roundLabel}: ACP attempt ${attempt}/${MAX_ACP_ATTEMPTS}...`,
    );
    const acp = await runWithACP(workDir, instruction, {
      timeoutMs: ACP_SESSION_TIMEOUT_MS,
    });
    lastAcpOutput = acp.output;
    if (acp.ok) {
      acpOk = true;
      break;
    }
    if (isAcpTimeoutMessage(acp.output)) {
      console.warn(
        `[autodev/coder] ACP timeout after ${ACP_SESSION_TIMEOUT_MS}ms (attempt ${attempt}/${MAX_ACP_ATTEMPTS})`,
      );
    } else {
      console.warn(
        `[autodev/coder] ACP failed (attempt ${attempt}/${MAX_ACP_ATTEMPTS}): ${acp.output.slice(0, 300)}`,
      );
    }
  }

  let mode: CoderOutput["mode"] = "acp";

  console.log(
    `[autodev/coder] Round ${roundLabel}: ACP result: success=${acpOk}, mode=acp, output length=${lastAcpOutput.length}`,
  );

  if (!acpOk) {
    if (isAcpTimeoutMessage(lastAcpOutput)) {
      console.warn("[autodev/coder] ACP timed out, falling back to CLI");
    } else {
      console.warn(
        `[autodev/coder] ACP failed after ${MAX_ACP_ATTEMPTS} attempts, falling back to CLI`,
      );
    }
    console.log("[autodev/coder] Starting CLI fallback...");
    const cli = await runCursorCLI(workDir, instruction, { timeoutMs: CLI_TIMEOUT_MS });
    console.log(
      `[autodev/coder] Round ${roundLabel}: CLI result: success=${cli.ok}, output length=${cli.output.length}`,
    );
    if (!cli.ok) {
      const errMsg = `Coder failed after ACP and CLI: ACP: ${lastAcpOutput.slice(0, 400)} | CLI: ${cli.output.slice(0, 400)}`;
      console.error(`[autodev/coder] ${errMsg}`);
      return { success: false, error: errMsg };
    }
    mode = "cli";
  }

  let changedFiles: string[] = [];
  try {
    changedFiles = await getChangedFiles();
  } catch {
    changedFiles = [];
  }
  const preview = changedFiles.slice(0, 40).join(",");
  console.log(
    `[autodev/coder] Round ${roundLabel}: changedFiles=${changedFiles.length}, files=${preview}`,
  );

  return {
    success: true,
    data: {
      success: true,
      mode,
      cursorRounds: roundLabel,
      changedFiles,
    },
  };
}
