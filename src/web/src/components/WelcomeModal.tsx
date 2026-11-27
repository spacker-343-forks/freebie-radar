import { Dialog } from "./Dialog.tsx";
import { BookOpen, Globe2, Send, ShieldCheck, X, Zap } from "lucide-react";
import type { Bootstrap } from "../lib/session.ts";
import { t } from "../lib/i18n.ts";

/**
 * 完整站点说明由用户主动打开，首次入站使用不阻断浏览的公告。
 * 内容由后台可编辑，这里的引导卡片按站点形态动态决定显示哪几条。
 */
export function WelcomeModal({
  boot,
  onClose,
  onLogin,
}: {
  boot: Bootstrap;
  onClose: () => void;
  onLogin: () => void;
}) {
  const ob = boot.onboarding;
  const cards = [
    {
      icon: Zap,
      title: t("⚡ 立项拆解与赛道图谱"),
      body: t("带有「⚡立项书」标识的高分帖内置启动成本、变现公式与单人 MVP 清单；左侧「赛道图谱」汇总 12 大主流变现流派白皮书。"),
    },
    {
      icon: ShieldCheck,
      title: t("本机偏好与富文本永久快照"),
      body: t("收藏、已读、屏蔽词保存在当前浏览器；所有帖子均已归档完整图文快照，原帖删除也不影响站内阅读。"),
    },
    boot.loginEnabled && {
      icon: Send,
      title: t("绑定自己的 Telegram Bot"),
      body: t("登录后可填自己的 Bot Token 与 Chat ID，按个人规则收推送，不会打扰别人。"),
    },
    {
      icon: Globe2,
      title: t("支持 RSS 订阅"),
      body: t("顶栏「RSS」按钮能生成公开订阅链接；登录后还有带个人屏蔽规则的专属链接。"),
    },
  ].filter(Boolean) as { icon: typeof ShieldCheck; title: string; body: string }[];

  return (
    <Dialog label={t(ob.title)} onClose={onClose}>
      <div className="sheet-enter panel w-full max-w-[520px] overflow-hidden">
        <div className="flex items-start justify-between gap-3 border-b border-ink-100 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <BookOpen size={15} className="text-accent" />
            <h2 className="text-[17px] font-semibold text-ink-950">{t(ob.title)}</h2>
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

        <div className="max-h-[62vh] space-y-3 overflow-auto px-5 py-4">
          <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-ink-700">{t(ob.content)}</p>

          {ob.showGuideCards && (
            <div className="space-y-2 pt-1">
              {cards.map((c) => (
                <div key={c.title} className="flex items-start gap-2.5 border-t border-ink-100 py-3">
                  <c.icon size={14} className="mt-0.5 shrink-0 text-accent" />
                  <div>
                    <div className="text-[12px] font-medium text-ink-900">{c.title}</div>
                    <div className="mt-0.5 text-[12px] leading-relaxed text-ink-500">{c.body}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-ink-100 px-5 py-3">
          {boot.loginEnabled && !boot.user && (
            <button
              type="button"
              onClick={onLogin}
              className="rounded-lg border border-ink-200 bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-700 hover:bg-ink-100"
            >
              {t("先登录")}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-solid px-3.5 py-1.5 text-[12px] font-medium text-on-solid hover:bg-solid-hover"
          >
            {t("开始使用")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}