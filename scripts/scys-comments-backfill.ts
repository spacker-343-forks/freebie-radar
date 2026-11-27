import { ensureSources } from "../src/server/collectors/index.ts";
import {
  ensureScysCommentSyncTable,
  extractScysTopicIdentity,
  fetchScysTopicCommentCandidates,
  recordScysCommentSync,
  renderDistilledScysComments,
  replaceSnapshotComments,
  syncScysItemComments,
} from "../src/server/collectors/scys.ts";
import { all, closeDb, migrate, run, tx } from "../src/server/db.ts";
import { aiReady, getAiSettings, resolveCommentModel } from "../src/server/enrich/ai-settings.ts";
import { distillCommentPostsWithAi, type DistillableComment } from "../src/server/scys/comment-ai.ts";
import { ScysAuthError, ScysMcpClient, type McpToolSchema } from "../src/server/scys/mcp-client.ts";

type Scope = "active" | "kept" | "all";

type CandidateRow = {
  id: number;
  title: string;
  external_id: string;
  url: string;
  summary: string | null;
  content: string | null;
  author: string | null;
  raw: string | null;
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
  const reclean = argv.includes("--reclean");
  const scopeRaw = (readArgValue(argv, "--scope") ?? (reclean ? "all" : "active")).trim();
  const scope: Scope = scopeRaw === "kept" || scopeRaw === "all" ? scopeRaw : "active";

  const limitRaw = readArgValue(argv, "--limit");
  const limit =
    limitRaw && Number.isFinite(Number(limitRaw)) && Number(limitRaw) > 0
      ? Math.round(Number(limitRaw))
      : 0;

  const idRaw = readArgValue(argv, "--id");
  const targetId =
    idRaw && Number.isFinite(Number(idRaw)) && Number(idRaw) > 0 ? Math.round(Number(idRaw)) : 0;

  const concRaw = Number(readArgValue(argv, "--concurrency") ?? 3);
  const concurrency = Number.isFinite(concRaw) ? Math.min(Math.max(Math.round(concRaw), 1), 24) : 3;

  const intervalRaw = Number(readArgValue(argv, "--interval-ms") ?? 550);
  const intervalMs = Number.isFinite(intervalRaw) ? Math.min(Math.max(Math.round(intervalRaw), 0), 10_000) : 550;

  const model = readArgValue(argv, "--model")?.trim() || undefined;
  const force = argv.includes("--force");
  const skipAi = argv.includes("--no-ai");
  return { scope, limit, targetId, concurrency, intervalMs, model, force, reclean, skipAi };
}

