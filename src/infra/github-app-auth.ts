import fs from "node:fs/promises";
import jwt from "jsonwebtoken";
import { loadConfig } from "../config/config.js";

let cachedToken: string | null = null;
let cachedExpiresAt = 0;

/**
 * Returns a GitHub installation access token for `autodev.github` (short-lived cache).
 */
export async function getInstallationToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedExpiresAt > now + 60_000) {
    return cachedToken;
  }

  const gh = loadConfig().autodev?.github;
  if (!gh) {
    throw new Error("autodev.github is not configured");
  }

  const privateKey = await fs.readFile(gh.privateKeyPath, "utf8");
  const issued = Math.floor(now / 1000) - 60;
  const appJwt = jwt.sign({ iat: issued, exp: issued + 600, iss: gh.appId }, privateKey, {
    algorithm: "RS256",
  });

  const res = await fetch(
    `https://api.github.com/app/installations/${gh.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub installation token failed (${res.status}): ${text.slice(0, 400)}`);
  }

  const data = (await res.json()) as { token?: string; expires_at?: string };
  if (!data.token) {
    throw new Error("GitHub installation token response missing token");
  }
  cachedToken = data.token;
  const exp = data.expires_at ? Date.parse(data.expires_at) : now + 3_600_000;
  cachedExpiresAt = Number.isFinite(exp) ? exp : now + 3_600_000;
  return cachedToken;
}
