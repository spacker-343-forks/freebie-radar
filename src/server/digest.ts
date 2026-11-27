import { config } from "./config.ts";
import { all, get, run } from "./db.ts";
import { CATEGORY_LABEL, dedupeByTitle, KIND_LABEL, type ContentKind, type DedupeEntry } from "./enrich/index.ts";
import { aiReady, aiSummaryExcerpt, getAiSettings, postChatCompletions, resolveDeepModel } from "./enrich/ai-settings.ts";
import { hasValueSignal, isNoiseTitle } from "./enrich/noise.ts";
import { isBlocked, loadActiveBlockRules } from "./enrich/blocklist.ts";
import { getPushSettings, passesPushFilters, sourceLabel, type PushSettings } from "./push.ts";
import { sendTelegram } from "./telegram.ts";
import { buildHotReport } from "./hot.ts";
import {
  stripThresholdPrefix,
  validateDigestReport,
  type DigestPick,
  type DigestReport,
} from "../shared/digest.ts";
export { sendTelegram };
export type { DigestPick, DigestReport };
export type DigestItem = {
  id: number;
  source_id: string;
  title: string;
  url: string;
  category: string | null;
  kind?: string | null;
  score: number;
  expires_at: string | null;
  published_at: string | null;
  price?: number | null;
  is_free?: number;
  obtain?: string | null;
  ai?: string | null;
  codes?: string;
  urlKey?: string | null;
  ai_quality?: number | null;
  summary?: string | null;
  content?: string | null;
};

export type Digest = {
  date: string;
  items: DigestItem[];
  text: string;
};

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function recentDigestPushed(day: string): { ids: Set<number>; seeds: DedupeEntry[] } {
  const rows = all<{ item_ids: string }>(
    "SELECT item_ids FROM digests WHERE (kind IS NULL OR kind = 'daily') AND date >= ?",
    new Date(new Date(day).getTime() - 3 * 86_400_000).toISOString().slice(0, 10),
  );
  const ids = new Set<number>();
  for (const r of rows) {
    try {
      for (const id of JSON.parse(r.item_ids) as number[]) ids.add(id);
    } catch {
      /* 忽略损坏的历史记录 */
    }
  }
  if (!ids.size) return { ids, seeds: [] };
  const placeholders = [...ids].map(() => "?").join(",");
  const seeds = all<DedupeEntry>(
    `SELECT title, url_key AS urlKey FROM items WHERE id IN (${placeholders})`,
    ...ids,
  );
  return { ids, seeds };
}

/** 纯生财源且尚未自定义推送形态时，日报/周报自动放行全有效形态与非抽奖获取方式，防止新环境日报为空。 */
function digestFilterSettings(): PushSettings {
  const settings = getPushSettings();
  const isDefaultKinds = settings.kinds.length === 1 && settings.kinds[0] === "freebie";
  if (!isDefaultKinds) return settings;
  const enabledSources = all<{ id: string }>("SELECT id FROM sources WHERE enabled = 1");
  if (!enabledSources.length || !enabledSources.every((s) => s.id.startsWith("scys-"))) {
    return settings;
  }
  return {
    ...settings,
    kinds: ["info", "opensource", "freebie", "deal"],
    obtainModes: ["free", "conditional", "paid", "promo", "trial"],
  };
}

