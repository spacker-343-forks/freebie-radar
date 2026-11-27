import { backfillAi } from "../src/server/ai-admin.ts";
import { ensureSources, ingestItems } from "../src/server/collectors/index.ts";
import { MAX_ARCHIVE_CONTENT_CHARS, parseScysTimestamp } from "../src/server/collectors/scys.ts";
import type { RawItem } from "../src/server/collectors/types.ts";
import { all, get, migrate, run } from "../src/server/db.ts";
import { aiReady, getAiSettings, parseModelSpec, saveAiSettings } from "../src/server/enrich/ai-settings.ts";
import { cleanText } from "../src/server/enrich/normalize.ts";
import { getRetention, saveRetention } from "../src/server/retention.ts";
import { ScysMcpClient } from "../src/server/scys/mcp-client.ts";

const PROGRESS_KEY = "scys_manuals_progress";

type ProgressState = {
  completed: string[];
  updatedAt: string;
};

function readArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1]!.startsWith("--")) {
    return args[idx + 1]!;
  }
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

function parseOptions(argv: string[]) {
  const reset = argv.includes("--reset");
  const maxRaw = readArgValue(argv, "--max-activities");
  const maxActivities = maxRaw && Number.isFinite(Number(maxRaw)) && Number(maxRaw) > 0
    ? Math.round(Number(maxRaw))
    : Infinity;
  const model = (readArgValue(argv, "--model") ?? "gpt-6.2-sol:xhigh").trim() || "gpt-6.2-sol:xhigh";
  return { reset, maxActivities, model };
}

function loadProgress(): Set<string> {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", PROGRESS_KEY);
  if (!row?.value) return new Set();
  try {
    const parsed = JSON.parse(row.value) as Partial<ProgressState>;
    return new Set(Array.isArray(parsed.completed) ? parsed.completed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveProgress(completed: Set<string>): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    PROGRESS_KEY,
    JSON.stringify({ completed: [...completed], updatedAt: now }),
    now,
  );
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

type TocChapter = {
  itemId: string;
  title: string;
  section?: string;
};

function extractActivities(payload: unknown): Array<{ id: string; name: string; publishedAt: string | null }> {
  const root = asRecord(payload);
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.items)
      ? root.items
      : Array.isArray(root?.list)
        ? root.list
        : Array.isArray(root?.data)
          ? root.data
          : [];
  const out: Array<{ id: string; name: string; publishedAt: string | null }> = [];
  for (const row of list) {
    const rec = asRecord(row);
    if (!rec) continue;
    const id = firstString(rec, ["id", "activityId"]);
    if (!id) continue;
    const name = firstString(rec, ["name", "title"]) || `航海 #${id}`;
    const publishedAt = parseScysTimestamp(rec.sailTime ?? rec.startTime ?? rec.gmtCreate ?? rec.createdAt);
    out.push({ id, name, publishedAt });
  }
  return out;
}

function extractTocChapters(payload: unknown): TocChapter[] {
  const root = asRecord(payload);
  const top = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.items)
      ? root.items
      : Array.isArray(root?.toc)
        ? root.toc
        : Array.isArray(root?.chapters)
          ? root.chapters
          : Array.isArray(root?.data)
            ? root.data
            : [];

  const out: TocChapter[] = [];
  const seen = new Set<string>();

  const visit = (node: Record<string, unknown>, groupTitle?: string) => {
    const children =
      (Array.isArray(node.children) && node.children) ||
      (Array.isArray(node.items) && node.items) ||
      (Array.isArray(node.articles) && node.articles) ||
      (Array.isArray(node.chapters) && node.chapters) ||
      [];
    const nodeTitle = firstString(node, ["title", "name", "chapterTitle"]);
    const itemId = firstString(node, ["itemId", "manualId", "docId", "articleId", "id"]);
    const hasContent = node.hasContent !== false;

    if (itemId && hasContent && !seen.has(itemId)) {
      seen.add(itemId);
      out.push({
        itemId,
        title: nodeTitle || groupTitle || `章节 ${itemId}`,
        section: groupTitle && groupTitle !== nodeTitle ? groupTitle : undefined,
      });
    }

    for (const c of children) {
      const cr = asRecord(c);
      if (cr) visit(cr, nodeTitle || groupTitle);
    }
  };

  for (const entry of top) {
    const rec = asRecord(entry);
    if (rec) visit(rec);
  }
  return out;
}

