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
  PUSH_CHANNEL: "none",
  ENABLE_SCHEDULER: "false",
});

const { migrate, run, get, closeDb } = await import("../src/server/db.ts");
const { ensureSources, ingestItems } = await import("../src/server/collectors/index.ts");
const { ensureDossierTable } = await import("../src/server/dossier.ts");
const { registerApi } = await import("../src/server/routes.ts");
const { enrichItem } = await import("../src/server/enrich/index.ts");
const { getAiSettings, saveAiSettings, DEFAULT_AI_SETTINGS } = await import("../src/server/enrich/ai-settings.ts");
const { getOnboarding } = await import("../src/server/access.ts");
const { applyChannelQuery } = await import("../src/shared/channel-query.ts");
const { CHANNELS, CATEGORY_GROUPS, SCYS_CATEGORY_KEYS, CATEGORY_KEYS } = await import("../src/shared/taxonomy.ts");
const { SCYS_SYSTEM_PROMPT } = await import("../scripts/scys-preset.ts");
const { reclassifyScysVault } = await import("../scripts/scys-reclassify.ts");

const app = new Hono();
const now = new Date().toISOString();

before(() => {
  migrate();
  ensureSources();
  ensureDossierTable();
  registerApi(app);
});

after(() => {
  closeDb();
});

beforeEach(() => {
  run("DELETE FROM item_classification_overrides");
  run("DELETE FROM item_dossiers");
  run("DELETE FROM items");
  run("DELETE FROM settings WHERE key IN ('ai', 'onboarding')");
});

test("taxonomy: 新增 6 个商业赛道与 6 个生财频道，且 CATEGORY_GROUPS 全覆盖 32 个分类", () => {
  const allFromGroups = CATEGORY_GROUPS.flatMap((g) => g.categories);
  assert.equal(allFromGroups.length, CATEGORY_KEYS.length);
  assert.deepEqual(new Set(allFromGroups), new Set(CATEGORY_KEYS));
  assert.equal(SCYS_CATEGORY_KEYS.length, 16);
  for (const key of ["picks", "dossiers", "manuals", "projects", "tools", "perks"]) {
    assert.ok(CHANNELS.some((c) => c.key === key), `missing channel ${key}`);
  }
  assert.ok(SCYS_SYSTEM_PROMPT.includes("xiaohongshu"));
  assert.ok(!SCYS_SYSTEM_PROMPT.includes(" | vps | "));
});

test("access: 默认入站欢迎文案升级为生财雷达 v2", () => {
  const ob = getOnboarding();
  assert.equal(ob.title, "欢迎使用生财雷达");
  assert.equal(ob.version, 2);
  assert.ok(ob.content.includes("生财有术"));
  assert.ok(ob.content.includes("立项拆解书"));
});

test("enrichItem: scys-* 跳过过期日期猜测与兑换码提取，同时精准识别新商业赛道", () => {
  const item = enrichItem(
    {
      externalId: "scys-no-expire",
      url: "https://scys.com/t/999",
      title: "小红书虚拟资料矩阵实操：2026年12月31日前入局路线图",
      summary: "完整复用 SOP，使用优惠码 SAVE20 和 ABCD-EFGH-1234 跑通私域成交。",
    },
    "scys-highlights",
  )!;
  assert.equal(item.expiresAt, null);
  assert.deepEqual(item.codes, []);
  assert.equal(item.category, "xiaohongshu");

  const daily = enrichItem(
    {
      externalId: "scys-daily-1",
      url: "https://scys.com/t/1000",
      title: "生财日报 2026-11-27：出海工具站新风向",
      summary: "今日精选",
    },
    "scys-latest",
  )!;
  assert.equal(daily.category, "daily");

  // 含网盘链接的生财日报或闲鱼实战帖入库时不得被 isSharedResource 强制改写为 pan（否则会被 picks 频道排除）
  ingestItems("scys-latest", [
    {
      externalId: "scys-daily-quark",
      url: "https://scys.com/t/1001",
      title: "生财日报・2026.11.27",
      summary: "附圈友分享模板",
      content: "资料链接 https://pan.quark.cn/s/abcdef123456 提取码 8888",
      publishedAt: now,
    },
  ]);
  const stored = get<{ category: string }>("SELECT category FROM items WHERE external_id = 'scys-daily-quark'")!;
  assert.equal(stored.category, "daily");
});

