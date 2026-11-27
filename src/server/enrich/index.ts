import { cleanText, guessExpiry, normalizeUrl, sanitizeImageUrl, urlKey } from "./normalize.ts";
import type { RawItem } from "../collectors/types.ts";
import { extractCodes } from "./codes.ts";
import { extractPrice } from "./pricing.ts";

import { OPENSOURCE_HINT, PROMO_HINT } from "./noise.ts";
import { guessObtain, type ObtainMode } from "./obtain.ts";
import { guessKind, isContentKind, KIND_LABEL, resolveKind, type ContentKind } from "./kind.ts";
import { CATEGORY_LABEL, isCategory, type Category } from "../../shared/taxonomy.ts";
import { categoryForSource, type SourceHints } from "../../shared/source-classification.ts";
import { contentSignals, isSharedResource, QUESTION_TITLE, REVOKED_FREE } from "./evidence.ts";

export { guessKind, isContentKind, KIND_LABEL, resolveKind, type ContentKind };
export type { Category };
export { CATEGORY_LABEL, isCategory };

type Rule = { category: Category; weight: number; keywords: string[]; exclude?: RegExp; require?: RegExp };

/** 线下场景词：出现这些才可能是「实地」，光有「免费」不算 */
const OFFLINE_SCENE_RE =
  /现场|到店|进店|门店|实体店|快闪|商场|专柜|自提|打卡|试吃|试饮|派样|派发|店庆|开业|线下|凭手机|凭截图|排队领|附近|博会|展会|展览|市集|集市|庙会|漫展|车展/;
/** 领取动作：必须能真的领到东西，否则只是地点词撞上了 */
const OFFLINE_CLAIM_RE =
  /(?:免费领取|免费领|现场领|领取|免费送|免费赠|赠送|白送|白给|0元|零元|一分钱|打卡[^\s]{0,4}(?:送|领)|试吃|试饮|派样|派发|小样|礼品|手幅|周边)/;
/** 资讯/求助/闲聊：命中就不该当实物福利 */
const OFFLINE_EXCLUDE_RE =
  /记者|直播|直击|发布会|峰会|论坛|通报|白皮书|签署|备忘录|抽检|不合格|检测结果|召回|处罚|罚款|我想|有吗|有没有人|求租|转租|合租/;
/** 实物/生活福利：线上免费领也算「实物福利」，不再要求到店 */
const PHYSICAL_RE =
  /实物|食品|零食|饮料|奶茶|咖啡|薯条|汉堡|炸鸡|披萨|餐|水果|生鲜|纸巾|日用品|洗护|小样|试用装|周边|手幅|徽章|玩偶|礼品|礼盒|礼包|书|教材|电子书|体检|话费|流量|红包|立减金|代金券|优惠券|充值卡|京豆|积分兑|会员|月卡|季卡|年卡|羊毛|现金|余额|\d+\s*(?:元|块|r)\b/;
/** 测评/选购/资讯：goods 分类里命中这些就不是优惠也不是福利 */
const GOODS_EDITORIAL_RE =
  /测评|评测|实测|使用记录|使用体验|使用感受|选购|怎么选|如何选|科普|榜单|排行|对比|值不值|开箱|避坑|踩雷|横评|盘点|攻略|差价|降价|涨价|调价|假货|验真|备案|增项|单价|差在哪|先分清|先查|别硬熬|被点名|一衣难求|成本|赚几|只能升不能降|降档墙|降到|便宜|放心买|能买吗|该不该|划不划算|值得吗|买前/;

