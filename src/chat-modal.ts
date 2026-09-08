// Free prompt chat modal — ported from the browser extension's chat window
// (content.js chat UI): iterative instructions with full context, streaming
// responses, stop button and "Apply" to write the result into the editor.

import { App, Editor, Modal, Notice } from "obsidian";
import { isGerman, t } from "./i18n";
import { ChatMessage, LlmClient } from "./llm";
import { getEditorSelection } from "./main";
import type LlmTextAssistantPlugin from "./main";

export class FreePromptModal extends Modal {
	private plugin: LlmTextAssistantPlugin;
	private editor: Editor;
	private messages: ChatMessage[] = [];
	private abortController: AbortController | null = null;
	private generatedText = "";

	// UI elements (created in onOpen)
	private chatEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private stopBtn!: HTMLButtonElement;
	private applyBtn!: HTMLButtonElement;
	private resetBtn!: HTMLButtonElement;
	private statusEl!: HTMLElement;

	constructor(plugin: LlmTextAssistantPlugin, editor: Editor) {
		super(plugin.app);
		this.plugin = plugin;
		this.editor = editor;
	}

	onOpen() {
		this.contentEl.addClass("llmta-chat-modal");
		this.titleEl.setText(t("chatTitle"));

		// Load the editor selection as initial context (if any)
		const sel = getEditorSelection(this.editor);
		const contextText = sel.text.trim() ? sel.text : "";
		this.messages = this.buildInitialMessages(contextText);

		// --- Chat transcript area ---
		this.chatEl = this.contentEl.createEl("div", { cls: "llmta-chat-log" });
		this.addBubble("system", contextText ? t("chatWelcomeWithContext") : t("chatWelcomeNoContext"));

		// --- Status line (streaming indicator) ---
		this.statusEl = this.contentEl.createEl("div", { cls: "llmta-chat-status" });
		this.statusEl.style.display = "none";

		// --- Input row ---
		const inputRow = this.contentEl.createEl("div", { cls: "llmta-chat-input-row" });
		this.inputEl = inputRow.createEl("textarea", {
			cls: "llmta-chat-input",
		});
		this.inputEl.placeholder = t("chatInputPlaceholder");
		this.inputEl.rows = 2;

		const btnCol = inputRow.createEl("div", { cls: "llmta-chat-buttons" });
		this.sendBtn = btnCol.createEl("button", {
			text: t("chatSend"),
			cls: "mod-cta llmta-chat-send",
		});
		this.stopBtn = btnCol.createEl("button", {
			text: t("chatStop"),
			cls: "llmta-chat-stop",
		});
		this.stopBtn.style.display = "none";

		this.sendBtn.addEventListener("click", () => this.handleSend());
		this.stopBtn.addEventListener("click", () => this.stopStreaming());
		this.inputEl.addEventListener("keydown", (evt) => {
			// Enter sends, Shift+Enter inserts a newline (same as the extension)
			if (evt.key === "Enter" && !evt.shiftKey && !evt.ctrlKey && !evt.metaKey) {
				evt.preventDefault();
				this.handleSend();
			}
		});

		// --- Footer with Apply / Reset ---
		const footer = this.contentEl.createEl("div", { cls: "llmta-chat-footer" });
		this.applyBtn = footer.createEl("button", {
			text: t("chatApply"),
			cls: "mod-cta",
		});
		this.applyBtn.addEventListener("click", () => this.handleApply());

		this.resetBtn = footer.createEl("button", { text: t("chatReset") });
		this.resetBtn.addEventListener("click", () => this.handleReset());
	}

	onClose() {
		this.stopStreaming();
	}

	// Mirrors buildInitialChatMessages from content.js
	private buildInitialMessages(contextText: string): ChatMessage[] {
		let systemContent = t("freePromptSystem");
		if (contextText) {
			systemContent +=
				"\n\n" + t("freePromptContextIntro") + "\n\n---\n" + contextText + "\n---";
		}
		return [{ role: "system", content: systemContent }];
	}

	private addBubble(role: "user" | "system" | "assistant", text: string): HTMLElement {
		const bubble = this.chatEl.createEl("div", { cls: `llmta-bubble llmta-bubble-${role}` });
		// render markdown is not needed; plain text is fine for chat transcript
		bubble.setText(text);
		if (role === "assistant" || role === "system") {
			bubble.addClass("llmta-bubble-markdown");
			bubble.setText(text);
		}
		return bubble;
	}

	private setGenerating(generating: boolean) {
		this.sendBtn.style.display = generating ? "none" : "";
		this.stopBtn.style.display = generating ? "" : "none";
		this.statusEl.style.display = generating ? "" : "none";
		if (generating) {
			this.statusEl.setText(t("chatGenerating"));
		}
	}

	private handleSend() {
		const instruction = this.inputEl.value.trim();
		if (!instruction) return;
		if (this.abortController) return; // already streaming

		this.addBubble("user", instruction);
		this.messages.push({ role: "user", content: instruction });
		this.inputEl.value = "";

		this.setGenerating(true);
		const bubble = this.addBubble("assistant", "");
		let first = true;

		this.abortController = new AbortController();
		const client = this.plugin.getClient();

		client.streamChat(this.messages, this.abortController.signal, {
			onToken: (token) => {
				if (first) {
					bubble.setText(token);
					first = false;
				} else {
					bubble.setText(bubble.getText() + token);
				}
			},
			onDone: (fullText) => {
				this.generatedText = fullText;
				this.messages.push({ role: "assistant", content: fullText });
				this.abortController = null;
				this.setGenerating(false);
			},
			onError: (message) => {
				bubble.setText(t("errorPrefix") + message);
				this.abortController = null;
				this.setGenerating(false);
			},
			onAborted: () => {
				// Keep already-received text (same as the extension's cancel)
				this.generatedText = bubble.getText();
				if (this.generatedText.trim()) {
					this.messages.push({ role: "assistant", content: this.generatedText });
				}
				this.abortController = null;
				this.setGenerating(false);
			},
		});
	}

	private stopStreaming() {
		if (this.abortController) {
			this.abortController.abort();
		}
	}

	private handleApply() {
		if (!this.generatedText.trim()) {
			new Notice(t("errorPrefix") + t("errorNoResult"));
			return;
		}
		const sel = getEditorSelection(this.editor);
		if (sel.isSelection) {
			this.editor.replaceRange(this.generatedText, sel.from, sel.to);
		} this.editor.replaceRange(this.generatedText, sel.from, sel.from);
		this.close();
	}

	private handleReset() {
		this.stopStreaming();
		this.messages = this.buildInitialMessages("");
		const sel = getEditorSelection(this.editor);
		if (sel.text.trim()) {
			this.messages = this.buildInitialMessages(sel.text);
			this.addBubble("system", t("chatResetWithContext"));
		} else {
			this.addBubble("system", t("chatResetNoContext"));
		}
		this.generatedText = "";
	}
}