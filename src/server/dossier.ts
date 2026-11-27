import { all, get, getDb, run } from "./db.ts";
import {
  aiReady,
  getAiSettings,
  postChatCompletions,
  resolveDeepModel,
  stripHtmlForAi,
  type AiSettings,
} from "./enrich/ai-settings.ts";
import { validateItemDossier, type ItemDossier } from "../shared/dossier.ts";

let tableEnsured = false;

export function ensureDossierTable(): void {
  if (tableEnsured) {
    // Check table still exists in case tests swap :memory: or truncate schema
    const exists = get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='item_dossiers'");
    if (exists) return;
  }
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS item_dossiers (
      item_id INTEGER PRIMARY KEY,
      payload TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `);
  tableEnsured = true;
}

export function getItemDossier(itemId: number): ItemDossier | null {
  ensureDossierTable();
  const row = get<{ payload: string; model: string; updated_at: string }>(
    "SELECT payload, model, updated_at FROM item_dossiers WHERE item_id = ?",
    itemId,
  );
  if (!row?.payload) return null;
  try {
    return validateItemDossier(JSON.parse(row.payload), {
      model: row.model,
      generatedAt: row.updated_at,
    });
  } catch {
    return null;
  }
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]?.trim() || trimmed;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function generateItemDossier(
  itemId: number,
  options: {
    force?: boolean;
    model?: string;
    fetchImpl?: typeof fetch;
    aiSettings?: AiSettings;
  } = {},
): Promise<ItemDossier> {
  ensureDossierTable();
  if (!options.force) {
    const existing = getItemDossier(itemId);
    if (existing) return existing;
  }

  const row = get<{
    id: number;
    title: string;
    url: string;
    category: string | null;
    summary: string | null;
    content: string | null;
    ai: string | null;
  }>("SELECT id, title, url, category, summary, content, ai FROM items WHERE id = ?", itemId);

  if (!row) {
    throw new Error(`条目不存在 (id=${itemId})`);
  }

  const s = options.aiSettings ?? getAiSettings();
  const model = options.model?.trim() || resolveDeepModel(s);
  if (!aiReady({ ...s, enabled: true, model })) {
    throw new Error("AI 未配置端点或模型，无法生成实战立项拆解书");
  }

  const cleanBody = stripHtmlForAi(row.content || row.summary || "").slice(0, 30_000);
  const systemPrompt = [
    "你是「生财雷达（scys-radar）」首席商业拆解师与独立创业顾问。",
    "请把这篇生财有术实战长文提炼成一份零水分、可直接照做落地的《AI 实战立项拆解书》。",
    "",
    "必须严格只输出单个 JSON 对象（不要输出 Markdown 代码围栏或多余文字）：",
    JSON.stringify({
      verdict: "一句话立项锐评：本质赚谁的什么钱、当前值不值得入局",
      startupCost: "预估启动资金与核心底牌（1~2句精炼完整表述，如：≤300元 + 1个实名小红书号）",
      timeToFirstDollar: "首单闭环验证周期（1~2句精炼完整表述，如：3~7天完成首个付费验证）",
      formula: "赚钱算账公式：客单价 × 转化率 × 流量来源 − 真实隐性工时/损耗成本",
      sop: ["第1步：具体动作与工具参数", "第2步：...", "第3步：..."],
      pitfalls: ["核心死穴1：封号点/流量枯竭/幸存者偏差", "核心死穴2：..."],
      soloMvp: "单人 + AI 轻资产最小验证改法：只有 1 个人如何用最小成本跑通首单",
    }),
    "硬性要求：",
    "- `startupCost` 与 `timeToFirstDollar` 保持精炼且句意完整（1~2 句表述收尾），`sop` 保留 3~6 步，滤除寒暄吹牛，只留具体动作、工具链与量化参数；",
    "- `pitfalls` 保留 2~4 条真实风险或隐性工时坑；",
    "- 严禁编造原文未提及的收益数字、工具名或渠道。",
  ].join("\n");

  const userPrompt = [
    `标题：${row.title}`,
    `分类：${row.category || "other"}`,
    `原文链接：${row.url}`,
    "",
    "正文全文：",
    cleanBody || row.title,
  ].join("\n");

  const { res } = await postChatCompletions({
    baseUrl: s.baseUrl,
    apiKey: s.apiKey,
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    signal: AbortSignal.timeout(180_000),
    fetchImpl: options.fetchImpl,
  });

  if (!res.ok) {
    throw new Error(`生成立项拆解书失败 (HTTP ${res.status}): ${(await res.text()).slice(0, 160)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const rawContent = data.choices?.[0]?.message?.content ?? "";
  const now = new Date().toISOString();
  const dossier = validateItemDossier(extractJsonObject(rawContent), { model, generatedAt: now });
  if (!dossier) {
    throw new Error("AI 返回的立项拆解书 JSON 格式不完整");
  }

  run(
    `INSERT INTO item_dossiers (item_id, payload, model, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET payload = excluded.payload, model = excluded.model, updated_at = excluded.updated_at`,
    itemId,
    JSON.stringify(dossier),
    dossier.model,
    now,
  );
  return dossier;
}

export async function backfillDossiers(
  options: {
    minQuality?: number;
    limit?: number;
    concurrency?: number;
    model?: string;
    fetchImpl?: typeof fetch;
    aiSettings?: AiSettings;
    log?: (m: string) => void;
  } = {},
): Promise<{ totalCandidates: number; generated: number; failed: number }> {
  ensureDossierTable();
  const minQuality = Math.min(Math.max(Math.round(options.minQuality ?? 4), 1), 5);
  const limit = Math.min(Math.max(Math.round(options.limit ?? 50), 1), 500);
  const concurrency = Math.min(Math.max(Math.round(options.concurrency ?? 3), 1), 8);
  const log = options.log ?? console.log;

  const rows = all<{ id: number; title: string }>(
    `SELECT i.id, i.title
       FROM items i
       LEFT JOIN item_dossiers d ON d.item_id = i.id
      WHERE i.status = 'active'
        AND i.ai_keep = 1
        AND COALESCE(i.ai_quality, 0) >= ?
        AND d.item_id IS NULL
      ORDER BY COALESCE(i.ai_quality, 0) DESC, i.score DESC, i.id DESC
      LIMIT ?`,
    minQuality,
    limit,
  );

  if (!rows.length) {
    return { totalCandidates: 0, generated: 0, failed: 0 };
  }

  let cursor = 0;
  let generated = 0;
  let failed = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
      while (cursor < rows.length) {
        const idx = cursor;
        cursor += 1;
        const row = rows[idx]!;
        try {
          await generateItemDossier(row.id, {
            model: options.model,
            fetchImpl: options.fetchImpl,
            aiSettings: options.aiSettings,
          });
          generated += 1;
        } catch (err) {
          failed += 1;
          log(`[dossier] 生成失败 id=${row.id} (${row.title.slice(0, 24)}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }),
  );

  return { totalCandidates: rows.length, generated, failed };
}