const RULES: Rule[] = [
  {
    category: "ai",
    weight: 1.15,
    keywords: ["gpt", "chatgpt", "openai", "claude", "gemini", "grok", "llm", "大模型", "api", "token", "额度", "算力", "算力券", "代金券", "qwen", "deepseek", "kimi", "glm", "cursor", "copilot", "midjourney", "sora", "colab", "notebook", "gpu", "体验金", "中转", "codex", "积分", "多模型", "智能体", "ai 模型", "credits", "tokens", "codearts", "mcp", "skill", "agent"],
  },
  {
    category: "vps",
    weight: 1.15,
    keywords: ["vps", "云服务器", "云主机", "独立服务器", "独服", "小鸡", "kvm", "nat", "cn2", "gia", "9929", "cmin2", "三网", "家宽", "现车", "racknerd", "dmit", "bandwagon", "搬瓦工", "bwh", "claw", "ovh", "hetzner", "netcup", "dedirock", "inmotion", "deluxhost", "cloudcone", "greencloud", "virmach", "动态ip", "公网ip", "vps 测试", "年付", "月付"],
  },
  {
    category: "cloud",
    weight: 1.1,
    keywords: ["对象存储", "oss", "s3", "r2", "cdn", "带宽", "数据库", "容器", "k8s", "serverless", "免费层", "free tier", "试用金", "额度", "cloud", "azure", "aws", "虚拟机", "存储", "egress", "requests", "代理流量"],
  },
  {
    category: "domain",
    weight: 1.05,
    keywords: ["域名", "domain", "ssl", "证书", "dns", "主机", "虚拟主机", "建站", "托管"],
  },
  {
    // 只认强信号：明确提到开源、GitHub、自托管才算，避免「工具」「插件」这类泛词抢走其它分类
    category: "opensource",
    weight: 1.0,
    keywords: ["开源", "open source", "opensource", "github.com", "github 仓库", "github项目", "gitlab", "self-host", "selfhosted", "自托管", "自建服务", "awesome-", "mit 协议", "apache 协议", "gpl", "源码", "pull request", "开源项目", "开源软件", "开源工具", "开源库"],
  },
  {
    category: "dev",
    weight: 1.0,
    keywords: ["sdk", "cli", "ide", "vscode", "vs code", "docker", "kubernetes", "git", "rust", "golang", "typescript", "python", "框架", "编译器", "api 文档", "debugger", "devtool", "browser extension", "chrome extension", "脚本", "自动化", "workflow", "ci/cd", "数据库工具", "编程语言"],
  },
  {
    category: "design",
    weight: 1.05,
    keywords: ["字体", "font", "fonts", "icon", "icons", "图标", "ui kit", "figma", "sketch", "psd", "svg", "模板", "template", "壁纸", "wallpaper", "插画", "illustration", "3d asset", "mockup", "素材", "音效", "sfx", "lut", "预设", "preset", "配色"],
  },
  {
    category: "security",
    weight: 1.05,
    keywords: ["漏洞", "cve", "零日", "0day", "安全公告", "防火墙", "firewall", "vpn", "wireguard", "tailscale", "零信任", "加密", "密码学", "隐私", "渗透", "内网穿透", "反诈", "sandbox", "2fa", "passkey"],
  },
  {
    category: "hardware",
    weight: 1.0,
    keywords: ["硬件", "cpu", "gpu", "显卡", "rtx", "nas", "路由器", "软路由", "旁路由", "显示器", "键盘", "鼠标", "耳机", "ssd", "固态硬盘", "内存条", "macbook", "mac mini", "iphone", "ipad", "树莓派", "raspberry pi", "开发板", "充电头", "数码"],
  },
  {
    category: "software",
    weight: 1.0,
    keywords: ["激活码", "序列号", "license", "授权", "正版", "绿色版", "注册机", "兑换码", "office", "windows", "adobe", "jetbrains", "photoshop", "会员版", "商业软件", "软件授权", "解锁", "remote desktop", "永久授权", "免费版", "freemium", "lifetime", "lifetime access", "限免", "ios", "android", "macos", "app"],
  },
  {
    category: "media",
    weight: 1.05,
    keywords: ["会员", "影音", "netflix", "奈飞", "spotify", "youtube", "bilibili", "爱奇艺", "优酷", "腾讯视频", "芒果", "emby", "plex", "音乐", "vip", "影视", "韩剧", "美剧", "日剧", "剧集", "电影", "4k", "1080p", "更至", "配音", "动漫", "短剧", "short drama", "short dramas", "听书", "漫画", "小说"],
  },
  {
    category: "game",
    weight: 1.05,
    keywords: ["游戏", "epic", "steam", "喜加一", "激活", "游戏本体", "礼包", "cdkey", "xbox", "psn", "switch", "手游", "内测资格", "gog", "itch.io", "indiegala", "giveaway", "key 赠送", "白给", "免费入库", "humble", "皮肤", "dlc", "bundle", "game", "free game", "steam key", "金钥匙", "shift code", "free weekend", "免费周末"],
  },
  {
    category: "carpool",
    weight: 1.25,
    keywords: ["拼车", "合租", "车位", "发车", "家庭组", "family plan", "team 车", "3缺1", "4缺1", "5缺1", "季付车", "月付车", "年付车", "车主", "开车", "上车"],
  },
  {
    category: "trade",
    weight: 1.1,
    keywords: ["出鸡", "收鸡", "转让", "过户", "出号", "成品号", "带原油", "带原邮", "原邮", "剩余价值", "明盘", "闲置出", "折价出", "转手", "出个", "出一台", "出闲置"],
  },
  {
    // 时政与外交合并进 news：AI 长期分不清 headline/world，只影响展示不影响判定
    category: "news",
    weight: 1.05,
    keywords: ["国务院", "央行", "新规", "法规", "政策", "法案", "国常会", "发改委", "工信部", "通告", "白皮书", "监管", "国务院办公厅", "政府工作", "教育部", "卫健委", "医保", "商保", "人社部", "两会", "全会", "央视", "焦点访谈", "外交部", "联合国", "峰会", "关税", "制裁", "大使馆", "多国", "欧盟", "白宫", "俄乌", "中东", "亚太", "apec", "g20", "国际社会", "海外"],
  },
  {
    category: "stock",
    weight: 1.1,
    keywords: ["a股", "港股", "美股", "纳斯达克", "标普", "道指", "恒生", "上证", "沪指", "创业板", "科创板", "etf", "股票", "股市", "涨停", "跌停", "牛市", "熊市", "券商", "北向资金", "股价", "市值", "ipo", "上市", "分红", "回购", "板块", "指数"],
  },
  {
    category: "finance",
    weight: 1.05,
    keywords: ["财报", "营收", "融资", "并购", "收购", "降息", "加息", "通胀", "汇率", "油价", "黄金", "美联储", "gdp", "基金", "债券", "业绩", "利润", "估值", "宏观经济", "资本市场", "货币政策"],
  },
  {
    category: "tech",
    weight: 1.0,
    keywords: ["科技", "芯片", "半导体", "光刻机", "英伟达", "nvidia", "amd", "intel", "苹果", "华为", "小米", "特斯拉", "机器人", "具身智能", "量子计算", "航天", "卫星", "新能源", "自动驾驶", "操作系统", "鸿蒙", "大模型发布", "互联网", "商用飞机"],
  },
  {
    category: "news",
    weight: 0.75,
    keywords: ["新闻", "快讯", "要闻", "播报", "周刊", "日报", "changelog", "release notes"],
  },
  {
    // 实物福利：线下门店/快闪/商场现场领取的实物，和线上羊毛分开，避免被「实物/优惠」吞掉
    category: "offline",
    weight: 1.2,
    keywords: [
      "现场领取", "现场可领", "现场免费", "现场送", "到店", "进店", "门店", "实体店", "快闪", "商场", "专柜", "自提",
      "打卡", "试吃", "试饮", "派样", "派发", "店庆", "开业活动", "新店开业", "附近", "线下", "凭手机", "凭截图领取", "排队领",
    ],
    // 光有「附近/线下/现场」这类地点词不够：必须同时出现「领取动作」，否则闲聊帖、行业资讯全被吸进来
    require: OFFLINE_CLAIM_RE,
    // 新闻/发布会里的「现场」不是实物福利；抽检通报、租房求组队这类也不是
    exclude: OFFLINE_EXCLUDE_RE,
  },
  {
    category: "goods",
    weight: 0.95,
    keywords: ["包邮", "free shipping", "优惠券", "优惠码", "券码", "满减", "零元", "一分钱", "实物", "试用装", "小样", "京东", "淘宝", "拼多多", "天猫", "羊毛", "折扣", "降价", "元起", "% off", "deal", "clearance", "bogo", "话费", "流量", "立减金", "红包", "外卖", "奶茶", "咖啡", "充值卡", "京豆", "cashback", "gift card"],
  },
  {
    category: "invite",
    weight: 0.9,
    keywords: ["邀请码", "邀请链接", "注册码", "开放注册", "注册送", "新用户", "内测", "资格", "名额"],
  },
  {
    // 网盘资源：强调「网盘/云盘/资源合集」本体，避免与影音会员、云服务混在一起
    category: "pan",
    weight: 0.95,
    keywords: ["网盘", "云盘", "夸克网盘", "阿里云盘", "百度网盘", "百度云", "天翼云盘", "115网盘", "迅雷网盘", "uc网盘", "资源合集", "资源分享", "网盘资源", "不限速", "转存", "提取码", "分享链接"],
  },
  {
    // 网课/教程：课程内容本体；部署/安装类技术教程仍归 dev
    category: "course",
    weight: 1.0,
    keywords: ["网课", "课程", "公开课", "训练营", "视频教程", "系列教程", "教学视频", "配套课件", "课件", "讲义", "mooc", "udemy", "coursera", "极客时间", "拉钩", "慕课"],
  },
  {
    category: "edu",
    weight: 0.95,
    keywords: ["考试", "题库", "真题", "教材", "电子书", "ebook", "ebooks", "audiobook", "audiobooks", "论文", "学习资料", "证书", "备考", "考研", "四六级", "雅思", "托福"],
  },
];

