import { backfillAi } from "../src/server/ai-admin.ts";
import { ensureSources, ingestItems } from "../src/server/collectors/index.ts";
import {
  DEFAULT_TRUSTED_SOURCE_TYPES,
  scysTrustedCollector,
  type ScysTrustedSourceType,
} from "../src/server/collectors/scys-trusted.ts";
import { get, migrate, run } from "../src/server/db.ts";
import { aiReady, getAiSettings, parseModelSpec, saveAiSettings } from "../src/server/enrich/ai-settings.ts";
import { createHttp } from "../src/server/http.ts";
import { getRetention, saveRetention } from "../src/server/retention.ts";

const PROGRESS_KEY = "scys_trusted_backfill_progress";
const SOURCE_ID = "scys-trusted";
const VALID_TYPES = new Set<ScysTrustedSourceType>(DEFAULT_TRUSTED_SOURCE_TYPES);
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

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
  const typesCsv =
    readArgValue(argv, "--source-types") ??
    readArgValue(argv, "--source-type") ??
    DEFAULT_TRUSTED_SOURCE_TYPES.join(",");
  const rawTypes = typesCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!rawTypes.length) {
    throw new Error("--source-types 不能为空");
  }
  const sourceTypes: ScysTrustedSourceType[] = [];
  for (const t of rawTypes) {
    if (!VALID_TYPES.has(t as ScysTrustedSourceType)) {
      throw new Error(`未知 sourceType "${t}"，支持: ${DEFAULT_TRUSTED_SOURCE_TYPES.join(", ")}`);
    }
    if (!sourceTypes.includes(t as ScysTrustedSourceType)) {
      sourceTypes.push(t as ScysTrustedSourceType);
    }
  }

  const account = readArgValue(argv, "--account")?.trim() || undefined;
  const month = readArgValue(argv, "--month")?.trim() || undefined;
  if (month && !MONTH_RE.test(month)) {
    throw new Error(`--month 格式必须为 YYYY-MM（如 2026-11），收到: ${month}`);
  }
  const keyword = readArgValue(argv, "--keyword")?.trim() || undefined;

  const pagesRaw = Number(readArgValue(argv, "--pages") ?? 5);
  const pages = Number.isFinite(pagesRaw) ? Math.min(Math.max(Math.round(pagesRaw), 1), 100) : 5;

  const pageSizeRaw = Number(readArgValue(argv, "--page-size") ?? 20);
  const pageSize = Number.isFinite(pageSizeRaw) ? Math.min(Math.max(Math.round(pageSizeRaw), 1), 20) : 20;

  const model = readArgValue(argv, "--model")?.trim() || undefined;
  const noAi = argv.includes("--no-ai");
  const reset = argv.includes("--reset");

  return { sourceTypes, account, month, keyword, pages, pageSize, model, noAi, reset };
}

