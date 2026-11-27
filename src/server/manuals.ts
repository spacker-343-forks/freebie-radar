import { all, get } from "./db.ts";
import { getItemDossier } from "./dossier.ts";
import {
  extractManualChapterNumber,
  isManualZeroDivider,
  matchActivityTrackSlug,
  parseManualTitleMeta,
  type ManualBookDetail,
  type ManualBookSummary,
  type ManualChapterDetail,
  type ManualChapterSummary,
  type ManualLinkedGroup,
  type ManualSectionGroup,
} from "../shared/manuals.ts";

type ManualDbRow = {
  id: number;
  external_id: string;
  url: string;
  title: string;
  summary: string | null;
  category: string | null;
  score: number;
  ai_quality: number | null;
  published_at: string | null;
  first_seen_at: string;
  raw: string;
  char_count: number;
  has_dossier: number;
};

type RawManualMeta = {
  activityId: string | null;
  activityName: string | null;
  itemId: string | null;
  parentId: string | null;
  periodLabel: string | null;
};

type ParsedChapterCandidate = {
  dbId: number;
  tocSeq: number;
  hasFullExternalId: boolean;
  externalId: string;
  url: string;
  title: string;
  cleanTitle: string;
  projectTitle: string | null;
  explicitSectionTitle: string | null;
  chapterKey: string;
  parentId: string | null;
  summary: string | null;
  category: string | null;
  score: number;
  aiQuality: number | null;
  publishedAt: string | null;
  firstSeenAt: string;
  charCount: number;
  hasDossier: boolean;
};

type BookBuildResult = {
  summary: ManualBookSummary;
  detail: ManualBookDetail;
  searchCorpus: string;
};

const MANUAL_WHERE_CLAUSE =
  "(i.source_id = 'scys-manuals' OR i.external_id LIKE 'scys-manual-%') AND i.status != 'ignored'";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function firstNonEmptyStr(obj: Record<string, unknown> | null, keys: string[]): string | null {
  if (!obj) return null;
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string" && val.trim()) return val.trim();
    if (typeof val === "number" && Number.isFinite(val)) return String(val);
  }
  return null;
}

function parseRawMeta(rawJson: string): RawManualMeta {
  try {
    const rec = asRecord(JSON.parse(rawJson || "{}"));
    return {
      activityId: firstNonEmptyStr(rec, ["activityId"]),
      activityName: firstNonEmptyStr(rec, ["activityName"]),
      itemId: firstNonEmptyStr(rec, ["itemId", "manualId", "docId", "articleId"]),
      parentId: firstNonEmptyStr(rec, ["parentId"]),
      periodLabel: firstNonEmptyStr(rec, ["periodLabel", "period", "sailPeriod"]),
    };
  } catch {
    return {
      activityId: null,
      activityName: null,
      itemId: null,
      parentId: null,
      periodLabel: null,
    };
  }
}

function parseExternalIdParts(externalId: string): { activityId: string | null; itemId: string | null; hasFullFormat: boolean } {
  const full = /^scys-manual-([^-]+)-(.+)$/.exec(externalId);
  if (full) {
    return { activityId: full[1]!.trim(), itemId: full[2]!.trim(), hasFullFormat: true };
  }
  const short = /^scys-manual-(.+)$/.exec(externalId);
  if (short) {
    return { activityId: null, itemId: short[1]!.trim(), hasFullFormat: false };
  }
  return { activityId: null, itemId: null, hasFullFormat: false };
}

function tableExists(name: string): boolean {
  const row = get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    name,
  );
  return Boolean(row?.name);
}

function tableColumns(name: string): Set<string> {
  const rows = all<{ name: string }>(`PRAGMA table_info(${name})`);
  return new Set(rows.map((r) => r.name));
}

function pickColumn(cols: Set<string>, candidates: string[]): string | null {
  for (const col of candidates) {
    if (cols.has(col)) return col;
  }
  return null;
}

