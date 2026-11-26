export type DigestPick = {
  id?: number;
  title: string;
  summary: string;
  threshold: string;
  url?: string;
};

export type DigestReport = {
  introTitle: string;
  introPoints: string[];
  picksTitle: string;
  picks: DigestPick[];
  closingTitle: string;
  closingPoints: string[];
};

/** 剥离大模型偶发输出的 `[底牌门槛]` / `【底牌门槛】` 前缀字样，保持字段纯净。 */
export function stripThresholdPrefix(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:\[|【)\s*底牌(?:门槛)?\s*(?:\]|】)\s*[:：\-—]?\s*/u, "")
    .replace(/^底牌(?:门槛)?\s*[:：\-—]\s*/u, "")
    .trim();
}

function normalizeStringList(raw: unknown, maxItems = 5): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

/** 校验并规范化结构化内参 JSON；不合法返回 null。 */
export function validateDigestReport(raw: unknown): DigestReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.picks) || !obj.picks.length) return null;

  const picks: DigestPick[] = [];
  for (const item of obj.picks) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const p = item as Record<string, unknown>;
    const title = typeof p.title === "string" ? p.title.trim() : "";
    const summary = typeof p.summary === "string" ? p.summary.trim() : "";
    const threshold = typeof p.threshold === "string" ? stripThresholdPrefix(p.threshold) : "";
    const id = typeof p.id === "number" && Number.isInteger(p.id) && p.id > 0 ? p.id : undefined;
    const url = typeof p.url === "string" && /^https?:\/\//i.test(p.url.trim()) ? p.url.trim() : undefined;
    if (!title && !summary && id === undefined) continue;
    picks.push({ ...(id !== undefined ? { id } : {}), title, summary, threshold, ...(url ? { url } : {}) });
  }
  if (!picks.length) return null;

  const introTitle = typeof obj.introTitle === "string" && obj.introTitle.trim() ? obj.introTitle.trim() : "🎯 今日核心风向";
  const picksTitle = typeof obj.picksTitle === "string" && obj.picksTitle.trim() ? obj.picksTitle.trim() : "🔥 必看实战拆解";
  const closingTitle = typeof obj.closingTitle === "string" && obj.closingTitle.trim() ? obj.closingTitle.trim() : "⚠️ 今日避坑提醒";

  return {
    introTitle,
    introPoints: normalizeStringList(obj.introPoints, 5),
    picksTitle,
    picks,
    closingTitle,
    closingPoints: normalizeStringList(obj.closingPoints, 5),
  };
}
