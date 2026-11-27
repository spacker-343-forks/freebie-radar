import { all, get, getDb, run } from "../db.ts";
import { cleanText, parseDate, sanitizeImageUrl } from "../enrich/normalize.ts";
import type { AiSettings } from "../enrich/ai-settings.ts";
import {
  distillCommentPostsWithAi,
  type DistillableComment,
  type DistillableSubReply,
} from "../scys/comment-ai.ts";
import {
  buildToolArgs,
  ScysAuthError,
  ScysMcpClient,
  type McpToolSchema,
  type ScysMcpClientOptions,
} from "../scys/mcp-client.ts";
import type { CollectContext, Collector, RawItem } from "./types.ts";

export type ScysMode = "highlights" | "projects" | "latest" | "manuals";
export const MAX_ARCHIVE_CONTENT_CHARS = 500_000;

type StageItem = {
  rawId: string;
  entityType?: string;
  activityId?: string;
  courseId?: string;
  commentsCount?: number;
  externalId: string;
  url: string;
  title: string;
  summary: string;
  content: string;
  metaHeader?: string;
  author: string | null;
  publishedAt: string | null;
  tags: string[];
  categoryHint: string | null;
  imageUrl: string | null;
  detailTool: "topicDetail" | "projectLibDetail" | "activityManualDetail" | null;
  raw: Record<string, unknown>;
};

const PROJECT_SECTION_LABELS: Record<string, string> = {
  worth_reason: "值得关注的原因",
  background: "项目背景",
  target_audience: "目标人群",
  profit_model: "盈利模式",
  operation_steps: "操作步骤",
  case_analysis: "案例拆解",
  risk_tips: "风险提示",
  summary: "项目总结",
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

function firstArray(obj: Record<string, unknown>, keys: string[]): unknown[] {
  for (const k of keys) {
    const v = obj[k];
    if (Array.isArray(v)) return v;
  }
  return [];
}

function safeDecodeUri(raw: string): string {
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function parseTagAttributes(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(attrStr))) {
    const name = m[1]?.toLowerCase();
    const val = m[2] ?? m[3] ?? "";
    if (name) attrs[name] = val;
  }
  return attrs;
}

/** Decodes Knowledge Planet inline `<e type="..." title="..." href="..." />` XML tags into readable Markdown/text. */
export function decodeScysInlineTags(input: string): string {
  if (!input) return "";
  let out = input.replace(/<e\b([^>]*?)\/>/gi, (_, attrStr: string) => {
    const attrs = parseTagAttributes(attrStr);
    const type = (attrs.type || "").toLowerCase();
    const title = safeDecodeUri(attrs.title || "").trim();
    const href = safeDecodeUri(attrs.href || "").trim();

    if (type === "web" && href) {
      if (!title || title === href) return href;
      return `[${title}](${href})`;
    }
    if (type === "text_bold" && title) {
      return `**${title}**`;
    }
    if (type === "hashtag" || type === "mention") {
      return title || href;
    }
    if (href && title) return `[${title}](${href})`;
    return title || href;
  });

  out = out.replace(/<e\b([^>]*)>([\s\S]*?)<\/e>/gi, (_, attrStr: string, inner: string) => {
    const attrs = parseTagAttributes(attrStr);
    const title = safeDecodeUri(attrs.title || "").trim() || inner.trim();
    const href = safeDecodeUri(attrs.href || "").trim();
    if (href && title && title !== href) return `[${title}](${href})`;
    return title || href;
  });

  return out;
}

/** Parses seconds/milliseconds unix timestamps or ISO strings into UTC ISO timestamps. */
export function parseScysTimestamp(input: unknown): string | null {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) return null;
    const ms = input > 1e12 ? input : input * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return null;
    if (/^\d{9,11}$/.test(trimmed)) {
      return new Date(Number(trimmed) * 1000).toISOString();
    }
    if (/^\d{12,14}$/.test(trimmed)) {
      return new Date(Number(trimmed)).toISOString();
    }
    return parseDate(trimmed);
  }
  return null;
}

function extractTagsFromMenuArray(arr: unknown[], out: Set<string>): void {
  for (const item of arr) {
    if (typeof item === "string" && item.trim()) {
      out.add(item.trim());
    } else {
      const rec = asRecord(item);
      const val = rec ? firstString(rec, ["value", "name", "title", "label", "tagName"]) : "";
      if (val) out.add(val);
    }
  }
}

function extractTags(obj: Record<string, unknown>, fallbackTag?: string): string[] {
  const out = new Set<string>();
  for (const field of ["menuList", "tags", "tagList", "labels", "categories", "platformMenus", "monetizeMenus", "crowdMenus"]) {
    const v = obj[field];
    if (Array.isArray(v)) extractTagsFromMenuArray(v, out);
  }
  if (typeof obj.tag === "string" && obj.tag.trim()) {
    for (const part of obj.tag.split(/[,，、]/)) {
      if (part.trim()) out.add(part.trim());
    }
  }
  if (fallbackTag?.trim()) out.add(fallbackTag.trim());
  return [...out].slice(0, 8);
}

