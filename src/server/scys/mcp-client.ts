import { createHash, randomBytes } from "node:crypto";
import { get, run } from "../db.ts";

export const DEFAULT_SCYS_MCP_URL = "https://mcp.scys.com/shengcai-web/mcp";
export const SCYS_AUTH_SETTINGS_KEY = "scys_mcp_auth";
export const DEFAULT_MIN_INTERVAL_MS = 1000;
export const DEFAULT_MAX_CONCURRENCY_PER_SLOT = 3;
export const MAX_SCYS_AUTH_SLOTS = 5;
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
  "getDocumentDetail",
  "pageTopicComment",
  "activityList",
  "activitySearch",
  "searchTrustedContent",
  "getDailyReport",
  "ai__listAiFeedItems",
  "listMyChatGroups",
  "getMyChatGroupMessages",
]);

export function isReadOnlyScysTool(name: string): boolean {
  return SCYS_READONLY_TOOLS.has(name);
}

export type McpToolInputSchema = {
  type?: string;
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
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
  slotId?: string;
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

export type ScysAuthPool = {
  slots: ScysAuthState[];
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

function normalizeAuthSlot(raw: unknown): ScysAuthState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const parsed = raw as Partial<ScysAuthState>;
  if (!parsed.accessToken || !parsed.tokenEndpoint) return null;
  return {
    ...(typeof parsed.slotId === "string" && parsed.slotId ? { slotId: parsed.slotId } : {}),
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
}

/** Loads the OAuth slot pool, seamlessly upgrading legacy single-object `scys_mcp_auth` into `slots: [legacy]`. */
export function loadScysAuthPool(): ScysAuthPool | null {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", SCYS_AUTH_SETTINGS_KEY);
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;

    if (Array.isArray(parsed.slots)) {
      const slots = parsed.slots
        .map(normalizeAuthSlot)
        .filter((s): s is ScysAuthState => s !== null)
        .slice(0, MAX_SCYS_AUTH_SLOTS);
      if (!slots.length) return null;
      const topSchemas = Array.isArray(parsed.cachedToolSchemas)
        ? (parsed.cachedToolSchemas as McpToolSchema[])
        : slots.find((s) => s.cachedToolSchemas?.length)?.cachedToolSchemas;
      return {
        slots,
        cachedToolSchemas: topSchemas,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : slots[0]!.updatedAt,
      };
    }

    const legacy = normalizeAuthSlot(parsed);
    if (!legacy) return null;
    return {
      slots: [legacy],
      cachedToolSchemas: legacy.cachedToolSchemas,
      updatedAt: legacy.updatedAt,
    };
  } catch {
    return null;
  }
}

export function saveScysAuthPool(pool: ScysAuthPool): ScysAuthPool {
  const now = new Date().toISOString();
  const next: ScysAuthPool = {
    slots: pool.slots.slice(0, MAX_SCYS_AUTH_SLOTS).map((s) => {
      const { cachedToolSchemas: _drop, ...rest } = s;
      return rest;
    }),
    cachedToolSchemas: pool.cachedToolSchemas,
    updatedAt: now,
  };
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    SCYS_AUTH_SETTINGS_KEY,
    JSON.stringify(next),
    now,
  );
  return next;
}

export function loadScysAuth(): ScysAuthState | null {
  const pool = loadScysAuthPool();
  if (!pool?.slots.length) return null;
  return {
    ...pool.slots[0]!,
    cachedToolSchemas: pool.cachedToolSchemas ?? pool.slots[0]!.cachedToolSchemas,
  };
}

export function saveScysAuth(state: ScysAuthState): void {
  const existing = loadScysAuthPool();
  const schemas = state.cachedToolSchemas ?? existing?.cachedToolSchemas;
  saveScysAuthPool({
    slots: [state],
    cachedToolSchemas: schemas,
    updatedAt: new Date().toISOString(),
  });
}

