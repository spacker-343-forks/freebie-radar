import { all, get, getDb, run } from "./db.ts";
import {
  aiReady,
  getAiSettings,
  postChatCompletions,
  resolveDeepModel,
  stripHtmlForAi,
  type AiSettings,
} from "./enrich/ai-settings.ts";
import { validateTrackWhitepaper, type TrackSummary, type TrackWhitepaper } from "../shared/tracks.ts";

let tracksTableEnsured = false;
let synthesisInFlight: Promise<TrackWhitepaper[]> | null = null;

export function ensureTracksTable(): void {
  if (tracksTableEnsured) {
    const exists = get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='scys_tracks'");
    if (exists) return;
  }
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS scys_tracks (
      slug TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '🧭',
      tagline TEXT NOT NULL DEFAULT '',
      item_count INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `);
  tracksTableEnsured = true;
}

export function isTrackSynthesisRunning(): boolean {
  return synthesisInFlight !== null;
}

export function listTracks(): TrackSummary[] {
  ensureTracksTable();
  const rows = all<{
    slug: string;
    title: string;
    emoji: string;
    tagline: string;
    item_count: number;
    payload: string;
    model: string;
    updated_at: string;
  }>("SELECT slug, title, emoji, tagline, item_count, payload, model, updated_at FROM scys_tracks ORDER BY item_count DESC, updated_at DESC");

  return rows.map((r) => {
    let playbookCount = 0;
    try {
      const parsed = JSON.parse(r.payload) as { playbooks?: unknown[] };
      if (Array.isArray(parsed.playbooks)) playbookCount = parsed.playbooks.length;
    } catch {
      playbookCount = 0;
    }
    return {
      slug: r.slug,
      title: r.title,
      emoji: r.emoji || "🧭",
      tagline: r.tagline,
      itemCount: r.item_count,
      playbookCount,
      model: r.model,
      updatedAt: r.updated_at,
    };
  });
}

export function getTrackDetail(slug: string): TrackWhitepaper | null {
  ensureTracksTable();
  const row = get<{
    slug: string;
    title: string;
    emoji: string;
    tagline: string;
    item_count: number;
    payload: string;
    model: string;
    updated_at: string;
  }>("SELECT slug, title, emoji, tagline, item_count, payload, model, updated_at FROM scys_tracks WHERE slug = ?", slug);
  if (!row) return null;
  try {
    return validateTrackWhitepaper(JSON.parse(row.payload), {
      slug: row.slug,
      title: row.title,
      emoji: row.emoji,
      tagline: row.tagline,
      itemCount: row.item_count,
      model: row.model,
      updatedAt: row.updated_at,
    });
  } catch {
    return null;
  }
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]?.trim() || trimmed;
  const objStart = fenced.indexOf("{");
  const arrStart = fenced.indexOf("[");
  let start = -1;
  let end = -1;
  if (arrStart >= 0 && (objStart < 0 || arrStart < objStart)) {
    start = arrStart;
    end = fenced.lastIndexOf("]");
  } else if (objStart >= 0) {
    start = objStart;
    end = fenced.lastIndexOf("}");
  }
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

function extractAiReason(aiJson: string | null): string {
  if (!aiJson) return "";
  try {
    const parsed = JSON.parse(aiJson) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : "";
  } catch {
    return "";
  }
}

type TrackClusterSeed = {
  slug: string;
  title: string;
  emoji: string;
  tagline: string;
  keywords: string[];
  seedIds: number[];
};

type ItemDbRow = {
  id: number;
  title: string;
  summary: string | null;
  content: string | null;
  category: string | null;
  ai_quality: number | null;
  score: number;
  ai: string | null;
};

function sanitizeSlug(raw: string, index: number): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || `track-${index + 1}`;
}

export async function synthesizeAllTracks(
  options: {
    maxTracks?: number;
    model?: string;
    fetchImpl?: typeof fetch;
    aiSettings?: AiSettings;
    log?: (m: string) => void;
  } = {},
): Promise<TrackWhitepaper[]> {
  if (synthesisInFlight) return synthesisInFlight;

  const task = (async () => {
    ensureTracksTable();
    const s = options.aiSettings ?? getAiSettings();
    const model = options.model?.trim() || resolveDeepModel(s);
    const log = options.log ?? console.log;
    const maxTracks = Math.min(Math.max(Math.round(options.maxTracks ?? 12), 1), 15);

    if (!aiReady({ ...s, enabled: true, model })) {
      throw new Error("AI 未配置端点或模型，无法合成赛道白皮书");
    }

    const allKept = all<ItemDbRow>(
      `SELECT id, title, summary, content, category, ai_quality, score, ai
         FROM items
        WHERE status = 'active' AND ai_keep = 1
        ORDER BY COALESCE(ai_quality, 0) DESC, score DESC, id DESC`,
    );
    if (!allKept.length) {
      return [];
    }

    const sample = allKept.slice(0, 300).map((r) => ({
      id: r.id,
      title: r.title.slice(0, 100),
      category: r.category ?? "other",
      quality: r.ai_quality ?? null,
      reason: extractAiReason(r.ai),
    }));

    // Step 1: Discover 8~15 non-overlapping business tracks
    const clusterSystem = [
      "你是「生财雷达（scys-radar）」商业赛道首席架构师。",
      `请阅读以下高价值帖子样本，将其聚类提炼为 ${Math.min(maxTracks, 8)}~${maxTracks} 个互不重叠的「生财实战赚钱赛道」（例如 AI Agent 工作流服务、小红书虚拟资料矩阵、海外独立站 SEO 工具、闲鱼无货源细分刚需、视频号中老年流量等）。`,
      "必须严格只输出单个 JSON 对象：",
      JSON.stringify({
        tracks: [
          {
            slug: "ai-agent-workflow",
            title: "AI Agent 自动化与效率服务",
            emoji: "🤖",
            tagline: "一句话概括该赛道商业本质与变现核心",
            keywords: ["Agent", "MCP", "自动化", "工作流"],
            seedIds: [101, 102],
          },
        ],
      }),
      "要求：",
      "- `slug` 使用英文短横线命名；",
      "- `keywords` 给出 3~8 个强相关中文/英文检索词（用于在全库归集同类帖子）；",
      "- `seedIds` 填入样本中最具代表性的条目 ID。",
    ].join("\n");

    const clusterRes = await postChatCompletions({
      baseUrl: s.baseUrl,
      apiKey: s.apiKey,
      model,
      messages: [
        { role: "system", content: clusterSystem },
        { role: "user", content: JSON.stringify(sample) },
      ],
      signal: AbortSignal.timeout(180_000),
      fetchImpl: options.fetchImpl,
    });
    if (!clusterRes.res.ok) {
      throw new Error(`赛道聚类失败 (HTTP ${clusterRes.res.status}): ${(await clusterRes.res.text()).slice(0, 160)}`);
    }
    const clusterJson = (await clusterRes.res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const clusterParsed = extractJson(clusterJson.choices?.[0]?.message?.content ?? "") as {
      tracks?: unknown[];
    } | null;
    const rawTracks = Array.isArray(clusterParsed?.tracks)
      ? clusterParsed.tracks
      : Array.isArray(clusterParsed)
        ? clusterParsed
        : [];

    const seeds: TrackClusterSeed[] = [];
    const seenSlugs = new Set<string>();
    for (let i = 0; i < rawTracks.length && seeds.length < maxTracks; i += 1) {
      const t = rawTracks[i] as Record<string, unknown> | null;
      if (!t || typeof t !== "object") continue;
      const title = typeof t.title === "string" ? t.title.trim().slice(0, 80) : "";
      if (!title) continue;
      let slug = sanitizeSlug(typeof t.slug === "string" ? t.slug : "", i);
      if (seenSlugs.has(slug)) slug = `${slug}-${i + 1}`;
      seenSlugs.add(slug);
      const emoji = typeof t.emoji === "string" && t.emoji.trim() ? t.emoji.trim().slice(0, 12) : "🧭";
      const tagline = typeof t.tagline === "string" && t.tagline.trim() ? t.tagline.trim().slice(0, 160) : title;
      const keywords = Array.isArray(t.keywords)
        ? t.keywords.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map((k) => k.trim())
        : [];
      const seedIds = Array.isArray(t.seedIds)
        ? t.seedIds.filter((id): id is number => typeof id === "number" && Number.isInteger(id))
        : [];
      seeds.push({ slug, title, emoji, tagline, keywords, seedIds });
    }

    if (!seeds.length) {
      throw new Error("AI 赛道聚类未返回有效赛道列表");
    }

    const validIdSet = new Set(allKept.map((r) => r.id));
    const prepared = seeds.map((seed) => {
      const seedSet = new Set(seed.seedIds);
      const kwsLower = seed.keywords.map((k) => k.toLowerCase());
      const matched = allKept.filter((item) => {
        if (seedSet.has(item.id)) return true;
        if (!kwsLower.length) return false;
        const hay = `${item.title} ${item.summary ?? ""}`.toLowerCase();
        return kwsLower.some((kw) => hay.includes(kw));
      });
      const pool = matched.length ? matched : allKept.slice(0, 10);
      return {
        seed,
        itemCount: matched.length || pool.length,
        topItems: pool.slice(0, 25),
      };
    });

    // Step 2: Synthesize deep cross-post whitepapers concurrently (concurrency=3)
    const results: TrackWhitepaper[] = [];
    let cursor = 0;
    const concurrency = 3;

    await Promise.all(
      Array.from({ length: Math.min(concurrency, prepared.length) }, async () => {
        while (cursor < prepared.length) {
          const idx = cursor;
          cursor += 1;
          const entry = prepared[idx]!;
          const { seed, itemCount, topItems } = entry;

          const materials = topItems.map((it) => ({
            id: it.id,
            title: it.title.slice(0, 120),
            aiReason: extractAiReason(it.ai),
            excerpt: stripHtmlForAi(it.content || it.summary || "").slice(0, 1200),
          }));

          const wpSystem = [
            `你是「生财雷达（scys-radar）」商业赛道主编，请基于以下 ${materials.length} 篇跨帖实证素材，为赛道【${seed.title}】合成一份《赛道实战白皮书》。`,
            "必须严格只输出单个 JSON 对象：",
            JSON.stringify({
              overview: "200字左右说清该赛道的商业本质、当前红利窗口与核心壁垒",
              playbooks: [
                {
                  name: "主流变现流派名称",
                  mechanism: "核心获客渠道 + 交付形式 + 变现路径（2~3句）",
                  roiRange: "月入/客单ROI区间（引用素材或谨慎估算）",
                  targetPlayer: "适合底牌（如：有代码能力/零基础内容党）",
                },
              ],
              commonPitfalls: ["跨帖高频踩坑死法1", "死法2"],
              actionChecklist: ["第1~2天验证动作", "第3~5天跑通动作", "第6~7天复盘放大动作"],
              topItemIds: [topItems[0]?.id ?? 1],
            }),
            "- `playbooks` 提取 2~4 种差异化变现流派；",
            "- `topItemIds` 必须从提供素材的 `id` 中精选 5~10 篇最具代表性的帖子 ID。",
          ].join("\n");

          try {
            const wpRes = await postChatCompletions({
              baseUrl: s.baseUrl,
              apiKey: s.apiKey,
              model,
              messages: [
                { role: "system", content: wpSystem },
                { role: "user", content: JSON.stringify(materials) },
              ],
              signal: AbortSignal.timeout(180_000),
              fetchImpl: options.fetchImpl,
            });
            if (!wpRes.res.ok) {
              throw new Error(`HTTP ${wpRes.res.status}`);
            }
            const wpJson = (await wpRes.res.json()) as { choices?: Array<{ message?: { content?: string } }> };
            const parsed = extractJson(wpJson.choices?.[0]?.message?.content ?? "") as Record<string, unknown> | null;
            if (!parsed || typeof parsed !== "object") {
              throw new Error("未返回合法 JSON 对象");
            }

            const rawTopIds = Array.isArray(parsed.topItemIds) ? parsed.topItemIds : [];
            const checkedIds: number[] = [];
            const seenIds = new Set<number>();
            for (const rid of rawTopIds) {
              if (typeof rid === "number" && Number.isInteger(rid) && validIdSet.has(rid) && !seenIds.has(rid)) {
                seenIds.add(rid);
                checkedIds.push(rid);
              }
            }
            for (const it of topItems) {
              if (checkedIds.length >= Math.min(8, topItems.length)) break;
              if (!seenIds.has(it.id)) {
                seenIds.add(it.id);
                checkedIds.push(it.id);
              }
            }

            const now = new Date().toISOString();
            const whitepaper = validateTrackWhitepaper(
              {
                ...parsed,
                slug: seed.slug,
                title: seed.title,
                emoji: seed.emoji,
                tagline: seed.tagline,
                itemCount,
                topItemIds: checkedIds,
                model,
                updatedAt: now,
              },
              {
                slug: seed.slug,
                title: seed.title,
                emoji: seed.emoji,
                tagline: seed.tagline,
                itemCount,
                topItemIds: checkedIds,
                model,
                updatedAt: now,
              },
            );

            if (!whitepaper) {
              throw new Error("赛道白皮书字段校验失败");
            }

            run(
              `INSERT INTO scys_tracks (slug, title, emoji, tagline, item_count, payload, model, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(slug) DO UPDATE SET
                 title = excluded.title,
                 emoji = excluded.emoji,
                 tagline = excluded.tagline,
                 item_count = excluded.item_count,
                 payload = excluded.payload,
                 model = excluded.model,
                 updated_at = excluded.updated_at`,
              whitepaper.slug,
              whitepaper.title,
              whitepaper.emoji,
              whitepaper.tagline,
              whitepaper.itemCount,
              JSON.stringify(whitepaper),
              whitepaper.model,
              whitepaper.updatedAt,
            );
            results.push(whitepaper);
            log(`[tracks] 合成完成: ${whitepaper.emoji} ${whitepaper.title} (${whitepaper.itemCount}篇)`);
          } catch (err) {
            log(`[tracks] 赛道 ${seed.slug} 合成失败: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }),
    );

    return results;
  })();

  synthesisInFlight = task;
  try {
    return await task;
  } finally {
    synthesisInFlight = null;
  }
}
