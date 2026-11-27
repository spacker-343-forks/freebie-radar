import { all, get, run } from "./db.ts";
import { calibrateScoreByObtain } from "./enrich/alias.ts";
import { demoteEditorialGoods, demoteOfflineCategory, enforceFreebieEvidence, enrichItem, FREEBIE_ONLY_SOURCES, isCategory, resolveKind, type ContentKind } from "./enrich/index.ts";
import { guessObtain } from "./enrich/obtain.ts";
import { isBlocked, loadActiveBlockRules } from "./enrich/blocklist.ts";
import { extractPrice } from "./enrich/pricing.ts";
import { aiQueueStats } from "./enrich/ai-queue.ts";
import { getSourceHints, applyManualClassification, getManualClassification } from "./source-settings.ts";
import { categoryForSource } from "../shared/source-classification.ts";
import { isSharedResource } from "./enrich/evidence.ts";
import { finishAiJob, getAiTelemetry, recordAiBatch, startAiJob } from "./enrich/ai-telemetry.ts";
import { aiDedupDegradation, aiDedupStats, dedupeKeptItemsWithAi } from "./enrich/ai-dedup.ts";
import {
  aiReady,
  DEFAULT_PROMPT,
  feedbackStats,
  getAiSettings,
  publicAiSettings,
  reviewItems,
  saveAiSettings,
  testAiConnection,
  type AiSettings,
} from "./enrich/ai-settings.ts";

function updateAi(
  id: number,
  ai: string,
  keep: number,
  score: number,
  category: string | null,
  obtain: string | null,
  kind: string,
  quality: number | null,
  price: number | null,
  isFree: boolean,
): void {
  run(
    "UPDATE items SET ai = ?, ai_keep = ?, score = ?, category = ?, obtain = ?, kind = ?, ai_quality = COALESCE(?, ai_quality), ai_reviewed_at = ?, price = ?, is_free = ? WHERE id = ?",
    ai,
    keep,
    score,
    category,
    obtain,
    kind,
    quality,
    new Date().toISOString(),
    price,
    isFree ? 1 : 0,
    id,
  );
}

/** AI 判定统计：总体分布 + 分类分布 + 队列状态 + 执行遥测 + 最近样本。 */
export function aiStats() {
  const totals = get<{ kept: number; rejected: number }>(
    `SELECT
       SUM(CASE WHEN ai_keep = 1 THEN 1 ELSE 0 END) AS kept,
       SUM(CASE WHEN ai_keep = 0 THEN 1 ELSE 0 END) AS rejected
     FROM items WHERE status = 'active'`,
  );
  // 未送审计数要把全局屏蔽词跳过省额度的条目剥离出来，避免界面显示「N 条待审」但点补审却 0 条可执行
  const pendingRows = all<{ source_id: string; title: string; summary: string | null }>(
    "SELECT source_id, title, summary FROM items WHERE status = 'active' AND ai IS NULL",
  );
  const rules = loadActiveBlockRules();
  let pending = 0;
  let blockedSkipped = 0;
  for (const r of pendingRows) {
    if (isBlocked(r, rules)) blockedSkipped += 1;
    else pending += 1;
  }
  const byCategory = all<{ category: string; n: number }>(
    `SELECT COALESCE(category,'other') AS category, COUNT(*) AS n
     FROM items WHERE status = 'active' AND ai_keep = 1
     GROUP BY category ORDER BY n DESC`,
  );
  const byKind = all<{ kind: string; n: number }>(
    `SELECT COALESCE(kind,'freebie') AS kind, COUNT(*) AS n
     FROM items WHERE status = 'active'
     GROUP BY kind ORDER BY n DESC`,
  );
  const recent = all<{
    id: number;
    source_id: string;
    title: string;
    score: number;
    obtain: string | null;
    kind: string | null;
    ai: string;
    ai_reviewed_at: string | null;
    last_seen_at: string;
  }>(
    `SELECT id, source_id, title, score, obtain, kind, ai, ai_reviewed_at, last_seen_at FROM items
     WHERE ai IS NOT NULL ORDER BY COALESCE(ai_reviewed_at, last_seen_at) DESC, id DESC LIMIT 40`,
  );
  return {
    kept: totals?.kept ?? 0,
    rejected: totals?.rejected ?? 0,
    pending,
    blockedSkipped,
    queue: aiQueueStats(),
    telemetry: getAiTelemetry(),
    byCategory,
    byKind,
    dedup: { ...aiDedupStats(), degraded: aiDedupDegradation() },
    recent: recent.map((r) => {
      let v: { keep?: boolean; kind?: string; reason?: string; category?: string; obtain?: string; quality?: number } = {};
      try {
        v = JSON.parse(r.ai) as typeof v;
      } catch {
        v = {};
      }
      return {
        id: r.id,
        sourceId: r.source_id,
        title: r.title,
        score: r.score,
        keep: v.keep ?? null,
        kind: v.kind ?? r.kind ?? (v.keep === false ? "noise" : "freebie"),
        reason: v.reason ?? "",
        category: v.category ?? "",
        obtain: v.obtain ?? r.obtain ?? "free",
        quality: typeof v.quality === "number" ? v.quality : null,
        reviewedAt: r.ai_reviewed_at ?? r.last_seen_at,
      };
    }),
  };
}

