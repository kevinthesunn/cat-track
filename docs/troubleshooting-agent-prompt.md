# Task: machine-scoped troubleshooting agent for Cat Track

Repo: `/Users/kevinyang/cat-track` (Node 22+, Express 5, `node:sqlite`, plain HTML/JS front end, no build step). Earlier notes call this app "Total CAT". Same app.

## What already exists. Reuse it, don't rebuild it.

| File | What it gives you |
|---|---|
| `server/agent.js` | Q&A agent: Claude tool loop (`search_memory`, `get_machine`, `find_fixes`, …) plus the offline `rulesAnswer` fallback. Its retrieval is **fleet-wide on purpose**, so don't reuse it unchanged for this. |
| `server/memory.js` | `normalizeAssetId`, `recallSimilar` (fleet-wide similarity), `rankFixes` (Laplace-smoothed success rate), `assetMemory` |
| `server/graph.js` | `nodes` / `edges` tables. Node ids are `type:slug` (`asset:ex-0412`, `code:cid-110-fmi-15`, `component:hydraulic-hose`) |
| `server/vocab.js` | Canonical components, symptoms, conditions, hazards, and the fault-code regex (`extractFaultCodes`) |
| `server/extract.js` | Structured extraction (Claude structured outputs + rule engine). Copy its pattern. |
| `server/db.js` | Schema. The DB path is hard-coded to `data/cattrack.db`. |
| `public/operator.html`, `public/js/operator.js` | Phone UI with unit ID box, QR scanner and dictation. Reuse these for input. |

Nothing exists yet for: a document store, machine configuration, a test framework, or retrieval logging.

## Goal

An operator gives a **unit ID**, the **problem in their own words**, and optionally a **fault code** and **location or operating context**. The agent answers with troubleshooting guidance built **only** from records that belong to that unit, or that are explicitly marked as applying to it. Every statement cites the record it came from.

## Scope rule (the core requirement)

For a request on unit **U** (model **M**, configuration **K**), a record is in scope only if it is one of:

1. **Unit record:** a report, repair, alert, memory fact or telemetry entry with `asset_id = U`.
2. **Applicable document or fix:** its `applies_to` names U, or names model M with a configuration compatible with K.
3. **Fleet reference:** a record from another unit of model M with compatible configuration. It is labelled "fleet reference", ranked below unit records, and never presented as U's own history.

Everything else is excluded: other models, incompatible configurations, other units' hazards. **Unknown applicability counts as excluded.** Write compatibility as one function (`isCompatible(record, asset)`) so it can be tested directly.

## Data model changes (additive only)

- `assets.config` (JSON): engine variant, attachments, hose/boom kit, software version. In the seed, give two Cat 336 units **different** configs so cross-config exclusion can be tested.
- New `documents` table: `id, title, doc_type (procedure | bulletin | spec | manual_excerpt), body, fault_codes, components, applies_to {asset_ids, models, config}, source, version, confidence, created_at`. Seed about 10 documents, each clearly marked **"Demo content — not a Caterpillar procedure."** Never write text that presents itself as an official Caterpillar procedure.
- `fixes.applies_to`, same shape. Existing fixes default to their own model.
- Graph: add `document` nodes and these edges: `DOCUMENTS` → asset/model, `COVERS` → code/component, `TYPICALLY_SHOWS` code → symptom. `INDICATES` code → component already exists.
- New `retrieval_log` table (see Observability).

## Pipeline

