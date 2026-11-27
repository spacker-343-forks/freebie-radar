export type TrackPlaybook = {
  name: string;
  mechanism: string;
  roiRange: string;
  targetPlayer: string;
};

export type TrackWhitepaper = {
  slug: string;
  title: string;
  emoji: string;
  tagline: string;
  itemCount: number;
  overview: string;
  playbooks: TrackPlaybook[];
  commonPitfalls: string[];
  actionChecklist: string[];
  topItemIds: number[];
  model: string;
  updatedAt: string;
};

export type TrackSummary = {
  slug: string;
  title: string;
  emoji: string;
  tagline: string;
  itemCount: number;
  playbookCount: number;
  model: string;
  updatedAt: string;
};

function cleanStr(v: unknown, maxLen: number): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, maxLen);
}

function cleanStrList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().slice(0, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function validateTrackWhitepaper(
  raw: unknown,
  fallbackMeta?: Partial<TrackWhitepaper>,
): TrackWhitepaper | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const slug = cleanStr(r.slug, 64) || cleanStr(fallbackMeta?.slug, 64);
  const title = cleanStr(r.title, 160) || cleanStr(fallbackMeta?.title, 160);
  const emoji = cleanStr(r.emoji, 12) || cleanStr(fallbackMeta?.emoji, 12) || "🧭";
  const tagline = cleanStr(r.tagline, 400) || cleanStr(fallbackMeta?.tagline, 400);
  const overview = cleanStr(r.overview, 4000);
  if (!slug || !title || !overview) return null;

  const playbooksRaw = Array.isArray(r.playbooks) ? r.playbooks : [];
  const playbooks: TrackPlaybook[] = [];
  for (const pb of playbooksRaw) {
    if (!pb || typeof pb !== "object" || Array.isArray(pb)) continue;
    const p = pb as Record<string, unknown>;
    const name = cleanStr(p.name, 160);
    const mechanism = cleanStr(p.mechanism, 1500);
    const roiRange = cleanStr(p.roiRange, 800) || "待测算";
    const targetPlayer = cleanStr(p.targetPlayer, 800) || "个人/小团队";
    if (name && mechanism) {
      playbooks.push({ name, mechanism, roiRange, targetPlayer });
    }
    if (playbooks.length >= 6) break;
  }
  if (!playbooks.length) return null;

  const commonPitfalls = cleanStrList(r.commonPitfalls, 8, 1000);
  const actionChecklist = cleanStrList(r.actionChecklist, 10, 1000);
  const topItemIds = Array.isArray(r.topItemIds)
    ? [...new Set(r.topItemIds.filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0))]
    : fallbackMeta?.topItemIds ?? [];

  const itemCount =
    typeof r.itemCount === "number" && Number.isFinite(r.itemCount) && r.itemCount >= 0
      ? Math.round(r.itemCount)
      : fallbackMeta?.itemCount ?? topItemIds.length;

  return {
    slug,
    title,
    emoji,
    tagline: tagline || title,
    itemCount,
    overview,
    playbooks,
    commonPitfalls,
    actionChecklist,
    topItemIds,
    model: cleanStr(r.model, 80) || fallbackMeta?.model || "",
    updatedAt: cleanStr(r.updatedAt, 40) || fallbackMeta?.updatedAt || new Date().toISOString(),
  };
}