function findExistingArchivedIds(externalIds: string[]): Set<string> {
  if (!externalIds.length) return new Set();
  const existing = new Set<string>();
  const chunkSize = 200;
  for (let i = 0; i < externalIds.length; i += chunkSize) {
    const slice = externalIds.slice(i, i + chunkSize);
    const ph = slice.map(() => "?").join(", ");
    const rows = all<{ external_id: string }>(
      `SELECT external_id FROM items WHERE external_id IN (${ph}) AND content IS NOT NULL AND TRIM(content) != ''`,
      ...slice,
    );
    for (const r of rows) existing.add(r.external_id);
  }
  return existing;
}

async function fetchFullChapterMarkdown(
  client: ScysMcpClient,
  activityId: string,
  itemId: string,
): Promise<{ title?: string; content: string }> {
  const chunks: string[] = [];
  let offset = 0;
  let totalLen = 0;
  let title: string | undefined;

  for (let page = 0; page < 20; page += 1) {
    // Strictly pass only { activityId, itemId } (never courseId alongside activityId)
    const args: Record<string, unknown> = {
      activityId,
      itemId,
      maxChars: 50_000,
      format: "markdown",
    };
    if (offset > 0) args.offset = offset;

    const res = await client.callTool<unknown>("activityManualDetail", args);
    if (typeof res === "string") {
      chunks.push(res);
      break;
    }
    const rec = asRecord(res);
    if (!rec) break;
    if (!title) {
      const t = firstString(rec, ["title", "name", "itemTitle"]);
      if (t) title = t;
    }
    const text = firstString(rec, ["content", "markdown", "text", "body"]);
    if (text) {
      chunks.push(text);
      totalLen += text.length;
    }
    if (rec.truncated === true && typeof rec.nextOffset === "number" && rec.nextOffset > offset && totalLen < MAX_ARCHIVE_CONTENT_CHARS) {
      offset = rec.nextOffset;
    } else {
      break;
    }
  }

  return {
    title,
    content: chunks.join("\n").trim().slice(0, MAX_ARCHIVE_CONTENT_CHARS),
  };
}

