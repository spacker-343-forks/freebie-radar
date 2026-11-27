import type {
  ScysOfficialReportDetail,
  ScysOfficialReportSummary,
} from "../shared/scys-official-report.ts";
import { all, get, getDb, run } from "./db.ts";
import { ScysAuthError, ScysMcpClient } from "./scys/mcp-client.ts";

let tableEnsured = false;

export function ensureScysOfficialReportTable(): void {
  if (tableEnsured) {
    // Check table still exists in case tests swap :memory: or truncate schema
    const exists = get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='scys_official_reports'",
    );
    if (exists) return;
  }
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS scys_official_reports (
      report_date TEXT PRIMARY KEY,
      edition TEXT NOT NULL DEFAULT 'DAILY',
      period TEXT,
      notice TEXT,
      title TEXT NOT NULL,
      signal_count INTEGER NOT NULL DEFAULT 0,
      highlight_count INTEGER NOT NULL DEFAULT 0,
      markdown TEXT NOT NULL,
      structured TEXT NOT NULL DEFAULT '{}',
      synced_at TEXT NOT NULL
    );
  `);
  tableEnsured = true;
}

type ReportRow = {
  report_date: string;
  edition: string;
  period: string | null;
  notice: string | null;
  title: string;
  signal_count: number;
  highlight_count: number;
  markdown?: string;
  structured?: string;
  synced_at: string;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => asString(x)).filter(Boolean);
}

function formatDateInShanghai(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function shiftIsoDate(dateStr: string, deltaDays: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) {
    throw new Error(`无效的日报日期格式 "${dateStr}"，应为 YYYY-MM-DD`);
  }
  const shifted = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + deltaDays));
  const y = shifted.getUTCFullYear();
  const mon = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${mon}-${d}`;
}

function isWeekendDate(dateStr: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return false;
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return day === 0 || day === 6;
}

function mapSummaryRow(row: ReportRow): ScysOfficialReportSummary {
  return {
    reportDate: row.report_date,
    edition: row.edition,
    period: row.period ?? null,
    notice: row.notice ?? null,
    title: row.title,
    signalCount: Number(row.signal_count ?? 0),
    highlightCount: Number(row.highlight_count ?? 0),
    syncedAt: row.synced_at,
  };
}

function formatBulletEntry(raw: unknown): string {
  const rec = asRecord(raw);
  if (!rec) return typeof raw === "string" && raw.trim() ? `- ${raw.trim()}` : "";

  const title = asString(rec.title) || asString(rec.name) || "未命名条目";
  const url = asString(rec.url);
  const oneLiner = asString(rec.oneLiner) || asString(rec.summary) || asString(rec.description);
  const source = asString(rec.source);
  const tags = asStringList(rec.tags);

  const head = url ? `[${title}](${url})` : `**${title}**`;
  const metaParts: string[] = [];
  if (source) metaParts.push(source);
  if (tags.length) metaParts.push(tags.map((t) => `#${t}`).join(" "));
  const metaSuffix = metaParts.length ? `（${metaParts.join(" · ")}）` : "";
  const bodySuffix = oneLiner ? `\n  ${oneLiner}` : "";
  return `- ${head}${metaSuffix}${bodySuffix}`;
}

function buildSectionMarkdown(heading: string, entries: unknown[]): string {
  const lines = entries.map(formatBulletEntry).filter(Boolean);
  if (!lines.length) return "";
  return `## ${heading}\n\n${lines.join("\n")}`;
}

function buildGroupChatMarkdown(entries: unknown[]): string {
  const blocks: string[] = [];
  for (const raw of entries) {
    const rec = asRecord(raw);
    if (!rec) continue;
    const title = asString(rec.title) || "群聊主题";
    const category = asString(rec.category);
    const summary = asString(rec.summary);
    const qa = asStringList(rec.qa);
    const header = category ? `### ${title}（${category}）` : `### ${title}`;
    const lines: string[] = [header];
    if (summary) lines.push(summary);
    for (const q of qa) {
      lines.push(`- ${q}`);
    }
    if (lines.length > 1 || title) {
      blocks.push(lines.join("\n"));
    }
  }
  if (!blocks.length) return "";
  return `## 群聊主题\n\n${blocks.join("\n\n")}`;
}

