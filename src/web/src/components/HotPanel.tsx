import { useMemo, useState } from "react";
import { Flame, Loader2, Newspaper, Radar, RefreshCw, Sparkles, TrendingDown, TrendingUp } from "lucide-react";
import { KIND_LABEL, categoryLabelForKind, timeAgo } from "../lib/sources.ts";
import type { HotReport, HotScope } from "../types.ts";
import { t } from "../lib/i18n.ts";

const WINDOWS = [
  { hours: 24, label: t("24 小时") },
  { hours: 72, label: t("3 天") },
  { hours: 168, label: t("7 天") },
];

const SCOPES: { key: HotScope; label: string }[] = [
  { key: "all", label: t("全部") },
  { key: "deals", label: t("福利/好价") },
  { key: "news", label: t("重要新闻") },
  { key: "info", label: t("行业资讯") },
];

function Delta({ delta }: { delta: number }) {
  if (delta === 0) return <span className="font-mono text-[11px] text-ink-400">{t("持平")}</span>;
  const up = delta > 0;
  return (
    <span className={"inline-flex items-center gap-0.5 font-mono text-[11px] " + (up ? "text-deal" : "text-ink-400")}>
      {up ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
      {up ? "+" : ""}
      {delta}
    </span>
  );
}

/**
 * 今日热点：同事件去重后的热词云 + 可点击分类热度 + 「最值得抢」与「重要新闻/资讯」严格分栏。
 */
export function HotPanel({
  report,
  loading,
  error,
  hours,
  scope,
  onHours,
  onScope,
  onReload,
  onSearchWord,
  onJumpCategory,
  onOpenItem,
  sourceName,
}: {
  report: HotReport | null;
  loading: boolean;
  error: string | null;
  hours: number;
  scope: HotScope;
  onHours: (h: number) => void;
  onScope: (s: HotScope) => void;
  onReload: () => void;
  onSearchWord: (word: string) => void;
  onJumpCategory: (category: string) => void;
  onOpenItem: (id: number) => void;
  sourceName: (id: string) => string;
}) {
  const [hovered, setHovered] = useState<string | null>(null);

  const words = report?.words ?? [];
  const max = words[0]?.n ?? 1;
  const min = words[words.length - 1]?.n ?? 1;
  const scale = (n: number) => {
    if (max === min) return 20;
    return Math.round(13 + ((n - min) / (max - min)) * 17);
  };
  const catMax = Math.max(1, ...(report?.categories ?? []).map((c) => c.n));

  const windowLabel = useMemo(() => WINDOWS.find((w) => w.hours === hours)?.label ?? t("{h} 小时", { h: hours }), [hours]);
  const totalDelta = report ? report.scanned - report.prevScanned : 0;
  const topNews = report?.topNews ?? [];

  return (
    <div className="space-y-4">
      <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex items-center gap-2">
          <Flame size={15} className="text-accent" />
          <span className="text-[14px] font-semibold text-ink-950">{t("今日热点")}</span>
          <span className="text-[12px] text-ink-500">{t("已做跨源事件去重，点词或分类直接跳回情报流")}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-md border border-ink-200 bg-surface p-0.5">
            {SCOPES.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => onScope(s.key)}
                className={
                  "rounded px-2.5 py-1 text-[12px] font-medium transition-colors active:scale-[0.98] " +
                  (scope === s.key ? "bg-canvas-subtle font-semibold text-ink-950 shadow-[inset_0_0_0_1px_var(--color-brand-border)]" : "text-ink-500 hover:text-ink-950")
                }
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-0.5 rounded-md border border-ink-200 bg-surface p-0.5">
            {WINDOWS.map((w) => (
              <button
                key={w.hours}
                type="button"
                onClick={() => onHours(w.hours)}
                className={
                  "rounded px-2.5 py-1 text-[12px] font-medium transition-colors active:scale-[0.98] " +
                  (hours === w.hours ? "bg-canvas-subtle font-semibold text-ink-950 shadow-[inset_0_0_0_1px_var(--color-brand-border)]" : "text-ink-500 hover:text-ink-950")
                }
              >
                {w.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onReload}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-ink-200 px-2 text-[12px] font-medium text-ink-600 transition-colors hover:bg-ink-100 active:scale-[0.98]"
            title={t("重新统计")}
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {error && <div className="panel border-alert-border bg-alert-subtle p-4 text-[13px] text-alert">{error}</div>}

      {loading && !report && (
        <div className="panel flex items-center gap-2 p-6 text-[13px] text-ink-500">
          <Loader2 size={13} className="animate-spin" /> {t("正在统计 {w} 热词…", { w: windowLabel })}
        </div>
      )}

      {report && (
        <div key={`${report.windowHours}-${report.scope}`} className="list-enter space-y-4">
          <div className="panel grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
            {[
              {
                label: t("独立事件数"),
                value: report.scanned,
                note: report.rawScanned && report.rawScanned > report.scanned
                  ? t("{w}（原始 {n} 条已去重）", { w: windowLabel, n: report.rawScanned })
                  : windowLabel,
              },
              { label: t("上一窗口"), value: report.prevScanned, note: t("同长度对比") },
              { label: t("热词数"), value: report.words.length, note: t("已过滤虚词") },
              { label: t("最值得抢"), value: report.top.length, note: t("仅真福利与特价好价") },
            ].map((m) => (
              <div key={m.label}>
                <div className="text-[12px] text-ink-500">{m.label}</div>
                <div className="mt-0.5 font-mono text-[18px] font-semibold tabular-nums text-ink-950">{m.value}</div>
                <div className="text-[11px] text-ink-400">{m.note}</div>
              </div>
            ))}
          </div>

          <div className="panel p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[14px] font-semibold text-ink-950">{t("热词云")}</span>
              <span className="text-[12px] text-ink-500">
                {t("字号 = 独立事件提及次数")} · <Delta delta={totalDelta} /> {t("为与上一窗口相比的事件增减")}
              </span>
            </div>
            {words.length === 0 ? (
              <div className="py-10 text-center text-[12px] text-ink-500">{t("这个窗口还没有足够的数据")}</div>
            ) : (
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5 leading-none">
                {words.map((w) => {
                  const size = scale(w.n);
                  const hot = w.delta >= 2;
                  return (
                    <button
                      key={w.w}
                      type="button"
                      onMouseEnter={() => setHovered(w.w)}
                      onMouseLeave={() => setHovered(null)}
                      onClick={() => onSearchWord(w.w)}
                      title={t("{w}：本窗口 {n} 次，上一窗口 {prev} 次（点击搜索）", { w: w.w, n: w.n, prev: w.prev })}
                      className={
                        "rounded px-1.5 py-0.5 transition-all duration-150 hover:-translate-y-0.5 active:scale-95 " +
                        (hovered === w.w
                          ? "bg-brand-subtle text-accent"
                          : hot
                            ? "font-semibold text-ink-950"
                            : w.delta > 0
                              ? "text-ink-800"
                              : "text-ink-500")
                      }
                      style={{ fontSize: size + "px", fontWeight: size >= 22 ? 600 : 500 }}
                    >
                      {w.w}
                      {hot && <span className="ml-0.5 text-[11px] font-semibold text-deal">↑</span>}
                      <span className="ml-1 align-super font-mono text-[11px] font-normal text-ink-400">{w.n}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <div className="panel min-w-0 p-5">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-[14px] font-semibold text-ink-950">{t("分类热度")}</span>
                <span className="text-[11px] text-ink-400">{t("点击直达对应分类")}</span>
              </div>
              <div className="space-y-2">
                {report.categories.slice(0, 10).map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => onJumpCategory(c.key)}
                    className="group block w-full rounded-md px-1.5 py-1 text-left transition-colors hover:bg-surface-hover"
                  >
                    <div className="mb-1 flex items-center justify-between text-[12px]">
                      <span className="text-ink-700 transition-colors group-hover:text-accent">
                        {t(categoryLabelForKind(c.key, scope === "news" ? "news" : scope === "info" ? "info" : null))}
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="font-mono tabular-nums text-ink-900">{c.n}</span>
                        <Delta delta={c.delta} />
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-ink-100">
                      <div
                        className="h-full rounded-full bg-solid transition-all duration-500 ease-out group-hover:bg-accent-solid"
                        style={{ width: Math.round((c.n / catMax) * 100) + "%" }}
                      />
                    </div>
                  </button>
                ))}
                {!report.categories.length && <div className="text-[12px] text-ink-500">{t("暂无分类数据")}</div>}
              </div>
            </div>

            <div className="panel min-w-0 p-5">
              <div className="mb-3 flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[14px] font-semibold text-ink-950">
                  <Sparkles size={13} className="text-deal" />
                  {t("这个窗口最值得抢")}
                </span>
                <span className="text-[11px] text-ink-500">{t("仅白嫖福利与特价好价 · 已去重")}</span>
              </div>
              <div className="divide-y divide-ink-100">
                {report.top.map((it, i) => (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => onOpenItem(it.id)}
                    className="flex w-full items-start gap-2.5 px-1 py-2 text-left transition-colors hover:bg-surface-hover"
                  >
                    <span className={"mt-0.5 w-4 shrink-0 font-mono text-[11px] " + (i < 3 ? "font-semibold text-deal" : "text-ink-400")}>
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-ink-900">{it.title}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-500">
                        <span>{sourceName(it.source_id)}</span>
                        {it.category && <span>· {t(categoryLabelForKind(it.category, it.kind))}</span>}
                        {it.kind && it.kind !== "freebie" && <span>· {t(KIND_LABEL[it.kind] ?? it.kind)}</span>}
                        {it.quality ? <span className="text-deal">{t("· 质量 {v}", { v: it.quality })}</span> : null}
                        {(it.dupCount ?? 1) > 1 ? (
                          <span className="rounded bg-brand-subtle px-1 py-0.2 text-[11px] text-accent">
                            {t("{n} 源同步", { n: it.dupCount ?? 1 })}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span className={"mt-0.5 shrink-0 font-mono text-[11px] tabular-nums " + (it.score >= 80 ? "font-semibold text-deal" : "text-ink-400")}>
                      {it.score}
                    </span>
                  </button>
                ))}
                {!report.top.length && (
                  <div className="flex flex-col items-center gap-2 py-8 text-center">
                    <Radar size={22} className="text-ink-300" />
                    <span className="text-[12px] text-ink-500">{t("这个窗口还没有真福利或特价好价")}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {topNews.length > 0 && (
            <div className="panel min-w-0 p-5">
              <div className="mb-3 flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[14px] font-semibold text-ink-950">
                  <Newspaper size={14} className="text-accent" />
                  {t("重要新闻与行业资讯精选")}
                </span>
                <span className="text-[11px] text-ink-500">{t("已按同事件折叠，不混入「最值得抢」")}</span>
              </div>
              <div className="divide-y divide-ink-100">
                {topNews.map((it, i) => (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => onOpenItem(it.id)}
                    className="flex w-full items-start gap-2.5 px-1 py-2 text-left transition-colors hover:bg-surface-hover"
                  >
                    <span className="mt-0.5 w-4 shrink-0 font-mono text-[11px] text-ink-400">{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-ink-900">{it.title}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-500">
                        <span>{sourceName(it.source_id)}</span>
                        {it.kind && <span>· {t(KIND_LABEL[it.kind] ?? it.kind)}</span>}
                        {it.category && <span>· {t(categoryLabelForKind(it.category, it.kind))}</span>}
                        {it.quality ? <span className="text-accent">{t("· 质量 {v}", { v: it.quality })}</span> : null}
                        {(it.dupCount ?? 1) > 1 ? (
                          <span className="rounded bg-brand-subtle px-1 py-0.2 text-[11px] text-accent">
                            {t("{n} 篇同事件", { n: it.dupCount ?? 1 })}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span className="mt-0.5 shrink-0 font-mono text-[11px] tabular-nums text-ink-400">{it.score}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="px-1 text-[11px] text-ink-400">
            {t("统计范围：{w}内 status=active 且未被 AI 判为噪音的条目 · 更新于 {time}", { w: windowLabel, time: timeAgo(report.to) })}
          </div>
        </div>
      )}
    </div>
  );
}