function filterDigestRows(
  rows: DigestItem[],
  pushedIds: Set<number>,
  rules: ReturnType<typeof loadActiveBlockRules>,
  settings: PushSettings,
  ignoreMaxAge = false,
): { kept: DigestItem[]; aiKeepMap: Map<number, boolean | null> } {
  const aiKeepMap = new Map<number, boolean | null>();
  const effectiveSettings = ignoreMaxAge ? { ...settings, maxAgeHours: 0 } : settings;
  const kept = rows.filter((r) => {
    if (pushedIds.has(r.id) || isBlocked(r, rules)) return false;
    let codes: string[] = [];
    try { codes = JSON.parse(r.codes ?? "[]") as string[]; } catch { codes = []; }
    let aiKeep: boolean | null = null;
    if (r.ai) {
      try { aiKeep = (JSON.parse(r.ai) as { keep?: boolean }).keep ?? null; } catch { aiKeep = null; }
    }
    aiKeepMap.set(r.id, aiKeep);
    if (settings.aiFallbackMode !== "ignore_ai" && (aiKeep === false || r.kind === "noise")) return false;
    if (!settings.applyToDigest) return true;
    return passesPushFilters({
      sourceId: r.source_id,
      title: r.title,
      score: r.score,
      codes,
      price: r.price ?? null,
      isFree: r.is_free === 1,
      aiKeep,
      kind: r.kind ?? null,
      category: r.category,
      obtain: r.obtain ?? null,
      publishedAt: r.published_at,
    }, effectiveSettings);
  });
  return { kept, aiKeepMap };
}

function selectDailyPool(date = new Date(), limit = config.dailyTopN): DigestItem[] {
  const lookback = new Date(date.getTime() - 3 * 86_400_000).toISOString();
  const now = new Date().toISOString();

  const rows = all<DigestItem>(
    `SELECT id, source_id, title, url, url_key AS urlKey, category, kind, score, expires_at, published_at,
            price, is_free, obtain, ai, codes, ai_quality, summary, content
       FROM items
      WHERE status = 'active'
        AND COALESCE(published_at, first_seen_at) >= ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY score DESC, COALESCE(published_at, first_seen_at) DESC
      LIMIT 400`,
    lookback,
    now,
  );

  const pushed = recentDigestPushed(dayKey(date));
  const rules = loadActiveBlockRules();
  const settings = digestFilterSettings();
  const { kept: fresh, aiKeepMap } = filterDigestRows(rows, pushed.ids, rules, settings, false);

  const hasSignal = (r: DigestItem) => aiKeepMap.get(r.id) === true || hasValueSignal(r.title, r.kind);
  const strictRaw = fresh.filter((r) => r.score >= MIN_DIGEST_SCORE && hasSignal(r) && !isNoiseTitle(r.title));
  const strict = dedupeByTitle(strictRaw, pushed.seeds);
  let primary = strict.slice(0, limit);
  if (primary.length < Math.min(6, limit)) {
    const relaxedRaw = fresh.filter((r) => hasSignal(r) && !isNoiseTitle(r.title) && r.score >= MIN_DIGEST_SCORE - 10);
    primary = dedupeByTitle(relaxedRaw, pushed.seeds).slice(0, limit);
  }
  if (primary.length >= limit) return primary;

  // 近期发布不足时，从近 3 天新采集入库（含历史回溯）且 ai_keep=1 的高质量帖按 ai_quality/score 补齐
  const primaryIds = new Set(primary.map((it) => it.id));
  const backfillRows = all<DigestItem>(
    `SELECT id, source_id, title, url, url_key AS urlKey, category, kind, score, expires_at, published_at,
            price, is_free, obtain, ai, codes, ai_quality, summary, content
       FROM items
      WHERE status = 'active'
        AND ai_keep = 1
        AND COALESCE(kind, 'freebie') != 'noise'
        AND first_seen_at >= ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY COALESCE(ai_quality, 0) DESC, score DESC, first_seen_at DESC
      LIMIT 200`,
    lookback,
    now,
  ).filter((r) => !primaryIds.has(r.id));

  const { kept: backfillKept } = filterDigestRows(backfillRows, pushed.ids, rules, settings, true);
  const backfillClean = dedupeByTitle(backfillKept, [...pushed.seeds, ...primary]);
  return [...primary, ...backfillClean].slice(0, limit);
}

export function pickDaily(date = new Date(), topN = config.dailyTopN): DigestItem[] {
  return selectDailyPool(date, topN);
}
const MIN_DIGEST_SCORE = 55;


