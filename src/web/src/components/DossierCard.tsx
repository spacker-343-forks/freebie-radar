import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Loader2,
  RefreshCw,
  Sparkles,
  Zap,
} from "lucide-react";
import type { ItemDossier } from "../../../shared/dossier.ts";
import { t } from "../lib/i18n.ts";

export function DossierCard({
  itemId,
  dossier,
  canAdmin = false,
  onDossierUpdated,
  onNotify,
}: {
  itemId: number;
  dossier: ItemDossier | null | undefined;
  canAdmin?: boolean;
  onDossierUpdated?: (itemId: number, dossier: ItemDossier) => void;
  onNotify?: (message: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOpen(true);
    setError(null);
  }, [itemId]);

  const generateDossier = async () => {
    if (generating) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/items/${itemId}/dossier`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        dossier?: ItemDossier | null;
        error?: string;
      };
      if (!res.ok || !data.dossier) {
        const msg = data.error ?? t("立项书生成失败，请稍后重试");
        setError(msg);
        onNotify?.(msg);
        return;
      }
      onDossierUpdated?.(itemId, data.dossier);
      setOpen(true);
      onNotify?.(t("AI 实战立项拆解书已生成"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("立项书生成失败，请稍后重试");
      setError(msg);
      onNotify?.(msg);
    } finally {
      setGenerating(false);
    }
  };

  if (!dossier) {
    if (!canAdmin) return null;
    return (
      <div className="min-w-0 rounded-xl border border-brand-border bg-brand-subtle/40 px-3.5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex min-w-0 items-center gap-2 text-[12px] text-ink-700">
            <Zap size={14} className="shrink-0 text-accent" />
            <span className="min-w-0 [overflow-wrap:anywhere] break-words">
              {t("尚未生成本帖的 AI 实战立项拆解书")}
            </span>
          </div>
          <button
            type="button"
            disabled={generating}
            onClick={() => void generateDossier()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-accent-solid px-3 py-1.5 text-[12px] font-medium text-on-solid transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {generating ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
            {generating ? t("正在拆解…") : t("⚡ 用顶配模型生成实战立项书")}
          </button>
        </div>
        {error && (
          <p role="alert" className="mt-2 [overflow-wrap:anywhere] break-words text-[12px] text-alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <section
      aria-label={t("⚡ AI 实战立项拆解书")}
      className="min-w-0 overflow-hidden rounded-xl border border-brand-border bg-surface"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-brand-border/70 bg-brand-subtle/50 px-3.5 py-2.5 sm:px-4">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-ink-950">
            <Zap size={14} className="shrink-0 text-accent" />
            {t("⚡ AI 实战立项拆解书")}
          </span>
          <span className="inline-flex max-w-full items-center rounded border border-code-border bg-code-subtle px-2 py-0.5 text-[11px] font-medium text-code [overflow-wrap:anywhere] break-words">
            {t("启动成本")}：{dossier.startupCost}
          </span>
          <span className="inline-flex max-w-full items-center rounded border border-brand-border bg-surface px-2 py-0.5 text-[11px] font-medium text-accent [overflow-wrap:anywhere] break-words">
            {t("首单周期")}：{dossier.timeToFirstDollar}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {canAdmin && (
            <button
              type="button"
              disabled={generating}
              onClick={() => void generateDossier()}
              className="inline-flex items-center gap-1 rounded-md border border-brand-border bg-surface px-2 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-brand-subtle disabled:opacity-50"
            >
              {generating ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
              {generating ? t("正在拆解…") : t("重新拆解")}
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-ink-600 transition-colors hover:bg-surface hover:text-ink-950"
          >
            {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            {open ? t("收起") : t("展开")}
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="border-b border-alert-border bg-alert-subtle px-4 py-2 text-[12px] text-alert [overflow-wrap:anywhere] break-words">
          {error}
        </div>
      )}

      {open && (
        <div className="space-y-3.5 p-3.5 text-[13px] sm:p-4">
          <div className="min-w-0">
            <div className="mb-1 text-[11px] font-semibold tracking-wide text-ink-500">
              {t("一句话立项锐评")}
            </div>
            <p className="leading-relaxed font-medium text-ink-950 [overflow-wrap:anywhere] break-words">
              {dossier.verdict}
            </p>
          </div>

          <div className="min-w-0">
            <div className="mb-1 text-[11px] font-semibold tracking-wide text-ink-500">
              {t("赚钱算账公式")}
            </div>
            <div className="rounded-lg border border-code-border bg-code-subtle/60 px-3 py-2 font-mono text-[12px] leading-relaxed text-ink-900 [overflow-wrap:anywhere] break-words">
              {dossier.formula}
            </div>
          </div>

          <div className="min-w-0">
            <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-ink-500">
              {t("去水分执行 SOP")}
            </div>
            <ol className="space-y-1.5">
              {dossier.sop.map((step, idx) => (
                <li key={idx} className="flex min-w-0 items-start gap-2 text-[13px] leading-relaxed text-ink-800">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-subtle font-mono text-[11px] font-semibold text-accent">
                    {idx + 1}
                  </span>
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere] break-words">{step}</span>
                </li>
              ))}
            </ol>
          </div>

          <div className="min-w-0 rounded-lg border border-alert-border bg-alert-subtle/60 p-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-alert">
              <AlertTriangle size={13} className="shrink-0" />
              {t("核心死穴与隐性坑")}
            </div>
            <ul className="space-y-1">
              {dossier.pitfalls.map((pitfall, idx) => (
                <li key={idx} className="flex min-w-0 items-start gap-2 text-[12px] leading-relaxed text-ink-800">
                  <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-alert" />
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere] break-words">{pitfall}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="min-w-0 rounded-lg border border-deal-border bg-deal-subtle/70 p-3">
            <div className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-deal">
              <Sparkles size={13} className="shrink-0" />
              {t("单人 + AI 最小验证改法")}
            </div>
            <p className="text-[12px] leading-relaxed text-ink-900 [overflow-wrap:anywhere] break-words">
              {dossier.soloMvp}
            </p>
          </div>

          {(dossier.model || dossier.generatedAt) && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-100 pt-2 font-mono text-[11px] text-ink-400">
              <span>{dossier.model ? `${t("模型")} ${dossier.model}` : ""}</span>
              <span>{dossier.generatedAt ? dossier.generatedAt.replace("T", " ").slice(0, 16) : ""}</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
