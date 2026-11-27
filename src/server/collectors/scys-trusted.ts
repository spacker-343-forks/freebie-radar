import { all } from "../db.ts";
import { cleanText, sanitizeImageUrl } from "../enrich/normalize.ts";
import {
  buildToolArgs,
  ScysAuthError,
  ScysMcpClient,
  type McpToolSchema,
  type ScysMcpClientOptions,
} from "../scys/mcp-client.ts";
import { MAX_ARCHIVE_CONTENT_CHARS, parseScysTimestamp } from "./scys.ts";
import type { CollectContext, Collector, RawItem } from "./types.ts";

export type ScysTrustedSourceType = "wechat_mp" | "twitter" | "navigator_chat_highlight";

export const DEFAULT_TRUSTED_SOURCE_TYPES: readonly ScysTrustedSourceType[] = [
  "wechat_mp",
  "twitter",
  "navigator_chat_highlight",
];

export const MAX_TRUSTED_CONTENT_CHARS = MAX_ARCHIVE_CONTENT_CHARS;

const VALID_SOURCE_TYPES = new Set<ScysTrustedSourceType>(DEFAULT_TRUSTED_SOURCE_TYPES);
const VALID_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_SECTION_CHARS = 50_000;
const MAX_OFFSET_CHUNKS_PER_SECTION = 25;
const MAX_SECTIONS_PER_ITEM = 60;

type TrustedSectionMeta = {
  sectionId: string;
  title?: string;
  theme?: string | null;
  infoDate?: string | null;
};

type StageTrustedItem = {
  sourceType: ScysTrustedSourceType;
  itemId: string;
  externalId: string;
  url: string;
  title: string;
  summary: string;
  author: string | null;
  accountName: string;
  accountKey: string;
  publishedAt: string | null;
  startDate: string;
  endDate: string;
  isSummaryOnly: boolean;
  sections: TrustedSectionMeta[];
  tags: string[];
  imageUrl: string | null;
  snippet: string;
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

function isValidSourceType(v: unknown): v is ScysTrustedSourceType {
  return typeof v === "string" && VALID_SOURCE_TYPES.has(v as ScysTrustedSourceType);
}

/** Parses `YYYY-MM-DD HH:mm:ss` / `YYYY-MM-DD` (assumed UTC+8 SCYS server time) or standard timestamps into UTC ISO. */
export function parseTrustedTimestamp(input: unknown): string | null {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return null;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) {
      const iso = `${trimmed.replace(" ", "T")}+08:00`;
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const d = new Date(`${trimmed}T00:00:00+08:00`);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
  }
  return parseScysTimestamp(input);
}

/** Normalizes `originalUrl` when valid http(s), otherwise falls back to a unique canonical SCYS trusted URL. */
export function normalizeTrustedUrl(
  rawUrl: string | null | undefined,
  sourceType: ScysTrustedSourceType,
  itemId: string,
): string {
  const trimmed = (rawUrl ?? "").trim();
  if (trimmed) {
    try {
      const u = new URL(trimmed);
      if (u.protocol === "http:" || u.protocol === "https:") {
        return u.toString();
      }
    } catch {
      /* fall through to canonical fallback URL */
    }
  }
  return `https://scys.com/trusted/${encodeURIComponent(sourceType)}/${encodeURIComponent(itemId)}`;
}

function formatNavigatorPeriod(startDate?: string, endDate?: string, publishedAt?: string | null): string {
  const s = (startDate ?? "").trim();
  const e = (endDate ?? "").trim();
  if (s && e) {
    const sMonth = s.slice(0, 7);
    const eMonth = e.slice(0, 7);
    if (VALID_MONTH_RE.test(sMonth) && sMonth === eMonth) {
      return sMonth;
    }
    return s === e ? s : `${s}~${e}`;
  }
  if (s) return s;
  if (e) return e;
  if (publishedAt) return publishedAt.slice(0, 7);
  return "";
}

