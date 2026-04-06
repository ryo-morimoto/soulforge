import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { getProviderApiKey } from "../secrets.js";
import { clearJsonSecret, getJsonSecret, setJsonSecret } from "./store.js";
import type { ProviderAuthAdapter, ProviderAuthLoginOptions, ProviderAuthState } from "./types.js";

const OPENAI_OAUTH_SECRET = "openai-oauth-session";
const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_OAUTH_ISSUER = "https://auth.openai.com";
const OPENAI_CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_OAUTH_PORT = 1455;
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000;

export const OPENAI_OAUTH_DUMMY_KEY = "openai-oauth";

export interface OpenAIOAuthSession {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

interface OpenAITokenResponse {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

interface OpenAIJwtClaims {
  chatgpt_account_id?: string;
  email?: string;
  organizations?: Array<{ id: string }>;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
}

interface PkceCodes {
  verifier: string;
  challenge: string;
}

interface PendingOAuth {
  pkce: PkceCodes;
  state: string;
  resolve: (tokens: OpenAITokenResponse) => void;
  reject: (error: Error) => void;
}

let oauthServer: ReturnType<typeof Bun.serve> | undefined;
let pendingOAuth: PendingOAuth | undefined;

const OPENAI_OAUTH_MODELS = [
  { id: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
  { id: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max" },
  { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
  { id: "gpt-5.2", name: "GPT-5.2" },
  { id: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
  { id: "gpt-5.4", name: "GPT-5.4" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
];

function log(options: ProviderAuthLoginOptions | undefined, line: string): void {
  options?.log?.(line);
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("");
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(hash) };
}

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

function parseJwtClaims(token: string): OpenAIJwtClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(
      Buffer.from(parts[1] ?? "", "base64url").toString("utf-8"),
    ) as OpenAIJwtClaims;
  } catch {
    return undefined;
  }
}

function extractAccountIdFromClaims(claims: OpenAIJwtClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  );
}

function extractAccountId(tokens: OpenAITokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token);
    const accountId = claims && extractAccountIdFromClaims(claims);
    if (accountId) return accountId;
  }
  const accessClaims = parseJwtClaims(tokens.access_token);
  return accessClaims ? extractAccountIdFromClaims(accessClaims) : undefined;
}

function toSession(tokens: OpenAITokenResponse): OpenAIOAuthSession {
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(tokens),
  };
}

function getRedirectUri(): string {
  return `http://localhost:${String(OPENAI_OAUTH_PORT)}/auth/callback`;
}

function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "soulforge",
  });
  return `${OPENAI_OAUTH_ISSUER}/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  pkce: PkceCodes,
): Promise<OpenAITokenResponse> {
  const response = await fetch(`${OPENAI_OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: OPENAI_OAUTH_CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  });
  if (!response.ok) throw new Error(`OpenAI token exchange failed (${String(response.status)})`);
  return (await response.json()) as OpenAITokenResponse;
}

