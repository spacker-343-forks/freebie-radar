import { ensureSources } from "../src/server/collectors/index.ts";
import { migrate } from "../src/server/db.ts";
import {
  DEFAULT_CHAT_DISTILL_MODEL,
  distillChatGroupInsights,
  ensureChatRadarTables,
  getChatGroupsOverview,
  syncChatGroupMessages,
  syncChatGroupsCatalog,
} from "../src/server/chat-radar.ts";

function readArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1]!.startsWith("--")) {
    return args[idx + 1]!;
  }
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

function parseIntOpt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

function parseOptions(argv: string[]) {
  const hasDiscover = argv.includes("--discover");
  const hasSync = argv.includes("--sync");
  const hasDistill = argv.includes("--distill");
  const defaultSync = !hasDiscover && !hasSync && !hasDistill;

  return {
    discover: hasDiscover,
    sync: hasSync || defaultSync,
    distill: hasDistill,
    groupKey: readArgValue(argv, "--group")?.trim() || undefined,
    activityId: readArgValue(argv, "--activity")?.trim() || undefined,
    lookbackDays: parseIntOpt(readArgValue(argv, "--days"), 14, 1, 90),
    maxPagesPerGroup: parseIntOpt(readArgValue(argv, "--max-pages"), 10, 1, 50),
    concurrency: parseIntOpt(readArgValue(argv, "--concurrency"), 3, 1, 8),
    intervalMs: parseIntOpt(readArgValue(argv, "--interval-ms"), 550, 0, 10_000),
    model: readArgValue(argv, "--model")?.trim() || undefined,
    limitGroups: parseIntOpt(readArgValue(argv, "--limit-groups"), 12, 1, 100),
    minPendingMessages: parseIntOpt(readArgValue(argv, "--min-msgs"), 8, 1, 100),
  };
}

async function main(): Promise<void> {
  migrate();
  ensureSources();
  ensureChatRadarTables();

  const opts = parseOptions(process.argv.slice(2));

  if (opts.discover) {
    console.log("[scys-chats] === 同步生财微信群目录并挂载航海手册 ===");
    const cat = await syncChatGroupsCatalog({ log: console.log });
    const overview = getChatGroupsOverview({ tier: "voyage" });
    const linked = overview.groups.filter((g) => Boolean(g.linkedActivityId));
    console.log(
      `[scys-chats] 目录汇总: 总计=${cat.total} | core=${cat.core} | voyage=${cat.voyage} | regional=${cat.regional} | 默认启用=${cat.enabled} | 新增=${cat.inserted} 更新=${cat.updated}`,
    );
    console.log(`[scys-chats] 航海手册挂载: ${linked.length}/${overview.groups.length} 个航海群已关联 activityId`);
    for (const g of linked.slice(0, 15)) {
      console.log(`  - ${g.name} -> [${g.linkedActivityId}] ${g.linkedBookTitle ?? "(未找到手册标题)"}`);
    }
    if (linked.length > 15) {
      console.log(`  ... 其余 ${linked.length - 15} 个已挂载航海群省略`);
    }
  }

  if (opts.sync) {
    console.log(
      `[scys-chats] === 增量同步群消息: group=${opts.groupKey ?? "all-enabled"} activity=${opts.activityId ?? "all"} days=${opts.lookbackDays} maxPages=${opts.maxPagesPerGroup} concurrency=${opts.concurrency} intervalMs=${opts.intervalMs} ===`,
    );
    const res = await syncChatGroupMessages({
      groupKey: opts.groupKey,
      activityId: opts.activityId,
      lookbackDays: opts.lookbackDays,
      maxPagesPerGroup: opts.maxPagesPerGroup,
      concurrency: opts.concurrency,
      intervalMs: opts.intervalMs,
      log: console.log,
    });
    console.log(
      `[scys-chats] 同步完成: 目标群=${res.groupsTargeted} 成功=${res.groupsSynced} 拉取=${res.fetchedMessages} 新增=${res.insertedMessages} (有效=${res.validInsertedMessages}) 失败=${res.errors.length}`,
    );
    for (const err of res.errors) {
      console.error(`  [ERR] ${err.groupName} (${err.groupKey}): ${err.error}`);
    }
  }

  if (opts.distill) {
    const model = opts.model || DEFAULT_CHAT_DISTILL_MODEL;
    console.log(
      `[scys-chats] === AI 群聊干货提纯: model=${model} group=${opts.groupKey ?? "all-enabled"} activity=${opts.activityId ?? "all"} limitGroups=${opts.limitGroups} minMsgs=${opts.minPendingMessages} ===`,
    );
    const res = await distillChatGroupInsights({
      groupKey: opts.groupKey,
      activityId: opts.activityId,
      model,
      limitGroups: opts.limitGroups,
      minPendingMessages: opts.minPendingMessages,
      log: console.log,
    });
    console.log(
      `[scys-chats] 提纯完成: 候选群=${res.groupsCandidate} 已处理=${res.groupsProcessed} 成功=${res.groupsSucceeded} 产出洞察=${res.digestsCreated} 失败=${res.errors.length}`,
    );
    for (const err of res.errors) {
      console.error(`  [ERR] ${err.groupName} (${err.groupKey}): ${err.error}`);
    }
  }
}

main().catch((err) => {
  console.error(`[scys-chats] 错误: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
