// Smoke test for the plugin's core logic (no Obsidian runtime required).
// Run with: npm run smoke
// Covers: i18n strings/placeholders, SSE streaming, non-streaming fallback,
// retry on 429, immediate failure on 401, user abort.

import http from "node:http";
import { initI18n, t, isGerman } from "../src/i18n.ts";
import { LlmClient } from "../src/llm.ts";

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
assert(
	t("defaultPromptTranslate", { TARGET_LANGUAGE: "Englisch" }).includes("Englisch"),
	"de: default prompt contains target language"
);
initI18n("en");
assert(t("extensionName") === "LLM Text Assistant", "en: extensionName");
assert(isGerman() === false, "en: isGerman()");

// --- helpers ---
function makeClient(port: number, timeoutSeconds = 60): LlmClient {
	return new LlmClient({
		apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
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

function makeCallbacks(): { cb: Collected; cbs: any } {
	const cb: Collected = { tokens: [], fullText: null, error: null, aborted: false };
	return {
		cb,
		cbs: {
			onToken: (token: string) => cb.tokens.push(token),
			onDone: (fullText: string) => (cb.fullText = fullText),
			onError: (message: string) => (cb.error = message),
			onAborted: () => (cb.aborted = true),
		},
	};
}

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, state: { requests: number }) => void): Promise<http.Server> {
	const state = { requests: 0 };
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			state.requests++;
			handler(req, res, state);
		});
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
}

function closeServer(server: http.Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

const addr = (server: http.Server) => (server.address() as { port: number }).port;

// --- 2. SSE streaming ---
console.log("[2] SSE streaming");
{
	const server = await startServer((req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write('data: {"choices":[{"delta":{"content":"Hallo"}}]}\n\n');
		res.write('data: {"choices":[{"delta":{"content":" "}}]}\n\n');
		res.write('data: {"choices":[{"delta":{"content":"Welt"}}]}\n\n');
		res.write("data: [DONE]\n\n");
		res.end();
	});
	const { cb, cbs } = makeCallbacks();
	await makeClient(addr(server)).streamChat(
		[{ role: "user", content: "hi" }],
		new AbortController().signal,
		cbs
	);
	assert(cb.error === null, "no error");
	assert(cb.tokens.join("") === "Hallo Welt", "tokens streamed in order");
	assert(cb.fullText === "Hallo Welt", "onDone returns full text");
	await closeServer(server);
}

// --- 3. Non-streaming fallback (endpoint returns plain JSON) ---
console.log("[3] non-streaming fallback");
{
	const server = await startServer((req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ choices: [{ message: { content: "Plain result" } }] }));
	});
	const { cb, cbs } = makeCallbacks();
	await makeClient(addr(server)).streamChat(
		[{ role: "user", content: "hi" }],
		new AbortController().signal,
		cbs
	);
	assert(cb.error === null, "no error");
	assert(cb.fullText === "Plain result", "JSON fallback parsed");
	await closeServer(server);
}

// --- 4. Retry on 429, success on 3rd attempt ---
console.log("[4] retry on 429");
{
	const server = await startServer((req, res, state) => {
		if (state.requests < 3) {
			res.writeHead(429, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "slow down" } }));
		} else {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ choices: [{ message: { content: "After retries" } }] }));
		}
	});
	const { cb, cbs } = makeCallbacks();
	await makeClient(addr(server), 10).streamChat(
		[{ role: "user", content: "hi" }],
		new AbortController().signal,
		cbs
	);
	assert(cb.error === null, "no error after retries");
	assert(cb.fullText === "After retries", "success on 3rd attempt");
	await closeServer(server);
}

// --- 5. Immediate failure on 401 (no retry) ---
console.log("[5] 401 → no retry");
{
	const server = await startServer((req, res, state) => {
		res.writeHead(401, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "bad key" } }));
		void state;
	});
	const { cb, cbs } = makeCallbacks();
	const started = Date.now();
	await makeClient(addr(server)).streamChat(
		[{ role: "user", content: "hi" }],
		new AbortController().signal,
		cbs
	);
	assert(cb.error !== null && /401|API key|API-Key/.test(cb.error), `error surfaced: ${cb.error}`);
	assert(Date.now() - started < 2000, "failed fast (no 1s/3s backoff)");
	await closeServer(server);
}

// --- 6. User abort mid-stream: partial text is kept (reference behaviour:
// reader.cancel() resolves read() with done:true → onDone with partial text) ---
console.log("[6] user abort mid-stream keeps partial text");
{
	const server = await startServer((req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write('data: {"choices":[{"delta":{"content":"start"}}]}\n\n');
		// never send [DONE]; keep the connection open
	});
	const { cb, cbs } = makeCallbacks();
	const controller = new AbortController();
	const client = makeClient(addr(server));
	const promise = client.streamChat([{ role: "user", content: "hi" }], controller.signal, cbs);
	setTimeout(() => controller.abort(), 150);
	await promise;
	assert(cb.error === null, "no error");
	assert(cb.fullText === "start", `partial text kept (got: ${JSON.stringify(cb.fullText)})`);
	await closeServer(server);
}

// --- 7. User abort before the response arrives → onAborted ---
console.log("[7] user abort before response → onAborted");
{
	const server = await startServer((req, res) => {
		// Delay the response so the abort hits during fetch
		setTimeout(() => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end('data: [DONE]\n\n');
		}, 800);
	});
	const { cb, cbs } = makeCallbacks();
	const controller = new AbortController();
	const client = makeClient(addr(server));
	const promise = client.streamChat([{ role: "user", content: "hi" }], controller.signal, cbs);
	setTimeout(() => controller.abort(), 100);
	await promise;
	assert(cb.aborted === true, "onAborted fired");
	assert(cb.fullText === null, "no text applied");
	await closeServer(server);
}

// --- summary ---
if (failures > 0) {
	console.error(`\n${failures} assertion(s) FAILED`);
	process.exit(1);
}
console.log("\nAll smoke tests passed");