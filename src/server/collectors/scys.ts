import { all } from "../db.ts";
import { cleanText, parseDate, sanitizeImageUrl } from "../enrich/normalize.ts";
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

    return {
      rawId: idToken,
      entityType,
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

function formatDetailContent(
  detail: unknown,
  fallbackContent: string,
  metaHeader?: string,
): {
  content: string;
  title?: string;
  summary?: string;
  author?: string;
  publishedAt?: string | null;
  tags?: string[];
  imageUrl?: string | null;
} {
  if (typeof detail === "string") {
    const decoded = decodeScysInlineTags(detail);
    return { content: [metaHeader, decoded].filter(Boolean).join("\n\n").slice(0, MAX_ARCHIVE_CONTENT_CHARS) };
  }
  const root = asRecord(detail);
  if (!root) return { content: fallbackContent.slice(0, MAX_ARCHIVE_CONTENT_CHARS) };

  const dto = asRecord(root.topicDTO) ?? asRecord(root.data) ?? asRecord(root.topic) ?? asRecord(root.project) ?? asRecord(root.manual) ?? root;
  const userDto = asRecord(root.topicUserDTO) ?? asRecord(dto.author) ?? asRecord(dto.user);

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

  const comments = firstArray(root, ["topicCommentDTOList", "comments", "topComments", "replies"]).length
    ? firstArray(root, ["topicCommentDTOList", "comments", "topComments", "replies"])
    : firstArray(dto, ["topicCommentDTOList", "comments", "topComments", "replies"]);
  if (comments.length) {
    const commentLines = comments
      .slice(0, 10)
      .map((c) => {
        const cr = asRecord(c);
        if (!cr) return typeof c === "string" ? decodeScysInlineTags(c) : "";
        const commentUser = asRecord(cr.commentUserDTO) ?? asRecord(cr.user);
        const cAuthor =
          (commentUser ? firstString(commentUser, ["name", "nickname", "userName"]) : "") ||
          firstString(cr, ["author", "authorName", "userName", "nickname"]);
        const cText = decodeScysInlineTags(firstString(cr, ["content", "text", "body"]));
        return cText ? `${cAuthor ? `${cAuthor}: ` : ""}${cText}` : "";
      })
      .filter(Boolean);
    if (commentLines.length) parts.push(`【精选评论】\n${commentLines.join("\n")}`);
  }

  const merged = (parts.join("\n\n") || fallbackContent).trim().slice(0, MAX_ARCHIVE_CONTENT_CHARS);
  const author =
    (userDto ? firstString(userDto, ["name", "nickname", "userName"]) : "") ||
    firstString(dto, ["author", "authorName", "userName"]) ||
    undefined;
  const publishedAt = parseScysTimestamp(
    dto.gmtCreate ?? dto.publishedAt ?? dto.publishTime ?? dto.createTime ?? dto.createdAt,
  );
  const explicitTitle = decodeScysInlineTags(
    firstString(dto, ["showTitle", "highlightShowTitle", "title", "name", "topicTitle", "projectName"]),
  );
  const tags = extractTags(dto);
  const miniImgs = firstArray(dto, ["miniImageList", "imageList"]);
  const firstImg = miniImgs.length && typeof miniImgs[0] === "string" ? miniImgs[0] : "";

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
  };
}

export function findExistingDetailKeys(sourceId: string, candidates: StageItem[]): Set<string> {
  if (!candidates.length) return new Set();
  const extIds = candidates.map((c) => c.externalId);
  const placeholders = extIds.map(() => "?").join(", ");
  const existing = new Set<string>();
  try {
    const rows = all<{ external_id: string }>(
      `SELECT external_id FROM items
       WHERE ((source_id = ? AND external_id IN (${placeholders})) OR external_id IN (${placeholders}))
         AND content IS NOT NULL AND TRIM(content) != ''
         AND (LENGTH(content) < 7995 OR LENGTH(content) > 8005)`,
      sourceId,
      ...extIds,
      ...extIds,
    );
    for (const r of rows) existing.add(r.external_id);
  } catch {
    /* if DB table not initialized in isolated unit test, treat as empty */
  }
  return existing;
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
      const maxDetailPerRun = fetchDetail ? Math.max(0, Number(cfg.maxDetailPerRun ?? 8)) : 0;

      const toolArgsRoot = asRecord(cfg.toolArgs) ?? {};
      const stage1Override = asRecord(toolArgsRoot.list) ?? (asRecord(toolArgsRoot.detail) ? undefined : toolArgsRoot);
      const detailOverride = asRecord(toolArgsRoot.detail);

      const clientOpts: ScysMcpClientOptions = {};
      if (typeof cfg.minIntervalMs === "number" && Number.isFinite(cfg.minIntervalMs) && cfg.minIntervalMs >= 0) {
        clientOpts.minIntervalMs = cfg.minIntervalMs;
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

      const existingDetailIds = findExistingDetailKeys(ctx.sourceId, staged);
      const canFetchTool = (name: string) => !hasAnySchema || hasTool(name);

      const pendingIndices: number[] = [];
      for (let i = 0; i < staged.length; i += 1) {
        const item = staged[i]!;
        if (
          fetchDetail &&
          pendingIndices.length < maxDetailPerRun &&
          item.detailTool !== null &&
          !existingDetailIds.has(item.externalId) &&
          canFetchTool(item.detailTool)
        ) {
          pendingIndices.push(i);
        }
      }

      const mergedByIdx = new Map<number, { item: StageItem; fetched: boolean }>();
      let detailFailures = 0;

      const fetchOne = async (idx: number) => {
        const item = staged[idx]!;
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
          mergedByIdx.set(idx, {
            fetched: true,
            item: {
              ...item,
              title:
                formatted.title ||
                (item.title === "生财有术精选帖" ? deriveTitleFromText(formatted.content) : item.title),
              summary: formatted.summary || item.summary,
              content: formatted.content || item.content,
              author: formatted.author || item.author,
              publishedAt: formatted.publishedAt || item.publishedAt,
              tags: formatted.tags?.length ? [...new Set([...item.tags, ...formatted.tags])].slice(0, 8) : item.tags,
              imageUrl: formatted.imageUrl || item.imageUrl,
            },
          });
        } catch (err) {
          if (err instanceof ScysAuthError) throw err;
          detailFailures += 1;
          ctx.log(`Stage 2 详情抓取失败 (${detailTool} ${item.rawId}): ${err instanceof Error ? err.message : String(err)}`);
          mergedByIdx.set(idx, { fetched: false, item });
        }
      };

      if (pendingIndices.length) {
        const workerCount = Math.min(slotCount, pendingIndices.length);
        let cursor = 0;
        await Promise.all(
          Array.from({ length: workerCount }, async () => {
            while (cursor < pendingIndices.length) {
              const nextIdx = pendingIndices[cursor]!;
              cursor += 1;
              await fetchOne(nextIdx);
            }
          }),
        );
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
        `完成采集: 列表 ${staged.length} 条, 跳过已存在详情 ${existingDetailIds.size} 条, 抓取详情 ${pendingIndices.length} 条 (槽位数=${slotCount})`,
      );
      const degraded =
        pendingIndices.length > 0 && detailFailures === pendingIndices.length
          ? `全部 ${pendingIndices.length} 条详情抓取失败，仅保留列表摘要`
          : null;

      return { items, degraded };
    },
  };
}

export const scysCollector: Collector = createScysCollector();
