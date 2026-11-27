import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Compass,
  ExternalLink,
  FileText,
  Layers,
  Loader2,
  MessageSquareText,
  RefreshCw,
  Search,
  Sparkles,
  Users,
  X,
  Zap,
} from "lucide-react";
import type {
  ManualBookDetail,
  ManualBookSummary,
  ManualChapterDetail,
  ManualChapterSummary,
  ManualLinkedGroup,
} from "../../../shared/manuals.ts";
import {
  CHAT_DIGEST_CATEGORIES,
  type ChatDigestCategory,
  type ChatDigestItem,
  type ChatDigestsResponse,
} from "../../../shared/chat-radar.ts";
import type { ItemDossier } from "../../../shared/dossier.ts";
import { dateLocale, t } from "../lib/i18n.ts";
import { isSafeHttpUrl } from "../lib/snapshot.ts";
import { DossierCard } from "./DossierCard.tsx";
import { SnapshotContent } from "./SnapshotContent.tsx";

export type ManualsPanelProps = {
  canAdmin?: boolean;
  initialActivityId?: string | null;
  onOpenChatRadar?: (opts: { activityId?: string; groupKey?: string }) => void;
  onNotify?: (msg: string) => void;
};

type BookshelfFilter = "all" | "linked" | "dossier";
type ReaderTab = "chapters" | "chat";

function formatCharCount(chars: number): string {
  const safe = Math.max(0, Math.round(chars));
  if (safe >= 10000) {
    const w = (safe / 10000).toFixed(1).replace(/\.0$/, "");
    return t("{w} 万字", { w });
  }
  return t("{n} 字", { n: safe });
}

function toMs(ts: number): number {
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return ts < 1e12 ? ts * 1000 : ts;
}

