import {
  aiReady,
  getAiSettings,
  postChatCompletions,
  resolveCommentModel,
  type AiSettings,
} from "../enrich/ai-settings.ts";

export type DistillableSubReply = {
  key: string;
  author: string;
  isAuthor: boolean;
  replyTo: string;
  likes: number;
  gmtCreate: number;
  body: string;
  plainText: string;
};

export type DistillableComment = {
  key: string;
  author: string;
  isAuthor: boolean;
  likes: number;
  gmtCreate: number;
  body: string;
  plainText: string;
  hasImages: boolean;
  hasUrl: boolean;
  hasAuthorReply: boolean;
  replies: DistillableSubReply[];
};

export type CommentDistillPostInput = {
  title: string;
  candidates: DistillableComment[];
};

export const COMMENT_DISTILL_SYSTEM_PROMPT = [
  "你是「生财有术」商业实战知识库的评论区脱水编辑。任务是从每篇帖子的候选评论（含楼中楼回复）中剔除无增量信息的水评，只保留对读者有实操参考价值的精选评论。",
  "",
  "仅保留以下 4 类有信息增量的评论：",
  "1. 楼主干货补充：楼主(isAuthor=true)补充的操作步骤、参数配置、避坑细节、文档/PDF/GitHub链接或勘误更新；",
  "2. 闭环实操问答：圈友提出具体实操问题，且楼中楼里有楼主或实战者给出了明确解答（须同时保留提问楼 id 与有效解答回复 id，并剔除楼中楼末尾单纯回复『好』『谢谢老大』『收到』等无信息礼貌尾巴）；",
  "3. 实测反馈与排坑：圈友亲测后的成功/失败条件、风控封号提醒、成本算账、优缺点或替代工具对比；",
  "4. 思路延伸与勘误：结合具体场景的可落地延伸用法、补充工具/数据或修正原文错误。",
  "",
  "坚决剔除以下无价值评论（哪怕字数长或带点赞也要剔除）：",
  "- 纯夸奖/彩虹屁/情绪共鸣/表决心（如『写得太好了』『视频内容和形式都太棒了，值得反复学习』『又重温了一遍吸收效率提升超多』『干货满满』）；",
  "- 简短附和/打卡/纯表情（如『很棒』『棒！！！』『[强]』『666』『学习了』『支持』『插眼』）；",
  "- 官方例行通知盖章（如『感谢分享，已中标』『恭喜精华』且无实质业务点评）；",
  "- 无人解答的纯伸手提问或纯报错求助（如『登录不上呢』『怎么弄呀』『求带』且下方无有效解答）；",
  "- 楼主的纯客套寒暄（如楼主仅回复『谢谢支持』『哈哈是的』『共勉』而无实质干货）；",
  "- 私域引流软广（如『加我微信领』『私信发你』）。",
  "",
  '输入为 JSON 数组：[{"postIndex":0,"title":"...","comments":[{"id":"c0","author":"...","isAuthor":true,"likes":3,"text":"...","replies":[{"id":"c0_r0","author":"...","isAuthor":true,"text":"..."}]}]}]',
  '严格只输出 JSON 数组（不要输出 Markdown 代码块或任何解释），每篇帖子对应一项：[{"postIndex":0,"keepIds":["c0"],"keepReplyIds":["c0_r0"]}]。若某帖没有值得保留的评论，keepIds 与 keepReplyIds 均返回 []。',
].join("\n");

type RawBatchVerdict = {
  postIndex?: unknown;
  keepIds?: unknown;
  keepReplyIds?: unknown;
};

function extractJsonArray(raw: string): unknown[] | null {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]?.trim() || trimmed;
  const start = fenced.indexOf("[");
  const end = fenced.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(fenced.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toStringSet(val: unknown): Set<string> {
  if (!Array.isArray(val)) return new Set();
  return new Set(val.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()));
}

function applyVerdictToPost(
  candidates: DistillableComment[],
  keepIds: Set<string>,
  keepReplyIds: Set<string>,
): DistillableComment[] {
  const out: DistillableComment[] = [];
  for (const c of candidates) {
    const keptReplies = c.replies.filter((r) => keepReplyIds.has(r.key));
    const keepTop = keepIds.has(c.key) || keptReplies.length > 0;
    if (!keepTop) continue;

    // Guard against keeping a bare short question stub when all of its replies were rejected
    if (
      !c.isAuthor &&
      c.replies.length > 0 &&
      keptReplies.length === 0 &&
      c.plainText.length < 18 &&
      /[?？吗呢咋怎]/.test(c.plainText)
    ) {
      continue;
    }

    out.push({
      ...c,
      hasAuthorReply: keptReplies.some((r) => r.isAuthor),
      replies: keptReplies,
    });
  }
  return out;
}

