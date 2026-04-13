import { Octokit } from "@octokit/rest";
import { loadConfig } from "../config/config.js";
import { getInstallationToken } from "./github-app-auth.js";

export async function createPullRequest(params: {
  branch: string;
  taskId: string;
  title: string;
  body: string;
}): Promise<{ prNumber: number; prUrl: string }> {
  const gh = loadConfig().autodev?.github;
  if (!gh) {
    throw new Error("autodev.github is not configured");
  }
  const token = await getInstallationToken();
  const octokit = new Octokit({ auth: token });

  const { data } = await octokit.pulls.create({
    owner: gh.repoOwner,
    repo: gh.repoName,
    title: params.title,
    head: params.branch,
    base: "main",
    body: params.body,
  });

  const prNumber = data.number;
  const prUrl =
    data.html_url ?? `https://github.com/${gh.repoOwner}/${gh.repoName}/pull/${prNumber}`;
  return { prNumber, prUrl };
}

/**
 * Enable auto-merge (squash) when branch protections allow it.
 */
export async function enableAutoMerge(prNumber: number): Promise<void> {
  const gh = loadConfig().autodev?.github;
  if (!gh) {
    throw new Error("autodev.github is not configured");
  }
  const token = await getInstallationToken();
  const octokit = new Octokit({ auth: token });

  const { data: pr } = await octokit.pulls.get({
    owner: gh.repoOwner,
    repo: gh.repoName,
    pull_number: prNumber,
  });

  const nodeId = pr.node_id;
  if (!nodeId) {
    console.warn("[autodev/github-pr] PR missing node_id; skip auto-merge");
    return;
  }

  try {
    await octokit.graphql(
      `mutation ($id: ID!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) {
          clientMutationId
        }
      }`,
      { id: nodeId },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[autodev/github-pr] enablePullRequestAutoMerge failed (non-fatal): ${msg}`);
  }
}
