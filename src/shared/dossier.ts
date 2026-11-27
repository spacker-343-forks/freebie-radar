export type ItemDossier = {
  verdict: string;
  startupCost: string;
  timeToFirstDollar: string;
  formula: string;
  sop: string[];
  pitfalls: string[];
  soloMvp: string;
  model: string;
  generatedAt: string;
};

function cleanStr(v: unknown, maxLen: number): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, maxLen);
}

function cleanStrList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim().slice(0, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function validateItemDossier(
  raw: unknown,
  fallbackMeta?: { model?: string; generatedAt?: string },
): ItemDossier | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const verdict = cleanStr(r.verdict, 1000);
  const startupCost = cleanStr(r.startupCost, 500);
  const timeToFirstDollar = cleanStr(r.timeToFirstDollar, 300);
  const formula = cleanStr(r.formula, 1000);
  const sop = cleanStrList(r.sop, 10, 1200);
  const pitfalls = cleanStrList(r.pitfalls, 8, 1000);
  const soloMvp = cleanStr(r.soloMvp, 1800);

  if (!verdict || !startupCost || !timeToFirstDollar || !formula || !soloMvp) return null;
  if (!sop.length || !pitfalls.length) return null;

  const model = cleanStr(r.model, 80) || fallbackMeta?.model || "";
  const generatedAt = cleanStr(r.generatedAt, 40) || fallbackMeta?.generatedAt || new Date().toISOString();

  return {
    verdict,
    startupCost,
    timeToFirstDollar,
    formula,
    sop,
    pitfalls,
    soloMvp,
    model,
    generatedAt,
  };
}
