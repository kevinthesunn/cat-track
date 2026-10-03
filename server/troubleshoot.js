// Operator troubleshooting agent. When an operator reports a problem, build a specific answer from
// the records that belong to THAT machine: its reports, alerts (open and solved, with what solved
// them), memory facts and its knowledge-graph links. Fixes, cases and documents for the same model
// are allowed but labelled; nothing from another model is ever gathered. Every statement cites the
// record it came from, and a validator throws away any citation that isn't in the gathered context.
import { q, parseJson } from './db.js';
import { nodeId, getNeighborhood } from './graph.js';
import { rankFixes } from './memory.js';
import { searchDocs } from './docs.js';
import { structured, llmEnabled, llmInfo, describeLlmError, contextChars } from './llm.js';
import { sevRank, HAZARDS } from './vocab.js';
import { publish } from './events.js';
import { translator, langName, normalizeLang } from './i18n.js';

// Guidance sentences the rule engine writes that must lead the answer (compared in the report's language).
const SAFETY_GUIDANCE = [
  'Do not keep working with an active hydraulic leak — pressurised oil can cause injection injuries. Lower the boom, shut down and wait for the technician.',
  'Reduce load and let the machine idle to cool before shutting down. Never open a hot radiator cap. A technician has been notified.',
];
const NOTHING_TO_DO = "Thanks — logged to this machine's memory. No action needed right now.";

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const uniq = (arr) => [...new Set((arr || []).filter(Boolean))];
const day = (iso) => String(iso || '').slice(0, 10);
const daysAgo = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 86400000));
const CRITICAL_HAZARDS = new Set(HAZARDS.filter((h) => h.critical).map((h) => h.name));
const WARN = 'Warning / fault code';

export const SOLUTION_INTENTS = new Set(['new_issue', 'update_existing', 'request_advice', 'request_help']);

/** How strongly a past extraction matches what was just reported. */
function overlap(ex, keys) {
  const comps = (ex.components || []).filter((c) => keys.comps.has(c));
  const syms = (ex.symptoms || []).filter((s) => keys.syms.has(s));
  const codes = (ex.fault_codes || []).filter((c) => keys.codes.has(c));
  const conds = (ex.conditions || []).filter((c) => keys.conds.has(c));
  const hz = (ex.safety_hazards || []).filter((h) => keys.hazards.has(h));
  const score = comps.length * 3 + codes.length * 4 + syms.length * 2 + conds.length + hz.length * 2;
  return { score, reasons: [...codes, ...comps, ...syms.map((s) => s.toLowerCase()), ...hz, ...conds.map((c) => c.toLowerCase())] };
}

const alertStatus = (s) => (s === 'resolved' ? 'solved' : s === 'ack' ? 'open, seen' : 'open');

/**
 * Everything on record that bears on this report, scoped to the machine (and, labelled, its model).
 * Returns { sources, parts, keys, mustSafety } — `sources` is the only set of ids an answer may cite.
 */
