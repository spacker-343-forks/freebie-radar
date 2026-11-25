import assert from "node:assert/strict";
import { after, before, test } from "node:test";

// 在导入 db/config 前强制走内存库并屏蔽本机 .env AI/推送开关，避免测试结果随 .env 漂移或发起外网请求
Object.assign(process.env, {
  DATABASE_PATH: ":memory:",
  AI_BASE_URL: "",
  AI_MODEL: "",
  AI_API_KEY: "",
  PUSH_CHANNEL: "none",
  ENABLE_SCHEDULER: "false",
});

const { migrate, run, closeDb } = await import("../src/server/db.ts");
const { dedupeByTitle, extractMergeKeys, mergeKey, TitleDeduper } = await import("../src/server/enrich/dedup.ts");
const { pickDaily } = await import("../src/server/digest.ts");

before(() => {
  migrate();
});

after(() => {
  closeDb();
});

test("extractMergeKeys：中英双语《》同时抽中文与英文别名", () => {
  assert.deepEqual(
    extractMergeKeys("Epic 喜加一：《斗阵骑士 Knightica》游戏免费领取"),
    ["knightica", "斗阵骑士"],
  );
  assert.deepEqual(
    extractMergeKeys("Epic《斗阵骑士》免费领，11月20日0点截止"),
    ["斗阵骑士"],
  );
  assert.deepEqual(
    extractMergeKeys("【Epic移动版】《斗阵骑士》本周免费领取"),
    ["斗阵骑士"],
  );
  assert.deepEqual(
    extractMergeKeys("【Epic】免费领取《斗阵骑士》（Knightica）"),
    ["knightica", "斗阵骑士"],
  );
  assert.deepEqual(
    extractMergeKeys("【gamesforfarm】完成任务免费领取《Milf City》"),
    ["milf city"],
  );
});

test("mergeKey：非《》中文标题保留主体词，不误合并不同商家", () => {
  const zhipu = mergeKey("智谱的coding plan免费送【7天体验卡】");
  const ali = mergeKey("阿里云 coding plan 免费送");
  assert.ok(zhipu.includes("智谱"));
  assert.ok(ali.includes("阿里云"));
  assert.notEqual(zhipu, ali);

  // 《AFF》不当作书名，不退化成 "aff windows"
  const tianyi = mergeKey("《AFF》天翼的免费云电脑，8G+4核，竟然是Windows的");
  assert.ok(tianyi.includes("天翼"));
  assert.notEqual(tianyi, "aff windows");

  // 英文游戏与无《》中文标题也能打通
  assert.equal(mergeKey("Epic 免费领 Flotsam"), "flotsam");
  assert.equal(mergeKey("Flotsam is free on Epic Games Store"), "flotsam");
});

test("TitleDeduper：无论排序先后，双语桥接都能把英文/双语/纯中文归为同一组", () => {
  const items = [
    { id: 1, title: "Knightica is free on Epic Games Store" },
    { id: 2, title: "Epic《斗阵骑士》免费领，11月20日0点截止" },
    { id: 3, title: "Epic 喜加一：《斗阵骑士 Knightica》游戏免费领取" },
    { id: 4, title: "【Epic移动版】《斗阵骑士》本周免费领取" },
    { id: 5, title: "【gamesforfarm】完成任务免费领取《Milf City》" },
  ];
  const out = dedupeByTitle(items);
  assert.deepEqual(out.map((i) => i.id), [1, 5]);
});

test("TitleDeduper：无《》中文近重复能合并，不同品牌不误并", () => {
  const items = [
    { id: 1, title: "阿里云免费领取 3 个月 ECS 云服务器" },
    { id: 2, title: "阿里云免费领3个月ECS云服务器体验" },
    { id: 3, title: "腾讯云免费领取 3 个月轻量服务器" },
    { id: 4, title: "智谱的coding plan免费送【7天体验卡】" },
    { id: 5, title: "阿里云百炼 coding plan 免费送" },
  ];
  const out = dedupeByTitle(items);
  assert.deepEqual(out.map((i) => i.id), [1, 3, 4, 5]);
});

test("TitleDeduper：跨日 seed 命中英文版时，后续中文与双语版也被拦截", () => {
  const seeds = [{ title: "[Epic Games] (Game) Knightica" }];
  const today = [
    { id: 10, title: "Epic《斗阵骑士》免费领，11月20日0点截止" },
    { id: 11, title: "Epic 喜加一：《斗阵骑士 Knightica》游戏免费领取" },
    { id: 12, title: "【Epic移动版】《斗阵骑士》本周免费领取" },
    { id: 13, title: "【gamesforfarm】完成任务免费领取《Milf City》" },
  ];
  const deduper = new TitleDeduper(today, seeds);
  assert.equal(deduper.isDuplicate(today[0]!), true);
  assert.equal(deduper.isDuplicate(today[1]!), true);
  assert.equal(deduper.isDuplicate(today[2]!), true);
  assert.equal(deduper.isDuplicate(today[3]!), false);
});

