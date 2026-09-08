// Free prompt chat modal — ported from the browser extension's chat window
// (content.js chat UI): iterative instructions with full context, streaming
// responses, stop button and "Apply" to write the result into the editor.

import { App, Editor, Modal, Notice } from "obsidian";
import { isGerman, t } from "./i18n";
import { ChatMessage, LlmClient } from "./llm";
import { getEditorSelection } from "./main";
import type LlmTextAssistantPlugin from "./main";

// --- helpers ---

function clipboardWrite(text: string): void {
	// Obsidian's Electron clipboard is not part of the public typings; use
	// the web Clipboard API with an execCommand fallback for older setups.
	if (navigator.clipboard?.writeText) {
		void navigator.clipboard.writeText(text).catch(() => execCommandCopy(text));
	} else {
		execCommandCopy(text);
	}
}

function execCommandCopy(text: string): void {
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.style.position = "fixed";
	ta.style.opacity = "0";
	document.body.appendChild(ta);
	ta.select();
	try {
		document.execCommand("copy");
	} catch {
		// ignore — notice below reflects the best-effort result
	}
	ta.remove();
}

// Bubbles are wrapped so the copy button can float on the assistant bubble.
function wrapAssistantBubble(bubble: HTMLElement): HTMLElement {
	const wrapper = document.createElement("div");
	wrapper.addClass("llmta-bubble-wrap");
	bubble.parentNode?.insertBefore(wrapper, bubble);
	wrapper.appendChild(bubble);
	return wrapper;
}

function addCopyButton(modal: FreePromptModal, wrapper: HTMLElement, bubble: HTMLElement): void {
	const btn = wrapper.createEl("button", { cls: "llmta-copy-btn" });
	btn.setText("⧉");
	btn.ariaLabel = "Copy";
	btn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		const text = bubble.getText();
		if (!text.trim()) return;
		clipboardWrite(text);
		// Remember as the latest assistant answer for "Apply" / copy-last
		modal.generatedText = text;
		modal.markCopied(btn);
	});
}

export class FreePromptModal extends Modal {
	private plugin: LlmTextAssistantPlugin;
	private editor: Editor;
	private messages: ChatMessage[] = [];
	private abortController: AbortController | null = null;
	// Latest assistant answer — public so the copy-button helper can set it
	// when an older bubble is copied.
	generatedText = "";

	// UI elements (created in onOpen)
	private chatEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private stopBtn!: HTMLButtonElement;
	private applyBtn!: HTMLButtonElement;
	private copyBtn!: HTMLButtonElement;
	private resetBtn!: HTMLButtonElement;
	private statusEl!: HTMLElement;
	private isModalOpen = false;
	private boundKeydown: ((evt: KeyboardEvent) => void) | null = null;

	constructor(plugin: LlmTextAssistantPlugin, editor: Editor) {
		super(plugin.app);
		this.plugin = plugin;
		this.editor = editor;
	}

	onOpen() {
		this.isModalOpen = true;
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

		// --- Footer with Copy / Apply / Reset ---
		const footer = this.contentEl.createEl("div", { cls: "llmta-chat-footer" });
		this.applyBtn = footer.createEl("button", {
			text: t("chatApply"),
			cls: "mod-cta",
		});
		this.applyBtn.addEventListener("click", () => this.handleApply());

		this.copyBtn = footer.createEl("button", { text: t("chatCopyLast") });
		this.copyBtn.addEventListener("click", () => this.copyLatest());

		this.resetBtn = footer.createEl("button", { text: t("chatReset") });
		this.resetBtn.addEventListener("click", () => this.handleReset());

		// Ctrl/Cmd+C inside the chat log copies the latest assistant answer
		// when no text is selected (mirrors the extension's chat copy UX).
		// Modal does not extend Component in the public typings, so the
		// listener is managed manually and removed in onClose.
		this.boundKeydown = (evt: KeyboardEvent) => {
			if (!this.isModalOpen) return;
			if (evt.key !== "c" || !(evt.ctrlKey || evt.metaKey) || evt.shiftKey || evt.altKey) return;
			const active = document.activeElement;
			if (active && (active === this.inputEl || active.tagName === "TEXTAREA" || active.tagName === "INPUT")) return;
			if (this.chatEl && this.chatEl.contains(active)) return;
			const selection = window.getSelection();
			if (selection && selection.toString().trim()) return; // let Obsidian copy the selection
			if (!this.generatedText.trim()) return;
			evt.preventDefault();
			this.copyLatest();
		};
		document.addEventListener("keydown", this.boundKeydown, true);
	}

	onClose() {
		this.isModalOpen = false;
		if (this.boundKeydown) {
			document.removeEventListener("keydown", this.boundKeydown, true);
			this.boundKeydown = null;
		}
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

	// A small system bubble (welcome/reset notice) — no copy button.
	private addSystemBubble(text: string): void {
		this.chatEl.createEl("div", { cls: "llmta-bubble llmta-bubble-system" }).setText(text);
	}

	private addBubble(role: "user" | "system" | "assistant", text: string): HTMLElement {
		const bubble = this.chatEl.createEl("div", { cls: `llmta-bubble llmta-bubble-${role}` });
		bubble.setText(text);
		return bubble;
	}

	// Assistant bubbles get a floating copy button (wrapped for positioning).
	private addAssistantBubble(): HTMLElement {
		const bubble = this.chatEl.createEl("div", { cls: "llmta-bubble llmta-bubble-assistant" });
		const wrapper = wrapAssistantBubble(bubble);
		addCopyButton(this, wrapper, bubble);
		return bubble;
	}

	copyLatest(): void {
		if (!this.generatedText.trim()) {
			new Notice(t("errorPrefix") + t("errorNoResult"));
			return;
		}
		clipboardWrite(this.generatedText);
		new Notice(t("chatCopied"));
	}

	markCopied(btn: HTMLButtonElement): void {
		const prev = btn.getText();
		btn.setText("✓");
		setTimeout(() => btn.setText(prev), 1500);
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
		const bubble = this.addAssistantBubble();
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
		} else {
			this.editor.replaceRange(this.generatedText, sel.from, sel.from);
		}
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