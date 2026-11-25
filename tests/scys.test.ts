import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, beforeEach, test } from "node:test";

process.env.DATABASE_PATH = ":memory:";

const { migrate, run, get, closeDb } = await import("../src/server/db.ts");
const { ensureSources, ingestItems } = await import("../src/server/collectors/index.ts");
const {
  buildToolArgs,
  discoverOAuthMetadata,
  exchangeAuthorizationCode,
  generatePkce,
  refreshScysAccessToken,
  registerDynamicClient,
  saveScysAuth,
  loadScysAuth,
  ScysAuthError,
  ScysMcpClient,
  ScysToolBlockedError,
} = await import("../src/server/scys/mcp-client.ts");
const { createScysCollector } = await import("../src/server/collectors/scys.ts");

type MockServerState = {
  baseUrl: string;
  sseMode: boolean;
  rateLimitOnce: boolean;
  rejectRefresh: boolean;
  expireSessionOnce: boolean;
  alwaysExpireSession: boolean;
  initializeCount: number;
  sessionCounter: number;
  tokenCount: number;
  handoffPolls: number;
  topicDetailCalls: string[];
  lastSearchArgs: Record<string, unknown> | null;
  lastSessionIdSeen: string | null;
  lastCodeChallenge: string | null;
};

async function readJsonBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function startMockScysServer() {
  const state: MockServerState = {
    baseUrl: "",
    sseMode: false,
    rateLimitOnce: false,
    rejectRefresh: false,
    expireSessionOnce: false,
    alwaysExpireSession: false,
    initializeCount: 0,
    sessionCounter: 1,
    tokenCount: 0,
    handoffPolls: 0,
    topicDetailCalls: [],
    lastSearchArgs: null,
    lastSessionIdSeen: null,
    lastCodeChallenge: null,
  };

  let currentAccessToken = "access-token-1";
  let currentRefreshToken = "refresh-token-1";

  const toolSchemas = [
    {
      name: "searchTopic",
      description: "Search topics",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string" },
          limit: { type: "number" },
          pageNo: { type: "number" },
          essenceOnly: { type: "boolean" },
          sort: { type: "string", enum: ["hot", "highlight", "latest"] },
          compact: { type: "boolean" },
        },
      },
    },
    {
      name: "topicDetail",
      description: "Get topic detail",
      inputSchema: {
        type: "object",
        properties: {
          topicId: { type: "string" },
        },
        required: ["topicId"],
      },
    },
    {
      name: "projectLibSearch",
      description: "Search project library",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          pageSize: { type: "number" },
        },
      },
    },
    {
      name: "projectLibDetail",
      description: "Get project detail",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" } },
      },
    },
    {
      name: "activityManualToc",
      description: "Get manual TOC",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "activityManualDetail",
      description: "Get manual detail",
      inputSchema: {
        type: "object",
        properties: { manualId: { type: "string" } },
      },
    },
    {
      name: "addFavorite",
      description: "Write tool that must be blocked",
      inputSchema: { type: "object", properties: { topicId: { type: "string" } } },
    },
  ];

  const server = createServer(async (req, res) => {
    const u = new URL(req.url || "/", "http://127.0.0.1");

    if (req.method === "GET" && u.pathname === "/shengcai-web/mcp") {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="${state.baseUrl}/.well-known/oauth-protected-resource", scope="mcp"`,
      });
      res.end(JSON.stringify({ error: "invalid_token" }));
      return;
    }

    if (req.method === "GET" && u.pathname === "/.well-known/oauth-protected-resource") {
      sendJson(res, 200, {
        resource: `${state.baseUrl}/shengcai-web/mcp`,
        resource_name: "Mock 生财有术 MCP",
        authorization_servers: [`${state.baseUrl}/mcp-oauth`],
        scopes_supported: ["mcp"],
      });
      return;
    }

    if (req.method === "GET" && u.pathname === "/.well-known/oauth-authorization-server/mcp-oauth") {
      sendJson(res, 200, {
        issuer: `${state.baseUrl}/mcp-oauth`,
        authorization_endpoint: `${state.baseUrl}/mcp-oauth/authorize`,
        authorization_handoff_endpoint: `${state.baseUrl}/mcp-oauth/authorization-handoff`,
        token_endpoint: `${state.baseUrl}/mcp-oauth/token`,
        registration_endpoint: `${state.baseUrl}/mcp-oauth/register`,
        scopes_supported: ["mcp"],
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }

    if (req.method === "POST" && u.pathname === "/mcp-oauth/register") {
      const body = JSON.parse(await readJsonBody(req)) as { redirect_uris?: string[] };
      assert.ok(Array.isArray(body.redirect_uris) && body.redirect_uris.length > 0);
      sendJson(res, 201, { client_id: "mock-client-123", client_secret: "mock-secret-456" });
      return;
    }

    if (req.method === "POST" && u.pathname === "/mcp-oauth/authorization-handoff") {
      state.handoffPolls += 1;
      if (state.handoffPolls === 1) {
        sendJson(res, 202, { status: "pending" });
        return;
      }
      sendJson(res, 200, {
        callback_uri: `http://127.0.0.1:9999/callback?code=mock-auth-code&state=test-state`,
      });
      return;
    }

    if (req.method === "POST" && u.pathname === "/mcp-oauth/token") {
      const form = new URLSearchParams(await readJsonBody(req));
      const grantType = form.get("grant_type");
      if (grantType === "authorization_code") {
        const verifier = form.get("code_verifier") || "";
        const computed = createHash("sha256").update(verifier).digest("base64url");
        if (state.lastCodeChallenge && computed !== state.lastCodeChallenge) {
          sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE mismatch" });
          return;
        }
        state.tokenCount += 1;
        currentAccessToken = `access-token-${state.tokenCount}`;
        currentRefreshToken = `refresh-token-${state.tokenCount}`;
        sendJson(res, 200, {
          access_token: currentAccessToken,
          refresh_token: currentRefreshToken,
          expires_in: 3600,
          token_type: "Bearer",
          scope: "mcp",
        });
        return;
      }
      if (grantType === "refresh_token") {
        if (state.rejectRefresh || form.get("refresh_token") !== currentRefreshToken) {
          sendJson(res, 400, { error: "invalid_grant", error_description: "refresh token expired" });
          return;
        }
        state.tokenCount += 1;
        currentAccessToken = `access-token-${state.tokenCount}`;
        currentRefreshToken = `refresh-token-${state.tokenCount}`;
        sendJson(res, 200, {
          access_token: currentAccessToken,
          refresh_token: currentRefreshToken,
          expires_in: 3600,
          token_type: "Bearer",
        });
        return;
      }
      sendJson(res, 400, { error: "unsupported_grant_type" });
      return;
    }

    if (req.method === "POST" && u.pathname === "/shengcai-web/mcp") {
      if (req.headers.authorization !== `Bearer ${currentAccessToken}`) {
        sendJson(res, 401, { error: "invalid_token" });
        return;
      }
      if (state.rateLimitOnce) {
        state.rateLimitOnce = false;
        sendJson(res, 429, { error: "rate_limited" }, { "retry-after": "0" });
        return;
      }
      const sess = req.headers["mcp-session-id"];
      if (typeof sess === "string") state.lastSessionIdSeen = sess;

      const rpc = JSON.parse(await readJsonBody(req)) as {
        id?: number;
        method: string;
        params?: Record<string, unknown>;
      };

      if (rpc.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }

      if (
        rpc.method !== "initialize" &&
        typeof sess === "string" &&
        (state.alwaysExpireSession || state.expireSessionOnce)
      ) {
        state.expireSessionOnce = false;
        sendJson(res, 404, { error: "session not found" });
        return;
      }

      let result: unknown;
      if (rpc.method === "initialize") {
        state.initializeCount += 1;
        state.sessionCounter = state.initializeCount;
        result = { protocolVersion: "2025-03-26", serverInfo: { name: "mock-scys", version: "1.0" } };
      } else if (rpc.method === "tools/list") {
        result = { tools: toolSchemas };
      } else if (rpc.method === "tools/call") {
        const name = String(rpc.params?.name ?? "");
        const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
        if (name === "searchTopic") {
          state.lastSearchArgs = args;
          result = {
            structuredContent: {
              list: [
                {
                  topicId: "t-1001",
                  title: "AI Agent 自动化副业月入过万拆解",
                  summary: "完整拆解工作流与变现路径",
                  author: "阿哲",
                  publishTime: "2026-11-24T10:00:00Z",
                  tags: ["AI", "风向标"],
                },
                {
                  topicId: "t-1002",
                  content: "今天实测了一个冷门信息差项目，不需要引流，直接对接本地商家就能跑通。附上完整报价单。",
                  author: "小满",
                  publishTime: "2026-11-25T02:00:00Z",
                },
              ],
            },
          };
        } else if (name === "topicDetail") {
          const tid = String(args.topicId ?? "");
          state.topicDetailCalls.push(tid);
          result = {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  topicId: tid,
                  content: `正文详情(${tid})：` + "实战步骤干货".repeat(30),
                  feishuContent: "飞书文档补充SOP与工具清单",
                  comments: [{ author: "亦仁", content: "这个切入点很扎实，值得复制" }],
                }),
              },
            ],
          };
        } else if (name === "projectLibSearch") {
          result = {
            structuredContent: {
              projects: [{ projectId: "p-201", title: "小红书虚拟资料矩阵项目", summary: "低成本自动化出单" }],
            },
          };
        } else if (name === "projectLibDetail") {
          result = {
            structuredContent: {
              projectId: args.projectId,
              content: "项目库详细步骤与成本收益测算",
            },
          };
        } else if (name === "activityManualToc") {
          result = {
            structuredContent: {
              toc: [
                {
                  title: "AI 工具实战航海",
                  children: [{ manualId: "m-301", title: "第一天：选品与定位" }],
                },
              ],
            },
          };
        } else if (name === "activityManualDetail") {
          result = {
            structuredContent: {
              manualId: args.manualId,
              content: "航海实战手册第一天正文详情",
            },
          };
        }
      }

      const activeSessionId = `mock-session-${state.sessionCounter}`;
      const payload = { jsonrpc: "2.0", id: rpc.id, result };
      if (state.sseMode) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "mcp-session-id": activeSessionId,
        });
        res.write(`: keepalive\n\nevent: message\ndata: ${JSON.stringify(payload)}\n\n`);
        res.end();
      } else {
        sendJson(res, 200, payload, { "mcp-session-id": activeSessionId });
      }
      return;
    }

    res.writeHead(404).end("Not Found");
  });

  return {
    state,
    start: () =>
      new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          assert.ok(addr && typeof addr !== "string");
          state.baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      }),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
    resetTokens: () => {
      currentAccessToken = "access-token-1";
      currentRefreshToken = "refresh-token-1";
      state.tokenCount = 1;
    },
  };
}

