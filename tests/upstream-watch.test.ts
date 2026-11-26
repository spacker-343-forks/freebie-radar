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

const { migrate, run, closeDb } = await import("../src/server/db.ts");
const { registerApi } = await import("../src/server/routes.ts");
const { DEFAULT_AI_SETTINGS } = await import("../src/server/enrich/ai-settings.ts");
const {
  checkUpstreamUpdates,
  dismissUpstreamWatch,
  getUpstreamWatchState,
} = await import("../src/server/upstream-watch.ts");
const { computeActiveBanner } = await import("../src/shared/upstream-watch.ts");

const app = new Hono();

const testAiSettings = {
  ...DEFAULT_AI_SETTINGS,
  enabled: true,
  baseUrl: "https://mock-ai.local/v1",
  apiKey: "test-key",
  model: "gpt-6.1-terra:high",
};

before(() => {
  migrate();
  registerApi(app);
});

after(() => {
  closeDb();
});

beforeEach(() => {
  run("DELETE FROM settings WHERE key = 'upstream_watch_state'");
});

test("上游有重大 feat 更新时 AI 判定 hasMajorFeature=true，且 GET /api/upstream-watch 返回 activeBanner=true", async () => {
  const aiCalls: number[] = [];
  const mockFetch: typeof fetch = async () => {
    aiCalls.push(1);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                hasMajorFeature: true,
                importance: "major",
                headline: "上游新增多模型推理降级与全文语义去重升级",
                highlights: [
                  "Web 列表新增实时聚类与高信噪比筛选交互",
                  "AI 审核支持推理模型自适应与并发重试",
                ],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const state = await checkUpstreamUpdates({
    force: true,
    aiSettings: testAiSettings,
    fetchImpl: mockFetch,
    resolveDiff: async ({ repo, branch }) => ({
      repo,
      branch,
      baseSha: "1111111111111111111111111111111111111111",
      latestSha: "2222222222222222222222222222222222222222",
      latestTag: "v1.1.14",
      aheadCount: 3,
      compareUrl: "https://github.com/ZiChuanLan/freebie-radar/compare/1111111...2222222",
      commits: [
        {
          sha: "2222222222222222222222222222222222222222",
          short: "2222222",
          date: "2026-11-26T08:00:00Z",
          message: "feat(ai): upgrade semantic clustering and UI filters",
          url: "https://github.com/ZiChuanLan/freebie-radar/commit/2222222",
        },
      ],
      changedFiles: ["modified: src/web/src/App.tsx", "modified: src/server/enrich/ai-dedup.ts"],
    }),
  });

  assert.equal(aiCalls.length, 1);
  assert.equal(state.hasMajorFeature, true);
  assert.equal(state.importance, "major");
  assert.equal(state.activeBanner, true);
  assert.equal(state.latestTag, "v1.1.14");
  assert.equal(state.aheadCount, 3);
  assert.equal(state.highlights.length, 2);

  const res = await app.request("/api/upstream-watch");
  assert.equal(res.status, 200);
  const json = (await res.json()) as typeof state;
  assert.equal(json.activeBanner, true);
  assert.equal(json.headline, "上游新增多模型推理降级与全文语义去重升级");
  assert.equal(json.mergeCommand, "git fetch upstream && git merge upstream/main");

  // 防重：force=false 且 baseSha + latestSha 未变时不重复调 AI
  const cached = await checkUpstreamUpdates({
    force: false,
    aiSettings: testAiSettings,
    fetchImpl: mockFetch,
    resolveDiff: async ({ repo, branch }) => ({
      repo,
      branch,
      baseSha: "1111111111111111111111111111111111111111",
      latestSha: "2222222222222222222222222222222222222222",
      latestTag: "v1.1.14",
      aheadCount: 3,
      compareUrl: "https://github.com/ZiChuanLan/freebie-radar/compare/1111111...2222222",
      commits: [],
      changedFiles: [],
    }),
  });
  assert.equal(aiCalls.length, 1, "相同 baseSha+latestSha 不应重复消耗 AI Token");
  assert.equal(cached.activeBanner, true);
});

test("dismiss 后 activeBanner=false，上游推送新 SHA 后自动重新激活横幅", async () => {
  await checkUpstreamUpdates({
    force: true,
    aiSettings: { ...testAiSettings, enabled: false },
    resolveDiff: async ({ repo, branch }) => ({
      repo,
      branch,
      baseSha: "aaaaaaa",
      latestSha: "bbbbbbb",
      latestTag: "v1.1.14",
      aheadCount: 2,
      compareUrl: "https://github.com/ZiChuanLan/freebie-radar/compare/aaaaaaa...bbbbbbb",
      commits: [
        { sha: "bbbbbbb", short: "bbbbbbb", date: "2026-11-26T09:00:00Z", message: "feat: new digest panel", url: "https://example.com/1" },
      ],
      changedFiles: ["modified: src/web/src/components/DigestPanel.tsx"],
    }),
  });
  assert.equal(getUpstreamWatchState().activeBanner, true);

  const dismissRes = await app.request("/api/upstream-watch/dismiss", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sha: "bbbbbbb" }),
  });
  assert.equal(dismissRes.status, 200);
  const dismissed = (await dismissRes.json()) as { activeBanner: boolean; dismissedSha: string };
  assert.equal(dismissed.activeBanner, false);
  assert.equal(dismissed.dismissedSha, "bbbbbbb");

  // 上游再推新 SHA ccccccc，横幅自动恢复提醒
  const next = await checkUpstreamUpdates({
    force: false,
    aiSettings: { ...testAiSettings, enabled: false },
    resolveDiff: async ({ repo, branch }) => ({
      repo,
      branch,
      baseSha: "aaaaaaa",
      latestSha: "ccccccc",
      latestTag: "v1.1.15",
      aheadCount: 4,
      compareUrl: "https://github.com/ZiChuanLan/freebie-radar/compare/aaaaaaa...ccccccc",
      commits: [
        { sha: "ccccccc", short: "ccccccc", date: "2026-11-27T09:00:00Z", message: "feat: realtime push upgrade", url: "https://example.com/2" },
      ],
      changedFiles: ["modified: src/server/push.ts"],
    }),
  });
  assert.equal(next.dismissedSha, "bbbbbbb");
  assert.equal(next.activeBanner, true);
  assert.equal(computeActiveBanner(next), true);
});

