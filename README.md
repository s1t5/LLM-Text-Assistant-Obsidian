# 🤖 LLM Text Assistant — Obsidian-Plugin

**Text in Obsidian-Notizen mit jedem OpenAI-kompatiblen LLM verarbeiten, übersetzen und verbessern — direkt im Editor**

Dieses Plugin ist die Obsidian-Variante der Browser-Erweiterung LLM Text Assistent (Chrome/Firefox/Thunderbird) — gleiche Aktionen, gleiche System-Prompts, gleiches Streaming-Verhalten, angepasst an den Obsidian-Editor.

## ✨ Features

- **Vier Built-in-Aktionen**: 🌐 Übersetzen, ✍️ Ausformulieren, 📋 Zusammenfassen, ✅ Rechtschreibung & Grammatik — per Kommando-Palette, Ribbon-Icon, Rechtsklick-Kontextmenü oder Fuzzy-Suche-Menü
- **Custom Actions**: Eigene Aktionen mit Emoji, Titel und System-Prompt
- **Freier Prompt (Chat-Modus)**: Chat-Fenster mit der aktuellen Auswahl als Kontext; mehrere Anweisungen nacheinander, Ergebnis per „Übernehmen" in den Editor
- **Streaming (Live-Tippen)**: Text erscheint Token für Token während das Modell generiert
- **Undo-Toast**: Nach jedem Ersetzen erscheint ein Toast mit Rückgängig-Button (8 Sekunden)
- **Abbrechen**: Laufende Anfrage per Klick auf den „Verarbeite…"-Toast stoppen; bereits empfangener Text bleibt
- **Robuste Fehlerbehandlung**: Konfigurierbares Timeout (Standard 60 s), automatische Retries bei Netzwerkfehlern und Rate-Limits (429/5xx), klare Fehlermeldungen
- **Ohne Auswahl**: wird die ganze Notiz verarbeitet
- **Zweisprachig**: UI und Standard-Prompts auf Deutsch und Englisch (folgt der Obsidian-Sprache)

## 🚀 Installation

### Variante A: Manuell aus dem Release (empfohlen)

