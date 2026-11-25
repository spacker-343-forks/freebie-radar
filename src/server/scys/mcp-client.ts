import { createHash, randomBytes } from "node:crypto";
import { get, run } from "../db.ts";

export const DEFAULT_SCYS_MCP_URL = "https://mcp.scys.com/shengcai-web/mcp";
export const SCYS_AUTH_SETTINGS_KEY = "scys_mcp_auth";
export const DEFAULT_MIN_INTERVAL_MS = 4000;
export const TOKEN_REFRESH_MARGIN_MS = 120_000;

/** Strict read-only allowlist: write/mutation tools (like/favorite/anchor/comment) are strictly forbidden. */
export const SCYS_READONLY_TOOLS: ReadonlySet<string> = new Set([
  "searchTopic",
  "topicDetail",
  "contentSearch",
  "projectLibSearch",
  "projectLibDetail",
  "searchProjectCases",
  "activityManualToc",
  "activityManualDetail",
  "activityManualSearch",
]);

export function isReadOnlyScysTool(name: string): boolean {
  return SCYS_READONLY_TOOLS.has(name);
}

export type McpToolInputSchema = {
  type?: string;
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
};

export type McpToolSchema = {
  name: string;
  description?: string;
  inputSchema?: McpToolInputSchema;
};

export type ScysProtectedResourceMetadata = {
  resource?: string;
  resource_name?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
};

export type ScysAuthServerMetadata = {
  issuer?: string;
  authorization_endpoint?: string;
  authorization_handoff_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
};

export type ScysOAuthDiscovery = {
  mcpUrl: string;
  scope: string;
  resourceMetadata: ScysProtectedResourceMetadata | null;
  authServerMetadata: ScysAuthServerMetadata;
};

export type ScysAuthState = {
  mcpUrl: string;
  clientId: string;
  clientSecret?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenEndpoint: string;
  authorizationEndpoint?: string;
  authorizationHandoffEndpoint?: string;
  registrationEndpoint?: string;
  scope?: string;
  cachedToolSchemas?: McpToolSchema[];
  updatedAt: string;
};

export type FetchLike = typeof fetch;

export class ScysAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScysAuthError";
  }
}

export class ScysToolBlockedError extends Error {
  constructor(toolName: string) {
    super(`禁止调用非只读工具 "${toolName}"：scys-mcp 客户端仅允许只读查询工具`);
    this.name = "ScysToolBlockedError";
  }
}

export function loadScysAuth(): ScysAuthState | null {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", SCYS_AUTH_SETTINGS_KEY);
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<ScysAuthState>;
    if (!parsed || typeof parsed !== "object" || !parsed.accessToken || !parsed.tokenEndpoint) {
      return null;
    }
    return {
      mcpUrl: parsed.mcpUrl || DEFAULT_SCYS_MCP_URL,
      clientId: parsed.clientId || "",
      clientSecret: parsed.clientSecret,
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      tokenEndpoint: parsed.tokenEndpoint,
      authorizationEndpoint: parsed.authorizationEndpoint,
      authorizationHandoffEndpoint: parsed.authorizationHandoffEndpoint,
      registrationEndpoint: parsed.registrationEndpoint,
      scope: parsed.scope || "mcp",
      cachedToolSchemas: Array.isArray(parsed.cachedToolSchemas) ? parsed.cachedToolSchemas : undefined,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveScysAuth(state: ScysAuthState): void {
  const now = new Date().toISOString();
  const next: ScysAuthState = { ...state, updatedAt: now };
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    SCYS_AUTH_SETTINGS_KEY,
    JSON.stringify(next),
    now,
  );
}

export function generatePkce(): {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
} {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge, codeChallengeMethod: "S256" };
}

export function generateOAuthState(): string {
  return randomBytes(24).toString("base64url");
}

function parseWwwAuthenticate(header: string | null): { resourceMetadata?: string; scope?: string } {
  if (!header) return {};
  const rm = /resource_metadata="([^"]+)"/i.exec(header)?.[1];
  const sc = /scope="([^"]+)"/i.exec(header)?.[1];
  return { resourceMetadata: rm, scope: sc };
}

