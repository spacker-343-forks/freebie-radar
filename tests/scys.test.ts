import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, beforeEach, test } from "node:test";

Object.assign(process.env, {
  DATABASE_PATH: ":memory:",
  AI_BASE_URL: "",
  AI_MODEL: "",
  AI_API_KEY: "",
  PUSH_CHANNEL: "none",
  ENABLE_SCHEDULER: "false",
});

const { migrate, run, get, closeDb } = await import("../src/server/db.ts");
const { ensureSources, ingestItems } = await import("../src/server/collectors/index.ts");
const {
  addScysAuthSlot,
  buildToolArgs,
  discoverOAuthMetadata,
  exchangeAuthorizationCode,
  generatePkce,
  isReadOnlyScysTool,
  loadScysAuth,
  loadScysAuthPool,
  MAX_SCYS_AUTH_SLOTS,
  refreshScysAccessToken,
  registerDynamicClient,
  saveScysAuth,
  SCYS_AUTH_SETTINGS_KEY,
  ScysAuthError,
  ScysMcpClient,
  ScysToolBlockedError,
} = await import("../src/server/scys/mcp-client.ts");
const {
  createScysCollector,
  decodeScysInlineTags,
  formatStructuredProjectContent,
  parseScysTimestamp,
} = await import("../src/server/collectors/scys.ts");

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
  topicDetailCalls: Array<{ entityType?: unknown; entityId?: unknown; token: string }>;
  contentSearchCalls: Array<Record<string, unknown>>;
  searchTopicCalls: Array<Record<string, unknown>>;
  projectCasesCalls: Array<Record<string, unknown>>;
  lastSessionIdSeen: string | null;
  lastCodeChallenge: string | null;
  longTopicBodyById: Record<string, string>;
  validTokens: Set<string>;
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
    contentSearchCalls: [],
    searchTopicCalls: [],
    projectCasesCalls: [],
    lastSessionIdSeen: null,
    lastCodeChallenge: null,
    longTopicBodyById: {},
    validTokens: new Set(["access-token-1"]),
  };

  let validRefreshTokens = new Set(["refresh-token-1", "refresh-token-slot-2"]);

  const toolSchemas = [
    {
      name: "contentSearch",
      description: "Partition search",
      inputSchema: {
        type: "object",
        properties: {
          keyword: { type: "string" },
          pageIndex: { type: "integer" },
          pageSize: { type: "integer" },
          pageScene: { type: "string", enum: ["all", "good", "winBid", "topic", "fxb", "square"] },
          displayMode: { type: "integer" },
          orderBy: { type: "string", enum: ["gmt_create", "gmt_digested", "gmt_win_bid"] },
        },
        additionalProperties: false,
      },
    },
    {
      name: "searchTopic",
      description: "Search topics",
      inputSchema: {
        type: "object",
        properties: {
          keyword: { type: "string" },
          pageIndex: { type: "integer" },
          pageSize: { type: "integer" },
          isHot: { type: "boolean" },
          isDigested: { type: "boolean" },
          displayMode: { type: "integer" },
          gmtCreateStart: { type: "integer" },
          gmtCreateEnd: { type: "integer" },
          orderBy: { type: "string", enum: ["gmt_create", "gmt_digested", "gmt_win_bid"] },
        },
        additionalProperties: false,
      },
    },
    {
      name: "topicDetail",
      description: "Get topic detail",
      inputSchema: {
        type: "object",
        properties: {
          entityType: { type: "string" },
          entityId: { type: "string" },
        },
        required: ["entityType", "entityId"],
        additionalProperties: false,
      },
    },
    {
      name: "searchProjectCases",
      description: "Search project cases",
      inputSchema: {
        type: "object",
        properties: {
          keyword: { type: "string" },
          sortType: { type: "string" },
          pageIndex: { type: "integer" },
          pageSize: { type: "integer" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "projectLibSearch",
      description: "Search project library",
      inputSchema: {
        type: "object",
        properties: {
          keyword: { type: "string" },
          pageIndex: { type: "integer" },
          pageSize: { type: "integer" },
        },
        required: ["keyword"],
        additionalProperties: false,
      },
    },
    {
      name: "projectLibDetail",
      description: "Get project detail",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
        additionalProperties: false,
      },
    },
    {
      name: "activityList",
      description: "List activities",
      inputSchema: {
        type: "object",
        properties: {
          pageIndex: { type: "integer" },
          pageSize: { type: "integer" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "activityManualToc",
      description: "Get manual TOC",
      inputSchema: {
        type: "object",
        properties: {
          activityId: { type: "string" },
          courseId: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "activityManualDetail",
      description: "Get manual detail",
      inputSchema: {
        type: "object",
        properties: {
          activityId: { type: "string" },
          courseId: { type: "string" },
          itemId: { type: "string" },
        },
        required: ["itemId"],
        additionalProperties: false,
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
        const tok = `access-token-${state.tokenCount}`;
        const refTok = `refresh-token-${state.tokenCount}`;
        state.validTokens.add(tok);
        validRefreshTokens.add(refTok);
        sendJson(res, 200, {
          access_token: tok,
          refresh_token: refTok,
          expires_in: 3600,
          token_type: "Bearer",
          scope: "mcp",
        });
        return;
      }
      if (grantType === "refresh_token") {
        const offered = form.get("refresh_token") || "";
        if (state.rejectRefresh || !validRefreshTokens.has(offered)) {
          sendJson(res, 400, { error: "invalid_grant", error_description: "refresh token expired" });
          return;
        }
        validRefreshTokens.delete(offered);
        state.tokenCount += 1;
        const tok = `access-token-${state.tokenCount}`;
        const refTok = `refresh-token-${state.tokenCount}`;
        state.validTokens.add(tok);
        validRefreshTokens.add(refTok);
        sendJson(res, 200, {
          access_token: tok,
          refresh_token: refTok,
          expires_in: 3600,
          token_type: "Bearer",
        });
        return;
      }
      sendJson(res, 400, { error: "unsupported_grant_type" });
      return;
    }

    if (req.method === "POST" && u.pathname === "/shengcai-web/mcp") {
      const authHeader = req.headers.authorization || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!state.validTokens.has(token)) {
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

        if (name === "contentSearch") {
          state.contentSearchCalls.push(args);
          const scene = String(args.pageScene ?? "good");
          if (scene === "fxb") {
            result = {
              structuredContent: {
                topicDetailDTO: {
                  items: [
                    {
                      detailUrl: "https://scys.com/articleDetail/xq_topic/1002",
                      topicDTO: {
                        entityType: "xq_topic",
                        entityId: "1002",
                        gmtCreate: 1795529820,
                        articleContent:
                          '<e type="text_bold" title="%E4%BB%8A%E5%A4%A9%E5%AE%9E%E6%B5%8B%E4%BA%86%E4%B8%80%E4%B8%AA%E5%86%B7%E9%97%A8%E4%BF%A1%E6%81%AF%E5%B7%AE%E9%A1%B9%E7%9B%AE" />%E5%86%85%E5%AE%B9',
                        menuList: [{ key: 1, value: "风向标" }],
                      },
                      topicUserDTO: { name: "小满" },
                    },
                  ],
                },
              },
            };
          } else {
            result = {
              structuredContent: {
                topicDetailDTO: {
                  items: [
                    {
                      detailUrl: "https://scys.com/articleDetail/xq_topic/1001",
                      topicDTO: {
                        entityType: "xq_topic",
                        entityId: "1001",
                        showTitle: "AI Agent 自动化副业月入过万拆解",
                        gmtCreate: 1795520000,
                        articleContent: "完整拆解工作流与变现路径",
                        menuList: [{ key: 2428701, value: "官方活动" }, { key: 2, value: "精华" }],
                        miniImageList: ["https://scys.com/img/cover-1001.png"],
                      },
                      topicUserDTO: { name: "阿哲" },
                    },
                  ],
                },
              },
            };
          }
        } else if (name === "searchTopic") {
          state.searchTopicCalls.push(args);
          result = {
            structuredContent: {
              items: [
                {
                  topicDTO: {
                    entityType: "forum_topic",
                    entityId: "1003",
                    highlightShowTitle: "最新开源自动化工具实测",
                    gmtCreate: 1795531000,
                    articleContent: "无需手动操作，一键部署运行。",
                    menuList: [{ key: 3, value: "AI实战" }],
                  },
                  topicUserDTO: { name: "阿南" },
                },
              ],
            },
          };
        } else if (name === "topicDetail") {
          assert.equal("topicId" in args, false, "topicDetail 不允许传 topicId (additionalProperties: false)");
          assert.ok(args.entityType && args.entityId, "topicDetail 必须传 entityType 和 entityId");
          state.topicDetailCalls.push({ entityType: args.entityType, entityId: args.entityId, token });
          const eid = String(args.entityId);
          const customBody = state.longTopicBodyById[eid];
          result = {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  topicDTO: {
                    entityType: args.entityType,
                    entityId: eid,
                    articleContent:
                      customBody ??
                      `正文详情(${eid})：` +
                        '<e type="text_bold" title="%E3%80%8C%E6%A0%B8%E5%BF%83%E6%96%B9%E6%B3%95%E3%80%8D" /> ' +
                        '<e type="web" href="https%3A%2F%2Fscys.com%2Fdoc%2F1" title="%E5%AE%9E%E6%88%98SOP" /> ' +
                        '<e type="hashtag" title="%23AI%E5%89%AF%E4%B8%9A%23" />',
                  },
                  documentList: [{ title: "飞书补充表", content: "飞书文档补充SOP与工具清单" }],
                  topicCommentDTOList: [
                    { commentUserDTO: { name: "亦仁" }, content: '<e type="mention" title="%40%E9%98%BF%E5%93%B2" /> 这个切入点很扎实' },
                  ],
                }),
              },
            ],
          };
        } else if (name === "searchProjectCases") {
          state.projectCasesCalls.push(args);
          result = {
            structuredContent: {
              items: [
                {
                  projectId: 201,
                  name: "小红书虚拟资料矩阵项目",
                  summary: "低成本自动化出单",
                  incomeMin: 3000,
                  incomeMax: 15000,
                  dailyMinutes: 60,
                  estimatedCost: 200,
                  publishedAt: 1795529820,
                  platformMenus: [{ name: "小红书" }],
                  monetizeMenus: [{ name: "虚拟产品" }],
                  crowdMenus: [{ name: "新手友好" }],
                },
              ],
            },
          };
        } else if (name === "projectLibDetail") {
          assert.ok(typeof args.projectId === "string");
          result = {
            structuredContent: {
              projectId: args.projectId,
              description: "项目概述：适合个人低成本冷启动。",
              content: [
                {
                  key: "worth_reason",
                  value: [{ key: "核心壁垒", value: "选品库沉淀与自动化回复流程" }],
                },
                {
                  key: "profit_model",
                  value: "单份资料定价 19.9~39.9 元，配合自动发货实现纯利润变现。",
                },
              ],
            },
          };
        } else if (name === "activityList") {
          result = {
            structuredContent: {
              items: [{ id: "88", name: "2026年11月 AI 实战航海" }],
            },
          };
        } else if (name === "activityManualToc") {
          assert.ok(args.activityId || args.courseId, "activityManualToc 必须传 activityId 或 courseId");
          result = {
            structuredContent: {
              items: [
                {
                  title: "AI 工具实战航海",
                  children: [{ itemId: "301", title: "第一天：选品与定位", hasContent: true }],
                },
              ],
            },
          };
        } else if (name === "activityManualDetail") {
          assert.ok(args.itemId, "activityManualDetail 必须传 itemId");
          result = {
            structuredContent: {
              itemId: args.itemId,
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
      state.validTokens = new Set(["access-token-1", "access-token-slot-2"]);
      validRefreshTokens = new Set(["refresh-token-1", "refresh-token-slot-2"]);
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
  mock.state.contentSearchCalls = [];
  mock.state.searchTopicCalls = [];
  mock.state.projectCasesCalls = [];
  mock.state.lastSessionIdSeen = null;
  mock.state.lastCodeChallenge = null;
  mock.state.longTopicBodyById = {};
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

test("向后兼容旧版单对象 scys_mcp_auth，并支持 addScysAuthSlot 追加多槽位（上限 5）", () => {
  const legacySingle = {
    mcpUrl: `${mock.state.baseUrl}/shengcai-web/mcp`,
    clientId: "legacy-client",
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    tokenEndpoint: `${mock.state.baseUrl}/mcp-oauth/token`,
    cachedToolSchemas: [{ name: "contentSearch" }],
    updatedAt: new Date().toISOString(),
  };
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
    SCYS_AUTH_SETTINGS_KEY,
    JSON.stringify(legacySingle),
  );

  const pool1 = loadScysAuthPool()!;
  assert.equal(pool1.slots.length, 1);
  assert.equal(pool1.slots[0]!.clientId, "legacy-client");
  assert.equal(pool1.cachedToolSchemas?.length, 1);
  assert.equal(loadScysAuth()?.clientId, "legacy-client");

  for (let i = 2; i <= MAX_SCYS_AUTH_SLOTS; i += 1) {
    const { pool, slotIndex } = addScysAuthSlot({
      mcpUrl: `${mock.state.baseUrl}/shengcai-web/mcp`,
      clientId: `client-${i}`,
      accessToken: `access-token-${i}`,
      refreshToken: `refresh-token-${i}`,
      tokenEndpoint: `${mock.state.baseUrl}/mcp-oauth/token`,
      updatedAt: new Date().toISOString(),
    });
    assert.equal(slotIndex, i - 1);
    assert.equal(pool.slots.length, i);
  }

  assert.throws(
    () =>
      addScysAuthSlot({
        mcpUrl: `${mock.state.baseUrl}/shengcai-web/mcp`,
        clientId: "client-6",
        accessToken: "access-token-6",
        tokenEndpoint: `${mock.state.baseUrl}/mcp-oauth/token`,
        updatedAt: new Date().toISOString(),
      }),
    ScysAuthError,
  );
});

test("相同 clientId 但不同 accessToken/refreshToken 的多槽位追加与独立刷新互不覆盖", async () => {
  saveScysAuth({
    slotId: "slot-a",
    mcpUrl: `${mock.state.baseUrl}/shengcai-web/mcp`,
    clientId: "shared-dcr-client",
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    tokenEndpoint: `${mock.state.baseUrl}/mcp-oauth/token`,
    updatedAt: new Date().toISOString(),
  });
  addScysAuthSlot({
    slotId: "slot-b",
    mcpUrl: `${mock.state.baseUrl}/shengcai-web/mcp`,
    clientId: "shared-dcr-client",
    accessToken: "access-token-slot-2",
    refreshToken: "refresh-token-slot-2",
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    tokenEndpoint: `${mock.state.baseUrl}/mcp-oauth/token`,
    updatedAt: new Date().toISOString(),
  });
  addScysAuthSlot({
    slotId: "slot-c",
    mcpUrl: `${mock.state.baseUrl}/shengcai-web/mcp`,
    clientId: "shared-dcr-client",
    accessToken: "access-token-slot-3",
    refreshToken: "refresh-token-slot-3",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    tokenEndpoint: `${mock.state.baseUrl}/mcp-oauth/token`,
    updatedAt: new Date().toISOString(),
  });

  const beforePool = loadScysAuthPool()!;
  assert.equal(beforePool.slots.length, 3, "同 clientId 的独立会话必须追加而不被覆盖");

  // 单独刷新第 2 个槽位，不得误覆盖槽位 1 或槽位 3
  const refreshedSlot2 = await refreshScysAccessToken(beforePool.slots[1]!, fetch, true);
  assert.equal(refreshedSlot2.accessToken, "access-token-2");
  assert.equal(refreshedSlot2.refreshToken, "refresh-token-2");

  const afterPool = loadScysAuthPool()!;
  assert.equal(afterPool.slots.length, 3);
  assert.equal(afterPool.slots[0]!.accessToken, "access-token-1");
  assert.equal(afterPool.slots[0]!.refreshToken, "refresh-token-1");
  assert.equal(afterPool.slots[1]!.accessToken, "access-token-2");
  assert.equal(afterPool.slots[1]!.refreshToken, "refresh-token-2");
  assert.equal(afterPool.slots[2]!.accessToken, "access-token-slot-3");
  assert.equal(afterPool.slots[2]!.refreshToken, "refresh-token-slot-3");
});

test("Token 临近过期自动 refresh 并持久化轮换后的 refresh_token；400/401 刷新失败报中文错误", async () => {
  saveScysAuth({
    mcpUrl: `${mock.state.baseUrl}/shengcai-web/mcp`,
    clientId: "mock-client-123",
    clientSecret: "mock-secret-456",
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    tokenEndpoint: `${mock.state.baseUrl}/mcp-oauth/token`,
    updatedAt: new Date().toISOString(),
  });

  const client = new ScysMcpClient({ minIntervalMs: 0 });
  const tools = await client.listTools();
  assert.ok(tools.length >= 8);

  const saved = loadScysAuth()!;
  assert.equal(saved.accessToken, "access-token-2");
  assert.equal(saved.refreshToken, "refresh-token-2");

  mock.state.rejectRefresh = true;
  await assert.rejects(
    () => refreshScysAccessToken(saved),
    (err: unknown) => err instanceof ScysAuthError && err.message.includes("pnpm scys:auth"),
  );
});

test("MCP Streamable HTTP 支持 SSE 帧解析、Session ID、429 Retry-After 退避与扩充后只读工具护栏", async () => {
  saveScysAuth({
    mcpUrl: `${mock.state.baseUrl}/shengcai-web/mcp`,
    clientId: "mock-client-123",
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    tokenEndpoint: `${mock.state.baseUrl}/mcp-oauth/token`,
    updatedAt: new Date().toISOString(),
  });

  for (const allowed of [
    "getDocumentDetail",
    "pageTopicComment",
    "activityList",
    "activitySearch",
    "searchTrustedContent",
    "getDailyReport",
    "ai__listAiFeedItems",
  ]) {
    assert.equal(isReadOnlyScysTool(allowed), true);
  }

  mock.state.sseMode = true;
  mock.state.rateLimitOnce = true;

  const client = new ScysMcpClient({ minIntervalMs: 5 });
  const tools = await client.listTools();
  assert.ok(tools.some((t) => t.name === "contentSearch"));

  await assert.rejects(() => client.callTool("addFavorite", { topicId: "1001" }), ScysToolBlockedError);
  await assert.rejects(() => client.callTool("topicLike", { topicId: "1001" }), ScysToolBlockedError);
  await assert.rejects(() => client.callTool("addCoinToTopic", { topicId: "1001" }), ScysToolBlockedError);

  const res = await client.callTool<{ topicDetailDTO: { items: unknown[] } }>("contentSearch", {
    pageScene: "good",
    pageIndex: 1,
    pageSize: 5,
    displayMode: 2,
  });
  assert.equal(res.topicDetailDTO.items.length, 1);
  assert.equal(mock.state.lastSessionIdSeen, "mock-session-1");
});

test("解码知识星球 <e .../> 内联标签、秒级时间戳与结构化 projectLibDetail.content", () => {
  const decoded = decodeScysInlineTags(
    '<e type="text_bold" title="%E3%80%8C%E6%A0%B8%E5%BF%83%E3%80%8D" /> ' +
      '<e type="web" href="https%3A%2F%2Fscys.com%2Fa" title="%E9%93%BE%E6%8E%A5" /> ' +
      '<e type="hashtag" title="%23AI%23" /> <e type="mention" title="%40%E4%BA%A6%E4%BB%81" />',
  );
  assert.equal(decoded, "**「核心」** [链接](https://scys.com/a) #AI# @亦仁");

  assert.equal(parseScysTimestamp(1795529820), new Date(1795529820 * 1000).toISOString());
  assert.equal(parseScysTimestamp("1795529820"), new Date(1795529820 * 1000).toISOString());

  const md = formatStructuredProjectContent([
    { key: "worth_reason", value: [{ key: "小标题", value: "段落正文" }] },
    { key: "profit_model", value: "单价 29.9 元" },
  ]);
  assert.ok(md.includes("## 值得关注的原因"));
  assert.ok(md.includes("### 小标题\n段落正文"));
  assert.ok(md.includes("## 盈利模式\n单价 29.9 元"));
});

test("真实结构采集：highlights (good+fxb)、latest、projects (searchProjectCases) 与 manuals (activityList->Toc->Detail)", async () => {
  saveScysAuth({
    mcpUrl: `${mock.state.baseUrl}/shengcai-web/mcp`,
    clientId: "slot-1",
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    tokenEndpoint: `${mock.state.baseUrl}/mcp-oauth/token`,
    updatedAt: new Date().toISOString(),
  });
  addScysAuthSlot({
    mcpUrl: `${mock.state.baseUrl}/shengcai-web/mcp`,
    clientId: "slot-2",
    accessToken: "access-token-slot-2",
    refreshToken: "refresh-token-1",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    tokenEndpoint: `${mock.state.baseUrl}/mcp-oauth/token`,
    updatedAt: new Date().toISOString(),
  });

  const collector = createScysCollector(() => new ScysMcpClient({ minIntervalMs: 0 }));

  const highlights = await collector.collect({
    sourceId: "scys-highlights",
    config: { mode: "highlights", pageSize: 10, fetchDetail: true, maxDetailPerRun: 8 },
    cursor: null,
    maxItems: 20,
    http: {} as never,
    log: () => {},
  });
  assert.equal(highlights.items.length, 2);
  assert.deepEqual(
    mock.state.contentSearchCalls.map((c) => c.pageScene).sort(),
    ["fxb", "good"],
  );
  // 验证多槽位并发轮询分发到不同槽位 token
  assert.equal(new Set(mock.state.topicDetailCalls.map((c) => c.token)).size, 2);
  assert.ok(mock.state.topicDetailCalls.every((c) => c.entityType === "xq_topic"));

  const item1 = highlights.items.find((i) => i.externalId === "scys-topic-xq_topic-1001")!;
  assert.equal(item1.url, "https://scys.com/articleDetail/xq_topic/1001");
  assert.equal(item1.author, "阿哲");
  assert.equal(item1.publishedAt, new Date(1795520000 * 1000).toISOString());
  assert.deepEqual(item1.tags, ["官方活动", "精华"]);
  assert.equal(item1.imageUrl, "https://scys.com/img/cover-1001.png");
  assert.ok(item1.content?.includes("**「核心方法」**"));
  assert.ok(item1.content?.includes("[实战SOP](https://scys.com/doc/1)"));
  assert.ok(item1.content?.includes("飞书文档补充SOP与工具清单"));
  assert.ok(item1.content?.includes("亦仁: @阿哲 这个切入点很扎实"));

  const item2 = highlights.items.find((i) => i.externalId === "scys-topic-xq_topic-1002")!;
  assert.ok(item2.title.includes("今天实测了一个冷门信息差项目"));

  // latest 模式：验证 searchTopic 传时间窗与 pageSize<=10，且解包 forum_topic
  const latest = await collector.collect({
    sourceId: "scys-latest",
    config: { mode: "latest", pageSize: 20, fetchDetail: false },
    cursor: null,
    maxItems: 20,
    http: {} as never,
    log: () => {},
  });
  assert.ok(mock.state.searchTopicCalls.length >= 1);
  assert.equal(mock.state.searchTopicCalls[0]?.pageSize, 10);
  assert.ok(typeof mock.state.searchTopicCalls[0]?.gmtCreateStart === "number");
  assert.ok(latest.items.some((i) => i.url === "https://scys.com/articleDetail/forum_topic/1003"));

  // projects 模式：searchProjectCases + projectLibDetail
  const projects = await collector.collect({
    sourceId: "scys-projects",
    config: { mode: "projects", pageSize: 5 },
    cursor: null,
    maxItems: 10,
    http: {} as never,
    log: () => {},
  });
  assert.equal(projects.items[0]?.externalId, "scys-project-201");
  assert.equal(projects.items[0]?.url, "https://scys.com/opportunity/detail/201");
  assert.equal(projects.items[0]?.publishedAt, new Date(1795529820 * 1000).toISOString());
  assert.ok(projects.items[0]?.content?.includes("启动成本: 200元"));
  assert.ok(projects.items[0]?.content?.includes("日均投入: 60分钟"));
  assert.ok(projects.items[0]?.content?.includes("月入区间: 3000~15000"));
  assert.ok(projects.items[0]?.content?.includes("## 值得关注的原因"));

  // manuals 模式：activityList -> activityManualToc -> activityManualDetail
  const manuals = await collector.collect({
    sourceId: "scys-manuals",
    config: { mode: "manuals", pageSize: 5 },
    cursor: null,
    maxItems: 10,
    http: {} as never,
    log: () => {},
  });
  assert.equal(manuals.items[0]?.externalId, "scys-manual-301");
  assert.ok(manuals.items[0]?.content?.includes("航海实战手册第一天正文详情"));
});

test("scysCollector 支持从 ctx.config.pageIndex / page 透传历史回溯页码", async () => {
  saveScysAuth({
    mcpUrl: `${mock.state.baseUrl}/shengcai-web/mcp`,
    clientId: "slot-1",
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    tokenEndpoint: `${mock.state.baseUrl}/mcp-oauth/token`,
    updatedAt: new Date().toISOString(),
  });

  const collector = createScysCollector(() => new ScysMcpClient({ minIntervalMs: 0 }));

  await collector.collect({
    sourceId: "scys-highlights",
    config: { mode: "highlights", pageScene: "good", pageIndex: 4, pageSize: 25, fetchDetail: false },
    cursor: null,
    maxItems: 25,
    http: {} as never,
    log: () => {},
  });
  assert.equal(mock.state.contentSearchCalls.at(-1)?.pageIndex, 4);
  assert.equal(mock.state.contentSearchCalls.at(-1)?.pageSize, 25);

  await collector.collect({
    sourceId: "scys-projects",
    config: { mode: "projects", page: 3, pageSize: 15, fetchDetail: false },
    cursor: null,
    maxItems: 15,
    http: {} as never,
    log: () => {},
  });
  assert.equal(mock.state.projectCasesCalls.at(-1)?.pageIndex, 3);

  await collector.collect({
    sourceId: "scys-latest",
    config: { mode: "latest", pageIndex: 2, pageSize: 20, fetchDetail: false },
    cursor: null,
    maxItems: 20,
    http: {} as never,
    log: () => {},
  });
  assert.equal(mock.state.contentSearchCalls.at(-1)?.pageIndex, 2);
  assert.equal(mock.state.searchTopicCalls.at(-1)?.pageIndex, 2);
});

test("buildToolArgs 适配 searchTopic 上限 <= 10、topicDetail {entityType,entityId} 及 overrides 覆盖", () => {
  const stArgs = buildToolArgs(
    "searchTopic",
    [{ name: "searchTopic", inputSchema: { type: "object", properties: { keyword: { type: "string" }, pageSize: { type: "integer" } } } }],
    { keyword: "AI 变现", pageSize: 25 },
    { pageSize: 6 },
  );
  assert.equal(stArgs.keyword, "AI 变现");
  assert.equal(stArgs.pageSize, 6);

  const stClamped = buildToolArgs(
    "searchTopic",
    [{ name: "searchTopic", inputSchema: { type: "object", properties: { keyword: { type: "string" }, pageSize: { type: "integer" } } } }],
    { keyword: "AI", pageSize: 25 },
  );
  assert.equal(stClamped.pageSize, 10);

  const tdArgs = buildToolArgs(
    "topicDetail",
    [{ name: "topicDetail", inputSchema: { type: "object", properties: { entityType: { type: "string" }, entityId: { type: "string" } } } }],
    { entityType: "forum_topic", entityId: "9988" },
  );
  assert.deepEqual(tdArgs, { entityType: "forum_topic", entityId: "9988" });

  // 空 schema 降级分支仍必须补全必填字段 entityType 与 entityId
  const tdFallback = buildToolArgs("topicDetail", [], { entityType: "xq_topic", entityId: "7766" });
  assert.deepEqual(tdFallback, { entityType: "xq_topic", entityId: "7766" });
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

  mock.state.expireSessionOnce = true;
  const res = await client.callTool<{ topicDetailDTO: { items: unknown[] } }>("contentSearch", {
    pageScene: "good",
    pageIndex: 1,
    pageSize: 5,
    displayMode: 2,
  });
  assert.equal(res.topicDetailDTO.items.length, 1);
  assert.equal(mock.state.initializeCount, 2);
  assert.equal(mock.state.lastSessionIdSeen, "mock-session-2");

  mock.state.alwaysExpireSession = true;
  await assert.rejects(
    () => client.callTool("contentSearch", { pageScene: "good" }),
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

  const run1 = await collector.collect({
    sourceId: "scys-highlights",
    config: { mode: "highlights", pageSize: 10, fetchDetail: true, maxDetailPerRun: 1 },
    cursor: null,
    maxItems: 20,
    http: {} as never,
    log: () => {},
  });
  assert.deepEqual(
    mock.state.topicDetailCalls.map((c) => c.entityId),
    ["1001"],
  );
  assert.ok(run1.items.find((i) => i.externalId === "scys-topic-xq_topic-1001")?.content?.includes("飞书文档补充SOP与工具清单"));
  assert.equal(run1.items.find((i) => i.externalId === "scys-topic-xq_topic-1002")?.content, null);

  const persist1 = ingestItems("scys-highlights", run1.items);
  assert.equal(persist1.inserted, 2);

  const row1AfterRun1 = get<{ content: string | null }>(
    "SELECT content FROM items WHERE source_id = 'scys-highlights' AND external_id = 'scys-topic-xq_topic-1001'",
  )!;
  const row2AfterRun1 = get<{ content: string | null }>(
    "SELECT content FROM items WHERE source_id = 'scys-highlights' AND external_id = 'scys-topic-xq_topic-1002'",
  )!;
  assert.ok(row1AfterRun1.content?.includes("正文详情(1001)"));
  assert.equal(row2AfterRun1.content, null);

  mock.state.topicDetailCalls = [];
  const run2 = await collector.collect({
    sourceId: "scys-highlights",
    config: { mode: "highlights", pageSize: 10, fetchDetail: true, maxDetailPerRun: 1 },
    cursor: null,
    maxItems: 20,
    http: {} as never,
    log: () => {},
  });
  assert.deepEqual(
    mock.state.topicDetailCalls.map((c) => c.entityId),
    ["1002"],
  );
  assert.equal(run2.items.find((i) => i.externalId === "scys-topic-xq_topic-1001")?.content, null);
  assert.ok(run2.items.find((i) => i.externalId === "scys-topic-xq_topic-1002")?.content?.includes("正文详情(1002)"));

  const persist2 = ingestItems("scys-highlights", run2.items);
  assert.equal(persist2.skipped, 2);

  const row1AfterRun2 = get<{ content: string | null }>(
    "SELECT content FROM items WHERE source_id = 'scys-highlights' AND external_id = 'scys-topic-xq_topic-1001'",
  )!;
  const row2AfterRun2 = get<{ content: string | null }>(
    "SELECT content FROM items WHERE source_id = 'scys-highlights' AND external_id = 'scys-topic-xq_topic-1002'",
  )!;
  assert.equal(row1AfterRun2.content, row1AfterRun1.content, "二次采集不得覆盖已有完整 content");
  assert.ok(row2AfterRun2.content?.includes("正文详情(1002)"), "超限未抓详情条目应在下轮自动补抓并落库");
});

test("超长万字富文本无损归档 (>20,000字)、旧 8,000 字截断记录自愈重抓与 10 年长期保留升级", async () => {
  const { applyScysPreset } = await import("../scripts/scys-preset.ts");
  const { getRetention, saveRetention } = await import("../src/server/retention.ts");

  // 1) 重置为上游默认 180 天保留策略，验证 applyScysPreset 升级为 10 年长期归档并允许历史老帖入库
  run("DELETE FROM settings WHERE key = 'retention'");
  assert.equal(getRetention().keptDays, 180);
  const presetOut = applyScysPreset();
  assert.equal(presetOut.retentionUpgraded, true);
  assert.deepEqual(
    { itemDays: getRetention().itemDays, keptDays: getRetention().keptDays, auto: getRetention().auto },
    { itemDays: 3650, keptDays: 3650, auto: false },
  );

  saveScysAuth({
    mcpUrl: `${mock.state.baseUrl}/shengcai-web/mcp`,
    clientId: "mock-client-123",
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    tokenEndpoint: `${mock.state.baseUrl}/mcp-oauth/token`,
    updatedAt: new Date().toISOString(),
  });

  // 2) 模拟库内已有一条旧版 8,000 字截断的记录 (1001) 与一条正常的短详情记录 (1002)
  const truncated8000 = "OLD_TRUNCATED_".padEnd(8000, "X");
  assert.equal(truncated8000.length, 8000);
  run(
    `INSERT INTO items (source_id, external_id, url, url_key, title, content, first_seen_at, last_seen_at)
     VALUES ('scys-highlights', 'scys-topic-xq_topic-1001', 'https://scys.com/articleDetail/xq_topic/1001', 'scys.com/articleDetail/xq_topic/1001', 'old-1001', ?, datetime('now'), datetime('now')),
            ('scys-highlights', 'scys-topic-xq_topic-1002', 'https://scys.com/articleDetail/xq_topic/1002', 'scys.com/articleDetail/xq_topic/1002', 'ok-1002', '短文完整详情', datetime('now'), datetime('now'))`,
    truncated8000,
  );

  // 超过 20,000 字的 Tiptap HTML 万字长文
  const longHtml = `<div class="tiptap-wrapper"><h1>万字长文实操</h1><p>${"长文干货段落".repeat(4000)}</p><p>结尾总结</p></div>`;
  assert.ok(longHtml.length > 24_000);
  mock.state.longTopicBodyById["1001"] = longHtml;

  const collector = createScysCollector(() => new ScysMcpClient({ minIntervalMs: 0 }));

  // 3) 重扫：1001 因 LENGTH(content) === 8000 触发 Stage 2 自愈重抓，1002 跳过；且全文 > 20,000 字不被截断
  const healRun = await collector.collect({
    sourceId: "scys-highlights",
    config: { mode: "highlights", pageSize: 10, fetchDetail: true, maxDetailPerRun: 8 },
    cursor: null,
    maxItems: 20,
    http: {} as never,
    log: () => {},
  });
  assert.deepEqual(
    mock.state.topicDetailCalls.map((c) => c.entityId),
    ["1001"],
  );
  const healedItem = healRun.items.find((i) => i.externalId === "scys-topic-xq_topic-1001")!;
  assert.ok((healedItem.content?.length ?? 0) > 24_000, "超过 20,000 字的长文不得被截断到 8,000 字");
  assert.ok(healedItem.content?.includes("结尾总结"));

  ingestItems("scys-highlights", healRun.items);
  const rowAfterHeal = get<{ content: string }>(
    "SELECT content FROM items WHERE source_id = 'scys-highlights' AND external_id = 'scys-topic-xq_topic-1001'",
  )!;
  assert.ok(rowAfterHeal.content.length > 24_000);
  assert.ok(rowAfterHeal.content.includes("结尾总结"));

  // 4) 再次采集：1001 已经是 >8005 字的完整归档，不应再重复拉 Stage 2
  mock.state.topicDetailCalls = [];
  await collector.collect({
    sourceId: "scys-highlights",
    config: { mode: "highlights", pageSize: 10, fetchDetail: true, maxDetailPerRun: 8 },
    cursor: null,
    maxItems: 20,
    http: {} as never,
    log: () => {},
  });
  assert.deepEqual(mock.state.topicDetailCalls, []);

  // 恢复默认 retention 避免影响其他测试
  saveRetention({ itemDays: 60, keptDays: 180, auto: true });
});
