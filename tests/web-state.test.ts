import assert from "node:assert/strict";
import { test } from "node:test";
import { selectGuestItems } from "../src/web/src/lib/session.ts";
import { installAuthFetch, verifyToken, setToken, clearToken } from "../src/web/src/lib/auth.ts";
import { isSafeHttpUrl, isSummaryCoveredByContent, parseSnapshotSections, plainCharCount, splitReasonBadge } from "../src/web/src/lib/snapshot.ts";

test("访客已关闭、收藏与已读视图互相联动，不把隐藏条目再过滤掉", () => {
  const items = [1, 2, 3].map((id) => ({ id, title: `条目 ${id}`, summary: null, starred: false, read: false, status: "active" }));
  const state = { hidden: [1], starred: [1, 2], read: [2], blocked: [] };
  assert.deepEqual(selectGuestItems(items, state, "hidden").map((i) => i.id), [1]);
  assert.equal(selectGuestItems(items, state, "hidden")[0]?.status, "ignored");
  assert.deepEqual(selectGuestItems(items, state, "starred").map((i) => i.id), [2]);
  assert.deepEqual(selectGuestItems(items, state, "all", true).map((i) => i.id), [3]);
});

test("fetch 仅向同源 API 附加管理 Token；Request 的其他头保留，错误凭据验证失败", async () => {
  const store = new Map<string, string>();
  Object.assign(globalThis, {
    sessionStorage: { getItem: (key: string) => store.get(key), setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) },
  });
  const calls: { url: string; headers: Headers }[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), headers: new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)) });
    return new Response('{"ok":true,"isAdmin":false}', { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const mockWindow = { location: { href: "https://radar.example/", origin: "https://radar.example" }, fetch: fakeFetch, dispatchEvent: () => true };
  Object.assign(globalThis, { window: mockWindow });
  installAuthFetch(); setToken("secret");
  await mockWindow.fetch("https://third-party.example/a");
  assert.equal(calls.at(-1)!.headers.has("authorization"), false);
  await mockWindow.fetch("/assets/a.js");
  assert.equal(calls.at(-1)!.headers.has("authorization"), false);
  await mockWindow.fetch(new Request("https://radar.example/api/items", { headers: { accept: "application/json", "x-test": "kept" } }));
  assert.equal(calls.at(-1)!.headers.get("authorization"), "Bearer secret");
  assert.equal(calls.at(-1)!.headers.get("x-test"), "kept");
  const original = globalThis.fetch;
  globalThis.fetch = mockWindow.fetch;
  try { assert.equal(await verifyToken("wrong"), false); }
  finally { globalThis.fetch = original; clearToken(); }
});

test("快照分段解析、字数统计、XSS URL 白名单与 reason 底牌徽章拆分", () => {
  const sample = [
    "【分类】AI应用 | 【热度】99",
    "",
    '<div class="tiptap-wrapper"><h2>实战步骤</h2><p>第一步：打开控制台。</p></div>',
    "",
    "【飞书文档内容】",
    "飞书附表说明",
    "",
    "【关联文档】",
    "操作清单: https://example.com/doc",
    "",
    "【精选评论】",
    "张三: 实测有效，感谢分享",
    "李四：已复现",
  ].join("\n");

  const parsed = parseSnapshotSections(sample);
  assert.equal(parsed.metaLine, "【分类】AI应用 | 【热度】99");
  assert.ok(parsed.body.includes("<h2>实战步骤</h2>"));
  assert.equal(parsed.feishuDoc, "飞书附表说明");
  assert.deepEqual(parsed.relatedDocs, ["操作清单: https://example.com/doc"]);
  assert.deepEqual(parsed.comments, [
    { author: "张三", body: "实测有效，感谢分享" },
    { author: "李四", body: "已复现" },
  ]);

  assert.equal(plainCharCount('<div class="tiptap-wrapper"><p>你好 世界</p></div>'), 4);
  assert.equal(isSafeHttpUrl("javascript:alert(1)"), null);
  assert.equal(isSafeHttpUrl("https://scys.com/articleDetail/xq_topic/1"), "https://scys.com/articleDetail/xq_topic/1");
  assert.equal(
    isSummaryCoveredByContent("第一步：打开控制台…", "第一步：打开控制台，配置工作流并运行测试验证结果。".repeat(12)),
    true,
  );
  assert.deepEqual(splitReasonBadge("[需基础剪辑] 拆解TikTok矩阵号"), {
    badge: "需基础剪辑",
    text: "拆解TikTok矩阵号",
  });
});
