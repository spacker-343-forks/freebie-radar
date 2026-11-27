import { ensureSources } from "../src/server/collectors/index.ts";
import { migrate } from "../src/server/db.ts";
import { backfillDossiers, ensureDossierTable } from "../src/server/dossier.ts";
import { ensureTracksTable, synthesizeAllTracks } from "../src/server/tracks.ts";

function readArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1]!.startsWith("--")) {
    return args[idx + 1]!;
  }
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

function parseOptions(argv: string[]) {
  const hasTracksFlag = argv.includes("--tracks");
  const hasDossiersFlag = argv.includes("--dossiers");
  const runTracks = hasTracksFlag || !hasDossiersFlag;
  const runDossiers = hasDossiersFlag || !hasTracksFlag;

  const limitRaw = readArgValue(argv, "--limit");
  const maxDossiers = limitRaw && Number.isFinite(Number(limitRaw)) && Number(limitRaw) > 0
    ? Math.round(Number(limitRaw))
    : Infinity;

  const minQRaw = Number(readArgValue(argv, "--min-quality") ?? 4);
  const minQuality = Number.isFinite(minQRaw) ? Math.min(Math.max(Math.round(minQRaw), 1), 5) : 4;

  return { runTracks, runDossiers, maxDossiers, minQuality };
}

async function main(): Promise<void> {
  migrate();
  ensureSources();
  ensureDossierTable();
  ensureTracksTable();

  const opts = parseOptions(process.argv.slice(2));
  console.log(
    `[scys:burn] 启动高阶精炼: tracks=${opts.runTracks} | dossiers=${opts.runDossiers} | minQuality>=${opts.minQuality} | limit=${Number.isFinite(opts.maxDossiers) ? opts.maxDossiers : "all"}`,
  );

  if (opts.runTracks) {
    console.log("\n[scys:burn] === 阶段 1：跨帖赛道聚类与白皮书合成 ===");
    const tracks = await synthesizeAllTracks({ log: console.log });
    console.log(`[scys:burn] 赛道白皮书合成完毕，共生成 ${tracks.length} 个赛道`);
  }

  if (opts.runDossiers) {
    console.log(`\n[scys:burn] === 阶段 2：批量生成 >=${opts.minQuality} 星干货实战立项拆解书 ===`);
    let totalGenerated = 0;
    let totalFailed = 0;
    let batchNo = 0;

    while (totalGenerated + totalFailed < opts.maxDossiers) {
      batchNo += 1;
      const remaining = Number.isFinite(opts.maxDossiers)
        ? Math.min(100, opts.maxDossiers - (totalGenerated + totalFailed))
        : 100;
      if (remaining <= 0) break;

      const res = await backfillDossiers({
        minQuality: opts.minQuality,
        limit: remaining,
        concurrency: 4,
        log: console.log,
      });
      totalGenerated += res.generated;
      totalFailed += res.failed;
      console.log(
        `[scys:burn] 批次 #${batchNo}: 候选=${res.totalCandidates} 成功=${res.generated} 失败=${res.failed} | 累计成功=${totalGenerated}`,
      );
      if (res.totalCandidates === 0 || (res.generated === 0 && res.failed === res.totalCandidates)) {
        break;
      }
    }
    console.log(`[scys:burn] 立项拆解书任务完成: 总成功=${totalGenerated} 总失败=${totalFailed}`);
  }
}

main().catch((err) => {
  console.error(`[scys:burn] 错误: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
