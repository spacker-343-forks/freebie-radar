import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, beforeEach, test } from "node:test";

Object.assign(process.env, {
  DATABASE_PATH: ":memory:",
  AI_BASE_URL: "",
  AI_MODEL: "",
  AI_API_KEY: "",
  AI_FALLBACK_BASE_URL: "",
  AI_FALLBACK_API_KEY: "",
  AI_FALLBACK_MODEL: "",
  AI_COMMENT_MODEL: "",
  PUSH_CHANNEL: "none",
  ENABLE_SCHEDULER: "false",
});

const { migrate, run, get, closeDb } = await import("../src/server/db.ts");
const { ensureSources, ingestItems } = await import("../src/server/collectors/index.ts");
const {
  buildToolArgs,
  isReadOnlyScysTool,
  saveScysAuth,
  SCYS_READONLY_TOOLS,
  ScysMcpClient,
} = await import("../src/server/scys/mcp-client.ts");
import type { McpToolSchema } from "../src/server/scys/mcp-client.ts";
const {
  buildTrustedMetaHeader,
  createScysTrustedCollector,
  normalizeTrustedUrl,
  parseTrustedTimestamp,
} = await import("../src/server/collectors/scys-trusted.ts");

type MockSectionReply = {
  content: string;
  truncated?: boolean;
  nextOffset?: number;
  nextSectionId?: string;
  title?: string;
  theme?: string;
  isSummaryOnly?: boolean;
  originalUrl?: string;
  accountName?: string;
  titleZh?: string;
  publishedAt?: string;
};

type MockTrustedServerState = {
  baseUrl: string;
  searchCalls: Array<Record<string, unknown>>;
  sectionCalls: Array<Record<string, unknown>>;
  itemsBySourceType: Record<string, Array<Record<string, unknown>>>;
  searchErrorBySourceType: Record<string, string | null>;
  sectionResponder: (args: Record<string, unknown>) => MockSectionReply | { error: string };
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

function startMockTrustedServer() {
  const state: MockTrustedServerState = {
    baseUrl: "",
    searchCalls: [],
    sectionCalls: [],
    itemsBySourceType: {
      wechat_mp: [],
      twitter: [],
      navigator_chat_highlight: [],
    },
    searchErrorBySourceType: {},
    sectionResponder: () => ({ content: "" }),
  };

  const toolSchemas: McpToolSchema[] = [
    {
      name: "searchTrustedContent",
      description: "Search trusted content",
      inputSchema: {
        type: "object",
        properties: {
          keyword: { type: "string" },
          sourceType: { type: "string", enum: ["navigator_chat_highlight", "wechat_mp", "twitter"] },
          accountKey: { type: "string" },
          month: { type: "string" },
          pageIndex: { type: "integer" },
          pageSize: { type: "integer" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "getTrustedContentSection",
      description: "Read trusted content section",
      inputSchema: {
        type: "object",
        properties: {
          sourceType: { type: "string", enum: ["navigator_chat_highlight", "wechat_mp", "twitter"] },
          itemId: { type: "string" },
          sectionId: { type: "string" },
          offset: { type: "integer" },
          maxChars: { type: "integer" },
          lang: { type: "string", enum: ["zh", "original"] },
        },
        required: ["sourceType", "itemId", "sectionId"],
        additionalProperties: false,
      },
    },
  ];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", state.baseUrl || "http://127.0.0.1");
    if (url.pathname === "/shengcai-web/mcp" && req.method === "POST") {
      const rpc = JSON.parse(await readJsonBody(req)) as {
        id?: string | number;
        method: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };

      if (rpc.method === "initialize") {
        sendJson(
          res,
          200,
          { jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-03-26", capabilities: {} } },
          { "mcp-session-id": "trusted-mock-sess" },
        );
        return;
      }
      if (rpc.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      if (rpc.method === "tools/list") {
        sendJson(res, 200, { jsonrpc: "2.0", id: rpc.id, result: { tools: toolSchemas } });
        return;
      }
      if (rpc.method === "tools/call") {
        const name = rpc.params?.name ?? "";
        const args = rpc.params?.arguments ?? {};
        if (name === "searchTrustedContent") {
          state.searchCalls.push(args);
          const st = String(args.sourceType ?? "");
          const errMsg = state.searchErrorBySourceType[st];
          if (errMsg) {
            sendJson(res, 200, {
              jsonrpc: "2.0",
              id: rpc.id,
              result: { isError: true, content: [{ type: "text", text: errMsg }] },
            });
            return;
          }
          const items = state.itemsBySourceType[st] ?? [];
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              structuredContent: {
                items,
                total: items.length,
                extra: { candidatesTruncated: false },
              },
            },
          });
          return;
        }
        if (name === "getTrustedContentSection") {
          state.sectionCalls.push(args);
          const reply = state.sectionResponder(args);
          if ("error" in reply) {
            sendJson(res, 200, {
              jsonrpc: "2.0",
              id: rpc.id,
              result: { isError: true, content: [{ type: "text", text: reply.error }] },
            });
            return;
          }
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              structuredContent: {
                sourceType: args.sourceType,
                itemId: args.itemId,
                sectionId: args.sectionId,
                lang: args.lang ?? "zh",
                ...reply,
              },
            },
          });
          return;
        }
      }
    }
    sendJson(res, 404, { error: "not_found" });
  });

  return {
    state,
    toolSchemas,
    async start() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const addr = server.address() as { port: number };
      state.baseUrl = `http://127.0.0.1:${addr.port}`;
    },
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const mock = startMockTrustedServer();

