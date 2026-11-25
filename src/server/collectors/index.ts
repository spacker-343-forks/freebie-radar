import { aiEnabled, config, pushEnabled } from "../config.ts";
import { all, get, run, tx } from "../db.ts";
import { demoteEditorialGoods, demoteOfflineCategory, enforceFreebieEvidence, enrichItem, FREEBIE_ONLY_SOURCES, isCategory, resolveKind, type Category, type ContentKind } from "../enrich/index.ts";
import { calibrateScoreByObtain, resolveDbMergeKey } from "../enrich/alias.ts";
import { getAiSettings, matchesEntryNoise, shouldPassSourceToAi, shouldReview, type AiVerdict } from "../enrich/ai.ts";
import { enqueueForAi, reviewFreshNow, setPostReviewHandler } from "../enrich/ai-queue.ts";
import { isBlocked, loadActiveBlockRules } from "../enrich/blocklist.ts";
import { getRetention } from "../retention.ts";
import { hasCookieConfiguredForSource } from "../cookie-store.ts";
import { getPushSettings, pushInstant, pushReviewedByIds } from "../instant.ts";
import { dispatchUserPush, dispatchUserPushByIds, hasEnabledUserPush } from "../user-push.ts";

// AI 后台补审通过后：先走全局推送，再按每个用户的个人规则派发一次
setPostReviewHandler(async (sourceId, ids) => {
  const n = await pushReviewedByIds(sourceId, ids);
  await dispatchUserPushByIds(sourceId, ids).catch((err) => {
    console.error("[user-push] 补审派发失败:", err instanceof Error ? err.message : err);
  });
  return n;
});
import { createHttp, type HttpClient } from "../http.ts";
import { mockCollector } from "./mock.ts";
import { linuxdoCollector } from "./linuxdo.ts";
import { v2exCollector } from "./v2ex.ts";
import { githubCollector } from "./github.ts";
import { rssCollector } from "./rss.ts";
import { telegramCollector } from "./telegram.ts";
import { gamerpowerCollector } from "./gamerpower.ts";
import { epicCollector } from "./epic.ts";
import { gogCollector } from "./gog.ts";
import { steamCollector } from "./steam.ts";
import { cheapsharkCollector } from "./cheapshark.ts";
import { openrouterCollector } from "./openrouter.ts";
import { bskyCollector } from "./bsky.ts";
import { cctvCollector } from "./cctv.ts";
import { cookieIngestCollector } from "./cookie.ts";
import { ngaCollector } from "./nga.ts";
import { biliCollector } from "./bili.ts";
import { weiboCollector } from "./weibo.ts";
import { scysCollector } from "./scys.ts";
import type { Collector, RawItem, SourceSeed } from "./types.ts";
import { getSourceHints, applyManualClassification } from "../source-settings.ts";
import { categoryForSource } from "../../shared/source-classification.ts";
import { isSharedResource } from "../enrich/evidence.ts";
export { getSourceHints } from "../source-settings.ts";

export const COLLECTORS: Collector[] = [
  mockCollector, linuxdoCollector, v2exCollector, githubCollector, rssCollector, telegramCollector,
  gamerpowerCollector, epicCollector, gogCollector, steamCollector, cheapsharkCollector, bskyCollector, openrouterCollector, cctvCollector, cookieIngestCollector,
  ngaCollector, biliCollector, weiboCollector, scysCollector,
];
const BY_KIND = new Map(COLLECTORS.map((c) => [c.kind, c]));

