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
const BLOCK_HTML_RE = /<(?:p|div|h[1-6]|ul|ol|li|pre|blockquote|table|section|article)\b[^>]*>/i;
const INLINE_HTML_RE = /<(?:img|strong|em|b|i|a|span|code)\b[^>]*>/i;
const MARKDOWN_SIGNAL_RE = /(?:^#{1,6}\s+\S|^\|.+\|\s*\n\|[\s:|-]+\||^```|!?\[[^\]\n]*\]\(https?:\/\/)/m;

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

/** 区分富文本 HTML 快照与纯 Markdown 文本（忽略代码块内的 HTML 示例及 Markdown 表格常用的 `<br>`）。 */
export function looksLikeHtml(text: string): boolean {
  const withoutCode = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]+`/g, "");
  if (BLOCK_HTML_RE.test(withoutCode)) return true;
  if (INLINE_HTML_RE.test(withoutCode) && !MARKDOWN_SIGNAL_RE.test(withoutCode)) return true;
  return false;
}

export type MarkdownAlign = "left" | "center" | "right";

export type MarkdownListItem = {
  text: string;
  checked?: boolean;
};

export type MarkdownBlock =
  | { type: "code"; code: string }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "hr" }
  | { type: "blockquote"; lines: string[] }
  | { type: "ul"; items: MarkdownListItem[] }
  | { type: "ol"; items: string[] }
  | { type: "table"; headers: string[]; aligns: MarkdownAlign[]; rows: string[][] }
  | { type: "paragraph"; lines: string[] };

const MD_HEADING_RE = /^(#{1,6})\s+(.+)$/;
const MD_HR_RE = /^(?:---+|\*\*\*+|___+)$/;
const MD_UL_RE = /^[-•*]\s+/;
const MD_OL_RE = /^\d+[.、)）]\s+/;
const MD_TASK_RE = /^\[([ xX])\]\s+([\s\S]*)$/;

export function isMarkdownTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|") || !trimmed.includes("-")) return false;
  return /^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$/.test(trimmed);
}

/** 按 GFM 规则拆分表格行单元格，保留反引号内与 `\|` 转义的竖线。 */
export function splitMarkdownTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) trimmed = trimmed.slice(0, -1);

  const cells: string[] = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (ch === "\\" && i + 1 < trimmed.length && trimmed[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (ch === "`") {
      inCode = !inCode;
      current += ch;
      continue;
    }
    if (ch === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function parseTableAligns(sepLine: string, colCount: number): MarkdownAlign[] {
  const rawCells = splitMarkdownTableRow(sepLine);
  const aligns: MarkdownAlign[] = [];
  for (let c = 0; c < colCount; c += 1) {
    const cell = (rawCells[c] ?? "").trim();
    if (cell.startsWith(":") && cell.endsWith(":")) aligns.push("center");
    else if (cell.endsWith(":")) aligns.push("right");
    else aligns.push("left");
  }
  return aligns;
}

function isTableStart(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length) return false;
  const header = lines[index]!.trim();
  if (!header.includes("|")) return false;
  return isMarkdownTableSeparator(lines[index + 1]!);
}

function isMarkdownBlockStarter(lines: string[], index: number): boolean {
  const trimmed = lines[index]!.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("```") || trimmed.startsWith(">")) return true;
  if (MD_HEADING_RE.test(trimmed) || MD_HR_RE.test(trimmed)) return true;
  if (MD_UL_RE.test(trimmed) || MD_OL_RE.test(trimmed)) return true;
  return isTableStart(lines, index);
}

/** 将 Markdown 文本拆解为代码块、标题(H1-H6)、表格、引用、列表与段落结构。 */
export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: "code", code: codeLines.join("\n") });
      continue;
    }

    const headingMatch = MD_HEADING_RE.exec(trimmed);
    if (headingMatch) {
      const level = Math.min(6, headingMatch[1]!.length) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: "heading", level, text: headingMatch[2]! });
      i += 1;
      continue;
    }

    if (MD_HR_RE.test(trimmed)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    if (isTableStart(lines, i)) {
      const headers = splitMarkdownTableRow(lines[i]!);
      const aligns = parseTableAligns(lines[i + 1]!, headers.length);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length) {
        const rowLine = lines[i]!.trim();
        if (!rowLine || !rowLine.includes("|")) break;
        if (rowLine.startsWith("```") || MD_HEADING_RE.test(rowLine)) break;
        const parsed = splitMarkdownTableRow(rowLine);
        const normalized = headers.map((_, colIdx) => parsed[colIdx] ?? "");
        rows.push(normalized);
        i += 1;
      }
      blocks.push({ type: "table", headers, aligns, rows });
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith(">")) {
        quoteLines.push(lines[i]!.trim().replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "blockquote", lines: quoteLines });
      continue;
    }

    if (MD_UL_RE.test(trimmed)) {
      const items: MarkdownListItem[] = [];
      while (i < lines.length && MD_UL_RE.test(lines[i]!.trim())) {
        const rawItem = lines[i]!.trim().replace(MD_UL_RE, "");
        const taskMatch = MD_TASK_RE.exec(rawItem);
        if (taskMatch) {
          items.push({ checked: taskMatch[1]!.toLowerCase() === "x", text: taskMatch[2]! });
        } else {
          items.push({ text: rawItem });
        }
        i += 1;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    if (MD_OL_RE.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && MD_OL_RE.test(lines[i]!.trim())) {
        items.push(lines[i]!.trim().replace(MD_OL_RE, ""));
        i += 1;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    const paraLines: string[] = [];
    while (i < lines.length && !isMarkdownBlockStarter(lines, i)) {
      paraLines.push(lines[i]!.trim());
      i += 1;
    }
    if (paraLines.length) {
      blocks.push({ type: "paragraph", lines: paraLines });
    }
  }

  return blocks;
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