/** Synthesizes clean Markdown from structured `getDailyReport` fields when official `markdown` is empty. */
export function buildOfficialReportFallbackMarkdown(
  raw: Record<string, unknown>,
  meta: { title: string; notice: string | null },
): string {
  const sections: string[] = [`# ${meta.title}`];
  if (meta.notice) {
    sections.push(`> ${meta.notice}`);
  }

  const signalsMd = buildSectionMarkdown("今日信号", asArray(raw.signals));
  if (signalsMd) sections.push(signalsMd);

  const highlightsMd = buildSectionMarkdown("今日精华", asArray(raw.highlights));
  if (highlightsMd) sections.push(highlightsMd);

  const digestsMd = buildSectionMarkdown("精选摘要", asArray(raw.digests));
  if (digestsMd) sections.push(digestsMd);

  const discussionsMd = buildSectionMarkdown("圈友在讨论", asArray(raw.discussions));
  if (discussionsMd) sections.push(discussionsMd);

  const groupChatMd = buildGroupChatMarkdown(asArray(raw.groupChatThemes));
  if (groupChatMd) sections.push(groupChatMd);

  const externalMd = buildSectionMarkdown("外部在关注", asArray(raw.external));
  if (externalMd) sections.push(externalMd);

  const newListingsMd = buildSectionMarkdown("新上架", asArray(raw.newListings));
  if (newListingsMd) sections.push(newListingsMd);

  const hotSkillsMd = buildSectionMarkdown("热门技能", asArray(raw.hotSkills));
  if (hotSkillsMd) sections.push(hotSkillsMd);

  const personal = asRecord(raw.personal);
  if (personal) {
    const personalEntries = [
      ...asArray(personal.followed),
      ...asArray(personal.voyages),
      ...asArray(personal.parties),
    ];
    const personalMd = buildSectionMarkdown("我关注的", personalEntries);
    if (personalMd) sections.push(personalMd);
  }

  return sections.join("\n\n").trim();
}

function countStructuredContent(raw: Record<string, unknown>): number {
  const keys = [
    "signals",
    "highlights",
    "digests",
    "discussions",
    "groupChatThemes",
    "external",
    "newListings",
    "hotSkills",
  ];
  let total = 0;
  for (const k of keys) {
    total += asArray(raw[k]).length;
  }
  const personal = asRecord(raw.personal);
  if (personal) {
    total += asArray(personal.followed).length + asArray(personal.voyages).length + asArray(personal.parties).length;
  }
  return total;
}

function extractTitle(raw: Record<string, unknown>, markdown: string, meta: { reportDate: string; edition: string; period: string | null }): string {
  const explicit = asString(raw.title);
  if (explicit) return explicit;
  const headingMatch = /^#\s+(.+)$/m.exec(markdown);
  if (headingMatch?.[1]?.trim()) return headingMatch[1].trim();
  const baseLabel = meta.edition === "WEEKEND" ? "生财周末合辑" : "生财日报";
  return `${baseLabel} · ${meta.period || meta.reportDate}`;
}

function buildStructuredPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "markdown") continue;
    out[k] = v;
  }
  return out;
}

export function listScysOfficialReports(limit = 30): ScysOfficialReportSummary[] {
  ensureScysOfficialReportTable();
  const safeLimit = Math.min(Math.max(Math.round(limit || 30), 1), 200);
  const rows = all<ReportRow>(
    `SELECT report_date, edition, period, notice, title, signal_count, highlight_count, synced_at
       FROM scys_official_reports
      ORDER BY report_date DESC
      LIMIT ?`,
    safeLimit,
  );
  return rows.map(mapSummaryRow);
}

