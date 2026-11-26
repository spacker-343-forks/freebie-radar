import { backfillAi } from "../src/server/ai-admin.ts";
import { ensureSources, ingestItems } from "../src/server/collectors/index.ts";
import { scysCollector, type ScysMode } from "../src/server/collectors/scys.ts";
import { get, migrate, run } from "../src/server/db.ts";
import { aiReady, getAiSettings, parseModelSpec, saveAiSettings } from "../src/server/enrich/ai-settings.ts";
import { createHttp } from "../src/server/http.ts";

const PROGRESS_KEY = "scys_backfill_progress";

type SectionTarget = {
  key: string;
  sourceId: string;
  mode: ScysMode;
  pageScene?: string;
};

const SECTION_MAP: Record<string, Omit<SectionTarget, "key">> = {
  good: { sourceId: "scys-highlights", mode: "highlights", pageScene: "good" },
  fxb: { sourceId: "scys-highlights", mode: "highlights", pageScene: "fxb" },
  winBid: { sourceId: "scys-highlights", mode: "highlights", pageScene: "winBid" },
  projects: { sourceId: "scys-projects", mode: "projects" },
  topic: { sourceId: "scys-latest", mode: "latest", pageScene: "topic" },
  square: { sourceId: "scys-latest", mode: "latest", pageScene: "square" },
  manuals: { sourceId: "scys-manuals", mode: "manuals" },
};

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

function parseBackfillOptions(argv: string[]) {
  const pagesRaw = Number(readArgValue(argv, "--pages") ?? 6);
  const pages = Number.isFinite(pagesRaw) ? Math.min(Math.max(Math.round(pagesRaw), 1), 100) : 6;

  const pageSizeRaw = Number(readArgValue(argv, "--page-size") ?? 25);
  const pageSize = Number.isFinite(pageSizeRaw) ? Math.min(Math.max(Math.round(pageSizeRaw), 1), 50) : 25;

  const sectionsCsv = readArgValue(argv, "--sections") ?? "good,fxb,projects,winBid,topic";
  const sectionKeys = sectionsCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!sectionKeys.length) {
    throw new Error("--sections 不能为空");
  }
  const sections: SectionTarget[] = sectionKeys.map((key) => {
    const spec = SECTION_MAP[key];
    if (!spec) {
      throw new Error(`未知分区 "${key}"，支持: ${Object.keys(SECTION_MAP).join(", ")}`);
    }
    return { key, ...spec };
  });

  const model = (readArgValue(argv, "--model") ?? "gpt-6.1-terra:xhigh").trim() || "gpt-6.1-terra:xhigh";
  const reset = argv.includes("--reset");
  return { pages, pageSize, sections, model, reset };
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
  const payload: ProgressState = { completed: [...completed], updatedAt: now };
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    PROGRESS_KEY,
    JSON.stringify(payload),
    now,
  );
}

function clearProgress(): void {
  run("DELETE FROM settings WHERE key = ?", PROGRESS_KEY);
}

async function main(): Promise<void> {
  migrate();
  ensureSources();

  const opts = parseBackfillOptions(process.argv.slice(2));
  if (opts.reset) {
    clearProgress();
    console.log("[backfill] 已重置断点进度 (settings.scys_backfill_progress)");
  }

  const completed = loadProgress();
  const origAi = getAiSettings();
  const parsedModel = parseModelSpec(opts.model);
  const isXhigh = parsedModel.reasoningEffort === "xhigh";
  const aiConfigured = aiReady({ ...origAi, enabled: true, model: opts.model });
  const http = createHttp({ gapMs: 0 });

  console.log(
    `[backfill] 启动回溯: sections=${opts.sections.map((s) => s.key).join(",")} | pages=${opts.pages} | pageSize=${opts.pageSize} | model=${opts.model}${isXhigh ? " (xhigh: batchSize=2, concurrency=6, timeoutSec=120)" : ""}`,
  );
  if (!aiConfigured) {
    console.warn("[backfill] 警告: 当前未配置 AI baseUrl/apiKey，本轮仅抓取落库，跳过 AI 脱水审核。");
  }

  let totalFetched = 0;
  let totalInserted = 0;
  let totalReviewed = 0;
  let totalKept = 0;
  let totalRejected = 0;

  for (const section of opts.sections) {
    console.log(`\n[backfill] === 开始分区 ${section.key} -> ${section.sourceId} (mode=${section.mode}) ===`);
    for (let page = 1; page <= opts.pages; page += 1) {
      const ck = `${section.key}:${page}`;
      if (completed.has(ck)) {
        console.log(`[backfill] 跳过已完成断点 ${ck}`);
        continue;
      }

      const collected = await scysCollector.collect({
        sourceId: section.sourceId,
        config: {
          mode: section.mode,
          ...(section.pageScene ? { pageScene: section.pageScene } : {}),
          pageIndex: page,
          pageSize: opts.pageSize,
          fetchDetail: true,
          maxDetailPerRun: opts.pageSize,
        },
        cursor: null,
        maxItems: opts.pageSize,
        http,
        log: (m) => console.log(`[${section.key}:p${page}] ${m}`),
      });

      if (!collected.items.length) {
        console.log(`[backfill] ${ck} 返回 0 条，结束分区 ${section.key} 翻页`);
        completed.add(ck);
        saveProgress(completed);
        break;
      }

      // 暂时关闭自动后台 AI/推送派发，由下方 backfillAi 同步控批审核并实时可见
      let saved: { inserted: number; skipped: number };
      saveAiSettings({ ...origAi, enabled: false });
      try {
        saved = ingestItems(section.sourceId, collected.items);
      } finally {
        saveAiSettings(origAi);
      }

      let reviewed = 0;
      let kept = 0;
      let rejected = 0;
      if (aiConfigured) {
        saveAiSettings({
          ...origAi,
          enabled: true,
          model: opts.model,
          ...(isXhigh ? { batchSize: 2, concurrency: 6, timeoutSec: 120 } : {}),
        });
        try {
          const aiOut = await backfillAi(Math.max(opts.pageSize * 2, 100), "pending");
          reviewed = aiOut.reviewed;
          rejected = aiOut.rejected;
          kept = Math.max(0, aiOut.reviewed - aiOut.rejected);
          if (aiOut.error) {
            console.warn(`[backfill] ${ck} AI 审核提示: ${aiOut.error}`);
          }
        } finally {
          saveAiSettings(origAi);
        }
      }

      totalFetched += collected.items.length;
      totalInserted += saved.inserted;
      totalReviewed += reviewed;
      totalKept += kept;
      totalRejected += rejected;

      completed.add(ck);
      saveProgress(completed);

      console.log(
        `[backfill] [${section.key} p${page}/${opts.pages}] 已抓=${collected.items.length} 新增=${saved.inserted} 跳过=${saved.skipped} | AI审核=${reviewed} 保留=${kept} 拦截=${rejected}`,
      );
    }
  }

  console.log(
    `\n[backfill] 全部完成: 总抓取=${totalFetched} 总新增=${totalInserted} | AI总审核=${totalReviewed} 总保留=${totalKept} 总拦截=${totalRejected}`,
  );
}

main().catch((err) => {
  console.error(`[backfill] 错误: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
