import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { Hono } from "hono";

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

const { migrate, run, closeDb } = await import("../src/server/db.ts");
const { ensureSources } = await import("../src/server/collectors/index.ts");
const { registerApi } = await import("../src/server/routes.ts");
const {
  DEFAULT_AI_SETTINGS,
  postChatCompletions,
  publicAiSettings,
  resetAiFallbackCircuit,
  resolveDeepModel,
  saveAiSettings,
} = await import("../src/server/enrich/ai-settings.ts");
const {
  backfillDossiers,
  ensureDossierTable,
  generateItemDossier,
  getItemDossier,
} = await import("../src/server/dossier.ts");
const {
  ensureTracksTable,
  getTrackDetail,
  listTracks,
  synthesizeAllTracks,
} = await import("../src/server/tracks.ts");

const app = new Hono();

const baseAi = {
  ...DEFAULT_AI_SETTINGS,
  enabled: true,
  baseUrl: "https://primary.invalid/v1",
  apiKey: "primary-test-key",
  model: "gpt-6.1-terra:high",
};

before(() => {
  migrate();
  ensureSources();
  ensureDossierTable();
  ensureTracksTable();
  registerApi(app);
});

after(() => {
  closeDb();
});

beforeEach(() => {
  resetAiFallbackCircuit();
  process.env.AI_FALLBACK_BASE_URL = "";
  process.env.AI_FALLBACK_API_KEY = "";
  process.env.AI_FALLBACK_MODEL = "";
  process.env.AI_DEEP_MODEL = "";
  run("DELETE FROM item_dossiers");
  run("DELETE FROM scys_tracks");
  run("DELETE FROM items");
  saveAiSettings(baseAi);
});

