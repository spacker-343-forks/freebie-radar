import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { get, run } from "./db.ts";
import { aiReady, getAiSettings, postChatCompletions, type AiSettings } from "./enrich/ai-settings.ts";
import {
  computeActiveBanner,
  type UpstreamCommitItem,
  type UpstreamImportance,
  type UpstreamWatchState,
} from "../shared/upstream-watch.ts";

const execFileAsync = promisify(execFile);

const SETTINGS_KEY = "upstream_watch_state";
const DEFAULT_BRANCH = "main";
const CHECK_INTERVAL_MS = 24 * 3600_000;
const STALE_THRESHOLD_MS = 20 * 3600_000;
const STARTUP_DELAY_MS = 15_000;

export function defaultUpstreamRepo(): string {
  return process.env.UPSTREAM_WATCH_REPO?.trim() || "ZiChuanLan/freebie-radar";
}

function defaultMergeCommand(branch: string): string {
  return `git fetch upstream && git merge upstream/${branch}`;
}

function createEmptyState(repo = defaultUpstreamRepo(), branch = DEFAULT_BRANCH): UpstreamWatchState {
  return {
    repo,
    branch,
    baseSha: null,
    latestSha: null,
    latestTag: null,
    aheadCount: 0,
    hasMajorFeature: false,
    importance: "none",
    headline: "尚未检测上游仓库更新",
    highlights: [],
    mergeCommand: defaultMergeCommand(branch),
    compareUrl: null,
    commits: [],
    checkedAt: null,
    dismissedSha: null,
    activeBanner: false,
    error: null,
  };
}

function normalizeImportance(v: unknown, hasMajorFeature: boolean): UpstreamImportance {
  if (v === "major" || v === "minor" || v === "none") return v;
  return hasMajorFeature ? "major" : "minor";
}

function normalizeState(raw: Partial<UpstreamWatchState> | null | undefined): UpstreamWatchState {
  const repo = typeof raw?.repo === "string" && raw.repo.trim() ? raw.repo.trim() : defaultUpstreamRepo();
  const branch = typeof raw?.branch === "string" && raw.branch.trim() ? raw.branch.trim() : DEFAULT_BRANCH;
  const baseSha = typeof raw?.baseSha === "string" && raw.baseSha.trim() ? raw.baseSha.trim() : null;
  const latestSha = typeof raw?.latestSha === "string" && raw.latestSha.trim() ? raw.latestSha.trim() : null;
  const latestTag = typeof raw?.latestTag === "string" && raw.latestTag.trim() ? raw.latestTag.trim() : null;
  const aheadCount =
    typeof raw?.aheadCount === "number" && Number.isFinite(raw.aheadCount) ? Math.max(0, Math.round(raw.aheadCount)) : 0;
  const hasMajorFeature = Boolean(raw?.hasMajorFeature);
  const importance = normalizeImportance(raw?.importance, hasMajorFeature);
  const headline = typeof raw?.headline === "string" && raw.headline.trim() ? raw.headline.trim() : "尚未检测上游仓库更新";
  const highlights = Array.isArray(raw?.highlights)
    ? raw.highlights.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 5)
    : [];
  const commits = Array.isArray(raw?.commits)
    ? raw.commits
        .filter((c): c is UpstreamCommitItem => Boolean(c && typeof c.sha === "string" && typeof c.message === "string"))
        .slice(0, 15)
    : [];
  const dismissedSha =
    typeof raw?.dismissedSha === "string" && raw.dismissedSha.trim() ? raw.dismissedSha.trim() : null;

  const state: UpstreamWatchState = {
    repo,
    branch,
    baseSha,
    latestSha,
    latestTag,
    aheadCount,
    hasMajorFeature,
    importance,
    headline,
    highlights,
    mergeCommand:
      typeof raw?.mergeCommand === "string" && raw.mergeCommand.trim()
        ? raw.mergeCommand.trim()
        : defaultMergeCommand(branch),
    compareUrl: typeof raw?.compareUrl === "string" && raw.compareUrl.trim() ? raw.compareUrl.trim() : null,
    commits,
    checkedAt: typeof raw?.checkedAt === "string" ? raw.checkedAt : null,
    dismissedSha,
    activeBanner: false,
    error: typeof raw?.error === "string" ? raw.error : null,
  };
  state.activeBanner = computeActiveBanner(state);
  return state;
}