async function fetchJsonOrNull<T>(url: string, fetchFn: FetchLike): Promise<T | null> {
  try {
    const res = await fetchFn(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function buildAuthServerMetadataCandidates(issuerUrl: string): string[] {
  const u = new URL(issuerUrl);
  const path = u.pathname.replace(/\/+$/, "");
  if (path && path !== "/") {
    return [
      `${u.origin}/.well-known/oauth-authorization-server${path}`,
      `${u.origin}${path}/.well-known/oauth-authorization-server`,
      `${u.origin}/.well-known/openid-configuration${path}`,
      `${u.origin}${path}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${u.origin}/.well-known/oauth-authorization-server`,
    `${u.origin}/.well-known/openid-configuration`,
  ];
}

export async function discoverOAuthMetadata(
  mcpUrl = DEFAULT_SCYS_MCP_URL,
  fetchFn: FetchLike = fetch,
): Promise<ScysOAuthDiscovery> {
  const parsedMcp = new URL(mcpUrl);
  const mcpPath = parsedMcp.pathname.replace(/\/+$/, "");

  let hintedResourceMetadata: string | undefined;
  let hintedScope = "mcp";
  try {
    const probe = await fetchFn(mcpUrl, { method: "GET", headers: { accept: "application/json" } });
    const www = parseWwwAuthenticate(probe.headers.get("www-authenticate"));
    hintedResourceMetadata = www.resourceMetadata;
    if (www.scope) hintedScope = www.scope;
  } catch {
    /* ignore initial probe network nuances; fall back to well-known paths */
  }

  const prCandidates = [
    ...(hintedResourceMetadata ? [hintedResourceMetadata] : []),
    ...(mcpPath && mcpPath !== "/" ? [`${parsedMcp.origin}/.well-known/oauth-protected-resource${mcpPath}`] : []),
    `${parsedMcp.origin}/.well-known/oauth-protected-resource`,
  ];

  let resourceMetadata: ScysProtectedResourceMetadata | null = null;
  for (const url of prCandidates) {
    const data = await fetchJsonOrNull<ScysProtectedResourceMetadata>(url, fetchFn);
    if (data && (data.authorization_servers?.length || data.resource)) {
      resourceMetadata = data;
      break;
    }
  }

  const scope = resourceMetadata?.scopes_supported?.[0] || hintedScope || "mcp";
  const authServers = resourceMetadata?.authorization_servers?.length
    ? resourceMetadata.authorization_servers
    : [parsedMcp.origin];

  for (const issuer of authServers) {
    for (const candidate of buildAuthServerMetadataCandidates(issuer)) {
      const meta = await fetchJsonOrNull<ScysAuthServerMetadata>(candidate, fetchFn);
      if (meta?.authorization_endpoint && meta?.token_endpoint) {
        return { mcpUrl, scope, resourceMetadata, authServerMetadata: meta };
      }
    }
  }

  throw new ScysAuthError(`无法发现生财有术 MCP OAuth 元数据 (${mcpUrl})`);
}

export async function registerDynamicClient(
  registrationEndpoint: string,
  redirectUri: string,
  fetchFn: FetchLike = fetch,
  scope = "mcp",
): Promise<{ clientId: string; clientSecret?: string }> {
  const res = await fetchFn(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "scys-radar",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ScysAuthError(`OAuth 动态客户端注册失败 (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const data = JSON.parse(text) as { client_id?: string; client_secret?: string };
  if (!data.client_id) {
    throw new ScysAuthError("OAuth 动态客户端注册未返回 client_id");
  }
  return { clientId: data.client_id, clientSecret: data.client_secret };
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

export async function exchangeAuthorizationCode(params: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  fetchFn?: FetchLike;
}): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string; scope?: string }> {
  const fetchFn = params.fetchFn ?? fetch;
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.codeVerifier,
  });
  if (params.clientSecret) form.set("client_secret", params.clientSecret);

  const res = await fetchFn(params.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form.toString(),
  });
  const text = await res.text();
  let data: TokenResponse = {};
  try {
    data = JSON.parse(text) as TokenResponse;
  } catch {
    /* keep empty */
  }
  if (!res.ok || !data.access_token) {
    throw new ScysAuthError(
      `OAuth 换取 Token 失败 (HTTP ${res.status}): ${data.error_description || data.error || text.slice(0, 200)}`,
    );
  }
  const expiresAt =
    typeof data.expires_in === "number" && Number.isFinite(data.expires_in)
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : undefined;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
    scope: data.scope,
  };
}

export async function refreshScysAccessToken(
  state: ScysAuthState,
  fetchFn: FetchLike = fetch,
  persist = true,
): Promise<ScysAuthState> {
  if (!state.refreshToken) {
    throw new ScysAuthError("生财有术 MCP 令牌已过期且无 refresh_token，请运行 pnpm scys:auth 重新登录");
  }
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: state.refreshToken,
    client_id: state.clientId,
  });
  if (state.clientSecret) form.set("client_secret", state.clientSecret);

  const res = await fetchFn(state.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form.toString(),
  });
  const text = await res.text();
  let data: TokenResponse = {};
  try {
    data = JSON.parse(text) as TokenResponse;
  } catch {
    /* ignore */
  }

  if (res.status === 400 || res.status === 401) {
    throw new ScysAuthError(
      `生财有术 MCP 授权已失效 (${data.error || `HTTP ${res.status}`})，请运行 pnpm scys:auth 重新授权`,
    );
  }
  if (!res.ok || !data.access_token) {
    throw new Error(`刷新生财有术 MCP Token 失败 (HTTP ${res.status}): ${data.error_description || text.slice(0, 200)}`);
  }

  const expiresAt =
    typeof data.expires_in === "number" && Number.isFinite(data.expires_in)
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : state.expiresAt;

  const updated: ScysAuthState = {
    ...state,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || state.refreshToken,
    expiresAt,
    scope: data.scope || state.scope,
    updatedAt: new Date().toISOString(),
  };
  if (persist) saveScysAuth(updated);
  return updated;
}

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  method?: string;
};

/** Parses either standard JSON or `text/event-stream` SSE frames returned by MCP Streamable HTTP. */
export function parseMcpStreamableBody(
  body: string,
  contentType: string,
  expectedId?: string | number,
): JsonRpcMessage {
  const trimmed = body.trim();
  const isSse = contentType.toLowerCase().includes("text/event-stream") || /^(?:event:|data:|:)/m.test(trimmed);
  if (!isSse) {
    return JSON.parse(trimmed) as JsonRpcMessage;
  }

  const blocks = body.split(/\r?\n\r?\n/);
  const messages: JsonRpcMessage[] = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (!dataLines.length) continue;
    const payload = dataLines.join("\n").trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const msg = JSON.parse(payload) as JsonRpcMessage;
      messages.push(msg);
    } catch {
      /* ignore non-JSON SSE keepalive/control frames */
    }
  }

  if (!messages.length) {
    throw new Error(`无法从 SSE 响应中解析 JSON-RPC 消息: ${trimmed.slice(0, 160)}`);
  }
  if (expectedId !== undefined) {
    const matched = messages.find((m) => m.id === expectedId);
    if (matched) return matched;
  }
  const withOutcome = [...messages].reverse().find((m) => m.result !== undefined || m.error !== undefined);
  return withOutcome ?? messages[messages.length - 1]!;
}

function parseRetryAfterMs(header: string | null, fallbackMs: number): number {
  if (!header) return fallbackMs;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return fallbackMs;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export type ScysMcpClientOptions = {
  minIntervalMs?: number;
  maxRetries?: number;
  fetchFn?: FetchLike;
  loadAuth?: () => ScysAuthState | null;
  saveAuth?: (state: ScysAuthState) => void;
};

export class ScysMcpClient {
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: FetchLike;
  private readonly loadAuthFn: () => ScysAuthState | null;
  private readonly saveAuthFn: (state: ScysAuthState) => void;

  private authState: ScysAuthState | null = null;
  private sessionId: string | null = null;
  private initialized = false;
  private nextRpcId = 1;
  private lastRequestAt = 0;
  private serialQueue: Promise<void> = Promise.resolve();
  private refreshInFlight: Promise<ScysAuthState> | null = null;

  constructor(options: ScysMcpClientOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchFn = options.fetchFn ?? fetch;
    this.loadAuthFn = options.loadAuth ?? loadScysAuth;
    this.saveAuthFn = options.saveAuth ?? saveScysAuth;
  }

  private getAuthOrThrow(): ScysAuthState {
    if (!this.authState) {
      this.authState = this.loadAuthFn();
    }
    if (!this.authState?.accessToken) {
      throw new ScysAuthError("未配置生财有术 MCP OAuth 登录态，请先运行 pnpm scys:auth 完成授权");
    }
    return this.authState;
  }

  private isTokenExpiringSoon(state: ScysAuthState): boolean {
    if (!state.expiresAt) return false;
    const expMs = Date.parse(state.expiresAt);
    if (Number.isNaN(expMs)) return false;
    return expMs - Date.now() <= TOKEN_REFRESH_MARGIN_MS;
  }

  private async ensureValidToken(forceRefresh = false): Promise<ScysAuthState> {
    const current = this.getAuthOrThrow();
    if (!forceRefresh && !this.isTokenExpiringSoon(current)) {
      return current;
    }
    if (!this.refreshInFlight) {
      this.refreshInFlight = (async () => {
        try {
          const refreshed = await refreshScysAccessToken(current, this.fetchFn, false);
          this.authState = refreshed;
          this.saveAuthFn(refreshed);
          return refreshed;
        } finally {
          this.refreshInFlight = null;
        }
      })();
    }
    return this.refreshInFlight;
  }

  private enqueueSerial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.serialQueue.then(async () => {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
      return fn();
    });
    this.serialQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private isSessionInvalidResponse(status: number, body: string): boolean {
    if (status === 404) return true;
    const sessionErrRe =
      /(?:invalid|expired|unknown|terminated|missing)[\s_-]*session|session[\s_-]*(?:not\s+found|expired|invalid|terminated|unknown)/i;
    if (status === 400 && /session/i.test(body)) return true;
    return sessionErrRe.test(body);
  }

  private async postJsonRpc(
    method: string,
    params?: Record<string, unknown>,
    isNotification = false,
    allowSessionRetry = true,
  ): Promise<unknown> {
    let authRefreshedFor401 = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const auth = await this.ensureValidToken(false);
      const id = isNotification ? undefined : this.nextRpcId++;
      const payload = isNotification
        ? { jsonrpc: "2.0", method, ...(params ? { params } : {}) }
        : { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
      const sentSessionId = this.sessionId;

      const res = await this.enqueueSerial(async () => {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${auth.accessToken}`,
        };
        if (sentSessionId) {
          headers["mcp-session-id"] = sentSessionId;
        }
        return this.fetchFn(auth.mcpUrl || DEFAULT_SCYS_MCP_URL, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });
      });

      const returnedSessionId = res.headers.get("mcp-session-id");
      if (returnedSessionId) {
        this.sessionId = returnedSessionId;
      }

      if (res.status === 401 && !authRefreshedFor401) {
        authRefreshedFor401 = true;
        await this.ensureValidToken(true);
        continue;
      }
      if (res.status === 401) {
        throw new ScysAuthError("生财有术 MCP 认证失败 (HTTP 401)，请运行 pnpm scys:auth 重新授权");
      }
      if (res.status === 429 && attempt < this.maxRetries) {
        const waitMs = parseRetryAfterMs(res.headers.get("retry-after"), Math.max(this.minIntervalMs, 5000));
        await sleep(waitMs);
        continue;
      }

      const body = await res.text();
      if (
        allowSessionRetry &&
        sentSessionId &&
        method !== "initialize" &&
        method !== "notifications/initialized" &&
        this.isSessionInvalidResponse(res.status, body)
      ) {
        this.sessionId = null;
        this.initialized = false;
        await this.initialize();
        return this.postJsonRpc(method, params, isNotification, false);
      }

      if (!res.ok) {
        throw new Error(`scys-mcp HTTP ${res.status} (${method}): ${body.slice(0, 240)}`);
      }
      if (isNotification && (!body.trim() || res.status === 202 || res.status === 204)) {
        return undefined;
      }

      const rpc = parseMcpStreamableBody(body, res.headers.get("content-type") ?? "", id);
      if (rpc.error) {
        if (
          allowSessionRetry &&
          sentSessionId &&
          method !== "initialize" &&
          method !== "notifications/initialized" &&
          this.isSessionInvalidResponse(res.status, JSON.stringify(rpc.error))
        ) {
          this.sessionId = null;
          this.initialized = false;
          await this.initialize();
          return this.postJsonRpc(method, params, isNotification, false);
        }
        throw new Error(`scys-mcp RPC 错误 (${method}, code=${rpc.error.code ?? "?"}): ${rpc.error.message ?? "unknown"}`);
      }
      return rpc.result;
    }

    throw new Error(`scys-mcp 请求重试耗尽 (${method})`);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.postJsonRpc(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "scys-radar", version: "1.0.0" },
      },
      false,
      false,
    );
    await this.postJsonRpc("notifications/initialized", undefined, true, false).catch(() => {
      /* stateless servers may omit handling notifications */
    });
    this.initialized = true;
  }

  async listTools(options: { forceRefresh?: boolean } = {}): Promise<McpToolSchema[]> {
    const auth = this.getAuthOrThrow();
    if (!options.forceRefresh && auth.cachedToolSchemas?.length) {
      return auth.cachedToolSchemas;
    }
    await this.initialize();

    const tools: McpToolSchema[] = [];
    let cursor: string | undefined;
    do {
      const result = (await this.postJsonRpc("tools/list", cursor ? { cursor } : {})) as {
        tools?: McpToolSchema[];
        nextCursor?: string;
      };
      if (Array.isArray(result?.tools)) {
        tools.push(...result.tools);
      }
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
    } while (cursor);

    const latestAuth = this.authState ?? auth;
    const updated: ScysAuthState = {
      ...latestAuth,
      cachedToolSchemas: tools,
      updatedAt: new Date().toISOString(),
    };
    this.authState = updated;
    this.saveAuthFn(updated);
    return tools;
  }

  async getToolSchemas(): Promise<McpToolSchema[]> {
    return this.listTools({ forceRefresh: false });
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!isReadOnlyScysTool(name)) {
      throw new ScysToolBlockedError(name);
    }
    await this.initialize();
    const result = (await this.postJsonRpc("tools/call", { name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: unknown;
      content?: Array<{ type?: string; text?: string }>;
    };

    if (result?.isError) {
      const msg =
        result.content
          ?.map((c) => c.text ?? "")
          .filter(Boolean)
          .join("\n") || "MCP tool returned isError=true";
      throw new Error(`scys-mcp 工具 ${name} 返回错误: ${msg}`);
    }

    if (result?.structuredContent !== undefined) {
      return result.structuredContent as T;
    }

    const texts = (result?.content ?? [])
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text!);

    if (texts.length === 1) {
      const single = texts[0]!.trim();
      if (single.startsWith("{") || single.startsWith("[")) {
        try {
          return JSON.parse(single) as T;
        } catch {
          /* return raw text */
        }
      }
      return single as T;
    }
    if (texts.length > 1) {
      return texts.join("\n") as T;
    }
    return result as T;
  }
}