export type BackfillMode = "pending" | "recent" | "rejected";

/**
 * 手动补审 / 重审：
 * - pending：仅审还没有 AI 结论的条目（默认）
 * - recent：用最新提示词/偏好重审近期入库条目（校准分类、获取方式与质量分）
 * - rejected：复核近期被 AI 拦截的非福利条目（防止误杀）
 */
export async function backfillAi(
  limit = 200,
  mode: BackfillMode = "pending",
): Promise<{ reviewed: number; rejected: number; skippedBlocked: number; scanned: number; mode: BackfillMode; error?: string }> {
  const s = getAiSettings();
  if (!aiReady(s)) return { reviewed: 0, rejected: 0, skippedBlocked: 0, scanned: 0, mode, error: "AI 未启用或未配置" };

  const safeLimit = Math.min(Math.max(Math.round(limit), 1), 2000);
  const scanLimit = Math.min(safeLimit * 4, 4000);
  const whereExtra =
    mode === "rejected"
      ? "AND ai_keep = 0"
      : mode === "recent"
        ? ""
        : "AND ai IS NULL";

  const rows = all<{
    id: number;
    source_id: string;
    external_id: string;
    title: string;
    summary: string | null;
    content: string | null;
    url: string;
    score: number;
    category: string | null;
    published_at: string | null;
    expires_at: string | null;
  }>(
    `SELECT id, source_id, external_id, title, summary, content, url, score, category, published_at, expires_at
     FROM items WHERE status = 'active' ${whereExtra}
     ORDER BY COALESCE(published_at, first_seen_at) DESC LIMIT ?`,
    scanLimit,
  );
  const blockRules = loadActiveBlockRules();
  const unblocked: typeof rows = [];
  let skippedBlocked = 0;
  for (const r of rows) {
    if (isBlocked(r, blockRules)) skippedBlocked += 1;
    else unblocked.push(r);
  }
  const activeRows = unblocked.slice(0, safeLimit);
  if (!activeRows.length) return { reviewed: 0, rejected: 0, skippedBlocked, scanned: rows.length, mode };

  const modeLabel = mode === "rejected" ? "复核已拦截" : mode === "recent" ? "重审近期" : "未审补审";
  const jobId = startAiJob({
    stage: "backfill",
    label: `历史库补审（${modeLabel}）`,
    model: s.model,
    total: activeRows.length,
    totalBatches: Math.ceil(activeRows.length / s.batchSize),
  });

  let reviewed = 0;
let rejected = 0;
  const keptIds: number[] = [];
  let lastError: string | undefined;
  const CHUNK = Math.max(s.batchSize * s.concurrency, 24);

  try {
    for (let start = 0; start < activeRows.length; start += CHUNK) {
      const chunk = activeRows.slice(start, start + CHUNK);

      const raws = chunk.map((r) => ({
        externalId: r.external_id,
        url: r.url,
        title: r.title,
        summary: r.summary ?? "",
        content: r.content ?? null,
      }));
      let map;
      try {
        map = await reviewItems(raws as never, { ...s, maxItems: chunk.length }, {
          onBatch: (ev) => {
            if (ev.error) lastError = ev.error;
            let bKept = 0;
            let bRejected = 0;
            const events = [];
            for (let i = 0; i < ev.items.length; i += 1) {
              const v = ev.verdicts?.get(ev.start + i);
              if (!v) continue;
              const keep = Boolean(v.keep);
              if (keep) bKept += 1;
              else bRejected += 1;
              events.push({
                title: ev.items[i]!.title,
                keep,
                kind: v.kind ?? (keep ? "freebie" : "noise"),
                category: v.category ?? "-",
                quality: typeof v.quality === "number" ? v.quality : null,
                reason: v.reason ?? "",
                at: new Date().toISOString(),
              });
            }
            recordAiBatch(jobId, {
              events,
              kept: bKept,
              rejected: bRejected,
              failed: ev.verdicts ? 0 : ev.count,
              ttfbMs: ev.ttfbMs,
            });
          },
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      }
      if (!map) continue;
      for (let i = 0; i < chunk.length; i += 1) {
        const row = chunk[i]!;
        const v = map.get(i);
        if (!v) continue;
        reviewed += 1;
if (!v.keep) rejected += 1;
        else keptIds.push(row.id);
        const obtain = v.obtain ?? guessObtain(row.title, row.summary ?? "");
        const priceInfo = extractPrice(row.title, row.summary);
        const hints = getSourceHints(row.source_id);
        // 重审时重算一次基础分再校准，避免多次叠加乘除失真
        const baseEnriched = enrichItem(
          {
            externalId: row.external_id,
            url: row.url,
            title: row.title,
            summary: row.summary ?? "",
            publishedAt: row.published_at,
            expiresAt: row.expires_at,
          },
          row.source_id,
          hints,
        );
        const baseScore = baseEnriched ? baseEnriched.score : row.score;
        const category = categoryForSource(row.source_id, !row.source_id.startsWith("scys-") && isSharedResource(row.title, row.summary ?? "", row.content ?? "", row.url) ? "pan" : isCategory(v.category) ? v.category : row.category, hints);
        const quality =
          typeof v.quality === "number" && Number.isFinite(v.quality)
            ? Math.min(5, Math.max(1, Math.round(v.quality)))
            : null;
        let kind = resolveKind(v.kind, v.keep, {
          title: row.title,
          summary: row.summary ?? "",
          sourceId: row.source_id,
          category,
          obtain,
          isFree: baseEnriched?.isFree ?? false,
          price: baseEnriched?.price ?? null,
          freebieOnlySource: FREEBIE_ONLY_SOURCES.has(row.source_id),
          kindHint: hints.kindHint,
          guardEnabled: hints.guardEnabled,
        });
        // 白嫖证据校验：抽奖 → lottery，明确标价 → deal
        const evidenced = enforceFreebieEvidence(kind, obtain, row.title, category, {
          summary: row.summary ?? "",
          price: baseEnriched?.price ?? null,
          isFree: baseEnriched?.isFree ?? false,
          codes: baseEnriched?.codes,
          sourceId: row.source_id,
        });
        kind = evidenced.kind;
        const finalObtain = evidenced.obtain === undefined ? obtain : evidenced.obtain;
        const categoryHint = evidenced.category ?? category;
        // 资讯/水帖不许落进实物福利
        let finalCategory = demoteEditorialGoods(
          demoteOfflineCategory(
            categoryHint,
            kind,
            row.title,
            row.summary ?? "",
            baseEnriched?.category ?? null,
          ),
          kind,
          { title: row.title, summary: row.summary ?? "", obtain: finalObtain, price: baseEnriched?.price ?? null },
        );
        finalCategory = categoryForSource(row.source_id, finalCategory, hints);
        const effectiveKeep = kind === "noise" ? false : v.keep;
        const keep = effectiveKeep ? 1 : 0;
        const ai = JSON.stringify({ ...v, keep: effectiveKeep, kind, category: finalCategory, obtain: finalObtain });
        ({ kind, category: finalCategory } = applyManualClassification(row.id, finalCategory, kind));
        const score = calibrateScoreByObtain(baseScore, finalObtain, effectiveKeep, quality, kind, {
          title: row.title,
          summary: row.summary ?? "",
          publishedAt: row.published_at,
          sourceId: row.source_id,
          codes: baseEnriched?.codes ?? [],
          price: baseEnriched?.price ?? null,
        });
        updateAi(row.id, ai, keep, score, finalCategory, finalObtain, kind, quality, priceInfo.price, priceInfo.isFree);
      }
    }
    finishAiJob(jobId, {
      skippedBlocked,
      error: reviewed === 0 ? lastError : undefined,
    });
  } catch (err) {
    finishAiJob(jobId, {
      skippedBlocked,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

// 补审/重审通过后顺带走一次 AI 语义去重聚类，避免历史库继续留着同活动多条
  if (keptIds.length && getAiSettings().aiDedupEnabled) {
    try {
      await dedupeKeptItemsWithAi(keptIds);
    } catch (err) {
      console.log("[ai] 补审后语义去重失败:", err instanceof Error ? err.message : String(err));
    }
  }

  return { reviewed, rejected, skippedBlocked, scanned: rows.length, mode };
}

/**
 * 零 Token 存量分类重整：用最新关键词规则重算 active 条目的 category（以及未 AI 审核条目的 kind / obtain）。
 * scope = "other"：仅挽救落入 other/null 的条目；scope = "all"：全量 active 按新规则刷新（已 AI 审核的只刷新 category=other 的漏网条目）。
 */
export function reclassifyStoredItems(scope: "other" | "all" = "other", options: { dryRun?: boolean; sourceId?: string; itemId?: number; forceAutomatic?: boolean } = {}): {
  scanned: number;
  updated: number;
  movedFromOther: number;
  scope: "other" | "all";
  dryRun: boolean;
  rerouted: number;
  samples: { id: number; title: string; sourceId: string; fromKind: string | null; toKind: string | null; fromCategory: string | null; toCategory: string | null }[];
} {
  const cond = scope === "other" ? "status = 'active' AND (category = 'other' OR category IS NULL)" : "status = 'active'";
  const rows = all<{
    id: number;
    source_id: string;
    external_id: string | null;
    url: string;
    title: string;
    summary: string | null;
    content: string | null;
    category: string | null;
    kind: string | null;
    obtain: string | null;
    ai_keep: number | null;
    published_at: string | null;
    expires_at: string | null;
    ai_quality: number | null;
    ai: string | null;
    score: number;
    base_score: number | null;
    price: number | null;
    is_free: number;
  }>(
    `SELECT id, source_id, external_id, url, title, summary, SUBSTR(content,1,12000) AS content, category, kind, obtain, ai_keep, ai_quality, ai, score, base_score, price, is_free, published_at, expires_at
       FROM items WHERE ${options.itemId ? "1=1" : cond}${options.sourceId ? " AND source_id = ?" : ""}${options.itemId ? " AND id = ?" : ""} ORDER BY id DESC LIMIT 6000`,
    ...(options.sourceId ? [options.sourceId] : []),
    ...(options.itemId ? [options.itemId] : []),
  );

  let updated = 0;
  let movedFromOther = 0;
  let rerouted = 0;
  const hintsBySource = new Map<string, ReturnType<typeof getSourceHints>>();
  const samples: { id: number; title: string; sourceId: string; fromKind: string | null; toKind: string | null; fromCategory: string | null; toCategory: string | null }[] = [];
  for (const r of rows) {
    let hints = hintsBySource.get(r.source_id);
    if (!hints) { hints = getSourceHints(r.source_id); hintsBySource.set(r.source_id, hints); }
    const e = enrichItem(
      {
        externalId: r.external_id ?? String(r.id),
        url: r.url,
        title: r.title,
        summary: r.summary ?? "",
        content: r.content,
        publishedAt: r.published_at,
        expiresAt: r.expires_at,
      },
      r.source_id,
      hints,
    );
    if (!e) continue;
    // AI 审核给出的分类优先：规则以前只用它算 kind，落库却存了关键词结果，导致 AI 判对的分类被丢掉
    let aiCategory: string | null = null;
    let aiKind: string | null = null;
    if (r.ai) {
      try {
        const parsed = JSON.parse(r.ai) as { category?: unknown; kind?: unknown };
        if (isCategory(parsed.category)) aiCategory = parsed.category;
        if (typeof parsed.kind === "string") aiKind = parsed.kind;
      } catch {
        aiCategory = null;
      }
    }
    // 已人工/AI 审核过的非 other 条目不随意覆盖其分类，只修复 other / 误判成 news 的 VPS 帖子 / 非权威源的 news
    const catWasLegacyNews = (r.category === "news" || r.category === "headline") && e.category === "vps";
    let nextCat: string | null =
      aiCategory ??
      (!options.forceAutomatic && r.ai_keep !== null && r.category && r.category !== "other" && !catWasLegacyNews ? r.category : e.category);
    nextCat = categoryForSource(r.source_id, !r.source_id.startsWith("scys-") && isSharedResource(r.title, r.summary ?? "", r.content ?? "", r.url) ? "pan" : nextCat, hints);
    let nextKind = options.forceAutomatic ? aiKind ?? e.kind : r.ai_keep === null ? e.kind : (r.kind ?? e.kind);
    {
      nextKind = resolveKind(nextKind, r.ai_keep === 1 ? true : r.ai_keep === 0 ? false : null, {
        title: r.title,
        summary: r.summary ?? "",
        sourceId: r.source_id,
        category: nextCat,
        obtain: r.obtain,
        isFree: e.isFree,
        price: e.price,
        kindHint: hints.kindHint,
        guardEnabled: hints.guardEnabled,
        freebieOnlySource: FREEBIE_ONLY_SOURCES.has(r.source_id),
      });
    }
    let nextObtain: string | null = r.ai_keep === null ? e.obtain : r.obtain ?? e.obtain;
    // 重整同样要过证据校验，否则抽奖/取消免费会被关键词重新洗成福利；
    // 资讯分类与无领取证据的价格文，点「修复」时也要能降级。
    {
      const evidenced = enforceFreebieEvidence(nextKind as import("../shared/taxonomy.ts").ContentKind, nextObtain, r.title, nextCat, {
        summary: r.summary ?? "",
        price: e.price,
        isFree: e.isFree,
        codes: e.codes,
        sourceId: r.source_id,
      });
      nextKind = evidenced.kind;
      const decidedObtain = evidenced.obtain;
      nextObtain = decidedObtain === undefined ? nextObtain : decidedObtain;
      nextCat = categoryForSource(r.source_id, evidenced.category ?? nextCat, hints);
    }
    // 资讯/水帖不许落进实物福利
    nextCat = demoteOfflineCategory(nextCat, nextKind, r.title, r.summary ?? "", e.category) as typeof nextCat;
    ({ category: nextCat, kind: nextKind } = applyManualClassification(r.id, nextCat, nextKind as import("../shared/taxonomy.ts").ContentKind));

// 顺手用新的多维加权口径重算分数（规则内容分存进 base_score，AI 质量分参与合成）
    const keepBool = r.ai_keep === null ? null : r.ai_keep === 1;
    const quality =
      typeof r.ai_quality === "number" && Number.isFinite(r.ai_quality)
        ? Math.min(5, Math.max(1, Math.round(r.ai_quality)))
        : null;
    const nextScore = calibrateScoreByObtain(e.baseScore, nextObtain, keepBool, quality, nextKind, {
      title: e.title,
      summary: e.summary ?? "",
      publishedAt: e.publishedAt ?? null,
      sourceId: r.source_id,
      codes: e.codes,
      price: e.price,
    });

    if (
      nextCat !== r.category ||
      nextKind !== r.kind ||
      nextObtain !== r.obtain ||
      nextScore !== r.score ||
      e.price !== r.price ||
      Number(e.isFree) !== r.is_free ||
      e.baseScore !== (r.base_score ?? null)
    ) {
      if (nextCat !== r.category || nextKind !== r.kind) {
        rerouted += 1;
        if (samples.length < 30) samples.push({ id: r.id, title: r.title, sourceId: r.source_id, fromKind: r.kind, toKind: nextKind, fromCategory: r.category, toCategory: nextCat });
      }
      let ai = r.ai;
      if (ai && !getManualClassification(r.id) && (nextCat !== r.category || nextKind !== r.kind || nextObtain !== r.obtain)) {
        try {
          const parsed: unknown = JSON.parse(ai);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ai = JSON.stringify({
            ...parsed, kind: nextKind, category: nextCat, obtain: nextObtain,
            classificationCorrection: { previousKind: r.kind, previousCategory: r.category, previousObtain: r.obtain, reason: "来源固定分类或内容证据校验", at: new Date().toISOString() },
          });
        } catch { /* preserve malformed legacy AI */ }
      }
      if (!options.dryRun) run(
        "UPDATE items SET category = ?, kind = ?, obtain = ?, base_score = ?, score = ?, ai = ?, price = ?, is_free = ? WHERE id = ?",
        nextCat,
        nextKind,
        nextObtain,
        e.baseScore,
        nextScore,
        ai,
        e.price,
        e.isFree ? 1 : 0,
        r.id,
      );
      updated += 1;
      if ((r.category === "other" || !r.category) && nextCat !== "other") {
        movedFromOther += 1;
      }
    }
  }
  return { scanned: rows.length, updated, movedFromOther, scope, dryRun: Boolean(options.dryRun), rerouted, samples };
}

export { publicAiSettings, saveAiSettings, testAiConnection, DEFAULT_PROMPT, aiReady, getAiSettings, feedbackStats };
export { aiDedupStats as aiDedupClusterStats, runAiDedupBackfill } from "./enrich/ai-dedup.ts";
export type { AiSettings };
