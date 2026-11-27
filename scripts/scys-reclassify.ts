import { all, closeDb, get, migrate, run, tx } from "../src/server/db.ts";
import { classifyScys } from "../src/server/enrich/index.ts";
import { getAiSettings, saveAiSettings } from "../src/server/enrich/ai-settings.ts";
import { SCYS_CATEGORY_KEYS, type Category } from "../src/shared/taxonomy.ts";
import { SCYS_SYSTEM_PROMPT } from "./scys-preset.ts";

const LEGACY_REMAP_SOURCE_CATEGORIES = new Set<string>([
  "other",
  "stock",
  "tech",
  "news",
  "goods",
  "vps",
  "cloud",
  "domain",
  "carpool",
  "trade",
  "lottery",
  "offline",
  "invite",
  "game",
  "hardware",
  "security",
  "pan",
]);

const TITLE_NEW_TRACK_RE =
  /小红书|私域|抖音|视频号|短视频|直播|快手|剪映|切片|tiktok|出海|独立站|跨境|shopify|seo|adsense|闲鱼|电商|无货源|淘宝|拼多多|抖店|公众号|流量主|知乎|播客|副业|信息差|同城|生财日报|风向标(?:精选)?周报/i;

const SCYS_CATEGORY_SET = new Set<string>(SCYS_CATEGORY_KEYS);

export type ReclassifyScysResult = {
  dryRun: boolean;
  scanned: number;
  updated: number;
  skippedManual: number;
  clearedExpires: number;
  clearedCodes: number;
  promptUpdated: boolean;
  transitions: Array<{ id: number; sourceId: string; from: string | null; to: string; title: string }>;
};

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function updateAiCategoryJson(rawAi: string | null, nextCategory: Category): string | null {
  if (!rawAi) return rawAi;
  try {
    const parsed: unknown = JSON.parse(rawAi);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({ ...(parsed as Record<string, unknown>), category: nextCategory });
    }
  } catch {
    /* preserve malformed legacy JSON */
  }
  return rawAi;
}

function fallbackScysCategory(
  sourceId: string,
  oldCategory: string | null,
  title: string,
  summary: string,
): Category {
  const hay = `${title} ${summary}`;
  if (sourceId === "scys-projects" || /副业|信息差|变现|接单|同城|案例|项目/.test(hay)) {
    return "sidehustle";
  }
  if (oldCategory === "stock" || oldCategory === "finance" || /财报|营收|复盘|商业|认知|创业/.test(hay)) {
    return "finance";
  }
  return "other";
}

/**
 * 0 Token 本地清洗与重分类生财有术存量条目：
 * 1. 清除 scys-* 条目历史误判的 expires_at 与 codes；
 * 2. 若已配置 AI，则平滑刷新 systemPrompt 为最新 SCYS_SYSTEM_PROMPT（不覆盖网关与模型参数）；
 * 3. 对未人工锁定的 scys-* 条目按生财新商业赛道重映射，并同步更新 items.category 与 items.ai.category。
 */
