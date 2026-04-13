import { loadConfig } from "../../config/config.js";
import { logError } from "../../logger.js";
import { extractJSON } from "./json-utils.js";
import { callAgentLLM } from "./llm-helper.js";
import { type ArchInput, type ArchReviewOutput, type RoleResult } from "./types.js";

const ARCH_SYSTEM_PROMPT = `You are an architecture reviewer for an automated coding pipeline.
Review the plan JSON in the user message and respond with a single JSON object only (no markdown):
{"approved": boolean, "suggestions": string[]}

If the plan is safe and reasonable, set approved to true and suggestions to [].
If changes are needed, set approved to false and list concrete suggestions.`;

export async function execute(input: ArchInput): Promise<RoleResult<ArchReviewOutput>> {
  const cfg = loadConfig();
  const agents = cfg.autodev?.agents;
  if (!agents) {
    return { success: false, error: "autodev.agents not configured" };
  }

  try {
    const userPrompt = JSON.stringify(input.plan).slice(0, 14_000);
    const raw = await callAgentLLM("arch", ARCH_SYSTEM_PROMPT, userPrompt);
    const parsed = extractJSON(raw, { logTag: "[autodev/arch]" });
    const approved = Boolean(parsed.approved);
    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.map((s: unknown) => String(s))
      : [];
    return { success: true, data: { approved, suggestions } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError(`[autodev/arch] ${msg}`);
    return { success: false, error: msg };
  }
}
