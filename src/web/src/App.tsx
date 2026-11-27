import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlignJustify,
  Bell,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  EyeOff,
  Lock,
  LayoutGrid,
  Loader2,
  Radar,
  RefreshCw,
  Search,
  ShieldBan,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  FolderOpen,
  Wrench,
  X,
  Zap,
  Code,
  Compass,
  CheckCheck,
  Flame,
  Newspaper,
  TrendingUp,
  MapPin,
  User,
  Globe2,
  Github,
  BookOpen,
  MoreHorizontal,
  LogOut,
  Flag,
} from "lucide-react";
import { CompactRow, ItemCard, ItemDetailDrawer, QuickBlockModal } from "./components/ItemView.tsx";
import { AdminGate } from "./components/AdminGate.tsx";
import { LangSwitch } from "./components/LangSwitch.tsx";
import { ThemeSwitch } from "./components/ThemeSwitch.tsx";
import { WorkspaceScopeBar } from "./components/WorkspaceScope.tsx";
import { FeedViewSwitch } from "./components/FeedViewSwitch.tsx";
import { FeedToolbar } from "./components/FeedToolbar.tsx";
import { ActiveFilters, type FilterKey } from "./components/ActiveFilters.tsx";
import { SourcePanel } from "./components/SourcePanel.tsx";
import { ADMIN_AUTH_EVENT } from "./lib/auth.ts";
import { t } from "./lib/i18n.ts";
import { DEFAULT_FEED_STATE, buildFeedQuery, buildStatsQuery, countAdditionalFilters, feedPolicyLabels, readFeedState, writeFeedSearch, type FeedState } from "./lib/feedQuery.ts";
import { configurationBase, configurationScope, readTab, readWorkspaceScope, tabUrl, type Tab, type WorkspaceScope } from "./lib/navigation.ts";
import {
  guestAddBlock,
  guestBatch,
  guestBlocks,
  guestPatch,
  importGuestToAccount,
  selectGuestItems,
  readGuest,
  useBootstrap,
  type GuestState,
} from "./lib/session.ts";
import { AuthModal } from "./components/AuthModal.tsx";
import { WelcomeModal } from "./components/WelcomeModal.tsx";
import { RssModal } from "./components/RssModal.tsx";
import { UpstreamWatchBanner } from "./components/UpstreamWatchBanner.tsx";
import type { DigestReport } from "../../shared/digest.ts";
import { KIND_LABEL, KIND_ORDER, OBTAIN_HINT, OBTAIN_LABEL, SOURCE_GROUPS, categoriesForPreset, categoryLabelForPreset, channelExcluded, formatInterval, groupOfSource } from "./lib/sources.ts";

// 管理区 / 次要 Tab 的大面板按需加载：首屏只发资源流真正要用的代码
const DigestPanel = lazy(async () => ({ default: (await import("./components/DigestPanel.tsx")).DigestPanel }));
const TracksPanel = lazy(async () => ({ default: (await import("./components/TracksPanel.tsx")).TracksPanel }));
const HotPanel = lazy(async () => ({ default: (await import("./components/HotPanel.tsx")).HotPanel }));
const RulesPanel = lazy(async () => ({ default: (await import("./components/RulesPanel.tsx")).RulesPanel }));
const PushPanel = lazy(async () => ({ default: (await import("./components/PushPanel.tsx")).PushPanel }));
const AiPanel = lazy(async () => ({ default: (await import("./components/AiPanel.tsx")).AiPanel }));
const OpsPanel = lazy(async () => ({ default: (await import("./components/OpsPanel.tsx")).OpsPanel }));
const SiteAdminPanel = lazy(async () => ({ default: (await import("./components/SiteAdminPanel.tsx")).SiteAdminPanel }));
const UserPushPanel = lazy(async () => ({ default: (await import("./components/UserPushPanel.tsx")).UserPushPanel }));
import type {
  BlockPreset,
  BlockRule,
  HotReport,
  HotScope,
  Item,
  PushLogItem,
  AiPayload,
  PushPayload,
  PushPreview,
  PushSettings,
  Run,
  Source,
  Stats,
  Subscription,
} from "./types.ts";

const SOURCE_LABEL: Record<string, string> = {
  "linuxdo-welfare": t("LINUX DO · 福利羊毛"),
  "linuxdo-resource": t("LINUX DO · 资源荟萃"),
  "v2ex-free": t("V2EX · 免费赠送"),
  "github-free-for-dev": "GitHub · free-for-dev",
  "rss-fuliba": t("福利吧"),
  "rss-52pojie": t("吾爱破解"),
  "rss-smzdm": t("什么值得买"),
  "zhihu-search": t("知乎 · 福利搜索"),
  "xhs-search": t("小红书 · 福利搜索"),
  "xiaoheihe-search": t("小黑盒 · 福利搜索"),
  "tg-channels": t("Telegram 频道"),
  gamerpower: t("GamerPower · 免费游戏"),
  "epic-free": t("Epic Games · 喜加一"),
  "rss-reddit-freegames": "Reddit · FreeGameFindings",
  "rss-reddit-efreebies": "Reddit · eFreebies",
  "rss-reddit-gamedeals": "Reddit · GameDeals",
  "rss-slickdeals": "Slickdeals",
  "rss-heyitsfree": "HeyItsFree",
  "rss-keylol": t("其乐 Keylol"),
  "openrouter-free": t("OpenRouter · 新免费大模型"),
  "gamerpower-loot": t("GamerPower · 免费礼包与 Key"),
  "rss-itch-free": t("itch.io · 100% 限免游戏"),
  "rss-freesteamkeys": t("FreeSteamKeys · Steam 限免"),
  "rss-ghxi": t("果核剥壳 · 免费软件"),
};

let SOURCE_NAMES: Record<string, string> = { ...SOURCE_LABEL };
const sourceName = (id: string) => SOURCE_NAMES[id] ?? SOURCE_LABEL[id] ?? id;


function useApi<T>(url: string | null, scope = ""): { data: T | null; loading: boolean; error: string | null; reload: () => void; update: (updater: (current: T | null) => T | null) => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [loadedKey, setLoadedKey] = useState("");
  const key = (url ?? "") + ":" + scope;
  const update = useCallback((updater: (current: T | null) => T | null) => {
    setData(updater);
    setLoadedKey(key);
  }, [key]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!url) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    fetch(url, { signal: ac.signal, cache: nonce > 0 ? "no-cache" : "default" })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error ?? `${r.status} ${r.statusText}`);
        }
        return (await r.json()) as T;
      })
      .then((d) => {
        if (!ac.signal.aborted) { setData(d); setLoadedKey(key); setError(null); }
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setLoadedKey(key);
        setData(null);
        setError(String(e));
      })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [url, nonce, key]);

  return { data: url && loadedKey === key ? data : null, loading: Boolean(url) && (loading || loadedKey !== key), error: url && loadedKey === key ? error : null, reload, update };
}

function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div role="status" aria-live="polite" className="toast-enter fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-lg border border-ink-700 bg-solid px-3.5 py-2 text-[12px] font-medium text-on-solid shadow-lg">
      <Bell size={14} className="text-ink-300" />
      {message}
    </div>
  );
}

type Preset = { key: string; label: string; icon: typeof Sparkles };

const PRIMARY_CHANNELS: Preset[] = [
  { key: "picks", label: t("精选干货"), icon: Flame },
  { key: "dossiers", label: t("立项拆解"), icon: Zap },
  { key: "manuals", label: t("航海手册"), icon: BookOpen },
  { key: "projects", label: t("项目案例"), icon: Compass },
  { key: "tools", label: t("开源与工具"), icon: Code },
  { key: "perks", label: t("福利与资料"), icon: Sparkles },
];

const NON_PRICE_PRESETS = new Set(["news", "info", "opensource", "picks", "dossiers", "manuals", "projects", "tools"]);

const SECONDARY_VIEWS: Preset[] = [
  { key: "top5", label: t("5星必读"), icon: Sparkles },
  { key: "starred", label: t("我的收藏"), icon: Check },
  { key: "all", label: t("全部收录"), icon: AlignJustify },
  { key: "hidden", label: t("已关闭"), icon: EyeOff },
  // 待复核：AI 判成福利但证据里没有可领取对象，公开站看不到，只有管理员能处理
  { key: "review", label: t("待复核"), icon: Flag },
];

const PRESETS: Preset[] = [...PRIMARY_CHANNELS, ...SECONDARY_VIEWS];


// 主仓库地址：顶栏 GitHub 图标跳这里
const REPO_URL = "https://github.com/spacker-343-forks/freebie-radar";
// 移动端顶栏图标按钮统一尺寸，5 个并排也不挤
const ICON_BTN =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-ink-200 bg-surface text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-950";
const ADMIN_TABS = new Set<Tab>(["rules", "push", "ai", "ops", "site"]);
const ADMIN_ENTRIES = [
  { key: "rules" as const, label: t("订阅与屏蔽"), desc: t("关键词订阅、屏蔽词防火墙"), icon: ShieldBan },
  { key: "push" as const, label: t("推送规则"), desc: t("推送时机、阈值、格式与免打扰"), icon: Zap },
  { key: "ai" as const, label: t("AI 引擎"), desc: t("规则初筛、审核模型、提示词与补审"), icon: Bot },
  { key: "ops" as const, label: t("数据源运维"), desc: t("采集开关、间隔、数据清理"), icon: Wrench },
  { key: "site" as const, label: t("站点设置"), desc: t("访问权限、用户、公告与版本"), icon: Globe2 },
];