function pickMostFrequentString(candidates: Array<string | null | undefined>, fallback: string): string {
  const counts = new Map<string, number>();
  for (const raw of candidates) {
    const val = raw?.trim();
    if (!val) continue;
    counts.set(val, (counts.get(val) ?? 0) + 1);
  }
  if (!counts.size) return fallback;
  let best = fallback;
  let bestCount = -1;
  for (const [val, count] of counts) {
    if (count > bestCount || (count === bestCount && val.length > best.length)) {
      best = val;
      bestCount = count;
    }
  }
  return best;
}

function pickBookCategory(categories: Array<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const c of categories) {
    const val = c?.trim();
    if (!val) continue;
    counts.set(val, (counts.get(val) ?? 0) + 1);
  }
  if (!counts.size) return null;
  const entries = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    const aGeneric = a[0] === "course" || a[0] === "other" ? 1 : 0;
    const bGeneric = b[0] === "course" || b[0] === "other" ? 1 : 0;
    return aGeneric - bGeneric;
  });
  return entries[0]?.[0] ?? null;
}

function inferPeriodLabel(bookTitle: string, rawPeriod: string | null): string | null {
  if (rawPeriod) return rawPeriod;
  const match = /[（(]([^）)]*期)[）)]/.exec(bookTitle);
  return match?.[1]?.trim() ?? null;
}

function deduplicateChapters(candidates: ParsedChapterCandidate[]): ParsedChapterCandidate[] {
  const byKey = new Map<string, ParsedChapterCandidate>();
  for (const cand of candidates) {
    const existing = byKey.get(cand.chapterKey);
    if (!existing) {
      byKey.set(cand.chapterKey, cand);
      continue;
    }

    // 同一章节若同时存在 scysCollector 裸条与 backfill 完整条，优先保留完整内容与较高评分，并继承缺失的 parentId / sectionTitle
    const preferCand =
      (cand.charCount !== existing.charCount && cand.charCount > existing.charCount) ||
      (cand.charCount === existing.charCount && cand.hasFullExternalId && !existing.hasFullExternalId) ||
      (cand.charCount === existing.charCount &&
        cand.hasFullExternalId === existing.hasFullExternalId &&
        cand.score > existing.score);

    const primary = preferCand ? cand : existing;
    const secondary = preferCand ? existing : cand;

    byKey.set(cand.chapterKey, {
      ...primary,
      tocSeq: primary.hasFullExternalId ? primary.tocSeq : secondary.hasFullExternalId ? secondary.tocSeq : Math.min(primary.tocSeq, secondary.tocSeq),
      projectTitle: primary.projectTitle ?? secondary.projectTitle,
      explicitSectionTitle: primary.explicitSectionTitle ?? secondary.explicitSectionTitle,
      parentId: primary.parentId ?? secondary.parentId,
      hasDossier: primary.hasDossier || secondary.hasDossier,
      score: Math.max(primary.score, secondary.score),
      aiQuality:
        primary.aiQuality !== null && secondary.aiQuality !== null
          ? Math.max(primary.aiQuality, secondary.aiQuality)
          : primary.aiQuality ?? secondary.aiQuality,
      publishedAt: primary.publishedAt ?? secondary.publishedAt,
      summary: primary.summary ?? secondary.summary,
    });
  }
  return [...byKey.values()];
}

function sortSectionChapters(chapters: ParsedChapterCandidate[]): ParsedChapterCandidate[] {
  return [...chapters].sort((a, b) => {
    const aNum = extractManualChapterNumber(a.cleanTitle);
    const bNum = extractManualChapterNumber(b.cleanTitle);
    const aRank = aNum ?? Number.MAX_SAFE_INTEGER;
    const bRank = bNum ?? Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return aRank - bRank;
    if (a.tocSeq !== b.tocSeq) return a.tocSeq - b.tocSeq;
    const aKeyNum = Number(a.chapterKey);
    const bKeyNum = Number(b.chapterKey);
    if (Number.isFinite(aKeyNum) && Number.isFinite(bKeyNum) && aKeyNum !== bKeyNum) {
      return aKeyNum - bKeyNum;
    }
    return a.dbId - b.dbId;
  });
}