const mock = startMockScysServer();

before(async () => {
  migrate();
  await mock.start();
});

after(async () => {
  await mock.stop();
  closeDb();
});

beforeEach(() => {
  run("DELETE FROM settings WHERE key = 'scys_mcp_auth'");
  run("DELETE FROM items");
  mock.state.sseMode = false;
  mock.state.rateLimitOnce = false;
  mock.state.rejectRefresh = false;
  mock.state.expireSessionOnce = false;
  mock.state.alwaysExpireSession = false;
  mock.state.initializeCount = 0;
  mock.state.sessionCounter = 1;
  mock.state.handoffPolls = 0;
  mock.state.topicDetailCalls = [];
  mock.state.lastSearchArgs = null;
  mock.state.lastSessionIdSeen = null;
  mock.state.lastCodeChallenge = null;
  mock.resetTokens();
});

test("未授权时 scysCollector 抛出明确中文指引 (pnpm scys:auth)", async () => {
  const collector = createScysCollector(() => new ScysMcpClient({ minIntervalMs: 0 }));
  await assert.rejects(
    () =>
      collector.collect({
        sourceId: "scys-highlights",
        config: { mode: "highlights" },
        cursor: null,
        maxItems: 10,
        http: {} as never,
        log: () => {},
      }),
    (err: unknown) => err instanceof ScysAuthError && err.message.includes("pnpm scys:auth"),
  );
});

