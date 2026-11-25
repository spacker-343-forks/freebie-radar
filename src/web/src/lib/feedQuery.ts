import { applyChannelQuery } from "../../../shared/channel-query.ts";
import { categoriesForPreset, isCategory, isContentKind, isObtainMode } from "../../../shared/taxonomy.ts";

export type FeedState = {
  preset: string;
  search: string;
  source: string;
  categories: string[];
  lang: "all" | "zh" | "en";
  sort: string;
  range: string;
  priceCap: string;
  minScore: string;
  obtain: string;
  kindFilter: string;
  unreadOnly: boolean;
};

export const DEFAULT_FEED_STATE: FeedState = {
  preset: "info", search: "", source: "", categories: [], lang: "all", sort: "newest",
  range: "auto", priceCap: "auto", minScore: "all", obtain: "auto", kindFilter: "auto", unreadOnly: false,
};
const PRESETS = new Set(["verified", "offline", "pan", "deal", "opensource", "news", "info", "codes", "urgent", "starred", "hidden", "review", "all"]);
const FIELDS = { preset: "preset", search: "q", source: "source", lang: "filterLang", sort: "sort", range: "range", priceCap: "price", minScore: "score", obtain: "obtain", kindFilter: "kind" } as const;
const DAYS: Record<string, number> = { "1d": 1, "3d": 3, "7d": 7, "30d": 30 };
const pick = (value: string | null, allowed: readonly string[], fallback: string) => value && allowed.includes(value) ? value : fallback;

/** Interface language (`lang`) is intentionally distinct from title language (`filterLang`). */
export function readFeedState(search: string): FeedState {
  const p = new URLSearchParams(search);
  const preset = pick(p.get("preset"), [...PRESETS], "info");
  const allowed = new Set(categoriesForPreset(preset));
  const kind = p.get("kind"), obtain = p.get("obtain");
  return {
    ...DEFAULT_FEED_STATE, preset,
    search: (p.get("q") ?? "").slice(0, 300), source: (p.get("source") ?? "").slice(0, 200),
    categories: [...new Set((p.get("category") ?? "").split(",").filter((v) => isCategory(v) && allowed.has(v)))],
    lang: pick(p.get("filterLang"), ["all", "zh", "en"], "all") as FeedState["lang"],
    sort: pick(p.get("sort"), ["newest", "score", "oldest", "expiring", "price_asc"], "newest"),
    range: pick(p.get("range"), ["auto", "all", "1d", "3d", "7d", "30d"], "auto"),
    priceCap: pick(p.get("price"), ["auto", "all", "free", "5", "10", "30", "100"], "auto"),
    minScore: pick(p.get("score"), ["all", "50", "60", "70"], "all"),
    obtain: obtain === "all" || isObtainMode(obtain) ? obtain : "auto",
    kindFilter: kind === "all" || isContentKind(kind) ? kind : "auto",
    unreadOnly: p.get("unread") === "1",
  };
}

/** Keep OAuth, interface-language and workspace parameters; own only feed fields. */
export function writeFeedSearch(search: string, state: FeedState): string {
  const p = new URLSearchParams(search);
  for (const [field, key] of Object.entries(FIELDS) as [keyof typeof FIELDS, string][]) {
    p.delete(key);
    const value = state[field];
    if (value !== DEFAULT_FEED_STATE[field]) p.set(key, value);
  }
  p.delete("category"); p.delete("unread");
  if (state.categories.length) p.set("category", state.categories.join(","));
  if (state.unreadOnly) p.set("unread", "1");
  const result = p.toString();
  return result ? "?" + result : "";
}

export function buildFeedQuery(state: FeedState, now = Date.now()): string {
  const q: Record<string, string | undefined> = { preset: state.preset, sort: state.sort, limit: "100" };
  if (state.search.trim()) q.search = state.search.trim();
  if (state.source) q.source = state.source;
  if (state.categories.length) q.category = state.categories.join(",");
  if (state.lang !== "all") q.lang = state.lang;
  if (state.kindFilter !== "auto") q.kind = state.kindFilter === "all" ? "" : state.kindFilter;
  if (state.obtain !== "auto") q.obtain = state.obtain === "all" ? "" : state.obtain;
  if (state.priceCap === "free") q.freeOnly = "1";
  else if (state.priceCap !== "auto" && state.priceCap !== "all") q.maxPrice = state.priceCap;
  if (state.minScore !== "all") q.minScore = state.minScore;
  if (state.unreadOnly) q.unread = "1";
  if (state.range !== "auto") q.maxAgeDays = state.range === "all" ? "all" : String(DAYS[state.range] ?? 14);
  const days = DAYS[state.range];
  if (days) q.since = new Date(now - days * 86_400_000).toISOString();
  return new URLSearchParams(Object.entries(applyChannelQuery(q)).filter((entry): entry is [string, string] => entry[1] !== undefined)).toString();
}

export function buildStatsQuery(query: string): string {
  const p = new URLSearchParams(query);
  for (const key of ["category", "sort", "limit"]) p.delete(key);
  return p.toString();
}

export function countAdditionalFilters(state: FeedState): number {
  return [state.source, state.categories.length, state.lang !== "all", state.search.trim(), state.minScore !== "all", state.unreadOnly, state.kindFilter !== "auto", state.priceCap !== "auto", state.obtain !== "auto", state.range !== "auto", state.sort !== "newest"].filter(Boolean).length;
}

/** Describe actual enforced constraints, not a blanket claim that AI keep means free. */
export function feedPolicyLabels(query: string): string[] {
  const p = new URLSearchParams(query), labels: string[] = [];
  if (p.get("aiOnly") === "1") labels.push("审核保留");
  else if (p.get("hideRejected") === "1") labels.push("隐藏审核拒绝");
  if (p.get("unexpired") === "1") labels.push("未过期");
  if (p.get("maxAgeDays") === "7") labels.push("近7天");
  if (p.get("obtain") === "free,conditional") labels.push("直接或有条件领取");
  return labels;
}