function seedTrustedAuth() {
  saveScysAuth({
    mcpUrl: `${mock.state.baseUrl}/shengcai-web/mcp`,
    clientId: "mock-client",
    accessToken: "mock-access-token",
    refreshToken: "mock-refresh-token",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    tokenEndpoint: `${mock.state.baseUrl}/mcp-oauth/token`,
    updatedAt: new Date().toISOString(),
  });
}

function ensureTrustedTestSourceRow() {
  run(
    `INSERT OR IGNORE INTO sources (id, name, kind, enabled, config, interval_sec, created_at)
     VALUES ('scys-trusted', '生财有术 · 大佬公众号/推文/群聊精华', 'scys-trusted', 1, '{}', 3600, datetime('now'))`,
  );
}

before(async () => {
  migrate();
  ensureSources();
  ensureTrustedTestSourceRow();
  await mock.start();
});

after(async () => {
  await mock.stop();
  closeDb();
});

beforeEach(() => {
  run("DELETE FROM items");
  run("DELETE FROM settings WHERE key IN ('scys_mcp_auth', 'scys_trusted_backfill_progress')");
  mock.state.searchCalls = [];
  mock.state.sectionCalls = [];
  mock.state.itemsBySourceType = {
    wechat_mp: [],
    twitter: [],
    navigator_chat_highlight: [],
  };
  mock.state.searchErrorBySourceType = {};
  mock.state.sectionResponder = () => ({ content: "" });
});

test("只读白名单包含 getTrustedContentSection 且 buildToolArgs 正确适配 searchTrustedContent/getTrustedContentSection", () => {
  assert.ok(SCYS_READONLY_TOOLS.has("searchTrustedContent"));
  assert.ok(SCYS_READONLY_TOOLS.has("getTrustedContentSection"));
  assert.equal(isReadOnlyScysTool("getTrustedContentSection"), true);

  const searchArgs = buildToolArgs("searchTrustedContent", mock.toolSchemas, {
    sourceType: "wechat_mp",
    keyword: "AI 出海",
    accountKey: "刘小排",
    month: "2026-11",
    page: 2,
    pageSize: 50,
  });
  assert.deepEqual(searchArgs, {
    sourceType: "wechat_mp",
    keyword: "AI 出海",
    accountKey: "刘小排",
    month: "2026-11",
    pageIndex: 2,
    pageSize: 20,
  });

  const secArgs = buildToolArgs("getTrustedContentSection", mock.toolSchemas, {
    sourceType: "twitter",
    itemId: "19312",
    sectionId: "0",
    offset: 1200,
    maxChars: 80_000,
    lang: "zh",
  });
  assert.deepEqual(secArgs, {
    sourceType: "twitter",
    itemId: "19312",
    sectionId: "0",
    offset: 1200,
    maxChars: 50_000,
    lang: "zh",
  });
});

