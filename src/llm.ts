// OpenAI-compatible Chat Completions client with streaming, timeout and retry.
// Ported from the browser extension's background.js (fetchWithRetry/streamResponse):
//   - per-attempt timeout linked to a user-facing abort signal
//   - 3 attempts total, backoff 1s / 3s
//   - non-retryable: 400/401/403/404 and other 4xx (except 408/429)
//   - retryable: 408, 429, 5xx, network failures, timeouts
//   - SSE parsing with fallback when the endpoint ignores stream:true

import { isGerman } from "./i18n.ts";

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export class AbortError extends Error {
	constructor() {
		super("Aborted");
		this.name = "AbortError";
	}
}

export class UserAbortError extends Error {
	constructor() {
		super("UserAbort");
		this.name = "UserAbortError";
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapApiError(status: number, errorText: string): string {
	const german = isGerman();
	let detail = "";
	try {
		const parsed = JSON.parse(errorText);
		if (parsed && parsed.error && parsed.error.message) {
			detail = parsed.error.message;
		}
	} catch {
		/* ignore */
	}

	if (status === 401 || status === 403) {
		return german
			? `API: Authentifizierung fehlgeschlagen (HTTP ${status}). Prüfe den API-Key.`
			: `API: authentication failed (HTTP ${status}). Check the API key.`;
	}
	if (status === 404) {
		return german
			? `API: Endpunkt oder Modell nicht gefunden (HTTP 404). Prüfe URL und Modellname.`
			: `API: endpoint or model not found (HTTP 404). Check the URL and model name.`;
	}
	if (status === 429) {
		return german
			? `API: Rate-Limit erreicht (HTTP 429). Bitte später erneut versuchen.`
			: `API: rate limit reached (HTTP 429). Please try again later.`;
	}
	return german
		? `API Fehler ${status}${detail ? ": " + detail : ""}`
		: `API error ${status}${detail ? ": " + detail : ""}`;
}

function timeoutMessage(seconds: number): string {
	return isGerman()
		? `Zeitüberschreitung nach ${seconds}s. Läuft der Server bzw. ist der Endpunkt erreichbar?`
		: `Timeout after ${seconds}s. Is the server running / the endpoint reachable?`;
}

function networkErrorMessage(): string {
	return isGerman()
		? "Netzwerkfehler: Der API-Endpunkt ist nicht erreichbar."
		: "Network error: the API endpoint is unreachable.";
}

export interface LlmRequestConfig {
	apiUrl: string;
	apiKey: string;
	model: string;
	temperature: string;
	timeoutSeconds: string;
}

async function fetchWithRetry(
	config: LlmRequestConfig,
	requestBody: Record<string, unknown>,
	signal: AbortSignal
): Promise<Response> {
	const timeoutMs =
		Math.max(5, parseInt(config.timeoutSeconds || "60", 10) || 60) * 1000;

	const maxAttempts = 3; // initial try + 2 retries
	let lastError: Error | null = null;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (signal.aborted) {
			throw new UserAbortError();
		}

		// Per-attempt timeout, linked to the user-facing abort signal
		const attemptController = new AbortController();
		const timeoutId = setTimeout(() => attemptController.abort(), timeoutMs);
		const onUserAbort = () => attemptController.abort();
		signal.addEventListener("abort", onUserAbort);

		try {
			const response = await requestUrl(requestBody, config, attemptController.signal);
			clearTimeout(timeoutId);
			signal.removeEventListener("abort", onUserAbort);
			return response;
		} catch (err) {
			clearTimeout(timeoutId);
			signal.removeEventListener("abort", onUserAbort);

			if (signal.aborted) {
				throw new UserAbortError();
			}

			const errTyped = err as { name?: string; status?: number; message?: string };
			if (errTyped.name === "AbortError") {
				// Per-attempt timeout fired
				lastError = new Error(timeoutMessage(timeoutMs / 1000));
			} else if (errTyped.status !== undefined) {
				const status = errTyped.status;
				const errorText = errTyped.message || "";
				// Non-retryable: client/config errors
				if (
					[400, 401, 403, 404].includes(status) ||
					(status >= 400 && status < 500 && status !== 408 && status !== 429)
				) {
					throw new Error(mapApiError(status, errorText));
				}
				// Retryable: 408, 429, 5xx
				lastError = new Error(mapApiError(status, errorText));
			} else {
				// Network failure
				lastError = new Error(networkErrorMessage());
			}
		}

		// Backoff before retry: 1s, then 3s
		if (attempt < maxAttempts - 1) {
			await sleep(attempt === 0 ? 1000 : 3000);
		}
	}

	throw lastError || new Error(isGerman() ? "Unbekannter Fehler" : "Unknown error");
}

// Fetch with a 401/403/404 status mapped into a thrown object carrying the
// response text, so mapApiError can surface provider details.
async function requestUrl(
	requestBody: Record<string, unknown>,
	config: LlmRequestConfig,
	signal: AbortSignal
): Promise<Response> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (config.apiKey) {
		headers["Authorization"] = `Bearer ${config.apiKey}`;
	}