export function getScysOfficialReport(reportDate: string): ScysOfficialReportDetail | null {
  ensureScysOfficialReportTable();
  const cleanDate = reportDate.trim();
  if (!cleanDate) return null;
  const row = get<ReportRow>(
    `SELECT report_date, edition, period, notice, title, signal_count, highlight_count, markdown, structured, synced_at
       FROM scys_official_reports
      WHERE report_date = ?`,
    cleanDate,
  );
  if (!row) return null;
  let structured: Record<string, unknown> = {};
  if (row.structured) {
    try {
      const parsed: unknown = JSON.parse(row.structured);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        structured = parsed as Record<string, unknown>;
      }
    } catch {
      structured = {};
    }
  }
  return {
    ...mapSummaryRow(row),
    markdown: row.markdown ?? "",
    structured,
  };
}

async function syncScysDailyReportInternal(
  options: {
    reportDate?: string;
    edition?: "DAILY" | "WEEKEND";
    force?: boolean;
    client?: ScysMcpClient;
  } = {},
): Promise<{ detail: ScysOfficialReportDetail; cached: boolean }> {
  ensureScysOfficialReportTable();

  const requestedDate = options.reportDate?.trim();
  if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    throw new Error(`无效的日报日期格式 "${requestedDate}"，应为 YYYY-MM-DD`);
  }

  if (requestedDate && !options.force) {
    const cached = getScysOfficialReport(requestedDate);
    if (cached) return { detail: cached, cached: true };
  }

  const client = options.client ?? new ScysMcpClient();
  const args: Record<string, unknown> = {};
  if (requestedDate) args.reportDate = requestedDate;
  if (options.edition) args.edition = options.edition;

  const rawRes = await client.callTool<unknown>("getDailyReport", args);
  const raw = asRecord(rawRes);
  if (!raw) {
    throw new Error(`getDailyReport 返回结构异常 (${requestedDate || "最新"})`);
  }

  const resolvedDate = asString(raw.reportDate) || requestedDate || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(resolvedDate)) {
    throw new Error(`getDailyReport 未返回有效 reportDate (${resolvedDate || "empty"})`);
  }

  if (!options.force) {
    const existing = getScysOfficialReport(resolvedDate);
    if (existing) return { detail: existing, cached: true };
  }

  const status = asString(raw.status);
  const rawMarkdown = typeof raw.markdown === "string" ? raw.markdown.trim() : "";
  const structuredCount = countStructuredContent(raw);
  if (!rawMarkdown && structuredCount === 0) {
    throw new Error(`生财日报 ${resolvedDate} 尚未生成或内容为空 (status=${status || "unknown"})`);
  }

  const edition = asString(raw.edition) || options.edition || "DAILY";
  const period = asString(raw.period) || null;
  const notice = asString(raw.notice) || null;
  const title = extractTitle(raw, rawMarkdown, { reportDate: resolvedDate, edition, period });
  const markdown = rawMarkdown || buildOfficialReportFallbackMarkdown(raw, { title, notice });
  const signalCount = asArray(raw.signals).length;
  const highlightCount = asArray(raw.highlights).length;
  const structured = buildStructuredPayload(raw);
  const syncedAt = new Date().toISOString();

  run(
    `INSERT INTO scys_official_reports (
       report_date, edition, period, notice, title, signal_count, highlight_count, markdown, structured, synced_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(report_date) DO UPDATE SET
       edition = excluded.edition,
       period = excluded.period,
       notice = excluded.notice,
       title = excluded.title,
       signal_count = excluded.signal_count,
       highlight_count = excluded.highlight_count,
       markdown = excluded.markdown,
       structured = excluded.structured,
       synced_at = excluded.synced_at`,
    resolvedDate,
    edition,
    period,
    notice,
    title,
    signalCount,
    highlightCount,
    markdown,
    JSON.stringify(structured),
    syncedAt,
  );

  return {
    detail: {
      reportDate: resolvedDate,
      edition,
      period,
      notice,
      title,
      signalCount,
      highlightCount,
      syncedAt,
      markdown,
      structured,
    },
    cached: false,
  };
}