test("主备 AI 网关故障切换：主端点 429 insufficient_quota 自动熔断并无缝切换至备用网关", async () => {
  process.env.AI_FALLBACK_BASE_URL = "https://fallback.invalid/v1";
  process.env.AI_FALLBACK_API_KEY = "fallback-test-key";
  process.env.AI_FALLBACK_MODEL = "gpt-6.2-astra:high";

  const pub = publicAiSettings(baseAi);
  assert.equal(pub.hasFallback, true);
  assert.equal(pub.fallbackBaseUrl, "https://fallback.invalid/v1");
  assert.equal("fallbackApiKey" in pub, false);

  assert.equal(resolveDeepModel(baseAi), "gpt-6.2-astra:xhigh");
  process.env.AI_DEEP_MODEL = "custom-deep:xhigh";
  assert.equal(resolveDeepModel(baseAi), "custom-deep:xhigh");
  process.env.AI_DEEP_MODEL = "";

  const calledUrls: string[] = [];
  const calledModels: string[] = [];
  const calledAuths: string[] = [];

  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { model: string };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calledUrls.push(url);
    calledModels.push(body.model);
    calledAuths.push(headers.authorization || "");

    if (url.startsWith("https://primary.invalid")) {
      return new Response(
        JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your current quota" } }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok-from-fallback" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  // 第 1 次请求：先打主端点 429 insufficient_quota -> 自动切换备用端点成功返回
  const first = await postChatCompletions({
    baseUrl: baseAi.baseUrl,
    apiKey: baseAi.apiKey,
    model: baseAi.model,
    messages: [{ role: "user", content: "ping-1" }],
    fetchImpl: mockFetch,
  });
  assert.equal(first.res.status, 200);
  assert.deepEqual(calledUrls, [
    "https://primary.invalid/v1/chat/completions",
    "https://fallback.invalid/v1/chat/completions",
  ]);
  assert.equal(calledModels[1], "gpt-6.2-astra");
  assert.equal(calledAuths[1], "Bearer fallback-test-key");

  // 第 2 次请求：熔断期内直连备用端点，零等待不再打主端点
  const second = await postChatCompletions({
    baseUrl: baseAi.baseUrl,
    apiKey: baseAi.apiKey,
    model: baseAi.model,
    messages: [{ role: "user", content: "ping-2" }],
    fetchImpl: mockFetch,
  });
  assert.equal(second.res.status, 200);
  assert.equal(calledUrls.length, 3);
  assert.equal(calledUrls[2], "https://fallback.invalid/v1/chat/completions");
});

test("模块一立项拆解书：generateItemDossier / backfillDossiers 与列表 hasDossier / 详情 dossier 联调", async () => {
  run(
    `INSERT INTO items (id, source_id, external_id, url, url_key, title, summary, content, category, kind, ai_keep, ai_quality, score, status, first_seen_at, last_seen_at)
     VALUES
       (101, 'scys-highlights', 'scys-101', 'https://scys.com/t/101', 'scys.com/t/101', 'AI工作流代搭建实战SOP', '摘要1', '<p>完整SOP正文：使用 MCP + Claude 自动化接单，客单价 2000 元。</p>', 'ai', 'info', 1, 5, 92, 'active', datetime('now'), datetime('now')),
       (102, 'scys-highlights', 'scys-102', 'https://scys.com/t/102', 'scys.com/t/102', '小红书虚拟资料自动化出单', '摘要2', '完整项目正文：单价 29.9 元，日引流 300 人。', 'goods', 'info', 1, 4, 86, 'active', datetime('now'), datetime('now')),
       (103, 'scys-highlights', 'scys-103', 'https://scys.com/t/103', 'scys.com/t/103', '普通3星随笔', '摘要3', '一般随笔', 'other', 'info', 1, 3, 60, 'active', datetime('now'), datetime('now'))`,
  );

  let usedModel = "";
  const mockFetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; reasoning_effort?: string };
    usedModel = `${body.model}:${body.reasoning_effort ?? ""}`;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: "面向中小企业交付自动化工作流，高客单且刚需明确",
                startupCost: "≤200元 + Cursor/Claude 订阅",
                timeToFirstDollar: "5~10天",
                formula: "客单价 2000元 × 成交率 15% × 周线索 10条 − 交付工时 6h",
                sop: ["第1步：整理行业垂直样板", "第2步：社媒发布演示视频引流", "第3步：交付标准化模板"],
                pitfalls: ["客户定制需求蔓延导致工时倒挂", "未签验收标准引发反复返工"],
                soloMvp: "先做 1 个细分行业固定流程包，299 元体验版验证付费意愿",
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  // 单篇生成并检查模型升级为 gpt-6.2-astra:xhigh
  const d101 = await generateItemDossier(101, { fetchImpl: mockFetch });
  assert.equal(usedModel, "gpt-6.2-astra:xhigh");
  assert.equal(d101.startupCost, "≤200元 + Cursor/Claude 订阅");
  assert.equal(getItemDossier(101)?.sop.length, 3);

  // 批量补齐 >= 4 星且尚未生成的条目（应只补 102，跳过已有 101 和 3 星 103）
  const bf = await backfillDossiers({ minQuality: 4, limit: 10, concurrency: 2, fetchImpl: mockFetch });
  assert.equal(bf.totalCandidates, 1);
  assert.equal(bf.generated, 1);
  assert.equal(bf.failed, 0);

  // 校验列表 hasDossier 与详情 dossier 接口
  const listRes = await app.request("/api/items?limit=10");
  assert.equal(listRes.status, 200);
  const listJson = (await listRes.json()) as { items: Array<{ id: number; hasDossier: boolean }> };
  assert.equal(listJson.items.find((x) => x.id === 101)?.hasDossier, true);
  assert.equal(listJson.items.find((x) => x.id === 102)?.hasDossier, true);
  assert.equal(listJson.items.find((x) => x.id === 103)?.hasDossier, false);

  const detailRes = await app.request("/api/items/101");
  assert.equal(detailRes.status, 200);
  const detailJson = (await detailRes.json()) as { hasDossier: boolean; dossier: { verdict: string } | null };
  assert.equal(detailJson.hasDossier, true);
  assert.ok(detailJson.dossier?.verdict.includes("中小企业"));
});

test("模块二赛道图谱：synthesizeAllTracks 聚类+白皮书合成及 GET /api/tracks 和 /api/tracks/:slug 路由", async () => {
  run(
    `INSERT INTO items (id, source_id, external_id, url, url_key, title, summary, content, category, kind, ai_keep, ai_quality, score, ai, status, first_seen_at, last_seen_at)
     VALUES
       (201, 'scys-highlights', 'scys-201', 'https://scys.com/t/201', 'scys.com/t/201', 'AI Agent 自动化接单复盘', 'Agent 工作流接单', '正文201', 'ai', 'info', 1, 5, 95, '{"reason":"[需编程] Agent接单"}', 'active', datetime('now'), datetime('now')),
       (202, 'scys-projects', 'scys-202', 'https://scys.com/t/202', 'scys.com/t/202', 'MCP 自动化服务项目拆解', 'MCP 部署变现', '正文202', 'ai', 'info', 1, 4, 88, '{"reason":"[需技术] MCP服务"}', 'active', datetime('now'), datetime('now')),
       (203, 'scys-highlights', 'scys-203', 'https://scys.com/t/203', 'scys.com/t/203', '小红书虚拟资料店铺SOP', '虚拟产品自动发货', '正文203', 'goods', 'info', 1, 5, 91, '{"reason":"[零门槛] 虚拟资料"}', 'active', datetime('now'), datetime('now'))`,
  );

  let step = 0;
  const mockFetch: typeof fetch = async (_input, init) => {
    step += 1;
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const sys = body.messages[0]?.content ?? "";

    if (sys.includes("聚类提炼")) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  tracks: [
                    {
                      slug: "ai-agent-service",
                      title: "AI Agent 与自动化服务",
                      emoji: "🤖",
                      tagline: "帮企业与个体部署 AI 工作流降本增效",
                      keywords: ["Agent", "MCP", "自动化"],
                      seedIds: [201, 202],
                    },
                    {
                      slug: "xhs-virtual-goods",
                      title: "小红书虚拟资料矩阵",
                      emoji: "📕",
                      tagline: "高毛利标准化数字资料自动发货变现",
                      keywords: ["小红书", "虚拟资料"],
                      seedIds: [203],
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const isAgentTrack = sys.includes("AI Agent");
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                overview: isAgentTrack ? "Agent 定制正处 B 端刚需早期红利。" : "虚拟资料边际成本接近零，适合轻资产起步。",
                playbooks: [
                  {
                    name: isAgentTrack ? "垂直行业工作流交付" : "痛点资料自动发货店",
                    mechanism: "公域案例演示获客 + 标准化模板交付",
                    roiRange: isAgentTrack ? "单笔 1500~5000 元" : "月入 3000~12000 元",
                    targetPlayer: isAgentTrack ? "懂提示词与脚本开发者" : "零代码内容执行者",
                  },
                ],
                commonPitfalls: ["过度定制拉低人效", "盲目投流导致 ROI 倒挂"],
                actionChecklist: ["第1天：梳理3个高频痛点", "第3天：上线最小演示页", "第7天：复盘转化数据"],
                topItemIds: isAgentTrack ? [201, 202, 999999] : [203],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const synthesized = await synthesizeAllTracks({ fetchImpl: mockFetch });
  assert.equal(synthesized.length, 2);
  assert.ok(step >= 3);

  const list = listTracks();
  assert.equal(list.length, 2);
  const agentTrack = getTrackDetail("ai-agent-service")!;
  assert.equal(agentTrack.itemCount, 2);
  // 幻觉 ID 999999 必须被剔除
  assert.deepEqual(agentTrack.topItemIds, [201, 202]);

  const apiListRes = await app.request("/api/tracks");
  assert.equal(apiListRes.status, 200);
  const apiListJson = (await apiListRes.json()) as { tracks: Array<{ slug: string }>; synthesizing: boolean };
  assert.equal(apiListJson.tracks.length, 2);
  assert.equal(apiListJson.synthesizing, false);

  const apiDetailRes = await app.request("/api/tracks/ai-agent-service");
  assert.equal(apiDetailRes.status, 200);
  const apiDetailJson = (await apiDetailRes.json()) as {
    track: { slug: string; playbooks: unknown[] };
    items: Array<{ id: number }>;
  };
  assert.equal(apiDetailJson.track.slug, "ai-agent-service");
  assert.equal(apiDetailJson.track.playbooks.length, 1);
  assert.deepEqual(
    apiDetailJson.items.map((x) => x.id),
    [201, 202],
  );
});