/** Builds a single-line meta header matching `snapshot.ts` `META_HEADER_RE`. */
export function buildTrustedMetaHeader(params: {
  sourceType: ScysTrustedSourceType;
  accountName?: string | null;
  publishedAt?: string | null;
  startDate?: string;
  endDate?: string;
}): string {
  const account = (params.accountName ?? "").trim();
  if (params.sourceType === "wechat_mp") {
    return account ? `【来源】微信公众号 · ${account}` : "【来源】微信公众号";
  }
  if (params.sourceType === "twitter") {
    return account ? `【来源】X(Twitter) · ${account}` : "【来源】X(Twitter)";
  }
  const period = formatNavigatorPeriod(params.startDate, params.endDate, params.publishedAt);
  return period ? `【来源】航海家群聊精华 · ${period}` : "【来源】航海家群聊精华";
}

function sourceTypeTag(sourceType: ScysTrustedSourceType): string {
  if (sourceType === "wechat_mp") return "公众号";
  if (sourceType === "twitter") return "X/Twitter";
  return "航海家群聊";
}

function extractFirstMarkdownImageUrl(markdown: string): string | null {
  const m = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/i.exec(markdown);
  return m?.[1] ? sanitizeImageUrl(m[1], "https://scys.com") : null;
}

function isNavigatorPermissionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /航海家|无权限|没有.*权限|权限|forbidden|permission|unauthorized|access\s*denied|403/i.test(msg);
}

function parseSourceTypes(cfg: Record<string, unknown>, accountKey?: string): ScysTrustedSourceType[] {
  if (Array.isArray(cfg.sourceTypes)) {
    const out = [...new Set(cfg.sourceTypes.filter(isValidSourceType))];
    if (out.length) return out;
  }
  if (isValidSourceType(cfg.sourceType)) {
    return [cfg.sourceType];
  }
  if (accountKey) {
    return ["wechat_mp", "twitter"];
  }
  return [...DEFAULT_TRUSTED_SOURCE_TYPES];
}

function extractStageItems(
  payload: unknown,
  fallbackSourceType: ScysTrustedSourceType,
): StageTrustedItem[] {
  const root = asRecord(payload);
  const rawList = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.items)
      ? root.items
      : Array.isArray(root?.list)
        ? root.list
        : [];

  const out: StageTrustedItem[] = [];
  for (const rawEntry of rawList) {
    const rec = asRecord(rawEntry);
    if (!rec) continue;

    const rawSourceType = rec.sourceType;
    const sourceType: ScysTrustedSourceType = isValidSourceType(rawSourceType)
      ? rawSourceType
      : fallbackSourceType;
    const itemId = firstString(rec, ["itemId", "id"]);
    if (!itemId) continue;

    const accountName = firstString(rec, ["accountName", "author", "authorName"]);
    const accountKey = firstString(rec, ["accountKey"]);
    const startDate = firstString(rec, ["startDate"]);
    const endDate = firstString(rec, ["endDate"]);
    const publishedAt = parseTrustedTimestamp(rec.publishedAt ?? endDate ?? startDate);
    const snippet = firstString(rec, ["snippet", "summary", "abstract"]);
    const explicitTitle = firstString(rec, ["titleZh", "title", "itemTitle"]);

    const fallbackTitle =
      sourceType === "wechat_mp"
        ? accountName
          ? `${accountName} · 公众号文章`
          : `微信公众号收录 (${itemId})`
        : sourceType === "twitter"
          ? accountName
            ? `${accountName} · X 动态`
            : `X(Twitter) 收录 (${itemId})`
          : startDate
            ? `航海家群聊精华 (${startDate.slice(0, 7)})`
            : `航海家群聊精华 (${itemId})`;

    const title = cleanText(explicitTitle || snippet || fallbackTitle, 140) || fallbackTitle;
    const originalUrl = firstString(rec, ["originalUrl", "url", "link"]);
    const url = normalizeTrustedUrl(originalUrl, sourceType, itemId);

    const rawSections = Array.isArray(rec.sections) ? rec.sections : [];
    const sections: TrustedSectionMeta[] = [];
    for (const sRaw of rawSections) {
      const sRec = asRecord(sRaw);
      if (!sRec) continue;
      const sectionId = firstString(sRec, ["sectionId", "id"]);
      if (!sectionId) continue;
      const sTitle = firstString(sRec, ["title"]);
      const sTheme = typeof sRec.theme === "string" && sRec.theme.trim() ? sRec.theme.trim() : null;
      const sInfoDate = typeof sRec.infoDate === "string" && sRec.infoDate.trim() ? sRec.infoDate.trim() : null;
      sections.push({
        sectionId,
        ...(sTitle ? { title: sTitle } : {}),
        theme: sTheme,
        infoDate: sInfoDate,
      });
    }

    const tagsSet = new Set<string>([sourceTypeTag(sourceType)]);
    for (const s of sections) {
      if (s.theme) tagsSet.add(s.theme);
    }

    const metaHeader = buildTrustedMetaHeader({
      sourceType,
      accountName,
      publishedAt,
      startDate,
      endDate,
    });
    const summary = cleanText([metaHeader, snippet || title].filter(Boolean).join(" | "), 400);

    out.push({
      sourceType,
      itemId,
      externalId: `scys-trusted-${sourceType}-${itemId}`,
      url,
      title,
      summary,
      author: accountName || (sourceType === "navigator_chat_highlight" ? "航海家群聊" : null),
      accountName,
      accountKey,
      publishedAt,
      startDate,
      endDate,
      isSummaryOnly: Boolean(rec.isSummaryOnly),
      sections,
      tags: [...tagsSet].slice(0, 6),
      imageUrl: sanitizeImageUrl(firstString(rec, ["imageUrl", "cover", "coverUrl"]), "https://scys.com"),
      snippet,
      raw: rec,
    });
  }
  return out;
}

