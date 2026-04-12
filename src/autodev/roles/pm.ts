import { loadConfig } from "../../config/config.js";
import { logDebug, logError } from "../../logger.js";
import { extractJSON } from "./json-utils.js";
import { callAgentLLM } from "./llm-helper.js";
import {
  resolveAgentConfig,
  type PMInput,
  type PlanOutput,
  type PlanTask,
  type RoleResult,
} from "./types.js";

const PM_MAX_RETRIES = 2;

const JSON_SYSTEM_PREFIX =
  "你是一个严格的 JSON 生成器。你的全部输出必须是且仅是一个合法 JSON 对象，不要包含任何自然语言、解释、markdown 代码块标记或其他非 JSON 内容。\n\n";

const PM_PROMPT_TEMPLATE = `${JSON_SYSTEM_PREFIX}You are acting as PM (Project Manager) in an automated development pipeline.

Analyze the following task and generate a structured development plan.

**Task Title:** {taskTitle}
**Task Description:** {taskDescription}
{projectContextBlock}

输出格式（严格 JSON，无其他内容）：
{
  "plan": {
    "objective": "目标描述",
    "acceptanceCriteria": ["验收标准1", "验收标准2"],
    "impactScope": ["文件或模块路径"],
    "tasks": [
      {
        "step": 1,
        "title": "步骤标题",
        "cursorInstruction": "给 Cursor 的具体指令",
        "verifyCommand": "验证命令"
      }
    ]
  },
  "riskLevel": "Low",
  "cursorInstructions": ["指令1", "指令2"]
}

Rules:
- Generate 3-5 discrete tasks inside plan.tasks (or provide equivalent cursorInstructions).
- Each cursorInstruction must be self-contained with enough context for Cursor to execute independently.
- Use verifyCommand where possible (e.g. "pnpm tsgo", "pnpm test <file>").
- riskLevel must be one of: Low, Medium, High (assess based on change scope, tests, architecture).
- You may use either plan.tasks or top-level cursorInstructions; at least one must be non-empty.`;

const JSON_USER_SUFFIX =
  "\n\n【重要】请直接输出 JSON 对象，不要有任何前言、解释或 markdown 标记。第一个字符必须是 {，最后一个字符必须是 }。";

const JSON_RETRY_SUFFIX =
  "\n\n上一次输出不是合法 JSON 或结构不完整，请只输出符合上述 schema 的 JSON，第一个字符必须是 {，最后一个字符必须是 }。";

function riskNorm(r: unknown): PlanOutput["riskLevel"] {
  const s = String(r ?? "medium").toLowerCase();
  if (s === "low" || s === "medium" || s === "high") {
    return s;
  }
  return "medium";
}

function normalizeToPlanOutput(parsed: Record<string, unknown>, input: PMInput): PlanOutput {
  if (parsed.plan && typeof parsed.plan === "object" && parsed.plan !== null) {
    const p = parsed.plan as Record<string, unknown>;
    const tasksRaw = Array.isArray(p.tasks) ? p.tasks : [];
    let tasks: PlanTask[] = tasksRaw.map((t, idx) => {
      const row = t as Record<string, unknown>;
      const verify = row.verifyCommand ?? row.validationCommand;
      return {
        title: String(row.title ?? `Step ${idx + 1}`),
        cursorInstruction: String(row.cursorInstruction ?? ""),
        ...(verify != null && String(verify).trim() !== ""
          ? { validationCommand: String(verify) }
          : {}),
      };
    });
    tasks = tasks.filter((t) => t.cursorInstruction.trim().length > 0);
    if (tasks.length === 0 && Array.isArray(parsed.cursorInstructions)) {
      tasks = (parsed.cursorInstructions as unknown[]).map((c, i) => ({
        title: `Step ${i + 1}`,
        cursorInstruction: String(c),
      }));
    }
    const goal = String(p.objective ?? input.taskTitle).trim();
    return {
      goal: goal || input.taskTitle,
      acceptanceCriteria: Array.isArray(p.acceptanceCriteria)
        ? p.acceptanceCriteria.map(String)
        : [],
      impactScope: Array.isArray(p.impactScope) ? p.impactScope.map(String) : [],
      tasks,
      riskLevel: riskNorm(parsed.riskLevel ?? p.riskLevel),
    };
  }

  if (typeof parsed.goal === "string") {
    const tasks = Array.isArray(parsed.tasks)
      ? (parsed.tasks as unknown[]).map((t, idx) => {
          const row = t as Record<string, unknown>;
          const verify = row.validationCommand ?? row.verifyCommand;
          return {
            title: String(row.title ?? `Step ${idx + 1}`),
            cursorInstruction: String(row.cursorInstruction ?? ""),
            ...(verify != null && String(verify).trim() !== ""
              ? { validationCommand: String(verify) }
              : {}),
          };
        })
      : [];
    return {
      goal: parsed.goal,
      acceptanceCriteria: Array.isArray(parsed.acceptanceCriteria)
        ? parsed.acceptanceCriteria.map(String)
        : [],
      impactScope: Array.isArray(parsed.impactScope) ? parsed.impactScope.map(String) : [],
      tasks,
      riskLevel: riskNorm(parsed.riskLevel),
    };
  }

  if (Array.isArray(parsed.cursorInstructions) && parsed.cursorInstructions.length > 0) {
    return {
      goal: input.taskTitle,
      acceptanceCriteria: [],
      impactScope: [],
      tasks: (parsed.cursorInstructions as unknown[]).map((c, i) => ({
        title: `Step ${i + 1}`,
        cursorInstruction: String(c),
      })),
      riskLevel: riskNorm(parsed.riskLevel),
    };
  }

  throw new Error(
    `JSON 结构无法映射为开发计划。原始键: ${Object.keys(parsed).join(", ")}；前 200 字符: ${JSON.stringify(parsed).slice(0, 200)}`,
  );
}