async function main(): Promise<void> {
  migrate();
  ensureSources();

  const curRetention = getRetention();
  if (curRetention.keptDays <= 180) {
    saveRetention({ itemDays: 3650, keptDays: 3650, auto: false });
    console.log("[manuals] 已将内容保留期升级为 10 年长期归档（itemDays=3650, keptDays=3650, auto=false）");
  }

  const opts = parseOptions(process.argv.slice(2));
  if (opts.reset) {
    run("DELETE FROM settings WHERE key = ?", PROGRESS_KEY);
    console.log("[manuals] 已重置航海手册抓取代号断点 (settings.scys_manuals_progress)");
  }

  const completed = loadProgress();
  const client = new ScysMcpClient();
  const slotCount = Math.max(1, client.getSlotCount());
  console.log(`[manuals] 连接池槽位数=${slotCount} | AI脱水模型=${opts.model}`);

  // 分页遍历 activityList 获取全部历史与当期航海项目
  const activities: Array<{ id: string; name: string; publishedAt: string | null }> = [];
  const seenAct = new Set<string>();
  for (let pageIndex = 1; pageIndex <= 20; pageIndex += 1) {
    const res = await client.callTool<unknown>("activityList", { pageIndex, pageSize: 50 });
    const batch = extractActivities(res);
    if (!batch.length) break;
    let added = 0;
    for (const act of batch) {
      if (!seenAct.has(act.id)) {
        seenAct.add(act.id);
        activities.push(act);
        added += 1;
      }
    }
    if (batch.length < 50 || added === 0) break;
  }

  const targets = activities.slice(0, opts.maxActivities);
  console.log(`[manuals] 共发现 ${activities.length} 个航海项目，本轮计划处理 ${targets.length} 个`);

  const origAi = getAiSettings();
  const isXhigh = parseModelSpec(opts.model).reasoningEffort === "xhigh";
  const aiConfigured = aiReady({ ...origAi, enabled: true, model: opts.model });

  for (let i = 0; i < targets.length; i += 1) {
    const act = targets[i]!;
    const ck = `act:${act.id}`;
    if (completed.has(ck)) {
      console.log(`[manuals] [${i + 1}/${targets.length}] 跳过已完成断点 ${ck} (${act.name})`);
      continue;
    }

    console.log(`\n[manuals] [${i + 1}/${targets.length}] 拉取目录: ${act.name} (activityId=${act.id})`);
    const tocRes = await client.callTool<unknown>("activityManualToc", { activityId: String(act.id) });
    const chapters = extractTocChapters(tocRes);
    if (!chapters.length) {
      console.log(`[manuals] ${act.name} 无可读章节，标记跳过`);
      completed.add(ck);
      saveProgress(completed);
      continue;
    }

    const withExtId = chapters.map((ch) => ({
      ...ch,
      externalId: `scys-manual-${act.id}-${ch.itemId}`,
    }));
    const existingIds = findExistingArchivedIds(withExtId.map((c) => c.externalId));
    const pending = withExtId.filter((c) => !existingIds.has(c.externalId));

    console.log(
      `[manuals] ${act.name}: 总章节=${withExtId.length} 已存在完整归档=${existingIds.size} 待抓取=${pending.length}`,
    );

    const rawItems: RawItem[] = [];
    if (pending.length) {
      let cursor = 0;
      const results = new Array<RawItem | null>(pending.length).fill(null);

      await Promise.all(
        Array.from({ length: Math.min(slotCount, pending.length) }, async () => {
          while (cursor < pending.length) {
            const idx = cursor;
            cursor += 1;
            const ch = pending[idx]!;
            try {
              const detail = await fetchFullChapterMarkdown(client, String(act.id), String(ch.itemId));
              const fullTitle = cleanText(
                ch.section ? `【${act.name} · ${ch.section}】${detail.title || ch.title}` : `【${act.name}】${detail.title || ch.title}`,
                140,
              );
              const content = detail.content || null;
              results[idx] = {
                externalId: ch.externalId,
                url: `https://scys.com/activity/detail/${encodeURIComponent(act.id)}?itemId=${encodeURIComponent(ch.itemId)}`,
                title: fullTitle,
                summary: cleanText(detail.content, 380),
                content,
                author: null,
                publishedAt: act.publishedAt,
                tags: ["航海手册", act.name.slice(0, 24)],
                categoryHint: "course",
                kindHint: "info",
                raw: { activityId: act.id, activityName: act.name, itemId: ch.itemId },
              };
            } catch (err) {
              console.warn(
                `[manuals] 章节抓取失败 (${act.id}/${ch.itemId} ${ch.title}): ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }),
      );

      for (const r of results) {
        if (r) rawItems.push(r);
      }
    }

    let inserted = 0;
    let skipped = 0;
    if (rawItems.length) {
      saveAiSettings({ ...origAi, enabled: false });
      try {
        const saved = ingestItems("scys-manuals", rawItems);
        inserted = saved.inserted;
        skipped = saved.skipped;
      } finally {
        saveAiSettings(origAi);
      }

      if (aiConfigured) {
        saveAiSettings({
          ...origAi,
          enabled: true,
          model: opts.model,
          ...(isXhigh ? { batchSize: 2, concurrency: 6, timeoutSec: 120 } : {}),
        });
        try {
          const aiOut = await backfillAi(Math.max(rawItems.length * 2, 100), "pending");
          console.log(
            `[manuals] ${act.name} 落库新增=${inserted} 跳过=${skipped} | AI审核=${aiOut.reviewed} 保留=${aiOut.reviewed - aiOut.rejected} 拦截=${aiOut.rejected}`,
          );
        } finally {
          saveAiSettings(origAi);
        }
      } else {
        console.log(`[manuals] ${act.name} 落库新增=${inserted} 跳过=${skipped} (AI未配置，跳过脱水)`);
      }
    }

    completed.add(ck);
    saveProgress(completed);
  }

  console.log("\n[manuals] 历期航海手册抓取任务完成！");
}

main().catch((err) => {
  console.error(`[manuals] 错误: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