function findExistingTrustedContentKeys(sourceId: string, candidates: StageTrustedItem[]): Set<string> {
  const existing = new Set<string>();
  if (!candidates.length) return existing;
  const extIds = candidates.map((c) => c.externalId);
  const placeholders = extIds.map(() => "?").join(", ");
  try {
    const rows = all<{ external_id: string }>(
      `SELECT external_id FROM items
       WHERE ((source_id = ? AND external_id IN (${placeholders})) OR external_id IN (${placeholders}))
         AND content IS NOT NULL AND TRIM(content) != ''`,
      sourceId,
      ...extIds,
      ...extIds,
    );
    for (const r of rows) {
      existing.add(r.external_id);
    }
  } catch {
    /* ignore when DB is uninitialized in pure unit helper tests */
  }
  return existing;
}

function isGenericSectionTitle(secTitle: string, itemTitle: string): boolean {
  const t = secTitle.trim();
  if (!t) return true;
  if (t === "全文" || t === itemTitle.trim()) return true;
  return false;
}

function bodyAlreadyStartsWithHeading(body: string, headingText: string): boolean {
  const firstLine = body.trimStart().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine.startsWith("#")) return false;
  const stripped = firstLine.replace(/^#{1,6}\s+/, "").trim();
  return stripped === headingText.trim();
}

