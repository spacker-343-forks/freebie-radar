import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Filter,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import {
  CHAT_DIGEST_CATEGORIES,
  type ChatDigestCategory,
  type ChatDigestItem,
  type ChatDigestsResponse,
  type ChatGroupItem,
  type ChatGroupTier,
  type ChatGroupsResponse,
  type ChatMessageContextResponse,
  type ChatMessageItem,
  type ChatMessagesSearchResponse,
  type ChatRadarStats,
} from "../../../shared/chat-radar.ts";
import { dateLocale, t } from "../lib/i18n.ts";

type MainTab = "digests" | "messages" | "groups";
type TierFilter = "all" | ChatGroupTier;

const TIER_ORDER: readonly ChatGroupTier[] = ["core", "voyage", "regional"];
const PAGE_SIZE = 50;

function toMs(ts: number): number {
  return ts > 1e12 ? ts : ts * 1000;
}

function formatDateTime(ts: number): string {
  if (!ts) return "—";
  return new Date(toMs(ts)).toLocaleString(dateLocale(), {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTimeRange(from: number, to: number): string {
  if (!from && !to) return "—";
  if (!from) return formatDateTime(to);
  if (!to || from === to) return formatDateTime(from);
  const start = new Date(toMs(from));
  const end = new Date(toMs(to));
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  if (sameDay) {
    const dayStr = start.toLocaleDateString(dateLocale(), { month: "2-digit", day: "2-digit" });
    const startClock = start.toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" });
    const endClock = end.toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" });
    return `${dayStr} ${startClock}–${endClock}`;
  }
  return `${formatDateTime(from)} – ${formatDateTime(to)}`;
}

function categoryBadgeClass(category: ChatDigestCategory): string {
  switch (category) {
    case "工具渠道":
      return "border-brand-border bg-brand-subtle text-accent";
    case "实操排坑":
      return "border-alert-border bg-alert-subtle text-alert";
    case "导师点评":
      return "border-deal-border bg-deal-subtle text-deal";
    case "变现思路":
      return "border-code-border bg-code-subtle text-code";
  }
}

function tierLabel(tier: ChatGroupTier): string {
  switch (tier) {
    case "core":
      return t("核心内测与X群");
    case "voyage":
      return t("11月大航海群");
    case "regional":
      return t("地域交流群");
  }
}

function tierBadgeClass(tier: ChatGroupTier): string {
  switch (tier) {
    case "core":
      return "border-brand-border bg-brand-subtle text-accent";
    case "voyage":
      return "border-deal-border bg-deal-subtle text-deal";
    case "regional":
      return "border-ink-200 bg-ink-100 text-ink-600";
  }
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function HighlightText({ text, query }: { text: string; query: string }) {
  const tokens = useMemo(
    () =>
      query
        .trim()
        .split(/\s+/)
        .filter((tok) => tok.length >= 1)
        .slice(0, 6),
    [query],
  );
  if (!tokens.length || !text) return <>{text}</>;
  const regex = new RegExp(`(${tokens.map(escapeRegExp).join("|")})`, "gi");
  const parts = text.split(regex);
  if (parts.length <= 1) return <>{text}</>;
  const lowerSet = new Set(tokens.map((tok) => tok.toLowerCase()));
  return (
    <>
      {parts.map((part, idx) =>
        lowerSet.has(part.toLowerCase()) ? (
          <mark
            key={idx}
            className="rounded bg-code-subtle px-0.5 font-medium text-ink-950"
          >
            {part}
          </mark>
        ) : (
          <Fragment key={idx}>{part}</Fragment>
        ),
      )}
    </>
  );
}

export function ChatRadarPanel({
  canAdmin = false,
  initialActivityId = null,
  initialGroupKey = null,
  onOpenManualBook,
  onNotify,
}: {
  canAdmin?: boolean;
  initialActivityId?: string | null;
  initialGroupKey?: string | null;
  onOpenManualBook?: (activityId: string) => void;
  onNotify?: (msg: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<MainTab>("digests");

  // 群目录与总览统计
  const [stats, setStats] = useState<ChatRadarStats | null>(null);
  const [groups, setGroups] = useState<ChatGroupItem[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [groupsError, setGroupsError] = useState<string | null>(null);

  // 统一筛选条件
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");
  const [selectedGroupKey, setSelectedGroupKey] = useState<string>(initialGroupKey ?? "");
  const [selectedActivityId, setSelectedActivityId] = useState<string>(
    initialGroupKey ? "" : initialActivityId ?? "",
  );

  // AI 提纯暗线状态
  const [categoryFilter, setCategoryFilter] = useState<"all" | ChatDigestCategory>("all");
  const [digests, setDigests] = useState<ChatDigestItem[]>([]);
  const [digestsModel, setDigestsModel] = useState<string>("");
  const [digestsLoading, setDigestsLoading] = useState(true);
  const [digestsError, setDigestsError] = useState<string | null>(null);

  // 跨群原话检索状态
  const [includeNoise, setIncludeNoise] = useState(false);
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [messagesTotal, setMessagesTotal] = useState(0);
  const [messagesOffset, setMessagesOffset] = useState(0);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);

  // 管理员操作状态
  const [syncing, setSyncing] = useState(false);
  const [distilling, setDistilling] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [managerTier, setManagerTier] = useState<ChatGroupTier>("core");
  const [managerSearch, setManagerSearch] = useState("");
  const [togglingGroupKey, setTogglingGroupKey] = useState<string | null>(null);

  // 原群上下文抽屉
  const [contextOpen, setContextOpen] = useState(false);
  const [contextTitle, setContextTitle] = useState("");
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [contextData, setContextData] = useState<ChatMessageContextResponse | null>(null);
  const anchorMsgRef = useRef<HTMLDivElement | null>(null);
  const groupsAbortRef = useRef<AbortController | null>(null);
  const digestsAbortRef = useRef<AbortController | null>(null);
  const messagesAbortRef = useRef<AbortController | null>(null);
  const contextAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      groupsAbortRef.current?.abort();
      digestsAbortRef.current?.abort();
      messagesAbortRef.current?.abort();
      contextAbortRef.current?.abort();
    };
  }, []);

  // 外部传入的初始定位变更时同步筛选
  useEffect(() => {
    if (initialGroupKey) {
      setSelectedGroupKey(initialGroupKey);
      setSelectedActivityId("");
      setTierFilter("all");
      setMessagesOffset(0);
    } else if (initialActivityId) {
      setSelectedActivityId(initialActivityId);
      setSelectedGroupKey("");
      setTierFilter("all");
      setMessagesOffset(0);
    }
  }, [initialActivityId, initialGroupKey]);

  // 搜索防抖（300ms）
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(searchInput.trim());
      setMessagesOffset(0);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const loadGroups = useCallback(async (silent = false) => {
    groupsAbortRef.current?.abort();
    const ac = new AbortController();
    groupsAbortRef.current = ac;
    if (!silent) setGroupsLoading(true);
    setGroupsError(null);
    try {
      const res = await fetch("/api/chat-radar/groups", { cache: "no-cache", signal: ac.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = (await res.json()) as ChatGroupsResponse;
      if (ac.signal.aborted) return;
      setStats(data.stats ?? null);
      setGroups(Array.isArray(data.groups) ? data.groups : []);
    } catch (err) {
      if (ac.signal.aborted) return;
      if (!silent) setGroupsError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent && groupsAbortRef.current === ac && !ac.signal.aborted) {
        setGroupsLoading(false);
      }
    }
  }, []);

  const loadDigests = useCallback(
    async (silent = false) => {
      digestsAbortRef.current?.abort();
      const ac = new AbortController();
      digestsAbortRef.current = ac;
      if (!silent) setDigestsLoading(true);
      setDigestsError(null);
      try {
        const sp = new URLSearchParams();
        if (selectedActivityId) sp.set("activityId", selectedActivityId);
        if (selectedGroupKey) sp.set("groupKey", selectedGroupKey);
        if (categoryFilter !== "all") sp.set("category", categoryFilter);
        if (query) sp.set("q", query);
        sp.set("limit", tierFilter !== "all" && !selectedGroupKey && !selectedActivityId ? "150" : "60");
        const res = await fetch(`/api/chat-radar/digests?${sp.toString()}`, {
          cache: "no-cache",
          signal: ac.signal,
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const data = (await res.json()) as ChatDigestsResponse;
        if (ac.signal.aborted) return;
        setDigests(Array.isArray(data.items) ? data.items : []);
        if (data.defaultModel) setDigestsModel(data.defaultModel);
      } catch (err) {
        if (ac.signal.aborted) return;
        setDigestsError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!silent && digestsAbortRef.current === ac && !ac.signal.aborted) {
          setDigestsLoading(false);
        }
      }
    },
    [selectedActivityId, selectedGroupKey, categoryFilter, query, tierFilter],
  );

  const loadMessages = useCallback(
    async (silent = false) => {
      messagesAbortRef.current?.abort();
      const ac = new AbortController();
      messagesAbortRef.current = ac;
      if (!silent) setMessagesLoading(true);
      setMessagesError(null);
      try {
        const sp = new URLSearchParams();
        if (query) sp.set("q", query);
        if (selectedActivityId) sp.set("activityId", selectedActivityId);
        if (selectedGroupKey) sp.set("groupKey", selectedGroupKey);
        if (tierFilter !== "all" && !selectedGroupKey) sp.set("tier", tierFilter);
        sp.set("includeNoise", includeNoise ? "1" : "0");
        sp.set("limit", String(PAGE_SIZE));
        sp.set("offset", String(messagesOffset));
        const res = await fetch(`/api/chat-radar/messages?${sp.toString()}`, {
          cache: "no-cache",
          signal: ac.signal,
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const data = (await res.json()) as ChatMessagesSearchResponse;
        if (ac.signal.aborted) return;
        setMessages(Array.isArray(data.items) ? data.items : []);
        setMessagesTotal(typeof data.total === "number" ? data.total : 0);
      } catch (err) {
        if (ac.signal.aborted) return;
        setMessagesError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!silent && messagesAbortRef.current === ac && !ac.signal.aborted) {
          setMessagesLoading(false);
        }
      }
    },
    [query, selectedActivityId, selectedGroupKey, tierFilter, includeNoise, messagesOffset],
  );

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  useEffect(() => {
    if (activeTab === "digests") {
      void loadDigests();
    } else if (activeTab === "messages") {
      void loadMessages();
    }
  }, [activeTab, loadDigests, loadMessages]);

  // 群信息索引
  const groupByKey = useMemo(() => {
    const map = new Map<string, ChatGroupItem>();
    for (const g of groups) map.set(g.groupKey, g);
    return map;
  }, [groups]);

  // 按分层聚合（用于筛选器下拉与群源目录/管理）
  const groupsByTier = useMemo(() => {
    const grouped: Record<ChatGroupTier, ChatGroupItem[]> = {
      core: [],
      voyage: [],
      regional: [],
    };
    for (const g of groups) {
      grouped[g.tier]?.push(g);
    }
    return grouped;
  }, [groups]);

  // 当前选中的单个群 / 关联手册 ID
  const selectedGroup = selectedGroupKey ? groupByKey.get(selectedGroupKey) ?? null : null;
  const activeActivityBookTitle = useMemo(() => {
    if (!selectedActivityId) return null;
    const matched = groups.find((g) => g.linkedActivityId === selectedActivityId && g.linkedBookTitle);
    return matched?.linkedBookTitle ?? null;
  }, [groups, selectedActivityId]);
  const activeLinkedActivityId = selectedActivityId || selectedGroup?.linkedActivityId || null;

  // 若启用了层级筛选且未单选群，对提纯洞察再做一次前端层级对齐
  const visibleDigests = useMemo(() => {
    if (tierFilter === "all" || selectedGroupKey || selectedActivityId) return digests;
    return digests.filter((d) => {
      const grp = groupByKey.get(d.groupKey);
      return grp ? grp.tier === tierFilter : true;
    });
  }, [digests, tierFilter, selectedGroupKey, selectedActivityId, groupByKey]);

  // 群源目录（Tab 3）& 群源管理抽屉过滤列表
  const directoryGroups = useMemo(() => {
    const kw = query.toLowerCase();
    return groups.filter((g) => {
      if (tierFilter !== "all" && g.tier !== tierFilter) return false;
      if (selectedGroupKey && g.groupKey !== selectedGroupKey) return false;
      if (selectedActivityId && g.linkedActivityId !== selectedActivityId) return false;
      if (!kw) return true;
      return (
        g.name.toLowerCase().includes(kw) ||
        (g.linkedBookTitle ?? "").toLowerCase().includes(kw)
      );
    });
  }, [groups, tierFilter, selectedGroupKey, selectedActivityId, query]);

  const managerGroups = useMemo(() => {
    const kw = managerSearch.trim().toLowerCase();
    return groupsByTier[managerTier].filter((g) => {
      if (!kw) return true;
      return (
        g.name.toLowerCase().includes(kw) ||
        (g.linkedBookTitle ?? "").toLowerCase().includes(kw)
      );
    });
  }, [groupsByTier, managerTier, managerSearch]);

  const hasActiveFilters = Boolean(
    query || tierFilter !== "all" || selectedGroupKey || selectedActivityId,
  );

  const clearAllFilters = () => {
    setSearchInput("");
    setQuery("");
    setTierFilter("all");
    setSelectedGroupKey("");
    setSelectedActivityId("");
    setCategoryFilter("all");
    setMessagesOffset(0);
  };

  // 打开群聊上下文抽屉
  const openContextDrawer = useCallback(
    async (groupKey: string, msgTime: number, title?: string) => {
      contextAbortRef.current?.abort();
      const ac = new AbortController();
      contextAbortRef.current = ac;
      setContextOpen(true);
      setContextTitle(title ?? "");
      setContextLoading(true);
      setContextError(null);
      setContextData(null);
      try {
        const sp = new URLSearchParams({
          groupKey,
          msgTime: String(msgTime),
        });
        const res = await fetch(`/api/chat-radar/messages/context?${sp.toString()}`, {
          cache: "no-cache",
          signal: ac.signal,
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const data = (await res.json()) as ChatMessageContextResponse;
        if (ac.signal.aborted) return;
        setContextData(data);
      } catch (err) {
        if (ac.signal.aborted) return;
        setContextError(err instanceof Error ? err.message : String(err));
      } finally {
        if (contextAbortRef.current === ac && !ac.signal.aborted) {
          setContextLoading(false);
        }
      }
    },
    [],
  );

  // 打开上下文后自动滚动到锚点消息
  useEffect(() => {
    if (!contextOpen || !contextData || !anchorMsgRef.current) return;
    const timer = window.setTimeout(() => {
      anchorMsgRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [contextOpen, contextData]);

  // Esc 关闭上下文抽屉
  useEffect(() => {
    if (!contextOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [contextOpen]);

  // 管理员：增量同步群消息
  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const body: Record<string, unknown> = { distill: false };
      if (selectedGroupKey) body.groupKey = selectedGroupKey;
      else if (selectedActivityId) body.activityId = selectedActivityId;
      const res = await fetch("/api/chat-radar/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        insertedMessages?: number;
        syncedGroups?: number;
      };
      if (!res.ok) {
        onNotify?.(data.error ?? t("同步群消息失败"));
        return;
      }
      onNotify?.(
        typeof data.insertedMessages === "number"
          ? t("群消息同步完成，新增 {n} 条消息", { n: data.insertedMessages })
          : t("群消息同步完成"),
      );
      await loadGroups(true);
      if (activeTab === "digests") void loadDigests(true);
      if (activeTab === "messages") void loadMessages(true);
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : t("同步群消息失败"));
    } finally {
      setSyncing(false);
    }
  };

  // 管理员：AI 提纯最新干货
  const handleDistill = async () => {
    if (distilling) return;
    setDistilling(true);
    try {
      const body: Record<string, unknown> = {};
      if (selectedGroupKey) body.groupKey = selectedGroupKey;
      else if (selectedActivityId) body.activityId = selectedActivityId;
      const res = await fetch("/api/chat-radar/distill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        insertedDigests?: number;
      };
      if (!res.ok) {
        onNotify?.(data.error ?? t("AI 提纯群聊失败"));
        return;
      }
      onNotify?.(
        typeof data.insertedDigests === "number"
          ? t("AI 提纯完成，新增 {n} 条暗线洞察", { n: data.insertedDigests })
          : t("AI 提纯完成"),
      );
      await loadGroups(true);
      if (activeTab === "digests") void loadDigests(true);
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : t("AI 提纯群聊失败"));
    } finally {
      setDistilling(false);
    }
  };

  // 管理员：启停单个群开关
  const handleToggleGroup = async (grp: ChatGroupItem) => {
    if (togglingGroupKey) return;
    setTogglingGroupKey(grp.groupKey);
    const nextEnabled = !grp.enabled;
    try {
      const res = await fetch(`/api/chat-radar/groups/${encodeURIComponent(grp.groupKey)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        group?: ChatGroupItem;
      };
      if (!res.ok) {
        onNotify?.(data.error ?? t("切换群源开关失败"));
        return;
      }
      setGroups((cur) =>
        cur.map((item) =>
          item.groupKey === grp.groupKey
            ? data.group ?? { ...item, enabled: nextEnabled }
            : item,
        ),
      );
      setStats((cur) =>
        cur
          ? {
              ...cur,
              enabledGroups: Math.max(0, cur.enabledGroups + (nextEnabled ? 1 : -1)),
            }
          : cur,
      );
      onNotify?.(
        nextEnabled
          ? t("已开启「{name}」群聊采集", { name: grp.name })
          : t("已暂停「{name}」群聊采集", { name: grp.name }),
      );
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : t("切换群源开关失败"));
    } finally {
      setTogglingGroupKey(null);
    }
  };

  const refreshAll = () => {
    void loadGroups();
    if (activeTab === "digests") void loadDigests();
    if (activeTab === "messages") void loadMessages();
  };

  const totalPages = Math.max(1, Math.ceil(messagesTotal / PAGE_SIZE));
  const currentPage = Math.floor(messagesOffset / PAGE_SIZE) + 1;

  // Context 抽屉中找出最贴近 anchorMsgTime 的消息 ID
  const anchorMsgId = useMemo(() => {
    if (!contextData || !contextData.items.length) return null;
    let bestId = contextData.items[0]!.msgId;
    let bestDiff = Math.abs(contextData.items[0]!.msgTime - contextData.anchorMsgTime);
    for (const m of contextData.items) {
      const diff = Math.abs(m.msgTime - contextData.anchorMsgTime);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestId = m.msgId;
      }
    }
    return bestId;
  }, [contextData]);

  return (
    <div className="mx-auto max-w-6xl space-y-5 pb-12">
      {/* 顶部总览与操作栏 */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-200 pb-4">
        <div className="min-w-0 space-y-1">
          <h2 className="flex items-center gap-2 text-[18px] font-semibold tracking-tight text-ink-950">
            <MessageSquare size={18} className="shrink-0 text-accent" />
            {t("💬 群聊暗线雷达")}
          </h2>
          <p className="text-[13px] text-ink-500 [overflow-wrap:anywhere] break-words">
            {t("检索高纯度生财微信群真实讨论与 AI 提纯洞察，还原前后群聊对线并联动航海手册")}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={refreshAll}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-700 transition-colors hover:bg-ink-100"
          >
            <RefreshCw size={13} className={groupsLoading || digestsLoading || messagesLoading ? "animate-spin" : ""} />
            {t("刷新")}
          </button>

          {canAdmin && (
            <>
              <button
                type="button"
                disabled={syncing}
                onClick={() => void handleSync()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-800 transition-colors hover:bg-ink-100 disabled:opacity-50"
              >
                {syncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                {syncing ? t("正在同步群消息…") : t("增量同步群消息")}
              </button>

              <button
                type="button"
                disabled={distilling}
                onClick={() => void handleDistill()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent-solid px-3.5 py-1.5 text-[12px] font-medium text-on-solid transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {distilling ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                {distilling ? t("正在 AI 提纯…") : t("AI 提纯最新干货")}
              </button>

              <button
                type="button"
                aria-expanded={managerOpen}
                onClick={() => setManagerOpen((v) => !v)}
                className={
                  "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-colors " +
                  (managerOpen
                    ? "border-brand-border bg-brand-subtle text-accent"
                    : "border-ink-200 bg-surface text-ink-700 hover:bg-ink-100")
                }
              >
                <Settings2 size={13} />
                {t("群源管理")}
                {managerOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              </button>
            </>
          )}
        </div>
      </div>

      {/* 核心指标条 */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-ink-200 bg-surface p-3.5">
          <div className="text-[11px] font-medium text-ink-500">{t("已启用群源")}</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-mono text-[20px] font-semibold text-ink-950">
              {stats ? stats.enabledGroups : "—"}
            </span>
            {stats && (
              <span className="text-[12px] text-ink-400">
                / {stats.totalGroups}
              </span>
            )}
          </div>
          {stats && (
            <div className="mt-1 text-[11px] text-ink-500">
              {t("核心 {core} · 航海 {voyage} · 地域 {regional}", {
                core: stats.coreGroups,
                voyage: stats.voyageGroups,
                regional: stats.regionalGroups,
              })}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-ink-200 bg-surface p-3.5">
          <div className="text-[11px] font-medium text-ink-500">{t("累计有效群消息")}</div>
          <div className="mt-1 font-mono text-[20px] font-semibold text-ink-950">
            {stats ? stats.validMessages.toLocaleString() : "—"}
          </div>
          {stats && (
            <div className="mt-1 text-[11px] text-ink-500">
              {t("原始消息共 {n} 条（已自动去噪）", {
                n: stats.totalMessages.toLocaleString(),
              })}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-ink-200 bg-surface p-3.5">
          <div className="text-[11px] font-medium text-ink-500">{t("AI 提纯洞察")}</div>
          <div className="mt-1 font-mono text-[20px] font-semibold text-accent">
            {stats ? stats.totalDigests.toLocaleString() : "—"}
          </div>
          <div className="mt-1 text-[11px] text-ink-500">
            {t("覆盖工具、排坑、点评与变现四维")}
          </div>
        </div>

        <div className="rounded-xl border border-ink-200 bg-surface p-3.5">
          <div className="text-[11px] font-medium text-ink-500">{t("当前提纯模型")}</div>
          <div className="mt-1 truncate font-mono text-[14px] font-semibold text-ink-900">
            {stats?.defaultDistillModel || digestsModel || "—"}
          </div>
          <div className="mt-1 text-[11px] text-ink-500">
            {t("支持按单群或航海项目增量提纯")}
          </div>
        </div>
      </div>

      {groupsError && (
        <div role="alert" className="rounded-xl border border-alert-border bg-alert-subtle p-3.5 text-[13px] text-alert">
          {t("群聊目录加载失败：")}{groupsError}
        </div>
      )}

      {/* 管理员折叠面板：群源管理 */}
      {canAdmin && managerOpen && (
        <section className="rounded-xl border border-brand-border bg-surface p-4 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 pb-3">
            <div>
              <h3 className="text-[14px] font-semibold text-ink-950">{t("群源分层管理")}</h3>
              <p className="mt-0.5 text-[12px] text-ink-500">
                {t("默认开启核心内测与 11 月航海群；地域交流群可按需随时开启或暂停采集")}
              </p>
            </div>
            <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
              <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-400" />
              <input
                type="search"
                value={managerSearch}
                onChange={(e) => setManagerSearch(e.target.value)}
                placeholder={t("过滤群名称或关联手册…")}
                className="w-full rounded-lg border border-ink-200 bg-surface-hover py-1.5 pr-3 pl-8 text-[12px] text-ink-900 placeholder:text-ink-400 focus:border-accent focus:outline-none"
              />
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {TIER_ORDER.map((tier) => {
              const list = groupsByTier[tier];
              const enabledCount = list.filter((g) => g.enabled).length;
              const active = managerTier === tier;
              return (
                <button
                  key={tier}
                  type="button"
                  onClick={() => setManagerTier(tier)}
                  className={
                    "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-colors " +
                    (active
                      ? "border-brand-border bg-brand-subtle text-accent"
                      : "border-ink-200 bg-surface-hover text-ink-600 hover:text-ink-900")
                  }
                >
                  <span>{tierLabel(tier)}</span>
                  <span className="font-mono text-[11px] opacity-80">
                    {enabledCount}/{list.length}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-3 max-h-[340px] divide-y divide-ink-100 overflow-y-auto rounded-lg border border-ink-200">
            {managerGroups.length === 0 ? (
              <div className="py-8 text-center text-[12px] text-ink-400">
                {t("当前分组下没有匹配的微信群")}
              </div>
            ) : (
              managerGroups.map((grp) => {
                const busy = togglingGroupKey === grp.groupKey;
                return (
                  <div
                    key={grp.groupKey}
                    className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 hover:bg-surface-hover"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[13px] font-medium text-ink-900">
                          {grp.name}
                        </span>
                        {grp.linkedBookTitle && (
                          <span className="inline-flex max-w-[220px] items-center gap-1 truncate rounded bg-deal-subtle px-1.5 py-0.5 text-[11px] text-deal">
                            <BookOpen size={11} className="shrink-0" />
                            <span className="truncate">{grp.linkedBookTitle}</span>
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-3 font-mono text-[11px] text-ink-500">
                        <span>{t("有效 {n} 条", { n: grp.validMessageCount })}</span>
                        <span>{t("提纯 {n} 条", { n: grp.digestCount })}</span>
                        {grp.lastMsgTime > 0 && (
                          <span>{t("最近活跃 {time}", { time: formatDateTime(grp.lastMsgTime) })}</span>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedGroupKey(grp.groupKey);
                          setSelectedActivityId("");
                          setTierFilter("all");
                          setMessagesOffset(0);
                          setManagerOpen(false);
                        }}
                        className="rounded-md border border-ink-200 bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-700 hover:bg-ink-100"
                      >
                        {t("只看此群")}
                      </button>

                      <button
                        type="button"
                        role="switch"
                        aria-checked={grp.enabled}
                        disabled={busy}
                        onClick={() => void handleToggleGroup(grp)}
                        className={
                          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 " +
                          (grp.enabled
                            ? "border-deal-border bg-deal-solid"
                            : "border-ink-300 bg-ink-200")
                        }
                        aria-label={t("开关群聊采集")}
                      >
                        <span
                          className={
                            "inline-block h-4 w-4 rounded-full bg-knob transition-transform " +
                            (grp.enabled ? "translate-x-5" : "translate-x-1")
                          }
                        />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>
      )}

      {/* 三大主视图切换 Tab */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200">
        <div className="flex flex-wrap items-center gap-1" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "digests"}
            onClick={() => setActiveTab("digests")}
            className={
              "inline-flex items-center gap-1.5 border-b-2 px-3.5 py-2.5 text-[13px] font-medium transition-colors " +
              (activeTab === "digests"
                ? "border-accent font-semibold text-accent"
                : "border-transparent text-ink-500 hover:text-ink-900")
            }
          >
            <Sparkles size={14} />
            {t("✨ AI 提纯暗线")}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "messages"}
            onClick={() => setActiveTab("messages")}
            className={
              "inline-flex items-center gap-1.5 border-b-2 px-3.5 py-2.5 text-[13px] font-medium transition-colors " +
              (activeTab === "messages"
                ? "border-accent font-semibold text-accent"
                : "border-transparent text-ink-500 hover:text-ink-900")
            }
          >
            <Search size={14} />
            {t("🔍 跨群原话检索")}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "groups"}
            onClick={() => setActiveTab("groups")}
            className={
              "inline-flex items-center gap-1.5 border-b-2 px-3.5 py-2.5 text-[13px] font-medium transition-colors " +
              (activeTab === "groups"
                ? "border-accent font-semibold text-accent"
                : "border-transparent text-ink-500 hover:text-ink-900")
            }
          >
            <Users size={14} />
            {t("🗂️ 群源目录")}
            {groups.length > 0 && (
              <span className="rounded-full bg-ink-100 px-1.5 py-0.5 font-mono text-[10px] text-ink-600">
                {groups.length}
              </span>
            )}
          </button>
        </div>

        {activeLinkedActivityId && onOpenManualBook && (
          <button
            type="button"
            onClick={() => onOpenManualBook(activeLinkedActivityId)}
            className="mb-1.5 inline-flex items-center gap-1.5 rounded-lg border border-deal-border bg-deal-subtle px-3 py-1.5 text-[12px] font-medium text-deal transition-opacity hover:opacity-90"
          >
            <BookOpen size={13} />
            {t("📖 查看对应航海手册")}
          </button>
        )}
      </div>

      {/* 统一筛选栏 */}
      <div className="space-y-2.5 rounded-xl border border-ink-200 bg-surface p-3.5">
        <div className="flex flex-wrap items-center gap-2.5">
          {/* 关键词搜索框 */}
          <div className="relative min-w-[220px] flex-1">
            <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-400" />
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setQuery(searchInput.trim());
                  setMessagesOffset(0);
                }
              }}
              placeholder={t("搜索工具、排坑、导师点评或群聊原话关键词…")}
              aria-label={t("搜索群聊关键词")}
              className="w-full rounded-lg border border-ink-200 bg-surface-hover py-2 pr-8 pl-9 text-[13px] text-ink-950 placeholder:text-ink-400 focus:border-accent focus:outline-none"
            />
            {searchInput && (
              <button
                type="button"
                aria-label={t("清空搜索词")}
                onClick={() => {
                  setSearchInput("");
                  setQuery("");
                  setMessagesOffset(0);
                }}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
              >
                <X size={13} />
              </button>
            )}
          </div>

          {/* 指定单个群下拉框 */}
          <select
            aria-label={t("按单个微信群筛选")}
            value={selectedGroupKey}
            onChange={(e) => {
              const val = e.target.value;
              setSelectedGroupKey(val);
              if (val) setSelectedActivityId("");
              setMessagesOffset(0);
            }}
            className="max-w-full rounded-lg border border-ink-200 bg-surface-hover px-3 py-2 text-[12px] text-ink-800 focus:border-accent focus:outline-none sm:max-w-[260px]"
          >
            <option value="">{t("全部群（不限单个群）")}</option>
            {TIER_ORDER.map((tier) => {
              const list = groupsByTier[tier];
              if (!list.length) return null;
              return (
                <optgroup key={tier} label={tierLabel(tier)}>
                  {list.map((g) => (
                    <option key={g.groupKey} value={g.groupKey}>
                      {g.name}
                      {g.enabled ? "" : ` (${t("未启用")})`}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearAllFilters}
              className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-2 text-[12px] font-medium text-ink-600 hover:bg-ink-100 hover:text-ink-900"
            >
              <X size={12} />
              {t("清除筛选")}
            </button>
          )}
        </div>

        {/* 群范围快选胶囊 + 当前激活的航海项目筛选提示 */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 inline-flex items-center gap-1 text-[11px] font-medium text-ink-400">
            <Filter size={11} />
            {t("群范围：")}
          </span>

          {(
            [
              { key: "all", label: t("全部高纯度群") },
              { key: "core", label: t("核心内测与X群") },
              { key: "voyage", label: t("11月大航海群") },
              { key: "regional", label: t("地域交流群") },
            ] as const
          ).map((opt) => {
            const active = tierFilter === opt.key && !selectedGroupKey && !selectedActivityId;
            return (
              <button
                key={opt.key}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setTierFilter(opt.key);
                  setSelectedGroupKey("");
                  setSelectedActivityId("");
                  setMessagesOffset(0);
                }}
                className={
                  "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors " +
                  (active
                    ? "border-brand-border bg-brand-subtle text-accent"
                    : "border-ink-200 bg-surface-hover text-ink-600 hover:text-ink-900")
                }
              >
                {opt.label}
              </button>
            );
          })}

          {selectedActivityId && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-deal-border bg-deal-subtle px-2.5 py-1 text-[11px] font-medium text-deal">
              <BookOpen size={11} />
              <span>
                {activeActivityBookTitle
                  ? t("航海项目：{title}", { title: activeActivityBookTitle })
                  : t("航海项目 #{id}", { id: selectedActivityId })}
              </span>
              <button
                type="button"
                aria-label={t("取消航海项目筛选")}
                onClick={() => {
                  setSelectedActivityId("");
                  setMessagesOffset(0);
                }}
                className="rounded-full p-0.5 hover:bg-surface/60"
              >
                <X size={11} />
              </button>
            </span>
          )}

          {selectedGroup && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-border bg-brand-subtle px-2.5 py-1 text-[11px] font-medium text-accent">
              <span>{selectedGroup.name}</span>
              <button
                type="button"
                aria-label={t("取消单群筛选")}
                onClick={() => {
                  setSelectedGroupKey("");
                  setMessagesOffset(0);
                }}
                className="rounded-full p-0.5 hover:bg-surface/60"
              >
                <X size={11} />
              </button>
            </span>
          )}
        </div>
      </div>

      {/* 子视图 1：✨ AI 提纯暗线 */}
      {activeTab === "digests" && (
        <section className="space-y-3">
          {/* 四分类胶囊过滤 */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                aria-pressed={categoryFilter === "all"}
                onClick={() => setCategoryFilter("all")}
                className={
                  "rounded-full border px-3 py-1 text-[12px] font-medium transition-colors " +
                  (categoryFilter === "all"
                    ? "border-solid bg-solid text-on-solid"
                    : "border-ink-200 bg-surface text-ink-600 hover:bg-surface-hover")
                }
              >
                {t("全部分类")}
              </button>
              {CHAT_DIGEST_CATEGORIES.map((cat) => {
                const active = categoryFilter === cat;
                return (
                  <button
                    key={cat}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setCategoryFilter(cat)}
                    className={
                      "rounded-full border px-3 py-1 text-[12px] font-medium transition-colors " +
                      (active
                        ? categoryBadgeClass(cat)
                        : "border-ink-200 bg-surface text-ink-600 hover:bg-surface-hover")
                    }
                  >
                    {t(cat)}
                  </button>
                );
              })}
            </div>
            <span className="font-mono text-[11px] text-ink-400">
              {t("共 {n} 条洞察", { n: visibleDigests.length })}
            </span>
          </div>

          {digestsError && (
            <div role="alert" className="rounded-xl border border-alert-border bg-alert-subtle p-4 text-[13px] text-alert">
              {t("AI 提纯洞察加载失败：")}{digestsError}
            </div>
          )}

          {digestsLoading && !visibleDigests.length ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-400">
              <Loader2 size={15} className="animate-spin" />
              {t("正在加载 AI 提纯暗线…")}
            </div>
          ) : !visibleDigests.length ? (
            <div className="rounded-xl border border-ink-200 bg-surface-hover px-6 py-14 text-center">
              <Sparkles size={26} className="mx-auto mb-2.5 text-ink-300" />
              <div className="text-[15px] font-semibold text-ink-900">
                {hasActiveFilters || categoryFilter !== "all"
                  ? t("当前筛选条件下暂无 AI 提纯洞察")
                  : t("尚未生成群聊 AI 提纯暗线")}
              </div>
              <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-ink-500">
                {canAdmin
                  ? t("可点击右上角「增量同步群消息」与「AI 提纯最新干货」，或切换至「🔍 跨群原话检索」直接查看群内讨论。")
                  : t("暂未匹配到符合条件的群聊洞察，可以放宽筛选条件或切换到「🔍 跨群原话检索」检索原话。")}
              </p>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {visibleDigests.map((item) => (
                <article
                  key={item.id}
                  className="flex min-w-0 flex-col justify-between rounded-xl border border-ink-200 bg-surface p-4 transition-colors hover:border-ink-300"
                >
                  <div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span
                          className={
                            "rounded-md border px-2 py-0.5 text-[11px] font-semibold " +
                            categoryBadgeClass(item.category)
                          }
                        >
                          {t(item.category)}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedGroupKey(item.groupKey);
                            setSelectedActivityId("");
                            setTierFilter("all");
                          }}
                          className="max-w-[200px] truncate rounded-md border border-ink-200 bg-surface-hover px-2 py-0.5 text-[11px] font-medium text-ink-700 hover:border-ink-300 hover:text-ink-950"
                          title={item.groupName}
                        >
                          {item.groupName}
                        </button>
                      </div>
                      <span className="shrink-0 font-mono text-[11px] text-ink-400">
                        {formatTimeRange(item.msgTimeFrom, item.msgTimeTo)}
                      </span>
                    </div>

                    <h3 className="mt-2.5 text-[15px] leading-snug font-semibold text-ink-950 [overflow-wrap:anywhere] break-words">
                      <HighlightText text={item.title} query={query} />
                    </h3>

                    <p className="mt-2 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-700 [overflow-wrap:anywhere] break-words">
                      <HighlightText text={item.summary} query={query} />
                    </p>

                    {item.keySpeakers.length > 0 && (
                      <div className="mt-3 flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] text-ink-400">{t("关键发言：")}</span>
                        {item.keySpeakers.map((speaker, idx) => (
                          <span
                            key={`${speaker}-${idx}`}
                            className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-700"
                          >
                            {speaker}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 border-t border-ink-100 pt-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          void openContextDrawer(
                            item.groupKey,
                            item.msgTimeFrom || item.msgTimeTo,
                            item.title,
                          )
                        }
                        className="inline-flex items-center gap-1.5 rounded-lg bg-brand-subtle px-2.5 py-1.5 text-[12px] font-medium text-accent transition-colors hover:opacity-90"
                      >
                        <MessageSquare size={12} />
                        {t("查看原群上下文")}
                      </button>

                      {item.linkedActivityId && onOpenManualBook && (
                        <button
                          type="button"
                          onClick={() => onOpenManualBook(item.linkedActivityId!)}
                          className="inline-flex max-w-[200px] items-center gap-1 rounded-lg border border-deal-border bg-deal-subtle px-2.5 py-1.5 text-[11px] font-medium text-deal transition-opacity hover:opacity-90"
                          title={item.linkedBookTitle ?? undefined}
                        >
                          <BookOpen size={12} className="shrink-0" />
                          <span className="truncate">
                            {t("📖 关联手册")}
                          </span>
                        </button>
                      )}
                    </div>

                    {item.model && (
                      <span className="font-mono text-[10px] text-ink-400">{item.model}</span>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {/* 子视图 2：🔍 跨群原话检索 */}
      {activeTab === "messages" && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-ink-600 select-none">
              <input
                type="checkbox"
                checked={includeNoise}
                onChange={(e) => {
                  setIncludeNoise(e.target.checked);
                  setMessagesOffset(0);
                }}
                className="h-3.5 w-3.5 rounded border-ink-300 accent-accent"
              />
              <span>{t("包含水帖/复读噪音（如 +1、收到、感谢点评）")}</span>
            </label>

            <span className="font-mono text-[11px] text-ink-500">
              {t("共命中 {n} 条真实发言", { n: messagesTotal.toLocaleString() })}
            </span>
          </div>

          {messagesError && (
            <div role="alert" className="rounded-xl border border-alert-border bg-alert-subtle p-4 text-[13px] text-alert">
              {t("群聊消息检索失败：")}{messagesError}
            </div>
          )}

          {messagesLoading && !messages.length ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-400">
              <Loader2 size={15} className="animate-spin" />
              {t("正在检索跨群原话记录…")}
            </div>
          ) : !messages.length ? (
            <div className="rounded-xl border border-ink-200 bg-surface-hover px-6 py-14 text-center">
              <Search size={26} className="mx-auto mb-2.5 text-ink-300" />
              <div className="text-[15px] font-semibold text-ink-900">
                {t("没有找到匹配的群聊原话")}
              </div>
              <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-ink-500">
                {t("可以尝试更换关键词、放宽群范围筛选，或勾选「包含水帖/复读噪音」后再试。")}
              </p>
            </div>
          ) : (
            <>
              <div className="divide-y divide-ink-100 overflow-hidden rounded-xl border border-ink-200 bg-surface">
                {messages.map((msg) => (
                  <button
                    key={`${msg.groupKey}-${msg.msgId}`}
                    type="button"
                    onClick={() => void openContextDrawer(msg.groupKey, msg.msgTime)}
                    className={
                      "flex w-full min-w-0 flex-col items-start gap-1.5 px-4 py-3 text-left transition-colors hover:bg-surface-hover " +
                      (msg.isNoise ? "opacity-75" : "")
                    }
                  >
                    <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="text-[13px] font-semibold text-ink-950">
                          {msg.senderName || t("群友")}
                        </span>
                        <span className="max-w-[220px] truncate rounded border border-ink-200 bg-surface-hover px-2 py-0.5 text-[11px] font-medium text-ink-700">
                          {msg.groupName}
                        </span>
                        <span
                          className={
                            "rounded border px-1.5 py-0.5 text-[10px] font-medium " +
                            tierBadgeClass(msg.tier)
                          }
                        >
                          {tierLabel(msg.tier)}
                        </span>
                        {msg.isNoise && (
                          <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] text-ink-500">
                            {t("已标噪音")}
                          </span>
                        )}
                      </div>
                      <span className="shrink-0 font-mono text-[11px] text-ink-400">
                        {formatDateTime(msg.msgTime)}
                      </span>
                    </div>

                    <p className="w-full text-[13px] leading-relaxed whitespace-pre-wrap text-ink-800 [overflow-wrap:anywhere] break-words">
                      <HighlightText text={msg.content} query={query} />
                    </p>

                    <span className="text-[11px] font-medium text-accent">
                      {t("点击展开前后 30 条真实群聊上下文 →")}
                    </span>
                  </button>
                ))}
              </div>

              {messagesTotal > PAGE_SIZE && (
                <div className="flex items-center justify-between pt-2">
                  <span className="font-mono text-[12px] text-ink-500">
                    {t("第 {page} / {total} 页", { page: currentPage, total: totalPages })}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={messagesOffset === 0 || messagesLoading}
                      onClick={() => setMessagesOffset((o) => Math.max(0, o - PAGE_SIZE))}
                      className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-700 hover:bg-ink-100 disabled:opacity-45"
                    >
                      <ChevronLeft size={13} />
                      {t("上一页")}
                    </button>
                    <button
                      type="button"
                      disabled={messagesOffset + PAGE_SIZE >= messagesTotal || messagesLoading}
                      onClick={() => setMessagesOffset((o) => o + PAGE_SIZE)}
                      className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-700 hover:bg-ink-100 disabled:opacity-45"
                    >
                      {t("下一页")}
                      <ChevronRight size={13} />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* 子视图 3：🗂️ 群源目录 */}
      {activeTab === "groups" && (
        <section className="space-y-3">
          <div className="flex items-center justify-between text-[12px] text-ink-500">
            <span>{t("按分层查看已接入微信群的同步进度、有效消息量与航海手册关联")}</span>
            <span className="font-mono text-[11px] text-ink-400">
              {t("共 {n} 个群", { n: directoryGroups.length })}
            </span>
          </div>

          {groupsLoading && !groups.length ? (
            <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-ink-400">
              <Loader2 size={15} className="animate-spin" />
              {t("正在加载群源目录…")}
            </div>
          ) : !directoryGroups.length ? (
            <div className="rounded-xl border border-ink-200 bg-surface-hover px-6 py-14 text-center text-[13px] text-ink-500">
              {t("当前筛选条件下没有匹配的微信群")}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {directoryGroups.map((grp) => (
                <div
                  key={grp.groupKey}
                  className="flex min-w-0 flex-col justify-between rounded-xl border border-ink-200 bg-surface p-3.5 transition-colors hover:border-ink-300"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 flex-1 text-[14px] font-semibold text-ink-950 [overflow-wrap:anywhere] break-words">
                        {grp.name}
                      </span>
                      <span
                        className={
                          "shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium " +
                          tierBadgeClass(grp.tier)
                        }
                      >
                        {tierLabel(grp.tier)}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-500">
                      <span className={grp.enabled ? "text-deal" : "text-ink-400"}>
                        {grp.enabled ? t("采集中") : t("已暂停")}
                      </span>
                      <span>·</span>
                      <span>{t("有效 {n} 条", { n: grp.validMessageCount })}</span>
                      <span>·</span>
                      <span>{t("洞察 {n} 条", { n: grp.digestCount })}</span>
                    </div>

                    {grp.lastMsgTime > 0 && (
                      <div className="mt-1 font-mono text-[11px] text-ink-400">
                        {t("最新发言：{time}", { time: formatDateTime(grp.lastMsgTime) })}
                      </div>
                    )}
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-2.5">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedGroupKey(grp.groupKey);
                        setSelectedActivityId("");
                        setTierFilter("all");
                        setActiveTab("digests");
                      }}
                      className="rounded-lg bg-brand-subtle px-2.5 py-1 text-[11px] font-medium text-accent hover:opacity-90"
                    >
                      {t("看提纯暗线")}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedGroupKey(grp.groupKey);
                        setSelectedActivityId("");
                        setTierFilter("all");
                        setMessagesOffset(0);
                        setActiveTab("messages");
                      }}
                      className="rounded-lg border border-ink-200 bg-surface-hover px-2.5 py-1 text-[11px] font-medium text-ink-700 hover:bg-ink-100"
                    >
                      {t("搜群原话")}
                    </button>
                    {grp.linkedActivityId && onOpenManualBook && (
                      <button
                        type="button"
                        onClick={() => onOpenManualBook(grp.linkedActivityId!)}
                        className="inline-flex items-center gap-1 rounded-lg border border-deal-border bg-deal-subtle px-2 py-1 text-[11px] font-medium text-deal hover:opacity-90"
                        title={grp.linkedBookTitle ?? undefined}
                      >
                        <BookOpen size={11} />
                        {t("手册")}
                      </button>
                    )}
                    {canAdmin && (
                      <button
                        type="button"
                        disabled={togglingGroupKey === grp.groupKey}
                        onClick={() => void handleToggleGroup(grp)}
                        className="ml-auto inline-flex items-center gap-1 rounded-lg border border-ink-200 px-2 py-1 text-[11px] text-ink-600 hover:bg-ink-100 disabled:opacity-50"
                      >
                        {grp.enabled && <Check size={11} className="text-deal" />}
                        {grp.enabled ? t("停用") : t("启用")}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* 右侧原群上下文对话流抽屉（前后 30 条真实消息还原问答） */}
      {contextOpen && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-overlay backdrop-enter"
          onClick={(e) => {
            if (e.target === e.currentTarget) setContextOpen(false);
          }}
        >
          <aside
            role="dialog"
            aria-modal="true"
            aria-label={t("原群聊上下文对话流")}
            className="drawer-enter drawer-shadow flex h-full w-full max-w-2xl flex-col bg-surface"
          >
            <header className="flex items-start justify-between gap-3 border-b border-ink-200 px-5 py-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 text-[15px] font-semibold text-ink-950">
                    <MessageSquare size={16} className="shrink-0 text-accent" />
                    <span className="truncate">
                      {contextData?.groupName || t("原群聊上下文对话流")}
                    </span>
                  </span>
                  {contextData && (
                    <span className="font-mono text-[11px] text-ink-400">
                      {t("前后共 {n} 条", { n: contextData.items.length })}
                    </span>
                  )}
                </div>
                {contextTitle && (
                  <p className="mt-1 line-clamp-2 text-[12px] text-ink-600 [overflow-wrap:anywhere] break-words">
                    {contextTitle}
                  </p>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {contextData?.linkedActivityId && onOpenManualBook && (
                  <button
                    type="button"
                    onClick={() => {
                      const actId = contextData.linkedActivityId!;
                      setContextOpen(false);
                      onOpenManualBook(actId);
                    }}
                    className="inline-flex items-center gap-1 rounded-lg border border-deal-border bg-deal-subtle px-2.5 py-1.5 text-[11px] font-medium text-deal hover:opacity-90"
                  >
                    <BookOpen size={12} />
                    {t("📖 关联手册")}
                  </button>
                )}
                <button
                  type="button"
                  aria-label={t("关闭上下文抽屉")}
                  onClick={() => setContextOpen(false)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-ink-200 text-ink-500 hover:bg-ink-100 hover:text-ink-900"
                >
                  <X size={15} />
                </button>
              </div>
            </header>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              {contextLoading ? (
                <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-ink-400">
                  <Loader2 size={16} className="animate-spin" />
                  {t("正在加载原群上下文对话流…")}
                </div>
              ) : contextError ? (
                <div role="alert" className="rounded-xl border border-alert-border bg-alert-subtle p-4 text-[13px] text-alert">
                  {t("原群上下文加载失败：")}{contextError}
                </div>
              ) : !contextData || !contextData.items.length ? (
                <div className="py-16 text-center text-[13px] text-ink-400">
                  {t("暂无可展示的群聊上下文记录")}
                </div>
              ) : (
                <div className="space-y-2.5">
                  {contextData.items.map((msg) => {
                    const isAnchor = msg.msgId === anchorMsgId;
                    return (
                      <div
                        key={`${msg.groupKey}-${msg.msgId}`}
                        ref={isAnchor ? anchorMsgRef : undefined}
                        className={
                          "rounded-xl border p-3 transition-colors " +
                          (isAnchor
                            ? "border-brand-border bg-brand-subtle/70 shadow-xs"
                            : msg.isNoise
                              ? "border-ink-100 bg-surface-hover/50 opacity-65"
                              : "border-ink-200 bg-surface-hover")
                        }
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-[12px] font-semibold text-ink-950">
                              {msg.senderName || t("群友")}
                            </span>
                            {isAnchor && (
                              <span className="rounded bg-accent-solid px-1.5 py-0.5 text-[10px] font-medium text-on-solid">
                                {t("定位消息")}
                              </span>
                            )}
                            {msg.isNoise && (
                              <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] text-ink-500">
                                {t("噪音")}
                              </span>
                            )}
                          </div>
                          <span className="font-mono text-[11px] text-ink-400">
                            {formatDateTime(msg.msgTime)}
                          </span>
                        </div>
                        <p className="mt-1.5 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-800 [overflow-wrap:anywhere] break-words">
                          <HighlightText text={msg.content} query={query} />
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