export function gatherAssetContext(asset, ex, text, { excludeReportId = null, lang = 'en' } = {}) {
  const keys = {
    comps: new Set(ex.components || []), syms: new Set((ex.symptoms || []).filter((s) => s !== WARN)),
    codes: new Set(ex.fault_codes || []), conds: new Set(ex.conditions || []), hazards: new Set(ex.safety_hazards || []),
  };
  const primaryC = ex.components?.[0] || null;
  const primaryS = (ex.symptoms || []).find((s) => s !== WARN) || ex.symptoms?.[0] || null;
  const sources = []; const parts = {};
  // Register a record as citable and return it (the existing one if that id was already added).
  const add = (src) => { const have = sources.find((s) => s.id === src.id); if (have) return have; sources.push(src); return src; };
  const assetHref = `/asset?id=${encodeURIComponent(asset.id)}`;

  // 1. This machine's reports: the ones about the same part / problem / code first, then the latest.
  const rows = q.all(`SELECT r.*, p.name AS person_name FROM reports r LEFT JOIN people p ON p.id = r.person_id WHERE r.asset_id = ? ORDER BY r.created_at DESC LIMIT 80`, asset.id)
    .filter((r) => r.id !== excludeReportId)
    .map((r) => { const e = parseJson(r.extraction, {}); return { ...r, extraction: e, ...overlap(e, keys), retracted: Boolean(e.retracted) }; })
    .filter((r) => !r.retracted);
  const matched = rows.filter((r) => r.score > 0).sort((a, b) => b.score - a.score || b.created_at.localeCompare(a.created_at)).slice(0, 8);
  const recent = rows.filter((r) => !matched.includes(r)).slice(0, 3);
  const alertOf = new Map(q.all(`SELECT id, report_id, status, resolution, resolved_by_report, created_at, updated_at FROM alerts WHERE asset_id = ? AND report_id IS NOT NULL`, asset.id).map((a) => [a.report_id, a]));
  const reportSource = (r, why) => {
    const a = alertOf.get(r.id);
    return add({
      id: `R${r.id}`, type: 'report', scope: 'this machine', href: assetHref, title: r.summary, date: day(r.created_at), days_ago: daysAgo(r.created_at),
      severity: r.severity, category: r.category, status: a ? alertStatus(a.status) : r.category === 'maintenance' ? 'repair' : 'logged',
      said: clip(r.raw_text, 220), by: r.person_name || r.source, matched_on: r.reasons, why,
      ...(a?.resolution ? { solved_by: clip(a.resolution, 200) } : {}),
    });
  };
  parts.this_machine = { id: asset.id, model: asset.model, family: asset.family, site: asset.site_name, climate: asset.site_climate, smu_hours: Math.round(asset.smu_hours), health: asset.health, status: asset.status };
  parts.matching_reports_on_this_machine = matched.map((r) => reportSource(r, 'same part, problem or code'));
  parts.latest_reports_on_this_machine = recent.map((r) => reportSource(r, 'recent'));

  // 2. Alerts on this machine: what's open now, and what was solved before (with what solved it).
  const alerts = q.all(`SELECT * FROM alerts WHERE asset_id = ? AND kind IN ('mechanical','safety','operational') ORDER BY created_at DESC LIMIT 40`, asset.id)
    .filter((a) => a.report_id !== excludeReportId) // the alert this very report just opened is not "already open"
    .map((a) => { const rep = a.report_id ? rows.find((r) => r.id === a.report_id) || hydrate(a.report_id) : null; return { ...a, rep, ...(rep ? overlap(rep.extraction, keys) : { score: 0, reasons: [] }) }; });
  const openAlerts = alerts.filter((a) => a.status !== 'resolved').slice(0, 5);
  const seenSolution = new Set();
  const solvedAlerts = alerts.filter((a) => a.status === 'resolved' && a.score > 0).slice(0, 8)
    .map((a) => ({ ...a, solution: solutionText(a, asset.id) }))
    // Two old alerts closed by the same repair would say the same thing twice; keep the latest.
    .filter((a) => { if (!a.solution) return false; const k = a.solution.text.toLowerCase(); if (seenSolution.has(k)) return false; seenSolution.add(k); return true; })
    .slice(0, 4);
  const alertSource = (a) => add({
    id: `A${a.id}`, type: 'alert', scope: 'this machine', href: assetHref, title: a.title.replace(`${asset.id} · `, ''), status: alertStatus(a.status),
    severity: a.severity, opened: day(a.created_at), days_ago: daysAgo(a.created_at), matched_on: a.reasons,
    ...(a.status === 'resolved' ? { solved_on: day(a.updated_at), solved_by: clip(a.solution?.text, 220), solved_by_source: a.solution?.sourceId || null } : { open_tasks: q.get(`SELECT COUNT(*) AS n FROM action_items WHERE alert_id = ? AND status = 'open'`, a.id).n, report: a.report_id ? `R${a.report_id}` : null }),
  });
  parts.open_issues_on_this_machine = openAlerts.map(alertSource);
  // The repair report that solved an alert becomes citable too, so "solved by" can point at it.
  parts.solved_before_on_this_machine = solvedAlerts.map((a) => { if (a.solution.report) reportSource(a.solution.report, 'repair that solved it'); return alertSource(a); });

  // 3. Durable memory facts on this machine.
  parts.memory_facts = q.all('SELECT * FROM memory_facts WHERE asset_id = ? ORDER BY created_at DESC LIMIT 8', asset.id)
    .map((f) => add({ id: `M${f.id}`, type: 'memory', scope: 'this machine', href: assetHref, title: f.fact, kind: f.kind, date: day(f.created_at) }));

  // 4. What the knowledge graph has linked to this machine (parts, problems, codes, conditions, hazards).
  const graph = graphLinks(asset.id);
  if (graph.total) {
    add({ id: 'G', type: 'graph', scope: 'this machine', href: `/graph?focus=${encodeURIComponent(nodeId('asset', asset.id))}`, title: `Knowledge graph links for ${asset.id}`, ...graph });
    parts.knowledge_graph_for_this_machine = { source: 'G', ...graph };
  }

  // 5. Known fixes for this model (field-learned or from CAT Engineering), by real field success.
  const fixes = rankFixes(asset.model, [...keys.comps], [...keys.syms], 5);
  parts.known_fixes_for_this_model = fixes.map((f) => {
    const learnedHere = f.report_id ? q.get('SELECT asset_id FROM reports WHERE id = ?', f.report_id)?.asset_id === asset.id : false;
    return add({
      id: `F${f.id}`, type: 'fix', scope: learnedHere ? 'this machine' : 'same model', href: '/engineering', fix_id: f.id, title: f.title, steps: f.steps || '',
      model: f.model || 'any model', part: f.component, problem: f.symptom, worked: f.success, failed: f.fail, confidence_pct: f.confidence, source_kind: f.source, author: f.author,
    });
  });

  // 6. Open engineering cases for this model and part.
  const cases = primaryC ? q.all(`SELECT * FROM eng_cases WHERE model = ? AND component = ? AND status <> 'closed' ORDER BY last_seen DESC LIMIT 2`, asset.model, primaryC) : [];
  parts.engineering_cases_for_this_model = cases.map((c) => add({
    id: `C${c.id}`, type: 'case', scope: 'same model', href: `/engineering?case=${c.id}`, case_id: c.id, title: c.title, status: c.status.replace(/_/g, ' '), priority: c.priority,
    occurrences: c.occurrences, quick_fix: c.quick_fix || null, root_cause: c.root_cause || null,
  }));

  // 7. Product documents that apply to this model (or to every machine). Unknown applicability is excluded.
  const docQuery = [text, ...keys.comps, ...keys.syms, ...keys.codes].join(' ');
  parts.product_documents = searchDocs(docQuery, { model: asset.model, limit: 4, excerpt: 500 })
    .filter((d) => d.applies_to.some((m) => m === asset.model || /all machines/.test(m)))
    .slice(0, 3)
    .map((d) => add({ id: `D${d.doc_id}`, type: 'document', scope: 'applies to model', href: `/library?doc=${d.doc_id}`, doc_id: d.doc_id, title: d.title, doc_type: d.doc_type, applies_to: d.applies_to, excerpt: d.excerpt }));

  // 8. Fleet references: the same part solved on another machine of the same model. Labelled, capped, last.
  if (primaryC) {
    const others = q.all(`SELECT r.*, a.model FROM reports r JOIN assets a ON a.id = r.asset_id JOIN alerts al ON al.report_id = r.id
        WHERE a.model = ? AND r.asset_id <> ? AND al.status = 'resolved' ORDER BY r.created_at DESC LIMIT 60`, asset.model, asset.id)
      .map((r) => { const e = parseJson(r.extraction, {}); return { ...r, extraction: e, ...overlap(e, keys) }; })
      .filter((r) => r.score >= 3 && !r.extraction.retracted).slice(0, 6);
    const refs = [];
    for (const r of others) {
      const al = q.get('SELECT * FROM alerts WHERE report_id = ? ORDER BY id LIMIT 1', r.id);
      const sol = solutionText({ ...al, rep: r }, r.asset_id);
      if (!sol) continue;
      refs.push(add({ id: `X${r.id}`, type: 'fleet_reference', scope: 'fleet reference', href: `/asset?id=${encodeURIComponent(r.asset_id)}`, machine: r.asset_id, model: r.model, title: r.summary, date: day(r.created_at), matched_on: r.reasons, solved_by: clip(sol.text, 200) }));
      if (refs.length >= 3) break;
    }
    parts.solved_on_other_machines_of_this_model = refs;
  }

  const mustSafety = sevRank(ex.severity) >= 3 || (ex.safety_hazards || []).some((h) => CRITICAL_HAZARDS.has(h));
  return { asset, ex, text, keys, primaryC, primaryS, sources, parts, mustSafety, lang: normalizeLang(lang) || 'en' };
}

