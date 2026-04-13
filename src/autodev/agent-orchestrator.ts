import { execute as facilitatorExecute } from "./roles/facilitator.js";
import type { FacilitatorOutput, RoleResult } from "./roles/types.js";

export type OrchestrateInput = {
  taskId: string;
  planContent: string;
  workDir: string;
  notionPageId?: string;
  /** If omitted, derived from the first non-empty line of planContent. */
  taskTitle?: string;
};

export type OrchestrateResult = RoleResult<FacilitatorOutput>;

function deriveTaskTitle(planContent: string, taskId: string): string {
  const line = planContent
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const raw = line ?? `Task ${taskId}`;
  return raw.length > 200 ? `${raw.slice(0, 197)}...` : raw;
}

/**
 * Runs the autodev pipeline (PM → Arch → Coder → Validator → CKO) via Facilitator routing.
 */
export async function orchestrate(input: OrchestrateInput): Promise<OrchestrateResult> {
  const taskTitle = input.taskTitle ?? deriveTaskTitle(input.planContent, input.taskId);
  const projectContext = input.notionPageId ? `Notion page ID: ${input.notionPageId}` : undefined;

  return facilitatorExecute({
    taskId: input.taskId,
    taskTitle,
    taskDescription: input.planContent,
    workDir: input.workDir,
    projectContext,
  });
}