test("pickDaily：同轮多个来源报道《斗阵骑士》只保留 1 条并自动顺延补足条数", () => {
  const now = new Date().toISOString();
  const sample = [
    { id: 1, src: "linuxdo-welfare", cat: "other", score: 88, title: "智谱的coding plan免费送【7天体验卡】" },
    { id: 2, src: "rss-ithome", cat: "game", score: 85, title: "Epic 喜加一：《斗阵骑士 Knightica》游戏免费领取" },
    { id: 3, src: "rss-nodeseek", cat: "other", score: 82, title: "免费1GB流量eSIM 大陆可以用 多地区 🈚aff" },
    { id: 4, src: "linuxdo-welfare", cat: "other", score: 80, title: "众安银行lv2拼团，免费领实体卡攻略" },
    { id: 5, src: "rss-nodeseek", cat: "ai", score: 78, title: "《AFF》天翼的免费云电脑，8G+4核，竟然是Windows的" },
    { id: 6, src: "rss-smzdm", cat: "game", score: 76, title: "Epic《斗阵骑士》免费领，11月20日0点截止" },
    { id: 7, src: "rss-keylol", cat: "game", score: 74, title: "【Epic移动版】《斗阵骑士》本周免费领取" },
    { id: 8, src: "rss-keylol", cat: "game", score: 72, title: "【gamesforfarm】完成任务免费领取《Milf City》" },
    { id: 9, src: "steam-free", cat: "game", score: 70, title: "Steam 免费领取《Flotsam》游戏本体" },
    { id: 10, src: "v2ex-free", cat: "cloud", score: 68, title: "免费领取 Cloudflare R2 10GB 永久额度" },
  ];

  for (const s of sample) {
    run(
      `INSERT INTO items (id, source_id, external_id, url, url_key, title, title_key, category, score, published_at, status, is_free, obtain, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, 'free', ?, ?)`,
      s.id,
      s.src,
      String(s.id),
      `https://example.com/${s.id}`,
      `example.com/${s.id}`,
      s.title,
      mergeKey(s.title),
      s.cat,
      s.score,
      now,
      now,
      now,
    );
  }

  const picked = pickDaily(new Date(), 8);
  assert.equal(picked.length, 8);
  const pickedIds = picked.map((p) => p.id);
  // 2、6、7 同属《斗阵骑士》，只保留高分 #2，自动顺延补进 #9 与 #10
  assert.deepEqual(pickedIds, [1, 2, 3, 4, 5, 8, 9, 10]);

  // 昨日日报如果已经发过英文版 Knightica，今日再挑精选时 2/6/7 应全部跳过
  const yesterday = new Date(Date.now() - 86_400_000);
  const yDay = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
  run(
    `INSERT INTO items (id, source_id, external_id, url, url_key, title, title_key, category, score, published_at, status, is_free, obtain, first_seen_at, last_seen_at)
     VALUES (99, 'epic-free', '99', 'https://example.com/99', 'example.com/99', 'Knightica is free on Epic Games Store', 'knightica', 'game', 90, ?, 'active', 1, 'free', ?, ?)`,
    yesterday.toISOString(),
    yesterday.toISOString(),
    yesterday.toISOString(),
  );
  run(
    "INSERT INTO digests (date, item_ids, payload, created_at, pushed_at) VALUES (?, ?, '{}', ?, ?)",
    yDay,
    JSON.stringify([99]),
    yesterday.toISOString(),
    yesterday.toISOString(),
  );

  const pickedNext = pickDaily(new Date(), 8);
  const nextIds = pickedNext.map((p) => p.id);
  assert.equal(nextIds.includes(2), false);
  assert.equal(nextIds.includes(6), false);
  assert.equal(nextIds.includes(7), false);
});