test("辅助函数：URL 规范化、时间戳解析与元信息头符合 snapshot.ts META_HEADER_RE", () => {
  assert.equal(
    normalizeTrustedUrl("https://mp.weixin.qq.com/s/abc123", "wechat_mp", "10"),
    "https://mp.weixin.qq.com/s/abc123",
  );
  assert.equal(
    normalizeTrustedUrl("", "navigator_chat_highlight", "42"),
    "https://scys.com/trusted/navigator_chat_highlight/42",
  );
  assert.equal(
    normalizeTrustedUrl("javascript:alert(1)", "twitter", "99"),
    "https://scys.com/trusted/twitter/99",
  );

  assert.equal(parseTrustedTimestamp("2026-11-27 08:01:10"), "2026-11-27T00:01:10.000Z");

  const metaRegex = /^(【(?:分类|来源|期数|热度|标签)】[^\n]+)$/u;
  assert.match(buildTrustedMetaHeader({ sourceType: "wechat_mp", accountName: "产品笔记" }), metaRegex);
  assert.match(buildTrustedMetaHeader({ sourceType: "twitter", accountName: "超级峰" }), metaRegex);
  assert.match(
    buildTrustedMetaHeader({
      sourceType: "navigator_chat_highlight",
      startDate: "2026-11-01",
      endDate: "2026-11-30",
    }),
    metaRegex,
  );
});