test("OAuth 2.1 发现（含路径型 issuer）、DCR、PKCE 与 authorization_handoff 轮询", async () => {
  const mcpUrl = `${mock.state.baseUrl}/shengcai-web/mcp`;
  const discovery = await discoverOAuthMetadata(mcpUrl);
  assert.equal(discovery.scope, "mcp");
  assert.equal(discovery.authServerMetadata.token_endpoint, `${mock.state.baseUrl}/mcp-oauth/token`);
  assert.equal(
    discovery.authServerMetadata.authorization_handoff_endpoint,
    `${mock.state.baseUrl}/mcp-oauth/authorization-handoff`,
  );

  const dcr = await registerDynamicClient(discovery.authServerMetadata.registration_endpoint!, "http://127.0.0.1:9999/callback");
  assert.equal(dcr.clientId, "mock-client-123");

  const pkce = generatePkce();
  assert.equal(pkce.codeChallengeMethod, "S256");
  mock.state.lastCodeChallenge = pkce.codeChallenge;

  // 模拟 handoff 轮询 2 次拿到 callback_uri
  const poll1 = await fetch(discovery.authServerMetadata.authorization_handoff_endpoint!, { method: "POST" });
  assert.equal(poll1.status, 202);
  const poll2 = await fetch(discovery.authServerMetadata.authorization_handoff_endpoint!, { method: "POST" });
  assert.equal(poll2.status, 200);
  const poll2Data = (await poll2.json()) as { callback_uri: string };
  const code = new URL(poll2Data.callback_uri).searchParams.get("code")!;

  const tokens = await exchangeAuthorizationCode({
    tokenEndpoint: discovery.authServerMetadata.token_endpoint!,
    clientId: dcr.clientId,
    clientSecret: dcr.clientSecret,
    code,
    redirectUri: "http://127.0.0.1:9999/callback",
    codeVerifier: pkce.codeVerifier,
  });
  assert.ok(tokens.accessToken);
  assert.ok(tokens.refreshToken);
});

