import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { migrate } from "../src/server/db.ts";
import {
  buildToolArgs,
  DEFAULT_SCYS_MCP_URL,
  discoverOAuthMetadata,
  exchangeAuthorizationCode,
  generateOAuthState,
  generatePkce,
  isReadOnlyScysTool,
  loadScysAuth,
  registerDynamicClient,
  saveScysAuth,
  ScysMcpClient,
  type McpToolSchema,
  type ScysAuthState,
} from "../src/server/scys/mcp-client.ts";

const SCHEMA_OUTPUT_PATH = resolve(process.cwd(), "data/scys-tools-schema.json");

function writeSchemasFile(tools: McpToolSchema[]): void {
  mkdirSync(dirname(SCHEMA_OUTPUT_PATH), { recursive: true });
  writeFileSync(SCHEMA_OUTPUT_PATH, JSON.stringify(tools, null, 2) + "\n", "utf8");
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    /* ignore if no browser launcher is available */
  }
}

function printStatus(): void {
  const state = loadScysAuth();
  if (!state) {
    console.log("状态: 未登录（settings.scys_mcp_auth 不存在）");
    console.log("请运行: pnpm scys:auth");
    return;
  }
  const expMs = state.expiresAt ? Date.parse(state.expiresAt) : NaN;
  const remainMin = Number.isFinite(expMs) ? Math.round((expMs - Date.now()) / 60_000) : null;
  const expired = remainMin !== null && remainMin <= 0;

  console.log("状态: 已配置 OAuth 凭据");
  console.log(`MCP 地址: ${state.mcpUrl}`);
  console.log(`Client ID: ${state.clientId ? `${state.clientId.slice(0, 8)}…` : "(空)"}`);
  console.log(`Scope: ${state.scope || "mcp"}`);
  console.log(`Refresh Token: ${state.refreshToken ? "已保存" : "缺失"}`);
  console.log(
    `过期时间: ${state.expiresAt ?? "未知"}${remainMin !== null ? (expired ? ` (已过期 ${Math.abs(remainMin)} 分钟)` : ` (剩余约 ${remainMin} 分钟)`) : ""}`,
  );
  console.log(`已缓存工具数: ${state.cachedToolSchemas?.length ?? 0}`);
  if (state.cachedToolSchemas?.length) {
    console.log(`工具列表: ${state.cachedToolSchemas.map((t) => t.name).join(", ")}`);
  }
  console.log(`更新时间: ${state.updatedAt}`);
}

async function printAndSaveTools(): Promise<void> {
  const client = new ScysMcpClient({ minIntervalMs: 500 });
  const tools = await client.listTools({ forceRefresh: true });
  writeSchemasFile(tools);
  console.log(`已获取 ${tools.length} 个 MCP 工具并写入 ${SCHEMA_OUTPUT_PATH}:`);
  for (const t of tools) {
    const props = Object.keys(t.inputSchema?.properties ?? {});
    const ro = isReadOnlyScysTool(t.name) ? "只读允许" : "已拦截(写/未知)";
    console.log(`- ${t.name} [${ro}] params=[${props.join(", ")}]${t.description ? ` — ${t.description.slice(0, 80)}` : ""}`);
  }
}

function extractCallbackCode(input: string, expectedState: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    const err = u.searchParams.get("error");
    if (err) {
      throw new Error(`OAuth 授权被拒绝: ${u.searchParams.get("error_description") || err}`);
    }
    const state = u.searchParams.get("state");
    if (state && state !== expectedState) {
      throw new Error("回调 URL 的 state 不匹配，请确认复制的是本次授权链接");
    }
    return u.searchParams.get("code");
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("OAuth")) throw err;
    if (err instanceof Error && err.message.startsWith("回调")) throw err;
    if (!trimmed.includes("://") && !trimmed.includes(" ")) return trimmed;
    return null;
  }
}