async function main(): Promise<void> {
  migrate();
  ensureSources();
  ensureScysCommentSyncTable();

  const opts = parseOptions(process.argv.slice(2));
  const aiSettings = getAiSettings();
  const effectiveModel = opts.model || resolveCommentModel(aiSettings);
  const aiActive = !opts.skipAi && aiReady({ ...aiSettings, model: effectiveModel });

  const probeClient = new ScysMcpClient({ minIntervalMs: opts.intervalMs });
  const slotCount = Math.max(1, probeClient.getSlotCount());
  const perSlotConcurrency = Math.max(1, Math.ceil(opts.concurrency / slotCount));

  const client = new ScysMcpClient({
    minIntervalMs: opts.intervalMs,
    maxConcurrencyPerSlot: perSlotConcurrency,
    maxRetries: 5,
  });

  let schemas: McpToolSchema[] = [];
  try {
    schemas = await client.getToolSchemas();
  } catch (err) {
    if (err instanceof ScysAuthError) throw err;
    console.warn(`[scys:comments] 获取 tools/list 提示: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (opts.targetId > 0) {
    const res = await syncScysItemComments(opts.targetId, {
      client,
      schemas,
      aiSettings,
      aiModel: opts.model,
      skipAi: opts.skipAi,
    });
    console.log(
      `[scys:comments] 单帖同步完成 id=${res.itemId} 《${res.title.slice(0, 36)}》: 原帖评论=${res.totalComments}, 规则候选=${res.ruleCandidatesCount}, AI精选入库=${res.keptComments} (model=${aiActive ? effectiveModel : "off"})`,
    );
    return;
  }

  const scopeClause =
    opts.scope === "kept"
      ? "AND i.ai_keep = 1"
      : opts.scope === "active"
        ? "AND i.status = 'active' AND (i.ai_keep = 1 OR i.ai_keep IS NULL)"
        : "";
  const syncFilterClause = opts.reclean
    ? "AND cs.external_id IS NOT NULL"
    : opts.force
      ? ""
      : "AND cs.external_id IS NULL";
  const limitClause = opts.limit > 0 ? `LIMIT ${opts.limit}` : "";

  const candidates = all<CandidateRow>(
    `SELECT i.id, i.title, i.external_id, i.url, i.summary, i.content, i.author, i.raw
       FROM items i
       LEFT JOIN scys_comment_sync cs ON cs.external_id = i.external_id
      WHERE i.external_id LIKE 'scys-topic-%'
        ${scopeClause}
        ${syncFilterClause}
        AND COALESCE(
              CAST(json_extract(i.raw, '$.topicDTO.commentsCount') AS INTEGER),
              CAST(json_extract(i.raw, '$.commentsCount') AS INTEGER),
              -1
            ) != 0
      ORDER BY COALESCE(i.ai_quality, 0) DESC, i.score DESC, i.id DESC
      ${limitClause}`,
  );

  if (!candidates.length) {
    console.log("[scys:comments] 没有需要补抓评论的候选生财帖子（可加 --reclean 重洗已同步帖，或 --force 重新拉取）");
    return;
  }

  const workerCount = Math.min(opts.concurrency, candidates.length);
  console.log(
    `[scys:comments] 启动两级评论脱水补抓: 候选=${candidates.length} 篇 | scope=${opts.reclean ? "reclean" : opts.scope} | AI模型=${aiActive ? effectiveModel : "关闭(仅规则)"} | 槽位数=${slotCount} | 并发=${workerCount} (间隔=${opts.intervalMs}ms)`,
  );

  const startedAt = Date.now();
  const waveSize = 18;
  let done = 0;
  let withKept = 0;
  let emptyOrFiltered = 0;
  let failed = 0;
  let totalRuleCandidates = 0;
  let totalKeptLines = 0;

  type FetchedWaveItem = {
    row: CandidateRow;
    total: number;
    candidates: DistillableComment[];
  };

  // Overlap Wave N+1 MCP fetching with Wave N AI distillation & DB write
  const fetchWave = async (slice: CandidateRow[]): Promise<FetchedWaveItem[]> => {
    const out: Array<FetchedWaveItem | null> = new Array(slice.length).fill(null);
    let cursor = 0;
    let fatalAuthErr: Error | null = null;

    await Promise.all(
      Array.from({ length: Math.min(workerCount, slice.length) }, async () => {
        while (cursor < slice.length && !fatalAuthErr) {
          const idx = cursor;
          cursor += 1;
          const row = slice[idx]!;
          try {
            // If post lacks body snapshot, fall back to full syncScysItemComments for that row
            if (!(row.content ?? "").trim()) {
              const full = await syncScysItemComments(row.id, {
                client,
                schemas,
                aiSettings,
                aiModel: opts.model,
                skipAi: opts.skipAi,
              });
              done += 1;
              totalRuleCandidates += full.ruleCandidatesCount;
              if (full.keptComments > 0) {
                withKept += 1;
                totalKeptLines += full.keptComments;
              } else {
                emptyOrFiltered += 1;
              }
              continue;
            }

            const identity = extractScysTopicIdentity(row);
            if (!identity) {
              done += 1;
              emptyOrFiltered += 1;
              continue;
            }

            const cmRes = await fetchScysTopicCommentCandidates(client, schemas, {
              entityType: identity.entityType,
              entityId: identity.entityId,
              postAuthor: row.author,
              maxCandidates: 25,
            });
            out[idx] = { row, total: cmRes.total, candidates: cmRes.candidates };
          } catch (err) {
            if (err instanceof ScysAuthError) {
              fatalAuthErr = err;
              break;
            }
            done += 1;
            failed += 1;
            console.warn(
              `[scys:comments] 抓取失败 id=${row.id} (${row.title.slice(0, 22)}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }),
    );

    if (fatalAuthErr) throw fatalAuthErr;
    return out.filter((x): x is FetchedWaveItem => x !== null);
  };

  const distillAndPersistWave = async (fetched: FetchedWaveItem[]): Promise<void> => {
    if (!fetched.length) return;
    for (const f of fetched) totalRuleCandidates += f.candidates.length;

    const distilledLists = aiActive
      ? await distillCommentPostsWithAi(
          fetched.map((f) => ({ title: f.row.title, candidates: f.candidates })),
          {
            aiSettings,
            model: effectiveModel,
            batchSize: 6,
            concurrency: 3,
            log: (m) => console.warn(m),
          },
        )
      : fetched.map((f) => f.candidates);

    tx(() => {
      for (let i = 0; i < fetched.length; i += 1) {
        const f = fetched[i]!;
        const distilled = distilledLists[i] ?? f.candidates;
        const rendered = renderDistilledScysComments(distilled, 20);
        const updatedContent = replaceSnapshotComments(f.row.content ?? "", rendered.lines);
        if (updatedContent !== (f.row.content ?? "")) {
          run("UPDATE items SET content = ? WHERE id = ?", updatedContent, f.row.id);
        }
        recordScysCommentSync(f.row.external_id, f.total, rendered.keptCount);

        done += 1;
        if (rendered.keptCount > 0) {
          withKept += 1;
          totalKeptLines += rendered.keptCount;
        } else {
          emptyOrFiltered += 1;
        }
      }
    });

    const elapsedSec = Math.max(0.1, (Date.now() - startedAt) / 1000);
    const rate = (done / elapsedSec).toFixed(2);
    const pct = ((done / candidates.length) * 100).toFixed(1);
    const remainSec = Math.round((candidates.length - done) / Math.max(0.05, done / elapsedSec));
    console.log(
      `[scys:comments] 进度 ${done}/${candidates.length} (${pct}%) | 有精选评论帖=${withKept} (规则留${totalRuleCandidates}条->AI精选${totalKeptLines}条) | 全水评清零=${emptyOrFiltered} | 失败=${failed} | 速率=${rate}帖/秒 | 预计剩余=${remainSec}s`,
    );
  };

  const slices: CandidateRow[][] = [];
  for (let i = 0; i < candidates.length; i += waveSize) {
    slices.push(candidates.slice(i, i + waveSize));
  }

  let nextFetchPromise: Promise<FetchedWaveItem[]> | null = slices.length ? fetchWave(slices[0]!) : null;
  for (let w = 0; w < slices.length; w += 1) {
    const currentFetched = await nextFetchPromise!;
    if (w + 1 < slices.length) {
      nextFetchPromise = fetchWave(slices[w + 1]!);
      nextFetchPromise.catch(() => undefined);
    } else {
      nextFetchPromise = null;
    }
    await distillAndPersistWave(currentFetched);
  }

  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\n[scys:comments] 全部完成 (${totalSec}s): 处理=${done} 篇 | 有精选评论帖=${withKept} 篇 (规则预筛 ${totalRuleCandidates} 条 -> AI精选保留 ${totalKeptLines} 条) | 纯水评清零=${emptyOrFiltered} 篇 | 失败=${failed} 篇`,
  );
}

main()
  .catch((err) => {
    console.error(`[scys:comments] 错误: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
  });