test("wechat_mp + twitter 采集、图片保留、摘要权限提示、多段及 truncated/nextOffset/nextSectionId 续读与二次跳过", async () => {
  seedTrustedAuth();

  mock.state.itemsBySourceType.wechat_mp = [
    {
      sourceType: "wechat_mp",
      itemId: "19252",
      title: "AI 产品冷启动长文拆解",
      startDate: "2026-11-27",
      endDate: "2026-11-27",
      originalUrl: "https://mp.weixin.qq.com/s/wx-19252",
      sections: [
        { sectionId: "0", title: "第一步：选品信号", theme: "出海方法论", infoDate: "2026-11-26" },
        { sectionId: "1", title: "第二步：转化闭环", theme: "出海方法论" },
      ],
      accountKey: "gh_wx001",
      accountName: "产品笔记",
      contentType: "article",
      publishedAt: "2026-11-27 08:01:10",
      snippet: "摘要预览",
      isSummaryOnly: false,
    },
  ];

  mock.state.itemsBySourceType.twitter = [
    {
      sourceType: "twitter",
      itemId: "19312",
      title: "Original EN tweet title",
      titleZh: "海外独立开发者月入 2 万美金复盘",
      startDate: "2026-11-27",
      endDate: "2026-11-27",
      originalUrl: "https://x.com/builder/status/19312",
      sections: [{ sectionId: "0", title: "全文" }],
      accountKey: "builder",
      accountName: "超级峰",
      contentType: "post",
      publishedAt: "2026-11-27 09:30:00",
      snippet: "只开放前 500 字摘要",
      isSummaryOnly: true,
    },
  ];

  mock.state.sectionResponder = (args) => {
    const itemId = String(args.itemId);
    const sectionId = String(args.sectionId);
    const offset = Number(args.offset ?? 0);

    if (itemId === "19252" && sectionId === "0" && offset === 0) {
      return {
        content: "第一段前半部分内容：",
        truncated: true,
        nextOffset: 10,
      };
    }
    if (itemId === "19252" && sectionId === "0" && offset === 10) {
      return {
        content: "后半部分无缝拼接。\n\n![图1](https://mmbiz.qpic.cn/demo1.png)",
        truncated: false,
        nextSectionId: "0b",
      };
    }
    if (itemId === "19252" && sectionId === "0b") {
      return {
        title: "隐藏补充节",
        content: "通过 nextSectionId 动态续读的补充段落。",
        truncated: false,
      };
    }
    if (itemId === "19252" && sectionId === "1") {
      return {
        content: "第二节落地执行细节。",
        truncated: false,
      };
    }
    if (itemId === "19312" && sectionId === "0") {
      return {
        content: "这是推特翻译后的前 500 字干货摘要内容。",
        truncated: false,
        isSummaryOnly: true,
      };
    }
    return { content: "" };
  };

  const collector = createScysTrustedCollector(() => new ScysMcpClient({ minIntervalMs: 0, maxConcurrencyPerSlot: 3 }));
  const firstRun = await collector.collect({
    sourceId: "scys-trusted",
    config: { pageSize: 15, fetchDetail: true, maxDetailPerRun: 10 },
    cursor: null,
    maxItems: 50,
    http: {} as never,
    log: () => {},
  });

  assert.equal(firstRun.degraded, null);
  assert.equal(firstRun.items.length, 2);

  const wxItem = firstRun.items.find((i) => i.externalId === "scys-trusted-wechat_mp-19252")!;
  assert.ok(wxItem);
  assert.equal(wxItem.url, "https://mp.weixin.qq.com/s/wx-19252");
  assert.equal(wxItem.author, "产品笔记");
  assert.equal(wxItem.imageUrl, "https://mmbiz.qpic.cn/demo1.png");
  assert.ok(wxItem.content?.startsWith("【来源】微信公众号 · 产品笔记\n\n"));
  assert.ok(wxItem.content?.includes("## 出海方法论"));
  assert.ok(wxItem.content?.includes("### 第一步：选品信号 (2026-11-26)"));
  assert.ok(wxItem.content?.includes("第一段前半部分内容：后半部分无缝拼接。"));
  assert.ok(wxItem.content?.includes("![图1](https://mmbiz.qpic.cn/demo1.png)"));
  assert.ok(wxItem.content?.includes("### 隐藏补充节\n\n通过 nextSectionId 动态续读的补充段落。"));
  assert.ok(wxItem.content?.includes("### 第二步：转化闭环\n\n第二节落地执行细节。"));

  const twItem = firstRun.items.find((i) => i.externalId === "scys-trusted-twitter-19312")!;
  assert.ok(twItem);
  assert.equal(twItem.title, "海外独立开发者月入 2 万美金复盘");
  assert.ok(twItem.content?.startsWith("【来源】X(Twitter) · 超级峰\n\n"));
  assert.ok(twItem.content?.includes("这是推特翻译后的前 500 字干货摘要内容。"));
  assert.ok(twItem.content?.includes("仅开放摘要"));
  assert.ok(twItem.content?.includes("https://x.com/builder/status/19312"));

  // 验证偏移续读请求与 nextSectionId 调用顺序
  const wxCalls = mock.state.sectionCalls.filter((c) => c.itemId === "19252");
  assert.equal(wxCalls.length, 4);
  assert.equal(wxCalls[0]?.lang, "zh");
  assert.equal(wxCalls[0]?.maxChars, 50_000);
  assert.equal(wxCalls[1]?.offset, 10);
  assert.equal(wxCalls[2]?.sectionId, "0b");
  assert.equal(wxCalls[3]?.sectionId, "1");

  const saved = ingestItems("scys-trusted", firstRun.items);
  assert.equal(saved.inserted, 2);

  // 二次采集：已有完整 content 的条目应跳过 getTrustedContentSection
  mock.state.sectionCalls = [];
  const secondRun = await collector.collect({
    sourceId: "scys-trusted",
    config: { pageSize: 15, fetchDetail: true, maxDetailPerRun: 10 },
    cursor: null,
    maxItems: 50,
    http: {} as never,
    log: () => {},
  });
  assert.equal(mock.state.sectionCalls.length, 0, "库内已有完整正文的条目不应重复调用 getTrustedContentSection");
  assert.equal(secondRun.items[0]?.content, null);
  ingestItems("scys-trusted", secondRun.items);
  const storedWx = get<{ content: string }>(
    "SELECT content FROM items WHERE external_id = 'scys-trusted-wechat_mp-19252'",
  )!;
  assert.equal(storedWx.content, wxItem.content, "二次采集不得覆盖已有完整 content");
});