test("routes & channel-query: 新频道 picks/dossiers/manuals/projects/tools/perks/top5 与 /api/stats 计数对齐", async () => {
  run(
    `INSERT INTO items (id, source_id, external_id, url, url_key, title, summary, category, kind, tags, ai_keep, ai_quality, score, status, published_at, first_seen_at, last_seen_at)
     VALUES
       (1, 'scys-highlights', 's1', 'https://scys.com/1', 'scys.com/1', 'AI Agent 拆解神帖', '精选', 'ai', 'info', '["风向标中标"]', 1, 5, 95, 'active', ?, ?, ?),
       (2, 'scys-manuals', 's2', 'https://scys.com/2', 'scys.com/2', '小红书无货源航海手册', '手册', 'xiaohongshu', 'info', '[]', 1, 4, 88, 'active', ?, ?, ?),
       (3, 'scys-projects', 's3', 'https://scys.com/3', 'scys.com/3', '闲鱼虚拟资料项目案例', '项目', 'ecommerce', 'info', '["项目库"]', 1, 5, 90, 'active', ?, ?, ?),
       (4, 'scys-latest', 's4', 'https://scys.com/4', 'scys.com/4', 'GitHub 开源工作流自动化工具', '工具', 'opensource', 'opensource', '[]', 1, 4, 85, 'active', ?, ?, ?),
       (5, 'scys-manuals', 's5', 'https://scys.com/5', 'scys.com/5', 'Cursor 编程航海指南', '手册开发', 'dev', 'info', '[]', 1, 3, 75, 'active', ?, ?, ?),
       (6, 'scys-latest', 's6', 'https://scys.com/6', 'scys.com/6', '限时白嫖 API 算力额度', '福利', 'software', 'freebie', '[]', 1, 4, 82, 'active', ?, ?, ?)`,
    now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now,
  );
  run(
    `INSERT INTO item_dossiers (item_id, payload, model, updated_at) VALUES (1, '{"verdict":"ok"}', 'gpt-6.2-astra', ?)`,
    now,
  );

  assert.deepEqual(applyChannelQuery({ preset: "top5" }), { preset: "top5", aiOnly: "1", minQuality: "5" });

  const fetchIds = async (preset: string) => {
    const res = await app.request(`/api/items?preset=${preset}&merge=0`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { items: Array<{ id: number }> };
    return data.items.map((x) => x.id).sort((a, b) => a - b);
  };

  assert.deepEqual(await fetchIds("picks"), [1, 3, 4, 6]);
  assert.deepEqual(await fetchIds("dossiers"), [1]);
  assert.deepEqual(await fetchIds("manuals"), [2, 5]);
  assert.deepEqual(await fetchIds("projects"), [1, 3]);
  assert.deepEqual(await fetchIds("tools"), [4]); // excludes scys-manuals dev (#5)
  assert.deepEqual(await fetchIds("perks"), [6]);
  assert.deepEqual(await fetchIds("top5"), [1, 3]);

  const statsRes = await app.request("/api/stats?preset=dossiers");
  assert.equal(statsRes.status, 200);
  const stats = (await statsRes.json()) as { byCategory: Array<{ category: string; n: number }> };
  assert.deepEqual(stats.byCategory, [{ category: "ai", n: 1 }]);
});

test("scys-reclassify: 零 Token 重分类支持 dry-run、清除假过期/兑换码、保留人工锁定、平滑刷新 AI 提示词", () => {
  saveAiSettings({
    ...DEFAULT_AI_SETTINGS,
    enabled: true,
    baseUrl: "https://custom-gateway.invalid/v1",
    apiKey: "keep-my-key",
    model: "gpt-6.2-sol:high",
    batchSize: 6,
    concurrency: 5,
    timeoutSec: 90,
    systemPrompt: "旧版提示词",
  });

  run(
    `INSERT INTO items (id, source_id, external_id, url, url_key, title, summary, category, kind, tags, codes, expires_at, ai, status, first_seen_at, last_seen_at)
     VALUES
       (10, 'scys-highlights', 'r10', 'https://scys.com/r10', 'scys.com/r10', '生财日报：本周风向速览', '总结', 'news', 'info', '["生财日报"]', '["FAKE-123"]', '2027-12-31T00:00:00.000Z', '{"keep":true,"category":"news"}', 'active', ?, ?),
       (11, 'scys-manuals', 'r11', 'https://scys.com/r11', 'scys.com/r11', 'TikTok 出海独立站实操手册', '跨境建站', 'other', 'info', '[]', '[]', NULL, '{"keep":true,"category":"other"}', 'active', ?, ?),
       (12, 'scys-manuals', 'r12', 'https://scys.com/r12', 'scys.com/r12', '生财大航海总纲与开营导读', '通用方法论', 'other', 'info', '[]', '[]', NULL, NULL, 'active', ?, ?),
       (13, 'scys-projects', 'r13', 'https://scys.com/r13', 'scys.com/r13', '小红书私域虚拟资料拆解', '稳定变现', 'stock', 'info', '["小红书"]', '[]', '2027-01-01T00:00:00.000Z', '{"keep":true,"category":"stock"}', 'active', ?, ?),
       (14, 'scys-highlights', 'r14', 'https://scys.com/r14', 'scys.com/r14', '小红书人工锁定样本', '不得覆盖', 'goods', 'info', '[]', '[]', NULL, '{"keep":true,"category":"goods"}', 'active', ?, ?)`,
    now, now, now, now, now, now, now, now, now, now,
  );
  run(
    `INSERT INTO item_classification_overrides (item_id, category, kind, note, updated_at)
     VALUES (14, 'goods', 'info', '人工锁定', ?)`,
    now,
  );

  // dryRun 不落库
  const dry = reclassifyScysVault({ dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.clearedExpires, 2);
  assert.equal(dry.clearedCodes, 1);
  assert.equal(dry.skippedManual, 1);
  assert.equal(dry.promptUpdated, true);
  assert.equal(dry.updated, 4);
  assert.equal(get<{ category: string }>("SELECT category FROM items WHERE id = 10")!.category, "news");

  // 正式执行
  const applied = reclassifyScysVault({ dryRun: false });
  assert.equal(applied.updated, 4);
  assert.equal(get<{ category: string; codes: string; expires_at: string | null; ai: string }>("SELECT category, codes, expires_at, ai FROM items WHERE id = 10")!.category, "daily");
  assert.equal(get<{ codes: string }>("SELECT codes FROM items WHERE id = 10")!.codes, "[]");
  assert.equal(get<{ expires_at: string | null }>("SELECT expires_at FROM items WHERE id = 10")!.expires_at, null);
  assert.equal(JSON.parse(get<{ ai: string }>("SELECT ai FROM items WHERE id = 10")!.ai).category, "daily");
  assert.equal(get<{ category: string }>("SELECT category FROM items WHERE id = 11")!.category, "overseas");
  assert.equal(get<{ category: string }>("SELECT category FROM items WHERE id = 12")!.category, "course");
  assert.equal(get<{ category: string }>("SELECT category FROM items WHERE id = 13")!.category, "xiaohongshu");
  assert.equal(get<{ expires_at: string | null }>("SELECT expires_at FROM items WHERE id = 13")!.expires_at, null);
  // 人工锁定不受影响
  assert.equal(get<{ category: string }>("SELECT category FROM items WHERE id = 14")!.category, "goods");

  // AI prompt 刷新同时完整保留网关、模型与并发参数
  const aiAfter = getAiSettings();
  assert.equal(aiAfter.systemPrompt, SCYS_SYSTEM_PROMPT);
  assert.equal(aiAfter.baseUrl, "https://custom-gateway.invalid/v1");
  assert.equal(aiAfter.apiKey, "keep-my-key");
  assert.equal(aiAfter.model, "gpt-6.2-sol:high");
  assert.equal(aiAfter.batchSize, 6);
  assert.equal(aiAfter.concurrency, 5);
  assert.equal(aiAfter.timeoutSec, 90);

  // 幂等性验证
  const second = reclassifyScysVault({ dryRun: false });
  assert.equal(second.updated, 0);
  assert.equal(second.clearedExpires, 0);
  assert.equal(second.clearedCodes, 0);
  assert.equal(second.promptUpdated, false);
});
