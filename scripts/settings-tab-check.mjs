// Value-level check for the settings tab's hand-built rows (no Obsidian needed).
// Run with: npm run test:settings
//
// Why this exists: Obsidian 1.13+ renders a plugin's settings tab from
// getSettingDefinitions() and SKIPS display(). Anything that only exists in
// display() silently disappears, and a `control` binding shows the STORED
// value — the prompt keys are stored as "" on purpose, so every prompt field
// looked empty and the custom-action editor was missing entirely (v1.1.0 bug,
// fixed in v1.1.1).
//
// This harness slices the four row builders out of src/main.ts, strips their
// TypeScript annotations with Node's built-in stripper, and runs them against a
// minimal fake DOM + fake Setting. It asserts what the user actually sees:
// the effective prompt text, the datalist wiring, and add/remove of actions.
//
// Requires Node >= 22.13 (module.stripTypeScriptTypes). The build itself only
// needs Node >= 20, which is why this is a separate script, not part of `smoke`.

import fs from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";

const repoRoot = path.join(import.meta.dirname, "..");
const src = fs.readFileSync(path.join(repoRoot, "src", "main.ts"), "utf8");

function sliceMethod(name) {
	const at = src.includes(`\tprivate ${name}(`)
		? src.indexOf(`\tprivate ${name}(`)
		: src.indexOf(`\t${name}(`);
	if (at < 0) throw new Error(`method not found in src/main.ts: ${name}`);
	const open = src.indexOf("{", at);
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}") {
			depth--;
			if (depth === 0) return src.slice(at, i + 1);
		}
	}
	throw new Error(`unbalanced braces in ${name}`);
}

// --- minimal fake DOM -------------------------------------------------------
class El {
	constructor(tag) {
		this.tagName = tag.toUpperCase();
		this.children = [];
		this.classes = [];
		this.style = {};
		this.value = "";
		this.id = "";
		this.textContent = "";
		this.attrs = {};
		this.listeners = {};
	}
	createEl(tag, o = {}) {
		const e = new El(tag);
		if (o.cls) e.classes.push(o.cls);
		if (o.type) e.attrs.type = o.type;
		if (o.text) e.textContent = o.text;
		this.children.push(e);
		return e;
	}
	createDiv(o = {}) {
		return this.createEl("div", o);
	}
	empty() {
		this.children = [];
	}
	addClass(c) {
		this.classes.push(c);
	}
	addEventListener(type, fn) {
		(this.listeners[type] ||= []).push(fn);
	}
	setAttribute(k, v) {
		this.attrs[k] = v;
	}
	click() {
		for (const fn of this.listeners.click || []) fn();
	}
	find(pred, out = []) {
		for (const c of this.children) {
			if (pred(c)) out.push(c);
			c.find(pred, out);
		}
		return out;
	}
}

// --- minimal fake Setting ---------------------------------------------------
class FakeSetting {
	constructor(containerEl) {
		this.settingEl = new El("div");
		this.settingEl.classes.push("setting-item");
		if (containerEl) containerEl.children.push(this.settingEl);
	}
	setName(n) {
		this.name = n;
		return this;
	}
	setDesc(d) {
		this.desc = d;
		return this;
	}
	setHeading() {
		this.heading = true;
		return this;
	}
	addTextArea(cb) {
		const ta = new El("textarea");
		ta.inputEl = ta;
		const comp = {
			inputEl: ta,
			setValue: (v) => (ta.value = v, comp),
			onChange: (fn) => (ta.onChange = fn, comp),
		};
		this.settingEl.children.push(ta);
		cb(comp);
		return this;
	}
	addText(cb) {
		const input = new El("input");
		input.inputEl = input;
		const comp = {
			inputEl: input,
			setValue: (v) => (input.value = v, comp),
			onChange: (fn) => (input.onChange = fn, comp),
		};
		this.settingEl.children.push(input);
		cb(comp);
		return this;
	}
	addButton(cb) {
		const btn = new El("button");
		btn.buttonEl = btn;
		const comp = {
			buttonEl: btn,
			setButtonText: (t) => (btn.textContent = t, comp),
			onClick: (fn) => (btn.addEventListener("click", fn), comp),
		};
		this.settingEl.children.push(btn);
		cb(comp);
		return this;
	}
}

// --- fake i18n: the real German defaults, so the assertions read naturally --
const DE = {
	defaultTargetLanguage: "Englisch",
	defaultPromptTranslate: "Du bist ein Übersetzungs-Werkzeug. Übersetze den Text ins $TARGET_LANGUAGE$.",
	defaultPromptExpand: "Du bist ein Text-Werkzeug.",
	defaultPromptSummarize: "Du bist ein Zusammenfassungs-Werkzeug.",
	defaultPromptGrammar: "Du bist ein Korrektur-Werkzeug.",
};
function t(key, subs) {
	let text = DE[key] ?? key;
	if (subs) for (const [k, v] of Object.entries(subs)) text = text.split(`$${k}$`).join(v);
	return text;
}
const isGerman = () => true;
const MODEL_LIST_ID = "llmta-model-list";

