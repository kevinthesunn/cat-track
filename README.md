# Cat Track — Memory for Physical AI

Cat Track gives every Caterpillar machine and job site a persistent memory. Field input (dictated voice notes, typed reports, photos, telemetry anomalies, repairs) is understood, woven into a growing **knowledge graph**, and turned into:

- **Alerts and action items** for the people on the job site
- **Recall** of similar past events across the fleet, plus the fixes that actually worked
- **Escalation to CAT Engineering** for mechanical failures, aggregated into fleet-wide cases
- **Feedback from the field.** Engineers push quick fixes back to crews, technicians report what fixed it, and every outcome changes how future fixes are ranked.

## Quick start

```bash
npm install
npm run demo        # server on :3000 + ngrok HTTPS tunnel, prints the phone link
# or
npm start           # local only: http://localhost:3000
npm run reseed      # wipe and regenerate the demo fleet + history
```

**AI provider (optional).** Put an OpenAI-compatible endpoint in `.env` (see `.env.example`). It's currently set to Groq (`openai/gpt-oss-120b` for reports and questions, `qwen/qwen3.8-27b` for documents), which answers in well under a second. Anthropic also works via `ANTHROPIC_API_KEY`. With no provider, the offline rule engine does everything.

**Every live report is understood first, then acted on.** The AI (or the rule engine, if AI is off or slow — 15 s limit, `AI_SYNC_TIMEOUT_MS`) works out the intent and what it refers to:

| Intent | Example | What Cat Track does |
|---|---|---|
| New problem | "Boom hose leaking at the foot" | Files it, alerts the right people on site, opens/updates the engineering case |
| Update | "Still overheating, now in the red after one climb" | Adds it to the open issue (raises severity if worse) instead of opening a duplicate |
| Resolved | "Fixed it — bled the brakes and replaced the pads" | Closes the referenced alert and its tasks, records the repair, learns the fix (only if a real repair is described). Ambiguous → asks "Which issue did you fix?" |
| Advice | "Coolant warning just came on, what should I do?" | Returns 2–4 next steps (and still files the problem) |
| Help | "Need a technician and a hose out here" | Creates a task for the right role and alerts them |
| Question | "When is the next service due?" | Answers from the machine's record |
| Correction | "I meant the stick cylinder, not the boom" | Withdraws the earlier report: closes its alert, removes it from its engineering case, files the corrected one |
| Delete | "Delete my last report", "remove the hose leak report from August" | Takes the report(s) off the record: closes their alerts and tasks, reopens an issue a deleted repair had closed, forgets a fix learned only from it, removes it from its engineering case and from the knowledge graph. Unclear → asks which; more than 3 → asks to confirm. Every delete can be undone |
| Routine | "Walkaround done, all good" | Logs it, pages nobody |

Issue types on the map (computed from each report by `issueClass` in `server/vocab.js`): **Safety hazard** (people at risk), **Malfunction** (overheating, warnings, fault codes, power, controls), **Wear & damage** (leaks, cracks, noise, worn parts), **Weather & ground** (rain, heat, dust, mud), **Logistics** (fuel, parts, crew, deliveries), **Repair & service**, and **Note or question**.

Deleting only ever starts from the person's own words (a delete word has to be in what they said), and only reaches reports on the machine they're on. Deleted reports move to `report_trash` with everything needed to restore them; `/reports` → **Deleted** lists them with who deleted them and what they said.

How the AI is used elsewhere, given that some endpoints queue requests:
- **Reports:** the rule engine files the report and alerts the crew in under a second. The model then reviews it in the background. When it finishes, the report, alert, graph and the operator's result card update live: sharper summary and guidance, likely causes, missed parts or symptoms, and severity can go up but never down.
- **Questions ("Ask the record"):** an instant answer comes straight from the record. The model's answer replaces it when it arrives. With an OpenAI-compatible provider the agent gathers the relevant records first and makes one call (`AI_AGENT_MODE=tools` switches to multi-turn tool calling).
- **Case root-cause analysis:** the rule engine's count shows immediately, and the model's write-up replaces it.

Phones need **HTTPS** for the microphone and camera. The ngrok link provides it.

## The four tabs

