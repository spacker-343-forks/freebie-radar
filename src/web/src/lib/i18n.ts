/**
 * 极简前端国际化（零依赖）。
 *
 * 约定：中文文案本身就是字典 key，`t("真福利精选")` 在英文下查表换词，查不到就回落中文。
 * 这样做的理由：
 *  - 2100+ 条文案全部在组件里，用语义 key 会先要发明 2100 个名字，改造量和出错面都翻倍；
 *  - 源码永远可读，中文即文档，`t()` 缺失时不会白屏，只是没翻译；
 *  - 词典按面板拆片（lib/i18n/en/*.ts），加面板只加一个文件，不会互相冲突。
 *
 * 带变量的文案用 `{name}` 占位：`t("共 {count} 条", { count })`，
 * 中文侧同样会做占位替换，所以中文也可以写成带占位的形式。
 *
 * 语言切换采用「持久化 + 整页重载」：模块级常量（频道表、分类表等）在导入时求值，
 * 重载是唯一能让这些常量也换语言而不引入订阅机制的办法，切换动作本身极低频，代价可忽略。
 */
import { EN_TAXONOMY } from "./i18n/en/taxonomy.ts";
import { EN_CORE } from "./i18n/en/core.ts";
import { EN_APP } from "./i18n/en/app.ts";
import { EN_ITEMVIEW } from "./i18n/en/itemview.ts";
import { EN_PUSH } from "./i18n/en/push.ts";
import { EN_OPS } from "./i18n/en/ops.ts";
import { EN_AI } from "./i18n/en/ai.ts";
import { EN_USERPUSH } from "./i18n/en/userpush.ts";
import { EN_ADMIN } from "./i18n/en/admin.ts";
import { EN_MISC } from "./i18n/en/misc.ts";
import { EN_MANUALS_CHATS } from "./i18n/en/manuals-chats.ts";

export type Lang = "zh" | "en";

export const LANGS: { key: Lang; label: string; short: string }[] = [
  { key: "zh", label: "简体中文", short: "中" },
  { key: "en", label: "English", short: "EN" },
];

const STORAGE_KEY = "radar.lang";

const EN: Record<string, string> = {
  ...EN_TAXONOMY,
  ...EN_CORE,
  ...EN_MISC,
  ...EN_ADMIN,
  ...EN_ITEMVIEW,
  ...EN_APP,
  ...EN_PUSH,
  ...EN_OPS,
  ...EN_AI,
  ...EN_USERPUSH,
  ...EN_MANUALS_CHATS,
};

function isLang(value: unknown): value is Lang {
  return value === "zh" || value === "en";
}

function detectLang(): Lang {
  if (typeof window === "undefined") return "zh";
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("lang");
    if (isLang(fromUrl)) {
      window.localStorage.setItem(STORAGE_KEY, fromUrl);
      return fromUrl;
    }
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (isLang(saved)) return saved;
    const nav = (window.navigator.language || "").toLowerCase();
    if (nav.startsWith("zh")) return "zh";
    // 非中文浏览器默认英文；中文用户首次访问不会被翻转
    if (nav.length > 0) return "en";
  } catch {
    /* 隐私模式下 localStorage 会抛错，忽略即可 */
  }
  return "zh";
}

let lang: Lang = detectLang();

export function getLang(): Lang {
  return lang;
}

export function dateLocale(): string {
  return lang === "en" ? "en-US" : "zh-CN";
}

/** 把当前语言同步到 <html lang>，供 CSS/无障碍/浏览器翻译使用。 */
export function applyDocumentLang(): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
}

/** 切换语言：写 localStorage 后整页重载，保证模块级常量也按新语言求值。 */
export function setLang(next: Lang): void {
  if (next === lang) return;
  lang = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* 忽略写入失败，重载后仍能读到旧值，不影响可用性 */
  }
  applyDocumentLang();
  const url = new URL(window.location.href);
  if (url.searchParams.has("lang")) {
    url.searchParams.set("lang", next);
    window.history.replaceState(window.history.state, "", url);
  }
  window.location.reload();
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (raw, key: string) => (params[key] == null ? raw : String(params[key])));
}

const warned = new Set<string>();

/** 翻译一条中文文案。参数用 `{name}` 占位，中英两侧都做替换。 */
export function t(zh: string, params?: Record<string, string | number>): string {
  if (lang === "zh") return interpolate(zh, params);
  const hit = EN[zh];
  if (hit == null) {
    const dev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
    if (dev && !warned.has(zh)) {
      warned.add(zh);
      console.warn("[i18n] 缺少英文词条:", zh);
    }
    return interpolate(zh, params);
  }
  return interpolate(hit, params);
}

/** `t` 的别名：作用域里已有名为 `t` 的变量（如 `.find((t) => ...)`）时用它避免遮蔽。 */
export const tr = t;
