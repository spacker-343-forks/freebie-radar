import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, ChevronUp, Copy, ExternalLink, GitMerge, Sparkles, X } from "lucide-react";
import type { UpstreamWatchState } from "../../../shared/upstream-watch.ts";
import { t } from "../lib/i18n.ts";

const LOCAL_DISMISS_KEY = "radar_dismissed_upstream_sha";
export const UPSTREAM_WATCH_UPDATED_EVENT = "radar:upstream-watch-updated";

function readLocalDismissedSha(): string | null {
  try {
    return localStorage.getItem(LOCAL_DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeLocalDismissedSha(sha: string): void {
  try {
    localStorage.setItem(LOCAL_DISMISS_KEY, sha);
  } catch {
    /* ignore storage quota/privacy restrictions */
  }
}

function safeGitHubUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

export function UpstreamWatchBanner({
  adminReady,
  onNotify,
}: {
  adminReady: boolean;
  onNotify?: (msg: string) => void;
}) {
  const [state, setState] = useState<UpstreamWatchState | null>(null);
  const [localDismissedSha, setLocalDismissedSha] = useState<string | null>(() => readLocalDismissedSha());
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/upstream-watch");
      if (!res.ok) return;
      const data = (await res.json()) as Partial<UpstreamWatchState>;
      if (data && typeof data.activeBanner === "boolean") {
        setState(data as UpstreamWatchState);
      }
    } catch {
      /* ignore transient fetch failure */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, adminReady]);

  useEffect(() => {
    const onUpdated = () => {
      setLocalDismissedSha(readLocalDismissedSha());
      void load();
    };
    window.addEventListener(UPSTREAM_WATCH_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(UPSTREAM_WATCH_UPDATED_EVENT, onUpdated);
  }, [load]);

  if (!state || !state.activeBanner || !state.latestSha || state.latestSha === localDismissedSha) {
    return null;
  }

  const compareHref = safeGitHubUrl(state.compareUrl);

  const handleDismiss = async () => {
    const sha = state.latestSha;
    if (!sha) return;
    writeLocalDismissedSha(sha);
    setLocalDismissedSha(sha);
    if (adminReady) {
      try {
        const res = await fetch("/api/upstream-watch/dismiss", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sha }),
        });
        if (res.ok) {
          const next = (await res.json()) as UpstreamWatchState;
          setState(next);
          window.dispatchEvent(new Event(UPSTREAM_WATCH_UPDATED_EVENT));
        }
      } catch {
        /* local dismissal already hid banner */
      }
    }
  };

  const handleCopyMerge = () => {
    void navigator.clipboard?.writeText(state.mergeCommand).catch(() => undefined);
    setCopied(true);
    onNotify?.(t("已复制合入命令"));
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <section
      aria-label={t("上游重大更新")}
      className="min-w-0 border-b border-brand-border bg-brand-subtle/50 px-3.5 py-2.5 sm:px-6"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <GitMerge size={14} className="shrink-0 text-accent" />
          <span className="inline-flex shrink-0 items-center gap-1 rounded border border-brand-border bg-surface px-1.5 py-0.5 text-[11px] font-semibold text-accent">
            <Sparkles size={11} />
            {t("上游重大更新")}
          </span>
          {state.latestTag && (
            <span className="shrink-0 rounded border border-deal-border bg-deal-subtle px-1.5 py-0.5 font-mono text-[11px] font-medium text-deal">
              {state.latestTag}
            </span>
          )}
          <span className="shrink-0 font-mono text-[11px] text-ink-600">
            {t("领先 {n} 个提交", { n: state.aheadCount })}
          </span>
          <span className="min-w-0 flex-1 text-[13px] font-medium text-ink-950 [overflow-wrap:anywhere] break-words">
            {state.headline}
          </span>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md border border-brand-border/80 bg-surface px-2.5 py-1 text-[12px] font-medium text-accent transition-colors hover:bg-brand-subtle"
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {expanded ? t("收起") : t("查看详情")}
          </button>
          <button
            type="button"
            onClick={() => void handleDismiss()}
            className="inline-flex items-center gap-1 rounded-md border border-ink-200 bg-surface px-2.5 py-1 text-[12px] font-medium text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-950"
          >
            <X size={12} />
            {t("已知晓（本版不再提醒）")}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-2.5 min-w-0 space-y-2.5 rounded-lg border border-brand-border/70 bg-surface/90 p-3 text-[12.5px]">
          {state.highlights.length > 0 && (
            <ul className="space-y-1 text-ink-800">
              {state.highlights.map((item, idx) => (
                <li key={idx} className="flex min-w-0 items-start gap-2">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent/70" aria-hidden="true" />
                  <span className="min-w-0 flex-1 leading-relaxed [overflow-wrap:anywhere] break-words">{item}</span>
                </li>
              ))}
            </ul>
          )}

          {state.commits.length > 0 && (
            <div className="space-y-1 border-t border-ink-100 pt-2">
              {state.commits.slice(0, 6).map((c) => {
                const href = safeGitHubUrl(c.url);
                const firstLine = c.message.split(/\r?\n/)[0] ?? c.message;
                return (
                  <div key={c.sha} className="flex min-w-0 items-start gap-2 text-[12px] text-ink-700">
                    <span className="mt-0.5 shrink-0 rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[11px] text-ink-700">
                      {c.short}
                    </span>
                    {href ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-w-0 flex-1 text-ink-800 hover:text-accent hover:underline [overflow-wrap:anywhere] break-words"
                      >
                        {firstLine}
                      </a>
                    ) : (
                      <span className="min-w-0 flex-1 [overflow-wrap:anywhere] break-words">{firstLine}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 pt-2">
            <code className="max-w-full rounded border border-ink-200 bg-canvas px-2 py-1 font-mono text-[11.5px] text-ink-800 [overflow-wrap:anywhere]">
              {state.mergeCommand}
            </code>
            <button
              type="button"
              onClick={handleCopyMerge}
              className="inline-flex items-center gap-1 rounded-md bg-solid px-2.5 py-1 text-[12px] font-medium text-on-solid transition-colors hover:bg-solid-hover"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? t("已复制合入命令") : t("复制合入命令")}
            </button>
            {compareHref && (
              <a
                href={compareHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex max-w-full items-center gap-1 rounded-md border border-ink-200 bg-surface px-2.5 py-1 text-[12px] font-medium text-ink-700 transition-colors hover:bg-ink-100"
              >
                <span className="truncate">{t("查看 GitHub 变更对比")}</span>
                <ExternalLink size={12} className="shrink-0" />
              </a>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