export function App() {
  const [tab, setTab] = useState<Tab>(() => readTab(typeof location === "undefined" ? "" : location.hash));
  const [initialFeed] = useState(() => readFeedState(typeof location === "undefined" ? "" : location.search));
  const [workspaceScope, setWorkspaceScope] = useState<WorkspaceScope>(() => readWorkspaceScope(typeof location === "undefined" ? "" : location.search));
  const [detail, setDetail] = useState<Item | null>(null);
  const [quickBlock, setQuickBlock] = useState<Item | null>(null);
  // 合并组展开：记录展开的条目 id 与其同福利的其他来源
  const [relatedOpen, setRelatedOpen] = useState<number | null>(null);
  const [relatedMap, setRelatedMap] = useState<Record<number, (Item & { sourceName?: string })[]>>({});
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const mobileNavRef = useRef<HTMLElement | null>(null);
  const channelRef = useRef<HTMLDivElement | null>(null);
  const [channelScroll, setChannelScroll] = useState({ left: false, right: false });
  const syncChannelScroll = useCallback(() => {
    const element = channelRef.current;
    if (!element) return;
    const left = element.scrollLeft > 2, right = element.scrollLeft + element.clientWidth < element.scrollWidth - 2;
    setChannelScroll((current) => current.left === left && current.right === right ? current : { left, right });
  }, []);
  // 展开合并组时按需拉取其他来源报道（同一 title_key 的兄弟条目）
  useEffect(() => {
    const id = relatedOpen;
    if (!id || relatedMap[id]) return;
    let alive = true;
    fetch(`/api/items/${id}/related`, { headers: { accept: "application/json" } })
      .then((r) => { if (!r.ok) throw new Error(t("关联来源加载失败")); return r.json(); })
      .then((d: { items?: (Item & { sourceName?: string })[] }) => {
        if (alive && Array.isArray(d.items)) setRelatedMap((m) => ({ ...m, [id]: d.items! }));
      })
      .catch(() => {
        if (alive) { setRelatedOpen(null); setToast(t("关联来源加载失败，请稍后重试")); }
      });
    return () => { alive = false; };
  }, [relatedOpen, relatedMap]);
  // 服务端是否启用管理密码（决定是否拦截管理区）
  const [authChecked, setAuthChecked] = useState(false);
  const [protectedMode, setProtectedMode] = useState(false);
  const [adminEntryAllowed, setAdminEntryAllowed] = useState(true);
  const [adminAuthed, setAdminAuthed] = useState(false);
  useEffect(() => {
    fetch("/api/auth/check")
      .then((r) => r.json())
      .then((j: { protected?: boolean; isAdmin?: boolean; adminHostAllowed?: boolean }) => {
        const prot = Boolean(j.protected);
        setProtectedMode(prot);
        setAdminAuthed(Boolean(j.isAdmin));
        setAdminEntryAllowed(j.adminHostAllowed !== false);
      })
      .catch(() => undefined)
      .finally(() => setAuthChecked(true));
  }, []);
  const adminReady = authChecked && adminAuthed;

  const boot = useBootstrap();
  const bootData = boot.data;
  useEffect(() => { boot.reload(); }, [adminAuthed, boot.reload]);
  useEffect(() => {
    const expire = () => setAdminAuthed(false);
    window.addEventListener(ADMIN_AUTH_EVENT, expire);
    return () => window.removeEventListener(ADMIN_AUTH_EVENT, expire);
  }, []);
  const me = bootData?.user ?? null;
  useEffect(() => {
    const nav = mobileNavRef.current;
    if (!nav || window.matchMedia("(min-width: 1024px)").matches) return;
    const selected = nav.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
    if (!selected) return;
    const bounds = nav.getBoundingClientRect(), item = selected.getBoundingClientRect();
    if (item.left < bounds.left) nav.scrollLeft -= bounds.left - item.left;
    else if (item.right > bounds.right) nav.scrollLeft += item.right - bounds.right;
  }, [tab, me?.id, adminReady]);
  const isPublicSite = bootData?.siteMode === "public";
  const [authOpen, setAuthOpen] = useState(false);
  const [authHash, setAuthHash] = useState<string | null>(null);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [firstVisitNotice, setFirstVisitNotice] = useState(false);
  const [rssOpen, setRssOpen] = useState(false);
  const [guest, setGuest] = useState<GuestState>(() => readGuest());

  // 公开站未登录时，个人状态全部落 localStorage；登录后用 /api/me/* 云同步
  const guestMode = isPublicSite && !me;
  const syncGuest = useCallback(() => setGuest(readGuest()), []);

  // 入站公告按版本提示，不阻断首次浏览；完整说明由用户主动打开。
  useEffect(() => {
    if (!bootData?.onboarding?.enabled) return;
    const key = "radar_onboarding_seen_v" + bootData.onboarding.version;
    try {
      if (!localStorage.getItem(key)) setFirstVisitNotice(true);
    } catch {
      setFirstVisitNotice(true);
    }
  }, [bootData?.onboarding?.enabled, bootData?.onboarding?.version]);

  // OAuth 回跳带 #invite-required / #login-* 时自动开登录弹窗并显示对应错误
  useEffect(() => {
    const h = location.hash.replace("#", "");
    if (!h) return;
    if (h === "invite-required" || h.startsWith("login-") || h.startsWith("register-") || h === "invite-invalid" || h === "quota-full") {
      setAuthHash(h);
      setAuthOpen(true);
    }
  }, []);

  const closeWelcome = useCallback(() => {
    setWelcomeOpen(false);
    setFirstVisitNotice(false);
    if (bootData?.onboarding) {
      try {
        localStorage.setItem("radar_onboarding_seen_v" + bootData.onboarding.version, "1");
      } catch {
        /* ignore */
      }
    }
  }, [bootData?.onboarding]);

  const logout = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) { setToast(t("退出失败，请重试")); return; }
      setTab("feed");
      setDetail(null);
      boot.reload();
    } catch { setToast(t("网络异常，退出未完成，请重试")); }
  }, [boot]);

  const [search, setSearch] = useState(initialFeed.search);
  const [debounced, setDebounced] = useState(initialFeed.search.trim());
  const [source, setSource] = useState(initialFeed.source);
  const [categories, setCategories] = useState<string[]>(initialFeed.categories);
  const [catOpen, setCatOpen] = useState(false);
  const catRef = useRef<HTMLDivElement | null>(null);
  const [lang, setLang] = useState<"all" | "zh" | "en">(initialFeed.lang);
  const [sort, setSort] = useState(initialFeed.sort);
  const [range, setRange] = useState(initialFeed.range);
  const [priceCap, setPriceCap] = useState(initialFeed.priceCap);
  const [minScore, setMinScore] = useState(initialFeed.minScore);
  const [obtain, setObtain] = useState(initialFeed.obtain);
  const [kindFilter, setKindFilter] = useState(initialFeed.kindFilter);
  const [preset, setPreset] = useState(initialFeed.preset);
  const [viewMode, setViewMode] = useState<"compact" | "grid2" | "grid3">(() => {
    if (typeof localStorage === "undefined") return "compact";
    const saved = localStorage.getItem("radar_view_mode");
    return saved === "grid2" || saved === "grid3" || saved === "compact" ? saved : "compact";
  });
  const [showRowSummary, setShowRowSummary] = useState(() => {
    try { return localStorage.getItem("radar_row_summary") === "true"; } catch { return false; }
  });
  const toggleRowSummary = () => {
    setShowRowSummary((current) => {
      const next = !current;
      try { localStorage.setItem("radar_row_summary", String(next)); } catch { /* optional preference */ }
      return next;
    });
  };
  const updateViewMode = useCallback((m: "compact" | "grid2" | "grid3") => {
    setViewMode(m);
    try {
      localStorage.setItem("radar_view_mode", m);
    } catch {
      /* ignore */
    }
  }, []);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [showAllSources, setShowAllSources] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(initialFeed.unreadOnly);
  /** 移动端：顶部筛选面板（含快捷视图、数据源与筛选条）展开态 */
  const [mobileFilterBar, setMobileFilterBar] = useState(false);
  const [advancedFilters, setAdvancedFilters] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onSlash = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement | null)?.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onSlash);
    return () => window.removeEventListener("keydown", onSlash);
  }, []);
  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1900);
  }, []);

  const copyCode = useCallback(
    async (code: string) => {
      try {
        if (!navigator.clipboard) throw new Error("clipboard unavailable");
        await navigator.clipboard.writeText(code);
        notify(t("已复制兑换码 {code}", { code }));
      } catch { notify(t("复制失败，请手动选择兑换码复制")); }
    },
    [notify],
  );


  useEffect(() => {
    if (typeof location === "undefined") return;
    const sp = new URLSearchParams(location.search);
    const site = sp.get("login_ok");
    if (!site) return;
    sp.delete("login_ok");
    const nextSearch = sp.toString();
    history.replaceState(null, "", location.pathname + (nextSearch ? "?" + nextSearch : "") + "#ops");
    setTab("ops");
    notify(t("已完成 {site} 登录并回传公开福利（Cookie 仅留本机）", { site }));
  }, [notify]);

  const [, bumpNames] = useState(0);
  useEffect(() => {
    fetch("/api/sources")
      .then((r) => r.json())
      .then((d: { sources: { id: string; name: string }[] }) => {
        const m: Record<string, string> = { ...SOURCE_LABEL };
        for (const s of d.sources) if (s.name) m[s.id] = s.name;
        SOURCE_NAMES = m;
        bumpNames((n) => n + 1);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!catOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (catRef.current && !catRef.current.contains(e.target as Node)) setCatOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setCatOpen(false); catRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onEscape);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onEscape); };
  }, [catOpen]);

  const feedState = useMemo<FeedState>(() => ({
    preset, search: debounced, source, categories, lang, sort, range, priceCap, minScore, obtain, kindFilter, unreadOnly,
  }), [preset, debounced, source, categories, lang, sort, range, priceCap, minScore, obtain, kindFilter, unreadOnly]);
  const query = useMemo(() => buildFeedQuery(feedState), [feedState]);
  const statsQuery = useMemo(() => buildStatsQuery(query), [query]);
  const policyLabels = useMemo(() => feedPolicyLabels(query), [query]);
  useEffect(() => {
    const frame = requestAnimationFrame(syncChannelScroll);
    window.addEventListener("resize", syncChannelScroll);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("resize", syncChannelScroll); };
  }, [tab, preset, syncChannelScroll]);

  const switchPreset = useCallback((nextKey: string) => {
    setPreset(nextKey);
    setKindFilter("auto");
    setObtain("auto");
    setPriceCap("auto");
    setCategories((cur) => {
      const allowed = new Set(categoriesForPreset(nextKey));
      return cur.filter((c) => allowed.has(c));
    });
  }, []);

  const activeFilterCount = countAdditionalFilters(feedState);

  const resetFilters = useCallback(() => {
    setSource("");
    setCategories([]);
    setLang("all");
    setSearch("");
    setDebounced("");
    setMinScore("all");
    setUnreadOnly(false);
    setKindFilter("auto");
    setPriceCap("auto");
    setObtain("auto");
    setRange("auto");
    setSort("newest");
  }, []);
  const removeFilter = useCallback((key: FilterKey, value?: string) => {
    if (key === "search") { setSearch(""); setDebounced(""); }
    else if (key === "category") { if (value) setCategories((cur) => cur.filter((c) => c !== value)); }
    else if (key === "source") setSource("");
    else if (key === "lang") setLang("all");
    else if (key === "price") setPriceCap("auto");
    else if (key === "obtain") setObtain("auto");
    else if (key === "range") setRange("auto");
    else if (key === "score") setMinScore("all");
    else if (key === "kind") setKindFilter("auto");
    else if (key === "unread") setUnreadOnly(false);
  }, []);
  const identityScope = `${me?.id ?? "guest"}:${adminReady}`;
  const stats = useApi<Stats>(statsQuery ? `/api/stats?${statsQuery}` : "/api/stats", identityScope);
  const guestIds = guestMode && (preset === "starred" || preset === "hidden")
    ? `&ids=${(preset === "starred" ? guest.starred : guest.hidden).slice(0, 100).join(",") || "0"}` : "";
  const items = useApi<{ total: number; items: Item[] }>(`/api/items?${query}${guestIds}`, identityScope);
  // A workspace is explicit; administrator authentication never replaces personal settings.
  const effectiveScope = configurationScope(workspaceScope, isPublicSite, Boolean(me));
  const rulesBase = bootData ? configurationBase(workspaceScope, isPublicSite, Boolean(me), adminReady) : null;
  const pushBase = rulesBase ? rulesBase + "/push" : null;
  const canConfigure = Boolean(rulesBase);
  const configScopeKey = identityScope + ":" + effectiveScope;
  const subs = useApi<{ subscriptions: Subscription[] }>(rulesBase ? rulesBase + "/subscriptions" : null, configScopeKey);
  const sources = useApi<{ sources: Source[] }>("/api/sources", identityScope);
  const runs = useApi<{ runs: Run[] }>(adminReady ? "/api/runs?limit=40" : null);
  const blockRules = useApi<{ rules: BlockRule[]; totalBlocked: number; presets: BlockPreset[] }>(
    rulesBase ? rulesBase + "/block-rules" : null,
    configScopeKey,
  );
  const digests = useApi<{ digests: { date: string; created_at: string; pushed_at: string | null; kind: string; count: number }[] }>(
    "/api/digests",
  );
  const [hotHours, setHotHours] = useState(24);
  const [hotScope, setHotScope] = useState<HotScope>("all");
  const hot = useApi<HotReport>(tab === "hot" ? `/api/hot?hours=${hotHours}&scope=${hotScope}` : null);
  // 管理接口只在就绪后请求，避免公开区刷出一堆 401，也避免无密码模式卡住加载
  const push = useApi<PushPayload>(pushBase, configScopeKey);
  const ai = useApi<AiPayload>(adminReady && tab === "ai" ? "/api/ai" : null);
  const pushLogs = useApi<{ logs: PushLogItem[] }>(pushBase && tab === "push" ? pushBase + "/log?limit=40" : null, configScopeKey);
  const configurationError = tab === "rules" ? subs.error ?? blockRules.error : tab === "push" ? push.error : null;
  const configurationLoading = tab === "rules" ? subs.loading || blockRules.loading : tab === "push" ? push.loading : false;
  const [pushPreview, setPushPreview] = useState<PushPreview | null>(null);
  const [pickedDate, setPickedDate] = useState<string | null>(null);
  const activeDate = pickedDate ?? digests.data?.digests?.[0]?.date ?? null;
  const digestDetail = useApi<{
    date: string;
    text: string;
    report?: DigestReport | null;
    count: number;
    created_at: string;
    pushed_at: string | null;
    items: Item[];
  }>(activeDate && tab === "digest" ? "/api/digests/" + activeDate : null);

  const [blockedPreview, setBlockedPreview] = useState<Item[] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailNonce, setDetailNonce] = useState(0);
  const applyFeedState = useCallback((next: FeedState) => {
    setPreset(next.preset);
    setSearch(next.search); setDebounced(next.search.trim()); setSource(next.source);
    setCategories((current) => current.join(",") === next.categories.join(",") ? current : next.categories);
    setLang(next.lang); setSort(next.sort); setRange(next.range); setPriceCap(next.priceCap);
    setMinScore(next.minScore); setObtain(next.obtain); setKindFilter(next.kindFilter); setUnreadOnly(next.unreadOnly);
  }, []);
  const overlayEpoch = useRef(0);
  const closeOverlays = useCallback(() => {
    overlayEpoch.current += 1;
    setDetail(null); setQuickBlock(null); setRelatedOpen(null); setRelatedMap({});
    setPushPreview(null); setBlockedPreview(null); setCatOpen(false); setMobileFilterBar(false);
    setAuthOpen(false); setRssOpen(false); setWelcomeOpen(false); setDetailError(null); setDetailLoading(false);
  }, []);
  const contextKey = identityScope + ":" + effectiveScope + ":" + tab;
  const previousContext = useRef(contextKey);
  useEffect(() => {
    if (previousContext.current !== contextKey) closeOverlays();
    previousContext.current = contextKey;
  }, [contextKey, closeOverlays]);

  useEffect(() => {
    const restore = () => {
      const next = readFeedState(location.search);
      setTab(readTab(location.hash)); setWorkspaceScope(readWorkspaceScope(location.search));
      applyFeedState(next);
      closeOverlays();
    };
    window.addEventListener("popstate", restore); window.addEventListener("hashchange", restore);
    return () => { window.removeEventListener("popstate", restore); window.removeEventListener("hashchange", restore); };
  }, [closeOverlays, applyFeedState]);

  useEffect(() => {
    const p = new URLSearchParams(writeFeedSearch(location.search, feedState));
    if (workspaceScope === "site") p.set("workspace", "site"); else p.delete("workspace");
    const search = p.toString();
    const url = tabUrl(location.pathname, search ? "?" + search : "", tab);
    if (url !== location.pathname + location.search + location.hash) history.replaceState(history.state, "", url);
  }, [feedState, tab, workspaceScope]);
  const detailId = detail?.id;
  useEffect(() => {
    if (!detailId) return;
    const ac = new AbortController();
    setDetailLoading(true); setDetailError(null);
    fetch(`/api/items/${detailId}`, { signal: ac.signal }).then(async (res) => {
      if (!res.ok) throw new Error(t("详情加载失败，请重试"));
      return await res.json() as Item;
    }).then((full) => {
      if (!ac.signal.aborted) setDetail((current) => current?.id === detailId ? { ...current, ...full } : current);
    }).catch((err: unknown) => { if (!ac.signal.aborted) setDetailError(String(err)); })
      .finally(() => { if (!ac.signal.aborted) setDetailLoading(false); });
    return () => ac.abort();
  }, [detailId, detailNonce]);

  const patch = useCallback(
    async (id: number, body: Record<string, unknown>) => {
      if (!bootData) { notify(t("站点配置加载中，请稍后重试")); return; }
      // 公开站未登录：只改本机 localStorage，不发请求，谁也不影响
      if (guestMode) {
        guestPatch(id, body as { starred?: boolean; read?: boolean; status?: string });
        syncGuest();
        if (detail && detail.id === id) {
          const next = readGuest();
          setDetail({
            ...detail,
            starred: next.starred.includes(id),
            read: next.read.includes(id),
          });
        }
        return;
      }
      const url = isPublicSite ? `/api/me/items/${id}` : `/api/items/${id}`;
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        notify(err.error ?? t("操作失败"));
        return;
      }
      items.reload();
      stats.reload();
      if (detail && detail.id === id) {
        const next = await fetch(`/api/items/${id}`).then((r) => r.json());
        setDetail((current) => current?.id === id ? next as Item : current);
      }
    },
    [items, stats, detail, guestMode, isPublicSite, syncGuest, notify, bootData],
  );

  const addRule = useCallback(
    async (pattern: string, mode: "keyword" | "regex", scope: string) => {
      // 公开站：登录用户写自己的规则，访客写本机 localStorage
      if (guestMode) {
        guestAddBlock(pattern);
        syncGuest();
        notify(t("已在本机屏蔽「{pattern}」", { pattern }));
        items.reload();
        return;
      }
      const ruleUrl = rulesBase + "/block-rules";
      const res = await fetch(ruleUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pattern, mode, scope }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        notify(err.error ?? t("添加失败"));
        throw new Error(err.error ?? t("添加失败"));
      }
      notify(t("已屏蔽「{pattern}」", { pattern }));
      blockRules.reload();
      items.reload();
      stats.reload();
      setBlockedPreview(null);
      setRelatedMap({});
    },
    [blockRules, items, stats, notify, guestMode, rulesBase, syncGuest],
  );

  const quickBlockAdd = useCallback(
    async (pattern: string, scope: string) => {
      await addRule(pattern, "keyword", scope);
    },
    [addRule],
  );

  const addSubscription = useCallback(
    async (kw: string) => {
      if (guestMode) {
        notify(t("登录后才能订阅关键词（访客偏好只存在本机）"));
        return;
      }
      const res = await fetch(rulesBase + "/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keyword: kw }),
      });
      if (!res.ok) { notify(((await res.json()) as { error?: string }).error ?? t("订阅失败")); throw new Error(t("订阅失败")); }
      subs.reload();
      items.reload();
      notify(t("已订阅「{kw}」", { kw }));
    },
    [subs, items, notify, guestMode, rulesBase],
  );

  const removeSubscription = useCallback(
    async (id: number) => {
      const res = await fetch(rulesBase + "/subscriptions/" + id, { method: "DELETE" });
      if (!res.ok) { notify(t("删除关注词失败")); return; }
      subs.reload();
      items.reload();
    },
    [subs, items, rulesBase, notify],
  );

  const refreshAll = useCallback(() => {
    items.reload();
    stats.reload();
    sources.reload();
    runs.reload();
    blockRules.reload();
    setRelatedMap({});
  }, [items, stats, sources, runs, blockRules]);

  const markVisibleRead = useCallback(async () => {
    const page = guestMode ? selectGuestItems(items.data?.items ?? [], guest, preset, unreadOnly) : items.data?.items ?? [];
    const unreadIds = page.filter((i) => !i.read).map((i) => i.id);
    if (!unreadIds.length) return;
    if (guestMode) {
      guestBatch(unreadIds, "read");
      syncGuest();
      notify(t("已在本机把 {n} 条标为已读", { n: unreadIds.length }));
      return;
    }
    const res = await fetch(isPublicSite ? "/api/me/items/batch" : "/api/items/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: unreadIds, action: "read" }),
    });
    if (!res.ok) { notify(t("标记已读失败，请重试")); return; }
    notify(t("已将本页 {n} 条标为已读", { n: unreadIds.length }));
    items.reload();
    stats.reload();
  }, [items, stats, notify, guestMode, isPublicSite, syncGuest, guest, preset, unreadOnly]);

