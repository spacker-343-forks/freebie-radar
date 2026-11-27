/**
 * 分类 / 内容形态 / 获取方式 / 频道（preset）的唯一定义源。
 *
 * 以前同一份分类清单分散在 5 处（enrich 规则、推送白名单校验、AI 提示词、
 * 前端 label 表、数据源运维下拉），任一处加分类都要手工同步，漏一处就会出现
 * 「主页有这个小类，推送给不出 / 数据源兜底分类选不到」的错位。
 * 现在服务端与前端都从这里 import，加分类只改这一个文件。
 */

/* ------------------------------------------------------------------ *
 * 分类（小类）
 * ------------------------------------------------------------------ */

export const CATEGORY_KEYS = [
  "ai",
  "xiaohongshu",
  "video",
  "overseas",
  "ecommerce",
  "sidehustle",
  "daily",
  "cloud",
  "vps",
  "domain",
  "opensource",
  "software",
  "dev",
  "design",
  "security",
  "hardware",
  "media",
  "game",
  "carpool",
  "trade",
  "finance",
  "stock",
  "tech",
  "news",
  "goods",
  "lottery",
  "offline",
  "invite",
  "edu",
  "pan",
  "course",
  "other",
] as const;

export type Category = (typeof CATEGORY_KEYS)[number];

export const SCYS_CATEGORY_KEYS: Category[] = [
  "ai",
  "xiaohongshu",
  "video",
  "overseas",
  "ecommerce",
  "media",
  "sidehustle",
  "dev",
  "opensource",
  "design",
  "daily",
  "course",
  "finance",
  "edu",
  "software",
  "other",
];

const CATEGORY_LABEL_BY_KEY = {
  ai: "AI 应用/智能体",
  xiaohongshu: "小红书/私域",
  video: "短视频/直播",
  overseas: "出海/独立站",
  ecommerce: "电商/带货",
  sidehustle: "副业/信息差",
  daily: "生财日报/风向",
  cloud: "云服务",
  vps: "VPS/主机",
  domain: "域名/建站",
  opensource: "开源/工作流",
  software: "额度/好价工具",
  dev: "编程/自动化",
  design: "设计/效率工具",
  security: "安全/网络",
  hardware: "硬件/数码",
  media: "自媒体/IP",
  game: "游戏",
  carpool: "拼车/合租",
  trade: "二手/交易",
  finance: "商业复盘/认知",
  stock: "股票/市场",
  tech: "科技动态",
  news: "综合资讯",
  goods: "实物/优惠",
  lottery: "抽奖/抽选",
  offline: "实物福利",
  invite: "邀请码",
  edu: "资料/提示词包",
  pan: "网盘资源",
  course: "航海实战教材",
  other: "其它",
} satisfies Record<Category, string>;

/** 对外用宽松索引类型，调用方拿到的可能是任意 string（来自数据库/AI）。 */
export const CATEGORY_LABEL: Record<string, string> = CATEGORY_LABEL_BY_KEY;

