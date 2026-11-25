import { all, closeDb, migrate, run } from "../src/server/db.ts";
import { SEEDS, ensureSources } from "../src/server/collectors/index.ts";
import { getAiSettings, saveAiSettings, type AiSettings } from "../src/server/enrich/ai.ts";
import { CATEGORY_DESC, CATEGORY_KEYS, CONTENT_KIND_KEYS, OBTAIN_KEYS } from "../src/shared/taxonomy.ts";

const SCYS_SYSTEM_PROMPT = [
  "你是「生财有术」知识社群的高信噪比脱水审核员，任务是从生财帖子中剔除水帖/晒单/私域引流软广，精准保留可复现、有实操价值的内容，并识别每条内容隐含的「前置底牌」。",
  "",
  "判定 keep=true 的有效内容（严格按内容形态分配 kind）：",
  `1. opensource（开源项目）：明确提供 GitHub/GitLab/Gitee 仓库地址、开源 Agent/MCP/脚本源码或可部署自托管代码的项目分享。`,
  `2. freebie（白嫖福利）：真正免费且无需加微/私域引流即可直接领取或使用的工具额度、模板、开源福利或免费资源。`,
  `3. deal（特价好价）：价格与权益透明的工具优惠、合租/服务对接或资源合作。`,
  `4. info（实战干货）：具备可执行 SOP、真实营收与成本拆解、踩坑复盘、AI Coding / 独立开发 SaaS / 流量增长工作流，以及含商业逻辑、变现路径、成本与收入测算的项目库拆解（含商业逻辑、变现路径、成本与收入测算的项目库案例同样属于有效 info）。`,
  "",
  "判定 keep=false 且 kind='noise' 的噪音水帖（坚决拦截）：",
  "- 纯晒单喜报：只晒收益截图、成交截图或情绪炫耀，没有可复现步骤与关键参数；",
  "- 私域引流与软广：刻意隐藏核心步骤，引导「加我微信 / 私信领取 / 扫码进群 / 付费陪跑营 / 卖课钩子」的钓鱼帖；",
  "- 无营养灌水：打卡帖（「打卡第N天」）、空洞励志鸡汤、泛泛而谈的正确废话或无实质内容的提问水帖。",
  "",
  `分类 category 只能是：${CATEGORY_KEYS.join(" | ")}`,
  `细分类参考：${CATEGORY_KEYS.map((k) => `${k}=${CATEGORY_DESC[k]}`).join("；")}。`,
  `内容形态 kind 只能是：${CONTENT_KIND_KEYS.join(" | ")}`,
  `获取方式 obtain 只能是（同时映射隐含的「前置底牌」门槛）：${OBTAIN_KEYS.join(" | ")}`,
  "- free：零基础 / 纯方法即可直接上手尝试，无明显资金或资源壁垒；",
  "- conditional：需要编程能力、老号权重/已有流量池、特定平台账号或资质门槛；",
  "- paid：需要投流预算、囤货资金、付费工具或商业订阅门槛；",
  "- promo：虽有招募合作或商业推广意图，但正文包含明确实操方法与可验证干货；",
  "- lottery / trial：按常规抽奖或短期试用语义判定。",
  "",
  "质量评分 quality 为 1-5 整数：5=强可复现SOP+真实数据/高价值开源项目，4=清晰实战复盘或可用工作流，3=有参考价值但门槛较高，2=信息稀疏/鸡肋，1=纯噪音。",
  '按 JSON 数组返回，每条形如：{"index":0,"keep":true,"kind":"info","category":"ai","obtain":"conditional","quality":5,"reason":"[需编程] Claude Code+MCP自动采集SOP"}。',
  "reason 必须控制在 25 个中文字符以内，且严格采用 `[底牌门槛] 核心干货或拦截原因` 格式，不得编造原文未提及的细节。",
].join("\n");

const SCYS_CUSTOM_NOISE_KEYWORDS = [
  "打卡第",
  "加我微信",
  "私信领取",
  "陪跑营招生",
  "扫码加微",
  "晒单喜报",
];

const SCYS_BLOCK_RULES = [
  "加我微信",
  "私信领取",
  "陪跑营招生",
  "打卡第",
  "扫码加微",
  "加微领资料",
  "日入过万",
  "纯晒单",
];

const ENABLED_SCYS_IDS = ["scys-highlights", "scys-projects", "scys-latest"] as const;