// 访客本地隐藏 / 收藏 / 已读与本地屏蔽词在客户端生效；登录用户由服务端按 user_item_states 过滤
  const visible = guestMode ? selectGuestItems(items.data?.items ?? [], guest, preset, unreadOnly) : items.data?.items ?? [];
  const currentIndex = detail ? visible.findIndex((i) => i.id === detail.id) : -1;

  const enabledSources = (sources.data?.sources ?? []).filter((s) => s.enabled || showAllSources);
  const grouped = SOURCE_GROUPS.map((g) => ({
    ...g,
    sources: enabledSources.filter((s) => groupOfSource(s) === g.key),
  })).filter((g) => g.sources.length > 0);

  // 公开区显示「情报流 / 赛道图谱 / 今日热点 / 每日精选」，其余 Tab 只有进管理区后才出现
  const tabs: { key: Tab; label: string; icon: typeof Activity; badge?: number }[] = [
    { key: "feed", label: t("情报流"), icon: Activity },
    { key: "tracks", label: t("赛道图谱"), icon: Compass },
    { key: "hot", label: t("今日热点"), icon: Flame },
    { key: "digest", label: t("每日精选"), icon: Radar },
    ...(me ? [{ key: "me" as Tab, label: t("账号与通知"), icon: User }] : []),
    ...(!adminReady && me ? [
      { key: "rules" as Tab, label: t("我的订阅与屏蔽"), icon: ShieldBan, badge: blockRules.data?.rules.length },
      { key: "push" as Tab, label: t("我的推送规则"), icon: Zap, badge: push.data?.stats.queued },
    ] : []),
    ...(adminReady ? ADMIN_ENTRIES.map((entry) => ({
      ...entry,
      label: entry.key === "rules" ? effectiveScope === "personal" ? t("我的订阅与屏蔽") : t("全站订阅与屏蔽")
        : entry.key === "push" ? effectiveScope === "personal" ? t("我的推送规则") : t("全站推送规则") : entry.label,
      badge: entry.key === "rules" ? blockRules.data?.rules.length : entry.key === "push" ? push.data?.stats.queued : undefined,
    })) : [{ key: "admin" as const, label: t("管理区"), icon: Lock }]),
  ];
  const navigationGroup = (key: Tab) => key === "me" || ((key === "rules" || key === "push") && effectiveScope === "personal") ? t("个人空间") : t("站点管理");

  const handleTab = (key: Tab, feedPatch: Partial<FeedState> = {}) => {
    const nextFeed = { ...feedState, search: search.trim(), ...feedPatch };
    const p = new URLSearchParams(writeFeedSearch(location.search, nextFeed));
    const targetScope = key === "admin" ? "site" : workspaceScope;
    if (targetScope === "site") p.set("workspace", "site"); else p.delete("workspace");
    const queryString = p.toString();
    const url = tabUrl(location.pathname, queryString ? "?" + queryString : "", key);
    if (url !== location.pathname + location.search + location.hash) history.pushState(history.state, "", url);
    if (key === "admin") setWorkspaceScope("site");
    applyFeedState(nextFeed); closeOverlays(); setTab(key);
  };
  const changeWorkspace = (next: WorkspaceScope) => {
    const p = new URLSearchParams(writeFeedSearch(location.search, feedState));
    if (next === "site") p.set("workspace", "site"); else p.delete("workspace");
    const value = p.toString();
    const url = tabUrl(location.pathname, value ? "?" + value : "", tab);
    if (url !== location.pathname + location.search + location.hash) history.pushState(history.state, "", url);
    closeOverlays(); setWorkspaceScope(next);
  };


  const exportUrl = "/api/export?format=md&" + query.replace(/limit=\d+/, "limit=300");


  // 说明/RSS 入口：桌面侧栏与移动端品牌行共用同一份按钮，避免复制两份标记
  const helpRssNode = (
    <>
      <button
        type="button"
        onClick={() => setWelcomeOpen(true)}
        className={ICON_BTN}
        title={t("站点说明与使用提示")}
      >
        <BookOpen size={14} />
      </button>
      <button
        type="button"
        onClick={() => setRssOpen(true)}
        className={ICON_BTN}
        title={t("RSS 订阅地址")}
      >
        <Globe2 size={14} />
      </button>
    </>
  );

  // 主仓库入口：GitHub 图标，移动端品牌行与桌面侧栏都用它
  const githubNode = (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noreferrer"
      className={ICON_BTN + " repo-link"}
      title={t("主仓库 · GitHub")}
      aria-label={t("GitHub 主仓库")}
    >
      <Github size={14} />
    </a>
  );

  // 界面语言与主题：桌面侧栏第二行与移动端品牌行各放一个
  const langNode = <LangSwitch className={ICON_BTN} />;
  const themeNode = <ThemeSwitch className={ICON_BTN} />;

  // 账号态：移动端放进导航行右侧，桌面端留在侧栏第二行
  const accountNode = me ? (
    <div className="flex min-w-0 items-center gap-1">
      <button type="button" onClick={() => handleTab("me")} aria-label={t("打开个人中心")} title={t("个人中心与推送渠道")} className="flex min-w-0 items-center gap-1 rounded hover:bg-ink-100">
      {me.avatarUrl ? (
        <img src={me.avatarUrl} alt="" className="h-6 w-6 shrink-0 rounded-full border border-ink-200" />
      ) : (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink-100 text-[11px] font-semibold text-ink-600">
          {(me.name ?? me.username).slice(0, 1).toUpperCase()}
        </span>
      )}
      <span
        className="hidden min-w-0 truncate text-[12px] font-medium text-ink-800 sm:inline"
        title={`${me.name ?? me.username} · ${me.linuxdoId < 0 ? "GitHub" : t("LINUX DO 信任等级 {level}", { level: me.trustLevel })}`}
      >
        {me.name ?? me.username}
      </span>
      </button>
      <button
        type="button"
        onClick={() => void logout()}
        className="shrink-0 rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-900"
        title={t("退出登录")}
      >
        <LogOut size={12} />
      </button>
    </div>
  ) : bootData?.loginEnabled ? (
    <button
      type="button"
      onClick={() => {
        setAuthHash(null);
        setAuthOpen(true);
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-md bg-solid px-2 py-1 text-[12px] font-medium whitespace-nowrap text-on-solid hover:bg-solid-hover"
      title={t("用 LINUX DO 登录")}
    >
      <User size={12} /> {t("登录")}
    </button>
  ) : null;

  // 快捷视图 + 数据源树：桌面在侧栏常驻，移动端折进「筛选」面板里
  const sourcePanelNode = (
    <SourcePanel
      views={SECONDARY_VIEWS.filter((view) => view.key !== "review" || adminReady)}
      preset={preset}
      onPickPreset={switchPreset}
      grouped={grouped}
      source={source}
      onPickSource={setSource}
      showAllSources={showAllSources}
      onToggleShowAll={() => setShowAllSources((v) => !v)}
      collapsedGroups={collapsedGroups}
      onToggleGroup={(key) => setCollapsedGroups((m) => ({ ...m, [key]: !m[key] }))}
    />
  );

  return (
    <div className="workspace-shell flex min-h-screen flex-col bg-surface lg:flex-row">
      {/* 左侧连续导轨（移动端为顶部收拢区） */}
      <aside className="workspace-rail w-full shrink-0 border-b border-ink-200 bg-canvas/70 px-3.5 py-3 lg:flex lg:w-[240px] lg:flex-col lg:gap-4 lg:border-r lg:border-b-0 lg:bg-canvas lg:px-3 lg:py-4">
        {/* 品牌行：说明/RSS/GitHub/导出/刷新 全部收进这一行，省掉整条第二栏 */}
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent-solid" aria-hidden="true" />
            <h1 className="shrink-0 whitespace-nowrap text-[14px] font-semibold tracking-tight text-ink-950">{t("生财雷达")}</h1>
          </div>
          <span className="hidden font-mono text-[11px] tabular-nums text-ink-400 lg:inline">
            {stats.data?.totals.aiKept ?? "—"} {t("精选")}
          </span>
          <div className="mobile-toolbar flex items-center gap-1 lg:hidden">
            <button type="button" onClick={() => setWelcomeOpen(true)} className={ICON_BTN} title={t("站点说明与使用提示")}>
              <BookOpen size={14} />
            </button>
            {themeNode}
            {langNode}
            <details className="feed-more">
              <summary aria-label={t("更多工具")} title={t("更多工具")}><MoreHorizontal size={16} aria-hidden="true" /></summary>
              <div className="feed-more-menu">
                <button type="button" onClick={() => setRssOpen(true)}><Globe2 size={14} /> {t("RSS 订阅")}</button>
                <a href={REPO_URL} target="_blank" rel="noreferrer"><Github size={14} /> GitHub</a>
                {tab === "feed" && <a href={exportUrl}><Download size={14} /> {t("导出 Markdown")}</a>}
              </div>
            </details>
            <button type="button" onClick={refreshAll} className={ICON_BTN} title={t("刷新数据")}>
              <RefreshCw size={14} className={items.loading ? "animate-spin" : ""} />
            </button>
          </div>
        </div>

        {/* 桌面侧栏第二行：说明/RSS + 账号；移动端这两个入口已分别并入品牌行与导航行 */}
        <div className="mt-2 hidden items-center gap-1 px-1 lg:mt-0 lg:flex">
          {helpRssNode}
          {githubNode}
          {themeNode}
          {langNode}
          <div className="ml-auto min-w-0">{accountNode}</div>
        </div>

        {isPublicSite && (guest.hidden.length > 0 || guest.starred.length > 0 || guest.read.length > 0 || guest.blocked.length > 0) && (
          <div className="mt-2 rounded-md border border-ink-200 bg-surface-hover px-2.5 py-1.5 text-[11px] leading-relaxed text-ink-600">
            {t("本机偏好：收藏 {starred} · 已读 {read} · 已关闭 {hidden}", { starred: guest.starred.length, read: guest.read.length, hidden: guest.hidden.length })}
            {bootData?.loginEnabled && (
              <button
                type="button"
                onClick={async () => {
                  if (!me) { setAuthOpen(true); return; }
                  const r = await importGuestToAccount(guest);
                  if (r.ok) {
                    notify(t("已合并 {n} 条偏好到账号", { n: r.imported }));
                    syncGuest();
                    items.reload();
                    stats.reload();
                    blockRules.reload();
                  } else {
                    notify(r.error ?? t("合并失败"));
                  }
                }}
                className="ml-1 font-medium text-accent hover:underline"
              >
                {me ? t("合并到当前账号") : t("登录后合并")}
              </button>
            )}
          </div>
        )}
        {/* 搜索框（/ 快捷键聚焦） */}
        <div className="relative mt-2.5 lg:mt-0">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-400" />
          <input
            ref={searchRef}
            maxLength={300}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { handleTab("feed", tab === "feed" ? { search: e.currentTarget.value.trim() } : { ...DEFAULT_FEED_STATE, search: e.currentTarget.value.trim() }); return; }
              if (e.key === "Escape") {
                if (search) {
                  setSearch("");
                  setDebounced("");
                } else {
                  e.currentTarget.blur();
                }
              }
            }}
            placeholder={t("搜索实战拆解、SOP、赛道关键词…")}
            className="h-8 w-full rounded-md border border-ink-200 bg-surface pr-8 pl-8 text-[12px] text-ink-950 transition-colors outline-none placeholder:text-ink-400 focus:border-accent"
          />
          {search ? (
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setDebounced("");
              }}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
              title={t("清空搜索")}
            >
              <X size={12} />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border border-ink-200 bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-ink-400 lg:inline">
              /
            </kbd>
          )}
        </div>

        {/* 导航：手机横向可滚 + 右侧账号，桌面纵列无边框 */}
        <div className="-mx-3.5 mt-2.5 flex items-center gap-1.5 px-3.5 pb-0.5 lg:mx-0 lg:mt-0 lg:block lg:px-0 lg:pb-0">
          <nav ref={mobileNavRef} aria-label={t("页面导航")} className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto lg:block lg:flex-none lg:space-y-0.5 lg:overflow-visible">
          {tabs.slice(0, 4).map((t) => (
            <button
              key={t.key}
              type="button"
              data-tab={t.key}
              aria-label={t.label}
              aria-current={tab === t.key ? "page" : undefined}
              onClick={() => handleTab(t.key)}
              className={
                "flex shrink-0 items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors lg:w-full " +
                (tab === t.key
                  ? "bg-brand-subtle font-semibold text-accent lg:bg-canvas-subtle lg:text-ink-950"
                  : "text-ink-600 hover:bg-canvas-subtle/70 hover:text-ink-950")
              }
            >
              <span className="flex items-center gap-2">
                <t.icon size={14} className={tab === t.key ? "lg:text-accent" : "text-ink-400"} />
                {t.label}
              </span>
              {t.key === "feed" && (stats.data?.totals.unread ?? 0) > 0 && (
                <span
                  className={
                    "hidden font-mono text-[11px] tabular-nums lg:inline " +
                    (tab === t.key ? "text-ink-600" : "text-ink-400")
                  }
                >
                  {stats.data?.totals.unread}
                </span>
              )}
            </button>
          ))}
          <div className="mx-1 h-4 w-px shrink-0 self-center bg-ink-200 lg:hidden" />
          {tabs.slice(4).map((t, index) => {
            const previous = tabs[index + 3];
            const group = navigationGroup(t.key);
            return <Fragment key={t.key}>
              {(index === 0 || !previous || group !== navigationGroup(previous.key)) && <div className="hidden px-2.5 pt-3 pb-1 text-[12px] font-medium text-ink-500 lg:block">{group}</div>}
            <button
              key={t.key}
              type="button"
              data-tab={t.key}
              aria-label={t.label}
              aria-current={tab === t.key ? "page" : undefined}
              onClick={() => handleTab(t.key)}
              className={
                "flex shrink-0 items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors lg:w-full " +
                (tab === t.key
                  ? "bg-brand-subtle font-semibold text-accent lg:bg-canvas-subtle lg:text-ink-950"
                  : "text-ink-600 hover:bg-canvas-subtle/70 hover:text-ink-950")
              }
            >
              <span className="flex items-center gap-2">
                <t.icon size={14} className={tab === t.key ? "lg:text-accent" : "text-ink-400"} />
                {t.label}
              </span>
              {typeof t.badge === "number" && t.badge > 0 && (
                <span
                  className={
                    "rounded px-1.5 py-0.5 font-mono text-[11px] tabular-nums " +
                    (tab === t.key
                      ? "bg-surface text-accent lg:text-ink-700"
                      : "bg-ink-200/80 text-ink-600")
                  }
                >
                  {t.badge}
                </span>
              )}
            </button>
            </Fragment>;
          })}
          </nav>
          {/* 移动端账号入口：贴着导航右侧，不单独占一行 */}
          <div className="shrink-0 lg:hidden">{accountNode}</div>
        </div>
        {tab !== "feed" && <nav className="mt-3 hidden border-t border-ink-200 pt-3 lg:block" aria-label={t("个人快捷入口")}>
          <div className="rail-section-label px-2.5 pb-1">{t("我的")}</div>
          {SECONDARY_VIEWS.filter((view) => view.key === "starred" || view.key === "hidden").map((view) => <button key={view.key} type="button"
            className="flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink-600 hover:bg-canvas-subtle"
            onClick={() => handleTab("feed", { ...DEFAULT_FEED_STATE, preset: view.key })}><view.icon size={14} />{view.label}</button>)}
        </nav>}
        {/* 场景预设 & 数据源：桌面侧栏常驻，移动端折进主区「筛选」面板 */}
        {tab === "feed" && (
          <div className="mt-3 hidden lg:mt-0 lg:block">
            <div className="space-y-4">{sourcePanelNode}</div>
          </div>
        )}
      </aside>

      {/* 右侧纯白主工作区 */}
      <div className="flex min-w-0 flex-1 flex-col bg-surface">
        {/* 桌面 48px 顶栏 */}
        <header className="sticky top-0 z-20 hidden h-12 items-center justify-between gap-4 border-b border-ink-200 bg-surface/95 px-6 backdrop-blur-sm lg:flex">
          <div className="flex min-w-0 items-center gap-2 text-[13px]">
            <span className="text-ink-500">{tab === "me" || ((tab === "rules" || tab === "push") && effectiveScope === "personal") ? t("个人空间") : ADMIN_TABS.has(tab) || tab === "admin" ? t("管理工作台") : t("公开内容")}</span>
            <ChevronRight size={12} className="text-ink-300" />
            <span className="font-medium text-ink-900">{tabs.find((t) => t.key === tab)?.label ?? t("管理区")}</span>
          </div>

          <div className="flex shrink-0 items-center gap-3 text-[12px] text-ink-500">
            {tab === "feed" && <><span className="font-mono tabular-nums">
              24h <strong className="font-semibold text-ink-900">+{stats.data?.totals.last24h ?? "—"}</strong>
            </span>
            <a
              href={exportUrl}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-950"
              title={t("按当前筛选导出 Markdown")}
              aria-label={t("按当前筛选导出 Markdown")}
            >
              <Download size={14} />
            </a>
            </>}
            <button
              type="button"
              onClick={refreshAll}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-ink-200 bg-surface text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-950"
              title={t("刷新数据")}
            >
              <RefreshCw size={13} className={items.loading ? "animate-spin" : ""} />
            </button>
          </div>
        </header>

        <UpstreamWatchBanner adminReady={adminReady} onNotify={notify} />

        {/* 主内容区 */}
        <main className={tab === "feed" ? "workspace-content min-w-0 flex-1" : "workspace-content min-w-0 flex-1 px-3.5 py-3.5 sm:px-6 sm:py-5"}>
          {/* 懒加载的面板首次进入时给一个轻量占位，避免整页闪白 */}
          {(ADMIN_TABS.has(tab) || tab === "admin") && <WorkspaceScopeBar
            scope={tab === "rules" || tab === "push" ? effectiveScope : "site"}
            subject={tab === "rules" ? "rules" : tab === "push" ? "push" : "admin"}
            canSwitch={Boolean(isPublicSite && me && (tab === "rules" || tab === "push"))}
            siteAllowed={adminReady} onChange={changeWorkspace} onOpenProfile={() => handleTab("me")}
          />}
          {configurationError && <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md bg-alert-subtle p-3 text-[13px] text-alert">
            <span>{t("配置加载失败：")}{configurationError}</span>
            <button type="button" className="font-medium underline" onClick={() => { subs.reload(); blockRules.reload(); push.reload(); }}>{t("重新加载")}</button>
          </div>}
          {canConfigure && configurationLoading && <div role="status" aria-label={t("配置加载中")} className="space-y-4 py-6">
            <div className="h-4 w-40 rounded bg-ink-100" /><div className="h-24 rounded bg-surface-muted" /><div className="h-24 rounded bg-surface-muted" />
          </div>}
          <Suspense
            fallback={
              <div className="flex items-center justify-center gap-1.5 px-6 py-10 text-[12px] text-ink-400">
                <Loader2 size={13} className="animate-spin" /> {t("载入中…")}
              </div>
            }
          >
          {(tab === "admin" || (ADMIN_TABS.has(tab) && !((tab === "rules" || tab === "push") ? canConfigure : adminReady))) && (
            <AdminGate protectedMode={protectedMode} entryAllowed={adminEntryAllowed} onAuthChange={setAdminAuthed}>
              <div className="admin-entries grid gap-x-8 sm:grid-cols-2">
                {ADMIN_ENTRIES.map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    onClick={() => { setWorkspaceScope("site"); handleTab(entry.key); }}
                    className="admin-entry flex flex-col items-start gap-1.5 py-4 text-left transition-colors hover:border-ink-400"
                  >
                    <entry.icon size={16} className="text-accent" />
                    <span className="text-[14px] font-semibold text-ink-950">{entry.label}</span>
                    <span className="text-[12px] leading-relaxed text-ink-500">{entry.desc}</span>
                  </button>
                ))}
              </div>
            </AdminGate>
          )}

          {tab === "feed" && (
            <>
              {firstVisitNotice && bootData && <section className="first-visit-notice" aria-label={t("站点公告")}>
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-solid" aria-hidden="true" />
                <h2 className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink-700">{t(bootData.onboarding.title)}</h2>
                <button type="button" className="scope-link shrink-0" onClick={() => setWelcomeOpen(true)}>{t("查看说明")}</button>
                <button type="button" className="notice-dismiss" aria-label={t("收起站点公告")} onClick={closeWelcome}><X size={15} /></button>
              </section>}
              {/* 移动端：频道胶囊 + 筛选/视图压成一行，省掉两条整行按钮 */}
              <div className="flex items-stretch border-b border-ink-100 bg-surface">
                <div ref={channelRef} onScroll={syncChannelScroll} className="channel-nav no-scrollbar min-w-0 flex-1" role="group" aria-label={t("内容频道")}>
                  {PRIMARY_CHANNELS.map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      aria-pressed={preset === p.key}
                      onClick={() => switchPreset(p.key)}
                      className="whitespace-nowrap transition-colors"
                    >
                      <p.icon size={11} />
                      {p.label}
                    </button>
                  ))}
                </div>
                {(channelScroll.left || channelScroll.right) && <button type="button" className="channel-scroll-control" aria-label={channelScroll.right ? t("更多频道") : t("前面频道")}
                  onClick={() => channelRef.current?.scrollBy({ left: channelScroll.right ? 240 : -240, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })}>
                  <ChevronRight size={16} className={channelScroll.right ? "" : "rotate-180"} />
                </button>}
                <div className="relative flex shrink-0 items-center gap-1 border-l border-ink-100 bg-surface px-2 lg:hidden">
                  {/* 左侧渐隐，避免横向滚动的频道胶囊被硬切一半 */}
                  <span className="pointer-events-none absolute inset-y-0 -left-4 w-4 bg-gradient-to-l from-surface to-transparent" aria-hidden="true" />
                  <button
                    type="button"
                    onClick={() => setMobileFilterBar((v) => !v)}
                    className={
                      "relative inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors " +
                      (mobileFilterBar
                        ? "border-brand-border bg-brand-subtle text-accent"
                        : "border-ink-200 bg-surface text-ink-600")
                    }
                    title={t("筛选条件")}
                    aria-label={t("筛选条件")}
                    aria-expanded={mobileFilterBar}
                  >
                    <SlidersHorizontal size={14} />
                    {activeFilterCount > 0 && (
                      <span className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent-solid px-0.5 font-mono text-[11px] leading-none text-on-solid">
                        {activeFilterCount}
                      </span>
                    )}
                  </button>
                </div>
              </div>

              <FeedToolbar
                policyLabels={policyLabels}
                loading={items.loading}
                total={items.data?.total ?? 0}
                view={viewMode}
                onView={updateViewMode}
                showSummary={showRowSummary}
                canToggleSummary={viewMode === "compact"}
                onToggleSummary={toggleRowSummary}
                canMarkRead={visible.some((item) => !item.read)}
                onMarkRead={() => void markVisibleRead()}
              />
              {/* 40px 细线筛选条（根据当前频道自适应隐藏无关的价格/方式筛选） */}
              <div
                className={
                  "feed-controls border-b border-ink-200 bg-surface px-3.5 py-2.5 sm:px-6 sm:py-2 " +
                  (mobileFilterBar ? "block" : "hidden sm:block")
                }
              >
                <div className="flex flex-wrap items-center gap-1">
                  {/* 分类多选浮层（展开查看全部分类） */}
                  <div className="filter-category relative" ref={catRef}>
                    <button
                      type="button"
                      aria-expanded={catOpen} aria-controls="category-filter-options"
                      onClick={() => setCatOpen((v) => !v)}
                      className={
                        "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] transition-colors " +
                        (categories.length
                          ? "border-brand-border bg-brand-subtle font-medium text-accent"
                          : "border-transparent bg-canvas text-ink-600 hover:bg-canvas-subtle hover:text-ink-900")
                      }
                    >
                      <span>
                        {categories.length === 0
                          ? t("分类")
                          : categories.length === 1
                            ? t("分类：{name}", { name: t(categoryLabelForPreset(categories[0]!, preset)) })
                            : t("分类：已选 {n} 项", { n: categories.length })}
                      </span>
                      <ChevronDown size={12} />
                    </button>
                    {catOpen && (
                      <div id="category-filter-options" role="group" aria-label={t("筛选分类")} className="pop-enter panel absolute top-full left-0 z-40 mt-1.5 w-[260px] p-2.5 shadow-lg">
                        <div className="mb-2 flex items-center justify-between text-[11px] text-ink-500">
                          <span>{preset === "news" ? t("要闻栏目（支持多选）") : preset === "info" ? t("行业资讯栏目（支持多选）") : preset === "deal" ? t("好价分类（支持多选）") : preset === "opensource" ? t("开源方向（支持多选）") : preset === "verified" ? t("福利分类（支持多选）") : t("细分赛道（支持多选）")}</span>
                          {categories.length > 0 && (
                            <button
                              type="button"
                              onClick={() => setCategories([])}
                              className="font-medium text-accent hover:underline"
                            >
                              {t("清空")}
                            </button>
                          )}
                        </div>
                        <div className="grid max-h-[240px] grid-cols-2 gap-1 overflow-auto">
                          {(() => {
                            const countMap = new Map((stats.data?.byCategory ?? []).map((c) => [c.category ?? "other", c.n]));
                            const allowed = categoriesForPreset(preset);
                            const ordered = [...allowed].sort((a, b) => (countMap.get(b) ?? 0) - (countMap.get(a) ?? 0));
                            return ordered.map((key) => {
                              const n = countMap.get(key) ?? 0;
                              const checked = categories.includes(key);
                              return (
                                <button
                                  key={key}
                                  type="button"
                                  aria-pressed={checked}
                                  onClick={() =>
                                    setCategories((cur) =>
                                      cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key],
                                    )
                                  }
                                  className={
                                    "flex items-center justify-between rounded border px-2 py-1 text-left text-[12px] transition-colors " +
                                    (checked
                                      ? "border-brand-border bg-brand-subtle font-medium text-accent"
                                      : n > 0
                                        ? "border-ink-200 bg-surface text-ink-700 hover:bg-ink-100"
                                        : "border-ink-100 bg-canvas/70 text-ink-400 hover:bg-ink-100")
                                  }
                                >
                                  <span className="truncate">{t(categoryLabelForPreset(key, preset))}</span>
                                  <span className={"ml-1 font-mono text-[11px] " + (checked ? "text-accent/75" : "text-ink-400")}>
                                    {n}
                                  </span>
                                </button>
                              );
                            });
                          })()}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 内容形态筛选 */}
                  {advancedFilters && <select
                    value={kindFilter}
                    onChange={(e) => setKindFilter(e.target.value)}
                    className="h-7 rounded-md border border-transparent bg-canvas px-2 text-[12px] font-medium text-ink-600 outline-none hover:bg-canvas-subtle hover:text-ink-900 focus:border-accent"
                    title={t("内容形态")}
                  >
                    <option value="auto">{t("形态：")}{preset === "verified" ? t("真福利") : preset === "deal" ? t("好价") : preset === "opensource" ? t("开源") : preset === "news" ? t("要闻") : preset === "info" ? t("资讯") : t("全部")}</option>
                    <option value="all">{t("形态：全部（含其它）")}</option>
                    {KIND_ORDER.map((k) => (
                      <option key={k} value={k}>
                        {t(KIND_LABEL[k] ?? k)}
                      </option>
                    ))}
                  </select>}

                  {advancedFilters && <>
                  {/* 语言筛选 */}
                  <select
                    value={lang}
                    onChange={(e) => setLang(e.target.value as "all" | "zh" | "en")}
                    className="h-7 rounded-md border border-transparent bg-canvas px-2 text-[12px] font-medium text-ink-600 outline-none hover:bg-canvas-subtle hover:text-ink-900 focus:border-accent"
                    title={t("按标题语言筛选")}
                  >
                    <option value="all">{t("语言：全部")}</option>
                    <option value="zh">{t("仅看中文")}</option>
                    <option value="en">{t("仅看英文")}</option>
                  </select>
                  </>}

                  {advancedFilters && !NON_PRICE_PRESETS.has(preset) && (
                    <>
                      <select
                        value={priceCap}
                        onChange={(e) => setPriceCap(e.target.value)}
                        className="h-7 rounded-md border border-transparent bg-canvas px-2 text-[12px] font-medium text-ink-600 outline-none hover:bg-canvas-subtle hover:text-ink-900 focus:border-accent"
                        title={t("价格上限")}
                      >
                        <option value="auto">
                          {t("价格：不限")}
                        </option>
                        <option value="all">{t("价格：不限")}</option>
                        <option value="free">{t("仅白嫖 (0 元)")}</option>
                        <option value="5">{t("≤ 5 元")}</option>
                        <option value="10">{t("≤ 10 元")}</option>
                        <option value="30">{t("≤ 30 元")}</option>
                        <option value="100">{t("≤ 100 元")}</option>
                      </select>

                      {advancedFilters && <select
                        value={obtain}
                        onChange={(e) => setObtain(e.target.value)}
                        className="h-7 rounded-md border border-transparent bg-canvas px-2 text-[12px] font-medium text-ink-600 outline-none hover:bg-canvas-subtle hover:text-ink-900 focus:border-accent"
                        title={t(OBTAIN_HINT[obtain] ?? "获取方式")}
                      >
                        <option value="auto">
                          {t("方式：")}{preset === "verified" ? t("白嫖+条件") : t("不限")}
                        </option>
                        <option value="all">{t("方式：全部（含抽奖/试用）")}</option>
                        <option value="free">{t("仅直接白嫖")}</option>
                        <option value="conditional">{t("有条件领取")}</option>
                        <option value="lottery">{t("抽奖/开奖")}</option>
                        <option value="trial">{t("免费试用")}</option>
                        <option value="promo">{t("推广/引流")}</option>
                        <option value="paid">{t("需付费")}</option>
                      </select>}
                    </>
                  )}

                  <select
                    value={range}
                    onChange={(e) => setRange(e.target.value)}
                    className="h-7 rounded-md border border-transparent bg-canvas px-2 text-[12px] font-medium text-ink-600 outline-none hover:bg-canvas-subtle hover:text-ink-900 focus:border-accent"
                    title={t("发布时间窗口")}
                  >
                    <option value="auto">
                      {t("时间：")}{preset === "verified" ? t("7天内") : t("不限")}
                    </option>
                    <option value="all">{t("时间：不限")}</option>
                    <option value="1d">{t("24 小时内")}</option>
                    <option value="3d">{t("3 天内")}</option>
                    <option value="7d">{t("一周内")}</option>
                    <option value="30d">{t("一个月内")}</option>
                  </select>

                  {advancedFilters && <select
                    value={minScore}
                    onChange={(e) => setMinScore(e.target.value)}
                    className="h-7 rounded-md border border-transparent bg-canvas px-2 text-[12px] font-medium text-ink-600 outline-none hover:bg-canvas-subtle hover:text-ink-900 focus:border-accent"
                    title={t("最低评分")}
                  >
                    <option value="all">{t("评分：不限")}</option>
                    <option value="50">{t("≥ 50 分")}</option>
                    <option value="60">{t("≥ 60 分")}</option>
                    <option value="70">{t("≥ 70 分")}</option>
                  </select>}
                  <button type="button" aria-label={advancedFilters ? t("收起高级筛选") : t("高级筛选")} aria-expanded={advancedFilters} onClick={() => setAdvancedFilters((v) => !v)} className="inline-flex items-center gap-1 rounded-md px-2 text-[12px] font-medium text-accent hover:bg-brand-subtle">
                    <SlidersHorizontal size={12} /> {advancedFilters ? t("收起高级筛选") : t("高级筛选")}
                    {(kindFilter !== "auto" || obtain !== "auto" || minScore !== "all") && <span className="h-1.5 w-1.5 rounded-full bg-accent-solid" aria-label={t("高级条件已生效")} />}
                  </button>

                  <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                    className="h-7 rounded-md border border-transparent bg-canvas px-2 text-[12px] font-medium text-ink-600 outline-none hover:bg-canvas-subtle hover:text-ink-900 focus:border-accent"
                    title={t("排序方式")}
                  >
                    <option value="newest">{t("最新")}</option>
                    <option value="score">{t("高分")}</option>
                    <option value="oldest">{t("最早")}</option>
                    <option value="expiring">{t("快截止")}</option>
                    {!NON_PRICE_PRESETS.has(preset) && <option value="price_asc">{t("低价")}</option>}
                  </select>

                  <button
                    type="button"
                    aria-pressed={unreadOnly}
                    onClick={() => setUnreadOnly((v) => !v)}
                    className={
                      "h-7 rounded-md border px-2.5 text-[12px] font-medium transition-colors active:scale-[0.97] " +
                      (unreadOnly
                        ? "border-brand-border bg-brand-subtle text-accent"
                        : "border-transparent bg-canvas text-ink-600 hover:bg-canvas-subtle")
                    }
                  >
                    {t("未读")}
                  </button>



                </div>
                {/* 移动端：快捷视图与数据源折进这个面板，排在筛选条之后 */}
                <ActiveFilters
                  state={feedState}
                  onRemove={removeFilter}
                  onReset={resetFilters}
                  sourceName={sourceName}
                  categoryName={(category) => t(categoryLabelForPreset(category, preset))}
                />
                {tab === "feed" && mobileFilterBar && (
                  <details className="mobile-source"><summary>{t("快捷视图与数据源")}</summary>{sourcePanelNode}</details>
                )}

              </div>
              {activeFilterCount > 0 && !mobileFilterBar && <div className="flex items-center justify-between gap-3 border-b border-ink-100 bg-brand-subtle/40 px-3.5 py-2 text-[12px] sm:hidden">
                <button type="button" onClick={() => setMobileFilterBar(true)} className="min-w-0 truncate text-ink-700">{t("已筛选 {n} 项", { n: activeFilterCount })}{source ? ` · ${sourceName(source)}` : ""}{categories.length ? ` · ${categories.map((cat) => t(categoryLabelForPreset(cat, preset))).join("、")}` : ""} · {t("查看条件")}</button>
                <button type="button" onClick={resetFilters} className="shrink-0 font-medium text-accent">{t("清除")}</button>
              </div>}


              {items.error && (
                <div role="alert" className="mx-3.5 my-3 rounded-lg border border-alert-border bg-alert-subtle p-4 text-[13px] text-alert sm:mx-6">
                  {t("加载失败：")}{items.error} <button type="button" onClick={items.reload} className="ml-2 underline">{t("重新加载")}</button>
                </div>
              )}
              {items.loading && !visible.length && <div role="status" aria-label={t("资源加载中")} className="divide-y divide-ink-100">
                {Array.from({ length: 5 }, (_, index) => <div key={index} className="flex items-center gap-4 px-6 py-5">
                  <div className="h-4 w-9 rounded bg-ink-100" /><div className="flex-1 space-y-2"><div className="h-3 w-2/3 rounded bg-ink-100" /><div className="h-2.5 w-1/3 rounded bg-ink-100" /></div>
                </div>)}
              </div>}

              {viewMode === "compact" ? (
                <div key={`compact-${preset}`} className="list-enter">
                  {visible.map((item) => (
                    <Fragment key={item.id}>
                      <CompactRow
                        item={item}
                        showSummary={showRowSummary}
                        sourceName={sourceName}
                        selected={detail?.id === item.id}
                        onPatch={patch}
                        onOpen={setDetail}
                        onQuickBlock={setQuickBlock}
                        onCopyCode={copyCode}
                        expanded={relatedOpen === item.id}
                        onToggleRelated={(id) => setRelatedOpen((cur) => (cur === id ? null : id))}
                      />
                      {relatedOpen === item.id && relatedMap[item.id] ? (
                        <div className="pop-enter border-b border-ink-100 bg-surface-hover px-3.5 py-2 sm:px-6">
                          <div className="mb-1 text-[11px] font-medium text-ink-500">
                            {t("同一事件 / 福利的其他 {n} 条来源报道", { n: relatedMap[item.id]!.length })}
                          </div>
                          <ul className="space-y-1">
                            {relatedMap[item.id]!.map((r) => (
                              <li key={r.id} className="flex items-center gap-2 text-[12px]">
                                <span className="w-20 shrink-0 truncate text-ink-500 sm:w-28">{r.sourceName ?? r.source_id}</span>
                                <a
                                  href={r.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="truncate text-ink-700 hover:text-accent hover:underline"
                                >
                                  {r.title}
                                </a>
                                <span className="shrink-0 font-mono text-[11px] text-ink-400">
                                  {String(r.first_seen_at).slice(5, 16).replace("T", " ")}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </Fragment>
                  ))}
                </div>
              ) : (
                <div
                  key={`grid-${preset}-${viewMode}`}
                  className={
                    "list-enter " +
                    (viewMode === "grid3"
                      ? "grid grid-cols-1 gap-3.5 px-3.5 py-3 md:grid-cols-2 xl:grid-cols-3 sm:px-6 sm:py-4"
                      : "grid grid-cols-1 gap-3.5 px-3.5 py-3 md:grid-cols-2 sm:px-6 sm:py-4")
                  }
                >
                  {visible.map((item) => (
                    <ItemCard
                      key={item.id}
                      item={item}
                      sourceName={sourceName}
                      onPatch={patch}
                      onOpen={setDetail}
                      onQuickBlock={setQuickBlock}
                      onCopyCode={copyCode}
                      expanded={relatedOpen === item.id}
                      relatedItems={relatedOpen === item.id ? relatedMap[item.id] : undefined}
                      onToggleRelated={(id) => setRelatedOpen((cur) => (cur === id ? null : id))}
                    />
                  ))}
                </div>
              )}

              {!items.loading && !items.error && !visible.length && (
                <div className="flex flex-col items-center gap-3 px-6 py-20 text-center">
                  <Radar size={28} className="text-ink-300" />
                  <div className="text-[17px] font-medium text-ink-900">{preset === "hidden" ? t("还没有已关闭的内容") : preset === "starred" ? t("还没有符合条件的收藏") : t("当前条件下暂无内容")}</div>
                  <p className="max-w-md text-[13px] leading-relaxed text-ink-500">
                    {preset === "hidden" ? t("列表里点“不想看”的内容会来到这里，需要时可恢复。") : preset === "starred" ? t("点资源旁的星标即可收藏；已收藏但未显示时，可先清除筛选。") : t("「{channel}」暂时没有匹配结果，可以清除条件或浏览全部收录。", { channel: PRESETS.find((p) => p.key === preset)?.label ?? t("当前频道") })}
                  </p>
                  {preset === "pan" && isPublicSite && <p className="max-w-md text-[12px] leading-relaxed text-ink-500">{t("网盘与网课条目的可见范围由站点访问策略决定；第三方分享请核对来源与版权。")}</p>}
                  <div className="flex gap-2">
                    {activeFilterCount > 0 && <button type="button" onClick={resetFilters} className="rounded-md border border-ink-200 px-4 py-2 text-[12px] font-medium text-ink-700 hover:bg-ink-100">{t("清除当前条件")}</button>}
                    <button type="button" onClick={() => { resetFilters(); setPreset("all"); }} className="rounded-md bg-solid px-4 py-2 text-[12px] font-medium text-on-solid hover:bg-solid-hover">{t("浏览全部收录")}</button>
                  </div>
                </div>
              )}
            </>
          )}

          {tab === "tracks" && (
            <TracksPanel
              canAdmin={adminReady}
              sourceName={sourceName}
              onPatch={patch}
              onOpen={setDetail}
              onQuickBlock={setQuickBlock}
              onCopyCode={copyCode}
              onNotify={notify}
            />
          )}

          {tab === "hot" && (
            <HotPanel
              report={hot.data}
              loading={hot.loading}
              error={hot.error}
              hours={hotHours}
              scope={hotScope}
              onHours={setHotHours}
              onScope={setHotScope}
              onReload={hot.reload}
              onSearchWord={(w) => handleTab("feed", { ...DEFAULT_FEED_STATE, search: w, preset: hotScope === "news" ? "news" : hotScope === "info" ? "info" : hotScope === "deals" ? "verified" : "all" })}
              onJumpCategory={(cat) => {
                const targetPreset =
                  hotScope === "news" || cat === "news"
                    ? "news"
                    : hotScope === "info" || cat === "stock" || cat === "tech" || cat === "finance"
                      ? "info"
                      : "all";
                handleTab("feed", { ...DEFAULT_FEED_STATE, preset: targetPreset, categories: [cat] });
              }}
              onOpenItem={async (id) => {
                const epoch = overlayEpoch.current;
                const found = items.data?.items?.find((it) => it.id === id);
                if (found) {
                  setDetail(found);
                  return;
                }
                try {
                  const res = await fetch("/api/items/" + id);
                  if (res.ok) {
                    const item = (await res.json()) as Item;
                    if (epoch !== overlayEpoch.current) return;
                    setDetail(item);
                    return;
                  }
                } catch {
                  /* 回退到资源流 */
                }
                if (epoch === overlayEpoch.current) handleTab("feed");
              }}
              sourceName={sourceName}
            />
          )}

          {tab === "digest" && (
            <DigestPanel
              digests={digests.data?.digests ?? []}
              detail={digestDetail}
              pickedDate={pickedDate}
              onPickDate={setPickedDate}
              canAdmin={adminReady}
              onRunDaily={async () => {
                notify(t("正在生成今日精选…"));
                const res = await fetch("/api/digests/run", { method: "POST" });
                const data = (await res.json().catch(() => ({}))) as { date?: string; count?: number; error?: string };
                if (!res.ok) notify(data.error ?? t("生成失败"));
                else notify(t("已生成 {n} 条精选", { n: data.count ?? 0 }));
                digests.reload();
                setPickedDate(res.ok && data.date ? data.date : null);
                digestDetail.reload();
              }}
              sourceName={sourceName}
              onPatch={patch}
              onOpen={setDetail}
              onQuickBlock={setQuickBlock}
              onCopyCode={copyCode}
              onRunWeekly={async () => {
                notify(t("正在汇总本周精选…"));
                const res = await fetch("/api/digests/weekly", { method: "POST" });
                const data = (await res.json().catch(() => ({}))) as { date?: string; count?: number; error?: string; pushed?: boolean };
                if (!res.ok) notify(data.error ?? t("生成失败"));
                else notify(t("周报已生成 {n} 条{suffix}", { n: data.count ?? 0, suffix: data.pushed ? t("，已发 Telegram") : "" }));
                digests.reload();
                setPickedDate(res.ok && data.date ? data.date : null);
                digestDetail.reload();
              }}
            />
          )}

          {canConfigure && !configurationLoading && !configurationError && tab === "rules" && (
            <RulesPanel
              key={configScopeKey}
              allowRegex={effectiveScope === "site" && adminReady}
              subscriptions={subs.data?.subscriptions ?? []}
              rules={blockRules.data?.rules ?? []}
              presets={blockRules.data?.presets ?? []}
              totalBlocked={blockRules.data?.totalBlocked ?? 0}
              sources={sources.data?.sources ?? []}
              blockedPreview={blockedPreview}
              sourceName={sourceName}
              onAddSub={addSubscription}
              onRemoveSub={removeSubscription}
              onJumpToSubscribed={(kw) => handleTab("feed", { ...DEFAULT_FEED_STATE, preset: "all", search: kw })}
              onAddRule={addRule}
              onImportPresets={async () => {
                const res = await fetch(rulesBase + "/block-rules", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ presets: true }),
                });
                if (!res.ok) { notify(t("导入屏蔽词失败")); return; }
                blockRules.reload();
                items.reload();
                stats.reload();
                notify(t("已导入生财反软广屏蔽词"));
              }}
              onToggleRule={async (id, enabled) => {
                const res = await fetch(rulesBase + "/block-rules/" + id, {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ enabled }),
                });
                if (!res.ok) { notify(t("修改规则失败")); return; }
                blockRules.reload();
                items.reload();
                setBlockedPreview(null);
              }}
              onDeleteRule={async (id) => {
                const res = await fetch(rulesBase + "/block-rules/" + id, { method: "DELETE" });
                if (!res.ok) { notify(t("删除规则失败")); return; }
                blockRules.reload();
                items.reload();
                stats.reload();
                setBlockedPreview(null);
                notify(t("规则已删除，相关条目已恢复显示"));
              }}
              onLoadBlockedPreview={async () => {
                const res = await fetch("/api/items?includeBlocked=1&limit=80&sort=newest");
                const data = (await res.json()) as { items: Item[] };
                setBlockedPreview(data.items);
              }}
            />
          )}

          {pushBase && !configurationLoading && !configurationError && tab === "push" && (
            <PushPanel
              key={configScopeKey}
              payload={push.data}
              preview={pushPreview}
              logs={pushLogs.data?.logs ?? []}
              sources={sources.data?.sources ?? []}
              onSave={async (p: Partial<PushSettings>) => {
                const res = await fetch(pushBase ?? "/api/push", {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(p),
                });
                if (!res.ok) {
                  const error = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? t("保存失败");
                  notify(error);
                  throw new Error(error);
                }
                push.reload();
                setPushPreview(null);
                notify(t("推送规则已保存"));
              }}
              onPreview={async () => {
                const res = await fetch((pushBase ?? "/api/push") + "/preview?limit=6");
                if (!res.ok) { notify(t("试算失败，请稍后重试")); return; }
                setPushPreview((await res.json()) as PushPreview);
              }}
              onFlush={async () => {
                const res = await fetch((pushBase ?? "/api/push") + "/flush", { method: "POST" });
                const data = (await res.json().catch(() => ({}))) as { sent?: number; queued?: number; error?: string };
                if (!res.ok) { notify(data.error ?? t("发送失败")); return; }
                notify(t("已发送 {sent} 条，队列剩 {queued} 条", { sent: data.sent ?? 0, queued: data.queued ?? 0 }));
                push.reload();
                pushLogs.reload();
                setPushPreview(null);
              }}
              onTest={async () => {
                const res = await fetch((pushBase ?? "/api/push") + "/test", { method: "POST" });
                const data = await res.json().catch(() => ({})) as { error?: string };
                notify(res.ok ? t("测试消息已发送到当前渠道") : data.error ?? t("推送未启用或缺少凭据"));
                pushLogs.reload();
              }}
            />
          )}

          {adminReady && tab === "ai" && (
            <AiPanel
              data={ai.data}
              sources={sources.data?.sources ?? []}
              reload={ai.reload}
              onNotify={notify}
              sourceName={sourceName}
              onOpenItem={async (id) => {
                const epoch = overlayEpoch.current;
                const found = items.data?.items?.find((it) => it.id === id);
                if (found) {
                  setDetail(found);
                  return;
                }
                try {
                  const res = await fetch("/api/items/" + id);
                  if (res.ok) {
                    const item = (await res.json()) as Item;
                    if (epoch !== overlayEpoch.current) return;
                    setDetail(item);
                  }
                } catch {
                  /* ignore */
                }
              }}
            />
          )}

          {tab === "me" && !me && bootData && <div className="space-y-3 py-10">
            <h2 className="text-[17px] font-semibold text-ink-950">{t("登录后查看账号与通知")}</h2>
            <p className="text-[13px] text-ink-500">{t("未登录时，收藏和屏蔽保存在当前浏览器中。")}</p>
            {bootData.loginEnabled && <button type="button" className="rounded-md bg-solid px-4 py-2 text-[13px] text-on-solid" onClick={() => { setAuthHash(null); setAuthOpen(true); }}>{t("登录")}</button>}
            <button type="button" className="scope-link ml-3" onClick={() => handleTab("feed")}>{t("回到情报流")}</button>
          </div>}
          {me && tab === "me" && bootData && <UserPushPanel key={me.id} boot={bootData} />}
          {adminReady && tab === "site" && <SiteAdminPanel onPublicConfigChange={boot.reload} />}
          {adminReady && tab === "ops" && (
            <OpsPanel
              onClassificationChanged={() => { refreshAll(); hot.reload(); digestDetail.reload(); }}
              sources={sources.data?.sources ?? []}
              runs={runs.data?.runs ?? []}
              sourceName={sourceName}
              onCollectSource={async (id) => {
                const isCookieSite = id === "zhihu-search" || id === "xhs-search" || id === "xiaoheihe-search";
                notify(isCookieSite ? t("正在通过 VPS Cookie 采集（约 15-40 秒）…") : t("正在采集…"));
                const res = await fetch(`/api/sources/${id}/collect`, { method: "POST" });
                const data = (await res.json().catch(() => ({}))) as {
                  ok?: boolean;
                  error?: string;
                  summary?: { inserted: number; fetched: number; status: string };
                };
                if (!res.ok || data.ok === false || data.summary?.status === "failed") {
                  notify(data.error ?? t("采集失败"));
                } else {
                  notify(t("完成：抓取 {fetched}，新增 {inserted}", { fetched: data.summary?.fetched ?? 0, inserted: data.summary?.inserted ?? 0 }));
                }
                refreshAll();
              }}
              onToggleSource={async (id, enabled) => {
                await fetch("/api/sources/" + id, {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ enabled }),
                });
                sources.reload();
                notify(enabled ? t("已启用该源") : t("已禁用该源"));
              }}
              onChangeInterval={async (id, sec) => {
                await fetch("/api/sources/" + id, {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ interval_sec: sec }),
                });
                sources.reload();
                notify(t("采集周期已改为 {interval}", { interval: formatInterval(sec) }));
              }}
              onAddRss={async (name, url, intervalSec, kindHint, categoryHint, fixedCategory) => {
                notify(t("正在添加并试采…"));
                const res = await fetch("/api/sources", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ name, url, intervalSec, kindHint, categoryHint, fixedCategory }),
                });
                const data = (await res.json().catch(() => ({}))) as {
                  error?: string;
                  summary?: { fetched: number; inserted: number; status: string; error?: string };
                };
                if (!res.ok) notify(data.error ?? t("添加失败"));
                else if (data.summary?.status === "failed") notify(t("已添加，但首次采集失败：{error}", { error: data.summary.error ?? "" }));
                else notify(t("已添加，抓取 {fetched} 条，新增 {inserted}", { fetched: data.summary?.fetched ?? 0, inserted: data.summary?.inserted ?? 0 }));
                refreshAll();
              }}
              onUpdateSource={async (id, patch) => {
                const res = await fetch("/api/sources/" + id, {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(patch),
                });
                const data = (await res.json().catch(() => ({}))) as { error?: string; reclassified?: number };
                if (!res.ok) {
                  notify(data.error ?? t("保存失败"));
                  return false;
                }
                // Commit the acknowledged config locally before closing/reopening the editor.
                // A background refresh must not make immediate re-edit show the previous values.
                sources.update((current) => current ? { ...current, sources: current.sources.map((source) => source.id === id ? { ...source, ...patch } : source) } : current);
                refreshAll();
                hot.reload();
                digestDetail.reload();
                notify(data.reclassified ? t("配置已更新，{n} 条历史资源已重新归类", { n: data.reclassified }) : t("数据源配置已更新"));
                return true;
              }}
              onDeleteSource={async (id) => {
                const res = await fetch("/api/sources/" + id, { method: "DELETE" });
                const data = (await res.json().catch(() => ({}))) as { error?: string };
                if (!res.ok) {
                  notify(data.error ?? t("删除失败"));
                  return false;
                }
                refreshAll();
                notify(t("已删除自定义数据源"));
                return true;
              }}
              onNotify={notify}
            />
          )}
          </Suspense>
        </main>

        <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-ink-200 px-3.5 py-3 text-[12px] text-ink-400 sm:px-6">
          <span>{t("生财雷达 · 生财有术 MCP 全文归档 · AI 脱水与立项拆解知识库")}</span>
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-ink-500 hover:text-accent" aria-label={t("GitHub 主仓库")}><Github size={12} /> GitHub</a>
          <span className="font-mono tabular-nums">
            {t("{active} 条在库 · {unread} 条未读", { active: stats.data?.totals.active ?? 0, unread: stats.data?.totals.unread ?? 0 })}
          </span>
          <span className="w-full text-[11px] leading-relaxed text-ink-400">
            {t("本站仅聚合公开渠道的资源标题与原始链接，不存储、不代理、不转存任何文件。如权利人认为内容侵权，请联系删除，本站将在收到通知后第一时间下架。")}
          </span>
        </footer>
      </div>

      {detail && (
        <ItemDetailDrawer
          item={detail}
          loading={detailLoading}
          error={detailError}
          onRetry={() => setDetailNonce((n) => n + 1)}
          sourceName={sourceName}
          hasPrev={currentIndex > 0}
          hasNext={currentIndex >= 0 && currentIndex < visible.length - 1}
          onPrev={() => currentIndex > 0 && setDetail(visible[currentIndex - 1] ?? null)}
          onNext={() => currentIndex >= 0 && currentIndex < visible.length - 1 && setDetail(visible[currentIndex + 1] ?? null)}
          onClose={() => setDetail(null)}
          onPatch={patch}
          onClassificationSave={adminReady ? async (id, update) => {
            const response = await fetch(`/api/admin/items/${id}/classification`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(update) });
            const result = await response.json() as { error?: string };
            if (!response.ok) throw new Error(result.error ?? t("保存分类失败"));
            // A fresh detail carries personal state and manual metadata without crossing user/admin scopes.
            const fullResponse = await fetch(`/api/items/${id}`);
            if (fullResponse.ok) {
              const full = await fullResponse.json() as Item;
              setDetail((current) => current?.id === id ? full : current);
            }
            refreshAll(); hot.reload(); digestDetail.reload();
          } : undefined}
          onQuickBlock={setQuickBlock}
          onCopyCode={copyCode}
          canAdmin={adminReady}
          onNotify={notify}
          onDossierUpdated={(id, dossier) => {
            setDetail((current) => current?.id === id ? { ...current, hasDossier: true, dossier } : current);
            items.update((current) => current ? {
              ...current,
              items: current.items.map((it) => it.id === id ? { ...it, hasDossier: true, dossier } : it),
            } : current);
          }}
        />
      )}

      {quickBlock && (
        <QuickBlockModal
          item={quickBlock}
          sourceName={sourceName}
          onClose={() => setQuickBlock(null)}
          onIgnoreOne={(id) => patch(id, { status: "ignored" })}
          onAddRule={quickBlockAdd}
        />
      )}

      <Toast message={toast} />

      {welcomeOpen && bootData && (
        <WelcomeModal
          boot={bootData}
          onClose={closeWelcome}
          onLogin={() => {
            closeWelcome();
            setAuthHash(null);
            setAuthOpen(true);
          }}
        />
      )}

      {authOpen && bootData && (
        <AuthModal
          boot={bootData}
          initialHash={authHash}
          onClose={() => setAuthOpen(false)}
          onDone={() => {
            setAuthOpen(false);
            boot.reload();
            setTimeout(() => {
              items.reload();
              stats.reload();
            }, 300);
          }}
        />
      )}

      {rssOpen && bootData && <RssModal boot={bootData} currentQuery={query} onClose={() => setRssOpen(false)} />}
    </div>
  );
}