function hydrate(reportId) {
  const r = q.get('SELECT * FROM reports WHERE id = ?', reportId);
  return r ? { ...r, extraction: parseJson(r.extraction, {}), score: 0, reasons: [] } : null;
}

/** What solved an alert: its resolution text, the repair report that closed it, or the next repair on the machine. */
function solutionText(a, assetId) {
  if (!a) return null;
  if (a.resolution && !/^Withdrawn:/.test(a.resolution)) {
    const rep = a.resolved_by_report ? hydrate(a.resolved_by_report) : null;
    return { text: a.resolution, sourceId: rep ? `R${rep.id}` : null, report: rep };
  }
  if (a.resolved_by_report) { const rep = hydrate(a.resolved_by_report); if (rep) return { text: rep.extraction.resolution || rep.raw_text, sourceId: `R${rep.id}`, report: rep }; }
  const comp = a.rep?.extraction?.components?.[0];
  const next = q.all(`SELECT * FROM reports WHERE asset_id = ? AND category = 'maintenance' AND created_at > ? ORDER BY created_at ASC LIMIT 6`, assetId, a.created_at)
    .map((r) => ({ ...r, extraction: parseJson(r.extraction, {}) }))
    .find((r) => !comp || (r.extraction.components || []).includes(comp) || new RegExp(comp.split(/\W+/)[0], 'i').test(r.raw_text));
  return next ? { text: next.extraction.resolution || next.raw_text, sourceId: `R${next.id}`, report: { ...next, score: 0, reasons: [] } } : null;
}

