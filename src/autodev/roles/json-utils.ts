import { logDebug } from "../../logger.js";

/**
 * 从 LLM 输出中提取 JSON 对象。
 * 按优先级尝试：
 * 1. 直接 JSON.parse 整段输出
 * 2. 提取 ```json ... ``` 代码块中的内容
 * 3. 提取第一个 { ... } 块（贪婪匹配最外层大括号）
 * 全部失败则抛出错误
 */
export function extractJSON(
  raw: string,
  opts?: { logTag?: string },
): Record<string, unknown> {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* try fallbacks */
  }
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* continue */
    }
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const tag = opts?.logTag ?? "[autodev/json]";
        logDebug(`${tag} JSON 非首字符，已从偏移量 ${firstBrace} 提取`);
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* continue */
    }
  }
  throw new Error(`输出无法解析为 JSON。原始输出前 200 字符: ${trimmed.slice(0, 200)}`);
}