export function applyScysPreset() {
  const version = migrate();
  ensureSources();

  const disabledNonScys = run("UPDATE sources SET enabled = 0 WHERE id NOT LIKE 'scys-%' AND enabled != 0").changes;
  const placeholders = ENABLED_SCYS_IDS.map(() => "?").join(", ");
  const enabledScys = run(`UPDATE sources SET enabled = 1 WHERE id IN (${placeholders}) AND enabled != 1`, ...ENABLED_SCYS_IDS).changes;

  // 升级旧版默认 maxDetailPerRun (8/10/6) 的生财源配置为完整单轮抓详情，保留用户其他自定义改写
  const legacyDefaults: Record<string, { pageSize: number; maxDetailPerRun: number }> = {
    "scys-highlights": { pageSize: 15, maxDetailPerRun: 8 },
    "scys-projects": { pageSize: 15, maxDetailPerRun: 8 },
    "scys-latest": { pageSize: 20, maxDetailPerRun: 10 },
    "scys-manuals": { pageSize: 15, maxDetailPerRun: 6 },
  };
  let upgradedConfigs = 0;
  for (const row of all<{ id: string; config: string }>("SELECT id, config FROM sources WHERE id LIKE 'scys-%'")) {
    const legacy = legacyDefaults[row.id];
    const seedCfg = SEEDS.find((s) => s.id === row.id)?.config;
    if (!legacy || !seedCfg) continue;
    try {
      const curCfg = JSON.parse(row.config || "{}") as Record<string, unknown>;
      if (curCfg.pageSize === legacy.pageSize && curCfg.maxDetailPerRun === legacy.maxDetailPerRun) {
        run("UPDATE sources SET config = ? WHERE id = ?", JSON.stringify(seedCfg), row.id);
        upgradedConfigs += 1;
      }
    } catch {
      /* 忽略异常 JSON */
    }
  }

  // 只传入脱水策略字段；若尚未配置自定义 baseUrl/model，填入官方推理默认参数并保留已有 apiKey/enabled
  const curAi = getAiSettings();
  const aiPatch: Partial<AiSettings> = {
    systemPrompt: SCYS_SYSTEM_PROMPT,
    customNoiseKeywords: SCYS_CUSTOM_NOISE_KEYWORDS,
    preFilterEnabled: true,
    learnFromFeedback: true,
    ...(!curAi.baseUrl.trim() ? { baseUrl: "https://api.openai.com/v1" } : {}),
    ...(!curAi.model.trim() ? { model: "gpt-6.1-terra:high" } : {}),
    ...(curAi.batchSize === 6 ? { batchSize: 4 } : {}),
    ...(curAi.concurrency === 4 ? { concurrency: 3 } : {}),
    ...(curAi.timeoutSec === 15 || curAi.timeoutSec === 45 ? { timeoutSec: 75 } : {}),
  };
  const ai = saveAiSettings(aiPatch);

  const now = new Date().toISOString();
  let rulesInserted = 0;
  for (const pattern of SCYS_BLOCK_RULES) {
    const res = run(
      `INSERT OR IGNORE INTO block_rules (pattern, mode, scope, enabled, created_at)
       VALUES (?, 'keyword', 'all', 1, ?)`,
      pattern,
      now,
    );
    rulesInserted += Number(res.changes ?? 0);
  }

  const activeSources = all<{ id: string; name: string }>(
    "SELECT id, name FROM sources WHERE enabled = 1 ORDER BY id",
  );
  const currentAi = getAiSettings();

  return {
    schemaVersion: version,
    disabledNonScys,
    enabledScys,
    upgradedConfigs,
    activeSources,
    rulesInserted,
    totalBlockRules: SCYS_BLOCK_RULES.length,
    aiConfigured: Boolean(currentAi.baseUrl && currentAi.model && currentAi.apiKey),
    aiEnabled: ai.enabled,
    aiBaseUrl: currentAi.baseUrl,
    aiModel: currentAi.model || "(未配置)",
    aiBatchSize: currentAi.batchSize,
    aiConcurrency: currentAi.concurrency,
    aiTimeoutSec: currentAi.timeoutSec,
  };
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("/scripts/scys-preset.ts");
if (isMain) {
  try {
    const summary = applyScysPreset();
    console.log(`[scys-preset] schema v${summary.schemaVersion} ready`);
    console.log(`[scys-preset] 已关闭非生财源 (${summary.disabledNonScys} 条变更)，升级生财源配置 ${summary.upgradedConfigs} 条，启用生财源：`);
    for (const s of summary.activeSources) {
      console.log(`  - ${s.id}: ${s.name}`);
    }
    console.log(
      `[scys-preset] 已写入生财有术脱水 AI 提示词与噪音过滤（baseUrl=${summary.aiBaseUrl}, model=${summary.aiModel}, batchSize=${summary.aiBatchSize}, concurrency=${summary.aiConcurrency}, timeoutSec=${summary.aiTimeoutSec}, enabled=${summary.aiEnabled}）`,
    );
    if (!summary.aiConfigured || !summary.aiEnabled) {
      console.log("[scys-preset] 提示：请在界面「AI 引擎」或 .env 中填入 AI_API_KEY 并开启总开关后启用自动脱水。");
    }
    console.log(`[scys-preset] 全局屏蔽规则新增 ${summary.rulesInserted} 条（预设共 ${summary.totalBlockRules} 条，重复执行幂等）`);
  } finally {
    closeDb();
  }
}