/** Parts, problems, codes, conditions and hazards the graph links to this machine, with how often each was observed. */
function graphLinks(assetId) {
  const { nodes, edges } = getNeighborhood(nodeId('asset', assetId), 2, 240);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const reports = new Set(nodes.filter((n) => n.type === 'report' && n.props?.asset === assetId && !n.props?.retracted).map((n) => n.id));
  const count = { component: new Map(), symptom: new Map(), code: new Map(), condition: new Map(), hazard: new Map() };
  for (const e of edges) {
    if (!reports.has(e.from)) continue;
    const n = byId.get(e.to);
    if (n && count[n.type]) count[n.type].set(n.label, (count[n.type].get(n.label) || 0) + 1);
  }
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, reports]) => ({ name, reports }));
  const out = { parts: top(count.component), problems: top(count.symptom), codes: top(count.code), conditions: top(count.condition), hazards: top(count.hazard) };
  out.total = Object.values(out).reduce((s, l) => s + (Array.isArray(l) ? l.length : 0), 0);
  return out;
}

/* ------------------------------- offline answer ------------------------------- */

const item = (text, sources = [], extra = {}) => ({ text: clip(text, 260), sources: uniq(sources), ...extra });

export function rulesSolution(ctx) {
  const { asset, ex, primaryC, primaryS, parts } = ctx;
  const tt = translator(ctx.lang);
  const id = asset.id;
  const what = primaryC && primaryS ? tt('{problem} at the {part}', { problem: tt.v(primaryS), part: tt.lower(primaryC) }) : ex.summary;
  const headline = primaryC && primaryS ? `${tt.v(primaryC)} · ${tt.v(primaryS)}` : clip(ex.summary, 80);
  const guidance = ex.operator_guidance || '';
  const isSafetyLine = SAFETY_GUIDANCE.some((k) => tt(k) === guidance) || /injection injur|do not keep working|never open a hot/i.test(guidance);
  const safety_first = ctx.mustSafety ? ex.operator_guidance : isSafetyLine ? ex.operator_guidance : null;

  const do_now = [];
  const steps = ex.advice_steps?.length ? ex.advice_steps : [];
  if (!steps.length && guidance && guidance !== safety_first && guidance !== tt(NOTHING_TO_DO) && !/^Thanks — logged/.test(guidance)) steps.push(guidance);
  for (const a of (ex.action_items || []).filter((x) => x.assignee_role === 'operator')) steps.push(a.text);
  for (const s of uniq(steps).slice(0, 4)) do_now.push(item(s, []));
  const openSame = parts.open_issues_on_this_machine.find((a) => a.matched_on.length);
  if (openSame) do_now.push(item(tt('This is already open on {id} as “{title}” (opened {opened}, {tasks} pending). Your report has been added to it; tell the technician if it has got worse since.', { id, title: openSame.title, opened: openSame.opened, tasks: openSame.open_tasks === 1 ? tt('1 task') : tt('{n} tasks', { n: openSame.open_tasks }) }), [openSame.id]));
  const solved = parts.solved_before_on_this_machine[0];
  if (solved) do_now.push(item(tt('The same problem on {id} was solved on {date} by: {how}. Tell the technician.', { id, date: solved.solved_on, how: solved.solved_by }), [solved.id, solved.solved_by_source]));
  const fix = parts.known_fixes_for_this_model[0];
  if (fix) do_now.push(item(tt('Ask the technician to try what worked before on {model}: {title} (worked {worked} of {total} times).', { model: fix.model, title: fix.title, worked: fix.worked, total: fix.worked + fix.failed }), [fix.id]));
  const c = parts.engineering_cases_for_this_model[0];
  if (c?.quick_fix) do_now.push(item(tt('CAT Engineering has a quick fix out for {model} {part}: {fix}.', { model: asset.model, part: primaryC ? tt.lower(primaryC) : '', fix: c.quick_fix }).replace(/\s{2,}/g, ' '), [c.id]));
  const doc = parts.product_documents[0];
  if (doc) do_now.push(item(tt('{title} ({type}, applies to {models}): {excerpt}', { title: doc.title, type: doc.doc_type, models: doc.applies_to.join(', '), excerpt: clip(doc.excerpt, 170) }), [doc.id]));
  if (!do_now.length) do_now.push(item(tt('Stop if anything looks unsafe, keep to light duty and watch the gauges. The right people on site have been told.'), []));

  const record_shows = [];
  for (const r of parts.matching_reports_on_this_machine.slice(0, 4)) record_shows.push(item(tt('{date} ({n}d ago): {title} — {severity}, {status}{solved}.', { date: r.date, n: r.days_ago, title: r.title, severity: tt.v(r.severity), status: tt.v(r.status), solved: r.solved_by ? tt('; solved by {how}', { how: r.solved_by }) : '' }), [r.id]));
  const g = parts.knowledge_graph_for_this_machine;
  if (g && primaryC) {
    const p = g.parts.find((x) => x.name === primaryC);
    const s = primaryS ? g.problems.find((x) => x.name === primaryS) : null;
    if (p && p.reports >= 2) record_shows.push(item(tt('{part} comes up in {n} reports on {id}{problem}.{condition}', { part: tt.v(primaryC), n: p.reports, id, problem: s ? tt('; {problem} in {m}', { problem: tt.lower(primaryS), m: s.reports }) : '', condition: g.conditions[0] ? tt(' Most often under {condition}.', { condition: tt.lower(g.conditions[0].name) }) : '' }), ['G']));
  }
  for (const m of parts.memory_facts.filter((f) => f.kind !== 'repair').slice(0, 2)) record_shows.push(item(`${m.title} (${m.date}).`, [m.id]));
  for (const code of ctx.keys.codes) {
    const seen = parts.matching_reports_on_this_machine.filter((r) => r.matched_on.includes(code));
    if (seen.length) record_shows.push(item(tt('{code} has been raised on {id} before: {dates}.', { code, id, dates: seen.map((r) => r.date).join(', ') }), seen.map((r) => r.id)));
  }

  const worked_before = [];
  for (const a of parts.solved_before_on_this_machine.slice(0, 3)) worked_before.push(item(tt('On this machine, {date}: {how}', { date: a.solved_on, how: a.solved_by }), [a.id, a.solved_by_source], { scope: 'this machine' }));
  for (const f of parts.known_fixes_for_this_model.slice(0, 3)) worked_before.push(item(tt('{title} ({source}, worked {worked} of {total} times on {model})', { title: f.title, source: f.source_kind === 'engineering' ? tt('CAT Engineering') : tt('learned in the field'), worked: f.worked, total: f.worked + f.failed, model: f.model }) + (f.steps ? ` — ${clip(f.steps, 120)}` : ''), [f.id], { scope: f.scope, confidence_pct: f.confidence_pct, fix_id: f.fix_id }));
  for (const x of (parts.solved_on_other_machines_of_this_model || []).slice(0, 2)) worked_before.push(item(tt('{machine} ({model}), {date}: {how}', { machine: x.machine, model: x.model, date: x.date, how: x.solved_by }), [x.id], { scope: 'fleet reference' }));

  const not_on_record = [];
  if (!parts.matching_reports_on_this_machine.length && (primaryC || primaryS)) not_on_record.push(tt('No earlier report of {what} on {id}; this is the first.', { what, id }));
  for (const code of ctx.keys.codes) if (!parts.matching_reports_on_this_machine.some((r) => r.matched_on.includes(code))) not_on_record.push(tt('{code} has not been seen on {id} before.', { code, id }));
  if (!worked_before.length && primaryC) not_on_record.push(tt('No fix on record yet for {part} {problem} on {model}.', { part: tt.lower(primaryC), problem: primaryS ? tt.lower(primaryS) : tt.v('problems'), model: asset.model }));

  return finish({ headline, safety_first, do_now, record_shows, worked_before, not_on_record }, ctx, { mode: 'rules' });
}