export async function refreshOpenAIOAuthSession(
  session: OpenAIOAuthSession,
): Promise<OpenAIOAuthSession> {
  const response = await fetch(`${OPENAI_OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refresh,
      client_id: OPENAI_OAUTH_CLIENT_ID,
    }).toString(),
  });
  if (!response.ok) throw new Error(`OpenAI token refresh failed (${String(response.status)})`);
  const tokens = (await response.json()) as OpenAITokenResponse;
  const refreshed = {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(tokens) || session.accountId,
  } satisfies OpenAIOAuthSession;
  setJsonSecret(OPENAI_OAUTH_SECRET, refreshed);
  return refreshed;
}

export function getOpenAIOAuthSession(): OpenAIOAuthSession | null {
  const session = getJsonSecret<OpenAIOAuthSession>(OPENAI_OAUTH_SECRET);
  if (!session?.access || !session.refresh || !session.expires) return null;
  return session;
}

export function getOpenAIOAuthModels() {
  return OPENAI_OAUTH_MODELS;
}

export function getOpenAICodexEndpoint(): string {
  return OPENAI_CODEX_ENDPOINT;
}

async function ensureOAuthServer(): Promise<string> {
  if (!oauthServer) {
    oauthServer = Bun.serve({
      port: OPENAI_OAUTH_PORT,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/auth/callback") return new Response("Not found", { status: 404 });

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        const errorDescription = url.searchParams.get("error_description") ?? error;

        if (errorDescription) {
          pendingOAuth?.reject(new Error(errorDescription));
          pendingOAuth = undefined;
          return new Response("Authentication failed. You can close this window.", { status: 400 });
        }
        if (!code) {
          pendingOAuth?.reject(new Error("Missing authorization code"));
          pendingOAuth = undefined;
          return new Response("Missing authorization code. You can close this window.", {
            status: 400,
          });
        }
        if (!pendingOAuth || state !== pendingOAuth.state) {
          pendingOAuth?.reject(new Error("Invalid OAuth state"));
          pendingOAuth = undefined;
          return new Response("Invalid OAuth state. You can close this window.", { status: 400 });
        }

        const current = pendingOAuth;
        pendingOAuth = undefined;
        exchangeCodeForTokens(code, getRedirectUri(), current.pkce)
          .then((tokens) => current.resolve(tokens))
          .catch((err: unknown) =>
            current.reject(err instanceof Error ? err : new Error(String(err))),
          );

        return new Response("Authentication complete. You can close this window.", {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      },
    });
  }
  return getRedirectUri();
}

function waitForOAuthCallback(pkce: PkceCodes, state: string): Promise<OpenAITokenResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        if (!pendingOAuth) return;
        pendingOAuth = undefined;
        reject(new Error("OpenAI OAuth callback timed out"));
      },
      5 * 60 * 1000,
    );

    pendingOAuth = {
      pkce,
      state,
      resolve: (tokens) => {
        clearTimeout(timeout);
        resolve(tokens);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    };
  });
}

async function openUrlFallback(url: string): Promise<void> {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, [url], { stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => resolve());
  });
}

async function loginWithBrowser(options?: ProviderAuthLoginOptions): Promise<void> {
  const redirectUri = await ensureOAuthServer();
  const pkce = await generatePKCE();
  const state = generateState();
  const url = buildAuthorizeUrl(redirectUri, pkce, state);
  log(options, `Open this URL if the browser does not open automatically:`);
  log(options, url);
  try {
    await (options?.openUrl ? options.openUrl(url) : openUrlFallback(url));
    log(options, "Browser opened for ChatGPT login.");
  } catch {
    log(options, "Unable to open a browser automatically.");
  }
  const tokens = await waitForOAuthCallback(pkce, state);
  setJsonSecret(OPENAI_OAUTH_SECRET, toSession(tokens));
}

async function loginWithDeviceCode(options?: ProviderAuthLoginOptions): Promise<void> {
  const deviceResponse = await fetch(`${OPENAI_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "soulforge",
    },
    body: JSON.stringify({ client_id: OPENAI_OAUTH_CLIENT_ID }),
  });
  if (!deviceResponse.ok) {
    throw new Error(`OpenAI device auth setup failed (${String(deviceResponse.status)})`);
  }

  const deviceData = (await deviceResponse.json()) as {
    device_auth_id: string;
    user_code: string;
    interval: string;
    expires_in?: number;
  };

  log(options, `Open ${OPENAI_OAUTH_ISSUER}/codex/device and enter code:`);
  log(options, deviceData.user_code);
  const interval = Math.max(Number.parseInt(deviceData.interval, 10) || 5, 1) * 1000;
  const expiresAt = Date.now() + (deviceData.expires_in ?? 15 * 60) * 1000;

  while (true) {
    if (Date.now() >= expiresAt) {
      throw new Error("OpenAI device auth timed out before completion");
    }
    const response = await fetch(`${OPENAI_OAUTH_ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "soulforge",
      },
      body: JSON.stringify({
        device_auth_id: deviceData.device_auth_id,
        user_code: deviceData.user_code,
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as {
        authorization_code: string;
        code_verifier: string;
      };
      const tokenResponse = await fetch(`${OPENAI_OAUTH_ISSUER}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: data.authorization_code,
          redirect_uri: `${OPENAI_OAUTH_ISSUER}/deviceauth/callback`,
          client_id: OPENAI_OAUTH_CLIENT_ID,
          code_verifier: data.code_verifier,
        }).toString(),
      });
      if (!tokenResponse.ok) {
        throw new Error(`OpenAI device token exchange failed (${String(tokenResponse.status)})`);
      }
      const tokens = (await tokenResponse.json()) as OpenAITokenResponse;
      setJsonSecret(OPENAI_OAUTH_SECRET, toSession(tokens));
      return;
    }

    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`OpenAI device auth failed (${String(response.status)})`);
    }
    await sleep(interval + OAUTH_POLLING_SAFETY_MARGIN_MS);
  }
}

async function getState(): Promise<ProviderAuthState> {
  const session = getOpenAIOAuthSession();
  const hasApiKey = Boolean(getProviderApiKey("OPENAI_API_KEY"));
  const configured: ProviderAuthState["configured"] = [];
  if (session) configured.push("oauth");
  if (hasApiKey) configured.push("apiKey");

  if (session) {
    return {
      active: "oauth",
      available: true,
      configured,
      expiresAt: session.expires,
      accountLabel: session.accountId,
    };
  }

  return {
    active: hasApiKey ? "apiKey" : "none",
    available: hasApiKey,
    configured,
  };
}

export const openaiAuth: ProviderAuthAdapter = {
  listMethods() {
    return [
      { type: "oauth-browser", label: "ChatGPT Login", description: "Open browser OAuth flow" },
      { type: "oauth-device", label: "Device Code", description: "Headless OAuth flow" },
      { type: "apiKey", label: "API Key", description: "Managed via /keys" },
    ];
  },
  getState,
  async checkAvailability() {
    return (await getState()).available;
  },
  async login(method, options) {
    if (method === "apiKey") {
      throw new Error("API keys are managed via /keys or --set-key");
    }
    if (method === "oauth-browser") {
      await loginWithBrowser(options);
      return;
    }
    if (method === "oauth-device") {
      await loginWithDeviceCode(options);
      return;
    }
    throw new Error(`Unknown auth method: ${method}`);
  },
  async logout() {
    clearJsonSecret(OPENAI_OAUTH_SECRET);
  },
};