	const response = await fetch(config.apiUrl, {
		method: "POST",
		headers,
		body: JSON.stringify(requestBody),
		signal,
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "");
		const err = new Error(errorText) as Error & { status?: number };
		err.status = response.status;
		throw err;
	}

	return response;
}

// Parse an OpenAI-style SSE stream. Returns the concatenated text.
async function streamResponse(
	response: Response,
	onToken: (token: string) => void,
	signal: AbortSignal
): Promise<string> {
	const contentType = response.headers.get("content-type") || "";
	if (!contentType.includes("text/event-stream")) {
		// Endpoint ignored stream:true and returned plain JSON
		const data = await response.json();
		const content = data?.choices?.[0]?.message?.content;
		if (content === undefined) {
			throw new Error(isGerman() ? "Ungültige API-Antwort" : "Invalid API response");
		}
		if (content) onToken(content);
		return content;
	}

	if (!response.body || typeof (response.body as any).getReader !== "function") {
		throw new Error(
			isGerman()
				? "Streaming wird von diesem Endpunkt nicht unterstützt"
				: "Streaming not supported by this endpoint"
		);
	}

	const reader = (response.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder("utf-8");
	let buffer = "";
	let fullText = "";

	const onAbort = () => {
		try {
			reader.cancel();
		} catch {
			/* ignore */
		}
	};
	signal.addEventListener("abort", onAbort);

	try {
		for (;;) {
			if (signal.aborted) {
				throw new UserAbortError();
			}

			const { value, done } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });

			// Process complete lines
			let newlineIndex: number;
			while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
				let line = buffer.slice(0, newlineIndex);
				buffer = buffer.slice(newlineIndex + 1);
				line = line.replace(/\r$/, "");

				if (!line.startsWith("data:")) continue;
				const payload = line.slice(5).trim();
				if (payload === "[DONE]") {
					return fullText;
				}

				try {
					const json = JSON.parse(payload);
					const delta = json?.choices?.[0]?.delta?.content;
					if (typeof delta === "string" && delta.length > 0) {
						fullText += delta;
						onToken(delta);
					}
				} catch {
					// Ignore malformed keep-alive lines
				}
			}
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
	}

	return fullText;
}

function isStreamUnsupported(err: unknown): boolean {
	// Some endpoints don't support streaming and may return 400 or HTML error pages
	return err instanceof Error && /stream/i.test(err.message || "");
}

export interface StreamCallbacks {
	onToken: (token: string) => void;
	onDone: (fullText: string) => void;
	onError: (message: string) => void;
	onAborted?: () => void;
}

export class LlmClient {
	private config: LlmRequestConfig;

	constructor(config: LlmRequestConfig) {
		this.config = config;
	}

	createAbortController(): AbortController {
		return new AbortController();
	}

	// Streaming chat completion with non-streaming fallback.
	// Mirrors processTextStreaming/processFreePromptStreaming from background.js.
	async streamChat(
		messages: ChatMessage[],
		signal: AbortSignal,
		callbacks: StreamCallbacks
	): Promise<void> {
		const requestBody: Record<string, unknown> = {
			model: this.config.model,
			messages,
			temperature: parseFloat(this.config.temperature || "0.3"),
			stream: true,
		};

		try {
			const response = await fetchWithRetry(this.config, requestBody, signal);
			const fullText = await streamResponse(response, callbacks.onToken, signal);
			callbacks.onDone(fullText);
		} catch (err) {
			if (isStreamUnsupported(err)) {
				// Fallback to non-streaming
				try {
					const body = { ...requestBody };
					delete body.stream;
					const response = await fetchWithRetry(this.config, body, signal);
					const data = await response.json();
					const content = data?.choices?.[0]?.message?.content;
					if (!content) {
						throw new Error(isGerman() ? "Ungültige API-Antwort" : "Invalid API response");
					}
					callbacks.onDone(content);
				} catch (fallbackErr) {
					this.dispatchError(fallbackErr, signal, callbacks);
				}
			} else {
				this.dispatchError(err, signal, callbacks);
			}
		}
	}

	private dispatchError(err: unknown, signal: AbortSignal, callbacks: StreamCallbacks): void {
		if (signal.aborted || (err as Error)?.name === "UserAbortError") {
			callbacks.onAborted?.();
			return;
		}
		const message =
			err instanceof Error && err.message
				? err.message
				: isGerman()
					? "Unbekannter Fehler"
					: "Unknown error";
		callbacks.onError(message);
	}
}