test("Token 临近过期自动 refresh 并持久化轮换后的 refresh_token；400/401 刷新失败报中文错误", async () => {
  saveScysAuth({
    mcpUrl: `${mock.state.baseUrl}/shengcai-web/mcp`,
    clientId: "mock-client-123",
    clientSecret: "mock-secret-456",
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    expiresAt: new Date(Date.now() + 30_000).toISOString(), // < 2min -> auto refresh
    tokenEndpoint: `${mock.state.baseUrl}/mcp-oauth/token`,
    updatedAt: new Date().toISOString(),
  });

  const client = new ScysMcpClient({ minIntervalMs: 0 });
  const tools = await client.listTools();
  assert.ok(tools.length >= 6);

  const saved = loadScysAuth()!;
  assert.equal(saved.accessToken, "access-token-2");
  assert.equal(saved.refreshToken, "refresh-token-2");

  // 刷新被服务端拒绝 (400 invalid_grant)
  mock.state.rejectRefresh = true;
  await assert.rejects(
    () => refreshScysAccessToken(saved),
    (err: unknown) => err instanceof ScysAuthError && err.message.includes("pnpm scys:auth"),
  );
});

test("MCP Streamable HTTP 支持 SSE 帧解析、Session ID、429 Retry-After 退避与只读工具护栏", async () => {
  saveScysAuth({
    mcpUrl: `${mock.state.baseUrl}/shengcai-web/mcp`,
    clientId: "mock-client-123",
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    tokenEndpoint: `${mock.state.baseUrl}/mcp-oauth/token`,
    updatedAt: new Date().toISOString(),
  });

  mock.state.sseMode = true;
  mock.state.rateLimitOnce = true;

  const client = new ScysMcpClient({ minIntervalMs: 5 });
  const tools = await client.listTools();
  assert.ok(tools.some((t) => t.name === "searchTopic"));

  // 只读护栏：禁止调用写工具 addFavorite 与未知工具
  await assert.rejects(() => client.callTool("addFavorite", { topicId: "t-1001" }), ScysToolBlockedError);
  await assert.rejects(() => client.callTool("anchorTopic", { topicId: "t-1001" }), ScysToolBlockedError);

  const res = await client.callTool<{ list: unknown[] }>("searchTopic", { q: "AI" });
  assert.equal(res.list.length, 2);
  assert.equal(mock.state.lastSessionIdSeen, "mock-session-1");
});

