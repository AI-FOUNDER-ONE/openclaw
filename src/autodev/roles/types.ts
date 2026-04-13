import type { AutodevAgentConfig, AutodevAgentsConfig } from "../../config/types.autodev.js";

export type RoleResult<T> = { success: true; data: T } | { success: false; error: string };

export type PlanTask = {
  title: string;
  cursorInstruction: string;
  validationCommand?: string;
};

export type PlanOutput = {
  goal: string;
  acceptanceCriteria: string[];
  impactScope: string[];
  tasks: PlanTask[];
  riskLevel: "low" | "medium" | "high";
};

export type PMInput = {
  taskTitle: string;
  taskDescription: string;
  projectContext?: string;
};

export type ArchInput = { plan: PlanOutput };

export type ArchReviewOutput = {
  approved: boolean;
  suggestions: string[];
};

export type CoderInput = {
  tasks: PlanTask[];
  workDir: string;
  /** Prepended to the combined instruction (validator repair loop). */
  repairInstruction?: string;
  /** Facilitator coding round (for logs). */
  roundIndex?: number;
};

export type CoderOutput = {
  success: boolean;
  mode: "acp" | "cli";
  cursorRounds: number;
  changedFiles: string[];
};

export type ValidatorInput = {
  workDir: string;
  expectedFiles?: string[];
};

export type ValidatorOutput = {
  passed: boolean;
  validationReport: string;
  fixInstructions?: string;
};

export type CKOInput = {
  taskId: string;
  taskTitle: string;
  plan: PlanOutput;
  validationReport: string;
  workDir: string;
};

export type CKOOutput = {
  summary: string;
};

export type FacilitatorInput = {
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  workDir: string;
  projectContext?: string;
};

export type FacilitatorOutput = {
  state: "done" | "failed";
  plan?: PlanOutput;
  archReview?: ArchReviewOutput;
  coderResult?: CoderOutput;
  validatorResult?: ValidatorOutput;
  knowledge?: CKOOutput;
};

export function resolveAgentConfig(
  agents: AutodevAgentsConfig,
  role: keyof AutodevAgentsConfig,
): AutodevAgentConfig {
  return agents[role];
}
