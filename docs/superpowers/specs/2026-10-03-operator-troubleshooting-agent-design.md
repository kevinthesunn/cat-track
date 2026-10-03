# Operator troubleshooting agent — design

Date: 2026-10-03. Approved scope: lean, integrated into the existing report flow. Grounding: this machine's own records first, plus fixes and resolutions from other machines of the same model, labelled as such and ranked lower.

## Goal

When an operator files a problem or a question on the operator screen, Cat Track answers with a specific, actionable response built only from records that belong to that machine (or are explicitly applicable to its model). The problem goes onto the knowledge graph coloured by its classified severity; when it is solved it turns green, and the solution is reused for later, similar problems.

## What already exists and is reused

- Severity classification (rule engine, model can raise it) and the severity colouring of report nodes on `/graph`.
- Fix learning on alert close (`closeAlert` → `fixes` row, Laplace-smoothed confidence), `rankFixes`, `recallSimilar`.
- SSE bus and the operator card's live-update pattern (`report-updated`).
- Document search (`searchDocs`) and machine memory (`assetMemory`).

## Components

### `server/troubleshoot.js` (new)

`gatherAssetContext(asset, ex, text)` returns `{ sources, parts }` where every record carries a source id:

| Source id | Record | Scope label |
|---|---|---|
| `R<id>` | report on this machine (matching part / symptom / code first, then recent) | `this machine` |
| `A<id>` | alert on this machine: open ones, and resolved ones with their resolution text or the repair report that closed them | `this machine` |
| `M<id>` | memory fact on this machine | `this machine` |
| `G` | graph neighbourhood of `asset:<id>` out to 2 hops: parts, symptoms, codes, conditions linked to it, with edge weights (how many times observed) | `this machine` |
| `F<id>` | known fix for this model (field or engineering), with worked/failed counts | `same model` |
| `C<id>` | open engineering case for this model + part | `same model` |
| `D<id>` | product document that applies to this model or all machines | `applies to model` |
| `X<report id>` | resolved report from another machine of the same model with the same part, with what fixed it | `fleet reference` |

Nothing from a different model is ever gathered. Fleet references are capped at 3 and ranked last.

`solve({ asset, ex, text, person })` builds a `Solution`:

```
{ headline, safety_first: string|null,
  do_now:        [{ text, sources: [id], caution? }],
  record_shows:  [{ text, sources: [id] }],
  worked_before: [{ text, sources: [id], confidence_pct?, fix_id?, scope }],
  not_on_record: [string],
  sources: [{ id, type, title, scope, href }],
  mode: 'rules' | 'llm', model?, seconds? }
```

- `rulesSolution(ctx)` builds it instantly from the gathered context (no model).
- `modelSolution(ctx)` calls `structured()` with the same schema and only the gathered context in the prompt.
- `validateSolution(sol, ctx)` removes any source id that is not in `ctx.sources`; items left with no sources are kept but marked `unverified: true` (rendered as "general guidance") except in `record_shows` and `worked_before`, where uncited items are dropped. `safety_first` is forced on when the classifier found a critical hazard or severity.

### Pipeline hook (`server/pipeline.js`)

For live reports with intent in `new_issue`, `update_existing`, `request_advice`, `request_help`, `question` (and a known machine): the rule solution is attached to the response as `out.solution`; if a model is configured, `modelSolution` runs in the background and publishes `solution` `{ reportId, solution }` over SSE. The existing `answer` / `advice` fields are unchanged so other screens keep working.

### Graph: solved turns green

- `public/js/graph.js`: report nodes with `status === 'closed'` are drawn green (`#3fa66b`) with a check icon and full opacity; `withdrawn` stays faded. Legend gains "green = solved".
- `server/graphview.js`: report nodes carry `resolution` and `fix_id` so the drawer shows "Solved by: …".
- `server/pipeline.js` `closeAlert`: adds `RESOLVED_BY` edge from the original problem report node to the fix node (when a fix was learned or chosen) and relabels the problem node with `{ solved: true, resolution }`. `graphview.js` includes `RESOLVED_BY` in `REPORT_LINKS` so the fix sits next to the solved problem on the map.

### Operator screen

`public/js/operator.js` renders `out.solution` as the first section of the result card:

- Headline + safety line (red when `safety_first`).
- "Do this now": numbered steps, each with source chips (`R12`, `F3`, `D2`); chips link to `/asset?id=…`, `/library?doc=…`, or the engineering case.
- "What this machine's record shows" and "What fixed it before" (with thumbs feedback on the top fix, existing endpoint).
- "Not on record" when the agent could not ground something.
- The card updates live when the `solution` SSE event arrives; TTS reads the `do_now` steps.

## Error handling

- Model failure or timeout: the rule solution stays; the card says so (same wording as today's AI review line).
- Unknown machine: unchanged (404 from `/api/reports`).
- No matching records: `record_shows` is empty, `not_on_record` says "Nothing on record for <part> on <id>", `do_now` falls back to the classifier's guidance.

## Testing

Manual, with no AI key (rule path) and with a key: file "boom hose leaking" on EX-0412 → solution cites only EX-0412 records plus Cat 336 fixes; close the alert from the dashboard with a repair description → node turns green on `/graph`, `RESOLVED_BY` edge appears; file the same problem again → "worked before" cites the new fix. A throwaway script under `/tmp` exercises `validateSolution` with an invented source id.
