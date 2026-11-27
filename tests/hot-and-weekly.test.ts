import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Hono } from "hono";

// 测试要可重复：不读本机 .env 的站点模式、管理令牌与 AI/推送开关（否则本机配了 .env 会影响结果或发外网）
Object.assign(process.env, {
  DATABASE_PATH: ":memory:",
  SITE_MODE: "selfhost",
  ADMIN_TOKEN: "",
  AI_BASE_URL: "",
  AI_MODEL: "",
  AI_API_KEY: "",
  AI_FALLBACK_BASE_URL: "",
  AI_FALLBACK_API_KEY: "",
  AI_FALLBACK_MODEL: "",
  AI_DEEP_MODEL: "",
  PUSH_CHANNEL: "none",
  ENABLE_SCHEDULER: "false",
});

const { migrate, run, get, closeDb } = await import("../src/server/db.ts");
const { ensureSources } = await import("../src/server/collectors/index.ts");
const { registerApi } = await import("../src/server/routes.ts");
const { buildHotReport, sourceQuality } = await import("../src/server/hot.ts");
const { lastDigests, pickDaily, runDaily, runWeekly, weekKey } = await import("../src/server/digest.ts");
const { saveAiSettings } = await import("../src/server/enrich/ai-settings.ts");

const app = new Hono();

before(() => {
  migrate();
  ensureSources();
  registerApi(app);
});

after(() => {
  closeDb();
});

let seq = 0;
function insertItem(opts: {
  sourceId: string;
  title: string;
  category?: string;
  kind?: string;
  score?: number;
  aiKeep?: number | null;
  aiQuality?: number | null;
  publishedAt: string;
  pushedAt?: string | null;
  titleKey?: string;
}) {
  seq += 1;
  run(
    `INSERT INTO items (source_id, external_id, url, url_key, title, title_key, category, kind, score,
                        ai_keep, ai_quality, published_at, pushed_at, status, is_free, obtain, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, 'free', ?, ?)`,
    opts.sourceId,
    "hw-" + seq,
    "https://example.com/hw/" + seq,
    "example/hw/" + seq,
    opts.title,
    opts.titleKey ?? "tk-hw-" + seq,
    opts.category ?? "ai",
    opts.kind ?? "freebie",
    opts.score ?? 80,
    opts.aiKeep === undefined ? 1 : opts.aiKeep,
    opts.aiQuality === undefined ? 4 : opts.aiQuality,
    opts.publishedAt,
    opts.pushedAt ?? null,
    opts.publishedAt,
    opts.publishedAt,
  );
  return (get<{ id: number }>("SELECT last_insert_rowid() AS id") as { id: number }).id;
}

test("buildHotReport & /api/hot：排除当前窗口 0 次词，正确统计 delta 与 top 排序", async () => {
  run("DELETE FROM items");
  const now = Date.now();
  const cur1 = new Date(now - 2 * 3_600_000).toISOString();
  const cur2 = new Date(now - 3 * 3_600_000).toISOString();
  const prev1 = new Date(now - 30 * 3_600_000).toISOString();
  const prev2 = new Date(now - 32 * 3_600_000).toISOString();

  // 当前窗口热词：Claude x2；上一窗口热词（当前 0 次）：OpenAI x2（不应出现在当前词云）
  insertItem({ sourceId: "linuxdo-welfare", title: "Claude Pro 免费额度领取", category: "ai", score: 85, aiQuality: 5, publishedAt: cur1 });
  insertItem({ sourceId: "v2ex-free", title: "Claude API 开发者新福利", category: "ai", score: 75, aiQuality: 3, publishedAt: cur2 });
  insertItem({ sourceId: "linuxdo-welfare", title: "OpenAI 旧期福利回顾", category: "ai", score: 70, aiQuality: 3, publishedAt: prev1 });
  insertItem({ sourceId: "v2ex-free", title: "OpenAI 上期测试额度", category: "ai", score: 70, aiQuality: 3, publishedAt: prev2 });

  const report = buildHotReport(24);
  assert.equal(report.scanned, 2);
  assert.equal(report.prevScanned, 2);
  assert.ok(report.words.some((w) => w.w === "claude" && w.n === 2 && w.prev === 0 && w.delta === 2));
  assert.ok(!report.words.some((w) => w.w === "openai"), "当前窗口出现 0 次的词不应进入词云");
  assert.equal(report.top[0]?.quality, 5);

  const res = await app.request("/api/hot?hours=24");
  assert.equal(res.status, 200);
  const json = (await res.json()) as { scanned: number; words: { w: string }[] };
  assert.equal(json.scanned, 2);
});