// --- build the class under test from the shipped sources --------------------
const methods = ["promptFallback", "addPromptControl", "addTargetLanguageControl", "addModelControl", "renderCustomActionsEditor"]
	.map((n) => sliceMethod(n).replace(/^\tprivate /, "\t").replace(/^\t/, ""))
	.join("\n");
const classSrc = stripTypeScriptTypes(`class Tab {\n${methods}\n}`, { mode: "strip" });
const Tab = new Function(
	"t",
	"isGerman",
	"Setting",
	"MODEL_LIST_ID",
	"return " + classSrc + ";"
)(t, isGerman, FakeSetting, MODEL_LIST_ID);

let failures = 0;
function check(label, ok, detail) {
	if (!ok) failures++;
	console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
}

console.log("[settings tab] prompt fields");
{
	const saved = [];
	const tab = new Tab();
	tab.plugin = {
		settings: {
			promptTranslate: "",
			promptExpand: "",
			promptSummarize: "",
			promptGrammar: "",
			customActions: [],
			model: "gpt-4",
		},
		saveSettings: async () => saved.push(1),
		registerCustomActionCommands: () => {},
	};

	// The shipped default: all prompt keys are "" (locale-aware defaults).
	const s = new FakeSetting(new El("div"));
	tab.addPromptControl(s, "promptTranslate");
	const ta = s.settingEl.find((e) => e.tagName === "TEXTAREA")[0];
	check("empty stored prompt shows the localized default", !!ta && ta.value.includes("Übersetzungs-Werkzeug"));
	check("translate default keeps the placeholder", !!ta && ta.value.includes("{TARGET_LANGUAGE}"));
	check("textarea carries the settings class", !!ta && ta.classes.includes("llmta-settings-textarea"));

	ta.value = "Eigener Prompt";
	ta.onChange("Eigener Prompt");
	check("edit lands in settings", tab.plugin.settings.promptTranslate === "Eigener Prompt");
	check("edit is persisted", saved.length === 1);

	tab.plugin.settings.promptExpand = "Mein Prompt";
	const s2 = new FakeSetting(new El("div"));
	tab.addPromptControl(s2, "promptExpand");
	const ta2 = s2.settingEl.find((e) => e.tagName === "TEXTAREA")[0];
	check("stored prompt wins over the default", ta2.value === "Mein Prompt", ta2.value);

	console.log("[settings tab] target language");
	tab.plugin.settings.targetLanguage = "";
	const s4 = new FakeSetting(new El("div"));
	tab.addTargetLanguageControl(s4);
	const langInput = s4.settingEl.find((e) => e.tagName === "INPUT")[0];
	check("empty stored language shows the localized default", langInput.value === "Englisch", langInput.value);

	console.log("[settings tab] model field");
	tab.modelsCache = ["llama3", "gpt-4o"];
	const s3 = new FakeSetting(new El("div"));
	tab.addModelControl(s3);
	const input = s3.settingEl.find((e) => e.tagName === "INPUT")[0];
	const datalist = s3.settingEl.find((e) => e.tagName === "DATALIST")[0];
	const button = s3.settingEl.find((e) => e.tagName === "BUTTON")[0];
	check("input points at the datalist", input && input.attrs.list === MODEL_LIST_ID, input && input.attrs.list);
	check("datalist uses the shared id", datalist && datalist.id === MODEL_LIST_ID);
	check("cached models are pre-filled", datalist && datalist.children.length === 2);
	check("load-models button exists", !!button);

	console.log("[settings tab] custom actions");
	tab.plugin.settings.customActions = [
		{ emoji: "⚡", title: "Kürzen", prompt: "p1" },
		{ emoji: "🔥", title: "Formell", prompt: "p2" },
	];
	const host = new El("div");
	tab.renderCustomActionsEditor(host);
	const cards = () => host.find((e) => e.classes.includes("llmta-custom-action"));
	const addBtn = host.find((e) => e.tagName === "BUTTON" && e.textContent.includes("Neue Aktion"))[0];
	check("one editor card per action", cards().length === 2, cards().length);
	check("add button is rendered", !!addBtn, addBtn && addBtn.textContent);

	addBtn.click();
	check("add appends an action", tab.plugin.settings.customActions.length === 3);
	check("editor re-renders after add", cards().length === 3, cards().length);

	cards()[0].find((e) => e.classes.includes("llmta-remove-btn"))[0].click();
	check("remove deletes the action", tab.plugin.settings.customActions.length === 2);
	check("editor re-renders after remove", cards().length === 2, cards().length);
}

if (failures > 0) {
	console.error(`\n${failures} assertion(s) FAILED`);
	process.exit(1);
}
console.log("\nAll settings-tab checks passed");
