import { useState } from "react";
import { CalendarDays, ChevronDown, ChevronUp, Loader2, Play, Sparkles } from "lucide-react";
import type { Item } from "../types.ts";
import { t } from "../lib/i18n.ts";
import { CompactRow } from "./ItemView.tsx";

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
    data: { date: string; text: string; count: number; created_at: string; pushed_at: string | null; items: Item[] } | null;
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
  const active = pickedDate ?? digests[0]?.date ?? null;

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
          <div className="panel p-5">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[13px]">
              <span className="font-semibold text-ink-950">{t("{date} 精选摘要", { date: detail.data.date })}</span>
              <span className="text-[12px] text-ink-500">
                {t("共 {n} 条 · 生成于 {time}", { n: detail.data.count, time: detail.data.created_at.replace("T", " ").slice(5, 16) })}
                {detail.data.pushed_at ? " · " + t("已发 Telegram") : " · " + t("仅落库")}
              </span>
            </div>
            <div className="relative mt-2">
              <pre
                className={
                  "rounded-lg border border-ink-200 bg-surface-hover p-3.5 font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-ink-800 " +
                  (textOpen ? "" : "max-h-[360px] overflow-hidden")
                }
              >
                {detail.data.text}
              </pre>
              {!textOpen && <span className="pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b-lg bg-gradient-to-t from-surface-hover to-transparent" aria-hidden="true" />}
            </div>
            <button type="button" onClick={() => setTextOpen((v) => !v)} className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline">
              {textOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {textOpen ? t("收起") : t("展开全文")}
            </button>
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