test("sourceQuality & /api/source-quality：准确统计留存率与平均质量", async () => {
  run("DELETE FROM items");
  const now = new Date().toISOString();
  insertItem({ sourceId: "linuxdo-welfare", title: "有效福利 A", score: 85, aiKeep: 1, aiQuality: 5, publishedAt: now, pushedAt: now });
  insertItem({ sourceId: "linuxdo-welfare", title: "有效福利 B", score: 80, aiKeep: 1, aiQuality: 3, publishedAt: now });
  insertItem({ sourceId: "linuxdo-welfare", title: "水贴噪音 C", kind: "noise", score: 20, aiKeep: 0, aiQuality: 1, publishedAt: now });
  insertItem({ sourceId: "linuxdo-welfare", title: "待审条目 D", score: 65, aiKeep: null, aiQuality: null, publishedAt: now });

  const rows = sourceQuality(7);
  const ld = rows.find((r) => r.id === "linuxdo-welfare");
  assert.ok(ld);
  assert.equal(ld.total, 4);
  assert.equal(ld.reviewed, 3);
  assert.equal(ld.kept, 2);
  assert.equal(ld.rejected, 1);
  assert.ok(Math.abs((ld.keepRate ?? 0) - 2 / 3) < 0.001);
  assert.equal(ld.avgQuality, 3);
  assert.equal(ld.pushed, 1);

  const res = await app.request("/api/source-quality?days=7");
  assert.equal(res.status, 200);
  const json = (await res.json()) as { days: number; sources: typeof rows };
  assert.equal(json.days, 7);
  assert.ok(json.sources.some((s) => s.id === "linuxdo-welfare"));
});

test("runWeekly & /api/digests/weekly：生成周报落库并区分 kind，且不拦截后续日报", async () => {
  run("DELETE FROM items");
  run("DELETE FROM digests");
  const now = new Date();
  const iso = now.toISOString();
  const id1 = insertItem({ sourceId: "epic-free", title: "本周必抢：免费领取《星空测试》", category: "game", score: 92, aiKeep: 1, aiQuality: 5, publishedAt: iso });
  insertItem({ sourceId: "linuxdo-welfare", title: "AI 编码助手免费 Pro 会员 30 天", category: "ai", score: 88, aiKeep: 1, aiQuality: 4, publishedAt: iso });

  const res = await app.request("/api/digests/weekly", { method: "POST" });
  assert.equal(res.status, 200);
  const weekly = (await res.json()) as { date: string; count: number; text: string };
  assert.equal(weekly.date, weekKey(now));
  assert.equal(weekly.count, 2);
  assert.ok(weekly.text.includes("本周精选"));

  const list = lastDigests(10);
  assert.equal(list[0]?.date, weekly.date);
  assert.equal(list[0]?.kind, "weekly");

  // 即使未来日期字符串 >= cutoff，周报也不应被 recentDigestPushed 当成日报屏蔽掉
  const dailyPicked = pickDaily(now);
  assert.ok(dailyPicked.some((it) => it.id === id1), "周报不应阻止日报收录同一条高分福利");
});

