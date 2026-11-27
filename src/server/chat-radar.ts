import { all, get, getDb, run, tx } from "./db.ts";
import {
  aiReady,
  getAiSettings,
  postChatCompletions,
  type AiSettings,
} from "./enrich/ai-settings.ts";
import { listManualBooks } from "./manuals.ts";
import { ScysAuthError, ScysMcpClient } from "./scys/mcp-client.ts";
import { matchActivityTrackSlug } from "../shared/manuals.ts";
import {
  CHAT_DIGEST_CATEGORIES,
  type ChatDigestCategory,
  type ChatDigestItem,
  type ChatDigestsResponse,
  type ChatGroupItem,
  type ChatGroupsResponse,
  type ChatGroupTier,
  type ChatMessageContextResponse,
  type ChatMessageItem,
  type ChatMessagesSearchResponse,
} from "../shared/chat-radar.ts";

export const DEFAULT_CHAT_DISTILL_MODEL = "gpt-6.2-sol:medium";

const VALID_DIGEST_CATEGORIES = new Set<string>(CHAT_DIGEST_CATEGORIES);

const PLACEHOLDER_RE = /^\[(图片|动画表情|表情|其他消息|红包|文件|视频|语音|位置|名片|小程序|链接)\]$/;
const ONLY_WECHAT_EMOJI_RE = /^(?:\[[^\]\r\n]{1,10}\]|[\s!！。.,，~～?？😆🤣😭👍❤️🎉🔥👏🙏🤝💪])+$/u;
const NOISE_EXACT_RE =
  /^(?:收到|好的|好哒|好滴|好嘞|行|ok+|okk+|roger|\+1|1|666+|888+|牛+|牛逼|牛掰|太牛了|牛掰大佬|厉害|强|赞|顶|蹲|插眼|马住|学习了|受教了|感恩|感谢|谢谢|多谢|哈哈+|笑死|确实|是的|没错|对头|有道理|加油|冲|共勉|晚安|早安|早上好|下午好|晚上好)(?:[!！。.~～\s😆🤣👍❤️🎉🔥👏🙏]*|\[[^\]]{1,10}\])*$/iu;
const THANKS_REVIEW_RE =
  /^(?:非常)?(?:感谢|谢谢|多谢|辛苦).{0,18}(?:点评|分享|解答|回复|指点|指导|整理|大佬|教练|老师)(?:[!！。.~～\s]|\[[^\]]{1,10}\])*$/u;

const CHAT_DISTILL_SYSTEM_PROMPT = [
  "你是「生财有术」高纯度社群情报官，负责从经过规则预筛的微信群聊记录中提纯一线暗线、实操排坑、工具渠道与教练/导师点评。",
  "",
  "### 核心提纯原则（务必严格遵守）",
  "1. **只保留高信噪比实战干货**：合并同一话题的多人往返讨论为一条完整洞察；坚决剔除闲聊寒暄、无结论纯提问、礼貌致谢、情绪共鸣、广告转发、无上下文的碎句。",
  "2. **高颗粒度细节还原**：`summary` 必须保留对话中出现的真实硬核细节——包括具体工具/平台/模型名称、命令/参数/配置、报错现象与解法、价格/费率/额度、账号风控或资质卡点（如个体户 vs 个人、免税州地址）、外部链接/帖子指向、以及教练点评给出的具体落地改法。禁止写成「讨论了某某问题」「分享了一些经验」之类的空话套话。",
  "3. **严禁编造（零幻觉底线）**：只陈述群聊原文明确提到的人名、工具、数值、因果结论与链接；原文未说明的原因或价格一概不许脑补；`keySpeakers` 只能填写该话题下实际贡献核心信息或点评的群友/教练原名。",
  "4. **宁缺毋滥**：如果本批聊天记录确实没有任何值得沉淀的实质干货（例如全是日常报到、纯提问无答案或闲聊），请直接返回空数组 `[]`。",
  "5. **分类四选一**：`category` 只能严格取以下四个值之一：",
  "   - `工具渠道`：值得关注的工具、API/镜像站/客户端、插件、风向标/MCP 渠道或高价值外链资源；",
  "   - `实操排坑`：具体报错、封号/风控触发条件、资质/备案/地址/支付卡点及已验证的绕过或解法；",
  "   - `导师点评`：教练/嘉宾/官方人员对具体项目或学员作业的拆解、需求验证方法、MVP 收窄建议；",
  "   - `变现思路`：具体的商业模式、选品切入点、获客/转化路径、算账数据或产品方向。",
  "",
  "### 输出格式要求",
  "严格只输出一个合法 JSON 数组（不要输出 Markdown 代码块标记 ```json，不要输出任何前后解释文字）。",
  "数组每个元素结构如下：",
  "{",
  '  "title": "12-28字精准标题，直击核心结论或工具/卡点",',
  '  "category": "工具渠道 | 实操排坑 | 导师点评 | 变现思路",',
  '  "summary": "100-260字高密度脱水总结，必须写清条件、具体工具/参数/价格/报错解法/教练建议，禁空话禁编造",',
  '  "keySpeakers": ["核心发言人1", "核心发言人2"]',
  "}",
].join("\n");

export type ScysChatMcpLike = Pick<ScysMcpClient, "callTool">;

export type SyncChatGroupsResult = {
  total: number;
  core: number;
  voyage: number;
  regional: number;
  enabled: number;
  linkedVoyage: number;
  inserted: number;
  updated: number;
};

export type SyncChatMessagesResult = {
  groupsTargeted: number;
  groupsSynced: number;
  fetchedMessages: number;
  insertedMessages: number;
  validInsertedMessages: number;
  errors: Array<{ groupKey: string; groupName: string; error: string }>;
};

export type DistillChatInsightsResult = {
  model: string;
  groupsCandidate: number;
  groupsProcessed: number;
  groupsSucceeded: number;
  digestsCreated: number;
  errors: Array<{ groupKey: string; groupName: string; error: string }>;
};