/* -------------------------------- model answer -------------------------------- */

const ITEM = (extra = {}) => ({
  type: 'array',
  items: { type: 'object', additionalProperties: false, required: ['text', 'sources', ...Object.keys(extra)], properties: { text: { type: 'string' }, sources: { type: 'array', items: { type: 'string' }, description: 'ids of the records this statement comes from, e.g. ["R12","F3"]' }, ...extra } },
});
const SOLUTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['headline', 'safety_first', 'do_now', 'record_shows', 'worked_before', 'not_on_record'],
  properties: {
    headline: { type: 'string', description: 'the problem in <= 8 words' },
    safety_first: { type: 'string', description: 'one sentence the operator must act on before anything else; empty string if none' },
    do_now: ITEM({ caution: { type: 'string', description: 'a short warning tied to this step, or empty' } }),
    record_shows: ITEM(),
    worked_before: ITEM({ scope: { type: 'string', enum: ['this machine', 'same model', 'fleet reference'] }, confidence_pct: { type: 'integer' } }),
    not_on_record: { type: 'array', items: { type: 'string' } },
  },
};

function systemPrompt(ctx) {
  const { asset } = ctx;
  return `You are Cat Track's troubleshooting agent, talking to the operator in the cab of machine ${asset.id} (${asset.model}).
Build a specific answer to what they just reported, using ONLY the records supplied. Every record has an id (R12 report, A4 alert, M2 memory fact, G graph links, F3 known fix, C1 engineering case, D2 document, X9 solved on another machine). Each record carries a scope: "this machine", "same model", "applies to model" or "fleet reference".
Rules:
- Every item in do_now, record_shows and worked_before must list the ids it is based on. Do not cite an id that is not in the records. If a step is general safety practice with no record behind it, give it an empty sources list.
- Prefer "this machine" records. Use "same model" and "fleet reference" records only for fixes, and say they come from other machines of the same model. Never present another machine's history as ${asset.id}'s.
- Figures, intervals and procedures in documents apply only to the models they name.
- do_now: 2-5 short imperative steps, in order, safety first, each one thing the operator or technician can do now. Fold in the best known fix and any open issue on this machine.
- record_shows: 1-4 facts from this machine's own record (earlier reports, open issues, graph links, memory facts) that bear on this problem. Empty if nothing relevant.
- worked_before: what solved this before, this machine first, then known fixes with their field success, then fleet references. Empty if none.
- not_on_record: what you looked for and did not find (e.g. "No earlier CID 110 on this machine"). 0-3 items.
- Plain language, no jargon, no padding, each item under 35 words. Today is ${new Date().toISOString().slice(0, 10)}.
- Language: the operator wrote in ${langName(ctx.lang)}. Write headline, safety_first and every item text in ${langName(ctx.lang)}${ctx.lang === 'hi' ? ' (Devanagari script; keep part names, fault codes and model numbers as written in the records)' : ''}. Record ids, fault codes and model numbers stay as they are.`;
}

