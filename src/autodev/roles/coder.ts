import { runCursorCLI, runWithACP } from "../../cursor/runner.js";
import { getChangedFiles } from "../../infra/git-branch.js";
import type { CoderInput, CoderOutput, RoleResult } from "./types.js";

const ACP_TIMEOUT_MS = 60_000;

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
  console.log(`[autodev/coder] Round ${roundLabel}: trying ACP...`);
  const acp = await runWithACP(workDir, instruction, { timeoutMs: ACP_TIMEOUT_MS });
  let mode: CoderOutput["mode"] = "acp";

  console.log(
    `[autodev/coder] Round ${roundLabel}: ACP result: success=${acp.ok}, mode=acp, output length=${acp.output.length}`,
  );

  if (!acp.ok) {
    console.log(`[autodev/coder] ACP failed: ${acp.output}, falling back to CLI`);
    console.log("[autodev/coder] Starting CLI fallback...");
    const cli = await runCursorCLI(workDir, instruction);
    console.log(
      `[autodev/coder] Round ${roundLabel}: CLI result: success=${cli.ok}, output length=${cli.output.length}`,
    );
    if (!cli.ok) {
      const errMsg = `Coder failed after ACP and CLI: ACP: ${acp.output.slice(0, 400)} | CLI: ${cli.output.slice(0, 400)}`;
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