test("GET /api/items 窗口函数跨源合并：筛选条件下保留各组最高分代表", async () => {
  run("DELETE FROM items");
  const now = new Date().toISOString();
  insertItem({ sourceId: "epic-free", title: "《星际免费》Epic 喜加一", category: "game", score: 82, publishedAt: now, titleKey: "starfree" });
  insertItem({ sourceId: "gamerpower", title: "StarFree 限免领取", category: "game", score: 91, publishedAt: now, titleKey: "starfree" });
  insertItem({ sourceId: "linuxdo-welfare", title: "Cloudflare Workers 免费额度扩容", category: "cloud", score: 78, publishedAt: now, titleKey: "cfworkers" });

  const res = await app.request("/api/items?aiOnly=1&merge=1");
  assert.equal(res.status, 200);
  const json = (await res.json()) as { total: number; items: { id: number; source_id: string; dupCount: number }[] };
  assert.equal(json.total, 2);
  const game = json.items.find((it) => it.source_id === "gamerpower");
  assert.ok(game);
  assert.equal(game.dupCount, 2);
});


test("aiStats & /api/ai/live：屏蔽词跳过单列计数，最近样本按 ai_reviewed_at 倒序，遥测记录完整生命周期", async () => {
  const { aiStats, backfillAi } = await import("../src/server/ai-admin.ts");
  const { saveAiSettings } = await import("../src/server/enrich/ai-settings.ts");
  const { finishAiJob, recordAiBatch, startAiJob } = await import("../src/server/enrich/ai-telemetry.ts");

  run("DELETE FROM items");
  run("DELETE FROM block_rules");
  const oldTime = "2026-11-10T00:00:00.000Z";
  const newSeen = "2026-11-14T12:00:00.000Z";
  const newerReview = "2026-11-15T01:00:00.000Z";

  // 1) 一条命中屏蔽词的 pending + 一条未屏蔽 pending
  run("INSERT INTO block_rules (pattern, mode, scope, enabled, created_at) VALUES ('屏蔽样本', 'keyword', 'all', 1, ?)", newSeen);
  insertItem({ sourceId: "v2ex-free", title: "屏蔽样本：待审跳过", aiKeep: null, aiQuality: null, publishedAt: newSeen });
  const unblockedId = insertItem({ sourceId: "v2ex-free", title: "正常未审样本", aiKeep: null, aiQuality: null, publishedAt: newSeen });
  run("UPDATE items SET ai = NULL WHERE id IN (?, ?)", unblockedId - 1, unblockedId);

  // 2) 两条已审样本：idA last_seen_at 更新，但 idB ai_reviewed_at 更新 -> recent[0] 必须是 idB
  const idA = insertItem({ sourceId: "v2ex-free", title: "较早审核样本 A", aiKeep: 1, aiQuality: 4, publishedAt: newSeen });
  const idB = insertItem({ sourceId: "linuxdo-welfare", title: "刚刚补审样本 B", aiKeep: 1, aiQuality: 5, publishedAt: oldTime });
  run("UPDATE items SET ai = ?, ai_reviewed_at = ? WHERE id = ?", JSON.stringify({ keep: true, reason: "旧审" }), oldTime, idA);
  run("UPDATE items SET ai = ?, ai_reviewed_at = ? WHERE id = ?", JSON.stringify({ keep: true, reason: "刚补审" }), newerReview, idB);

  const jobId = startAiJob({ stage: "backfill", label: "单测模拟", model: "test-m", total: 2, totalBatches: 1 });
  recordAiBatch(jobId, {
    kept: 2,
    rejected: 0,
    ttfbMs: 120,
    events: [{ title: "刚刚补审样本 B", keep: true, kind: "freebie", category: "ai", quality: 5, reason: "刚补审", at: newerReview }],
  });
  let st = aiStats();
  assert.equal(st.pending, 1, "未屏蔽的待审应为 1");
  assert.equal(st.blockedSkipped, 1, "命中屏蔽词跳过的待审应单独计为 1");
  assert.equal(st.recent[0]?.id, idB, "最近判定样本应按 ai_reviewed_at 倒序");
  assert.equal(st.telemetry.active.length, 1);

  finishAiJob(jobId);
  const liveRes = await app.request("/api/ai/live");
  assert.equal(liveRes.status, 200);
  const liveJson = (await liveRes.json()) as { stats: ReturnType<typeof aiStats> };
  assert.equal(liveJson.stats.telemetry.active.length, 0);
  assert.ok(liveJson.stats.telemetry.history.some((h) => h.label === "单测模拟" && h.ttfbAvgMs === 120));

  // 如果全部 pending 都命中屏蔽词，backfillAi 应返回 skippedBlocked=1 且不调模型
  run("DELETE FROM items WHERE id = ?", unblockedId);
  saveAiSettings({ enabled: true, baseUrl: "https://example.invalid/v1", model: "test-m" });
  const bf = await backfillAi(20, "pending");
  assert.equal(bf.reviewed, 0);
  assert.equal(bf.skippedBlocked, 1);
  saveAiSettings({ enabled: false, baseUrl: "", model: "" });
  run("DELETE FROM block_rules");
});


