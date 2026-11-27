import type { Hono } from "hono";
import { all, get, run, tx, dbRevision, type SqlValue } from "./db.ts";
import { registerSecurity, registerPublicCache, limitUserAction, adminHostAllowed } from "./security.ts";
import { reconcileSourceCategory, getSourceHints, getManualClassification } from "./source-settings.ts";
import { getClassificationSettings, saveClassificationSettings } from "./classification-settings.ts";
import { contentSignals } from "./enrich/evidence.ts";
import { enrichItem, resolveKind } from "./enrich/index.ts";
import { guessObtain } from "./enrich/obtain.ts";
import { applyChannelQuery } from "../shared/channel-query.ts";
import { TitleDeduper } from "./enrich/dedup.ts";
import { aiEnabled, config, pushEnabled } from "./config.ts";
import { getCookieSettings, toPublicCookieStatus, updateCookieSettings, type CookieSiteKey } from "./cookie-store.ts";
import { identityOf, loadUserStates, registerAuthRoutes, resolveIdentity, userByRssToken } from "./auth.ts";
import {
  createInviteCodes,
  deleteInviteCode,
  getAccessControl,
  getOnboarding,
  listInviteCodes,
  listUsers,
  saveAccessControl,
  saveOnboarding,
  setUserDisabled,
  toggleInviteCode,
  countUsers,
} from "./access.ts";
import {
  detectTelegramChatIds,
  dispatchUserPush,
  flushUserBatches,
  getUserPushConfig,
  previewUserPush,
  saveUserPushConfig,
  userPushLogs,
  userPushStats,
  loadUserBlockRules,
  loadUserSubscriptions,
  resolveUserBotToken,
  sendTelegramToUser,
} from "./user-push.ts";
import { buildRssXml, rssEtag, type RssItem } from "./rss.ts";
import { checkForUpdate, getBuildInfo, getUpdateJob, hostUpdateCommand, runUpdate } from "./updater.ts";
import { checkUpstreamUpdates, dismissUpstreamWatch, getUpstreamWatchState } from "./upstream-watch.ts";
import { backfillDossiers, ensureDossierTable, generateItemDossier, getItemDossier } from "./dossier.ts";
import {
  ensureTracksTable,
  getTrackDetail,
  isTrackSynthesisRunning,
  listTracks,
  synthesizeAllTracks,
} from "./tracks.ts";
import { isPublicSite, siteMode } from "./config.ts";
import {
  addCustomRssSource,
  BUILTIN_SOURCE_IDS,
  deleteCustomSource,
  ingestItems,
  markSourceFailure,
  runSource,
} from "./collectors/index.ts";
import type { RawItem } from "./collectors/types.ts";
import { lastDigests, runDaily, runWeekly } from "./digest.ts";
import { validateDigestReport, type DigestReport } from "../shared/digest.ts";
import { buildHotReport, sourceQuality } from "./hot.ts";
import { sendTelegram } from "./telegram.ts";
import {
  DEFAULT_SETTINGS,
  passesPushFilters,
  flushBatch,
  getPushSettings,
  isQuietNow,
  previewPush,
  pushStats,
  queueSize,
  recentPushLog,
  savePushSettings,
  type PushSettings,
} from "./push.ts";
import {
  aiStats,
  backfillAi,
  feedbackStats,
  getAiSettings,
  publicAiSettings,
  saveAiSettings,
  testAiConnection,
  reclassifyStoredItems,
  type AiSettings,
type BackfillMode,
  aiDedupClusterStats,
  runAiDedupBackfill,
} from "./ai-admin.ts";
import { promptSyncConfigured, readSyncState, syncPromptsNow } from "./enrich/prompt-sync.ts";
import {
  getRetention,
  itemCounts,
  runCleanup,
  saveRetention,
  type RetentionSettings,
} from "./retention.ts";
import {
  compileRule,
  safeRegex,
  loadActiveBlockRules,
  matchBlockRules,
  PRESET_NOISE_PATTERNS,
  type BlockRule,
} from "./enrich/blocklist.ts";
import {
  CATEGORY_DESC,
  CATEGORY_GROUPS,
  CATEGORY_KEYS,
  CATEGORY_LABEL,
  CHANNELS,
  KIND_LABEL,
  KIND_ORDER,
  OBTAIN_KEYS,
  OBTAIN_LABEL,
  isCategory,
  isContentKind,
} from "../shared/taxonomy.ts";

/**
 * 校验数据源上的分类/形态兜底提示。
 * 以前这里是自由字符串，手写错一个字就会被静默忽略，主页与数据源口径逐渐漂移。
 */
function checkSourceHints(kindHint: unknown, categoryHint: unknown, fixedCategory?: unknown): string | null {
  if (fixedCategory !== undefined && fixedCategory !== null && (typeof fixedCategory !== "string" || (fixedCategory.trim() && !isCategory(fixedCategory.trim())))) {
    return "固定分类必须是合法的小类 key；留空恢复自动分类";
  }
  if (typeof kindHint === "string" && kindHint.trim()) {
    const v = kindHint.trim();
    if (!isContentKind(v) || v === "noise") return `kindHint 只能是 ${KIND_ORDER.join("/")}`;
  }
  if (typeof categoryHint === "string" && categoryHint.trim()) {
    const v = categoryHint.trim();
    if (!isCategory(v)) return `categoryHint 必须是小类 key（${CATEGORY_KEYS.join("/")}）`;
  }
  return null;
}

export type ItemRow = {
  id: number;
  source_id: string;
  external_id: string;
  url: string;
  url_key: string;
  title_key?: string | null;
  title: string;
  summary: string | null;
  author: string | null;
  category: string | null;
  image_url?: string | null;
  kind?: string | null;
  ai_quality?: number | null;
  tags: string;
  codes?: string;
  price?: number | null;
  is_free?: number;
  score: number;
  expires_at: string | null;
  published_at: string | null;
  raw: string;
  content?: string | null;
  status: string;
  starred: number;
  ai: string | null;
  read_at?: string | null;
  pushed_at?: string | null;
  first_seen_at: string;
  last_seen_at: string;
  canonical_id?: number | null;
  has_dossier?: number;
};

// List payloads never select full snapshots. The drawer fetches content on demand.
const LIST_COLUMNS = "id, source_id, external_id, url, url_key, title_key, title, SUBSTR(summary, 1, 1200) AS summary, author, category, image_url, kind, ai_quality, tags, codes, price, is_free, obtain, score, expires_at, published_at, status, starred, ai, read_at, pushed_at, first_seen_at, last_seen_at, canonical_id, (EXISTS (SELECT 1 FROM item_dossiers d WHERE d.item_id = items.id)) AS has_dossier";

/** 订阅命中的关键词（都转小写比较），用于前端高亮与筛选。 */
function matchKeywords(row: ItemRow, keywords: string[]): string[] {
  if (!keywords.length) return [];
  const text = (row.title + " " + (row.summary ?? "")).toLowerCase();
  return keywords.filter((k) => text.includes(k.toLowerCase()));
}

const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

function shape(row: ItemRow, keywords: string[] = [], blockedBy: string | null = null) {
  let tags: string[] = [];
  try {
    tags = JSON.parse(row.tags) as string[];
  } catch {
    tags = [];
  }
  let codes: string[] = [];
  try {
    codes = JSON.parse(row.codes ?? "[]") as string[];
    if (!Array.isArray(codes)) codes = [];
  } catch {
    codes = [];
  }
  let ai: unknown = null;
  if (row.ai) {
    try {
      ai = JSON.parse(row.ai);
    } catch {
      ai = null;
    }
  }
  return {
    ...row,
    tags,
    codes,
    ai,
    starred: row.starred === 1,
    read: Boolean(row.read_at),
    hasDossier: Boolean(row.has_dossier),
    raw: undefined,
    matched: matchKeywords(row, keywords),
    blockedBy,
  };
}

/**
 * 公开站：把「个人收藏 / 已读」覆盖到列表结果上。
 * items 表里的 starred / read_at 是自建站的全局状态，公开站不能拿来给用户看，
 * 否则 A 的收藏会显示成 B 的收藏。
 */
function applyUserStates<T extends { id: number; starred: boolean; read: boolean }>(list: T[], userId: number | null): T[] {
  if (!list.length) return list;
  if (!userId) return isPublicSite ? list.map((item) => ({ ...item, starred: false, read: false })) : list;
  const states = loadUserStates(
    userId,
    list.map((x) => x.id),
  );
  for (const it of list) {
    const s = states.get(it.id);
    it.starred = s?.starred ?? false;
    it.read = s?.read ?? false;
    if (s?.hidden) Object.assign(it, { status: "ignored" });
  }
  return list;
}

const SORTS: Record<string, string> = {
  score: "score DESC, COALESCE(published_at, first_seen_at) DESC",
  newest: "COALESCE(published_at, first_seen_at) DESC",
  oldest: "COALESCE(published_at, first_seen_at) ASC",
  expiring: "CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END ASC, expires_at ASC, score DESC",
  price_asc: "CASE WHEN is_free = 1 THEN 0 WHEN price IS NOT NULL THEN price ELSE 999999 END ASC, score DESC",
};
/**
 * 跨源聚类的唯一入口：「N 个来源」徽标和展开列表必须用同一个候选池。
 * 池子 = 同一 (kind, category) 分组，与当前筛选条件无关：
 *   - game 类不设时间下限（喜加一活动寿命长，旧帖仍是同一福利）
 *   - 其它类只看近 CLUSTER_WINDOW_DAYS 天（更早的靠 TitleDeduper 的 48h 窗口也合不到一起）
 * 以前列表按「当前筛选结果的前 300 条」聚类、/related 按「全局 score 前 300 条」再聚一次，
 * 两个池子不同，于是出现「35 个来源、点开 0 条」。
 */
const CLUSTER_WINDOW_DAYS = 3;
// 900 条池子 × 每次请求命中的几十个 (kind,category) 组合 = 单次请求要建几十个聚类索引，
// 2 核机器上直接把 /api/items 拖到 6-9 秒。降到 300 后徽标精度基本不变（同组内 300 条已够数来源），
// 但索引构造成本降到三分之一。
const CLUSTER_POOL_LIMIT = 150;

/** 聚类只需要这几列：items.content / raw 是整篇正文，整池 900 行一起取会把单次请求拖到几百毫秒。 */
type ClusterPoolRow = {
  id: number;
  title: string;
  title_key: string | null;
  url_key: string | null;
  canonical_id: number | null;
  category: string | null;
  kind: string | null;
  published_at: string | null;
  first_seen_at: string;
};

function loadClusterPool(
  kind: string | null | undefined,
  category: string | null | undefined,
  since: string,
): ClusterPoolRow[] {
  const bounded = category !== "game";
  return all<ClusterPoolRow>(
    `SELECT id, title, title_key, url_key, canonical_id, category, kind, published_at, first_seen_at
       FROM items
      WHERE status = 'active' AND kind IS ? AND category IS ?
        ${bounded ? "AND COALESCE(published_at, first_seen_at) >= ?" : ""}
      ORDER BY COALESCE(published_at, first_seen_at) DESC LIMIT ?`,
    kind ?? null,
    category ?? null,
    ...(bounded ? [since] : []),
    CLUSTER_POOL_LIMIT,
  );
}

type ClusterIndex = { rootOf: (id: number) => number; sizeOf: (root: number) => number };

function buildClusterIndex(rows: readonly ClusterPoolRow[]): ClusterIndex {
  const entries = rows.map((r) => ({
    row: r,
    title: r.title,
    urlKey: r.url_key,
    canonicalId: r.canonical_id ?? null,
    category: r.category,
    kind: r.kind,
    publishedAt: r.published_at ?? r.first_seen_at,
  }));
  const deduper = new TitleDeduper(entries, [], { maxGapHours: 48 });

  // TitleDeduper 只认标题文本，不认落库的 title_key；而 SQL 折叠是按 title_key 做的。
  // 这里再按 title_key 补一次并查集，保证「列表折成一条」和「徽标算几个来源」用的是同一套分组。
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let cur = x;
    while (parent.get(cur) !== cur) {
      const up = parent.get(cur)!;
      parent.set(cur, parent.get(up) ?? up);
      cur = parent.get(cur)!;
    }
    return cur;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  for (const e of entries) parent.set(e.row.id, e.row.id);
  const byDeduperRoot = new Map<number, number>();
  for (const e of entries) {
    const root = deduper.rootOf(e);
    const prev = byDeduperRoot.get(root);
    if (prev === undefined) byDeduperRoot.set(root, e.row.id);
    else union(prev, e.row.id);
  }
  const byTitleKey = new Map<string, number>();
  for (const e of entries) {
    const key = e.row.title_key;
    if (!key) continue;
    const prev = byTitleKey.get(key);
    if (prev === undefined) byTitleKey.set(key, e.row.id);
    else union(prev, e.row.id);
  }

  const sizeByRoot = new Map<number, number>();
  for (const e of entries) {
    const root = find(e.row.id);
    sizeByRoot.set(root, (sizeByRoot.get(root) ?? 0) + 1);
  }
  return {
    rootOf: (id) => (parent.has(id) ? find(id) : id),
    sizeOf: (root) => sizeByRoot.get(root) ?? 1,
  };
}