async function waitForAuthCode(params: {
  expectedState: string;
  codeChallenge: string;
  handoffEndpoint?: string;
  headless: boolean;
}): Promise<{ code: string; cleanup: () => void }> {
  return new Promise((resolveCode, rejectCode) => {
    let settled = false;
    let handoffTimer: ReturnType<typeof setInterval> | null = null;
    let rl: ReturnType<typeof createInterface> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (handoffTimer) clearInterval(handoffTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      try {
        rl?.close();
      } catch {
        /* ignore */
      }
      try {
        server.close();
      } catch {
        /* ignore */
      }
    };

    const finish = (code: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveCode({ code, cleanup });
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectCode(err);
    };

    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
      if (reqUrl.pathname !== "/callback") {
        res.writeHead(404).end("Not Found");
        return;
      }
      const oauthErr = reqUrl.searchParams.get("error");
      if (oauthErr) {
        const desc = reqUrl.searchParams.get("error_description") || oauthErr;
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(`<h3>授权失败</h3><p>${desc}</p>`);
        fail(new Error(`OAuth 授权失败: ${desc}`));
        return;
      }
      const state = reqUrl.searchParams.get("state");
      const code = reqUrl.searchParams.get("code");
      if (!code || state !== params.expectedState) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end("<h3>无效回调参数</h3>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<h2>生财有术 MCP 授权成功</h2><p>可以关闭此浏览器标签页并返回终端。</p>");
      finish(code);
    });

    server.on("error", (err) => fail(err));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        fail(new Error("无法启动本地 OAuth 回调监听服务"));
        return;
      }
      (server as unknown as { __redirectUri?: string }).__redirectUri = `http://127.0.0.1:${addr.port}/callback`;
      server.emit("listening_ready", `http://127.0.0.1:${addr.port}/callback`);
    });

    timeoutTimer = setTimeout(() => {
      fail(new Error("等待 OAuth 授权超时（5 分钟）"));
    }, 5 * 60_000);

    if (params.handoffEndpoint) {
      const endpoint = params.handoffEndpoint;
      handoffTimer = setInterval(async () => {
        if (settled) return;
        try {
          const form = new URLSearchParams({
            state: params.expectedState,
            code_challenge: params.codeChallenge,
          });
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: form.toString(),
          });
          if (res.status === 200) {
            const data = (await res.json()) as { callback_uri?: string; callbackUrl?: string };
            const cb = data.callback_uri || data.callbackUrl || "";
            const code = extractCallbackCode(cb, params.expectedState);
            if (code) finish(code);
          }
        } catch {
          /* retry on next 3s tick */
        }
      }, 3000);
    }

    if (process.stdin.isTTY) {
      rl = createInterface({ input: process.stdin, output: process.stdout });
      void (async () => {
        try {
          while (!settled) {
            const line = await rl!.question("");
            if (settled) break;
            const code = extractCallbackCode(line, params.expectedState);
            if (code) {
              finish(code);
              break;
            }
          }
        } catch {
          /* ignore closed stdin */
        }
      })();
    }

    // expose server via a small symbol property so caller gets redirectUri synchronously after bind
    (waitForAuthCode as unknown as { _lastServer?: typeof server })._lastServer = server;
  });
}

