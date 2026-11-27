import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { installAuthFetch } from "./lib/auth.ts";
import { applyDocumentLang, t } from "./lib/i18n.ts";
import { initTheme } from "./lib/theme.ts";
import "./styles.css";

// 所有请求自动带上管理密码（若已登录）
installAuthFetch();

// 主题在首帧前落地，避免深色用户先看到一屏白
initTheme();
// 语言相关的文档级副作用只在启动时做一次（切换语言会整页重载）
applyDocumentLang();
document.title = t("生财雷达 · 商业情报与实战知识库");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
