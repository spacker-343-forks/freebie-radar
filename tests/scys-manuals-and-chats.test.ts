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
  AI_COMMENT_MODEL: "",
  PUSH_CHANNEL: "none",
  ENABLE_SCHEDULER: "false",
});

const { migrate, run, closeDb } = await import("../src/server/db.ts");
const { config } = await import("../src/server/config.ts");
const { getAiSettings } = await import("../src/server/enrich/ai-settings.ts");
const { ensureDossierTable } = await import("../src/server/dossier.ts");
const { ensureSources } = await import("../src/server/collectors/index.ts");
const { registerApi } = await import("../src/server/routes.ts");
const { ScysAuthError, isReadOnlyScysTool } = await import("../src/server/scys/mcp-client.ts");
const { getManualBookDetail, getManualChapter, listManualBooks } = await import(
  "../src/server/manuals.ts"
);
const { matchActivityTrackSlug } = await import("../src/shared/manuals.ts");
const {
  DEFAULT_CHAT_DISTILL_MODEL,
  classifyChatGroupTier,
  distillChatGroupInsights,
  ensureChatRadarTables,
  formatRawChatMessage,
  getChatGroupsOverview,
  getChatMessageContext,
  isChatNoiseMessage,
  listChatDigests,
  searchChatMessages,
  setChatGroupEnabled,
  syncChatGroupMessages,
  syncChatGroupsCatalog,
} = await import("../src/server/chat-radar.ts");

function insertManualRow(opts: {
  externalId: string;
  title: string;
  content: string;
  raw: Record<string, unknown>;
  score?: number;
  aiQuality?: number;
  category?: string;
}): number {
  const now = "2026-11-27T10:00:00.000Z";
  const res = run(
    `INSERT INTO items (
       source_id, external_id, url, url_key, title_key, title, summary, content,
       category, kind, ai_quality, tags, codes, is_free, score, published_at,
       raw, status, starred, first_seen_at, last_seen_at
     ) VALUES (
       'scys-manuals', ?, ?, ?, ?, ?, ?, ?,
       ?, 'guide', ?, '["航海手册"]', '[]', 0, ?, ?,
       ?, 'active', 0, ?, ?
     )`,
    opts.externalId,
    `https://scys.com/activity/manual/${opts.externalId}`,
    `scys.com/activity/manual/${opts.externalId}`,
    opts.title,
    opts.title,
    opts.content.slice(0, 120),
    opts.content,
    opts.category ?? "dev",
    opts.aiQuality ?? 4,
    opts.score ?? 75,
    now,
    JSON.stringify(opts.raw),
    now,
    now,
  );
  return Number(res.lastInsertRowid);
}

before(() => {
  migrate();
  ensureSources();
  ensureDossierTable();
  ensureChatRadarTables();
});

beforeEach(() => {
  (config as { adminToken: string }).adminToken = "";
  run("DELETE FROM items");
  run("DELETE FROM item_dossiers");
  run("DELETE FROM scys_chat_digests");
  run("DELETE FROM scys_chat_messages");
  run("DELETE FROM scys_chat_groups");
});

after(() => {
  closeDb();
});

test("MCP 只读白名单包含群聊工具且默认群聊提纯模型为 gpt-6.2-sol:medium", () => {
  assert.equal(isReadOnlyScysTool("listMyChatGroups"), true);
  assert.equal(isReadOnlyScysTool("getMyChatGroupMessages"), true);
  assert.equal(DEFAULT_CHAT_DISTILL_MODEL, "gpt-6.2-sol:medium");
});

test("群分层与 0-Token 群聊噪音预筛覆盖 16 字截断航海群、地域群及接龙水词", () => {
  assert.equal(classifyChatGroupTier("AI有术-深圳1群"), "regional");
  assert.equal(classifyChatGroupTier("AI 有术 · 上海交流群"), "regional");
  assert.equal(classifyChatGroupTier("微信小程序1群-11月航海"), "voyage");
  assert.equal(classifyChatGroupTier("【Day9】视频号AI图书带货4群"), "voyage");
  assert.equal(classifyChatGroupTier("【第9天】视频号-AI图书带货1群-11"), "voyage");
  assert.equal(matchActivityTrackSlug("【Day9】视频号AI图书带货4群"), "channels-ai-book-commerce");
  assert.equal(matchActivityTrackSlug("【第9天】视频号-AI图书带货1群-11"), "channels-ai-book-commerce");
  assert.equal(matchActivityTrackSlug("【未知冷门实验项目】01. 小红书引流步骤"), null);
  assert.equal(classifyChatGroupTier("生财 MCP 内测 1 群"), "core");
  assert.equal(classifyChatGroupTier("生财 TokenRank 排行榜内测群"), "core");
  assert.equal(classifyChatGroupTier("生财 X 自媒体交流群"), "core");

  const shareText = formatRawChatMessage({
    msgType: 2005,
    content: "[链接]",
    shareTitle: "飞书实操 SOP 教程",
    shareDesc: "生财有术",
    shareUrl: "https://scys.feishu.cn/docx/abc123",
  });
  assert.match(shareText, /飞书实操 SOP 教程/);
  assert.match(shareText, /https:\/\/scys\.feishu\.cn\/docx\/abc123/);
  assert.equal(isChatNoiseMessage(shareText, 2005, []), false);

  assert.equal(isChatNoiseMessage("[动画表情]", 2004, []), true);
  assert.equal(isChatNoiseMessage("感谢安小生教练细致点评！！！", 2001, []), true);
  assert.equal(isChatNoiseMessage("+1", 2001, []), true);
  assert.equal(isChatNoiseMessage("系统提示：欢迎入群", 1000, []), true);
  assert.equal(
    isChatNoiseMessage("我报名参加今晚复盘", 2001, ["其他发言", "我报名参加今晚复盘"]),
    true,
  );
  assert.equal(
    isChatNoiseMessage(
      "个体户注册微信小程序如果名称校验失败，可以打 400-670-0700 转小程序认证专员",
      2001,
      [],
    ),
    false,
  );
});

