import { ensureSources, ingestItems } from "../src/server/collectors/index.ts";
import { scysAiFeedCollector } from "../src/server/collectors/scys-ai-feed.ts";
import { get, migrate, run } from "../src/server/db.ts";
import { createHttp } from "../src/server/http.ts";
import {
  backfillScysDailyReports,
  ensureScysOfficialReportTable,
  syncScysDailyReport,
} from "../src/server/scys-official-report.ts";

function readArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1]!.startsWith("--")) {
    return args[idx + 1]!;
  }
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

function parseOptions(argv: string[]) {
  const daysRaw = Number(readArgValue(argv, "--days") ?? 14);
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(Math.round(daysRaw), 0), 29) : 14;
  const date = readArgValue(argv, "--date")?.trim();
  const editionRaw = readArgValue(argv, "--edition")?.trim().toUpperCase();
  const edition: "DAILY" | "WEEKEND" | undefined =
    editionRaw === "DAILY" || editionRaw === "WEEKEND" ? editionRaw : undefined;
  const force = argv.includes("--force");
  const aiFeed = argv.includes("--ai-feed");
  const limitRaw = Number(readArgValue(argv, "--limit") ?? 30);
  const aiFeedLimit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.round(limitRaw), 1), 50) : 30;
  return { days, date, edition, force, aiFeed, aiFeedLimit };
}

async function main(): Promise<void> {
  migrate();
  ensureSources();
  ensureScysOfficialReportTable();

  const opts = parseOptions(process.argv.slice(2));

  if (opts.date) {
    console.log(`[scys-reports] 同步指定日期官方内参: ${opts.date} (force=${opts.force})`);
    const detail = await syncScysDailyReport({
      reportDate: opts.date,
      edition: opts.edition,
      force: opts.force,
    });
    console.log(
      `[scys-reports] 完成: ${detail.reportDate} (${detail.edition}) | ${detail.title} | 信号=${detail.signalCount} 精华=${detail.highlightCount}`,
    );
  } else {
    console.log(`[scys-reports] 启动官方内参回补: days=${opts.days} | force=${opts.force}`);
    const summary = await backfillScysDailyReports({
      days: opts.days,
      force: opts.force,
      log: console.log,
    });
    console.log(
      `[scys-reports] 官方内参回补完成: 新增/更新=${summary.synced} 跳过=${summary.skipped} 失败=${summary.failed} | 最新日期=${summary.latestDate ?? "无"}`,
    );
  }

  if (opts.aiFeed) {
    console.log(`\n[scys-reports] === 同步官方 AI 情报流 (limit=${opts.aiFeedLimit}) ===`);
    const existing = get<{ id: string }>("SELECT id FROM sources WHERE id = ?", "scys-ai-feed");
    if (!existing) {
      run(
        `INSERT OR IGNORE INTO sources (id, name, kind, enabled, config, interval_sec, created_at)
         VALUES (?, ?, ?, 1, ?, 3600, ?)`,
        "scys-ai-feed",
        "生财有术 · 官方 AI 情报流",
        "scys-ai-feed",
        JSON.stringify({ limit: opts.aiFeedLimit }),
        new Date().toISOString(),
      );
    }
    const collected = await scysAiFeedCollector.collect({
      sourceId: "scys-ai-feed",
      config: { limit: opts.aiFeedLimit },
      cursor: null,
      maxItems: opts.aiFeedLimit,
      http: createHttp({ gapMs: 0 }),
      log: (m) => console.log(`[scys-ai-feed] ${m}`),
    });
    const saved = ingestItems("scys-ai-feed", collected.items);
    console.log(
      `[scys-reports] 官方 AI 情报流完成: 抓取=${collected.items.length} 新增=${saved.inserted} 跳过=${saved.skipped}`,
    );
  }
}

main().catch((err) => {
  console.error(`[scys-reports] 错误: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