function daysLeft(iso: string | null): string | null {
  if (!iso) return null;
  const d = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (Number.isNaN(d)) return null;
  if (d < 0) return "已过期";
  if (d === 0) return "今天截止";
  return d + " 天后截止";
}

export function formatDigest(items: DigestItem[], date = new Date()): string {
  const label = date.getMonth() + 1 + "月" + date.getDate() + "日";
  if (!items.length) return "🛰 资源雷达 · " + label + "\n\n今天没有新的可领资源，明天见。";
  const lines = ["🛰 资源雷达 · " + label + " 精选 " + items.length + " 条", ""];
  items.forEach((it, i) => {
    const cat = it.category ? (CATEGORY_LABEL[it.category as keyof typeof CATEGORY_LABEL] ?? it.category) : "其它";
    const kindTag = it.kind && it.kind !== "freebie" && it.kind !== "noise" ? KIND_LABEL[it.kind as ContentKind] : null;
    const exp = daysLeft(it.expires_at);
    const meta = [sourceLabel(it.source_id), kindTag, cat, exp].filter(Boolean).join(" · ");
    lines.push(i + 1 + ". " + it.title.slice(0, 100));
    lines.push("   " + meta);
    lines.push("   " + it.url);
    lines.push("");
  });
  lines.push("来源：资源雷达多源聚合");
  return lines.join("\n");
}


function extractAiReason(rawAi: string | null | undefined): string {
  if (!rawAi) return "";
  try {
    const parsed = JSON.parse(rawAi) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason.trim() : "";
  } catch {
    return "";
  }
}

function defaultSectionTitles(mode: "daily" | "weekly") {
  return mode === "daily"
    ? {
        introTitle: "🎯 今日核心风向",
        picksTitle: "🔥 必看实战拆解",
        closingTitle: "⚠️ 今日避坑提醒",
      }
    : {
        introTitle: "📈 本周赛道风向",
        picksTitle: "🏆 本周 Top 精选拆解",
        closingTitle: "💡 下周行动建议",
      };
}

export function formatReportAsPlainText(report: DigestReport): string {
  const lines: string[] = [];
  lines.push(report.introTitle);
  for (const pt of report.introPoints) lines.push(`- ${pt}`);
  lines.push("", report.picksTitle);
  report.picks.forEach((p, idx) => {
    lines.push(`${idx + 1}. ${p.title}`);
    if (p.summary) lines.push(`   ${p.summary}`);
    if (p.threshold) lines.push(`   [底牌门槛] ${p.threshold}`);
    if (p.url) lines.push(`   原文：${p.url}`);
    lines.push("");
  });
  if (report.closingPoints.length) {
    lines.push(report.closingTitle);
    for (const pt of report.closingPoints) lines.push(`- ${pt}`);
  }
  return lines.join("\n").trim();
}

function buildEditorSystemPrompt(mode: "daily" | "weekly", topN: number): string {
  const titles = defaultSectionTitles(mode);
  const closingInstruction =
    mode === "daily"
      ? "提炼 1~3 条门槛风险、隐性成本或需要警惕的伪需求"
      : "给出 1~3 条不同底牌读者的可执行下一步行动建议";

  return [
    "你是「生财有术私人商业情报主编」。",
    `请从候选条目中优中选优，挑选赛道互补、实操性最强的最多 ${topN} 条（不足 ${topN} 条则全选），并输出结构化 JSON 深度内参。`,
    "",
    "必须严格输出单个 JSON 对象（不要输出 Markdown 代码围栏或多余解释）：",
    JSON.stringify({
      selectedIds: [123, 456],
      report: {
        introTitle: titles.introTitle,
        introPoints: ["核心风向判断 1", "核心风向判断 2"],
        picksTitle: titles.picksTitle,
        picks: [
          {
            id: 123,
            title: "条目核心标题",
            summary: "2~3 句讲清核心打法、关键数据与可复现步骤（不含链接与门槛前缀）",
            threshold: "说明前置底牌门槛/所需资源或风险提示（不要包含 [底牌门槛] 前缀本身）",
          },
        ],
        closingTitle: titles.closingTitle,
        closingPoints: [closingInstruction],
      },
    }),
    "- `selectedIds` 必须是候选列表中的整数 `id` 数组（去重且按推荐优先级排序）。",
    "- `report.picks` 顺序需与 `selectedIds` 对齐，每条必须保留真实的 `id`。",
    "- `threshold` 只写具体门槛或前置条件（如「需编程能力与海外收款账号」「零代码可直接跟练」），不要带 `[底牌门槛]` 字样。",
    "- 严禁编造候选内容未提及的收益数字或链接。",
  ].join("\n");
}