export type ToolIntent = {
  keyword?: string;
  tag?: string;
  pageSize?: number;
  page?: number;
  cursor?: string | null;
  topicId?: string;
  mode?: "highlights" | "projects" | "latest" | "manuals";
  compact?: boolean;
};

function pickProp(props: Record<string, Record<string, unknown>>, candidates: string[]): string | null {
  const keys = Object.keys(props);
  for (const c of candidates) {
    if (keys.includes(c)) return c;
  }
  const lowerMap = new Map(keys.map((k) => [k.toLowerCase(), k]));
  for (const c of candidates) {
    const found = lowerMap.get(c.toLowerCase());
    if (found) return found;
  }
  return null;
}

function pickEnumValue(propDef: Record<string, unknown> | undefined, preferred: string[]): string | null {
  const enumVals = Array.isArray(propDef?.enum) ? propDef.enum.filter((v): v is string => typeof v === "string") : [];
  if (!enumVals.length) return null;
  for (const pref of preferred) {
    const exact = enumVals.find((e) => e.toLowerCase() === pref.toLowerCase());
    if (exact) return exact;
  }
  for (const pref of preferred) {
    const partial = enumVals.find((e) => e.toLowerCase().includes(pref.toLowerCase()));
    if (partial) return partial;
  }
  return null;
}