test("navigator_chat_highlight 无权限报错优雅降级，不影响 wechat_mp 与 twitter 采集", async () => {
  seedTrustedAuth();

  mock.state.itemsBySourceType.wechat_mp = [
    {
      sourceType: "wechat_mp",
      itemId: "3001",
      title: "公众号正常运行条目",
      originalUrl: "https://mp.weixin.qq.com/s/ok-3001",
      sections: [{ sectionId: "0", title: "全文" }],
      accountName: "亦仁",
      publishedAt: "2026-11-27 10:00:00",
    },
  ];
  mock.state.itemsBySourceType.twitter = [
    {
      sourceType: "twitter",
      itemId: "3002",
      title: "Twitter 正常运行条目",
      originalUrl: "https://x.com/yiren/status/3002",
      sections: [{ sectionId: "0", title: "全文" }],
      accountName: "亦仁",
      publishedAt: "2026-11-27 10:05:00",
    },
  ];
  mock.state.searchErrorBySourceType.navigator_chat_highlight = "当前账号无航海家权限，无法访问群聊精华";

  mock.state.sectionResponder = (args) => ({
    content: `正文内容(${args.sourceType}:${args.itemId})`,
    truncated: false,
  });

  const logs: string[] = [];
  const collector = createScysTrustedCollector(() => new ScysMcpClient({ minIntervalMs: 0 }));
  const result = await collector.collect({
    sourceId: "scys-trusted",
    config: { pageSize: 15, fetchDetail: true, maxDetailPerRun: 10 },
    cursor: null,
    maxItems: 50,
    http: {} as never,
    log: (m) => logs.push(m),
  });

  assert.equal(result.items.length, 2);
  assert.ok(result.degraded?.includes("navigator_chat_highlight"));
  assert.ok(logs.some((l) => l.includes("降级跳过")));
  assert.equal(result.items[0]?.content, "【来源】微信公众号 · 亦仁\n\n正文内容(wechat_mp:3001)");
  assert.equal(result.items[1]?.content, "【来源】X(Twitter) · 亦仁\n\n正文内容(twitter:3002)");
});

test("navigator_chat_highlight 缺 originalUrl 时生成唯一稳定 url_key，且单篇无权限不拖垮其他条目", async () => {
  seedTrustedAuth();

  mock.state.itemsBySourceType.navigator_chat_highlight = [
    {
      sourceType: "navigator_chat_highlight",
      itemId: "501",
      title: "2026年11月航海家群聊精华 - 有权限篇",
      startDate: "2026-11-01",
      endDate: "2026-11-27",
      sections: [{ sectionId: "s1", title: "AI 工作流讨论", theme: "提效工具" }],
    },
    {
      sourceType: "navigator_chat_highlight",
      itemId: "502",
      title: "2026年11月航海家群聊精华 - 无权限篇",
      startDate: "2026-11-01",
      endDate: "2026-11-27",
      sections: [{ sectionId: "s1", title: "私密复盘" }],
    },
  ];

  mock.state.sectionResponder = (args) => {
    if (args.itemId === "502") {
      return { error: "无航海家权限查看该群聊精华" };
    }
    return { content: "群聊精华实操纪要。", truncated: false };
  };

  const collector = createScysTrustedCollector(() => new ScysMcpClient({ minIntervalMs: 0 }));
  const result = await collector.collect({
    sourceId: "scys-trusted",
    config: {
      sourceTypes: ["navigator_chat_highlight"],
      pageSize: 10,
      fetchDetail: true,
      maxDetailPerRun: 10,
    },
    cursor: null,
    maxItems: 20,
    http: {} as never,
    log: () => {},
  });

  assert.equal(result.items.length, 2);
  const okItem = result.items.find((i) => i.externalId === "scys-trusted-navigator_chat_highlight-501")!;
  const deniedItem = result.items.find((i) => i.externalId === "scys-trusted-navigator_chat_highlight-502")!;
  assert.equal(okItem.url, "https://scys.com/trusted/navigator_chat_highlight/501");
  assert.equal(deniedItem.url, "https://scys.com/trusted/navigator_chat_highlight/502");
  assert.ok(okItem.content?.startsWith("【来源】航海家群聊精华 · 2026-11\n\n"));
  assert.ok(okItem.content?.includes("## 提效工具"));
  assert.equal(deniedItem.content, null);

  const saved = ingestItems("scys-trusted", result.items);
  assert.equal(saved.inserted, 2, "缺失 originalUrl 时两篇应凭借唯一 fallback URL 全部入库无 url_key 冲突");
});