/** 一句话说清这个分类收什么，供下拉/悬浮说明使用。 */
export const CATEGORY_DESC: Record<Category, string> = {
  ai: "AI 应用落地 / Agent 智能体 / Prompt 工程 / AI 变现与额度",
  xiaohongshu: "小红书电商 / 虚拟资料 / 私域引流 / 社群与个人IP变现",
  video: "抖音 / 视频号 / 快手 / YouTube 短视频、中视频与直播切片带货",
  overseas: "TikTok 跨境 / Shopify 独立站 / 海外工具站 / SEO 与 AdSense",
  ecommerce: "闲鱼 / 淘宝 / 拼多多 / 抖店 / 选品供应链与无货源电商",
  sidehustle: "轻资产副业 / 本地同城获客 / 平台红利 / 信息差与实战项目",
  daily: "生财日报 / 风向标精选 / 平台新规与商业趋势洞察",
  cloud: "云主机外的云服务：对象存储 / CDN / 数据库 / 代理流量",
  vps: "独立服务器 / VPS 小鸡 / 现车 / 家宽",
  domain: "域名 / SSL / DNS / 虚拟主机 / 建站",
  opensource: "GitHub 仓库 / Agent Skill / Coze 与 n8n 工作流 / 自托管工具",
  software: "SaaS 工具优惠 / API 额度 / 正版软件授权与效率应用",
  dev: "AI Coding / 独立开发 / 自动化脚本 / 插件与小程序实战",
  design: "设计素材 / AI 绘图视频工具 / 模板预设 / 效率软件",
  security: "漏洞 / VPN / 隐私与安全工具",
  hardware: "硬件 / 路由器 / NAS / 数码外设",
  media: "公众号 / 知乎 / 播客 / 图文矩阵 / 流量主与内容 IP",
  game: "喜加一 / 史低 / 游戏本体与礼包",
  carpool: "合规拼车 / 合租 / 家庭组车位",
  trade: "明盘出鸡 / 账号与设备转让",
  finance: "商业模式拆解 / 营收复盘 / 创业心法与宏观商业认知",
  stock: "A股 / 港股 / 美股 / ETF / IPO",
  tech: "科技前沿 / 芯片 / 互联网 / 航天新能源",
  news: "综合快讯与其它资讯",
  goods: "生活羊毛 / 优惠券 / 话费红包 / 实物",
  lottery: "免费参与但结果不确定的抽奖 / Sweepstakes / 抽选活动（不计入确定福利）",
  offline: "实物福利：线下到店领取（门店/快闪/展会）或线上免费领实物与生活福利（食品/日用品/书/话费/红包/会员）；纯资讯、抽检通报、租房组队不算",
  invite: "邀请码 / 开放注册 / 内测资格",
  edu: "SOP 文档 / 提示词库 / 电子书 / 行业报告与学习资料",
  pan: "夸克 / 阿里云盘 / 百度网盘等分享与转存",
  course: "大航海实战手册 / 系统训练营 / SOP 教程与方法论",
  other: "兜底分类",
};

/** 大类分组：前端下拉与推送白名单用同一套分组，和主页频道口径一致。 */
export type CategoryGroupKey = "commercial" | "tech" | "content" | "freebie" | "other";

export const CATEGORY_GROUPS: { key: CategoryGroupKey; label: string; categories: Category[] }[] = [
  {
    key: "commercial",
    label: "商业变现赛道",
    categories: ["xiaohongshu", "video", "overseas", "ecommerce", "media", "sidehustle"],
  },
  {
    key: "tech",
    label: "AI 与技术工程",
    categories: ["ai", "dev", "opensource", "design"],
  },
  {
    key: "content",
    label: "风向与体系课",
    categories: ["daily", "course", "finance"],
  },
  {
    key: "freebie",
    label: "资源与工具福利",
    categories: [
      "edu",
      "software",
      "cloud",
      "domain",
      "hardware",
      "security",
      "tech",
      "news",
      "stock",
      "goods",
      "vps",
      "game",
      "carpool",
      "trade",
      "lottery",
      "offline",
      "invite",
      "pan",
    ],
  },
  {
    key: "other",
    label: "其它",
    categories: ["other"],
  },
];

export const CATEGORY_SET: ReadonlySet<string> = new Set<string>(CATEGORY_KEYS);

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && CATEGORY_SET.has(value);
}

export function categoryLabel(category: string | null | undefined): string {
  const key = (category ?? "other") as Category;
  return CATEGORY_LABEL[key] ?? category ?? "其它";
}