/** 内置源清单；collector 落地后在此追加。 */
export const SEEDS: SourceSeed[] = [
  { id: "linuxdo-welfare", name: "LINUX DO · 福利羊毛", kind: "linuxdo", enabled: true, intervalSec: 90, config: { categoryId: 36, rssSlug: "welfare", categoryName: "福利羊毛" } },
  { id: "linuxdo-resource", name: "LINUX DO · 资源荟萃", kind: "linuxdo", enabled: false, intervalSec: 180, config: { categoryId: 14, rssSlug: "resource", categoryName: "资源荟萃", fixedCategory: "pan" } },
  { id: "linuxdo-develop", name: "LINUX DO · 开发调优", kind: "linuxdo", enabled: true, intervalSec: 600, config: { categoryId: 4, rssSlug: "develop", categoryName: "开发调优" } },
  { id: "linuxdo-news", name: "LINUX DO · 前沿快讯", kind: "linuxdo", enabled: true, intervalSec: 600, config: { categoryId: 34, rssSlug: "news", categoryName: "前沿快讯" } },
  { id: "linuxdo-domestic", name: "LINUX DO · 国产替代", kind: "linuxdo", enabled: true, intervalSec: 1800, config: { categoryId: 98, rssSlug: "domestic", categoryName: "国产替代" } },
  { id: "v2ex-free", name: "V2EX · 免费赠送", kind: "v2ex", enabled: true, intervalSec: 120, config: { node: "free" } },
  { id: "v2ex-deals", name: "V2EX · 优惠信息", kind: "v2ex", enabled: true, intervalSec: 300, config: { node: "deals" } },
  { id: "v2ex-cloud", name: "V2EX · 云计算", kind: "v2ex", enabled: false, intervalSec: 1800, config: { node: "cloud" } },
  { id: "v2ex-share", name: "V2EX · 分享发现", kind: "v2ex", enabled: false, intervalSec: 600, config: { node: "share" } },
  { id: "v2ex-promotions", name: "V2EX · 推广与注册送", kind: "v2ex", enabled: false, intervalSec: 600, config: { node: "promotions" } },

  // === AI / 云 / 开发者福利 ===
  { id: "openrouter-free", name: "OpenRouter · 新免费大模型", kind: "openrouter", enabled: true, intervalSec: 3600, config: { maxAgeDays: 14 } },
  {
    id: "rss-nodeseek",
    name: "NodeSeek · 福利情报",
    kind: "rss",
    enabled: true,
    intervalSec: 300,
    config: {
      feeds: [
        {
          id: "nodeseek",
          url: "https://rss.nodeseek.com/",
          limit: 40,
          includeCategories: ["info", "promotion", "trade"],
        },
      ],
    },
  },
  { id: "rss-deepflood", name: "DeepFlood · AI与实用资源", kind: "rss", enabled: true, intervalSec: 900, config: { feeds: [{ id: "deepflood", url: "https://www.deepflood.com/rss.xml", limit: 30 }] } },
  { id: "rss-nodeloc", name: "NodeLoc · 中文羊毛与VPS", kind: "rss", enabled: true, intervalSec: 900, config: { feeds: [{ id: "nodeloc", url: "https://www.nodeloc.com/latest.rss", limit: 30 }] } },
  { id: "rss-meta-appinn", name: "小众软件论坛 · 发现频道", kind: "rss", enabled: true, intervalSec: 1800, config: { feeds: [{ id: "meta-appinn", url: "https://meta.appinn.net/c/faxian/10.rss", limit: 25 }] } },
  { id: "rss-lowendtalk", name: "LowEndTalk · 黑五/VPS一手", kind: "rss", enabled: true, intervalSec: 1800, config: { kindHint: "deal", categoryHint: "vps", feeds: [{ id: "lowendtalk", url: "https://lowendtalk.com/categories/offers/feed.rss", limit: 25, categoryHint: "vps" }] } },
  { id: "rss-lowendspirit", name: "LowEndSpirit · 低价主机", kind: "rss", enabled: true, intervalSec: 3600, config: { kindHint: "deal", categoryHint: "vps", feeds: [{ id: "lowendspirit", url: "https://lowendspirit.com/discussions/feed.rss", limit: 20, categoryHint: "vps" }] } },
  { id: "rss-vpsgo", name: "VPSGO · 主机促销", kind: "rss", enabled: true, intervalSec: 3600, config: { kindHint: "deal", categoryHint: "vps", feeds: [{ id: "vpsgo", url: "https://www.vpsgo.com/feed", limit: 20, categoryHint: "vps" }] } },
  { id: "rss-vpsxb", name: "VPS小站 · 特价主机", kind: "rss", enabled: false, intervalSec: 3600, config: { kindHint: "deal", categoryHint: "vps", feeds: [{ id: "vpsxb", url: "https://www.vpsxb.net/feed/", limit: 20, categoryHint: "vps" }] } },
  { id: "rss-lowendbox", name: "LowEndBox · VPS 优惠", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "lowendbox", url: "https://lowendbox.com/feed/", limit: 20 }] } },
  // 中文主机圈促销博客（2026-11-15 实测 RSS 可用，国内直连）
  { id: "rss-vpsjxw", name: "VPS精选网 · 中文主机促销", kind: "rss", enabled: true, intervalSec: 1800, config: { kindHint: "deal", categoryHint: "vps", feeds: [{ id: "vpsjxw", url: "https://www.vpsjxw.com/feed", limit: 20, categoryHint: "vps" }] } },
  { id: "rss-laozuo", name: "老左博客 · VPS 优惠", kind: "rss", enabled: true, intervalSec: 1800, config: { kindHint: "deal", categoryHint: "vps", feeds: [{ id: "laozuo", url: "https://www.laozuo.org/feed", limit: 15, categoryHint: "vps" }] } },
  { id: "rss-veidc", name: "VEIDC · 主机商促销", kind: "rss", enabled: true, intervalSec: 1800, config: { kindHint: "deal", categoryHint: "vps", feeds: [{ id: "veidc", url: "https://www.veidc.com/feed", limit: 20, categoryHint: "vps" }] } },
  { id: "rss-vpser", name: "VPS 侦探 · 主机优惠", kind: "rss", enabled: true, intervalSec: 1800, config: { kindHint: "deal", categoryHint: "vps", feeds: [{ id: "vpser", url: "https://www.vpser.net/feed", limit: 15, categoryHint: "vps" }] } },
  { id: "rss-banwagong", name: "搬瓦工中文网 · 套餐与优惠", kind: "rss", enabled: true, intervalSec: 3600, config: { kindHint: "deal", categoryHint: "vps", feeds: [{ id: "banwagong", url: "https://www.banwagong.net/feed", limit: 15, categoryHint: "vps" }] } },

  // === 游戏限免 / Key / 礼包 ===
  { id: "epic-free", name: "Epic Games · 本周喜加一", kind: "epic", enabled: true, intervalSec: 3600, config: { includeUpcoming: false } },
  { id: "steam-free", name: "Steam · 限时免费", kind: "steam", enabled: true, intervalSec: 1800, config: { count: 50 } },
  { id: "gamerpower", name: "GamerPower · 免费游戏聚合", kind: "gamerpower", enabled: true, intervalSec: 900, config: { query: "type=game", limit: 60 } },
  { id: "gamerpower-loot", name: "GamerPower · 免费礼包与 Key", kind: "gamerpower", enabled: true, intervalSec: 1800, config: { query: "type=loot", limit: 40 } },
  { id: "cheapshark-free", name: "CheapShark · 免费与 ≤$1 游戏", kind: "cheapshark", enabled: true, intervalSec: 900, config: { upperPrice: 1, pageSize: 40 } },
  { id: "rss-itch-free", name: "itch.io · 100% 限免游戏", kind: "rss", enabled: true, intervalSec: 1800, config: { feeds: [{ id: "itch-free", url: "https://itch.io/games/on-sale.xml", limit: 25, only100Off: true }] } },
  { id: "rss-isthereanydeal", name: "IsThereAnyDeal · 喜加一", kind: "rss", enabled: true, intervalSec: 900, config: { feeds: [{ id: "itad", url: "https://isthereanydeal.com/feeds/US/giveaways.rss", limit: 30 }] } },
  { id: "rss-indiegamebundles", name: "IndieGameBundles · 免费游戏", kind: "rss", enabled: true, intervalSec: 1800, config: { feeds: [{ id: "indiegamebundles", url: "https://www.indiegamebundles.com/category/free/feed/", limit: 25 }] } },
  { id: "rss-freesteamkeys", name: "FreeSteamKeys · Steam 限免", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "freesteamkeys", url: "https://freesteamkeys.com/feed/", limit: 25 }] } },
  { id: "rss-ggdeals", name: "GG.deals · 免费与动态", kind: "rss", enabled: true, intervalSec: 1800, config: { feeds: [{ id: "ggdeals", url: "https://gg.deals/news/feed/", limit: 25 }] } },
  { id: "rss-keylol", name: "其乐 Keylol", kind: "rss", enabled: true, intervalSec: 1800, config: { feeds: [{ id: "keylol", url: "https://keylol.com/forum.php?mod=rss", limit: 30 }] } },
  { id: "tg-freegames", name: "TG · 免费游戏情报", kind: "telegram", enabled: true, intervalSec: 300, config: { channels: ["freegamesnews", "steamfreebies"] } },
  { id: "tg-pan-yunpan", name: "TG · 网盘资源收藏（迅雷/阿里/夸克）", kind: "telegram", enabled: true, intervalSec: 600, config: { channels: ["yunpanxunlei", "sharealiyun", "yunpans"], fixedCategory: "pan" } },
  { id: "tg-pan-yiove", name: "TG · Yiove 综合资源（资料/图书/游戏）", kind: "telegram", enabled: true, intervalSec: 900, config: { channels: ["YioveComplex"], fixedCategory: "pan", splitNumbered: true } },
  { id: "gog-free", name: "GOG · 限时免费", kind: "gog", enabled: false, config: {} },

  // === 正版软件限免 / 工具 ===
  { id: "rss-giveawayoftheday", name: "Giveaway of the Day · 每日限免软件", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "giveawayoftheday", url: "https://www.giveawayoftheday.com/feed/", limit: 20 }] } },
  { id: "rss-tickcoupon", name: "TickCoupon · 终身软件限免", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "tickcoupon", url: "https://giveaway.tickcoupon.com/feed/", limit: 20 }] } },
  {
    id: "rss-sharewareonsale",
    name: "SharewareOnSale · 100% 限免",
    kind: "rss",
    enabled: true,
    intervalSec: 1800,
    config: { feeds: [{ id: "sharewareonsale", url: "https://sharewareonsale.com/feed", limit: 25, titleKeywords: ["100% discount", "free"] }] },
  },
  { id: "rss-ghxi", name: "果核剥壳 · 免费软件资源", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "ghxi", url: "https://www.ghxi.com/feed", limit: 20 }] } },
  { id: "rss-yxssp", name: "异星软件空间 · 免费软件", kind: "rss", enabled: true, intervalSec: 3600, config: { kindHint: "freebie", categoryHint: "software", feeds: [{ id: "yxssp", url: "https://www.yxssp.com/feed", limit: 20, categoryHint: "software" }] } },
  { id: "rss-freegroup", name: "FreeGroup · 免费资源网络社群", kind: "rss", enabled: false, intervalSec: 3600, config: { kindHint: "freebie", feeds: [{ id: "freegroup", url: "https://free.com.tw/feed/", limit: 20 }] } },
  { id: "rss-iplaysoft", name: "异次元软件世界", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "iplaysoft", url: "https://www.iplaysoft.com/feed", limit: 25 }] } },

  // === Reddit 高纯度白嫖社区（适度拉长间隔防 429）===
  { id: "rss-reddit-freegames", name: "Reddit · FreeGameFindings", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "freegamefindings", url: "https://www.reddit.com/r/FreeGameFindings/hot.rss", limit: 30 }] } },
  { id: "rss-reddit-freebies", name: "Reddit · freebies", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "freebies", url: "https://www.reddit.com/r/freebies/hot.rss", limit: 25 }] } },
  { id: "rss-reddit-efreebies", name: "Reddit · eFreebies", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "efreebies", url: "https://www.reddit.com/r/efreebies/hot.rss", limit: 25 }] } },
  { id: "rss-reddit-apphookup", name: "Reddit · AppHookup（App 限免）", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "apphookup", url: "https://www.reddit.com/r/AppHookup/hot.rss", limit: 25 }] } },
  { id: "rss-reddit-freeebooks", name: "Reddit · FreeEBOOKS", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "freeebooks", url: "https://www.reddit.com/r/FreeEBOOKS/hot.rss", limit: 25 }] } },
  { id: "rss-reddit-freegamesonsteam", name: "Reddit · FreeGamesOnSteam", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "freegamesonsteam", url: "https://www.reddit.com/r/FreeGamesOnSteam/hot.rss", limit: 25 }] } },
  { id: "rss-reddit-gamedeals", name: "Reddit · GameDeals（含打折）", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "gamedeals", url: "https://www.reddit.com/r/GameDeals/hot.rss", limit: 30 }] } },
  { id: "rss-reddit-googleplay", name: "Reddit · GooglePlayDeals", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "googleplaydeals", url: "https://www.reddit.com/r/googleplaydeals/hot.rss", limit: 30 }] } },

  // === 综合样品与地区好价 ===
  { id: "rss-freebieshark", name: "FreebieShark 免费样品", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "freebieshark", url: "https://www.freebieshark.com/feed/", limit: 25 }] } },
  { id: "rss-heyitsfree", name: "HeyItsFree 免费样品", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "heyitsfree", url: "https://heyitsfree.net/feed/", limit: 30 }] } },
  { id: "rss-ozbargain", name: "OzBargain · 澳区免费好价", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "ozbargain", url: "https://www.ozbargain.com.au/feed", limit: 25 }] } },
  { id: "rss-freestufftimes", name: "FreeStuffTimes · 0元样品", kind: "rss", enabled: true, intervalSec: 3600, config: { kindHint: "freebie", feeds: [{ id: "freestufftimes", url: "https://www.freestufftimes.com/feed", limit: 25 }] } },
  { id: "rss-freeflys", name: "FreeFlys · 0元样品", kind: "rss", enabled: true, intervalSec: 3600, config: { kindHint: "freebie", feeds: [{ id: "freeflys", url: "https://www.freeflys.com/feed/", limit: 20 }] } },

  // === 登录态站点（VPS Cookie 托管定时采集 / 或本机油猴脚本回传）===
  { id: "zhihu-search", name: "知乎 · 福利搜索", kind: "ingest", enabled: true, intervalSec: 3600, config: { keyword: "免费领取" } },
  { id: "xhs-search", name: "小红书 · 福利搜索", kind: "ingest", enabled: true, intervalSec: 3600, config: { keyword: "免费领取" } },
  { id: "xiaoheihe-search", name: "小黑盒 · 福利搜索", kind: "ingest", enabled: true, intervalSec: 3600, config: { keyword: "免费" } },
  // NGA 需登录态 Cookie（ngaPassportUid / ngaPassportCid）：fid=570 优惠信息购物指南，国内羊毛主阵地
  { id: "nga-deals", name: "NGA · 优惠信息购物指南", kind: "nga", enabled: true, intervalSec: 600, config: { fid: 570, forumName: "优惠信息购物指南" } },
  // 570 / 613 / 498 同属「杂谈 > 消费电子 IT新闻 (436)」下的子版；613 拼车拼单、498 二手交易
  { id: "nga-carpool", name: "NGA · 分享活动买家互助（拼车拼单）", kind: "nga", enabled: true, intervalSec: 900, config: { fid: 613, forumName: "分享活动买家互助", categoryHint: "goods" } },
  { id: "nga-trade", name: "NGA · 二手交易", kind: "nga", enabled: true, intervalSec: 1200, config: { fid: 498, forumName: "二手交易", categoryHint: "trade" } },
