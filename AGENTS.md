# AGENTS.md

This repository contains the **LLM Text Assistant** plugin for **Obsidian** — the Obsidian edition of the [LLM Text Assistant browser extension](https://git.schrrs.de/s1t5/LLM-Text-Assistant) (Chrome/Firefox/Thunderbird) by the same author.

## Project structure

| File/Folder | Purpose |
|---|---|
| `manifest.json` | Obsidian plugin manifest (id, version, minAppVersion) |
| `src/main.ts` | Plugin core: commands, context menu, streaming replacement, undo toast, settings tab (imperative `display()` + declarative `getSettingDefinitions()`) |
| `src/llm.ts` | OpenAI-compatible Chat Completions client: `requestUrl` network layer, timeout, retries (408/429/5xx), buffered SSE parsing, abort handling |
| `src/chat-modal.ts` | Free Prompt chat modal (context loading, streaming bubbles, copy, apply, reset) |
| `src/menu-modal.ts` | Fuzzy-search action menu (ribbon icon) |
| `src/i18n.ts` | UI strings and default system prompts (de/en), selected by Obsidian locale |
| `src/settings.ts` | Settings model (`DEFAULT_SETTINGS`) |
| `styles.css` | Chat modal, settings and toast styles |
| `scripts/smoke.ts` | Core-logic tests without an Obsidian runtime (mocks `requestUrl` via `scripts/smoke-hook.mjs`) |
| `.github/workflows/release.yml` | Auto-release on version bump (see below) |
| `main.js` | Build artifact (bundled by esbuild, committed for releases) |

## Build & test

```bash
npm install
npm run build      # tsc type-check + esbuild bundle → main.js
npm run typecheck  # TypeScript check only
npm run smoke      # core tests: i18n, SSE parsing, JSON fallback, retry, abort
npm run dev        # esbuild watch mode
```

- Node.js ≥ 20, npm. No Obsidian installation needed for build/smoke tests.
- `npm run smoke` uses `--experimental-strip-types` (Node ≥ 22.6) with a loader hook that mocks the typings-only `obsidian` package; `src/llm.ts`'s `requestUrl` import is rewritten to `scripts/obsidian-mock.ts`.
- Never edit `main.js` directly — it is generated. Change `src/`, then `npm run build`.

## Conventions

### i18n

Every user-facing string lives in `src/i18n.ts` as a key of the `I18nKey` union — **never hardcode UI text** in components. Add the key and its German **and** English text in the same change. Default system prompts (`defaultPromptTranslate`, …) are also localized; they are **not** part of `DEFAULT_SETTINGS` (kept empty) so the effective default stays locale-aware. Settings UI shows the effective prompt: stored value, else the localized default; an empty field falls back to the default.

### Obsidian API guidelines

The plugin must pass the community directory review (obsidianmd/obsidian-releases). Relevant rules observed here — keep them intact:

- Use `requestUrl` (not `fetch`) for network requests; it has no native abort, so `performRequest` races the user-facing abort signal.
- No inline `el.style.*` assignments — use CSS classes / `toggleClass` (`is-hidden`).
- Use `createEl`/`createDiv`/`createSpan` (Obsidian's helpers), not `document.createElement`.
- `Setting.setHeading()` instead of raw `h2`/`h3` elements.
- `window.setTimeout`/`window.clearTimeout` (popout window compatibility).
- Fire-and-forget promises marked with `void`, or `.catch`-ed.
- `notice.messageEl`, not the deprecated `noticeEl`.
- Command IDs must not contain the plugin ID (Obsidian prefixes it automatically).

### Settings search (1.13+)

`getSettingDefinitions()` in `src/main.ts` mirrors `display()` declaratively so settings appear in Obsidian's settings search. When adding a setting, update **both** `display()` and `getSettingDefinitions()`, plus `src/settings.ts`.

### Versioning & release

- Version format strictly `x.y.z` (SemVer, no `v` prefix). Bump `manifest.json` **and** `package.json` together.
- Push to `main` with a new `manifest.json` version → `.github/workflows/release.yml` builds, attests and publishes a GitHub release named exactly like the version, with `main.js`, `manifest.json`, `styles.css` attached. No manual tagging needed.
- Fix-only pushes without a version bump skip the release cleanly.
- First submission to the community directory happens via https://community.obsidian.md (Obsidian account + linked GitHub); after publication, updates flow to users automatically through GitHub releases.

### Committing

- `main.js` is regenerated on every build and committed alongside `src/` changes — never commit `src/` changes without rebuilding.
- Keep commits in English, conventional style (e.g. `feat:`, `fix:`, `docs:`).

## Pitfalls

- **`llm.ts` parameter properties**: `constructor(private config: …)` breaks `--experimental-strip-types` in the smoke tests — use explicit property declarations.
- **Static imports in `scripts/smoke.ts`**: the obsidian mock must be registered via `register()` **before** importing `src/llm.ts`; use dynamic `await import()` there.
- **`requestUrl` headers**: `response.headers` keys are lower-case (`content-type`); the code checks both spellings.
- **`MenuItem.submenu`** is not part of the public typings — the editor context menu uses flat items.
- **`PluginSettingTab.getSettingDefinitions()`** requires `SettingGroupItem` (not the wider `SettingDefinitionItem`) inside group `items`.
- **esbuild banner**: keep it a single block comment — a `*/` in the middle truncates the file into invalid syntax.