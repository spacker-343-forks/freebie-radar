import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
  AI_COMMENT_MODEL: "",
  PUSH_CHANNEL: "none",
  ENABLE_SCHEDULER: "false",
});

const { migrate, run, get, closeDb } = await import("../src/server/db.ts");
const { config } = await import("../src/server/config.ts");
const { COLLECTORS, SEEDS, ensureSources, ingestItems } = await import("../src/server/collectors/index.ts");
const { registerApi } = await import("../src/server/routes.ts");
const { SCYS_AUTH_SETTINGS_KEY } = await import("../src/server/scys/mcp-client.ts");
const { ScysAuthError, ScysMcpClient } = await import("../src/server/scys/mcp-client.ts");
const {
  backfillScysDailyReports,
  ensureScysOfficialReportTable,
  getScysOfficialReport,
  listScysOfficialReports,
  syncScysDailyReport,
} = await import("../src/server/scys-official-report.ts");
const { createScysAiFeedCollector, parseAiFeedPublishedAt } = await import(
  "../src/server/collectors/scys-ai-feed.ts"
);
const { createHttp } = await import("../src/server/http.ts");

type MockState = {
  baseUrl: string;
  dailyCalls: Array<{ reportDate?: string; edition?: string }>;
  aiFeedCalls: Array<{ limit?: number }>;
  dailyHandler: (args: { reportDate?: string; edition?: string }) => unknown;
  aiFeedHandler: (args: { limit?: number }) => unknown;
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function startMockServer() {
  const state: MockState = {
    baseUrl: "",
    dailyCalls: [],
    aiFeedCalls: [],
    dailyHandler: () => ({}),
    aiFeedHandler: () => ({ count: 0, items: [] }),
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/mcp" || req.method !== "POST") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const rpc = JSON.parse(await readBody(req)) as {
      id?: string | number;
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };

    if (rpc.method === "initialize") {
      sendJson(
        res,
        200,
        {
          jsonrpc: "2.0",
          id: rpc.id,
          result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "mock" } },
        },
        { "mcp-session-id": "sess-goldmine3" },
      );
      return;
    }
    if (rpc.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    if (rpc.method === "tools/list") {
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          tools: [
            { name: "getDailyReport", inputSchema: { type: "object", properties: {} } },
            { name: "ai__listAiFeedItems", inputSchema: { type: "object", properties: {} } },
          ],
        },
      });
      return;
    }
    if (rpc.method === "tools/call") {
      const name = rpc.params?.name;
      const args = rpc.params?.arguments ?? {};
      if (name === "getDailyReport") {
        const typedArgs = args as { reportDate?: string; edition?: string };
        state.dailyCalls.push(typedArgs);
        try {
          const out = state.dailyHandler(typedArgs);
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id: rpc.id,
            result: { structuredContent: out },
          });
        } catch (err) {
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              isError: true,
              content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
            },
          });
        }
        return;
      }
      if (name === "ai__listAiFeedItems") {
        const typedArgs = args as { limit?: number };
        state.aiFeedCalls.push(typedArgs);
        const out = state.aiFeedHandler(typedArgs);
        sendJson(res, 200, {
          jsonrpc: "2.0",
          id: rpc.id,
          result: { structuredContent: out },
        });
        return;
      }
    }
    sendJson(res, 400, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "method not found" } });
  });

  return {
    state,
    start: () =>
      new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          assert(addr && typeof addr === "object");
          state.baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      }),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function makeClient(baseUrl: string) {
  return new ScysMcpClient({
    minIntervalMs: 0,
    maxRetries: 0,
    loadAuth: () => ({
      mcpUrl: `${baseUrl}/mcp`,
      clientId: "test-client",
      accessToken: "test-token",
      tokenEndpoint: `${baseUrl}/token`,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    saveAuth: () => {},
  });
}

const mock = startMockServer();

before(async () => {
  await mock.start();
  migrate();
  ensureSources();
  ensureScysOfficialReportTable();
});

beforeEach(() => {
  run("DELETE FROM scys_official_reports");
  run("DELETE FROM items");
  mock.state.dailyCalls = [];
  mock.state.aiFeedCalls = [];
});

after(async () => {
  await mock.stop();
  closeDb();
});

test("syncScysDailyReport stores official markdown, uses idempotent cache unless force=true", async () => {
  let version = 1;
  mock.state.dailyHandler = () => ({
    reportDate: "2026-11-26",
    edition: "DAILY",
    period: "11月26日（周四）",
    status: "COMPLETED",
    notice: "今日为测试公告提示",
    signals: [{ id: "s1", title: "海外 AI 工具涨价信号", oneLiner: "SaaS 定价权上移", url: "https://scys.com/s1", tags: ["AI"] }],
    highlights: [
      { id: "h1", title: "精华复盘 1", url: "https://scys.com/h1" },
      { id: "h2", title: "精华复盘 2", url: "https://scys.com/h2" },
    ],
    markdown: `# 生财日报 · 11月26日（周四） v${version}\n\n正文内容`,
  });

  const client = makeClient(mock.state.baseUrl);
  const first = await syncScysDailyReport({ client });
  assert.equal(first.reportDate, "2026-11-26");
  assert.equal(first.edition, "DAILY");
  assert.equal(first.period, "11月26日（周四）");
  assert.equal(first.notice, "今日为测试公告提示");
  assert.equal(first.signalCount, 1);
  assert.equal(first.highlightCount, 2);
  assert.match(first.markdown, /v1/);

  // Querying by explicit reportDate with force=false returns cached DB record without calling MCP
  version = 2;
  const cached = await syncScysDailyReport({ reportDate: "2026-11-26", client });
  assert.equal(mock.state.dailyCalls.length, 1);
  assert.match(cached.markdown, /v1/);

  // force=true refreshes from MCP
  const refreshed = await syncScysDailyReport({ reportDate: "2026-11-26", force: true, client });
  assert.equal(mock.state.dailyCalls.length, 2);
  assert.match(refreshed.markdown, /v2/);

  const list = listScysOfficialReports(10);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.reportDate, "2026-11-26");
  const detail = getScysOfficialReport("2026-11-26");
  assert.ok(detail);
  assert.equal(Array.isArray(detail.structured.signals), true);
  assert.equal(detail.structured.markdown, undefined);
});

test("syncScysDailyReport synthesizes structured markdown fallback when official markdown is empty", async () => {
  mock.state.dailyHandler = () => ({
    reportDate: "2026-11-25",
    edition: "DAILY",
    period: "11月25日（周三）",
    status: "COMPLETED",
    signals: [{ id: "s1", title: "小红书虚拟资料爆款", oneLiner: "客单 39 元", url: "https://scys.com/s1", tags: ["小红书"] }],
    highlights: [{ id: "h1", title: "私域成交 SOP", url: "https://scys.com/h1" }],
    discussions: [{ id: "d1", title: "投流 ROI 讨论", oneLiner: "自然流先跑通", url: "https://scys.com/d1" }],
    groupChatThemes: [{ id: "g1", title: "AI 工作流答疑", category: "AI", summary: "多 Agent 协同", qa: ["如何控成本？"] }],
    hotSkills: [{ id: "k1", title: "Claude Code 自动化", oneLiner: "脚本提效", url: "https://scys.com/k1", tags: ["效率"], source: "生财" }],
    markdown: "",
  });

  const client = makeClient(mock.state.baseUrl);
  const detail = await syncScysDailyReport({ reportDate: "2026-11-25", client });
  assert.match(detail.markdown, /## 今日信号/);
  assert.match(detail.markdown, /小红书虚拟资料爆款/);
  assert.match(detail.markdown, /## 今日精华/);
  assert.match(detail.markdown, /## 圈友在讨论/);
  assert.match(detail.markdown, /## 群聊主题/);
  assert.match(detail.markdown, /如何控成本？/);
  assert.match(detail.markdown, /## 热门技能/);
});

test("syncScysDailyReport rejects invalid date format and empty/ungenerated report", async () => {
  const client = makeClient(mock.state.baseUrl);
  await assert.rejects(() => syncScysDailyReport({ reportDate: "2026/11/25", client }), /YYYY-MM-DD/);

  mock.state.dailyHandler = () => ({
    reportDate: "2026-11-24",
    status: "NOT_GENERATED",
    signals: [],
    highlights: [],
    markdown: "",
  });
  await assert.rejects(() => syncScysDailyReport({ reportDate: "2026-11-24", client }), /尚未生成或内容为空/);
  assert.equal(getScysOfficialReport("2026-11-24"), null);
});

test("backfillScysDailyReports handles latest, weekend fallback, deduplication, and skips missing days", async () => {
  // Assume today is Friday 2026-11-27, days=6 covers:
  // offset 1: 2026-11-26 (Thu)
  // offset 2: 2026-11-25 (Wed) -> pre-cached to verify skip
  // offset 3: 2026-11-24 (Tue) -> throws missing error, gracefully skipped
  // offset 4: 2026-11-23 (Mon)
  // offset 5: 2026-11-22 (Sun) -> DAILY fails, falls back to edition=WEEKEND
  // offset 6: 2026-11-21 (Sat) -> WEEKEND maps to 2026-11-22, deduplicated
  const client = makeClient(mock.state.baseUrl);

  mock.state.dailyHandler = () => ({
    reportDate: "2026-11-25",
    edition: "DAILY",
    markdown: "# 预先缓存的 25 日日报",
  });
  await syncScysDailyReport({ reportDate: "2026-11-25", client });
  mock.state.dailyCalls = [];

  mock.state.dailyHandler = ({ reportDate, edition }) => {
    if (!reportDate) {
      return { reportDate: "2026-11-26", edition: "DAILY", period: "11月26日（周四）", markdown: "# 最新日报 26" };
    }
    if (reportDate === "2026-11-24") {
      throw new Error("report not generated yet");
    }
    if (reportDate === "2026-11-23") {
      return { reportDate: "2026-11-23", edition: "DAILY", markdown: "# 日报 23" };
    }
    if (reportDate === "2026-11-22") {
      if (edition !== "WEEKEND") throw new Error("weekend requires WEEKEND edition");
      return { reportDate: "2026-11-22", edition: "WEEKEND", period: "11月21日-22日", markdown: "# 周末合辑" };
    }
    if (reportDate === "2026-11-21") {
      if (edition !== "WEEKEND") throw new Error("weekend requires WEEKEND edition");
      return { reportDate: "2026-11-22", edition: "WEEKEND", period: "11月21日-22日", markdown: "# 周末合辑" };
    }
    throw new Error(`unexpected date ${reportDate}`);
  };

  const logs: string[] = [];
  const res = await backfillScysDailyReports({
    days: 6,
    today: "2026-11-27",
    client,
    log: (m) => logs.push(m),
  });

  assert.equal(res.latestDate, "2026-11-26");
  assert.equal(res.synced, 3); // 26, 23, 22
  assert.equal(res.failed, 0);
  assert.equal(logs.some((l) => l.includes("2026-11-24")), true);

  const list = listScysOfficialReports(10);
  assert.deepEqual(
    list.map((r) => r.reportDate),
    ["2026-11-26", "2026-11-25", "2026-11-23", "2026-11-22"],
  );
  // 2026-11-25 was never re-fetched from MCP
  assert.equal(mock.state.dailyCalls.some((c) => c.reportDate === "2026-11-25"), false);
});

test("backfillScysDailyReports rethrows ScysAuthError immediately", async () => {
  const authFailClient = new ScysMcpClient({
    minIntervalMs: 0,
    loadAuth: () => null,
  });
  await assert.rejects(() => backfillScysDailyReports({ days: 3, client: authFailClient }), ScysAuthError);
});

test("parseAiFeedPublishedAt infers year for MM-DD HH:mm and rolls back across year boundary", () => {
  const refSameYear = new Date("2026-11-27T10:00:00Z");
  assert.equal(parseAiFeedPublishedAt("11-21 10:05", refSameYear), "2026-11-21T02:05:00.000Z");

  const refNewYear = new Date("2027-01-02T04:00:00Z");
  assert.equal(parseAiFeedPublishedAt("12-30 22:15", refNewYear), "2026-12-30T14:15:00.000Z");
});

test("scysAiFeedCollector maps live ai__listAiFeedItems fields, handles missing URL, and ingests idempotently", async () => {
  mock.state.aiFeedHandler = () => ({
    count: 2,
    items: [
      {
        candidateId: 3290,
        title: "@gregisenberg 的 AI 动态获得 109 次点赞",
        summary: "原文核心信息是海外 AI SaaS 案例汇总",
        detail: "X 上的高互动说明微创业方向仍有需求。",
        opportunity: "可做垂直行业模板库",
        signals: ["推特", "出海"],
        sourceName: "Twitter · @gregisenberg",
        sourceUrl: "https://x.com/gregisenberg/status/2123943441017028866",
        publishedAt: "11-21 10:05",
        tag: "AI线索",
      },
      {
        candidateId: 3291,
        title: "无外链纯情报条目",
        summary: "内部整理的一手 AI 工具动向",
        detail: "补充详情内容",
        sourceName: "生财 AI 组",
        sourceUrl: "",
        publishedAt: "11-26 09:00",
        tag: "工具雷达",
      },
    ],
  });

  const collector = createScysAiFeedCollector(() => makeClient(mock.state.baseUrl));
  const collected = await collector.collect({
    sourceId: "scys-ai-feed",
    config: { limit: 80 }, // clamped to 50
    cursor: null,
    maxItems: 50,
    http: createHttp({ gapMs: 0 }),
    log: () => {},
  });

  assert.equal(mock.state.aiFeedCalls[0]?.limit, 50);
  assert.equal(collected.items.length, 2);

  const first = collected.items[0]!;
  assert.equal(first.externalId, "scys-aifeed-3290");
  assert.equal(first.url, "https://x.com/gregisenberg/status/2123943441017028866");
  assert.equal(first.author, "Twitter · @gregisenberg");
  assert.equal(first.categoryHint, "ai");
  assert.equal(first.kindHint, "info");
  assert.ok(first.publishedAt);
  assert.deepEqual(first.tags, ["AI线索", "推特", "出海"]);
  assert.match(first.content ?? "", /^【来源】生财 AI 情报流/);
  assert.match(first.content ?? "", /可做垂直行业模板库/);

  const second = collected.items[1]!;
  assert.equal(second.externalId, "scys-aifeed-3291");
  assert.equal(second.url, "https://scys.com/ai-feed/3291");

  run(
    `INSERT OR IGNORE INTO sources (id, name, kind, enabled, config, interval_sec, created_at)
     VALUES ('scys-ai-feed', '生财有术 · 官方 AI 情报流', 'scys-ai-feed', 1, '{}', 3600, ?)`,
    new Date().toISOString(),
  );
  const saved1 = ingestItems("scys-ai-feed", collected.items);
  assert.equal(saved1.inserted, 2);
  const saved2 = ingestItems("scys-ai-feed", collected.items);
  assert.equal(saved2.inserted, 0);
  assert.equal(saved2.skipped, 2);

  const row1 = get<{ category: string; kind: string; external_id: string }>(
    "SELECT category, kind, external_id FROM items WHERE external_id = 'scys-aifeed-3290'",
  );
  assert.ok(row1);
  assert.equal(row1.kind, "info");

  const row2 = get<{ category: string; kind: string; external_id: string }>(
    "SELECT category, kind, external_id FROM items WHERE external_id = 'scys-aifeed-3291'",
  );
  assert.ok(row2);
  assert.equal(row2.category, "ai");
  assert.equal(row2.kind, "info");
});

test("HTTP routes & registry: daily-reports public GET, admin POST sync validation, and new collectors registered", async () => {
  assert.ok(COLLECTORS.some((c) => c.kind === "scys-trusted"));
  assert.ok(COLLECTORS.some((c) => c.kind === "scys-ai-feed"));
  assert.equal(SEEDS.find((s) => s.id === "scys-trusted")?.enabled, true);
  assert.equal(SEEDS.find((s) => s.id === "scys-ai-feed")?.enabled, true);

  const app = new Hono();
  registerApi(app);

  // Put mock OAuth auth in :memory: settings so POST /api/scys/daily-reports/sync hits local mock server
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    SCYS_AUTH_SETTINGS_KEY,
    JSON.stringify({
      mcpUrl: `${mock.state.baseUrl}/mcp`,
      clientId: "route-test-client",
      accessToken: "route-test-token",
      tokenEndpoint: `${mock.state.baseUrl}/token`,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    new Date().toISOString(),
  );

  mock.state.dailyHandler = ({ reportDate }) => ({
    reportDate: reportDate || "2026-11-26",
    edition: "DAILY",
    period: "11月26日（周四）",
    status: "COMPLETED",
    signals: [{ id: "s1", title: "路由联调信号", oneLiner: "测试", url: "https://scys.com/s1", tags: ["AI"] }],
    highlights: [{ id: "h1", title: "路由联调精华", url: "https://scys.com/h1" }],
    markdown: "# 生财日报 · 路由测试\n\n测试正文",
  });

  const prevAdminToken = config.adminToken;
  (config as { adminToken: string }).adminToken = "secret-admin-tok";
  try {
    // Public GET works without admin token
    const emptyListRes = await app.request("/api/scys/daily-reports");
    assert.equal(emptyListRes.status, 200);
    const emptyListJson = (await emptyListRes.json()) as { reports: unknown[] };
    assert.deepEqual(emptyListJson.reports, []);

    const badDateRes = await app.request("/api/scys/daily-reports/not-a-date");
    assert.equal(badDateRes.status, 400);

    const missingDateRes = await app.request("/api/scys/daily-reports/2026-11-01");
    assert.equal(missingDateRes.status, 404);

    // Admin POST requires ADMIN_TOKEN
    const unauthSyncRes = await app.request("/api/scys/daily-reports/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(unauthSyncRes.status, 401);

    // Parameter validation errors with valid ADMIN_TOKEN
    const authHeaders = {
      "content-type": "application/json",
      authorization: "Bearer secret-admin-tok",
    };
    const badDaysRes = await app.request("/api/scys/daily-reports/sync", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ days: 30 }),
    });
    assert.equal(badDaysRes.status, 400);

    const badEditionRes = await app.request("/api/scys/daily-reports/sync", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ edition: "MONTHLY" }),
    });
    assert.equal(badEditionRes.status, 400);

    const conflictRes = await app.request("/api/scys/daily-reports/sync", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ reportDate: "2026-11-26", days: 3 }),
    });
    assert.equal(conflictRes.status, 400);

    // Valid POST sync succeeds
    const syncRes = await app.request("/api/scys/daily-reports/sync", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(syncRes.status, 200);
    const syncJson = (await syncRes.json()) as { ok: boolean; synced: number; latestDate: string; reports: Array<{ reportDate: string }> };
    assert.equal(syncJson.ok, true);
    assert.equal(syncJson.synced, 1);
    assert.equal(syncJson.latestDate, "2026-11-26");
    assert.equal(syncJson.reports.length, 1);

    // Public GET detail now returns the synced report
    const detailRes = await app.request("/api/scys/daily-reports/2026-11-26");
    assert.equal(detailRes.status, 200);
    const detailJson = (await detailRes.json()) as { report: { reportDate: string; markdown: string } };
    assert.equal(detailJson.report.reportDate, "2026-11-26");
    assert.match(detailJson.report.markdown, /路由测试/);
  } finally {
    (config as { adminToken: string }).adminToken = prevAdminToken;
    run("DELETE FROM settings WHERE key = ?", SCYS_AUTH_SETTINGS_KEY);
  }
});