async function callCommentDistillBatch(
  batch: Array<{ postIndex: number; title: string; candidates: DistillableComment[] }>,
  settings: AiSettings,
  model: string,
  fetchImpl?: typeof fetch,
): Promise<Map<number, { keepIds: Set<string>; keepReplyIds: Set<string> }>> {
  const payload = batch.map((item) => ({
    postIndex: item.postIndex,
    title: item.title.slice(0, 140),
    comments: item.candidates.map((c) => ({
      id: c.key,
      author: c.author,
      isAuthor: c.isAuthor,
      ...(c.likes > 0 ? { likes: c.likes } : {}),
      ...(c.hasImages ? { hasImage: true } : {}),
      text: c.plainText.slice(0, 800),
      ...(c.replies.length
        ? {
            replies: c.replies.map((r) => ({
              id: r.key,
              author: r.author,
              isAuthor: r.isAuthor,
              ...(r.replyTo ? { replyTo: r.replyTo } : {}),
              text: r.plainText.slice(0, 500),
            })),
          }
        : {}),
    })),
  }));

  const timeoutMs = Math.max(30, settings.timeoutSec || 60) * 1000;
  const { res } = await postChatCompletions({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model,
    messages: [
      { role: "system", content: COMMENT_DISTILL_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(payload) },
    ],
    signal: AbortSignal.timeout(timeoutMs),
    fetchImpl,
  });

  if (!res.ok) {
    throw new Error(`评论 AI 脱水 HTTP ${res.status}: ${(await res.text()).slice(0, 140)}`);
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? "";
  const arr = extractJsonArray(content);
  if (!arr || arr.length !== batch.length) {
    throw new Error(`评论 AI 脱水返回条数不匹配 (期望 ${batch.length}, 实际 ${arr?.length ?? "非数组"})`);
  }

  const expected = new Set(batch.map((b) => b.postIndex));
  const verdictMap = new Map<number, { keepIds: Set<string>; keepReplyIds: Set<string> }>();

  for (const item of arr) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("评论 AI 脱水单项不是对象");
    }
    const v = item as RawBatchVerdict;
    if (
      typeof v.postIndex !== "number" ||
      !Number.isInteger(v.postIndex) ||
      !expected.has(v.postIndex) ||
      verdictMap.has(v.postIndex)
    ) {
      throw new Error(`评论 AI 脱水 postIndex 非法或重复: ${String(v.postIndex)}`);
    }
    verdictMap.set(v.postIndex, {
      keepIds: toStringSet(v.keepIds),
      keepReplyIds: toStringSet(v.keepReplyIds),
    });
  }

  return verdictMap;
}

/**
 * Runs Stage 2 AI semantic filtering across one or more posts' candidate comments in batches.
 * Gracefully degrades to Stage 1 deterministic candidates when AI is unconfigured/disabled or on hard gateway failure.
 */
export async function distillCommentPostsWithAi(
  posts: CommentDistillPostInput[],
  options: {
    aiSettings?: AiSettings;
    model?: string;
    batchSize?: number;
    concurrency?: number;
    fetchImpl?: typeof fetch;
    log?: (msg: string) => void;
  } = {},
): Promise<DistillableComment[][]> {
  if (!posts.length) return [];
  const s = options.aiSettings ?? getAiSettings();
  const model = options.model?.trim() || resolveCommentModel(s);

  if (!aiReady({ ...s, model })) {
    return posts.map((p) => p.candidates);
  }

  const results: DistillableComment[][] = posts.map((p) => p.candidates);
  const nonEmpty = posts
    .map((p, idx) => ({ postIndex: idx, title: p.title, candidates: p.candidates }))
    .filter((p) => p.candidates.length > 0);

  if (!nonEmpty.length) return results;

  const batchSize = Math.min(Math.max(Math.round(options.batchSize ?? 6), 1), 15);
  const concurrency = Math.min(Math.max(Math.round(options.concurrency ?? 3), 1), 8);
  const batches: Array<typeof nonEmpty> = [];
  for (let i = 0; i < nonEmpty.length; i += batchSize) {
    batches.push(nonEmpty.slice(i, i + batchSize));
  }

  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
      while (cursor < batches.length) {
        const bIdx = cursor;
        cursor += 1;
        const batch = batches[bIdx]!;
        let lastErr = "";

        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const verdictMap = await callCommentDistillBatch(batch, s, model, options.fetchImpl);
            for (const entry of batch) {
              const v = verdictMap.get(entry.postIndex);
              if (v) {
                results[entry.postIndex] = applyVerdictToPost(entry.candidates, v.keepIds, v.keepReplyIds);
              }
            }
            lastErr = "";
            break;
          } catch (err) {
            lastErr = err instanceof Error ? err.message : String(err);
          }
        }

        if (lastErr) {
          options.log?.(`[comment-ai] 批次脱水降级保留规则结果 (n=${batch.length}): ${lastErr}`);
        }
      }
    }),
  );

  return results;
}