/** 新闻/资讯场景下的栏目名（避免科技新闻显示成旧福利口径）。 */
export const NEWS_CATEGORY_LABEL: Record<string, string> = {
  finance: "商业复盘/认知",
  stock: "股票/市场",
  tech: "科技前沿",
  ai: "AI 应用/智能体",
  xiaohongshu: "小红书/私域",
  video: "短视频/直播",
  overseas: "出海/独立站",
  ecommerce: "电商/带货",
  sidehustle: "副业/信息差",
  daily: "生财日报/风向",
  media: "自媒体/IP",
  dev: "编程/自动化",
  opensource: "开源/工作流",
  security: "安全/漏洞",
  cloud: "云与架构",
  vps: "主机/网络",
  hardware: "硬件数码",
  software: "额度/好价工具",
  game: "游戏动态",
  design: "设计/效率工具",
  edu: "资料/提示词包",
  pan: "网盘资源",
  course: "航海实战教材",
  news: "综合资讯",
  other: "其它资讯",
};

/* ------------------------------------------------------------------ *
 * 频道（主页大类 preset）
 * ------------------------------------------------------------------ */

/** 真福利/白嫖频道的分类集合：网盘、网课、实物福利各有独立频道，不混进来 */
export const FREEBIE_CATEGORY_KEYS: Category[] = [
  "ai", "software", "game", "cloud", "vps", "domain", "media", "design", "dev", "edu", "goods", "lottery", "invite", "opensource", "security", "hardware", "other",
];

/**
 * 频道 = 主页顶部的大类；分类白名单以它为默认集合，推送规则也支持一键套用。
 * exclude 里的分类即使出现在 categories 里也会被该频道排除（主页查询与分类胶囊都按它算）。
 */
export const CHANNELS: { key: string; label: string; categories: Category[]; exclude?: Category[] }[] = [
  { key: "picks", label: "精选干货", categories: SCYS_CATEGORY_KEYS, exclude: ["pan"] },
  { key: "dossiers", label: "立项拆解", categories: SCYS_CATEGORY_KEYS, exclude: ["pan"] },
  { key: "manuals", label: "航海手册", categories: SCYS_CATEGORY_KEYS, exclude: ["pan"] },
  { key: "projects", label: "项目案例", categories: SCYS_CATEGORY_KEYS, exclude: ["pan"] },
  { key: "tools", label: "开源与工具", categories: SCYS_CATEGORY_KEYS, exclude: ["pan"] },
  { key: "perks", label: "福利与资料", categories: SCYS_CATEGORY_KEYS, exclude: ["pan"] },
  { key: "info", label: "行业资讯", categories: ["finance", "stock", "tech", "ai", "dev", "hardware", "security", "cloud", "software", "game", "opensource", "design", "edu", "news", "goods", "other"], exclude: ["pan", "course"] },
  { key: "opensource", label: "开源", categories: ["ai", "dev", "opensource", "security", "cloud", "vps", "software", "tech", "design", "hardware", "edu", "other"], exclude: ["pan", "course"] },
  // 开源项目即使免费也归「开源」频道：真福利是「能领到的东西」，不是「能用的项目」。
  { key: "verified", label: "真福利", categories: FREEBIE_CATEGORY_KEYS, exclude: ["pan", "course", "offline", "lottery", "opensource"] },
  { key: "free", label: "全部白嫖", categories: FREEBIE_CATEGORY_KEYS },
  { key: "offline", label: "实物福利", categories: ["offline"] },
  { key: "news", label: "重要新闻", categories: ["finance", "tech", "stock", "news", "security", "other"], exclude: ["pan", "course"] },
  { key: "deal", label: "好价", categories: ["vps", "carpool", "trade", "game", "software", "cloud", "domain", "ai", "media", "hardware", "goods", "design", "dev", "security", "edu", "other"], exclude: ["pan", "course"] },
  { key: "pan", label: "网盘/网课", categories: ["pan", "course"] },
];

/** 该频道要排除的分类（主页查询用它拼 excludeCategory，避免分类胶囊里出现点了没结果的项）。 */
export function channelExcluded(preset: string): Category[] {
  return CHANNELS.find((c) => c.key === preset)?.exclude ?? [];
}

