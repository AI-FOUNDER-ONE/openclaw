import { runCommandWithTimeout } from "../process/exec.js";
import { logDebug, logError } from "../logger.js";

const COMMAND_TIMEOUT_MS = 300_000;

export type ValidationStep = {
  name: string;
  command: string;
  required: boolean;
};

export type ValidationResult = {
  step: ValidationStep;
  success: boolean;
  output: string;
  duration: number;
};

export type FullValidationResult = {
  allPassed: boolean;
  results: ValidationResult[];
  failedSteps: string[];
};

const ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  "npm install",
  "npm run lint",
  "npm test",
  "npm run build",
  "pnpm install",
  "pnpm run lint",
  "pnpm test",
  "pnpm run build",
  "pnpm run typecheck",
  "npx tsc --noEmit",
  // Large monorepo: tsgo/tsc needs a bigger V8 heap than the default ~4GB.
  "node --max-old-space-size=8192 scripts/run-tsgo.mjs",
]);

function isAllowedCommand(command: string): boolean {
  return ALLOWED_COMMANDS.has(command.trim());
}

function parseCommandToArgv(command: string): string[] {
  return command.trim().split(/\s+/);
}

const DEFAULT_STEPS: ValidationStep[] = [
  { name: "install", command: "pnpm install", required: true },
  {
    name: "typecheck",
    command: "node --max-old-space-size=8192 scripts/run-tsgo.mjs",
    required: true,
  },
  { name: "build", command: "pnpm run build", required: false },
];

export async function runCommand(
  command: string,
  workDir: string,
): Promise<{ success: boolean; output: string; duration: number }> {
  if (!isAllowedCommand(command)) {
    return {
      success: false,
      output: `Command rejected: "${command}" is not in the allowed command list`,
      duration: 0,
    };
  }

  const argv = parseCommandToArgv(command);
  const start = Date.now();

  try {
    const result = await runCommandWithTimeout(argv, {
      timeoutMs: COMMAND_TIMEOUT_MS,
      cwd: workDir,
    });

    const duration = Date.now() - start;
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

    return {
      success: result.code === 0,
      output: output.trim(),
      duration,
    };
  } catch (err) {
    const duration = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    logError(`Validation command failed: ${command} — ${message}`);
    return {
      success: false,
      output: message,
      duration,
    };
  }
}

export async function runValidation(
  workDir: string,
  steps: ValidationStep[] = DEFAULT_STEPS,
): Promise<FullValidationResult> {
  const results: ValidationResult[] = [];
  const failedSteps: string[] = [];
  let aborted = false;

  for (const step of steps) {
    if (aborted) {
      results.push({
        step,
        success: false,
        output: "Skipped: a previous required step failed",
        duration: 0,
      });
      failedSteps.push(step.name);
      continue;
    }

    logDebug(`Validation step: ${step.name} — ${step.command}`);
    const { success, output, duration } = await runCommand(step.command, workDir);

    results.push({ step, success, output, duration });

    if (!success) {
      failedSteps.push(step.name);
      if (step.required) {
        aborted = true;
      }
    }
  }

  return {
    allPassed: failedSteps.length === 0,
    results,
    failedSteps,
  };
}

function formatDuration(ms: number): string {
  if (ms < 1_000) {
    return `${ms}ms`;
  }
  return `${(ms / 1_000).toFixed(1)}s`;
}

function truncateOutput(output: string, maxLines = 15): string {
  const lines = output.split("\n");
  if (lines.length <= maxLines) {
    return output;
  }
  return [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more lines)`].join("\n");
}

export function formatValidationReport(result: FullValidationResult): string {
  const lines: string[] = [];

  const header = result.allPassed ? "Validation PASSED" : "Validation FAILED";
  lines.push(`## ${header}`);
  lines.push("");

  for (const r of result.results) {
    const icon = r.success ? "[PASS]" : "[FAIL]";
    const time = r.duration > 0 ? ` (${formatDuration(r.duration)})` : "";
    lines.push(`${icon} ${r.step.name}${time}`);

    if (!r.success && r.output) {
      lines.push("");
      lines.push(truncateOutput(r.output));
      lines.push("");
    }
  }

  if (result.failedSteps.length > 0) {
    lines.push("");
    lines.push(`Failed steps: ${result.failedSteps.join(", ")}`);
  }

  return lines.join("\n");
}