function formatTimestamp(ts: number): string {
  const ms = toMs(ts);
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString(dateLocale(), {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function formatTimeRange(fromTs: number, toTs: number): string {
  const a = formatTimestamp(fromTs);
  const b = formatTimestamp(toTs);
  if (a && b && a !== b) return `${a} - ${b}`;
  return a || b;
}

function sumLinkedStats(groups: ManualLinkedGroup[]): { messages: number; digests: number } {
  let messages = 0;
  let digests = 0;
  for (const g of groups) {
    messages += Number(g.messageCount || 0);
    digests += Number(g.digestCount || 0);
  }
  return { messages, digests };
}

function digestCategoryBadgeClass(cat: ChatDigestCategory): string {
  switch (cat) {
    case "导师点评":
      return "border-brand-border bg-brand-subtle text-accent";
    case "实操排坑":
      return "border-alert-border bg-alert-subtle text-alert";
    case "工具渠道":
      return "border-code-border bg-code-subtle text-code";
    case "变现思路":
      return "border-deal-border bg-deal-subtle text-deal";
  }
}

function flattenBookChapters(book: ManualBookDetail | null): ManualChapterSummary[] {
  if (!book) return [];
  if (book.sections.length > 0) {
    return book.sections.flatMap((sec) => sec.chapters);
  }
  return book.chapters;
}

export function ManualsPanel({
  canAdmin = false,
  initialActivityId = null,
  onOpenChatRadar,
  onNotify,
}: ManualsPanelProps) {
  // ── Layer 1：书架状态 ───────────────────────────────────────────────
  const [books, setBooks] = useState<ManualBookSummary[]>([]);
  const [booksLoading, setBooksLoading] = useState(true);
  const [booksError, setBooksError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filterMode, setFilterMode] = useState<BookshelfFilter>("all");

  // ── Layer 2：整书阅读器状态 ─────────────────────────────────────────
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(
    initialActivityId || null,
  );
  const [readerTab, setReaderTab] = useState<ReaderTab>("chapters");
  const [bookDetail, setBookDetail] = useState<ManualBookDetail | null>(null);
  const [bookLoading, setBookLoading] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);

  const [activeChapterId, setActiveChapterId] = useState<number | null>(null);
  const [mobileTocOpen, setMobileTocOpen] = useState(false);
  const [chapterCache, setChapterCache] = useState<Record<number, ManualChapterDetail>>({});
  const [chapterLoading, setChapterLoading] = useState(false);
  const [chapterError, setChapterError] = useState<string | null>(null);

  // ── Tab B：同期实战群暗线状态 ───────────────────────────────────────
  const [digests, setDigests] = useState<ChatDigestItem[]>([]);
  const [digestsLoading, setDigestsLoading] = useState(false);
  const [digestsError, setDigestsError] = useState<string | null>(null);
  const [digestCategory, setDigestCategory] = useState<ChatDigestCategory | "all">("all");

  const readerTopRef = useRef<HTMLDivElement | null>(null);
  const booksAbortRef = useRef<AbortController | null>(null);
  const bookDetailAbortRef = useRef<AbortController | null>(null);
  const chapterAbortRef = useRef<AbortController | null>(null);
  const digestsAbortRef = useRef<AbortController | null>(null);
  const chapterCacheRef = useRef<Record<number, ManualChapterDetail>>({});
  chapterCacheRef.current = chapterCache;

  useEffect(() => {
    return () => {
      booksAbortRef.current?.abort();
      bookDetailAbortRef.current?.abort();
      chapterAbortRef.current?.abort();
      digestsAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (initialActivityId) {
      setSelectedActivityId(initialActivityId);
      setReaderTab("chapters");
      setActiveChapterId(null);
      setMobileTocOpen(false);
    }
  }, [initialActivityId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(searchInput.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const loadBooks = useCallback(async (keyword: string) => {
    booksAbortRef.current?.abort();
    const ac = new AbortController();
    booksAbortRef.current = ac;
    setBooksLoading(true);
    setBooksError(null);
    try {
      const qs = keyword ? `?q=${encodeURIComponent(keyword)}` : "";
      const res = await fetch(`/api/manuals${qs}`, { cache: "no-cache", signal: ac.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = (await res.json()) as { books?: ManualBookSummary[] };
      if (ac.signal.aborted) return;
      setBooks(Array.isArray(data.books) ? data.books : []);
    } catch (err) {
      if (ac.signal.aborted) return;
      setBooksError(err instanceof Error ? err.message : String(err));
    } finally {
      if (booksAbortRef.current === ac && !ac.signal.aborted) {
        setBooksLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadBooks(debouncedQuery);
  }, [debouncedQuery, loadBooks]);

  const loadBookDetail = useCallback(async (activityId: string) => {
    bookDetailAbortRef.current?.abort();
    const ac = new AbortController();
    bookDetailAbortRef.current = ac;
    setBookLoading(true);
    setBookError(null);
    try {
      const res = await fetch(`/api/manuals/${encodeURIComponent(activityId)}`, {
        cache: "no-cache",
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = (await res.json()) as { book?: ManualBookDetail };
      if (!data.book) throw new Error(t("未找到该航海手册"));
      if (ac.signal.aborted) return;
      setBookDetail(data.book);
      const flat = flattenBookChapters(data.book);
      setActiveChapterId((cur) => {
        if (cur !== null && flat.some((ch) => ch.itemId === cur)) return cur;
        return flat[0]?.itemId ?? data.book?.coverChapterItemId ?? null;
      });
    } catch (err) {
      if (ac.signal.aborted) return;
      setBookError(err instanceof Error ? err.message : String(err));
      setBookDetail(null);
    } finally {
      if (bookDetailAbortRef.current === ac && !ac.signal.aborted) {
        setBookLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!selectedActivityId) {
      bookDetailAbortRef.current?.abort();
      setBookDetail(null);
      setBookError(null);
      setBookLoading(false);
      return;
    }
    void loadBookDetail(selectedActivityId);
  }, [selectedActivityId, loadBookDetail]);

  const loadChapterDetail = useCallback(async (itemId: number, force = false) => {
    if (!force && chapterCacheRef.current[itemId]) {
      chapterAbortRef.current?.abort();
      setChapterLoading(false);
      setChapterError(null);
      return;
    }
    chapterAbortRef.current?.abort();
    const ac = new AbortController();
    chapterAbortRef.current = ac;
    setChapterLoading(true);
    setChapterError(null);
    try {
      const res = await fetch(`/api/manuals/chapters/${itemId}`, {
        cache: "no-cache",
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = (await res.json()) as { chapter?: ManualChapterDetail };
      if (!data.chapter) throw new Error(t("未找到该章节内容"));
      if (ac.signal.aborted) return;
      const chapter = data.chapter;
      setChapterCache((prev) => ({ ...prev, [itemId]: chapter }));
    } catch (err) {
      if (ac.signal.aborted) return;
      setChapterError(err instanceof Error ? err.message : String(err));
    } finally {
      if (chapterAbortRef.current === ac && !ac.signal.aborted) {
        setChapterLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!selectedActivityId || readerTab !== "chapters" || activeChapterId === null) return;
    void loadChapterDetail(activeChapterId);
  }, [selectedActivityId, readerTab, activeChapterId, loadChapterDetail]);

  const loadBookDigests = useCallback(async (activityId: string) => {
    digestsAbortRef.current?.abort();
    const ac = new AbortController();
    digestsAbortRef.current = ac;
    setDigestsLoading(true);
    setDigestsError(null);
    try {
      const res = await fetch(
        `/api/chat-radar/digests?activityId=${encodeURIComponent(activityId)}&limit=30`,
        { cache: "no-cache", signal: ac.signal },
      );
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = (await res.json()) as ChatDigestsResponse;
      if (ac.signal.aborted) return;
      setDigests(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      if (ac.signal.aborted) return;
      setDigestsError(err instanceof Error ? err.message : String(err));
      setDigests([]);
    } finally {
      if (digestsAbortRef.current === ac && !ac.signal.aborted) {
        setDigestsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!selectedActivityId || readerTab !== "chat") return;
    setDigestCategory("all");
    void loadBookDigests(selectedActivityId);
  }, [selectedActivityId, readerTab, loadBookDigests]);

  const openBook = (activityId: string, tab: ReaderTab = "chapters") => {
    setSelectedActivityId(activityId);
    setReaderTab(tab);
    setActiveChapterId(null);
    setMobileTocOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const selectChapter = (itemId: number) => {
    setActiveChapterId(itemId);
    setMobileTocOpen(false);
    setChapterError(null);
    window.requestAnimationFrame(() => {
      readerTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const handleDossierUpdated = (itemId: number, dossier: ItemDossier) => {
    setChapterCache((prev) => {
      const existing = prev[itemId];
      if (!existing) return prev;
      return {
        ...prev,
        [itemId]: { ...existing, hasDossier: true, dossier },
      };
    });
    setBookDetail((prev) => {
      if (!prev) return prev;
      let addedNew = false;
      const updateChapter = <T extends ManualChapterSummary>(ch: T): T => {
        if (ch.itemId !== itemId) return ch;
        if (!ch.hasDossier) addedNew = true;
        return { ...ch, hasDossier: true };
      };
      const sections = prev.sections.map((sec) => ({
        ...sec,
        chapters: sec.chapters.map(updateChapter),
      }));
      const chapters = prev.chapters.map(updateChapter);
      return {
        ...prev,
        dossierCount: prev.dossierCount + (addedNew ? 1 : 0),
        sections,
        chapters,
      };
    });
    setBooks((prev) =>
      prev.map((b) =>
        b.activityId === selectedActivityId
          ? { ...b, dossierCount: Math.max(1, b.dossierCount) }
          : b,
      ),
    );
  };

  const filteredBooks = useMemo(() => {
    if (filterMode === "linked") return books.filter((b) => b.linkedGroups.length > 0);
    if (filterMode === "dossier") return books.filter((b) => b.dossierCount > 0);
    return books;
  }, [books, filterMode]);

  const linkedBookCount = useMemo(
    () => books.filter((b) => b.linkedGroups.length > 0).length,
    [books],
  );
  const dossierBookCount = useMemo(
    () => books.filter((b) => b.dossierCount > 0).length,
    [books],
  );

  const flatChapters = useMemo(() => flattenBookChapters(bookDetail), [bookDetail]);
  const activeChapterIndex = useMemo(
    () => flatChapters.findIndex((ch) => ch.itemId === activeChapterId),
    [flatChapters, activeChapterId],
  );
  const activeChapterSummary =
    activeChapterIndex >= 0 ? flatChapters[activeChapterIndex] : null;
  const activeChapterDetail =
    activeChapterId !== null ? chapterCache[activeChapterId] ?? null : null;
  const prevChapter =
    activeChapterIndex > 0 ? flatChapters[activeChapterIndex - 1] : null;
  const nextChapter =
    activeChapterIndex >= 0 && activeChapterIndex < flatChapters.length - 1
      ? flatChapters[activeChapterIndex + 1]
      : null;

  const filteredDigests = useMemo(() => {
    if (digestCategory === "all") return digests;
    return digests.filter((d) => d.category === digestCategory);
  }, [digests, digestCategory]);

  // ── Layer 2：单本航海电子书沉浸阅读器视图 ─────────────────────────
  if (selectedActivityId) {
    const activeUrl = isSafeHttpUrl(
      activeChapterDetail?.url || activeChapterSummary?.url,
    );
    const hasLinkedGroups = (bookDetail?.linkedGroups.length ?? 0) > 0;

    return (
      <div className="mx-auto max-w-6xl space-y-4 pb-12">
        {/* 顶部返回与整书元信息栏 */}
        <div className="rounded-xl border border-ink-200 bg-surface p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setSelectedActivityId(null)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-700 transition-colors hover:bg-ink-100"
            >
              <ArrowLeft size={14} />
              {t("返回全部手册")}
            </button>

            {bookDetail && (
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                {bookDetail.periodLabel && (
                  <span className="rounded bg-brand-subtle px-2 py-0.5 font-medium text-accent">
                    {bookDetail.periodLabel}
                  </span>
                )}
                {bookDetail.category && (
                  <span className="rounded bg-ink-100 px-2 py-0.5 font-medium text-ink-600">
                    {bookDetail.category}
                  </span>
                )}
                <span className="rounded bg-ink-100 px-2 py-0.5 font-medium text-ink-700">
                  {t("{n} 节课程", { n: bookDetail.chapterCount })}
                </span>
                <span className="rounded bg-ink-100 px-2 py-0.5 font-mono text-ink-600">
                  {formatCharCount(bookDetail.totalChars)}
                </span>
                {bookDetail.dossierCount > 0 && (
                  <span className="rounded border border-code-border bg-code-subtle px-2 py-0.5 font-medium text-code">
                    {t("⚡ {n} 份立项书", { n: bookDetail.dossierCount })}
                  </span>
                )}
              </div>
            )}
          </div>

          {bookDetail && (
            <div className="mt-3 space-y-3">
              <h2 className="text-[18px] font-semibold tracking-tight text-ink-950 [overflow-wrap:anywhere] break-words sm:text-[20px]">
                {bookDetail.title}
              </h2>

              {hasLinkedGroups && (
                <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 pt-3">
                  <button
                    type="button"
                    onClick={() => setReaderTab("chapters")}
                    className={
                      "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12.5px] font-medium transition-colors " +
                      (readerTab === "chapters"
                        ? "border-brand-border bg-brand-subtle text-accent"
                        : "border-ink-200 bg-surface text-ink-600 hover:bg-surface-hover hover:text-ink-950")
                    }
                  >
                    {t("📖 手册正文目录")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setReaderTab("chat")}
                    className={
                      "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12.5px] font-medium transition-colors " +
                      (readerTab === "chat"
                        ? "border-deal-border bg-deal-subtle text-deal"
                        : "border-ink-200 bg-surface text-ink-600 hover:bg-surface-hover hover:text-ink-950")
                    }
                  >
                    {t("💬 同期实战群暗线 ({n})", {
                      n: bookDetail.linkedGroups.length,
                    })}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {bookLoading && !bookDetail ? (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-ink-200 bg-surface py-16 text-[13px] text-ink-400">
            <Loader2 size={16} className="animate-spin" />
            {t("正在加载航海手册目录…")}
          </div>
        ) : bookError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-alert-border bg-alert-subtle p-4 text-[13px] text-alert"
          >
            <span>
              {t("手册详情加载失败：")}
              {bookError}
            </span>
            <button
              type="button"
              onClick={() => void loadBookDetail(selectedActivityId)}
              className="inline-flex items-center gap-1 rounded-lg border border-alert-border bg-surface px-3 py-1 text-[12px] font-medium text-alert hover:bg-surface-hover"
            >
              <RefreshCw size={12} />
              {t("重试")}
            </button>
          </div>
        ) : !bookDetail ? null : readerTab === "chat" ? (
          /* ── Tab B：同期实战群暗线联动面板 ───────────────────────────── */
          <div className="space-y-4">
            <section className="rounded-xl border border-ink-200 bg-surface p-4 sm:p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="flex items-center gap-1.5 text-[14px] font-semibold text-ink-950">
                  <Users size={15} className="text-deal" />
                  {t("关联当期实战微信群")}
                </h3>
                <span className="text-[12px] text-ink-500">
                  {t("共挂载 {n} 个当期实战群", { n: bookDetail.linkedGroups.length })}
                </span>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {bookDetail.linkedGroups.map((g) => (
                  <div
                    key={g.groupKey}
                    className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-deal-border/70 bg-deal-subtle/35 p-3.5"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="truncate text-[13.5px] font-semibold text-ink-950">
                        {g.name}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-600">
                        <span>{t("{n} 条群消息", { n: g.messageCount })}</span>
                        {typeof g.digestCount === "number" && g.digestCount > 0 && (
                          <span className="rounded bg-surface px-1.5 py-0.5 font-medium text-deal">
                            {t("{n} 条提纯", { n: g.digestCount })}
                          </span>
                        )}
                        {g.lastMsgTime > 0 && (
                          <span className="text-ink-400">
                            {t("最近活跃")} {formatTimestamp(g.lastMsgTime)}
                          </span>
                        )}
                      </div>
                    </div>

                    {onOpenChatRadar && (
                      <button
                        type="button"
                        onClick={() =>
                          onOpenChatRadar({
                            activityId: bookDetail.activityId,
                            groupKey: g.groupKey,
                          })
                        }
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-deal-border bg-surface px-3 py-1.5 text-[12px] font-medium text-deal transition-colors hover:bg-deal-subtle"
                      >
                        {t("查看原始群聊")}
                        <ArrowRight size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>

            {/* 同期实战群 AI 提纯暗线 */}
            <section className="space-y-3 rounded-xl border border-ink-200 bg-surface p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-ink-100 pb-3">
                <div className="space-y-0.5">
                  <h3 className="flex items-center gap-1.5 text-[14px] font-semibold text-ink-950">
                    <Sparkles size={15} className="text-accent" />
                    {t("实战群提纯暗线与排坑精华")}
                  </h3>
                  <p className="text-[12px] text-ink-500">
                    {t("自动汇聚关联微信群内的导师点评、实操排坑、工具渠道与变现思路")}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => void loadBookDigests(bookDetail.activityId)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-700 transition-colors hover:bg-ink-100"
                >
                  <RefreshCw size={12} className={digestsLoading ? "animate-spin" : ""} />
                  {t("刷新")}
                </button>
              </div>

              {digests.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setDigestCategory("all")}
                    className={
                      "rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors " +
                      (digestCategory === "all"
                        ? "border-brand-border bg-brand-subtle text-accent"
                        : "border-ink-200 bg-surface text-ink-600 hover:bg-surface-hover")
                    }
                  >
                    {t("全部")} ({digests.length})
                  </button>
                  {CHAT_DIGEST_CATEGORIES.map((cat) => {
                    const count = digests.filter((d) => d.category === cat).length;
                    if (count === 0) return null;
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setDigestCategory(cat)}
                        className={
                          "rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors " +
                          (digestCategory === cat
                            ? digestCategoryBadgeClass(cat)
                            : "border-ink-200 bg-surface text-ink-600 hover:bg-surface-hover")
                        }
                      >
                        {t(cat)} ({count})
                      </button>
                    );
                  })}
                </div>
              )}

              {digestsLoading && digests.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-ink-400">
                  <Loader2 size={15} className="animate-spin" />
                  {t("正在加载实战群提纯暗线…")}
                </div>
              ) : digestsError ? (
                <div
                  role="alert"
                  className="rounded-xl border border-alert-border bg-alert-subtle p-4 text-[13px] text-alert"
                >
                  {t("群暗线加载失败：")}
                  {digestsError}
                </div>
              ) : filteredDigests.length === 0 ? (
                <div className="rounded-xl border border-ink-200 bg-surface-hover px-6 py-10 text-center">
                  <MessageSquareText size={26} className="mx-auto mb-2 text-ink-300" />
                  <div className="text-[14px] font-semibold text-ink-900">
                    {t("暂未提纯该期实战群暗线洞察")}
                  </div>
                  <p className="mx-auto mt-1 max-w-md text-[12.5px] leading-relaxed text-ink-500">
                    {t("可前往群聊雷达同步该期微信群消息或触发 AI 提纯，提炼导师点评与实操排坑。")}
                  </p>
                  {onOpenChatRadar && (
                    <button
                      type="button"
                      onClick={() => onOpenChatRadar({ activityId: bookDetail.activityId })}
                      className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-accent-solid px-3.5 py-1.5 text-[12px] font-medium text-on-solid transition-opacity hover:opacity-90"
                    >
                      {t("前往群聊雷达查看")}
                      <ArrowRight size={13} />
                    </button>
                  )}
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {filteredDigests.map((item) => {
                    const rangeLabel = formatTimeRange(item.msgTimeFrom, item.msgTimeTo);
                    return (
                      <article
                        key={item.id}
                        className="flex min-w-0 flex-col justify-between gap-2.5 rounded-xl border border-ink-200 bg-surface-hover/50 p-3.5"
                      >
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span
                              className={
                                "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold " +
                                digestCategoryBadgeClass(item.category)
                              }
                            >
                              {t(item.category)}
                            </span>
                            {rangeLabel && (
                              <span className="font-mono text-[11px] text-ink-400">
                                {rangeLabel}
                              </span>
                            )}
                          </div>

                          <h4 className="text-[14px] font-semibold leading-snug text-ink-950 [overflow-wrap:anywhere] break-words">
                            {item.title}
                          </h4>

                          <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-700 [overflow-wrap:anywhere] break-words">
                            {item.summary}
                          </p>
                        </div>

                        <div className="space-y-2 border-t border-ink-200/70 pt-2">
                          {item.keySpeakers.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5">
                              {item.keySpeakers.map((speaker, sIdx) => (
                                <span
                                  key={sIdx}
                                  className="rounded bg-ink-100 px-1.5 py-0.5 text-[11px] font-medium text-ink-700"
                                >
                                  @{speaker}
                                </span>
                              ))}
                            </div>
                          )}

                          <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-ink-500">
                            <span className="truncate">{item.groupName}</span>
                            {onOpenChatRadar && (
                              <button
                                type="button"
                                onClick={() =>
                                  onOpenChatRadar({
                                    activityId: bookDetail.activityId,
                                    groupKey: item.groupKey,
                                  })
                                }
                                className="inline-flex shrink-0 items-center gap-1 font-medium text-accent hover:underline"
                              >
                                {t("追溯群聊上下文")}
                                <ArrowRight size={11} />
                              </button>
                            )}
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        ) : (
          /* ── Tab A：手册分关阅读器（左目录树 + 右正文） ──────────────── */
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
            {/* 移动端可折叠章节选择器 */}
            <div className="lg:hidden">
              <button
                type="button"
                onClick={() => setMobileTocOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-2 rounded-xl border border-ink-200 bg-surface px-3.5 py-2.5 text-left"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-medium text-ink-500">
                    {t("当前章节")} ·{" "}
                    {activeChapterIndex >= 0
                      ? `${activeChapterIndex + 1} / ${flatChapters.length}`
                      : `0 / ${flatChapters.length}`}
                  </div>
                  <div className="truncate text-[13px] font-semibold text-ink-950">
                    {activeChapterSummary?.cleanTitle ?? t("请选择章节")}
                  </div>
                </div>
                {mobileTocOpen ? (
                  <ChevronUp size={16} className="shrink-0 text-ink-500" />
                ) : (
                  <ChevronDown size={16} className="shrink-0 text-ink-500" />
                )}
              </button>

              {mobileTocOpen && (
                <div className="mt-2 max-h-[60vh] space-y-3 overflow-y-auto rounded-xl border border-ink-200 bg-surface p-2.5">
                  {bookDetail.sections.map((sec, sIdx) => (
                    <div key={`${sec.sectionTitle}-${sIdx}`} className="space-y-1">
                      <div className="px-2 py-1 text-[11px] font-semibold tracking-wide text-ink-500">
                        {sec.sectionTitle}
                      </div>
                      <div className="space-y-0.5">
                        {sec.chapters.map((ch) => {
                          const active = ch.itemId === activeChapterId;
                          return (
                            <button
                              key={ch.itemId}
                              type="button"
                              onClick={() => selectChapter(ch.itemId)}
                              className={
                                "flex w-full items-start justify-between gap-2 rounded-lg border px-2.5 py-2 text-left text-[12.5px] transition-colors " +
                                (active
                                  ? "border-brand-border bg-brand-subtle font-semibold text-accent"
                                  : "border-transparent text-ink-700 hover:bg-surface-hover")
                              }
                            >
                              <span className="min-w-0 flex-1 [overflow-wrap:anywhere] break-words">
                                {ch.cleanTitle}
                              </span>
                              {ch.hasDossier && (
                                <Zap
                                  size={12}
                                  className="mt-0.5 shrink-0 text-code"
                                  aria-label={t("含立项拆解书")}
                                />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 桌面端左栏固定可滚动目录树 */}
            <aside className="hidden lg:block lg:w-[276px] lg:shrink-0">
              <div className="sticky top-4 flex max-h-[calc(100vh-6rem)] flex-col overflow-hidden rounded-xl border border-ink-200 bg-surface">
                <div className="flex items-center justify-between border-b border-ink-100 bg-surface-hover px-3.5 py-2.5">
                  <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-900">
                    <Layers size={14} className="text-accent" />
                    {t("章节目录")}
                  </span>
                  <span className="font-mono text-[11px] text-ink-500">
                    {flatChapters.length}
                  </span>
                </div>

                <nav
                  aria-label={t("章节目录")}
                  className="flex-1 space-y-3.5 overflow-y-auto p-2.5"
                >
                  {bookDetail.sections.map((sec, sIdx) => (
                    <div key={`${sec.sectionTitle}-${sIdx}`} className="space-y-1">
                      <div className="px-2 py-0.5 text-[11px] font-semibold tracking-wide text-ink-500">
                        {sec.sectionTitle}
                      </div>
                      <div className="space-y-0.5">
                        {sec.chapters.map((ch) => {
                          const active = ch.itemId === activeChapterId;
                          return (
                            <button
                              key={ch.itemId}
                              type="button"
                              onClick={() => selectChapter(ch.itemId)}
                              className={
                                "flex w-full items-start justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[12.5px] leading-snug transition-colors " +
                                (active
                                  ? "border-brand-border bg-brand-subtle font-semibold text-accent"
                                  : "border-transparent text-ink-700 hover:bg-surface-hover hover:text-ink-950")
                              }
                            >
                              <span className="min-w-0 flex-1 [overflow-wrap:anywhere] break-words">
                                {ch.cleanTitle}
                              </span>
                              {ch.hasDossier && (
                                <Zap
                                  size={12}
                                  className="mt-0.5 shrink-0 text-code"
                                  aria-label={t("含立项拆解书")}
                                />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </nav>
              </div>
            </aside>

            {/* 右栏正文阅读区 */}
            <main ref={readerTopRef} className="min-w-0 flex-1 space-y-4">
              {flatChapters.length === 0 ? (
                <div className="rounded-xl border border-ink-200 bg-surface px-6 py-14 text-center text-[13px] text-ink-500">
                  {t("该手册暂无可阅读章节")}
                </div>
              ) : chapterLoading && !activeChapterDetail ? (
                <div className="flex items-center justify-center gap-2 rounded-xl border border-ink-200 bg-surface py-16 text-[13px] text-ink-400">
                  <Loader2 size={16} className="animate-spin" />
                  {t("正在加载章节正文…")}
                </div>
              ) : chapterError && !activeChapterDetail ? (
                <div
                  role="alert"
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-alert-border bg-alert-subtle p-4 text-[13px] text-alert"
                >
                  <span>
                    {t("章节加载失败：")}
                    {chapterError}
                  </span>
                  {activeChapterId !== null && (
                    <button
                      type="button"
                      onClick={() => void loadChapterDetail(activeChapterId, true)}
                      className="inline-flex items-center gap-1 rounded-lg border border-alert-border bg-surface px-3 py-1 text-[12px] font-medium text-alert hover:bg-surface-hover"
                    >
                      <RefreshCw size={12} />
                      {t("重试")}
                    </button>
                  )}
                </div>
              ) : activeChapterDetail ? (
                <article className="space-y-5 rounded-xl border border-ink-200 bg-surface p-4 sm:p-6">
                  {/* 章节标题与元信息 */}
                  <header className="space-y-2.5 border-b border-ink-100 pb-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        {activeChapterDetail.sectionTitle && (
                          <span className="rounded bg-brand-subtle px-2 py-0.5 font-medium text-accent">
                            {activeChapterDetail.sectionTitle}
                          </span>
                        )}
                        <span className="rounded bg-ink-100 px-2 py-0.5 font-mono text-ink-600">
                          {formatCharCount(activeChapterDetail.charCount)}
                        </span>
                        {activeChapterDetail.publishedAt && (
                          <span className="font-mono text-ink-400">
                            {activeChapterDetail.publishedAt.slice(0, 10)}
                          </span>
                        )}
                      </div>

                      {activeUrl && (
                        <a
                          href={activeUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1 text-[11.5px] font-medium text-accent transition-colors hover:bg-surface-hover"
                        >
                          {t("生财原帖")}
                          <ExternalLink size={11} />
                        </a>
                      )}
                    </div>

                    <h1 className="text-[18px] font-bold leading-snug text-ink-950 [overflow-wrap:anywhere] break-words sm:text-[20px]">
                      {activeChapterDetail.cleanTitle || activeChapterDetail.title}
                    </h1>
                  </header>

                  {/* 立项拆解书（查看 + 管理员一键拆解） */}
                  <DossierCard
                    itemId={activeChapterDetail.itemId}
                    dossier={activeChapterDetail.dossier}
                    canAdmin={canAdmin}
                    onDossierUpdated={handleDossierUpdated}
                    onNotify={onNotify}
                  />

                  {/* 零 XSS 富文本快照正文 */}
                  {activeChapterDetail.content || activeChapterDetail.summary ? (
                    <SnapshotContent
                      content={
                        activeChapterDetail.content || activeChapterDetail.summary || ""
                      }
                    />
                  ) : (
                    <div className="rounded-lg border border-ink-200 bg-surface-hover px-4 py-10 text-center text-[13px] text-ink-400">
                      {t("本节暂无正文内容")}
                    </div>
                  )}

                  {/* 底部「上一节 / 下一节」大翻页按钮 */}
                  <footer className="grid gap-2.5 border-t border-ink-100 pt-4 sm:grid-cols-2">
                    <button
                      type="button"
                      disabled={!prevChapter}
                      onClick={() => prevChapter && selectChapter(prevChapter.itemId)}
                      className="flex min-w-0 items-center gap-2.5 rounded-xl border border-ink-200 bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <ChevronLeft size={16} className="shrink-0 text-ink-500" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-medium text-ink-500">
                          {t("上一节")}
                        </div>
                        <div className="truncate text-[13px] font-semibold text-ink-900">
                          {prevChapter ? prevChapter.cleanTitle : t("已是第一节")}
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      disabled={!nextChapter}
                      onClick={() => nextChapter && selectChapter(nextChapter.itemId)}
                      className="flex min-w-0 items-center justify-end gap-2.5 rounded-xl border border-ink-200 bg-surface px-4 py-3 text-right transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-medium text-ink-500">
                          {t("下一节")}
                        </div>
                        <div className="truncate text-[13px] font-semibold text-ink-900">
                          {nextChapter ? nextChapter.cleanTitle : t("已是最后一节")}
                        </div>
                      </div>
                      <ChevronRight size={16} className="shrink-0 text-ink-500" />
                    </button>
                  </footer>
                </article>
              ) : null}
            </main>
          </div>
        )}
      </div>
    );
  }

  // ── Layer 1：航海手册整书书架视图 ─────────────────────────────────
  return (
    <div className="mx-auto max-w-6xl space-y-5 pb-10">
      {/* 顶部标题栏 */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-200 pb-4">
        <div className="min-w-0 space-y-1">
          <h2 className="flex items-center gap-2 text-[18px] font-semibold tracking-tight text-ink-950">
            <BookOpen size={18} className="shrink-0 text-accent" />
            {t("🧭 航海实战手册书架")}
          </h2>
          <p className="text-[13px] text-ink-500 [overflow-wrap:anywhere] break-words">
            {t("已按项目自动归并历期航海 SOP 整书并挂载当期微信实战群")}
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadBooks(debouncedQuery)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-700 transition-colors hover:bg-ink-100"
        >
          <RefreshCw size={13} className={booksLoading ? "animate-spin" : ""} />
          {t("刷新")}
        </button>
      </div>

      {/* 搜索框 + 筛选胶囊栏 */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative min-w-0 flex-1 sm:max-w-md">
          <Search
            size={14}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-400"
          />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setDebouncedQuery(searchInput.trim());
            }}
            placeholder={t("搜索手册项目、章节或实战群名…")}
            className="w-full rounded-lg border border-ink-200 bg-surface py-2 pr-8 pl-8 text-[13px] text-ink-950 placeholder:text-ink-400 focus:border-brand-border focus:outline-none"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => {
                setSearchInput("");
                setDebouncedQuery("");
              }}
              aria-label={t("清空搜索")}
              className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded p-0.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
            >
              <X size={13} />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setFilterMode("all")}
            className={
              "rounded-full border px-3 py-1 text-[12px] font-medium transition-colors " +
              (filterMode === "all"
                ? "border-brand-border bg-brand-subtle text-accent"
                : "border-ink-200 bg-surface text-ink-600 hover:bg-surface-hover")
            }
          >
            {t("全部手册")} ({books.length})
          </button>
          <button
            type="button"
            onClick={() => setFilterMode("linked")}
            className={
              "rounded-full border px-3 py-1 text-[12px] font-medium transition-colors " +
              (filterMode === "linked"
                ? "border-deal-border bg-deal-subtle text-deal"
                : "border-ink-200 bg-surface text-ink-600 hover:bg-surface-hover")
            }
          >
            {t("已挂载实战群")} ({linkedBookCount})
          </button>
          <button
            type="button"
            onClick={() => setFilterMode("dossier")}
            className={
              "rounded-full border px-3 py-1 text-[12px] font-medium transition-colors " +
              (filterMode === "dossier"
                ? "border-code-border bg-code-subtle text-code"
                : "border-ink-200 bg-surface text-ink-600 hover:bg-surface-hover")
            }
          >
            {t("含立项拆解书")} ({dossierBookCount})
          </button>
        </div>
      </div>

      {booksError && (
        <div
          role="alert"
          className="rounded-xl border border-alert-border bg-alert-subtle p-4 text-[13px] text-alert"
        >
          {t("航海手册加载失败：")}
          {booksError}
        </div>
      )}

      {booksLoading && books.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-400">
          <Loader2 size={15} className="animate-spin" />
          {t("正在整理航海实战手册书架…")}
        </div>
      ) : filteredBooks.length === 0 ? (
        <div className="rounded-xl border border-ink-200 bg-surface-hover px-6 py-14 text-center">
          <Compass size={28} className="mx-auto mb-2.5 text-ink-300" />
          <div className="text-[15px] font-semibold text-ink-900">
            {books.length === 0
              ? t("尚未归档航海实战手册")
              : t("没有匹配的航海手册")}
          </div>
          <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-ink-500">
            {books.length === 0
              ? t("同步历期大航海实战手册后，系统会自动按项目归并成整本电子书并联动同期微信实战群。")
              : t("试试切换筛选条件或更换项目/章节/群名关键词。")}
          </p>
        </div>
      ) : (
        <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {filteredBooks.map((book) => {
            const linkedStats = sumLinkedStats(book.linkedGroups);
            return (
              <article
                key={book.activityId}
                className="flex min-w-0 flex-col justify-between gap-3 rounded-xl border border-ink-200 bg-surface p-4 transition-all hover:border-brand-border hover:bg-surface-hover"
              >
                <button
                  type="button"
                  onClick={() => openBook(book.activityId, "chapters")}
                  className="flex min-w-0 flex-1 flex-col items-start space-y-2.5 text-left"
                >
                  {/* 期数 / 分类 / 立项书徽章 */}
                  <div className="flex w-full flex-wrap items-center gap-1.5 text-[11px]">
                    {book.periodLabel && (
                      <span className="rounded bg-brand-subtle px-2 py-0.5 font-medium text-accent">
                        {book.periodLabel}
                      </span>
                    )}
                    {book.category && (
                      <span className="rounded bg-ink-100 px-2 py-0.5 font-medium text-ink-600">
                        {book.category}
                      </span>
                    )}
                    {book.dossierCount > 0 && (
                      <span className="rounded border border-code-border bg-code-subtle px-2 py-0.5 font-medium text-code">
                        {t("⚡ {n} 份立项书", { n: book.dossierCount })}
                      </span>
                    )}
                  </div>

                  {/* 书名 */}
                  <h3 className="line-clamp-2 w-full text-[15px] font-semibold leading-snug text-ink-950 [overflow-wrap:anywhere] break-words">
                    {book.title}
                  </h3>

                  {/* 章节数与字数 */}
                  <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-500">
                    <span className="inline-flex items-center gap-1 rounded bg-ink-100 px-2 py-0.5 font-medium text-ink-700">
                      <FileText size={11} />
                      {t("{n} 节课程", { n: book.chapterCount })}
                    </span>
                    <span className="font-mono text-ink-500">
                      {formatCharCount(book.totalChars)}
                    </span>
                  </div>

                  {/* 预览前 3 个核心章节标题 */}
                  {book.previewChapters.length > 0 && (
                    <ul className="w-full space-y-1 border-t border-ink-100 pt-2 text-[12px] text-ink-600">
                      {book.previewChapters.slice(0, 3).map((chTitle, idx) => (
                        <li key={idx} className="flex min-w-0 items-center gap-1.5">
                          <span className="h-1 w-1 shrink-0 rounded-full bg-ink-300" />
                          <span className="min-w-0 flex-1 truncate">{chTitle}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </button>

                {/* 当期微信实战群联动胶囊 + 快速进入 */}
                {book.linkedGroups.length > 0 ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-deal-border bg-deal-subtle/60 px-2.5 py-2">
                    <button
                      type="button"
                      onClick={() => openBook(book.activityId, "chat")}
                      className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-left text-[11.5px] font-medium text-deal hover:underline"
                    >
                      <span>
                        {t("💬 {n} 个当期实战群", { n: book.linkedGroups.length })}
                      </span>
                      {linkedStats.digests > 0 ? (
                        <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-deal">
                          {t("{n} 条提纯", { n: linkedStats.digests })}
                        </span>
                      ) : linkedStats.messages > 0 ? (
                        <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-ink-600">
                          {t("{n} 条群消息", { n: linkedStats.messages })}
                        </span>
                      ) : null}
                    </button>

                    {onOpenChatRadar && (
                      <button
                        type="button"
                        onClick={() => onOpenChatRadar({ activityId: book.activityId })}
                        className="inline-flex shrink-0 items-center gap-0.5 rounded border border-deal-border bg-surface px-2 py-0.5 text-[11px] font-medium text-deal transition-colors hover:bg-deal-subtle"
                      >
                        {t("群聊雷达")}
                        <ArrowRight size={10} />
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center justify-between border-t border-ink-100 pt-2 text-[11.5px] text-ink-400">
                    <span>{t("独立航海 SOP 手册")}</span>
                    <button
                      type="button"
                      onClick={() => openBook(book.activityId, "chapters")}
                      className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
                    >
                      {t("翻阅整书")}
                      <ArrowRight size={11} />
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