/** Derives a crisp title from the first heading or sentence when a 知识星球 post lacks an explicit title. */
export function deriveTitleFromText(text: string, fallback = "生财有术精选帖"): string {
  const decoded = decodeScysInlineTags(text);
  const plain = cleanText(
    decoded
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/[*_`~>|]/g, " "),
    300,
  );
  if (!plain) return fallback;
  const sentence = plain.split(/[。！？\n]/)[0]?.trim() ?? plain;
  const candidate = sentence.length >= 6 ? sentence : plain;
  return candidate.length > 72 ? `${candidate.slice(0, 72)}…` : candidate;
}

function normalizeScysUrl(
  rawUrl: string,
  kind: "topic" | "project" | "manual",
  rawId: string,
  entityType?: string,
): string {
  if (rawUrl) {
    try {
      const u = new URL(rawUrl, "https://scys.com");
      if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
    } catch {
      /* fall through to canonical URL */
    }
  }
  if (kind === "project") return `https://scys.com/opportunity/detail/${encodeURIComponent(rawId)}`;
  if (kind === "manual") return `https://scys.com/manual/${encodeURIComponent(rawId)}`;
  if (entityType) {
    return `https://scys.com/articleDetail/${encodeURIComponent(entityType)}/${encodeURIComponent(rawId)}`;
  }
  return `https://scys.com/topic/${encodeURIComponent(rawId)}`;
}

function extractRecordsFromPayload(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.map(asRecord).filter((r): r is Record<string, unknown> => r !== null);
  }
  const root = asRecord(payload);
  if (!root) return [];

  const nestedDto = asRecord(root.topicDetailDTO);
  if (nestedDto) {
    const inner = extractRecordsFromPayload(nestedDto);
    if (inner.length) return inner;
  }

  const listKeys = ["items", "list", "topics", "rows", "records", "projects", "cases", "manuals", "toc", "chapters", "results", "data"];
  for (const k of listKeys) {
    const val = root[k];
    if (Array.isArray(val)) {
      const direct = val.map(asRecord).filter((r): r is Record<string, unknown> => r !== null);
      if (direct.length) return direct;
    }
    const nested = asRecord(val);
    if (nested) {
      const inner = extractRecordsFromPayload(nested);
      if (inner.length) return inner;
    }
  }
  return [];
}

function flattenManualToc(records: Record<string, unknown>[], fallbackActivityId?: string, fallbackCourseId?: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (node: Record<string, unknown>, groupTitle?: string) => {
    const children = firstArray(node, ["children", "items", "sections", "articles", "chapters"]);
    const nodeTitle = firstString(node, ["title", "name", "chapterTitle"]);
    const id = firstString(node, ["itemId", "manualId", "docId", "articleId", "id", "slug"]);
    const hasContent = node.hasContent !== false;
    const enrichedNode: Record<string, unknown> = {
      ...node,
      ...(groupTitle && !node.tag ? { tag: groupTitle } : {}),
      ...(fallbackActivityId && !node.activityId ? { activityId: fallbackActivityId } : {}),
      ...(fallbackCourseId && !node.courseId ? { courseId: fallbackCourseId } : {}),
    };
    if (id && !children.length && hasContent) {
      out.push(enrichedNode);
      return;
    }
    if (id && hasContent && firstString(node, ["url", "link", "content", "summary"])) {
      out.push(enrichedNode);
    }
    for (const c of children) {
      const rec = asRecord(c);
      if (rec) visit(rec, nodeTitle || groupTitle);
    }
  };
  for (const r of records) visit(r);
  return out.length ? out : records;
}

function formatProjectMetaHeader(rec: Record<string, unknown>): string {
  const parts: string[] = [];
  const cost = rec.estimatedCost;
  if (cost !== undefined && cost !== null && String(cost).trim() !== "") {
    parts.push(`启动成本: ${typeof cost === "number" ? `${cost}元` : String(cost)}`);
  }
  const mins = rec.dailyMinutes;
  if (mins !== undefined && mins !== null && String(mins).trim() !== "") {
    parts.push(`日均投入: ${mins}分钟`);
  }
  const minIn = rec.incomeMin;
  const maxIn = rec.incomeMax;
  if ((minIn !== undefined && minIn !== null) || (maxIn !== undefined && maxIn !== null)) {
    const range =
      minIn !== undefined && maxIn !== undefined && minIn !== null && maxIn !== null
        ? `${minIn}~${maxIn}`
        : String(minIn ?? maxIn);
    parts.push(`月入区间: ${range}`);
  }
  const menuGroups: Array<[string, string]> = [
    ["platformMenus", "平台"],
    ["monetizeMenus", "变现"],
    ["crowdMenus", "人群"],
  ];
  for (const [key, label] of menuGroups) {
    const arr = firstArray(rec, [key]);
    if (arr.length) {
      const s = new Set<string>();
      extractTagsFromMenuArray(arr, s);
      if (s.size) parts.push(`${label}: ${[...s].join("/")}`);
    }
  }
  return parts.join(" | ");
}

function toStageItem(
  rec: Record<string, unknown>,
  mode: ScysMode,
  fallbackTag?: string,
): StageItem | null {
  const kind: "topic" | "project" | "manual" =
    mode === "projects" ? "project" : mode === "manuals" ? "manual" : "topic";

  if (kind === "topic") {
    const dto = asRecord(rec.topicDTO) ?? rec;
    const userDto = asRecord(rec.topicUserDTO) ?? asRecord(dto.author) ?? asRecord(dto.user) ?? asRecord(dto.owner);
    const rawEntityType = typeof dto.entityType === "string" ? dto.entityType.trim() : "";
    const hasExplicitEntityType = rawEntityType.length > 0;
    const entityType = rawEntityType || "xq_topic";
    const rawId = firstString(dto, ["entityId", "topicId", "topic_id", "id", "slug"]);
    const rawUrl = firstString(rec, ["detailUrl", "url", "link", "shareUrl", "jumpUrl"]) ||
      firstString(dto, ["detailUrl", "url", "link", "shareUrl", "jumpUrl"]);
    if (!rawId && !rawUrl) return null;

    const idToken = rawId || rawUrl;
    const externalId = idToken.startsWith("scys-")
      ? idToken
      : hasExplicitEntityType
        ? `scys-topic-${entityType}-${idToken}`
        : `scys-topic-${idToken}`;
    const url = normalizeScysUrl(rawUrl, "topic", idToken, hasExplicitEntityType ? entityType : undefined);

    const rawBody = decodeScysInlineTags(
      firstString(dto, ["articleContent", "content", "text", "body", "description", "summary", "snippet", "abstract"]),
    );
    const explicitTitle = decodeScysInlineTags(
      firstString(dto, ["showTitle", "highlightShowTitle", "title", "name", "topicTitle"]),
    );
    const title = explicitTitle ? cleanText(explicitTitle, 140) : deriveTitleFromText(rawBody);
    const summary = cleanText(
      decodeScysInlineTags(firstString(dto, ["summary", "snippet", "abstract", "description"])) || rawBody,
      400,
    );

    const author =
      (userDto ? firstString(userDto, ["name", "nickname", "username", "userName"]) : "") ||
      firstString(dto, ["author", "authorName", "userName", "creator"]) ||
      null;

    const publishedAt = parseScysTimestamp(
      dto.gmtCreate ?? dto.gmtDigested ?? dto.publishedAt ?? dto.publishTime ?? dto.createTime ?? dto.createdAt ?? dto.created_at,
    );

    const miniImgs = firstArray(dto, ["miniImageList", "imageList"]);
    const firstImg = miniImgs.length
      ? typeof miniImgs[0] === "string"
        ? miniImgs[0]
        : firstString(asRecord(miniImgs[0]) ?? {}, ["url", "src"])
      : "";
    const imageUrl = sanitizeImageUrl(
      firstImg || firstString(dto, ["imageUrl", "cover", "coverUrl", "thumbnail", "image"]),
      "https://scys.com",
    );
    const rawCommentsCount = Number(dto.commentsCount ?? dto.commentCount ?? dto.replyCount ?? 0);
    const commentsCount =
      Number.isFinite(rawCommentsCount) && rawCommentsCount > 0 ? Math.floor(rawCommentsCount) : 0;

    return {
      rawId: idToken,
      entityType,
      commentsCount,
      externalId,
      url,
      title,
      summary,
      content: rawBody.slice(0, MAX_ARCHIVE_CONTENT_CHARS),
      author,
      publishedAt,
      tags: extractTags(dto, fallbackTag),
      categoryHint: inferScysCategoryHint(title, summary, mode),
      imageUrl,
      detailTool: "topicDetail",
      raw: rec,
    };
  }

  if (kind === "project") {
    const rawId = firstString(rec, ["projectId", "project_id", "id", "slug"]);
    const rawUrl = firstString(rec, ["detailUrl", "url", "link", "shareUrl"]);
    if (!rawId && !rawUrl) return null;

    const idToken = rawId || rawUrl;
    const externalId = idToken.startsWith("scys-") ? idToken : `scys-project-${idToken}`;
    const url = normalizeScysUrl(rawUrl, "project", idToken);

    const rawBody = decodeScysInlineTags(
      firstString(rec, ["description", "summary", "highlightText", "content", "text"]),
    );
    const explicitTitle = decodeScysInlineTags(firstString(rec, ["name", "title", "projectName"]));
    const title = explicitTitle ? cleanText(explicitTitle, 140) : deriveTitleFromText(rawBody);
    const metaHeader = formatProjectMetaHeader(rec);
    const summaryBase = cleanText(
      decodeScysInlineTags(firstString(rec, ["summary", "highlightText", "description"])) || rawBody,
      320,
    );
    const summary = cleanText([metaHeader, summaryBase].filter(Boolean).join(" | "), 400);

    const publishedAt = parseScysTimestamp(rec.publishedAt ?? rec.gmtCreate ?? rec.createTime ?? rec.createdAt);
    const imageUrl = sanitizeImageUrl(firstString(rec, ["imageUrl", "cover", "coverUrl", "image"]), "https://scys.com");

    return {
      rawId: idToken,
      externalId,
      url,
      title,
      summary,
      content: [metaHeader, rawBody].filter(Boolean).join("\n\n").slice(0, MAX_ARCHIVE_CONTENT_CHARS),
      metaHeader,
      author: firstString(rec, ["author", "authorName", "creator"]) || null,
      publishedAt,
      tags: extractTags(rec, fallbackTag),
      categoryHint: inferScysCategoryHint(title, summary, mode),
      imageUrl,
      detailTool: "projectLibDetail",
      raw: rec,
    };
  }

  // manual
  const rawId = firstString(rec, ["itemId", "manualId", "docId", "articleId", "id", "slug"]);
  const rawUrl = firstString(rec, ["detailUrl", "url", "link", "shareUrl"]);
  if (!rawId && !rawUrl) return null;

  const idToken = rawId || rawUrl;
  const externalId = idToken.startsWith("scys-") ? idToken : `scys-manual-${idToken}`;
  const url = normalizeScysUrl(rawUrl, "manual", idToken);

  const rawBody = decodeScysInlineTags(firstString(rec, ["content", "text", "body", "description", "summary"]));
  const explicitTitle = decodeScysInlineTags(firstString(rec, ["title", "name", "manualTitle"]));
  const title = explicitTitle ? cleanText(explicitTitle, 140) : deriveTitleFromText(rawBody);
  const summary = cleanText(firstString(rec, ["summary", "description"]) || rawBody, 400);
  const publishedAt = parseScysTimestamp(rec.publishedAt ?? rec.gmtCreate ?? rec.createTime ?? rec.createdAt);

  return {
    rawId: idToken,
    activityId: firstString(rec, ["activityId"]) || undefined,
    courseId: firstString(rec, ["courseId"]) || undefined,
    externalId,
    url,
    title,
    summary,
    content: rawBody.slice(0, MAX_ARCHIVE_CONTENT_CHARS),
    author: firstString(rec, ["author", "authorName", "creator"]) || null,
    publishedAt,
    tags: extractTags(rec, fallbackTag),
    categoryHint: inferScysCategoryHint(title, summary, mode),
    imageUrl: sanitizeImageUrl(firstString(rec, ["imageUrl", "cover", "coverUrl", "image"]), "https://scys.com"),
    detailTool: "activityManualDetail",
    raw: rec,
  };
}

function inferScysCategoryHint(title: string, summary: string, mode: ScysMode): string {
  const combined = `${title} ${summary}`.toLowerCase();
  if (/(ai|gpt|claude|gemini|mcp|agent|大模型|提示词|算力)/i.test(combined)) return "ai";
  if (/(开源|github|self-host)/i.test(combined)) return "opensource";
  if (/(脚本|自动化|开发|api|sdk|插件)/i.test(combined)) return "dev";
  if (/(教程|实战|手册|课程|复盘)/.test(combined) && mode === "manuals") return "course";
  return "finance";
}

/** Recursively formats structured `projectLibDetail.content` sections (`[{ key, value }]`) into clean Markdown. */
export function formatStructuredProjectContent(node: unknown, depth = 0): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return decodeScysInlineTags(node).trim();
  if (typeof node === "number" || typeof node === "boolean") return String(node);

  if (Array.isArray(node)) {
    return node
      .map((item) => formatStructuredProjectContent(item, depth))
      .filter(Boolean)
      .join("\n\n");
  }

  const rec = asRecord(node);
  if (!rec) return "";

  const rawKey = firstString(rec, ["key", "label", "title", "name"]);
  const headingLabel = rawKey ? (PROJECT_SECTION_LABELS[rawKey] ?? rawKey) : "";
  const val = rec.value ?? rec.content ?? rec.items ?? rec.children;

  if (val !== undefined) {
    const inner = formatStructuredProjectContent(val, depth + 1);
    if (!inner && !headingLabel) return "";
    if (!headingLabel) return inner;
    const prefix = depth === 0 ? "##" : "###";
    return inner ? `${prefix} ${headingLabel}\n${inner}` : `${prefix} ${headingLabel}`;
  }

  const text = firstString(rec, ["text", "description", "summary"]);
  return text ? decodeScysInlineTags(text) : "";
}

