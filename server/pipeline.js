// Ingestion pipeline: field report → structured observation → knowledge graph → memory recall →
// site alerts + action items → CAT Engineering escalation → live push to every panel.
import fs from 'node:fs';
import path from 'node:path';
import { q, tx, nowIso, UPLOAD_DIR, parseJson, alertRow } from './db.js';
import { upsertNode, upsertEdge, relabelNode, nodeId, newDelta, slug } from './graph.js';
import { weaveReport } from './weave.js';
import { casePriority, refreshCase, deleteReports, findReportsToDelete, reportOption } from './history.js';
import { HttpError } from './errors.js';
import { extractObservation, modelExtract } from './extract.js';
import { llmEnabled, llmInfo, describeLlmError } from './llm.js';
import { searchDocs } from './docs.js';
import { answerNow } from './agent.js';
import { solveForReport, SOLUTION_INTENTS } from './troubleshoot.js';
import { ROLES } from './vocab.js';
import { componentSystem, sevRank, issueClass } from './vocab.js';
import { detectLang, translator } from './i18n.js';
import {
  getAsset, recentReports, recallSimilar, rankFixes, fixesForModel, recomputeAssetState, normalizeAssetId, hydrateReport,
} from './memory.js';
import { publish } from './events.js';

export { HttpError };

const ROLE_LABEL = { operator: 'Operators', technician: 'Technicians', site_manager: 'Site manager', safety_officer: 'Safety officer', fleet_manager: 'Fleet manager' };
const ROLE_ONE = { operator: 'Operator', technician: 'Technician', site_manager: 'Site manager', safety_officer: 'Safety officer', fleet_manager: 'Fleet manager' };

function savePhoto(dataUrl) {
  const m = /^data:(image\/(jpeg|png|webp));base64,(.+)$/s.exec(dataUrl || '');
  if (!m) return null;
  const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
  const file = `photo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), Buffer.from(m[3], 'base64'));
  return { url: `/uploads/${file}`, mediaType: m[1], data: m[3] };
}

/** People on the job site who receive an alert (site staff for the given roles + roaming staff). */
export function recipientsFor(siteId, roles) {
  if (!roles.length) return [];
  const marks = roles.map(() => '?').join(',');
  return q.all(`SELECT id, name, role FROM people WHERE (site_id = ? OR site_id IS NULL) AND role IN (${marks}) ORDER BY role, name`, siteId, ...roles);
}

/**
 * Ingest one observation from the field.
 * @param {object} input { assetId, personId, text, source, photo (data URL), createdAt, forceRules, silent, overrides }
 * Live screens hear 'report-received' as soon as the report is accepted, then 'report' (or
 * 'report-handled' for a delete request, 'report-failed' on an error) when it has been processed.
 */
export async function ingestReport(input) {
  const run = { rid: `rx${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, announced: false };
  try {
    return await processReport(input, run);
  } catch (err) {
    if (run.announced) publish('report-failed', { rid: run.rid, error: err.message });
    throw err;
  }
}

