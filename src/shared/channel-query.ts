import { channelExcluded } from "./taxonomy.ts";

/** Shared by API, exports and RSS. Explicit selectors can narrow a channel, never evade its exclusions. */
export function applyChannelQuery(input: Record<string, string | undefined>): Record<string, string | undefined> {
  const q = { ...input };
  const defaults: Record<string, Record<string, string>> = {
    picks: { hideRejected: "1", excludeSource: "scys-manuals" },
    dossiers: { hideRejected: "1", hasDossier: "1" },
    manuals: { hideRejected: "1", source: "scys-manuals" },
    projects: { hideRejected: "1", projectCases: "1" },
    tools: { hideRejected: "1", toolsOnly: "1" },
    perks: { hideRejected: "1", kind: "freebie,deal" },
    top5: { aiOnly: "1", minQuality: "5" },
    verified: { unexpired: "1", aiOnly: "1", kind: "freebie", obtain: "free,conditional", maxAgeDays: "7" },
    // 网盘频道按分类收，形态只该是福利/好价/资讯；opensource 与 news 混进来时
    // 会出现「开源项目」标签挂在网盘频道里（2026-11-24 修过一批），news 同理。
    pan: { unexpired: "1", hideRejected: "1", category: "pan,course", kind: "freebie,deal,info" },
    offline: { unexpired: "1", hideRejected: "1", category: "offline" },
    deal: { unexpired: "1", hideRejected: "1", kind: "deal" },
    opensource: { hideRejected: "1", kind: "opensource" },
    news: { hideRejected: "1", kind: "news" },
    info: { hideRejected: "1", kind: "info" },
    codes: { unexpired: "1", hasCodes: "1" },
    urgent: { expiring: "1" },
    starred: { starred: "1" },
    hidden: { status: "ignored" },
    // 待复核：AI 说是福利但没有任何可领取证据的条目，公开站按 status='active' 自动隐藏
    review: { status: "review" },
    all: { hideRejected: "1" },
  };
  for (const [key, value] of Object.entries(defaults[q.preset ?? ""] ?? {})) {
    if (q[key] === undefined) q[key] = value;
  }
  const excluded = [...new Set([...channelExcluded(q.preset ?? ""), ...(q.excludeCategory ?? "").split(",").filter(Boolean)])];
  if (excluded.length) q.excludeCategory = excluded.join(",");
  return q;
}
