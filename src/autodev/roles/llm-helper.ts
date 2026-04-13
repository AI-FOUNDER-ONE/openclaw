import { loadConfig } from "../../config/config.js";
import type { AutodevAgentsConfig } from "../../config/types.autodev.js";

function resolveBaseUrlAndModel(modelRaw: string): { baseUrl: string; actualModel: string } {
  const model = modelRaw.trim();
  if (model.startsWith("moonshot/")) {
    return {
      baseUrl: "https://api.moonshot.cn/v1",
      actualModel: model.slice("moonshot/".length),
    };
  }
  if (model.startsWith("deepseek/")) {
    return {
      baseUrl: "https://api.deepseek.com/v1",
      actualModel: model.slice("deepseek/".length),
    };
  }
  if (model.startsWith("anthropic/")) {
    return {
      baseUrl: "https://api.anthropic.com/v1",
      actualModel: model.slice("anthropic/".length),
    };
  }
  return {
    baseUrl: "https://api.openai.com/v1",
    actualModel: model,
  };
}

function buildMessages(
  systemPrompt: string,
  userPrompt: string,
): Array<{
  role: "system" | "user";
  content: string;
}> {
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  const sys = systemPrompt.trim();
  if (sys.length > 0) {
    messages.push({ role: "system", content: sys });
  }
  messages.push({ role: "user", content: userPrompt });
  return messages;
}

/**
 * Direct OpenAI-compatible `fetch` to the vendor implied by `autodev.agents[role].model`
 * prefix. Does not use embedded Pi agent or OpenClaw provider routing.
 */
export async function callAgentLLM(
  role: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const config = loadConfig();
  const agents = config.autodev?.agents;
  if (!agents) {
    throw new Error("autodev.agents is not configured");
  }
  const agentConfig = agents[role as keyof AutodevAgentsConfig];
  if (!agentConfig) {
    throw new Error(`No autodev agent config for role: ${role}`);
  }

  const { model, apiKey } = agentConfig;
  const { baseUrl, actualModel } = resolveBaseUrlAndModel(model);

  console.log(`[llm-helper] role=${role} model=${actualModel} baseUrl=${baseUrl}`);

  const temperature = model.trim().startsWith("moonshot/") ? 1 : 0.7;

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: actualModel,
      messages: buildMessages(systemPrompt, userPrompt),
      temperature,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`LLM request failed: ${response.status} ${errorText.slice(0, 800)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) {
    throw new Error(`LLM returned empty content: ${JSON.stringify(data).slice(0, 500)}`);
  }
  console.log(`[llm-helper] role=${role} response length=${text.length}`);
  return text;
}