const DEAL_WORDS = ["免费", "白嫖", "领取", "报名领", "领积分", "赠送", "送", "白送", "白给", "0元", "零元", "试用", "体验", "兑换", "激活码", "福利", "优惠", "折扣", "开通", "送额度", "注册送", "限免", "积分", "代金券", "算力", "free", "giveaway", "coupon", "credits", "tokens"];
const SCARCITY_WORDS = ["限时", "限量", "仅限", "前100", "前 100", "名额", "抽奖", "开放注册", "先到先得", "今日", "今晚", "截止", "最后", "limited", "ends", "until", "last chance", "24h", "while supplies"];
const NOISE_PATTERNS = [/怎么(?:领取|申请|弄|搞)/, /有没有/, /求(?:一个|个|推荐|问)/, /请问/, /值得买吗/, /是什么体验/, /怎么样/, /如何评价/];

const URL_NOISE_RE = /https?:\/\/\S+|\b(?:buff\.ly|ow\.ly|redd\.it|bit\.ly|t\.co|tinyurl\.com|dlvr\.it|goo\.gl|youtu\.be|is\.gd|t\.me)\/\S+/gi;
const ASCII_ONLY_RE = /^[a-z0-9\s./+_-]+$/i;
const KW_REGEX_CACHE = new Map<string, RegExp>();

function stripUrls(s: string): string {
  return s.replace(URL_NOISE_RE, " ");
}

