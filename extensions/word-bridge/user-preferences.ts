import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface UserPreference {
  key: string;
  value: unknown;
  confidence: number;
  source: "explicit" | "implicit";
  learnedAt: string;
  context?: string;
}

export interface UserPreferenceStore {
  userId: string;
  preferences: Record<string, UserPreference>;
  rejectedSuggestions: Array<{
    category: string;
    suggestion: string;
    rejectedAt: string;
    reason?: string;
  }>;
  acceptedSuggestions: Array<{
    category: string;
    suggestion: string;
    acceptedAt: string;
  }>;
  documentHistory: Array<{
    documentName: string;
    templateUsed: string | null;
    editedAt: string;
    formatChoices: Record<string, unknown>;
  }>;
}

const PREFS_FILE_PATH = path.join(__dirname, ".user-preferences.json");

let prefStore: UserPreferenceStore = {
  userId: "default",
  preferences: {},
  rejectedSuggestions: [],
  acceptedSuggestions: [],
  documentHistory: [],
};

export function loadPreferences(): UserPreferenceStore {
  try {
    if (fs.existsSync(PREFS_FILE_PATH)) {
      prefStore = JSON.parse(fs.readFileSync(PREFS_FILE_PATH, "utf-8")) as UserPreferenceStore;
    }
  } catch {
    /* keep defaults */
  }
  return prefStore;
}

export function savePreferences() {
  fs.writeFileSync(PREFS_FILE_PATH, JSON.stringify(prefStore, null, 2), "utf-8");
}

export function setExplicitPreference(key: string, value: unknown, context?: string) {
  prefStore.preferences[key] = {
    key,
    value,
    confidence: 1.0,
    source: "explicit",
    learnedAt: new Date().toISOString(),
    context,
  };
  savePreferences();
}

export function learnImplicitPreference(key: string, value: unknown, context?: string) {
  const existing = prefStore.preferences[key];
  if (existing) {
    if (existing.source === "explicit") {return;}
    if (JSON.stringify(existing.value) === JSON.stringify(value)) {
      existing.confidence = Math.min(1.0, existing.confidence + 0.15);
      existing.learnedAt = new Date().toISOString();
    } else {
      existing.confidence -= 0.1;
      if (existing.confidence < 0.3) {
        prefStore.preferences[key] = {
          key,
          value,
          confidence: 0.4,
          source: "implicit",
          learnedAt: new Date().toISOString(),
          context,
        };
      }
    }
    savePreferences();
    return;
  } else {
    prefStore.preferences[key] = {
      key,
      value,
      confidence: 0.4,
      source: "implicit",
      learnedAt: new Date().toISOString(),
      context,
    };
  }
  savePreferences();
}

export function recordAcceptedSuggestion(category: string, suggestion: string) {
  prefStore.acceptedSuggestions.push({
    category,
    suggestion,
    acceptedAt: new Date().toISOString(),
  });
  if (prefStore.acceptedSuggestions.length > 200) {
    prefStore.acceptedSuggestions = prefStore.acceptedSuggestions.slice(-200);
  }
  savePreferences();
}

export function recordRejectedSuggestion(category: string, suggestion: string, reason?: string) {
  prefStore.rejectedSuggestions.push({
    category,
    suggestion,
    rejectedAt: new Date().toISOString(),
    reason,
  });
  if (prefStore.rejectedSuggestions.length > 200) {
    prefStore.rejectedSuggestions = prefStore.rejectedSuggestions.slice(-200);
  }
  savePreferences();
}

export function recordDocumentEdit(
  documentName: string,
  templateUsed: string | null,
  formatChoices: Record<string, unknown>,
) {
  prefStore.documentHistory.push({
    documentName,
    templateUsed,
    editedAt: new Date().toISOString(),
    formatChoices,
  });
  if (prefStore.documentHistory.length > 50) {
    prefStore.documentHistory = prefStore.documentHistory.slice(-50);
  }
  savePreferences();
}

export function getPreference(key: string): { value: unknown; confidence: number; source: string } | null {
  const pref = prefStore.preferences[key];
  if (!pref || pref.confidence < 0.3) {return null;}
  return { value: pref.value, confidence: pref.confidence, source: pref.source };
}

export function getHighConfidencePreferences(minConfidence: number = 0.5): UserPreference[] {
  return Object.values(prefStore.preferences)
    .filter((p) => p.confidence >= minConfidence)
    .toSorted((a, b) => b.confidence - a.confidence);
}

export function wasSuggestionRejected(category: string): boolean {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const recentRejections = prefStore.rejectedSuggestions.filter(
    (r) => r.category === category && r.rejectedAt > thirtyDaysAgo,
  );
  return recentRejections.length >= 2;
}

/** 审计时可跳过的类别（近 30 天同类拒绝 ≥2 次） */
export function getSkippedAuditCategories(): string[] {
  const thirtyDaysAgo = Date.now() - 30 * 86400000;
  const counts: Record<string, number> = {};
  for (const r of prefStore.rejectedSuggestions) {
    if (new Date(r.rejectedAt).getTime() < thirtyDaysAgo) {continue;}
    counts[r.category] = (counts[r.category] || 0) + 1;
  }
  return Object.entries(counts)
    .filter(([, c]) => c >= 2)
    .map(([k]) => k);
}

export function getPreferenceSummary(): string {
  const prefs = getHighConfidencePreferences(0.5);
  if (prefs.length === 0) {return "暂无已学习的用户偏好。";}

  const lines = prefs.map((p) => {
    const src =
      p.source === "explicit"
        ? "(用户明确指定)"
        : `(隐式学习, 置信度${Math.round(p.confidence * 100)}%)`;
    return `- ${p.key}: ${JSON.stringify(p.value)} ${src}`;
  });

  return "已学习的用户偏好:\n" + lines.join("\n");
}
