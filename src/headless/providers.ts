import {
  describeProviderAuthState,
  getAuthProvider,
  getProviderAuthState,
  listProviderAuthStatuses,
} from "../core/auth/index.js";
import { checkProviders } from "../core/llm/provider.js";
import { getAllProviders } from "../core/llm/providers/index.js";
import { setSecret } from "../core/secrets.js";
import { BOLD, DIM, EXIT_ERROR, GREEN, PURPLE, RED, RST } from "./constants.js";

export async function listProviders(): Promise<void> {
  const statuses = await checkProviders();
  const providers = getAllProviders();
  const customIds = new Set(providers.filter((p) => p.custom).map((p) => p.id));
  const authStates = await listProviderAuthStatuses();
  const authStateById = new Map(authStates.map((entry) => [entry.provider.id, entry.state]));

  for (const s of statuses) {
    const tag = customIds.has(s.id) ? ` ${DIM}[custom]${RST}` : "";
    const authState = authStateById.get(s.id);
    const detail = authState
      ? describeProviderAuthState(authState)
      : s.available
        ? "api key"
        : "not configured";
    const mark = s.available ? `${GREEN()}ready${RST}` : `${DIM}${detail}${RST}`;
    const env = s.envVar ? `  ${DIM}(${s.envVar})${RST}` : "";
    process.stdout.write(
      `${s.available ? GREEN() : DIM}${s.id.padEnd(18)}${RST} ${mark}${env}${tag}${detail && s.available ? ` ${DIM}[${detail}]${RST}` : ""}\n`,
    );
  }
}

export async function listModels(providerId?: string): Promise<void> {
  const providers = getAllProviders();
  const targets = providerId ? providers.filter((p) => p.id === providerId) : providers;

  if (targets.length === 0) {
    process.stderr.write(`${RED()}Error:${RST} Unknown provider "${providerId ?? ""}"\n`);
    process.stderr.write(`Available: ${providers.map((p) => p.id).join(", ")}\n`);
    process.exit(EXIT_ERROR);
  }

  for (const provider of targets) {
    const authState = await getProviderAuthState(provider);
    if (!authState.available && !providerId) continue;

    const tag = provider.custom ? ` ${DIM}[custom]${RST}` : "";
    process.stdout.write(
      `${BOLD}${PURPLE()}${provider.name}${RST} ${DIM}(${provider.id})${RST}${tag}\n`,
    );

    let models = await provider.fetchModels().catch((err: unknown) => {
      process.stderr.write(
        `${DIM}  (model fetch failed: ${err instanceof Error ? err.message : String(err)} — showing cached models)${RST}\n`,
      );
      return null;
    });
    if (!models) models = provider.fallbackModels;

    for (const m of models) {
      const ctx = m.contextWindow
        ? `  ${DIM}${String(Math.round(m.contextWindow / 1000))}k ctx${RST}`
        : "";
      process.stdout.write(`  ${provider.id}/${m.id}${ctx}\n`);
    }
    process.stdout.write("\n");
  }
}

export function setKey(providerId: string, key: string): void {
  const provider = getAllProviders().find((p) => p.id === providerId);
  if (!provider) {
    const allIds = getAllProviders().map((p) => p.id);
    process.stderr.write(`${RED()}Error:${RST} Unknown provider "${providerId}"\n`);
    process.stderr.write(`Available: ${allIds.join(", ")}\n`);
    process.exit(EXIT_ERROR);
  }

  const secretId = provider.secretKey ?? provider.envVar;
  if (!secretId) {
    process.stderr.write(`${RED()}Error:${RST} Provider "${providerId}" does not use an API key\n`);
    process.exit(EXIT_ERROR);
  }

  const result = setSecret(secretId, key);
  if (result.success) {
    const where = result.storage === "keychain" ? "system keychain" : "~/.soulforge/secrets.json";
    process.stdout.write(`${GREEN()}Saved${RST} ${providerId} key to ${where}\n`);
  } else {
    process.stderr.write(`${RED()}Error:${RST} Failed to save key\n`);
    process.exit(EXIT_ERROR);
  }
}

export async function authStatus(providerId?: string): Promise<void> {
  const statuses = await listProviderAuthStatuses();
  const filtered = providerId
    ? statuses.filter((entry) => entry.provider.id === providerId && entry.provider.auth)
    : statuses.filter((entry) => entry.provider.auth);
  if (filtered.length === 0) {
    process.stderr.write(`${RED()}Error:${RST} Unknown provider "${providerId ?? ""}"\n`);
    process.exit(EXIT_ERROR);
  }
  for (const { provider, state } of filtered) {
    process.stdout.write(`${BOLD}${provider.name}${RST} ${DIM}(${provider.id})${RST}\n`);
    process.stdout.write(`  status: ${describeProviderAuthState(state)}\n`);
    if (state.expiresAt)
      process.stdout.write(`  expires: ${new Date(state.expiresAt).toISOString()}\n`);
    process.stdout.write(
      `  methods: ${
        provider.auth
          ?.listMethods()
          .map((method) => method.label)
          .join(", ") ?? ""
      }\n\n`,
    );
  }
}

export async function authLogin(providerId: string, device: boolean): Promise<void> {
  const provider = getAuthProvider(providerId);
  if (!provider?.auth) {
    process.stderr.write(`${RED()}Error:${RST} Unknown auth provider "${providerId}"\n`);
    process.exit(EXIT_ERROR);
  }
  await provider.auth.login(device ? "oauth-device" : "oauth-browser", {
    log: (line) => process.stdout.write(`${line}\n`),
  });
  process.stdout.write(`${GREEN()}Authenticated${RST} ${provider.name}\n`);
}

export async function authLogout(providerId: string): Promise<void> {
  const provider = getAuthProvider(providerId);
  if (!provider?.auth) {
    process.stderr.write(`${RED()}Error:${RST} Unknown auth provider "${providerId}"\n`);
    process.exit(EXIT_ERROR);
  }
  const state = await provider.auth.getState();
  if (!state.configured.includes("oauth")) {
    process.stdout.write(`${DIM}No OAuth session for ${provider.name}${RST}\n`);
    return;
  }
  await provider.auth.logout();
  process.stdout.write(`${GREEN()}Removed${RST} ${provider.name} OAuth session\n`);
}