function loadProgress(): Set<string> {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", PROGRESS_KEY);
  if (!row?.value) return new Set();
  try {
    const parsed = JSON.parse(row.value) as Partial<ProgressState>;
    return new Set(
      Array.isArray(parsed.completed) ? parsed.completed.filter((x): x is string => typeof x === "string") : [],
    );
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

function ensureTrustedSourceRow(): void {
  const existing = get<{ id: string }>("SELECT id FROM sources WHERE id = ?", SOURCE_ID);
  if (existing) return;
  run(
    `INSERT OR IGNORE INTO sources (id, name, kind, enabled, config, interval_sec, created_at)
     VALUES (?, ?, ?, 1, ?, 3600, ?)`,
    SOURCE_ID,
    "生财有术 · 大佬公众号/推文/群聊精华",
    "scys-trusted",
    JSON.stringify({ pageSize: 15, fetchDetail: true, maxDetailPerRun: 12 }),
    new Date().toISOString(),
  );
}

async function main(): Promise<void> {
  migrate();
  ensureSources();
  ensureTrustedSourceRow();

  const curRetention = getRetention();
  if (curRetention.keptDays <= 180) {
    saveRetention({ itemDays: 3650, keptDays: 3650, auto: false });
    console.log(
      "[trusted-backfill] 已将内容保留期升级为 10 年长期归档（itemDays=3650, keptDays=3650, auto=false）",
    );
  }

  const opts = parseOptions(process.argv.slice(2));
  if (opts.reset) {
    clearProgress();
    console.log(`[trusted-backfill] 已重置断点进度 (settings.${PROGRESS_KEY})`);
  }

  const completed = loadProgress();
  const origAi = getAiSettings();
  const effectiveModel = opts.model || origAi.model || "gpt-6.2-sol:high";
  const parsedModel = parseModelSpec(effectiveModel);
  const isXhigh = parsedModel.reasoningEffort === "xhigh";
  const aiConfigured = !opts.noAi && aiReady({ ...origAi, enabled: true, model: effectiveModel });
  const http = createHttp({ gapMs: 0 });

  console.log(
    `[trusted-backfill] 启动回溯: sourceTypes=${opts.sourceTypes.join(",")} | pages=${opts.pages} | pageSize=${opts.pageSize}` +
      `${opts.account ? ` | account=${opts.account}` : ""}` +
      `${opts.month ? ` | month=${opts.month}` : ""}` +
      `${opts.noAi ? " | ai=off" : ` | model=${effectiveModel}`}`,
  );
  if (!opts.noAi && !aiConfigured) {
    console.warn("[trusted-backfill] 警告: 当前未配置 AI baseUrl/apiKey，本轮仅抓取落库，跳过 AI 审核。");
  }

  let totalFetched = 0;
  let totalInserted = 0;
  let totalReviewed = 0;
  let totalKept = 0;
  let totalRejected = 0;

  for (const sourceType of opts.sourceTypes) {
    if (opts.account && sourceType === "navigator_chat_highlight") {
      console.log("[trusted-backfill] account 过滤不适用于 navigator_chat_highlight，已自动跳过该类型");
      continue;
    }

    console.log(`\n[trusted-backfill] === 开始来源类型 ${sourceType} -> ${SOURCE_ID} ===`);
    for (let page = 1; page <= opts.pages; page += 1) {
      const ck = `${sourceType}:${opts.month || "*"}:${opts.account || "*"}:${opts.keyword || "*"}:${page}`;
      if (completed.has(ck)) {
        console.log(`[trusted-backfill] 跳过已完成断点 ${ck}`);
        continue;
      }

      const collected = await scysTrustedCollector.collect({
        sourceId: SOURCE_ID,
        config: {
          sourceTypes: [sourceType],
          ...(opts.account ? { accountKey: opts.account } : {}),
          ...(opts.month ? { month: opts.month } : {}),
          ...(opts.keyword ? { keyword: opts.keyword } : {}),
          pageIndex: page,
          pageSize: opts.pageSize,
          fetchDetail: true,
          maxDetailPerRun: opts.pageSize,
        },
        cursor: null,
        maxItems: opts.pageSize,
        http,
        log: (m) => console.log(`[${sourceType}:p${page}] ${m}`),
      });

      if (!collected.items.length) {
        console.log(
          `[trusted-backfill] ${ck} 返回 0 条${collected.degraded ? ` (${collected.degraded})` : ""}，结束 ${sourceType} 翻页`,
        );
        completed.add(ck);
        saveProgress(completed);
        break;
      }

      let saved: { inserted: number; skipped: number };
      saveAiSettings({ ...origAi, enabled: false });
      try {
        saved = ingestItems(SOURCE_ID, collected.items);
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
          model: effectiveModel,
          ...(isXhigh ? { batchSize: 2, concurrency: 6, timeoutSec: 120 } : {}),
        });
        try {
          const aiOut = await backfillAi(Math.max(opts.pageSize * 2, 100), "pending");
          reviewed = aiOut.reviewed;
          rejected = aiOut.rejected;
          kept = Math.max(0, aiOut.reviewed - aiOut.rejected);
          if (aiOut.error) {
            console.warn(`[trusted-backfill] ${ck} AI 审核提示: ${aiOut.error}`);
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
        `[trusted-backfill] [${sourceType} p${page}/${opts.pages}] 已抓=${collected.items.length} 新增=${saved.inserted} 跳过=${saved.skipped}` +
          `${aiConfigured ? ` | AI审核=${reviewed} 保留=${kept} 拦截=${rejected}` : ""}`,
      );
    }
  }

  console.log(
    `\n[trusted-backfill] 全部完成: 总抓取=${totalFetched} 总新增=${totalInserted}` +
      `${aiConfigured ? ` | AI总审核=${totalReviewed} 总保留=${totalKept} 总拦截=${totalRejected}` : ""}`,
  );
}

main().catch((err) => {
  console.error(`[trusted-backfill] 错误: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