/**
 * Dynamically adapts semantic arguments to the live `tools/list` inputSchema for a given tool,
 * falling back cleanly when schema metadata is absent and honoring explicit user overrides.
 */
export function buildToolArgs(
  toolName: string,
  schemas: McpToolSchema[],
  intent: ToolIntent,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  const schema = schemas.find((s) => s.name === toolName);
  const props = schema?.inputSchema?.properties ?? {};
  const hasProps = Object.keys(props).length > 0;
  const out: Record<string, unknown> = {};

  if (intent.keyword) {
    const key = hasProps ? pickProp(props, ["keyword", "query", "q", "search", "searchKey", "title"]) : "keyword";
    if (key) out[key] = intent.keyword;
  }

  if (intent.tag) {
    const key = hasProps ? pickProp(props, ["tag", "tags", "category", "channel", "section"]) : "tag";
    if (key) {
      const propType = props[key]?.type;
      out[key] = propType === "array" ? [intent.tag] : intent.tag;
    }
  }

  if (intent.pageSize !== undefined) {
    const bounded = toolName === "contentSearch" ? Math.min(5, Math.max(1, intent.pageSize)) : Math.max(1, intent.pageSize);
    const key = hasProps ? pickProp(props, ["pageSize", "limit", "size", "count", "perPage", "num"]) : "pageSize";
    if (key) out[key] = bounded;
  }

  if (intent.cursor) {
    const key = hasProps ? pickProp(props, ["cursor", "nextCursor", "pageToken"]) : null;
    if (key) out[key] = intent.cursor;
  } else if (intent.page !== undefined) {
    const key = hasProps ? pickProp(props, ["page", "pageNo", "pageNum", "offset"]) : "page";
    if (key) out[key] = intent.page;
  }

  if (intent.topicId) {
    const candidatesByTool: Record<string, string[]> = {
      topicDetail: ["topicId", "topic_id", "id", "postId"],
      projectLibDetail: ["projectId", "project_id", "id", "caseId"],
      activityManualDetail: ["manualId", "manual_id", "docId", "articleId", "chapterId", "id", "slug"],
    };
    const candidates = candidatesByTool[toolName] ?? ["topicId", "id"];
    const key = hasProps ? pickProp(props, candidates) : candidates[0]!;
    if (key) out[key] = intent.topicId;
  }

  if (intent.compact && toolName === "searchTopic") {
    const compactKey = hasProps ? pickProp(props, ["compact", "isCompact", "brief"]) : null;
    if (compactKey) out[compactKey] = true;
    const modeKey = hasProps ? pickProp(props, ["responseFormat", "detailLevel", "format"]) : null;
    if (modeKey) {
      const val = pickEnumValue(props[modeKey], ["compact", "brief", "summary"]);
      if (val) out[modeKey] = val;
    }
  }

  if (toolName === "searchTopic" && (intent.mode === "highlights" || intent.mode === "latest")) {
    const isHighlights = intent.mode === "highlights";
    if (hasProps) {
      const boolEssence = pickProp(props, ["isEssence", "essence", "onlyEssence", "digest", "highlight", "isHighlight", "essenceOnly"]);
      if (boolEssence && isHighlights && props[boolEssence]?.type === "boolean") {
        out[boolEssence] = true;
      }
      const sortKey = pickProp(props, ["sort", "sortBy", "orderBy", "tab", "type", "filter", "mode"]);
      if (sortKey) {
        const preferred = isHighlights
          ? ["highlight", "essence", "digest", "hot", "featured", "recommended"]
          : ["latest", "new", "newest", "recent", "time"];
        const matched = pickEnumValue(props[sortKey], preferred);
        if (matched) out[sortKey] = matched;
      }
    } else if (isHighlights) {
      out.sort = "highlight";
    } else {
      out.sort = "latest";
    }
  }

  if (overrides && typeof overrides === "object") {
    Object.assign(out, overrides);
  }
  return out;
}
