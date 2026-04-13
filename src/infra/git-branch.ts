import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { findGitRoot } from "./git-root.js";
import { getInstallationToken } from "./github-app-auth.js";

const GIT_TIMEOUT_MS = 30_000;

/** Written under `.git/` so it is never committed; marks the autodev task baseline commit. */
const AUTODEV_BASELINE_FILENAME = "openclaw-autodev-baseline";

function autodevBaselineMarkerPath(root: string): string {
  return path.join(root, ".git", AUTODEV_BASELINE_FILENAME);
}

/** Remove autodev baseline marker (e.g. after task completes or cleanup). */
export async function clearAutodevBaseline(root: string): Promise<void> {
  try {
    await fs.unlink(autodevBaselineMarkerPath(root));
  } catch {
    /* missing is fine */
  }
}

async function resolveRepoRoot(): Promise<string> {
  const root = findGitRoot(process.cwd());
  if (!root) {
    throw new Error("Not inside a git repository");
  }
  return root;
}

function git(root: string, args: string[], timeoutMs = GIT_TIMEOUT_MS) {
  return runCommandWithTimeout(["git", "-C", root, ...args], { timeoutMs });
}

async function resolveMainLikeRef(root: string): Promise<string | null> {
  for (const ref of ["main", "origin/main", "master", "origin/master"] as const) {
    const r = await git(root, ["rev-parse", "--verify", ref]);
    if (r.code === 0 && r.stdout.trim()) {
      return ref;
    }
  }
  return null;
}

function assertSuccess(result: { code: number | null; stderr: string }, context: string): void {
  if (result.code !== 0) {
    throw new Error(`${context} failed (exit ${result.code}): ${result.stderr.trim()}`);
  }
}

export async function createFeatureBranch(taskId: string, planVersion: number): Promise<string> {
  const root = await resolveRepoRoot();
  const branchName = `feature/notion-${taskId}-v${planVersion}`;

  await clearAutodevBaseline(root);

  const checkout = await git(root, ["checkout", "main"]);
  assertSuccess(checkout, "git checkout main");

  const pull = await git(root, ["pull", "origin", "main"]);
  assertSuccess(pull, "git pull origin main");

  const create = await git(root, ["checkout", "-b", branchName]);
  assertSuccess(create, `git checkout -b ${branchName}`);

  // Empty commit: stable baseline so getChangedFiles() can ignore pre-existing dirty trees vs main.
  const emptyCommit = await git(root, [
    "commit",
    "--allow-empty",
    "-m",
    "chore(autodev): workspace baseline",
  ]);
  assertSuccess(emptyCommit, "git commit --allow-empty (autodev baseline)");

  const headRes = await git(root, ["rev-parse", "HEAD"]);
  assertSuccess(headRes, "git rev-parse HEAD");
  await fs.writeFile(autodevBaselineMarkerPath(root), `${headRes.stdout.trim()}\n`, "utf8");

  return branchName;
}

export async function getChangedFiles(): Promise<string[]> {
  const root = await resolveRepoRoot();
  const files = new Set<string>();

  let baselineSha: string | null = null;
  try {
    const raw = await fs.readFile(autodevBaselineMarkerPath(root), "utf8");
    baselineSha = raw.trim() || null;
  } catch {
    baselineSha = null;
  }

  const addLines = (stdout: string) => {
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) {
        files.add(trimmed);
      }
    }
  };

  if (baselineSha) {
    // Commits on this branch after the autodev baseline (typically Coder commits if any).
    const committed = await git(root, ["diff", "--name-only", `${baselineSha}...HEAD`]);
    if (committed.code === 0) {
      addLines(committed.stdout);
    }
    // Working tree vs current HEAD (Coder edits before pipeline commit).
    const wt = await git(root, ["diff", "--name-only", "HEAD"]);
    if (wt.code === 0) {
      addLines(wt.stdout);
    }
  } else {
    // No baseline (non-pipeline use): commits ahead of main + local edits (not “all diff vs main”).
    const mainRef = await resolveMainLikeRef(root);
    if (mainRef) {
      const branchCommits = await git(root, ["diff", "--name-only", `${mainRef}...HEAD`]);
      if (branchCommits.code === 0) {
        addLines(branchCommits.stdout);
      }
    }
    const diffRes = await git(root, ["diff", "--name-only", "HEAD"]);
    addLines(diffRes.stdout);
  }

  const untrackedRes = await git(root, ["ls-files", "--others", "--exclude-standard"]);
  addLines(untrackedRes.stdout);

  return [...files].toSorted();
}

export async function getDiffContent(): Promise<string> {
  const root = await resolveRepoRoot();

  // Staged diff
  const staged = await git(root, ["diff", "--cached"]);
  // Unstaged diff
  const unstaged = await git(root, ["diff"]);

  return [staged.stdout, unstaged.stdout].filter(Boolean).join("\n");
}

export async function commitAndPush(message: string): Promise<string> {
  const root = await resolveRepoRoot();

  const addRes = await git(root, ["add", "-A"]);
  assertSuccess(addRes, "git add -A");

  const commitRes = await git(root, ["commit", "-m", message]);
  assertSuccess(commitRes, "git commit");

  // Extract commit hash from output
  const hashRes = await git(root, ["rev-parse", "HEAD"]);
  assertSuccess(hashRes, "git rev-parse HEAD");
  const commitHash = hashRes.stdout.trim();

  // Build push URL with installation token for authentication
  const token = await getInstallationToken();
  const cfg = loadConfig();
  const github = cfg.autodev?.github;
  if (!github) {
    throw new Error("autodev.github is not configured in openclaw.json");
  }

  const branchRes = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  assertSuccess(branchRes, "git rev-parse --abbrev-ref HEAD");
  const currentBranch = branchRes.stdout.trim();

  const pushUrl = `https://x-access-token:${token}@github.com/${github.repoOwner}/${github.repoName}.git`;

  const pushRes = await git(root, ["push", pushUrl, `HEAD:${currentBranch}`], 60_000);
  assertSuccess(pushRes, "git push");

  return commitHash;
}