function matchKeyword(textLower: string, kw: string): boolean {
  const k = kw.toLowerCase();
  if (!ASCII_ONLY_RE.test(k)) return textLower.includes(k);
  let re = KW_REGEX_CACHE.get(k);
  if (!re) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`);
    KW_REGEX_CACHE.set(k, re);
  }
  return re.test(textLower);
}

const SOURCE_BONUS: Record<string, number> = {
  "linuxdo-welfare": 8,
  "v2ex-free": 8,
  "epic-free": 8,
  "gamerpower": 7,
  "gamerpower-loot": 7,
  "openrouter-free": 8,
  "rss-itch-free": 6,
  "rss-freesteamkeys": 6,
  "rss-isthereanydeal": 7,
  "cheapshark-free": 6,
  "rss-sharewareonsale": 6,
  "rss-tickcoupon": 6,
  "tg-freegames": 6,
  "rss-reddit-freegames": 6,
  "bsky-gamedeals": 5,
  "rss-reddit-gamedeals": 5,
  "rss-reddit-efreebies": 5,
  "rss-reddit-freegamesonsteam": 5,
  "rss-keylol": 5,
  "rss-nodeseek": 5,
  "rss-indiegamebundles": 4,
  "linuxdo-resource": 4,
  "linuxdo-develop": 3,
  "linuxdo-news": 3,
  "linuxdo-domestic": 3,
  "tg-cn-deals": 4,
  "github-free-for-dev": 3,
  "rss-ithome": 3,
  "rss-smzdm": 3,
  "rss-fuliba": 2,
  "zhihu-search": 4,
  "xhs-search": 4,
  "xiaoheihe-search": 4,
};

export type EnrichedItem = RawItem & {
  category: Category;
  tags: string[];
  codes: string[];
  price: number | null;
  isFree: boolean;
  /** 规则内容分（scoreItem 的原始结果），综合分由它 + AI 质量分重算 */
  baseScore: number;
  score: number;
  url: string;
  urlKey: string;
  expiresAt: string | null;
  imageUrl: string | null;
  kind: ContentKind;
  obtain: ObtainMode;
  keep: boolean;
  reason: string;
};
export {
  mergeKey,
  extractMergeKeys,
  TitleDeduper,
  dedupeByTitle,
  type DedupeEntry,
} from "./dedup.ts";
const SCYS_DAILY_TITLE_RE = /生财日报|风向标(?:精选)?周报|本周风向标/;

const SCYS_MANUAL_RULES: Array<{ category: Category; weight: number; keywords: string[] }> = [
  { category: "xiaohongshu", weight: 1.3, keywords: ["小红书", "私域", "朋友圈", "社群变现"] },
  { category: "video", weight: 1.25, keywords: ["抖音", "视频号", "快手", "短视频", "直播", "剪映", "切片", "混剪", "中视频"] },
  { category: "overseas", weight: 1.25, keywords: ["tiktok", "出海", "独立站", "shopify", "跨境", "seo", "youtube", "adsense", "reddit", "amazon", "etsy"] },
  { category: "ecommerce", weight: 1.25, keywords: ["闲鱼", "淘宝", "拼多多", "抖店", "电商", "无货源", "选品", "1688", "店群"] },
  { category: "media", weight: 1.2, keywords: ["公众号", "知乎", "头条", "流量主", "写作", "播客", "个人ip", "图文矩阵", "ip打造"] },
  { category: "dev", weight: 1.3, keywords: ["小程序", "插件", "脚本", "自动化", "coze", "n8n", "cursor", "claude code", "编程", "独立开发", "saas"] },
  { category: "design", weight: 1.35, keywords: ["ai绘画", "ai 绘画", "midjourney", "comfyui", "设计", "壁纸", "ppt", "表情包", "海报", "即梦", "可灵"] },
  { category: "ai", weight: 1.05, keywords: ["agent", "智能体", "大模型", "gpt", "deepseek", "提示词", "prompt", "dify", "mcp", "rag"] },
];

const SCYS_RULES: Rule[] = [
  { category: "daily", weight: 1.4, keywords: ["生财日报", "风向标周报", "本周风向标", "风向周报"] },
  { category: "xiaohongshu", weight: 1.25, keywords: ["小红书", "私域", "小红书电商", "小红书虚拟", "笔记引流", "加微转化", "社群变现", "朋友圈运营"] },
  { category: "video", weight: 1.2, keywords: ["抖音", "视频号", "快手", "短视频", "直播", "剪映", "切片", "中视频", "无人直播", "混剪", "带货直播"] },
  { category: "overseas", weight: 1.25, keywords: ["tiktok", "出海", "独立站", "shopify", "跨境", "seo", "youtube", "adsense", "reddit", "amazon", "etsy", "海外工具站", "google ads", "stripe"] },
  { category: "ecommerce", weight: 1.2, keywords: ["闲鱼", "淘宝", "拼多多", "抖店", "电商", "无货源", "选品", "1688", "店群", "供应链", "带货"] },
  { category: "media", weight: 1.15, keywords: ["公众号", "知乎", "头条", "流量主", "写作", "播客", "个人ip", "图文矩阵", "爆文", "自媒体", "百家号"] },
  { category: "sidehustle", weight: 1.15, keywords: ["副业", "信息差", "同城", "兼职", "轻资产", "地推", "本地生活", "美团", "大众点评", "高德", "代办", "接单变现"] },
  { category: "design", weight: 1.2, keywords: ["ai绘画", "ai 绘画", "midjourney", "comfyui", "stable diffusion", "设计素材", "壁纸", "ppt", "表情包", "海报", "模板预设", "即梦", "可灵", "figma"] },
  { category: "dev", weight: 1.2, keywords: ["小程序", "插件", "chrome扩展", "脚本", "自动化", "coze", "n8n", "cursor", "claude code", "编程", "独立开发", "saas", "rpa", "python", "typescript", "nextjs", "workflow"] },
  { category: "opensource", weight: 1.2, keywords: ["开源", "github", "gitlab", "gitee", "self-host", "自托管", "github仓库", "agent skill", "开源项目", "源码"] },
  { category: "ai", weight: 1.05, keywords: ["agent", "智能体", "大模型", "gpt", "chatgpt", "claude", "gemini", "deepseek", "提示词", "prompt", "mcp", "dify", "rag", "工作流", "ai应用", "ai变现", "算力", "token"] },
  { category: "course", weight: 1.05, keywords: ["大航海", "航海手册", "训练营", "实战手册", "sop教程", "方法论", "课代表", "航海复盘", "教程"] },
  { category: "finance", weight: 1.0, keywords: ["商业复盘", "商业模式", "盈利模式", "复盘", "营收", "净利", "roi", "创业心法", "年入", "变现闭环", "底层逻辑", "商业认知"] },
  { category: "edu", weight: 1.0, keywords: ["提示词库", "指令库", "电子书", "行业报告", "白皮书", "资料包", "学习资料", "合集"] },
  { category: "software", weight: 1.0, keywords: ["正版授权", "软件优惠", "会员额度", "效率软件", "api额度", "saas优惠", "激活码", "限免"] },
];

/** 生财有术商业赛道分类器：按标题 > 标签 > 摘要权重归入 16 个 SCYS_CATEGORY_KEYS，不影响非生财源规则。 */
export function classifyScys(input: {
  title: string;
  summary?: string;
  tags?: readonly string[];
  sourceId?: string;
}): { category: Category; tags: string[] } {
  const title = stripUrls(input.title || "");
  const titleLower = title.toLowerCase();
  const tagsText = (input.tags ?? []).join(" ").trim();
  const tagsLower = tagsText.toLowerCase();
  const summaryLower = stripUrls(input.summary ?? "").toLowerCase();

  if (
    SCYS_DAILY_TITLE_RE.test(title) ||
    (input.tags ?? []).some((t) => t.includes("生财日报") || t.includes("风向标周报"))
  ) {
    return { category: "daily", tags: ["生财日报"] };
  }

  if (input.sourceId === "scys-manuals") {
    let best: { category: Category; hits: string[]; score: number } = { category: "course", hits: [], score: 0 };
    for (const rule of SCYS_MANUAL_RULES) {
      const hits = rule.keywords.filter((k) => matchKeyword(titleLower, k));
      if (!hits.length) continue;
      const score = hits.length * rule.weight;
      if (score > best.score) best = { category: rule.category, hits, score };
    }
    return { category: best.category, tags: best.hits.slice(0, 6) };
  }

  let best: { category: Category; hits: string[]; score: number } = { category: "other", hits: [], score: 0 };
  for (const rule of SCYS_RULES) {
    const titleHits = rule.keywords.filter((k) => matchKeyword(titleLower, k));
    const tagHits = tagsLower ? rule.keywords.filter((k) => matchKeyword(tagsLower, k)) : [];
    const summaryHits = summaryLower ? rule.keywords.filter((k) => matchKeyword(summaryLower, k)) : [];
    const weighted = titleHits.length * 3 + tagHits.length * 2 + summaryHits.length;
    if (weighted <= 0) continue;
    const score = weighted * rule.weight;
    const mergedHits = [...new Set([...titleHits, ...tagHits, ...summaryHits])];
    if (score > best.score) {
      best = { category: rule.category, hits: mergedHits, score };
    }
  }
  return { category: best.category, tags: best.hits.slice(0, 6) };
}

export function classify(
  title: string,
  summary: string,
  opts?: { excludeCategories?: readonly Category[]; scys?: boolean; tags?: readonly string[]; sourceId?: string },
): { category: Category; tags: string[] } {
  if (opts?.scys) {
    const scysOut = classifyScys({ title, summary, tags: opts.tags, sourceId: opts.sourceId });
    if (!opts.excludeCategories?.includes(scysOut.category)) {
      return scysOut;
    }
  }
  const text = stripUrls(`${title} ${summary}`).toLowerCase();
  const skip = opts?.excludeCategories;
  let best: { category: Category; hits: string[]; score: number } = { category: "other", hits: [], score: 0 };
  for (const rule of RULES) {
    if (skip?.includes(rule.category)) continue;
    if (rule.exclude && rule.exclude.test(text)) continue;
    if (rule.require && !rule.require.test(text)) continue;
    const hits = rule.keywords.filter((k) => matchKeyword(text, k));
    if (!hits.length) continue;
    const score = hits.length * rule.weight;
    if (score > best.score) best = { category: rule.category, hits, score };
  }
  const tags = best.hits.slice(0, 6);
  if (best.category === "pan" && !isSharedResource(title, summary) && /网盘|云盘/.test(text) && /会员|容量|扩容|套餐|不限速|空间/.test(text)) {
    return { category: /会员|不限速/.test(text) ? "media" : "cloud", tags };
  }
  return { category: best.category, tags };
}
/**
 * 实物福利的完整口径：先得是福利（kind=freebie），再得是实地（线下场景 + 领取动作 + 中文文本）。
 * AI 会把美国的线上促销/到店好价也标成 offline，所以规则结果和 AI 输出都要过这道闸。
 */
export function isOfflineWorthy(title: string, summary: string, kind: string | null): boolean {
  if (kind !== "freebie") return false;
  const text = `${title} ${summary}`;
  if (!OFFLINE_CLAIM_RE.test(text)) return false;
  if (OFFLINE_EXCLUDE_RE.test(text)) return false;
  // 全英文的海外本地促销对中文站没有意义
  if ((text.match(/[\u4e00-\u9fff]/g) ?? []).length < 2) return false;
  // ① 线下到店领取（原有口径）② 线上免费领实物/生活福利（新增口径）
  return OFFLINE_SCENE_RE.test(text) || PHYSICAL_RE.test(text);
}

/**
 * 统一收口：任何来源（规则 / AI 审核 / 重分类）把条目标成 offline 时都过一遍 isOfflineWorthy，
 * 不合格就退回 fallback（默认兜底分类）。
 */
export function demoteOfflineCategory(
  category: string | null,
  kind: string | null,
  title = "",
  summary = "",
  fallback: string | null = "other",
): string | null {
  if (category !== "offline") return category;
  if (isOfflineWorthy(title, summary, kind)) return category;
  return fallback && fallback !== "offline" ? fallback : "other";
}

/**
 * 商品分类里的「测评 / 使用记录 / 选购科普 / 榜单」不是优惠也不是福利。
 * AI 常把「什么值得买」的测评文判成 goods+freebie，于是它们混进「真福利」「好价」频道
 * （频道按 category 筛，不看 kind）。没有价格、没有促销、没有领取证据时降到 tech，
 * 只留在「行业资讯」频道。
 */
export function demoteEditorialGoods(
  category: string | null,
  kind: string | null,
  input: { title: string; summary?: string; obtain?: string | null; price?: number | null },
): string | null {
  if (category !== "goods") return category;
  if (kind === "noise" || kind === "news") return category;
  // 测评 / 选购 / 价格资讯：既不是优惠也不是福利
  if (GOODS_EDITORIAL_RE.test(input.title)) return "tech";
  const text = `${input.title} ${input.summary ?? ""}`;
  const signals = contentSignals(input.title, input.summary ?? "");
  const paidish = input.obtain === "paid" || (typeof input.price === "number" && input.price > 0);
  // 免费领实物/生活福利 → 实物福利（offline）大类
  if (kind === "freebie" && signals.claim && PHYSICAL_RE.test(text)) return "offline";
  // 有价格或有促销 → 保留 goods（优惠）
  if (paidish || signals.promotion) return category;
  // 无价格、无促销、无领取证据 → 测评/资讯
  return "tech";
}

/** 资讯类分类：这些分类的内容是报道，不可能是「白拿福利」，AI 判成 freebie 一律降级为 info。 */
const EDITORIAL_CATEGORIES = new Set(["finance", "stock", "news"]);

/**
 * 中性分类：这些分类本身不代表「有东西可领」。AI 把它们判成 freebie 时，标题里必须有领取证据，
 * 否则「买东西更划算」这类消费测评/比价文会混进真福利频道
 * （如「茅台告别抢购后，宴席、送礼买酒比以前更划算吗？」被判 freebie + tech + 74 分）。
 */
const CLAIM_NEEDED_CATEGORIES = new Set(["tech", "hardware", "other", "finance", "stock", "news"]);

/** contentSignals().claim 没覆盖、但标题里一样算「真有东西可领」的说法。 */
/** 新闻体裁：出现这些词说明是报道，不是发福利。 */
const NEWS_VOICE_RE = /消息称|据悉|宣布|筹备|计划|或将|预计|报道|曝光|记者|官方表示|发布会|招聘|岗位|财报|数据显示/;

// 只认「免费 + 动作/对象」：裸「免费」二字会把「以后在家刷短剧，还能免费吗？」
// 这种新闻标题当成白嫖证据，进而让 tech 类新闻落进真福利。
const TITLE_CLAIM_RE = /可领|能领|领了|到账|免费(?:领|送|获取|拿到|使用|开放|下载|入库)|giveaway|coupon/i;

/** 价格/行情话术：正文出现它，说明讲的是「买得值不值/更划算」，不是「白拿」。 */
const PRICE_TALK_RE =
  /\d+(?:\.\d+)?\s*(?:元|块|美元)|[¥￥$]\s*\d|价格|标价|售价|定价|行情|差价|涨价|降价|跌价|调价|折扣|几折|划算|性价比|成本|省下|省钱|赚几|降到|跌到/;

/** 抽奖：免费参与但不确定能拿到，obtain 记 lottery，不进「真福利」。Giveaway 不算（Steam/Epic 送游戏常用它）。 */
const LOTTERY_TITLE_RE = /sweepstakes|\bwinners?\b|抽奖|抽选|抽签|摇号|赢取/i;
/** 明确标价的不是白嫖：「Only $9.99」「仅售」「到手价」。 */
const PRICED_TITLE_RE = /(?:only\s*\$|(?:仅售|到手价|售价|现价)\s*[$￥¥]?)\s*(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)/i;

/** 证据校验要用到的正文信息：摘要、价格、兑换码、来源（纯白嫖源免检）。 */
export type FreebieEvidenceExtra = {
  summary?: string | null;
  price?: number | null;
  isFree?: boolean;
  codes?: readonly string[] | null;
  sourceId?: string | null;
};

/**
 * 白嫖证据校验（只做否定，不做确认）：
 * - 抽奖类：免费参与但结果不确定 → obtain=lottery，从「真福利」频道排除
 * - 明确标价：不是白嫖 → kind 降为 deal
 * - 资讯类分类：报道不可能有东西可领 → kind 降为 info
 * - 中性分类 + 无领取证据 + 通篇价格话术：「更划算」不是白嫖 → kind 降为 info
 * 只排除「肯定不是确定福利」的情形，不判断「是不是福利」。
 * 返回的 obtain 语义：undefined / null 由调用方处理（null = 明确清空），字符串 = 改写。
 */
export function enforceFreebieEvidence(
  kind: ContentKind,
  obtain: string | null,
  title: string,
  category?: string | null,
  extra: FreebieEvidenceExtra = {},
): { kind: ContentKind; obtain: string | null; category?: string | null } {
  const ruleObtain = guessObtain(title, extra.summary ?? "", extra.isFree !== undefined || extra.price !== undefined ? { price: extra.price ?? null, isFree: extra.isFree ?? false } : undefined);
  const revoked = REVOKED_FREE.test(`${title} ${extra.summary ?? ""}`);
  const paidPrice = typeof extra.price === "number" && extra.price > 0 && extra.isFree !== true;
  // AI 缺省/判 free 时补回明确的条件，不能把未识别当成直接白拿。
  if (!obtain || obtain === "free") obtain = ruleObtain;
  if (revoked) return { kind: kind === "freebie" ? "info" : kind, obtain: "paid", category };
  if (kind !== "freebie") return { kind, obtain, category };
  if (ruleObtain === "lottery" || obtain === "lottery" || LOTTERY_TITLE_RE.test(title)) {
    return { kind, obtain: "lottery", category: "lottery" };
  }
  if (PRICED_TITLE_RE.test(title) || paidPrice || obtain === "paid") {
    return { kind: "deal", obtain: obtain === "free" ? "paid" : obtain, category };
  }
  // 资讯类分类下不可能有「白拿福利」：AI 偶尔把民生新政、行业新闻判成 freebie
  // （如「新能源车险条款过审，你的保费开始按车型连坐」被判 freebie + 82 分进真福利频道）。
  if (category && EDITORIAL_CATEGORIES.has(category)) return { kind: "info", obtain: null, category };
  // 中性分类里的消费测评/比价长文：标题没有领取证据、正文全是价格行情 → 不是白嫖。
  // 纯免费源（Epic/喜加一等）本身就保证有免费对象，免检。
  if (
    category &&
    CLAIM_NEEDED_CATEGORIES.has(category) &&
    !(extra.sourceId && FREEBIE_ONLY_SOURCES.has(extra.sourceId)) &&
    !(extra.codes && extra.codes.length)
  ) {
    const hasClaim = contentSignals(title).claim || TITLE_CLAIM_RE.test(title);
    const question = QUESTION_TITLE.test(title);
    const text = `${title} ${extra.summary ?? ""}`.slice(0, 3000);
    // 资讯类分类下，新闻体裁或疑问句标题且没有领取证据 → 不是白嫖。
    // 原来要求「正文有价格讨论」才降级，于是「红果筹备电视端：还能免费吗？」
    // 这种新闻靠标题里一个「免费」就落进了真福利频道。
    // 只降「新闻腔/提问」，不动「送一个美国静态IP」「muse账号2个」这类社区直给帖。
    if (!hasClaim && (question || NEWS_VOICE_RE.test(title) || PRICE_TALK_RE.test(`${title} ${extra.summary ?? ""}`))) {
      return { kind: "info", obtain: null, category };
    }
  }
  return { kind, obtain, category };
}

function ageDays(iso: string | null): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return (Date.now() - t) / 86_400_000;
}

/** 纯免费/喜加一专用源（标题有时省略 "Free" 字样，如 r/FreeGameFindings）。 */
export const FREEBIE_ONLY_SOURCES = new Set([
  "epic-free",
  "steam-free",
  "gamerpower",
  "gamerpower-loot",
  "openrouter-free",
  "rss-itch-free",
  "rss-freesteamkeys",
  "rss-isthereanydeal",
  "rss-reddit-freegames",
  "rss-reddit-freegamesonsteam",
  "rss-reddit-efreebies",
  "rss-reddit-freebies",
  "rss-heyitsfree",
  "rss-freebieshark",
  "rss-giveawayoftheday",
  "rss-tickcoupon",
  "rss-indiegamebundles",
]);
export function scoreItem(input: {
  title: string;
  summary: string;
  publishedAt: string | null;
  sourceId: string;
  category: Category;
  tags: string[];
  expiresAt: string | null;
  isFree?: boolean;
  price?: number | null;
  codes?: string[];
  kind?: ContentKind;
}): { score: number; reason: string } {
  const text = stripUrls(`${input.title} ${input.summary}`).toLowerCase();
  const notes: string[] = [];
  let score = 30;

  if (input.isFree) {
    score += 15;
    notes.push("完全免费");
  } else if (input.price !== null && input.price !== undefined) {
    if (input.price <= 5) {
      score += 8;
      notes.push("低价 ≤5元");
    } else if (input.price > 30 && input.kind !== "deal") {
      score -= 10;
      notes.push("需实付 >30元");
    }
  } else if (FREEBIE_ONLY_SOURCES.has(input.sourceId)) {
    score += 12;
    notes.push("白嫖专源");
  }

  if (input.codes?.length) {
    score += 12;
    notes.push("含兑换码");
  }

  const dealHits = DEAL_WORDS.filter((w) => matchKeyword(text, w));
  if (dealHits.length) {
    const add = dealHits.length >= 2 ? 14 : 10;
    score += add;
    notes.push(`福利词 ×${dealHits.length}`);
  } else if (input.kind === "deal" && PROMO_HINT.test(text)) {
    score += 10;
    notes.push("特惠信号");
  } else if (input.kind === "opensource" && (input.category === "opensource" || OPENSOURCE_HINT.test(text))) {
    score += 10;
    notes.push("开源项目");
  } else if (input.kind === "news" || input.kind === "info") {
    if (OPENSOURCE_HINT.test(text)) {
      score += 8;
      notes.push("实用指南");
    } else {
      score += 4;
      notes.push(input.kind === "news" ? "重要新闻" : "行业资讯");
    }
  } else {
    score -= 8;
    notes.push("无福利词");
  }

  const scarcity = SCARCITY_WORDS.filter((w) => matchKeyword(text, w));
  if (scarcity.length) {
    score += scarcity.length >= 2 ? 8 : 5;
    notes.push(`稀缺 ×${scarcity.length}`);
  }

  if (NOISE_PATTERNS.some((p) => p.test(input.title))) {
    score -= 18;
    notes.push("疑问/求资源");
  }

  const days = ageDays(input.publishedAt);
  if (input.publishedAt) {
    if (days <= 1) {
      score += 16;
      notes.push("24h 内");
    } else if (days <= 3) {
      score += 11;
      notes.push("3 天内");
    } else if (days <= 7) {
      score += 6;
      notes.push("一周内");
    } else if (days > 45) {
      score -= 12;
      notes.push("陈旧");
    }
  }

  if (input.expiresAt) {
    const left = (new Date(input.expiresAt).getTime() - Date.now()) / 86_400_000;
    if (left < 0) {
      return { score: 0, reason: [...notes, "已过期"].join(" · ") };
    } else if (left <= 3) {
      score += 6;
      notes.push("临近截止");
    }
  }

  score += SOURCE_BONUS[input.sourceId] ?? 0;

  if (input.title.length < 6) {
    score -= 10;
    notes.push("标题过短");
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), reason: notes.join(" · ") };
}

export function enrichItem(
  raw: RawItem,
  sourceId: string,
  hints?: SourceHints,
): EnrichedItem | null {
  const title = cleanText(raw.title, 200);
  if (!title) return null;
  const summary = cleanText(raw.summary ?? "", 400);
  const url = normalizeUrl(raw.url);
  if (!url) return null;

  const isScys = sourceId.startsWith("scys-");
  const guessed = classify(title, summary, isScys ? { scys: true, tags: raw.tags, sourceId } : undefined);
  const hintCat = raw.categoryHint ?? hints?.categoryHint ?? null;
  let category: Category = guessed.category === "other" && isCategory(hintCat) ? hintCat : guessed.category;
  if (!isScys && isSharedResource(title, raw.summary ?? "", raw.content ?? "", raw.url)) category = "pan";
  category = categoryForSource(sourceId, category, hints);
  let tags = guessed.tags;
  const codes = isScys ? [] : extractCodes(title, raw.content ?? raw.summary ?? "");
  const priceInfo = extractPrice(title, summary);
  const expiresAt = isScys ? (raw.expiresAt ?? null) : (raw.expiresAt ?? guessExpiry(`${title} ${summary}`));
  let obtain = guessObtain(title, summary, priceInfo);
  const kindInput = {
    title,
    summary,
    sourceId,
    category,
    obtain,
    isFree: priceInfo.isFree,
    price: priceInfo.price,
    freebieOnlySource: FREEBIE_ONLY_SOURCES.has(sourceId),
    kindHint: raw.kindHint ?? hints?.kindHint ?? null,
    guardEnabled: hints?.guardEnabled,
  };
  let kind = guessKind(kindInput);
  // 实物福利必须是「能到店领到的实物福利」：好价（deal）和只撞上地点词的资讯/闲聊一律退回
  if (category === "offline" && !isOfflineWorthy(title, summary, kind)) {
    const again = classify(title, summary, { excludeCategories: ["offline"] });
    category =
      again.category === "other" && isCategory(hintCat) && hintCat !== "offline" ? hintCat : again.category;
    tags = again.tags;
    kind = guessKind({ ...kindInput, category });
  }
  // 白嫖证据校验（看摘要与价格）：抽奖、已取消免费、明确标价都不能算福利
  const evidenced = enforceFreebieEvidence(kind, obtain, title, category, {
    summary,
    price: priceInfo.price,
    isFree: priceInfo.isFree,
  });
  kind = evidenced.kind;
  obtain = (evidenced.obtain ?? obtain) as ObtainMode;
  category = categoryForSource(sourceId, (evidenced.category ?? category) as Category, hints);
  const { score, reason } = scoreItem({
    title,
    summary,
    publishedAt: raw.publishedAt ?? null,
    sourceId,
    category,
    tags,
    expiresAt,
    isFree: priceInfo.isFree,
    price: priceInfo.price,
    codes,
    kind,
  });

  const expired = Boolean(expiresAt && new Date(expiresAt).getTime() < Date.now());

  return {
    ...raw,
    codes,
    price: priceInfo.price,
    isFree: priceInfo.isFree,
    title,
    summary,
    url,
    urlKey: urlKey(url),
    category,
    tags,
    expiresAt,
    baseScore: score,
    score,
    imageUrl: sanitizeImageUrl(raw.imageUrl, url),
    kind,
    obtain,
    keep: !expired,
    reason,
  };
}