function buildSectionsAndChapters(deduped: ParsedChapterCandidate[]): {
  sections: ManualSectionGroup[];
  chapters: Array<ManualChapterSummary & { summary: string | null }>;
} {
  const ordered = [...deduped].sort((a, b) => a.tocSeq - b.tocSeq || a.dbId - b.dbId);
  const hasExplicitSections = ordered.some((c) => Boolean(c.explicitSectionTitle));

  type RawBucket = { sectionTitle: string; items: ParsedChapterCandidate[] };
  const buckets: RawBucket[] = [];

  if (hasExplicitSections) {
    const bySection = new Map<string, ParsedChapterCandidate[]>();
    for (const ch of ordered) {
      const sec = ch.explicitSectionTitle || "开篇导读";
      let arr = bySection.get(sec);
      if (!arr) {
        arr = [];
        bySection.set(sec, arr);
        buckets.push({ sectionTitle: sec, items: arr });
      }
      arr.push(ch);
    }
  } else {
    let currentBucket: ParsedChapterCandidate[] = [];
    let currentParentId: string | null = null;
    let prevNumberInBucket: number | null = null;

    const flushBucket = () => {
      if (!currentBucket.length) return;
      buckets.push({ sectionTitle: "", items: currentBucket });
      currentBucket = [];
      prevNumberInBucket = null;
    };

    for (const ch of ordered) {
      const num = extractManualChapterNumber(ch.cleanTitle);
      const isZero = isManualZeroDivider(ch.cleanTitle);

      let startNew = false;
      if (currentBucket.length > 0) {
        if (ch.parentId && currentParentId && ch.parentId !== currentParentId) {
          startNew = true;
        } else if (ch.parentId && !currentParentId) {
          startNew = true;
        } else if (!ch.parentId && currentParentId) {
          startNew = true;
        } else if (!ch.parentId && isZero) {
          startNew = true;
        } else if (
          !ch.parentId &&
          num !== null &&
          prevNumberInBucket !== null &&
          (num < prevNumberInBucket || (num === 1 && prevNumberInBucket === 1))
        ) {
          startNew = true;
        }
      }

      if (startNew) {
        flushBucket();
      }
      currentBucket.push(ch);
      currentParentId = ch.parentId;
      if (num !== null) prevNumberInBucket = num;
    }
    flushBucket();

    if (buckets.length <= 1) {
      if (buckets[0]) buckets[0].sectionTitle = "正文目录";
    } else {
      const firstHasZero = buckets[0]!.items.some((c) => isManualZeroDivider(c.cleanTitle));
      const laterHasZero = buckets.slice(1).some((b) => b.items.some((c) => isManualZeroDivider(c.cleanTitle)));
      let stageIndex = 1;
      for (let i = 0; i < buckets.length; i += 1) {
        if (i === 0 && !firstHasZero && laterHasZero && buckets[0]!.items.length <= 2) {
          buckets[i]!.sectionTitle = "开篇导读";
        } else {
          buckets[i]!.sectionTitle = `第 ${stageIndex} 关`;
          stageIndex += 1;
        }
      }
    }
  }

  const sections: ManualSectionGroup[] = [];
  const flatChapters: Array<ManualChapterSummary & { summary: string | null }> = [];
  let orderIndex = 0;

  for (const bucket of buckets) {
    const sortedItems = sortSectionChapters(bucket.items);
    const sectionChapters: ManualChapterSummary[] = [];
    for (const ch of sortedItems) {
      const summaryRow: ManualChapterSummary & { summary: string | null } = {
        itemId: ch.dbId,
        chapterKey: ch.chapterKey,
        title: ch.title,
        cleanTitle: ch.cleanTitle,
        sectionTitle: bucket.sectionTitle || null,
        orderIndex,
        charCount: ch.charCount,
        score: ch.score,
        aiQuality: ch.aiQuality,
        hasDossier: ch.hasDossier,
        url: ch.url,
        summary: ch.summary,
      };
      orderIndex += 1;
      const { summary: _omitSummary, ...chapterSummary } = summaryRow;
      sectionChapters.push(chapterSummary);
      flatChapters.push(summaryRow);
    }
    sections.push({
      sectionTitle: bucket.sectionTitle,
      chapters: sectionChapters,
    });
  }

  return { sections, chapters: flatChapters };
}

