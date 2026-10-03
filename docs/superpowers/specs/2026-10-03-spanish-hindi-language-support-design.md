# Spanish and Hindi language support — design

Date: 2026-10-03. Approved by Kevin in chat (approach B, plus Hindi).

## Goal

Field crews who speak Spanish or Hindi can use every Cat Track screen, dictate or type a report in their language, and get the troubleshooting answer, advice and spoken replies back in that language. Nothing about the knowledge graph forks by language: a Spanish "fuga en la manguera hidráulica" and an English "hydraulic hose leak" land on the same component and symptom nodes, so fixes learned in one language help operators in another.

## Decisions (from the brainstorm)

| Question | Decision |
| --- | --- |
| Scope | Full bilingual: UI, understanding spoken/typed reports, agent replies, speech in/out |
| Picking a language | Browser language by default (`es*` → es, `hi*` → hi, else en), with an **EN / ES / हिं** picker in the header that overrides and is remembered in `localStorage` |
| What is stored | **As spoken.** The report's `raw_text`, `summary`, `operator_guidance`, advice and action items are kept in the reporter's language. Entity keys (components, symptoms, conditions, hazards, severity, intent) stay canonical English so the graph is shared |
| Existing English data | Left in place. UI chrome and agent replies are translated; historical English snippets are shown as they are |
| Languages | `en`, `es`, `hi` (Devanagari and Roman-script Hinglish both understood) |

## Client

- `public/js/i18n.js` (loaded before `common.js` on every page): resolves the language, exposes `I18N = { lang, locale, speech, t, setLang, apply, picker, LANGS }`, and `CT.t` is the same `t`.
- Catalogs `public/i18n/es.js` and `public/i18n/hi.js` register `window.CT_I18N.es` / `.hi`. **English text is the key**: `t('Send report')`. A missing key falls back to the English text, so a half-translated catalog never blanks a label. Variables use `{name}` placeholders: `t('Send report on {id}', { id })`.
- Static HTML: elements with `data-i18n` are translated from their English text content at boot; `data-i18n-attr="placeholder,aria-label,title"` translates attributes.
- Panels (`dashboard.js`, `reports.js`, `graph.js`, `engineering.js`, `library.js`, `asset.js`, `operator.js`, `common.js`) wrap every user-visible literal in `t()`. Vocabulary names coming from the server (`Hydraulic hose`, `Leak`, `High`) are translated at render time with `t(name)`; catalogs include the vocabulary.
- Dates and relative times use `Intl` with the active locale (`en-US`, `es-MX`, `hi-IN`).
- Operator page: speech recognition and speech synthesis use `I18N.speech`; server transcription is called with `?lang=`; reports and questions carry `lang`; the "sample report" list switches to Spanish / Hindi sentences.

## Server

- `server/i18n.js`: `LANGS`, `normalizeLang`, `detectLang(text, hint)` (Devanagari → `hi`; Spanish stop-words/diacritics → `es`; Roman Hinglish markers → `hi`; else the client's hint; else `en`), `t(lang, key, vars)` for the rule engine's own sentences, `vocabName(lang, name)` for canonical names, `langName(lang)` for prompts.
- `server/vocab.js`: every component, symptom, condition and hazard gains `es` and `hi` regexes (accent-stripped Spanish; Devanagari + Hinglish). `matchAll`/`canonical`/hazard matching test all three. Text is normalised (lower-case, diacritics stripped) before matching.
- `server/extract.js`: intent and severity regexes gain Spanish/Hinglish alternatives; rule-engine summary, guidance, action items and memory facts are produced through `t(lang, …)`; the model prompt says the note may be in any of the three languages, asks for canonical English entity names, and asks for all free text in the note's language.
- `server/pipeline.js`: `lang = detectLang(text, input.lang)` is stored on the report (`reports.lang`, additive migration) and passed to extraction, the troubleshooting agent and the question agent.
- `server/troubleshoot.js` and `server/agent.js`: rule-engine sentences through `t(lang, …)`; model prompts told to answer in the language.
- `server/llm.js` `transcribe(buffer, mime, lang)`: Whisper `language` and a per-language vocabulary prompt.
- `server/index.js`: `/api/reports` and `/api/ask` accept `lang`; `/api/transcribe?lang=`.

## Error handling

- Unknown or missing language → `en`. Missing catalog key → English text. Speech voices unavailable for the language → the browser's default voice is used; recognition unavailable → the existing "type below" path.
- Detection never overrides a clear script signal (Devanagari always wins); the client hint only breaks ties.

## Testing

- `node --check` on every changed file.
- Offline API run: Spanish and Hindi (Devanagari and Hinglish) reports for the hose leak, overheating with a fault code, a "fixed it" note, an advice question and a delete request; assert canonical entities, intent, `lang`, and that guidance/solution text is in the report's language.
- Browser: switch the header picker to ES and हिं on the operator page and dashboard; confirm chrome, sample reports, result card and graph legend are translated; confirm English fallback for untranslated keys.
