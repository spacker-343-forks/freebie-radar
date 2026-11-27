import { cleanText } from "../enrich/normalize.ts";
import { ScysMcpClient, type ScysMcpClientOptions } from "../scys/mcp-client.ts";
import { parseScysTimestamp } from "./scys.ts";
import type { CollectContext, Collector, RawItem } from "./types.ts";

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

function normalizeHttpUrl(raw: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
  } catch {
    /* ignore malformed external URL */
  }
  return null;
}

/**
 * Parses `ai__listAiFeedItems` timestamps (`"MM-DD HH:mm"` without year, or full ISO/unix timestamps).
 * Uses Asia/Shanghai time for month-day inputs and rolls back 1 year if the inferred date falls in the future.
 */
export function parseAiFeedPublishedAt(input: unknown, now = new Date()): string | null {
  if (typeof input === "string") {
    const trimmed = input.trim();
    const mdMatch = /^(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(trimmed);
    if (mdMatch) {
      const month = Number(mdMatch[1]);
      const day = Number(mdMatch[2]);
      const hour = Number(mdMatch[3] ?? 0);
      const minute = Number(mdMatch[4] ?? 0);
      const second = Number(mdMatch[5] ?? 0);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour <= 23 && minute <= 59 && second <= 59) {
        const shanghaiYear = Number(
          new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Shanghai",
            year: "numeric",
          }).format(now),
        );
        let candidateMs = Date.UTC(shanghaiYear, month - 1, day, hour - 8, minute, second);
        if (candidateMs > now.getTime() + 86_400_000) {
          candidateMs = Date.UTC(shanghaiYear - 1, month - 1, day, hour - 8, minute, second);
        }
        const d = new Date(candidateMs);
        if (!Number.isNaN(d.getTime())) return d.toISOString();
      }
    }

    const ymdMatch = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
    if (ymdMatch) {
      const ms = Date.UTC(
        Number(ymdMatch[1]),
        Number(ymdMatch[2]) - 1,
        Number(ymdMatch[3]),
        Number(ymdMatch[4]) - 8,
        Number(ymdMatch[5]),
        Number(ymdMatch[6] ?? 0),
      );
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  return parseScysTimestamp(input);
}

function extractAiFeedTags(rec: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const singleTag = firstString(rec, ["tag", "category"]);
  if (singleTag) {
    for (const part of singleTag.split(/[,，、]/)) {
      if (part.trim()) out.add(part.trim());
    }
  }
  for (const field of ["signals", "tags", "tagList"]) {
    const arr = rec[field];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (typeof entry === "string" && entry.trim()) out.add(entry.trim());
    }
  }
  return [...out].slice(0, 8);
}

function toAiFeedRawItem(rec: Record<string, unknown>, now = new Date()): RawItem | null {
  const id = firstString(rec, ["candidateId", "id", "itemId", "feedId"]);
  if (!id) return null;

  const externalId = `scys-aifeed-${id}`;
  const rawSourceUrl = firstString(rec, ["sourceUrl", "url", "link", "originalUrl"]);
  const url = normalizeHttpUrl(rawSourceUrl) ?? `https://scys.com/ai-feed/${encodeURIComponent(id)}`;

  const sourceName = firstString(rec, ["sourceName", "author", "source"]);
  const tag = firstString(rec, ["tag", "category"]);
  const signals = Array.isArray(rec.signals)
    ? rec.signals.filter((s): s is string => typeof s === "string" && Boolean(s.trim())).map((s) => s.trim())
    : [];

  const title = cleanText(firstString(rec, ["title", "name"]), 180) || `生财 AI 情报 #${id}`;
  const summaryText = firstString(rec, ["summary", "abstract"]);
  const detailText = firstString(rec, ["detail", "content", "description"]);
  const opportunityText = firstString(rec, ["opportunity"]);

  const metaParts = ["生财 AI 情报流"];
  if (sourceName) metaParts.push(sourceName);
  if (tag) metaParts.push(tag);
  const metaHeader = `【来源】${metaParts.join(" · ")}`;

  const contentSections: string[] = [metaHeader];
  if (summaryText) contentSections.push(`## 核心情报\n\n${summaryText}`);
  if (detailText) contentSections.push(`## 深度解读\n\n${detailText}`);
  if (opportunityText) contentSections.push(`## 商业机会\n\n${opportunityText}`);
  if (signals.length) contentSections.push(`**信号标签**：${signals.join(" / ")}`);
  if (rawSourceUrl) {
    const safeUrl = normalizeHttpUrl(rawSourceUrl);
    contentSections.push(
      safeUrl ? `**原始信源**：[${sourceName || safeUrl}](${safeUrl})` : `**原始信源**：${rawSourceUrl}`,
    );
  }

  const summary = cleanText(
    [sourceName ? `[${sourceName}]` : "", summaryText || detailText || title].filter(Boolean).join(" "),
    400,
  );

  return {
    externalId,
    url,
    title,
    summary,
    content: contentSections.join("\n\n"),
    author: sourceName || null,
    publishedAt: parseAiFeedPublishedAt(rec.publishedAt ?? rec.publishTime ?? rec.createdAt, now),
    tags: extractAiFeedTags(rec),
    categoryHint: "ai",
    kindHint: "info",
    raw: rec,
  };
}

export function createScysAiFeedCollector(
  clientFactory?: (cfg: Record<string, unknown>) => ScysMcpClient,
): Collector {
  return {
    kind: "scys-ai-feed",
    label: "生财有术 · 官方 AI 情报流",
    defaults: {
      config: { limit: 30 },
    },
    async collect(ctx: CollectContext) {
      const cfg = ctx.config ?? {};
      const rawLimit = Number(cfg.limit ?? ctx.maxItems ?? 30);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.round(rawLimit), 1), 50) : 30;

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
      ctx.log(`调用 ai__listAiFeedItems (limit=${limit})`);
      const payload = await client.callTool<unknown>("ai__listAiFeedItems", { limit });

      const rawList = Array.isArray(payload)
        ? payload
        : Array.isArray(asRecord(payload)?.items)
          ? (asRecord(payload)!.items as unknown[])
          : [];

      const now = new Date();
      const items: RawItem[] = [];
      const seen = new Set<string>();
      for (const entry of rawList) {
        const rec = asRecord(entry);
        if (!rec) continue;
        const item = toAiFeedRawItem(rec, now);
        if (!item || seen.has(item.externalId)) continue;
        seen.add(item.externalId);
        items.push(item);
      }

      ctx.log(`采集完成: 返回 ${rawList.length} 条，有效入列 ${items.length} 条`);
      return { items, degraded: null };
    },
  };
}

export const scysAiFeedCollector: Collector = createScysAiFeedCollector();
