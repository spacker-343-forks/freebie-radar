import { Fragment, useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n.ts";
import { Activity, Check, Copy, Database, ExternalLink, Gauge, GitMerge, KeyRound, Loader2, Pencil, Play, Plus, RefreshCw, Rss, Search, ShieldCheck, Trash2, X } from "lucide-react";
import {
  CATEGORY_LABEL,
  KIND_LABEL,
  KIND_ORDER,
  categoryOptionGroups,
  formatInterval,
  timeAgo,
} from "../lib/sources.ts";
import type { RetentionSettings, Run, Source, SourceQuality } from "../types.ts";
import type { UpstreamWatchState } from "../../../shared/upstream-watch.ts";
import { DEFAULT_FIXED_CATEGORIES } from "../../../shared/source-classification.ts";
import { ClassificationPanel } from "./ClassificationPanel.tsx";
import { UPSTREAM_WATCH_UPDATED_EVENT } from "./UpstreamWatchBanner.tsx";

const INTERVAL_OPTIONS = [
  { label: t("60 秒"), sec: 60 },
  { label: t("90 秒"), sec: 90 },
  { label: t("2 分钟"), sec: 120 },
  { label: t("5 分钟"), sec: 300 },
  { label: t("15 分钟"), sec: 900 },
  { label: t("30 分钟"), sec: 1800 },
  { label: t("1 小时"), sec: 3600 },
  { label: t("6 小时"), sec: 21600 },
];

/** 用途（kind）下拉：来自 shared/taxonomy.ts，与推送/主页同一份 */
const KIND_HINT_OPTIONS = [
  { value: "", label: t("用途：自动识别") },
  ...KIND_ORDER.map((key) => ({ value: key, label: t("用途：{v}", { v: t(KIND_LABEL[key] ?? key) }) })),
];

/** 分类下拉按大类分组，覆盖全部分类（以前这里只列了 13 个，网盘/网课/拼车等选不到） */
const CATEGORY_HINT_GROUPS = categoryOptionGroups();

function categoryHintLabel(value: string): string {
  return value ? t(CATEGORY_LABEL[value as keyof typeof CATEGORY_LABEL] ?? value) : t("自动识别");
}

/**
 * 数据源当前生效的分类/用途口径（已转成中文标签）：源级优先，其次 feed / channel 上的 hint。
 * 多个不同取值时显示「首个 +N」，避免把多栏目源说成单一分类。
 */
function sourceHints(source: Source): { category: string; kind: string } {
  const cfg = source.config ?? {};
  const feeds = Array.isArray(cfg.feeds) ? (cfg.feeds as Array<Record<string, unknown>>) : [];
  const channels = Array.isArray(cfg.channels) ? (cfg.channels as unknown[]) : [];
  const pick = (key: "categoryHint" | "kindHint"): string => {
    const values = [
      cfg[key],
      ...feeds.map((f) => f?.[key]),
      ...channels.map((c) => (c && typeof c === "object" ? (c as Record<string, unknown>)[key] : undefined)),
    ]
      .filter((v): v is string => typeof v === "string" && Boolean(v.trim()))
      .map((v) => v.trim());
    const unique = [...new Set(values)];
    if (!unique.length) return "";
    const labelOf = (v: string) => (key === "categoryHint" ? categoryHintLabel(v) : (t(KIND_LABEL[v] ?? v)));
    if (unique.length === 1) return labelOf(unique[0]!);
    return `${labelOf(unique[0]!)} +${unique.length - 1}`;
  };
  const fixed = typeof cfg.fixedCategory === "string" ? cfg.fixedCategory : DEFAULT_FIXED_CATEGORIES[source.id];
  return { category: fixed ? t("固定 · {v}", { v: categoryHintLabel(fixed) }) : pick("categoryHint"), kind: pick("kindHint") };
}

type OpsTab = "sources" | "runs" | "quality" | "retention";
type FeedRow = {
  url: string;
  limit: string;
  categoryHint: string;
  kindHint: string;
  titleKeywords: string;
  excludeTitleKeywords: string;
  includeCategories: string;
  excludeCategories: string;
};

function feedToRow(feed: Record<string, unknown>): FeedRow {
  return {
    url: typeof feed.url === "string" ? feed.url : "",
    limit: typeof feed.limit === "number" ? String(feed.limit) : "30",
    categoryHint: typeof feed.categoryHint === "string" ? feed.categoryHint : "",
    kindHint: typeof feed.kindHint === "string" ? feed.kindHint : "",
    titleKeywords: Array.isArray(feed.titleKeywords) ? (feed.titleKeywords as string[]).join(", ") : "",
    excludeTitleKeywords: Array.isArray(feed.excludeTitleKeywords) ? (feed.excludeTitleKeywords as string[]).join(", ") : "",
    includeCategories: Array.isArray(feed.includeCategories) ? (feed.includeCategories as string[]).join(", ") : "",
    excludeCategories: Array.isArray(feed.excludeCategories) ? (feed.excludeCategories as string[]).join(", ") : "",
  };
}

const EMPTY_FEED_ROW: FeedRow = { url: "", limit: "30", categoryHint: "", kindHint: "", titleKeywords: "", excludeTitleKeywords: "", includeCategories: "", excludeCategories: "" };

function splitKeywords(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 分类下拉：按大类分组，覆盖全部分类；未知的历史值也能原样显示 */
function CategoryHintSelect({
  value,
  onChange,
  className,
  emptyLabel = t("分类：自动识别"),
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  emptyLabel?: string;
  ariaLabel?: string;
}) {
  const known = Boolean(value && value in CATEGORY_LABEL);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={className} aria-label={ariaLabel}>
      <option value="">{emptyLabel}</option>
      {value && !known && <option value={value}>{value}{t("（未知分类）")}</option>}
      {CATEGORY_HINT_GROUPS.map((group) => (
        <optgroup key={group.label} label={t(group.label)}>
          {group.options.map((opt) => (
            <option key={opt.value} value={opt.value} title={t(opt.desc)}>
              {t(opt.label)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function SourceInlineEditor({
  source,
  onSave,
  onDelete,
  onCancel,
}: {
  source: Source;
  onSave: (patch: { name: string; interval_sec: number; config: Record<string, unknown> }) => Promise<boolean>;
  onDelete?: () => Promise<boolean>;
  onCancel: () => void;
}) {
  const cfg = source.config ?? {};
  const feeds = Array.isArray(cfg.feeds) ? (cfg.feeds as Array<Record<string, unknown>>) : [];
  const channels = Array.isArray(cfg.channels) ? (cfg.channels as unknown[]).filter((c) => typeof c === "string") : [];

  const [name, setName] = useState(source.name);
  const [intervalSec, setIntervalSec] = useState(source.interval_sec);
  const [kindHint, setKindHint] = useState(typeof cfg.kindHint === "string" ? cfg.kindHint : "");
  const [categoryHint, setCategoryHint] = useState(typeof cfg.categoryHint === "string" ? cfg.categoryHint : "");
  const [fixedCategory, setFixedCategory] = useState(typeof cfg.fixedCategory === "string" ? cfg.fixedCategory : DEFAULT_FIXED_CATEGORIES[source.id] ?? "");
  const [feedRows, setFeedRows] = useState<FeedRow[]>(() =>
    feeds.length ? feeds.map(feedToRow) : [{ ...EMPTY_FEED_ROW }],
  );
  const [tgChannels, setTgChannels] = useState(channels.join(", "));
  const [showJson, setShowJson] = useState(source.kind !== "rss" && source.kind !== "telegram" && source.kind !== "linuxdo");
  const [rawJson, setRawJson] = useState(() => JSON.stringify(cfg, null, 2));
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const buildNextConfig = (): Record<string, unknown> | null => {
    setJsonErr(null);
    let base: Record<string, unknown>;
    if (showJson) {
      try {
        const parsed = JSON.parse(rawJson);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setJsonErr(t("JSON 必须是对象 {}"));
          return null;
        }
        base = parsed as Record<string, unknown>;
      } catch (e) {
        setJsonErr(e instanceof Error ? e.message : t("JSON 语法错误"));
        return null;
      }
    } else {
      base = { ...cfg };
    }

    if (kindHint.trim()) base.kindHint = kindHint.trim();
    else delete base.kindHint;

    if (categoryHint.trim()) base.categoryHint = categoryHint.trim();
    else delete base.categoryHint;
    // Empty is explicit opt-out, so a built-in default does not silently reappear.
    base.fixedCategory = fixedCategory.trim();

    if (!showJson && source.kind === "rss") {
      base.feeds = feedRows.map((row, i) => {
        const prev = feeds[i] ?? {};
        const fallbackId = i === 0 ? source.id.replace(/^rss-/, "") : `${source.id.replace(/^rss-/, "")}-${i + 1}`;
        const next: Record<string, unknown> = {
          ...prev,
          id: typeof prev.id === "string" && prev.id ? prev.id : fallbackId,
          url: row.url.trim(),
          limit: Math.max(1, Math.min(100, Number(row.limit) || 30)),
        };
        if (row.categoryHint.trim()) next.categoryHint = row.categoryHint.trim();
        else delete next.categoryHint;
        if (row.kindHint.trim()) next.kindHint = row.kindHint.trim();
        else delete next.kindHint;
        for (const key of ["titleKeywords", "excludeTitleKeywords", "includeCategories", "excludeCategories"] as const) {
          const values = splitKeywords(row[key]);
          if (values.length) next[key] = values;
          else delete next[key];
        }
        return next;
      });
    }

    if (!showJson && source.kind === "telegram") {
      base.channels = tgChannels
        .split(/[,，\s]+/)
        .map((s) => s.replace(/^@/, "").trim())
        .filter(Boolean);
    }

    return base;
  };

  const updateFeed = (index: number, patch: Partial<FeedRow>) => {
    setFeedRows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const handleSave = async () => {
    const nextConfig = buildNextConfig();
    if (!nextConfig || !name.trim()) return;
    setSaving(true);
    try {
      const ok = await onSave({ name: name.trim(), interval_sec: intervalSec, config: nextConfig });
      if (ok) onCancel();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-ink-200 bg-surface p-3.5 text-[12px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-medium text-ink-950">
          {t("编辑数据源")} <span className="font-mono text-[11px] text-ink-400">{source.id}</span>
        </div>
        <button
          type="button"
          onClick={() => {
            if (!showJson) {
              const built = buildNextConfig();
              if (built) setRawJson(JSON.stringify(built, null, 2));
            }
            setShowJson((v) => !v);
          }}
          className="text-[12px] font-medium text-brand hover:underline"
        >
          {showJson ? t("切回表单编辑") : t("高级 JSON 配置")}
        </button>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-12">
        <label className="space-y-1 sm:col-span-4">
          <span className="text-[11px] text-ink-500">{t("显示名称")}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-[12px] text-ink-950 outline-none focus:border-brand"
          />
        </label>
        <label className="space-y-1 sm:col-span-2">
          <span className="text-[11px] text-ink-500">{t("采集周期")}</span>
          <select
            value={intervalSec}
            onChange={(e) => setIntervalSec(Number(e.target.value))}
            className="w-full rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-[12px] text-ink-800 outline-none focus:border-brand"
          >
            {!INTERVAL_OPTIONS.some((o) => o.sec === intervalSec) && (
              <option value={intervalSec}>{formatInterval(intervalSec)}</option>
            )}
            {INTERVAL_OPTIONS.map((o) => (
              <option key={o.sec} value={o.sec}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 sm:col-span-3">
          <span className="text-[11px] text-ink-500">{t("源级兜底用途（feed 未指定时生效）")}</span>
          <select
            value={kindHint}
            onChange={(e) => setKindHint(e.target.value)}
            className="w-full rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-[12px] text-ink-800 outline-none focus:border-brand"
          >
            {KIND_HINT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 sm:col-span-3">
          <span className="text-[11px] text-ink-500">{t("兜底分类（内容识别不出时采用）")}</span>
          <CategoryHintSelect
            value={categoryHint}
            onChange={setCategoryHint}
            className="w-full rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-[12px] text-ink-800 outline-none focus:border-brand"
          />
        </label>
      </div>

      <div className="grid gap-3 rounded-lg border border-brand-border bg-brand-subtle/40 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(220px,0.8fr)]">
        <div>
          <div className="flex items-center gap-1.5 text-[12px] font-semibold text-accent"><ShieldCheck size={14} /> {t("固定分类（硬规则）")}</div>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-600">{t("选定后，该源资源固定归入此类，优先于关键词、RSS 提示和 AI（单条人工纠正除外）；保存时同步重整历史条目，不触发 AI 或推送。启停和收藏不受影响。取消固定后，新条目恢复自动分类，已有条目保持原分类。")}</p>
        </div>
        <label className="space-y-1">
          <span className="text-[12px] font-medium text-ink-700">{t("固定分类")}</span>
          <CategoryHintSelect value={fixedCategory} onChange={setFixedCategory} emptyLabel={t("不固定 · 按内容自动分类")} ariaLabel={t("固定分类")} className="w-full rounded-lg border border-ink-200 bg-surface px-2 py-2 text-[12px] text-ink-800 outline-none focus:border-brand" />
          {source.id === "linuxdo-resource" && <span className="block text-[11px] text-ink-500">{t("资源荟萃推荐：网盘资源；不会再混进真福利。")}</span>}
        </label>
      </div>

      {!showJson && source.kind === "rss" && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-ink-500">
              {t("订阅地址（{n} 条）· 每条可单独指定分类/用途，留空则用源级兜底", { n: feedRows.length })}
            </span>
            <button
              type="button"
              onClick={() => setFeedRows((rows) => [...rows, { ...EMPTY_FEED_ROW }])}
              className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2 py-1 text-[12px] font-medium text-ink-700 hover:border-brand-border hover:text-brand"
            >
              <Plus size={11} /> {t("添加订阅地址")}
            </button>
          </div>
          {feedRows.map((row, i) => (
            <div key={i} className="space-y-2 rounded-lg border border-ink-200 bg-surface-hover p-2.5">
              <div className="grid gap-2 sm:grid-cols-12">
                <label className="space-y-1 sm:col-span-6">
                  <span className="text-[11px] text-ink-500">{t("RSS / Atom 地址 #{n}", { n: i + 1 })}</span>
                  <input
                    value={row.url}
                    onChange={(e) => updateFeed(i, { url: e.target.value })}
                    placeholder="https://example.com/rss.xml"
                    className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink-950 outline-none focus:border-brand"
                  />
                </label>
                <label className="space-y-1 sm:col-span-2">
                  <span className="text-[11px] text-ink-500">{t("每次条数")}</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={row.limit}
                    onChange={(e) => updateFeed(i, { limit: e.target.value })}
                    className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink-950 outline-none focus:border-brand"
                  />
                </label>
                <div className="space-y-1 sm:col-span-2">
                  <span className="text-[11px] text-ink-500">{t("分类")}</span>
                  <CategoryHintSelect
                    value={row.categoryHint}
                    onChange={(v) => updateFeed(i, { categoryHint: v })}
                    className="w-full rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-[12px] text-ink-800 outline-none focus:border-brand"
                  />
                </div>
                <label className="space-y-1 sm:col-span-2">
                  <span className="text-[11px] text-ink-500">{t("用途")}</span>
                  <select
                    value={row.kindHint}
                    onChange={(e) => updateFeed(i, { kindHint: e.target.value })}
                    className="w-full rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-[12px] text-ink-800 outline-none focus:border-brand"
                  >
                    {KIND_HINT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-[200px] flex-1 space-y-1">
                  <span className="text-[11px] text-ink-500">{t("标题必含关键词（逗号分隔，留空全收）")}</span>
                  <input
                    value={row.titleKeywords}
                    onChange={(e) => updateFeed(i, { titleKeywords: e.target.value })}
                    placeholder={t("如：免费, 限免, free")}
                    className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-[12px] text-ink-950 outline-none focus:border-brand"
                  />
                </label>
                {feedRows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setFeedRows((rows) => rows.filter((_, x) => x !== i))}
                    className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-[12px] font-medium text-alert hover:border-alert/40 hover:bg-alert-subtle"
                  >
                    <Trash2 size={11} /> {t("删除这条")}
                  </button>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                {[
                  { key: "includeCategories" as const, label: t("只采这些 RSS 栏目"), placeholder: "info, promotion" },
                  { key: "excludeCategories" as const, label: t("排除这些 RSS 栏目"), placeholder: "trade, discussion" },
                  { key: "excludeTitleKeywords" as const, label: t("标题排除词"), placeholder: t("求助, 广告, 招募") },
                ].map((field) => <label key={field.key} className="space-y-1">
                  <span className="text-[11px] text-ink-500">{field.label}</span>
                  <input value={row[field.key]} onChange={(event) => updateFeed(i, { [field.key]: event.target.value })} placeholder={field.placeholder} className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-[12px] text-ink-950 outline-none focus:border-brand" />
                </label>)}
              </div>
              <p className="text-[11px] leading-relaxed text-ink-500">{t("逗号分隔，排除优先。这些栏目是原站 RSS 标签，不是本站分类；采集过滤从下次采集起生效，不删除历史资源。")}</p>
            </div>
          ))}
        </div>
      )}

      {!showJson && source.kind === "telegram" && (
        <label className="block space-y-1">
          <span className="text-[11px] text-ink-500">{t("Telegram 公开频道名（逗号或空格分隔）")}</span>
          <input
            value={tgChannels}
            onChange={(e) => setTgChannels(e.target.value)}
            placeholder="zaihuapd, vps_offers"
            className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink-950 outline-none focus:border-brand"
          />
        </label>
      )}

      {showJson && (
        <div className="space-y-1">
          <span className="text-[11px] text-ink-500">{t("源 config JSON（可直接增删栏目 / feeds / 过滤参数）")}</span>
          <textarea
            rows={5}
            value={rawJson}
            onChange={(e) => setRawJson(e.target.value)}
            className="w-full rounded-lg border border-ink-200 bg-surface p-2 font-mono text-[12px] text-ink-900 outline-none focus:border-brand"
          />
          {jsonErr && <div className="text-[12px] text-alert">{jsonErr}</div>}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <div>
          {!source.builtIn && onDelete && (
            <button
              type="button"
              onClick={async () => {
                if (!confirmDel) {
                  setConfirmDel(true);
                  return;
                }
                const ok = await onDelete();
                if (ok) onCancel();
              }}
              className={
                "inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[12px] font-medium transition-colors " +
                (confirmDel
                  ? "border-alert bg-alert-solid text-on-solid"
                  : "border-ink-200 bg-surface text-alert hover:border-alert/40 hover:bg-alert-subtle")
              }
            >
              <Trash2 size={12} /> {confirmDel ? t("再点一次确认删除") : t("删除自定义源")}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-3 py-1 text-[12px] text-ink-600 hover:bg-ink-100"
          >
            <X size={12} /> {t("取消")}
          </button>
          <button
            type="button"
            disabled={saving || !name.trim() || (!showJson && source.kind === "rss" && feedRows.some((row) => !/^https?:\/\//i.test(row.url.trim())))}
            onClick={() => void handleSave()}
            className="inline-flex items-center gap-1 rounded-lg bg-solid px-3 py-1 text-[12px] font-medium text-on-solid hover:bg-solid-hover disabled:opacity-40"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} {t("保存配置")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function OpsPanel({
  sources,
  runs,
  sourceName,
  onCollectSource,
  onToggleSource,
  onChangeInterval,
  onAddRss,
  onClassificationChanged,
  onUpdateSource,
  onDeleteSource,
  onNotify,
}: {
  sources: Source[];
  runs: Run[];
  sourceName: (id: string) => string;
  onCollectSource: (id: string) => Promise<void>;
  onToggleSource: (id: string, enabled: boolean) => Promise<void>;
  onChangeInterval: (id: string, sec: number) => Promise<void>;
  onAddRss: (name: string, url: string, intervalSec: number, kindHint?: string, categoryHint?: string, fixedCategory?: string) => Promise<void>;
  onClassificationChanged?: () => void;
  onUpdateSource: (id: string, patch: { name?: string; interval_sec?: number; config?: Record<string, unknown> }) => Promise<boolean>;
  onDeleteSource: (id: string) => Promise<boolean>;
  onNotify?: (msg: string) => void;
}) {
  const [subTab, setSubTab] = useState<OpsTab>("sources");
  const [externalTools, setExternalTools] = useState<{ epicClaimer: { url: string } | null } | null>(null);
  const [filterText, setFilterText] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "ok" | "error" | "disabled">("all");
  const [runningIds, setRunningIds] = useState<string[]>([]);
  const isRunning = (id: string) => runningIds.includes(id);
  const runSourceWithLock = async (id: string) => {
    setRunningIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    try {
      await onCollectSource(id);
    } finally {
      setRunningIds((prev) => prev.filter((x) => x !== id));
    }
  };
  const [editingId, setEditingId] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const editingSource = sources.find((source) => source.id === editingId);
  useEffect(() => {
    if (editingId) editorRef.current?.scrollIntoView({ block: "nearest" });
  }, [editingId]);
  const [showAddRss, setShowAddRss] = useState(false);
  const [rssName, setRssName] = useState("");
  const [rssUrl, setRssUrl] = useState("");
  const [rssInterval, setRssInterval] = useState(1800);
  const [rssKindHint, setRssKindHint] = useState("");
  const [rssCategoryHint, setRssCategoryHint] = useState("");
  const [rssFixedCategory, setRssFixedCategory] = useState("");
  const [addingRss, setAddingRss] = useState(false);
  const [showIngestGuide, setShowIngestGuide] = useState(false);
  const [cookieStatus, setCookieStatus] = useState<{
    runnerUrl: string;
    xhsProxy: string;
    sites: Record<
      "zhihu" | "xhs" | "xiaoheihe" | "nga" | "weibo",
      { site: "zhihu" | "xhs" | "xiaoheihe" | "nga" | "weibo"; configured: boolean; count: number; keyNames: string[]; hasAuthHint: boolean; updatedAt: string | null }
    >;
  } | null>(null);
  const [cookieInputs, setCookieInputs] = useState<Record<"zhihu" | "xhs" | "xiaoheihe" | "nga" | "weibo", string>>({
    zhihu: "",
    xhs: "",
    xiaoheihe: "",
    nga: "",
    weibo: "",
  });
  const [runnerUrlInput, setRunnerUrlInput] = useState("http://172.17.0.1:18790");
  const [xhsProxyInput, setXhsProxyInput] = useState("");
  const [cookieBusy, setCookieBusy] = useState<string | null>(null);
  const [runnerTest, setRunnerTest] = useState<{ ok?: boolean; busy?: boolean; chrome?: boolean; error?: string } | null>(null);

  const loadCookieStatus = async () => {
    try {
      const r = await fetch("/api/cookies");
      if (!r.ok) return;
      const d = (await r.json()) as NonNullable<typeof cookieStatus>;
      setCookieStatus(d);
      setRunnerUrlInput(d.runnerUrl || "http://172.17.0.1:18790");
      setXhsProxyInput(d.xhsProxy || "");
    } catch { /* ignore */ }
  };

  useEffect(() => {
    void loadCookieStatus();
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/external-tools")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setExternalTools(d as { epicClaimer: { url: string } | null }); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const saveCookiePatch = async (
    patch: { runnerUrl?: string; xhsProxy?: string; cookies?: Partial<Record<"zhihu" | "xhs" | "xiaoheihe" | "nga" | "weibo", string>> },
    busyKey: string,
    clearKey?: "zhihu" | "xhs" | "xiaoheihe" | "nga" | "weibo",
  ): Promise<boolean> => {
    setCookieBusy(busyKey);
    try {
      const r = await fetch("/api/cookies", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const d = (await r.json().catch(() => ({}))) as NonNullable<typeof cookieStatus> & { error?: string };
      if (!r.ok) {
        onNotify?.(d.error ?? t("保存失败"));
        return false;
      }
      setCookieStatus(d);
      setRunnerUrlInput(d.runnerUrl || "");
      setXhsProxyInput(d.xhsProxy || "");
      if (clearKey) setCookieInputs((prev) => ({ ...prev, [clearKey]: "" }));
      onNotify?.(t("Cookie 托管配置已保存"));
      return true;
    } finally {
      setCookieBusy(null);
    }
  };

  const testCookieRunner = async () => {
    setCookieBusy("test-runner");
    try {
      const r = await fetch("/api/cookies/test-runner", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runnerUrl: runnerUrlInput }),
      });
      const d = (await r.json().catch(() => ({}))) as NonNullable<typeof runnerTest>;
      setRunnerTest(d);
      onNotify?.(d.ok ? t("VPS Cookie 执行器在线且已就绪") : t("执行器未连接：") + (d.error ?? t("检查端口/服务")));
    } finally {
      setCookieBusy(null);
    }
  };
  const [helperUrl, setHelperUrl] = useState(() => {
    try {
      return localStorage.getItem("radar_loopback_helper") || "http://127.0.0.1:18789";
    } catch {
      return "http://127.0.0.1:18789";
    }
  });
  const [ingestTokenInput, setIngestTokenInput] = useState("");

  const siteKeyOf = (id: string) => (id.startsWith("zhihu") ? "zhihu" : id.startsWith("xhs") ? "xhs" : "xiaoheihe");

  const startLoopbackLogin = async (sourceId: string) => {
    const base = helperUrl.replace(/\/+$/, "");
    const site = siteKeyOf(sourceId);
    try {
      const probe = await fetch(base + "/status", { signal: AbortSignal.timeout(1500) });
      if (!probe.ok) throw new Error("not ok");
    } catch {
      setShowIngestGuide(true);
      onNotify?.(t("未检测到本机回环助手（请按下方指引先启动，Cookie 绝不上传）"));
      return;
    }
    const target = new URL(base + "/login");
    target.searchParams.set("site", site);
    target.searchParams.set("server", window.location.origin);
    target.searchParams.set("return_to", window.location.href.split("#")[0] ?? window.location.origin);
    if (ingestTokenInput.trim()) target.searchParams.set("token", ingestTokenInput.trim());
    window.open(target.toString(), "_blank", "noopener");
  };

  const buildUserscript = () => {
    const origin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:8788";
    const tok = ingestTokenInput.trim() || t("请替换为你的 INGEST_TOKEN");
    return `// ==UserScript==
// @name         Freebie Radar 零 Cookie 上传采集助手
// @namespace    https://github.com/ZiChuanLan/freebie-radar
// @version      0.1.0
// @description  仅读取当前搜索页公开帖子标题与链接发送到你自己的 Freebie Radar，Cookie 绝不离开浏览器
// @match        https://www.xiaohongshu.com/search_result*
// @match        https://www.zhihu.com/search*
// @match        https://www.xiaoheihe.cn/app/bbs/*
// @grant        GM_xmlhttpRequest
// ==/UserScript==
(function () {
  const SERVER = ${JSON.stringify(origin)};
  const TOKEN = ${JSON.stringify(tok)};
  function push(sourceId, items) {
    if (!items.length) return;
    GM_xmlhttpRequest({
      method: "POST",
      url: SERVER + "/api/ingest",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
      data: JSON.stringify({ sourceId, items }),
      onload: (r) => console.log("[FreebieRadar]", sourceId, r.status, r.responseText),
    });
  }
  setTimeout(() => {
    const h = location.hostname;
    if (h.includes("xiaohongshu")) {
      const items = [...document.querySelectorAll("section.note-item")].map((c) => {
        const a = c.querySelector('a.cover, a[href*="/explore/"], a[href*="/search_result/"]');
        const t = c.querySelector(".title span, .footer .title, .title");
        const img = c.querySelector("img");
        return a && t ? { externalId: a.href, url: a.href, title: t.textContent.trim(), summary: "", imageUrl: img?.src || "" } : null;
      }).filter((x) => x && x.title && x.url);
      push("xhs-search", items);
    } else if (h.includes("zhihu")) {
      const items = [...document.querySelectorAll(".SearchResult-Card, .List-item")].map((c) => {
        const a = c.querySelector("h2 a, .ContentItem-title a");
        const t = c.querySelector(".RichText");
        const img = c.querySelector("img");
        return a ? { externalId: a.href, url: a.href, title: a.textContent.trim(), summary: (t?.textContent || "").trim().slice(0, 300), imageUrl: img?.getAttribute("data-original") || img?.src || "" } : null;
      }).filter((x) => x && x.title && x.url);
      push("zhihu-search", items);
    }
  }, 3500);
})();`;
  };

  const visibleSources = sources.filter((s) => {
    if (filterText && !(s.name + " " + s.id + " " + s.kind).toLowerCase().includes(filterText.toLowerCase())) {
      return false;
    }
    if (statusFilter === "disabled") return !s.enabled;
    if (statusFilter === "error") return s.last_status === "failed" || s.last_status === "degraded";
    if (statusFilter === "ok") return s.enabled && s.last_status === "ok";
    return true;
  });

  const enabledCount = sources.filter((s) => s.enabled).length;
  const errorCount = sources.filter((s) => s.enabled && (s.last_status === "failed" || s.last_status === "degraded")).length;

  const [retention, setRetention] = useState<RetentionSettings | null>(null);
  const [retCounts, setRetCounts] = useState<{ total: number; active: number; ignored: number; starred: number } | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanPreview, setCleanPreview] = useState<Record<string, number> | null>(null);
  const [upstreamWatch, setUpstreamWatch] = useState<UpstreamWatchState | null>(null);
  const [upstreamChecking, setUpstreamChecking] = useState(false);
  const [upstreamCopied, setUpstreamCopied] = useState(false);


  // 来源质量榜：按源的 AI 留存率看谁在浪费采集与 AI 额度
  const [qualityDays, setQualityDays] = useState(7);
  const [quality, setQuality] = useState<SourceQuality[] | null>(null);
  const [qualityLoading, setQualityLoading] = useState(false);
  useEffect(() => {
    setQualityLoading(true);
    fetch("/api/source-quality?days=" + qualityDays)
      .then((r) => r.json())
      .then((j: { sources: SourceQuality[] }) => setQuality(j.sources))
      .catch(() => setQuality(null))
      .finally(() => setQualityLoading(false));
  }, [qualityDays, sources]);
  useEffect(() => {
    fetch("/api/retention")
      .then((r) => r.json())
      .then((j: { settings: RetentionSettings; counts: typeof retCounts }) => {
        setRetention(j.settings);
        setRetCounts(j.counts);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    const loadUpstream = () => {
      fetch("/api/upstream-watch")
        .then((r) => (r.ok ? r.json() : null))
        .then((j: Partial<UpstreamWatchState> | null) => {
          if (j && typeof j.repo === "string") setUpstreamWatch(j as UpstreamWatchState);
        })
        .catch(() => undefined);
    };
    loadUpstream();
    window.addEventListener(UPSTREAM_WATCH_UPDATED_EVENT, loadUpstream);
    return () => window.removeEventListener(UPSTREAM_WATCH_UPDATED_EVENT, loadUpstream);
  }, []);

  const checkUpstreamNow = async () => {
    setUpstreamChecking(true);
    try {
      const r = await fetch("/api/upstream-watch/check", { method: "POST" });
      if (!r.ok) {
        onNotify?.(t("上游检测失败"));
        return;
      }
      const next = (await r.json()) as UpstreamWatchState;
      setUpstreamWatch(next);
      window.dispatchEvent(new Event(UPSTREAM_WATCH_UPDATED_EVENT));
      onNotify?.(t("已完成上游源头 AI 巡检"));
    } catch {
      onNotify?.(t("上游检测失败"));
    } finally {
      setUpstreamChecking(false);
    }
  };

  const saveRetentionField = async (patch: Partial<RetentionSettings>) => {
    if (!retention) return;
    setRetention({ ...retention, ...patch });
    const r = await fetch("/api/retention", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (r.ok) {
      const j = (await r.json()) as { settings: RetentionSettings; counts: typeof retCounts };
      setRetention(j.settings);
      setRetCounts(j.counts);
      onNotify?.("保留策略已保存");
    } else {
      onNotify?.("保存失败");
    }
  };

  const previewCleanup = async () => {
    const r = await fetch("/api/retention/preview", { method: "POST" });
    if (r.ok) setCleanPreview(((await r.json()) as { deleted: Record<string, number> }).deleted);
  };

  const doCleanup = async () => {
    setCleaning(true);
    try {
      const r = await fetch("/api/retention/run", { method: "POST" });
      if (r.ok) {
        const j = (await r.json()) as { deleted: Record<string, number>; counts: typeof retCounts };
        setCleanPreview(j.deleted);
        setRetCounts(j.counts);
        onNotify?.("清理完成");
      }
    } finally {
      setCleaning(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* 顶部概览 + 子页签 */}
      <div className="panel flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {[
            { key: "sources" as OpsTab, label: t("数据源 ({n}/{total})", { n: enabledCount, total: sources.length }), icon: Rss },
            { key: "runs" as OpsTab, label: t("采集记录 ({n})", { n: runs.length }), icon: Activity },
            { key: "quality" as OpsTab, label: t("来源质量榜"), icon: Gauge },
            { key: "retention" as OpsTab, label: t("数据保留与清理"), icon: Database },
          ].map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setSubTab(tab.key)}
              className={
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors " +
                (subTab === tab.key ? "border border-brand-border bg-brand-subtle text-accent" : "border border-transparent text-ink-600 hover:bg-ink-100")
              }
            >
              <tab.icon size={13} />
              {tab.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-[12px] text-ink-500">
          <span>
            {t("异常源")}{" "}
            <span className={`font-mono font-semibold ${errorCount > 0 ? "text-alert" : "text-deal"}`}>{errorCount}</span>
          </span>
          {retCounts && (
            <span>
              {t("在库")} <span className="font-mono font-semibold text-ink-800">{retCounts.total}</span>
            </span>
          )}
        </div>
      </div>

      {externalTools?.epicClaimer && (
        <div className="panel flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-900">
            <ExternalLink size={14} className="text-accent" />
            <span className="font-semibold">{t("外部工具")}</span>
            <span className="text-[12px] text-ink-500">{t("Epic 喜加一领取器 · 独立项目（自带面板，领取与验证都在那边）")}</span>
          </div>
          <a
            href={externalTools.epicClaimer.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-lg border border-brand-border bg-brand-subtle px-3 py-1.5 text-[12px] font-medium text-accent hover:bg-ink-200/70"
          >
            {t("打开领取器")} <ExternalLink size={11} />
          </a>
        </div>
      )}

      {/* 上游白嫖雷达源头 AI 巡检卡 */}
      <div className="panel min-w-0 space-y-2 px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-[12.5px]">
            <GitMerge size={14} className="shrink-0 text-accent" />
            <span className="font-semibold text-ink-950">{t("上游白嫖雷达源头巡检")}</span>
            <span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[11px] text-ink-600">
              {upstreamWatch?.repo ?? "ZiChuanLan/freebie-radar"}
            </span>
            {upstreamWatch?.latestTag && (
              <span className="rounded border border-ink-200 bg-surface-hover px-1.5 py-0.5 font-mono text-[11px] text-ink-700">
                {upstreamWatch.latestTag}
              </span>
            )}
            <span className="font-mono text-[11px] text-ink-500">
              {upstreamWatch && upstreamWatch.aheadCount > 0
                ? t("未合入 {n} 个提交", { n: upstreamWatch.aheadCount })
                : t("已同步最新")}
            </span>
            {upstreamWatch && (
              <span
                className={
                  "rounded border px-1.5 py-0.5 text-[11px] font-medium " +
                  (upstreamWatch.importance === "major"
                    ? "border-brand-border bg-brand-subtle text-accent"
                    : upstreamWatch.importance === "minor"
                      ? "border-code-border bg-code-subtle text-code"
                      : "border-deal-border bg-deal-subtle text-deal")
                }
              >
                {upstreamWatch.importance === "major"
                  ? t("发现重大功能可合入")
                  : upstreamWatch.importance === "minor"
                    ? t("仅常规小修")
                    : t("已同步最新")}
              </span>
            )}
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={upstreamChecking}
              onClick={() => void checkUpstreamNow()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-solid px-2.5 py-1.5 text-[12px] font-medium text-on-solid transition-colors hover:bg-solid-hover disabled:opacity-50"
            >
              {upstreamChecking ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {upstreamChecking ? t("检测中…") : t("立即 AI 检测上游")}
            </button>
            {upstreamWatch?.mergeCommand && (
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(upstreamWatch.mergeCommand).catch(() => undefined);
                  setUpstreamCopied(true);
                  onNotify?.(t("已复制合入命令"));
                  window.setTimeout(() => setUpstreamCopied(false), 1800);
                }}
                className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-[12px] font-medium text-ink-700 hover:bg-ink-100"
              >
                {upstreamCopied ? <Check size={12} className="text-deal" /> : <Copy size={12} />}
                {upstreamCopied ? t("已复制") : t("复制合入命令")}
              </button>
            )}
            {upstreamWatch?.compareUrl && /^https?:\/\//i.test(upstreamWatch.compareUrl) && (
              <a
                href={upstreamWatch.compareUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-[12px] font-medium text-ink-700 hover:bg-ink-100"
              >
                {t("变更对比")} <ExternalLink size={11} />
              </a>
            )}
          </div>
        </div>

        {upstreamWatch && (
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2 text-[12px] text-ink-600">
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere] break-words">{upstreamWatch.headline}</span>
            <span className="shrink-0 text-[11px] text-ink-400">
              {t("上次检测：{when}", {
                when: upstreamWatch.checkedAt ? timeAgo(upstreamWatch.checkedAt) : t("从未检测"),
              })}
            </span>
          </div>
        )}

        {upstreamWatch && upstreamWatch.highlights.length > 0 && (
          <ul className="space-y-0.5 text-[12px] text-ink-700">
            {upstreamWatch.highlights.map((hl, idx) => (
              <li key={idx} className="flex min-w-0 items-start gap-1.5">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ink-400" aria-hidden="true" />
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere] break-words">{hl}</span>
              </li>
            ))}
          </ul>
        )}

        {upstreamWatch?.error && (
          <div className="rounded-md border border-alert-border bg-alert-subtle px-2.5 py-1.5 text-[11.5px] text-alert [overflow-wrap:anywhere]">
            {upstreamWatch.error}
          </div>
        )}
      </div>

      {subTab === "sources" && (
        <div className="space-y-4">
          <div className="panel overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder={t("搜源名称 / 类型…")}
                  className="rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-[12px] text-ink-900 outline-none focus:border-brand"
                />
                {(["all", "ok", "error", "disabled"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setStatusFilter(k)}
                    className={
                      "rounded-lg px-2.5 py-1 text-[12px] font-medium transition-colors " +
                      (statusFilter === k ? "border border-brand-border bg-brand-subtle text-accent" : "border border-transparent text-ink-600 hover:bg-ink-100")
                    }
                  >
                    {k === "all" ? t("全部 ({n})", { n: sources.length }) : k === "ok" ? t("正常") : k === "error" ? t("异常 ({n})", { n: errorCount }) : t("已禁用")}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowIngestGuide((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-700 hover:border-brand-border hover:text-accent"
                >
                  <KeyRound size={13} /> {showIngestGuide ? t("收起 Cookie 托管") : t("Cookie 托管（知乎/小红书/小黑盒/NGA）")}
                </button>
              <button
                type="button"
                onClick={() => setShowAddRss((v) => !v)}
                className="inline-flex items-center gap-1 rounded-lg border border-brand-border bg-brand-subtle px-3 py-1.5 text-[12px] font-medium text-accent hover:bg-ink-200/70"
              >
                <Plus size={13} /> {showAddRss ? t("收起") : t("添加 RSS / Atom")}
              </button>
            </div>
              </div>

            {showIngestGuide && (
              <div className="space-y-3.5 border-b border-ink-100 bg-brand-subtle/50 px-4 py-3.5 text-[12px] text-ink-700">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 font-medium text-ink-950">
                    <KeyRound size={14} className="text-accent" />
                    {t("VPS Cookie 托管采集（按需拉起无头 Chrome，抓完立即释放，平时 0 MB 内存）")}
                  </div>
                  {runnerTest && (
                    <span
                      className={
                        "rounded px-2 py-0.5 text-[11px] font-medium " +
                        (runnerTest.ok ? "bg-deal-subtle text-deal" : "bg-alert-subtle text-alert")
                      }
                    >
                      {runnerTest.ok ? t("执行器在线") + (runnerTest.chrome ? t(" · Chrome 就绪") : "") : t("未连通：") + (runnerTest.error ?? t("离线"))}
                    </span>
                  )}
                </div>

                {/* 执行器地址与小红书代理 */}
                <div className="grid gap-2 sm:grid-cols-12">
                  <label className="space-y-1 sm:col-span-5">
                    <span className="text-[11px] text-ink-500">{t("VPS 执行器地址（仅内网/Docker 网桥监听）")}</span>
                    <input
                      value={runnerUrlInput}
                      onChange={(e) => setRunnerUrlInput(e.target.value)}
                      placeholder="http://172.17.0.1:18790"
                      className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink-900 outline-none focus:border-brand"
                    />
                  </label>
                  <label className="space-y-1 sm:col-span-4">
                    <span className="text-[11px] text-ink-500">{t("小红书国内代理出口（海外 VPS 必填，如 http://47.110.65.20:8888）")}</span>
                    <input
                      value={xhsProxyInput}
                      onChange={(e) => setXhsProxyInput(e.target.value)}
                      placeholder="http://47.110.65.20:8888"
                      className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink-900 outline-none focus:border-brand"
                    />
                  </label>
                  <div className="flex items-end gap-1.5 sm:col-span-3">
                    <button
                      type="button"
                      disabled={cookieBusy !== null}
                      onClick={() => void saveCookiePatch({ runnerUrl: runnerUrlInput, xhsProxy: xhsProxyInput }, "save-net")}
                      className="inline-flex h-8 flex-1 items-center justify-center rounded-lg bg-solid px-2.5 text-[12px] font-medium text-on-solid hover:bg-ink-800 disabled:opacity-40"
                    >
                      {cookieBusy === "save-net" ? <Loader2 size={12} className="animate-spin" /> : t("保存线路")}
                    </button>
                    <button
                      type="button"
                      disabled={cookieBusy !== null}
                      onClick={() => void testCookieRunner()}
                      className="inline-flex h-8 items-center justify-center rounded-lg border border-ink-200 bg-surface px-2.5 text-[12px] font-medium text-ink-700 hover:border-brand-border hover:text-brand disabled:opacity-40"
                    >
                      {cookieBusy === "test-runner" ? <Loader2 size={12} className="animate-spin" /> : t("测连通")}
                    </button>
                  </div>
                </div>

                {/* 登录态站点 Cookie 粘贴卡 */}
                <div className="grid gap-2.5 lg:grid-cols-2">
                  {(
                    [
{ key: "zhihu" as const, sourceId: "zhihu-search", title: t("知乎（zhihu.com）"), hint: t("关键字段：z_c0 / d_c0") },
                      { key: "xhs" as const, sourceId: "xhs-search", title: t("小红书（xiaohongshu.com）"), hint: t("关键字段：web_session / a1") },
                      { key: "xiaoheihe" as const, sourceId: "xiaoheihe-search", title: t("小黑盒（xiaoheihe.cn）"), hint: t("关键字段：user_token / x_app_id") },
                      {
                        key: "nga" as const,
                        sourceId: "nga-deals",
                        title: t("NGA（bbs.nga.cn）"),
                        hint: t("关键字段：ngaPassportUid / ngaPassportCid（HTTP 直连，无需执行器）"),
                      },
                      {
                        key: "weibo" as const,
                        sourceId: "weibo-freebies",
                        title: t("微博（weibo.com）"),
                        hint: t("关键字段：SUB / SUBP（PC 端 ajax 直连，无需执行器）"),
                      },
                    ] as const
                  ).map((site) => {
                    const st = cookieStatus?.sites[site.key];
                    const draft = cookieInputs[site.key];
                    return (
                      <div key={site.key} className="space-y-2 rounded-lg border border-ink-200 bg-surface p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-ink-950">{site.title}</span>
                          {st?.configured ? (
                            <span
                              className={
                                "rounded px-1.5 py-0.5 text-[11px] font-medium " +
                                (st.hasAuthHint ? "bg-deal-subtle text-deal" : "bg-code-subtle text-code")
                              }
                              title={t("已保存字段：{fields}", { fields: st.keyNames.join(", ") })}
                            >
                              {t("已托管 {n} 项", { n: st.count })}{st.hasAuthHint ? t(" · 含登录态") : t(" · 待核对")}
                            </span>
                          ) : (
                            <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[11px] text-ink-500">{t("未配置")}</span>
                          )}
                        </div>
                        <div className="text-[11px] text-ink-400">
                          {st?.configured && st.updatedAt ? t("更新于 {when} · {fields}", { when: timeAgo(st.updatedAt), fields: st.keyNames.slice(0, 4).join(", ") }) : t(site.hint)}
                        </div>
                        <textarea
                          rows={2}
                          value={draft}
                          onChange={(e) => setCookieInputs((prev) => ({ ...prev, [site.key]: e.target.value }))}
                          placeholder={t("粘贴 Request Cookie 字符串（a=1; b=2）或 Cookie-Editor 导出的 JSON 数组（保存后不回显明文）")}
                          className="w-full rounded-md border border-ink-200 bg-canvas/50 p-2 font-mono text-[11px] text-ink-900 outline-none focus:border-brand"
                        />
                        <div className="flex flex-wrap items-center justify-between gap-1.5">
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={!draft.trim() || cookieBusy !== null}
                              onClick={() => void saveCookiePatch({ cookies: { [site.key]: draft } }, `save-${site.key}`, site.key)}
                              className="inline-flex h-7 items-center gap-1 rounded-md bg-solid px-2.5 text-[12px] font-medium text-on-solid hover:bg-solid-hover disabled:opacity-40"
                            >
                              {cookieBusy === `save-${site.key}` ? <Loader2 size={11} className="animate-spin" /> : t("保存")}
                            </button>
                            <button
                              type="button"
                              disabled={(!draft.trim() && !st?.configured) || cookieBusy !== null || isRunning(site.sourceId)}
                              onClick={async () => {
                                if (draft.trim()) {
                                  const ok = await saveCookiePatch({ cookies: { [site.key]: draft } }, `run-${site.key}`, site.key);
                                  if (!ok) return;
                                }
                                await runSourceWithLock(site.sourceId);
                              }}
                              className="inline-flex h-7 items-center gap-1 rounded-md border border-ink-200 bg-surface px-2.5 text-[12px] font-medium text-ink-800 hover:border-brand-border hover:text-brand disabled:opacity-40"
                            >
                              {isRunning(site.sourceId) ? <Loader2 size={11} className="animate-spin" /> : <Play size={10} />}
                              {t("立即采集")}
                            </button>
                          </div>
                          {st?.configured && (
                            <button
                              type="button"
                              disabled={cookieBusy !== null}
                              onClick={() => void saveCookiePatch({ cookies: { [site.key]: "" } }, `del-${site.key}`, site.key)}
                              className="text-[11px] text-alert hover:underline"
                            >
                              {t("清空")}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <details className="rounded-lg border border-ink-200/80 bg-surface/80 px-3 py-2 text-[12px] text-ink-600">
                  <summary className="cursor-pointer font-medium text-ink-700">
                    {t("备用：本机回环助手 / 油猴脚本（Cookie 留在本机时使用）")}
                  </summary>
                  <div className="mt-2 space-y-2">
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="space-y-1">
                    <span className="text-[12px] text-ink-500">{t("本机回环助手地址")}</span>
                    <input
                      value={helperUrl}
                      onChange={(e) => {
                        setHelperUrl(e.target.value);
                        try {
                          localStorage.setItem("radar_loopback_helper", e.target.value);
                        } catch { /* ignore */ }
                      }}
                      className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink-900 outline-none focus:border-brand"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[12px] text-ink-500">{t("可选回传 INGEST_TOKEN（留空则用本机助手 .env）")}</span>
                    <input
                      type="password"
                      value={ingestTokenInput}
                      onChange={(e) => setIngestTokenInput(e.target.value)}
                      placeholder={t("若本机 .env 已配 INGEST_TOKEN 可留空")}
                      className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink-900 outline-none focus:border-brand"
                    />
                  </label>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[12px]">
                  <span className="text-ink-500">{t("方式 A（本机回环服务，平时无常驻浏览器）：")}</span>
                  <code className="rounded bg-surface px-2 py-1 font-mono text-[12px] text-ink-900">
                    SERVER_URL={typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:8788"} node scripts/pw-collect.mjs serve
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(
                        `SERVER_URL=${window.location.origin} node scripts/pw-collect.mjs serve`,
                      );
                      onNotify?.(t("已复制回环助手启动命令"));
                    }}
                    className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2 py-1 text-[12px] hover:border-brand-border hover:text-accent"
                  >
                    <Copy size={11} /> {t("复制命令")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(buildUserscript());
                      onNotify?.(t("已复制 Tampermonkey 油猴脚本（免装 Playwright）"));
                    }}
                    className="inline-flex items-center gap-1 rounded-lg border border-brand-border bg-surface px-2 py-1 text-[12px] text-accent hover:bg-brand-subtle"
                  >
                    <Copy size={11} /> {t("复制油猴脚本（方式 B · 免装 Node）")}
                  </button>
                </div>
                  </div>
                </details>
              </div>
            )}
            {showAddRss && (
              <div className="space-y-2 border-b border-ink-100 bg-surface-hover px-4 py-3">
                <div className="grid gap-2 sm:grid-cols-12">
                  <input
                    value={rssName}
                    onChange={(e) => setRssName(e.target.value)}
                    placeholder={t("源名称（如 财联社电报 / 某博客）")}
                    className="rounded-lg border border-ink-200 bg-surface px-3 py-2 text-[12px] text-ink-950 outline-none focus:border-brand sm:col-span-3"
                  />
                  <input
                    value={rssUrl}
                    onChange={(e) => setRssUrl(e.target.value)}
                    placeholder="https://example.com/feed"
                    className="rounded-lg border border-ink-200 bg-surface px-3 py-2 text-[12px] text-ink-950 outline-none focus:border-brand sm:col-span-4"
                  />
                  <select
                    value={rssKindHint}
                    onChange={(e) => setRssKindHint(e.target.value)}
                    className="rounded-lg border border-ink-200 bg-surface px-2 py-2 text-[12px] text-ink-800 outline-none focus:border-brand sm:col-span-3"
                  >
                    {KIND_HINT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <div className="sm:col-span-2">
                    <CategoryHintSelect
                      value={rssCategoryHint}
                      onChange={setRssCategoryHint}
                      className="w-full rounded-lg border border-ink-200 bg-surface px-2 py-2 text-[12px] text-ink-800 outline-none focus:border-brand"
                    />
                  </div>
                </div>
                <label className="flex flex-wrap items-center gap-3 text-[12px] text-ink-600">
                  <span className="font-medium">{t("固定分类（可选）")}</span>
                  <CategoryHintSelect value={rssFixedCategory} onChange={setRssFixedCategory} emptyLabel={t("不固定 · 按内容自动分类")} className="rounded-lg border border-ink-200 bg-surface px-2 py-2 text-[12px] text-ink-800" />
                  <span className="text-[12px] text-ink-500">{t("适合网盘、课程等专源；AI 不会改到其它分类。")}</span>
                </label>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-[12px] text-ink-500">
                    <span>{t("采集周期：")}</span>
                    <select
                      value={rssInterval}
                      onChange={(e) => setRssInterval(Number(e.target.value))}
                      className="rounded-lg border border-ink-200 bg-surface px-2 py-1 text-[12px] text-ink-800 outline-none focus:border-brand"
                    >
                      {INTERVAL_OPTIONS.map((o) => (
                        <option key={o.sec} value={o.sec}>
                          {t("每 {v}", { v: o.label })}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    disabled={!rssName.trim() || !/^https?:\/\//i.test(rssUrl.trim()) || addingRss}
                    onClick={async () => {
                      setAddingRss(true);
                      try {
                        await onAddRss(
                          rssName.trim(),
                          rssUrl.trim(),
                          rssInterval,
                          rssKindHint || undefined,
                          rssCategoryHint || undefined,
                          rssFixedCategory || undefined,
                        );
                        setRssName("");
                        setRssUrl("");
                        setRssKindHint("");
                        setRssCategoryHint("");
                        setRssFixedCategory("");
                        setShowAddRss(false);
                      } finally {
                        setAddingRss(false);
                      }
                    }}
                    className="inline-flex items-center justify-center gap-1 rounded-lg bg-solid px-3.5 py-1.5 text-[12px] font-medium text-on-solid transition-colors hover:bg-solid-hover disabled:opacity-40"
                  >
                    {addingRss ? <Loader2 size={13} className="animate-spin" /> : <Plus size={14} />}
                    {t("加入并采集")}
                  </button>
                </div>
              </div>
            )}

            <div className="px-4 py-4"><ClassificationPanel sources={sources} onChanged={onClassificationChanged ?? (() => {})} /></div>
            {editingSource && <div ref={editorRef} className="border-b border-ink-200 bg-surface-hover px-4 py-3">
              <SourceInlineEditor key={editingSource.id} source={editingSource}
                onSave={(patch) => onUpdateSource(editingSource.id, patch)}
                onDelete={!editingSource.builtIn ? () => onDeleteSource(editingSource.id) : undefined}
                onCancel={() => setEditingId(null)} />
            </div>}
            {/* 移动端：卡片式源列表（表格仅 ≥sm 显示，避免横向挤压） */}
            <div className="divide-y divide-ink-100 sm:hidden">
              {visibleSources.map((s) => {
                const isCustomInterval = !INTERVAL_OPTIONS.some((o) => o.sec === s.interval_sec);
                return (
                  <div key={s.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-ink-950">{s.name}</div>
                        <div className="truncate font-mono text-[11px] text-ink-400">
                          {s.id} · {s.kind}
                        </div>
                      </div>
                      <span
                        className={
                          "shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium " +
                          (s.last_status === "ok"
                            ? "bg-deal-subtle text-deal"
                            : s.last_status === "failed"
                              ? "bg-alert-subtle text-alert"
                              : s.last_status === "degraded"
                                ? "bg-code-subtle text-code"
                                : "bg-ink-100 text-ink-600")
                        }
                      >
                        {s.last_status ?? t("未运行")}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-ink-500">
                      <span className="font-mono tabular-nums text-ink-700">{t("{n} 条在库", { n: s.items })}</span>
                      <span className="text-ink-400">
                        {(() => {
                          const hints = sourceHints(s);
                          const cat = hints.category || t("分类自动");
                          const kind = hints.kind || t("用途自动");
                          return `${cat} · ${kind}`;
                        })()}
                      </span>
                      <span>{t("{time}采集", { time: timeAgo(s.last_run_at) })}</span>
                      <button
                        type="button"
                        onClick={() => onToggleSource(s.id, !s.enabled)}
                        className={"h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors " + (s.enabled ? "bg-solid" : "bg-ink-300")}
                        title={s.enabled ? t("点击禁用") : t("点击启用")}
                      >
                        <span
                          className={
                            "block h-4 w-4 rounded-full bg-knob shadow-sm transition-transform " + (s.enabled ? "translate-x-4" : "")
                          }
                        />
                      </button>
                      {s.kind === "ingest" && !cookieStatus?.sites[siteKeyOf(s.id)]?.configured ? (
                        <span className="text-[12px] text-ink-500">{t("待配 Cookie")}</span>
                      ) : (
                        <select
                          value={s.interval_sec}
                          onChange={(e) => onChangeInterval(s.id, Number(e.target.value))}
                          className="rounded-lg border border-ink-200 bg-surface px-2 py-1.5 text-[12px] text-ink-800 outline-none focus:border-brand"
                        >
                          {isCustomInterval && <option value={s.interval_sec}>{formatInterval(s.interval_sec)}</option>}
                          {INTERVAL_OPTIONS.map((o) => (
                            <option key={o.sec} value={o.sec}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>

                    {s.last_error && <div className="mt-1.5 font-mono text-[11px] text-alert">{s.last_error}</div>}

                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingId((cur) => (cur === s.id ? null : s.id))}
                        className={
                          "inline-flex items-center justify-center gap-1 rounded-lg border px-2.5 py-2 text-[12px] font-medium transition-colors " +
                          (editingId === s.id
                            ? "border-brand-border bg-brand-subtle text-accent"
                            : "border-ink-200 bg-surface text-ink-700 hover:border-ink-300")
                        }
                      >
                        <Pencil size={11} /> {t("编辑")}
                      </button>
                      {s.kind === "ingest" && !cookieStatus?.sites[siteKeyOf(s.id)]?.configured ? (
                        <button
                          type="button"
                          onClick={() => setShowIngestGuide(true)}
                          className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-brand-border bg-brand-subtle px-2.5 py-2 text-[12px] font-medium text-accent hover:bg-ink-200/70"
                          title={t("先贴入 Cookie 或启用本机回环采集")}
                        >
                          <KeyRound size={11} />
                          {t("配置 Cookie")}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={isRunning(s.id)}
                          onClick={() => void runSourceWithLock(s.id)}
                          className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-2 text-[12px] font-medium text-ink-700 hover:border-brand-border hover:bg-brand-subtle hover:text-accent disabled:opacity-50"
                        >
                          {isRunning(s.id) ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                          {t("立即采集")}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full text-left text-[13px]">
                <thead className="bg-surface-hover text-[11px] tracking-wide text-ink-500 uppercase">
                  <tr className="border-b border-ink-200">
                    <th className="px-4 py-2.5 font-medium">{t("源")}</th>
                    <th className="px-2 py-2.5 font-medium">{t("启用")}</th>
                    <th className="px-2 py-2.5 font-medium">{t("采集周期")}</th>
                    <th className="px-2 py-2.5 font-medium">{t("分类口径")}</th>
                    <th className="px-2 py-2.5 font-medium">{t("在库条数")}</th>
                    <th className="px-2 py-2.5 font-medium">{t("最近采集")}</th>
                    <th className="px-2 py-2.5 font-medium">{t("状态")}</th>
                    <th className="px-2 py-2.5 font-medium">{t("错误信息")}</th>
                    <th className="px-4 py-2.5 text-right font-medium">{t("操作")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {visibleSources.map((s) => {
                    const isCustomInterval = !INTERVAL_OPTIONS.some((o) => o.sec === s.interval_sec);
                    return (
                      <Fragment key={s.id}>
                      <tr className="hover:bg-surface-hover">
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-ink-950">{s.name}</div>
                          <div className="font-mono text-[11px] text-ink-400">
                            {s.id} · {s.kind}
                          </div>
                        </td>
                        <td className="px-2 py-2.5">
                          <button
                            type="button"
                            onClick={() => onToggleSource(s.id, !s.enabled)}
                            className={
                              "h-5 w-9 rounded-full p-0.5 transition-colors " + (s.enabled ? "bg-solid" : "bg-ink-300")
                            }
                            title={s.enabled ? t("点击禁用") : t("点击启用")}
                          >
                            <span
                              className={
                                "block h-4 w-4 rounded-full bg-knob shadow-sm transition-transform " +
                                (s.enabled ? "translate-x-4" : "")
                              }
                            />
                          </button>
                        </td>
                        <td className="px-2 py-2.5">
                          {s.kind === "ingest" && !cookieStatus?.sites[siteKeyOf(s.id)]?.configured ? (
                            <span className="text-[12px] text-ink-500">{t("待配 Cookie")}</span>
                          ) : (
                            <select
                              value={s.interval_sec}
                              onChange={(e) => onChangeInterval(s.id, Number(e.target.value))}
                              className="rounded-lg border border-ink-200 bg-surface px-2 py-1 text-[12px] text-ink-800 outline-none focus:border-brand"
                            >
                              {isCustomInterval && <option value={s.interval_sec}>{formatInterval(s.interval_sec)}</option>}
                              {INTERVAL_OPTIONS.map((o) => (
                                <option key={o.sec} value={o.sec}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td className="px-2 py-2.5">
                          {(() => {
                            const hints = sourceHints(s);
                            if (!hints.category && !hints.kind) {
                              return <span className="text-[11px] text-ink-400">{t("自动")}</span>;
                            }
                            return (
                              <div className="flex flex-col gap-0.5 text-[11px]">
                                {hints.category && <span className="text-ink-700">{hints.category}</span>}
                                {hints.kind && <span className="text-ink-500">{hints.kind}</span>}
                              </div>
                            );
                          })()}
                        </td>
                        <td className="px-2 py-2.5 font-mono tabular-nums text-ink-700">{s.items}</td>
                        <td className="px-2 py-2.5 text-ink-500">{timeAgo(s.last_run_at)}</td>
                        <td className="px-2 py-2.5">
                          <span
                            className={
                              "inline-flex rounded-md px-2 py-0.5 text-[11px] font-medium " +
                              (s.last_status === "ok"
                                ? "bg-deal-subtle text-deal"
                                : s.last_status === "failed"
                                  ? "bg-alert-subtle text-alert"
                                  : s.last_status === "degraded"
                                    ? "bg-code-subtle text-code"
                                    : "bg-ink-100 text-ink-600")
                            }
                          >
                            {s.last_status ?? t("未运行")}
                          </span>
                        </td>
                        <td className="max-w-[220px] truncate px-2 py-2.5 font-mono text-[11px]" title={s.last_error ?? ""}>
                          {s.last_error ? <span className="text-alert">{s.last_error}</span> : <span className="text-ink-300">—</span>}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <div className="inline-flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => setEditingId((cur) => (cur === s.id ? null : s.id))}
                              className={
                                "inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[12px] font-medium transition-colors " +
                                (editingId === s.id
                                  ? "border-brand-border bg-brand-subtle text-accent"
                                  : "border-ink-200 bg-surface text-ink-600 hover:border-ink-300 hover:text-ink-950")
                              }
                              title={t("编辑名称、RSS 地址、用途频道或 JSON 配置")}
                            >
                              <Pencil size={11} /> {t("编辑")}
                            </button>
                            {s.kind === "ingest" && !cookieStatus?.sites[siteKeyOf(s.id)]?.configured ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => setShowIngestGuide(true)}
                                  className="inline-flex items-center gap-1 rounded-lg border border-brand-border bg-brand-subtle px-2.5 py-1 text-[12px] font-medium text-accent hover:bg-ink-200/70"
                                  title={t("粘贴 Cookie 开启 VPS 全链路采集")}
                                >
                                  <KeyRound size={11} />
                                  {t("配 Cookie")}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void startLoopbackLogin(s.id)}
                                  className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2 py-1 text-[12px] text-ink-600 hover:border-brand-border hover:text-accent"
                                  title={t("备用：通过本机回环助手扫码登录采集")}
                                >
                                  <ExternalLink size={11} />
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                disabled={isRunning(s.id)}
                                onClick={() => void runSourceWithLock(s.id)}
                                className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1 text-[12px] font-medium text-ink-700 hover:border-brand-border hover:bg-brand-subtle hover:text-accent disabled:opacity-50"
                              >
                                {isRunning(s.id) ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
                                {t("立即采集")}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}


      {subTab === "quality" && (
        <div className="space-y-4">
          <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <div className="flex items-center gap-2 text-[14px] font-semibold text-ink-950">
                <Gauge size={15} className="text-accent" /> {t("来源质量榜")}
              </div>
              <p className="mt-0.5 text-[12px] text-ink-500">
                {t("留存率 = AI 判为有效 ÷ 已审条数。留存率低、条数又多的源，基本是在白烧采集与 AI 额度。")}
              </p>
            </div>
            <div className="flex items-center gap-0.5 rounded-md border border-ink-200 bg-surface p-0.5">
              {[
                { d: 1, label: t("今天") },
                { d: 7, label: t("7 天") },
                { d: 30, label: t("30 天") },
              ].map((w) => (
                <button
                  key={w.d}
                  type="button"
                  onClick={() => setQualityDays(w.d)}
                  className={
                    "rounded px-2.5 py-1 text-[12px] font-medium transition-colors " +
                    (qualityDays === w.d ? "bg-canvas-subtle font-semibold text-ink-950 shadow-[inset_0_0_0_1px_var(--color-brand-border)]" : "text-ink-500 hover:text-ink-950")
                  }
                >
                  {w.label}
                </button>
              ))}
            </div>
          </div>

          <div className="panel overflow-hidden">
            {qualityLoading && !quality && (
              <div className="flex items-center gap-2 px-4 py-8 text-[13px] text-ink-500">
                <Loader2 size={13} className="animate-spin" /> {t("统计中…")}
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-[13px]">
                <thead className="bg-surface-hover text-[11px] tracking-wide text-ink-500 uppercase">
                  <tr className="border-b border-ink-200">
                    <th className="px-4 py-2 font-medium">{t("源")}</th>
                    <th className="px-2 py-2 text-right font-medium">{t("入库")}</th>
                    <th className="px-2 py-2 text-right font-medium">{t("已审")}</th>
                    <th className="px-2 py-2 text-right font-medium">{t("留存")}</th>
                    <th className="px-2 py-2 font-medium">{t("留存率")}</th>
                    <th className="px-2 py-2 text-right font-medium">{t("平均质量")}</th>
                    <th className="px-2 py-2 text-right font-medium">{t("已推")}</th>
                  </tr>
                </thead>
                <tbody>
                  {(quality ?? [])
                    .filter((q) => q.total > 0)
                    .sort((a, b) => (a.keepRate ?? 2) - (b.keepRate ?? 2) || b.total - a.total)
                    .map((q) => {
                      const rate = q.keepRate;
                      const pct = rate === null ? null : Math.round(rate * 100);
                      const tone = pct === null ? "text-ink-400" : pct >= 60 ? "text-deal" : pct >= 30 ? "text-ink-700" : "text-alert";
                      return (
                        <tr key={q.id} className="border-b border-ink-100 last:border-0 hover:bg-surface-hover">
                          <td className="px-4 py-2">
                            <div className="text-[12px] font-medium text-ink-900">{q.name}</div>
                            <div className="font-mono text-[11px] text-ink-400">{q.id}</div>
                          </td>
                          <td className="px-2 py-2 text-right font-mono tabular-nums text-ink-700">{q.total}</td>
                          <td className="px-2 py-2 text-right font-mono tabular-nums text-ink-500">{q.reviewed}</td>
                          <td className="px-2 py-2 text-right font-mono tabular-nums text-ink-700">{q.kept}</td>
                          <td className="px-2 py-2">
                            <div className="flex items-center gap-2">
                              <div className="h-1.5 w-16 overflow-hidden rounded-full bg-ink-100">
                                <div
                                  className={"h-full rounded-full " + (pct !== null && pct >= 60 ? "bg-deal" : pct !== null && pct >= 30 ? "bg-accent-solid" : "bg-alert-solid")}
                                  style={{ width: (pct ?? 0) + "%" }}
                                />
                              </div>
                              <span className={"font-mono text-[12px] tabular-nums " + tone}>
                                {pct === null ? t("未审") : pct + "%"}
                              </span>
                            </div>
                          </td>
                          <td className="px-2 py-2 text-right font-mono tabular-nums text-ink-700">
                            {q.avgQuality === null ? "—" : q.avgQuality}
                          </td>
                          <td className="px-2 py-2 text-right font-mono tabular-nums text-ink-500">{q.pushed}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            {quality && quality.filter((q) => q.total > 0).length === 0 && (
              <div className="px-4 py-10 text-center text-[12px] text-ink-500">{t("这个时间范围内没有采集到条目")}</div>
            )}
          </div>
        </div>
      )}
      {subTab === "runs" && (
        <div className="panel overflow-hidden">
          <div className="border-b border-ink-100 px-4 py-3 text-[14px] font-semibold text-ink-950">
            {t("最近采集记录（{n}）", { n: runs.length })}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-[13px]">
              <thead className="bg-surface-hover text-[11px] tracking-wide text-ink-500 uppercase">
                <tr className="border-b border-ink-200">
                  <th className="px-4 py-2 font-medium">{t("时间")}</th>
                  <th className="px-2 py-2 font-medium">{t("源")}</th>
                  <th className="px-2 py-2 font-medium">{t("抓取")}</th>
                  <th className="px-2 py-2 font-medium">{t("新增")}</th>
                  <th className="px-2 py-2 font-medium">{t("耗时")}</th>
                  <th className="px-4 py-2 font-medium">{t("结果")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {runs.map((r) => (
                  <tr key={r.id} className="hover:bg-surface-hover">
                    <td className="px-4 py-2 font-mono text-[12px] text-ink-500">
                      {r.started_at.replace("T", " ").slice(5, 19)}
                    </td>
                    <td className="px-2 py-2 text-ink-800">{sourceName(r.source_id)}</td>
                    <td className="px-2 py-2 font-mono tabular-nums text-ink-700">{r.fetched}</td>
                    <td className="px-2 py-2 font-mono font-medium tabular-nums text-deal">{r.inserted}</td>
                    <td className="px-2 py-2 font-mono tabular-nums text-ink-500">
                      {r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + "s" : "—"}
                    </td>
                    <td className="max-w-[320px] truncate px-4 py-2 font-mono text-[11px] text-ink-500">
                      {r.error ?? r.status}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {subTab === "retention" && (
        <div className="panel space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-2 text-[14px] font-semibold text-ink-950">
                <Trash2 size={15} className="text-accent" /> {t("数据保留与自动清理")}
              </div>
              <p className="mt-0.5 text-[12px] text-ink-500">
                {t("修改天数后失焦即保存；收藏条目永久保留不删除。")}
              </p>
            </div>
            {retCounts && (
              <span className="text-[12px] text-ink-500">
                {t("在库")} <span className="font-mono font-medium text-ink-800">{retCounts.total}</span>{t(" · 收藏")}{" "}
                <span className="font-mono font-medium text-code">{retCounts.starred}</span>{t(" · 已关闭")}{" "}
                <span className="font-mono font-medium">{retCounts.ignored}</span>
              </span>
            )}
          </div>

          {retention && (
            <div className="grid gap-3 sm:grid-cols-5">
              {[
                { key: "itemDays" as const, label: t("非福利条目"), hint: t("天") },
                { key: "keptDays" as const, label: t("AI 判福利"), hint: t("天") },
                { key: "ignoredDays" as const, label: t("手动关闭"), hint: t("天") },
                { key: "pushLogDays" as const, label: t("推送日志"), hint: t("天") },
                { key: "digestDays" as const, label: t("每日精选"), hint: t("天") },
              ].map((f) => (
                <label key={f.key} className="block rounded-lg border border-ink-200 bg-surface-hover p-3">
                  <span className="mb-1.5 block text-[12px] font-medium text-ink-700">{f.label}</span>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min={1}
                      max={3650}
                      value={retention[f.key]}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setRetention({ ...retention, [f.key]: Number.isFinite(v) ? v : 0 });
                      }}
                      onBlur={(e) => {
                        const raw = Number(e.target.value);
                        const clamped = Math.min(Math.max(Number.isFinite(raw) ? Math.round(raw) : 1, 1), 3650);
                        void saveRetentionField({ [f.key]: clamped } as Partial<RetentionSettings>);
                      }}
                      className="w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 font-mono text-[13px] text-ink-900 outline-none focus:border-brand"
                    />
                    <span className="text-[12px] text-ink-500">{f.hint}</span>
                  </div>
                </label>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <label className="flex items-center gap-2 text-[12px] text-ink-700">
              <input
                type="checkbox"
                checked={retention?.auto ?? true}
                onChange={(e) => void saveRetentionField({ auto: e.target.checked })}
                className="h-4 w-4 accent-brand"
              />
              {t("每天自动清理过期数据")}
            </label>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={previewCleanup}
                className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-3.5 py-1.5 text-[12px] font-medium text-ink-700 hover:bg-ink-100"
              >
                <Search size={13} /> {t("预演清理量")}
              </button>
              <button
                type="button"
                disabled={cleaning}
                onClick={doCleanup}
                className="inline-flex items-center gap-1.5 rounded-lg border border-alert-border bg-alert-subtle px-3.5 py-1.5 text-[12px] font-medium text-alert hover:bg-alert-subtle/80 disabled:opacity-60"
              >
                {cleaning ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} {t("立即清理")}
              </button>
            </div>
          </div>

          {cleanPreview && (
            <div className="rounded-lg border border-ink-200 bg-surface-hover p-3 text-[12px] text-ink-700">
              {t("将清理：")}
              {Object.entries(cleanPreview)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => `${k} ${t("{n} 条", { n })}`)
                .join(" · ") || t("没有需要清理的条目")}
            </div>
          )}
        </div>
      )}

    </div>
  );
}