type ChatGroupDbRow = {
  group_key: string;
  platform: number;
  name: string;
  tier: string;
  enabled: number;
  linked_activity_id: string | null;
  message_count: number;
  valid_message_count: number;
  last_msg_time: number;
  last_synced_at: string | null;
  last_distilled_msg_time: number;
  digest_count?: number;
};

type ChatMessageDbRow = {
  group_key: string;
  group_name: string;
  tier: string;
  linked_activity_id: string | null;
  msg_id: string;
  msg_time: number;
  msg_type: number;
  sender_name: string;
  content: string;
  is_noise: number;
};

type ChatDigestDbRow = {
  id: number;
  group_key: string;
  group_name: string;
  linked_activity_id: string | null;
  category: string;
  title: string;
  summary: string;
  key_speakers: string;
  msg_time_from: number;
  msg_time_to: number;
  model: string;
  created_at: string;
};

let chatRadarTablesEnsured = false;

export function ensureChatRadarTables(): void {
  if (chatRadarTablesEnsured) {
    const g = get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='scys_chat_groups'");
    const m = get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='scys_chat_messages'");
    const d = get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='scys_chat_digests'");
    if (g && m && d) return;
  }

  getDb().exec(`
    CREATE TABLE IF NOT EXISTS scys_chat_groups (
      group_key TEXT PRIMARY KEY,
      platform INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'core',
      enabled INTEGER NOT NULL DEFAULT 1,
      linked_activity_id TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      valid_message_count INTEGER NOT NULL DEFAULT 0,
      last_msg_time INTEGER NOT NULL DEFAULT 0,
      last_synced_at TEXT,
      last_distilled_msg_time INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS scys_chat_messages (
      group_key TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      msg_time INTEGER NOT NULL,
      msg_type INTEGER NOT NULL DEFAULT 2001,
      sender_name TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      is_noise INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (group_key, msg_id)
    );
    CREATE INDEX IF NOT EXISTS idx_scys_chat_msg_group_time
      ON scys_chat_messages(group_key, msg_time DESC);
    CREATE INDEX IF NOT EXISTS idx_scys_chat_msg_valid_time
      ON scys_chat_messages(is_noise, msg_time DESC);

    CREATE TABLE IF NOT EXISTS scys_chat_digests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_key TEXT NOT NULL,
      group_name TEXT NOT NULL,
      linked_activity_id TEXT,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      key_speakers TEXT NOT NULL DEFAULT '[]',
      msg_time_from INTEGER NOT NULL DEFAULT 0,
      msg_time_to INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scys_chat_digests_group
      ON scys_chat_digests(group_key, msg_time_to DESC);
    CREATE INDEX IF NOT EXISTS idx_scys_chat_digests_act
      ON scys_chat_digests(linked_activity_id, msg_time_to DESC);
  `);
  chatRadarTablesEnsured = true;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function firstStr(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === "string" && val.trim()) return val.trim();
    if (typeof val === "number" && Number.isFinite(val)) return String(val);
  }
  return "";
}

function normalizeTier(raw: string): ChatGroupTier {
  if (raw === "regional" || raw === "voyage" || raw === "core") return raw;
  return "core";
}

function escapeSqlLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function splitSearchTokens(q: string | undefined): string[] {
  if (!q) return [];
  return q
    .trim()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8);
}

/**
 * 兼容 16 字微信群名截断与前置 `【Day9】` / `【第9天】` 标识：
 * 先直接调 `matchActivityTrackSlug`，未命中时剥离前置 `【...】` 再匹配一次。
 */
function matchChatGroupTrackSlug(name: string): string | null {
  const direct = matchActivityTrackSlug(name);
  if (direct) return direct;
  const stripped = name.replace(/^\s*(?:【[^】]+】\s*)+/g, "").trim();
  if (stripped && stripped !== name.trim()) {
    return matchActivityTrackSlug(stripped);
  }
  return null;
}

/**
 * 群分层与默认启用规则：
 * - `^AI\s*有术` -> `regional`（默认关闭）
 * - 含 `航海` 或命中大航海赛道 slug -> `voyage`（默认开启）
 * - 其余核心内测/垂类交流群 -> `core`（默认开启）
 */
export function classifyChatGroupTier(name: string): ChatGroupTier {
  const trimmed = name.trim();
  if (/^AI\s*有术/i.test(trimmed)) return "regional";
  if (/航海/.test(trimmed) || matchChatGroupTrackSlug(trimmed) !== null) return "voyage";
  return "core";
}

function loadBookTitleMaps(): {
  latestBySlug: Map<string, { activityId: string; title: string; numericId: number }>;
  titleByActivityId: Map<string, string>;
} {
  const latestBySlug = new Map<string, { activityId: string; title: string; numericId: number }>();
  const titleByActivityId = new Map<string, string>();
  try {
    const books = listManualBooks();
    for (const book of books) {
      titleByActivityId.set(book.activityId, book.title);
      const slug = matchActivityTrackSlug(book.title);
      if (!slug) continue;
      const numericId = /^\d+$/.test(book.activityId) ? Number(book.activityId) : -1;
      const prev = latestBySlug.get(slug);
      if (!prev || numericId > prev.numericId) {
        latestBySlug.set(slug, { activityId: book.activityId, title: book.title, numericId });
      }
    }
  } catch {
    // 单元测试或未建 items 表场景下优雅降级为空映射
  }
  return { latestBySlug, titleByActivityId };
}

