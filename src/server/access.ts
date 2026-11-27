import { all, get, run, txImmediate } from "./db.ts";
import { config, isPublicSite } from "./config.ts";
import { generateInviteCode } from "./crypto.ts";

/* ------------------------------------------------------------------ *
 * 运营配置：登录/注册开关、入站公告
 * 都放 settings 表，管理端热改，无需重启。
 * ------------------------------------------------------------------ */

const ACCESS_KEY = "access_control";
const ONBOARDING_KEY = "onboarding";

export type RegistrationMode = "open" | "invite" | "closed";

export type AccessControl = {
  /** 网页登录入口总开关；关掉只影响「新登录」，已有用户默认不受影响 */
  loginEnabled: boolean;
  /** 关闭登录时是否连带暂停已登录用户的个人端（维护模式） */
  suspendUserSessionsOnClose: boolean;
  /** 注册模式：开放 / 邀请码 / 停止新注册（老用户始终可登录） */
  registrationMode: RegistrationMode;
  /** 最低 LINUX DO 信任等级 */
  minTrustLevel: number;
  /** 账号总数上限（0 = 不限）；满了老用户照常登录，只挡新注册 */
  maxUsers: number;
};

export type Onboarding = {
  enabled: boolean;
  title: string;
  content: string;
  /** 功能引导卡片（访客隔离 / 登录与个人 Bot / 公开 RSS） */
  showGuideCards: boolean;
  /** 版本号：站长点「重新弹出」时自增，前端据此决定弹不弹 */
  version: number;
};

const DEFAULT_ONBOARDING_CONTENT = [
  "生财雷达直连生财有术官方 MCP，全文归档精华帖、风向标、项目库案例与历期大航海实战手册，",
  "通过 AI 脱水引擎拦截水帖与私域引流软广、提炼 [底牌门槛]，并自动生成《⚡实战立项拆解书》与《🧭赛道实战白皮书》。",
  "",
  "· 顶部六大核心频道按「精选干货 / 立项拆解 / 航海手册 / 项目案例 / 开源与工具 / 福利与资料」分流直达。",
  "· 无需登录即可自由浏览，「不想看 / 收藏 / 已读 / 屏蔽词」均独立保存在本机浏览器里，互不干扰。",
  "· 每篇归档支持站内富文本快照永久阅读与目录导航，重要实操 SOP 与评论洞察随时回看。",
].join("\n");

function numOr(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

export function defaultAccessControl(): AccessControl {
  return {
    loginEnabled: isPublicSite,
    suspendUserSessionsOnClose: false,
    // 公开站默认「邀请码注册」更保守：AI 一审成本 + 个人 Bot 推送都要花服务器出口，
    // 站长想全开就一键切成 open。
    registrationMode: isPublicSite ? "invite" : "closed",
    minTrustLevel: config.linuxdoMinTrustLevel,
    maxUsers: 0,
  };
}

export function getAccessControl(): AccessControl {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", ACCESS_KEY);
  const base = defaultAccessControl();
  if (!row) return base;
  try {
    const raw = JSON.parse(row.value) as Partial<AccessControl>;
    return {
      loginEnabled: typeof raw.loginEnabled === "boolean" ? raw.loginEnabled : base.loginEnabled,
      suspendUserSessionsOnClose:
        typeof raw.suspendUserSessionsOnClose === "boolean" ? raw.suspendUserSessionsOnClose : base.suspendUserSessionsOnClose,
      registrationMode:
        raw.registrationMode === "open" || raw.registrationMode === "invite" || raw.registrationMode === "closed"
          ? raw.registrationMode
          : base.registrationMode,
      minTrustLevel: numOr(raw.minTrustLevel, base.minTrustLevel, 0, 4),
      maxUsers: numOr(raw.maxUsers, base.maxUsers, 0, 100000),
    };
  } catch {
    return base;
  }
}

export function saveAccessControl(patch: Partial<AccessControl>): AccessControl {
  const cur = getAccessControl();
  const next: AccessControl = {
    loginEnabled: typeof patch.loginEnabled === "boolean" ? patch.loginEnabled : cur.loginEnabled,
    suspendUserSessionsOnClose:
      typeof patch.suspendUserSessionsOnClose === "boolean" ? patch.suspendUserSessionsOnClose : cur.suspendUserSessionsOnClose,
    registrationMode:
      patch.registrationMode === "open" || patch.registrationMode === "invite" || patch.registrationMode === "closed"
        ? patch.registrationMode
        : cur.registrationMode,
    minTrustLevel: numOr(patch.minTrustLevel, cur.minTrustLevel, 0, 4),
    maxUsers: numOr(patch.maxUsers, cur.maxUsers, 0, 100000),
  };
  run(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ACCESS_KEY,
    JSON.stringify(next),
    new Date().toISOString(),
  );
  return next;
}

/** 名额检查：maxUsers=0 视为不限；满了只挡新注册，老用户照常登录 */
export function userQuota(): { used: number; max: number; full: boolean } {
  const max = getAccessControl().maxUsers;
  const used = get<{ n: number }>("SELECT COUNT(*) AS n FROM users")?.n ?? 0;
  return { used, max, full: max > 0 && used >= max };
}

/** 新用户准入前的统一闸门；返回 null 表示可以放行 */
export function admissionBlocked(): string | null {
  const q = userQuota();
  if (q.full) return `站点名额已满（${q.used}/${q.max}），暂时停止新用户注册`;
  return null;
}
export function getOnboarding(): Onboarding {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", ONBOARDING_KEY);
  const base: Onboarding = {
    enabled: true,
    title: "欢迎使用生财雷达",
    content: DEFAULT_ONBOARDING_CONTENT,
    showGuideCards: true,
    version: 2,
  };
  if (!row) return base;
  try {
    const raw = JSON.parse(row.value) as Partial<Onboarding>;
    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
      title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 60) : base.title,
      content: typeof raw.content === "string" ? raw.content.slice(0, 4000) : base.content,
      showGuideCards: typeof raw.showGuideCards === "boolean" ? raw.showGuideCards : base.showGuideCards,
      version: numOr(raw.version, base.version, 1, Number.MAX_SAFE_INTEGER),
    };
  } catch {
    return base;
  }
}