async function synthesizeDigestWithAi(
  candidates: DigestItem[],
  mode: "daily" | "weekly",
  date: Date,
  topN: number,
  options: { fetchImpl?: typeof fetch; log?: (m: string) => void } = {},
): Promise<{ items: DigestItem[]; text: string; report: DigestReport | null }> {
  const fallbackItems = candidates.slice(0, topN);
  const fallbackText = mode === "daily" ? formatDigest(fallbackItems, date) : formatWeekly(fallbackItems, date);
  const s = getAiSettings();
  if (!candidates.length || !aiReady(s)) {
    return { items: fallbackItems, text: fallbackText, report: null };
  }

  const candidateById = new Map(candidates.map((it) => [it.id, it]));
  const payload = candidates.map((it) => ({
    id: it.id,
    title: it.title.slice(0, 140),
    url: it.url,
    kind: it.kind ?? "info",
    category: it.category ?? "other",
    obtain: it.obtain ?? "free",
    quality: it.ai_quality ?? null,
    aiReason: extractAiReason(it.ai),
    summaryExcerpt: aiSummaryExcerpt({ summary: it.summary, content: it.content }),
  }));

  const ac = new AbortController();
  const timeoutMs = Math.max(s.timeoutSec, 90) * 1000;
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const { res } = await postChatCompletions({
      baseUrl: s.baseUrl,
      apiKey: s.apiKey,
      model: resolveDeepModel(s),
      messages: [
        { role: "system", content: buildEditorSystemPrompt(mode, topN) },
        { role: "user", content: JSON.stringify(payload) },
      ],
      signal: ac.signal,
      fetchImpl: options.fetchImpl,
    });
    if (!res.ok) {
      throw new Error(`AI 主编 HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? "";
    const jsonText = /\{[\s\S]*\}/.exec(content)?.[0];
    if (!jsonText) throw new Error("AI 主编未返回 JSON 对象");
    const parsed = JSON.parse(jsonText) as {
      selectedIds?: unknown;
      report?: unknown;
      briefing?: unknown;
    };

    const titles = defaultSectionTitles(mode);
    const parsedReport = validateDigestReport(parsed.report);
    const pickedIds: number[] = [];
    const seen = new Set<number>();
    const pushValidId = (rawId: unknown) => {
      if (typeof rawId !== "number" || !Number.isInteger(rawId)) return;
      if (!candidateById.has(rawId) || seen.has(rawId) || pickedIds.length >= topN) return;
      seen.add(rawId);
      pickedIds.push(rawId);
    };

    if (Array.isArray(parsed.selectedIds)) {
      for (const rawId of parsed.selectedIds) pushValidId(rawId);
    }
    if (!pickedIds.length && parsedReport) {
      for (const p of parsedReport.picks) pushValidId(p.id);
    }

    if (parsedReport) {
      const normalizedPicks: DigestPick[] = [];
      for (const pick of parsedReport.picks) {
        const matched = pick.id !== undefined ? candidateById.get(pick.id) : undefined;
        if (pick.id !== undefined && !matched) continue;
        normalizedPicks.push({
          ...(matched ? { id: matched.id } : {}),
          title: pick.title || matched?.title || "",
          summary: pick.summary,
          threshold: stripThresholdPrefix(pick.threshold),
          ...(matched?.url ? { url: matched.url } : pick.url ? { url: pick.url } : {}),
        });
      }
      if (normalizedPicks.length) {
        for (const p of normalizedPicks) pushValidId(p.id);
        for (const c of candidates) {
          if (pickedIds.length >= Math.min(topN, candidates.length)) break;
          pushValidId(c.id);
        }
        const finalReport: DigestReport = {
          introTitle: parsedReport.introTitle || titles.introTitle,
          introPoints: parsedReport.introPoints,
          picksTitle: parsedReport.picksTitle || titles.picksTitle,
          picks: normalizedPicks,
          closingTitle: parsedReport.closingTitle || titles.closingTitle,
          closingPoints: parsedReport.closingPoints,
        };
        const selectedItems = pickedIds.map((id) => candidateById.get(id)!).filter(Boolean);
        return {
          items: selectedItems,
          text: formatReportAsPlainText(finalReport),
          report: finalReport,
        };
      }
    }

    if (typeof parsed.briefing === "string" && parsed.briefing.trim()) {
      for (const c of candidates) {
        if (pickedIds.length >= Math.min(topN, candidates.length)) break;
        pushValidId(c.id);
      }
      const selectedItems = pickedIds.map((id) => candidateById.get(id)!).filter(Boolean);
      return {
        items: selectedItems,
        text: parsed.briefing.trim(),
        report: null,
      };
    }

    throw new Error("AI 主编未返回有效 report 或 briefing");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    (options.log ?? console.warn)(`[${mode}] AI 主编合成失败，优雅回退默认格式: ${msg}`);
    return { items: fallbackItems, text: fallbackText, report: null };
  } finally {
    clearTimeout(timer);
  }
}

export type DailyResult = {
  date: string;
  count: number;
  text: string;
  report?: DigestReport | null;
  pushed: boolean;
  skippedReason?: string;
};

export async function runDaily(options: {
  dryRun?: boolean;
  date?: Date;
  log?: (m: string) => void;
  fetchImpl?: typeof fetch;
} = {}): Promise<DailyResult> {
  const log = options.log ?? ((m: string) => console.log(m));
  const date = options.date ?? new Date();
  const key = dayKey(date);
  const topN = config.dailyTopN;
  const candidates = selectDailyPool(date, Math.max(topN * 2, 20));
  const { items, text, report } = await synthesizeDigestWithAi(candidates, "daily", date, topN, {
    fetchImpl: options.fetchImpl,
    log,
  });

  if (options.dryRun) {
    log("[daily] dry-run " + key + " items=" + items.length);
    log(text);
    return { date: key, count: items.length, text, report, pushed: false, skippedReason: "dry-run" };
  }

  const payloadJson = JSON.stringify({ text, count: items.length, ...(report ? { report } : {}) });

  if (config.pushChannel === "none") {
    run(
      "INSERT INTO digests (date, item_ids, payload, created_at, pushed_at) VALUES (?, ?, ?, ?, NULL) ON CONFLICT(date) DO UPDATE SET item_ids = excluded.item_ids, payload = excluded.payload",
      key,
      JSON.stringify(items.map((i) => i.id)),
      payloadJson,
      new Date().toISOString(),
    );
    log("[daily] " + key + " 已生成 " + items.length + " 条（PUSH_CHANNEL=none，仅落库）");
    return { date: key, count: items.length, text, report, pushed: false, skippedReason: "push disabled" };
  }

  if (!config.telegramBotToken || !config.telegramChatId) {
    throw new Error("PUSH_CHANNEL=telegram 但缺少 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID");
  }

  await sendTelegram(text);
  run(
    "INSERT INTO digests (date, item_ids, payload, created_at, pushed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(date) DO UPDATE SET item_ids = excluded.item_ids, payload = excluded.payload, pushed_at = excluded.pushed_at",
    key,
    JSON.stringify(items.map((i) => i.id)),
    payloadJson,
    new Date().toISOString(),
    new Date().toISOString(),
  );
  log("[daily] " + key + " 已推送 " + items.length + " 条到 Telegram");
  return { date: key, count: items.length, text, report, pushed: true };
}

export function lastDigests(limit = 10) {
  const rows = all<{ date: string; item_ids: string; created_at: string; pushed_at: string | null; kind: string }>(
    "SELECT date, item_ids, created_at, pushed_at, kind FROM digests ORDER BY date DESC LIMIT ?",
    limit,
  );
  return rows.map((r) => {
    let count = 0;
    try {
      count = (JSON.parse(r.item_ids) as number[]).length;
    } catch {
      count = 0;
    }
    return { ...r, kind: r.kind ?? "daily", count };
  });
}

export function digestExists(day: string): boolean {
  return Boolean(get("SELECT date FROM digests WHERE date = ?", day));
}

/* ------------------------------------------------------------------ *
 * 周报：近 7 天「值得抢」的精选 + 热词 + 分类分布
 * ------------------------------------------------------------------ */

const WEEK_DAYS = 7;

function shortDate(iso: string): string {
  return iso.slice(5, 10).replace("-", "/");
}

/** 周报的存储键：`2026-11-03~11-09`，既能按字符串排序，也不会和日报的日期主键撞车 */
export function weekKey(date = new Date()): string {
  const end = new Date(date);
  const start = new Date(end.getTime() - (WEEK_DAYS - 1) * 86_400_000);
  return dayKey(start) + "~" + dayKey(end).slice(5);
}

function selectWeeklyPool(date = new Date(), limit = 20): DigestItem[] {
  const end = new Date(date);
  const start = new Date(end.getTime() - WEEK_DAYS * 86_400_000);
  const now = new Date().toISOString();
  const rows = all<DigestItem>(
    `SELECT id, source_id, title, url, url_key AS urlKey, category, kind, score, expires_at, published_at,
            price, is_free, obtain, ai, codes, ai_quality, summary, content
       FROM items
      WHERE status = 'active'
        AND ai_keep = 1
        AND kind != 'noise'
        AND COALESCE(published_at, first_seen_at) >= ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY COALESCE(ai_quality, 0) DESC, score DESC, COALESCE(published_at, first_seen_at) DESC
      LIMIT 600`,
    start.toISOString(),
    now,
  );
  const rules = loadActiveBlockRules();
  const settings = digestFilterSettings();
  const emptyPushed = new Set<number>();
  const { kept: usable } = filterDigestRows(rows, emptyPushed, rules, settings, false);
  // 同一福利被十几个源报道时只留一条，避免周报被喜加一刷屏
  const primary = dedupeByTitle(usable, []).slice(0, limit);
  if (primary.length >= limit) return primary;

  const primaryIds = new Set(primary.map((it) => it.id));
  const backfillRows = all<DigestItem>(
    `SELECT id, source_id, title, url, url_key AS urlKey, category, kind, score, expires_at, published_at,
            price, is_free, obtain, ai, codes, ai_quality, summary, content
       FROM items
      WHERE status = 'active'
        AND ai_keep = 1
        AND COALESCE(kind, 'freebie') != 'noise'
        AND first_seen_at >= ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY COALESCE(ai_quality, 0) DESC, score DESC, first_seen_at DESC
      LIMIT 300`,
    start.toISOString(),
    now,
  ).filter((r) => !primaryIds.has(r.id));
  const { kept: backfillKept } = filterDigestRows(backfillRows, emptyPushed, rules, settings, true);
  const backfillClean = dedupeByTitle(backfillKept, primary);
  return [...primary, ...backfillClean].slice(0, limit);
}

export function pickWeekly(date = new Date(), topN = 20): DigestItem[] {
  return selectWeeklyPool(date, topN);
}

export function formatWeekly(items: DigestItem[], date = new Date()): string {
  const end = new Date(date);
  const start = new Date(end.getTime() - (WEEK_DAYS - 1) * 86_400_000);
  const range = shortDate(dayKey(start)) + " ~ " + shortDate(dayKey(end));
  const head = "🛰 资源雷达 · 本周精选（" + range + "）";
  if (!items.length) return head + "\n\n这一周没有新的可领资源，下周见。";

  const hot = buildHotReport(WEEK_DAYS * 24).words.slice(0, 6).map((w) => w.w);
  const byCategory = new Map<string, number>();
  for (const it of items) {
    const key = it.category ? (CATEGORY_LABEL[it.category as keyof typeof CATEGORY_LABEL] ?? it.category) : "其它";
    byCategory.set(key, (byCategory.get(key) ?? 0) + 1);
  }
  const catLine = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, n]) => k + " " + n)
    .join(" · ");

  const lines = [head, "共 " + items.length + " 条 · 只收 AI 判为真福利且未过期的", ""];
  if (hot.length) lines.push("🔥 本周热词：" + hot.join(" · "));
  if (catLine) lines.push("📊 分类分布：" + catLine);
  lines.push("");

  items.forEach((it, i) => {
    const cat = it.category ? (CATEGORY_LABEL[it.category as keyof typeof CATEGORY_LABEL] ?? it.category) : "其它";
    const kindTag = it.kind && it.kind !== "freebie" && it.kind !== "noise" ? KIND_LABEL[it.kind as ContentKind] : null;
    const exp = daysLeft(it.expires_at);
    const meta = [sourceLabel(it.source_id), kindTag, cat, exp].filter(Boolean).join(" · ");
    lines.push(i + 1 + ". " + it.title.slice(0, 100));
    lines.push("   " + meta);
    lines.push("   " + it.url);
    lines.push("");
  });
  lines.push("来源：资源雷达多源聚合");
  return lines.join("\n");
}

export type WeeklyResult = {
  date: string;
  count: number;
  text: string;
  report?: DigestReport | null;
  pushed: boolean;
  skippedReason?: string;
};

export async function runWeekly(options: {
  dryRun?: boolean;
  date?: Date;
  log?: (m: string) => void;
  fetchImpl?: typeof fetch;
} = {}): Promise<WeeklyResult> {
  const log = options.log ?? ((m: string) => console.log(m));
  const date = options.date ?? new Date();
  const key = weekKey(date);
  const topN = 20;
  const candidates = selectWeeklyPool(date, Math.max(topN * 2, 20));
  const { items, text, report } = await synthesizeDigestWithAi(candidates, "weekly", date, topN, {
    fetchImpl: options.fetchImpl,
    log,
  });

  if (options.dryRun) {
    log("[weekly] dry-run " + key + " items=" + items.length);
    log(text);
    return { date: key, count: items.length, text, report, pushed: false, skippedReason: "dry-run" };
  }

  const payloadJson = JSON.stringify({
    text,
    count: items.length,
    range: key,
    ...(report ? { report } : {}),
  });

  const save = (pushedAt: string | null) =>
    run(
      `INSERT INTO digests (date, item_ids, payload, created_at, pushed_at, kind) VALUES (?, ?, ?, ?, ?, 'weekly')
       ON CONFLICT(date) DO UPDATE SET item_ids = excluded.item_ids, payload = excluded.payload,
         pushed_at = COALESCE(excluded.pushed_at, digests.pushed_at), kind = 'weekly'`,
      key,
      JSON.stringify(items.map((i) => i.id)),
      payloadJson,
      new Date().toISOString(),
      pushedAt,
    );

  if (config.pushChannel !== "telegram" || !config.telegramBotToken || !config.telegramChatId) {
    save(null);
    log("[weekly] " + key + " 已生成 " + items.length + " 条（推送未启用，仅落库）");
    return { date: key, count: items.length, text, report, pushed: false, skippedReason: "push disabled" };
  }

  await sendTelegram(text);
  save(new Date().toISOString());
  log("[weekly] " + key + " 已推送 " + items.length + " 条到 Telegram");
  return { date: key, count: items.length, text, report, pushed: true };
}