/** 合并链接/小程序卡片的 `shareTitle` / `shareDesc` / `shareUrl` 为可检索纯文本。 */
export function formatRawChatMessage(raw: unknown): string {
  const m = asRecord(raw);
  if (!m) return "";
  const content = String(m.content ?? "").trim();
  const shareTitle = String(m.shareTitle ?? "").trim();
  const shareDesc = String(m.shareDesc ?? "").trim();
  const shareUrl = String(m.shareUrl ?? "").trim();
  const msgType = Number(m.msgType ?? 2001);

  if ((msgType === 2005 || msgType === 2013 || PLACEHOLDER_RE.test(content) || !content) && (shareTitle || shareUrl)) {
    const parts = [content || (msgType === 2013 ? "[小程序]" : "[链接]")];
    if (shareTitle) parts.push(`标题:${shareTitle.replace(/\s+/g, " ").slice(0, 160)}`);
    if (shareDesc) parts.push(`来源:${shareDesc.replace(/\s+/g, " ").slice(0, 60)}`);
    if (shareUrl) parts.push(`链接:${shareUrl}`);
    return parts.join(" | ");
  }
  return content;
}

/** 0-Token 规则过滤系统消息、纯表情占位符、礼貌复读与 3 条内短句接龙重复。 */
export function isChatNoiseMessage(
  text: string,
  msgType = 2001,
  recentNorms: readonly string[] = [],
): boolean {
  const norm = text.replace(/\s+/g, " ").trim();
  if (!norm || msgType === 1000) return true;
  if (PLACEHOLDER_RE.test(norm) || ONLY_WECHAT_EMOJI_RE.test(norm)) return true;
  if (NOISE_EXACT_RE.test(norm) || THANKS_REVIEW_RE.test(norm)) return true;

  const prevNorm = recentNorms.length > 0 ? recentNorms[recentNorms.length - 1] : "";
  if (norm.length <= 80 && norm === prevNorm) return true;
  if (norm.length <= 40 && recentNorms.slice(-3).includes(norm)) return true;
  return false;
}

function mapGroupRow(
  row: ChatGroupDbRow,
  titleByActivityId: Map<string, string>,
): ChatGroupItem {
  const linkedActivityId = row.linked_activity_id?.trim() || null;
  return {
    groupKey: row.group_key,
    platform: Number(row.platform ?? 1),
    name: row.name,
    tier: normalizeTier(row.tier),
    enabled: Boolean(row.enabled),
    linkedActivityId,
    linkedBookTitle: linkedActivityId ? (titleByActivityId.get(linkedActivityId) ?? null) : null,
    messageCount: Number(row.message_count ?? 0),
    validMessageCount: Number(row.valid_message_count ?? 0),
    digestCount: Number(row.digest_count ?? 0),
    lastMsgTime: Number(row.last_msg_time ?? 0),
    lastSyncedAt: row.last_synced_at ?? null,
    lastDistilledMsgTime: Number(row.last_distilled_msg_time ?? 0),
  };
}

function mapMessageRow(row: ChatMessageDbRow): ChatMessageItem {
  return {
    groupKey: row.group_key,
    groupName: row.group_name,
    tier: normalizeTier(row.tier),
    linkedActivityId: row.linked_activity_id?.trim() || null,
    msgId: row.msg_id,
    msgTime: Number(row.msg_time ?? 0),
    msgType: Number(row.msg_type ?? 2001),
    senderName: row.sender_name,
    content: row.content,
    isNoise: Boolean(row.is_noise),
  };
}

function mapDigestRow(
  row: ChatDigestDbRow,
  titleByActivityId: Map<string, string>,
): ChatDigestItem {
  let keySpeakers: string[] = [];
  try {
    const parsed = JSON.parse(row.key_speakers || "[]");
    if (Array.isArray(parsed)) {
      keySpeakers = parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    }
  } catch {
    keySpeakers = [];
  }
  const linkedActivityId = row.linked_activity_id?.trim() || null;
  const cat = VALID_DIGEST_CATEGORIES.has(row.category)
    ? (row.category as ChatDigestCategory)
    : "实操排坑";
  return {
    id: Number(row.id),
    groupKey: row.group_key,
    groupName: row.group_name,
    linkedActivityId,
    linkedBookTitle: linkedActivityId ? (titleByActivityId.get(linkedActivityId) ?? null) : null,
    category: cat,
    title: row.title,
    summary: row.summary,
    keySpeakers,
    msgTimeFrom: Number(row.msg_time_from ?? 0),
    msgTimeTo: Number(row.msg_time_to ?? 0),
    model: row.model,
    createdAt: row.created_at,
  };
}

