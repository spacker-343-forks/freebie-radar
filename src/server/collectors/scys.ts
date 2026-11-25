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

type StageItem = {
  rawId: string;
  externalId: string;
  url: string;
  title: string;
  summary: string;
  content: string;
  author: string | null;
  publishedAt: string | null;
  tags: string[];
  categoryHint: string | null;
  imageUrl: string | null;
  detailTool: "topicDetail" | "projectLibDetail" | "activityManualDetail" | null;
  raw: Record<string, unknown>;
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

function extractTags(obj: Record<string, unknown>, fallbackTag?: string): string[] {
  const raw = obj.tags ?? obj.tagList ?? obj.labels ?? obj.categories ?? obj.tag;
  const out = new Set<string>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string" && item.trim()) out.add(item.trim());
      else {
        const rec = asRecord(item);
        const name = rec ? firstString(rec, ["name", "title", "label", "tagName"]) : "";
        if (name) out.add(name);
      }
    }
  } else if (typeof raw === "string" && raw.trim()) {
    for (const part of raw.split(/[,，、]/)) {
      if (part.trim()) out.add(part.trim());
    }
  }
  if (fallbackTag?.trim()) out.add(fallbackTag.trim());
  return [...out].slice(0, 8);
}

/** Derives a crisp title from the first heading or sentence when a 知识星球 post lacks an explicit title. */
export function deriveTitleFromText(text: string, fallback = "生财有术精选帖"): string {
  const plain = cleanText(
    text
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

function normalizeScysUrl(rawUrl: string, kind: "topic" | "project" | "manual", rawId: string): string {
  if (rawUrl) {
    try {
      const u = new URL(rawUrl, "https://scys.com");
      if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
    } catch {
      /* fall through to canonical URL */
    }
  }
  if (kind === "project") return `https://scys.com/project/${encodeURIComponent(rawId)}`;
  if (kind === "manual") return `https://scys.com/manual/${encodeURIComponent(rawId)}`;
  return `https://scys.com/topic/${encodeURIComponent(rawId)}`;
}

function extractRecordsFromPayload(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.map(asRecord).filter((r): r is Record<string, unknown> => r !== null);
  }
  const root = asRecord(payload);
  if (!root) return [];

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

function flattenManualToc(records: Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (node: Record<string, unknown>, groupTitle?: string) => {
    const children = firstArray(node, ["children", "items", "sections", "articles", "chapters"]);
    const nodeTitle = firstString(node, ["title", "name", "chapterTitle"]);
    const id = firstString(node, ["manualId", "docId", "articleId", "id", "slug"]);
    if (id && !children.length) {
      out.push(groupTitle && !node.tag ? { ...node, tag: groupTitle } : node);
      return;
    }
    if (id && firstString(node, ["url", "link", "content", "summary"])) {
      out.push(groupTitle && !node.tag ? { ...node, tag: groupTitle } : node);
    }
    for (const c of children) {
      const rec = asRecord(c);
      if (rec) visit(rec, nodeTitle || groupTitle);
    }
  };
  for (const r of records) visit(r);
  return out.length ? out : records;
}

function toStageItem(
  rec: Record<string, unknown>,
  mode: ScysMode,
  fallbackTag?: string,
): StageItem | null {
  const kind: "topic" | "project" | "manual" =
    mode === "projects" ? "project" : mode === "manuals" ? "manual" : "topic";

  const rawId = firstString(rec, [
    "topicId",
    "topic_id",
    "projectId",
    "project_id",
    "manualId",
    "docId",
    "articleId",
    "id",
    "slug",
  ]);
  const rawUrl = firstString(rec, ["url", "link", "shareUrl", "jumpUrl"]);
  if (!rawId && !rawUrl) return null;

  const idToken = rawId || rawUrl;
  const externalId = idToken.startsWith("scys-") ? idToken : `scys-${kind}-${idToken}`;
  const url = normalizeScysUrl(rawUrl, kind, idToken);

  const rawBody = firstString(rec, ["content", "text", "body", "description", "summary", "snippet", "abstract"]);
  const explicitTitle = firstString(rec, ["title", "name", "topicTitle", "projectName", "manualTitle"]);
  const title = explicitTitle ? cleanText(explicitTitle, 140) : deriveTitleFromText(rawBody);
  const summary = cleanText(firstString(rec, ["summary", "snippet", "abstract", "description"]) || rawBody, 400);

  const authorObj = asRecord(rec.author) ?? asRecord(rec.user) ?? asRecord(rec.owner);
  const author =
    (authorObj ? firstString(authorObj, ["name", "nickname", "username"]) : "") ||
    firstString(rec, ["author", "authorName", "userName", "creator"]) ||
    null;

  const publishedRaw =
    rec.publishedAt ?? rec.publishTime ?? rec.createTime ?? rec.createdAt ?? rec.created_at ?? rec.updatedAt;
  const publishedAt = parseDate(
    typeof publishedRaw === "string" || typeof publishedRaw === "number" ? publishedRaw : null,
  );

  const imageUrl = sanitizeImageUrl(firstString(rec, ["imageUrl", "cover", "coverUrl", "thumbnail", "image"]), "https://scys.com");

  const detailTool: StageItem["detailTool"] =
    kind === "project" ? "projectLibDetail" : kind === "manual" ? "activityManualDetail" : "topicDetail";

  return {
    rawId: idToken,
    externalId,
    url,
    title,
    summary,
    content: rawBody.slice(0, 8000),
    author,
    publishedAt,
    tags: extractTags(rec, fallbackTag),
    categoryHint: inferScysCategoryHint(title, summary, mode),
    imageUrl,
    detailTool,
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

function formatDetailContent(detail: unknown, fallbackContent: string): {
  content: string;
  title?: string;
  summary?: string;
  author?: string;
  publishedAt?: string | null;
  tags?: string[];
  imageUrl?: string | null;
} {
  if (typeof detail === "string") {
    return { content: detail.slice(0, 8000) };
  }
  const root = asRecord(detail);
  if (!root) return { content: fallbackContent.slice(0, 8000) };
  const rec = asRecord(root.data) ?? asRecord(root.topic) ?? asRecord(root.project) ?? asRecord(root.manual) ?? root;

  const parts: string[] = [];
  const mainBody = firstString(rec, ["content", "text", "body", "detail", "markdown", "description"]);
  if (mainBody) parts.push(mainBody);

  const feishuText = firstString(rec, ["feishuContent", "feishuDoc", "feishuText", "docContent"]);
  if (feishuText) parts.push(`【飞书文档内容】\n${feishuText}`);

  const docs = firstArray(rec, ["feishuDocs", "docs", "attachments"]);
  if (docs.length) {
    const docLines = docs
      .map((d) => {
        const dr = asRecord(d);
        if (!dr) return typeof d === "string" ? d : "";
        const dt = firstString(dr, ["title", "name"]);
        const dc = firstString(dr, ["content", "text", "summary", "url"]);
        return [dt, dc].filter(Boolean).join(": ");
      })
      .filter(Boolean);
    if (docLines.length) parts.push(`【关联文档】\n${docLines.join("\n")}`);
  }

  const comments = firstArray(rec, ["comments", "topComments", "replies"]);
  if (comments.length) {
    const commentLines = comments
      .slice(0, 10)
      .map((c) => {
        const cr = asRecord(c);
        if (!cr) return typeof c === "string" ? c : "";
        const cAuthor = firstString(cr, ["author", "authorName", "userName", "nickname"]);
        const cText = firstString(cr, ["content", "text", "body"]);
        return cText ? `${cAuthor ? `${cAuthor}: ` : ""}${cText}` : "";
      })
      .filter(Boolean);
    if (commentLines.length) parts.push(`【精选评论】\n${commentLines.join("\n")}`);
  }

  const merged = (parts.join("\n\n") || fallbackContent).trim().slice(0, 8000);
  const authorObj = asRecord(rec.author) ?? asRecord(rec.user);
  const author =
    (authorObj ? firstString(authorObj, ["name", "nickname"]) : "") ||
    firstString(rec, ["author", "authorName", "userName"]) ||
    undefined;
  const pubRaw = rec.publishedAt ?? rec.publishTime ?? rec.createTime ?? rec.createdAt;
  const publishedAt = parseDate(typeof pubRaw === "string" || typeof pubRaw === "number" ? pubRaw : null);
  const explicitTitle = firstString(rec, ["title", "name", "topicTitle", "projectName"]);
  const tags = extractTags(rec);

  return {
    content: merged,
    title: explicitTitle ? cleanText(explicitTitle, 140) : undefined,
    summary: cleanText(firstString(rec, ["summary", "abstract"]) || mainBody || merged, 400),
    author,
    publishedAt,
    tags: tags.length ? tags : undefined,
    imageUrl: sanitizeImageUrl(firstString(rec, ["imageUrl", "cover", "coverUrl", "image"]), "https://scys.com"),
  };
}

function findExistingDetailKeys(sourceId: string, candidates: StageItem[]): Set<string> {
  if (!candidates.length) return new Set();
  const extIds = candidates.map((c) => c.externalId);
  const placeholders = extIds.map(() => "?").join(", ");
  const existing = new Set<string>();
  try {
    const rows = all<{ external_id: string }>(
      `SELECT external_id FROM items
       WHERE ((source_id = ? AND external_id IN (${placeholders})) OR external_id IN (${placeholders}))
         AND content IS NOT NULL AND TRIM(content) != ''`,
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

      const hasTool = (name: string) => !schemas.length || schemas.some((s) => s.name === name);
      let stage1Tool = "searchTopic";
      if (mode === "projects") {
        stage1Tool = hasTool("projectLibSearch") ? "projectLibSearch" : "searchProjectCases";
      } else if (mode === "manuals") {
        stage1Tool = keyword && hasTool("activityManualSearch") ? "activityManualSearch" : "activityManualToc";
      }

      const stage1Args = buildToolArgs(
        stage1Tool,
        schemas,
        {
          mode,
          keyword,
          tag,
          pageSize,
          page: 1,
          compact: true,
        },
        stage1Override ?? undefined,
      );

      ctx.log(`Stage 1 调用 ${stage1Tool}(mode=${mode}, pageSize=${pageSize})`);
      const stage1Res = await client.callTool<unknown>(stage1Tool, stage1Args);
      let records = extractRecordsFromPayload(stage1Res);
      if (stage1Tool === "activityManualToc") {
        records = flattenManualToc(records);
      }

      const staged = records
        .map((r) => toStageItem(r, mode, tag))
        .filter((x): x is StageItem => x !== null)
        .slice(0, pageSize);

      const existingDetailIds = findExistingDetailKeys(ctx.sourceId, staged);
      let detailCalls = 0;
      let detailFailures = 0;
      const items: RawItem[] = [];

      for (const item of staged) {
        let merged = item;
        let fetchedDetail = false;
        const shouldFetchDetail =
          fetchDetail &&
          detailCalls < maxDetailPerRun &&
          item.detailTool !== null &&
          !existingDetailIds.has(item.externalId) &&
          hasTool(item.detailTool);

        if (shouldFetchDetail && item.detailTool) {
          detailCalls += 1;
          try {
            const detailArgs = buildToolArgs(
              item.detailTool,
              schemas,
              { topicId: item.rawId },
              detailOverride ?? undefined,
            );
            const detailRes = await client.callTool<unknown>(item.detailTool, detailArgs);
            const formatted = formatDetailContent(detailRes, item.content);
            fetchedDetail = true;
            merged = {
              ...item,
              title: formatted.title || (item.title === "生财有术精选帖" ? deriveTitleFromText(formatted.content) : item.title),
              summary: formatted.summary || item.summary,
              content: formatted.content || item.content,
              author: formatted.author || item.author,
              publishedAt: formatted.publishedAt || item.publishedAt,
              tags: formatted.tags?.length ? [...new Set([...item.tags, ...formatted.tags])].slice(0, 8) : item.tags,
              imageUrl: formatted.imageUrl || item.imageUrl,
            };
          } catch (err) {
            if (err instanceof ScysAuthError) throw err;
            detailFailures += 1;
            ctx.log(`Stage 2 详情抓取失败 (${item.detailTool} ${item.rawId}): ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        const outContent = fetchDetail ? (fetchedDetail ? merged.content || null : null) : merged.content || null;

        items.push({
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
          raw: { mode, stage1Tool, ...merged.raw },
        });
      }

      ctx.log(`完成采集: 列表 ${staged.length} 条, 跳过已存在详情 ${existingDetailIds.size} 条, 抓取详情 ${detailCalls} 条`);
      const degraded =
        detailCalls > 0 && detailFailures === detailCalls
          ? `全部 ${detailCalls} 条详情抓取失败，仅保留列表摘要`
          : null;

      return { items, degraded };
    },
  };
}

export const scysCollector: Collector = createScysCollector();
