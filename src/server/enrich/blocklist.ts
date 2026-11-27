import { all } from "../db.ts";

export type BlockRule = {
  id: number;
  pattern: string;
  mode: "keyword" | "regex";
  scope: string;
  enabled: number;
  created_at: string;
};

/** 生财有术常见私域导流、卖课钩子与纯灌水黑话，用户在界面可一键导入，零误伤正常实战复盘。 */
export const PRESET_NOISE_PATTERNS: { pattern: string; mode: "keyword" | "regex"; scope: string; note: string }[] = [
  { pattern: "加我微信", mode: "keyword", scope: "all", note: "私域导流" },
  { pattern: "扫码加微", mode: "keyword", scope: "all", note: "扫码导流" },
  { pattern: "加微领资料", mode: "keyword", scope: "all", note: "领资料钩子" },
  { pattern: "私信领取", mode: "keyword", scope: "all", note: "私信引流钩子" },
  { pattern: "私聊领取", mode: "keyword", scope: "all", note: "私聊引流钩子" },
  { pattern: "扫码进群领", mode: "keyword", scope: "all", note: "进群导流钩子" },
  { pattern: "陪跑营招生", mode: "keyword", scope: "all", note: "付费陪跑软广" },
  { pattern: "训练营招募", mode: "keyword", scope: "all", note: "卖课招募软广" },
  { pattern: "知识星球优惠券", mode: "keyword", scope: "all", note: "拉新返佣软广" },
  { pattern: "打卡第", mode: "keyword", scope: "all", note: "无营养打卡水帖" },
  { pattern: "日入过万", mode: "keyword", scope: "all", note: "标题党夸张噱头" },
  { pattern: "纯晒单", mode: "keyword", scope: "all", note: "纯晒收益无干货" },
];

export function loadActiveBlockRules(): BlockRule[] {
  return all<BlockRule>("SELECT id, pattern, mode, scope, enabled, created_at FROM block_rules WHERE enabled = 1 ORDER BY id");
}

export function compileRule(rule: BlockRule): (text: string, sourceId: string) => boolean {
  const scope = rule.scope || "all";
  if (rule.mode === "regex") {
    let re: RegExp | null = null;
    if (!safeRegex(rule.pattern)) return () => false;
    try {
      re = new RegExp(rule.pattern, "i");
    } catch {
      re = null;
    }
    return (text, sourceId) => {
      if (scope !== "all" && scope !== sourceId) return false;
      if (re) return re.test(text.slice(0, 2048));
      return text.toLowerCase().includes(rule.pattern.toLowerCase());
    };
  }
  const needle = rule.pattern.toLowerCase();
  return (text, sourceId) => {
    if (scope !== "all" && scope !== sourceId) return false;
    return text.toLowerCase().includes(needle);
  };
}

/** Conservative admin-only subset; unsafe legacy patterns are never executed. */
export function safeRegex(pattern: string): boolean {
  if (!pattern || pattern.length > 80 || /\\[1-9]|\(\?/.test(pattern)) return false;
  const tokens = pattern.replace(/\\./g, "_").replace(/\[(?:\\.|[^\]\\])*\]/g, "_");
  if (/\)[*+?{]/.test(tokens) || (tokens.match(/[*+{]/g)?.length ?? 0) > 1) return false;
  try { new RegExp(pattern, "i"); return true; } catch { return false; }
}

export function matchBlockRules(
  item: { title: string; summary?: string | null; source_id?: string; sourceId?: string },
  rules: BlockRule[],
): BlockRule | null {
  if (!rules.length) return null;
  const text = (item.title ?? "") + " " + (item.summary ?? "");
  const sourceId = item.source_id ?? item.sourceId ?? "";
  for (const rule of rules) {
    if (compileRule(rule)(text, sourceId)) return rule;
  }
  return null;
}

export function isBlocked(item: { title: string; summary?: string | null; source_id?: string; sourceId?: string }, rules?: BlockRule[]): boolean {
  const list = rules ?? loadActiveBlockRules();
  return matchBlockRules(item, list) !== null;
}
