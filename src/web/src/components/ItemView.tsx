import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Ban,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  Copy,
  Eye,
  EyeOff,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import { KIND_LABEL, OBTAIN_HINT, OBTAIN_LABEL, categoryLabelForKind, expiresLabel, extractBlockCandidates, timeAgo } from "../lib/sources.ts";
import { isSummaryCoveredByContent, plainCharCount, splitReasonBadge } from "../lib/snapshot.ts";
import { SnapshotContent } from "./SnapshotContent.tsx";
import type { ItemDossier } from "../../../shared/dossier.ts";
import type { Item } from "../types.ts";
import { DossierCard } from "./DossierCard.tsx";
import { ItemClassificationEditor, type ClassificationPatch } from "./ItemClassificationEditor.tsx";
import { t } from "../lib/i18n.ts";
import { useNow } from "../lib/clock.ts";

export { splitReasonBadge };

/** 相对时间：订阅共享时钟，只有这一小块每 30 秒重渲染。 */
export function RelativeTime({ iso, className = "" }: { iso: string | null | undefined; className?: string }) {
  useNow();
  return <span className={className}>{timeAgo(iso)}</span>;
}

export function CodeChip({ code, onCopy }: { code: string; onCopy: (code: string) => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onCopy(code);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
      className={
        "inline-flex max-w-[46vw] items-center gap-1 truncate rounded px-2 py-1 font-mono text-[11px] font-semibold transition-colors sm:max-w-none sm:py-0.5 " +
        (copied
          ? "bg-deal-subtle text-deal"
          : "bg-code-subtle text-code hover:bg-code-border/70")
      }
      title={t("点击复制兑换码")}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {code}
    </button>
  );
}

function PriceBadge({ item, inline = false }: { item: Item; inline?: boolean }) {
  if (item.is_free === 1 || item.price === 0) {
    return inline ? (
      <span className="shrink-0 text-[12px] font-semibold text-deal">{t("免费")}</span>
    ) : (
      <span className="inline-flex items-center rounded bg-deal-subtle px-1.5 py-0.5 text-[11px] font-semibold text-deal">
        {t("免费")}
      </span>
    );
  }
  if (typeof item.price === "number" && item.price > 0) {
    const label = item.price < 1 ? t("<1 元") : t("{n} 元内", { n: Math.round(item.price) });
    return inline ? (
      <span className="shrink-0 text-[12px] font-semibold text-accent">{label}</span>
    ) : (
      <span className="inline-flex items-center rounded bg-brand-subtle px-1.5 py-0.5 text-[11px] font-semibold text-accent">
        {label}
      </span>
    );
  }
  return null;
}

const OBTAIN_STYLE: Record<string, string> = {
  conditional: "bg-code-subtle text-code",
  lottery: "bg-purple-50 text-purple-700",
  trial: "bg-sky-50 text-sky-700",
  promo: "bg-ink-100 text-ink-600",
  paid: "bg-ink-100 text-ink-600",
};

const OBTAIN_TEXT: Record<string, string> = {
  conditional: "text-code",
  lottery: "text-purple-700",
  trial: "text-sky-700",
  promo: "text-ink-500",
  paid: "text-ink-500",
};

/** 获取方式徽章：非 free 的一律标出来，避免抽奖/试用/推广混进「完全白嫖」。 */
const KIND_STYLE: Record<string, string> = {
  deal: "bg-code-subtle text-code",
  opensource: "bg-deal-subtle text-deal",
  news: "bg-rose-50 text-rose-700",
  info: "bg-sky-50 text-sky-700",
};

function KindBadge({ kind, category, inline = false }: { kind: string | null | undefined; category?: string | null; inline?: boolean }) {
  if (!kind || kind === "freebie" || kind === "noise" || kind === "info") return null;
  // 网盘/网课资源本身是「资源分享」，分类标签已经说清内容性质；
  // kind 五类里没有资源形态，AI 只能落 info，再挂「行业资讯」就和「网盘资源」自相矛盾了
  if ((category === "pan" || category === "course") && (kind === "info" || kind === "news")) return null;
  const label = KIND_LABEL[kind];
  if (!label) return null;
  if (inline) {
    return (
      <span className={"shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium " + (KIND_STYLE[kind] ?? "bg-ink-100 text-ink-600")}>
        {t(label)}
      </span>
    );
  }
  return (
    <span className={"inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium " + (KIND_STYLE[kind] ?? "bg-ink-100 text-ink-600")}>
      {t(label)}
    </span>
  );
}

function ObtainBadge({ obtain, inline = false }: { obtain: string | null | undefined; inline?: boolean }) {
  const mode = obtain ?? "free";
  if (mode === "free") return null;
  if (inline) {
    return (
      <span
        className={"shrink-0 text-[12px] font-semibold " + (OBTAIN_TEXT[mode] ?? OBTAIN_TEXT.promo)}
        title={t(OBTAIN_HINT[mode] ?? "")}
      >
        {t(OBTAIN_LABEL[mode] ?? mode)}
      </span>
    );
  }
  return (
    <span
      className={"inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium " + (OBTAIN_STYLE[mode] ?? OBTAIN_STYLE.promo)}
      title={t(OBTAIN_HINT[mode] ?? "")}
    >
      {t(OBTAIN_LABEL[mode] ?? mode)}
    </span>
  );
}