1. **`parseTroubleshootQuery(input)`** → `{ assetId, faultCodes[], components[], symptoms[], conditions[], location, freeText, missing[] }`. Use `vocab.js` and `extractFaultCodes`. Use Claude structured outputs when a key is set, rules otherwise.
2. **`retrieve(query)`** → candidates, each `{ recordType, recordId, assetId, model, scope: 'unit' | 'applicable' | 'fleet_reference', score, reasons[], source }`. The scope filter runs **before** ranking.
3. **Rank.** Starting weights: same unit 5, fault-code match 4, component 2.5, symptom 2, condition/location 1. Multiply by a recency decay and by the record's confidence. Fleet references ×0.5. Drop anything below a threshold.
4. **`assertScoped(context, asset)`** runs again right before the prompt and removes any record that fails `isCompatible`. This is the safety net, and tests target it directly.
5. **Answer.** Call Claude with only the scoped context, using this structured-output schema:
   ```
   { safety_first: string|null,
     confirmed_facts: [{ text, sources[] }],
     history:         [{ text, sources[] }],   // past incidents on this unit (+ labelled fleet refs)
     steps:           [{ text, sources[], caution }],
     unknowns: [string], applicability_warnings: [string],
     sources: [{ id, type, title }] }
   ```
   Validate the output: every fact and step must cite at least one source id **that is in the context**. Drop or flag anything uncited, and reject any source id that isn't in the context. The offline fallback builds the same shape from the same scoped records.
6. **Fallbacks:**
   - No unit ID: ask for it. Never guess.
   - Unknown unit: not-found message with close matches.
   - Unknown fault code: say so, then continue on symptoms.
   - Nothing relevant: "Nothing on record for this on U", general safety advice, and an offer to create an action item or escalate to engineering.
7. **Safety:**
   - Critical keywords (fire, smoke, brakes, steering, injury): lead with stop, park and lock out.
   - Never suggest bypassing interlocks or guards.
   - Steps drawn from demo or low-confidence sources carry "verify against the service manual."

## API and UI

- `POST /api/troubleshoot {assetId, text, faultCode?, location?, personId?}` → `{ answer, context[], logId }`
- Operator screen: add a **Troubleshoot** mode next to **Report**, reusing the unit ID, QR and dictation controls. Render each answer section with source chips linking to the unit's history (`/asset?id=…`) or the document. Show unknowns and applicability warnings above the steps, not below.
- Do **not** change the existing report flow or how `/api/ask` behaves.

## Tests (built-in `node:test`, no new dependencies)

- Make the DB path configurable (`CAT_TRACK_DB`; `:memory:` or a temp file) and seed fixtures per test. Add `npm test`.
- Required cases:
  - EX-0412 hose leak: EX-0412 records come first; no HT/WL/DZ records in context.
  - Two 336s with different configs: the config-specific document for one is excluded for the other.
  - `CID 110 FMI 15`: retrieves the cooling document for the 777s only.
  - Natural-language symptom with no code: retrieves by symptom and component.
  - History lookup for one unit.
  - Missing unit ID: asks for it.
  - Unknown unit, and unknown error code.
  - No matching documents: fallback answer.
  - Conflicting documents (two versions): newer or higher-confidence wins, and the conflict appears in `applicability_warnings`.
  - Low-confidence source: produces a warning.
  - `assertScoped` drops an injected cross-machine record.
  - Answer validator drops an uncited step and rejects an invented source id.

## Observability

Each request writes a `retrieval_log` row with:
- the structured query
- the selected unit
- candidates considered (ids and scores)
- included records
- excluded records with the reason
- sources cited
- failures
- cross-machine and low-confidence flags

Log person **ids**, not names, and don't log raw free text beyond the parsed fields. Add `GET /api/troubleshoot/logs/:id` so a reviewer can see why each record was chosen.

## How to work

1. Read the files in the table above. Post a plan of 15 bullets or fewer, with your assumptions. Wait for a go-ahead **only** if a change is not additive (alters existing behavior, renames columns, changes `/api/ask`).
2. Build in this order:
   1. Config and documents schema, plus seed data
   2. Query parser
   3. Scoped retrieval and `assertScoped`
   4. Ranking and the retrieval log
   5. Answer schema and validator
   6. API
   7. Operator UI
   8. Tests
3. **Done when:**
   - `npm test` passes.
   - Every answer section cites sources.
   - Manual runs on EX-0412, EX-0601, HT-0761 and WL-0241 show no out-of-scope record in context (show the log for each).
   - Offline mode still works with no API key.

**MVP:** steps 1–6 plus the scope tests. **Stretch:** the operator UI mode and a document viewer page.