test("航海手册按项目归并去重分关，并将 11 月实战群精确挂载到最新一期 activityId", async () => {
  // 旧期微信小程序手册 (activityId = 10100)
  insertManualRow({
    externalId: "scys-manual-10100-m1",
    title: "【AI 产品（国内-微信小程序）】01. 往期开船第一课",
    content: "往期内容",
    raw: { activityId: "10100", activityName: "AI 产品（国内-微信小程序）", itemId: "m1" },
  });

  // 最新期微信小程序手册 (activityId = 10472)，含旧短格式重复行与 00. 分节标题
  insertManualRow({
    externalId: "scys-manual-c1",
    title: "【AI 产品（国内-微信小程序）】00. 本章任务：找需求",
    content: "旧短 ID 版本（字数较少）",
    raw: { activityId: "10472", activityName: "AI 产品（国内-微信小程序）", itemId: "c1" },
  });
  const ch1Id = insertManualRow({
    externalId: "scys-manual-10472-c1",
    title: "【AI 产品（国内-微信小程序）】00. 本章任务：找需求",
    content: "关卡一任务总览与交付标准完整正文",
    raw: { activityId: "10472", activityName: "AI 产品（国内-微信小程序）", itemId: "c1" },
  });
  const ch2Id = insertManualRow({
    externalId: "scys-manual-10472-c2",
    title: "【AI 产品（国内-微信小程序）】01. 找需求实操方法",
    content: "微信指数与下拉词挖掘 SOP 正文",
    raw: { activityId: "10472", activityName: "AI 产品（国内-微信小程序）", itemId: "c2" },
    score: 88,
    aiQuality: 5,
  });
  insertManualRow({
    externalId: "scys-manual-10472-c3",
    title: "【AI 产品（国内-微信小程序）】00. 本章任务：备案与认证",
    content: "关卡二任务说明",
    raw: { activityId: "10472", activityName: "AI 产品（国内-微信小程序）", itemId: "c3" },
  });
  insertManualRow({
    externalId: "scys-manual-10472-c4",
    title: "【AI 产品（国内-微信小程序）】01. 小程序备案实操",
    content: "个体户与个人主体备案区别详解",
    raw: { activityId: "10472", activityName: "AI 产品（国内-微信小程序）", itemId: "c4" },
  });

  // 同步群目录（含 core / 11月航海群 / 16字截断群 / 地域群）
  const mockMcp = {
    async callTool<T>(name: string): Promise<T> {
      assert.equal(name, "listMyChatGroups");
      return {
        total: 4,
        items: [
          { groupKey: "grp-core-1", platform: 1, name: "生财 TokenRank 排行榜内测群" },
          { groupKey: "grp-mp-1", platform: 1, name: "微信小程序1群-11月航海" },
          { groupKey: "grp-mp-2", platform: 1, name: "微信小程序2群-11月航海" },
          { groupKey: "grp-reg-1", platform: 1, name: "AI有术-北京1群" },
        ],
      } as T;
    },
  };

  const cat = await syncChatGroupsCatalog({ client: mockMcp });
  assert.equal(cat.total, 4);
  assert.equal(cat.core, 1);
  assert.equal(cat.voyage, 2);
  assert.equal(cat.regional, 1);
  assert.equal(cat.enabled, 3); // core(1) + voyage(2) 默认启用，regional(1) 默认关闭
  assert.equal(cat.linkedVoyage, 2);

  // 验证用户手动调整开关后再次 discover 不会覆盖 enabled，且旧期 linked_activity_id 可自动升级到最新一期
  setChatGroupEnabled("grp-reg-1", true);
  run("UPDATE scys_chat_groups SET linked_activity_id = '10100' WHERE group_key = 'grp-mp-1'");
  await syncChatGroupsCatalog({ client: mockMcp });
  const overviewAfter = getChatGroupsOverview();
  assert.equal(overviewAfter.groups.find((g) => g.groupKey === "grp-reg-1")?.enabled, true);
  assert.equal(
    overviewAfter.groups.find((g) => g.groupKey === "grp-mp-1")?.linkedActivityId,
    "10472",
  );

  // 验证手册整书聚合与最新期挂载
  const books = listManualBooks();
  assert.equal(books.length, 2);

  const latestBook = books.find((b) => b.activityId === "10472");
  const oldBook = books.find((b) => b.activityId === "10100");
  assert.ok(latestBook);
  assert.ok(oldBook);
  assert.equal(latestBook.chapterCount, 4); // c1 去重后剩 4 节
  assert.equal(latestBook.linkedGroups.length, 2);
  assert.equal(oldBook.linkedGroups.length, 0); // 旧期不误挂 11 月群

  const detail = getManualBookDetail("10472");
  assert.ok(detail);
  assert.equal(detail.sections.length, 2);
  assert.equal(detail.sections[0]!.chapters.length, 2);
  assert.equal(detail.sections[1]!.chapters.length, 2);

  const ch1 = getManualChapter(ch1Id);
  const ch2 = getManualChapter(ch2Id);
  assert.ok(ch1);
  assert.ok(ch2);
  assert.equal(ch1.content, "关卡一任务总览与交付标准完整正文");
  assert.equal(ch2.cleanTitle, "01. 找需求实操方法");
});