export function addScysAuthSlot(state: ScysAuthState, maxSlots = MAX_SCYS_AUTH_SLOTS): { pool: ScysAuthPool; slotIndex: number } {
  const existing = loadScysAuthPool();
  if (!existing) {
    const saved = saveScysAuthPool({
      slots: [state],
      cachedToolSchemas: state.cachedToolSchemas,
      updatedAt: new Date().toISOString(),
    });
    return { pool: saved, slotIndex: 0 };
  }

  const sameIdx = existing.slots.findIndex(
    (s) => s.accessToken === state.accessToken || (Boolean(state.slotId) && s.slotId === state.slotId),
  );
  if (sameIdx >= 0) {
    const nextSlots = [...existing.slots];
    nextSlots[sameIdx] = state;
    const saved = saveScysAuthPool({
      slots: nextSlots,
      cachedToolSchemas: state.cachedToolSchemas ?? existing.cachedToolSchemas,
      updatedAt: new Date().toISOString(),
    });
    return { pool: saved, slotIndex: sameIdx };
  }

  if (existing.slots.length >= maxSlots) {
    throw new ScysAuthError(`生财有术 MCP 连接池已达上限（最多 ${maxSlots} 个槽位），如需重置请运行 pnpm scys:auth`);
  }

  const nextSlots = [...existing.slots, state];
  const saved = saveScysAuthPool({
    slots: nextSlots,
    cachedToolSchemas: state.cachedToolSchemas ?? existing.cachedToolSchemas,
    updatedAt: new Date().toISOString(),
  });
  return { pool: saved, slotIndex: saved.slots.length - 1 };
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
    /* fall back to well-known paths */
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
  clientName = "scys-radar",
): Promise<{ clientId: string; clientSecret?: string }> {
  const res = await fetchFn(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: clientName,
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
  slotIndex?: number,
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
  if (persist) {
    const existing = loadScysAuthPool();
    if (existing) {
      let idx =
        typeof slotIndex === "number" && slotIndex >= 0 && slotIndex < existing.slots.length
          ? slotIndex
          : existing.slots.findIndex(
              (s) =>
                (Boolean(state.slotId) && s.slotId === state.slotId) ||
                s.accessToken === state.accessToken ||
                (Boolean(state.refreshToken) && s.refreshToken === state.refreshToken),
            );
      if (idx < 0 && existing.slots.length === 1) idx = 0;
      if (idx >= 0) {
        const nextSlots = [...existing.slots];
        nextSlots[idx] = updated;
        saveScysAuthPool({ ...existing, slots: nextSlots });
      }
    } else {
      saveScysAuth(updated);
    }
  }
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

function parseMcpToolRateLimit(msg: string): { waitMs: number; userScoped: boolean } | null {
  if (!/MCP_RATE_LIMITED|rate[_\s-]*limit/i.test(msg)) return null;
  const secMatch =
    /retryAfterSeconds\s*=\s*(\d+(?:\.\d+)?)/i.exec(msg) ?? /sleep\s+(\d+(?:\.\d+)?)\s*s/i.exec(msg);
  const secs = secMatch ? Number(secMatch[1]) : 1;
  const waitMs = Math.max(1000, Math.ceil((Number.isFinite(secs) && secs > 0 ? secs : 1) * 1000) + 150);
  return { waitMs, userScoped: /dimension\s*=\s*USER/i.test(msg) };
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export type ScysMcpClientOptions = {
  minIntervalMs?: number;
  maxConcurrencyPerSlot?: number;
  maxRetries?: number;
  fetchFn?: FetchLike;
  loadAuth?: () => ScysAuthState | null;
  saveAuth?: (state: ScysAuthState) => void;
  loadPool?: () => ScysAuthPool | null;
  savePool?: (pool: ScysAuthPool) => ScysAuthPool;
};

type SlotWorker = {
  index: number;
  state: ScysAuthState;
  sessionId: string | null;
  initialized: boolean;
  lastRequestAt: number;
  nextDispatchAt: number;
  cooldownUntil: number;
  reservedUntil: number;
  inFlight: number;
  activeCount: number;
  waitQueue: Array<() => void>;
  refreshInFlight: Promise<ScysAuthState> | null;
  initInFlight: Promise<void> | null;
};

export class ScysMcpClient {
  private readonly minIntervalMs: number;
  private readonly maxConcurrencyPerSlot: number;
  private readonly maxRetries: number;
  private readonly fetchFn: FetchLike;
  private readonly loadPoolFn: () => ScysAuthPool | null;
  private readonly savePoolFn: (pool: ScysAuthPool) => void;

  private pool: ScysAuthPool | null = null;
  private slotWorkers: SlotWorker[] = [];
  private readonly toolCooldownUntil = new Map<string, number>();
  private nextRpcId = 1;
  private rrCursor = 0;

  constructor(options: ScysMcpClientOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.maxConcurrencyPerSlot = Math.max(
      1,
      Math.min(12, Math.round(options.maxConcurrencyPerSlot ?? DEFAULT_MAX_CONCURRENCY_PER_SLOT)),
    );
    this.maxRetries = options.maxRetries ?? 3;
    this.fetchFn = options.fetchFn ?? fetch;

    if (options.loadPool) {
      this.loadPoolFn = options.loadPool;
    } else if (options.loadAuth) {
      const legacyLoad = options.loadAuth;
      this.loadPoolFn = () => {
        const s = legacyLoad();
        return s ? { slots: [s], cachedToolSchemas: s.cachedToolSchemas, updatedAt: s.updatedAt } : null;
      };
    } else {
      this.loadPoolFn = loadScysAuthPool;
    }

    if (options.savePool) {
      this.savePoolFn = options.savePool;
    } else if (options.saveAuth) {
      const legacySave = options.saveAuth;
      this.savePoolFn = (pool) => {
        if (pool.slots[0]) {
          legacySave({ ...pool.slots[0], cachedToolSchemas: pool.cachedToolSchemas });
        }
      };
    } else {
      this.savePoolFn = saveScysAuthPool;
    }
  }

  private ensurePoolLoaded(): ScysAuthPool {
    if (!this.pool || !this.slotWorkers.length) {
      const loaded = this.loadPoolFn();
      if (!loaded?.slots.length) {
        throw new ScysAuthError("未配置生财有术 MCP OAuth 登录态，请先运行 pnpm scys:auth 完成授权");
      }
      this.pool = loaded;
      this.slotWorkers = loaded.slots.map((state, index) => ({
        index,
        state,
        sessionId: null,
        initialized: false,
        lastRequestAt: 0,
        nextDispatchAt: 0,
        cooldownUntil: 0,
        reservedUntil: 0,
        inFlight: 0,
        activeCount: 0,
        waitQueue: [],
        refreshInFlight: null,
        initInFlight: null,
      }));
    }
    return this.pool;
  }

  getSlotCount(): number {
    if (this.slotWorkers.length) return this.slotWorkers.length;
    return this.loadPoolFn()?.slots.length ?? 0;
  }

  getMaxConcurrencyPerSlot(): number {
    return this.maxConcurrencyPerSlot;
  }

  getConcurrencyCapacity(): number {
    return Math.max(1, this.getSlotCount()) * this.maxConcurrencyPerSlot;
  }

  private isTokenExpiringSoon(state: ScysAuthState): boolean {
    if (!state.expiresAt) return false;
    const expMs = Date.parse(state.expiresAt);
    if (Number.isNaN(expMs)) return false;
    return expMs - Date.now() <= TOKEN_REFRESH_MARGIN_MS;
  }

  private persistPool(): void {
    if (!this.pool) return;
    this.pool = {
      slots: this.slotWorkers.map((w) => w.state),
      cachedToolSchemas: this.pool.cachedToolSchemas,
      updatedAt: new Date().toISOString(),
    };
    this.savePoolFn(this.pool);
  }

  private async ensureValidToken(worker: SlotWorker, forceRefresh = false): Promise<ScysAuthState> {
    if (!forceRefresh && !this.isTokenExpiringSoon(worker.state)) {
      return worker.state;
    }
    if (!worker.refreshInFlight) {
      worker.refreshInFlight = (async () => {
        try {
          const refreshed = await refreshScysAccessToken(worker.state, this.fetchFn, false);
          worker.state = refreshed;
          this.persistPool();
          return refreshed;
        } finally {
          worker.refreshInFlight = null;
        }
      })();
    }
    return worker.refreshInFlight;
  }

  private async acquirePermit(worker: SlotWorker): Promise<void> {
    if (worker.activeCount < this.maxConcurrencyPerSlot) {
      worker.activeCount += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      worker.waitQueue.push(resolve);
    });
  }

  private releasePermit(worker: SlotWorker): void {
    const next = worker.waitQueue.shift();
    if (next) {
      next();
    } else {
      worker.activeCount = Math.max(0, worker.activeCount - 1);
    }
  }

  private async runPacedOnSlot<T>(worker: SlotWorker, fn: () => Promise<T>, toolName?: string): Promise<T> {
    await this.acquirePermit(worker);
    try {
      while (true) {
        const now = Date.now();
        const toolCd = toolName ? (this.toolCooldownUntil.get(toolName) ?? 0) : 0;
        const effectiveCooldown = Math.max(worker.cooldownUntil, toolCd);
        const scheduledAt = Math.max(
          now,
          effectiveCooldown,
          worker.nextDispatchAt,
          worker.lastRequestAt + this.minIntervalMs,
        );
        worker.nextDispatchAt = scheduledAt + this.minIntervalMs;
        if (scheduledAt > now) {
          await sleep(scheduledAt - now);
        }
        const wakeCd = Math.max(worker.cooldownUntil, toolName ? (this.toolCooldownUntil.get(toolName) ?? 0) : 0);
        if (Date.now() < wakeCd) {
          continue;
        }
        worker.lastRequestAt = Date.now();
        return await fn();
      }
    } finally {
      this.releasePermit(worker);
    }
  }

  private acquireSlot(): SlotWorker {
    this.ensurePoolLoaded();
    const now = Date.now();
    const n = this.slotWorkers.length;
    let best = this.slotWorkers[this.rrCursor % n]!;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let offset = 0; offset < n; offset += 1) {
      const idx = (this.rrCursor + offset) % n;
      const w = this.slotWorkers[idx]!;
      const readyAt =
        w.inFlight > 0
          ? Math.max(now, w.reservedUntil, w.nextDispatchAt)
          : Math.max(now, w.nextDispatchAt, w.lastRequestAt + this.minIntervalMs);
      if (readyAt < bestScore || (readyAt === bestScore && w.inFlight < best.inFlight)) {
        best = w;
        bestScore = readyAt;
      }
    }

    this.rrCursor = (best.index + 1) % n;
    best.inFlight += 1;
    best.reservedUntil =
      Math.max(now, best.reservedUntil, best.nextDispatchAt, best.lastRequestAt + this.minIntervalMs) +
      this.minIntervalMs;
    return best;
  }

  private isSessionInvalidResponse(status: number, body: string): boolean {
    if (status === 404) return true;
    const sessionErrRe =
      /(?:invalid|expired|unknown|terminated|missing)[\s_-]*session|session[\s_-]*(?:not\s+found|expired|invalid|terminated|unknown)/i;
    if (status === 400 && /session/i.test(body)) return true;
    return sessionErrRe.test(body);
  }

  private async postJsonRpcOnSlot(
    worker: SlotWorker,
    method: string,
    params?: Record<string, unknown>,
    isNotification = false,
    allowSessionRetry = true,
  ): Promise<unknown> {
    let authRefreshedFor401 = false;

    const toolName = method === "tools/call" && typeof params?.name === "string" ? params.name : undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const auth = await this.ensureValidToken(worker, false);
      const id = isNotification ? undefined : this.nextRpcId++;
      const payload = isNotification
        ? { jsonrpc: "2.0", method, ...(params ? { params } : {}) }
        : { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
      const sentSessionId = worker.sessionId;

      const res = await this.runPacedOnSlot(
        worker,
        async () => {
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
        },
        toolName,
      );

      const returnedSessionId = res.headers.get("mcp-session-id");
      if (returnedSessionId) {
        worker.sessionId = returnedSessionId;
      }

      if (res.status === 401 && !authRefreshedFor401) {
        authRefreshedFor401 = true;
        await this.ensureValidToken(worker, true);
        continue;
      }
      if (res.status === 401) {
        throw new ScysAuthError("生财有术 MCP 认证失败 (HTTP 401)，请运行 pnpm scys:auth 重新授权");
      }
      if (res.status === 429 && attempt < this.maxRetries) {
        const waitMs = parseRetryAfterMs(res.headers.get("retry-after"), Math.max(this.minIntervalMs, 5000));
        const until = Date.now() + waitMs;
        worker.cooldownUntil = Math.max(worker.cooldownUntil, until);
        worker.nextDispatchAt = Math.max(worker.nextDispatchAt, until);
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
        worker.sessionId = null;
        worker.initialized = false;
        await this.initializeSlot(worker);
        return this.postJsonRpcOnSlot(worker, method, params, isNotification, false);
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
          worker.sessionId = null;
          worker.initialized = false;
          await this.initializeSlot(worker);
          return this.postJsonRpcOnSlot(worker, method, params, isNotification, false);
        }
        throw new Error(`scys-mcp RPC 错误 (${method}, code=${rpc.error.code ?? "?"}): ${rpc.error.message ?? "unknown"}`);
      }
      return rpc.result;
    }

    throw new Error(`scys-mcp 请求重试耗尽 (${method})`);
  }

  private async initializeSlot(worker: SlotWorker): Promise<void> {
    if (worker.initialized) return;
    if (!worker.initInFlight) {
      worker.initInFlight = (async () => {
        try {
          if (worker.initialized) return;
          await this.postJsonRpcOnSlot(
            worker,
            "initialize",
            {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "scys-radar", version: "1.0.0" },
            },
            false,
            false,
          );
          await this.postJsonRpcOnSlot(worker, "notifications/initialized", undefined, true, false).catch(() => {
            /* stateless servers may omit handling notifications */
          });
          worker.initialized = true;
        } finally {
          worker.initInFlight = null;
        }
      })();
    }
    return worker.initInFlight;
  }

  async initialize(): Promise<void> {
    this.ensurePoolLoaded();
    await this.initializeSlot(this.slotWorkers[0]!);
  }

  async listTools(options: { forceRefresh?: boolean } = {}): Promise<McpToolSchema[]> {
    const pool = this.ensurePoolLoaded();
    if (!options.forceRefresh && pool.cachedToolSchemas?.length) {
      return pool.cachedToolSchemas;
    }
    const worker = this.acquireSlot();
    try {
      await this.initializeSlot(worker);

      const tools: McpToolSchema[] = [];
      let cursor: string | undefined;
      do {
        const result = (await this.postJsonRpcOnSlot(worker, "tools/list", cursor ? { cursor } : {})) as {
          tools?: McpToolSchema[];
          nextCursor?: string;
        };
        if (Array.isArray(result?.tools)) {
          tools.push(...result.tools);
        }
        cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      } while (cursor);

      this.pool = {
        ...this.pool!,
        cachedToolSchemas: tools,
        updatedAt: new Date().toISOString(),
      };
      this.persistPool();
      return tools;
    } finally {
      worker.inFlight = Math.max(0, worker.inFlight - 1);
    }
  }

  async getToolSchemas(): Promise<McpToolSchema[]> {
    return this.listTools({ forceRefresh: false });
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!isReadOnlyScysTool(name)) {
      throw new ScysToolBlockedError(name);
    }
    const worker = this.acquireSlot();
    try {
      await this.initializeSlot(worker);
      for (let rlAttempt = 0; rlAttempt <= this.maxRetries; rlAttempt += 1) {
        const result = (await this.postJsonRpcOnSlot(worker, "tools/call", { name, arguments: args })) as {
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
          const rl = parseMcpToolRateLimit(msg);
          if (rl && rlAttempt < this.maxRetries) {
            const until = Date.now() + rl.waitMs;
            worker.cooldownUntil = Math.max(worker.cooldownUntil, until);
            worker.nextDispatchAt = Math.max(worker.nextDispatchAt, until);
            if (rl.userScoped) {
              this.toolCooldownUntil.set(name, Math.max(this.toolCooldownUntil.get(name) ?? 0, until));
              for (const w of this.slotWorkers) {
                w.nextDispatchAt = Math.max(w.nextDispatchAt, until);
              }
            }
            await sleep(rl.waitMs);
            continue;
          }
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
      throw new Error(`scys-mcp 工具 ${name} 触发限流且重试耗尽`);
    } finally {
      worker.inFlight = Math.max(0, worker.inFlight - 1);
    }
  }
}