| Tab | Path | What |
|---|---|---|
| **Dashboard** | `/` (`?site=S1` for one site) | Everything on the job sites at a glance: machines needing attention, open alerts (mark seen, log the repair), latest reports, machines with health and live sensor readings, tasks by role, CAT Engineering's open cases, "Ask the record", and links to the engineering portal, product library and QR tags |
| **Reports** | `/reports` | The log of every report, newest first; new ones drop in live and flash. Filter by words, site, machine, person, type of issue and open issues. Open a report to read it, **edit** it (headline, urgency, part, problem, type of issue, what was said; a new part or problem re-links it on the graph, and every edit is recorded), add **notes**, or **delete** it (undo, or restore from the Deleted tab) |
| **Graph** | `/graph` | The site map: job sites → machines → reports, each report coloured by urgency with an icon for its type of issue. Side panel has two tabs: Filters (site, time, urgency, type, open only, more layers) and Coming in (each report as it's received and processed). Zoom and pan are limited so the map can't be lost |
| **Operator** | `/operator` | Phone screen: who's reporting, machine ID box and **QR scanner**, machine card, the **big mic button**, photo, result card, site alerts and the machine's earlier reports |

Reached from the Dashboard: `/engineering` (fleet cases, quick fixes, design changes), `/library` (spec sheets and policies for the document agent), `/tags` (printable QR tags) and `/asset?id=EX-0412` (one machine's full history). `/site` redirects to the Dashboard.

**Voice capture.** The mic button records on the phone and the server transcribes it with Whisper on the same Groq key (`whisper-large-v3-turbo`, primed with Cat part names and codes). That works on iPhone Safari, Android Chrome, Firefox and desktop browsers, and in engine noise. A ring around the button follows your voice; a 3.5 s pause after speaking stops it hands-free; switching apps stops it cleanly. Without a speech model (`AI_STT_MODEL=off`, or a non-Groq provider) it falls back to the browser's own recognition, run one phrase at a time on phones (continuous mode repeats words on Android and stalls on iPhone).

## Demo script (about 3 minutes)

1. Open `/` on the laptop and scan the QR code with a phone to get `/operator`.
2. On the phone, tap **Scan** and point it at a tag on `/tags` (e.g. **EX-0601**). The unit card loads with its health, hours and memory ("Part of fleet pattern: Cat 336 hydraulic hose leak…").
3. Tap the big **Dictate** button and say *"Boom hose is leaking again near the frame bracket, dripping steady, hot day."* Then tap **Send**.
4. Back on the laptop:
   - The Dashboard shows the alert flash in, with crew action items including *"Try known fix… (71% field success)"*.
   - `/engineering` shows case **Cat 336 — Hydraulic hose: leak** with one more report across 3 machines and 3 sites. Click **Analyze field evidence**, then **Issue quick fix to field**. Every site running a 336 gets the bulletin, and the phone shows it live.
   - The Graph tab shows each report arrive under "Coming in" (received → understood → alerted), then flies to it on the map.
5. On the Dashboard, open the alert and click **Log the repair**, choose the known fix, and type what you did. That fix's success rate goes up, a repair record joins the machine's lifecycle, and its health recovers.
6. Turn on **Sensors** on the Dashboard. Simulated sensor anomalies go through the same pipeline.

## Architecture

```
server/
  index.js      Express API + SSE + static panels
  pipeline.js   ingest → extract → graph → recall → alerts/actions → engineering case → publish
  extract.js    rule-engine extraction + model extraction (JSON) with machine memory as context
  vocab.js      canonical components / symptoms / conditions / hazards (keeps the graph consistent)
  graph.js      knowledge graph (nodes + weighted edges that strengthen on repeat observation)
  memory.js     similarity recall, Laplace-smoothed fix ranking, distilled asset facts, role insights
  agent.js      record agent: instant rule answer, then a model answer (gathered context or tool calling:
                search_memory, get_machine, find_fixes, create_action_item, notify_site, …); case analysis
  llm.js        provider layer: OpenAI-compatible endpoints (NVIDIA etc.) or Anthropic
  docs.js       product library + document agent: read PDF/DOCX/text → extract → match → new graph branches; document search
  telemetry.js  sensor simulator; threshold breaches become telemetry observations
  seed.js       11 machines, 3 sites, ~4 months of history replayed through the real pipeline
  db.js         node:sqlite (built in, no native deps) → data/cattrack.db
public/         plain HTML/CSS/JS panels (no build step); vis-network for graphs, jsQR for scanning
```

**How it learns from field outcomes:** each fix's confidence is `(worked + 1) / (worked + failed + 2)`. Thumbs up/down on the operator panel, choosing a fix when resolving an alert, and new repairs described in free text all update it. A new repair description becomes a new learned fix. Recurring problems, environmental correlations (e.g. *overheating* with *high ambient heat*) and fleet-pattern membership are distilled into each machine's memory.

All machines, people and history are demo data.
