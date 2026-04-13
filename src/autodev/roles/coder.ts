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
  console.log("[autodev/coder] Round 1: trying ACP...");
  const acp = await runWithACP(workDir, instruction, { timeoutMs: ACP_TIMEOUT_MS });
  let mode: CoderOutput["mode"] = "acp";
  let ok = acp.ok;

  console.log(
    `[autodev/coder] Round 1: ACP result: success=${acp.ok}, mode=acp, output length=${acp.output.length}`,
  );

  if (!acp.ok) {
    console.log(`[autodev/coder] ACP failed: ${acp.output}, falling back to CLI`);
    console.log("[autodev/coder] Starting CLI fallback...");
    const cli = await runCursorCLI(workDir, instruction);
    ok = cli.ok;
    mode = cli.ok ? "cli" : "fallback";
    console.log(
      `[autodev/coder] Round 1: CLI result: success=${cli.ok}, output length=${cli.output.length}`,
    );
  }

  let changedFiles: string[] = [];
  try {
    changedFiles = await getChangedFiles();
  } catch {
    changedFiles = [];
  }
  const preview = changedFiles.slice(0, 40).join(",");
  console.log(`[autodev/coder] Round 1: changedFiles=${changedFiles.length}, files=${preview}`);

  return {
    success: true,
    data: {
      success: ok,
      mode,
      cursorRounds: roundLabel,
      changedFiles,
    },
  };
}
