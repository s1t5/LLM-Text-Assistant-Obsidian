// Smoke test for the plugin's core logic (no Obsidian runtime required).
// Run with: npm run smoke
// Covers: i18n strings/placeholders, buffered SSE parsing, JSON fallback,
// retry on 429, immediate failure on 401, user abort.
//
// The "obsidian" module is a typings-only package, so this test registers a
// Node loader hook that mocks requestUrl before src/llm.ts is imported.

import { register } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

register(pathToFileURL(path.join(process.cwd(), "scripts", "smoke-hook.mjs")).href);

// Node has no `window` global — llm.ts uses window.setTimeout/clearTimeout
// for popout-window compatibility. Provide a minimal shim before importing.
// biome-ignore lint/suspicious/noExplicitAny: test scaffold
(globalThis as any).window = {
	setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
	clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

// --- shared request handler the hook delegates to ---
// biome-ignore lint/suspicious/noExplicitAny: test scaffold
(globalThis as any).__smokeHandler = null;

const { initI18n, t, isGerman } = await import("../src/i18n.ts");
// Must be a dynamic import: static imports are resolved before register()
// above runs, which would bypass the obsidian mock.
const { LlmClient } = await import("../src/llm.ts");

let failures = 0;
function assert(cond: boolean, label: string): void {
	if (cond) {
		console.log(`  ✓ ${label}`);
	} else {
		console.error(`  ✗ ${label}`);
		failures++;
	}
}

// --- 1. i18n ---
console.log("[1] i18n");
initI18n("de");
assert(t("extensionName") === "LLM Text Assistent", "de: extensionName");
assert(isGerman() === true, "de: isGerman()");
assert(
	t("actionTranslate", { TARGET_LANGUAGE: "Englisch" }) === "🌐 Ins Englisch übersetzen",
	"de: placeholder substitution"
);
initI18n("en");
assert(t("extensionName") === "LLM Text Assistant", "en: extensionName");
assert(isGerman() === false, "en: isGerman()");

// --- helpers ---

function makeClient(timeoutSeconds = 60): InstanceType<typeof LlmClient> {
	return new LlmClient({
		apiUrl: "http://llm.test/v1/chat/completions",
		apiKey: "test-key",
		model: "test-model",
		temperature: "0.3",
		timeoutSeconds: String(timeoutSeconds),
	});
}

interface Collected {
	tokens: string[];
	fullText: string | null;
	error: string | null;
	aborted: boolean;
}

function makeCallbacks(): { cb: Collected; cbs: Record<string, (v: unknown) => void> } {
	const cb: Collected = { tokens: [], fullText: null, error: null, aborted: false };
	return {
		cb,
		cbs: {
			onToken: (token: unknown) => cb.tokens.push(String(token)),
			onDone: (fullText: unknown) => (cb.fullText = String(fullText)),
			onError: (message: unknown) => (cb.error = String(message)),
			onAborted: () => (cb.aborted = true),
		},
	};
}

// Installs a handler that receives (body) and returns a synthetic response:
// { status, contentType, text } — mirroring requestUrl's buffered result.
// biome-ignore lint/suspicious/noExplicitAny: test scaffold
function mockResponse(handler: (body: Record<string, unknown>, n: number) => any) {
	let n = 0;
	// biome-ignore lint/suspicious/noExplicitAny: test scaffold
	(globalThis as any).__smokeHandler = (body: Record<string, unknown>) => {
		n++;
		return handler(body, n);
	};
	return () => {
		// biome-ignore lint/suspicious/noExplicitAny: test scaffold
		(globalThis as any).__smokeHandler = null;
	};
}

// --- 2. Buffered SSE parsing ---
console.log("[2] SSE parsing (buffered via requestUrl)");
{
	const restore = mockResponse(() => ({
		status: 200,
		contentType: "text/event-stream",
		text: 'data: {"choices":[{"delta":{"content":"Hallo"}}]}\n\n' +
			'data: {"choices":[{"delta":{"content":" "}}]}\n\n' +
			'data: {"choices":[{"delta":{"content":"Welt"}}]}\n\n' +
			"data: [DONE]\n\n",
	}));
	const { cb, cbs } = makeCallbacks();
	await makeClient().streamChat([{ role: "user", content: "hi" }], new AbortController().signal, cbs);
	assert(cb.error === null, "no error");
	assert(cb.tokens.join("") === "Hallo Welt", "tokens delivered in order");
	assert(cb.fullText === "Hallo Welt", "onDone returns full text");
	restore();
}

// --- 3. Non-SSE JSON response (endpoint ignored stream:true) ---
console.log("[3] non-streaming fallback (plain JSON)");
{
	const restore = mockResponse(() => ({
		status: 200,
		contentType: "application/json",
		text: JSON.stringify({ choices: [{ message: { content: "Plain result" } }] }),
	}));
	const { cb, cbs } = makeCallbacks();
	await makeClient().streamChat([{ role: "user", content: "hi" }], new AbortController().signal, cbs);
	assert(cb.error === null, "no error");
	assert(cb.fullText === "Plain result", "JSON fallback parsed");
	restore();
}

// --- 4. Retry on 429, success on 3rd attempt ---
console.log("[4] retry on 429");
{
	const restore = mockResponse((_body, n) =>
		n < 3
			? { status: 429, contentType: "application/json", text: JSON.stringify({ error: { message: "slow down" } }) }
			: {
					status: 200,
					contentType: "application/json",
					text: JSON.stringify({ choices: [{ message: { content: "After retries" } }] }),
				}
	);
	const { cb, cbs } = makeCallbacks(10);
	await makeClient(10).streamChat([{ role: "user", content: "hi" }], new AbortController().signal, cbs);
	assert(cb.error === null, "no error after retries");
	assert(cb.fullText === "After retries", "success on 3rd attempt");
	restore();
}

// --- 5. Immediate failure on 401 (no retry) ---
console.log("[5] 401 → no retry");
{
	const restore = mockResponse(() => ({
		status: 401,
		contentType: "application/json",
		text: JSON.stringify({ error: { message: "bad key" } }),
	}));
	const { cb, cbs } = makeCallbacks();
	const started = Date.now();
	await makeClient().streamChat([{ role: "user", content: "hi" }], new AbortController().signal, cbs);
	assert(cb.error !== null && /401|API key|API-Key/.test(cb.error as string), `error surfaced: ${cb.error}`);
	assert(Date.now() - started < 2000, "failed fast (no 1s/3s backoff)");
	restore();
}

// --- 6. User abort before the request completes ---
console.log("[6] user abort → onAborted");
{
	const restore = mockResponse(
		() =>
			new Promise(() => {
				// never resolves — the abort signal must fire onAborted
			}) as unknown as { status: number; contentType: string; text: string },
	);
	const { cb, cbs } = makeCallbacks();
	const controller = new AbortController();
	const promise = makeClient().streamChat([{ role: "user", content: "hi" }], controller.signal, cbs);
	setTimeout(() => controller.abort(), 100);
	await promise;
	assert(cb.aborted === true, "onAborted fired");
	assert(cb.fullText === null, "no text applied");
	restore();
}

// --- summary ---
if (failures > 0) {
	console.error(`\n${failures} assertion(s) FAILED`);
	process.exit(1);
}
console.log("\nAll smoke tests passed");