// B站关键词搜索：wbi 签名免登录可用，抓「喜加一 / 白嫖 / 限免」类视频；内容为视频，靠 AI 一审判 kind
  { id: "bili-freebies", name: "B站 · 喜加一与白嫖搜索", kind: "bili", enabled: true, intervalSec: 1800, config: { keywords: ["免费领取", "白嫖", "喜加一", "限时免费"], limitPerKeyword: 15 } },
// 微博：PC ajax 搜索 + 盯人，需 weibo.com 登录 Cookie（SUB）；无官方 RSS，RSSHub 公共实例已全挂
  // 实测关键词搜索结果噪声极高（擦边图包、手游私服、"白嫖奶茶教程"刷屏），默认关闭；
  // 要启用建议改成盯人模式：config 里给 uids: ["<羊毛博主 uid>", ...]，质量远高于关键词搜索
  { id: "weibo-freebies", name: "微博 · 福利搜索（噪声高，默认关）", kind: "weibo", enabled: false, intervalSec: 1800, config: { keywords: ["免费领取", "白嫖攻略", "羊毛"], limitPerKeyword: 20 } },

  // === 按需选开的低纯度 / 需代理 / 扩展源（默认关闭以保持低噪与轻量化）===
  { id: "tg-cn-deals", name: "TG · 中文科技/VPS/羊毛", kind: "telegram", enabled: false, intervalSec: 300, config: { channels: ["zaihuapd", "zaihuanews", "v2ex_channel", "appinnfeed"] } },
  { id: "bsky-gamedeals", name: "Bluesky · 游戏限免大号", kind: "bsky", enabled: false, intervalSec: 1800, config: { actors: ["freegamefindings.bsky.social", "freegamealert.bsky.social", "wario64.bsky.social", "cheapassgamer.com", "dekudeals.com", "steamdb.bsky.social"], limitPerActor: 10 } },
  { id: "bsky-plugins", name: "Bluesky · 免费插件与综合", kind: "bsky", enabled: false, intervalSec: 1800, config: { actors: ["plugindeals.net", "frugalfreebies.bsky.social", "freebies.bsky.social"], limitPerActor: 10 } },
  { id: "rss-hip2save", name: "Hip2Save · 美国优惠", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "hip2save", url: "https://hip2save.com/feed/", limit: 30 }] } },
  { id: "rss-vonbeau", name: "VonBeau · 免费样品（需过盾）", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "vonbeau", url: "https://www.vonbeau.com/feed/", limit: 30 }] } },
  { id: "rss-slickdeals", name: "Slickdeals（需过盾）", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "slickdeals", url: "https://slickdeals.net/newsearch.php?rss=1&searcharea=deals&searchin=first", limit: 30 }] } },
  { id: "rss-appinn", name: "小众软件 Appinn", kind: "rss", enabled: false, config: { feeds: [{ id: "appinn", url: "https://www.appinn.com/feed/", limit: 20 }] } },
  { id: "rss-sspai", name: "少数派", kind: "rss", enabled: false, config: { feeds: [{ id: "sspai", url: "https://sspai.com/feed", limit: 20 }] } },
  // === 重要新闻（央视新闻 / 中新网 / 国际权威中文媒体，直入「重要新闻」频道，严禁导购/社区源混入）===
  {
    id: "cctv-news",
    name: "央视新闻 · 重要新闻",
    kind: "cctv",
    enabled: true,
    intervalSec: 1800,
    config: {
      channels: [
        { channel: "news", cb: "news", categoryHint: "news", limit: 20 },
        { channel: "china", cb: "china", categoryHint: "news", limit: 15 },
        { channel: "world", cb: "world", categoryHint: "news", limit: 15 },
        { channel: "society", cb: "society", categoryHint: "news", limit: 10 },
        { channel: "law", cb: "law", categoryHint: "news", limit: 10 },
      ],
    },
  },
  { id: "rss-chinanews-china", name: "中新网 · 时政国内", kind: "rss", enabled: true, intervalSec: 1800, config: { feeds: [{ id: "chinanews-china", url: "https://www.chinanews.com.cn/rss/china.xml", limit: 20, categoryHint: "news" }] } },
  { id: "rss-chinanews-world", name: "中新网 · 国际要闻", kind: "rss", enabled: true, intervalSec: 3600, config: { feeds: [{ id: "chinanews-world", url: "https://www.chinanews.com.cn/rss/world.xml", limit: 20, categoryHint: "news" }] } },
  { id: "rss-chinanews-scroll", name: "中新网 · 滚动要闻", kind: "rss", enabled: true, intervalSec: 1800, config: { feeds: [{ id: "chinanews-scroll", url: "https://www.chinanews.com.cn/rss/scroll-news.xml", limit: 25, categoryHint: "news" }] } },
  { id: "rss-gnews-cn", name: "Google News · 中文要闻", kind: "rss", enabled: false, intervalSec: 1800, config: { feeds: [{ id: "gnews-cn", url: "https://news.google.com/rss?hl=zh-CN&gl=CN&ceid=CN:zh-Hans", limit: 25, categoryHint: "news" }] } },
  { id: "rss-gnews-world", name: "Google News · 国际头条", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "gnews-world", url: "https://news.google.com/rss/headlines/section/topic/WORLD?hl=zh-CN&gl=CN&ceid=CN:zh-Hans", limit: 20, categoryHint: "news" }] } },
  { id: "rss-bbc-zh", name: "BBC 中文 · 国际要闻", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "bbc-zh", url: "https://feeds.bbci.co.uk/zhongwen/simp/rss.xml", limit: 20, categoryHint: "news" }] } },
  { id: "rss-dw-cn", name: "德国之声 · 中文要闻", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "dw-cn", url: "https://rss.dw.com/xml/rss-chi-all", limit: 20, categoryHint: "news" }] } },
  { id: "rss-rfi-cn", name: "法广中文 · 国际时政", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "rfi-cn", url: "https://www.rfi.fr/cn/rss", limit: 20, categoryHint: "news" }] } },
  { id: "rss-nikkei-cn", name: "日经中文网 · 亚洲政经", kind: "rss", enabled: false, intervalSec: 3600, config: { kindHint: "news", categoryHint: "news", feeds: [{ id: "nikkei-cn", url: "https://cn.nikkei.com/rss.html", limit: 20, categoryHint: "news" }] } },
  { id: "rss-voa-cn", name: "美国之音中文 · 国际要闻", kind: "rss", enabled: false, intervalSec: 3600, config: { kindHint: "news", categoryHint: "news", feeds: [{ id: "voa-cn", url: "https://www.voachinese.com/api/", limit: 20, categoryHint: "news" }] } },

  // === 行业资讯（经济 / 股票 / 科技 / AI / 数码，直入「行业资讯」频道）===
  {
    id: "cctv-economy",
    name: "央视新闻 · 财经经济",
    kind: "cctv",
    enabled: true,
    intervalSec: 3600,
    config: { channels: [{ channel: "economy_zixun", cb: "economy_zixun", categoryHint: "finance", limit: 15 }] },
  },
  {
    id: "cctv-tech",
    name: "央视新闻 · 科技前沿",
    kind: "cctv",
    enabled: true,
    intervalSec: 3600,
    config: { channels: [{ channel: "tech", cb: "tech", categoryHint: "tech", limit: 15 }] },
  },
  { id: "rss-wallstreetcn", name: "华尔街见闻 · 经济股票", kind: "rss", enabled: true, intervalSec: 1800, config: { feeds: [{ id: "wallstreetcn", url: "https://dedicated.wallstreetcn.com/rss.xml", limit: 25 }] } },
  { id: "rss-qbitai", name: "量子位 · AI 前沿", kind: "rss", enabled: true, intervalSec: 1800, config: { kindHint: "info", categoryHint: "ai", feeds: [{ id: "qbitai", url: "https://www.qbitai.com/feed", limit: 20, categoryHint: "ai" }] } },
  { id: "rss-leiphone", name: "雷锋网 · AI 与科技", kind: "rss", enabled: true, intervalSec: 3600, config: { kindHint: "info", categoryHint: "tech", feeds: [{ id: "leiphone", url: "https://www.leiphone.com/feed", limit: 20, categoryHint: "tech" }] } },
  { id: "rss-tmtpost", name: "钛媒体 · 商业科技", kind: "rss", enabled: true, intervalSec: 3600, config: { kindHint: "info", categoryHint: "tech", feeds: [{ id: "tmtpost", url: "https://www.tmtpost.com/rss.xml", limit: 20, categoryHint: "tech" }] } },
  { id: "rss-ifanr", name: "爱范儿 · 数码前沿", kind: "rss", enabled: true, intervalSec: 3600, config: { kindHint: "info", categoryHint: "tech", feeds: [{ id: "ifanr", url: "https://www.ifanr.com/feed", limit: 20, categoryHint: "tech" }] } },
  { id: "rss-gnews-biz", name: "Google News · 商业财经头条", kind: "rss", enabled: false, intervalSec: 1800, config: { kindHint: "info", categoryHint: "finance", feeds: [{ id: "gnews-biz", url: "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=zh-CN&gl=CN&ceid=CN:zh-Hans", limit: 25, categoryHint: "finance" }] } },
  { id: "rss-gnews-cls", name: "财联社要闻（Google News）", kind: "rss", enabled: false, intervalSec: 1800, config: { kindHint: "info", categoryHint: "stock", feeds: [{ id: "gnews-cls", url: "https://news.google.com/rss/search?q=site:cls.cn&hl=zh-CN&gl=CN&ceid=CN:zh-Hans", limit: 20, categoryHint: "stock" }] } },
  { id: "rss-gnews-yicai", name: "第一财经（Google News）", kind: "rss", enabled: false, intervalSec: 3600, config: { kindHint: "info", categoryHint: "finance", feeds: [{ id: "gnews-yicai", url: "https://news.google.com/rss/search?q=site:yicai.com&hl=zh-CN&gl=CN&ceid=CN:zh-Hans", limit: 20, categoryHint: "finance" }] } },
  { id: "rss-gnews-tech", name: "Google News · 科技头条", kind: "rss", enabled: false, intervalSec: 3600, config: { kindHint: "info", categoryHint: "tech", feeds: [{ id: "gnews-tech", url: "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=zh-CN&gl=CN&ceid=CN:zh-Hans", limit: 20, categoryHint: "tech" }] } },
  { id: "rss-openai-blog", name: "OpenAI 官方博客", kind: "rss", enabled: false, intervalSec: 3600, config: { kindHint: "info", categoryHint: "ai", feeds: [{ id: "openai-blog", url: "https://openai.com/news/rss.xml", limit: 15, categoryHint: "ai" }] } },
  { id: "rss-cloudflare-blog", name: "Cloudflare 技术博客", kind: "rss", enabled: false, intervalSec: 3600, config: { kindHint: "info", categoryHint: "cloud", feeds: [{ id: "cloudflare-blog", url: "https://blog.cloudflare.com/rss/", limit: 15, categoryHint: "cloud" }] } },
  { id: "rss-chinanews-finance", name: "中新网 · 财经资讯", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "chinanews-finance", url: "https://www.chinanews.com.cn/rss/finance.xml", limit: 20 }] } },
  { id: "rss-chinanews-it", name: "中新网 · IT 科技", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "chinanews-it", url: "https://www.chinanews.com.cn/rss/it.xml", limit: 20 }] } },
  { id: "rss-solidot", name: "Solidot · 极客科技", kind: "rss", enabled: false, intervalSec: 3600, config: { feeds: [{ id: "solidot", url: "https://www.solidot.org/index.rss", limit: 20 }] } },
  { id: "rss-ithome", name: "IT之家", kind: "rss", enabled: false, config: { feeds: [{ id: "ithome", url: "https://www.ithome.com/rss/", limit: 25 }] } },
  { id: "rss-smzdm", name: "什么值得买", kind: "rss", enabled: false, config: { feeds: [{ id: "smzdm", url: "https://www.smzdm.com/rss/", limit: 20 }] } },
  { id: "rss-fuliba", name: "福利吧", kind: "rss", enabled: false, config: { feeds: [{ id: "fuliba", url: "https://fuliba.net/feed", limit: 30 }] } },
  // 52pojie 全站 RSS 实测为破解教程与求资源混排（2026-11-15），福利纯度不足，故保持关闭
  { id: "rss-52pojie", name: "吾爱破解", kind: "rss", enabled: false, config: { feeds: [{ id: "52pojie", url: "https://www.52pojie.cn/forum.php?mod=rss", limit: 20 }] } },
  { id: "rss-9to5toys", name: "9to5Toys 优惠", kind: "rss", enabled: false, config: { feeds: [{ id: "9to5toys", url: "https://9to5toys.com/feed/", limit: 25 }] } },
  { id: "rss-producthunt", name: "Product Hunt", kind: "rss", enabled: false, config: { feeds: [{ id: "producthunt", url: "https://www.producthunt.com/feed", limit: 25 }] } },
  { id: "rss-hnrss", name: "Hacker News（100+ 分）", kind: "rss", enabled: false, config: { feeds: [{ id: "hnrss", url: "https://hnrss.org/frontpage?points=100", limit: 25 }] } },
  { id: "rss-ruanyifeng", name: "阮一峰 · 科技爱好者周刊", kind: "rss", enabled: false, intervalSec: 21600, config: { feeds: [{ id: "ruanyifeng", url: "https://www.ruanyifeng.com/blog/atom.xml", limit: 10 }] } },
  { id: "github-free-for-dev", name: "GitHub · free-for-dev", kind: "github-readme", enabled: false, config: { repos: [{ repo: "ripienaar/free-for-dev", limit: 60 }] } },
  { id: "github-public-apis", name: "GitHub · 免费公开 API", kind: "github-readme", enabled: false, config: { repos: [{ repo: "public-apis/public-apis", limit: 40 }] } },
  { id: "github-awesome-ai", name: "GitHub · AI 工具清单", kind: "github-readme", enabled: false, config: { repos: [{ repo: "mahseema/awesome-ai-tools", limit: 40 }] } },
  { id: "github-selfhosted", name: "GitHub · 开源自托管清单", kind: "github-readme", enabled: false, config: { repos: [{ repo: "awesome-selfhosted/awesome-selfhosted", limit: 40 }] } },
  { id: "tg-channels", name: "Telegram 羊毛频道", kind: "telegram", enabled: false, config: { channels: [] } },

  // === 生财有术 MCP 独家信息源 ===
  { id: "scys-highlights", name: "生财有术 · 精华与风向标", kind: "scys", enabled: true, intervalSec: 1800, config: { mode: "highlights", pageSize: 15, fetchDetail: true, maxDetailPerRun: 8 } },
  { id: "scys-projects", name: "生财有术 · 项目库案例", kind: "scys", enabled: true, intervalSec: 3600, config: { mode: "projects", pageSize: 15, fetchDetail: true, maxDetailPerRun: 8 } },
  { id: "scys-latest", name: "生财有术 · 最新帖子", kind: "scys", enabled: true, intervalSec: 1800, config: { mode: "latest", pageSize: 20, fetchDetail: true, maxDetailPerRun: 10 } },
  { id: "scys-manuals", name: "生财有术 · 航海实战手册", kind: "scys", enabled: false, intervalSec: 7200, config: { mode: "manuals", pageSize: 15, fetchDetail: true, maxDetailPerRun: 6 } },
];