/** bumpVersion=true 时版本号自增，让所有访客下次进站重新看到弹窗 */
export function saveOnboarding(patch: Partial<Onboarding> & { bumpVersion?: boolean }): Onboarding {
  const cur = getOnboarding();
  const next: Onboarding = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled,
    title: typeof patch.title === "string" && patch.title.trim() ? patch.title.trim().slice(0, 60) : cur.title,
    content: typeof patch.content === "string" ? patch.content.slice(0, 4000) : cur.content,
    showGuideCards: typeof patch.showGuideCards === "boolean" ? patch.showGuideCards : cur.showGuideCards,
    version: patch.bumpVersion ? cur.version + 1 : cur.version,
  };
  run(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ONBOARDING_KEY,
    JSON.stringify(next),
    new Date().toISOString(),
  );
  return next;
}

/* ------------------------------------------------------------------ *
 * 邀请码
 * ------------------------------------------------------------------ */

export type InviteCode = {
  id: number;
  code: string;
  max_uses: number;
  used_count: number;
  disabled: number;
  note: string | null;
  expires_at: string | null;
  created_at: string;
};

export type InviteRedemptionRow = { code: string; username: string; redeemed_at: string };

export function listInviteCodes(): { codes: InviteCode[]; redemptions: InviteRedemptionRow[] } {
  const codes = all<InviteCode>(
    "SELECT id, code, max_uses, used_count, disabled, note, expires_at, created_at FROM invite_codes ORDER BY id DESC",
  );
  const redemptions = all<InviteRedemptionRow>(
    `SELECT c.code AS code, u.username AS username, r.redeemed_at AS redeemed_at
       FROM invite_redemptions r
       JOIN invite_codes c ON c.id = r.invite_id
       JOIN users u ON u.id = r.user_id
      ORDER BY r.id DESC LIMIT 200`,
  );
  return { codes, redemptions };
}

export function createInviteCodes(opts: {
  count: number;
  maxUses: number;
  note?: string;
  expiresDays?: number;
  customCode?: string;
}): InviteCode[] {
  const count = Math.min(Math.max(Math.round(opts.count) || 1, 1), 50);
  const maxUses = Math.min(Math.max(Math.round(opts.maxUses) || 1, 1), 10000);
  const note = (opts.note ?? "").trim().slice(0, 120) || null;
  const expiresAt =
    opts.expiresDays && opts.expiresDays > 0
      ? new Date(Date.now() + Math.min(opts.expiresDays, 3650) * 86_400_000).toISOString()
      : null;
  const now = new Date().toISOString();
  const created: InviteCode[] = [];
  for (let i = 0; i < count; i += 1) {
    const custom = i === 0 ? (opts.customCode ?? "").trim().toUpperCase() : "";
    const code = custom || generateInviteCode();
    if (!/^[A-Z0-9-]{4,32}$/.test(code)) continue;
    const exists = get<{ id: number }>("SELECT id FROM invite_codes WHERE code = ?", code);
    if (exists) continue;
    const res = run(
      "INSERT INTO invite_codes (code, max_uses, used_count, disabled, note, expires_at, created_at) VALUES (?, ?, 0, 0, ?, ?, ?)",
      code,
      maxUses,
      note,
      expiresAt,
      now,
    );
    const id = Number(res.lastInsertRowid);
    created.push({ id, code, max_uses: maxUses, used_count: 0, disabled: 0, note, expires_at: expiresAt, created_at: now });
  }
  return created;
}

