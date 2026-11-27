import { useEffect, useState } from "react";
import { AlertTriangle, Github, Loader2, LogIn, Ticket, X } from "lucide-react";
import type { Bootstrap } from "../lib/session.ts";
import { t } from "../lib/i18n.ts";
import { Dialog } from "./Dialog.tsx";

const HASH_MESSAGES: Record<string, string> = {
  "login-disabled": t("站点当前已关闭登录"),
  "login-unconfigured": t("站点还没配置 LINUX DO 登录凭据"),
  "login-failed": t("登录失败，请重试"),
  "login-state-mismatch": t("登录状态校验失败（可能链接过期），请重新发起登录"),
  "login-inactive": t("该 LINUX DO 账号未激活"),
  "login-silenced": t("该 LINUX DO 账号处于禁言状态，暂时无法登录"),
  "login-trust": t("信任等级不足，站点设置了登录门槛"),
  "login-banned": t("该账号已被站点停用"),
  "register-closed": t("站点当前已停止新用户注册（老用户仍可正常登录）"),
  "quota-full": t("站点注册名额已满，暂时停止新用户注册（老用户仍可正常登录）"),
  "invite-invalid": t("邀请码无效或已用完"),
};

export function AuthModal({
  boot,
  initialHash,
  onClose,
  onDone,
}: {
  boot: Bootstrap;
  initialHash?: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [inviteMode, setInviteMode] = useState(initialHash === "invite-required");
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(
    initialHash ? (HASH_MESSAGES[initialHash] ?? null) : null,
  );

  useEffect(() => {
    if (initialHash) window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }, [initialHash]);

  const startLogin = (code?: string, provider: "linuxdo" | "github" = "linuxdo") => {
    const q = code?.trim() ? "?invite=" + encodeURIComponent(code.trim()) : "";
    window.location.href = `/api/auth/${provider}/login` + q;
  };

  const devLogin = async (preset: "alice" | "bob") => {
    setBusy(preset);
    setError(null);
    try {
      const res = await fetch("/api/auth/dev-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preset }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; needInvite?: boolean; message?: string };
      if (!res.ok) {
        setError(data.error ?? t("本地测试登录失败"));
        return;
      }
      // 邀请码模式下后端会返回 needInvite：切到补码界面，走和真实 OAuth 一样的准入
      if (data.needInvite) {
        setInviteMode(true);
        setError(data.error ?? data.message ?? null);
        return;
      }
      onDone();
    } catch {
      setError(t("网络异常，请重试"));
    } finally {
      setBusy(null);
    }
  };

  const submitInvite = async () => {
    if (!invite.trim()) return;
    setBusy("invite");
    setError(null);
    try {
      const res = await fetch("/api/auth/redeem-invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: invite.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; expired?: boolean };
      if (!res.ok) {
        setError(data.error ?? t("邀请码校验失败"));
        return;
      }
      onDone();
    } catch {
      setError(t("网络异常，请重试"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog label={inviteMode ? t("输入邀请码完成注册") : t("登录生财雷达")} onClose={onClose} className="max-w-[420px]">
      <div className="sheet-enter panel w-full max-w-[420px] overflow-hidden">
        <div className="flex items-start justify-between gap-3 border-b border-ink-100 px-5 py-3.5">
          <div>
            <h2 className="text-[17px] font-semibold text-ink-950">
              {inviteMode ? t("输入邀请码完成注册") : t("登录生财雷达")}
            </h2>
            <p className="mt-0.5 text-[12px] text-ink-500">
              {inviteMode
                ? t("你的登录身份已验证，再填一枚邀请码即可开通账号")
                : t("登录后可跨设备同步收藏与屏蔽，并绑定自己的 Telegram Bot")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-900"
            title={t("关闭")}
          >
            <X size={14} />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-alert-border bg-alert-subtle px-3 py-2 text-[12px] text-alert">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {inviteMode ? (
            <>
              <label className="block">
                <span className="text-[12px] font-medium text-ink-700">{t("邀请码")}</span>
                <input
                  value={invite}
                  onChange={(e) => setInvite(e.target.value.toUpperCase())}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitInvite();
                  }}
                  placeholder="FR-XXXX-XXXX"
                  maxLength={32}
                  autoFocus
                  className="mt-1 w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-2 font-mono text-[13px] tracking-wider text-ink-950 outline-none focus:border-accent"
                />
              </label>
              <button
                type="button"
                onClick={() => void submitInvite()}
                disabled={busy === "invite" || !invite.trim()}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-solid px-3 py-2 text-[13px] font-medium text-on-solid hover:bg-solid-hover disabled:opacity-60"
              >
                {busy === "invite" ? <Loader2 size={14} className="animate-spin" /> : <Ticket size={14} />}
                {t("验证并完成注册")}
              </button>
              <p className="text-[11px] leading-relaxed text-ink-500">
                {t("凭证 10 分钟内有效。过期了就关掉这个窗口重新点「LINUX DO 登录」。")}
              </p>
            </>
          ) : (
            <>
              {boot.loginEnabled ? (
                <>
                  {/* 只有邀请码注册时才显示补码输入；开放注册下这里是空噪声 */}
                  {boot.registrationMode === "invite" && (
                    <label className="block">
                      <span className="text-[12px] font-medium text-ink-700">{t("邀请码")}</span>
                      <input
                        value={invite}
                        onChange={(e) => setInvite(e.target.value.toUpperCase())}
                        placeholder={t("新用户必填，老用户留空")}
                        maxLength={32}
                        className="mt-1 w-full rounded-lg border border-ink-200 bg-surface px-2.5 py-2 font-mono text-[13px] tracking-wider text-ink-950 outline-none focus:border-accent"
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    onClick={() => startLogin(invite)}
                    disabled={!boot.oauthConfigured}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-solid px-3 py-2 text-[13px] font-medium text-on-solid hover:bg-solid-hover disabled:opacity-60"
                  >
                    <LogIn size={14} />
                    {t("跳转 LINUX DO 授权")}
                  </button>
                  {boot.githubConfigured && (
                    <button
                      type="button"
                      onClick={() => startLogin(invite, "github")}
                      className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-3 py-2 text-[13px] font-medium text-ink-800 hover:bg-ink-100"
                    >
                      <Github size={14} /> {t("跳转 GitHub 授权")}
                    </button>
                  )}
                  {!boot.oauthConfigured && (
                    <p className="text-[12px] text-ink-500">
                      {t("服务端还没有配置 LINUXDO_CLIENT_ID / SECRET，先按下方的本地测试账号体验。")}
                    </p>
                  )}
                </>
              ) : (
                <p className="rounded-md border border-ink-200 bg-surface-hover px-3 py-2 text-[12px] text-ink-600">
                  {t("站点当前已关闭登录入口。已有登录态不受影响。")}
                </p>
              )}

              {boot.devMockEnabled && (
                <div className="rounded-lg border border-ink-200 bg-surface-hover p-3">
                  <div className="mb-2 text-[12px] font-medium text-ink-700">{t("本地测试账号（仅非生产环境可见）")}</div>
                  <div className="flex gap-2">
                    {(["alice", "bob"] as const).map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => void devLogin(preset)}
                        disabled={busy !== null}
                        className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-700 hover:bg-ink-100 disabled:opacity-60"
                      >
                        {busy === preset ? <Loader2 size={12} className="animate-spin" /> : null}
                        {t("账号")} {preset === "alice" ? "A" : "B"}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
                    {t("用来验证「A 关掉的条目不会影响 B」，以及两个账号各自推送到自己的 Bot。")}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