export function getUpstreamWatchState(): UpstreamWatchState {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", SETTINGS_KEY);
  if (!row?.value) return createEmptyState();
  try {
    return normalizeState(JSON.parse(row.value) as Partial<UpstreamWatchState>);
  } catch {
    return createEmptyState();
  }
}

export function saveUpstreamWatchState(state: UpstreamWatchState): UpstreamWatchState {
  const normalized = normalizeState(state);
  const now = new Date().toISOString();
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    SETTINGS_KEY,
    JSON.stringify(normalized),
    now,
  );
  return normalized;
}

export function dismissUpstreamWatch(sha?: string): UpstreamWatchState {
  const current = getUpstreamWatchState();
  const nextSha = sha?.trim() || current.latestSha || current.dismissedSha || null;
  return saveUpstreamWatchState({
    ...current,
    dismissedSha: nextSha,
  });
}

export type UpstreamDiffResolved = {
  repo: string;
  branch: string;
  baseSha: string | null;
  latestSha: string | null;
  latestTag: string | null;
  aheadCount: number;
  compareUrl: string | null;
  commits: UpstreamCommitItem[];
  changedFiles: string[];
};

export type CheckUpstreamOptions = {
  force?: boolean;
  repo?: string;
  branch?: string;
  fetchImpl?: typeof fetch;
  resolveDiff?: (ctx: {
    repo: string;
    branch: string;
    prevState: UpstreamWatchState;
    fetchImpl: typeof fetch;
  }) => Promise<UpstreamDiffResolved>;
  aiSettings?: AiSettings;
};

async function runGit(args: string[], timeoutMs = 12_000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: process.cwd(),
      timeout: timeoutMs,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
      },
    });
    const out = stdout.trim();
    return out || null;
  } catch {
    return null;
  }
}