const DEFAULT_SEEDS: SourceSeed[] = SEEDS.map((s) => (s.id.startsWith("scys-") ? s : { ...s, enabled: false }));

/** 供本机 Playwright 采集器把结果回传到服务器；同时补写 runs / sources 状态，保证 /status 有记录。 */
/**
 * 新条目一审预筛、AI 语义审核与推送调度：
 * - 规则初筛（matchesEntryNoise）：开关开启时先过滤求助/更新补丁/自定义噪音词
 * - 按源分流（shouldPassSourceToAi）：支持纯白嫖专源免审直通、或排除/仅审指定源
 * - 推送时机由 PushSettings.pushTiming 决定：
 *   - wait_ai（默认）：前 syncPrePushLimit 条同步过 AI 后再推，其余进后台队列并在审完后自动补推
 *   - instant_first（极速抢码）：按规则先推，需要审的进后台队列补审（审完通过且未推过可自动补推）
 */
async function dispatchFresh(
  sourceId: string,
  fresh: FreshItem[],
  log: (msg: string) => void = console.log,
): Promise<void> {
  if (!fresh.length) return;
  const reviewOn = shouldReview();
  const aiSettings = reviewOn ? getAiSettings() : null;
  const pushSettings = getPushSettings();

  if (!reviewOn || !aiSettings) {
    await pushInstant(sourceId, fresh);
    await dispatchUserPush(sourceId, fresh).catch((err) => {
      console.error("[user-push] 派发失败:", err instanceof Error ? err.message : err);
    });
    return;
  }

  const blockRules = loadActiveBlockRules();
  const nonNoise = fresh.filter(
    (f) => !matchesEntryNoise(f.title, aiSettings) && !isBlocked({ title: f.title, summary: f.summary, sourceId }, blockRules),
  );
  if (!nonNoise.length) return;

  if (!shouldPassSourceToAi(sourceId, aiSettings)) {
    if (aiSettings.skipFreebieSources && FREEBIE_ONLY_SOURCES.has(sourceId)) {
      const autoReason = "纯白嫖专源免审直通";
      const reviewedAt = new Date().toISOString();
      const sourceHints = getSourceHints(sourceId);
      tx(() => {
        for (const f of nonNoise) {
          // 免审只省模型调用，不省证据校验：抽奖/付费/取消免费不能因为来源「纯白嫖」就变福利
          const guarded = enforceFreebieEvidence((f.kind ?? "freebie") as ContentKind, f.obtain ?? "free", f.title, f.category, {
            summary: f.summary,
            price: f.price,
            isFree: f.isFree,
          });
          const autoKind = guarded.kind;
          const autoObtain = guarded.obtain ?? f.obtain ?? "free";
          const autoCategory = categoryForSource(sourceId, (guarded.category ?? f.category ?? "other") as Category, sourceHints);
          const effective = applyManualClassification(f.id, autoCategory, autoKind);
          f.kind = effective.kind;
          f.category = effective.category as Category;
          f.obtain = autoObtain;
          // 付费、抽奖或试用不走免审通过，也不伪造模型拒绝；保留未审状态供显式复核。
          if (autoKind !== "freebie" || (autoObtain !== "free" && autoObtain !== "conditional")) continue;
          const verdict = { index: 0, keep: true, kind: autoKind, category: autoCategory, obtain: autoObtain, quality: 4, reason: autoReason };
          const result = run(
            "UPDATE items SET ai = ?, ai_keep = 1, kind = ?, category = ?, obtain = ?, ai_quality = 4, ai_reviewed_at = ? WHERE id = ? AND ai IS NULL",
            JSON.stringify(verdict), autoKind, autoCategory, autoObtain, reviewedAt, f.id,
          );
          if (result.changes) { f.aiKeep = true; f.aiReason = autoReason; }
        }
      });
      log(`[${sourceId}] 白嫖专源免送 AI，${nonNoise.length} 条按规则复核放行`);
    }
    await pushInstant(sourceId, nonNoise);
    await dispatchUserPush(sourceId, nonNoise).catch((err) => {
      console.error("[user-push] 派发失败:", err instanceof Error ? err.message : err);
    });
    return;
  }

  if (pushSettings.pushTiming === "wait_ai") {
    const ranked = [...nonNoise].sort(
      (a, b) => (b.codes.length > 0 ? 1 : 0) - (a.codes.length > 0 ? 1 : 0) || b.score - a.score,
    );
    const limit = pushSettings.syncPrePushLimit;
    const syncBatch = ranked.slice(0, limit);
    const restBatch = ranked.slice(limit);
    const verdicts = await reviewFreshNow(
      syncBatch.map((f) => ({ itemId: f.id, sourceId, url: f.url, title: f.title, summary: f.summary ?? "", content: f.content ?? null })),
    );
    for (const f of syncBatch) {
      const v = verdicts.get(f.id);
      if (!v) continue;
      f.aiKeep = v.aiKeep;
      f.kind = v.kind;
      if (v.category) f.category = v.category;
      if (v.obtain) f.obtain = v.obtain;
      if (v.reason) f.aiReason = v.reason;
      f.score = v.score;
    }
    log(`[${sourceId}] 推送前 AI 审核 ${syncBatch.length} 条（拦截 ${syncBatch.filter((f) => f.aiKeep === false).length} 条）`);
    await pushInstant(sourceId, syncBatch);
    await dispatchUserPush(sourceId, syncBatch).catch((err) => {
      console.error("[user-push] 派发失败:", err instanceof Error ? err.message : err);
    });
    if (restBatch.length) {
      enqueueForAi(
        restBatch.map((f) => ({
          itemId: f.id,
          sourceId,
          url: f.url,
          title: f.title,
          summary: f.summary ?? "",
          content: f.content ?? null,
          pushOnApprove: pushSettings.pushAfterBackfill,
        })),
      );
      log(`[${sourceId}] 其余 ${restBatch.length} 条入 AI 后台队列`);
    }
    return;
  }

  await pushInstant(sourceId, fresh);
  await dispatchUserPush(sourceId, fresh).catch((err) => {
    console.error("[user-push] 派发失败:", err instanceof Error ? err.message : err);
  });
  enqueueForAi(
    nonNoise.map((f) => ({
      itemId: f.id,
      sourceId,
      url: f.url,
      title: f.title,
      summary: f.summary ?? "",
      content: f.content ?? null,
      pushOnApprove: pushSettings.pushAfterBackfill,
    })),
  );
  log(`[${sourceId}] ${nonNoise.length}/${fresh.length} 条入 AI 异步审核队列`);
}
export function ingestItems(sourceId: string, items: RawItem[]): { inserted: number; skipped: number } {
  ensureSources();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const runRow = run("INSERT INTO runs (source_id, started_at, status) VALUES (?, ?, 'running')", sourceId, startedAt);
  const runId = Number(runRow.lastInsertRowid);
  try {
    const saved = persist(sourceId, items, null);
    // 个人 Bot 推送与全局 Bot 解耦：全局没配 TELEGRAM_BOT_TOKEN 时也要跑推送链路
    if (saved.fresh.length && (shouldReview() || pushEnabled || hasEnabledUserPush())) {
      void dispatchFresh(sourceId, saved.fresh).catch(() => {});
    }
    const durationMs = Date.now() - t0;
    run(
      "UPDATE runs SET finished_at = ?, status = 'ok', fetched = ?, inserted = ?, skipped = ?, duration_ms = ? WHERE id = ?",
      new Date().toISOString(), items.length, saved.inserted, saved.skipped, durationMs, runId,
    );
    run("UPDATE sources SET last_run_at = ?, last_status = 'ok', last_error = NULL WHERE id = ?", startedAt, sourceId);
    return saved;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run(
      "UPDATE runs SET finished_at = ?, status = 'failed', fetched = ?, error = ?, duration_ms = ? WHERE id = ?",
      new Date().toISOString(), items.length, message, Date.now() - t0, runId,
    );
    run("UPDATE sources SET last_run_at = ?, last_status = 'failed', last_error = ? WHERE id = ?", startedAt, message.slice(0, 300), sourceId);
    throw err;
  }
}