test("动态 Schema 参数映射与 scysCollector 二段去重、无标题推导、飞书/评论拼接", async () => {
  saveScysAuth({
    mcpUrl: `${mock.state.baseUrl}/shengcai-web/mcp`,
    clientId: "mock-client-123",
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    tokenEndpoint: `${mock.state.baseUrl}/mcp-oauth/token`,
    updatedAt: new Date().toISOString(),
  });

  const collector = createScysCollector(() => new ScysMcpClient({ minIntervalMs: 0 }));

  // 第一次采集：2 条均抓取 detail
  const first = await collector.collect({
    sourceId: "scys-highlights",
    config: { mode: "highlights", pageSize: 10, fetchDetail: true, maxDetailPerRun: 8 },
    cursor: null,
    maxItems: 20,
    http: {} as never,
    log: () => {},
  });
  assert.equal(first.items.length, 2);
  assert.deepEqual(mock.state.topicDetailCalls, ["t-1001", "t-1002"]);
  // 验证动态 Schema 适配：mock schema 用了 q / limit / pageNo / essenceOnly / sort / compact
  assert.equal(mock.state.lastSearchArgs?.limit, 10);
  assert.equal(mock.state.lastSearchArgs?.essenceOnly, true);
  assert.equal(mock.state.lastSearchArgs?.sort, "highlight");
  assert.equal(mock.state.lastSearchArgs?.compact, true);

  // 验证无显式标题的 t-1002 自动从首句推导出标题，且合并了飞书文档和评论
  const item2 = first.items.find((i) => i.externalId === "scys-topic-t-1002")!;
  assert.ok(item2.title.includes("今天实测了一个冷门信息差项目"));
  assert.ok(item2.content?.includes("飞书文档补充SOP与工具清单"));
  assert.ok(item2.content?.includes("亦仁: 这个切入点很扎实"));
  assert.equal(item2.kindHint, "info");

  // 把 t-1001 写入数据库模拟已入库完整详情
  run(
    `INSERT INTO items (source_id, external_id, url, url_key, title, content, first_seen_at, last_seen_at)
     VALUES ('scys-highlights', 'scys-topic-t-1001', 'https://scys.com/topic/t-1001', 'scys.com/topic/t-1001', 'existing', '已有完整正文', datetime('now'), datetime('now'))`,
  );

  // 第二次采集：t-1001 已存在完整详情，Stage 2 仅抓取 t-1002，且 t-1001 输出 content=null 不覆盖库内详情！
  mock.state.topicDetailCalls = [];
  const second = await collector.collect({
    sourceId: "scys-highlights",
    config: { mode: "highlights", pageSize: 10, fetchDetail: true, maxDetailPerRun: 8 },
    cursor: null,
    maxItems: 20,
    http: {} as never,
    log: () => {},
  });
  assert.equal(second.items.length, 2);
  assert.deepEqual(mock.state.topicDetailCalls, ["t-1002"]);
  assert.equal(second.items.find((i) => i.externalId === "scys-topic-t-1001")?.content, null);

  // projects 与 manuals 模式
  const projects = await collector.collect({
    sourceId: "scys-projects",
    config: { mode: "projects", pageSize: 5 },
    cursor: null,
    maxItems: 10,
    http: {} as never,
    log: () => {},
  });
  assert.equal(projects.items[0]?.externalId, "scys-project-p-201");
  assert.ok(projects.items[0]?.content?.includes("项目库详细步骤"));

  const manuals = await collector.collect({
    sourceId: "scys-manuals",
    config: { mode: "manuals", pageSize: 5 },
    cursor: null,
    maxItems: 10,
    http: {} as never,
    log: () => {},
  });
  assert.equal(manuals.items[0]?.externalId, "scys-manual-m-301");
  assert.ok(manuals.items[0]?.content?.includes("航海实战手册第一天正文详情"));
});

test("buildToolArgs 限制 contentSearch 的 pageSize <= 5 并支持 toolArgs 覆盖", () => {
  const args = buildToolArgs(
    "contentSearch",
    [{ name: "contentSearch", inputSchema: { type: "object", properties: { query: { type: "string" }, pageSize: { type: "number" } } } }],
    { keyword: "AI 变现", pageSize: 20 },
    { pageSize: 3 },
  );
  assert.equal(args.query, "AI 变现");
  assert.equal(args.pageSize, 3);

  const clamped = buildToolArgs(
    "contentSearch",
    [{ name: "contentSearch", inputSchema: { type: "object", properties: { query: { type: "string" }, pageSize: { type: "number" } } } }],
    { keyword: "AI", pageSize: 20 },
  );
  assert.equal(clamped.pageSize, 5);
});

