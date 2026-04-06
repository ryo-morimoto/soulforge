import { getAllProviders, getProvider } from "../llm/providers/index.js";
import type { ProviderDefinition } from "../llm/providers/types.js";
import { getProviderApiKey } from "../secrets.js";
import type { ProviderAuthState } from "./types.js";

export interface ProviderAuthStatus {
  provider: ProviderDefinition;
  state: ProviderAuthState;
}

function defaultState(provider: ProviderDefinition): ProviderAuthState {
  if (provider.envVar === "") {
    return { active: "none", available: true, configured: [] };
  }
  const hasApiKey = Boolean(getProviderApiKey(provider.envVar));
  return {
    active: hasApiKey ? "apiKey" : "none",
    available: hasApiKey,
    configured: hasApiKey ? ["apiKey"] : [],
  };
}

export async function getProviderAuthState(
  provider: ProviderDefinition,
): Promise<ProviderAuthState> {
  if (provider.auth) return provider.auth.getState();
  return defaultState(provider);
}

export async function listProviderAuthStatuses(): Promise<ProviderAuthStatus[]> {
  const providers = getAllProviders();
  return Promise.all(
    providers.map(async (provider) => ({ provider, state: await getProviderAuthState(provider) })),
  );
}

export function getAuthEnabledProviders(): ProviderDefinition[] {
  return getAllProviders().filter((provider) => provider.auth);
}

export function getAuthProvider(providerId: string): ProviderDefinition | undefined {
  const provider = getProvider(providerId);
  return provider?.auth ? provider : undefined;
}

export function describeProviderAuthState(state: ProviderAuthState): string {
  if (state.active === "oauth") {
    const suffix = state.accountLabel ? ` (${state.accountLabel})` : "";
    return `oauth${suffix}`;
  }
  if (state.active === "apiKey") return "api key";
  if (state.active === "externalToken") return "external token";
  if (state.configured.length === 0) return "not configured";
  return state.configured.join(", ");
}