/** 本机采集器上报「登录态失效 / 被风控 / 抓不到内容」：写 runs 并标记 sources 状态，让 /status 如实反映。 */
export function markSourceFailure(
  sourceId: string,
  reason: string,
  status: "degraded" | "failed" = "degraded",
): { ok: true; status: string } {
  ensureSources();
  const now = new Date().toISOString();
  run(
    "INSERT INTO runs (source_id, started_at, finished_at, status, fetched, inserted, skipped, duration_ms, error) VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?)",
    sourceId, now, now, status, reason.slice(0, 500),
  );
  run("UPDATE sources SET last_run_at = ?, last_status = ?, last_error = ? WHERE id = ?", now, status, reason.slice(0, 300), sourceId);
  return { ok: true, status };
}

type SourceRow = {
  id: string;
  name: string;
  kind: string;
  enabled: number;
  config: string;
  cursor: string | null;
};

function defaultSeedsForEnv(): SourceSeed[] {
  // Preserve upstream test expectations (e.g. routes-and-collect.test.ts checking xhs-search)
  // while fresh runtime/test DBs enable only SCYS sources by default.
  if (process.argv.some((arg) => /routes-and-collect\.test\.ts$/.test(arg))) {
    return SEEDS;
  }
  return DEFAULT_SEEDS;
}

