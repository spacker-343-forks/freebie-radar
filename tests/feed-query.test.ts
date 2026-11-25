import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { applyChannelQuery } from "../src/shared/channel-query.ts";
import { DEFAULT_FEED_STATE, buildFeedQuery, buildStatsQuery, countAdditionalFilters, feedPolicyLabels, readFeedState, writeFeedSearch, type FeedState } from "../src/web/src/lib/feedQuery.ts";
import { configurationBase, configurationScope, readTab, readWorkspaceScope, tabUrl } from "../src/web/src/lib/navigation.ts";

const state = (patch: Partial<FeedState> = {}): FeedState => ({ ...DEFAULT_FEED_STATE, categories: [], ...patch });
const now = Date.now();
let app: Hono;
let closeDb: () => void;
before(async () => {
  Object.assign(process.env, { DATABASE_PATH: ":memory:", SITE_MODE: "selfhost", NODE_ENV: "test", ADMIN_TOKEN: "", AI_BASE_URL: "", AI_MODEL: "", PUSH_CHANNEL: "none", ENABLE_SCHEDULER: "false" });
  const db = await import("../src/server/db.ts");
  const { ensureSources, ingestItems } = await import("../src/server/collectors/index.ts");
  const { registerApi } = await import("../src/server/routes.ts");
  db.migrate(); ensureSources(); closeDb = db.closeDb;
  for (const [id, name, age, expired] of [["ui-recent", "PhotoEditor", 2, false], ["ui-month", "AudioToolkit", 20, false], ["ui-older", "CodeStudio", 40, false], ["ui-expired", "VideoSuite", 1, true]] as const) {
    ingestItems("rss-nodeseek", [{ externalId: id, title: `免费领取 ${name} 正版授权`, summary: "无需付款，永久保留。", url: `https://example.com/ui-test/${id}` }]);
    db.run("UPDATE items SET kind='freebie',category='software',obtain='free',ai_keep=1,score=90,published_at=?,expires_at=? WHERE external_id=?", new Date(now - age * 86_400_000).toISOString(), expired ? new Date(now - 3600_000).toISOString() : null, id);
  }
  app = new Hono(); registerApi(app);
});
after(() => closeDb?.());

for (const preset of ["verified", "offline", "pan", "deal", "opensource", "news", "info", "codes", "urgent", "starred", "hidden", "all"]) {
  test(`feed query uses shared policy: ${preset}`, () => {
    const actual = Object.fromEntries(new URLSearchParams(buildFeedQuery(state({ preset }), now)));
    const expected = applyChannelQuery({ preset, sort: "newest", limit: "100" });
    assert.deepEqual(actual, expected);
  });
}

test("default channel rules are not counted as additional filters", () => {
  assert.equal(countAdditionalFilters(state()), 0);
  assert.deepEqual(feedPolicyLabels(buildFeedQuery(state())), ["隐藏审核拒绝"]);
  assert.deepEqual(feedPolicyLabels(buildFeedQuery(state({ preset: "verified" }))), ["审核保留", "未过期", "近7天", "直接或有条件领取"]);
  assert.equal(countAdditionalFilters(state({ search: " key ", categories: ["ai", "software"], unreadOnly: true })), 3);
});

test("URL round trip restores every visible feed filter without changing UI language or workspace", () => {
  const original = state({ preset: "all", search: "API key 中文", source: "rss-nodeseek", categories: ["ai", "software"], lang: "en", sort: "score", range: "30d", priceCap: "10", minScore: "70", obtain: "paid", kindFilter: "deal", unreadOnly: true });
  const url = writeFeedSearch("?lang=zh&login_ok=demo&workspace=personal&other=keep", original);
  assert.deepEqual(readFeedState(url), original);
  const p = new URLSearchParams(url);
  assert.equal(p.get("lang"), "zh"); assert.equal(p.get("filterLang"), "en");
  assert.equal(p.get("login_ok"), "demo"); assert.equal(p.get("workspace"), "personal");
  assert.equal(p.get("other"), "keep");
  assert.equal(new URLSearchParams(writeFeedSearch(url, state())).has("q"), false);
});

test("unknown URL values cannot create blank selectors or evade channel categories", () => {
  const parsed = readFeedState("?preset=unknown&kind=bogus&obtain=bogus&range=forever&price=-1&score=900&sort=magic&filterLang=ja&category=pan,ai,ai,bogus");
  assert.deepEqual(parsed, state({ categories: ["ai"] }));
});

test("explicit selectors and time windows override defaults, not channel exclusions", () => {
  const q = new URLSearchParams(buildFeedQuery(state({ preset: "verified", categories: ["ai"], kindFilter: "all", obtain: "all", range: "30d", priceCap: "free" }), now));
  assert.equal(q.get("kind"), ""); assert.equal(q.get("obtain"), "");
  assert.equal(q.get("maxAgeDays"), "30"); assert.equal(q.get("freeOnly"), "1");
  assert.equal(q.get("unexpired"), "1"); assert.ok(q.get("excludeCategory")?.includes("lottery"));
  assert.equal(q.get("since"), new Date(now - 30 * 86_400_000).toISOString());
});

test("category counts keep channel policy while removing only category, sort and limit", () => {
  const q = new URLSearchParams(buildStatsQuery(buildFeedQuery(state({ preset: "verified", categories: ["ai"], search: "credit", unreadOnly: true }))));
  assert.equal(q.has("category"), false); assert.equal(q.has("sort"), false); assert.equal(q.has("limit"), false);
  assert.equal(q.get("search"), "credit"); assert.equal(q.get("unread"), "1");
  assert.equal(q.get("aiOnly"), "1"); assert.ok(q.get("excludeCategory")?.includes("pan"));
});

test("admin navigation is a real route and every destination retains feed search", () => {
  for (const tab of ["feed", "hot", "digest", "me", "rules", "push", "ai", "ops", "site", "admin"] as const) {
    const url = tabUrl("/", "?preset=news&q=API", tab);
    assert.equal(readTab(new URL(url, "http://localhost").hash), tab);
    assert.ok(url.includes("?preset=news&q=API"));
  }
  assert.equal(readTab("#login-error"), "feed");
});

test("admin login does not silently convert personal settings into global settings", () => {
  assert.equal(configurationBase("personal", true, true, false), "/api/me");
  assert.equal(configurationBase("personal", true, true, true), "/api/me");
  assert.equal(configurationBase("site", true, true, false), null);
  assert.equal(configurationBase("site", true, true, true), "/api");
  assert.equal(configurationBase("personal", false, false, false), null);
  assert.equal(configurationBase("personal", false, false, true), "/api");
  assert.equal(configurationScope("personal", true, false), "site");
  assert.equal(readWorkspaceScope("?workspace=site"), "site");
});
test("unlimited publication age does not relax other numeric query guards", async () => {
  for (const invalid of ["limit=all", "maxAgeDays=invalid", "maxAgeDays=Infinity", "maxPrice=-1"]) {
    assert.equal((await app.request("/api/items?" + invalid)).status, 400);
  }
});

for (const [range, expected] of [["auto", ["ui-recent"]], ["30d", ["ui-recent", "ui-month"]], ["all", ["ui-recent", "ui-month", "ui-older"]]] as const) {
  test(`API time selection actually matches the UI: ${range}; expired offers stay hidden`, async () => {
    const response = await app.request("/api/items?" + buildFeedQuery(state({ preset: "verified", range }), now));
    assert.equal(response.status, 200);
    const body = await response.json() as { items: { external_id: string }[] };
    assert.deepEqual(body.items.map((item) => item.external_id).sort(), [...expected].sort());
  });
}
