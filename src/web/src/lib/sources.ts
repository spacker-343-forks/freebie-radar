import type { Source } from "../types.ts";
import { dateLocale, t } from "./i18n.ts";

/**
 * 分类 / 形态 / 获取方式 / 频道的定义全部来自 shared/taxonomy.ts（服务端同一份），
 * 前端只做转发，避免主页、推送规则、数据源运维三处的分类表各写各的。
 */
export {
  CATEGORY_KEYS,
  CATEGORY_LABEL,
  CATEGORY_DESC,
  CATEGORY_GROUPS,
  NEWS_CATEGORY_LABEL,
  FREEBIE_CATEGORY_KEYS,
  CHANNELS,
  KIND_LABEL,
  KIND_ORDER,
  OBTAIN_LABEL,
  OBTAIN_HINT,
  OBTAIN_ORDER,
  categoriesForPreset,
  channelExcluded,
  categoryLabel,
  categoryLabelForPreset,
  categoryLabelForKind,
  categoryOptionGroups,
  isCategory,
} from "../../../shared/taxonomy.ts";

export type SourceGroupKey = "news" | "community" | "game" | "software" | "deals";

export const SOURCE_GROUPS: { key: SourceGroupKey; label: string }[] = [
  { key: "community", label: t("国内社区与线报") },
  { key: "news", label: t("重要新闻与行业资讯") },
  { key: "game", label: t("游戏喜加一与史低") },
  { key: "software", label: t("软件 · AI · 开源") },
  { key: "deals", label: t("综合羊毛与优惠") },
];

export function groupOfSource(s: Source): SourceGroupKey {
  const id = s.id;
  if (
    id.startsWith("cctv-") ||
    id.startsWith("rss-chinanews-") ||
    id.startsWith("rss-gnews-") ||
    id === "rss-bbc-zh" ||
    id === "rss-dw-cn" ||
    id === "rss-rfi-cn" ||
    id === "rss-nikkei-cn" ||
    id === "rss-voa-cn" ||
    id === "rss-wallstreetcn" ||
    id === "rss-qbitai" ||
    id === "rss-leiphone" ||
    id === "rss-tmtpost" ||
    id === "rss-ifanr" ||
    id === "rss-openai-blog" ||
    id === "rss-cloudflare-blog" ||
    id === "rss-ithome" ||
    id === "rss-sspai" ||
    id === "rss-ruanyifeng" ||
    id === "rss-hnrss" ||
    id === "rss-solidot" ||
    id === "rss-producthunt"
  ) {
    return "news";
  }
  if (
    id.startsWith("scys-") ||
    id.startsWith("linuxdo-") ||
    id.startsWith("v2ex-") ||
    id.includes("nodeseek") ||
    id === "rss-deepflood" ||
    id === "rss-nodeloc" ||
    id === "rss-meta-appinn" ||
    id.endsWith("-search") ||
    id.startsWith("nga-") ||
    id === "tg-cn-deals"
  ) {
    return "community";
  }
  if (
    id === "epic-free" ||
    id === "steam-free" ||
    id.startsWith("gamerpower") ||
    id === "cheapshark-free" ||
    id === "gog-free" ||
    id === "tg-freegames" ||
    id === "bsky-gamedeals" ||
    /itad|isthereanydeal|indiegame|ggdeals|keylol|freegame|gamedeal|itch-free|freesteamkeys/i.test(id)
  ) {
    return "game";
  }
  if (
    id.startsWith("github-") ||
    id === "openrouter-free" ||
    id === "bsky-plugins" ||
    /shareware|tickcoupon|giveawayoftheday|ghxi|yxssp|freegroup|appinn|iplaysoft|iapps|apphookup|googleplay|freeebooks/i.test(
      id,
    )
  ) {
    return "software";
  }
  return "deals";
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  const diff = Date.now() - ms;
  // 未来时间戳（Epic「即将免费」把开卖时间写进 published_at）不能算成「刚刚」，
  // 否则列表会永远停在刚打开的那一刻。
  if (diff < 0) {
    const inMin = Math.round(-diff / 60000);
    if (inMin < 60) return t("即将开始");
    const inHour = Math.round(inMin / 60);
    if (inHour < 24) return t("{n} 小时后开始", { n: inHour });
    return t("{n} 天后开始", { n: Math.round(inHour / 24) });
  }
  const m = Math.round(diff / 60000);
  if (m < 1) return t("刚刚");
  if (m < 60) return t("{n} 分钟前", { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t("{n} 小时前", { n: h });
  const d = Math.round(h / 24);
  if (d < 30) return t("{n} 天前", { n: d });
  return new Date(iso).toLocaleDateString(dateLocale());
}

export function expiresLabel(iso: string | null | undefined): { text: string; urgent: boolean } | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  const days = Math.ceil((ms - Date.now()) / 86_400_000);
  if (days < 0) return { text: t("已过期"), urgent: true };
  if (days === 0) return { text: t("今天截止"), urgent: true };
  return { text: t("{n} 天后截止", { n: days }), urgent: days <= 3 };
}

/** 从标题里拆出方便点击快速屏蔽的候选词片段（中英分词的轻量替代）。 */
export function extractBlockCandidates(title: string): string[] {
  const parts = title
    .replace(/【[^】]+】|\[[^\]]+\]/g, " ")
    .split(/[\s|,，。：:；;!?！？/()（）·—-]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 16 && !/^\d+$/.test(s));
  return [...new Set(parts)].slice(0, 8);
}

export function formatInterval(sec: number): string {
  if (sec < 120) return t("{n} 秒", { n: sec });
  if (sec < 3600) return t("{n} 分钟", { n: Math.round(sec / 60) });
  return t("{n} 小时", { n: (sec / 3600).toFixed(sec % 3600 === 0 ? 0 : 1) });
}