async function fetchFullTrustedContent(
  client: ScysMcpClient,
  schemas: McpToolSchema[],
  item: StageTrustedItem,
  options: {
    lang: "zh" | "original";
    maxCharsPerSection: number;
    overrides?: Record<string, unknown>;
  },
): Promise<{
  content: string;
  title: string;
  url: string;
  author: string | null;
  publishedAt: string | null;
  imageUrl: string | null;
  isSummaryOnly: boolean;
}> {
  const queue: TrustedSectionMeta[] = [...item.sections];
  const visitedSectionIds = new Set<string>();
  const formattedSections: string[] = [];

  let resolvedTitle = item.title;
  let resolvedUrl = item.url;
  let resolvedAccountName = item.accountName;
  let resolvedPublishedAt = item.publishedAt;
  let resolvedIsSummaryOnly = item.isSummaryOnly;
  let totalRawChars = 0;
  let lastTheme = "";
  let fetchedSectionCount = 0;

  while (
    queue.length > 0 &&
    visitedSectionIds.size < MAX_SECTIONS_PER_ITEM &&
    totalRawChars < MAX_TRUSTED_CONTENT_CHARS
  ) {
    const sec = queue.shift()!;
    if (!sec.sectionId || visitedSectionIds.has(sec.sectionId)) continue;
    visitedSectionIds.add(sec.sectionId);

    const partChunks: string[] = [];
    const seenOffsets = new Set<number>();
    let offset: number | undefined;
    let secTitle = sec.title ?? "";
    let secTheme = sec.theme ?? null;
    let nextSectionId = "";

    for (let chunkIdx = 0; chunkIdx < MAX_OFFSET_CHUNKS_PER_SECTION; chunkIdx += 1) {
      const args = buildToolArgs(
        "getTrustedContentSection",
        schemas,
        {
          sourceType: item.sourceType,
          itemId: item.itemId,
          sectionId: sec.sectionId,
          ...(offset !== undefined ? { offset } : {}),
          maxChars: options.maxCharsPerSection,
          lang: options.lang,
        },
        options.overrides,
      );

      const res = await client.callTool<unknown>("getTrustedContentSection", args);
      if (typeof res === "string") {
        if (res) {
          partChunks.push(res);
          totalRawChars += res.length;
        }
        break;
      }

      const rec = asRecord(res);
      if (!rec) break;

      const chunkContent = typeof rec.content === "string" ? rec.content : "";
      if (chunkContent) {
        partChunks.push(chunkContent);
        totalRawChars += chunkContent.length;
      }

      const detailTitle = firstString(rec, ["titleZh", "itemTitle"]);
      if (detailTitle) resolvedTitle = cleanText(detailTitle, 140) || resolvedTitle;
      const detailAcc = firstString(rec, ["accountName"]);
      if (detailAcc) resolvedAccountName = detailAcc;
      const detailOrigUrl = firstString(rec, ["originalUrl"]);
      if (detailOrigUrl) resolvedUrl = normalizeTrustedUrl(detailOrigUrl, item.sourceType, item.itemId);
      const detailPub = parseTrustedTimestamp(rec.publishedAt);
      if (detailPub && !resolvedPublishedAt) resolvedPublishedAt = detailPub;
      if (typeof rec.isSummaryOnly === "boolean") resolvedIsSummaryOnly = rec.isSummaryOnly;

      if (!secTitle) {
        const t = firstString(rec, ["title"]);
        if (t) secTitle = t;
      }
      if (typeof rec.theme === "string" && rec.theme.trim()) {
        secTheme = rec.theme.trim();
      }
      const nsid = firstString(rec, ["nextSectionId"]);
      if (nsid) nextSectionId = nsid;

      const truncated = rec.truncated === true;
      const nextOff = Number(rec.nextOffset);
      if (
        truncated &&
        Number.isFinite(nextOff) &&
        nextOff > (offset ?? 0) &&
        !seenOffsets.has(nextOff) &&
        totalRawChars < MAX_TRUSTED_CONTENT_CHARS
      ) {
        seenOffsets.add(nextOff);
        offset = nextOff;
        continue;
      }
      break;
    }

    if (
      nextSectionId &&
      !visitedSectionIds.has(nextSectionId) &&
      !queue.some((q) => q.sectionId === nextSectionId)
    ) {
      queue.unshift({ sectionId: nextSectionId, ...(secTheme ? { theme: secTheme } : {}) });
    }

    const sectionBody = partChunks.join("").trim();
    if (!sectionBody) continue;
    fetchedSectionCount += 1;

    const multiSection = item.sections.length > 1 || Boolean(nextSectionId) || queue.length > 0 || fetchedSectionCount > 1;
    const sectionPrefixLines: string[] = [];

    if (secTheme && secTheme !== lastTheme) {
      sectionPrefixLines.push(`## ${secTheme}`);
      lastTheme = secTheme;
    }

    const showSectionTitle =
      !isGenericSectionTitle(secTitle, resolvedTitle) && (multiSection || Boolean(secTheme) || Boolean(sec.infoDate));
    const titleLabel = showSectionTitle
      ? `${secTitle.trim()}${sec.infoDate ? ` (${sec.infoDate})` : ""}`
      : sec.infoDate && (multiSection || Boolean(secTheme))
        ? sec.infoDate
        : "";

    if (titleLabel && !bodyAlreadyStartsWithHeading(sectionBody, titleLabel)) {
      const level = secTheme ? "###" : "##";
      sectionPrefixLines.push(`${level} ${titleLabel}`);
    }

    if (sectionPrefixLines.length) {
      formattedSections.push(`${sectionPrefixLines.join("\n\n")}\n\n${sectionBody}`);
    } else {
      formattedSections.push(sectionBody);
    }
  }

  const metaHeader = buildTrustedMetaHeader({
    sourceType: item.sourceType,
    accountName: resolvedAccountName,
    publishedAt: resolvedPublishedAt,
    startDate: item.startDate,
    endDate: item.endDate,
  });

  const bodyBlocks: string[] = [metaHeader];
  if (formattedSections.length) {
    bodyBlocks.push(...formattedSections);
  } else if (item.snippet) {
    bodyBlocks.push(item.snippet);
  }

  if (resolvedIsSummaryOnly) {
    bodyBlocks.push(
      resolvedUrl
        ? `> 注：该博主仅开放摘要，完整原文请查看：${resolvedUrl}`
        : "> 注：该博主仅开放摘要。",
    );
  }

  const mergedContent = bodyBlocks.filter(Boolean).join("\n\n").slice(0, MAX_TRUSTED_CONTENT_CHARS);
  const coverImage = item.imageUrl || extractFirstMarkdownImageUrl(mergedContent);

  return {
    content: mergedContent,
    title: resolvedTitle,
    url: resolvedUrl,
    author: resolvedAccountName || item.author,
    publishedAt: resolvedPublishedAt,
    imageUrl: coverImage,
    isSummaryOnly: resolvedIsSummaryOnly,
  };
}