function buildPreviewChapters(chapters: ManualChapterSummary[]): string[] {
  const nonZero = chapters
    .filter((c) => !isManualZeroDivider(c.cleanTitle))
    .map((c) => c.cleanTitle);
  const pool = nonZero.length ? nonZero : chapters.map((c) => c.cleanTitle);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const title of pool) {
    if (!seen.has(title)) {
      seen.add(title);
      unique.push(title);
    }
    if (unique.length >= 3) break;
  }
  return unique;
}

function loadLinkedGroupsByActivity(bookTitlesByActivity: Map<string, string>): Map<string, ManualLinkedGroup[]> {
  const result = new Map<string, ManualLinkedGroup[]>();
  try {
    if (!tableExists("scys_chat_groups")) return result;
    const groupCols = tableColumns("scys_chat_groups");
    const groupKeyCol = pickColumn(groupCols, ["group_key", "groupKey"]);
    const nameCol = pickColumn(groupCols, ["name", "group_name", "groupName"]);
    if (!groupKeyCol || !nameCol) return result;

    const platformCol = pickColumn(groupCols, ["platform"]);
    const msgCountCol = pickColumn(groupCols, ["message_count", "msg_count", "messageCount"]);
    const lastMsgCol = pickColumn(groupCols, ["last_msg_time", "last_message_time", "lastMsgTime"]);
    const linkedActCol = pickColumn(groupCols, ["linked_activity_id", "activity_id", "linkedActivityId"]);

    const rows = all<{
      groupKey: string;
      platform: number | null;
      name: string;
      messageCount: number | null;
      lastMsgTime: number | null;
      linkedActivityId: string | number | null;
    }>(
      `SELECT ${groupKeyCol} AS groupKey,
              ${platformCol ? platformCol : "1"} AS platform,
              ${nameCol} AS name,
              ${msgCountCol ? msgCountCol : "0"} AS messageCount,
              ${lastMsgCol ? lastMsgCol : "0"} AS lastMsgTime,
              ${linkedActCol ? linkedActCol : "NULL"} AS linkedActivityId
         FROM scys_chat_groups`,
    );

    if (!rows.length) return result;

    // 可选统计 scys_chat_digests 提纯条数
    const digestCounts = new Map<string, number>();
    if (tableExists("scys_chat_digests")) {
      const digestCols = tableColumns("scys_chat_digests");
      const dGroupKeyCol = pickColumn(digestCols, ["group_key", "groupKey"]);
      if (dGroupKeyCol) {
        const dRows = all<{ groupKey: string; cnt: number }>(
          `SELECT ${dGroupKeyCol} AS groupKey, COUNT(*) AS cnt FROM scys_chat_digests GROUP BY ${dGroupKeyCol}`,
        );
        for (const d of dRows) {
          digestCounts.set(String(d.groupKey), Number(d.cnt ?? 0));
        }
      }
    }

    // 为每个 track slug 找出 CAST(activityId AS INTEGER) 最大的最新一期当期航海
    const latestActivityBySlug = new Map<string, { activityId: string; numericId: number }>();
    for (const [activityId, title] of bookTitlesByActivity) {
      const slug = matchActivityTrackSlug(title);
      if (!slug) continue;
      const numericId = /^\d+$/.test(activityId) ? Number(activityId) : -1;
      const prev = latestActivityBySlug.get(slug);
      if (!prev || numericId > prev.numericId) {
        latestActivityBySlug.set(slug, { activityId, numericId });
      }
    }

    for (const g of rows) {
      const explicitActId =
        g.linkedActivityId !== null && g.linkedActivityId !== undefined && String(g.linkedActivityId).trim()
          ? String(g.linkedActivityId).trim()
          : null;

      let targetActivityId: string | null = null;
      if (explicitActId && bookTitlesByActivity.has(explicitActId)) {
        targetActivityId = explicitActId;
      } else if (!explicitActId) {
        const slug = matchActivityTrackSlug(g.name);
        if (slug) {
          targetActivityId = latestActivityBySlug.get(slug)?.activityId ?? null;
        }
      }

      if (!targetActivityId) continue;
      const linked: ManualLinkedGroup = {
        groupKey: String(g.groupKey),
        platform: Number(g.platform ?? 1),
        name: String(g.name),
        messageCount: Number(g.messageCount ?? 0),
        lastMsgTime: Number(g.lastMsgTime ?? 0),
        ...(digestCounts.has(String(g.groupKey)) ? { digestCount: digestCounts.get(String(g.groupKey))! } : {}),
      };
      const arr = result.get(targetActivityId) ?? [];
      arr.push(linked);
      result.set(targetActivityId, arr);
    }

    for (const arr of result.values()) {
      arr.sort((a, b) => b.lastMsgTime - a.lastMsgTime || b.messageCount - a.messageCount || a.name.localeCompare(b.name));
    }
    return result;
  } catch {
    return new Map();
  }
}