const BRACKET_EMOJI_RE =
  /\[(?:强|弱|赞|玫瑰|凋谢|抱拳|握手|鼓掌|爱心|心碎|呲牙|憨笑|偷笑|笑哭|捂脸|流泪|大哭|加油|奋斗|胜利|OK|ok|比心|合十|庆祝|烟花|666|牛|火|太阳|月亮|咖啡|啤酒|礼物|红包|发财|旺柴|狗头|吃瓜|奸笑|坏笑|破涕为笑|敬礼|勾引|拳头|差劲|爱你|NO|no|微笑|撇嘴|色|发呆|得意|害羞|闭嘴|睡|尴尬|发怒|调皮|惊讶|难过|酷|冷汗|抓狂|吐|可爱|白眼|傲慢|饥饿|困|惊恐|流汗|悠闲|咒骂|疑问|嘘|晕|衰|骷髅|敲打|再见|擦汗|抠鼻|糗大了|委屈|快哭了|阴险|亲亲|吓|可怜|菜刀|西瓜|篮球|乒乓|猪头|拥抱|闪电|炸弹|刀|足球|瓢虫|便便|饭|蛋糕|凋谢|嘴唇|跳跳|发抖|怄火|转圈|磕头|回头|跳绳|挥手|激动|街舞|献吻|左太极|右太极|嘿哈|机智|皱眉|耶)\]/gu;

const LOW_SIGNAL_COMMENT_RE =
  /^(?:(?:很|太|真|好|超|非常|特别|贼)?棒+(?:了|哒|呀|啊|哦)*|好文|好帖|(?:太|真|好|超)?(?:强|牛|厉害|赞|优秀|顶|绝|丝滑|实用|受用)(?:了|呀|啊|哦|啦|逼|🍺|b)*|牛[逼🍺b哇]+|干货(?:满满|十足)?|纯干货|受教了?|学到了?|涨知识了?|受益匪浅|写得(?:真|太|很|超)?好(?:了)?|说得(?:真|太|很)?好(?:了)?|总结(?:得)?(?:很|太)?到位|通俗易懂|值得(?:反复)?(?:学习|阅读|细品|收藏)|谢谢[\s老板分享大佬楼主哥姐们老大支持鼓励大家认可]*|感谢[\s分享大佬老板楼主哥姐们老大支持鼓励大家认可]*(?:已中标)?|恭喜(?:中标|加精|精华|上榜)|已(?:中标|加精|阅|赞|收藏|三连)|已赞[\s收藏支持]*|先?马(?:住|一下|后看)?|插个?眼|mark(?:一下)?|果断收藏|收藏了?|学习了?|支持[\s一下楼主大佬老大]*|蹲(?:一个|后续)?|来看看|前排[\s围观占座]*|沙发|顶+(?:一下|起来)?|打卡[\s第\d天]*|同问|路过|加油+|共勉|哈哈+|收到|好的?|明白(?:了)?|get|ok|666+|111+|(?:\+1)+|加我?微信.*|私信领.*|扫码(?:加微|进群).*)$/iu;

const AUTHOR_COURTESY_ONLY_RE =
  /^(?:谢谢[\s支持鼓励大家老板圈友认可哥姐们]*|感谢[\s支持鼓励大家老板圈友认可哥姐们]*|哈哈+|好的?|收到|明白(?:了)?|共勉|加油+|握手|抱拳|不客气|客气了|嗯+|是的?|没错|对的?)$/iu;

const SUB_REPLY_ACK_ONLY_RE =
  /^(?:好(?:的|嘞|呀|哒|滴)?|收到|明白(?:了)?|了解|懂了|原来如此|get|ok|谢谢[\s老大楼主大佬老板分享]*|感谢[\s老大楼主大佬老板解答分享]*|辛苦了?|哈哈+|嗯+|666+|赞+)$/iu;

let commentSyncTableEnsured = false;