export async function modelSolution(ctx) {
  const started = Date.now();
  const records = JSON.stringify(ctx.parts).slice(0, contextChars());
  const out = await structured({
    system: systemPrompt(ctx),
    text: `What the operator said: """${ctx.text}"""\n\nHow it was classified: ${JSON.stringify({ severity: ctx.ex.severity, category: ctx.ex.category, intent: ctx.ex.intent, parts: ctx.ex.components, problems: ctx.ex.symptoms, codes: ctx.ex.fault_codes, conditions: ctx.ex.conditions, hazards: ctx.ex.safety_hazards, likely_causes: ctx.ex.likely_causes })}\n\nRecords for ${ctx.asset.id} (JSON):\n${records}`,
    schema: SOLUTION_SCHEMA, maxTokens: 2000,
  });
  return finish(out, ctx, { mode: 'llm', model: llmInfo().label, seconds: Math.round((Date.now() - started) / 1000) });
}

/* ---------------------------------- validator ---------------------------------- */

/** Keep only citations that exist in the gathered context; drop uncited claims about the record; force the safety line. */
export function validateSolution(sol, ctx) {
  const known = new Set(ctx.sources.map((s) => s.id));
  const str = (v, n = 260) => (typeof v === 'string' ? clip(v, n) : '');
  const list = (arr, { dropUncited = false, max = 6 } = {}) => (Array.isArray(arr) ? arr : [])
    .filter((it) => it && typeof it.text === 'string' && it.text.trim())
    .map((it) => {
      const sources = uniq((Array.isArray(it.sources) ? it.sources : []).map((s) => String(s).trim().toUpperCase()).filter((s) => known.has(s)));
      const out = { text: str(it.text), sources, unverified: !sources.length };
      if (typeof it.caution === 'string' && it.caution.trim()) out.caution = str(it.caution, 160);
      if (['this machine', 'same model', 'fleet reference'].includes(it.scope)) out.scope = it.scope;
      if (Number.isInteger(it.confidence_pct)) out.confidence_pct = Math.max(0, Math.min(100, it.confidence_pct));
      if (Number.isInteger(it.fix_id)) out.fix_id = it.fix_id;
      return out;
    })
    .filter((it) => !(dropUncited && it.unverified))
    .slice(0, max);
  const fallbackSafety = ctx.mustSafety ? ctx.ex.operator_guidance : null;
  const worked_before = list(sol.worked_before, { dropUncited: true }).map((w) => {
    // A fix id lets the operator give thumbs up/down; take it from the citation when the model left it out.
    if (!w.fix_id) { const f = w.sources.map((id) => ctx.sources.find((s) => s.id === id)).find((s) => s?.type === 'fix'); if (f) { w.fix_id = f.fix_id; w.confidence_pct ??= f.confidence_pct; } }
    if (!w.scope) { const s = ctx.sources.find((x) => w.sources.includes(x.id)); w.scope = s?.scope === 'applies to model' ? 'same model' : s?.scope || 'same model'; }
    return w;
  });
  return {
    headline: str(sol.headline, 90) || (ctx.primaryC && ctx.primaryS ? `${translator(ctx.lang).v(ctx.primaryC)} · ${translator(ctx.lang).v(ctx.primaryS)}` : clip(ctx.ex.summary, 80)),
    safety_first: str(sol.safety_first, 240) || fallbackSafety || null,
    do_now: list(sol.do_now),
    record_shows: list(sol.record_shows, { dropUncited: true }),
    worked_before,
    not_on_record: (Array.isArray(sol.not_on_record) ? sol.not_on_record : []).filter((s) => typeof s === 'string' && s.trim()).map((s) => clip(s, 200)).slice(0, 4),
  };
}