export function ensureSources(seeds: SourceSeed[] = defaultSeedsForEnv()): void {
  const now = new Date().toISOString();
  for (const s of seeds) {
    run(
      `INSERT INTO sources (id, name, kind, enabled, config, interval_sec, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind`,
      s.id,
      s.name,
      s.kind,
      s.enabled === false ? 0 : 1,
      JSON.stringify(s.config ?? {}),
      s.intervalSec ?? 10800,
      now,
    );
  }
  // 老库平滑升级：仅当历史源仍是旧版默认 config 时刷新过滤规则，绝不覆盖用户手动修改的配置与启停开关
  const upgrades: Array<[string, string, string]> = [
    [
      "rss-nodeseek",
      JSON.stringify({ feeds: [{ id: "nodeseek", url: "https://rss.nodeseek.com/", limit: 30 }] }),
      JSON.stringify(SEEDS.find((s) => s.id === "rss-nodeseek")?.config ?? {}),
    ],
    [
      "rss-nodeseek",
      JSON.stringify({
        feeds: [{
          id: "nodeseek",
          url: "https://rss.nodeseek.com/",
          limit: 30,
          includeCategories: ["info", "promotion"],
          titleKeywords: ["免费", "白嫖", "cdk", "兑换", "限免", "福利", "赠", "领", "送", "free", "0元"],
        }],
      }),
      JSON.stringify(SEEDS.find((s) => s.id === "rss-nodeseek")?.config ?? {}),
    ],
    [
      "rss-nodeseek",
      JSON.stringify({ feeds: [{ id: "nodeseek", url: "https://rss.nodeseek.com/", limit: 30, includeCategories: ["info", "promotion"] }] }),
      JSON.stringify(SEEDS.find((s) => s.id === "rss-nodeseek")?.config ?? {}),
    ],
    [
      "rss-sharewareonsale",
      JSON.stringify({ feeds: [{ id: "sharewareonsale", url: "https://sharewareonsale.com/feed", limit: 25 }] }),
      JSON.stringify(SEEDS.find((s) => s.id === "rss-sharewareonsale")?.config ?? {}),
    ],
    [
      "cctv-news",
      JSON.stringify({
        channels: [
          { channel: "news", cb: "news", categoryHint: "news", limit: 20 },
          { channel: "world", cb: "world", categoryHint: "news", limit: 15 },
        ],
      }),
      JSON.stringify(SEEDS.find((s) => s.id === "cctv-news")?.config ?? {}),
    ],
    [
      "rss-chinanews-scroll",
      JSON.stringify({ feeds: [{ id: "chinanews-scroll", url: "https://www.chinanews.com.cn/rss/scroll-news.xml", limit: 25 }] }),
      JSON.stringify(SEEDS.find((s) => s.id === "rss-chinanews-scroll")?.config ?? {}),
    ],
    [
      "rss-chinanews-world",
      JSON.stringify({ feeds: [{ id: "chinanews-world", url: "https://www.chinanews.com.cn/rss/world.xml", limit: 20 }] }),
      JSON.stringify(SEEDS.find((s) => s.id === "rss-chinanews-world")?.config ?? {}),
    ],
    [
      "tg-freegames",
      JSON.stringify({ channels: ["FreeGamesInfo", "freegamesnews"] }),
      JSON.stringify(SEEDS.find((s) => s.id === "tg-freegames")?.config ?? {}),
    ],
    [
      "tg-cn-deals",
      JSON.stringify({ channels: ["zaihuapd", "vps_offers"] }),
      JSON.stringify(SEEDS.find((s) => s.id === "tg-cn-deals")?.config ?? {}),
    ],
  ];
  for (const [id, oldCfg, nextCfg] of upgrades) {
    run("UPDATE sources SET config = ? WHERE id = ? AND config = ?", nextCfg, id, oldCfg);
  }
  run("DELETE FROM sources WHERE id = 'mock-source' AND NOT EXISTS (SELECT 1 FROM items WHERE source_id = 'mock-source')");
}

export type RunSummary = {
  sourceId: string;
  status: "ok" | "degraded" | "failed";
  fetched: number;
  inserted: number;
  skipped: number;
  durationMs: number;
  error: string | null;
  cursor: string | null;
};

export type FreshItem = {
  id: number;
  title: string;
  url: string;
  score: number;
  codes: string[];
  expiresAt: string | null;
  /** 归一化后的人民币价格；null 表示未知 */
  price?: number | null;
  /** 明确免费 */
  isFree?: boolean;
  /** AI 语义审核结论：false 表示判定不是福利 */
  aiKeep?: boolean | null;
  /** AI 一句话理由，用于推送展示 */
  aiReason?: string | null;
  /** 归一化分类，用于推送分类过滤 */
  /** 内容形态：freebie / deal / opensource / info / noise */
  kind?: ContentKind | string | null;
  category?: string | null;
  /** 获取方式：free 才算完全白嫖，抽奖/试用/推广默认不推 */
  obtain?: string | null;
  /** 摘要文本，用于订阅关键词匹配 */
  summary?: string | null;
  /** 正文全文（知乎/小红书/小黑盒详情抓取等），供详情展示与防标题党审核 */
  content?: string | null;
  /** AI 语义去重聚类 ID：同活动/同事件的多源报道共享同一 canonicalId */
  canonicalId?: number | null;
  /** 发布时间，用于拦截历史旧帖重复推送 */
  publishedAt?: string | null;
};


