import assert from "node:assert/strict";
import { test } from "node:test";
import { selectGuestItems } from "../src/web/src/lib/session.ts";
import { installAuthFetch, verifyToken, setToken, clearToken } from "../src/web/src/lib/auth.ts";
import {
  isSafeHttpUrl,
  isSummaryCoveredByContent,
  looksLikeHtml,
  parseMarkdownBlocks,
  parseSnapshotSections,
  plainCharCount,
  splitReasonBadge,
} from "../src/web/src/lib/snapshot.ts";

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

test("looksLikeHtml 正确区分含 <br>/代码块示例的 Markdown 与真实 HTML 快照", () => {
  const manualMd = [
    "### 01. 找对标账号",
    "",
    "对标账号说明，[打开工具站](https://sail.zuoyeguanli.top/#creators)。",
    "",
    "##### 类型一：AI 工具／AI 教程",
    "",
    "| 编号 / 账号 | 配图 | 代表作 / 链接 |",
    "| --- | --- | --- |",
    "| [01｜卡尔](https://www.xiaohongshu.com/user/1) | ![图片](https://img.example.com/a.png) | 内容简介<br>[查看原作](https://www.xiaohongshu.com/user/1/post) |",
  ].join("\n");
  assert.equal(looksLikeHtml(manualMd), false);

  const mdWithCodeHtml = [
    "### HTML 模板示例",
    "",
    "```html",
    "<div class=\"card\"><p>示例</p></div>",
    "```",
    "",
    "行内代码 `<p>tag</p>` 也不应误判。",
  ].join("\n");
  assert.equal(looksLikeHtml(mdWithCodeHtml), false);

  assert.equal(looksLikeHtml('<div class="tiptap-wrapper"><p>正文</p></div>'), true);
  assert.equal(looksLikeHtml('<a href="https://scys.com">原文链接</a>'), true);
});

test("parseMarkdownBlocks 支持 H5/H6 标题、GFM 表格对齐/转义与任务列表", () => {
  const md = [
    "##### 类型一：AI 工具",
    "###### 子分类说明",
    "",
    "| 账号 | 报价 | 说明 |",
    "| :--- | :---: | ---: |",
    "| [01](https://example.com) | ¥100 | 第一行<br>第二行 \\| `a|b` |",
    "",
    "- [x] 已完成",
    "- [ ] 待处理",
  ].join("\n");

  const blocks = parseMarkdownBlocks(md);
  assert.equal(blocks.length, 4);
  assert.deepEqual(blocks[0], { type: "heading", level: 5, text: "类型一：AI 工具" });
  assert.deepEqual(blocks[1], { type: "heading", level: 6, text: "子分类说明" });
  assert.deepEqual(blocks[2], {
    type: "table",
    headers: ["账号", "报价", "说明"],
    aligns: ["left", "center", "right"],
    rows: [["[01](https://example.com)", "¥100", "第一行<br>第二行 | `a|b`"]],
  });
  assert.deepEqual(blocks[3], {
    type: "ul",
    items: [
      { checked: true, text: "已完成" },
      { checked: false, text: "待处理" },
    ],
  });
});

test("parseSnapshotSections 支持多段换行评论、楼主与点赞徽章及楼中楼二级回复且不误拆冒号行", () => {
  const raw = [
    "主帖正文第一段",
    "",
    "【精选评论】",
    "💬 欢乐马 [楼主·👍3]: 作者补充两条实操细节：",
    "",
    "第一步：用 Scamalytics 查欺诈分",
    "第二步：确认节点地区与账单地址一致",
    "",
    "![](https://scys.com/img/step3.png)",
    "💬 逸尘: 老大，这个上传上去就是默认商用授权嘛",
    "  ↳ 亦仁 [楼主·👍2] 回复 逸尘: 还没考虑过这个，有啥建议吗",
    "    后续可以做付费 Skill 授权",
  ].join("\n");

  const parsed = parseSnapshotSections(raw);
  assert.equal(parsed.body, "主帖正文第一段");
  assert.equal(parsed.comments.length, 2);
  assert.deepEqual(parsed.comments[0], {
    author: "欢乐马",
    isAuthor: true,
    likes: 3,
    body: [
      "作者补充两条实操细节：",
      "",
      "第一步：用 Scamalytics 查欺诈分",
      "第二步：确认节点地区与账单地址一致",
      "",
      "![](https://scys.com/img/step3.png)",
    ].join("\n"),
  });
  assert.deepEqual(parsed.comments[1], {
    author: "逸尘",
    body: "老大，这个上传上去就是默认商用授权嘛",
    replies: [
      {
        author: "亦仁",
        isAuthor: true,
        likes: 2,
        replyTo: "逸尘",
        body: "还没考虑过这个，有啥建议吗\n后续可以做付费 Skill 授权",
      },
    ],
  });
});
