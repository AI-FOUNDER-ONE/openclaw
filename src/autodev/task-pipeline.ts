import {
  clearAutodevBaseline,
  commitAndPush,
  createFeatureBranch,
  getChangedFiles,
  restoreAutodevStashedWorkspace,
} from "../infra/git-branch.js";
import { resolveGitRoot } from "../infra/git-root.js";
import { getInstallationToken } from "../infra/github-app-auth.js";
import { createPullRequest, enableAutoMerge } from "../infra/github-pr.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { orchestrate } from "./agent-orchestrator.js";
import { postAutodevBridgeStatus } from "./bridge-client.js";

const GIT_CLEANUP_TIMEOUT_MS = 60_000;

export type AutodevTaskInput = {
  taskId: string;
  planVersion: number;
  notionPageId: string;
  planContent: string;
  /** Optional; used in commit message and PR title when set. */
  taskTitle?: string;
};

function deriveTaskTitle(planContent: string, taskId: string): string {
  const line = planContent
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const raw = line ?? `Task ${taskId}`;
  return raw.length > 200 ? `${raw.slice(0, 197)}...` : raw;
}

async function cleanupGitState(repoRoot: string, branchName: string | null): Promise<void> {
  await clearAutodevBaseline(repoRoot);
  if (!branchName) {
    return;
  }
  console.log(`[autodev/pipeline] Git cleanup: reset + checkout main + delete ${branchName}`);
  await runCommandWithTimeout(["git", "-C", repoRoot, "reset", "--hard", "HEAD"], {
    timeoutMs: GIT_CLEANUP_TIMEOUT_MS,
  }).catch(() => undefined);
  await runCommandWithTimeout(["git", "-C", repoRoot, "checkout", "main"], {
    timeoutMs: GIT_CLEANUP_TIMEOUT_MS,
  }).catch(() => undefined);
  await runCommandWithTimeout(["git", "-C", repoRoot, "branch", "-D", branchName], {
    timeoutMs: GIT_CLEANUP_TIMEOUT_MS,
  }).catch(() => undefined);
}

function buildPrBody(params: {
  taskTitle: string;
  planSummary: string;
  changedFiles: string[];
  validationReport: string;
  notionPageId: string;
}): string {
  const files =
    params.changedFiles.length > 0
      ? params.changedFiles.map((f) => `- \`${f}\``).join("\n")
      : "_No files listed._";
  return [
    `## Task`,
    params.taskTitle,
    "",
    `**Notion:** \`${params.notionPageId}\``,
    "",
    "## Plan summary",
    params.planSummary.slice(0, 8000),
    "",
    "## Changed files",
    files,
    "",
    "## Validation",
    "```text",
    params.validationReport.slice(0, 12000),
    "```",
  ].join("\n");
}

/**
 * End-to-end autodev task: Notion status → feature branch → agent orchestration → commit/push → PR → Notion.
 */
export async function runTaskPipeline(taskInput: AutodevTaskInput): Promise<void> {
  const { taskId, planVersion, notionPageId, planContent } = taskInput;
  const taskTitle = taskInput.taskTitle ?? deriveTaskTitle(planContent, taskId);

  const repoRoot = resolveGitRoot(process.cwd());
  if (!repoRoot) {
    throw new Error("Not inside a git repository (resolveGitRoot returned null)");
  }
  const workDir = repoRoot;

  let featureBranch: string | null = null;

  try {
    console.log(
      `[autodev/pipeline] Start task=${taskId} planVersion=${planVersion} repo=${workDir}`,
    );

    // Step 1a — Notion Running
    console.log("[autodev/pipeline] Step 1a: POST status Running");
    await postAutodevBridgeStatus({
      taskId,
      notionPageId,
      status: "Running",
      planVersion,
    });

    // Step 1b — feature branch
    console.log("[autodev/pipeline] Step 1b: create feature branch");
    featureBranch = await createFeatureBranch(taskId, planVersion);
    console.log(`[autodev/pipeline] Branch: ${featureBranch}`);

    // Step 2 — orchestration
    console.log(
      "[autodev/pipeline] Step 2: Facilitator orchestrate (PM → Arch → Coder → Validator → CKO)",
    );
    const orch = await orchestrate({
      taskId,
      planContent,
      workDir,
      notionPageId,
      taskTitle,
    });

    if (!orch.success) {
      throw new Error(orch.error);
    }
    if (orch.data.state !== "done") {
      throw new Error(`Orchestration ended in state: ${orch.data.state}`);
    }

    const out = orch.data;
    const cursorMode = out.coderResult?.mode ?? "unknown";
    const cursorRounds = out.coderResult?.cursorRounds ?? 0;

    // Collect files for PR body (post-orchestration, pre-commit)
    let changedFiles = out.coderResult?.changedFiles ?? [];
    if (changedFiles.length === 0) {
      try {
        changedFiles = await getChangedFiles();
      } catch {
        changedFiles = [];
      }
    }

    const validationReport = out.validatorResult?.validationReport ?? "(no validation report)";
    const planSummary = out.plan?.goal
      ? `${out.plan.goal}\n\n${planContent.slice(0, 2000)}`
      : planContent.slice(0, 4000);

    await clearAutodevBaseline(workDir);

    // Step 3 — commit + push (warm GitHub App token first)
    console.log("[autodev/pipeline] Step 3: commit and push");
    await getInstallationToken();
    const commitMessage = `feat(autodev): ${taskTitle} [notion-${taskId}]`;
    const commitHash = await commitAndPush(commitMessage);
    console.log(`[autodev/pipeline] Pushed commit ${commitHash}`);

    // Step 4 — PR + auto-merge
    console.log("[autodev/pipeline] Step 4: create PR + enable auto-merge");
    const { prNumber, prUrl } = await createPullRequest({
      branch: featureBranch,
      taskId,
      title: taskTitle,
      body: buildPrBody({
        taskTitle,
        planSummary,
        changedFiles,
        validationReport,
        notionPageId,
      }),
    });
    console.log(`[autodev/pipeline] PR #${prNumber}: ${prUrl}`);

    await enableAutoMerge(prNumber);
    console.log("[autodev/pipeline] Auto-merge enabled");

    // Step 5 — Notion PR Open
    console.log("[autodev/pipeline] Step 5: POST status PR Open");
    await postAutodevBridgeStatus({
      taskId,
      notionPageId,
      status: "PR Open",
      branch: featureBranch,
      prUrl,
      commitHash,
      cursorMode,
      cursorRounds,
    });

    console.log("[autodev/pipeline] Done");
  } catch (err) {
    const errorReason = err instanceof Error ? err.message : String(err);
    console.error(`[autodev/pipeline] FAILED: ${errorReason}`);

    try {
      await postAutodevBridgeStatus({
        taskId,
        notionPageId,
        status: "Blocked",
        errorReason,
        planVersion,
      });
    } catch (bridgeErr) {
      console.error(
        `[autodev/pipeline] Could not post Blocked status: ${bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr)}`,
      );
    }

    await cleanupGitState(workDir, featureBranch);
    throw err;
  } finally {
    await restoreAutodevStashedWorkspace(workDir);
  }
}