/** 默认的精致紧凑列表行：在纯白面板里用 1px 细线分隔，扫货效率最高。 */
const SOURCE_TONES = [
  "bg-[#4338ca]",
  "bg-[#047857]",
  "bg-[#b45309]",
  "bg-[#be123c]",
  "bg-[#64748b]",
] as const;

/** 同一来源恒定同色，431 条列表靠色块做视觉锚点。 */
function sourceTone(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return SOURCE_TONES[hash % SOURCE_TONES.length]!;
}

function DossierBadge({ item }: { item: Item }) {
  if (!item.hasDossier && !item.dossier) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full border border-brand-border bg-brand-subtle px-1.5 py-0.5 text-[11px] font-medium text-accent"
      title={t("已生成 AI 实战立项拆解书")}
    >
      {t("⚡立项书")}
    </span>
  );
}

function MetaSep({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={"text-ink-300 " + className}>·</span>;
}

/** 默认的精致紧凑列表行：在纯白面板里用 1px 细线分隔，扫货效率最高。 */
export function CompactRow({
  item,
  sourceName,
  selected,
  onPatch,
  onOpen,
  onQuickBlock,
  onToggleRelated,
  expanded,
  onCopyCode,
  showSummary = false,
}: {
  item: Item;
  sourceName: (id: string) => string;
  selected?: boolean;
  onPatch: (id: number, body: Record<string, unknown>) => void;
  onOpen: (item: Item) => void;
  onQuickBlock: (item: Item) => void;
  onCopyCode: (code: string) => void;
  /** 合并组：展开/收起同福利的其他来源 */
  onToggleRelated?: (id: number) => void;
  expanded?: boolean;
  showSummary?: boolean;
}) {
  const exp = expiresLabel(item.expires_at);
  const codes = Array.isArray(item.codes) ? item.codes : [];
  const matched = Array.isArray(item.matched) ? item.matched : [];
  const aiRejected = item.ai?.keep === false;
  const showPrice = item.kind !== "news" && item.kind !== "info";
  const topPick = !item.read && !aiRejected && ((item.ai?.quality ?? item.ai_quality ?? 0) >= 5 || item.score >= 88);
  const name = sourceName(item.source_id);
  const rawCategoryLabel = categoryLabelForKind(item.category, item.kind);
  const categoryLabel = t(rawCategoryLabel);
  // 「其它 / 其它资讯」是兜底分类，挂在每一行上只会制造噪音
  const showCategory = rawCategoryLabel !== "其它" && rawCategoryLabel !== "其它资讯";

  return (
    <div
      onClick={() => onOpen(item)}
      data-read={item.read}
      className={
        "resource-row group grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5 gap-y-1 border-b border-ink-100 py-3 pr-3 pl-3 transition-colors last:border-b-0 sm:flex sm:items-center sm:gap-x-3 sm:gap-y-0 sm:py-3 sm:pr-5 sm:pl-5 " +
        (selected ? "bg-surface-hover " : "hover:bg-surface-hover ") +
        (topPick ? "shadow-[inset_2px_0_0_0_var(--color-deal)] " : "")
      }
    >
      {/* 未读圆点 + 纯数字评分 */}
      <div className="flex shrink-0 items-center gap-2 pt-0.5 sm:pt-0">
        <span
          className={
            "h-[7px] w-[7px] rounded-full " +
            (item.read ? "border border-ink-300 bg-transparent" : "bg-accent-solid")
          }
          title={item.read ? t("已读") : t("未读")}
        />
        <span
          className={
            "w-6 text-right font-mono text-[12px] font-semibold tabular-nums " +
            (item.score >= 70
              ? "text-deal"
              : item.score >= 45
                ? "text-ink-700"
                : "text-ink-400")
          }
          title={t("综合评分")}
        >
          {Math.round(item.score)}
        </span>
      </div>

      {/* 主信息 */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); onOpen(item); }}
            className={
              "row-title text-left [overflow-wrap:anywhere] text-[14px] leading-snug font-medium text-ink-950 transition-colors group-hover:text-accent " +
              (aiRejected ? "line-through decoration-ink-300 text-ink-500" : "")
            }
          >
            {item.title}
          </button>
          <span className="flex flex-wrap items-center gap-1 sm:contents">
            <KindBadge kind={item.kind} category={item.category} inline />
            <DossierBadge item={item} />
            {showPrice && <PriceBadge item={item} inline />}
            {showPrice && <ObtainBadge obtain={item.obtain} inline />}
          </span>
          {matched.length > 0 && (
            <span className="rounded bg-code-subtle px-1.5 py-0.5 text-[11px] font-medium text-code">
              {t("命中：")}{matched.join("/")}
            </span>
          )}
          {(item.dupCount ?? 1) > 1 && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onToggleRelated?.(item.id);
              }}
              title={t("同一福利被多个源报道，点击看全部来源")}
              className="rounded bg-brand-subtle px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-ink-200/70"
            >
              {expanded ? t("收起") : t("{n} 个来源", { n: item.dupCount ?? 1 })}
            </button>
          )}
          {item.blockedBy && (
            <span className="rounded bg-alert-subtle px-1.5 py-0.5 text-[11px] text-alert">
              {t("屏蔽：")}{item.blockedBy}
            </span>
          )}
        </div>

        <div className="row-meta mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-ink-500">
          <span className="max-w-[45%] truncate font-medium text-ink-700">{name}</span>
          {showCategory && (
            <>
              <MetaSep />
              <span className="max-w-[40%] truncate">{categoryLabel}</span>
            </>
          )}
          {exp && (
            <>
              <MetaSep />
              <span className={"shrink-0 " + (exp.urgent ? "font-medium text-code" : "text-ink-500")}>
                {exp.text}
              </span>
            </>
          )}
          <MetaSep className="sm:hidden" />
          <span className="shrink-0 tabular-nums text-ink-400 sm:hidden">
            <RelativeTime iso={item.published_at ?? item.first_seen_at} />
          </span>
        </div>
        {showSummary && item.ai?.reason && (() => {
          const { badge, text } = splitReasonBadge(item.ai.reason);
          return (
            <p title={item.ai.reason} className="row-summary mt-1 flex flex-wrap items-center gap-1.5 text-[12px] leading-relaxed text-ink-500">
              {badge && (
                <span className="inline-flex shrink-0 items-center rounded border border-code-border bg-code-subtle px-1.5 py-0.5 text-[11px] font-semibold text-code">
                  {badge}
                </span>
              )}
              {text && <span className="min-w-0 [overflow-wrap:anywhere] break-words">{text}</span>}
            </p>
          );
        })()}
      </div>

      {/* 右端：兑换码 & 快捷操作 & 相对时间 */}
      <div
        className="col-span-2 flex min-w-0 items-center gap-2 sm:col-span-1 sm:w-auto sm:shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          {codes.slice(0, 2).map((code) => (
            <CodeChip key={code} code={code} onCopy={onCopyCode} />
          ))}
        </div>
        <div className="row-actions ml-auto flex shrink-0 items-center gap-0.5 sm:ml-1">
          <span className="flex items-center gap-0.5 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:focus-within:opacity-100">
          <button
            type="button"
            onClick={() => onQuickBlock(item)}
            className="rounded-md p-2 text-ink-400 transition-colors hover:bg-alert-subtle hover:text-alert sm:p-1.5"
            title={t("加入屏蔽词 / 屏蔽")}
          >
            <Ban size={14} />
          </button>
          <button
            type="button"
            onClick={() => onPatch(item.id, { status: item.status === "ignored" ? "active" : "ignored" })}
            className="rounded-md p-2 text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-800 sm:p-1.5"
            title={item.status === "ignored" ? t("恢复到列表") : t("不想看，从列表移除（可在「已关闭」找回）")}
          >
            {item.status === "ignored" ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
          </span>
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer noopener"
            onClick={() => {
              if (!item.read) onPatch(item.id, { read: true });
            }}
            className="rounded-md p-2 text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-950 sm:p-1.5"
            title={t("新标签打开原帖")}
          >
            <ArrowUpRight size={15} />
          </a>
        </div>
        <span className="hidden w-[72px] shrink-0 whitespace-nowrap text-right font-mono text-[12px] tabular-nums text-ink-400 sm:inline-block">
          <RelativeTime iso={item.published_at ?? item.first_seen_at} />
        </span>
      </div>
    </div>
  );
}

