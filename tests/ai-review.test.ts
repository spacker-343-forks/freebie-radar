import assert from "node:assert/strict";
import { after, before, test, type TestContext } from "node:test";

Object.assign(process.env, {
  DATABASE_PATH: ":memory:", ENABLE_SCHEDULER: "false",
  AI_BASE_URL: "", AI_MODEL: "", AI_API_KEY: "",
  PUSH_CHANNEL: "none", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "",
  SITE_MODE: "selfhost", ADMIN_TOKEN: "ai-review-test",
});

const { closeDb, get, migrate, run } = await import("../src/server/db.ts");
const {
  DEFAULT_AI_SETTINGS,
  aiSummaryExcerpt,
  buildChatCompletionBody,
  reviewItems,
  saveAiSettings,
} = await import("../src/server/enrich/ai-settings.ts");
const { reviewFreshNow } = await import("../src/server/enrich/ai-queue.ts");
const { findSemanticDuplicatesWithAi } = await import("../src/server/enrich/ai-dedup.ts");

const settings = {
  ...DEFAULT_AI_SETTINGS,
  enabled: true,
  baseUrl: "https://ai-review.invalid/v1",
  apiKey: "",
  model: "fixture",
  batchSize: 2,
  concurrency: 2,
  learnFromFeedback: false,
  aiDedupEnabled: false,
};
type PayloadItem = { index: number; title: string; summary: string };
const items = [0, 1, 2, 3].map((i) => ({
  externalId: String(i), title: `免费领取模型额度 ${i}`, summary: "公开活动",
  url: `https://example.invalid/ai-review/${i}`,
}));
function verdicts(payload: PayloadItem[]) {
  return payload.map((item) => ({
    index: item.index, keep: true, kind: "freebie", category: "ai",
    obtain: "free", quality: 4, reason: `fixture ${item.index}`,
  }));
}
function mockAi(t: TestContext, respond: (payload: PayloadItem[]) => unknown) {
  const requests: PayloadItem[][] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), `${settings.baseUrl}/chat/completions`);
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const payload = JSON.parse(body.messages[1]!.content) as PayloadItem[];
    requests.push(payload);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(respond(payload)) } }] }), {
      headers: { "content-type": "application/json" },
    });
  });
  return requests;
}

before(() => {
  migrate();
  saveAiSettings(settings);
});
after(() => closeDb());