async function processReport(input, run) {
  const text = String(input.text || '').trim();
  if (!text) throw new HttpError(400, 'Report text is empty — dictate or type what you observed.');
  if (text.length > 4000) throw new HttpError(400, 'Report is too long (max 4000 characters).');
  const assetId = normalizeAssetId(input.assetId);
  const asset = getAsset(assetId);
  if (!asset) throw new HttpError(404, `Unknown unit ID "${input.assetId}". Scan the machine's QR tag or check the ID.`);
  const person = input.personId ? q.get('SELECT * FROM people WHERE id = ?', input.personId) : null;
  const createdAt = input.createdAt || nowIso();
  const source = input.source || 'voice';
  if (!input.silent) {
    publish('report-received', { rid: run.rid, asset_id: asset.id, site_id: asset.site_id, person_name: person?.name || null, source, at: createdAt });
    run.announced = true;
  }
  const photo = input.photo ? savePhoto(input.photo) : null;
  // The language the note is in (script and marker words; the screen's language breaks ties). What
  // the reporter said and what the engine says back stay in that language; entity keys stay English.
  const lang = input.forceRules && !input.lang ? 'en' : detectLang(text, input.lang);

  // 1. Understand: what happened, and what does the person want done? Live reports go to the AI
  //    first (with a time limit); the rule engine answers if it's off, slow or fails. Seeded history,
  //    telemetry and repair records (forceRules) skip both the AI and intent routing.
  const history = recentReports(asset.id, 12);
  const openAlerts = q.all(`SELECT id, title, severity, kind, report_id, created_at FROM alerts WHERE asset_id = ? AND status <> 'resolved' ORDER BY created_at DESC LIMIT 8`, asset.id);
  const extractCtx = {
    assetId: asset.id, asset, siteName: asset.site_name, siteClimate: asset.site_climate, lang,
    reporter: person?.name, reporterRole: person?.role, source, history, openAlerts,
    fixes: fixesForModel(asset.model), photo: photo ? { mediaType: photo.mediaType, data: photo.data } : null,
    docs: searchDocs(text, { model: asset.model, limit: 2, excerpt: 600 }),
  };
  const rules = await extractObservation(text, { ...extractCtx, forceRules: true });
  const live = !input.forceRules && !input.overrides;
  let ex = rules; let aiPending = false;
  if (live && llmEnabled()) {
    try {
      ex = await modelExtract(text, { ...extractCtx, timeoutMs: SYNC_TIMEOUT_MS }, rules);
      ex.ai_status = 'reviewed';
    } catch (err) {
      console.warn('[ingest] AI understanding failed, using rules:', describeLlmError(err));
      ex = { ...rules, ai_status: 'pending' };
      aiPending = true; // try again in the background
    }
  }
  if (input.overrides) Object.assign(ex, input.overrides);
  const intent = live ? ex.intent || 'new_issue' : 'record';
  // A request to delete earlier reports files nothing new: it only takes reports off the record.
  if (intent === 'delete_report') {
    const out = handleDeleteRequest({ text, ex, asset, person, lang });
    if (!input.silent) publish('report-handled', { rid: run.rid, intent, asset_id: asset.id, site_id: asset.site_id, deleted: out.deleted.map((d) => d.id), asking: Boolean(out.needsChoice) });
    return out;
  }
  const hasProblem = ex.components.length > 0 || ex.symptoms.length > 0 || ex.safety_hazards.length > 0;
  // Choose what this report should touch before writing anything.
  const target = ['resolved', 'update_existing'].includes(intent) ? pickOpenAlert(ex, openAlerts, intent) : null;
  if (intent === 'resolved') Object.assign(ex, { category: 'maintenance', severity: 'low', needs_engineering: false, is_mechanical_failure: false, action_items: [], memory_facts: [...new Set([...(ex.memory_facts || []), `Repaired: ${ex.resolution || text}`.slice(0, 200)])] });
  const asUpdate = intent === 'update_existing' && Boolean(target);
  const quiet = ['resolved', 'question', 'routine_log'].includes(intent) || asUpdate || (intent === 'request_advice' && !hasProblem) || (intent === 'request_help' && !hasProblem);
  const skipCase = quiet || intent === 'correction' && !hasProblem;

  // 2. Recall: what does the fleet already know about this?
  const similar = recallSimilar(ex, asset, { limit: 5 });
  const fixes = (ex.is_mechanical_failure || ex.category === 'mechanical') ? rankFixes(asset.model, ex.components, ex.symptoms) : [];

  const delta = newDelta();
  const result = tx(() => {
    // 3. Remember: persist the report and weave it into the knowledge graph.
    const ins = q.run(
      `INSERT INTO reports (asset_id, site_id, person_id, source, raw_text, photo_path, category, severity, summary, extraction, ai_mode, created_at, lang)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      asset.id, asset.site_id, person?.id, source, text, photo?.url, ex.category, ex.severity, ex.summary,
      { ...ex, lang, similar: similar.map((s) => ({ id: s.id, score: s.score, reasons: s.reasons })) }, ex.ai_mode, createdAt, lang);
    const reportId = Number(ins.lastInsertRowid);

    const { rNode, mNode, compNodes } = weaveReport({ reportId, ex, asset, person, source, createdAt, similar, delta });
    for (const fact of ex.memory_facts || []) {
      q.run(`INSERT INTO memory_facts (asset_id, fact, kind, source_report_id, fact_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(asset_id, fact_key) DO UPDATE SET fact = excluded.fact, updated_at = excluded.updated_at`,
        asset.id, fact, ex.category === 'maintenance' ? 'repair' : 'note', reportId, slug(fact).slice(0, 80), createdAt, createdAt);
    }

    // 4. Escalate mechanical failures to CAT Engineering (fleet-wide case keyed by model + part + symptom).
    let engCase = null;
    const primaryC = ex.components[0];
    const primaryS = ex.symptoms.find((s) => s !== 'Warning / fault code') || ex.symptoms[0] || 'Fault';
    if (ex.needs_engineering && primaryC && !skipCase) {
      const key = `${asset.model}|${primaryC}`;
      let c = q.get('SELECT * FROM eng_cases WHERE case_key = ?', key);
      if (!c) {
        const r = q.run(`INSERT INTO eng_cases (case_key, model, component, symptom, title, status, priority, occurrences, first_seen, last_seen, updated_at)
                         VALUES (?, ?, ?, ?, ?, 'new', 'P3', 0, ?, ?, ?)`, key, asset.model, primaryC, primaryS, `${asset.model} — ${primaryC}: ${primaryS.toLowerCase()}`, createdAt, createdAt, createdAt);
        c = q.get('SELECT * FROM eng_cases WHERE id = ?', Number(r.lastInsertRowid));
      }
      q.run('INSERT OR IGNORE INTO case_reports (case_id, report_id) VALUES (?, ?)', c.id, reportId);
      const occurrences = q.get('SELECT COUNT(*) AS n FROM case_reports WHERE case_id = ?', c.id).n;
      const distinctAssets = q.get('SELECT COUNT(DISTINCT r.asset_id) AS n FROM case_reports cr JOIN reports r ON r.id = cr.report_id WHERE cr.case_id = ?', c.id).n;
      const maxSev = q.get(`SELECT MAX(CASE r.severity WHEN 'critical' THEN 3 WHEN 'high' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END) AS m FROM case_reports cr JOIN reports r ON r.id = cr.report_id WHERE cr.case_id = ?`, c.id).m;
      const priority = casePriority({ occurrences }, ['low', 'medium', 'high', 'critical'][maxSev], distinctAssets);
      const reopened = c.status === 'closed';
      q.run(`UPDATE eng_cases SET occurrences = ?, last_seen = ?, priority = ?, status = ?, updated_at = ? WHERE id = ?`,
        occurrences, createdAt > (c.last_seen || '') ? createdAt : c.last_seen, priority, reopened ? 'new' : c.status, createdAt, c.id);
      engCase = { ...q.get('SELECT * FROM eng_cases WHERE id = ?', c.id), distinctAssets, reopened };
      const caseNode = upsertNode('case', String(c.id), `Case #${c.id}: ${primaryC}`, { caseId: c.id, priority, status: engCase.status, occurrences }, delta, createdAt);
      upsertEdge(rNode, caseNode, 'PART_OF', delta, createdAt);
      upsertEdge(caseNode, mNode, 'CONCERNS', delta, createdAt);
      if (compNodes[0]) upsertEdge(caseNode, compNodes[0], 'CONCERNS', delta, createdAt);
    }

    // 5. Alert the people on site and hand them concrete action items.
    let alert = null; const actions = []; let recipients = [];
    const alertWorthy = sevRank(ex.severity) >= 1 || ex.category === 'safety';
    if (alertWorthy && ex.category !== 'maintenance' && !quiet) {
      const kind = ex.category === 'safety' ? 'safety' : (ex.is_mechanical_failure || ex.category === 'mechanical') ? 'mechanical' : 'operational';
      const roles = new Set(['site_manager']);
      if (kind === 'mechanical') { roles.add('technician'); if (sevRank(ex.severity) >= 2) roles.add('operator'); }
      if (kind === 'safety') { roles.add('operator'); roles.add('safety_officer'); roles.add('technician'); }
      if (sevRank(ex.severity) >= 3) roles.add('fleet_manager');
      for (const a of ex.action_items || []) if (a.assignee_role) roles.add(a.assignee_role);
      const audience = [...roles];
      recipients = recipientsFor(asset.site_id, audience).filter((p) => p.id !== person?.id);
      const body = alertBody(ex.operator_guidance, fixes[0], engCase);
      const ar = q.run(`INSERT INTO alerts (site_id, asset_id, report_id, case_id, kind, severity, title, body, audience, status, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        asset.site_id, asset.id, reportId, engCase?.id, kind, ex.severity, `${asset.id} · ${ex.summary}`, body, audience, createdAt, createdAt);
      alert = alertRow(q.get('SELECT * FROM alerts WHERE id = ?', Number(ar.lastInsertRowid)));
      const items = [...(ex.action_items || [])];
      if (fixes[0] && fixes[0].confidence >= 50) items.push({ assignee_role: 'technician', text: `Try what worked before: ${fixes[0].title} (worked ${fixes[0].success} of ${fixes[0].success + fixes[0].fail} times)` });
      for (const it of items.slice(0, 7)) {
        const r = q.run(`INSERT INTO action_items (alert_id, site_id, asset_id, text, assignee_role, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)`,
          alert.id, asset.site_id, asset.id, it.text, it.assignee_role || 'site_manager', createdAt);
        actions.push(q.get('SELECT * FROM action_items WHERE id = ?', Number(r.lastInsertRowid)));
      }
    }
    if (asUpdate && target.report_id) upsertEdge(rNode, nodeId('report', String(target.report_id)), 'UPDATES', delta, createdAt);
    return { reportId, alert, actions, engCase, recipients };
  });

  // 6. Act on what the person asked for.
  const did = []; let needsChoice = null; let answer = null; let advice = []; let solution = null;
  const tt = translator(lang);
  if (live) {
    if (intent === 'resolved') {
      if (target) {
        const closed = closeAlert(target.id, { personId: person?.id, resolution: ex.resolution || text, viaReportId: result.reportId });
        did.push({ kind: 'resolved', text: tt('Closed the open issue “{title}”, with its tasks.', { title: target.title }), alertId: target.id });
        if (closed.learnedFixId) did.push({ kind: 'learned', text: tt('Saved “{fix}” as a known fix for {model}.', { fix: clip(ex.resolution || text, 90), model: asset.model }) });
      } else if (openAlerts.length) {
        needsChoice = { kind: 'resolve', reportId: result.reportId, prompt: tt('Which issue did you fix?'), options: openAlerts.map((a) => ({ id: a.id, title: a.title, severity: a.severity, created_at: a.created_at })) };
        did.push({ kind: 'note', text: tt('{id} has {n} open issues — pick the one you fixed so it can be closed.', { id: asset.id, n: openAlerts.length }) });
      } else {
        did.push({ kind: 'note', text: tt('No open issue on {id} to close — saved as a repair record.', { id: asset.id }) });
      }
    }
    if (asUpdate) {
      updateOpenAlert(target.id, ex, person);
      did.push({ kind: 'updated', text: tt('Added this to the open issue “{title}” instead of opening a new one.', { title: target.title }), alertId: target.id });
    } else if (intent === 'update_existing') {
      did.push({ kind: 'note', text: tt('No matching open issue, so this was filed as a new one.') });
    }
    if (intent === 'correction') {
      const wrong = pickCorrectedReport(ex, history, person, result.reportId);
      if (wrong) {
        retractReport(wrong.id, person, text);
        did.push({ kind: 'retracted', text: tt('Withdrew your earlier report “{summary}” and removed it from its alerts and engineering case.', { summary: wrong.summary }), reportId: wrong.id });
      } else did.push({ kind: 'note', text: tt('Couldn’t tell which earlier report this corrects, so nothing was withdrawn.') });
    }
    if ((intent === 'request_help' || (ex.help_role && ex.help_role !== 'none' && ex.help_request)) && ex.help_request) {
      const h = requestHelp(asset, person, ex, result.alert, result.reportId);
      const who = tt.lower(ROLE_ONE[h.role] || h.role);
      did.push({ kind: 'help', text: tt('Asked the {who} for: {what}', { who, what: clip(ex.help_request, 100) }), alertId: h.alertId });
    }
    if (intent === 'question') {
      // Asked from the cab about this machine: answer from this machine's record only.
      const a = await answerNow({ question: text, assetId: asset.id, personId: person?.id, role: person?.role || 'operator', scoped: true, lang });
      answer = { text: a.answer, mode: a.mode, model: a.model || null, trace: a.trace || [] };
    }
    if (ex.wants_advice || ex.advice_steps?.length || intent === 'request_advice') {
      advice = ex.advice_steps?.length ? ex.advice_steps : ruleAdvice(ex, fixes, tt);
    }
    // 7. Solve it: a specific answer built only from this machine's record (and its model's fixes).
    //    The rule answer goes back now; the model's answer follows over SSE as a `solution` event.
    if (SOLUTION_INTENTS.has(intent) && (hasProblem || intent === 'request_advice')) {
      try { solution = solveForReport({ asset, ex, text, reportId: result.reportId, lang }); }
      catch (err) { console.warn('[troubleshoot] failed:', err.message); }
    }
  }

  const assetState = recomputeAssetState(asset.id);
  const report = hydrateReport(q.get(`SELECT r.*, p.name AS person_name, p.role AS person_role FROM reports r LEFT JOIN people p ON p.id = r.person_id WHERE r.id = ?`, result.reportId));
  const graphDelta = {
    nodes: delta.nodes.filter((n, i, arr) => arr.findIndex((m) => m.id === n.id) === i),
    edges: delta.edges.filter((e, i, arr) => arr.findIndex((f) => f.id === e.id) === i),
  };
  const routed = [];
  if (result.alert) {
    const byRole = {};
    for (const p of result.recipients) (byRole[p.role] ||= []).push(p.name);
    routed.push({ to: `${asset.site_name} crew`, detail: Object.entries(byRole).map(([r, names]) => `${ROLE_LABEL[r] || r}: ${names.join(', ')}`).join(' · '), count: result.recipients.length });
  }
  if (result.engCase) routed.push({ to: 'CAT Engineering', detail: `Case #${result.engCase.id} · ${result.engCase.title} · ${result.engCase.occurrences} fleet report(s) · ${result.engCase.priority}`, count: 1 });

  const out = {
    report, extraction: ex, asset: { ...getAsset(asset.id), ...assetState }, alert: result.alert, actions: result.actions,
    engCase: result.engCase, similar, fixes, routed, intent, did, advice, answer, solution, needsChoice,
    graph: { newNodes: graphDelta.nodes.filter((n) => n.isNew).length, newEdges: graphDelta.edges.filter((e) => e.isNew).length, reinforced: graphDelta.edges.filter((e) => !e.isNew).length + graphDelta.nodes.filter((n) => !n.isNew).length },
  };

  if (!input.silent) {
    publish('report', {
      report, asset: out.asset, rid: run.rid, intent, issue: issueClass(report),
      outcome: { alertId: result.alert?.id || null, told: result.recipients.length, caseId: result.engCase?.id || null, newFacts: out.graph.newNodes, newLinks: out.graph.newEdges, did: did.map((d) => d.kind) },
    });
    publish('graph', graphDelta);
    publish('asset', out.asset);
    if (result.alert) publish('alert', { alert: result.alert, actions: result.actions, recipients: result.recipients.length });
    if (result.engCase) publish('case', { case: result.engCase, reportId: result.reportId });
  }
  if (aiPending) {
    out.aiPending = true;
    out.aiLabel = llmInfo().label;
    reviewReport(result.reportId, text, extractCtx).catch((err) => console.warn('[review] failed:', err.message));
  }
  return out;
}

function alertBody(guidance, fix, engCase) {
  return [
    guidance,
    fix ? `What worked before: ${fix.title} (${fix.success} of ${fix.success + fix.fail} times).` : '',
    engCase ? `Sent to CAT Engineering as case #${engCase.id}, now ${engCase.occurrences} report${engCase.occurrences === 1 ? '' : 's'} across the fleet.` : '',
  ].filter(Boolean).join(' ');
}

const reportWithPerson = (id) => hydrateReport(q.get(`SELECT r.*, p.name AS person_name, p.role AS person_role FROM reports r LEFT JOIN people p ON p.id = r.person_id WHERE r.id = ?`, id));

/**
 * Background model review of a report the rule engine already filed. It can sharpen the summary and
 * guidance, add entities the rules missed (new graph links), add likely causes and memory facts, and
 * raise severity — never lower it, and it never removes anything the crew was already told.
 */
async function reviewReport(reportId, text, ctx) {
  const started = Date.now();
  let ai;
  try {
    ai = await modelExtract(text, ctx);
  } catch (err) {
    const why = describeLlmError(err);
    console.warn(`[review] report ${reportId}: model review failed (${why}); keeping the rule engine's read`);
    const row = q.get('SELECT extraction FROM reports WHERE id = ?', reportId);
    if (!row) return;
    const ex = { ...parseJson(row.extraction, {}), ai_status: 'failed', ai_error: why };
    q.run('UPDATE reports SET extraction = ? WHERE id = ?', ex, reportId);
    publish('report-updated', { reportId, status: 'failed', error: why, report: reportWithPerson(reportId) });
    return;
  }
  const row = q.get('SELECT r.*, a.model FROM reports r JOIN assets a ON a.id = r.asset_id WHERE r.id = ?', reportId);
  if (!row) return;
  const base = parseJson(row.extraction, {});
  const at = nowIso();
  const fresh = (k) => (ai[k] || []).filter((x) => !(base[k] || []).includes(x));
  const added = { components: fresh('components'), symptoms: fresh('symptoms'), fault_codes: fresh('fault_codes'), conditions: fresh('conditions'), safety_hazards: fresh('safety_hazards') };
  const severity = sevRank(ai.severity) > sevRank(base.severity) ? ai.severity : base.severity;
  const merged = {
    ...base,
    summary: ai.summary || base.summary,
    operator_guidance: ai.operator_guidance || base.operator_guidance,
    likely_causes: ai.likely_causes?.length ? ai.likely_causes : base.likely_causes || [],
    memory_facts: [...new Set([...(base.memory_facts || []), ...(ai.memory_facts || [])])],
    components: [...(base.components || []), ...added.components],
    symptoms: [...(base.symptoms || []), ...added.symptoms],
    fault_codes: [...(base.fault_codes || []), ...added.fault_codes],
    conditions: [...(base.conditions || []), ...added.conditions],
    safety_hazards: [...(base.safety_hazards || []), ...added.safety_hazards],
    severity, rules_severity: base.severity, rules_summary: base.summary,
    ai_mode: 'llm', ai_label: ai.ai_label, ai_status: 'reviewed', ai_seconds: Math.round((Date.now() - started) / 1000),
  };
  const delta = newDelta();
  let alert = null;
  tx(() => {
    q.run('UPDATE reports SET summary = ?, severity = ?, extraction = ?, ai_mode = ? WHERE id = ?', merged.summary, merged.severity, merged, 'llm', reportId);
    const rNode = relabelNode('report', String(reportId), merged.summary.slice(0, 48), { severity, reviewed: true }, delta, at);
    const mNode = nodeId('model', row.model);
    const sNode = nodeId('site', row.site_id);
    const compId = (c) => nodeId('component', c);
    for (const c of added.components) {
      upsertNode('component', c, c, { system: componentSystem(c) }, delta, at);
      upsertEdge(rNode, compId(c), 'AFFECTS', delta, at);
      upsertEdge(mNode, compId(c), 'HAS_COMPONENT', delta, at);
    }
    for (const s of added.symptoms) { upsertNode('symptom', s, s, {}, delta, at); upsertEdge(rNode, nodeId('symptom', s), 'EXHIBITS', delta, at); }
    for (const c of merged.components.slice(0, 2)) {
      for (const s of merged.symptoms) {
        if (added.components.includes(c) || added.symptoms.includes(s)) upsertEdge(compId(c), nodeId('symptom', s), 'SHOWS', delta, at);
      }
    }
    for (const code of added.fault_codes) {
      upsertNode('code', code, code, {}, delta, at);
      upsertEdge(rNode, nodeId('code', code), 'RAISED', delta, at);
      if (merged.components[0]) upsertEdge(nodeId('code', code), compId(merged.components[0]), 'INDICATES', delta, at);
    }
    for (const cond of added.conditions) {
      upsertNode('condition', cond, cond, {}, delta, at);
      upsertEdge(rNode, nodeId('condition', cond), 'UNDER', delta, at);
      for (const s of merged.symptoms) upsertEdge(nodeId('symptom', s), nodeId('condition', cond), 'CORRELATES_WITH', delta, at);
    }
    for (const hz of added.safety_hazards) {
      upsertNode('hazard', hz, hz, {}, delta, at);
      upsertEdge(rNode, nodeId('hazard', hz), 'FLAGS', delta, at);
      upsertEdge(nodeId('hazard', hz), sNode, 'OBSERVED_AT', delta, at);
    }
    for (const fact of (ai.memory_facts || []).filter((f) => !(base.memory_facts || []).includes(f))) {
      q.run(`INSERT INTO memory_facts (asset_id, fact, kind, source_report_id, fact_key, created_at, updated_at) VALUES (?, ?, 'note', ?, ?, ?, ?)
             ON CONFLICT(asset_id, fact_key) DO UPDATE SET fact = excluded.fact, updated_at = excluded.updated_at`, row.asset_id, fact, reportId, slug(fact).slice(0, 80), at, at);
    }
    const existing = q.get('SELECT * FROM alerts WHERE report_id = ? ORDER BY id LIMIT 1', reportId);
    if (existing) {
      const engCase = q.get('SELECT c.* FROM eng_cases c JOIN case_reports cr ON cr.case_id = c.id WHERE cr.report_id = ?', reportId);
      const fix = rankFixes(row.model, merged.components, merged.symptoms)[0];
      const raise = sevRank(severity) > sevRank(existing.severity) ? severity : existing.severity;
      q.run('UPDATE alerts SET title = ?, body = ?, severity = ?, updated_at = ? WHERE id = ?', `${row.asset_id} · ${merged.summary}`, alertBody(merged.operator_guidance, fix, engCase), raise, at, existing.id);
      alert = alertRow(q.get('SELECT * FROM alerts WHERE id = ?', existing.id));
    }
  });
  const state = recomputeAssetState(row.asset_id);
  console.log(`[review] report ${reportId} reviewed by ${ai.ai_label} in ${merged.ai_seconds}s (+${Object.values(added).flat().length} entities${severity !== base.severity ? `, severity ${base.severity}→${severity}` : ''})`);
  publish('report-updated', { reportId, status: 'reviewed', added, escalated: severity !== base.severity, report: reportWithPerson(reportId) });
  if (delta.nodes.length || delta.edges.length) publish('graph', delta);
  if (alert) publish('alert-updated', { alert });
  if (state) publish('asset', { ...getAsset(row.asset_id), ...state });
}

/** Engineering → field: publish a quick fix, remember it as a fix, and alert every site running that model. */
export function issueQuickFix(caseId, { title, steps, engineer }) {
  const c = q.get('SELECT * FROM eng_cases WHERE id = ?', caseId);
  if (!c) throw new HttpError(404, 'Case not found');
  if (!title || !String(title).trim()) throw new HttpError(400, 'Quick fix needs a title');
  const at = nowIso();
  const delta = newDelta();
  const out = tx(() => {
    const fr = q.run(`INSERT INTO fixes (model, component, symptom, title, steps, source, author, case_id, success, fail, created_at) VALUES (?, ?, ?, ?, ?, 'engineering', ?, ?, 0, 0, ?)`,
      c.model, c.component, c.symptom, String(title).trim(), steps || '', engineer || 'CAT Engineering', c.id, at);
    const fixId = Number(fr.lastInsertRowid);
    q.run(`UPDATE eng_cases SET status = 'quick_fix_issued', quick_fix = ?, engineer = COALESCE(?, engineer), updated_at = ? WHERE id = ?`, String(title).trim(), engineer, at, c.id);
    const fNode = upsertNode('fix', String(fixId), String(title).slice(0, 40), { fixId, source: 'engineering' }, delta, at);
    upsertEdge(fNode, nodeId('case', String(c.id)), 'RESOLVES', delta, at);
    upsertEdge(fNode, nodeId('model', c.model), 'APPLIES_TO', delta, at);
    upsertEdge(fNode, nodeId('component', c.component), 'REPAIRS', delta, at);
    // Alert every site that runs this model.
    const assets = q.all('SELECT id, site_id FROM assets WHERE model = ?', c.model);
    const sites = [...new Set(assets.map((a) => a.site_id))];
    const alerts = [];
    for (const siteId of sites) {
      const ar = q.run(`INSERT INTO alerts (site_id, asset_id, case_id, kind, severity, title, body, audience, status, created_at, updated_at)
                        VALUES (?, NULL, ?, 'bulletin', 'medium', ?, ?, ?, 'open', ?, ?)`,
        siteId, c.id, `CAT Engineering quick fix · ${c.model}: ${String(title).trim()}`, steps || '', ['technician', 'site_manager', 'operator'], at, at);
      const alert = alertRow(q.get('SELECT * FROM alerts WHERE id = ?', Number(ar.lastInsertRowid)));
      for (const a of assets.filter((x) => x.site_id === siteId)) {
        q.run(`INSERT INTO action_items (alert_id, site_id, asset_id, text, assignee_role, status, created_at) VALUES (?, ?, ?, ?, 'technician', 'open', ?)`,
          alert.id, siteId, a.id, `Apply CAT quick fix to ${a.id}: ${String(title).trim()}`, at);
      }
      alerts.push(alert);
    }
    return { fixId, alerts };
  });
  publish('graph', delta);
  publish('case', { case: q.get('SELECT * FROM eng_cases WHERE id = ?', c.id) });
  for (const a of out.alerts) publish('alert', { alert: a, actions: [], recipients: 0 });
  return { case: q.get('SELECT * FROM eng_cases WHERE id = ?', c.id), fixId: out.fixId, sitesNotified: out.alerts.length };
}

/**
 * Close an alert: mark it resolved, finish its tasks, record whether a known fix worked, and learn a
 * new field fix from the resolution text. `viaReportId` is the repair report that closed it, if any.
 */
export function closeAlert(alertId, { personId, resolution, fixId = null, worked = false, viaReportId = null }) {
  const alert = q.get('SELECT * FROM alerts WHERE id = ?', alertId);
  if (!alert) throw new HttpError(404, 'Alert not found');
  const at = nowIso();
  const report = alert.report_id ? hydrateReport(q.get('SELECT * FROM reports WHERE id = ?', alert.report_id)) : null;
  const asset = alert.asset_id ? getAsset(alert.asset_id) : null;
  let learnedFixId = null;
  tx(() => {
    q.run(`UPDATE alerts SET status = 'resolved', ack_by = COALESCE(ack_by, ?), resolution = ?, resolved_by_report = ?, updated_at = ? WHERE id = ?`, personId, resolution || null, viaReportId, at, alertId);
    q.run(`UPDATE action_items SET status = 'done', done_by = COALESCE(done_by, ?), done_at = COALESCE(done_at, ?) WHERE alert_id = ? AND status = 'open'`, personId, at, alertId);
    if (fixId) {
      q.run(`UPDATE fixes SET ${worked ? 'success = success + 1' : 'fail = fail + 1'} WHERE id = ?`, fixId);
      q.run('INSERT INTO fix_feedback (fix_id, asset_id, report_id, worked, person_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', fixId, alert.asset_id, alert.report_id, worked ? 1 : 0, personId, at);
    }
    // Learn a new field fix from the technician's words — only when they describe an actual repair
    // ("replaced the hose", not "all sorted"), and not when they confirmed an existing fix worked.
    if (resolution && REPAIR_ACTION_RE.test(resolution) && report && asset && report.extraction.components?.[0] && !(fixId && worked)) {
      const ex = report.extraction;
      const existing = q.get('SELECT id FROM fixes WHERE model = ? AND component = ? AND lower(title) = lower(?)', asset.model, ex.components[0], resolution.trim());
      if (existing) {
        q.run('UPDATE fixes SET success = success + 1 WHERE id = ?', existing.id);
        learnedFixId = existing.id;
      } else {
        const person = personId ? q.get('SELECT name FROM people WHERE id = ?', personId) : null;
        const r = q.run(`INSERT INTO fixes (model, component, symptom, title, steps, source, author, case_id, success, fail, created_at, report_id) VALUES (?, ?, ?, ?, '', 'field', ?, ?, 1, 0, ?, ?)`,
          asset.model, ex.components[0], (ex.symptoms || []).find((s) => s !== 'Warning / fault code') || null, resolution.trim(), person?.name || 'Field technician', alert.case_id, at, viaReportId);
        learnedFixId = Number(r.lastInsertRowid);
      }
    }
  });
  const delta = newDelta();
  if (learnedFixId) {
    const fNode = upsertNode('fix', String(learnedFixId), resolution.trim().slice(0, 40), { fixId: learnedFixId, source: 'field' }, delta, at);
    if (viaReportId) upsertEdge(nodeId('report', String(viaReportId)), fNode, 'APPLIED', delta, at);
    if (report?.extraction.components?.[0]) upsertEdge(fNode, nodeId('component', report.extraction.components[0]), 'REPAIRS', delta, at);
    if (asset) upsertEdge(fNode, nodeId('model', asset.model), 'APPLIES_TO', delta, at);
  }
  // The problem is solved: mark its node (the map turns it green) and link it to what solved it, so
  // the next time this part plays up the solution sits right next to the problem on the graph.
  if (alert.report_id) {
    const solvedBy = learnedFixId || ((fixId && worked) ? fixId : null);
    const rId = nodeId('report', String(alert.report_id));
    const node = q.get('SELECT label FROM nodes WHERE id = ?', rId);
    if (node) relabelNode('report', String(alert.report_id), node.label, { solved: true, resolution: resolution ? String(resolution).slice(0, 200) : null, solved_at: at, fix_id: solvedBy }, delta, at);
    if (solvedBy && node) {
      const f = q.get('SELECT * FROM fixes WHERE id = ?', solvedBy);
      const fNode = f && !q.get('SELECT id FROM nodes WHERE id = ?', nodeId('fix', String(f.id)))
        ? upsertNode('fix', String(f.id), f.title.slice(0, 40), { fixId: f.id, source: f.source }, delta, at)
        : nodeId('fix', String(solvedBy));
      upsertEdge(rId, fNode, 'RESOLVED_BY', delta, at);
    }
  }
  if (delta.nodes.length || delta.edges.length) publish('graph', delta);
  const state = asset ? recomputeAssetState(asset.id) : null;
  const updated = alertRow(q.get('SELECT * FROM alerts WHERE id = ?', alertId));
  publish('alert-updated', { alert: updated });
  if (state) publish('asset', { ...getAsset(asset.id), ...state });
  return { alert: updated, learnedFixId };
}

/** Dashboard path: resolving an alert also files a repair record on the machine. */
export async function resolveAlert(alertId, { personId, resolution, fixId, worked }) {
  const alert = q.get('SELECT * FROM alerts WHERE id = ?', alertId);
  if (!alert) throw new HttpError(404, 'Alert not found');
  const report = alert.report_id ? hydrateReport(q.get('SELECT * FROM reports WHERE id = ?', alert.report_id)) : null;
  let repairReport = null;
  if (resolution && alert.asset_id) {
    repairReport = await ingestReport({
      assetId: alert.asset_id, personId, source: 'repair', forceRules: true,
      text: `Repair completed: ${resolution.trim()}${report ? ` (resolves: ${report.summary})` : ''}`,
      overrides: { category: 'maintenance', severity: 'low', needs_engineering: false, is_mechanical_failure: false, action_items: [], memory_facts: [`Repaired: ${resolution.trim()}`] },
    });
  }
  const out = closeAlert(alertId, { personId, resolution, fixId, worked, viaReportId: repairReport?.report.id || null });
  return { ...out, repairReportId: repairReport?.report.id || null };
}

/** Operator picked which open issue their "it's fixed" report closes. */
export function resolveFromReport(reportId, alertId, personId) {
  const report = hydrateReport(q.get('SELECT * FROM reports WHERE id = ?', reportId));
  if (!report) throw new HttpError(404, 'Report not found');
  const alert = q.get(`SELECT * FROM alerts WHERE id = ? AND status <> 'resolved'`, alertId);
  if (!alert) throw new HttpError(404, 'That issue is already closed.');
  if (alert.asset_id !== report.asset_id) throw new HttpError(400, 'That issue belongs to a different machine.');
  return closeAlert(alertId, { personId: personId || report.person_id, resolution: report.extraction.resolution || report.raw_text, viaReportId: reportId });
}

/* ------------------------------ intent helpers ------------------------------ */

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const SYNC_TIMEOUT_MS = Number(process.env.AI_SYNC_TIMEOUT_MS) || 15_000;
const REPAIR_ACTION_RE = /\b(replac|clean|blew|blow|tighten|adjust|re-?rout|install|bled|bleed|flush|calibrat|repair|swap|weld|seal|torqu|patch|reset|topped|top up|grease|lubricat|clamp|sleeve|rebuil|realign|recharg|changed|fitted|refill)/i;

/** Which open alert a "fixed" / "update" report is about: the AI's pick, else the only candidate, else a part match. */
function pickOpenAlert(ex, openAlerts, intent) {
  if (!openAlerts.length) return null;
  const byId = openAlerts.find((a) => a.id === ex.references_alert_id);
  if (byId) return byId;
  const issues = openAlerts.filter((a) => a.kind === 'mechanical' || a.kind === 'safety');
  if (issues.length === 1) return issues[0];
  const parts = new Set(ex.components || []);
  const matches = issues.filter((a) => {
    const rep = a.report_id ? q.get('SELECT extraction FROM reports WHERE id = ?', a.report_id) : null;
    return (parseJson(rep?.extraction, {}).components || []).some((c) => parts.has(c));
  });
  if (matches.length === 1) return matches[0];
  return intent === 'update_existing' && matches.length ? matches[0] : null;
}

/** Which earlier report a correction refers to: the AI's pick, else the reporter's latest in the last day. */
function pickCorrectedReport(ex, history, person, newId) {
  const byId = history.find((h) => h.id === ex.references_report_id && h.id !== newId);
  if (byId) return byId;
  const dayAgo = Date.now() - 86400000;
  return history.find((h) => h.id !== newId && (!person || h.person_id === person.id) && new Date(h.created_at).getTime() > dayAgo && !h.extraction?.retracted) || null;
}

const MAX_VOICE_DELETE = 3; // more than this from one sentence needs a tap to confirm

/** "Delete my last report": work out which report(s) are meant, take them off the record, or ask. */
function handleDeleteRequest({ text, ex, asset, person, lang = 'en' }) {
  const tt = translator(lang);
  const onMachine = (id) => q.get('SELECT r.*, p.name AS person_name FROM reports r LEFT JOIN people p ON p.id = r.person_id WHERE r.id = ? AND r.asset_id = ?', id, asset.id);
  let targets = [...new Set(ex.delete_report_ids || [])].map(onMachine).filter(Boolean);
  let candidates = []; let why = null;
  let pickedBy = ex.ai_status === 'reviewed' ? 'ai' : 'rules';
  if (!targets.length) {
    const m = findReportsToDelete(text, ex, asset, person);
    targets = m.ids.map(onMachine).filter(Boolean);
    candidates = m.candidates;
    why = m.why;
    pickedBy = 'rules';
  }
  const out = {
    report: null, extraction: ex, intent: 'delete_report', asset: getAsset(asset.id), alert: null, actions: [], engCase: null,
    similar: [], fixes: [], routed: [], advice: [], answer: null, solution: null, did: [], deleted: [], needsChoice: null, pickedBy,
    graph: { newNodes: 0, newEdges: 0, reinforced: 0 },
  };
  if (targets.length > MAX_VOICE_DELETE) {
    out.needsChoice = { kind: 'delete', confirm: true, prompt: tt('Delete these {n} reports?', { n: targets.length }), options: targets.map(reportOption) };
    out.did.push({ kind: 'note', text: tt('That matches {n} reports on {id}. Nothing is deleted until you confirm.', { n: targets.length, id: asset.id }) });
    return out;
  }
  if (targets.length) {
    const d = deleteReports(targets.map((t) => t.id), { personId: person?.id, reason: text, via: 'voice', lang });
    return { ...out, deleted: d.deleted, did: d.did, asset: getAsset(asset.id) };
  }
  const options = (candidates.length ? candidates : recentReports(asset.id, 5)).map(reportOption);
  if (!options.length) { out.did.push({ kind: 'note', text: tt('{id} has nothing on record to delete.', { id: asset.id }) }); return out; }
  out.needsChoice = { kind: 'delete', prompt: tt('Which report should be deleted?'), options };
  out.did.push({ kind: 'note', text: why === 'ambiguous' ? tt('More than one report on {id} fits. Pick the one to delete.', { id: asset.id }) : tt('Couldn’t tell which report on {id} you meant. Pick it below, or say it again with the part or the day.', { id: asset.id }) });
  return out;
}

/** A correction withdraws the earlier report: its alert closes and it leaves its engineering case. */
function retractReport(reportId, person, reason) {
  const at = nowIso();
  const rep = hydrateReport(q.get('SELECT * FROM reports WHERE id = ?', reportId));
  if (!rep) return;
  const delta = newDelta();
  const touchedCases = [];
  const closedAlerts = [];
  tx(() => {
    const ex = { ...rep.extraction, retracted: { at, by: person?.id || null, reason: clip(reason, 200) } };
    q.run('UPDATE reports SET extraction = ?, summary = ? WHERE id = ?', ex, rep.summary.endsWith('(withdrawn)') ? rep.summary : `${rep.summary} (withdrawn)`, reportId);
    for (const a of q.all(`SELECT id FROM alerts WHERE report_id = ? AND status <> 'resolved'`, reportId)) {
      q.run(`UPDATE alerts SET status = 'resolved', resolution = 'Withdrawn: the reporter corrected this in a later report', updated_at = ? WHERE id = ?`, at, a.id);
      q.run(`UPDATE action_items SET status = 'done', done_at = ? WHERE alert_id = ? AND status = 'open'`, at, a.id);
      closedAlerts.push(a.id);
    }
    for (const cr of q.all('SELECT case_id FROM case_reports WHERE report_id = ?', reportId)) {
      q.run('DELETE FROM case_reports WHERE case_id = ? AND report_id = ?', cr.case_id, reportId);
      q.run("DELETE FROM edges WHERE src = ? AND dst = ? AND type = 'PART_OF'", nodeId('report', String(reportId)), nodeId('case', String(cr.case_id)));
      touchedCases.push(refreshCase(cr.case_id, at));
    }
    relabelNode('report', String(reportId), `${rep.summary.slice(0, 36)} (withdrawn)`, { retracted: true }, delta, at);
  });
  recomputeAssetState(rep.asset_id);
  for (const id of closedAlerts) publish('alert-updated', { alert: alertRow(q.get('SELECT * FROM alerts WHERE id = ?', id)) });
  for (const c of touchedCases.filter(Boolean)) publish('case', { case: c });
  publish('report-updated', { reportId, status: 'retracted', report: reportWithPerson(reportId) });
  publish('graph', delta);
}

/** More information about an issue that's already open: append it and raise severity if it got worse. */
function updateOpenAlert(alertId, ex, person) {
  const a = q.get('SELECT * FROM alerts WHERE id = ?', alertId);
  if (!a) return;
  const at = nowIso();
  const sev = sevRank(ex.severity) > sevRank(a.severity) ? ex.severity : a.severity;
  const stamp = new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const body = `${a.body || ''}\nUpdate ${stamp}${person ? ` from ${person.name}` : ''}: ${ex.summary}.${ex.operator_guidance ? ' ' + ex.operator_guidance : ''}`.slice(-1800);
  q.run(`UPDATE alerts SET severity = ?, body = ?, status = 'open', updated_at = ? WHERE id = ?`, sev, body, at, alertId);
  for (const it of (ex.action_items || []).slice(0, 3)) {
    const dup = q.get(`SELECT id FROM action_items WHERE alert_id = ? AND status = 'open' AND lower(text) = lower(?)`, alertId, it.text);
    if (!dup) q.run(`INSERT INTO action_items (alert_id, site_id, asset_id, text, assignee_role, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)`, alertId, a.site_id, a.asset_id, it.text, it.assignee_role || 'site_manager', at);
  }
  publish('alert', { alert: alertRow(q.get('SELECT * FROM alerts WHERE id = ?', alertId)), actions: [], recipients: 0 });
}

/** Someone asked for a person, part or service: give it to the right role as a task (and an alert if needed). */
function requestHelp(asset, person, ex, existingAlert, reportId) {
  const at = nowIso();
  const role = ROLES.includes(ex.help_role) ? ex.help_role : 'site_manager';
  let alertId = existingAlert?.id || null;
  if (!alertId) {
    const r = q.run(`INSERT INTO alerts (site_id, asset_id, report_id, kind, severity, title, body, audience, status, created_at, updated_at) VALUES (?, ?, ?, 'operational', 'medium', ?, ?, ?, 'open', ?, ?)`,
      asset.site_id, asset.id, reportId || null, `${asset.id} · Help requested: ${clip(ex.help_request, 80)}`, `${person?.name || 'Someone'} asked for ${ex.help_request}${ex.summary ? ` (${ex.summary})` : ''}.`, [role, 'site_manager'], at, at);
    alertId = Number(r.lastInsertRowid);
    publish('alert', { alert: alertRow(q.get('SELECT * FROM alerts WHERE id = ?', alertId)), actions: [], recipients: recipientsFor(asset.site_id, [role, 'site_manager']).length });
  }
  const it = q.run(`INSERT INTO action_items (alert_id, site_id, asset_id, text, assignee_role, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    alertId, asset.site_id, asset.id, `${clip(ex.help_request, 160)} — requested by ${person?.name || 'the operator'} for ${asset.id}`, role, at);
  publish('action', { item: q.get('SELECT * FROM action_items WHERE id = ?', Number(it.lastInsertRowid)) });
  return { role, alertId };
}

/** Offline next steps: the operator-facing guidance and tasks, plus what worked before. */
function ruleAdvice(ex, fixes, tt = translator('en')) {
  const steps = [];
  if (ex.operator_guidance) steps.push(ex.operator_guidance);
  for (const a of (ex.action_items || []).filter((x) => x.assignee_role === 'operator')) steps.push(a.text);
  if (fixes?.[0]) steps.push(tt('Tell the technician what worked before: {fix}.', { fix: fixes[0].title }));
  if (!steps.length) steps.push(tt('Stop if anything looks unsafe, then describe the problem in a report so the right person is alerted.'));
  return [...new Set(steps)].slice(0, 4);
}

export function parseAudience(a) { return parseJson(a.audience, []); }
