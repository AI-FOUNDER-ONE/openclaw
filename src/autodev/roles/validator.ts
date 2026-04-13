import { loadConfig } from "../../config/config.js";
import { getChangedFiles } from "../../infra/git-branch.js";
import { logDebug, logError } from "../../logger.js";
import { runValidation, formatValidationReport } from "../validation.js";
import { extractJSON } from "./json-utils.js";
import { callAgentLLM } from "./llm-helper.js";
import { type ValidatorInput, type ValidatorOutput, type RoleResult } from "./types.js";

const VALIDATOR_LLM_MAX_ATTEMPTS = 2;

const VALIDATOR_JSON_STRICT =
  "你必须只输出 JSON，不要包含任何自然语言解释。第一个字符必须是 {。\n" +
  '输出格式：{ "passed": boolean, "fixInstructions": string | null, "analysis": string }\n\n';

const FAILURE_ANALYSIS_PROMPT = `You are acting as Validator in an automated development pipeline.

The following validation steps failed. Analyze the errors and produce a fix instruction
that a coding agent (Cursor) can execute to resolve them.

${VALIDATOR_JSON_STRICT}

**Validation Report:**
{validationReport}

**Changed Files:**
{changedFilesList}
{expectedFilesBlock}

Rules:
- Focus on the root cause, not the symptom.
- Set "fixInstructions" to a self-contained natural-language instruction for the coding agent to fix all reported errors, or null if not applicable.
- Set "analysis" to a concise technical summary of what failed.
- Set "passed" to false (validation already failed in this pipeline step).
- If multiple errors exist, address them in a single cohesive instruction in fixInstructions.`;

const VALIDATOR_JSON_RETRY_SUFFIX =
  "\n\n【重试】上一次输出无法解析为 JSON。现在只输出一个 JSON 对象：不要 markdown、不要代码块、不要任何前缀或后缀。第一个字符必须是 {，最后一个字符必须是 }。字段：passed (boolean), fixInstructions (string 或 null), analysis (string)。";

const DEFAULT_PARSE_FAILURE_ANALYSIS = "LLM 输出解析失败，无法生成修复建议";