test("buildHotReport：最值得抢严格排除新闻/资讯/二手，对同事件去重并单独输出 topNews", async () => {
  run("DELETE FROM items");
  const now = new Date().toISOString();
  insertItem({ sourceId: "linuxdo-welfare", title: "天翼云免费领 4核8G 云电脑", category: "cloud", kind: "freebie", score: 95, aiQuality: 5, publishedAt: now });
  insertItem({ sourceId: "rss-nodeseek", title: "DediRock 黑五特价 $10/年 VPS", category: "vps", kind: "deal", score: 86, aiQuality: 4, publishedAt: now });
  insertItem({ sourceId: "rss-nodeseek", title: "出 懒猫家宽 1折账号转让", category: "trade", kind: "deal", score: 88, aiQuality: 5, publishedAt: now });
  insertItem({ sourceId: "rss-ithome", title: "2026 商保创新药目录扩容，百万元 CAR-T 抗癌药入选，患者自付下降", category: "news", kind: "news", score: 68, aiQuality: 5, publishedAt: now });
  insertItem({ sourceId: "rss-smzdm", title: "129万一针的CAR-T首次进医保，降至30万？", category: "news", kind: "news", score: 63, aiQuality: 5, publishedAt: now });
  insertItem({ sourceId: "rss-smzdm", title: "首款CAR-T进医保，其他CAR-T患者怎么办", category: "news", kind: "news", score: 63, aiQuality: 5, publishedAt: now });
  insertItem({ sourceId: "rss-wallstreetcn", title: "Anthropic 冲刺 IPO 估值超万亿美元", category: "stock", kind: "info", score: 70, aiQuality: 4, publishedAt: now });

  const allReport = buildHotReport(24, "all");
  // 「这个窗口最值得抢」不得出现新闻/资讯或二手转让
  assert.equal(allReport.top.length, 2);
  assert.ok(allReport.top.every((t) => t.kind === "freebie" || t.kind === "deal"));
  assert.ok(!allReport.top.some((t) => t.category === "trade" || t.kind === "news" || t.kind === "info"));

  // 「热点新闻与行业资讯」应将 3 篇 CAR-T 折叠为 1 篇（dupCount=3）+ 1 篇 Anthropic IPO
  assert.equal(allReport.topNews.length, 2);
  const cart = allReport.topNews.find((t) => t.title.includes("CAR-T"));
  assert.ok(cart);
  assert.equal(cart.dupCount, 3);

  // /api/items?merge=1 与 /api/items/:id/related 也应把 3 篇 CAR-T 折叠并返回关联条目
  const itemsRes = await app.request("/api/items?kind=news&merge=1");
  assert.equal(itemsRes.status, 200);
  const itemsJson = (await itemsRes.json()) as { total: number; items: { id: number; dupCount: number }[] };
  assert.equal(itemsJson.total, 1);
  assert.equal(itemsJson.items[0]?.dupCount, 3);

  const relRes = await app.request(`/api/items/${itemsJson.items[0]!.id}/related`);
  const relJson = (await relRes.json()) as { items: { id: number }[] };
  assert.equal(relJson.items.length, 2);
});

