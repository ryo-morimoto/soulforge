import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { authStatus } from "../src/headless/providers.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

async function importFresh<T>(path: string): Promise<T> {
	return import(`${path}?t=${Date.now()}-${Math.random()}`) as Promise<T>;
}

describe("openai auth headless behavior", () => {
	let stdoutSpy: ReturnType<typeof spyOn>;
	let stderrSpy: ReturnType<typeof spyOn>;
	let exitSpy: ReturnType<typeof spyOn>;
	let exitCode: number | undefined;

	beforeEach(() => {
		exitCode = undefined;
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
		stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
		exitSpy = spyOn(process, "exit").mockImplementation((code) => {
			exitCode = (code as number) ?? 0;
			throw new Error(`EXIT:${String(exitCode)}`);
		});
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
		exitSpy.mockRestore();
		globalThis.fetch = originalFetch;
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		mock.restore();
	});

	test("authStatus rejects non-auth providers", async () => {
		try {
			await authStatus("anthropic");
		} catch {}
		expect(exitCode).toBe(1);
		expect(stderrSpy).toHaveBeenCalled();
	});

	test("authStatus shows OpenAI auth methods", async () => {
		await authStatus("openai");
		const output = stdoutSpy.mock.calls.map((call) => call.join("")).join("");
		expect(output).toContain("OpenAI");
		expect(output).toContain("ChatGPT Login");
		expect(output).toContain("Device Code");
	});

	test("OpenAI fetchModels uses OAuth allowlist when oauth session exists", async () => {
		mock.module("../src/core/auth/openai.js", () => ({
			getOpenAICodexEndpoint: () => "https://chatgpt.com/backend-api/codex/responses",
			getOpenAIOAuthModels: () => [{ id: "gpt-5.1-codex", name: "GPT-5.1 Codex" }],
			getOpenAIOAuthSession: () => ({
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
				accountId: "acct_123",
			}),
			OPENAI_OAUTH_DUMMY_KEY: "openai-oauth",
			openaiAuth: {
				listMethods: () => [],
				getState: async () => ({ active: "oauth", available: true, configured: ["oauth"] }),
				checkAvailability: async () => true,
				login: async () => {},
				logout: async () => {},
			},
			refreshOpenAIOAuthSession: async () => ({
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
				accountId: "acct_123",
			}),
		}));

		const { openai } = await importFresh<typeof import("../src/core/llm/providers/openai.js")>(
			"../src/core/llm/providers/openai.js",
		);
		const models = await openai.fetchModels();
		expect(models).toEqual([{ id: "gpt-5.1-codex", name: "GPT-5.1 Codex" }]);
	});

	test("OpenAI fetchModels uses API endpoint when only API key exists", async () => {
		process.env.OPENAI_API_KEY = "sk-test";
		mock.module("../src/core/auth/openai.js", () => ({
			getOpenAICodexEndpoint: () => "https://chatgpt.com/backend-api/codex/responses",
			getOpenAIOAuthModels: () => [],
			getOpenAIOAuthSession: () => null,
			OPENAI_OAUTH_DUMMY_KEY: "openai-oauth",
			openaiAuth: {
				listMethods: () => [],
				getState: async () => ({ active: "apiKey", available: true, configured: ["apiKey"] }),
				checkAvailability: async () => true,
				login: async () => {},
				logout: async () => {},
			},
			refreshOpenAIOAuthSession: async () => {
				throw new Error("should not refresh without oauth");
			},
		}));
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ data: [{ id: "gpt-5", object: "model" }] }), {
					status: 200,
				}),
			),
		) as typeof fetch;

		const { openai } = await importFresh<typeof import("../src/core/llm/providers/openai.js")>(
			"../src/core/llm/providers/openai.js",
		);
		const models = await openai.fetchModels();
		expect(models).toEqual([{ id: "gpt-5", name: "gpt-5" }]);
		expect(globalThis.fetch).toHaveBeenCalled();
	});

	test("OpenAI createModel passes OAuth config to AI SDK when oauth session exists", async () => {
		let capturedConfig: Record<string, unknown> | undefined;
		mock.module("../src/core/auth/openai.js", () => ({
			getOpenAICodexEndpoint: () => "https://chatgpt.com/backend-api/codex/responses",
			getOpenAIOAuthModels: () => [],
			getOpenAIOAuthSession: () => ({
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
				accountId: "acct_123",
			}),
			OPENAI_OAUTH_DUMMY_KEY: "openai-oauth",
			openaiAuth: {
				listMethods: () => [],
				getState: async () => ({ active: "oauth", available: true, configured: ["oauth"] }),
				checkAvailability: async () => true,
				login: async () => {},
				logout: async () => {},
			},
			refreshOpenAIOAuthSession: async () => ({
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
				accountId: "acct_123",
			}),
		}));
		mock.module("@ai-sdk/openai", () => ({
			createOpenAI: (config: Record<string, unknown>) => {
				capturedConfig = config;
				return (modelId: string) => ({ modelId, capturedConfig });
			},
		}));

		const { openai } = await importFresh<typeof import("../src/core/llm/providers/openai.js")>(
			"../src/core/llm/providers/openai.js",
		);
		const model = openai.createModel("gpt-5") as { modelId: string };
		expect(model.modelId).toBe("gpt-5");
		expect(capturedConfig?.apiKey).toBe("openai-oauth");
		expect(typeof capturedConfig?.fetch).toBe("function");
	});

	test("OpenAI OAuth middleware moves system prompt to instructions and forces store false", async () => {
		let capturedParams: Record<string, unknown> | undefined;
		mock.module("../src/core/auth/openai.js", () => ({
			getOpenAICodexEndpoint: () => "https://chatgpt.com/backend-api/codex/responses",
			getOpenAIOAuthModels: () => [],
			getOpenAIOAuthSession: () => ({
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
				accountId: "acct_123",
			}),
			OPENAI_OAUTH_DUMMY_KEY: "openai-oauth",
			openaiAuth: {
				listMethods: () => [],
				getState: async () => ({ active: "oauth", available: true, configured: ["oauth"] }),
				checkAvailability: async () => true,
				login: async () => {},
				logout: async () => {},
			},
			refreshOpenAIOAuthSession: async () => ({
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
				accountId: "acct_123",
			}),
		}));
		mock.module("@ai-sdk/openai", () => ({
			createOpenAI: () =>
				() => ({
					specificationVersion: "v3",
					provider: "openai",
					modelId: "gpt-5",
					doGenerate: async (params: Record<string, unknown>) => {
						capturedParams = params;
						return {
							finishReason: "stop",
							usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
							rawCall: { rawPrompt: null, rawSettings: {} },
							text: "ok",
							warnings: [],
						};
					},
					doStream: async () => {
						throw new Error("unused");
					},
				}),
		}));

		const { openai } = await importFresh<typeof import("../src/core/llm/providers/openai.js")>(
			"../src/core/llm/providers/openai.js",
		);
		const model = openai.createModel("gpt-5");
		await model.doGenerate({
			prompt: [
				{ role: "system", content: "system prompt" },
				{ role: "user", content: [{ type: "text", text: "hello" }] },
			],
		} as never);

		expect(capturedParams).toBeDefined();
		expect(capturedParams?.prompt).toEqual([
			{ role: "user", content: [{ type: "text", text: "hello" }] },
		]);
		expect(capturedParams?.providerOptions).toEqual({
			openai: {
				instructions: "system prompt",
				store: false,
			},
		});
	});

	test("OpenAI OAuth fetch rewrites responses requests and preserves request headers", async () => {
		let capturedConfig: { fetch?: typeof fetch } | undefined;
		let refreshed = false;
		let capturedRequest: Request | undefined;
		mock.module("../src/core/auth/openai.js", () => ({
			getOpenAICodexEndpoint: () => "https://chatgpt.com/backend-api/codex/responses",
			getOpenAIOAuthModels: () => [],
			getOpenAIOAuthSession: () => ({
				access: refreshed ? "fresh-access" : "stale-access",
				refresh: "refresh-token",
				expires: refreshed ? Date.now() + 60_000 : Date.now() - 1,
				accountId: "acct_123",
			}),
			OPENAI_OAUTH_DUMMY_KEY: "openai-oauth",
			openaiAuth: {
				listMethods: () => [],
				getState: async () => ({ active: "oauth", available: true, configured: ["oauth"] }),
				checkAvailability: async () => true,
				login: async () => {},
				logout: async () => {},
			},
			refreshOpenAIOAuthSession: async () => {
				refreshed = true;
				return {
					access: "fresh-access",
					refresh: "refresh-token",
					expires: Date.now() + 60_000,
					accountId: "acct_123",
				};
			},
		}));
		mock.module("@ai-sdk/openai", () => ({
			createOpenAI: (config: { fetch?: typeof fetch }) => {
				capturedConfig = config;
				return (modelId: string) => ({ modelId });
			},
		}));
		globalThis.fetch = mock((input: string | URL | Request) => {
			capturedRequest = input instanceof Request ? input : new Request(input);
			return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
		}) as typeof fetch;

		const { openai } = await importFresh<typeof import("../src/core/llm/providers/openai.js")>(
			"../src/core/llm/providers/openai.js",
		);
		openai.createModel("gpt-5");
		const oauthFetch = capturedConfig?.fetch;
		expect(oauthFetch).toBeDefined();

		const request = new Request("https://api.openai.com/v1/responses", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-trace-id": "trace-1",
			},
			body: JSON.stringify({ input: "hello" }),
		});

		await oauthFetch?.(request);

		expect(refreshed).toBe(true);
		expect(capturedRequest).toBeDefined();
		expect(capturedRequest?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(capturedRequest?.method).toBe("POST");
		expect(capturedRequest?.headers.get("authorization")).toBe("Bearer fresh-access");
		expect(capturedRequest?.headers.get("ChatGPT-Account-Id")).toBe("acct_123");
		expect(capturedRequest?.headers.get("content-type")).toBe("application/json");
		expect(capturedRequest?.headers.get("x-trace-id")).toBe("trace-1");
		expect(await capturedRequest?.text()).toContain("hello");
	});
});