/** 分页同步全部可读微信群目录，按赛道规则自动分层并挂载最新一期航海手册。 */
export async function syncChatGroupsCatalog(
  options: {
    client?: ScysChatMcpLike;
    log?: (m: string) => void;
  } = {},
): Promise<SyncChatGroupsResult> {
  ensureChatRadarTables();
  const client = options.client ?? new ScysMcpClient({ maxConcurrencyPerSlot: 3, minIntervalMs: 550 });
  const log = options.log ?? (() => {});

  const pageSize = 100;
  const deduped = new Map<string, { groupKey: string; platform: number; name: string }>();

  for (let pageIndex = 1; pageIndex <= 20; pageIndex += 1) {
    const resp = await client.callTool<Record<string, unknown>>("listMyChatGroups", {
      pageIndex,
      pageSize,
    });
    const rawItems = Array.isArray(resp?.items) ? resp.items : [];
    for (const raw of rawItems) {
      const rec = asRecord(raw);
      if (!rec) continue;
      const groupKey = firstStr(rec, ["groupKey", "group_key", "id"]);
      if (!groupKey) continue;
      const platform = Number(rec.platform ?? 1) || 1;
      const name = firstStr(rec, ["name", "groupName", "title", "roomName"]) || groupKey;
      deduped.set(groupKey, { groupKey, platform, name });
    }
    const total = Number(resp?.total ?? 0);
    if (rawItems.length < pageSize || (total > 0 && pageIndex * pageSize >= total)) {
      break;
    }
  }

  const { latestBySlug } = loadBookTitleMaps();
  const groups = [...deduped.values()];

  let core = 0;
  let voyage = 0;
  let regional = 0;
  let linkedVoyage = 0;
  let inserted = 0;
  let updated = 0;

  const existingKeys = new Set(
    all<{ group_key: string }>("SELECT group_key FROM scys_chat_groups").map((r) => r.group_key),
  );

  tx(() => {
    const stmt = getDb().prepare(
      `INSERT INTO scys_chat_groups (group_key, platform, name, tier, enabled, linked_activity_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(group_key) DO UPDATE SET
         platform = excluded.platform,
         name = excluded.name,
         tier = excluded.tier,
         linked_activity_id = COALESCE(NULLIF(excluded.linked_activity_id, ''), scys_chat_groups.linked_activity_id)`,
    );

    for (const g of groups) {
      const tier = classifyChatGroupTier(g.name);
      if (tier === "core") core += 1;
      else if (tier === "voyage") voyage += 1;
      else regional += 1;

      const defaultEnabled = tier === "regional" ? 0 : 1;
      const slug = tier === "voyage" ? matchChatGroupTrackSlug(g.name) : null;
      const linkedActivityId = slug ? (latestBySlug.get(slug)?.activityId ?? null) : null;
      if (tier === "voyage" && linkedActivityId) linkedVoyage += 1;

      stmt.run(g.groupKey, g.platform, g.name, tier, defaultEnabled, linkedActivityId);
      if (existingKeys.has(g.groupKey)) updated += 1;
      else inserted += 1;
    }
  });

  const enabledCount =
    get<{ n: number }>("SELECT COUNT(*) AS n FROM scys_chat_groups WHERE enabled = 1")?.n ?? 0;

  log(
    `[chat-radar] 群目录同步完成: 总计=${groups.length} (core=${core}, voyage=${voyage}, regional=${regional}), 启用=${enabledCount}, 已挂载手册=${linkedVoyage}`,
  );

  return {
    total: groups.length,
    core,
    voyage,
    regional,
    enabled: enabledCount,
    linkedVoyage,
    inserted,
    updated,
  };
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!items.length) return;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      await worker(items[idx]!, idx);
    }
  });
  await Promise.all(workers);
}