export type ToolIntent = {
  keyword?: string;
  tag?: string;
  pageSize?: number;
  commentPageSize?: number;
  page?: number;
  cursor?: string | null;
  topicId?: string;
  entityType?: string;
  entityId?: string;
  activityId?: string;
  courseId?: string;
  pageScene?: string;
  displayMode?: number;
  orderBy?: string;
  gmtCreateStart?: number;
  gmtCreateEnd?: number;
  sortType?: string | number;
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
 * strictly respecting schema properties (`additionalProperties: false`) while keeping overrides intact.
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
    if (key) {
      out[key] = toolName === "searchProjectCases" ? intent.keyword.slice(0, 30) : intent.keyword;
    }
  }

  if (intent.tag) {
    const key = hasProps ? pickProp(props, ["tag", "tags", "category", "channel", "section"]) : null;
    if (key) {
      const propType = props[key]?.type;
      out[key] = propType === "array" ? [intent.tag] : intent.tag;
    }
  }

  const effectivePageSize = intent.commentPageSize ?? intent.pageSize;
  if (effectivePageSize !== undefined) {
    let bounded = Math.max(1, effectivePageSize);
    if (toolName === "searchTopic") bounded = Math.min(10, bounded);
    if (toolName === "pageTopicComment") bounded = Math.min(50, bounded);
    if (toolName === "contentSearch" && !props.displayMode) bounded = Math.min(5, bounded);
    const defaultSizeKey = toolName === "pageTopicComment" ? "commentPageSize" : "pageSize";
    const key = hasProps
      ? pickProp(props, ["commentPageSize", "pageSize", "limit", "size", "count", "perPage", "num"])
      : defaultSizeKey;
    if (key) out[key] = bounded;
  }

  if (intent.cursor) {
    const key = hasProps ? pickProp(props, ["cursor", "nextCursor", "pageToken"]) : null;
    if (key) out[key] = intent.cursor;
  } else if (intent.page !== undefined) {
    const key = hasProps ? pickProp(props, ["pageIndex", "page", "pageNo", "pageNum", "offset"]) : "pageIndex";
    if (key) out[key] = intent.page;
  }

  if (toolName === "topicDetail" || toolName === "pageTopicComment") {
    if (!hasProps || (props.entityType && props.entityId)) {
      out.entityType = intent.entityType || "xq_topic";
      if (intent.entityId || intent.topicId) {
        out.entityId = String(intent.entityId || intent.topicId);
      }
    } else if (intent.entityId || intent.topicId) {
      const key = pickProp(props, ["entityId", "topicId", "topic_id", "id", "postId"]);
      if (key) out[key] = String(intent.entityId || intent.topicId);
    }
  } else if (toolName === "projectLibDetail" && (intent.entityId || intent.topicId)) {
    const key = hasProps ? pickProp(props, ["projectId", "project_id", "id", "caseId"]) : "projectId";
    if (key) out[key] = String(intent.entityId || intent.topicId);
  } else if (toolName === "activityManualDetail" && (intent.entityId || intent.topicId)) {
    const key = hasProps ? pickProp(props, ["itemId", "manualId", "manual_id", "docId", "articleId", "id"]) : "itemId";
    if (key) out[key] = String(intent.entityId || intent.topicId);
    if (intent.activityId && (!hasProps || props.activityId)) out.activityId = String(intent.activityId);
    else if (intent.courseId && (!hasProps || props.courseId)) out.courseId = String(intent.courseId);
  } else if (intent.topicId) {
    const key = hasProps ? pickProp(props, ["topicId", "entityId", "id"]) : "topicId";
    if (key) out[key] = intent.topicId;
  }

  if (toolName === "activityManualToc") {
    if (intent.activityId && (!hasProps || props.activityId)) out.activityId = String(intent.activityId);
    else if (intent.courseId && (!hasProps || props.courseId)) out.courseId = String(intent.courseId);
  }

  if (intent.pageScene && (!hasProps || props.pageScene)) {
    out.pageScene = intent.pageScene;
  }
  if (intent.displayMode !== undefined && (!hasProps || props.displayMode)) {
    out.displayMode = intent.displayMode;
  } else if (intent.compact && (!hasProps || props.displayMode)) {
    if (props.displayMode) out.displayMode = 2;
  }
  if (intent.orderBy && (!hasProps || props.orderBy)) {
    out.orderBy = intent.orderBy;
  }
  if (intent.gmtCreateStart !== undefined && (!hasProps || props.gmtCreateStart)) {
    out.gmtCreateStart = intent.gmtCreateStart;
  }
  if (intent.gmtCreateEnd !== undefined && (!hasProps || props.gmtCreateEnd)) {
    out.gmtCreateEnd = intent.gmtCreateEnd;
  }
  if (intent.sortType !== undefined && (!hasProps || props.sortType)) {
    out.sortType = intent.sortType;
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
      const boolEssence = pickProp(props, ["isDigested", "isEssence", "essence", "onlyEssence", "digest", "highlight", "isHighlight", "essenceOnly"]);
      if (boolEssence && isHighlights && props[boolEssence]?.type === "boolean") {
        out[boolEssence] = true;
      }
      const sortKey = pickProp(props, ["orderBy", "sort", "sortBy", "tab", "type", "filter", "mode"]);
      if (sortKey && out[sortKey] === undefined) {
        const preferred = isHighlights
          ? ["gmt_digested", "highlight", "essence", "digest", "hot", "featured", "recommended"]
          : ["gmt_create", "latest", "new", "newest", "recent", "time"];
        const matched = pickEnumValue(props[sortKey], preferred);
        if (matched) out[sortKey] = matched;
      }
    }
  }

  if (overrides && typeof overrides === "object") {
    Object.assign(out, overrides);
  }
  return out;
}
