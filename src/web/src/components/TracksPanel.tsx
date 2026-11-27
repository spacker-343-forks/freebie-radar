import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Compass,
  Layers,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import type { TrackSummary, TrackWhitepaper } from "../../../shared/tracks.ts";
import type { Item } from "../types.ts";
import { t } from "../lib/i18n.ts";
import { CompactRow } from "./ItemView.tsx";

type TracksIndexPayload = {
  tracks: TrackSummary[];
  synthesizing?: boolean;
};

type TrackDetailPayload = {
  track: TrackWhitepaper;
  items: Item[];
};

export function TracksPanel({
  canAdmin,
  sourceName,
  onPatch,
  onOpen,
  onQuickBlock,
  onCopyCode,
  onNotify,
}: {
  canAdmin: boolean;
  sourceName: (id: string) => string;
  onPatch: (id: number, body: Record<string, unknown>) => void;
  onOpen: (item: Item) => void;
  onQuickBlock: (item: Item) => void;
  onCopyCode: (code: string) => void;
  onNotify: (message: string) => void;
}) {
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [synthesizing, setSynthesizing] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [mobileShowDetail, setMobileShowDetail] = useState(false);
  const [detail, setDetail] = useState<TrackDetailPayload | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);

  const loadTracks = useCallback(async (silent = false) => {
    if (!silent) setListLoading(true);
    setListError(null);
    try {
      const res = await fetch("/api/tracks", { cache: "no-cache" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = (await res.json()) as TracksIndexPayload;
      const list = Array.isArray(data.tracks) ? data.tracks : [];
      setTracks(list);
      setSynthesizing(Boolean(data.synthesizing));
      setSelectedSlug((cur) => {
        if (cur && list.some((tr) => tr.slug === cur)) return cur;
        return list[0]?.slug ?? null;
      });
    } catch (err) {
      if (!silent) setListError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent) setListLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (slug: string, silent = false) => {
    if (!silent) setDetailLoading(true);
    setDetailError(null);
    try {
      const res = await fetch(`/api/tracks/${encodeURIComponent(slug)}`, { cache: "no-cache" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = (await res.json()) as TrackDetailPayload;
      setDetail(data);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err));
      setDetail(null);
    } finally {
      if (!silent) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTracks();
  }, [loadTracks]);

  useEffect(() => {
    if (!selectedSlug) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedSlug);
  }, [selectedSlug, loadDetail]);

  useEffect(() => {
    if (!synthesizing) return;
    const timer = window.setInterval(() => {
      void loadTracks(true);
      if (selectedSlug) void loadDetail(selectedSlug, true);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [synthesizing, selectedSlug, loadTracks, loadDetail]);

  const handleSynthesize = async () => {
    if (triggering) return;
    setTriggering(true);
    try {
      const res = await fetch("/api/tracks/synthesize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; running?: boolean };
      if (!res.ok) {
        onNotify(data.error ?? t("启动赛道提炼失败"));
        return;
      }
      setSynthesizing(true);
      onNotify(t("已启动 AI 赛道图谱提炼，页面将自动刷新进度"));
      void loadTracks(true);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : t("启动赛道提炼失败"));
    } finally {
      setTriggering(false);
    }
  };

  const handlePatchTrackItem = (id: number, body: Record<string, unknown>) => {
    onPatch(id, body);
    setDetail((cur) => {
      if (!cur) return cur;
      return {
        ...cur,
        items: cur.items
          .map((it) => (it.id === id ? { ...it, ...body } as Item : it))
          .filter((it) => !(id === it.id && body.status === "ignored")),
      };
    });
  };

  return (
    <div className="mx-auto max-w-6xl space-y-5 pb-10">
      {/* 顶栏 */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-200 pb-4">
        <div className="min-w-0 space-y-1">
          <h2 className="flex items-center gap-2 text-[18px] font-semibold tracking-tight text-ink-950">
            <Compass size={18} className="shrink-0 text-accent" />
            {t("🧭 赛道图谱")}
          </h2>
          <p className="text-[13px] text-ink-500 [overflow-wrap:anywhere] break-words">
            {t("跨百帖聚类提炼实战赛道白皮书，拆解主流变现流派、高频死法与 7 天最小验证清单")}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              void loadTracks();
              if (selectedSlug) void loadDetail(selectedSlug);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-700 transition-colors hover:bg-ink-100"
          >
            <RefreshCw size={13} className={listLoading ? "animate-spin" : ""} />
            {t("刷新")}
          </button>
          {canAdmin && (
            <button
              type="button"
              disabled={triggering}
              onClick={() => void handleSynthesize()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent-solid px-3.5 py-1.5 text-[12px] font-medium text-on-solid transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {triggering || synthesizing ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              {synthesizing ? t("正在提炼赛道白皮书…") : t("AI 重新提炼赛道图谱")}
            </button>
          )}
        </div>
      </div>

      {synthesizing && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-xl border border-brand-border bg-brand-subtle px-4 py-2.5 text-[13px] font-medium text-accent"
        >
          <Loader2 size={15} className="shrink-0 animate-spin" />
          <span className="min-w-0 [overflow-wrap:anywhere] break-words">
            {t("AI 正在跨帖提炼赛道白皮书… 每完成一条赛道会自动出现在下方列表")}
          </span>
        </div>
      )}

      {listError && (
        <div role="alert" className="rounded-xl border border-alert-border bg-alert-subtle p-4 text-[13px] text-alert">
          {t("赛道列表加载失败：")}{listError}
        </div>
      )}

      {listLoading && !tracks.length ? (
        <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-400">
          <Loader2 size={15} className="animate-spin" />
          {t("正在加载赛道图谱…")}
        </div>
      ) : !tracks.length ? (
        <div className="rounded-xl border border-ink-200 bg-surface-hover px-6 py-14 text-center">
          <Compass size={28} className="mx-auto mb-2.5 text-ink-300" />
          <div className="text-[15px] font-semibold text-ink-900">{t("尚未生成赛道全景图谱")}</div>
          <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-ink-500">
            {canAdmin
              ? t("点击右上角「AI 重新提炼赛道图谱」，将基于库内高分生财干货自动聚类并生成结构化赛道白皮书。")
              : t("管理员生成赛道图谱后，这里将展示各生财赚钱赛道的流派拆解与代表神帖。")}
          </p>
        </div>
      ) : (
        <>
          {/* 赛道卡片网格：移动端查看详情时隐藏列表，可一键返回 */}
          <div className={mobileShowDetail ? "hidden lg:block" : "block"}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {tracks.map((tr) => {
                const active = selectedSlug === tr.slug;
                return (
                  <button
                    key={tr.slug}
                    type="button"
                    onClick={() => {
                      setSelectedSlug(tr.slug);
                      setMobileShowDetail(true);
                    }}
                    className={
                      "flex min-w-0 flex-col items-start rounded-xl border p-3.5 text-left transition-all " +
                      (active
                        ? "border-brand-border bg-brand-subtle/60 shadow-xs"
                        : "border-ink-200 bg-surface hover:border-ink-300 hover:bg-surface-hover")
                    }
                  >
                    <div className="flex w-full min-w-0 items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2 text-[14px] font-semibold text-ink-950">
                        <span aria-hidden="true" className="shrink-0 text-[16px]">{tr.emoji}</span>
                        <span className="truncate">{tr.title}</span>
                      </span>
                    </div>
                    <p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-ink-600 [overflow-wrap:anywhere] break-words">
                      {tr.tagline}
                    </p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                      <span className="rounded bg-ink-100 px-2 py-0.5 font-medium text-ink-700">
                        {t("{n} 篇干货", { n: tr.itemCount })}
                      </span>
                      <span className="rounded border border-brand-border bg-surface px-2 py-0.5 font-medium text-accent">
                        {t("{m} 种流派", { m: tr.playbookCount })}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 选中赛道的白皮书详情 */}
          {selectedSlug && (
            <div className={mobileShowDetail ? "block" : "hidden lg:block"}>
              <button
                type="button"
                onClick={() => setMobileShowDetail(false)}
                className="mb-3 inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-700 hover:bg-ink-100 lg:hidden"
              >
                <ArrowLeft size={13} />
                {t("返回全部赛道")}
              </button>

              {detailLoading && !detail ? (
                <div className="flex items-center justify-center gap-2 rounded-xl border border-ink-200 bg-surface py-14 text-[13px] text-ink-400">
                  <Loader2 size={15} className="animate-spin" />
                  {t("正在加载赛道白皮书…")}
                </div>
              ) : detailError ? (
                <div role="alert" className="rounded-xl border border-alert-border bg-alert-subtle p-4 text-[13px] text-alert">
                  {t("白皮书加载失败：")}{detailError}
                </div>
              ) : detail ? (
                <article className="space-y-4">
                  {/* 白皮书标题头 */}
                  <div className="rounded-xl border border-brand-border bg-surface p-4 sm:p-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="flex min-w-0 items-center gap-2 text-[17px] font-semibold text-ink-950 [overflow-wrap:anywhere] break-words">
                        <span aria-hidden="true" className="text-[20px]">{detail.track.emoji}</span>
                        <span>{t("《{title} · 赛道实战白皮书》", { title: detail.track.title })}</span>
                      </h3>
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span className="rounded bg-brand-subtle px-2 py-0.5 font-medium text-accent">
                          {t("{n} 篇干货", { n: detail.track.itemCount })}
                        </span>
                        {detail.track.model && (
                          <span className="rounded bg-ink-100 px-2 py-0.5 font-mono text-ink-500">
                            {detail.track.model}
                          </span>
                        )}
                      </div>
                    </div>
                    <p className="mt-1 text-[13px] text-ink-500 [overflow-wrap:anywhere] break-words">
                      {detail.track.tagline}
                    </p>

                    {/* 赛道商业本质与红利判断 */}
                    <div className="mt-4 rounded-lg border border-ink-200 bg-surface-hover p-3.5">
                      <div className="mb-1 text-[12px] font-semibold text-ink-800">
                        {t("赛道商业本质与红利判断")}
                      </div>
                      <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-ink-700 [overflow-wrap:anywhere] break-words">
                        {detail.track.overview}
                      </p>
                    </div>
                  </div>

                  {/* 主流变现流派对比 */}
                  {detail.track.playbooks.length > 0 && (
                    <section className="space-y-2.5">
                      <h4 className="flex items-center gap-1.5 text-[14px] font-semibold text-ink-900">
                        <Layers size={15} className="text-accent" />
                        {t("主流变现流派对比")}
                      </h4>
                      <div className="grid gap-3 md:grid-cols-2">
                        {detail.track.playbooks.map((pb, idx) => (
                          <div
                            key={idx}
                            className="flex min-w-0 flex-col rounded-xl border border-ink-200 bg-surface p-4"
                          >
                            <div className="text-[14px] font-semibold text-ink-950 [overflow-wrap:anywhere] break-words">
                              {pb.name}
                            </div>
                            <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                              <span className="rounded border border-deal-border bg-deal-subtle px-2 py-0.5 font-medium text-deal [overflow-wrap:anywhere] break-words">
                                {t("ROI 区间")}：{pb.roiRange}
                              </span>
                              <span className="rounded border border-code-border bg-code-subtle px-2 py-0.5 font-medium text-code [overflow-wrap:anywhere] break-words">
                                {t("适合底牌")}：{pb.targetPlayer}
                              </span>
                            </div>
                            <p className="mt-2.5 text-[13px] leading-relaxed text-ink-700 [overflow-wrap:anywhere] break-words">
                              {pb.mechanism}
                            </p>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {/* 高频死法避坑 + 7 天验证清单 */}
                  {(detail.track.commonPitfalls.length > 0 || detail.track.actionChecklist.length > 0) && (
                    <div className="grid gap-4 lg:grid-cols-2">
                      {detail.track.commonPitfalls.length > 0 && (
                        <section className="min-w-0 rounded-xl border border-alert-border bg-alert-subtle/50 p-4">
                          <h4 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-alert">
                            <AlertTriangle size={14} className="shrink-0" />
                            {t("跨帖高频死法避坑")}
                          </h4>
                          <ul className="space-y-1.5">
                            {detail.track.commonPitfalls.map((pitfall, idx) => (
                              <li key={idx} className="flex min-w-0 items-start gap-2 text-[13px] leading-relaxed text-ink-800">
                                <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-alert" />
                                <span className="min-w-0 flex-1 [overflow-wrap:anywhere] break-words">{pitfall}</span>
                              </li>
                            ))}
                          </ul>
                        </section>
                      )}

                      {detail.track.actionChecklist.length > 0 && (
                        <section className="min-w-0 rounded-xl border border-deal-border bg-deal-subtle/50 p-4">
                          <h4 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-deal">
                            <CheckCircle2 size={14} className="shrink-0" />
                            {t("7 天低成本验证清单")}
                          </h4>
                          <ol className="space-y-1.5">
                            {detail.track.actionChecklist.map((step, idx) => (
                              <li key={idx} className="flex min-w-0 items-start gap-2 text-[13px] leading-relaxed text-ink-800">
                                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface font-mono text-[11px] font-semibold text-deal">
                                  {idx + 1}
                                </span>
                                <span className="min-w-0 flex-1 [overflow-wrap:anywhere] break-words">{step}</span>
                              </li>
                            ))}
                          </ol>
                        </section>
                      )}
                    </div>
                  )}

                  {/* 本赛道必看代表神帖 */}
                  <section className="overflow-hidden rounded-xl border border-ink-200 bg-surface">
                    <div className="flex items-center justify-between border-b border-ink-100 bg-surface-hover px-4 py-3">
                      <h4 className="text-[13px] font-semibold text-ink-900">
                        {t("本赛道必看代表神帖")}
                      </h4>
                      <span className="font-mono text-[11px] text-ink-500">
                        {t("共 {n} 篇", { n: detail.items.length })}
                      </span>
                    </div>
                    {detail.items.length > 0 ? (
                      <div>
                        {detail.items.map((item) => (
                          <CompactRow
                            key={item.id}
                            item={item}
                            sourceName={sourceName}
                            onPatch={handlePatchTrackItem}
                            onOpen={onOpen}
                            onQuickBlock={onQuickBlock}
                            onCopyCode={onCopyCode}
                            showSummary
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="px-4 py-8 text-center text-[13px] text-ink-400">
                        {t("暂无代表贴记录")}
                      </div>
                    )}
                  </section>
                </article>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}