async function runGitOk(args: string[], timeoutMs = 12_000): Promise<boolean> {
  try {
    await execFileAsync("git", args, {
      cwd: process.cwd(),
      timeout: timeoutMs,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function fetchGitHubJson<T>(url: string, fetchImpl: typeof fetch): Promise<T | null> {
  try {
    const res = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "scys-radar-upstream-watch",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function resolveUpstreamDiffDefault(ctx: {
  repo: string;
  branch: string;
  prevState: UpstreamWatchState;
  fetchImpl: typeof fetch;
}): Promise<UpstreamDiffResolved> {
  const { repo, branch, prevState, fetchImpl } = ctx;
  const hasGit = existsSync(resolve(process.cwd(), ".git"));

  let baseSha: string | null = null;
  let fetchedLocalLatest: string | null = null;
  let fetchSucceeded = false;

  if (hasGit) {
    const ok = await runGitOk(["fetch", `https://github.com/${repo}.git`, branch, "--quiet"], 12_000);
    if (ok) {
      const fetchHead = await runGit(["rev-parse", "--verify", "FETCH_HEAD"], 5_000);
      if (fetchHead) {
        fetchSucceeded = true;
        fetchedLocalLatest = fetchHead;
        baseSha = await runGit(["merge-base", "HEAD", "FETCH_HEAD"], 5_000);
      }
    }
    if (!baseSha) {
      baseSha =
        (await runGit(["merge-base", "HEAD", `upstream/${branch}`], 5_000)) ??
        prevState.baseSha ??
        (await runGit(["rev-parse", "HEAD"], 5_000));
    }
  } else {
    baseSha = prevState.baseSha;
  }

  const tags = await fetchGitHubJson<Array<{ name?: string }>>(
    `https://api.github.com/repos/${repo}/tags?per_page=1`,
    fetchImpl,
  );
  const latestTag = tags?.[0]?.name?.trim() || prevState.latestTag || null;

  if (baseSha) {
    type CompareResponse = {
      ahead_by?: number;
      html_url?: string;
      commits?: Array<{
        sha?: string;
        html_url?: string;
        commit?: { message?: string; author?: { date?: string } };
      }>;
      files?: Array<{ filename?: string; status?: string }>;
    };
    const compare = await fetchGitHubJson<CompareResponse>(
      `https://api.github.com/repos/${repo}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(branch)}`,
      fetchImpl,
    );
    if (compare && Array.isArray(compare.commits)) {
      const aheadCount = typeof compare.ahead_by === "number" ? compare.ahead_by : compare.commits.length;
      const mapped = compare.commits
        .filter((c): c is NonNullable<typeof c> & { sha: string } => Boolean(c.sha))
        .slice(-15)
        .reverse()
        .map((c) => ({
          sha: c.sha,
          short: c.sha.slice(0, 7),
          date: c.commit?.author?.date || "",
          message: (c.commit?.message || "").split(/\r?\n/)[0]?.trim() || "",
          url: c.html_url || `https://github.com/${repo}/commit/${c.sha}`,
        }));
      const latestSha = mapped[0]?.sha || fetchedLocalLatest || baseSha;
      const compareUrl =
        compare.html_url ||
        (latestSha !== baseSha ? `https://github.com/${repo}/compare/${baseSha}...${latestSha}` : null);
      const changedFiles = (compare.files ?? [])
        .slice(0, 40)
        .map((f) => `${f.status || "modified"}: ${f.filename || ""}`)
        .filter((s) => s.length > 3);

      return {
        repo,
        branch,
        baseSha,
        latestSha,
        latestTag,
        aheadCount,
        compareUrl,
        commits: mapped,
        changedFiles,
      };
    }
  }

  // Fallback 1: local FETCH_HEAD git log when GitHub API is unavailable/rate-limited
  if (hasGit && fetchSucceeded && baseSha && fetchedLocalLatest) {
    const countRaw = await runGit(["rev-list", "--count", `${baseSha}..FETCH_HEAD`], 5_000);
    const aheadCount = countRaw ? Math.max(0, Number(countRaw) || 0) : 0;
    const logRaw = await runGit(
      ["log", `${baseSha}..FETCH_HEAD`, "--max-count=15", "--format=%H%x1f%aI%x1f%s"],
      5_000,
    );
    const commits: UpstreamCommitItem[] = (logRaw ? logRaw.split(/\r?\n/) : [])
      .map((line) => {
        const [sha = "", date = "", message = ""] = line.split("\x1f");
        if (!sha) return null;
        return {
          sha,
          short: sha.slice(0, 7),
          date,
          message,
          url: `https://github.com/${repo}/commit/${sha}`,
        };
      })
      .filter((x): x is UpstreamCommitItem => x !== null);
    const diffStat = await runGit(["diff", "--name-status", `${baseSha}..FETCH_HEAD`], 5_000);
    const changedFiles = diffStat ? diffStat.split(/\r?\n/).slice(0, 40) : [];
    const compareUrl =
      fetchedLocalLatest !== baseSha ? `https://github.com/${repo}/compare/${baseSha}...${fetchedLocalLatest}` : null;

    return {
      repo,
      branch,
      baseSha,
      latestSha: fetchedLocalLatest,
      latestTag,
      aheadCount,
      compareUrl,
      commits,
      changedFiles,
    };
  }

  // Fallback 2: GitHub commits list without local .git
  type CommitApiItem = {
    sha?: string;
    html_url?: string;
    commit?: { message?: string; author?: { date?: string } };
  };
  const recentCommits = await fetchGitHubJson<CommitApiItem[]>(
    `https://api.github.com/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=15`,
    fetchImpl,
  );
  if (recentCommits?.length) {
    const mapped = recentCommits
      .filter((c): c is NonNullable<typeof c> & { sha: string } => Boolean(c.sha))
      .map((c) => ({
        sha: c.sha,
        short: c.sha.slice(0, 7),
        date: c.commit?.author?.date || "",
        message: (c.commit?.message || "").split(/\r?\n/)[0]?.trim() || "",
        url: c.html_url || `https://github.com/${repo}/commit/${c.sha}`,
      }));
    const latestSha = mapped[0]?.sha || null;
    const aheadCount = baseSha && latestSha === baseSha ? 0 : mapped.length;
    return {
      repo,
      branch,
      baseSha,
      latestSha,
      latestTag,
      aheadCount,
      compareUrl: baseSha && latestSha && baseSha !== latestSha ? `https://github.com/${repo}/compare/${baseSha}...${latestSha}` : null,
      commits: mapped,
      changedFiles: [],
    };
  }

  throw new Error(`无法连接 GitHub 上游仓库 (${repo}) 或本地 git 远端不可用`);
}

type AiAssessment = {
  hasMajorFeature: boolean;
  importance: UpstreamImportance;
  headline: string;
  highlights: string[];
};

const CORE_MODULE_RE =
  /(?:src\/web\/src\/|src\/server\/enrich\/ai|src\/server\/(?:push|user-push|auth|security|db|routes|digest)\.ts)/i;
const TRIVIAL_ONLY_RE =
  /^(?:docs|chore|style|ci|test|i18n)(?:\([^)]*\))?:|\b(?:typo|readme|comment|bump version|changelog)\b/i;

export function evaluateUpstreamHeuristic(diff: UpstreamDiffResolved): AiAssessment {
  if (diff.aheadCount === 0 || !diff.latestSha || (diff.baseSha && diff.latestSha === diff.baseSha)) {
    return {
      hasMajorFeature: false,
      importance: "none",
      headline: "当前已包含上游最新提交",
      highlights: [],
    };
  }

  const featCommits = diff.commits.filter((c) => /^feat(?:\([^)]*\))?:/i.test(c.message) || /新增|支持|升级|重构/.test(c.message));
  const coreFileTouched = diff.changedFiles.some((f) => CORE_MODULE_RE.test(f));
  const allTrivial =
    diff.commits.length > 0 &&
    diff.commits.every((c) => TRIVIAL_ONLY_RE.test(c.message));

  const isMajor = !allTrivial && (featCommits.length > 0 || (coreFileTouched && diff.aheadCount >= 2));
  const topMsgs = (featCommits.length ? featCommits : diff.commits)
    .slice(0, 3)
    .map((c) => c.message)
    .filter(Boolean);

  if (isMajor) {
    return {
      hasMajorFeature: true,
      importance: "major",
      headline: topMsgs[0] ? `上游新增核心特性：${topMsgs[0].slice(0, 48)}` : `上游领先 ${diff.aheadCount} 个提交，含潜在重要功能更新`,
      highlights: topMsgs.length ? topMsgs : [`上游领先 ${diff.aheadCount} 个提交，建议查看变更对比并评估合入。`],
    };
  }

  return {
    hasMajorFeature: false,
    importance: "minor",
    headline: `上游有 ${diff.aheadCount} 个常规更新（暂无重大功能变更）`,
    highlights: topMsgs.length ? topMsgs : ["主要为细节修复、文档或局部源规则调整，可按需合入。"],
  };
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]?.trim() || trimmed;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(fenced.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function evaluateUpstreamWithAi(
  diff: UpstreamDiffResolved,
  aiSettings: AiSettings,
  fetchImpl: typeof fetch,
): Promise<AiAssessment> {
  if (!aiReady(aiSettings)) {
    return evaluateUpstreamHeuristic(diff);
  }

  const systemPrompt = [
    "你是「生财雷达（scys-radar）」下游分支架构师。",
    "我们基于上游 ZiChuanLan/freebie-radar 定制了生财有术 MCP 商业情报工作台，日常开发在 scys-radar 分支。",
    "你的任务是评估上游未合入的新提交中，是否包含值得提醒用户合入我们分支的「重大通用能力升级」：",
    "- 属于重大更新（hasMajorFeature=true, importance='major'）：Web 界面与筛选交互升级、AI 审核/语义去重/聚类改进、日报/周报能力升级、推送渠道扩展、多用户与安全机制、数据库性能与运维工具、关键 Bug 修复。",
    "- 属于常规小修（hasMajorFeature=false, importance='minor'）：纯文档/README/注释/词条微调、单纯版本号 bump、仅针对游戏喜加一/羊毛 RSS 源的小规则调整、单个无关测试微调。",
    '严格只输出单个 JSON 对象：{"hasMajorFeature": boolean, "importance": "major"|"minor"|"none", "headline": "一句话中文提醒标题（<=36字）", "highlights": ["中文要点1", "中文要点2"]}',
    "highlights 保留 1~3 条，简明扼要说明上游新增了什么能力、对我们分支的价值与合入建议。",
  ].join("\n");

  const commitLines = diff.commits
    .slice(0, 15)
    .map((c) => `- [${c.short}] ${c.message}${c.date ? ` (${c.date.slice(0, 10)})` : ""}`)
    .join("\n");
  const fileLines = diff.changedFiles.slice(0, 30).join("\n");

  const userPrompt = [
    `上游仓库：${diff.repo} (${diff.branch})`,
    `最新 Tag：${diff.latestTag || "无"}`,
    `未合入提交数：${diff.aheadCount}`,
    `基线 SHA：${diff.baseSha || "未知"} -> 最新 SHA：${diff.latestSha || "未知"}`,
    "",
    "近期未合入提交：",
    commitLines || "(无提交列表)",
    fileLines ? `\n涉及文件变更摘要：\n${fileLines}` : "",
  ].join("\n");

  try {
    const { res } = await postChatCompletions({
      baseUrl: aiSettings.baseUrl,
      apiKey: aiSettings.apiKey,
      model: aiSettings.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      signal: AbortSignal.timeout(Math.max(aiSettings.timeoutSec, 45) * 1000),
      fetchImpl,
    });
    if (!res.ok) {
      return evaluateUpstreamHeuristic(diff);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";
    const parsed = extractJsonObject(content);
    if (!parsed) {
      return evaluateUpstreamHeuristic(diff);
    }

    const importanceRaw = parsed.importance;
    const hasMajor =
      typeof parsed.hasMajorFeature === "boolean"
        ? parsed.hasMajorFeature
        : importanceRaw === "major";
    const importance: UpstreamImportance =
      importanceRaw === "major" || importanceRaw === "minor" || importanceRaw === "none"
        ? importanceRaw
        : hasMajor
          ? "major"
          : "minor";
    const headline =
      typeof parsed.headline === "string" && parsed.headline.trim()
        ? parsed.headline.trim().slice(0, 80)
        : evaluateUpstreamHeuristic(diff).headline;
    const highlights = Array.isArray(parsed.highlights)
      ? parsed.highlights
          .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
          .map((x) => x.trim().slice(0, 140))
          .slice(0, 3)
      : [];

    return {
      hasMajorFeature: hasMajor,
      importance,
      headline,
      highlights: highlights.length ? highlights : evaluateUpstreamHeuristic(diff).highlights,
    };
  } catch {
    return evaluateUpstreamHeuristic(diff);
  }
}

let checkInFlight: Promise<UpstreamWatchState> | null = null;

export async function checkUpstreamUpdates(options: CheckUpstreamOptions = {}): Promise<UpstreamWatchState> {
  if (checkInFlight) return checkInFlight;

  const task = (async () => {
    const prevState = getUpstreamWatchState();
    const repo = options.repo?.trim() || prevState.repo || defaultUpstreamRepo();
    const branch = options.branch?.trim() || prevState.branch || DEFAULT_BRANCH;
    const fetchImpl = options.fetchImpl ?? fetch;
    const now = new Date().toISOString();

    try {
      const diff = await (options.resolveDiff ?? resolveUpstreamDiffDefault)({
        repo,
        branch,
        prevState,
        fetchImpl,
      });

      if (diff.aheadCount === 0 || (diff.baseSha && diff.latestSha && diff.latestSha === diff.baseSha)) {
        return saveUpstreamWatchState({
          ...prevState,
          repo,
          branch,
          baseSha: diff.baseSha,
          latestSha: diff.latestSha,
          latestTag: diff.latestTag,
          aheadCount: 0,
          hasMajorFeature: false,
          importance: "none",
          headline: "当前已包含上游最新提交",
          highlights: [],
          mergeCommand: defaultMergeCommand(branch),
          compareUrl: null,
          commits: [],
          checkedAt: now,
          activeBanner: false,
          error: null,
        });
      }

      const sameSnapshot =
        !options.force &&
        Boolean(diff.baseSha && diff.latestSha) &&
        prevState.baseSha === diff.baseSha &&
        prevState.latestSha === diff.latestSha &&
        !prevState.error &&
        Boolean(prevState.checkedAt);

      if (sameSnapshot) {
        return saveUpstreamWatchState({
          ...prevState,
          latestTag: diff.latestTag ?? prevState.latestTag,
          compareUrl: diff.compareUrl ?? prevState.compareUrl,
          commits: diff.commits.length ? diff.commits : prevState.commits,
          checkedAt: now,
          error: null,
        });
      }

      const aiSettings = options.aiSettings ?? getAiSettings();
      const assessment = await evaluateUpstreamWithAi(diff, aiSettings, fetchImpl);

      return saveUpstreamWatchState({
        repo,
        branch,
        baseSha: diff.baseSha,
        latestSha: diff.latestSha,
        latestTag: diff.latestTag,
        aheadCount: diff.aheadCount,
        hasMajorFeature: assessment.hasMajorFeature,
        importance: assessment.importance,
        headline: assessment.headline,
        highlights: assessment.highlights,
        mergeCommand: defaultMergeCommand(branch),
        compareUrl: diff.compareUrl,
        commits: diff.commits.slice(0, 15),
        checkedAt: now,
        dismissedSha: prevState.dismissedSha,
        activeBanner: false,
        error: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return saveUpstreamWatchState({
        ...prevState,
        repo,
        branch,
        checkedAt: now,
        error: msg.slice(0, 300),
      });
    }
  })();

  checkInFlight = task;
  try {
    return await task;
  } finally {
    checkInFlight = null;
  }
}

let startupTimer: NodeJS.Timeout | null = null;
let dailyTimer: NodeJS.Timeout | null = null;

export function startUpstreamWatchScheduler(log: (m: string) => void = console.log): void {
  if (startupTimer || dailyTimer) return;

  const runIfStale = () => {
    const state = getUpstreamWatchState();
    const lastMs = state.checkedAt ? Date.parse(state.checkedAt) : NaN;
    const stale = !Number.isFinite(lastMs) || Date.now() - lastMs >= STALE_THRESHOLD_MS;
    if (!stale) return;
    void checkUpstreamUpdates({ force: false })
      .then((res) => {
        if (res.error) log(`[upstream-watch] 巡检失败: ${res.error}`);
        else log(`[upstream-watch] 巡检完成: ahead=${res.aheadCount}, importance=${res.importance}, activeBanner=${res.activeBanner}`);
      })
      .catch((err) => {
        log(`[upstream-watch] 巡检异常: ${err instanceof Error ? err.message : String(err)}`);
      });
  };

  startupTimer = setTimeout(runIfStale, STARTUP_DELAY_MS);
  startupTimer.unref?.();

  dailyTimer = setInterval(() => {
    void checkUpstreamUpdates({ force: false })
      .then((res) => {
        if (res.error) log(`[upstream-watch] 定时巡检失败: ${res.error}`);
        else log(`[upstream-watch] 定时巡检完成: ahead=${res.aheadCount}, importance=${res.importance}`);
      })
      .catch((err) => {
        log(`[upstream-watch] 定时巡检异常: ${err instanceof Error ? err.message : String(err)}`);
      });
  }, CHECK_INTERVAL_MS);
  dailyTimer.unref?.();
}

export function stopUpstreamWatchScheduler(): void {
  if (startupTimer) clearTimeout(startupTimer);
  if (dailyTimer) clearInterval(dailyTimer);
  startupTimer = null;
  dailyTimer = null;
}