test("群消息增量同步、上下文对话流还原、AI 四维提纯与 HTTP 路由端到端验证", async () => {
  insertManualRow({
    externalId: "scys-manual-10472-c1",
    title: "【AI 产品（国内-微信小程序）】01. 开船第一课",
    content: "小程序立项指南",
    raw: { activityId: "10472", activityName: "AI 产品（国内-微信小程序）", itemId: "c1" },
  });

  const baseSec = Math.floor(Date.now() / 1000) - 3600;
  const seenCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  const mockMcp = {
    async callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      seenCalls.push({ name, args });
      if (name === "listMyChatGroups") {
        return {
          total: 2,
          items: [
            { groupKey: "59015092545@chatroom", platform: 1, name: "微信小程序1群-11月航海" },
            { groupKey: "99999999999@chatroom", platform: 1, name: "AI有术-闲聊群" },
          ],
        } as T;
      }
      if (name === "getMyChatGroupMessages") {
        const from = Number(args.msgTimeFrom ?? 0);
        if (from > baseSec + 30) {
          return { total: 0, items: [] } as T;
        }
        return {
          total: 4,
          items: [
            {
              msgId: "m4",
              msgTime: baseSec + 30,
              msgType: 2001,
              senderName: "学员B",
              content: "感谢教练细致点评！！！",
            },
            {
              msgId: "m3",
              msgTime: baseSec + 20,
              msgType: 2001,
              senderName: "教练-码叔编程",
              content: "主体名称校验失败可以拨打 400-670-0700 转小程序微信认证专员处理。",
            },
            {
              msgId: "m2",
              msgTime: baseSec + 10,
              msgType: 2001,
              senderName: "水晶-上海",
              content: "个体工商户做小程序认证一直报主体名称校验失败，普通客服不接怎么办？",
            },
            {
              msgId: "m1",
              msgTime: baseSec + 5,
              msgType: 2004,
              senderName: "路人A",
              content: "[动画表情]",
            },
          ],
        } as T;
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };

  const sync1 = await syncChatGroupMessages({ client: mockMcp, concurrency: 2, intervalMs: 0 });
  assert.equal(sync1.groupsTargeted, 1); // 仅启用群
  assert.equal(sync1.groupsSynced, 1);
  assert.equal(sync1.insertedMessages, 4);
  assert.equal(sync1.validInsertedMessages, 2); // m1 动画表情与 m4 感谢点评被标为 is_noise=1

  // 第二次增量同步：游标推进至 last_msg_time + 1，新增为 0
  const sync2 = await syncChatGroupMessages({ client: mockMcp, concurrency: 2, intervalMs: 0 });
  assert.equal(sync2.insertedMessages, 0);

  // ScysAuthError 必须快速上抛不被静默吞掉
  await assert.rejects(
    () =>
      syncChatGroupMessages({
        groupKey: "59015092545@chatroom",
        client: {
          async callTool() {
            throw new ScysAuthError("token expired");
          },
        },
      }),
    ScysAuthError,
  );

  // 检索默认跳过噪音，勾选 includeNoise 可找回
  const cleanHits = searchChatMessages({ q: "400-670-0700" });
  assert.equal(cleanHits.total, 1);
  assert.equal(cleanHits.items[0]!.senderName, "教练-码叔编程");

  const noiseFiltered = searchChatMessages({ q: "感谢教练" });
  assert.equal(noiseFiltered.total, 0);
  const noiseIncluded = searchChatMessages({ q: "感谢教练", includeNoise: true });
  assert.equal(noiseIncluded.total, 1);

  // 上下文还原同时返回前后完整消息（含噪音）
  const ctx = getChatMessageContext("59015092545@chatroom", baseSec + 20, 5);
  assert.ok(ctx);
  assert.equal(ctx.items.length, 4);
  assert.equal(ctx.linkedActivityId, "10472");

  // AI 提纯（模拟网关返回 1 条排坑洞察）
  let usedModel = "";
  const distillRes = await distillChatGroupInsights({
    minPendingMessages: 1,
    aiSettings: {
      ...getAiSettings(),
      enabled: true,
      baseUrl: "http://127.0.0.1:18317/v1",
      apiKey: "test-key",
      model: "gpt-6.2-sol:high",
      timeoutSec: 60,
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string; reasoning_effort?: string };
      usedModel = `${body.model}:${body.reasoning_effort ?? ""}`;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify([
                  {
                    title: "个体户小程序认证名称校验失败转接专线",
                    category: "实操排坑",
                    summary:
                      "个体户做微信小程序认证报主体名称校验失败时，可拨打 400-670-0700 要求转接小程序微信认证专员处理。",
                    keySpeakers: ["水晶-上海", "教练-码叔编程"],
                  },
                ]),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  assert.equal(usedModel, "gpt-6.2-sol:medium");
  assert.equal(distillRes.digestsCreated, 1);

  const digests = listChatDigests({ activityId: "10472" });
  assert.equal(digests.items.length, 1);
  assert.equal(digests.items[0]!.linkedBookTitle, "AI 产品（国内-微信小程序）");

  // HTTP 路由端到端验证（公开只读 GET + ADMIN_TOKEN 写保护）
  const app = new Hono();
  registerApi(app);
  (config as { adminToken: string }).adminToken = "secret-admin";

  const booksRes = await app.request("/api/manuals");
  assert.equal(booksRes.status, 200);
  const booksJson = (await booksRes.json()) as { books: Array<{ activityId: string }> };
  assert.equal(booksJson.books[0]?.activityId, "10472");

  const groupsRes = await app.request("/api/chat-radar/groups");
  assert.equal(groupsRes.status, 200);

  const digestsRes = await app.request("/api/chat-radar/digests?activityId=10472");
  assert.equal(digestsRes.status, 200);

  const ctxRes = await app.request(
    `/api/chat-radar/messages/context?groupKey=${encodeURIComponent("59015092545@chatroom")}&msgTime=${baseSec + 20}`,
  );
  assert.equal(ctxRes.status, 200);

  // 未授权写接口返回 401
  const unauthPatch = await app.request(
    `/api/chat-radar/groups/${encodeURIComponent("99999999999@chatroom")}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    },
  );
  assert.equal(unauthPatch.status, 401);

  // 携带 Bearer ADMIN_TOKEN 成功修改开关
  const authPatch = await app.request(
    `/api/chat-radar/groups/${encodeURIComponent("99999999999@chatroom")}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-admin",
      },
      body: JSON.stringify({ enabled: true }),
    },
  );
  assert.equal(authPatch.status, 200);
  const patchJson = (await authPatch.json()) as { ok: boolean; group: { enabled: boolean } };
  assert.equal(patchJson.ok, true);
  assert.equal(patchJson.group.enabled, true);

  // 公开站 (SITE_MODE=public) 未认证访客禁止读取私密微信群聊接口，且手册书架剥离 linkedGroups
  const prevSiteMode = config.siteMode;
  try {
    (config as { siteMode: string }).siteMode = "public";
    const pubGroupsRes = await app.request("/api/chat-radar/groups");
    assert.equal(pubGroupsRes.status, 403);
    const pubMsgsRes = await app.request("/api/chat-radar/messages?q=400");
    assert.equal(pubMsgsRes.status, 403);
    const pubManualsRes = await app.request("/api/manuals");
    assert.equal(pubManualsRes.status, 200);
    const pubManualsJson = (await pubManualsRes.json()) as {
      books: Array<{ linkedGroups: unknown[] }>;
    };
    assert.equal(pubManualsJson.books[0]?.linkedGroups.length, 0);

    // 公开站携带管理员凭据仍可正常访问
    const adminGroupsRes = await app.request("/api/chat-radar/groups", {
      headers: { authorization: "Bearer secret-admin" },
    });
    assert.equal(adminGroupsRes.status, 200);
  } finally {
    (config as { siteMode: string }).siteMode = prevSiteMode;
  }
});