function loadAndBuildAllBooks(targetActivityId?: string): BookBuildResult[] {
  const hasDossierTable = tableExists("item_dossiers");
  const dossierExpr = hasDossierTable
    ? "EXISTS (SELECT 1 FROM item_dossiers d WHERE d.item_id = i.id)"
    : "0";

  const rows = all<ManualDbRow>(
    `SELECT i.id,
            i.external_id,
            i.url,
            i.title,
            i.summary,
            i.category,
            i.score,
            i.ai_quality,
            i.published_at,
            i.first_seen_at,
            i.raw,
            LENGTH(COALESCE(i.content, i.summary, '')) AS char_count,
            ${dossierExpr} AS has_dossier
       FROM items i
      WHERE ${MANUAL_WHERE_CLAUSE}
      ORDER BY i.id ASC`,
  );

  if (!rows.length) return [];

  const grouped = new Map<
    string,
    {
      rawNames: Array<string | null>;
      rawPeriods: Array<string | null>;
      candidates: ParsedChapterCandidate[];
    }
  >();

  for (const row of rows) {
    const rawMeta = parseRawMeta(row.raw);
    const extParts = parseExternalIdParts(row.external_id);
    const titleMeta = parseManualTitleMeta(row.title);

    const activityId =
      rawMeta.activityId ||
      extParts.activityId ||
      (titleMeta.projectTitle ? `title:${titleMeta.projectTitle}` : `item:${row.id}`);

    if (targetActivityId && activityId !== targetActivityId) continue;

    const chapterKey = rawMeta.itemId || extParts.itemId || `row:${row.id}`;

    let bucket = grouped.get(activityId);
    if (!bucket) {
      bucket = { rawNames: [], rawPeriods: [], candidates: [] };
      grouped.set(activityId, bucket);
    }
    bucket.rawNames.push(rawMeta.activityName, titleMeta.projectTitle);
    if (rawMeta.periodLabel) bucket.rawPeriods.push(rawMeta.periodLabel);

    bucket.candidates.push({
      dbId: row.id,
      tocSeq: row.id,
      hasFullExternalId: extParts.hasFullFormat,
      externalId: row.external_id,
      url: row.url,
      title: row.title,
      cleanTitle: titleMeta.chapterTitle,
      projectTitle: titleMeta.projectTitle,
      explicitSectionTitle: titleMeta.sectionTitle,
      chapterKey,
      parentId: rawMeta.parentId,
      summary: row.summary,
      category: row.category,
      score: Number(row.score ?? 0),
      aiQuality: row.ai_quality !== null && row.ai_quality !== undefined ? Number(row.ai_quality) : null,
      publishedAt: row.published_at,
      firstSeenAt: row.first_seen_at,
      charCount: Number(row.char_count ?? 0),
      hasDossier: Boolean(row.has_dossier),
    });
  }

  if (!grouped.size) return [];

  // 如果只查询单本 detail，仍需全部 book 的 title 才能精确判定 11 月群归属的最新一期 activityId
  const bookTitlesForLinking = new Map<string, string>();
  if (targetActivityId) {
    for (const row of rows) {
      const rawMeta = parseRawMeta(row.raw);
      const extParts = parseExternalIdParts(row.external_id);
      const titleMeta = parseManualTitleMeta(row.title);
      const actId =
        rawMeta.activityId ||
        extParts.activityId ||
        (titleMeta.projectTitle ? `title:${titleMeta.projectTitle}` : `item:${row.id}`);
      const candidateTitle = rawMeta.activityName || titleMeta.projectTitle;
      if (candidateTitle && !bookTitlesForLinking.has(actId)) {
        bookTitlesForLinking.set(actId, candidateTitle);
      }
    }
  }

  const prelimTitles = new Map<string, string>();
  for (const [activityId, bucket] of grouped) {
    const fallbackName = activityId.startsWith("title:")
      ? activityId.slice("title:".length)
      : `航海手册 #${activityId}`;
    const title = pickMostFrequentString(bucket.rawNames, fallbackName);
    prelimTitles.set(activityId, title);
    bookTitlesForLinking.set(activityId, title);
  }

  const linkedGroupsMap = loadLinkedGroupsByActivity(bookTitlesForLinking);
  const results: BookBuildResult[] = [];

  for (const [activityId, bucket] of grouped) {
    const title = prelimTitles.get(activityId)!;
    const deduped = deduplicateChapters(bucket.candidates);
    const { sections, chapters } = buildSectionsAndChapters(deduped);

    const totalChars = chapters.reduce((sum, ch) => sum + ch.charCount, 0);
    const dossierCount = chapters.reduce((sum, ch) => sum + (ch.hasDossier ? 1 : 0), 0);
    const maxScore = chapters.reduce((max, ch) => (ch.score > max ? ch.score : max), 0);
    const publishedAt =
      deduped
        .map((c) => c.publishedAt || c.firstSeenAt)
        .filter(Boolean)
        .sort()
        .at(-1) ?? null;

    const linkedGroups = linkedGroupsMap.get(activityId) ?? [];
    const summary: ManualBookSummary = {
      activityId,
      title,
      periodLabel: inferPeriodLabel(title, bucket.rawPeriods[0] ?? null),
      category: pickBookCategory(deduped.map((c) => c.category)),
      chapterCount: chapters.length,
      totalChars,
      dossierCount,
      maxScore,
      publishedAt,
      coverChapterItemId: chapters[0]?.itemId ?? 0,
      previewChapters: buildPreviewChapters(chapters),
      linkedGroups,
    };

    const detail: ManualBookDetail = {
      ...summary,
      sections,
      chapters,
    };

    const searchCorpus = [
      activityId,
      title,
      summary.category ?? "",
      ...linkedGroups.map((g) => g.name),
      ...sections.map((s) => s.sectionTitle),
      ...chapters.map((c) => c.cleanTitle),
    ]
      .join("\n")
      .toLowerCase();

    results.push({ summary, detail, searchCorpus });
  }

  results.sort((a, b) => {
    const aNum = /^\d+$/.test(a.summary.activityId) ? Number(a.summary.activityId) : -1;
    const bNum = /^\d+$/.test(b.summary.activityId) ? Number(b.summary.activityId) : -1;
    if (aNum !== bNum) return bNum - aNum;
    if (b.summary.maxScore !== a.summary.maxScore) return b.summary.maxScore - a.summary.maxScore;
    return b.summary.chapterCount - a.summary.chapterCount;
  });

  return results;
}