test("纯生财源默认推送态放行 info/opensource 与历史回溯补位，且 runDaily/runWeekly 调用 AI 主编生成深度内参并支持异常回退", async (t) => {
  run("DELETE FROM items");
  run("DELETE FROM digests");
  run("DELETE FROM settings WHERE key IN ('ai', 'push')");

  const now = new Date();
  const nowIso = now.toISOString();
  const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000).toISOString();

  // 插入近期生财 info 帖与 10 天前发布的回溯入库（first_seen_at 为今天）高质量开源/实战帖
  const recentId = insertItem({
    sourceId: "scys-highlights",
    title: "Claude Code + MCP 自动化变现实战 SOP",
    category: "ai",
    kind: "info",
    score: 82,
    aiKeep: 1,
    aiQuality: 5,
    publishedAt: nowIso,
  });
  run("UPDATE items SET obtain = 'conditional', content = '完整 SOP 步骤与变现拆解', ai = ? WHERE id = ?", JSON.stringify({ keep: true, kind: "info", category: "ai", obtain: "conditional", quality: 5, reason: "[需编程] AI工作流SOP" }), recentId);

  const backfillId = insertItem({
    sourceId: "scys-projects",
    title: "海外独立 SaaS 月入 5000 刀成本拆解",
    category: "dev",
    kind: "opensource",
    score: 76,
    aiKeep: 1,
    aiQuality: 4,
    publishedAt: tenDaysAgo,
  });
  run("UPDATE items SET obtain = 'paid', first_seen_at = ?, content = '含 GitHub 源码与投入产出比测算', ai = ? WHERE id = ?", nowIso, JSON.stringify({ keep: true, kind: "opensource", category: "dev", obtain: "paid", quality: 4, reason: "[需投流] SaaS开源拆解" }), backfillId);

  // 未修改 push 设置（仍为默认 freebie/free）时，纯生财源环境下 pickDaily 应同时收录 info 与历史回溯补位帖
  const dailyPool = pickDaily(now, 12);
  assert.ok(dailyPool.some((it) => it.id === recentId));
  assert.ok(dailyPool.some((it) => it.id === backfillId));

  // 开启 AI 后，runDaily / runWeekly 应按 AI 返回的 selectedIds 排序并写入主编 briefing
  saveAiSettings({ enabled: true, baseUrl: "https://digest-ai.invalid/v1", apiKey: "test-key", model: "gpt-6.1-terra:high" });
  const sentRequests: Array<{ model: string; reasoning_effort?: string; hasTemp: boolean; system: string; candidateCount: number }> = [];
  let failNext = false;

  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      reasoning_effort?: string;
      temperature?: unknown;
      messages: Array<{ role: string; content: string }>;
    };
    const candidates = JSON.parse(body.messages[1]!.content) as Array<{ id: number }>;
    sentRequests.push({
      model: body.model,
      reasoning_effort: body.reasoning_effort,
      hasTemp: "temperature" in body,
      system: body.messages[0]!.content,
      candidateCount: candidates.length,
    });
    if (failNext) {
      return new Response("upstream error", { status: 500 });
    }
    const isWeekly = body.messages[0]!.content.includes("本周赛道风向");
    const report = isWeekly
      ? {
          introTitle: "📈 本周赛道风向",
          introPoints: ["AI 工作流加速。"],
          picksTitle: "🏆 本周 Top 精选拆解",
          picks: [
            {
              id: backfillId,
              title: "海外独立 SaaS 月入 5000 刀成本拆解",
              summary: "含 GitHub 源码与完整投流测算，可直接对照复刻。",
              threshold: "[底牌门槛] 需投流预算",
              url: "https://hallucinated.invalid/should-be-replaced",
            },
            {
              id: recentId,
              title: "Claude Code + MCP 自动化变现实战 SOP",
              summary: "拆解自动化工作流步骤与转化路径。",
              threshold: "需编程基础",
            },
          ],
          closingTitle: "💡 下周行动建议",
          closingPoints: ["先跑通 MVP。"],
        }
      : {
          introTitle: "🎯 今日核心风向",
          introPoints: ["关注 AI 自动化。"],
          picksTitle: "🔥 必看实战拆解",
          picks: [
            {
              id: backfillId,
              title: "海外独立 SaaS 月入 5000 刀成本拆解",
              summary: "拆解成本结构与获客漏斗。",
              threshold: "需投流预算",
              url: "https://hallucinated.invalid/should-be-replaced",
            },
            {
              id: recentId,
              title: "Claude Code + MCP 自动化变现实战 SOP",
              summary: "从接入 MCP 到变现闭环的实操指南。",
              threshold: "[底牌门槛] 需编程",
            },
          ],
          closingTitle: "⚠️ 今日避坑提醒",
          closingPoints: ["控制投流预算。"],
        };
    // 故意把 backfillId 排在前面并混入一个无效 ID 999999 测试校验与重排
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ selectedIds: [999999, backfillId, recentId], report }) } }],
      }),
      { headers: { "content-type": "application/json" } },
    );
  });

  try {
    const dailyRes = await runDaily({ dryRun: false, date: now });
    assert.equal(dailyRes.count, 2);
    assert.ok(dailyRes.text.includes("🎯 今日核心风向"));
    assert.ok(dailyRes.text.includes("[底牌门槛] 需投流预算"));
    assert.equal(dailyRes.report?.picks[0]?.threshold, "需投流预算");
    assert.equal(dailyRes.report?.picks[1]?.threshold, "需编程");
    assert.ok(dailyRes.report?.picks[0]?.url?.startsWith("https://example.com/"), "须用真实条目 URL 覆盖幻觉链接");
    assert.equal(sentRequests[0]!.model, "gpt-6.2-astra");
    assert.equal(sentRequests[0]!.reasoning_effort, "xhigh");
    assert.equal(sentRequests[0]!.hasTemp, false);
    const savedDaily = get<{ item_ids: string }>("SELECT item_ids FROM digests WHERE date = ?", dailyRes.date)!;
    assert.deepEqual(JSON.parse(savedDaily.item_ids), [backfillId, recentId]);

    const apiDailyRes = await app.request(`/api/digests/${dailyRes.date}`);
    assert.equal(apiDailyRes.status, 200);
    const apiDailyJson = (await apiDailyRes.json()) as {
      text: string;
      report: { introTitle: string; picks: Array<{ id?: number; threshold: string; url?: string }> } | null;
      items: Array<{ id: number }>;
    };
    assert.equal(apiDailyJson.report?.introTitle, "🎯 今日核心风向");
    assert.equal(apiDailyJson.report?.picks.length, 2);
    assert.equal(apiDailyJson.report?.picks[0]?.threshold, "需投流预算");
    assert.equal(apiDailyJson.report?.picks[1]?.threshold, "需编程");
    assert.deepEqual(apiDailyJson.items.map((it) => it.id), [backfillId, recentId]);

    const weeklyRes = await runWeekly({ dryRun: false, date: now });
    assert.equal(weeklyRes.count, 2);
    assert.ok(weeklyRes.text.includes("📈 本周赛道风向"));
    assert.equal(weeklyRes.report?.picks[0]?.threshold, "需投流预算");
    const savedWeekly = get<{ item_ids: string }>("SELECT item_ids FROM digests WHERE date = ?", weeklyRes.date)!;
    assert.deepEqual(JSON.parse(savedWeekly.item_ids), [backfillId, recentId]);

    // 兼容旧版仅返回 briefing 字符串的 JSON（report 应为 null，text 保留原样）
    run("DELETE FROM digests");
    t.mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  selectedIds: [recentId, backfillId],
                  briefing: "🎯 今日核心风向\n- 旧版纯文本兼容。",
                }),
              },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const legacyRes = await runDaily({ dryRun: true, date: now });
    assert.equal(legacyRes.report, null);
    assert.ok(legacyRes.text.includes("旧版纯文本兼容"));

    // AI 异常时优雅回退默认 formatDigest / formatWeekly
    run("DELETE FROM digests");
    failNext = true;
    t.mock.method(globalThis, "fetch", async () => new Response("upstream error", { status: 500 }));
    const fallbackDaily = await runDaily({ dryRun: true, date: now });
    assert.equal(fallbackDaily.report, null);
    assert.ok(fallbackDaily.text.includes("资源雷达"));
    const fallbackWeekly = await runWeekly({ dryRun: true, date: now });
    assert.equal(fallbackWeekly.report, null);
    assert.ok(fallbackWeekly.text.includes("本周精选"));
  } finally {
    saveAiSettings({ enabled: false, baseUrl: "", model: "", apiKey: "" });
  }
});