function finish(raw, ctx, meta) {
  const sol = validateSolution(raw, ctx);
  const cited = new Set([sol.do_now, sol.record_shows, sol.worked_before].flat().flatMap((it) => it.sources));
  sol.sources = ctx.sources.filter((s) => cited.has(s.id)).map(({ id, type, scope, href, title }) => ({ id, type, scope, href, title: clip(title, 90) }));
  sol.scope = { machine: ctx.asset.id, model: ctx.asset.model, records_considered: ctx.sources.length };
  return { ...sol, ...meta };
}

/* ---------------------------------- entry points ---------------------------------- */

/** The instant answer for a just-filed report, plus a background model answer pushed as a `solution` event. */
export function solveForReport({ asset, ex, text, reportId, lang = 'en' }) {
  const ctx = gatherAssetContext(asset, ex, text, { excludeReportId: reportId, lang });
  const instant = rulesSolution(ctx);
  if (!llmEnabled()) return instant;
  modelSolution(ctx)
    .then((sol) => publish('solution', { reportId, status: 'done', solution: sol }))
    .catch((err) => { console.warn(`[troubleshoot] report ${reportId}: model answer failed (${describeLlmError(err)})`); publish('solution', { reportId, status: 'failed', error: describeLlmError(err) }); });
  return { ...instant, pending: true, model: llmInfo().label };
}