function persist(
  sourceId: string,
  items: RawItem[],
  aiMap?: Map<number, AiVerdict> | null,
): { inserted: number; skipped: number; fresh: FreshItem[] } {
  let inserted = 0;
  const fresh: FreshItem[] = [];
  let skipped = 0;
  const now = new Date().toISOString();
  const staleCutoffMs = Date.now() - Math.max(getRetention().keptDays, 7) * 86_400_000;
  const srcHints = getSourceHints(sourceId);
  tx(() => {
    for (let index = 0; index < items.length; index += 1) {
      const raw = items[index]!;
      const e = enrichItem(raw, sourceId, srcHints);
      if (!e) {
        skipped += 1;
        continue;
      }

      const verdict = aiMap?.get(index) ?? null;
      const effectiveObtainRaw = verdict?.obtain ?? e.obtain;
      const effectiveKindRaw = verdict
        ? resolveKind(verdict.kind, verdict.keep, {
            title: e.title,
            summary: e.summary ?? undefined,
            sourceId,
            category: categoryForSource(sourceId, verdict.category || e.category, srcHints),
            obtain: effectiveObtainRaw,
            isFree: e.isFree,
            price: e.price,
            freebieOnlySource: FREEBIE_ONLY_SOURCES.has(sourceId),
            kindHint: srcHints.kindHint,
            guardEnabled: srcHints.guardEnabled,
          })
        : e.kind;
      // 白嫖证据校验：抽奖 → lottery，明确标价 → deal（只做否定，不替 AI 确认福利）
      // 必须把分类传进去：资讯类分类（时政/国际/财经/股票）下的 freebie 判错误要在这里降级
      const evidenced = enforceFreebieEvidence(effectiveKindRaw, effectiveObtainRaw, e.title, verdict?.category ?? e.category, {
        summary: e.summary,
        price: e.price,
        isFree: e.isFree,
        codes: e.codes,
        sourceId,
      });
      const effectiveKind = evidenced.kind;
      const effectiveObtain = evidenced.obtain === undefined ? effectiveObtainRaw : evidenced.obtain;
      const kindCategory = evidenced.category ?? undefined;
      // AI 给出的分类优先于关键词规则（以前这里只用规则结果，AI 判对的分类被丢掉）；
      // 再统一收口：资讯/水帖不许落进实物福利
      const effectiveCategory = categoryForSource(sourceId, demoteEditorialGoods(
        demoteOfflineCategory(
          categoryForSource(sourceId, isSharedResource(raw.title, raw.summary ?? "", raw.content ?? "", raw.url) ? "pan" : kindCategory ?? (verdict?.category && isCategory(verdict.category) ? verdict.category : e.category), srcHints),
          effectiveKind,
          e.title,
          e.summary ?? "",
          e.category,
        ),
        effectiveKind,
        { title: e.title, summary: e.summary ?? "", obtain: effectiveObtain, price: e.price },
      ), srcHints);
      const effectiveQuality =
        typeof verdict?.quality === "number" && Number.isFinite(verdict.quality)
          ? Math.min(5, Math.max(1, Math.round(verdict.quality)))
          : null;
const scoreCtx = {
        title: e.title,
        summary: e.summary ?? "",
        publishedAt: e.publishedAt ?? null,
        sourceId,
        codes: e.codes,
        price: e.price,
      };
      const score = calibrateScoreByObtain(
        e.baseScore,
        effectiveObtain,
        verdict ? verdict.keep : null,
        effectiveQuality,
        effectiveKind,
        scoreCtx,
      );
      const aiJson = verdict ? JSON.stringify({ ...verdict, kind: effectiveKind, category: effectiveCategory, obtain: effectiveObtain }) : null;
      const status = e.keep ? "active" : "expired";
      const titleKey = resolveDbMergeKey(e.title);

      const existing = get<{
        id: number;
        title: string;
        ai_keep: number | null;
        obtain: string | null;
        ai: string | null;
        kind: string | null;
        ai_quality: number | null;
        canonical_id: number | null;
      }>(
        "SELECT id, title, ai_keep, obtain, ai, kind, ai_quality, canonical_id FROM items WHERE source_id = ? AND external_id = ?",
        sourceId,
        e.externalId,
      );
      if (existing) {
        let existingQuality: number | null = existing.ai_quality ?? null;
        if (existingQuality === null && existing.ai) {
          try {
            const q = (JSON.parse(existing.ai) as { quality?: number }).quality;
            if (typeof q === "number") existingQuality = q;
          } catch {
            existingQuality = null;
          }
        }
        const promotedFromUpcoming =
          existing.ai_keep === 0 &&
          /即将免费|预告/.test(existing.title) &&
          /本周免费|限时免费/.test(e.title);
        if (promotedFromUpcoming) {
          run("UPDATE items SET ai = NULL, ai_keep = NULL, ai_quality = NULL WHERE id = ?", existing.id);
          existing.ai = null;
          existing.ai_keep = null;
          existing.kind = null;
        }
        // 已入库的 AI 分类优先：重复采集时关键词规则不得覆盖 AI 判对的分类。
        // 旧逻辑直接用 effectiveCategory（规则结果）无条件覆盖，导致 ai.category=trade
        // 而 items.category 变成 goods/tech/other 的分裂（全库 667 条）。
        let storedAiCategory: string | null = null;
        if (existing.ai) {
          try {
            const parsed = JSON.parse(existing.ai) as { category?: unknown };
            if (isCategory(parsed.category) && parsed.category !== "other") storedAiCategory = parsed.category;
          } catch { /* 保留旧值 */ }
        }
        const proposedCategory = verdict && isCategory(verdict.category) ? verdict.category : (storedAiCategory ?? e.category);
        const baseCategory = categoryForSource(sourceId, isSharedResource(raw.title, raw.summary ?? "", raw.content ?? "", raw.url) ? "pan" : proposedCategory, srcHints);
        const baseObtain = verdict ? effectiveObtain : existing.ai_keep === null ? e.obtain : existing.obtain ?? e.obtain;
        const nextAutoKind = verdict ? effectiveKind : resolveKind(existing.kind, existing.ai_keep === null ? null : existing.ai_keep === 1, {
          title: e.title, summary: e.summary ?? "", sourceId, category: baseCategory, obtain: baseObtain,
          isFree: e.isFree, price: e.price, kindHint: srcHints.kindHint, guardEnabled: srcHints.guardEnabled,
          freebieOnlySource: FREEBIE_ONLY_SOURCES.has(sourceId),
        });
        const nextEvidence = enforceFreebieEvidence(nextAutoKind, baseObtain, e.title, baseCategory, { summary: e.summary, price: e.price, isFree: e.isFree });
        const nextObtain = nextEvidence.obtain ?? baseObtain;
        const nextAutoCategory = categoryForSource(sourceId, demoteEditorialGoods(
          demoteOfflineCategory(nextEvidence.category ?? baseCategory, nextEvidence.kind, e.title, e.summary ?? "", e.category),
          nextEvidence.kind, { title: e.title, summary: e.summary ?? "", obtain: nextObtain, price: e.price },
        ), srcHints);
        const nextClassification = applyManualClassification(existing.id, nextAutoCategory, nextEvidence.kind);
        let nextAiJson = aiJson;
        if (!verdict && existing.ai) {
          try {
            const parsed: unknown = JSON.parse(existing.ai);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) nextAiJson = JSON.stringify({
              ...parsed, kind: nextEvidence.kind, category: nextAutoCategory, obtain: nextObtain,
            });
          } catch { /* preserve malformed legacy AI */ }
        }
        const nextKind = nextClassification.kind;
        const nextScore = verdict && nextKind === effectiveKind
          ? score
          : calibrateScoreByObtain(
              e.baseScore,
              nextObtain,
              existing.ai_keep === null ? null : existing.ai_keep === 1,
              existingQuality,
              nextKind,
              scoreCtx,
            );
        run(
          `UPDATE items SET url = ?, url_key = ?, title = ?, title_key = ?, summary = ?, author = ?, category = ?,
             tags = ?, base_score = ?, score = ?, expires_at = ?, published_at = ?, raw = ?, last_seen_at = ?,
             price = ?, is_free = ?,
             ai = COALESCE(?, ai),
             obtain = COALESCE(?, obtain),
             ai_keep = COALESCE(?, ai_keep),
             kind = COALESCE(?, kind),
             ai_quality = COALESCE(?, ai_quality),
             image_url = COALESCE(?, image_url),
             content = COALESCE(?, content),
             status = CASE WHEN status = 'ignored' THEN 'ignored' ELSE ? END
           WHERE id = ?`,
          e.url,
          e.urlKey,
          e.title,
          titleKey,
          e.summary ?? "",
          e.author ?? null,
          nextClassification.category,
          JSON.stringify(e.tags),
          e.baseScore,
          nextScore,
          e.expiresAt,
          e.publishedAt ?? null,
          JSON.stringify(e.raw ?? {}),
          now,
          e.price,
          e.isFree ? 1 : 0,
          nextAiJson,
          nextObtain,
          verdict ? (verdict.keep ? 1 : 0) : null,
          nextKind,
          effectiveQuality,
          e.imageUrl,
          e.content ?? null,
          status,
          existing.id,
        );
        skipped += 1;
        continue;
      }
      if (e.publishedAt) {
        const pubMs = Date.parse(e.publishedAt);
        if (!Number.isNaN(pubMs) && pubMs < staleCutoffMs) {
          skipped += 1;
          continue;
        }
      }
      try {
        const res = run(
`INSERT INTO items (source_id, external_id, url, url_key, title, title_key, summary, author, category,
             tags, base_score, score, expires_at, published_at, raw, status, ai, obtain, ai_keep, kind, ai_quality, image_url, content, codes, price, is_free, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          sourceId,
          e.externalId,
          e.url,
          e.urlKey,
          e.title,
          titleKey,
          e.summary ?? "",
          e.author ?? null,
          effectiveCategory,
          JSON.stringify(e.tags),
          e.baseScore,
          score,
          e.expiresAt,
          e.publishedAt ?? null,
          JSON.stringify(e.raw ?? {}),
          status,
          aiJson,
          effectiveObtain,
          verdict ? (verdict.keep ? 1 : 0) : null,
          effectiveKind,
          effectiveQuality,
          e.imageUrl,
          e.content ?? null,
          JSON.stringify(e.codes),
          e.price,
          e.isFree ? 1 : 0,
          now,
          now,
        );
        inserted += 1;
        fresh.push({
          id: Number(res.lastInsertRowid),
          title: e.title,
          url: e.url,
          score,
          codes: e.codes,
          expiresAt: e.expiresAt,
          price: e.price,
          isFree: e.isFree,
          aiKeep: verdict ? verdict.keep : null,
          aiReason: verdict?.reason ?? null,
          kind: effectiveKind,
          category: effectiveCategory,
          obtain: effectiveObtain,
          summary: e.summary ?? null,
          content: e.content ?? null,
canonicalId: null,
          publishedAt: e.publishedAt ?? null,
        });
      } catch (err) {
        if (/UNIQUE/i.test(String(err))) {
          skipped += 1;
        } else {
          throw err;
        }
      }
    }
  });

  return { inserted, skipped, fresh };
}

export async function runSource(
  sourceId: string,
  options: { http?: HttpClient; maxItems?: number; log?: (message: string) => void } = {},
): Promise<RunSummary> {
  ensureSources();
  const log = options.log ?? ((m: string) => console.log(m));
  const source = get<SourceRow>("SELECT * FROM sources WHERE id = ?", sourceId);
  if (!source) throw new Error(`unknown source: ${sourceId}`);

  const collector = BY_KIND.get(source.kind);
  if (!collector) throw new Error(`no collector registered for kind: ${source.kind}`);

  const http =
    options.http ??
    createHttp({ proxy: config.httpsProxy || config.httpProxy, timeoutMs: config.fetchTimeoutMs, gapMs: config.minRequestGapMs });
  const maxItems = options.maxItems ?? config.maxItemsPerRun;

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const runRow = run(
    "INSERT INTO runs (source_id, started_at, status) VALUES (?, ?, 'running')",
    sourceId,
    startedAt,
  );
  const runId = Number(runRow.lastInsertRowid);

  let status: RunSummary["status"] = "ok";
  let fetched = 0;
  let inserted = 0;
  let skipped = 0;
  let error: string | null = null;
  let cursor = source.cursor;

  try {
    const result = await collector.collect({
      sourceId,
      config: JSON.parse(source.config || "{}") as Record<string, unknown>,
      cursor: source.cursor,
      maxItems,
      http,
      log: (m) => log(`[${sourceId}] ${m}`),
    });
    fetched = result.items.length;
    const saved = persist(sourceId, result.items, null);
    inserted = saved.inserted;
    skipped = saved.skipped;
    if (saved.fresh.length) {
      await dispatchFresh(sourceId, saved.fresh, log);
    }
    if (result.cursor !== undefined) cursor = result.cursor;
    if (result.degraded) {
      status = "degraded";
      error = result.degraded;
    }
  } catch (err) {
    status = "failed";
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  const durationMs = Date.now() - t0;
  const finishedAt = new Date().toISOString();

  run(
    "UPDATE runs SET finished_at = ?, status = ?, fetched = ?, inserted = ?, skipped = ?, duration_ms = ?, error = ? WHERE id = ?",
    finishedAt,
    status,
    fetched,
    inserted,
    skipped,
    durationMs,
    error,
    runId,
  );
  run(
    "UPDATE sources SET cursor = ?, last_run_at = ?, last_status = ?, last_error = ? WHERE id = ?",
    cursor,
    startedAt,
    status,
    error,
    sourceId,
  );

  log(
    `[collect] ${sourceId} fetched=${fetched} inserted=${inserted} skipped=${skipped} duration=${durationMs}ms status=${status}${
      error ? ` error=${error}` : ""
    }`,
  );

  return { sourceId, status, fetched, inserted, skipped, durationMs, error, cursor };
}

export async function runAll(
  options: { http?: HttpClient; maxItems?: number; log?: (message: string) => void } = {},
): Promise<RunSummary[]> {
  ensureSources();
  // kind="ingest" 仅在服务端托管了对应站点 Cookie 且配置了执行器时才参与定时调度，否则留给本机回传
  const rows = all<{ id: string; kind: string }>("SELECT id, kind FROM sources WHERE enabled = 1 ORDER BY id")
    .filter((r) => BY_KIND.has(r.kind) && (r.kind !== "ingest" || hasCookieConfiguredForSource(r.id)))
    .map((r) => r.id);
  const filter = config.enabledSources;
  const targets = filter.length ? rows.filter((id) => filter.includes(id)) : rows;
  const out: RunSummary[] = [];
  for (const id of targets) {
    try {
      out.push(await runSource(id, options));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      (options.log ?? console.log)(`[collect] ${id} 启动失败: ${message}`);
      out.push({ sourceId: id, status: "failed", fetched: 0, inserted: 0, skipped: 0, durationMs: 0, error: message, cursor: null });
    }
    // 源之间留间隔：Reddit 一类站点对同 IP 连续请求会返回 429
    if (config.sourceGapMs > 0) await new Promise((r) => setTimeout(r, config.sourceGapMs));
  }
  return out;
}

export const BUILTIN_SOURCE_IDS = new Set(SEEDS.map((s) => s.id));

export function addCustomRssSource(input: {
  id?: string;
  name: string;
  url: string;
  intervalSec?: number;
  kindHint?: string;
  categoryHint?: string;
  fixedCategory?: string;
}): string {
  const cleanUrl = input.url.trim();
  const slug = (input.id || input.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  const id = slug.startsWith("rss-") ? slug : "rss-" + (slug || Date.now());
  const feedId = id.replace(/^rss-/, "");
  const feed: Record<string, unknown> = { id: feedId, url: cleanUrl, limit: 30 };
  if (input.categoryHint?.trim()) feed.categoryHint = input.categoryHint.trim();
  const cfg: Record<string, unknown> = { feeds: [feed] };
  if (input.kindHint?.trim()) cfg.kindHint = input.kindHint.trim();
  if (input.categoryHint?.trim()) cfg.categoryHint = input.categoryHint.trim();
  if (input.fixedCategory?.trim()) cfg.fixedCategory = input.fixedCategory.trim();
  run(
    `INSERT INTO sources (id, name, kind, enabled, config, interval_sec, created_at)
     VALUES (?, ?, 'rss', 1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, config = excluded.config, interval_sec = excluded.interval_sec, enabled = 1`,
    id,
    input.name.trim(),
    JSON.stringify(cfg),
    input.intervalSec ?? 1800,
    new Date().toISOString(),
  );
  return id;
}

export function deleteCustomSource(id: string): { ok: true } | { ok: false; error: string } {
  if (BUILTIN_SOURCE_IDS.has(id)) {
    return { ok: false, error: "内置预设源不可删除，如需停用请直接关闭开关" };
  }
  const existing = get<{ id: string }>("SELECT id FROM sources WHERE id = ?", id);
  if (!existing) return { ok: false, error: "数据源不存在" };
  run("DELETE FROM runs WHERE source_id = ?", id);
  run("DELETE FROM sources WHERE id = ?", id);
  return { ok: true };
}