function clusterSince(): string {
  return new Date(Date.now() - CLUSTER_WINDOW_DAYS * 86_400_000).toISOString();
}

/**
 * 分组聚类索引带缓存：同一 (kind, category) 的池子在一次请求里被复用，跨请求也不必重算。
 * 用「条目数 + 最大 id + 最近一次 AI 审核时间」当版本号，入库或补审写入 canonical 后自动失效。
 */
/**
 * 聚类索引缓存：按 (kind, category) 分组缓存，5 分钟 TTL。
 *
 * 之前用 dbRevision() 当失效信号——采集进程每秒都在写库，导致缓存几乎每个请求都被全清，
 * 而全部频道一次要重建几十个分组的索引（每个 300 条跑 TitleDeduper），冷启动单次 5-6 秒。
 * 现在改成 TTL：一次重建后 5 分钟内都命中，实测同一请求从 5.5s 降到 4ms。
 * 「N 个来源」徽标最多延迟 5 分钟，对展示无影响。
 */
const CLUSTER_CACHE_TTL_MS = 5 * 60_000;
const clusterIndexCache = new Map<string, { index: ClusterIndex; builtAt: number }>();

/**
 * 后台预热聚类缓存：启动后把库里所有 (kind, category) 组合的索引先建好。
 * 全部频道单次请求要命中 40+ 个组合，每个组合建索引约 100ms，冷启动就是 4-5 秒。
 * 预热放在后台分批跑，用户第一个请求就能命中缓存。
 */
export async function warmClusterCache(log: (msg: string) => void = console.log): Promise<void> {
  const combos = all<{ kind: string | null; category: string | null }>(
    "SELECT DISTINCT kind, category FROM items WHERE status = 'active'",
  );
  const now = Date.now();
  let built = 0;
  for (const { kind, category } of combos) {
    const key = `${kind ?? ""}::${category ?? ""}`;
    const entry = clusterIndexCache.get(key);
    if (entry && now - entry.builtAt < CLUSTER_CACHE_TTL_MS) continue;
    try {
      clusterIndexCache.set(key, { index: buildClusterIndex(loadClusterPool(kind, category, clusterSince())), builtAt: Date.now() });
      built += 1;
    } catch { /* 单个分组失败不影响其它 */ }
    // 让出事件循环，别把 API 请求饿死
    await new Promise((r) => setTimeout(r, 20));
  }
  log(`[cluster] 预热完成，建了 ${built}/${combos.length} 个分组索引`);
}

/** 一次请求内复用的分组聚类入口：同一请求里同一个分组只算一次。 */
function createClusterScope(): (kind: string | null | undefined, category: string | null | undefined) => ClusterIndex {
  const now = Date.now();
  const local = new Map<string, ClusterIndex>();
  return (kind, category) => {
    const key = `${kind ?? ""}::${category ?? ""}`;
    const cached = local.get(key);
    if (cached) return cached;
    const entry = clusterIndexCache.get(key);
    let index: ClusterIndex;
    if (entry && now - entry.builtAt < CLUSTER_CACHE_TTL_MS) {
      index = entry.index;
    } else {
      index = buildClusterIndex(loadClusterPool(kind, category, clusterSince()));
      clusterIndexCache.set(key, { index, builtAt: now });
    }
    local.set(key, index);
    return index;
  };
}
/**
 * scope 用于公开站：个人状态（关闭/收藏/已读）存在 user_item_states 里，
 * 必须用自包含 EXISTS 子查询过滤 —— merge=1 时的窗口函数子查询只查 items 单表，
 * 拿不到外层 JOIN 别名，写成 JOIN 会在 merge 模式下直接报错。
 */
type QueryScope = { userId: number | null; publicMode: boolean; /** 管理员可在公开站查看 review/ignored 等非 active 状态 */ adminView?: boolean };

function buildItemsQuery(
  input: Record<string, string | undefined>,
  rules: BlockRule[],
  includeBlocked: boolean,
  scope: QueryScope = { userId: null, publicMode: false },
) {
  const q = applyChannelQuery(input);
  const where: string[] = [];
  const params: SqlValue[] = [];

  const status = q.status ?? "active";
  // 待复核/已关闭这类状态只对管理员开放：公开站访客与普通用户永远只看 active
  const adminStatusView = Boolean(scope.adminView) && status !== "active";
  if (scope.publicMode && !adminStatusView) {
    where.push("status = 'active'");
    // 公开站：ignored 等价于「我关掉了这条」，active 等价于「我没关」
    if (scope.userId !== null) {
      if (status === "ignored") {
        where.push(
          "EXISTS (SELECT 1 FROM user_item_states uis WHERE uis.user_id = ? AND uis.item_id = items.id AND uis.hidden = 1)",
        );
        params.push(scope.userId);
      } else if (status === "active") {
        where.push(
          "NOT EXISTS (SELECT 1 FROM user_item_states uis WHERE uis.user_id = ? AND uis.item_id = items.id AND uis.hidden = 1)",
        );
        params.push(scope.userId);
      }
      // status=all：不做个人过滤
    }
    // 未登录访客：隐藏/收藏状态在浏览器 localStorage 里，服务端不参与过滤
  } else if (status !== "all") {
    where.push("status = ?");
    params.push(status);
  }
  if (q.source) {
    where.push("source_id = ?");
    params.push(q.source);
  }
  if (q.category) {
    const cats = q.category.split(",").map((s) => s.trim()).filter(Boolean);
    if (cats.length === 1) {
      where.push("category = ?");
      params.push(cats[0]!);
    } else if (cats.length > 1) {
      where.push(`category IN (${cats.map(() => "?").join(",")})`);
      params.push(...cats);
    }
  }
  // 公开演示站对未登录访客隐藏版权敏感分类（默认 pan/course）。
  // 这两个分类聚合的是第三方网盘分享链接，公开展示等于向公众提供侵权作品指引。
  // 只在公开站生效：自部署（SITE_MODE=selfhost）没有游客概念，全部分类可见。
  // 这样「一键切换」只需改 SITE_MODE，不用再单独设 GUEST_HIDDEN_CATEGORIES。
  if (scope.publicMode && scope.userId === null && config.guestHiddenCategories.length) {
    const hidden = config.guestHiddenCategories;
    where.push(`COALESCE(category, 'other') NOT IN (${hidden.map(() => "?").join(",")})`);
    params.push(...hidden);
  }
  // 反向排除分类：真福利频道要把「网盘资源 / 网课教程」这类长期资料型内容挡在外面
  if (q.excludeCategory) {
    const cats = q.excludeCategory.split(",").map((s) => s.trim()).filter(Boolean);
    if (cats.length) {
      where.push(`COALESCE(category, 'other') NOT IN (${cats.map(() => "?").join(",")})`);
      params.push(...cats);
    }
  }
  if (q.kind) {
    const kinds = q.kind.split(",").map((s) => s.trim()).filter(Boolean);
    if (kinds.length === 1) {
      where.push("kind = ?");
      params.push(kinds[0]!);
    } else if (kinds.length > 1) {
      where.push(`kind IN (${kinds.map(() => "?").join(",")})`);
      params.push(...kinds);
    }
  }
  if (q.lang === "zh") where.push("is_zh(title) = 1");
  else if (q.lang === "en") where.push("is_zh(title) = 0");
  if (q.starred === "1") {
    if (scope.publicMode) {
      if (scope.userId !== null) {
        where.push(
          "EXISTS (SELECT 1 FROM user_item_states uis WHERE uis.user_id = ? AND uis.item_id = items.id AND uis.starred = 1)",
        );
        params.push(scope.userId);
      } else {
        where.push("1 = 0");
      }
    } else {
      where.push("starred = 1");
    }
  }
  if (q.unread === "1") {
    if (scope.publicMode) {
      if (scope.userId !== null) {
        where.push(
          "NOT EXISTS (SELECT 1 FROM user_item_states uis WHERE uis.user_id = ? AND uis.item_id = items.id AND uis.read_at IS NOT NULL)",
        );
        params.push(scope.userId);
      }
    } else {
      where.push("read_at IS NULL");
    }
  }
  if (q.hasCodes === "1") where.push("codes != '[]' AND codes != ''");
  if (q.aiOnly === "1") where.push("ai_keep = 1");
  // 用 IS NOT 而不是 (IS NULL OR != 0)：OR 会让索引失效，5671 行要 27 秒
  if (q.hideRejected === "1") where.push("ai_keep IS NOT 0");
  // 综合评分下限：走 idx_items_status_score，和 sort=score 同一个索引方向
  if (q.minScore) {
    const n = Math.min(Math.max(Number(q.minScore), 0), 100);
    if (Number.isFinite(n) && n > 0) {
      where.push("score >= ?");
      params.push(n);
    }
  }
  if (q.search) {
    where.push("(title LIKE ? ESCAPE '\\' OR COALESCE(summary,'') LIKE ? ESCAPE '\\')");
    params.push(likePattern(q.search), likePattern(q.search));
  }
  // 标签筛选：tags 是 JSON 数组，用 json_each 精确匹配，不做 LIKE（避免 STEAM 命中 STEAM_KEY 之类）
  if (q.tag) {
    where.push("EXISTS (SELECT 1 FROM json_each(items.tags) WHERE json_each.value = ?)");
    params.push(q.tag);
  }
  if (q.since) {
    where.push("COALESCE(published_at, first_seen_at) >= ?");
    params.push(q.since);
  }
  // 「未过期」拆成两个独立条件，避免 (A OR B) 这种写法让索引整体失效：
  //  1) 保鲜期：源没给截止时间时按发布时间算，否则 28 天前的老帖会被当成现役福利
  //  2) 截止时间：源给了就按它判断
  if (q.unexpired === "1") {
    if (q.maxAgeDays !== "all") {
      const maxAgeDays = Math.min(Math.max(Number(q.maxAgeDays ?? 14), 1), 365);
      where.push("COALESCE(published_at, first_seen_at) >= ?");
      params.push(new Date(Date.now() - maxAgeDays * 86_400_000).toISOString());
    }
    const now = new Date();
    where.push("(expires_at IS NULL OR expires_at > ?)");
    params.push(now.toISOString());
  }
  // 获取方式：用 IN 精确匹配（走 idx_items_obtain），不要用 COALESCE 包住列
  if (q.obtain) {
    const modes = q.obtain.split(",").filter(Boolean);
    if (modes.length) {
      where.push(`obtain IN (${modes.map(() => "?").join(",")})`);
      params.push(...modes);
    }
  }

  // 价格筛选：完全白嫖 / 最高能付多少（未知价格视为不匹配）
  if (q.freeOnly === "1") where.push("(is_free = 1 OR price = 0)");
  if (q.maxPrice) {
    const cap = Number(q.maxPrice);
    if (Number.isFinite(cap) && cap >= 0) {
      where.push("((is_free = 1 OR price = 0) OR (price IS NOT NULL AND price <= ?))");
      params.push(cap);
    }
  }

  const subKeywords = scope.publicMode
    ? scope.userId ? loadUserSubscriptions(scope.userId) : []
    : all<{ keyword: string }>("SELECT keyword FROM subscriptions ORDER BY keyword").map((r) => r.keyword);
  if (q.subscribed === "1") {
    if (subKeywords.length) {
      const likes = subKeywords.map(() => "(title LIKE ? ESCAPE '\\' OR COALESCE(summary,'') LIKE ? ESCAPE '\\')").join(" OR ");
      where.push("(" + likes + ")");
      for (const k of subKeywords) params.push(likePattern(k), likePattern(k));
    } else {
      where.push("1 = 0");
    }
  }
  if (q.expiring === "1") {
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
    where.push("expires_at IS NOT NULL AND expires_at > ? AND expires_at <= ?");
    params.push(new Date().toISOString(), soon);
  }

  // 屏蔽词下推：keyword 规则走 SQL NOT LIKE，regex 规则精确排除 id
  if (!includeBlocked && rules.length) {
    const regexRules: BlockRule[] = [];
    for (const r of rules) {
      if (r.mode === "regex") {
        regexRules.push(r);
        continue;
      }
      const pat = likePattern(r.pattern.toLowerCase());
      if (r.scope === "all") {
        where.push("LOWER(title || ' ' || COALESCE(summary,'')) NOT LIKE ? ESCAPE '\\'");
        params.push(pat);
      } else {
        where.push("(source_id != ? OR LOWER(title || ' ' || COALESCE(summary,'')) NOT LIKE ? ESCAPE '\\')");
        params.push(r.scope, pat);
      }
    }
    if (regexRules.length) {
      // 正则规则没法下推成 SQL，只能拉全表逐条跑 JS 正则。5000+ 行每次请求都扫一遍要 5-6 秒，
      // 所以按「规则签名 + 数据版本」缓存结果，规则或条目数变了才重算。
      const signature = regexRules.map((r) => r.id + ":" + r.pattern + ":" + r.scope).join("|");
      const version = get<{ n: number; maxId: number }>(
        "SELECT COUNT(*) AS n, COALESCE(MAX(id),0) AS maxId FROM items WHERE status = 'active'",
      );
      const cacheKey = signature + "#" + (version?.n ?? 0) + "#" + (version?.maxId ?? 0);
      if (regexBlockCache.key !== cacheKey) {
        const candidates = all<{ id: number; source_id: string; title: string; summary: string | null }>(
          "SELECT id, source_id, title, summary FROM items WHERE status = 'active'",
        );
        const compiled = regexRules.map((r) => compileRule(r));
        const ids: number[] = [];
        for (const row of candidates) {
          const text = row.title + " " + (row.summary ?? "");
          if (compiled.some((fn) => fn(text, row.source_id))) ids.push(row.id);
        }
        regexBlockCache = { key: cacheKey, ids };
      }
      if (regexBlockCache.ids.length) {
        where.push(`id NOT IN (${regexBlockCache.ids.map(() => "?").join(",")})`);
        params.push(...regexBlockCache.ids);
      }
    }
  }

  return { where, params, subKeywords };
}
/** 正则屏蔽规则的扫描结果缓存（见 buildItemsQuery 里的说明）。 */
let regexBlockCache: { key: string; ids: number[] } = { key: "", ids: [] };
/**
 * 公开读接口白名单：浏览、搜索、导出、健康检查都不需要密码。
 * 其余（推送/推送规则/AI/清理/屏蔽词/订阅/运维/采集）一律需要 ADMIN_TOKEN。
 * 注意：公开站下「个人」写操作走 /api/me/*，不落在这里。
 */
