import { Fragment, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileText,
  LayoutList,
  Lightbulb,
  Loader2,
  Play,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import type { DigestPick, DigestReport } from "../../../shared/digest.ts";
import type { Item } from "../types.ts";
import { t } from "../lib/i18n.ts";
import { CompactRow } from "./ItemView.tsx";

const URL_IN_TEXT_RE = /(https?:\/\/[^\s<>()[\]"'，。；！？、]+)/gi;
const INTRO_HEADING_RE = /^(?:#{1,3}\s*)?(?:\*{1,2})?((?:🎯|📈)\s*[^\n]+?)(?:\*{1,2})?$/u;
const PICKS_HEADING_RE = /^(?:#{1,3}\s*)?(?:\*{1,2})?((?:🔥|🏆)\s*[^\n]+?)(?:\*{1,2})?$/u;
const CLOSING_HEADING_RE = /^(?:#{1,3}\s*)?(?:\*{1,2})?((?:⚠️|⚠|💡)\s*[^\n]+?)(?:\*{1,2})?$/u;
const PICK_START_RE = /^\s*(\d+)[.、)）]\s+(.+)$/;
const THRESHOLD_LINE_RE = /^(?:[-•*]\s*)?(?:(?:\[|【)\s*底牌(?:门槛)?\s*(?:\]|】)|底牌(?:门槛)?\s*[:：])\s*[:：\-—]?\s*(.+)$/u;
const INLINE_THRESHOLD_RE = /(?:\[|【)\s*底牌(?:门槛)?\s*(?:\]|】)\s*[:：\-—]?\s*(.+)$/u;
const URL_LINE_RE = /^(?:[-•*]\s*)?(?:原文|原帖|链接|地址)?\s*[:：]?\s*(https?:\/\/\S+)\s*$/iu;
const INLINE_URL_RE = /(?:原文|原帖|链接|地址)\s*[:：]\s*(https?:\/\/\S+)/iu;
const WEEKLY_ACTION_RE = /💡|行动|建议/;

function cleanUrl(raw: string): string {
  return raw.trim().replace(/[)>.,;。，；\]】]+$/u, "");
}

function normalizeUrlForMatch(raw: string | undefined): string {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const pathname = u.pathname.replace(/\/+$/, "");
    return `${u.hostname.toLowerCase()}${pathname}${u.search}`;
  } catch {
    return raw.trim().toLowerCase().replace(/\/+$/, "");
  }
}

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function matchItemForPick(pick: DigestPick, items: Item[]): Item | undefined {
  if (pick.id !== undefined) {
    const byId = items.find((it) => it.id === pick.id);
    if (byId) return byId;
  }
  const targetUrl = normalizeUrlForMatch(pick.url);
  if (targetUrl) {
    const byUrl = items.find((it) => normalizeUrlForMatch(it.url) === targetUrl);
    if (byUrl) return byUrl;
  }
  const normTitle = pick.title.trim().toLowerCase();
  if (normTitle) {
    return items.find((it) => it.title.trim().toLowerCase() === normTitle);
  }
  return undefined;
}

/** 回溯解析旧版主编纯文本 briefing（带 🎯/🔥/⚠️/📈/🏆/💡 与 [底牌门槛]），非主编格式返回 null。 */
export function parseLegacyBriefing(text: string, items: Item[]): DigestReport | null {
  const lines = text.split(/\r?\n/);
  let section: "none" | "intro" | "picks" | "closing" = "none";
  let sawHeading = false;
  let introTitle = "";
  let picksTitle = "";
  let closingTitle = "";
  const introPoints: string[] = [];
  const closingPoints: string[] = [];
  const picks: Array<{ title: string; bodyLines: string[]; threshold: string; url?: string }> = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const introMatch = INTRO_HEADING_RE.exec(line);
    if (introMatch) {
      sawHeading = true;
      section = "intro";
      introTitle = introMatch[1]!.trim();
      continue;
    }
    const picksMatch = PICKS_HEADING_RE.exec(line);
    if (picksMatch) {
      sawHeading = true;
      section = "picks";
      picksTitle = picksMatch[1]!.trim();
      continue;
    }
    const closingMatch = CLOSING_HEADING_RE.exec(line);
    if (closingMatch) {
      sawHeading = true;
      section = "closing";
      closingTitle = closingMatch[1]!.trim();
      continue;
    }

    if (section === "intro") {
      introPoints.push(line.replace(/^[-•*]\s+/, "").trim());
      continue;
    }
    if (section === "closing") {
      closingPoints.push(line.replace(/^[-•*]\s+/, "").trim());
      continue;
    }

    if (section === "picks" || (sawHeading && PICK_START_RE.test(line))) {
      const startMatch = PICK_START_RE.exec(line);
      if (startMatch) {
        section = "picks";
        picks.push({ title: startMatch[2]!.replace(/\*\*/g, "").trim(), bodyLines: [], threshold: "" });
        continue;
      }
      const current = picks[picks.length - 1];
      if (!current) continue;

      const urlLineMatch = URL_LINE_RE.exec(line);
      if (urlLineMatch) {
        current.url = cleanUrl(urlLineMatch[1]!);
        continue;
      }

      const thLineMatch = THRESHOLD_LINE_RE.exec(line);
      if (thLineMatch) {
        const inlineUrl = INLINE_URL_RE.exec(thLineMatch[1]!);
        if (inlineUrl) {
          current.url = current.url ?? cleanUrl(inlineUrl[1]!);
          current.threshold = thLineMatch[1]!.replace(INLINE_URL_RE, "").trim();
        } else {
          current.threshold = thLineMatch[1]!.trim();
        }
        continue;
      }

      let bodyLine = line.replace(/^[-•*]\s+/, "");
      const inlineUrl = INLINE_URL_RE.exec(bodyLine);
      if (inlineUrl) {
        current.url = current.url ?? cleanUrl(inlineUrl[1]!);
        bodyLine = bodyLine.replace(INLINE_URL_RE, "").trim();
      }
      const inlineTh = INLINE_THRESHOLD_RE.exec(bodyLine);
      if (inlineTh) {
        current.threshold = current.threshold || inlineTh[1]!.trim();
        bodyLine = bodyLine.replace(INLINE_THRESHOLD_RE, "").trim();
      }
      if (bodyLine) current.bodyLines.push(bodyLine);
    }
  }

  if (!sawHeading || !picks.length) return null;

  const normalizedPicks: DigestPick[] = picks.map((p) => {
    const matched = matchItemForPick({ title: p.title, summary: "", threshold: p.threshold, url: p.url }, items);
    return {
      ...(matched ? { id: matched.id } : {}),
      title: p.title,
      summary: p.bodyLines.join(" ").trim(),
      threshold: p.threshold,
      ...(matched?.url ? { url: matched.url } : p.url ? { url: p.url } : {}),
    };
  });

  return {
    introTitle: introTitle || t("核心风向"),
    introPoints,
    picksTitle: picksTitle || t("精选拆解"),
    picks: normalizedPicks,
    closingTitle: closingTitle || t("提醒与建议"),
    closingPoints,
  };
}

function renderLineWithCompactUrls(line: string) {
  const parts = line.split(URL_IN_TEXT_RE);
  if (parts.length === 1) return line;
  return parts.map((part, idx) => {
    if (!/^https?:\/\//i.test(part)) return <Fragment key={idx}>{part}</Fragment>;
    const href = cleanUrl(part);
    const host = hostOf(href);
    return (
      <a
        key={idx}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="mx-1 inline-flex max-w-full items-center gap-1 rounded-md border border-ink-200 bg-surface px-2 py-0.5 align-middle text-[11px] font-medium text-accent transition-colors hover:bg-ink-100"
      >
        <span className="truncate">{host ? `${t("查看原文")} · ${host}` : t("查看原文")}</span>
        <ExternalLink size={11} className="shrink-0" />
      </a>
    );
  });
}

export function DigestPanel({
  digests,
  detail,
  pickedDate,
  onPickDate,
  onRunDaily,
  onRunWeekly,
  canAdmin = true,
  sourceName,
  onPatch,
  onOpen,
  onQuickBlock,
  onCopyCode,
}: {
  digests: { date: string; created_at: string; pushed_at: string | null; kind: string; count: number }[];
  detail: {
    data: {
      date: string;
      text: string;
      report?: DigestReport | null;
      count: number;
      created_at: string;
      pushed_at: string | null;
      items: Item[];
    } | null;
    loading: boolean;
    error: string | null;
  };
  pickedDate: string | null;
  onPickDate: (d: string) => void;
  onRunDaily: () => Promise<void>;
  onRunWeekly: () => Promise<void>;
  canAdmin?: boolean;
  sourceName: (id: string) => string;
  onPatch: (id: number, body: Record<string, unknown>) => void;
  onOpen: (item: Item) => void;
  onQuickBlock: (item: Item) => void;
  onCopyCode: (code: string) => void;
}) {
  const [running, setRunning] = useState(false);
  const [weeklyRunning, setWeeklyRunning] = useState(false);
  const [textOpen, setTextOpen] = useState(true);
  const [viewMode, setViewMode] = useState<"card" | "text">("card");
  const active = pickedDate ?? digests[0]?.date ?? null;

  const resolvedReport = detail.data
    ? (detail.data.report ?? parseLegacyBriefing(detail.data.text, detail.data.items))
    : null;
  const isWeeklyClosing = Boolean(resolvedReport && WEEKLY_ACTION_RE.test(resolvedReport.closingTitle));

  return (
    <div className="space-y-4">
      <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {digests.map((d) => (
            <button
              key={d.date}
              type="button"
              onClick={() => onPickDate(d.date)}
              className={
                "rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-colors " +
                (d.date === active
                  ? "border-brand-border bg-brand-subtle text-accent"
                  : "border-ink-200 bg-surface text-ink-700 hover:bg-ink-100")
              }
            >
              {d.kind === "weekly" ? <span className="mr-1 text-[11px] opacity-80">{t("周报")}</span> : null}
              {d.date}
              {d.pushed_at ? <span className="ml-1.5 text-[11px] opacity-80">{t("· 已推")}</span> : null}
            </button>
          ))}
          {!digests.length && <span className="text-[13px] text-ink-500">{t("还没有生成过每日精选")}</span>}
        </div>

        {canAdmin && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={running}
              onClick={async () => {
                setRunning(true);
                try {
                  await onRunDaily();
                } finally {
                  setRunning(false);
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-solid px-3.5 py-2 text-[12px] font-medium text-on-solid transition-colors hover:bg-solid-hover disabled:opacity-50"
            >
              {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              {t("立即生成今日精选")}
            </button>
            <button
              type="button"
              disabled={weeklyRunning}
              onClick={async () => {
                setWeeklyRunning(true);
                try {
                  await onRunWeekly();
                } finally {
                  setWeeklyRunning(false);
                }
              }}
              title={t("汇总近 7 天 AI 判为真福利且未过期的条目，附本周热词与分类分布")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-3 py-2 text-[12px] font-medium text-ink-700 transition-colors hover:bg-ink-100 disabled:opacity-50"
            >
              {weeklyRunning ? <Loader2 size={13} className="animate-spin" /> : <CalendarDays size={13} />}
              {t("生成本周周报")}
            </button>
          </div>
        )}
      </div>

      {!digests.length && (
        <div className="panel flex flex-col items-center gap-3 px-6 py-16 text-center">
          <Sparkles size={26} className="text-ink-400" />
          <div className="text-[14px] font-medium text-ink-900">{t("还没有日报记录")}</div>
          <p className="max-w-md text-[13px] leading-relaxed text-ink-500">
            {t("点右上角「立即生成今日精选」，会按照你在「推送规则」里设好的价格、分类与 AI 条件生成今日精选并自动记录。")}
          </p>
        </div>
      )}

      {detail.loading && <div className="panel p-6 text-[13px] text-ink-500">{t("加载日报中…")}</div>}
      {detail.error && (
        <div className="panel border-alert-border bg-alert-subtle p-4 text-[13px] text-alert">{detail.error}</div>
      )}

      {detail.data && (
        <>
          <div className="panel min-w-0 p-4 sm:p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[13px]">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-semibold text-ink-950">{t("{date} 精选摘要", { date: detail.data.date })}</span>
                <span className="text-[12px] text-ink-500">
                  {t("共 {n} 条 · 生成于 {time}", {
                    n: detail.data.count,
                    time: detail.data.created_at.replace("T", " ").slice(5, 16),
                  })}
                  {detail.data.pushed_at ? " · " + t("已发 Telegram") : " · " + t("仅落库")}
                </span>
              </div>
              <div className="inline-flex shrink-0 items-center rounded-lg border border-ink-200 bg-surface-hover p-0.5 text-[12px]">
                <button
                  type="button"
                  onClick={() => setViewMode("card")}
                  aria-pressed={viewMode === "card"}
                  className={
                    "inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition-colors " +
                    (viewMode === "card" ? "bg-surface text-ink-950 shadow-xs" : "text-ink-500 hover:text-ink-800")
                  }
                >
                  <LayoutList size={12} />
                  {t("卡片视图")}
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("text")}
                  aria-pressed={viewMode === "text"}
                  className={
                    "inline-flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition-colors " +
                    (viewMode === "text" ? "bg-surface text-ink-950 shadow-xs" : "text-ink-500 hover:text-ink-800")
                  }
                >
                  <FileText size={12} />
                  {t("纯文本")}
                </button>
              </div>
            </div>

            {viewMode === "card" && resolvedReport ? (
              <div className="min-w-0 space-y-4">
                {resolvedReport.introPoints.length > 0 && (
                  <section className="min-w-0 rounded-xl border border-brand-border bg-brand-subtle/40 p-3.5 sm:p-4">
                    <h3 className="text-[13px] font-semibold text-accent">{resolvedReport.introTitle}</h3>
                    <ul className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-ink-800">
                      {resolvedReport.introPoints.map((pt, idx) => (
                        <li key={idx} className="flex min-w-0 items-start gap-2">
                          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent/70" aria-hidden="true" />
                          <span className="min-w-0 flex-1 [overflow-wrap:anywhere] break-words">{pt}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                <section className="min-w-0 space-y-3">
                  <h3 className="text-[13px] font-semibold text-ink-900">{resolvedReport.picksTitle}</h3>
                  {resolvedReport.picks.map((pick, idx) => {
                    const matchedItem = matchItemForPick(pick, detail.data?.items ?? []);
                    const resolvedUrl = matchedItem?.url || pick.url;
                    const host = hostOf(resolvedUrl);
                    const isScys = Boolean(resolvedUrl && /scys\.com/i.test(resolvedUrl));
                    return (
                      <article
                        key={`${pick.id ?? "pick"}-${idx}`}
                        className="min-w-0 rounded-xl border border-ink-200 bg-surface p-3.5 transition-colors hover:border-ink-300 sm:p-4"
                      >
                        <div className="flex min-w-0 items-start gap-2.5">
                          <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-brand-subtle font-mono text-[11px] font-semibold text-accent">
                            {idx + 1}
                          </span>
                          <h4 className="min-w-0 flex-1 text-[14px] leading-snug font-semibold text-ink-950 [overflow-wrap:anywhere] break-words">
                            {pick.title || matchedItem?.title}
                          </h4>
                        </div>

                        {pick.summary && (
                          <p className="mt-2 text-[13px] leading-relaxed text-ink-700 [overflow-wrap:anywhere] break-words">
                            {pick.summary}
                          </p>
                        )}

                        {pick.threshold && (
                          <div className="mt-2.5 flex min-w-0 flex-wrap items-start gap-2 rounded-lg border border-code-border bg-code-subtle/60 px-3 py-2 text-[12px] leading-relaxed">
                            <span className="inline-flex shrink-0 items-center gap-1 rounded border border-code-border bg-code-subtle px-1.5 py-0.5 text-[11px] font-semibold text-code">
                              <ShieldAlert size={12} />
                              {t("底牌门槛")}
                            </span>
                            <span className="min-w-0 flex-1 text-ink-800 [overflow-wrap:anywhere] break-words">
                              {pick.threshold}
                            </span>
                          </div>
                        )}

                        {(matchedItem || resolvedUrl) && (
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            {matchedItem && (
                              <button
                                type="button"
                                onClick={() => onOpen(matchedItem)}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-solid px-3 py-1.5 text-[12px] font-medium text-on-solid transition-colors hover:bg-solid-hover"
                              >
                                <BookOpen size={13} />
                                {t("站内读全文")}
                              </button>
                            )}
                            {resolvedUrl && (
                              <a
                                href={resolvedUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex max-w-full items-center gap-1 rounded-lg border border-ink-200 bg-surface-hover px-2.5 py-1.5 text-[12px] font-medium text-ink-700 transition-colors hover:bg-ink-100"
                              >
                                <span className="truncate">
                                  {matchedItem
                                    ? isScys
                                      ? t("生财原帖")
                                      : t("查看原文")
                                    : host
                                      ? `${t("查看原文")} · ${host}`
                                      : t("查看原文")}
                                </span>
                                <ExternalLink size={12} className="shrink-0" />
                              </a>
                            )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </section>

                {resolvedReport.closingPoints.length > 0 && (
                  <section
                    className={
                      "min-w-0 rounded-xl border p-3.5 sm:p-4 " +
                      (isWeeklyClosing
                        ? "border-deal-border bg-deal-subtle/40"
                        : "border-alert-border bg-alert-subtle/40")
                    }
                  >
                    <h3
                      className={
                        "flex items-center gap-1.5 text-[13px] font-semibold " +
                        (isWeeklyClosing ? "text-deal" : "text-alert")
                      }
                    >
                      {isWeeklyClosing ? <Lightbulb size={14} /> : <AlertTriangle size={14} />}
                      {resolvedReport.closingTitle}
                    </h3>
                    <ul className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-ink-800">
                      {resolvedReport.closingPoints.map((pt, idx) => (
                        <li key={idx} className="flex min-w-0 items-start gap-2">
                          <span
                            className={
                              "mt-2 h-1.5 w-1.5 shrink-0 rounded-full " +
                              (isWeeklyClosing ? "bg-deal/70" : "bg-alert/70")
                            }
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1 [overflow-wrap:anywhere] break-words">{pt}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            ) : viewMode === "card" ? (
              <div className="min-w-0 space-y-1.5 rounded-lg border border-ink-200 bg-surface-hover p-3.5 text-[13px] leading-relaxed text-ink-800">
                {detail.data.text.split(/\r?\n/).map((line, idx) =>
                  line.trim() ? (
                    <p key={idx} className="min-w-0 [overflow-wrap:anywhere] break-words">
                      {renderLineWithCompactUrls(line)}
                    </p>
                  ) : (
                    <div key={idx} className="h-1.5" />
                  ),
                )}
              </div>
            ) : (
              <>
                <div className="relative mt-1 min-w-0">
                  <pre
                    className={
                      "max-w-full overflow-x-hidden rounded-lg border border-ink-200 bg-surface-hover p-3.5 font-sans text-[13px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] break-words text-ink-800 " +
                      (textOpen ? "" : "max-h-[360px] overflow-hidden")
                    }
                  >
                    {detail.data.text}
                  </pre>
                  {!textOpen && (
                    <span
                      className="pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b-lg bg-gradient-to-t from-surface-hover to-transparent"
                      aria-hidden="true"
                    />
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setTextOpen((v) => !v)}
                  className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline"
                >
                  {textOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  {textOpen ? t("收起") : t("展开全文")}
                </button>
              </>
            )}
          </div>

          <div className="panel overflow-hidden">
            {detail.data.items.map((item) => (
              <CompactRow
                key={item.id}
                item={item}
                sourceName={sourceName}
                onPatch={onPatch}
                onOpen={onOpen}
                onQuickBlock={onQuickBlock}
                onCopyCode={onCopyCode}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
