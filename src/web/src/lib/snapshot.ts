export type SnapshotComment = {
  author?: string;
  body: string;
};

export type SnapshotSections = {
  metaLine: string | null;
  body: string;
  feishuDoc: string | null;
  relatedDocs: string[];
  comments: SnapshotComment[];
};

const META_HEADER_RE = /^(【(?:分类|来源|期数|热度|标签)】[^\n]+)$/u;
const TRAILING_SECTION_RE = /\n{1,2}【(飞书文档内容|关联文档|精选评论)】\n/g;
const HTML_DETECTION_RE = /<(?:p|div|h[1-6]|ul|ol|li|pre|blockquote|img|strong|em|b|i|a|table|br)\b[^>]*>/i;

export function isSafeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const u = new URL(trimmed);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function looksLikeHtml(text: string): boolean {
  return HTML_DETECTION_RE.test(text);
}

/** 识别单条 reason 开头的 `[底牌]` / `【底牌】` 前缀（长度 2~18 字），拆为徽章与正文。 */
export function splitReasonBadge(reason: string): { badge: string | null; text: string } {
  const trimmed = reason.trim();
  const match = /^(?:\[([^\]\n]{2,18})\]|【([^】\n]{2,18})】)\s*(.*)$/s.exec(trimmed);
  if (!match) return { badge: null, text: trimmed };
  const badge = (match[1] ?? match[2] ?? "").trim();
  const rest = (match[3] ?? "").trim();
  return badge ? { badge, text: rest } : { badge: null, text: trimmed };
}

/** 统计阅读字数时剥离 HTML 标签噪音，得到真实的纯文本字符数。 */
export function plainCharCount(raw: string): number {
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, "")
    .length;
}

/** 判断截断摘要是否已被完整正文覆盖，避免抽屉里先读残缺摘要再读正文。 */
export function isSummaryCoveredByContent(summary: string | null | undefined, content: string | null | undefined): boolean {
  if (!summary || !content) return false;
  const clean = (v: string) =>
    v
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  const s = clean(summary).replace(/^【[^】]+】\s*\|\s*/, "");
  const c = clean(content);
  if (!s || c.length <= s.length * 1.25) return false;
  const head = s.replace(/[.…]+$/, "").slice(0, 36).trim();
  if (head.length >= 6 && c.includes(head)) return true;
  return c.length >= 400 && (s.endsWith("...") || s.endsWith("…"));
}

/** 拆出可选顶部元信息头、主正文，以及尾部的飞书文档/关联文档/精选评论附加板块。 */
export function parseSnapshotSections(raw: string): SnapshotSections {
  let working = raw.replace(/\r\n/g, "\n").trim();
  let metaLine: string | null = null;

  const firstBreak = working.indexOf("\n\n");
  if (firstBreak > 0) {
    const firstBlock = working.slice(0, firstBreak).trim();
    if (META_HEADER_RE.test(firstBlock)) {
      metaLine = firstBlock;
      working = working.slice(firstBreak + 2).trim();
    }
  } else {
    const firstNewline = working.indexOf("\n");
    if (firstNewline > 0) {
      const firstLine = working.slice(0, firstNewline).trim();
      if (META_HEADER_RE.test(firstLine)) {
        metaLine = firstLine;
        working = working.slice(firstNewline + 1).trim();
      }
    }
  }

  let feishuDoc: string | null = null;
  let relatedDocs: string[] = [];
  let comments: SnapshotComment[] = [];

  TRAILING_SECTION_RE.lastIndex = 0;
  const matches: Array<{ index: number; end: number; kind: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = TRAILING_SECTION_RE.exec(working)) !== null) {
    matches.push({ index: m.index, end: m.index + m[0].length, kind: m[1]! });
  }

  let body = working;
  if (matches.length) {
    body = working.slice(0, matches[0]!.index).trim();
    for (let i = 0; i < matches.length; i += 1) {
      const cur = matches[i]!;
      const nextIndex = i + 1 < matches.length ? matches[i + 1]!.index : working.length;
      const chunk = working.slice(cur.end, nextIndex).trim();
      if (!chunk) continue;
      if (/^飞书/.test(cur.kind)) {
        feishuDoc = feishuDoc ? `${feishuDoc}\n\n${chunk}` : chunk;
      } else if (/^关联/.test(cur.kind)) {
        relatedDocs = relatedDocs.concat(
          chunk
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
        );
      } else if (/^精选/.test(cur.kind)) {
        const parsedComments = chunk
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line): SnapshotComment => {
            const cm = /^([^:\n：]{1,32})[:：]\s*(.+)$/.exec(line);
            if (cm && !/^https?$/i.test(cm[1]!)) {
              return { author: cm[1]!.trim(), body: cm[2]!.trim() };
            }
            return { body: line };
          });
        comments = comments.concat(parsedComments);
      }
    }
  }

  return { metaLine, body, feishuDoc, relatedDocs, comments };
}