const PUBLIC_GET_EXACT = new Set([
  "/api/auth/check",
  "/api/items",
  "/api/stats",
  "/api/sources",
  "/api/digests",
  "/api/export",
  "/api/hot",
  "/api/taxonomy",
  "/api/source-quality",
  "/api/site/bootstrap",
  "/api/rss",
  "/api/upstream-watch",
  "/api/tracks",
]);

const PUBLIC_GET_PREFIX = ["/api/items/", "/api/digests/", "/api/tracks/"];

let warnedNoAdminToken = false;
let warnedAdminLocked = false;

export function registerApi(app: Hono) {
  ensureDossierTable();
  ensureTracksTable();
  registerSecurity(app);
  /**
   * 鉴权分层（顺序即优先级）：
   *   1. 采集回传：独立 INGEST_TOKEN，自己校验
   *   2. 登录/站点元信息：公开
   *   3. /api/me/*：必须登录，且站点没暂停个人功能
   *   4. 公开只读 GET
   *   5. 其余：仅 ADMIN_TOKEN（OAuth 登录不构成管理权限）
   */
  app.use("/api/*", async (c, next) => {
    const identity = resolveIdentity(c);
    c.set("identity" as never, identity as never);
    const path = c.req.path;
    const method = c.req.method;

    if (path.startsWith("/api/ingest")) return next();
    if (path.startsWith("/api/auth/") || path === "/api/site/bootstrap") return next();

    if (path.startsWith("/api/me/")) {
      if (!identity.user) return c.json({ error: "需要登录", needLogin: true }, 401);
      if (identity.personalSuspended) return c.json({ error: "站点已暂停个人功能" }, 403);
      return next();
    }

    if (method === "GET" && (PUBLIC_GET_EXACT.has(path) || PUBLIC_GET_PREFIX.some((p) => path.startsWith(p)))) {
      return next();
    }

    if (!adminHostAllowed(c)) return c.json({ error: "请从专用管理入口访问", needAuth: true }, 403);
    if (identity.isAdmin) return next();

    if (identity.adminLocked) {
      if (!warnedAdminLocked) {
        console.warn("[auth] 公开站未设置 ADMIN_TOKEN，管理接口已锁定");
        warnedAdminLocked = true;
      }
      return c.json({ error: "站点未配置 ADMIN_TOKEN，管理区已锁定", needAuth: true, adminLocked: true }, 403);
    }
    if (!config.adminToken) {
      if (!warnedNoAdminToken) {
        console.warn("[auth] 未设置 ADMIN_TOKEN，管理接口对所有访问者开放");
        warnedNoAdminToken = true;
      }
      return next();
    }
    return c.json({ error: "需要管理密码", needAuth: true }, 401);
  });

  registerPublicCache(app);

  app.get("/api/auth/check", (c) => {
    const id = identityOf(c);
    return c.json({ ok: true, protected: Boolean(config.adminToken) || id.adminLocked, isAdmin: id.isAdmin, adminLocked: id.adminLocked, adminHostAllowed: adminHostAllowed(c) });
  });

  app.get("/api/items", (c) => {
    const q = c.req.query();
    const limit = Math.min(Math.max(Math.floor(Number(q.limit ?? 40)), 1), 200);
    const offset = Math.max(Math.floor(Number(q.offset ?? 0)), 0);
    const id = identityOf(c);
    const includeBlocked = q.includeBlocked === "1" && (id.isAdmin || Boolean(id.user));
    const rules = id.siteMode === "public" && id.user
      ? loadUserBlockRules(id.user.id, getUserPushConfig(id.user.id).useGlobalBlocks)
      : loadActiveBlockRules();
    const scope: QueryScope = { userId: id.user?.id ?? null, publicMode: id.siteMode === "public", adminView: id.isAdmin };
    // 公开站未登录访客：个人收藏/已关闭在 localStorage，前端带 ids 列表来查
    if (scope.publicMode && !scope.userId && q.ids) {
      const ids = q.ids.split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0).slice(0, 100);
      if (!ids.length) return c.json({ total: 0, limit, offset, items: [] });
      const rows = all<ItemRow>(
        `SELECT ${LIST_COLUMNS} FROM items WHERE status = 'active' AND id IN (` + ids.map(() => "?").join(",") + ")",
        ...ids,
      );
      return c.json({ total: rows.length, limit, offset, items: rows.map((r) => ({ ...shape(r, [], null), dupCount: 1 })) });
    }

    const { where, params, subKeywords } = buildItemsQuery(q, rules, includeBlocked, scope);
    // 同一福利常被十几个源同时报道（Epic 喜加一尤甚），列表默认按 title_key 收敛：
    // 每组只保留最早入库的那条，前端按 dup_count 显示「N 个来源」并可展开。
    // 指定了单源或「我的收藏」时不做跨源合并，避免主记录落在别处导致本源条目被隐藏。
    const merge = q.merge === "1" || (q.merge !== "0" && !q.source && q.starred !== "1");
    if (merge) {
      // 代表条目只算一次：旧写法是逐行相关子查询（每行都要重跑一遍全表过滤 + 排序），5000 行时单次请求要 2-13 秒。
      // 现在改成一次窗口函数：按 title_key + 48 小时时间桶分组，每组取 score 最高的一条当代表。
      const groupKey = "CASE WHEN category = 'game' THEN 'game' ELSE CAST(julianday(COALESCE(published_at, first_seen_at)) / 2 AS INTEGER) END";
const keyOk = "LENGTH(CAST(title_key AS BLOB)) >= 6";
      const innerClause = where.length ? `${where.join(" AND ")} AND ` : "";
      // 注意：SQL 层只按 title_key 收敛（可走 idx_items_title_key 索引）。
      // canonical_id 的跨措辞聚类交给下面的 JS TitleDeduper（它已接收 canonicalId），
      // 不要放进 PARTITION BY —— 表达式分组会让索引失效，全表排序会阻塞事件循环。
      where.push(
        `(title_key IS NULL OR title_key = '' OR LENGTH(CAST(title_key AS BLOB)) < 6 OR id IN (
           SELECT rid FROM (
             SELECT id AS rid, ROW_NUMBER() OVER (PARTITION BY title_key, ${groupKey} ORDER BY score DESC, id ASC) AS rn
               FROM items WHERE ${innerClause}${keyOk}
           ) WHERE rn = 1))`,
      );
      // 子查询复用上面同一批过滤条件，参数按 SQL 文本顺序再排一遍
      params.push(...params.slice());
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const order = SORTS[q.sort ?? "newest"] ?? SORTS.newest;
    const rawTotal = get<{ n: number }>(`SELECT COUNT(*) AS n FROM items ${clause}`, ...params)?.n ?? 0;

    if (!merge) {
      const rows = all<ItemRow>(
        `SELECT ${LIST_COLUMNS} FROM items ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset,
      );
      return c.json({
        total: rawTotal,
        limit,
        offset,
        items: applyUserStates(
          rows.map((r) => {
            const hit = includeBlocked ? matchBlockRules(r, rules) : null;
            return { ...shape(r, subKeywords, hit ? hit.pattern : null), dupCount: 1 };
          }),
          scope.userId,
        ),
      });
    }

const fetchLimit = Math.min(Math.max(offset + limit * 3, 240), 600);
    const candidates = all<ItemRow>(
      `SELECT ${LIST_COLUMNS} FROM items ${clause} ORDER BY ${order} LIMIT ?`,
      ...params,
      fetchLimit,
    );

    // 折叠列表与计算「N 个来源」共用同一个分组聚类：徽标数字一定等于展开条数 + 1
    const clusterOf = createClusterScope();

    const seenClusters = new Set<string>();
    const representatives: Array<{ row: ItemRow; dupCount: number }> = [];
    for (const r of candidates) {
      const idx = clusterOf(r.kind, r.category);
      const root = idx.rootOf(r.id);
      const key = `${r.kind ?? ""}::${r.category ?? ""}::${root}`;
      if (seenClusters.has(key)) continue;
      seenClusters.add(key);
      representatives.push({ row: r, dupCount: idx.sizeOf(root) });
    }

    const extraMerged = candidates.length - representatives.length;
    const total = Math.max(representatives.length, rawTotal - extraMerged);
    const page = representatives.slice(offset, offset + limit);

    return c.json({
      total,
      limit,
      offset,
      items: applyUserStates(
        page.map(({ row: r, dupCount }) => {
          const hit = includeBlocked ? matchBlockRules(r, rules) : null;
          return {
            ...shape(r, subKeywords, hit ? hit.pattern : null),
            dupCount,
          };
        }),
        scope.userId,
      ),
    });
  });

  /** 展开「同一福利/事件的其它来源报道」（精确 title_key + 同事件实体聚类双路召回） */
  app.get("/api/items/:id/related", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    const self = get<ItemRow & { source_name?: string }>(
      `SELECT items.*, s.name AS source_name
         FROM items LEFT JOIN sources s ON s.id = items.source_id
        WHERE items.id = ?`,
      id,
    );
    if (!self) return c.json({ items: [] });

// 与列表的「N 个来源」用同一个池子：同 (kind, category) 分组的 active 条目。
    // 这样徽标数字一定等于展开条数 + 1；列表里那个数字就是这么算出来的。
    const pool = loadClusterPool(self.kind, self.category, clusterSince());
    const index = buildClusterIndex(pool);
    const selfRoot = index.rootOf(id);
    const memberIds = pool
      .filter((r) => r.id !== id && index.rootOf(r.id) === selfRoot)
      .map((r) => r.id)
      .slice(0, 200);
    if (!memberIds.length) return c.json({ items: [] });

    const members = all<ItemRow & { source_name?: string }>(
      `SELECT items.*, s.name AS source_name
         FROM items LEFT JOIN sources s ON s.id = items.source_id
        WHERE items.id IN (${memberIds.map(() => "?").join(",")})
        ORDER BY items.score DESC, items.id ASC`,
      ...memberIds,
    );
    return c.json({
      items: members.map((r) => ({ ...shape(r, [], null), sourceName: r.source_name ?? r.source_id })),
    });
  });

  app.get("/api/export", (c) => {
    const q = c.req.query();
    const format = q.format === "json" ? "json" : "md";
    const viewer = identityOf(c);
    const rules = viewer.siteMode === "public" && viewer.user
      ? loadUserBlockRules(viewer.user.id, getUserPushConfig(viewer.user.id).useGlobalBlocks) : loadActiveBlockRules();
    const { where, params, subKeywords } = buildItemsQuery(q, rules, false, { userId: viewer.user?.id ?? null, publicMode: viewer.siteMode === "public", adminView: viewer.isAdmin });
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const order = SORTS[q.sort ?? "newest"] ?? SORTS.newest;
    const rows = all<ItemRow>(`SELECT * FROM items ${clause} ORDER BY ${order} LIMIT 300`, ...params);

    if (format === "json") {
      return c.json({ count: rows.length, items: applyUserStates(rows.map((r) => shape(r, subKeywords)), viewer.user?.id ?? null) });
    }
    const lines = [`# 资源雷达导出 (${new Date().toISOString().slice(0, 10)}) · ${rows.length} 条`, ""];
    for (const r of rows) {
      const s = shape(r, subKeywords);
      const tags = [s.source_id, s.category, s.is_free === 1 ? "白嫖" : s.price ? `≤${Math.round(s.price)}元` : null]
        .filter(Boolean)
        .join(" · ");
      lines.push(`- [${r.title}](${r.url}) — *${tags}*` + (s.codes.length ? ` \`${s.codes.join(" / ")}\`` : ""));
    }
    c.header("Content-Type", "text/markdown; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="freebie-radar-${new Date().toISOString().slice(0, 10)}.md"`);
    return c.body(lines.join("\n"));
  });

  app.get("/api/items/:id", (c) => {
    const row = get<ItemRow>("SELECT * FROM items WHERE id = ?", Number(c.req.param("id")));
    if (!row) return c.json({ error: "not found" }, 404);
    const id = identityOf(c);
    if (id.siteMode === "public" && !id.isAdmin && row.status !== "active") return c.json({ error: "not found" }, 404);
    const pubUser = id.siteMode === "public" ? (id.user?.id ?? null) : null;
    const subKeywords =
      id.siteMode === "public" ? pubUser !== null ? loadUserSubscriptions(pubUser) : []
        : all<{ keyword: string }>("SELECT keyword FROM subscriptions").map((r) => r.keyword);
    const dossier = getItemDossier(row.id);
    return c.json({ ...applyUserStates([shape(row, subKeywords)], pubUser)[0],
      hasDossier: Boolean(dossier || row.has_dossier),
      dossier,
      ...(id.isAdmin ? { manualClassification: getManualClassification(row.id) } : {}),
    });
  });

  app.post("/api/items/:id/dossier", async (c) => {
    const itemId = Number(c.req.param("id"));
    if (!Number.isSafeInteger(itemId) || itemId < 1) return c.json({ error: "条目 ID 无效" }, 400);
    if (!get("SELECT id FROM items WHERE id = ?", itemId)) return c.json({ error: "资源不存在" }, 404);
    try {
      const dossier = await generateItemDossier(itemId, { force: true });
      return c.json({ ok: true, dossier });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
  app.patch("/api/admin/items/:id/classification", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id < 1) return c.json({ error: "条目 ID 无效" }, 400);
    if (!get("SELECT id FROM items WHERE id=?", id)) return c.json({ error: "资源不存在" }, 404);
    const body = await c.req.json().catch(() => null) as { category?: unknown; kind?: unknown; note?: unknown; clear?: unknown } | null;
    if (!body) return c.json({ error: "请求体无效" }, 400);
    if (body.clear !== true) {
      if (body.category !== null && !isCategory(body.category)) return c.json({ error: "分类必须是合法分类或 null（保持自动）" }, 400);
      if (body.kind !== null && !isContentKind(body.kind)) return c.json({ error: "内容形态必须是合法频道形态或 null（保持自动）" }, 400);
      if (body.category === null && body.kind === null) return c.json({ error: "至少选择分类或内容形态；取消人工设置请恢复自动" }, 400);
      if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 200)) return c.json({ error: "备注最多 200 字" }, 400);
    }
    tx(() => {
      run("DELETE FROM item_classification_overrides WHERE item_id=?", id);
      // First recompute automatic fields (including expired/hidden rows); then apply selected manual fields.
      reclassifyStoredItems("all", { itemId: id, forceAutomatic: true });
      if (body.clear !== true) {
        run("INSERT INTO item_classification_overrides(item_id,category,kind,note,updated_at) VALUES(?,?,?,?,?)",
          id, body.category as string | null, body.kind as string | null, typeof body.note === "string" ? body.note.trim() : "", new Date().toISOString());
        reclassifyStoredItems("all", { itemId: id });
      }
    });
    return c.json({ ok: true, item: shape(get<ItemRow>("SELECT * FROM items WHERE id=?", id)!), manualClassification: getManualClassification(id) });
  });

  app.patch("/api/items/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const body = (await c.req.json().catch(() => ({}))) as { starred?: boolean; status?: string; read?: boolean };
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (typeof body.starred === "boolean") {
      sets.push("starred = ?");
      params.push(body.starred ? 1 : 0);
    }
    if (body.status && ["active", "ignored", "expired"].includes(body.status)) {
      sets.push("status = ?");
      params.push(body.status);
    }
    if (typeof body.read === "boolean") {
      sets.push("read_at = ?");
      params.push(body.read ? new Date().toISOString() : null);
    }
    if (!sets.length) return c.json({ error: "nothing to update" }, 400);
    params.push(id);
    run(`UPDATE items SET ${sets.join(", ")} WHERE id = ?`, ...params);
    const row = get<ItemRow>("SELECT * FROM items WHERE id = ?", id);
    return row ? c.json(shape(row)) : c.json({ error: "not found" }, 404);
  });

  app.post("/api/items/batch", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { ids?: number[]; action?: string } | null;
    if (!body?.ids?.length || !body.action) return c.json({ error: "ids 与 action 必填" }, 400);
    const ids = body.ids.filter((n) => Number.isInteger(n)).slice(0, 200);
    if (!ids.length) return c.json({ updated: 0 });
    const ph = ids.map(() => "?").join(",");
    const now = new Date().toISOString();
    switch (body.action) {
      case "read":
        run(`UPDATE items SET read_at = ? WHERE id IN (${ph})`, now, ...ids);
        break;
      case "unread":
        run(`UPDATE items SET read_at = NULL WHERE id IN (${ph})`, ...ids);
        break;
      case "ignore":
        run(`UPDATE items SET status = 'ignored' WHERE id IN (${ph})`, ...ids);
        break;
      case "restore":
        run(`UPDATE items SET status = 'active' WHERE id IN (${ph})`, ...ids);
        break;
      default:
        return c.json({ error: "unsupported action" }, 400);
    }
    return c.json({ ok: true, updated: ids.length });
  });

  // ---- 分类口径（前端/第三方客户端据此渲染，与主页频道保持同一份定义）----
  app.get("/api/taxonomy", (c) => {
    return c.json({
      categories: CATEGORY_KEYS.map((key) => ({ key, label: CATEGORY_LABEL[key], desc: CATEGORY_DESC[key] })),
      groups: CATEGORY_GROUPS,
      channels: CHANNELS,
      kinds: KIND_ORDER.map((key) => ({ key, label: KIND_LABEL[key] })),
      obtains: OBTAIN_KEYS.map((key) => ({ key, label: OBTAIN_LABEL[key] })),
    });
  });
  // ---- 屏蔽词管理 ----
  app.get("/api/block-rules", (c) => {
    const rules = all<BlockRule>("SELECT id, pattern, mode, scope, enabled, created_at FROM block_rules ORDER BY id DESC");
    const activeItems = all<{ id: number; source_id: string; title: string; summary: string | null }>(
      "SELECT id, source_id, title, summary FROM items WHERE status = 'active'",
    );
    const enriched = rules.map((r) => {
      const matcher = compileRule(r);
      let hits = 0;
      for (const it of activeItems) {
        if (matcher(it.title + " " + (it.summary ?? ""), it.source_id)) hits += 1;
      }
      return { ...r, enabled: r.enabled === 1, hits };
    });

    // 统计全部启用规则合计挡掉多少条
    const enabledRules = rules.filter((r) => r.enabled === 1);
    let totalBlocked = 0;
    if (enabledRules.length) {
      const matchers = enabledRules.map((r) => compileRule(r));
      for (const it of activeItems) {
        const text = it.title + " " + (it.summary ?? "");
        if (matchers.some((m) => m(text, it.source_id))) totalBlocked += 1;
      }
    }

    return c.json({ rules: enriched, totalBlocked, presets: PRESET_NOISE_PATTERNS });
  });

  app.post("/api/block-rules", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      pattern?: string;
      mode?: string;
      scope?: string;
      presets?: boolean;
    } | null;

    const now = new Date().toISOString();
    if (body?.presets) {
      for (const p of PRESET_NOISE_PATTERNS) {
        run(
          "INSERT INTO block_rules (pattern, mode, scope, enabled, created_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(pattern, scope) DO UPDATE SET enabled = 1",
          p.pattern,
          p.mode,
          p.scope,
          now,
        );
      }
      return c.json({ ok: true, added: PRESET_NOISE_PATTERNS.length });
    }

    const pattern = (body?.pattern ?? "").trim();
    if (!pattern || pattern.length > 80) return c.json({ error: "pattern 必填且不超过 80 字" }, 400);
    const mode = body?.mode === "regex" ? "regex" : "keyword";
    if (mode === "regex" && !safeRegex(pattern)) return c.json({ error: "正则无效或复杂度过高；不支持回溯引用、前后查找和重复分组" }, 400);
    const scope = (body?.scope ?? "all").trim() || "all";
    run(
      "INSERT INTO block_rules (pattern, mode, scope, enabled, created_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(pattern, scope) DO UPDATE SET mode = excluded.mode, enabled = 1",
      pattern,
      mode,
      scope,
      now,
    );
    return c.json({ ok: true });
  });

  app.patch("/api/block-rules/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
    if (typeof body.enabled !== "boolean") return c.json({ error: "enabled required" }, 400);
    run("UPDATE block_rules SET enabled = ? WHERE id = ?", body.enabled ? 1 : 0, id);
    return c.json({ ok: true });
  });

  app.delete("/api/block-rules/:id", (c) => {
    run("DELETE FROM block_rules WHERE id = ?", Number(c.req.param("id")));
    return c.json({ ok: true });
  });

  // ---- 数据源管理与手动触发 ----
  app.get("/api/sources", (c) => {
    const sourceRows = all<Record<string, unknown>>("SELECT * FROM sources ORDER BY id");
    const stats = all<{ source_id: string; n: number; last_published: string | null }>(
      "SELECT source_id, COUNT(*) AS n, MAX(COALESCE(published_at, first_seen_at)) AS last_published FROM items GROUP BY source_id",
    );
    const byId = new Map(stats.map((s) => [s.source_id, s]));
    return c.json({
      sources: sourceRows.map((s) => ({
        ...(identityOf(c).isAdmin ? s : {
          id: s.id, name: s.name, kind: s.kind, interval_sec: s.interval_sec,
          last_run_at: s.last_run_at, last_status: s.last_status,
        }),
        enabled: s.enabled === 1,
        builtIn: BUILTIN_SOURCE_IDS.has(String(s.id)),
        config: identityOf(c).isAdmin ? JSON.parse(String(s.config ?? "{}")) : {},
        items: byId.get(String(s.id))?.n ?? 0,
        latest_item_at: byId.get(String(s.id))?.last_published ?? null,
      })),
    });
  });

  app.post("/api/sources", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      name?: string;
      url?: string;
      intervalSec?: number;
      kindHint?: string;
      categoryHint?: string;
      fixedCategory?: string;
    } | null;
    const name = (body?.name ?? "").trim();
    const url = (body?.url ?? "").trim();
    if (!name || !/^https?:\/\//i.test(url)) return c.json({ error: "名称与合法的 http(s) RSS 地址必填" }, 400);
    const hintErr = checkSourceHints(body?.kindHint, body?.categoryHint, body?.fixedCategory);
    if (hintErr) return c.json({ error: hintErr }, 400);
    const id = addCustomRssSource({
      name,
      url,
      intervalSec: body?.intervalSec,
      kindHint: body?.kindHint,
      categoryHint: body?.categoryHint,
      fixedCategory: body?.fixedCategory,
    });
    const summary = await runSource(id).catch((err) => ({
      sourceId: id,
      status: "failed" as const,
      fetched: 0,
      inserted: 0,
      skipped: 0,
      durationMs: 0,
      error: err instanceof Error ? err.message : String(err),
      cursor: null,
    }));
    return c.json({ ok: true, id, summary });
  });

  app.patch("/api/sources/:id", async (c) => {
    const id = c.req.param("id");
    const existing = get<{ id: string; kind: string; config: string }>("SELECT id, kind, config FROM sources WHERE id = ?", id);
    if (!existing) return c.json({ error: "source not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      enabled?: boolean;
      interval_sec?: number;
      name?: string;
      config?: Record<string, unknown>;
    };
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (typeof body.enabled === "boolean") {
      sets.push("enabled = ?");
      params.push(body.enabled ? 1 : 0);
    }
    if (typeof body.interval_sec === "number" && Number.isFinite(body.interval_sec) && body.interval_sec >= 60) {
      sets.push("interval_sec = ?");
      params.push(Math.round(body.interval_sec));
    }
    if (typeof body.name === "string") {
      const nextName = body.name.trim();
      if (!nextName || nextName.length > 80) return c.json({ error: "名称长度需在 1-80 字之间" }, 400);
      sets.push("name = ?");
      params.push(nextName);
    }
    if (body.config !== undefined) {
      if (!body.config || typeof body.config !== "object" || Array.isArray(body.config)) {
        return c.json({ error: "config 必须为 JSON 对象" }, 400);
      }
      const cfg = body.config as Record<string, unknown>;
      const hintErr = checkSourceHints(cfg.kindHint, cfg.categoryHint, cfg.fixedCategory);
      if (hintErr) return c.json({ error: hintErr }, 400);
      if (existing.kind === "rss") {
        const feeds = (body.config as { feeds?: unknown }).feeds;
        if (!Array.isArray(feeds) || feeds.length === 0) {
          return c.json({ error: "RSS 源 config.feeds 必须至少包含一条订阅地址" }, 400);
        }
        if (feeds.length > 30) return c.json({ error: "每个源最多 30 条 RSS 地址" }, 400);
        for (const f of feeds) {
          if (!f || typeof f !== "object" || Array.isArray(f)) return c.json({ error: "每条 RSS 配置必须是对象" }, 400);
          const url = typeof (f as { url?: unknown })?.url === "string" ? (f as { url: string }).url.trim() : "";
          if (!/^https?:\/\//i.test(url)) {
            return c.json({ error: "RSS 订阅地址必须是合法的 http(s):// URL" }, 400);
          }
          const feedHintErr = checkSourceHints(
            (f as { kindHint?: unknown })?.kindHint,
            (f as { categoryHint?: unknown })?.categoryHint,
          );
          if (feedHintErr) return c.json({ error: `feeds 里的 ${feedHintErr}` }, 400);
          for (const key of ["titleKeywords", "excludeTitleKeywords", "includeCategories", "excludeCategories"] as const) {
            const values = (f as Record<string, unknown>)[key];
            if (values !== undefined && (!Array.isArray(values) || values.length > 50 || values.some((value) => typeof value !== "string" || !value.trim() || value.length > 80))) {
              return c.json({ error: `${key} 必须是最多 50 个非空字符串的数组，每个不超过 80 字` }, 400);
            }
          }
        }
      }
      sets.push("config = ?");
      params.push(JSON.stringify(body.config));
    }
    if (!sets.length) return c.json({ error: "nothing to update" }, 400);
    params.push(id);
    const reclassified = tx(() => {
      run(`UPDATE sources SET ${sets.join(", ")} WHERE id = ?`, ...params);
      return body.config === undefined ? 0 : reconcileSourceCategory(id);
    });
    return c.json({ ok: true, reclassified });
  });

  app.delete("/api/sources/:id", (c) => {
    const id = c.req.param("id");
    const res = deleteCustomSource(id);
    if (!res.ok) return c.json({ error: res.error }, 400);
    return c.json({ ok: true });
  });

  app.post("/api/sources/:id/collect", async (c) => {
    const id = c.req.param("id");
    const src = get<{ id: string; kind: string }>("SELECT id, kind FROM sources WHERE id = ?", id);
    if (!src) return c.json({ error: "source not found" }, 404);
    try {
      const summary = await runSource(id);
      return c.json({ ok: summary.status !== "failed", summary, error: summary.error });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ---- VPS Cookie 托管与执行器状态（受 ADMIN_TOKEN 保护，不返回明文 Cookie）----
  app.get("/api/cookies", (c) => {
    return c.json(toPublicCookieStatus());
  });

  app.patch("/api/cookies", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      runnerUrl?: string;
      xhsProxy?: string;
      cookies?: Partial<Record<CookieSiteKey, string>>;
    } | null;
    if (!body) return c.json({ error: "invalid json" }, 400);
    try {
      return c.json(updateCookieSettings(body));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/cookies/test-runner", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { runnerUrl?: string };
    const url = (body.runnerUrl ?? getCookieSettings().runnerUrl).replace(/\/+$/, "");
    if (!url) return c.json({ ok: false, error: "未配置执行器地址" }, 400);
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000) });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; busy?: boolean; chrome?: boolean };
      return c.json({ ok: res.ok && Boolean(data.ok), ...data });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* ---- 外部工具入口（独立项目，雷达只做链接，不参与其逻辑） ---- */
  app.get("/api/external-tools", (c) =>
    c.json({ epicClaimer: config.epicClaimerUrl ? { url: config.epicClaimerUrl } : null }),
  );


  app.get("/api/runs", (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 200);
    return c.json({ runs: all("SELECT * FROM runs ORDER BY id DESC LIMIT ?", limit) });
  });

  // ---- 订阅 ----
  app.get("/api/subscriptions", (c) => {
    const rows = all<{ id: number; keyword: string; created_at: string; last_hit_at: string | null }>(
      "SELECT id, keyword, created_at, last_hit_at FROM subscriptions ORDER BY keyword",
    );
    const hits = all<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE status = 'active'").at(0)?.n ?? 0;
    return c.json({ subscriptions: rows, activeItems: hits });
  });

  app.post("/api/subscriptions", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { keyword?: string } | null;
    const keyword = (body?.keyword ?? "").trim();
    if (!keyword || keyword.length > 40) return c.json({ error: "keyword 必填且不超过 40 字" }, 400);
    run(
      "INSERT INTO subscriptions (keyword, created_at) VALUES (?, ?) ON CONFLICT(keyword) DO NOTHING",
      keyword,
      new Date().toISOString(),
    );
    const rows = all<{ id: number; keyword: string; created_at: string; last_hit_at: string | null }>(
      "SELECT id, keyword, created_at, last_hit_at FROM subscriptions ORDER BY keyword",
    );
    return c.json({ subscriptions: rows });
  });

  app.delete("/api/subscriptions/:id", (c) => {
    run("DELETE FROM subscriptions WHERE id = ?", Number(c.req.param("id")));
    const rows = all<{ id: number; keyword: string; created_at: string; last_hit_at: string | null }>(
      "SELECT id, keyword, created_at, last_hit_at FROM subscriptions ORDER BY keyword",
    );
    return c.json({ subscriptions: rows });
  });

  app.get("/api/stats", (c) => {
    const q = c.req.query();
    const viewer = identityOf(c);
    const queryScope: QueryScope = { userId: viewer.user?.id ?? null, publicMode: viewer.siteMode === "public" };
    const statsCutoff = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const totals = get<{
      total: number;
      active: number;
      starred: number;
      expired: number;
      withCodes: number;
      unread: number;
      aiKept: number;
      aiRejected: number;
      cleanFree: number;
    }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN starred=1 THEN 1 ELSE 0 END) AS starred,
              SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 1 ELSE 0 END) AS expired,
              SUM(CASE WHEN status='active' AND codes != '[]' AND codes != '' THEN 1 ELSE 0 END) AS withCodes,
              SUM(CASE WHEN ai_keep = 1 THEN 1 ELSE 0 END) AS aiKept,
              SUM(CASE WHEN ai_keep = 0 THEN 1 ELSE 0 END) AS aiRejected,
              SUM(CASE WHEN ai_keep = 1 AND COALESCE(obtain,'free') = 'free' AND COALESCE(published_at, first_seen_at) >= ? THEN 1 ELSE 0 END) AS cleanFree,
              SUM(CASE WHEN status='active' AND read_at IS NULL THEN 1 ELSE 0 END) AS unread
       FROM items`,
      new Date().toISOString(),
      statsCutoff,
    );

    const hasChannelFilter = Boolean(
      q.preset || q.kind || q.obtain || q.aiOnly || q.hideRejected || q.unexpired || q.freeOnly || q.maxPrice ||
      q.source || q.search || q.since || q.lang || q.hasCodes || q.expiring || q.starred ||
      q.unread || q.subscribed || q.minScore || q.status,
    );
    let byCategory: { category: string | null; n: number }[];
    if (hasChannelFilter) {
      const { category: _omit, ...restQ } = q;
      const rules = queryScope.publicMode && queryScope.userId
        ? loadUserBlockRules(queryScope.userId, getUserPushConfig(queryScope.userId).useGlobalBlocks) : loadActiveBlockRules();
      const { where, params } = buildItemsQuery(restQ, rules, false, queryScope);
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      byCategory = all<{ category: string | null; n: number }>(
        `SELECT category, COUNT(*) AS n FROM items ${clause} GROUP BY category ORDER BY n DESC`,
        ...params,
      );
    } else {
      byCategory = all<{ category: string | null; n: number }>(
        "SELECT category, COUNT(*) AS n FROM items WHERE status='active' GROUP BY category ORDER BY n DESC",
      );
    }
    const byKind = all<{ kind: string | null; n: number }>(
      "SELECT COALESCE(kind, 'freebie') AS kind, COUNT(*) AS n FROM items WHERE status='active' GROUP BY kind ORDER BY n DESC",
    );
    const bySource = all<{ source_id: string; n: number }>(
      "SELECT source_id, COUNT(*) AS n FROM items WHERE status='active' GROUP BY source_id ORDER BY n DESC",
    );
    const last24h = get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM items WHERE COALESCE(published_at, first_seen_at) >= ?",
      new Date(Date.now() - 86_400_000).toISOString(),
    );
    const id = identityOf(c);
    const pubUser = id.siteMode === "public" ? (id.user?.id ?? null) : null;
    const userTotals = pubUser
      ? get<{ starred: number; hidden: number; read: number }>(
          "SELECT SUM(starred) AS starred, SUM(hidden) AS hidden, SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) AS read FROM user_item_states WHERE user_id = ?",
          pubUser,
        )
      : undefined;
    const blockRules =
      pubUser
        ? (get<{ n: number }>("SELECT COUNT(*) AS n FROM user_block_rules WHERE user_id = ? AND enabled = 1", pubUser)?.n ?? 0)
        : (get<{ n: number }>("SELECT COUNT(*) AS n FROM block_rules WHERE enabled = 1")?.n ?? 0);

    return c.json({
      totals: {
        total: totals?.total ?? 0,
        active: totals?.active ?? 0,
        starred: userTotals ? (userTotals.starred ?? 0) : (totals?.starred ?? 0),
        expired: totals?.expired ?? 0,
        withCodes: totals?.withCodes ?? 0,
        unread: userTotals ? (totals?.active ?? 0) - (userTotals.read ?? 0) : (totals?.unread ?? 0),
        last24h: last24h?.n ?? 0,
        blockRules,
        aiKept: totals?.aiKept ?? 0,
        aiRejected: totals?.aiRejected ?? 0,
        cleanFree: totals?.cleanFree ?? 0,
      },
      byCategory,
      byKind,
      bySource,
      price: get<{ free: number; under5: number; under10: number; known: number }>(
        `SELECT SUM(CASE WHEN is_free = 1 OR price = 0 THEN 1 ELSE 0 END) AS free,
                SUM(CASE WHEN price IS NOT NULL AND price > 0 AND price <= 5 THEN 1 ELSE 0 END) AS under5,
                SUM(CASE WHEN price IS NOT NULL AND price > 5 AND price <= 10 THEN 1 ELSE 0 END) AS under10,
                SUM(CASE WHEN price IS NOT NULL OR is_free = 1 THEN 1 ELSE 0 END) AS known
         FROM items WHERE status = 'active'`,
      ),
      features: { ai: aiEnabled, push: pushEnabled, pushChannel: config.pushChannel },
    });
  });

  // ---- 推送设置 / 预览 / 记录 ----
  app.get("/api/push", (c) => {
    const s = getPushSettings();
    return c.json({
      settings: s,
      defaults: DEFAULT_SETTINGS,
      stats: pushStats(),
      channel: config.pushChannel,
      ready: pushEnabled,
      quiet: isQuietNow(s),
    });
  });

  app.patch("/api/push", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<PushSettings> | null;
    if (!body) return c.json({ error: "无效的请求体" }, 400);
    const settings = savePushSettings(body);
    return c.json({ settings, stats: pushStats(), quiet: isQuietNow(settings) });
  });

  /* ---------------------------------------------------------------- *
   * AI 语义审核配置：开关/规则初筛/送审范围/连接与性能/提示词/测试/补审
   * ---------------------------------------------------------------- */

  // 云端提示词：配置与最近一次同步状态；POST 立即拉取一次
  app.get("/api/ai/prompt-sync", (c) =>
    c.json({
      configured: promptSyncConfigured(),
      urls: { system: config.promptUrl ? "set" : "", extra: config.promptExtraUrl ? "set" : "" },
      intervalMinutes: config.promptSyncMinutes,
      state: readSyncState(),
    }),
  );
  app.post("/api/ai/prompt-sync", async (c) => c.json(await syncPromptsNow()));

  app.get("/api/ai", (c) => {
    const aiS = getAiSettings();
    const pushS = getPushSettings();
    return c.json({
      settings: {
        ...publicAiSettings(aiS),
        reviewBeforePush: pushS.pushTiming === "wait_ai",
        syncPrePushLimit: pushS.syncPrePushLimit,
      },
      stats: aiStats(),
      feedback: feedbackStats(aiS.feedbackLimit),
    });
  });

  app.get("/api/ai/live", (c) => {
    return c.json({ stats: aiStats() });
  });
  app.patch("/api/ai", async (c) => {
    const body = (await c.req.json().catch(() => null)) as (Partial<AiSettings> & { reviewBeforePush?: boolean }) | null;
    if (!body) return c.json({ error: "无效的请求体" }, 400);
    if (typeof body.reviewBeforePush === "boolean") {
      savePushSettings({ pushTiming: body.reviewBeforePush ? "wait_ai" : "instant_first" });
    }
    const saved = saveAiSettings(body);
    const pushS = getPushSettings();
    return c.json({
      settings: { ...publicAiSettings(saved), reviewBeforePush: pushS.pushTiming === "wait_ai", syncPrePushLimit: pushS.syncPrePushLimit },
      stats: aiStats(),
      feedback: feedbackStats(saved.feedbackLimit),
    });
  });

  app.post("/api/ai/test", async (c) => {
    const draft = (await c.req.json().catch(() => ({}))) as Partial<AiSettings>;
    return c.json(await testAiConnection(draft));
  });

  app.post("/api/ai/backfill", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { limit?: number; mode?: string };
    const limit = Math.min(Math.max(Number(body.limit ?? 200), 1), 2000);
    const mode: BackfillMode =
      body.mode === "recent" || body.mode === "rejected" ? body.mode : "pending";
    return c.json(await backfillAi(limit, mode));
  });

  app.post("/api/ai/backfill-dossiers", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { minQuality?: number; limit?: number; concurrency?: number };
    const res = await backfillDossiers({
      minQuality: typeof body.minQuality === "number" ? body.minQuality : undefined,
      limit: typeof body.limit === "number" ? body.limit : undefined,
      concurrency: typeof body.concurrency === "number" ? body.concurrency : undefined,
    });
    return c.json({ ok: true, ...res });
  });

  app.post("/api/ai/reclassify", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { scope?: string };
    const scope = body.scope === "all" ? "all" : "other";
    return c.json(reclassifyStoredItems(scope));
  });

  app.get("/api/admin/classification", (c) => c.json({
    settings: getClassificationSettings(),
    audit: reclassifyStoredItems("all", { dryRun: true }),
  }));
  app.patch("/api/admin/classification", async (c) => {
    const body = await c.req.json().catch(() => null) as { guardEnabled?: unknown } | null;
    if (typeof body?.guardEnabled !== "boolean") return c.json({ error: "guardEnabled 必须是布尔值" }, 400);
    return c.json({ settings: saveClassificationSettings(body.guardEnabled) });
  });
  app.post("/api/admin/classification/preview", async (c) => {
    const body = await c.req.json().catch(() => null) as { title?: unknown; summary?: unknown; sourceId?: unknown; aiKind?: unknown } | null;
    if (typeof body?.title !== "string" || !body.title.trim() || body.title.length > 200) return c.json({ error: "标题必填，最多 200 字" }, 400);
    const sourceId = typeof body.sourceId === "string" ? body.sourceId : "";
    const summary = typeof body.summary === "string" ? body.summary.slice(0, 2000) : "";
    const hints = getSourceHints(sourceId);
    const item = enrichItem({ externalId: "preview", title: body.title, summary, url: "https://example.com/classification-preview" }, sourceId, hints);
    if (!item) return c.json({ error: "无法识别标题" }, 400);
    const kind = resolveKind(body.aiKind, true, { title: item.title, summary, sourceId, category: item.category, obtain: guessObtain(item.title, summary), isFree: item.isFree, price: item.price, ...hints });
    return c.json({ category: item.category, ruleKind: item.kind, finalKind: kind, signals: contentSignals(item.title, summary), hints, note: "规则试算，不调用 AI；AI kind 仅用于模拟误判后的校验结果" });
  });
  app.post("/api/admin/classification/reclassify", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { sourceId?: unknown };
    const sourceId = typeof body.sourceId === "string" && body.sourceId ? body.sourceId : undefined;
    if (sourceId && !get("SELECT id FROM sources WHERE id = ?", sourceId)) return c.json({ error: "数据源不存在" }, 400);
    return c.json(tx(() => reclassifyStoredItems("all", { sourceId })));
  });

  app.post("/api/ai/dedup", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { limit?: number };
    const limit = Math.min(Math.max(Number(body.limit ?? 80), 10), 200);
    return c.json(await runAiDedupBackfill(limit));
  });
  /* ---------------------------------------------------------------- *
   * 数据保留：过期条目、推送日志、日报的自动清理
   * ---------------------------------------------------------------- */

  app.get("/api/retention", (c) => {
    return c.json({ settings: getRetention(), counts: itemCounts() });
  });

  app.patch("/api/retention", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<RetentionSettings> | null;
    if (!body) return c.json({ error: "无效的请求体" }, 400);
    return c.json({ settings: saveRetention(body), counts: itemCounts() });
  });

  app.post("/api/retention/preview", (c) => {
    // 只统计不删，让用户先看清会清掉多少
    return c.json(runCleanup(getRetention(), true));
  });

  app.post("/api/retention/run", (c) => {
    const report = runCleanup(getRetention(), false);
    return c.json({ ...report, counts: itemCounts() });
  });

  app.get("/api/push/preview", (c) => {
    return c.json(previewPush(Math.min(Math.max(Number(c.req.query("limit") ?? 6), 1), 12)));
  });

  app.get("/api/push/log", (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 30), 1), 100);
    return c.json({ logs: recentPushLog(limit) });
  });

  app.post("/api/push/flush", async (c) => {
    const sent = await flushBatch(true);
    return c.json({ ok: true, sent, queued: queueSize() });
  });

  app.post("/api/push/test", async (c) => {
    if (!pushEnabled || config.pushChannel !== "telegram" || !config.telegramBotToken || !config.telegramChatId) {
      return c.json({ error: "Telegram 推送未启用或缺少凭据" }, 400);
    }
    await sendTelegram("🛰 资源雷达测试消息 · " + new Date().toLocaleString("zh-CN"));
    return c.json({ ok: true });
  });

  app.post("/api/ingest", async (c) => {
    if (!config.ingestToken) return c.json({ error: "INGEST_TOKEN 未配置，拒绝写入" }, 403);
    const auth = c.req.header("authorization") ?? "";
    if (auth !== "Bearer " + config.ingestToken) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => null)) as { sourceId?: string; items?: unknown[] } | null;
    if (!body?.sourceId || !Array.isArray(body.items)) return c.json({ error: "sourceId 与 items 必填" }, 400);
    if (body.items.length > 500) return c.json({ error: "每次最多回传 500 条" }, 400);
    const items = body.items
      .filter((i): i is RawItem => {
        const r = i as RawItem | null;
        return Boolean(r && typeof r.title === "string" && typeof r.url === "string");
      })
      // 外部脚本（油猴 / 本地 Playwright）不一定给 externalId，缺了就退回 URL，
      // 否则会带着 undefined 绑到 SQLite 参数上直接 500
      .map((r) => ({ ...r, externalId: r.externalId || r.url }));
    const saved = ingestItems(body.sourceId, items);
    return c.json({ ok: true, received: body.items.length, ...saved });
  });

  app.post("/api/ingest/failed", async (c) => {
    if (!config.ingestToken) return c.json({ error: "INGEST_TOKEN 未配置" }, 403);
    const auth = c.req.header("authorization") ?? "";
    if (auth !== "Bearer " + config.ingestToken) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => null)) as { sourceId?: string; reason?: string; status?: string } | null;
    if (!body?.sourceId || !body.reason) return c.json({ error: "sourceId 与 reason 必填" }, 400);
    const status = body.status === "failed" ? "failed" : "degraded";
    return c.json(markSourceFailure(body.sourceId, body.reason, status));
  });

  /** 供本地/远端 Playwright 采集器同步「我的订阅」关键词，主动去知乎/小红书/小黑盒定向搜索 */
  app.get("/api/ingest/keywords", (c) => {
    if (!config.ingestToken) return c.json({ error: "INGEST_TOKEN 未配置" }, 403);
    const auth = c.req.header("authorization") ?? "";
    if (auth !== "Bearer " + config.ingestToken) return c.json({ error: "unauthorized" }, 401);
    const rows = all<{ keyword: string }>("SELECT keyword FROM subscriptions ORDER BY id DESC LIMIT 20");
    return c.json({ keywords: rows.map((r) => r.keyword) });
  });

  app.get("/api/hot", (c) => {
    return c.json(buildHotReport(Number(c.req.query("hours") ?? 24), c.req.query("scope")));
  });

  app.get("/api/source-quality", (c) => {
    const days = Number(c.req.query("days") ?? 7);
    const safeDays = Math.min(Math.max(Math.round(days) || 7, 1), 90);
    return c.json({ days: safeDays, sources: sourceQuality(safeDays) });
  });

  app.get("/api/digests", (c) => {
    return c.json({ digests: lastDigests(30) });
  });

  app.post("/api/digests/weekly", async (c) => {
    try {
      const result = await runWeekly({ dryRun: false });
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/digests/run", async (c) => {
    try {
      const result = await runDaily({ dryRun: false });
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/digests/:date", (c) => {
    const date = c.req.param("date");
    const row = get<{ date: string; item_ids: string; payload: string; created_at: string; pushed_at: string | null }>(
      "SELECT date, item_ids, payload, created_at, pushed_at FROM digests WHERE date = ?",
      date,
    );
    if (!row) return c.json({ error: "not found" }, 404);
    let ids: number[] = [];
    try {
      ids = JSON.parse(row.item_ids) as number[];
    } catch {
      ids = [];
    }
    let text = "";
    let report: DigestReport | null = null;
    try {
      const payload = JSON.parse(row.payload) as { text?: unknown; report?: unknown };
      text = typeof payload.text === "string" ? payload.text : String(payload.text ?? "");
      report = validateDigestReport(payload.report);
    } catch {
      text = "";
      report = null;
    }
    const rawItems = ids.length
      ? all<ItemRow>(`SELECT * FROM items WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids)
      : [];
    const orderMap = new Map(ids.map((id, i) => [id, i]));
    const items = [...rawItems].sort((a, b) => (orderMap.get(a.id) ?? 9999) - (orderMap.get(b.id) ?? 9999));
    const id = identityOf(c);
    const subKeywords =
      id.siteMode === "public" && id.user
        ? loadUserSubscriptions(id.user.id)
        : all<{ keyword: string }>("SELECT keyword FROM subscriptions").map((r) => r.keyword);
    return c.json({
      date: row.date,
      created_at: row.created_at,
      pushed_at: row.pushed_at,
      text,
      report,
      count: ids.length,
      items: applyUserStates(
        items.map((r) => shape(r, subKeywords)),
        id.siteMode === "public" ? (id.user?.id ?? null) : null,
      ),
    });
  });

  /* ================================================================== *
   * 公开站：登录用户个人接口（/api/me/*）
   * 与自建站的全局接口严格分开：这里只读写当前用户自己的数据。
   * ================================================================== */

  registerAuthRoutes(app);

  const currentUserId = (c: any): number => {
    const id = identityOf(c);
    if (!id.user) throw new Error("需要登录");
    return id.user.id;
  };

  function upsertUserState(
    userId: number,
    itemId: number,
    patch: { hidden?: boolean; starred?: boolean; read?: boolean },
  ): void {
    const now = new Date().toISOString();
    const cur = get<{ hidden: number; starred: number; read_at: string | null }>(
      "SELECT hidden, starred, read_at FROM user_item_states WHERE user_id = ? AND item_id = ?",
      userId,
      itemId,
    );
    const hidden = patch.hidden ?? (cur?.hidden === 1);
    const starred = patch.starred ?? (cur?.starred === 1);
    const readAt = patch.read === undefined ? (cur?.read_at ?? null) : patch.read ? now : null;
    run(
      "INSERT INTO user_item_states (user_id, item_id, hidden, starred, read_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(user_id, item_id) DO UPDATE SET hidden = excluded.hidden, starred = excluded.starred, read_at = excluded.read_at, updated_at = excluded.updated_at",
      userId,
      itemId,
      hidden ? 1 : 0,
      starred ? 1 : 0,
      readAt,
      now,
    );
  }

  app.patch("/api/me/items/:id", async (c) => {
    const userId = currentUserId(c);
    const itemId = Number(c.req.param("id"));
    if (!Number.isFinite(itemId)) return c.json({ error: "bad id" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { starred?: boolean; status?: string; read?: boolean };
    const patch: { hidden?: boolean; starred?: boolean; read?: boolean } = {};
    if (typeof body.starred === "boolean") patch.starred = body.starred;
    if (typeof body.read === "boolean") patch.read = body.read;
    if (body.status === "ignored") patch.hidden = true;
    else if (body.status === "active") patch.hidden = false;
    if (!Object.keys(patch).length) return c.json({ error: "nothing to update" }, 400);
    upsertUserState(userId, itemId, patch);
    const row = get<ItemRow>("SELECT * FROM items WHERE id = ?", itemId);
    if (!row) return c.json({ error: "not found" }, 404);
    const shaped = shape(row, loadUserSubscriptions(userId));
    return c.json(applyUserStates([shaped], userId)[0]);
  });

  app.post("/api/me/items/batch", async (c) => {
    const userId = currentUserId(c);
    const body = (await c.req.json().catch(() => null)) as { ids?: number[]; action?: string } | null;
    if (!body?.ids?.length || !body.action) return c.json({ error: "ids 与 action 必填" }, 400);
    const ids = body.ids.filter((n) => Number.isInteger(n)).slice(0, 200);
    if (!ids.length) return c.json({ updated: 0 });
    for (const itemId of ids) {
      if (body.action === "read") upsertUserState(userId, itemId, { read: true });
      else if (body.action === "unread") upsertUserState(userId, itemId, { read: false });
      else if (body.action === "ignore") upsertUserState(userId, itemId, { hidden: true });
      else if (body.action === "restore") upsertUserState(userId, itemId, { hidden: false });
      else return c.json({ error: "unsupported action" }, 400);
    }
    return c.json({ ok: true, updated: ids.length });
  });

  /** 访客在 localStorage 攒的偏好，登录后一键合并到账号 */
  app.post("/api/me/items/import-guest", async (c) => {
    const userId = currentUserId(c);
    const body = (await c.req.json().catch(() => null)) as {
      hidden?: number[];
      starred?: number[];
      read?: number[];
      blocked?: string[];
    } | null;
    if (!body) return c.json({ error: "invalid json" }, 400);
    if ([body.hidden, body.starred, body.read].some((arr) => Array.isArray(arr) && arr.length > 500)) {
      return c.json({ error: "单次最多合并每类 500 条偏好；本机数据未清除" }, 400);
    }
    const patterns = Array.isArray(body.blocked) ? [...new Set(body.blocked.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean))] : [];
    if (patterns.length > 100 || patterns.some((s) => s.length > 80)) return c.json({ error: "屏蔽词最多 100 条，每条不超过 80 字" }, 400);
    const ownPatterns = new Set(all<{ pattern: string }>("SELECT pattern FROM user_block_rules WHERE user_id = ?", userId).map((r) => r.pattern));
    if (ownPatterns.size + patterns.filter((s) => !ownPatterns.has(s)).length > 100) return c.json({ error: "合并后屏蔽规则超过 100 条，请先整理规则" }, 400);
    const clean = (arr: unknown): number[] =>
      Array.isArray(arr) ? arr.filter((n): n is number => Number.isInteger(n) && n > 0).slice(0, 500) : [];
    let imported = 0;
    tx(() => {
      for (const id of clean(body.hidden)) { upsertUserState(userId, id, { hidden: true }); imported += 1; }
      for (const id of clean(body.starred)) { upsertUserState(userId, id, { starred: true }); imported += 1; }
      for (const id of clean(body.read)) { upsertUserState(userId, id, { read: true }); imported += 1; }
      for (const pattern of patterns) run(
        "INSERT INTO user_block_rules(user_id, pattern, mode, scope, enabled, created_at) VALUES(?, ?, 'keyword', 'all', 1, ?) ON CONFLICT(user_id, pattern, scope) DO UPDATE SET enabled = 1, mode = 'keyword'",
        userId, pattern, new Date().toISOString(),
      );
    });
    return c.json({ ok: true, imported });
  });

  app.get("/api/me/overview", (c) => {
    const userId = currentUserId(c);
    const id = identityOf(c);
    const totals = get<{ starred: number; hidden: number; read: number }>(
      "SELECT SUM(starred) AS starred, SUM(hidden) AS hidden, SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) AS read FROM user_item_states WHERE user_id = ?",
      userId,
    );
    return c.json({
      user: id.user,
      totals: {
        starred: totals?.starred ?? 0,
        hidden: totals?.hidden ?? 0,
        read: totals?.read ?? 0,
      },
      push: userPushStats(userId),
      blockRules: get<{ n: number }>("SELECT COUNT(*) AS n FROM user_block_rules WHERE user_id = ? AND enabled = 1", userId)?.n ?? 0,
      subscriptions: get<{ n: number }>("SELECT COUNT(*) AS n FROM user_subscriptions WHERE user_id = ?", userId)?.n ?? 0,
    });
  });

  /* ---- 个人屏蔽词 ---- */
  app.get("/api/me/block-rules", (c) => {
    const userId = currentUserId(c);
    const rules = all<BlockRule>(
      "SELECT id, pattern, mode, scope, enabled, created_at FROM user_block_rules WHERE user_id = ? ORDER BY id DESC",
      userId,
    );
    const activeItems = all<{ id: number; source_id: string; title: string; summary: string | null }>(
      "SELECT id, source_id, title, summary FROM items WHERE status = 'active'",
    );
    const enriched = rules.map((r) => {
      const matcher = r.mode === "regex" ? () => false : compileRule(r);
      let hits = 0;
      for (const it of activeItems) {
        if (matcher(it.title + " " + (it.summary ?? ""), it.source_id)) hits += 1;
      }
      return { ...r, enabled: r.enabled === 1 && r.mode !== "regex", hits };
    });
    const enabledRules = rules.filter((r) => r.enabled === 1 && r.mode !== "regex");
    let totalBlocked = 0;
    if (enabledRules.length) {
      const matchers = enabledRules.map((r) => compileRule(r));
      for (const it of activeItems) {
        const text = it.title + " " + (it.summary ?? "");
        if (matchers.some((m) => m(text, it.source_id))) totalBlocked += 1;
      }
    }
    const cfg = getUserPushConfig(userId);
    return c.json({ rules: enriched, totalBlocked, presets: PRESET_NOISE_PATTERNS, useGlobalBlocks: cfg.useGlobalBlocks });
  });

  app.post("/api/me/block-rules", async (c) => {
    const userId = currentUserId(c);
    const body = (await c.req.json().catch(() => null)) as {
      pattern?: string;
      mode?: string;
      scope?: string;
      presets?: boolean;
    } | null;
    const now = new Date().toISOString();
    if (body?.presets) {
      const count = get<{ n: number }>("SELECT COUNT(*) AS n FROM user_block_rules WHERE user_id = ?", userId)?.n ?? 0;
      const additional = PRESET_NOISE_PATTERNS.filter((pr) => !get("SELECT id FROM user_block_rules WHERE user_id = ? AND pattern = ? AND scope = ?", userId, pr.pattern, pr.scope)).length;
      if (count + additional > 100) return c.json({ error: "导入后超过 100 条规则，请先删除不用的规则" }, 400);
      for (const pr of PRESET_NOISE_PATTERNS) {
        run(
          "INSERT INTO user_block_rules (user_id, pattern, mode, scope, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(user_id, pattern, scope) DO UPDATE SET enabled = 1",
          userId, pr.pattern, pr.mode, pr.scope, now,
        );
      }
      return c.json({ ok: true, added: PRESET_NOISE_PATTERNS.length });
    }
    const pattern = (body?.pattern ?? "").trim();
    if (!pattern || pattern.length > 80) return c.json({ error: "pattern 必填且不超过 80 字" }, 400);
    if (body?.mode === "regex") return c.json({ error: "个人屏蔽仅支持关键词，不支持正则表达式" }, 400);
    const mode = "keyword";
    const existing = get("SELECT id FROM user_block_rules WHERE user_id = ? AND pattern = ? AND scope = ?", userId, pattern, body?.scope ?? "all");
    if (!existing && (get<{ n: number }>("SELECT COUNT(*) AS n FROM user_block_rules WHERE user_id = ?", userId)?.n ?? 0) >= 100) {
      return c.json({ error: "个人屏蔽规则最多 100 条，请先删除不用的规则" }, 400);
    }
    const scope = (body?.scope ?? "all").trim() || "all";
    run(
      "INSERT INTO user_block_rules (user_id, pattern, mode, scope, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(user_id, pattern, scope) DO UPDATE SET mode = excluded.mode, enabled = 1",
      userId, pattern, mode, scope, now,
    );
    return c.json({ ok: true });
  });

  app.patch("/api/me/block-rules/:id", async (c) => {
    const userId = currentUserId(c);
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
    if (typeof body.enabled !== "boolean") return c.json({ error: "enabled required" }, 400);
    if (body.enabled && get<{ mode: string }>("SELECT mode FROM user_block_rules WHERE id = ? AND user_id = ?", Number(c.req.param("id")), userId)?.mode === "regex") {
      return c.json({ error: "个人正则规则已停用，请改成关键词" }, 400);
    }
    run("UPDATE user_block_rules SET enabled = ? WHERE id = ? AND user_id = ?", body.enabled ? 1 : 0, Number(c.req.param("id")), userId);
    return c.json({ ok: true });
  });

  app.delete("/api/me/block-rules/:id", (c) => {
    const userId = currentUserId(c);
    run("DELETE FROM user_block_rules WHERE id = ? AND user_id = ?", Number(c.req.param("id")), userId);
    return c.json({ ok: true });
  });

  /* ---- 个人关注词 ---- */
  app.get("/api/me/subscriptions", (c) => {
    const userId = currentUserId(c);
    const rows = all<{ id: number; keyword: string; created_at: string; last_hit_at: string | null }>(
      "SELECT id, keyword, created_at, last_hit_at FROM user_subscriptions WHERE user_id = ? ORDER BY keyword",
      userId,
    );
    const hits = get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE status = 'active'")?.n ?? 0;
    return c.json({ subscriptions: rows, activeItems: hits });
  });

  app.post("/api/me/subscriptions", async (c) => {
    const userId = currentUserId(c);
    const body = (await c.req.json().catch(() => null)) as { keyword?: string } | null;
    const keyword = (body?.keyword ?? "").trim();
    if (!keyword || keyword.length > 40) return c.json({ error: "keyword 必填且不超过 40 字" }, 400);
    if ((get<{ n: number }>("SELECT COUNT(*) AS n FROM user_subscriptions WHERE user_id = ?", userId)?.n ?? 0) >= 100 &&
        !get("SELECT id FROM user_subscriptions WHERE user_id = ? AND keyword = ?", userId, keyword)) {
      return c.json({ error: "个人关注词最多 100 个" }, 400);
    }
    run(
      "INSERT INTO user_subscriptions (user_id, keyword, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id, keyword) DO NOTHING",
      userId, keyword, new Date().toISOString(),
    );
    const rows = all<{ id: number; keyword: string; created_at: string; last_hit_at: string | null }>(
      "SELECT id, keyword, created_at, last_hit_at FROM user_subscriptions WHERE user_id = ? ORDER BY keyword",
      userId,
    );
    return c.json({ subscriptions: rows });
  });

  app.delete("/api/me/subscriptions/:id", (c) => {
    const userId = currentUserId(c);
    run("DELETE FROM user_subscriptions WHERE id = ? AND user_id = ?", Number(c.req.param("id")), userId);
    const rows = all<{ id: number; keyword: string; created_at: string; last_hit_at: string | null }>(
      "SELECT id, keyword, created_at, last_hit_at FROM user_subscriptions WHERE user_id = ? ORDER BY keyword",
      userId,
    );
    return c.json({ subscriptions: rows });
  });

  /* ---- 个人 Telegram Bot 推送 ---- */
  app.get("/api/me/push", (c) => {
    const userId = currentUserId(c);
    const cfg = getUserPushConfig(userId);
    return c.json({
      config: cfg,
      settings: cfg.settings,
      defaults: DEFAULT_SETTINGS,
      stats: userPushStats(userId),
      quiet: isQuietNow(cfg.settings),
      channel: cfg.settings.deliverVia,
      ready: cfg.settings.deliverVia === "webhook" ? Boolean(cfg.settings.webhookUrl) : cfg.hasToken && Boolean(cfg.chatId),
      caps: { maxPerHour: config.userPushMaxPerHour, maxPerInstant: config.userPushMaxPerInstant },
    });
  });

  app.patch("/api/me/push", async (c) => {
    const userId = currentUserId(c);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: "无效的请求体" }, 400);
    try {
      const cfg = saveUserPushConfig(userId, body as never);
      return c.json({ config: cfg, settings: cfg.settings, stats: userPushStats(userId), quiet: isQuietNow(cfg.settings) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/me/push/detect-chat", async (c) => {
    const userId = currentUserId(c);
    const limited = limitUserAction(c, userId, "detect");
    if (limited) return limited;
    const body = (await c.req.json().catch(() => ({}))) as { botToken?: string };
    let token = (body.botToken ?? "").trim();
    if (!token) {
      token = resolveUserBotToken(userId) ?? "";
      if (!token) return c.json({ error: "请先填写 Bot Token" }, 400);
    }
    if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) return c.json({ error: "Bot Token 格式不正确" }, 400);
    try {
      const chats = await detectTelegramChatIds(token);
      return c.json({ ok: true, chats });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/api/me/push/test", async (c) => {
    const userId = currentUserId(c);
    const limited = limitUserAction(c, userId, "test");
    if (limited) return limited;
    const cfg = getUserPushConfig(userId);
    const viaWebhook = cfg.settings.deliverVia === "webhook";
    if (viaWebhook ? !cfg.settings.webhookUrl : !cfg.hasToken || !cfg.chatId)
      return c.json({ error: viaWebhook ? "请先保存 webhook 地址" : "请先保存 Bot Token 与 Chat ID" }, 400);
    try {
      await sendTelegramToUser(userId, "🛰 资源雷达 · 个人推送测试消息\n" + new Date().toLocaleString("zh-CN"));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/api/me/push/preview", (c) => {
    const userId = currentUserId(c);
    return c.json(previewUserPush(userId, Math.min(Math.max(Number(c.req.query("limit") ?? 6), 1), 12)));
  });

  app.post("/api/me/push/flush", async (c) => {
    const userId = currentUserId(c);
    const limited = limitUserAction(c, userId, "flush");
    if (limited) return limited;
    const sent = await flushUserBatches(true, userId);
    return c.json({ ok: true, sent, queued: userPushStats(userId).queued });
  });

  app.get("/api/me/push/log", (c) => {
    const userId = currentUserId(c);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 30), 1), 100);
    return c.json({ logs: userPushLogs(userId, limit) });
  });

  /* ================================================================== *
   * 站长管理：访问控制 / 邀请码 / 用户 / 公告 / 版本更新
   * 全部要求 isAdmin（ADMIN_TOKEN），OAuth 登录不构成管理权限
   * ================================================================== */

  app.get("/api/admin/overview", async (c) => {
    const info = await getBuildInfo();
    return c.json({
      siteMode,
      build: info,
      access: getAccessControl(),
      onboarding: getOnboarding(),
      users: countUsers(),
      invites: listInviteCodes().codes.length,
      hostUpdateCommand: hostUpdateCommand(),
    });
  });

  app.get("/api/admin/access", (c) => c.json({ access: getAccessControl() }));

  app.patch("/api/admin/access", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: "无效的请求体" }, 400);
    return c.json({ access: saveAccessControl(body as never) });
  });

  app.get("/api/admin/invites", (c) => c.json(listInviteCodes()));

  app.post("/api/admin/invites", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      count?: number;
      maxUses?: number;
      note?: string;
      expiresDays?: number;
      customCode?: string;
    };
    const created = createInviteCodes({
      count: Number(body.count ?? 1),
      maxUses: Number(body.maxUses ?? 1),
      note: body.note,
      expiresDays: Number(body.expiresDays ?? 0),
      customCode: body.customCode,
    });
    return c.json({ ok: true, created, ...listInviteCodes() });
  });

  app.patch("/api/admin/invites/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { disabled?: boolean };
    if (typeof body.disabled !== "boolean") return c.json({ error: "disabled required" }, 400);
    const ok = toggleInviteCode(Number(c.req.param("id")), body.disabled);
    return c.json({ ok, ...listInviteCodes() });
  });

  app.delete("/api/admin/invites/:id", (c) => {
    const ok = deleteInviteCode(Number(c.req.param("id")));
    return c.json({ ok, ...listInviteCodes() });
  });

  app.get("/api/admin/users", (c) => c.json({ users: listUsers(Number(c.req.query("limit") ?? 200)) }));

  app.patch("/api/admin/users/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { disabled?: boolean };
    if (typeof body.disabled !== "boolean") return c.json({ error: "disabled required" }, 400);
    const ok = setUserDisabled(Number(c.req.param("id")), body.disabled);
    return c.json({ ok });
  });

  app.get("/api/admin/onboarding", (c) => c.json({ onboarding: getOnboarding() }));

  app.patch("/api/admin/onboarding", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: "无效的请求体" }, 400);
    return c.json({ onboarding: saveOnboarding(body as never) });
  });

  app.get("/api/admin/update/check", async (c) => {
    try {
      return c.json(await checkForUpdate());
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/admin/update/status", (c) => c.json({ job: getUpdateJob() }));

  app.post("/api/admin/update/run", async (c) => {
    try {
      return c.json({ job: await runUpdate() });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/upstream-watch", (c) => {
    const id = identityOf(c);
    if (id.siteMode === "public" && !id.isAdmin) {
      return c.json({ activeBanner: false });
    }
    return c.json(getUpstreamWatchState());
  });

  app.post("/api/upstream-watch/check", async (c) => {
    try {
      return c.json(await checkUpstreamUpdates({ force: true }));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/upstream-watch/dismiss", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { sha?: unknown } | null;
    const sha = typeof body?.sha === "string" ? body.sha : undefined;
    return c.json(dismissUpstreamWatch(sha));
  });

  /* ---------------------------------------------------------------- *
   * 赛道全景图谱（白皮书列表 / 详情 / AI 合成）
   * ---------------------------------------------------------------- */

  app.get("/api/tracks", (c) => {
    return c.json({
      tracks: listTracks(),
      synthesizing: isTrackSynthesisRunning(),
    });
  });

  app.get("/api/tracks/:slug", (c) => {
    const slug = c.req.param("slug");
    const track = getTrackDetail(slug);
    if (!track) return c.json({ error: "track not found" }, 404);

    const viewer = identityOf(c);
    const pubUser = viewer.siteMode === "public" ? (viewer.user?.id ?? null) : null;
    const subKeywords =
      viewer.siteMode === "public"
        ? pubUser !== null
          ? loadUserSubscriptions(pubUser)
          : []
        : all<{ keyword: string }>("SELECT keyword FROM subscriptions").map((r) => r.keyword);

    const ids = track.topItemIds.filter((id) => Number.isInteger(id) && id > 0).slice(0, 30);
    let items: ReturnType<typeof shape>[] = [];
    if (ids.length) {
      const ph = ids.map(() => "?").join(", ");
      const statusClause = viewer.siteMode === "public" && !viewer.isAdmin ? "AND status = 'active'" : "";
      const rows = all<ItemRow>(
        `SELECT ${LIST_COLUMNS} FROM items WHERE id IN (${ph}) ${statusClause}`,
        ...ids,
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ordered = ids.map((id) => byId.get(id)).filter((r): r is ItemRow => Boolean(r));
      items = applyUserStates(
        ordered.map((r) => shape(r, subKeywords)),
        pubUser,
      );
    }

    return c.json({ track, items });
  });

  app.post("/api/tracks/synthesize", async (c) => {
    if (isTrackSynthesisRunning()) {
      return c.json({ ok: true, running: true });
    }
    const body = (await c.req.json().catch(() => ({}))) as { wait?: boolean; maxTracks?: number };
    const maxTracks = typeof body.maxTracks === "number" ? body.maxTracks : undefined;
    if (body.wait === true) {
      try {
        const tracks = await synthesizeAllTracks({ maxTracks });
        return c.json({ ok: true, running: false, tracks });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
    void synthesizeAllTracks({ maxTracks }).catch((err) => {
      console.error("[tracks] 后台合成失败:", err instanceof Error ? err.message : err);
    });
    return c.json({ ok: true, running: true });
  });

  /* ================================================================== *
   * 项目自身 RSS 2.0 输出
   *   /rss.xml            公开 Feed（可带筛选参数）
   *   /api/rss            同上，给不方便走根路径的客户端
   *   /rss/u/:token.xml   个人专属 Feed（自动套用个人隐藏与个人屏蔽词）
   * ================================================================== */

  function rssQuery(
    q: Record<string, string | undefined>,
    rules: BlockRule[],
    scope: QueryScope,
    limit: number,
  ): RssItem[] {
    const { where, params } = buildItemsQuery({ ...q, status: q.status ?? "active" }, rules, false, scope);
    const clause = where.length ? "WHERE " + where.join(" AND ") : "";
    return all<RssItem>(
      "SELECT id, source_id, title, url, summary, content, category, kind, score, price, is_free, obtain, codes, " +
        "published_at, first_seen_at, expires_at, image_url, ai FROM items " + clause +
        " ORDER BY COALESCE(published_at, first_seen_at) DESC LIMIT ?",
      ...params,
      limit,
    );
  }

  function codesOf(raw: string): string[] {
    try {
      const arr = JSON.parse(raw || "[]") as unknown;
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  function aiKeepOf(raw: string | null): boolean | null {
    if (!raw) return null;
    try {
      const o = JSON.parse(raw) as { keep?: unknown };
      return typeof o.keep === "boolean" ? o.keep : null;
    } catch {
      return null;
    }
  }

  function baseUrl(c: any): string {
    const configured = config.publicBaseUrl;
    if (configured) return configured.replace(/\/+$/, "");
    try {
      return new URL(c.req.url).origin;
    } catch {
      return "";
    }
  }

  function sendFeed(c: any, items: RssItem[], title: string, description: string, selfPath: string, salt: string) {
    const etag = rssEtag(items, salt);
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    const xml = buildRssXml(items, {
      title,
      link: baseUrl(c) + "/",
      description,
      selfUrl: baseUrl(c) + selfPath,
      limit: items.length,
    });
    c.header("Content-Type", "application/rss+xml; charset=utf-8");
    c.header("Cache-Control", salt.startsWith("user-") ? "private, no-store" : "public, max-age=300");
    c.header("ETag", etag);
    return c.body(xml);
  }

  const publicFeed = (c: any) => {
    const q = c.req.query();
    const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 100);
    const rules = loadActiveBlockRules();
    const items = rssQuery(q, rules, { userId: null, publicMode: false }, limit);
    const qs = new URLSearchParams(q as Record<string, string>).toString();
    return sendFeed(
      c,
      items,
      "资源雷达 · 福利订阅",
      "全网福利、黑五好价、拼车交易、开源项目与新闻资讯的聚合订阅",
      "/rss.xml" + (qs ? "?" + qs : ""),
      "public",
    );
  };
  app.get("/rss.xml", publicFeed);
  app.get("/api/rss", publicFeed);

  app.get("/rss/u/:file", (c) => {
    const file = c.req.param("file");
    const token = file.replace(/\.xml$/i, "");
    const user = userByRssToken(token);
    if (!user) return c.text("RSS 链接无效或已被重置", 404);
    const q = c.req.query();
    const mode = q.mode === "push" || q.mode === "subs" ? q.mode : "feed";
    const limit = Math.min(Math.max(Number(q.limit ?? 50), 1), 100);
    const cfg = getUserPushConfig(user.id);
    const rules = loadUserBlockRules(user.id, cfg.useGlobalBlocks);
    let items = rssQuery(q, rules, { userId: user.id, publicMode: true }, mode === "feed" ? limit : 200);

    if (mode === "push") {
      items = items.filter((it) =>
        passesPushFilters(
          {
            sourceId: it.source_id,
            title: it.title,
            summary: it.summary,
            score: it.score,
            codes: codesOf(it.codes),
            price: it.price,
            isFree: it.is_free === 1,
            aiKeep: aiKeepOf(it.ai),
            kind: it.kind,
            category: it.category,
            obtain: it.obtain,
            publishedAt: it.published_at,
          },
          cfg.settings,
        ),
      );
    } else if (mode === "subs") {
      const subs = loadUserSubscriptions(user.id).map((k) => k.toLowerCase());
      items = items.filter((it) => {
        const hay = (it.title + " " + (it.summary ?? "")).toLowerCase();
        return subs.some((k) => hay.includes(k));
      });
    }

    return sendFeed(
      c,
      items.slice(0, limit),
      "资源雷达 · " + (user.name ?? user.username) + " 的订阅",
      mode === "push" ? "按我的推送规则输出" : mode === "subs" ? "只包含我关注的关键词" : "我的个人订阅（已排除我关掉的条目）",
      "/rss/u/" + token + ".xml" + (mode !== "feed" ? "?mode=" + mode : ""),
      "user-" + user.id + "-" + mode,
    );
  });
}