export function toggleInviteCode(id: number, disabled: boolean): boolean {
  const res = run("UPDATE invite_codes SET disabled = ? WHERE id = ?", disabled ? 1 : 0, id);
  return Number(res.changes) > 0;
}

export function deleteInviteCode(id: number): boolean {
  const res = run("DELETE FROM invite_codes WHERE id = ?", id);
  return Number(res.changes) > 0;
}

export type RedeemResult =
  | { ok: true; inviteId: number; maxUses: number; usedCount: number }
  | { ok: false; error: string };

/**
 * 原子核销：BEGIN IMMEDIATE 拿写锁 → 校验可用 → used_count+1 → 记核销人。
 * 条件全写在 UPDATE 的 WHERE 里，靠 changes===1 判断，杜绝并发超发。
 */
export function redeemInviteCode(code: string, userId: number): RedeemResult {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return { ok: false, error: "请输入邀请码" };
  return txImmediate<RedeemResult>(() => {
    const row = get<InviteCode>(
      "SELECT id, code, max_uses, used_count, disabled, note, expires_at, created_at FROM invite_codes WHERE code = ?",
      normalized,
    );
    if (!row) return { ok: false, error: "邀请码不存在" };
    if (row.disabled === 1) return { ok: false, error: "该邀请码已被停用" };
    if (row.expires_at && row.expires_at <= new Date().toISOString()) return { ok: false, error: "该邀请码已过期" };
    if (row.used_count >= row.max_uses) return { ok: false, error: "该邀请码已用完" };
    const res = run(
      `UPDATE invite_codes SET used_count = used_count + 1
        WHERE id = ? AND disabled = 0 AND used_count < max_uses
          AND (expires_at IS NULL OR expires_at > ?)`,
      row.id,
      new Date().toISOString(),
    );
    if (Number(res.changes) !== 1) return { ok: false, error: "该邀请码刚刚被用完，请换一个" };
    run(
      "INSERT INTO invite_redemptions (invite_id, user_id, redeemed_at) VALUES (?, ?, ?) ON CONFLICT(invite_id, user_id) DO NOTHING",
      row.id,
      userId,
      new Date().toISOString(),
    );
    return { ok: true, inviteId: row.id, maxUses: row.max_uses, usedCount: row.used_count + 1 };
  });
}

/** 这个 LINUX DO 账号是否已经在等待补邀请码（重进时不重复建号） */
export function findUserByLinuxdoId(linuxdoId: number) {
  return get<{
    id: number;
    linuxdo_id: number;
    username: string;
    name: string | null;
    avatar_url: string | null;
    trust_level: number;
    disabled: number;
    rss_token: string;
    invited_by_id: number | null;
    created_at: string;
    last_login_at: string;
  }>("SELECT * FROM users WHERE linuxdo_id = ?", linuxdoId);
}

export type AdminUserRow = {
  id: number;
  linuxdo_id: number;
  username: string;
  name: string | null;
  avatar_url: string | null;
  trust_level: number;
  disabled: number;
  created_at: string;
  last_login_at: string;
  hidden: number;
  starred: number;
  push_enabled: number;
};

export function listUsers(limit = 200): AdminUserRow[] {
  return all<AdminUserRow>(
    `SELECT u.id, u.linuxdo_id, u.username, u.name, u.avatar_url, u.trust_level, u.disabled,
            u.created_at, u.last_login_at,
            COALESCE(s.hidden, 0) AS hidden,
            COALESCE(s.starred, 0) AS starred,
            COALESCE(p.enabled, 0) AS push_enabled
       FROM users u
       LEFT JOIN (
         SELECT user_id, SUM(hidden) AS hidden, SUM(starred) AS starred
           FROM user_item_states GROUP BY user_id
       ) s ON s.user_id = u.id
       LEFT JOIN user_push_configs p ON p.user_id = u.id
      ORDER BY u.id DESC LIMIT ?`,
    Math.min(Math.max(limit, 1), 500),
  );
}

export function setUserDisabled(id: number, disabled: boolean): boolean {
  const res = run("UPDATE users SET disabled = ? WHERE id = ?", disabled ? 1 : 0, id);
  if (disabled) run("DELETE FROM sessions WHERE user_id = ?", id);
  return Number(res.changes) > 0;
}

export function countUsers(): number {
  return get<{ n: number }>("SELECT COUNT(*) AS n FROM users")?.n ?? 0;
}