function parseFixInstructions(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function parseAnalysis(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function execute(input: ValidatorInput): Promise<RoleResult<ValidatorOutput>> {
  const { workDir, expectedFiles } = input;

  console.log("[autodev/validator] Starting validation in", workDir);

  try {
    logDebug(`[autodev/validator] Running validation in ${workDir}`);
    const result = await runValidation(workDir);

    console.log("[autodev/validator] Validation result: allPassed=", result.allPassed);
    console.log(
      "[autodev/validator] Steps:",
      result.results
        .map((r) => `${r.step.name}: ${r.success ? "PASS" : "FAIL"} (${r.duration}ms)`)
        .join(", "),
    );
    for (const r of result.results) {
      if (!r.success) {
        console.log(`[autodev/validator] FAILED step "${r.step.name}" output (first 20 lines):`);
        console.log(r.output.split("\n").slice(0, 20).join("\n"));
      }
    }

    const report = formatValidationReport(result);

    if (result.allPassed) {
      // Scope check: verify changed files match expectations
      if (expectedFiles && expectedFiles.length > 0) {
        try {
          const actual = await getChangedFiles();
          console.log("[autodev/validator] Changed files count:", actual.length);
          const unexpected = actual.filter((f) => !expectedFiles.includes(f));
          if (unexpected.length > 0) {
            logDebug(`[autodev/validator] Unexpected file changes: ${unexpected.join(", ")}`);
            const scopeWarning =
              `\n\nScope warning: ${unexpected.length} unexpected file(s) changed: ` +
              unexpected.join(", ");
            console.log("[autodev/validator] Final verdict: passed=", true);
            return {
              success: true,
              data: {
                passed: true,
                validationReport: report + scopeWarning,
              },
            };
          }
        } catch {
          logDebug("[autodev/validator] Could not check file scope (non-fatal)");
        }
      }

      logDebug("[autodev/validator] All validations passed");
      console.log("[autodev/validator] Final verdict: passed=", true);
      return {
        success: true,
        data: { passed: true, validationReport: report },
      };
    }

    // Validation failed — gather changed files for LLM / logs
    logDebug(
      `[autodev/validator] Validation failed (${result.failedSteps.join(", ")}), calling LLM for analysis`,
    );

    let changedFilesList = "(unknown)";
    try {
      const files = await getChangedFiles();
      console.log("[autodev/validator] Changed files count:", files.length);
      changedFilesList = files.map((f) => `- ${f}`).join("\n");
    } catch {
      // non-fatal
    }

    const cfg = loadConfig();
    const agents = cfg.autodev?.agents;
    if (!agents) {
      console.log("[autodev/validator] LLM analysis skipped (no autodev.agents)");
      console.log("[autodev/validator] Final verdict: passed=", false);
      return {
        success: true,
        data: {
          passed: false,
          validationReport: report,
          fixInstructions: undefined,
        },
      };
    }

    const expectedFilesBlock =
      expectedFiles && expectedFiles.length > 0
        ? `**Expected Files:**\n${expectedFiles.map((f) => `- ${f}`).join("\n")}`
        : "";

    const basePrompt = FAILURE_ANALYSIS_PROMPT.replace("{validationReport}", report)
      .replace("{changedFilesList}", changedFilesList)
      .replace("{expectedFilesBlock}", expectedFilesBlock);

    try {
      for (let attempt = 1; attempt <= VALIDATOR_LLM_MAX_ATTEMPTS; attempt += 1) {
        const prompt = attempt === 1 ? basePrompt : `${basePrompt}${VALIDATOR_JSON_RETRY_SUFFIX}`;
        try {
          const raw = await callAgentLLM("validator", "", prompt);
          logDebug(`[autodev/validator] Attempt ${attempt} raw output length: ${raw.length}`);
          const parsed = extractJSON(raw, { logTag: "[autodev/validator]" });
          const fixInstructions = parseFixInstructions(parsed.fixInstructions);
          const analysis = parseAnalysis(parsed.analysis);
          const llmResult = {
            passed: parsed.passed,
            fixInstructions: fixInstructions ?? null,
            analysis,
          };
          console.log(
            "[autodev/validator] LLM analysis result:",
            JSON.stringify(llmResult).slice(0, 500),
          );
          const reportSuffix = analysis ? `\n\n**LLM analysis:** ${analysis}` : "";

          console.log("[autodev/validator] Final verdict: passed=", false);
          return {
            success: true,
            data: {
              passed: false,
              validationReport: report + reportSuffix,
              fixInstructions,
            },
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logError(`[autodev/validator] Attempt ${attempt} parse/LLM error: ${msg}`);
        }
      }
      logError(`[autodev/validator] ${DEFAULT_PARSE_FAILURE_ANALYSIS}`);
      console.log("[autodev/validator] Final verdict: passed=", false);
      return {
        success: true,
        data: {
          passed: false,
          validationReport: `${report}\n\n**LLM analysis:** ${DEFAULT_PARSE_FAILURE_ANALYSIS}`,
          fixInstructions: undefined,
        },
      };
    } catch (llmErr) {
      const llmMessage = llmErr instanceof Error ? llmErr.message : String(llmErr);
      logError(`[autodev/validator] LLM analysis failed: ${llmMessage}`);
      console.log("[autodev/validator] Final verdict: passed=", false);
      return {
        success: true,
        data: {
          passed: false,
          validationReport: `${report}\n\n**LLM analysis:** ${DEFAULT_PARSE_FAILURE_ANALYSIS}`,
        },
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[autodev/validator] ${message}`);
    console.log("[autodev/validator] Final verdict: passed=", false, "(role error)");
    return { success: false, error: message };
  }
}