test("Mcp-Session-Id 会话失效 (HTTP 404) 时自动清空并重新 initialize 后重试一次且防死循环", async () => {
  saveScysAuth({
    mcpUrl: `${mock.state.baseUrl}/shengcai-web/mcp`,
    clientId: "mock-client-123",
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    tokenEndpoint: `${mock.state.baseUrl}/mcp-oauth/token`,
    updatedAt: new Date().toISOString(),
  });

  const client = new ScysMcpClient({ minIntervalMs: 0 });
  await client.listTools();
  assert.equal(mock.state.initializeCount, 1);

  // 服务端会话过期返回 404：应自动清空 sessionId、重新 initialize 并完成此次调用
  mock.state.expireSessionOnce = true;
  const res = await client.callTool<{ list: unknown[] }>("searchTopic", { q: "AI" });
  assert.equal(res.list.length, 2);
  assert.equal(mock.state.initializeCount, 2);
  assert.equal(mock.state.lastSessionIdSeen, "mock-session-2");

  // 若服务端重连后仍持续 404，仅重试一次后抛出异常，不会死循环
  mock.state.alwaysExpireSession = true;
  await assert.rejects(
    () => client.callTool("searchTopic", { q: "AI" }),
    (err: unknown) => err instanceof Error && err.message.includes("HTTP 404"),
  );
  assert.equal(mock.state.initializeCount, 3);
});

test("真实落库回归：二次采集不覆盖已有 items.content，且超限未抓详情条目下轮自动补抓", async () => {
  ensureSources();
  saveScysAuth({
    mcpUrl: `${mock.state.baseUrl}/shengcai-web/mcp`,
    clientId: "mock-client-123",
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    tokenEndpoint: `${mock.state.baseUrl}/mcp-oauth/token`,
    updatedAt: new Date().toISOString(),
  });

  const collector = createScysCollector(() => new ScysMcpClient({ minIntervalMs: 0 }));

  // 首轮 maxDetailPerRun=1：只抓 t-1001 详情，t-1002 因超限留待下轮补抓（输出 content=null）
  const run1 = await collector.collect({
    sourceId: "scys-highlights",
    config: { mode: "highlights", pageSize: 10, fetchDetail: true, maxDetailPerRun: 1 },
    cursor: null,
    maxItems: 20,
    http: {} as never,
    log: () => {},
  });
  assert.deepEqual(mock.state.topicDetailCalls, ["t-1001"]);
  assert.ok(run1.items.find((i) => i.externalId === "scys-topic-t-1001")?.content?.includes("飞书文档补充SOP与工具清单"));
  assert.equal(run1.items.find((i) => i.externalId === "scys-topic-t-1002")?.content, null);

  const persist1 = ingestItems("scys-highlights", run1.items);
  assert.equal(persist1.inserted, 2);

  const row1AfterRun1 = get<{ content: string | null }>(
    "SELECT content FROM items WHERE source_id = 'scys-highlights' AND external_id = 'scys-topic-t-1001'",
  )!;
  const row2AfterRun1 = get<{ content: string | null }>(
    "SELECT content FROM items WHERE source_id = 'scys-highlights' AND external_id = 'scys-topic-t-1002'",
  )!;
  assert.ok(row1AfterRun1.content?.includes("正文详情(t-1001)"));
  assert.equal(row2AfterRun1.content, null);

  // 次轮 maxDetailPerRun=1：t-1001 已有完整 content 跳过 Stage 2（output content=null 不覆盖库内详情）；
  // t-1002 库内 content 为 NULL，自动补抓 Stage 2 详情并落库！
  mock.state.topicDetailCalls = [];
  const run2 = await collector.collect({
    sourceId: "scys-highlights",
    config: { mode: "highlights", pageSize: 10, fetchDetail: true, maxDetailPerRun: 1 },
    cursor: null,
    maxItems: 20,
    http: {} as never,
    log: () => {},
  });
  assert.deepEqual(mock.state.topicDetailCalls, ["t-1002"]);
  assert.equal(run2.items.find((i) => i.externalId === "scys-topic-t-1001")?.content, null);
  assert.ok(run2.items.find((i) => i.externalId === "scys-topic-t-1002")?.content?.includes("正文详情(t-1002)"));

  const persist2 = ingestItems("scys-highlights", run2.items);
  assert.equal(persist2.skipped, 2);

  const row1AfterRun2 = get<{ content: string | null }>(
    "SELECT content FROM items WHERE source_id = 'scys-highlights' AND external_id = 'scys-topic-t-1001'",
  )!;
  const row2AfterRun2 = get<{ content: string | null }>(
    "SELECT content FROM items WHERE source_id = 'scys-highlights' AND external_id = 'scys-topic-t-1002'",
  )!;
  assert.equal(row1AfterRun2.content, row1AfterRun1.content, "二次采集不得覆盖已有完整 content");
  assert.ok(row2AfterRun2.content?.includes("正文详情(t-1002)"), "超限未抓详情条目应在下轮自动补抓并落库");
});