test("推送前同步审核与普通审核使用同一份正文证据", async (t) => {
  const requests = mockAi(t, verdicts);
  const now = new Date().toISOString();
  const item = { ...items[0]!, content: "领取须充值99元，且仅限新用户。" };
  const row = run(
    `INSERT INTO items(source_id,external_id,url,url_key,title,summary,content,first_seen_at,last_seen_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    "review-fixture", item.externalId, item.url, "review-body", item.title, item.summary, item.content, now, now,
  );
  await reviewFreshNow([{ ...item, itemId: Number(row.lastInsertRowid), sourceId: "review-fixture" }]);
  await reviewItems([item], settings);
  assert.equal(requests.length, 2);
  assert.ok(requests[0]![0]!.summary.includes("充值99元"));
  assert.deepEqual(requests[0], requests[1]);
});

test("合法返回允许乱序，false 保持布尔拒绝且跨批索引不串位", async (t) => {
  mockAi(t, (payload) => verdicts(payload).map((v) => ({ ...v, keep: v.index % 2 === 0 })).reverse());
  const result = await reviewItems(items, settings);
  assert.equal(result?.size, 4);
  for (let i = 0; i < items.length; i += 1) assert.equal(result?.get(i)?.keep, i % 2 === 0);
});

test("兼容缺省 kind/obtain/quality 的合法旧模型返回", async (t) => {
  mockAi(t, (payload) => payload.map((item) => ({ index: item.index, keep: true, category: "ai", reason: "有效内容" })));
  const result = await reviewItems(items.slice(0, 1), settings);
  assert.equal(result?.get(0)?.keep, true);
  assert.equal(result?.get(0)?.kind, undefined);
  assert.equal(result?.get(0)?.obtain, undefined);
});

test("无效 AI 补审不覆盖条目，也不把未审条目标记成通过", async (t) => {
  mockAi(t, (payload) => verdicts(payload).map((v) => ({ ...v, keep: "false" })));
  const now = new Date().toISOString();
  const item = items[1]!;
  const row = run(
    `INSERT INTO items(source_id,external_id,url,url_key,title,summary,kind,first_seen_at,last_seen_at)
     VALUES(?,?,?,?,?,?,'info',?,?)`,
    "review-fixture", item.externalId, item.url, "review-invalid", item.title, item.summary, now, now,
  );
  const itemId = Number(row.lastInsertRowid);
  const result = await reviewFreshNow([{ ...item, itemId, sourceId: "review-fixture" }]);
  assert.equal(result.size, 0);
  const stored = get<{ ai: string | null; ai_keep: number | null; kind: string }>("SELECT ai,ai_keep,kind FROM items WHERE id=?", itemId)!;
  assert.equal(stored.ai, null);
  assert.equal(stored.ai_keep, null);
  assert.equal(stored.kind, "info");
});

const invalidCases: Array<{ name: string; mutate: (payload: PayloadItem[]) => unknown }> = [
  { name: 'keep="false" 不能被当成 true', mutate: (p) => verdicts(p).map((v) => ({ ...v, keep: "false" })) },
  { name: "缺失 keep 不能标成已审核", mutate: (p) => verdicts(p).map(({ keep: _keep, ...v }) => v) },
  { name: "非法分类不能落库", mutate: (p) => verdicts(p).map((v) => ({ ...v, category: "invented-category" })) },
  { name: "非法形态不能落库", mutate: (p) => verdicts(p).map((v) => ({ ...v, kind: "invented-kind" })) },
  { name: "非法获取方式不能落库", mutate: (p) => verdicts(p).map((v) => ({ ...v, obtain: "invented-obtain" })) },
  { name: "字符串质量分不能当成有效评分", mutate: (p) => verdicts(p).map((v) => ({ ...v, quality: "5" })) },
  { name: "越界质量分不能当成有效评分", mutate: (p) => verdicts(p).map((v) => ({ ...v, quality: 6 })) },
  { name: "非文本理由不能落库", mutate: (p) => verdicts(p).map((v) => ({ ...v, reason: 42 })) },
  { name: "字符串索引不能导致空结果被记成功", mutate: (p) => verdicts(p).map((v) => ({ ...v, index: String(v.index) })) },
  { name: "小数索引不能串位", mutate: (p) => verdicts(p).map((v) => ({ ...v, index: v.index + 0.5 })) },
  { name: "其他批次的索引不能污染当前批次", mutate: (p) => verdicts(p).map((v) => ({ ...v, index: v.index + 2 })) },
  { name: "重复索引不能覆盖另一条资源", mutate: (p) => verdicts(p).map((v) => ({ ...v, index: p[0]!.index })) },
  { name: "漏判条目不能把批次记为全部成功", mutate: (p) => verdicts(p).slice(0, 1) },
  { name: "空数组不能把批次记为全部成功", mutate: () => [] },
];
for (const { name, mutate } of invalidCases) {
  test(`AI 响应校验：${name}`, async (t) => {
    const requests = mockAi(t, mutate);
    const result = await reviewItems(items.slice(0, 2), settings);
    assert.equal(result, null);
    assert.equal(requests.length, 2, "无效结果沿用一次重试，仍无效则保持未审");
  });
}

test("一批失败不丢弃另一批的有效结论，重试索引不覆盖已成功批次", async (t) => {
  const requests = mockAi(t, (payload) => verdicts(payload).map((v) => ({ ...v, index: v.index % 2 })));
  const result = await reviewItems(items, settings);
  assert.equal(result?.size, 2);
  assert.equal(result?.get(0)?.reason, "fixture 0");
  assert.equal(result?.get(1)?.reason, "fixture 1");
  assert.equal(result?.has(2), false);
  assert.equal(result?.has(3), false);
  assert.equal(requests.length, 3);
});

test("无效返回重试成功后使用完整的有效批次", async (t) => {
  let attempt = 0;
  mockAi(t, (payload) => ++attempt === 1 ? [] : verdicts(payload));
  const result = await reviewItems(items.slice(0, 2), settings);
  assert.equal(attempt, 2);
  assert.equal(result?.size, 2);
});

test("推理模型后缀 gpt-6.1-terra:xhigh 自动拆解 reasoning_effort 且省略 temperature（审核与去重共用）", async (t) => {
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { messages: { content: string }[] };
    bodies.push(body);
    const payload = JSON.parse(body.messages[1]!.content) as PayloadItem[];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdicts(payload)) } }] }), {
      headers: { "content-type": "application/json" },
    });
  });

  const reasoningSettings = { ...settings, model: "gpt-6.1-terra:xhigh", timeoutSec: 90 };
  const saved = saveAiSettings({ timeoutSec: 90 });
  assert.equal(saved.timeoutSec, 90);
  assert.equal(saveAiSettings({ timeoutSec: 200 }).timeoutSec, 120);
  saveAiSettings(settings);

  const direct = buildChatCompletionBody({
    model: "o4-mini@high",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(direct.model, "o4-mini");
  assert.equal(direct.reasoning_effort, "high");
  assert.equal("temperature" in direct, false);

  const result = await reviewItems(items.slice(0, 1), reasoningSettings);
  assert.equal(result?.size, 1);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.model, "gpt-6.1-terra");
  assert.equal(bodies[0]!.reasoning_effort, "xhigh");
  assert.equal("temperature" in bodies[0]!, false);

  const dedupBodies: Array<Record<string, unknown>> = [];
  const fakeDedupFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    dedupBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  await findSemanticDuplicatesWithAi(
    [{ id: 101, title: "生财实战复盘 A" }],
    [{ id: 100, title: "生财实战复盘 B" }],
    reasoningSettings,
    fakeDedupFetch,
  );
  assert.equal(dedupBodies.length, 1);
  assert.equal(dedupBodies[0]!.model, "gpt-6.1-terra");
  assert.equal(dedupBodies[0]!.reasoning_effort, "xhigh");
  assert.equal("temperature" in dedupBodies[0]!, false);
});

test("普通未知模型遇 HTTP 400 temperature 不支持错误时自动去掉 temperature 重试成功", async (t) => {
  const sentBodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { messages: { content: string }[] };
    sentBodies.push(body);
    if (sentBodies.length === 1) {
      return new Response(
        JSON.stringify({ error: { message: "Unsupported value: 'temperature' does not support 0 with this model." } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    const payload = JSON.parse(body.messages[1]!.content) as PayloadItem[];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdicts(payload)) } }] }), {
      headers: { "content-type": "application/json" },
    });
  });

  const result = await reviewItems(items.slice(0, 1), { ...settings, model: "custom-unknown-model" });
  assert.equal(result?.size, 1);
  assert.equal(sentBodies.length, 2);
  assert.equal(sentBodies[0]!.model, "custom-unknown-model");
  assert.equal(sentBodies[0]!.temperature, 0);
  assert.equal(sentBodies[1]!.model, "custom-unknown-model");
  assert.equal("temperature" in sentBodies[1]!, false);
});

test("生财长文脱水默认参数与 2000 字正文截断策略 (aiSummaryExcerpt)", async (t) => {
  assert.equal(DEFAULT_AI_SETTINGS.baseUrl, "https://api.openai.com/v1");
  assert.equal(DEFAULT_AI_SETTINGS.model, "gpt-6.1-terra:high");
  assert.equal(DEFAULT_AI_SETTINGS.batchSize, 4);
  assert.equal(DEFAULT_AI_SETTINGS.concurrency, 3);
  assert.equal(DEFAULT_AI_SETTINGS.timeoutSec, 75);

  const exact2000 = "A".repeat(2000);
  assert.equal(aiSummaryExcerpt({ content: exact2000 }), exact2000);

  const head = "HEAD_SOP_".padEnd(1550, "B");
  const middle = "MID_".padEnd(500, "M");
  const tail = "_TAIL_CTA".padStart(420, "C");
  const longContent = `${head}${middle}${tail}`;
  const excerpt = aiSummaryExcerpt({ content: longContent });
  assert.equal(excerpt, `${head} … ${tail}`);

  const sentPayloads: PayloadItem[][] = [];
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const payload = JSON.parse(body.messages[1]!.content) as PayloadItem[];
    sentPayloads.push(payload);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdicts(payload)) } }] }), {
      headers: { "content-type": "application/json" },
    });
  });

  await reviewItems([{ ...items[0]!, content: longContent }], settings);
  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0]![0]!.summary, `${head} … ${tail}`);
});

test("scys-preset 升级旧版默认生财源 maxDetailPerRun 与默认 AI 档位", async () => {
  const { ensureSources } = await import("../src/server/collectors/index.ts");
  const { applyScysPreset } = await import("../scripts/scys-preset.ts");

  ensureSources();
  // 模拟旧库：scys-* 仍保留旧默认 maxDetailPerRun，AI 配置仍保留旧默认参数
  run("UPDATE sources SET config = ? WHERE id = 'scys-highlights'", JSON.stringify({ mode: "highlights", pageSize: 15, fetchDetail: true, maxDetailPerRun: 8 }));
  run("UPDATE sources SET config = ? WHERE id = 'scys-latest'", JSON.stringify({ mode: "latest", pageSize: 20, fetchDetail: true, maxDetailPerRun: 10 }));
  saveAiSettings({ baseUrl: "", model: "", batchSize: 6, concurrency: 4, timeoutSec: 45 });

  const out = applyScysPreset();
  assert.equal(out.upgradedConfigs, 2);
  assert.equal(out.aiModel, "gpt-6.1-terra:high");
  assert.equal(out.aiBatchSize, 4);
  assert.equal(out.aiConcurrency, 3);
  assert.equal(out.aiTimeoutSec, 75);

  const highlightsCfg = JSON.parse(get<{ config: string }>("SELECT config FROM sources WHERE id = 'scys-highlights'")!.config) as { pageSize: number; maxDetailPerRun: number };
  const latestCfg = JSON.parse(get<{ config: string }>("SELECT config FROM sources WHERE id = 'scys-latest'")!.config) as { pageSize: number; maxDetailPerRun: number };
  assert.deepEqual(highlightsCfg, { mode: "highlights", pageSize: 15, fetchDetail: true, maxDetailPerRun: 15 });
  assert.deepEqual(latestCfg, { mode: "latest", pageSize: 15, fetchDetail: true, maxDetailPerRun: 15 });
  saveAiSettings(settings);
});