async function runInteractiveLogin(mcpUrl: string, headless: boolean): Promise<void> {
  console.log(`[scys-auth] 正在探测 OAuth 元数据: ${mcpUrl}`);
  const discovery = await discoverOAuthMetadata(mcpUrl);
  const { authServerMetadata, scope } = discovery;

  if (!authServerMetadata.authorization_endpoint || !authServerMetadata.token_endpoint) {
    throw new Error("OAuth 元数据缺少 authorization_endpoint 或 token_endpoint");
  }
  if (!authServerMetadata.registration_endpoint) {
    throw new Error("OAuth 元数据缺少 registration_endpoint，无法完成动态客户端注册");
  }

  // Bind local ephemeral callback server first to obtain redirectUri
  let resolveRedirect!: (uri: string) => void;
  const redirectReady = new Promise<string>((r) => {
    resolveRedirect = r;
  });

  const expectedState = generateOAuthState();
  const pkce = generatePkce();

  const codePromise = waitForAuthCode({
    expectedState,
    codeChallenge: pkce.codeChallenge,
    handoffEndpoint: authServerMetadata.authorization_handoff_endpoint,
    headless,
  });
  const srv = (waitForAuthCode as unknown as { _lastServer?: ReturnType<typeof createServer> })._lastServer;
  if (!srv) throw new Error("本地回调服务器初始化失败");
  srv.once("listening_ready", (uri: string) => resolveRedirect(uri));

  const redirectUri = await redirectReady;
  console.log(`[scys-auth] 正在注册 OAuth 客户端 (redirect_uri=${redirectUri})`);
  const client = await registerDynamicClient(authServerMetadata.registration_endpoint, redirectUri, fetch, scope);

  const authUrl = new URL(authServerMetadata.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", client.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("state", expectedState);
  authUrl.searchParams.set("code_challenge", pkce.codeChallenge);
  authUrl.searchParams.set("code_challenge_method", pkce.codeChallengeMethod);
  if (discovery.resourceMetadata?.resource) {
    authUrl.searchParams.set("resource", discovery.resourceMetadata.resource);
  }

  console.log("\n请在浏览器打开以下链接完成生财有术登录与授权：");
  console.log(authUrl.toString());
  console.log(
    authServerMetadata.authorization_handoff_endpoint
      ? "\n等待回调中（支持自动本地回调、3s handoff 轮询，或直接粘贴回调 URL 后回车）…"
      : "\n等待回调中（浏览器授权后会自动完成，或直接粘贴回调 URL 后回车）…",
  );
  if (!headless) {
    openBrowser(authUrl.toString());
  }

  const { code } = await codePromise;
  console.log("[scys-auth] 已收到授权码，正在换取 Access Token…");
  const tokens = await exchangeAuthorizationCode({
    tokenEndpoint: authServerMetadata.token_endpoint,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    code,
    redirectUri,
    codeVerifier: pkce.codeVerifier,
  });

  const state: ScysAuthState = {
    mcpUrl,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    tokenEndpoint: authServerMetadata.token_endpoint,
    authorizationEndpoint: authServerMetadata.authorization_endpoint,
    authorizationHandoffEndpoint: authServerMetadata.authorization_handoff_endpoint,
    registrationEndpoint: authServerMetadata.registration_endpoint,
    scope: tokens.scope || scope,
    updatedAt: new Date().toISOString(),
  };
  saveScysAuth(state);
  console.log("[scys-auth] OAuth 凭据已保存到 SQLite settings.scys_mcp_auth");

  const mcpClient = new ScysMcpClient({ minIntervalMs: 500 });
  const tools = await mcpClient.listTools({ forceRefresh: true });
  writeSchemasFile(tools);
  console.log(`[scys-auth] 已同步 ${tools.length} 个工具 Schema 到 ${SCHEMA_OUTPUT_PATH}`);

  const smokeTool = tools.find((t) => t.name === "searchTopic")
    ? "searchTopic"
    : tools.find((t) => isReadOnlyScysTool(t.name))?.name;
  if (smokeTool) {
    const args = buildToolArgs(smokeTool, tools, { mode: "highlights", pageSize: 1, page: 1, compact: true });
    await mcpClient.callTool(smokeTool, args);
    console.log(`[scys-auth] 只读冒烟测试成功 (${smokeTool}, 1 item)`);
  }
}

async function main(): Promise<void> {
  migrate();
  const args = process.argv.slice(2);
  if (args.includes("--status")) {
    printStatus();
    return;
  }
  if (args.includes("--tools")) {
    await printAndSaveTools();
    return;
  }
  const headless = args.includes("--headless");
  const urlIdx = args.indexOf("--mcp-url");
  const mcpUrl = urlIdx >= 0 && args[urlIdx + 1] ? args[urlIdx + 1]! : DEFAULT_SCYS_MCP_URL;
  await runInteractiveLogin(mcpUrl, headless);
}

main().catch((err) => {
  console.error(`[scys-auth] 错误: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
