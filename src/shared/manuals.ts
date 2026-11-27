import type { ItemDossier } from "./dossier.ts";

export type ManualLinkedGroup = {
  groupKey: string;
  platform: number;
  name: string;
  messageCount: number;
  lastMsgTime: number;
  digestCount?: number;
};

export type ManualChapterSummary = {
  itemId: number;
  chapterKey: string;
  title: string;
  cleanTitle: string;
  sectionTitle: string | null;
  orderIndex: number;
  charCount: number;
  score: number;
  aiQuality: number | null;
  hasDossier: boolean;
  url: string;
};

export type ManualSectionGroup = {
  sectionTitle: string;
  chapters: ManualChapterSummary[];
};

export type ManualBookSummary = {
  activityId: string;
  title: string;
  periodLabel: string | null;
  category: string | null;
  chapterCount: number;
  totalChars: number;
  dossierCount: number;
  maxScore: number;
  publishedAt: string | null;
  coverChapterItemId: number;
  previewChapters: string[];
  linkedGroups: ManualLinkedGroup[];
};

export type ManualBookDetail = ManualBookSummary & {
  sections: ManualSectionGroup[];
  chapters: Array<ManualChapterSummary & { summary: string | null }>;
};

export type ManualChapterDetail = ManualChapterSummary & {
  activityId: string | null;
  bookTitle: string | null;
  category: string | null;
  tags: string[];
  publishedAt: string | null;
  summary: string | null;
  content: string | null;
  dossier: ItemDossier | null;
};

export type ParsedManualTitleMeta = {
  projectTitle: string | null;
  sectionTitle: string | null;
  chapterTitle: string;
};

/**
 * 拆解航海手册标题中的项目名、章节组与干净章节标题：
 * - `【AI 产品（国内-微信小程序） · 第一章】01. 具体步骤`
 * - `【微信小程序 - 做出有人用的产品】01. 开船第一课`
 * - `01. 开船第一课`
 */
export function parseManualTitleMeta(rawTitle: string): ParsedManualTitleMeta {
  const trimmed = rawTitle.trim();
  const match = /^\s*【([^】]+)】\s*(.*)$/.exec(trimmed);
  if (!match) {
    return {
      projectTitle: null,
      sectionTitle: null,
      chapterTitle: trimmed,
    };
  }

  const bracketInner = match[1]!.trim();
  const remainder = match[2]!.trim();
  const dotParts = bracketInner
    .split(/\s*[·•]\s*/)
    .map((p) => p.trim())
    .filter(Boolean);

  const projectTitle = dotParts[0] || null;
  const sectionTitle = dotParts.length > 1 ? dotParts.slice(1).join(" · ") : null;

  return {
    projectTitle,
    sectionTitle,
    chapterTitle: remainder || trimmed,
  };
}

/** 从章节标题提取自然排序用的前置编号，如 `00. 本关任务卡` -> 0，`（新增）✍️02. ...` -> 2。 */
export function extractManualChapterNumber(cleanTitle: string): number | null {
  const stripped = cleanTitle
    .trim()
    .replace(/^(?:[（(][^）)]*[）)]\s*)+/, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
  const m = /^(\d{1,3})(?=\s*[\.、．:：\-]|\s+[\u4e00-\u9fa5A-Za-z]|[\u4e00-\u9fa5])/.exec(stripped);
  if (!m) return null;
  const num = Number(m[1]);
  return Number.isFinite(num) ? num : null;
}

/** 判断章节标题是否以 `00.` 开头（作为关卡/篇章分界标识）。 */
export function isManualZeroDivider(cleanTitle: string): boolean {
  return extractManualChapterNumber(cleanTitle) === 0;
}