export function ensureScysCommentSyncTable(): void {
  if (commentSyncTableEnsured) {
    try {
      const exists = get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='scys_comment_sync'",
      );
      if (exists) return;
    } catch {
      return;
    }
  }
  try {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS scys_comment_sync (
        external_id TEXT PRIMARY KEY,
        source_comment_count INTEGER NOT NULL DEFAULT 0,
        kept_comment_count INTEGER NOT NULL DEFAULT 0,
        synced_at TEXT NOT NULL
      );
    `);
    commentSyncTableEnsured = true;
  } catch {
    /* ignore when DB is uninitialized in pure unit helper tests */
  }
}

export function recordScysCommentSync(
  externalId: string,
  sourceCommentCount: number,
  keptCommentCount: number,
): void {
  if (!externalId) return;
  ensureScysCommentSyncTable();
  try {
    run(
      `INSERT INTO scys_comment_sync (external_id, source_comment_count, kept_comment_count, synced_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(external_id) DO UPDATE SET
         source_comment_count = MAX(scys_comment_sync.source_comment_count, excluded.source_comment_count),
         kept_comment_count = excluded.kept_comment_count,
         synced_at = excluded.synced_at`,
      externalId,
      Math.max(0, Math.floor(sourceCommentCount)),
      Math.max(0, Math.floor(keptCommentCount)),
      new Date().toISOString(),
    );
  } catch {
    /* ignore if isolated unit test has no DB schema */
  }
}

function stripCommentPlain(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\u200b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strips HTML, bracket emoticons (`[强]`), URLs, Unicode emojis, and punctuation to count substantive characters. */
export function extractSubstantiveCommentText(plainText: string): string {
  return plainText
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(BRACKET_EMOJI_RE, " ")
    .replace(/(?:^|\s)(?:\[[\u4e00-\u9fa5a-zA-Z0-9]{1,3}\]\s*){2,}(?=$|\s)/gu, " ")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function isLowSignalComment(plainText: string, isAuthor = false): boolean {
  const trimmed = plainText.trim();
  if (!trimmed) return true;
  const hasUrl = /https?:\/\//i.test(trimmed);
  if (hasUrl) return false;

  const substantive = extractSubstantiveCommentText(trimmed);
  if (!substantive) return true;

  if (isAuthor) {
    return AUTHOR_COURTESY_ONLY_RE.test(substantive);
  }
  if (substantive.length < 6) return true;
  return LOW_SIGNAL_COMMENT_RE.test(substantive) || LOW_SIGNAL_COMMENT_RE.test(trimmed);
}

function isLowSignalSubReply(plainText: string, isAuthor: boolean): boolean {
  const trimmed = plainText.trim();
  if (!trimmed) return true;
  if (/https?:\/\//i.test(trimmed)) return false;

  const substantive = extractSubstantiveCommentText(trimmed);
  if (!substantive) return true;

  if (isAuthor) {
    return AUTHOR_COURTESY_ONLY_RE.test(substantive);
  }
  if (SUB_REPLY_ACK_ONLY_RE.test(substantive)) return true;
  if (substantive.length < 5) return true;
  return LOW_SIGNAL_COMMENT_RE.test(substantive);
}

function extractCommentImages(cr: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const pushUrl = (u: unknown) => {
    if (typeof u === "string") {
      for (const part of u.split(/[\s,;，；]+/)) {
        const clean = sanitizeImageUrl(part.trim(), "https://scys.com");
        if (clean && !urls.includes(clean)) urls.push(clean);
      }
    } else {
      const rec = asRecord(u);
      if (rec) {
        const clean = sanitizeImageUrl(firstString(rec, ["url", "src", "imageUrl"]), "https://scys.com");
        if (clean && !urls.includes(clean)) urls.push(clean);
      }
    }
  };
  if (cr.images !== undefined) {
    if (Array.isArray(cr.images)) cr.images.forEach(pushUrl);
    else pushUrl(cr.images);
  }
  for (const k of ["imageList", "miniImageList", "pictures"]) {
    const arr = cr[k];
    if (Array.isArray(arr)) arr.forEach(pushUrl);
  }
  return urls.slice(0, 6);
}

function escapeCommentMarkers(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^(\s*)[💬↳]/gm, "$1·").trim();
}

function appendImagesToCommentBody(body: string, images: string[]): string {
  if (!images.length) return body;
  const isHtmlBlock = /<(?:p|div|h[1-6]|ul|ol|blockquote)\b/i.test(body);
  if (isHtmlBlock) {
    const htmlImgs = images.map((u) => `<p><img src="${u}" alt="" /></p>`).join("");
    return body ? `${body}${htmlImgs}` : htmlImgs;
  }
  const mdImgs = images.map((u) => `![](${u})`).join("\n");
  return body ? `${body}\n\n${mdImgs}` : mdImgs;
}

type NormalizedSubReply = {
  id: string;
  author: string;
  isAuthor: boolean;
  replyTo: string;
  likes: number;
  gmtCreate: number;
  body: string;
  plainLen: number;
  lowSignal: boolean;
};

type NormalizedComment = {
  id: string;
  author: string;
  isAuthor: boolean;
  likes: number;
  gmtCreate: number;
  body: string;
  hasImages: boolean;
  plainLen: number;
  lowSignal: boolean;
  hasAuthorReply: boolean;
  replies: NormalizedSubReply[];
};

/**
 * Stage 1 deterministic comment pre-filter (0 Token):
 * Strips pure praise ("很棒很棒", "棒！！！", "[强]"), routine award stamps ("感谢分享，已中标"),
 * courtesy tails ("好", "收到", "谢谢老大"), and empty emoji noise before Stage 2 AI distillation.
 */
export function prepareScysCommentCandidates(
  rawComments: unknown[],
  options: { maxCandidates?: number; postAuthor?: string | null } = {},
): DistillableComment[] {
  const maxCandidates = Math.max(1, options.maxCandidates ?? 25);
  const postAuthor = options.postAuthor?.trim() || "";
  const parsed: NormalizedComment[] = [];
  const seenIds = new Set<string>();

  for (let idx = 0; idx < rawComments.length; idx += 1) {
    const raw = rawComments[idx];
    if (typeof raw === "string") {
      const text = escapeCommentMarkers(decodeScysInlineTags(raw));
      const plain = stripCommentPlain(text);
      if (text && !isLowSignalComment(plain, false)) {
        parsed.push({
          id: `str-${idx}`,
          author: "",
          isAuthor: false,
          likes: 0,
          gmtCreate: idx,
          body: text,
          hasImages: false,
          plainLen: plain.length,
          lowSignal: false,
          hasAuthorReply: false,
          replies: [],
        });
      }
      continue;
    }

    const cr = asRecord(raw);
    if (!cr) continue;
    const cid = firstString(cr, ["commentId", "id"]);
    if (cid) {
      if (seenIds.has(cid)) continue;
      seenIds.add(cid);
    }

    const commentUser = asRecord(cr.commentUserDTO) ?? asRecord(cr.user);
    const cAuthor =
      (commentUser ? firstString(commentUser, ["name", "nickname", "userName"]) : "") ||
      firstString(cr, ["userName", "author", "authorName", "nickname"]);
    const isAuthor = Boolean(cr.isAuthor) || Boolean(postAuthor && cAuthor && cAuthor === postAuthor);
    const likes = Math.max(0, Math.floor(Number(cr.likeCount ?? cr.likesCount ?? cr.likes ?? 0) || 0));
    const gmtCreate = Number(cr.gmtCreate ?? cr.createTime ?? idx) || idx;
    const rawText = escapeCommentMarkers(decodeScysInlineTags(firstString(cr, ["content", "text", "body"])));
    const images = extractCommentImages(cr);
    const fullBody = appendImagesToCommentBody(rawText, images);
    const plain = stripCommentPlain(rawText);

    const rawReplies = firstArray(cr, ["replies", "subComments", "childComments", "replyList"]);
    const allSubReplies: NormalizedSubReply[] = [];
    const seenSubIds = new Set<string>();
    for (let rIdx = 0; rIdx < rawReplies.length; rIdx += 1) {
      const sr = asRecord(rawReplies[rIdx]);
      if (!sr) continue;
      const sid = firstString(sr, ["commentId", "id"]);
      if (sid) {
        if (seenSubIds.has(sid)) continue;
        seenSubIds.add(sid);
      }
      const subUser = asRecord(sr.commentUserDTO) ?? asRecord(sr.user);
      const rAuthor =
        (subUser ? firstString(subUser, ["name", "nickname", "userName"]) : "") ||
        firstString(sr, ["userName", "author", "authorName", "nickname"]);
      const rIsAuthor = Boolean(sr.isAuthor) || Boolean(postAuthor && rAuthor && rAuthor === postAuthor);
      const rReplyTo = decodeScysInlineTags(firstString(sr, ["replyUserName", "replyToName", "targetUserName"]));
      const rLikes = Math.max(0, Math.floor(Number(sr.likeCount ?? sr.likesCount ?? sr.likes ?? 0) || 0));
      const rGmt = Number(sr.gmtCreate ?? sr.createTime ?? rIdx) || rIdx;
      const rText = escapeCommentMarkers(decodeScysInlineTags(firstString(sr, ["content", "text", "body"])));
      const rImgs = extractCommentImages(sr);
      const rBody = appendImagesToCommentBody(rText, rImgs);
      const rPlain = stripCommentPlain(rText);
      if (!rBody) continue;
      allSubReplies.push({
        id: sid || `sub-${rIdx}`,
        author: rAuthor,
        isAuthor: rIsAuthor,
        replyTo: rReplyTo,
        likes: rLikes,
        gmtCreate: rGmt,
        body: rBody,
        plainLen: rPlain.length,
        lowSignal: rImgs.length === 0 && isLowSignalSubReply(rPlain, rIsAuthor),
      });
    }

    // Keep substantive sub-replies, plus earlier replies explicitly answered by a substantive author reply
    const sortedSub = [...allSubReplies].sort((a, b) => a.gmtCreate - b.gmtCreate);
    const keptSubSet = new Set<string>();
    for (let i = 0; i < sortedSub.length; i += 1) {
      const cur = sortedSub[i]!;
      if (!cur.lowSignal) {
        keptSubSet.add(cur.id);
        if (cur.isAuthor && cur.replyTo && cur.replyTo !== cAuthor) {
          for (let j = i - 1; j >= 0; j -= 1) {
            const prev = sortedSub[j]!;
            if (prev.author === cur.replyTo && extractSubstantiveCommentText(stripCommentPlain(prev.body)).length >= 2) {
              keptSubSet.add(prev.id);
              break;
            }
          }
        }
      }
    }
    const keptReplies = sortedSub.filter((r) => keptSubSet.has(r.id)).slice(0, 8);
    const hasAuthorReply = keptReplies.some((r) => r.isAuthor);
    const substantiveSubThread = keptReplies.length > 0;
    if (!fullBody && !substantiveSubThread) continue;

    const topLowSignal = images.length === 0 && isLowSignalComment(plain, isAuthor);
    parsed.push({
      id: cid || `idx-${idx}`,
      author: cAuthor,
      isAuthor,
      likes,
      gmtCreate,
      body: fullBody || "（原评论含图片或已省略）",
      hasImages: images.length > 0,
      plainLen: plain.length,
      lowSignal: topLowSignal,
      hasAuthorReply,
      replies: keptReplies,
    });
  }

  const priority = parsed
    .filter((c) => (c.isAuthor && !c.lowSignal) || c.hasAuthorReply)
    .sort((a, b) => a.gmtCreate - b.gmtCreate);
  const priorityIds = new Set(priority.map((c) => c.id));

  const community = parsed
    .filter((c) => !priorityIds.has(c.id) && (!c.lowSignal || c.hasImages))
    .sort((a, b) => b.likes - a.likes || b.plainLen - a.plainLen || a.gmtCreate - b.gmtCreate);

  const effectiveLimit = Math.max(maxCandidates, Math.min(priority.length, 30));
  const selected = [...priority, ...community].slice(0, effectiveLimit);

  return selected.map((c, cIdx): DistillableComment => {
    const key = `c${cIdx}`;
    const plain = stripCommentPlain(c.body);
    const replies: DistillableSubReply[] = c.replies.map((r, rIdx) => ({
      key: `${key}_r${rIdx}`,
      author: r.author,
      isAuthor: r.isAuthor,
      replyTo: r.replyTo,
      likes: r.likes,
      gmtCreate: r.gmtCreate,
      body: r.body,
      plainText: stripCommentPlain(r.body),
    }));
    return {
      key,
      author: c.author,
      isAuthor: c.isAuthor,
      likes: c.likes,
      gmtCreate: c.gmtCreate,
      body: c.body,
      plainText: plain || (c.hasImages ? "[评论配图]" : ""),
      hasImages: c.hasImages,
      hasUrl: /https?:\/\//i.test(c.body),
      hasAuthorReply: c.hasAuthorReply,
      replies,
    };
  });
}

export function renderDistilledScysComments(
  comments: DistillableComment[],
  maxComments = 20,
): { lines: string[]; keptCount: number } {
  const priorityCount = comments.filter((c) => c.isAuthor || c.hasAuthorReply).length;
  const effectiveLimit = Math.max(maxComments, Math.min(priorityCount, 30));
  const bounded = comments.slice(0, effectiveLimit);

  const lines: string[] = [];
  for (const c of bounded) {
    const badges: string[] = [];
    if (c.isAuthor) badges.push("楼主");
    if (c.likes > 0) badges.push(`👍${c.likes}`);
    const badgeStr = badges.length ? ` [${badges.join("·")}]` : "";
    const topBlock = c.author ? `💬 ${c.author}${badgeStr}: ${c.body}` : `💬 ${c.body}`;
    const replyBlocks = c.replies.map((r) => {
      const rBadges: string[] = [];
      if (r.isAuthor) rBadges.push("楼主");
      if (r.likes > 0) rBadges.push(`👍${r.likes}`);
      const rBadgeStr = rBadges.length ? ` [${rBadges.join("·")}]` : "";
      const rTarget = r.replyTo ? ` 回复 ${r.replyTo}` : "";
      const indentedBody = r.body.replace(/\n/g, "\n    ");
      return r.author ? `  ↳ ${r.author}${rBadgeStr}${rTarget}: ${indentedBody}` : `  ↳ ${indentedBody}`;
    });
    lines.push([topBlock, ...replyBlocks].join("\n"));
  }
  return { lines, keptCount: bounded.length };
}

export function selectAndFormatScysComments(
  rawComments: unknown[],
  options: { maxComments?: number; postAuthor?: string | null } = {},
): { lines: string[]; keptCount: number } {
  const maxComments = Math.max(1, options.maxComments ?? 20);
  const candidates = prepareScysCommentCandidates(rawComments, {
    maxCandidates: Math.max(maxComments, 25),
    postAuthor: options.postAuthor,
  });
  return renderDistilledScysComments(candidates, maxComments);
}

/** Replaces (or appends) the trailing `【精选评论】` section in an item's snapshot `content`. */
export function replaceSnapshotComments(baseContent: string, commentLines: string[]): string {
  const normalized = (baseContent || "").replace(/\r\n/g, "\n").trim();
  const cmHeaderRe = /\n{1,2}【精选评论】\n/;
  const match = cmHeaderRe.exec(normalized);

  let stripped = normalized;
  if (match) {
    const before = normalized.slice(0, match.index).trim();
    const afterStart = match.index + match[0].length;
    const rest = normalized.slice(afterStart);
    const nextSec = /\n{1,2}【(?:飞书文档内容|关联文档)】\n/.exec(rest);
    const after = nextSec ? rest.slice(nextSec.index).trim() : "";
    stripped = [before, after].filter(Boolean).join("\n\n");
  }

  if (!commentLines.length) {
    return stripped.slice(0, MAX_ARCHIVE_CONTENT_CHARS);
  }
  const commentSection = `【精选评论】\n${commentLines.join("\n")}`;
  const merged = stripped ? `${stripped}\n\n${commentSection}` : commentSection;
  return merged.slice(0, MAX_ARCHIVE_CONTENT_CHARS);
}

export async function fetchScysTopicCommentCandidates(
  client: ScysMcpClient,
  schemas: McpToolSchema[],
  params: {
    entityType?: string;
    entityId: string;
    postAuthor?: string | null;
    maxCandidates?: number;
    overrides?: Record<string, unknown>;
  },
): Promise<{ candidates: DistillableComment[]; total: number }> {
  const entityType = params.entityType || "xq_topic";
  const entityId = String(params.entityId);

  const earliestArgs = buildToolArgs(
    "pageTopicComment",
    schemas,
    { entityType, entityId, commentPageSize: 50, page: 1, sortType: 3 },
    params.overrides,
  );
  const firstRes = await client.callTool<unknown>("pageTopicComment", earliestArgs);
  const firstObj = asRecord(firstRes);
  const rawItems = [...extractRecordsFromPayload(firstRes)];
  const total = Math.max(
    rawItems.length,
    Math.floor(Number(firstObj?.total ?? 0) || 0),
  );

  // Mega-threads (>50 comments): merge Floor 1..50 earliest (catches author supplements) + Top 50 hot comments
  if (total > 50 && !params.overrides?.sortType) {
    try {
      const hotArgs = buildToolArgs(
        "pageTopicComment",
        schemas,
        { entityType, entityId, commentPageSize: 50, page: 1, sortType: 1 },
        params.overrides,
      );
      const hotRes = await client.callTool<unknown>("pageTopicComment", hotArgs);
      rawItems.push(...extractRecordsFromPayload(hotRes));
    } catch {
      /* keep earliest page if hot page fails */
    }
  }

  const candidates = prepareScysCommentCandidates(rawItems, {
    maxCandidates: params.maxCandidates ?? 25,
    postAuthor: params.postAuthor,
  });
  return { candidates, total };
}

export async function fetchScysTopicComments(
  client: ScysMcpClient,
  schemas: McpToolSchema[],
  params: {
    entityType?: string;
    entityId: string;
    postTitle?: string;
    postAuthor?: string | null;
    maxComments?: number;
    overrides?: Record<string, unknown>;
    aiSettings?: AiSettings;
    aiModel?: string;
    fetchImpl?: typeof fetch;
    skipAi?: boolean;
  },
): Promise<{ lines: string[]; total: number; keptCount: number; ruleCandidatesCount: number }> {
  const maxComments = params.maxComments ?? 20;
  const { candidates, total } = await fetchScysTopicCommentCandidates(client, schemas, {
    entityType: params.entityType,
    entityId: params.entityId,
    postAuthor: params.postAuthor,
    maxCandidates: Math.max(maxComments, 25),
    overrides: params.overrides,
  });

  if (!candidates.length) {
    return { lines: [], total, keptCount: 0, ruleCandidatesCount: 0 };
  }

  let distilled = candidates;
  if (!params.skipAi) {
    const [aiFiltered] = await distillCommentPostsWithAi(
      [{ title: params.postTitle || "", candidates }],
      { aiSettings: params.aiSettings, model: params.aiModel, fetchImpl: params.fetchImpl },
    );
    distilled = aiFiltered ?? candidates;
  }

  const rendered = renderDistilledScysComments(distilled, maxComments);
  return {
    lines: rendered.lines,
    total,
    keptCount: rendered.keptCount,
    ruleCandidatesCount: candidates.length,
  };
}

function formatDetailContent(
  detail: unknown,
  fallbackContent: string,
  metaHeader?: string,
  extraComments?: string[],
): {
  content: string;
  title?: string;
  summary?: string;
  author?: string;
  publishedAt?: string | null;
  tags?: string[];
  imageUrl?: string | null;
  commentsCount?: number;
  inlineCommentsKept?: number;
  inlineCommentCandidates?: DistillableComment[];
} {
  if (typeof detail === "string") {
    const decoded = decodeScysInlineTags(detail);
    const base = [metaHeader, decoded].filter(Boolean).join("\n\n");
    return {
      content: extraComments?.length
        ? replaceSnapshotComments(base, extraComments)
        : base.slice(0, MAX_ARCHIVE_CONTENT_CHARS),
    };
  }
  const root = asRecord(detail);
  if (!root) {
    return {
      content: extraComments?.length
        ? replaceSnapshotComments(fallbackContent, extraComments)
        : fallbackContent.slice(0, MAX_ARCHIVE_CONTENT_CHARS),
    };
  }

  const dto = asRecord(root.topicDTO) ?? asRecord(root.data) ?? asRecord(root.topic) ?? asRecord(root.project) ?? asRecord(root.manual) ?? root;
  const userDto = asRecord(root.topicUserDTO) ?? asRecord(dto.author) ?? asRecord(dto.user);
  const author =
    (userDto ? firstString(userDto, ["name", "nickname", "userName"]) : "") ||
    firstString(dto, ["author", "authorName", "userName"]) ||
    undefined;

  const parts: string[] = [];
  if (metaHeader) parts.push(metaHeader);

  const descText = firstString(dto, ["description"]);
  const rawContentVal = dto.content;

  if (Array.isArray(rawContentVal)) {
    if (descText) parts.push(decodeScysInlineTags(descText));
    const structuredMd = formatStructuredProjectContent(rawContentVal);
    if (structuredMd) parts.push(structuredMd);
  } else {
    const mainBody = decodeScysInlineTags(
      firstString(dto, ["articleContent", "content", "text", "body", "detail", "markdown", "description"]),
    );
    if (mainBody) parts.push(mainBody);
  }

  const feishuText = decodeScysInlineTags(firstString(dto, ["feishuContent", "feishuDoc", "feishuText", "docContent"]));
  if (feishuText) parts.push(`【飞书文档内容】\n${feishuText}`);

  const docs = firstArray(root, ["documentList", "feishuDocs", "docs", "attachments"]).length
    ? firstArray(root, ["documentList", "feishuDocs", "docs", "attachments"])
    : firstArray(dto, ["documentList", "feishuDocs", "docs", "attachments"]);
  if (docs.length) {
    const docLines = docs
      .map((d) => {
        const dr = asRecord(d);
        if (!dr) return typeof d === "string" ? d : "";
        const dt = decodeScysInlineTags(firstString(dr, ["title", "name", "docTitle"]));
        const dc = decodeScysInlineTags(firstString(dr, ["content", "text", "summary", "url", "docUrl"]));
        return [dt, dc].filter(Boolean).join(": ");
      })
      .filter(Boolean);
    if (docLines.length) parts.push(`【关联文档】\n${docLines.join("\n")}`);
  }

  let inlineCommentsKept = 0;
  let inlineCommentCandidates: DistillableComment[] | undefined;
  if (extraComments && extraComments.length) {
    parts.push(`【精选评论】\n${extraComments.join("\n")}`);
    inlineCommentsKept = extraComments.length;
  } else {
    const comments = firstArray(root, ["topicCommentDTOList", "comments", "topComments", "replies"]).length
      ? firstArray(root, ["topicCommentDTOList", "comments", "topComments", "replies"])
      : firstArray(dto, ["topicCommentDTOList", "comments", "topComments", "replies"]);
    if (comments.length) {
      inlineCommentCandidates = prepareScysCommentCandidates(comments, { maxCandidates: 25, postAuthor: author });
      const formattedComments = renderDistilledScysComments(inlineCommentCandidates, 20);
      if (formattedComments.lines.length) {
        parts.push(`【精选评论】\n${formattedComments.lines.join("\n")}`);
        inlineCommentsKept = formattedComments.keptCount;
      }
    }
  }

  const merged = (parts.join("\n\n") || fallbackContent).trim().slice(0, MAX_ARCHIVE_CONTENT_CHARS);
  const publishedAt = parseScysTimestamp(
    dto.gmtCreate ?? dto.publishedAt ?? dto.publishTime ?? dto.createTime ?? dto.createdAt,
  );
  const explicitTitle = decodeScysInlineTags(
    firstString(dto, ["showTitle", "highlightShowTitle", "title", "name", "topicTitle", "projectName"]),
  );
  const tags = extractTags(dto);
  const miniImgs = firstArray(dto, ["miniImageList", "imageList"]);
  const firstImg = miniImgs.length && typeof miniImgs[0] === "string" ? miniImgs[0] : "";
  const rawDetailComments = Number(dto.commentsCount ?? dto.commentCount ?? dto.replyCount ?? 0);
  const commentsCount =
    Number.isFinite(rawDetailComments) && rawDetailComments > 0 ? Math.floor(rawDetailComments) : 0;

  return {
    content: merged,
    title: explicitTitle ? cleanText(explicitTitle, 140) : undefined,
    summary: cleanText(
      [metaHeader, decodeScysInlineTags(firstString(dto, ["summary", "abstract"])) || merged].filter(Boolean).join(" | "),
      400,
    ),
    author,
    publishedAt,
    tags: tags.length ? tags : undefined,
    imageUrl: sanitizeImageUrl(firstImg || firstString(dto, ["imageUrl", "cover", "coverUrl", "image"]), "https://scys.com"),
    commentsCount,
    inlineCommentsKept,
    inlineCommentCandidates,
  };
}

type ExistingDetailState = {
  existingContentByExtId: Map<string, string>;
  commentSyncByExtId: Map<string, { sourceCommentCount: number; keptCommentCount: number }>;
};

function findExistingDetailState(sourceId: string, candidates: StageItem[]): ExistingDetailState {
  const existingContentByExtId = new Map<string, string>();
  const commentSyncByExtId = new Map<string, { sourceCommentCount: number; keptCommentCount: number }>();
  if (!candidates.length) return { existingContentByExtId, commentSyncByExtId };

  const extIds = candidates.map((c) => c.externalId);
  const placeholders = extIds.map(() => "?").join(", ");
  ensureScysCommentSyncTable();
  try {
    const rows = all<{ external_id: string; content: string }>(
      `SELECT external_id, content FROM items
       WHERE ((source_id = ? AND external_id IN (${placeholders})) OR external_id IN (${placeholders}))
         AND content IS NOT NULL AND TRIM(content) != ''
         AND (LENGTH(content) < 7995 OR LENGTH(content) > 8005)`,
      sourceId,
      ...extIds,
      ...extIds,
    );
    for (const r of rows) {
      if (!existingContentByExtId.has(r.external_id)) {
        existingContentByExtId.set(r.external_id, r.content);
      }
    }
    const syncRows = all<{ external_id: string; source_comment_count: number; kept_comment_count: number }>(
      `SELECT external_id, source_comment_count, kept_comment_count
         FROM scys_comment_sync
        WHERE external_id IN (${placeholders})`,
      ...extIds,
    );
    for (const sr of syncRows) {
      commentSyncByExtId.set(sr.external_id, {
        sourceCommentCount: sr.source_comment_count,
        keptCommentCount: sr.kept_comment_count,
      });
    }
  } catch {
    /* if DB table not initialized in isolated unit test, treat as empty */
  }
  return { existingContentByExtId, commentSyncByExtId };
}

export function findExistingDetailKeys(sourceId: string, candidates: StageItem[]): Set<string> {
  return new Set(findExistingDetailState(sourceId, candidates).existingContentByExtId.keys());
}

function shouldRefreshTopicComments(params: {
  stageCommentsCount: number;
  existingContent: string;
  syncState?: { sourceCommentCount: number; keptCommentCount: number };
  mode: ScysMode;
}): boolean {
  const { stageCommentsCount, existingContent, syncState, mode } = params;
  if (stageCommentsCount <= 0) return false;
  if (!syncState) {
    return !existingContent.includes("【精选评论】");
  }
  if (syncState.sourceCommentCount === 0) return true;
  if (syncState.keptCommentCount === 0 && stageCommentsCount > syncState.sourceCommentCount) return true;
  if (mode === "highlights" && stageCommentsCount > syncState.sourceCommentCount) return true;
  return stageCommentsCount >= syncState.sourceCommentCount + 3;
}

export function extractScysTopicIdentity(row: {
  external_id: string;
  url: string;
  raw?: string | null;
}): { entityType: string; entityId: string } | null {
  const typedExt = /^scys-topic-(xq_topic|forum_topic)-([1-9]\d*)$/.exec(row.external_id);
  if (typedExt) {
    return { entityType: typedExt[1]!, entityId: typedExt[2]! };
  }

  const urlTyped = /^https?:\/\/(?:[^/]+\.)?scys\.com\/articleDetail\/(xq_topic|forum_topic)\/([1-9]\d*)/i.exec(
    row.url,
  );
  if (urlTyped) {
    return { entityType: urlTyped[1]!.toLowerCase(), entityId: urlTyped[2]! };
  }

  const isScysTopicCandidate =
    row.external_id.startsWith("scys-topic-") ||
    /^https?:\/\/(?:[^/]+\.)?scys\.com\/(?:articleDetail|topic)\//i.test(row.url);
  if (!isScysTopicCandidate) {
    return null;
  }

  if (row.raw) {
    try {
      const parsed = JSON.parse(row.raw) as Record<string, unknown>;
      const dto = asRecord(parsed.topicDTO);
      if (dto) {
        const rawId = firstString(dto, ["entityId", "topicId", "id"]);
        const rawType = firstString(dto, ["entityType"]) || "xq_topic";
        if (/^[1-9]\d*$/.test(rawId) && (rawType === "xq_topic" || rawType === "forum_topic")) {
          return { entityType: rawType, entityId: rawId };
        }
      }
      const rootEntityId = firstString(parsed, ["entityId", "topicId"]);
      const rootEntityType = firstString(parsed, ["entityType"]) || "xq_topic";
      if (/^[1-9]\d*$/.test(rootEntityId) && (rootEntityType === "xq_topic" || rootEntityType === "forum_topic")) {
        return { entityType: rootEntityType, entityId: rootEntityId };
      }
    } catch {
      /* fall through to legacy external_id / URL */
    }
  }

  const legacyExt = /^scys-topic-([1-9]\d*)$/.exec(row.external_id);
  if (legacyExt) {
    return { entityType: "xq_topic", entityId: legacyExt[1]! };
  }
  const urlTopic = /^https?:\/\/(?:[^/]+\.)?scys\.com\/topic\/([1-9]\d*)/i.exec(row.url);
  if (urlTopic) {
    return { entityType: "xq_topic", entityId: urlTopic[1]! };
  }
  return null;
}

/** Syncs latest `pageTopicComment` replies (and missing `topicDetail` body if needed) for a single stored SCYS item. */
export async function syncScysItemComments(
  itemId: number,
  options: {
    client?: ScysMcpClient;
    schemas?: McpToolSchema[];
    maxComments?: number;
    aiSettings?: AiSettings;
    aiModel?: string;
    fetchImpl?: typeof fetch;
    skipAi?: boolean;
  } = {},
): Promise<{
  itemId: number;
  title: string;
  externalId: string;
  entityType: string;
  entityId: string;
  totalComments: number;
  ruleCandidatesCount: number;
  keptComments: number;
  content: string;
}> {
  const row = get<{
    id: number;
    external_id: string;
    url: string;
    title: string;
    summary: string | null;
    content: string | null;
    author: string | null;
    raw: string | null;
  }>("SELECT id, external_id, url, title, summary, content, author, raw FROM items WHERE id = ?", itemId);

  if (!row) {
    throw new Error(`条目不存在 (id=${itemId})`);
  }

  const identity = extractScysTopicIdentity(row);
  if (!identity) {
    throw new Error("该条目不是生财有术社区帖子，不支持评论区同步");
  }

  const client = options.client ?? new ScysMcpClient();
  let schemas = options.schemas ?? [];
  if (!options.schemas) {
    try {
      schemas = await client.getToolSchemas();
    } catch (err) {
      if (err instanceof ScysAuthError) throw err;
    }
  }

  let baseContent = (row.content ?? "").trim();
  let postAuthor = row.author;

  if (!baseContent) {
    const detailArgs = buildToolArgs("topicDetail", schemas, {
      entityType: identity.entityType,
      entityId: identity.entityId,
    });
    const detailRes = await client.callTool<unknown>("topicDetail", detailArgs);
    const formattedDetail = formatDetailContent(detailRes, row.summary ?? "");
    baseContent = formattedDetail.content;
    if (!postAuthor && formattedDetail.author) postAuthor = formattedDetail.author;
  }

  const cmRes = await fetchScysTopicComments(client, schemas, {
    entityType: identity.entityType,
    entityId: identity.entityId,
    postTitle: row.title,
    postAuthor,
    maxComments: options.maxComments ?? 25,
    aiSettings: options.aiSettings,
    aiModel: options.aiModel,
    fetchImpl: options.fetchImpl,
    skipAi: options.skipAi,
  });

  const updatedContent = replaceSnapshotComments(baseContent, cmRes.lines);
  if (updatedContent !== (row.content ?? "")) {
    run("UPDATE items SET content = ? WHERE id = ?", updatedContent, row.id);
  }
  recordScysCommentSync(row.external_id, cmRes.total, cmRes.keptCount);

  return {
    itemId: row.id,
    title: row.title,
    externalId: row.external_id,
    entityType: identity.entityType,
    entityId: identity.entityId,
    totalComments: cmRes.total,
    ruleCandidatesCount: cmRes.ruleCandidatesCount,
    keptComments: cmRes.keptCount,
    content: updatedContent,
  };
}

export function createScysCollector(clientFactory?: (cfg: Record<string, unknown>) => ScysMcpClient): Collector {
  return {
    kind: "scys",
    label: "生财有术 MCP",
    defaults: {
      config: { mode: "highlights", pageSize: 15, fetchDetail: true, maxDetailPerRun: 8 },
    },
    async collect(ctx: CollectContext) {
      const cfg = ctx.config ?? {};
      const modeRaw = String(cfg.mode ?? "highlights");
      const mode: ScysMode =
        modeRaw === "projects" || modeRaw === "latest" || modeRaw === "manuals" ? modeRaw : "highlights";
      const keyword = typeof cfg.keyword === "string" && cfg.keyword.trim() ? cfg.keyword.trim() : undefined;
      const tag = typeof cfg.tag === "string" && cfg.tag.trim() ? cfg.tag.trim() : undefined;
      const pageIndex = Math.max(1, Math.round(Number(cfg.pageIndex ?? cfg.page ?? 1) || 1));
      const pageSize = Math.min(Math.max(1, Number(cfg.pageSize ?? 15) || 15), ctx.maxItems || 50);
      const fetchDetail = cfg.fetchDetail !== false;
      const fetchComments = cfg.fetchComments !== false;
      const maxDetailPerRun = fetchDetail ? Math.max(0, Number(cfg.maxDetailPerRun ?? 8)) : 0;
      const maxCommentRefreshPerRun =
        fetchDetail && fetchComments
          ? Math.max(0, Number(cfg.maxCommentRefreshPerRun ?? Math.max(maxDetailPerRun, 8)))
          : 0;

      const toolArgsRoot = asRecord(cfg.toolArgs) ?? {};
      const stage1Override = asRecord(toolArgsRoot.list) ?? (asRecord(toolArgsRoot.detail) ? undefined : toolArgsRoot);
      const detailOverride = asRecord(toolArgsRoot.detail);
      const commentOverride = asRecord(toolArgsRoot.comments);

      const clientOpts: ScysMcpClientOptions = {};
      if (typeof cfg.minIntervalMs === "number" && Number.isFinite(cfg.minIntervalMs) && cfg.minIntervalMs >= 0) {
        clientOpts.minIntervalMs = cfg.minIntervalMs;
      }
      if (
        typeof cfg.maxConcurrencyPerSlot === "number" &&
        Number.isFinite(cfg.maxConcurrencyPerSlot) &&
        cfg.maxConcurrencyPerSlot >= 1
      ) {
        clientOpts.maxConcurrencyPerSlot = cfg.maxConcurrencyPerSlot;
      }

      const client = clientFactory ? clientFactory(cfg) : new ScysMcpClient(clientOpts);
      let schemas: McpToolSchema[] = [];
      try {
        schemas = await client.getToolSchemas();
      } catch (err) {
        if (err instanceof ScysAuthError) throw err;
        ctx.log(`获取 tools/list 失败，降级使用内置参数映射: ${err instanceof Error ? err.message : String(err)}`);
      }

      const hasTool = (name: string) => schemas.some((s) => s.name === name);
      const hasAnySchema = schemas.length > 0;
      const slotCount = Math.max(1, client.getSlotCount());

      let stage1Label = "searchTopic";
      let records: Record<string, unknown>[] = [];

      if (mode === "highlights") {
        const explicitScene =
          typeof cfg.pageScene === "string" && cfg.pageScene.trim()
            ? cfg.pageScene.trim()
            : typeof stage1Override?.pageScene === "string"
              ? stage1Override.pageScene
              : undefined;

        if (!hasAnySchema || hasTool("contentSearch")) {
          const scenes = explicitScene ? [explicitScene] : ["good", "fxb"];
          stage1Label = `contentSearch(${scenes.join("+")})`;
          ctx.log(`Stage 1 调用 ${stage1Label} (pageIndex=${pageIndex}, pageSize=${pageSize})`);
          const calls = scenes.map((scene) => {
            const args = buildToolArgs(
              "contentSearch",
              schemas,
              { mode, keyword, tag, pageSize, page: pageIndex, pageScene: scene, displayMode: 2 },
              stage1Override ?? undefined,
            );
            return () => client.callTool<unknown>("contentSearch", args);
          });
          const results = slotCount > 1 ? await Promise.all(calls.map((fn) => fn())) : await (async () => {
            const out: unknown[] = [];
            for (const fn of calls) out.push(await fn());
            return out;
          })();
          for (const res of results) {
            records.push(...extractRecordsFromPayload(res));
          }
        } else {
          stage1Label = "searchTopic";
          const args = buildToolArgs(
            "searchTopic",
            schemas,
            { mode, keyword, tag, pageSize: Math.min(pageSize, 10), page: pageIndex, displayMode: 2, compact: true },
            stage1Override ?? undefined,
          );
          ctx.log(`Stage 1 调用 searchTopic(mode=${mode}, pageIndex=${pageIndex}, pageSize=${pageSize})`);
          records = extractRecordsFromPayload(await client.callTool<unknown>("searchTopic", args));
        }
      } else if (mode === "latest") {
        const nowSec = Math.floor(Date.now() / 1000);
        const lookbackDays = pageIndex > 1 ? Math.max(7, pageIndex * 14) : 7;
        const gmtCreateStartSec = nowSec - lookbackDays * 86400;
        const latestScene =
          typeof cfg.pageScene === "string" && cfg.pageScene.trim() ? cfg.pageScene.trim() : "topic";
        const tasks: Array<() => Promise<unknown>> = [];
        const usedTools: string[] = [];

        if (!hasAnySchema || hasTool("contentSearch")) {
          usedTools.push(`contentSearch(${latestScene})`);
          const csArgs = buildToolArgs(
            "contentSearch",
            schemas,
            { mode, keyword, tag, pageSize, page: pageIndex, pageScene: latestScene, displayMode: 2 },
            stage1Override ?? undefined,
          );
          tasks.push(() => client.callTool<unknown>("contentSearch", csArgs));
        }
        if (!hasAnySchema || hasTool("searchTopic")) {
          usedTools.push("searchTopic");
          const stArgs = buildToolArgs(
            "searchTopic",
            schemas,
            {
              mode,
              keyword,
              tag,
              pageSize: Math.min(pageSize, 10),
              page: pageIndex,
              displayMode: 2,
              orderBy: "gmt_create",
              ...(keyword ? {} : { gmtCreateStart: gmtCreateStartSec }),
              compact: true,
            },
            stage1Override ?? undefined,
          );
          tasks.push(() => client.callTool<unknown>("searchTopic", stArgs));
        }

        stage1Label = usedTools.join("+");
        ctx.log(`Stage 1 调用 ${stage1Label} (pageIndex=${pageIndex}, pageSize=${pageSize})`);
        const results = slotCount > 1 ? await Promise.all(tasks.map((fn) => fn())) : await (async () => {
          const out: unknown[] = [];
          for (const fn of tasks) out.push(await fn());
          return out;
        })();
        for (const res of results) {
          records.push(...extractRecordsFromPayload(res));
        }
      } else if (mode === "projects") {
        if (!hasAnySchema || hasTool("searchProjectCases")) {
          stage1Label = "searchProjectCases";
          const args = buildToolArgs(
            "searchProjectCases",
            schemas,
            { mode, keyword, pageSize, page: pageIndex, sortType: "latest" },
            stage1Override ?? undefined,
          );
          ctx.log(`Stage 1 调用 searchProjectCases(pageIndex=${pageIndex}, pageSize=${pageSize})`);
          records = extractRecordsFromPayload(await client.callTool<unknown>("searchProjectCases", args));
        } else {
          stage1Label = "projectLibSearch";
          const args = buildToolArgs(
            "projectLibSearch",
            schemas,
            { mode, keyword: keyword || "AI", pageSize, page: pageIndex },
            stage1Override ?? undefined,
          );
          ctx.log(`Stage 1 调用 projectLibSearch(pageIndex=${pageIndex}, pageSize=${pageSize})`);
          records = extractRecordsFromPayload(await client.callTool<unknown>("projectLibSearch", args));
        }
      } else {
        // manuals mode
        const cfgActivityId = typeof cfg.activityId === "string" || typeof cfg.activityId === "number" ? String(cfg.activityId) : undefined;
        const cfgCourseId = typeof cfg.courseId === "string" || typeof cfg.courseId === "number" ? String(cfg.courseId) : undefined;

        if (keyword && (!hasAnySchema || hasTool("activityManualSearch"))) {
          stage1Label = "activityManualSearch";
          const args = buildToolArgs(
            "activityManualSearch",
            schemas,
            { mode, keyword, pageSize, page: pageIndex },
            stage1Override ?? undefined,
          );
          ctx.log(`Stage 1 调用 activityManualSearch(keyword=${keyword}, pageIndex=${pageIndex})`);
          records = extractRecordsFromPayload(await client.callTool<unknown>("activityManualSearch", args));
        } else if (cfgActivityId || cfgCourseId) {
          stage1Label = "activityManualToc";
          const tocArgs = buildToolArgs(
            "activityManualToc",
            schemas,
            { activityId: cfgActivityId, courseId: cfgCourseId },
            stage1Override ?? undefined,
          );
          ctx.log(`Stage 1 调用 activityManualToc`);
          const tocRes = await client.callTool<unknown>("activityManualToc", tocArgs);
          records = flattenManualToc(extractRecordsFromPayload(tocRes), cfgActivityId, cfgCourseId);
        } else if (hasAnySchema && hasTool("activityList")) {
          stage1Label = "activityList->activityManualToc";
          ctx.log(`Stage 1 调用 activityList 获取最近航海项目`);
          const actRes = await client.callTool<unknown>("activityList", { pageIndex: 1, pageSize: 3 });
          const activities = extractRecordsFromPayload(actRes);
          for (const act of activities.slice(0, 2)) {
            const actId = firstString(act, ["id", "activityId"]);
            if (!actId) continue;
            const tocRes = await client.callTool<unknown>("activityManualToc", { activityId: actId });
            records.push(...flattenManualToc(extractRecordsFromPayload(tocRes), actId));
            if (records.length >= pageSize) break;
          }
        } else {
          stage1Label = "activityManualToc";
          const args = buildToolArgs("activityManualToc", schemas, { mode }, stage1Override ?? undefined);
          ctx.log(`Stage 1 调用 activityManualToc`);
          records = flattenManualToc(extractRecordsFromPayload(await client.callTool<unknown>("activityManualToc", args)));
        }
      }

      // Deduplicate Stage 1 entries by externalId (e.g. across good + fxb or contentSearch + searchTopic)
      const stagedMap = new Map<string, StageItem>();
      for (const rec of records) {
        const item = toStageItem(rec, mode, tag);
        if (item && !stagedMap.has(item.externalId)) {
          stagedMap.set(item.externalId, item);
        }
        if (stagedMap.size >= pageSize) break;
      }
      const staged = [...stagedMap.values()];

      const { existingContentByExtId, commentSyncByExtId } = findExistingDetailState(ctx.sourceId, staged);
      const canFetchTool = (name: string) => !hasAnySchema || hasTool(name);
      const canFetchTopicComments = fetchComments && canFetchTool("pageTopicComment");

      type Stage2Task =
        | { kind: "detail"; idx: number }
        | { kind: "comments_only"; idx: number; existingContent: string };

      const stage2Tasks: Stage2Task[] = [];
      let queuedDetails = 0;
      let queuedCommentRefreshes = 0;

      for (let i = 0; i < staged.length; i += 1) {
        const item = staged[i]!;
        const existingContent = existingContentByExtId.get(item.externalId);

        if (existingContent === undefined) {
          if (
            fetchDetail &&
            queuedDetails < maxDetailPerRun &&
            item.detailTool !== null &&
            canFetchTool(item.detailTool)
          ) {
            stage2Tasks.push({ kind: "detail", idx: i });
            queuedDetails += 1;
          }
          continue;
        }

        if (
          canFetchTopicComments &&
          queuedCommentRefreshes < maxCommentRefreshPerRun &&
          item.detailTool === "topicDetail" &&
          shouldRefreshTopicComments({
            stageCommentsCount: item.commentsCount ?? 0,
            existingContent,
            syncState: commentSyncByExtId.get(item.externalId),
            mode,
          })
        ) {
          stage2Tasks.push({ kind: "comments_only", idx: i, existingContent });
          queuedCommentRefreshes += 1;
        }
      }

      type PendingCommentDistill = {
        idx: number;
        externalId: string;
        title: string;
        baseContent: string;
        originalExistingContent?: string;
        sourceCommentCount: number;
        candidates: DistillableComment[];
      };

      const mergedByIdx = new Map<number, { item: StageItem; fetched: boolean }>();
      const pendingDistills: PendingCommentDistill[] = [];
      let detailFailures = 0;

      const executeStage2Task = async (task: Stage2Task) => {
        const item = staged[task.idx]!;
        if (task.kind === "comments_only") {
          try {
            const cmRes = await fetchScysTopicCommentCandidates(client, schemas, {
              entityType: item.entityType,
              entityId: item.rawId,
              postAuthor: item.author,
              overrides: commentOverride ?? undefined,
            });
            pendingDistills.push({
              idx: task.idx,
              externalId: item.externalId,
              title: item.title,
              baseContent: task.existingContent,
              originalExistingContent: task.existingContent,
              sourceCommentCount: Math.max(item.commentsCount ?? 0, cmRes.total),
              candidates: cmRes.candidates,
            });
          } catch (err) {
            if (err instanceof ScysAuthError) throw err;
            ctx.log(`评论增量补抓失败 (${item.rawId}): ${err instanceof Error ? err.message : String(err)}`);
          }
          return;
        }

        const detailTool = item.detailTool!;
        try {
          const detailArgs = buildToolArgs(
            detailTool,
            schemas,
            {
              topicId: item.rawId,
              entityType: item.entityType,
              entityId: item.rawId,
              activityId: item.activityId,
              courseId: item.courseId,
            },
            detailOverride ?? undefined,
          );
          const detailRes = await client.callTool<unknown>(detailTool, detailArgs);
          const formatted = formatDetailContent(detailRes, item.content, item.metaHeader);
          const postAuthor = formatted.author || item.author;
          const resolvedTitle =
            formatted.title ||
            (item.title === "生财有术精选帖" ? deriveTitleFromText(formatted.content || item.content) : item.title);
          const expectedComments = Math.max(item.commentsCount ?? 0, formatted.commentsCount ?? 0);
          const finalContent = formatted.content || item.content;

          mergedByIdx.set(task.idx, {
            fetched: true,
            item: {
              ...item,
              title: resolvedTitle,
              summary: formatted.summary || item.summary,
              content: finalContent,
              author: postAuthor,
              publishedAt: formatted.publishedAt || item.publishedAt,
              tags: formatted.tags?.length ? [...new Set([...item.tags, ...formatted.tags])].slice(0, 8) : item.tags,
              imageUrl: formatted.imageUrl || item.imageUrl,
            },
          });

          if (detailTool === "topicDetail") {
            if (
              canFetchTopicComments &&
              expectedComments > 0 &&
              !(formatted.inlineCommentsKept && formatted.inlineCommentsKept >= expectedComments)
            ) {
              try {
                const cmRes = await fetchScysTopicCommentCandidates(client, schemas, {
                  entityType: item.entityType,
                  entityId: item.rawId,
                  postAuthor,
                  overrides: commentOverride ?? undefined,
                });
                pendingDistills.push({
                  idx: task.idx,
                  externalId: item.externalId,
                  title: resolvedTitle,
                  baseContent: finalContent,
                  sourceCommentCount: Math.max(expectedComments, cmRes.total),
                  candidates: cmRes.candidates,
                });
              } catch (cmErr) {
                if (cmErr instanceof ScysAuthError) throw cmErr;
                ctx.log(`Stage 2 评论抓取失败 (pageTopicComment ${item.rawId}): ${cmErr instanceof Error ? cmErr.message : String(cmErr)}`);
              }
            } else if (formatted.inlineCommentCandidates?.length) {
              pendingDistills.push({
                idx: task.idx,
                externalId: item.externalId,
                title: resolvedTitle,
                baseContent: finalContent,
                sourceCommentCount:
                  expectedComments === 0 || (formatted.inlineCommentsKept ?? 0) >= expectedComments
                    ? Math.max(expectedComments, formatted.inlineCommentsKept ?? 0)
                    : -1,
                candidates: formatted.inlineCommentCandidates,
              });
            } else if (expectedComments === 0) {
              recordScysCommentSync(item.externalId, 0, 0);
            }
          }
        } catch (err) {
          if (err instanceof ScysAuthError) throw err;
          detailFailures += 1;
          ctx.log(`Stage 2 详情抓取失败 (${detailTool} ${item.rawId}): ${err instanceof Error ? err.message : String(err)}`);
          mergedByIdx.set(task.idx, { fetched: false, item });
        }
      };

      if (stage2Tasks.length) {
        const capacity =
          typeof client.getConcurrencyCapacity === "function" ? client.getConcurrencyCapacity() : slotCount;
        const workerCount = Math.min(Math.max(1, capacity), stage2Tasks.length);
        let cursor = 0;
        await Promise.all(
          Array.from({ length: workerCount }, async () => {
            while (cursor < stage2Tasks.length) {
              const nextTask = stage2Tasks[cursor]!;
              cursor += 1;
              await executeStage2Task(nextTask);
            }
          }),
        );
      }

      if (pendingDistills.length) {
        const distilledLists = await distillCommentPostsWithAi(
          pendingDistills.map((d) => ({ title: d.title, candidates: d.candidates })),
          { log: (m) => ctx.log(m) },
        );

        for (let i = 0; i < pendingDistills.length; i += 1) {
          const entry = pendingDistills[i]!;
          const distilled = distilledLists[i] ?? entry.candidates;
          const rendered = renderDistilledScysComments(distilled, 20);
          const nextContent = replaceSnapshotComments(entry.baseContent, rendered.lines);

          if (entry.sourceCommentCount >= 0) {
            recordScysCommentSync(entry.externalId, entry.sourceCommentCount, rendered.keptCount);
          }

          if (entry.originalExistingContent !== undefined) {
            if (nextContent !== entry.originalExistingContent) {
              const baseItem = staged[entry.idx]!;
              mergedByIdx.set(entry.idx, {
                fetched: true,
                item: { ...baseItem, content: nextContent },
              });
            }
          } else {
            const cur = mergedByIdx.get(entry.idx);
            if (cur) {
              mergedByIdx.set(entry.idx, {
                fetched: cur.fetched,
                item: { ...cur.item, content: nextContent },
              });
            }
          }
        }
      }

      const items: RawItem[] = staged.map((item, idx) => {
        const res = mergedByIdx.get(idx);
        const merged = res ? res.item : item;
        const fetchedDetail = res?.fetched ?? false;
        const outContent = fetchDetail ? (fetchedDetail ? merged.content || null : null) : merged.content || null;

        return {
          externalId: merged.externalId,
          url: merged.url,
          title: merged.title,
          summary: merged.summary,
          content: outContent,
          author: merged.author,
          publishedAt: merged.publishedAt,
          tags: merged.tags,
          categoryHint: merged.categoryHint,
          kindHint: "info",
          imageUrl: merged.imageUrl,
          raw: { mode, stage1Tool: stage1Label, ...merged.raw },
        };
      });

      ctx.log(
        `完成采集: 列表 ${staged.length} 条, 跳过已有详情 ${existingContentByExtId.size} 条, 抓取详情 ${queuedDetails} 条, 评论补抓 ${queuedCommentRefreshes} 条 (槽位数=${slotCount})`,
      );
      const degraded =
        queuedDetails > 0 && detailFailures === queuedDetails
          ? `全部 ${queuedDetails} 条详情抓取失败，仅保留列表摘要`
          : null;

      return { items, degraded };
    },
  };
}

export const scysCollector: Collector = createScysCollector();