function buildPrompt(input: PMInput, attempt: number): string {
  const projectContextBlock = input.projectContext
    ? `**Project Context:**\n${input.projectContext}`
    : "";
  let body = PM_PROMPT_TEMPLATE.replace("{taskTitle}", input.taskTitle)
    .replace("{taskDescription}", input.taskDescription)
    .replace("{projectContextBlock}", projectContextBlock);
  body += JSON_USER_SUFFIX;
  if (attempt > 1) {
    body += JSON_RETRY_SUFFIX;
  }
  return body;
}

function validateExtractedShape(result: Record<string, unknown>): void {
  const hasPlan = result.plan && typeof result.plan === "object" && result.plan !== null;
  const hasCursorInstructions =
    Array.isArray(result.cursorInstructions) && result.cursorInstructions.length > 0;
  const hasLegacyGoal = typeof result.goal === "string" && result.goal.trim().length > 0;
  if (!hasPlan && !hasCursorInstructions && !hasLegacyGoal) {
    throw new Error("JSON 缺少 plan、cursorInstructions 或 goal 字段");
  }
}

function validatePlanOutput(plan: PlanOutput, rawPreview: string): void {
  if (!plan.goal?.trim()) {
    throw new Error(`解析后缺少 goal。原始输出前 200 字符: ${rawPreview.slice(0, 200)}`);
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new Error(`解析后 tasks 为空。原始输出前 200 字符: ${rawPreview.slice(0, 200)}`);
  }
}

export async function execute(input: PMInput): Promise<RoleResult<PlanOutput>> {
  const cfg = loadConfig();
  const agents = cfg.autodev?.agents;
  if (!agents) {
    return { success: false, error: "autodev.agents not configured" };
  }

  let lastError: Error | null = null;

  try {
    const agentConfig = resolveAgentConfig(agents, "pm");
    logDebug(`[autodev/pm] Generating plan for: ${input.taskTitle}`);

    for (let attempt = 1; attempt <= PM_MAX_RETRIES; attempt++) {
      try {
        const prompt = buildPrompt(input, attempt);
        const rawOutput = await callAgentLLM({
          agentConfig,
          role: "pm",
          prompt,
          workDir: process.cwd(),
        });
        console.log(`[autodev/pm] Attempt ${attempt} raw output length: ${rawOutput.length}`);

        const result = extractJSON(rawOutput, { logTag: "[autodev/pm]" });
        validateExtractedShape(result);
        const plan = normalizeToPlanOutput(result, input);
        validatePlanOutput(plan, rawOutput);

        logDebug(`[autodev/pm] Plan generated: ${plan.tasks.length} tasks, risk=${plan.riskLevel}`);
        return { success: true, data: plan };
      } catch (err: unknown) {
        const e = err instanceof Error ? err : new Error(String(err));
        lastError = e;
        const preview =
          e.message.length > 200 ? `${e.message.slice(0, 200)}…` : e.message;
        console.error(`[autodev/pm] Attempt ${attempt}/${PM_MAX_RETRIES} failed:`, preview);
        if (attempt < PM_MAX_RETRIES) {
          console.log("[autodev/pm] 追加 JSON 强制提示后重试...");
        }
      }
    }

    const finalMsg = lastError?.message ?? "PM failed after all retries";
    logError(`[autodev/pm] ${finalMsg}`);
    return { success: false, error: finalMsg };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[autodev/pm] ${message}`);
    return { success: false, error: message };
  }
}