1. Lade `main.js`, `styles.css` und `manifest.json` aus dem neuesten Release bzw. aus diesem Repository herunter.
2. Öffne Obsidian → **Einstellungen → Community-Plugins** → schalte den **Restricted Mode** (Sicherheitsmodus) aus, falls noch nicht geschehen.
3. Klicke bei „Community-Plugins" auf das Zahnrad → **Plugin aus Dateien installieren** (ab Obsidian 1.8) und wähle die drei Dateien — **oder**:
4. Lege den Ordner `<dein-Vault>/.obsidian/plugins/llm-text-assistant/` an und kopiere `main.js`, `styles.css` und `manifest.json` hinein.
5. Aktiviere das Plugin in der Liste der Community-Plugins (**„LLM Text Assistant"** → On).
6. Konfiguriere es unter **Einstellungen → LLM Text Assistant** (API-URL, Modell, ggf. API-Key).

### Variante B: Aus dem Quellcode bauen

Voraussetzungen: Node.js ≥ 20 und npm.

```bash
git clone <repository-url>
cd obsidian-llm
npm install
npm run build      # erzeugt main.js
npm run smoke      # Kern-Tests (Streaming, Retry, Abort, i18n)
```

Danach `main.js`, `styles.css` und `manifest.json` wie in Variante A in den Plugin-Ordner kopieren.

**Für Entwicklung mit Auto-Reload:** statt `npm run build` → `npm run dev` laufen lassen und das [Hot-Reload-Plugin](https://github.com/pfrankov/obsidian-hot-reload) verwenden.

## ⚙️ Konfiguration

**Einstellungen → LLM Text Assistant:**

| Einstellung | Beschreibung |
|---|---|
| **API URL** | Chat-Completions-Endpunkt, z. B. `https://api.openai.com/v1/chat/completions` |
| **API Key** | Dein API-Key (bei lokalen Endpunkten leer lassen) |
| **Modell** | z. B. `gpt-4o-mini`, `llama3.1`, `mistral` |
| **Temperature** | Kreativität (0–2, Standard: 0.3) |
| **Timeout (Sekunden)** | Max. Wartezeit pro Versuch (Standard: 60), 2 Retries |
| **Zielsprache** | Sprache, in die übersetzt wird (Standard: Englisch) |
| **System-Prompts** | Pro Aktion anpassbar, `{TARGET_LANGUAGE}`-Platzhalter beim Übersetzen |
| **Custom Actions** | Eigene Aktionen (Emoji, Titel, Prompt) |
| **Freier Prompt** | Chat-Eintrag im Menü anzeigen/ausblenden |

### Lokale Endpunkt-Beispiele

| Anbieter | URL | API Key |
|---|---|---|
| **Ollama** | `http://localhost:11434/v1/chat/completions` | leer lassen |
| **LM Studio** | `http://localhost:1234/v1/chat/completions` | leer lassen |
| **llama.cpp Server** | `http://localhost:8080/v1/chat/completions` | leer lassen (oder dein konfigurierter Key) |

## 📖 Verwendung

1. Text im Editor markieren (ohne Markierung wird die **gesamte Notiz** verarbeitet)
2. Aktion wählen per:
   - Rechtsklick → Kontextmenü → Aktions-Eintrag
   - Kommando-Palette (`Strg/Cmd+P`) → „LLM Text Assistant: …"
   - Ribbon-Icon ✨ → Fuzzy-Suche-Menü
3. Das Ergebnis ersetzt die Auswahl **live** (Streaming)
4. **Abbrechen**: Klick auf den „Verarbeite…"-Toast
5. **Rückgängig**: Button im grünen Toast (8 s)

### Freier Prompt (Chat)

Rechtsklick → **💬 Freier Prompt** (oder via Ribbon-Menü). Es öffnet sich ein Chat-Fenster:
- Die aktuelle Auswahl wird als Kontext geladen
- Anweisungen nacheinander senden, z. B. „Verbessere den Text", „Übersetze ins Englische"
- **✓ Übernehmen** schreibt das Ergebnis in den Editor (ersetzt die Auswahl bzw. fügt am Cursor ein)
- **↺ Zurücksetzen** startet den Chat mit frischem Kontext neu

## 🏗️ Entwicklung

```
obsidian-llm/
├── src/
│   ├── main.ts         # Plugin-Kern: Commands, Kontextmenü, Streaming-Replace, Undo-Toast, Settings-Tab
│   ├── llm.ts          # OpenAI-kompatibler Client: Streaming, Timeout, Retry, SSE-Parsing
│   ├── chat-modal.ts   # Freier-Prompt-Chat (Modal)
│   ├── menu-modal.ts   # Fuzzy-Suche-Aktionsmenü
│   ├── i18n.ts         # UI-Texte + Standard-Prompts (de/en)
│   └── settings.ts     # Settings-Modell
├── styles.css          # Chat-/Settings-Styles
├── scripts/smoke.ts    # Kern-Tests ohne Obsidian-Runtime
├── manifest.json
├── esbuild.config.mjs
└── tsconfig.json
```

```bash
npm run build      # TypeCheck + Bundle → main.js
npm run typecheck  # nur TypeScript-Check
npm run smoke      # Kernlogik-Tests (benötigt Node ≥ 22.6)
```

## 🔒 Datenschutz

- **Keine Datenerhebung**: API-Calls gehen direkt vom Client an den konfigurierten Endpunkt — kein Zwischenserver
- Der API-Key wird nur in den Plugin-Einstellungen deines Vaults gespeichert (`.obsidian/plugins/llm-text-assistant/data.json`) und ausschließlich als `Authorization`-Header an den konfigurierten Endpunkt gesendet

## 🤝 Beitragen

Für Änderungen Dritter bitte vorab per E-Mail an mail@s1t5.dev koordinieren. Bugreports und Feature-Wünsche gerne als Issue.

---

📄 *Lizenz: GNU General Public License v3 (siehe LICENSE-Datei)*