function interleaveBySourceType(
  buckets: StageTrustedItem[][],
  limit: number,
): StageTrustedItem[] {
  const seen = new Set<string>();
  const out: StageTrustedItem[] = [];
  const totalAvailable = buckets.reduce((acc, b) => acc + b.length, 0);

  if (totalAvailable <= limit) {
    for (const bucket of buckets) {
      for (const item of bucket) {
        if (!seen.has(item.externalId)) {
          seen.add(item.externalId);
          out.push(item);
        }
      }
    }
    return out;
  }

  let idx = 0;
  while (out.length < limit) {
    let pushedAny = false;
    for (const bucket of buckets) {
      if (idx < bucket.length) {
        const item = bucket[idx]!;
        if (!seen.has(item.externalId)) {
          seen.add(item.externalId);
          out.push(item);
          if (out.length >= limit) break;
        }
        pushedAny = true;
      }
    }
    if (!pushedAny) break;
    idx += 1;
  }
  return out;
}

export function createScysTrustedCollector(
  clientFactory?: (cfg: Record<string, unknown>) => ScysMcpClient,
): Collector {
  return {
    kind: "scys-trusted",
    label: "生财有术 · 收录文库与群聊精华",
    defaults: {
      config: {
        sourceTypes: [...DEFAULT_TRUSTED_SOURCE_TYPES],
        pageSize: 15,
        fetchDetail: true,
        maxDetailPerRun: 12,
      },
    },
    async collect(ctx: CollectContext) {
      const cfg = ctx.config ?? {};
      const keyword =
        typeof cfg.keyword === "string" && cfg.keyword.trim()
          ? cfg.keyword.trim().slice(0, 100)
          : undefined;
      const accountKey =
        typeof cfg.accountKey === "string" && cfg.accountKey.trim()
          ? cfg.accountKey.trim()
          : undefined;
      const monthRaw = typeof cfg.month === "string" ? cfg.month.trim() : "";
      const month = VALID_MONTH_RE.test(monthRaw) ? monthRaw : undefined;
      const sourceTypes = parseSourceTypes(cfg, accountKey);

      const pageIndex = Math.max(1, Math.round(Number(cfg.pageIndex ?? cfg.page ?? 1) || 1));
      const pageSize = Math.min(20, Math.max(1, Math.round(Number(cfg.pageSize ?? 15) || 15)));
      const maxTotalItems = ctx.maxItems > 0 ? ctx.maxItems : pageSize * sourceTypes.length;
      const fetchDetail = cfg.fetchDetail !== false;
      const maxDetailPerRun = fetchDetail ? Math.max(0, Number(cfg.maxDetailPerRun ?? 12)) : 0;
      const lang: "zh" | "original" = cfg.lang === "original" ? "original" : "zh";
      const maxCharsPerSection = Math.min(
        MAX_SECTION_CHARS,
        Math.max(1, Math.round(Number(cfg.maxCharsPerSection ?? MAX_SECTION_CHARS) || MAX_SECTION_CHARS)),
      );

      const toolArgsRoot = asRecord(cfg.toolArgs) ?? {};
      const stage1Override =
        asRecord(toolArgsRoot.list) ?? (asRecord(toolArgsRoot.detail) ? undefined : toolArgsRoot);
      const detailOverride = asRecord(toolArgsRoot.detail);

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

      const hasAnySchema = schemas.length > 0;
      const hasTool = (name: string) => schemas.some((s) => s.name === name);
      const canFetchSection = !hasAnySchema || hasTool("getTrustedContentSection");

      const buckets: StageTrustedItem[][] = [];
      const degradedNotes: string[] = [];

      for (const sourceType of sourceTypes) {
        const searchArgs = buildToolArgs(
          "searchTrustedContent",
          schemas,
          {
            sourceType,
            keyword,
            ...(sourceType !== "navigator_chat_highlight" && accountKey ? { accountKey } : {}),
            month,
            page: pageIndex,
            pageSize,
          },
          stage1Override ?? undefined,
        );

        ctx.log(
          `Stage 1 调用 searchTrustedContent(sourceType=${sourceType}, pageIndex=${pageIndex}, pageSize=${pageSize})`,
        );

        try {
          const res = await client.callTool<unknown>("searchTrustedContent", searchArgs);
          const parsed = extractStageItems(res, sourceType);
          buckets.push(parsed);
        } catch (err) {
          if (err instanceof ScysAuthError) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          if (sourceType === "navigator_chat_highlight") {
            ctx.log(`航海家群聊精华检索已降级跳过 (无权限或暂不可用): ${msg}`);
            degradedNotes.push(`navigator_chat_highlight 已降级跳过: ${msg}`);
          } else {
            ctx.log(`Stage 1 检索失败 (${sourceType}): ${msg}`);
            degradedNotes.push(`${sourceType} 检索失败: ${msg}`);
          }
          buckets.push([]);
        }
      }

      const staged = interleaveBySourceType(buckets, maxTotalItems);
      const existingKeys = findExistingTrustedContentKeys(ctx.sourceId, staged);

      const detailQueueIndices: number[] = [];
      for (let i = 0; i < staged.length; i += 1) {
        const item = staged[i]!;
        if (existingKeys.has(item.externalId)) continue;
        if (!fetchDetail || !canFetchSection || !item.sections.length) continue;
        if (detailQueueIndices.length >= maxDetailPerRun) continue;
        detailQueueIndices.push(i);
      }

      const detailResults = new Map<
        number,
        {
          fetched: boolean;
          content?: string;
          title?: string;
          url?: string;
          author?: string | null;
          publishedAt?: string | null;
          imageUrl?: string | null;
          isSummaryOnly?: boolean;
        }
      >();
      let detailFailures = 0;

      if (detailQueueIndices.length) {
        const slotCount = Math.max(1, client.getSlotCount());
        const capacity =
          typeof client.getConcurrencyCapacity === "function" ? client.getConcurrencyCapacity() : slotCount;
        const workerCount = Math.min(Math.max(1, capacity), detailQueueIndices.length);
        let cursor = 0;

        await Promise.all(
          Array.from({ length: workerCount }, async () => {
            while (cursor < detailQueueIndices.length) {
              const idx = detailQueueIndices[cursor]!;
              cursor += 1;
              const item = staged[idx]!;
              try {
                const detail = await fetchFullTrustedContent(client, schemas, item, {
                  lang,
                  maxCharsPerSection,
                  overrides: detailOverride ?? undefined,
                });
                detailResults.set(idx, { fetched: true, ...detail });
              } catch (err) {
                if (err instanceof ScysAuthError) throw err;
                detailFailures += 1;
                const msg = err instanceof Error ? err.message : String(err);
                if (item.sourceType === "navigator_chat_highlight" && isNavigatorPermissionError(err)) {
                  ctx.log(`航海家群聊精华详情无权限，已跳过 (${item.itemId}): ${msg}`);
                  degradedNotes.push(`navigator_chat_highlight(${item.itemId}) 无权限跳过`);
                } else {
                  ctx.log(`Stage 2 详情抓取失败 (${item.sourceType}/${item.itemId}): ${msg}`);
                }
                detailResults.set(idx, { fetched: false });
              }
            }
          }),
        );
      }

      const items: RawItem[] = staged.map((item, idx) => {
        const res = detailResults.get(idx);
        const fetched = res?.fetched ?? false;
        let outContent: string | null = null;
        if (fetched && res?.content) {
          outContent = res.content;
        } else if (!fetchDetail && item.snippet) {
          outContent = `${buildTrustedMetaHeader({
            sourceType: item.sourceType,
            accountName: item.accountName,
            publishedAt: item.publishedAt,
            startDate: item.startDate,
            endDate: item.endDate,
          })}\n\n${item.snippet}`.slice(0, MAX_TRUSTED_CONTENT_CHARS);
        }

        return {
          externalId: item.externalId,
          url: res?.url || item.url,
          title: res?.title || item.title,
          summary: item.summary,
          content: outContent,
          author: res?.author ?? item.author,
          publishedAt: res?.publishedAt ?? item.publishedAt,
          tags: item.tags,
          categoryHint: null,
          kindHint: "info",
          imageUrl: res?.imageUrl ?? item.imageUrl,
          raw: {
            stage1Tool: "searchTrustedContent",
            sourceType: item.sourceType,
            itemId: item.itemId,
            ...(item.accountKey ? { accountKey: item.accountKey } : {}),
            ...(typeof res?.isSummaryOnly === "boolean"
              ? { isSummaryOnly: res.isSummaryOnly }
              : item.isSummaryOnly
                ? { isSummaryOnly: true }
                : {}),
            ...item.raw,
          },
        };
      });

      ctx.log(
        `完成采集: 列表 ${staged.length} 条, 跳过已有详情 ${existingKeys.size} 条, 抓取详情 ${detailQueueIndices.length} 条 (失败 ${detailFailures} 条)`,
      );

      const allDetailsFailed =
        detailQueueIndices.length > 0 && detailFailures === detailQueueIndices.length
          ? `全部 ${detailQueueIndices.length} 条详情抓取失败，仅保留列表摘要`
          : null;
      const degraded = allDetailsFailed ?? (degradedNotes.length ? degradedNotes.join("; ") : null);

      return { items, degraded };
    },
  };
}

export const scysTrustedCollector: Collector = createScysTrustedCollector();