test("mergeKey：Bluesky / TG / Reddit / IndieGameBundles 长尾推文全部收敛为 knightica", () => {
  const variants = [
    "Knightica is free on Epic Games Store — build an army and let the synergies do the fighting",
    "[Epic Games Mobile] (Game) Knightica **Knightica** \\-> Android ( EGS Store ) / iOS ( EGS Store ) **Claim All** (Mobile) -> Here . View Post on Reddit for comments Join | Shar",
    "Knightica is free on Epic Games Store mobile iOS buff.ly/vcvjSZ1 Android buff.ly/MgFQWTQ",
    "Knightica (Mobile) is Free via Epic Games Store. IOS https://ow.ly/iIhn51069o5 Android https://ow.ly/IBIv51069ob",
    "[Epic/Epic Mobile] (Game) Knightica is free! See the /r/FreeGameFindings thread below. #FGF #FreeGameFindings #Free redd.it/1xuginp redd.it/1xugop9",
    "(PCDD) Knightica is Free via The Epic Games Store. Alien: Isolation & Mark of the Deep Will be Free Next Week. https://ow.ly/E74a51068Ut #ad",
    "Knightica is free on Epic Games Store. Alien: Isolation & Mark of the Deep are the next free titles buff.ly/MdEraPT",
    "Free Knightica (Epic Games, reg. $14.99) — free to keep starting today 11 AM ET through Nov 19",
    "[Multi] [Knightica] [CA$16.99 → Free] [Recruit units, place them strategically and find the best synergies]",
  ];
  for (const t of variants) {
    assert.equal(mergeKey(t), "knightica", `failed on: ${t}`);
  }
});


test("TitleDeduper：同事件跨媒体不同措辞（CAR-T 进医保）自动聚类，不同品牌/主题不误并", () => {
  const now = new Date().toISOString();
  const newsCluster = [
    {
      id: 101,
      title: "2026 商保创新药目录扩容至 28 种，百万元 CAR-T 抗癌药与中国首个血友病基因治疗药入选，患者自付价格大幅下降",
      category: "news",
      kind: "news",
      publishedAt: now,
    },
    {
      id: 102,
      title: "129万一针的CAR-T首次进医保：“降至30万”的说法，有几分成色？",
      category: "news",
      kind: "news",
      publishedAt: now,
    },
    {
      id: 103,
      title: "首款CAR-T进医保，用其他CAR-T产品的患者怎么办",
      category: "news",
      kind: "news",
      publishedAt: now,
    },
    {
      id: 104,
      title: "Google 发布 Gemini 4 Carbon 模型细节",
      category: "ai",
      kind: "info",
      publishedAt: now,
    },
    {
      id: 105,
      title: "Google Pixel 10 降价促销评测",
      category: "hardware",
      kind: "info",
      publishedAt: now,
    },
  ];
  const deduper = new TitleDeduper(newsCluster, [], { maxGapHours: 48 });
  const r1 = deduper.rootOf(newsCluster[0]!);
  const r2 = deduper.rootOf(newsCluster[1]!);
  const r3 = deduper.rootOf(newsCluster[2]!);
  assert.equal(r1, r2, "CAR-T 报道 #1 与 #2 应聚为同一事件");
  assert.equal(r2, r3, "CAR-T 报道 #2 与 #3 应聚为同一事件");
  assert.notEqual(deduper.rootOf(newsCluster[3]!), deduper.rootOf(newsCluster[4]!), "同品牌不同事件不得误并");
});


test("TitleDeduper：B站 BLG 夺冠送大会员 的多种措辞收敛为同一活动，合作方活动不误并", () => {
  const now = new Date().toISOString();
  const titles = [
    "b站免费领大会员",
    "B站免费送所有人大会员",
    "BLG夺冠，B站送所有人7天大会员",
    "BLG夺冠B站送7天大会员11.15 12:00-----11.16 12:00",
    "哔哩哔哩为庆祝BLG夺冠，决定免费赠送大会员",
    "B站“BLG 夺冠时刻”赠送大会员活动细则公布：可领 7 天、每位用户限领一次",
    "B站领取7天大会员",
    "B站免费大会员羊毛",
  ];
  const entries = titles.map((title, i) => ({
    id: 200 + i,
    title,
    category: "media",
    kind: "freebie",
    publishedAt: now,
  }));
  const deduper = new TitleDeduper(entries, [], { maxGapHours: 48 });
  const root = deduper.rootOf(entries[0]!);
  for (const e of entries.slice(1)) {
    assert.equal(deduper.rootOf(e), root, `「${e.title}」应与「${entries[0]!.title}」聚为同一活动`);
  }
});