const TRACK_SLUG_RULES: ReadonlyArray<{ slug: string; test: (norm: string) => boolean }> = [
  // 小红书细分赛道（必须优先区分虚拟产品 / 实体电商 / AI自媒体 / 教育资料PPT）
  { slug: "xhs-virtual-product", test: (s) => s.includes("小红书") && s.includes("虚拟") },
  { slug: "xhs-physical-ecommerce", test: (s) => s.includes("小红书") && (s.includes("实体") || s.includes("垂直小店")) },
  { slug: "xhs-ai-media", test: (s) => s.includes("小红书") && s.includes("自媒体") },
  { slug: "xhs-edu-ppt", test: (s) => s.includes("小红书") && (s.includes("教育资料") || s.includes("ppt")) },

  // 视频号图书带货 vs 抖音爆款 AI 视频 vs 高质感短片 vs AI 视频带货 vs 抖音自然流 CPS
  { slug: "channels-ai-book-commerce", test: (s) => s.includes("视频号") && s.includes("图书") },
  { slug: "douyin-ai-video", test: (s) => s.includes("抖音") && s.includes("爆款") && s.includes("视频") },
  { slug: "douyin-natural-cps", test: (s) => s.includes("抖音") && (s.includes("自然流") || s.includes("cps")) },
  { slug: "ai-high-quality-video", test: (s) => s.includes("高质感视频") || s.includes("爆款短片") },
  { slug: "ai-video-commerce", test: (s) => s.includes("视频带货") && !s.includes("图书") },

  // 核心赛道精确映射
  { slug: "wechat-miniprogram", test: (s) => s.includes("微信小程序") },
  { slug: "fde-entry", test: (s) => /\bfde\b/.test(s) || s.includes("fde入门") || s.includes("企业ai服务") },
  {
    slug: "scys-mcp",
    test: (s) =>
      s.includes("生财mcp") &&
      !s.includes("内测") &&
      !s.includes("测试") &&
      !s.includes("排行榜"),
  },
  { slug: "ai-ip-acquisition", test: (s) => s.includes("ip获客") || (s.includes("ai") && s.includes("获客系统")) },
  { slug: "ai-short-novel", test: (s) => s.includes("短篇小说") },
  { slug: "traffic-keyword-en-site", test: (s) => s.includes("流量词英文站") },
  { slug: "overseas-keyword-game-site", test: (s) => s.includes("热词游戏站") },
  { slug: "enterprise-ai-training", test: (s) => s.includes("企业ai内训") || s.includes("企业内训") },
  { slug: "wechat-sticker-account", test: (s) => s.includes("微信贴图号") || s.includes("贴图号") },
  { slug: "vertical-micro-account", test: (s) => s.includes("垂直小号") },
  { slug: "personal-ai-assistant", test: (s) => s.includes("个人ai助理") },
  { slug: "agent-skills-camp", test: (s) => s.includes("agentskills") || s.includes("炼术营") },
  { slug: "ai-agent-architect", test: (s) => s.includes("agent架构师") },
  { slug: "ai-second-brain", test: (s) => s.includes("第二大脑") },
];

function matchNormalizedTrackSlug(base: string): string | null {
  const norm = base
    .trim()
    .toLowerCase()
    .replace(/\bal(?=\s*高质感)/g, "ai")
    .replace(/(?:-\s*\d+月航海|\d+群|（[^）]*期）|\([^)]*期\))/g, "")
    .replace(/[\s+\-—–·•_/:：()（）【】[\]「」『』,，.。!?！？]+/g, "");

  if (!norm) return null;

  for (const rule of TRACK_SLUG_RULES) {
    if (rule.test(norm)) return rule.slug;
  }
  return null;
}

const PROGRESS_TAG_PREFIX_RE = /^(?:day\s*\d+|第\s*[\d一二三四五六七八九十百]+\s*[天期课关周]|打卡|群公告)/i;

/**
 * 归一化提取核心赛道 slug，用于将航海手册项目名与大航海微信群名精准配对。
 * 若标题本身带有 `【项目名】` 前缀，只取项目名部分匹配，避免被正文章节关键词误导；
 * 若前置括号仅为微信群打卡进度标识（如 `【Day9】`、`【第9天】`），则剥离后再匹配群主体名。
 */
export function matchActivityTrackSlug(title: string): string | null {
  const strippedProgress = title
    .trim()
    .replace(/^(?:【([^】]+)】\s*)+/, (full, inner: string) =>
      PROGRESS_TAG_PREFIX_RE.test(String(inner ?? "").trim()) ? "" : full,
    )
    .trim();
  if (!strippedProgress) return null;

  const meta = parseManualTitleMeta(strippedProgress);
  const base = (meta.projectTitle || strippedProgress).trim();
  if (!base) return null;
  return matchNormalizedTrackSlug(base);
}