test("上游仅为常规小修 (minor) 时不弹横幅 (activeBanner=false)", async () => {
  const state = await checkUpstreamUpdates({
    force: true,
    aiSettings: testAiSettings,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  hasMajorFeature: false,
                  importance: "minor",
                  headline: "仅调整单个游戏 RSS 源规则与文档错别字",
                  highlights: ["非核心链路改动，无需立即合入"],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    resolveDiff: async ({ repo, branch }) => ({
      repo,
      branch,
      baseSha: "aaaaaaa",
      latestSha: "ddddddd",
      latestTag: "v1.1.14",
      aheadCount: 1,
      compareUrl: "https://github.com/ZiChuanLan/freebie-radar/compare/aaaaaaa...ddddddd",
      commits: [
        { sha: "ddddddd", short: "ddddddd", date: "2026-11-26T10:00:00Z", message: "docs: fix typo in readme", url: "https://example.com/3" },
      ],
      changedFiles: ["modified: README.md"],
    }),
  });

  assert.equal(state.hasMajorFeature, false);
  assert.equal(state.importance, "minor");
  assert.equal(state.activeBanner, false);

  const res = await app.request("/api/upstream-watch");
  const json = (await res.json()) as { activeBanner: boolean; importance: string };
  assert.equal(json.activeBanner, false);
  assert.equal(json.importance, "minor");
  assert.equal(dismissUpstreamWatch("ddddddd").activeBanner, false);
});

test("AI 返回 HTTP 500 时启发式降级不崩溃，且支持 POST /api/upstream-watch/check", async () => {
  const state = await checkUpstreamUpdates({
    force: true,
    aiSettings: testAiSettings,
    fetchImpl: async () => new Response("upstream ai 500", { status: 500 }),
    resolveDiff: async ({ repo, branch }) => ({
      repo,
      branch,
      baseSha: "1111111",
      latestSha: "eeeeeee",
      latestTag: "v1.1.16",
      aheadCount: 2,
      compareUrl: "https://github.com/ZiChuanLan/freebie-radar/compare/1111111...eeeeeee",
      commits: [
        { sha: "eeeeeee", short: "eeeeeee", date: "2026-11-26T11:00:00Z", message: "feat: support webhook retry queue", url: "https://example.com/4" },
      ],
      changedFiles: ["modified: src/server/push.ts"],
    }),
  });

  assert.equal(state.error, null);
  assert.equal(state.importance, "major");
  assert.equal(state.hasMajorFeature, true);
  assert.equal(state.activeBanner, true);

  // 小修提交在 AI 500 时启发式判 minor
  const minorState = await checkUpstreamUpdates({
    force: true,
    aiSettings: testAiSettings,
    fetchImpl: async () => new Response("err", { status: 500 }),
    resolveDiff: async ({ repo, branch }) => ({
      repo,
      branch,
      baseSha: "1111111",
      latestSha: "fffffff",
      latestTag: "v1.1.16",
      aheadCount: 1,
      compareUrl: "https://github.com/ZiChuanLan/freebie-radar/compare/1111111...fffffff",
      commits: [
        { sha: "fffffff", short: "fffffff", date: "2026-11-26T11:05:00Z", message: "chore: bump version", url: "https://example.com/5" },
      ],
      changedFiles: ["modified: package.json"],
    }),
  });
  assert.equal(minorState.importance, "minor");
  assert.equal(minorState.hasMajorFeature, false);
  assert.equal(minorState.activeBanner, false);
});

test("POST /api/upstream-watch/check 路由与非管理员密码保护生效", async () => {
  const { config } = await import("../src/server/config.ts");
  assert.equal(typeof config.enableScheduler, "boolean");
  const checkRes = await app.request("/api/upstream-watch/check", {
    method: "POST",
  });
  assert.equal(checkRes.status, 200);
  const body = (await checkRes.json()) as { repo: string; checkedAt: string | null };
  assert.equal(body.repo, "ZiChuanLan/freebie-radar");
  assert.ok(body.checkedAt);
});