export async function syncScysDailyReport(
  options: {
    reportDate?: string;
    edition?: "DAILY" | "WEEKEND";
    force?: boolean;
    client?: ScysMcpClient;
  } = {},
): Promise<ScysOfficialReportDetail> {
  const { detail } = await syncScysDailyReportInternal(options);
  return detail;
}

export async function backfillScysDailyReports(
  options: {
    days?: number;
    force?: boolean;
    client?: ScysMcpClient;
    log?: (msg: string) => void;
    today?: string;
  } = {},
): Promise<{
  synced: number;
  skipped: number;
  failed: number;
  latestDate: string | null;
  dates: string[];
}> {
  ensureScysOfficialReportTable();
  const log = options.log ?? console.log;
  const client = options.client ?? new ScysMcpClient();
  const force = options.force === true;
  const daysRaw = options.days ?? 14;
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(Math.round(daysRaw), 0), 29) : 14;
  const todayStr = options.today?.trim() || formatDateInShanghai();

  let synced = 0;
  let skipped = 0;
  let failed = 0;
  let latestDate: string | null = null;
  const syncedDates: string[] = [];
  const seenDates = new Set<string>();

  // Step 1: always pull the default latest edition (no reportDate argument)
  try {
    const latestRes = await syncScysDailyReportInternal({ force, client });
    latestDate = latestRes.detail.reportDate;
    seenDates.add(latestRes.detail.reportDate);
    if (latestRes.cached) {
      skipped += 1;
      log(`[scys-report] 最新一期 ${latestRes.detail.reportDate} 已存在，跳过`);
    } else {
      synced += 1;
      syncedDates.push(latestRes.detail.reportDate);
      log(`[scys-report] 已同步最新一期 ${latestRes.detail.reportDate} (${latestRes.detail.edition})`);
    }
  } catch (err) {
    if (err instanceof ScysAuthError) throw err;
    failed += 1;
    log(`[scys-report] 拉取最新一期失败，继续历史日期回补: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 2: backfill past 1..days (excluding today, capped at 29 per getDailyReport schema)
  for (let offset = 1; offset <= days; offset += 1) {
    const targetDate = shiftIsoDate(todayStr, -offset);
    if (seenDates.has(targetDate)) {
      continue;
    }
    if (!force && getScysOfficialReport(targetDate)) {
      seenDates.add(targetDate);
      skipped += 1;
      continue;
    }

    const weekend = isWeekendDate(targetDate);
    let result: { detail: ScysOfficialReportDetail; cached: boolean } | null = null;
    let lastErr: unknown = null;

    try {
      result = await syncScysDailyReportInternal({ reportDate: targetDate, force, client });
    } catch (err) {
      if (err instanceof ScysAuthError) throw err;
      lastErr = err;
      if (weekend) {
        try {
          result = await syncScysDailyReportInternal({
            reportDate: targetDate,
            edition: "WEEKEND",
            force,
            client,
          });
          lastErr = null;
        } catch (weekendErr) {
          if (weekendErr instanceof ScysAuthError) throw weekendErr;
          lastErr = weekendErr;
        }
      }
    }

    if (result) {
      seenDates.add(targetDate);
      seenDates.add(result.detail.reportDate);
      if (!latestDate || result.detail.reportDate > latestDate) {
        latestDate = result.detail.reportDate;
      }
      if (result.cached) {
        skipped += 1;
      } else {
        synced += 1;
        syncedDates.push(result.detail.reportDate);
        log(`[scys-report] 补齐 ${result.detail.reportDate} (${result.detail.edition})`);
      }
    } else {
      skipped += 1;
      log(
        `[scys-report] 跳过 ${targetDate}: ${lastErr instanceof Error ? lastErr.message : String(lastErr ?? "无报告")}`,
      );
    }
  }

  if (!latestDate) {
    latestDate = listScysOfficialReports(1)[0]?.reportDate ?? null;
  }

  return { synced, skipped, failed, latestDate, dates: syncedDates };
}
