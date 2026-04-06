import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel } from "ai";
import {
  getOpenAICodexEndpoint,
  getOpenAIOAuthModels,
  getOpenAIOAuthSession,
  OPENAI_OAUTH_DUMMY_KEY,
  openaiAuth,
  refreshOpenAIOAuthSession,
} from "../../auth/openai.js";
import { getProviderApiKey } from "../../secrets.js";
import type { ProviderDefinition, ProviderModelInfo } from "./types.js";

interface OpenAIModel {
  id: string;
  context_window?: number;
}

const OPENAI_PREFIXES = ["gpt-4", "gpt-5", "gpt-3.5", "o1", "o3", "o4", "chatgpt"];

function withOpenAIOAuthFetch() {
  return (async (requestInput: string | URL | Request, init?: RequestInit) => {
    const applySession = async (allowRefresh: boolean) => {
      let session = getOpenAIOAuthSession();
      if (!session) throw new Error("OpenAI OAuth session is not configured");
      if (allowRefresh && session.expires <= Date.now()) {
        session = await refreshOpenAIOAuthSession(session);
      }

      const headers = new Headers(
        requestInput instanceof Request ? requestInput.headers : undefined,
      );
      if (init?.headers) {
        new Headers(init.headers).forEach((value, key) => {
          headers.set(key, value);
        });
      }
      headers.delete("authorization");
      headers.delete("Authorization");
      headers.set("authorization", `Bearer ${session.access}`);
      if (session.accountId) headers.set("ChatGPT-Account-Id", session.accountId);

      const parsed =
        requestInput instanceof URL
          ? requestInput
          : new URL(typeof requestInput === "string" ? requestInput : requestInput.url);
      const url =
        parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions")
          ? new URL(getOpenAICodexEndpoint())
          : parsed;

      if (requestInput instanceof Request) {
        const original = requestInput.clone();
        const requestInit: RequestInit & { duplex?: "half" } = {
          method: init?.method ?? original.method,
          headers,
          signal: init?.signal ?? original.signal,
          redirect: init?.redirect ?? original.redirect,
          referrer: init?.referrer ?? original.referrer,
          referrerPolicy: init?.referrerPolicy ?? original.referrerPolicy,
          cache: init?.cache ?? original.cache,
          credentials: init?.credentials ?? original.credentials,
          integrity: init?.integrity ?? original.integrity,
          keepalive: init?.keepalive ?? original.keepalive,
          mode: init?.mode ?? original.mode,
        };

        if (init?.body !== undefined) {
          requestInit.body = init.body;
        } else if (original.method !== "GET" && original.method !== "HEAD") {
          requestInit.body = original.body;
          if (original.body) requestInit.duplex = "half";
        }

        return fetch(new Request(url.toString(), requestInit));
      }

      return fetch(url, { ...init, headers });
    };

    const response = await applySession(true);
    if (response.status !== 401) return response;
    const session = getOpenAIOAuthSession();
    if (!session) return response;
    await refreshOpenAIOAuthSession(session);
    return applySession(false);
  }) as typeof fetch;
}

function withOpenAIOAuthInstructions(model: ReturnType<ReturnType<typeof createOpenAI>>) {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      transformParams: async ({ params }) => {
        const systemMessages = params.prompt.filter((message) => message.role === "system");
        if (systemMessages.length === 0) return params;

        const instructions = systemMessages
          .map((message) => message.content)
          .join("\n\n")
          .trim();
        return {
          ...params,
          prompt: params.prompt.filter((message) => message.role !== "system"),
          providerOptions: {
            ...params.providerOptions,
            openai: {
              ...((params.providerOptions?.openai as Record<string, unknown> | undefined) ?? {}),
              instructions,
              store: false,
            },
          },
        };
      },
    },
  });
}

export const openai: ProviderDefinition = {
  id: "openai",
  name: "OpenAI",
  envVar: "OPENAI_API_KEY",
  icon: "󰧑", // nf-md-head_snowflake U+F09D1
  secretKey: "openai-api-key",
  keyUrl: "platform.openai.com",
  asciiIcon: "O",
  description: "GPT & o-series",
  auth: openaiAuth,

  createModel(modelId: string) {
    if (getOpenAIOAuthSession()) {
      const model = createOpenAI({ apiKey: OPENAI_OAUTH_DUMMY_KEY, fetch: withOpenAIOAuthFetch() })(
        modelId,
      );
      return withOpenAIOAuthInstructions(model);
    }
    const apiKey = getProviderApiKey("OPENAI_API_KEY");
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not set");
    }
    return createOpenAI({ apiKey })(modelId);
  },

  async fetchModels(): Promise<ProviderModelInfo[] | null> {
    if (getOpenAIOAuthSession()) return getOpenAIOAuthModels();
    const apiKey = getProviderApiKey("OPENAI_API_KEY");
    if (!apiKey) return null;
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`OpenAI API ${String(res.status)}`);
    const data = (await res.json()) as { data: OpenAIModel[] };
    const result: ProviderModelInfo[] = [];
    for (const m of data.data) {
      if (OPENAI_PREFIXES.some((p) => m.id.startsWith(p))) {
        result.push({ id: m.id, name: m.id });
      }
    }
    return result;
  },

  fallbackModels: [
    { id: "gpt-5", name: "GPT-5" },
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "gpt-4o-mini", name: "GPT-4o Mini" },
    { id: "o4-mini", name: "o4 Mini" },
    { id: "o3-mini", name: "o3 Mini" },
  ],

  contextWindows: [
    ["gpt-5", 400_000],
    ["gpt-4.1", 1_048_576],
    ["gpt-4o-mini", 128_000],
    ["gpt-4o", 128_000],
    ["gpt-4-turbo", 128_000],
    ["gpt-4-32k", 32_000],
    ["gpt-4", 8_192],
    ["gpt-3.5-turbo-16k", 16_000],
    ["gpt-3.5", 4_096],
    ["o4-mini", 200_000],
    ["o3-pro", 200_000],
    ["o3-mini", 200_000],
    ["o3", 200_000],
    ["o1-pro", 200_000],
    ["o1-mini", 128_000],
    ["o1", 200_000],
  ],
};