/** 增量同步目标微信群聊天记录（支持首次 14 天回溯 + 冷门群最新 100 条兜底 + 游标顺读）。 */
export async function syncChatGroupMessages(
  options: {
    groupKey?: string;
    activityId?: string;
    tier?: ChatGroupTier;
    lookbackDays?: number;
    maxPagesPerGroup?: number;
    concurrency?: number;
    intervalMs?: number;
    client?: ScysChatMcpLike;
    log?: (m: string) => void;
  } = {},
): Promise<SyncChatMessagesResult> {
  ensureChatRadarTables();
  const concurrency = Math.max(1, Math.min(8, Math.round(options.concurrency ?? 3)));
  const intervalMs = Math.max(0, Math.round(options.intervalMs ?? 550));
  const lookbackDays = Math.max(1, Math.min(90, Math.round(options.lookbackDays ?? 14)));
  const maxPagesPerGroup = Math.max(1, Math.min(50, Math.round(options.maxPagesPerGroup ?? 10)));
  const log = options.log ?? (() => {});

  const client =
    options.client ??
    new ScysMcpClient({
      maxConcurrencyPerSlot: concurrency,
      minIntervalMs: intervalMs,
    });

  const existingCount = get<{ n: number }>("SELECT COUNT(*) AS n FROM scys_chat_groups")?.n ?? 0;
  if (existingCount === 0) {
    await syncChatGroupsCatalog({ client, log });
  }

  let targets: ChatGroupDbRow[] = [];
  if (options.groupKey?.trim()) {
    const single = get<ChatGroupDbRow>(
      "SELECT * FROM scys_chat_groups WHERE group_key = ?",
      options.groupKey.trim(),
    );
    if (single) targets = [single];
  } else {
    const where: string[] = ["enabled = 1"];
    const args: Array<string | number> = [];
    if (options.activityId?.trim()) {
      where.push("linked_activity_id = ?");
      args.push(options.activityId.trim());
    }
    if (options.tier) {
      where.push("tier = ?");
      args.push(options.tier);
    }
    targets = all<ChatGroupDbRow>(
      `SELECT * FROM scys_chat_groups
        WHERE ${where.join(" AND ")}
        ORDER BY CASE tier WHEN 'core' THEN 1 WHEN 'voyage' THEN 2 ELSE 3 END, last_msg_time DESC, group_key ASC`,
      ...args,
    );
  }

  if (!targets.length) {
    return {
      groupsTargeted: 0,
      groupsSynced: 0,
      fetchedMessages: 0,
      insertedMessages: 0,
      validInsertedMessages: 0,
      errors: [],
    };
  }

  const pageSize = 100;
  let groupsSynced = 0;
  let fetchedMessages = 0;
  let insertedMessages = 0;
  let validInsertedMessages = 0;
  const errors: Array<{ groupKey: string; groupName: string; error: string }> = [];

  await runWithConcurrency(targets, concurrency, async (group) => {
    try {
      const collectedMap = new Map<string, Record<string, unknown>>();
      const lastMsgTime = Number(group.last_msg_time ?? 0);
      const isIncremental = lastMsgTime > 0;
      const msgTimeFrom = isIncremental
        ? lastMsgTime + 1
        : Math.floor(Date.now() / 1000) - lookbackDays * 86400;

      for (let pageIndex = 1; pageIndex <= maxPagesPerGroup; pageIndex += 1) {
        const resp = await client.callTool<Record<string, unknown>>("getMyChatGroupMessages", {
          groupKey: group.group_key,
          platform: group.platform,
          msgTimeFrom,
          pageIndex,
          pageSize,
        });
        const items = Array.isArray(resp?.items) ? resp.items : [];
        for (const raw of items) {
          const rec = asRecord(raw);
          if (!rec) continue;
          const formatted = formatRawChatMessage(rec);
          const msgTime = Math.floor(Number(rec.msgTime ?? 0));
          const senderName = String(rec.senderName ?? "").trim();
          const msgId =
            firstStr(rec, ["msgId", "id"]) || `${msgTime}-${senderName}-${formatted.slice(0, 24)}`;
          collectedMap.set(msgId, { ...rec, msgId });
        }
        if (items.length < pageSize) break;
      }

      // 首次回溯近 14 天无消息的冷门群：不带 msgTimeFrom 回退拉取最新 100 条兜底
      if (!isIncremental && collectedMap.size === 0) {
        const fallbackResp = await client.callTool<Record<string, unknown>>("getMyChatGroupMessages", {
          groupKey: group.group_key,
          platform: group.platform,
          pageIndex: 1,
          pageSize,
        });
        const fallbackItems = Array.isArray(fallbackResp?.items) ? fallbackResp.items : [];
        for (const raw of fallbackItems) {
          const rec = asRecord(raw);
          if (!rec) continue;
          const formatted = formatRawChatMessage(rec);
          const msgTime = Math.floor(Number(rec.msgTime ?? 0));
          const senderName = String(rec.senderName ?? "").trim();
          const msgId =
            firstStr(rec, ["msgId", "id"]) || `${msgTime}-${senderName}-${formatted.slice(0, 24)}`;
          collectedMap.set(msgId, { ...rec, msgId });
        }
      }

      const sorted = [...collectedMap.values()].sort((a, b) => {
        const dt = Number(a.msgTime ?? 0) - Number(b.msgTime ?? 0);
        if (dt !== 0) return dt;
        return String(a.msgId).localeCompare(String(b.msgId));
      });

      const recentSeedRows = all<{ content: string }>(
        `SELECT content FROM scys_chat_messages
          WHERE group_key = ? AND is_noise = 0
          ORDER BY msg_time DESC, msg_id DESC
          LIMIT 3`,
        group.group_key,
      );
      const recentNorms = recentSeedRows
        .reverse()
        .map((r) => r.content.replace(/\s+/g, " ").trim())
        .filter(Boolean);

      let batchInserted = 0;
      let batchValidInserted = 0;
      const nowIso = new Date().toISOString();

      tx(() => {
        const insertStmt = getDb().prepare(
          `INSERT OR IGNORE INTO scys_chat_messages
             (group_key, msg_id, msg_time, msg_type, sender_name, content, is_noise)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );

        for (const rec of sorted) {
          const msgId = String(rec.msgId);
          const msgTime = Math.floor(Number(rec.msgTime ?? 0));
          const msgType = Number(rec.msgType ?? 2001) || 2001;
          const senderName = String(rec.senderName ?? "").trim();
          const text = formatRawChatMessage(rec);
          const noise = isChatNoiseMessage(text, msgType, recentNorms) ? 1 : 0;

          const res = insertStmt.run(
            group.group_key,
            msgId,
            msgTime,
            msgType,
            senderName,
            text,
            noise,
          );
          if (Number(res.changes ?? 0) > 0) {
            batchInserted += 1;
            if (noise === 0) {
              batchValidInserted += 1;
              recentNorms.push(text.replace(/\s+/g, " ").trim());
              if (recentNorms.length > 3) recentNorms.shift();
            }
          }
        }

        const counts = get<{ total_count: number; valid_count: number | null; max_msg_time: number }>(
          `SELECT COUNT(*) AS total_count,
                  SUM(CASE WHEN is_noise = 0 THEN 1 ELSE 0 END) AS valid_count,
                  COALESCE(MAX(msg_time), 0) AS max_msg_time
             FROM scys_chat_messages
            WHERE group_key = ?`,
          group.group_key,
        );

        run(
          `UPDATE scys_chat_groups
              SET message_count = ?,
                  valid_message_count = ?,
                  last_msg_time = MAX(last_msg_time, ?),
                  last_synced_at = ?
            WHERE group_key = ?`,
          Number(counts?.total_count ?? 0),
          Number(counts?.valid_count ?? 0),
          Number(counts?.max_msg_time ?? 0),
          nowIso,
          group.group_key,
        );
      });

      groupsSynced += 1;
      fetchedMessages += sorted.length;
      insertedMessages += batchInserted;
      validInsertedMessages += batchValidInserted;
      if (batchInserted > 0) {
        log(
          `[chat-radar] ${group.name}: 拉取 ${sorted.length} 条, 新增 ${batchInserted} 条 (有效 ${batchValidInserted} 条)`,
        );
      }
    } catch (err) {
      if (err instanceof ScysAuthError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ groupKey: group.group_key, groupName: group.name, error: msg });
      log(`[chat-radar] 同步失败 ${group.name}: ${msg}`);
    }
  });

  return {
    groupsTargeted: targets.length,
    groupsSynced,
    fetchedMessages,
    insertedMessages,
    validInsertedMessages,
    errors,
  };
}

function formatChinaTimeShort(unixSec: number): string {
  const ms = (unixSec + 8 * 3600) * 1000;
  return new Date(ms).toISOString().replace("T", " ").slice(5, 16);
}

function parseJsonArrayLenient(raw: string): unknown[] | null {
  const trimmed = raw.trim();
  try {
    const direct = JSON.parse(trimmed);
    if (Array.isArray(direct)) return direct;
  } catch {
    // fall through to code fence / bracket extraction
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]?.trim() ?? trimmed;
  const start = fenced.indexOf("[");
  const end = fenced.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const sliced = JSON.parse(fenced.slice(start, end + 1));
      if (Array.isArray(sliced)) return sliced;
    } catch {
      return null;
    }
  }
  return null;
}

/** 对未提纯的群聊有效消息进行高信噪比四分类 AI 提纯并落盘 `scys_chat_digests`。 */
export async function distillChatGroupInsights(
  options: {
    groupKey?: string;
    activityId?: string;
    model?: string;
    minPendingMessages?: number;
    limitGroups?: number;
    maxMessagesPerGroup?: number;
    concurrency?: number;
    aiSettings?: AiSettings;
    fetchImpl?: typeof fetch;
    log?: (m: string) => void;
  } = {},
): Promise<DistillChatInsightsResult> {
  ensureChatRadarTables();
  const s = options.aiSettings ?? getAiSettings();
  const model = options.model?.trim() || DEFAULT_CHAT_DISTILL_MODEL;
  if (!aiReady({ ...s, enabled: true, model })) {
    throw new Error("AI 未配置端点或模型，无法执行群聊 AI 提纯");
  }

  const log = options.log ?? (() => {});
  const minPending = Math.max(1, Math.round(options.minPendingMessages ?? 8));
  const limitGroups = Math.max(1, Math.min(100, Math.round(options.limitGroups ?? 12)));
  const maxMsgs = Math.max(20, Math.min(300, Math.round(options.maxMessagesPerGroup ?? 180)));
  const concurrency = Math.max(1, Math.min(4, Math.round(options.concurrency ?? 2)));

  const where: string[] = [];
  const args: Array<string | number> = [];

  if (options.groupKey?.trim()) {
    where.push("g.group_key = ?");
    args.push(options.groupKey.trim());
  } else {
    where.push("g.enabled = 1");
    if (options.activityId?.trim()) {
      where.push("g.linked_activity_id = ?");
      args.push(options.activityId.trim());
    }
  }

  const candidates = all<ChatGroupDbRow & { pending_count: number }>(
    `SELECT g.*,
            COUNT(m.msg_id) AS pending_count
       FROM scys_chat_groups g
       JOIN scys_chat_messages m
         ON m.group_key = g.group_key
        AND m.is_noise = 0
        AND m.msg_time > g.last_distilled_msg_time
      WHERE ${where.join(" AND ")}
      GROUP BY g.group_key
     HAVING COUNT(m.msg_id) >= ?
      ORDER BY pending_count DESC, g.last_msg_time DESC
      LIMIT ?`,
    ...args,
    minPending,
    limitGroups,
  );

  if (!candidates.length) {
    return {
      model,
      groupsCandidate: 0,
      groupsProcessed: 0,
      groupsSucceeded: 0,
      digestsCreated: 0,
      errors: [],
    };
  }

  let groupsProcessed = 0;
  let groupsSucceeded = 0;
  let digestsCreated = 0;
  const errors: Array<{ groupKey: string; groupName: string; error: string }> = [];

  await runWithConcurrency(candidates, concurrency, async (group) => {
    groupsProcessed += 1;
    try {
      const latestDesc = all<{
        msg_id: string;
        msg_time: number;
        sender_name: string;
        content: string;
      }>(
        `SELECT msg_id, msg_time, sender_name, content
           FROM scys_chat_messages
          WHERE group_key = ? AND is_noise = 0 AND msg_time > ?
          ORDER BY msg_time DESC, msg_id DESC
          LIMIT ?`,
        group.group_key,
        Number(group.last_distilled_msg_time ?? 0),
        maxMsgs,
      );
      if (!latestDesc.length) return;

      const batchMsgs = latestDesc.reverse();
      const batchFrom = Number(batchMsgs[0]!.msg_time);
      const batchTo = Number(batchMsgs[batchMsgs.length - 1]!.msg_time);

      const transcript = batchMsgs
        .map((m) => {
          const dt = formatChinaTimeShort(Number(m.msg_time));
          const sender = (m.sender_name || "匿名").trim();
          const body = m.content.replace(/\n+/g, " ⏎ ");
          return `[${dt}] ${sender}: ${body}`;
        })
        .join("\n");

      const userPrompt = [
        `以下是生财有术微信群「${group.name}」经过 0-Token 预筛后的 ${batchMsgs.length} 条有效聊天记录（已按时间从早到晚排序）：`,
        "",
        transcript,
        "",
        "请按系统要求提取出所有值得沉淀的高信噪比实战干货洞察，严格输出 JSON 数组。",
      ].join("\n");

      const { res } = await postChatCompletions({
        baseUrl: s.baseUrl,
        apiKey: s.apiKey,
        model,
        messages: [
          { role: "system", content: CHAT_DISTILL_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        signal: AbortSignal.timeout(Math.max((s.timeoutSec || 75) * 1000, 120_000)),
        fetchImpl: options.fetchImpl,
      });

      const rawText = await res.text();
      if (!res.ok) {
        throw new Error(`AI 请求失败 (HTTP ${res.status}): ${rawText.slice(0, 200)}`);
      }

      const payload = JSON.parse(rawText) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = String(payload?.choices?.[0]?.message?.content ?? "");
      const parsedItems = parseJsonArrayLenient(content);
      if (!parsedItems) {
        throw new Error("模型未返回合法 JSON 数组");
      }

      const validItems: Array<{
        category: ChatDigestCategory;
        title: string;
        summary: string;
        keySpeakers: string[];
      }> = [];

      for (const rawItem of parsedItems) {
        const rec = asRecord(rawItem);
        if (!rec) continue;
        const category = typeof rec.category === "string" ? rec.category.trim() : "";
        const title = typeof rec.title === "string" ? rec.title.trim().slice(0, 120) : "";
        const summary = typeof rec.summary === "string" ? rec.summary.trim().slice(0, 1200) : "";
        if (!VALID_DIGEST_CATEGORIES.has(category) || !title || !summary) continue;

        const keySpeakers = Array.isArray(rec.keySpeakers)
          ? [
              ...new Set(
                rec.keySpeakers
                  .filter((x): x is string => typeof x === "string")
                  .map((x) => x.trim().slice(0, 60))
                  .filter(Boolean),
              ),
            ].slice(0, 10)
          : [];

        validItems.push({
          category: category as ChatDigestCategory,
          title,
          summary,
          keySpeakers,
        });
      }

      const nowIso = new Date().toISOString();
      tx(() => {
        const insertDigest = getDb().prepare(
          `INSERT INTO scys_chat_digests
             (group_key, group_name, linked_activity_id, category, title, summary, key_speakers, msg_time_from, msg_time_to, model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        for (const item of validItems) {
          insertDigest.run(
            group.group_key,
            group.name,
            group.linked_activity_id ?? null,
            item.category,
            item.title,
            item.summary,
            JSON.stringify(item.keySpeakers),
            batchFrom,
            batchTo,
            model,
            nowIso,
          );
        }

        run(
          `UPDATE scys_chat_groups
              SET last_distilled_msg_time = MAX(last_distilled_msg_time, ?)
            WHERE group_key = ?`,
          batchTo,
          group.group_key,
        );
      });

      groupsSucceeded += 1;
      digestsCreated += validItems.length;
      log(
        `[chat-radar] AI 提纯完成 ${group.name}: 送审 ${batchMsgs.length} 条 -> 产出 ${validItems.length} 条洞察`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ groupKey: group.group_key, groupName: group.name, error: msg });
      log(`[chat-radar] AI 提纯失败 ${group.name}: ${msg}`);
    }
  });

  return {
    model,
    groupsCandidate: candidates.length,
    groupsProcessed,
    groupsSucceeded,
    digestsCreated,
    errors,
  };
}

/** 获取群聊雷达全局统计与筛选后的群源列表。 */
export function getChatGroupsOverview(
  filter: {
    tier?: ChatGroupTier;
    enabledOnly?: boolean;
    activityId?: string;
    q?: string;
  } = {},
): ChatGroupsResponse {
  ensureChatRadarTables();
  const { titleByActivityId } = loadBookTitleMaps();

  const allRows = all<ChatGroupDbRow>(
    `SELECT g.*,
            COALESCE(d.cnt, 0) AS digest_count
       FROM scys_chat_groups g
       LEFT JOIN (
         SELECT group_key, COUNT(*) AS cnt
           FROM scys_chat_digests
          GROUP BY group_key
       ) d ON d.group_key = g.group_key
      ORDER BY g.enabled DESC,
               CASE g.tier WHEN 'core' THEN 1 WHEN 'voyage' THEN 2 ELSE 3 END,
               g.last_msg_time DESC,
               g.valid_message_count DESC,
               g.name ASC`,
  );

  let enabledGroups = 0;
  let coreGroups = 0;
  let voyageGroups = 0;
  let regionalGroups = 0;
  let totalMessages = 0;
  let validMessages = 0;
  let totalDigests = 0;

  const allItems = allRows.map((row) => {
    const item = mapGroupRow(row, titleByActivityId);
    if (item.enabled) enabledGroups += 1;
    if (item.tier === "core") coreGroups += 1;
    else if (item.tier === "voyage") voyageGroups += 1;
    else regionalGroups += 1;
    totalMessages += item.messageCount;
    validMessages += item.validMessageCount;
    totalDigests += item.digestCount;
    return item;
  });

  const tokens = splitSearchTokens(filter.q).map((t) => t.toLowerCase());
  const filtered = allItems.filter((g) => {
    if (filter.tier && g.tier !== filter.tier) return false;
    if (filter.enabledOnly && !g.enabled) return false;
    if (filter.activityId?.trim() && g.linkedActivityId !== filter.activityId.trim()) return false;
    if (tokens.length > 0) {
      const hay = `${g.name}\n${g.linkedBookTitle ?? ""}\n${g.groupKey}`.toLowerCase();
      if (!tokens.every((t) => hay.includes(t))) return false;
    }
    return true;
  });

  return {
    stats: {
      totalGroups: allItems.length,
      enabledGroups,
      coreGroups,
      voyageGroups,
      regionalGroups,
      totalMessages,
      validMessages,
      totalDigests,
      defaultDistillModel: DEFAULT_CHAT_DISTILL_MODEL,
    },
    groups: filtered,
  };
}

/** 启停单个微信群的增量同步开关，返回更新后的群信息。 */
export function setChatGroupEnabled(groupKey: string, enabled: boolean): ChatGroupItem | null {
  ensureChatRadarTables();
  const key = groupKey.trim();
  if (!key) return null;

  const res = run("UPDATE scys_chat_groups SET enabled = ? WHERE group_key = ?", enabled ? 1 : 0, key);
  if (Number(res.changes ?? 0) === 0) return null;

  const row = get<ChatGroupDbRow>(
    `SELECT g.*,
            (SELECT COUNT(*) FROM scys_chat_digests d WHERE d.group_key = g.group_key) AS digest_count
       FROM scys_chat_groups g
      WHERE g.group_key = ?`,
    key,
  );
  if (!row) return null;
  const { titleByActivityId } = loadBookTitleMaps();
  return mapGroupRow(row, titleByActivityId);
}

/** 跨群检索微信群聊原始发言记录（支持多关键词空格分词，默认跳过噪音）。 */
export function searchChatMessages(params: {
  q?: string;
  groupKey?: string;
  activityId?: string;
  tier?: ChatGroupTier;
  includeNoise?: boolean;
  limit?: number;
  offset?: number;
}): ChatMessagesSearchResponse {
  ensureChatRadarTables();
  const limit = Math.min(Math.max(Math.round(params.limit ?? 50), 1), 200);
  const offset = Math.max(Math.round(params.offset ?? 0), 0);

  const where: string[] = [];
  const args: Array<string | number> = [];

  if (!params.includeNoise) {
    where.push("m.is_noise = 0");
  }
  if (params.groupKey?.trim()) {
    where.push("m.group_key = ?");
    args.push(params.groupKey.trim());
  }
  if (params.activityId?.trim()) {
    where.push("g.linked_activity_id = ?");
    args.push(params.activityId.trim());
  }
  if (params.tier) {
    where.push("g.tier = ?");
    args.push(params.tier);
  }

  for (const tok of splitSearchTokens(params.q)) {
    const pat = `%${escapeSqlLike(tok)}%`;
    where.push("(m.content LIKE ? ESCAPE '\\' OR m.sender_name LIKE ? ESCAPE '\\' OR g.name LIKE ? ESCAPE '\\')");
    args.push(pat, pat, pat);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRow = get<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM scys_chat_messages m
       JOIN scys_chat_groups g ON g.group_key = m.group_key
      ${whereSql}`,
    ...args,
  );

  const rows = all<ChatMessageDbRow>(
    `SELECT m.group_key,
            g.name AS group_name,
            g.tier,
            g.linked_activity_id,
            m.msg_id,
            m.msg_time,
            m.msg_type,
            m.sender_name,
            m.content,
            m.is_noise
       FROM scys_chat_messages m
       JOIN scys_chat_groups g ON g.group_key = m.group_key
      ${whereSql}
      ORDER BY m.msg_time DESC, m.msg_id DESC
      LIMIT ? OFFSET ?`,
    ...args,
    limit,
    offset,
  );

  return {
    total: Number(totalRow?.n ?? 0),
    limit,
    offset,
    items: rows.map(mapMessageRow),
  };
}

/** 查询指定群聊某条消息时间锚点前后各 `windowSize` 条真实群聊上下文。 */
export function getChatMessageContext(
  groupKey: string,
  anchorMsgTime: number,
  windowSize = 15,
): ChatMessageContextResponse | null {
  ensureChatRadarTables();
  const key = groupKey.trim();
  if (!key) return null;

  const group = get<{
    group_key: string;
    name: string;
    tier: string;
    linked_activity_id: string | null;
  }>("SELECT group_key, name, tier, linked_activity_id FROM scys_chat_groups WHERE group_key = ?", key);
  if (!group) return null;

  const anchor = Math.floor(Number(anchorMsgTime));
  const win = Math.min(Math.max(Math.round(windowSize), 1), 100);

  const beforeDesc = all<ChatMessageDbRow>(
    `SELECT m.group_key,
            ? AS group_name,
            ? AS tier,
            ? AS linked_activity_id,
            m.msg_id,
            m.msg_time,
            m.msg_type,
            m.sender_name,
            m.content,
            m.is_noise
       FROM scys_chat_messages m
      WHERE m.group_key = ? AND m.msg_time <= ?
      ORDER BY m.msg_time DESC, m.msg_id DESC
      LIMIT ?`,
    group.name,
    group.tier,
    group.linked_activity_id,
    key,
    anchor,
    win + 1,
  );

  const afterAsc = all<ChatMessageDbRow>(
    `SELECT m.group_key,
            ? AS group_name,
            ? AS tier,
            ? AS linked_activity_id,
            m.msg_id,
            m.msg_time,
            m.msg_type,
            m.sender_name,
            m.content,
            m.is_noise
       FROM scys_chat_messages m
      WHERE m.group_key = ? AND m.msg_time > ?
      ORDER BY m.msg_time ASC, m.msg_id ASC
      LIMIT ?`,
    group.name,
    group.tier,
    group.linked_activity_id,
    key,
    anchor,
    win,
  );

  const deduped = new Map<string, ChatMessageItem>();
  for (const r of [...beforeDesc.reverse(), ...afterAsc]) {
    deduped.set(r.msg_id, mapMessageRow(r));
  }
  const items = [...deduped.values()].sort(
    (a, b) => a.msgTime - b.msgTime || a.msgId.localeCompare(b.msgId),
  );

  return {
    groupKey: group.group_key,
    groupName: group.name,
    linkedActivityId: group.linked_activity_id?.trim() || null,
    anchorMsgTime: anchor,
    items,
  };
}

/** 列出 AI 提纯后的群聊实战干货洞察卡片。 */
export function listChatDigests(
  params: {
    groupKey?: string;
    activityId?: string;
    category?: string;
    q?: string;
    limit?: number;
  } = {},
): ChatDigestsResponse {
  ensureChatRadarTables();
  const limit = Math.min(Math.max(Math.round(params.limit ?? 60), 1), 200);
  const where: string[] = [];
  const args: Array<string | number> = [];

  if (params.groupKey?.trim()) {
    where.push("d.group_key = ?");
    args.push(params.groupKey.trim());
  }
  if (params.activityId?.trim()) {
    where.push("d.linked_activity_id = ?");
    args.push(params.activityId.trim());
  }
  if (params.category?.trim()) {
    where.push("d.category = ?");
    args.push(params.category.trim());
  }

  for (const tok of splitSearchTokens(params.q)) {
    const pat = `%${escapeSqlLike(tok)}%`;
    where.push(
      "(d.title LIKE ? ESCAPE '\\' OR d.summary LIKE ? ESCAPE '\\' OR d.group_name LIKE ? ESCAPE '\\' OR d.key_speakers LIKE ? ESCAPE '\\')",
    );
    args.push(pat, pat, pat, pat);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = all<ChatDigestDbRow>(
    `SELECT d.*
       FROM scys_chat_digests d
      ${whereSql}
      ORDER BY d.msg_time_to DESC, d.id DESC
      LIMIT ?`,
    ...args,
    limit,
  );

  const { titleByActivityId } = loadBookTitleMaps();
  return {
    items: rows.map((r) => mapDigestRow(r, titleByActivityId)),
    defaultModel: DEFAULT_CHAT_DISTILL_MODEL,
  };
}