export function reclassifyScysVault(opts: { dryRun?: boolean } = {}): ReclassifyScysResult {
  const dryRun = Boolean(opts.dryRun);

  const clearedExpires =
    get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE source_id LIKE 'scys-%' AND expires_at IS NOT NULL")?.n ?? 0;
  const clearedCodes =
    get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM items WHERE source_id LIKE 'scys-%' AND codes IS NOT NULL AND codes != '[]' AND codes != ''",
    )?.n ?? 0;

  const aiRow = get<{ value: string }>("SELECT value FROM settings WHERE key = 'ai'");
  const curAi = getAiSettings();
  const hasConfiguredAi = Boolean(aiRow || (curAi.baseUrl.trim() && (curAi.apiKey.trim() || curAi.enabled)));
  const promptUpdated = hasConfiguredAi && curAi.systemPrompt !== SCYS_SYSTEM_PROMPT;

  const skippedManual =
    get<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM items i
        WHERE i.source_id LIKE 'scys-%'
          AND EXISTS (SELECT 1 FROM item_classification_overrides o WHERE o.item_id = i.id)`,
    )?.n ?? 0;

  const rows = all<{
    id: number;
    source_id: string;
    title: string;
    summary: string | null;
    tags: string | null;
    category: string | null;
    ai: string | null;
  }>(
    `SELECT i.id, i.source_id, i.title, i.summary, i.tags, i.category, i.ai
       FROM items i
      WHERE i.source_id LIKE 'scys-%'
        AND NOT EXISTS (SELECT 1 FROM item_classification_overrides o WHERE o.item_id = i.id)
      ORDER BY i.id ASC`,
  );

  const updates: Array<{ id: number; sourceId: string; from: string | null; to: Category; title: string; nextAi: string | null }> = [];

  for (const r of rows) {
    const tags = parseTags(r.tags);
    const oldCat = r.category;
    const isDaily =
      /生财日报|风向标(?:精选)?周报|本周风向标/.test(r.title) ||
      tags.some((t) => t.includes("生财日报") || t.includes("风向标周报"));

    let nextCat: Category | null = null;
    if (isDaily) {
      nextCat = "daily";
    } else if (r.source_id === "scys-manuals") {
      nextCat = classifyScys({
        title: r.title,
        summary: r.summary ?? "",
        tags,
        sourceId: r.source_id,
      }).category;
    } else {
      const shouldRemap =
        !oldCat ||
        !SCYS_CATEGORY_SET.has(oldCat) ||
        LEGACY_REMAP_SOURCE_CATEGORIES.has(oldCat) ||
        TITLE_NEW_TRACK_RE.test(r.title);

      if (shouldRemap) {
        const guessed = classifyScys({
          title: r.title,
          summary: r.summary ?? "",
          tags,
          sourceId: r.source_id,
        }).category;
        if (guessed !== "other") {
          nextCat = guessed;
        } else if (!oldCat || !SCYS_CATEGORY_SET.has(oldCat)) {
          nextCat = fallbackScysCategory(r.source_id, oldCat, r.title, r.summary ?? "");
        } else {
          nextCat = oldCat as Category;
        }
      }
    }

    if (nextCat && nextCat !== oldCat) {
      updates.push({
        id: r.id,
        sourceId: r.source_id,
        from: oldCat,
        to: nextCat,
        title: r.title,
        nextAi: updateAiCategoryJson(r.ai, nextCat),
      });
    }
  }

  if (!dryRun) {
    tx(() => {
      if (clearedExpires > 0) {
        run("UPDATE items SET expires_at = NULL WHERE source_id LIKE 'scys-%' AND expires_at IS NOT NULL");
      }
      if (clearedCodes > 0) {
        run("UPDATE items SET codes = '[]' WHERE source_id LIKE 'scys-%' AND codes IS NOT NULL AND codes != '[]'");
      }
      for (const u of updates) {
        run("UPDATE items SET category = ?, ai = ? WHERE id = ?", u.to, u.nextAi, u.id);
      }
    });
    if (promptUpdated) {
      saveAiSettings({ systemPrompt: SCYS_SYSTEM_PROMPT });
    }
  }

  return {
    dryRun,
    scanned: rows.length,
    updated: updates.length,
    skippedManual,
    clearedExpires,
    clearedCodes,
    promptUpdated,
    transitions: updates.map(({ id, sourceId, from, to, title }) => ({ id, sourceId, from, to, title })),
  };
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("/scripts/scys-reclassify.ts");
if (isMain) {
  const dryRun = process.argv.includes("--dry-run");
  try {
    migrate();
    const res = reclassifyScysVault({ dryRun });
    console.log(
      `[scys-reclassify] ${res.dryRun ? "DRY-RUN" : "APPLIED"}: scanned=${res.scanned}, updated=${res.updated}, skippedManual=${res.skippedManual}, clearedExpires=${res.clearedExpires}, clearedCodes=${res.clearedCodes}, promptUpdated=${res.promptUpdated}`,
    );
    for (const t of res.transitions.slice(0, 30)) {
      console.log(`  #${t.id} [${t.sourceId}] ${t.from ?? "null"} -> ${t.to} | ${t.title.slice(0, 50)}`);
    }
  } finally {
    closeDb();
  }
}