test("TitleDeduper：B站大会员与联名卡/合作方活动、以及同夺冠不同奖品不得误并", () => {
  const now = new Date().toISOString();
  const entries = [
    { id: 300, title: "B站免费送所有人大会员", category: "media", kind: "freebie", publishedAt: now },
    { id: 301, title: "中国银行2233卡领b站会员", category: "media", kind: "freebie", publishedAt: now },
    { id: 302, title: "雷鸟GT Max bilibili限定版加赠B站大会员年卡", category: "goods", kind: "deal", publishedAt: now },
    { id: 303, title: "BLG夺冠庆典开启，免费白嫖皮肤和臻彩", category: "game", kind: "freebie", publishedAt: now },
  ];
  const deduper = new TitleDeduper(entries, [], { maxGapHours: 48 });
  const base = deduper.rootOf(entries[0]!);
  assert.notEqual(deduper.rootOf(entries[1]!), base, "银行联名卡活动不应并入全站送会员");
  assert.notEqual(deduper.rootOf(entries[2]!), base, "硬件联名赠送不应并入全站送会员");
  assert.notEqual(deduper.rootOf(entries[3]!), base, "同夺冠但奖品是游戏皮肤，不应并入送大会员");
});

test("TitleDeduper：canonicalId 相同的条目即使标题完全不同也强制聚为一类", () => {
  const now = new Date().toISOString();
  const entries = [
    { id: 400, title: "B站免费送所有人大会员", canonicalId: 400, category: "media", kind: "freebie", publishedAt: now },
    { id: 401, title: "庆祝夺冠，哔哩哔哩请你看番", canonicalId: 400, category: "media", kind: "freebie", publishedAt: now },
    { id: 402, title: "Epic 喜加一：某游戏", canonicalId: 402, category: "game", kind: "freebie", publishedAt: now },
  ];
  const deduper = new TitleDeduper(entries, [], { maxGapHours: 48 });
  assert.equal(deduper.rootOf(entries[0]!), deduper.rootOf(entries[1]!));
  assert.notEqual(deduper.rootOf(entries[2]!), deduper.rootOf(entries[0]!));
});


test("AI 语义去重：canonical 聚类键零成本拦截已推送的同一活动，AI 命中后落库并拦截推送", async () => {
  const { linkCanonicalCluster, filterPushDuplicatesWithAi } = await import("../src/server/enrich/ai-dedup.ts");
  const { get } = await import("../src/server/db.ts");
  const now = new Date().toISOString();
  const insert = (id: number, title: string) =>
    run(
      `INSERT INTO items (id, source_id, external_id, url, url_key, title, summary, category, kind, score, status,
                          first_seen_at, last_seen_at, ai_keep)
       VALUES (?, 'linuxdo-welfare', ?, ?, ?, ?, '', 'media', 'freebie', 80, 'active', ?, ?, 1)`,
      id,
      `ext-${id}`,
      `https://example.com/${id}`,
      `example.com/${id}`,
      title,
      now,
      now,
    );
  insert(901, "B站免费送所有人大会员");
  insert(902, "BLG夺冠，B站送所有人7天大会员");
  insert(903, "哔哩哔哩为庆祝夺冠免费赠送大会员");

  // 1) 聚类键已落库：同簇已推送过 → 零 Token 直接拦截
  linkCanonicalCluster(902, 901);
  assert.equal(get<{ canonical_id: number }>("SELECT canonical_id FROM items WHERE id = 902")?.canonical_id, 901);

  const ruleOnly = await filterPushDuplicatesWithAi(
    [{ id: 902, title: "BLG夺冠，B站送所有人7天大会员", canonicalId: 901 }],
    [{ id: 901, title: "B站免费送所有人大会员", canonicalId: 901 }],
    { settings: { aiDedupEnabled: false } as never },
  );
  assert.equal(ruleOnly.kept.length, 0);
  assert.equal(ruleOnly.intercepted[0]?.duplicateOfId, 901);

  // 2) 规则抓不到的不同措辞：交给 AI 判定，命中后写回 canonical_id 并拦截
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: '[{"index":0,"duplicateOfId":901,"reason":"同为B站夺冠送大会员"}]' } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;

  const aiResult = await filterPushDuplicatesWithAi(
    [{ id: 903, title: "哔哩哔哩为庆祝夺冠免费赠送大会员" }],
    [{ id: 901, title: "B站免费送所有人大会员" }],
    {
      settings: {
        enabled: true,
        baseUrl: "https://example.com/v1",
        apiKey: "",
        model: "test-model",
        timeoutSec: 10,
        aiDedupEnabled: true,
        aiDedupWindowHours: 48,
      } as never,
      fetchImpl: fakeFetch,
    },
  );
  assert.equal(aiResult.kept.length, 0, "AI 判定重复后不应再推送");
  assert.equal(aiResult.intercepted[0]?.duplicateOfId, 901);
  assert.equal(
    get<{ canonical_id: number }>("SELECT canonical_id FROM items WHERE id = 903")?.canonical_id,
    901,
    "AI 命中的重复条目应写回聚类键",
  );
});