/** 列出全部聚合后的《航海实战手册》整书卡片（支持按书名/赛道/群名/章节名关键词过滤）。 */
export function listManualBooks(options?: { q?: string }): ManualBookSummary[] {
  const books = loadAndBuildAllBooks();
  const q = options?.q?.trim().toLowerCase();
  if (!q) return books.map((b) => b.summary);
  return books.filter((b) => b.searchCorpus.includes(q)).map((b) => b.summary);
}

/** 获取指定 `activityId` 的《航海实战手册》整书详情与分关目录树。 */
export function getManualBookDetail(activityId: string): ManualBookDetail | null {
  const key = activityId.trim();
  if (!key) return null;
  const books = loadAndBuildAllBooks(key);
  return books[0]?.detail ?? null;
}

/** 获取单篇手册章节的完整正文快照与 AI 实战立项拆解书。 */
export function getManualChapter(itemId: number): ManualChapterDetail | null {
  if (!Number.isSafeInteger(itemId) || itemId < 1) return null;
  const hasDossierTable = tableExists("item_dossiers");
  const dossierExpr = hasDossierTable
    ? "EXISTS (SELECT 1 FROM item_dossiers d WHERE d.item_id = i.id)"
    : "0";

  const row = get<{
    id: number;
    external_id: string;
    url: string;
    title: string;
    summary: string | null;
    content: string | null;
    category: string | null;
    tags: string;
    score: number;
    ai_quality: number | null;
    published_at: string | null;
    first_seen_at: string;
    raw: string;
    has_dossier: number;
  }>(
    `SELECT i.id,
            i.external_id,
            i.url,
            i.title,
            i.summary,
            i.content,
            i.category,
            i.tags,
            i.score,
            i.ai_quality,
            i.published_at,
            i.first_seen_at,
            i.raw,
            ${dossierExpr} AS has_dossier
       FROM items i
      WHERE i.id = ? AND ${MANUAL_WHERE_CLAUSE}`,
    itemId,
  );
  if (!row) return null;

  const rawMeta = parseRawMeta(row.raw);
  const extParts = parseExternalIdParts(row.external_id);
  const titleMeta = parseManualTitleMeta(row.title);
  const activityId =
    rawMeta.activityId ||
    extParts.activityId ||
    (titleMeta.projectTitle ? `title:${titleMeta.projectTitle}` : null);
  const chapterKey = rawMeta.itemId || extParts.itemId || `row:${row.id}`;
  const dossier = hasDossierTable ? getItemDossier(row.id) : null;

  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags || "[]");
    if (Array.isArray(parsed)) tags = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    tags = [];
  }

  let sectionTitle = titleMeta.sectionTitle;
  let bookTitle = rawMeta.activityName || titleMeta.projectTitle;
  let orderIndex = 0;

  if (activityId) {
    const book = getManualBookDetail(activityId);
    if (book) {
      bookTitle = book.title;
      const matched = book.chapters.find((c) => c.itemId === row.id || c.chapterKey === chapterKey);
      if (matched) {
        sectionTitle = matched.sectionTitle;
        orderIndex = matched.orderIndex;
      }
    }
  }

  const bodyText = row.content ?? row.summary ?? "";
  return {
    itemId: row.id,
    chapterKey,
    title: row.title,
    cleanTitle: titleMeta.chapterTitle,
    sectionTitle,
    orderIndex,
    charCount: bodyText.length,
    score: Number(row.score ?? 0),
    aiQuality: row.ai_quality !== null && row.ai_quality !== undefined ? Number(row.ai_quality) : null,
    hasDossier: Boolean(dossier || row.has_dossier),
    url: row.url,
    activityId,
    bookTitle,
    category: row.category,
    tags,
    publishedAt: row.published_at || row.first_seen_at || null,
    summary: row.summary,
    content: row.content,
    dossier,
  };
}
