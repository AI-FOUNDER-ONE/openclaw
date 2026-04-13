import { logDebug, logError } from "../../logger.js";
import { execute as archExecute } from "./arch.js";
import { execute as ckoExecute } from "./cko.js";
import { execute as coderExecute } from "./coder.js";
import { execute as pmExecute } from "./pm.js";
import type {
  ArchReviewOutput,
  CKOOutput,
  CoderOutput,
  FacilitatorInput,
  FacilitatorOutput,
  PlanOutput,
  RoleResult,
  ValidatorOutput,
} from "./types.js";
import { execute as validatorExecute } from "./validator.js";

const MAX_PLANNING_ROUNDS = 3;
const MAX_CODING_ROUNDS = 3;

type FacilitatorState =
  | "planning"
  | "reviewing"
  | "coding"
  | "validating"
  | "knowledge"
  | "done"
  | "failed";

function isLowRisk(level: PlanOutput["riskLevel"]): boolean {
  return level === "low";
}

export async function execute(input: FacilitatorInput): Promise<RoleResult<FacilitatorOutput>> {
  const { taskId, taskTitle, workDir, projectContext } = input;
  let taskDescription = input.taskDescription;

  let state: FacilitatorState = "planning";
  let plan: PlanOutput | undefined;
  let archReview: ArchReviewOutput | undefined;
  let coderResult: CoderOutput | undefined;
  let validatorResult: ValidatorOutput | undefined;
  let knowledge: CKOOutput | undefined;

  let planningRounds = 0;
  let codingRounds = 0;
  let pendingRepair: string | undefined;

  logDebug(`[autodev/facilitator] Starting pipeline for task ${taskId}: ${taskTitle}`);

  while (state !== "done" && state !== "failed") {
    logDebug(`[autodev/facilitator] State: ${state}`);
    switch (state) {
      case "planning": {
        planningRounds += 1;
        if (planningRounds > MAX_PLANNING_ROUNDS) {
          logError("[autodev/facilitator] Exceeded max planning rounds");
          state = "failed";
          break;
        }
        const pm = await pmExecute({ taskTitle, taskDescription, projectContext });
        if (!pm.success) {
          logError(`[autodev/facilitator] PM failed: ${pm.error}`);
          state = "failed";
          break;
        }
        plan = pm.data;
        state = isLowRisk(plan.riskLevel) ? "coding" : "reviewing";
        break;
      }
      case "reviewing": {
        if (!plan) {
          state = "failed";
          break;
        }
        const ar = await archExecute({ plan });
        if (!ar.success) {
          logError(`[autodev/facilitator] Arch failed: ${ar.error}`);
          state = "failed";
          break;
        }
        archReview = ar.data;
        if (archReview.approved) {
          state = "coding";
        } else if (planningRounds < MAX_PLANNING_ROUNDS) {
          taskDescription += `\n\n**Architecture feedback:**\n${archReview.suggestions.join("\n")}`;
          state = "planning";
        } else {
          logError("[autodev/facilitator] Plan rejected after max planning rounds");
          state = "failed";
        }
        break;
      }
      case "coding": {
        if (!plan) {
          state = "failed";
          break;
        }
        if (codingRounds >= MAX_CODING_ROUNDS) {
          logError("[autodev/facilitator] Exceeded max coding rounds");
          state = "failed";
          break;
        }
        codingRounds += 1;
        const code = await coderExecute({
          tasks: plan.tasks,
          workDir,
          repairInstruction: pendingRepair,
          roundIndex: codingRounds,
        });
        pendingRepair = undefined;
        if (!code.success) {
          logError(`[autodev/facilitator] Coder failed: ${code.error}`);
          state = "failed";
          break;
        }
        coderResult = code.data;
        state = "validating";
        break;
      }
      case "validating": {
        const val = await validatorExecute({ workDir });
        if (!val.success) {
          logError(`[autodev/facilitator] Validator failed: ${val.error}`);
          state = "failed";
          break;
        }
        validatorResult = val.data;
        if (validatorResult.passed) {
          state = "knowledge";
        } else if (codingRounds < MAX_CODING_ROUNDS) {
          pendingRepair =
            validatorResult.fixInstructions?.trim() ||
            "Fix all validation failures from the last validation report. Run pnpm check in the repo root before finishing.";
          state = "coding";
        } else {
          console.error("[autodev/facilitator] Validation failed after max coding rounds");
          state = "failed";
        }
        break;
      }
      case "knowledge": {
        if (!plan || !validatorResult) {
          state = "failed";
          break;
        }
        const k = await ckoExecute({
          taskId,
          taskTitle,
          plan,
          validationReport: validatorResult.validationReport,
          workDir,
        });
        if (!k.success) {
          logError(`[autodev/facilitator] CKO failed: ${k.error}`);
          state = "failed";
          break;
        }
        knowledge = k.data;
        state = "done";
        break;
      }
      default: {
        state = "failed";
      }
    }
  }

  if (state === "failed") {
    return { success: false, error: "Pipeline failed — see logs" };
  }

  return {
    success: true,
    data: {
      state: "done",
      plan,
      archReview,
      coderResult,
      validatorResult,
      knowledge,
    },
  };
}