function CoverImage({
  src,
  className = "",
  children,
}: {
  src: string | null | undefined;
  className?: string;
  children?: React.ReactNode;
}) {
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    setBroken(false);
  }, [src]);

  if (!src || broken) return null;
  return (
    <div className={"relative overflow-hidden bg-ink-100 " + className}>
      <img
        src={src}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
      />
      {children}
    </div>
  );
}

/** 网格卡片视图（支持 2列 / 3列与封面图，无图条目保持紧凑纯文字卡片） */
export function ItemCard({
  item,
  sourceName,
  onPatch,
  onOpen,
  onQuickBlock,
  onCopyCode,
  onToggleRelated,
  expanded,
  relatedItems,
}: {
  item: Item;
  sourceName: (id: string) => string;
  onPatch: (id: number, body: Record<string, unknown>) => void;
  onOpen: (item: Item) => void;
  onQuickBlock: (item: Item) => void;
  onCopyCode: (code: string) => void;
  onToggleRelated?: (id: number) => void;
  expanded?: boolean;
  relatedItems?: (Item & { sourceName?: string })[];
}) {
  const exp = expiresLabel(item.expires_at);
  const codes = Array.isArray(item.codes) ? item.codes : [];
  const matched = Array.isArray(item.matched) ? item.matched : [];
  const aiRejected = item.ai?.keep === false;
  const [imgBroken, setImgBroken] = useState(false);

  useEffect(() => {
    setImgBroken(false);
  }, [item.image_url]);
  const hasImage = Boolean(item.image_url && !imgBroken);

  return (
    <article
      onClick={() => onOpen(item)}
      className={
        "panel group flex h-full cursor-pointer flex-col overflow-hidden transition-all hover:border-ink-300 hover:shadow-sm " +
        (item.read ? "opacity-65 hover:opacity-100" : "")
      }
    >
      {hasImage && (
        <div className="relative aspect-[16/9] w-full overflow-hidden border-b border-ink-100 bg-ink-100">
          <img
            src={item.image_url!}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setImgBroken(true)}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
          <span
            className={
              "absolute top-2.5 right-2.5 rounded-md px-2 py-0.5 font-mono text-[12px] font-semibold tabular-nums backdrop-blur-sm " +
              (item.score >= 70 ? "bg-deal-solid text-on-solid" : "bg-overlay text-white")
            }
          >
            {Math.round(item.score)}
          </span>
        </div>
      )}

      <div className="flex flex-1 flex-col p-3.5 sm:p-4">
        <div className="mb-1.5 flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-ink-500">
            <span
              className={
                "h-[6px] w-[6px] shrink-0 rounded-full " +
                (item.read ? "border border-ink-300 bg-transparent" : "bg-accent-solid")
              }
              title={item.read ? t("已读") : t("未读")}
            />
            <span className="truncate font-medium text-ink-700">{sourceName(item.source_id)}</span>
            {item.category && (
              <>
                <span aria-hidden="true">·</span>
                <span>{t(categoryLabelForKind(item.category, item.kind))}</span>
              </>
            )}
            <KindBadge kind={item.kind} category={item.category} />
            <DossierBadge item={item} />
            {item.kind !== "news" && item.kind !== "info" && <PriceBadge item={item} />}
            {item.kind !== "news" && item.kind !== "info" && <ObtainBadge obtain={item.obtain} />}
          </div>
          {!hasImage && (
            <span
              className={
                "shrink-0 rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[12px] font-semibold tabular-nums " +
                (item.score >= 70 ? "text-deal" : "text-ink-600")
              }
            >
              {Math.round(item.score)}
            </span>
          )}
        </div>

        <h3
          className={
            "line-clamp-2 text-[14px] leading-snug font-semibold text-ink-950 transition-colors group-hover:text-accent " +
            (aiRejected ? "line-through decoration-ink-300 text-ink-500" : "")
          }
        >
          {item.title}
        </h3>

        {item.summary && (
          <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-ink-600">{item.summary}</p>
        )}

        {(matched.length > 0 || codes.length > 0 || item.ai?.reason || (item.dupCount ?? 1) > 1) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11px]" onClick={(e) => e.stopPropagation()}>
            {matched.length > 0 && (
              <span className="rounded bg-code-subtle px-1.5 py-0.5 font-medium text-code">
                {t("命中：")}{matched.join("/")}
              </span>
            )}
            {codes.slice(0, 2).map((code) => (
              <CodeChip key={code} code={code} onCopy={onCopyCode} />
            ))}
            {(item.dupCount ?? 1) > 1 && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggleRelated?.(item.id);
                }}
                title={t("同一福利被多个源报道，点击看全部来源")}
                className="rounded bg-brand-subtle px-1.5 py-0.5 font-medium text-accent hover:bg-ink-200/70"
              >
                {expanded ? t("收起") : t("{n} 个来源", { n: item.dupCount ?? 1 })}
              </button>
            )}
            {item.ai?.reason && (() => {
              const { badge, text } = splitReasonBadge(item.ai.reason);
              return (
                <span className={"inline-flex min-w-0 flex-wrap items-center gap-1.5 " + (item.ai.keep === false ? "text-ink-400" : "text-deal")}>
                  {badge && (
                    <span className="inline-flex shrink-0 items-center rounded border border-code-border bg-code-subtle px-1.5 py-0.5 text-[10px] font-semibold text-code">
                      {badge}
                    </span>
                  )}
                  {text && <span className="line-clamp-1">{text}</span>}
                </span>
              );
            })()}
          </div>
        )}

        <div
          className="mt-auto flex items-center justify-between gap-2 border-t border-ink-100 pt-2.5 text-[12px] text-ink-400"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="tabular-nums"><RelativeTime iso={item.published_at ?? item.first_seen_at} /></span>
            {exp && (
              <span className={"inline-flex items-center gap-1 truncate " + (exp.urgent ? "font-medium text-code" : "")}>
                <Clock3 size={11} /> {exp.text}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer noopener"
              onClick={() => {
                if (!item.read) onPatch(item.id, { read: true });
              }}
              className="rounded-md p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-950"
              title={t("打开原文")}
            >
              <ArrowUpRight size={14} />
            </a>
            <button
              type="button"
              onClick={() => onPatch(item.id, { starred: !item.starred })}
              className={
                "rounded-md p-1.5 hover:bg-ink-100 " +
                (item.starred ? "text-code" : "text-ink-400 hover:text-ink-800")
              }
              title={item.starred ? t("取消收藏") : t("收藏")}
            >
              <Star size={14} fill={item.starred ? "currentColor" : "none"} />
            </button>
            <button
              type="button"
              onClick={() => onQuickBlock(item)}
              className="rounded-md p-1.5 text-ink-400 hover:bg-alert-subtle hover:text-alert"
              title={t("屏蔽")}
            >
              <Ban size={14} />
            </button>
            <button
              type="button"
              onClick={() => onPatch(item.id, { status: item.status === "ignored" ? "active" : "ignored" })}
              className="rounded-md p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-800"
              title={item.status === "ignored" ? t("恢复到列表") : t("不想看，从列表移除（可在「已关闭」找回）")}
            >
              <EyeOff size={14} />
            </button>
          </div>
        </div>

        {expanded && relatedItems && relatedItems.length > 0 && (
          <div
            className="pop-enter mt-2.5 rounded-lg border border-ink-100 bg-surface-hover p-2.5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 text-[11px] font-medium text-ink-500">
              {t("其他 {n} 条来源报道", { n: relatedItems.length })}
            </div>
            <ul className="space-y-1">
              {relatedItems.map((r) => (
                <li key={r.id} className="flex items-center gap-2 text-[12px]">
                  <span className="w-20 shrink-0 truncate text-ink-500">{r.sourceName ?? r.source_id}</span>
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate text-ink-700 hover:text-accent hover:underline"
                  >
                    {r.title}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </article>
  );
}

/** 右侧滑出详情抽屉（按 Esc 关闭，↑/↓ 可在列表上下切换） */
export function ItemDetailDrawer({
  item,
  sourceName,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
  onPatch,
  onQuickBlock,
  onCopyCode,
  loading = false,
  error = null,
  onRetry,
  onClassificationSave,
  canAdmin = false,
  onDossierUpdated,
  onContentUpdated,
  onNotify,
}: {
  item: Item;
  sourceName: (id: string) => string;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onPatch: (id: number, body: Record<string, unknown>) => void;
  onQuickBlock: (item: Item) => void;
  onCopyCode: (code: string) => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onClassificationSave?: (id: number, patch: ClassificationPatch) => Promise<void>;
  canAdmin?: boolean;
  onDossierUpdated?: (itemId: number, dossier: ItemDossier) => void;
  onContentUpdated?: (itemId: number, content: string) => void;
  onNotify?: (message: string) => void;
}) {
  const exp = expiresLabel(item.expires_at);
  const codes = Array.isArray(item.codes) ? item.codes : [];
  const dialogRef = useRef<HTMLElement | null>(null);
  const [snapshotOpen, setSnapshotOpen] = useState(true);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [syncingComments, setSyncingComments] = useState(false);

  const canSyncScysComments =
    canAdmin &&
    (/^scys-topic-/.test(item.external_id || "") ||
      (item.source_id.startsWith("scys-") && item.source_id !== "scys-projects" && item.source_id !== "scys-manuals"));

  useEffect(() => {
    setSnapshotOpen(true);
    setSummaryOpen(false);
    setSyncingComments(false);
  }, [item.id]);

  const handleSyncComments = async () => {
    if (syncingComments) return;
    setSyncingComments(true);
    try {
      const res = await fetch(`/api/items/${item.id}/sync-comments`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        totalComments?: number;
        keptComments?: number;
        content?: string;
      };
      if (!res.ok || data.ok === false) {
        onNotify?.(data.error ?? t("同步评论失败，请稍后重试"));
        return;
      }
      if (typeof data.content === "string" && data.content) {
        onContentUpdated?.(item.id, data.content);
        setSnapshotOpen(true);
      }
      const kept = data.keptComments ?? 0;
      const total = data.totalComments ?? 0;
      onNotify?.(
        kept > 0
          ? t("已同步 {kept} 条精选评论（原帖共 {total} 条）", { kept, total })
          : t("同步完成，原帖暂无有效评论"),
      );
    } catch {
      onNotify?.(t("同步评论失败，请稍后重试"));
    } finally {
      setSyncingComments(false);
    }
  };

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => { document.body.style.overflow = overflow; previous?.focus(); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key === "Tab" && dialogRef.current) {
        const controls = Array.from(dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input, select, textarea, [tabindex='0']"));
        const first = controls[0], last = controls[controls.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowUp" && hasPrev) {
        e.preventDefault();
        onPrev();
      }
      if (e.key === "ArrowDown" && hasNext) {
        e.preventDefault();
        onNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, hasPrev, hasNext, onPrev, onNext]);

  return (
    <div className="backdrop-enter fixed inset-0 z-50 flex justify-end bg-overlay backdrop-blur-[1px]" onClick={onClose}>
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("资源详情")}
        tabIndex={-1}
        className="drawer-enter drawer-shadow outline-none flex h-full w-full flex-col border-ink-200 bg-surface sm:max-w-2xl sm:border-l"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶栏 */}
        <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3 sm:px-5 sm:py-3.5">
          <div className="flex items-center gap-1.5">
            <div className="flex items-center rounded-lg border border-ink-200 bg-surface">
              <button
                type="button"
                disabled={!hasPrev}
                onClick={onPrev}
                className="-mr-px rounded-l-lg p-1.5 text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900 disabled:text-ink-300 disabled:hover:bg-transparent"
                title={t("上一条 (↑)")}
                aria-label={t("上一条")}
              >
                <ChevronUp size={16} />
              </button>
              <button
                type="button"
                disabled={!hasNext}
                onClick={onNext}
                className="rounded-r-lg border-l border-ink-200 p-1.5 text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900 disabled:text-ink-300 disabled:hover:bg-transparent"
                title={t("下一条 (↓)")}
                aria-label={t("下一条")}
              >
                <ChevronDown size={16} />
              </button>
            </div>
            <span className="ml-2 text-[12px] text-ink-500">{sourceName(item.source_id)}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100 hover:text-ink-900"
            title={t("关闭 (Esc)")}
          >
            <X size={16} />
          </button>
        </div>

        {/* 内容区 */}
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5 sm:py-5">
          {loading && <p role="status" className="text-[12px] text-ink-500">{t("正在加载完整正文…")}</p>}
          {error && <div role="alert" className="rounded-lg border border-alert-border bg-alert-subtle p-3 text-[12px] text-alert">{error} <button type="button" onClick={onRetry} className="ml-2 underline">{t("重试")}</button></div>}
          <CoverImage src={item.image_url} className="aspect-[16/9] w-full rounded-lg border border-ink-100" />
          <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
            <KindBadge kind={item.kind} category={item.category} />
            {item.category && (
              <span className="rounded bg-brand-subtle px-2 py-0.5 font-medium text-accent">
                {t(categoryLabelForKind(item.category, item.kind))}
              </span>
            )}
            {item.kind !== "news" && item.kind !== "info" && <PriceBadge item={item} />}
            {item.kind !== "news" && item.kind !== "info" && <ObtainBadge obtain={item.obtain} />}
            <span className="rounded bg-ink-100 px-2 py-0.5 font-mono text-ink-700">
              {t("评分")} {Math.round(item.score)}
            </span>
            {exp && (
              <span className={"inline-flex items-center gap-1 " + (exp.urgent ? "font-medium text-code" : "text-ink-500")}>
                <Clock3 size={11} /> {exp.text}
              </span>
            )}
          </div>

          <h2 className="text-[17px] leading-snug font-semibold text-ink-950">{item.title}</h2>
          {onClassificationSave && item.manualClassification !== undefined && !loading && !error && <ItemClassificationEditor key={item.id} item={item} onSave={onClassificationSave} />}

          {item.ai?.reason && (() => {
            const { badge, text } = splitReasonBadge(item.ai.reason);
            return (
              <div
                className={
                  "flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-[12px] " +
                  (item.ai.keep === false
                    ? "border-ink-200 bg-ink-100/70 text-ink-600"
                    : "border-deal-border bg-deal-subtle/70 text-deal")
                }
              >
                <Sparkles size={14} className={"mt-0.5 shrink-0 " + (item.ai.keep === false ? "text-ink-500" : "text-deal")} />
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere] break-words">
                  <strong>{item.manualClassification ? t("原 AI 说明：") : t("AI 判定：")}</strong>
                  {!item.manualClassification && (item.ai.keep === false
                    ? t("低价值/水帖 · ")
                    : item.kind === "news"
                      ? t("重要新闻 · ")
                      : item.kind === "info"
                        ? t("实战干货 · ")
                        : item.kind === "opensource"
                          ? t("开源项目 · ")
                          : item.kind === "deal"
                            ? t("特价好价 · ")
                            : t("可领取福利 · "))}
                  {badge && (
                    <span className="mx-1 inline-flex items-center rounded border border-code-border bg-code-subtle px-1.5 py-0.5 text-[11px] font-semibold text-code">
                      {badge}
                    </span>
                  )}
                  {text}
                </span>
              </div>
            );
          })()}

          {!loading && !error && (
            <DossierCard
              itemId={item.id}
              dossier={item.dossier}
              canAdmin={canAdmin}
              onDossierUpdated={onDossierUpdated}
              onNotify={onNotify}
            />
          )}

          {codes.length > 0 && (
            <div className="rounded-lg border border-code-border bg-code-subtle/70 p-3.5">
              <div className="mb-2 text-[12px] font-medium text-code">{t("提取到的兑换码（点击复制）")}</div>
              <div className="flex flex-wrap gap-2">
                {codes.map((code) => (
                  <CodeChip key={code} code={code} onCopy={onCopyCode} />
                ))}
              </div>
            </div>
          )}

          {item.summary && (() => {
            const hasFullSnapshot = Boolean(item.content && item.content !== item.summary);
            const covered = hasFullSnapshot && isSummaryCoveredByContent(item.summary, item.content);
            if (covered) {
              return (
                <div className="rounded-lg border border-ink-200/80 bg-surface-hover/60 px-3 py-2 text-[12px]">
                  <button
                    type="button"
                    onClick={() => setSummaryOpen((v) => !v)}
                    className="flex w-full items-center justify-between gap-2 text-left font-medium text-ink-500 hover:text-ink-800"
                  >
                    <span>{t("摘要（已收录于下方完整正文）")}</span>
                    {summaryOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </button>
                  {summaryOpen && (
                    <p className="mt-2 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-600 [overflow-wrap:anywhere]">
                      {item.summary}
                    </p>
                  )}
                </div>
              );
            }
            return (
              <div>
                <div className="mb-1 text-[12px] font-medium text-ink-500">{t("摘要")}</div>
                <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-ink-700 [overflow-wrap:anywhere]">
                  {item.summary}
                </p>
              </div>
            );
          })()}

          {item.content && item.content !== item.summary ? (
            <div className="min-w-0 rounded-xl border border-ink-200 bg-surface-hover p-4 sm:p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-ink-200/80 pb-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12px] font-semibold text-ink-800">{t("正文快照（原帖被删也能留档）")}</span>
                  <span className="rounded-md border border-ink-200 bg-surface px-2 py-0.5 font-mono text-[11px] text-ink-600">
                    {t("{n} 字", { n: plainCharCount(item.content) })}
                  </span>
                </div>
                <div className="flex items-center gap-2.5">
                  {canSyncScysComments && (
                    <button
                      type="button"
                      disabled={syncingComments}
                      onClick={() => void handleSyncComments()}
                      title={t("从生财 MCP 实时拉取楼主补充与高赞评论")}
                      className="inline-flex items-center gap-1 rounded-md border border-ink-200 bg-surface px-2 py-1 text-[11.5px] font-medium text-ink-700 transition-colors hover:bg-ink-100 hover:text-ink-950 disabled:opacity-50"
                    >
                      <RefreshCw size={11} className={syncingComments ? "animate-spin" : ""} />
                      {syncingComments ? t("同步中…") : t("同步最新评论")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setSnapshotOpen((v) => !v)}
                    className="inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline"
                  >
                    {snapshotOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    {snapshotOpen ? t("收起") : t("展开")}
                  </button>
                </div>
              </div>
              {snapshotOpen && <SnapshotContent content={item.content} />}
            </div>
          ) : canSyncScysComments && !loading ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-ink-200 bg-surface-hover px-3.5 py-2.5 text-[12px]">
              <span className="text-ink-600">{t("从生财 MCP 实时拉取楼主补充与高赞评论")}</span>
              <button
                type="button"
                disabled={syncingComments}
                onClick={() => void handleSyncComments()}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-ink-200 bg-surface px-2.5 py-1 text-[12px] font-medium text-ink-800 hover:bg-ink-100 disabled:opacity-50"
              >
                <RefreshCw size={12} className={syncingComments ? "animate-spin" : ""} />
                {syncingComments ? t("同步中…") : t("同步最新评论")}
              </button>
            </div>
          ) : null}

          <dl className="grid grid-cols-2 gap-3 rounded-lg border border-ink-200 bg-surface-hover p-3.5 text-[12px]">
            <div>
              <dt className="text-ink-500">{t("发布时间")}</dt>
              <dd className="mt-0.5 font-mono text-ink-900">
                {item.published_at ? item.published_at.replace("T", " ").slice(0, 19) : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-ink-500">{t("截止时间")}</dt>
              <dd className="mt-0.5 font-mono text-ink-900">
                {item.expires_at ? item.expires_at.replace("T", " ").slice(0, 19) : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-ink-500">{t("收录时间")}</dt>
              <dd className="mt-0.5 font-mono text-ink-900">{item.first_seen_at.replace("T", " ").slice(0, 19)}</dd>
            </div>
            <div>
              <dt className="text-ink-500">{t("来源 ID")}</dt>
              <dd className="mt-0.5 truncate font-mono text-ink-700">{item.source_id}</dd>
            </div>
          </dl>

          {item.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {item.tags.map((tag) => (
                <span key={tag} className="rounded-md bg-ink-100 px-2 py-0.5 font-mono text-[11px] text-ink-600">
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* 底部动作栏 */}
        <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 bg-surface-hover px-4 py-3 sm:px-5 sm:py-3.5">
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer noopener"
            onClick={() => {
              if (!item.read) onPatch(item.id, { read: true });
            }}
            className="inline-flex min-w-full flex-1 items-center justify-center gap-1.5 rounded-lg bg-solid px-4 py-2.5 text-[13px] font-medium text-on-solid transition-colors hover:bg-solid-hover sm:min-w-0 sm:py-2"
          >
            {item.kind === "news" || item.kind === "info" ? t("查看原文详情") : t("打开原帖领取")} <ArrowUpRight size={14} />
          </a>
          <button
            type="button"
            onClick={() => onPatch(item.id, { starred: !item.starred })}
            className={
              "inline-flex grow basis-[calc(50%-0.25rem)] items-center justify-center gap-1 rounded-lg border px-3 py-2.5 text-[13px] transition-colors sm:grow-0 sm:basis-auto sm:py-2 " +
              (item.starred
                ? "border-code-border bg-code-subtle text-code"
                : "border-ink-200 bg-surface text-ink-700 hover:bg-ink-100")
            }
          >
            <Star size={14} fill={item.starred ? "currentColor" : "none"} /> {item.starred ? t("已收藏") : t("收藏")}
          </button>
          <button
            type="button"
            onClick={() => onPatch(item.id, { read: !item.read })}
            className="inline-flex grow basis-[calc(50%-0.25rem)] items-center justify-center gap-1 rounded-lg border border-ink-200 bg-surface px-3 py-2.5 text-[13px] text-ink-700 hover:bg-ink-100 sm:grow-0 sm:basis-auto sm:py-2"
          >
            <Eye size={14} /> {item.read ? t("标未读") : t("标已读")}
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              onQuickBlock(item);
            }}
            className="inline-flex grow basis-[calc(50%-0.25rem)] items-center justify-center gap-1 rounded-lg border border-alert-border bg-alert-subtle px-3 py-2.5 text-[13px] text-alert hover:bg-alert-subtle/80 sm:grow-0 sm:basis-auto sm:py-2"
          >
            <ShieldAlert size={14} /> {t("屏蔽")}
          </button>
          <button
            type="button"
            onClick={() => {
              onPatch(item.id, { status: "ignored" });
              onClose();
            }}
            className="inline-flex grow basis-[calc(50%-0.25rem)] items-center justify-center gap-1 rounded-lg border border-ink-200 bg-surface px-3 py-2.5 text-[13px] text-ink-700 hover:bg-ink-100 sm:grow-0 sm:basis-auto sm:py-2"
            title={t("单纯不想看，不进屏蔽词")}
          >
            <EyeOff size={14} /> {t("关闭")}
          </button>
        </div>
      </aside>
    </div>
  );
}

/** 快捷屏蔽弹窗 */
export function QuickBlockModal({
  item,
  sourceName,
  onClose,
  onIgnoreOne,
  onAddRule,
}: {
  item: Item;
  sourceName: (id: string) => string;
  onClose: () => void;
  onIgnoreOne: (id: number) => void;
  onAddRule: (pattern: string, scope: string) => Promise<void>;
}) {
  const candidates = extractBlockCandidates(item.title);
  const [pattern, setPattern] = useState(candidates[0] ?? "");
  const [scope, setScope] = useState("all");
  const [busy, setBusy] = useState(false);

  return (
    <div
      className="backdrop-enter fixed inset-0 z-50 flex items-end justify-center bg-overlay backdrop-blur-[1px] sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="sheet-enter sm:pop-enter panel max-h-[90vh] w-full max-w-md overflow-y-auto rounded-b-none rounded-t-xl p-4 sm:rounded-xl sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-ink-950">
            <ShieldAlert size={16} className="text-alert" /> {t("屏蔽处理")}
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-ink-500 hover:bg-ink-100">
            <X size={15} />
          </button>
        </div>

        <p className="mb-3 line-clamp-2 rounded-lg border border-ink-200 bg-surface-hover p-2.5 text-[13px] text-ink-700">
          {item.title}
        </p>

        <div className="space-y-3">
          <div>
            <div className="mb-1.5 text-[12px] text-ink-500">{t("点选标题关键词快速加入屏蔽：")}</div>
            <div className="flex flex-wrap gap-1.5">
              {candidates.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setPattern(c)}
                  className={
                    "rounded-lg border px-2 py-1 text-[12px] transition-colors " +
                    (pattern === c
                      ? "border-alert-border bg-alert-subtle font-medium text-alert"
                      : "border-ink-200 bg-surface text-ink-700 hover:bg-ink-100")
                  }
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[12px] text-ink-500">
              {t("屏蔽关键词（命中该词的新老条目都会隐藏，且不推 Telegram）")}
            </label>
            <input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder={t("输入要屏蔽的关键词…")}
              className="w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-[13px] text-ink-950 outline-none focus:border-brand"
            />
          </div>

          <div className="flex flex-col gap-2 text-[12px] sm:flex-row">
            {[
              { key: "all", label: t("全部来源屏蔽") },
              { key: item.source_id, label: t("仅对「{name}」生效", { name: sourceName(item.source_id) }) },
            ].map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => setScope(o.key)}
                className={
                  "flex-1 truncate rounded-lg border px-2.5 py-2.5 text-left transition-colors sm:py-2 " +
                  (scope === o.key
                    ? "border-alert-border bg-alert-subtle font-medium text-alert"
                    : "border-ink-200 text-ink-600 hover:bg-ink-100")
                }
              >
                {o.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 pb-[env(safe-area-inset-bottom)]">
            <button
              type="button"
              onClick={() => {
                onIgnoreOne(item.id);
                onClose();
              }}
              className="rounded-lg border border-ink-200 px-3 py-2 text-[12px] text-ink-600 hover:bg-ink-100"
            >
              {t("仅隐藏这一条")}
            </button>
            <button
              type="button"
              disabled={!pattern.trim() || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onAddRule(pattern.trim(), scope);
                  onClose();
                } finally {
                  setBusy(false);
                }
              }}
              className="rounded-lg bg-alert-solid px-4 py-2 text-[12px] font-medium text-on-solid transition-colors hover:bg-alert-solid disabled:opacity-40"
            >
              {t("加入屏蔽规则")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