/** preset 未知（如 codes / urgent / starred）时返回全部分类。 */
export function categoriesForPreset(preset: string): string[] {
  const channel = CHANNELS.find((c) => c.key === preset);
  if (!channel) return [...CATEGORY_KEYS];
  const excluded = new Set<string>(channel.exclude ?? []);
  return channel.categories.filter((key) => !excluded.has(key));
}
export function categoryLabelForPreset(category: string, preset: string): string {
  if (preset === "news" || preset === "info") {
    return NEWS_CATEGORY_LABEL[category] ?? categoryLabel(category);
  }
  return categoryLabel(category);
}

export function categoryLabelForKind(
  category: string | null | undefined,
  kind: string | null | undefined,
): string {
  const key = category || "other";
  if (kind === "news" || kind === "info") {
    return NEWS_CATEGORY_LABEL[key] ?? categoryLabel(key);
  }
  return categoryLabel(key);
}

/* ------------------------------------------------------------------ *
 * 内容形态（kind）
 * ------------------------------------------------------------------ */

export const CONTENT_KIND_KEYS = ["freebie", "deal", "opensource", "news", "info", "noise"] as const;

export type ContentKind = (typeof CONTENT_KIND_KEYS)[number];

const KIND_LABEL_BY_KEY = {
  freebie: "白嫖福利",
  deal: "特价好价",
  opensource: "开源项目",
  news: "重要新闻",
  info: "行业资讯",
  noise: "噪音水帖",
} satisfies Record<ContentKind, string>;

export const KIND_LABEL: Record<string, string> = KIND_LABEL_BY_KEY;

/** 可被分配/筛选的形态（noise 是拦截结果，不作为筛选项）。 */
export const KIND_ORDER = ["freebie", "deal", "opensource", "news", "info"] as const;

export const KIND_SET: ReadonlySet<string> = new Set<string>(CONTENT_KIND_KEYS);

export function isContentKind(v: unknown): v is ContentKind {
  return typeof v === "string" && KIND_SET.has(v);
}

/* ------------------------------------------------------------------ *
 * 获取方式（obtain）
 * ------------------------------------------------------------------ */

export const OBTAIN_KEYS = ["free", "conditional", "lottery", "trial", "promo", "paid"] as const;

export type ObtainMode = (typeof OBTAIN_KEYS)[number];

const OBTAIN_LABEL_BY_KEY = {
  free: "直接白嫖",
  conditional: "有条件",
  lottery: "抽奖",
  trial: "试用/限时",
  promo: "推广/广告",
  paid: "需付费",
} satisfies Record<ObtainMode, string>;

export const OBTAIN_LABEL: Record<string, string> = OBTAIN_LABEL_BY_KEY;

const OBTAIN_HINT_BY_KEY = {
  free: "点开就能领，不需要发帖、邀请、抽签",
  conditional: "要回帖、盖楼、转发、关注、邀请或实名绑卡才能拿",
  lottery: "抽名额/开奖，不一定轮到你",
  trial: "免费试用 N 天或首月免费，到期要付费",
  promo: "本质是商家推广自家付费服务，福利是引流钩子",
  paid: "要实付钱才拿得到",
} satisfies Record<ObtainMode, string>;

export const OBTAIN_HINT: Record<string, string> = OBTAIN_HINT_BY_KEY;

export const OBTAIN_ORDER = ["free", "conditional", "lottery", "trial", "promo", "paid"] as const;

export const OBTAIN_SET: ReadonlySet<string> = new Set<string>(OBTAIN_KEYS);

export function isObtainMode(v: unknown): v is ObtainMode {
  return typeof v === "string" && OBTAIN_SET.has(v);
}

/* ------------------------------------------------------------------ *
 * 下拉选项（数据源运维 / 推送规则共用）
 * ------------------------------------------------------------------ */

/** 按大类分组的分类选项，供 <optgroup> 或多列面板渲染。 */
export function categoryOptionGroups(): { label: string; options: { value: Category; label: string; desc: string }[] }[] {
  return CATEGORY_GROUPS.map((g) => ({
    label: g.label,
    options: g.categories.map((key) => ({ value: key, label: CATEGORY_LABEL_BY_KEY[key], desc: CATEGORY_DESC[key] })),
  }));
}
