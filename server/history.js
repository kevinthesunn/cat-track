// Report history: what's on record for a machine or the fleet, and deleting reports (by voice or
// by hand) without leaving traces behind. A deleted report moves to report_trash together with
// everything needed to put it back, so every delete can be undone.
import { q, tx, nowIso, parseJson, alertRow } from './db.js';
import { HttpError } from './errors.js';
import { weaveReport, unweaveReport, pruneOrphans } from './weave.js';
import { newDelta, nodeId, upsertNode, upsertEdge, relabelNode } from './graph.js';
import { SEVERITIES, ISSUE_TYPES, COMPONENTS, SYMPTOMS, issueClass } from './vocab.js';
import { hydrateReport, getAsset, recomputeAssetState } from './memory.js';
import { publish } from './events.js';
import { translator } from './i18n.js';

const DAY = 86400000;
const MAX_BATCH = 25;
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/* ------------------------------ engineering cases ------------------------------ */

export function casePriority(c, severity, distinctAssets) {
  if (severity === 'critical' || c.occurrences >= 4 || (c.occurrences >= 3 && distinctAssets >= 2)) return 'P1';
  if (severity === 'high' || c.occurrences >= 2) return 'P2';
  return 'P3';
}

/** Recount a case from its linked reports; a case left with no reports is closed. */
export function refreshCase(caseId, at = nowIso()) {
  const c = q.get('SELECT * FROM eng_cases WHERE id = ?', caseId);
  if (!c) return null;
  const occurrences = q.get('SELECT COUNT(*) AS n FROM case_reports WHERE case_id = ?', caseId).n;
  if (!occurrences) {
    q.run(`UPDATE eng_cases SET occurrences = 0, status = 'closed', updated_at = ? WHERE id = ?`, at, caseId);
    return q.get('SELECT * FROM eng_cases WHERE id = ?', caseId);
  }
  const distinctAssets = q.get('SELECT COUNT(DISTINCT r.asset_id) AS n FROM case_reports cr JOIN reports r ON r.id = cr.report_id WHERE cr.case_id = ?', caseId).n;
  const maxSev = q.get(`SELECT MAX(CASE r.severity WHEN 'critical' THEN 3 WHEN 'high' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END) AS m, MAX(r.created_at) AS last FROM case_reports cr JOIN reports r ON r.id = cr.report_id WHERE cr.case_id = ?`, caseId);
  const priority = casePriority({ occurrences }, ['low', 'medium', 'high', 'critical'][maxSev.m || 0], distinctAssets);
  // A case that was closed only because its last report was deleted reopens when one comes back.
  const status = c.status === 'closed' && c.occurrences === 0 ? 'new' : c.status;
  q.run('UPDATE eng_cases SET occurrences = ?, priority = ?, last_seen = ?, status = ?, updated_at = ? WHERE id = ?', occurrences, priority, maxSev.last, status, at, caseId);
  return q.get('SELECT * FROM eng_cases WHERE id = ?', caseId);
}

/* ------------------------------ listing ------------------------------ */

/** Where a report stands now: withdrawn, an open issue, a closed one, a repair, or just on record. */
function withStatus(r) {
  const rep = hydrateReport(r);
  let status = 'logged';
  if (rep.extraction.retracted) status = 'withdrawn';
  else if (rep.alert_status) status = rep.alert_status === 'resolved' ? 'closed' : 'open';
  else if (rep.category === 'maintenance') status = 'repair';
  return { ...rep, status, intent: rep.extraction.intent || null, issue: issueClass(rep) };
}

const KIND_SQL = {
  problems: "r.category = 'mechanical'",
  safety: "r.category = 'safety'",
  repairs: "r.category = 'maintenance'",
  sensor: "r.source = 'telemetry'",
  notes: "r.category IN ('observation', 'operational')",
};

/**
 * Reports on record, newest first. Filters: assetId, siteId, personId, search text, kind (an issue
 * type from ISSUE_TYPES, or a legacy category group), status ('open'). `before` is the cursor from
 * the previous page ("<created_at>~<id>"). Each report comes with its notes; `counts` tallies the
 * issue types matching every other filter, for the filter chips.
 */
export function listReports({ assetId, siteId, personId, kind, status, search, before, limit = 30 } = {}) {
  const where = []; const params = [];
  if (assetId) { where.push('r.asset_id = ?'); params.push(assetId); }
  if (siteId) { where.push('r.site_id = ?'); params.push(siteId); }
  if (personId) { where.push('r.person_id = ?'); params.push(personId); }
  if (KIND_SQL[kind]) where.push(KIND_SQL[kind]);
  const term = String(search || '').trim().slice(0, 80);
  if (term) {
    const like = `%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    where.push("(r.raw_text LIKE ? ESCAPE '\\' OR r.summary LIKE ? ESCAPE '\\' OR r.asset_id LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  const rows = q.all(`SELECT r.*, p.name AS person_name, p.role AS person_role, a.model, a.family, s.name AS site_name,
      (SELECT al.status FROM alerts al WHERE al.report_id = r.id ORDER BY al.id LIMIT 1) AS alert_status,
      (SELECT al.id FROM alerts al WHERE al.report_id = r.id ORDER BY al.id LIMIT 1) AS alert_id
      FROM reports r LEFT JOIN people p ON p.id = r.person_id LEFT JOIN assets a ON a.id = r.asset_id LEFT JOIN sites s ON s.id = r.site_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.created_at DESC, r.id DESC LIMIT 5000`, ...params);
  let all = rows.map(withStatus);
  if (status === 'open') all = all.filter((r) => r.status === 'open');
  const counts = {};
  for (const r of all) counts[r.issue] = (counts[r.issue] || 0) + 1;
  if (ISSUE_TYPES[kind]) all = all.filter((r) => r.issue === kind);
  const total = all.length;
  const cur = /^(.+)~(\d+)$/.exec(String(before || ''));
  if (cur) all = all.filter((r) => r.created_at < cur[1] || (r.created_at === cur[1] && r.id < Number(cur[2])));
  const n = Math.max(1, Math.min(100, Number(limit) || 30));
  const reports = all.slice(0, n);
  const ids = reports.map((r) => r.id);
  const notes = ids.length ? q.all(`SELECT nt.*, p.name AS person_name FROM report_notes nt LEFT JOIN people p ON p.id = nt.person_id WHERE nt.report_id IN (${ids.map(() => '?').join(',')}) ORDER BY nt.created_at`, ...ids) : [];
  for (const r of reports) r.notes = notes.filter((x) => x.report_id === r.id);
  const last = reports[reports.length - 1];
  const deleted = q.get(`SELECT COUNT(*) AS n FROM report_trash t ${assetId ? 'WHERE t.asset_id = ?' : siteId ? 'WHERE t.site_id = ?' : ''}`, ...(assetId ? [assetId] : siteId ? [siteId] : [])).n;
  return { reports, total, deleted, counts, next: all.length > n && last ? `${last.created_at}~${last.id}` : null };
}

/** Deleted reports, most recently deleted first, with who deleted them and what they said. */
export function listDeleted({ assetId, siteId, limit = 30 } = {}) {
  const n = Math.max(1, Math.min(100, Number(limit) || 30));
  const rows = q.all(`SELECT t.*, p.name AS deleted_by_name FROM report_trash t LEFT JOIN people p ON p.id = t.deleted_by
      ${assetId ? 'WHERE t.asset_id = ?' : siteId ? 'WHERE t.site_id = ?' : ''} ORDER BY t.deleted_at DESC LIMIT ?`, ...(assetId ? [assetId] : siteId ? [siteId] : []), n);
  return rows.map(trashSummary);
}

function trashSummary(t) {
  const r = parseJson(t.row, {});
  const author = r.person_id ? q.get('SELECT name FROM people WHERE id = ?', r.person_id) : null;
  return {
    id: t.id, asset_id: t.asset_id, site_id: t.site_id, summary: t.summary, created_at: t.created_at,
    raw_text: r.raw_text, severity: r.severity, category: r.category, source: r.source, person_name: author?.name || null, extraction: parseJson(r.extraction, {}),
    deleted_at: t.deleted_at, deleted_by: t.deleted_by, deleted_by_name: t.deleted_by_name ?? (t.deleted_by ? q.get('SELECT name FROM people WHERE id = ?', t.deleted_by)?.name : null),
    reason: t.reason, via: t.via,
  };
}

/** What a picker button needs to show for one report. */
export function reportOption(r) {
  const ex = typeof r.extraction === 'string' ? parseJson(r.extraction, {}) : r.extraction || {};
  return { id: r.id, title: r.summary, summary: r.summary, created_at: r.created_at, person_name: r.person_name || null, severity: r.severity, category: r.category, quote: clip(r.raw_text, 110), extraction: { components: ex.components || [], symptoms: ex.symptoms || [], safety_hazards: ex.safety_hazards || [], fault_codes: ex.fault_codes || [] } };
}

/* ------------------------------ delete ------------------------------ */

/**
 * Delete reports. Each one leaves the record completely: its open alert and tasks close, an issue
 * it marked fixed reopens, a field fix learned only from it is forgotten, it leaves its engineering
 * case, its memory facts go, and it comes out of the knowledge graph. All of it is restorable.
 */
export function deleteReports(ids, { personId = null, reason = '', via = 'manual', lang = 'en' } = {}) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!wanted.length) throw new HttpError(400, 'Pick at least one report to delete.');
  if (wanted.length > MAX_BATCH) throw new HttpError(400, `Delete at most ${MAX_BATCH} reports at a time.`);
  const rows = wanted.map((id) => q.get('SELECT r.*, a.model AS _model FROM reports r LEFT JOIN assets a ON a.id = r.asset_id WHERE r.id = ?', id)).filter(Boolean)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id); // oldest first: see the reopen rule below
  if (!rows.length) throw new HttpError(404, 'Those reports are already deleted.');
  const person = personId ? q.get('SELECT id, name FROM people WHERE id = ?', personId) : null;
  const at = nowIso();
  const removed = { nodes: [], edges: [] };
  const alertIds = new Set(); const caseIds = new Set(); const assetIds = new Set();
  const effects = { alertsClosed: [], alertsReopened: [], fixesRemoved: [], cases: [], facts: 0, graph: { nodes: 0, edges: 0 } };
  const deleted = [];

  tx(() => {
    for (const { _model: model, ...row } of rows) {
      const rep = hydrateReport(row);
      const undo = { alertsClosed: [], alertsReopened: [], cases: [], facts: [], fix: null };

      // The alert this report raised closes, with its open tasks.
      for (const a of q.all(`SELECT id, status, title FROM alerts WHERE report_id = ? AND status <> 'resolved'`, row.id)) {
        const tasks = q.all(`SELECT id FROM action_items WHERE alert_id = ? AND status = 'open'`, a.id).map((t) => t.id);
        q.run(`UPDATE alerts SET status = 'resolved', resolution = ?, updated_at = ? WHERE id = ?`, `Deleted with its report${reason ? `: “${clip(reason, 140)}”` : ''}`, at, a.id);
        q.run(`UPDATE action_items SET status = 'done', done_at = ? WHERE alert_id = ? AND status = 'open'`, at, a.id);
        undo.alertsClosed.push({ id: a.id, status: a.status, tasks });
        effects.alertsClosed.push({ id: a.id, title: a.title, tasks: tasks.length });
        alertIds.add(a.id);
      }
      // An issue this report marked as fixed reopens: the repair it described is off the record.
      // (Not when the issue's own report is gone too — reports are processed oldest first.)
      for (const a of q.all(`SELECT * FROM alerts WHERE resolved_by_report = ? AND status = 'resolved' AND (report_id IS NULL OR EXISTS (SELECT 1 FROM reports WHERE id = alerts.report_id))`, row.id)) {
        const tasks = q.all(`SELECT id FROM action_items WHERE alert_id = ? AND status = 'done' AND done_at = ?`, a.id, a.updated_at).map((t) => t.id);
        q.run(`UPDATE alerts SET status = 'open', resolution = NULL, resolved_by_report = NULL, updated_at = ? WHERE id = ?`, at, a.id);
        for (const t of tasks) q.run(`UPDATE action_items SET status = 'open', done_by = NULL, done_at = NULL WHERE id = ?`, t);
        undo.alertsReopened.push({ id: a.id, resolution: a.resolution, ack_by: a.ack_by, closedAt: a.updated_at, tasks });
        effects.alertsReopened.push({ id: a.id, title: a.title });
        alertIds.add(a.id);
      }
      // A known fix learned from this report is forgotten, unless other crews have confirmed it since.
      const fix = q.get('SELECT * FROM fixes WHERE report_id = ?', row.id);
      if (fix && fix.success <= 1 && fix.fail === 0 && !q.get('SELECT id FROM fix_feedback WHERE fix_id = ? LIMIT 1', fix.id)) {
        const fId = nodeId('fix', String(fix.id));
        for (const e of q.all('SELECT id FROM edges WHERE src = ? OR dst = ?', fId, fId)) removed.edges.push(e.id);
        q.run('DELETE FROM edges WHERE src = ? OR dst = ?', fId, fId);
        if (q.run('DELETE FROM nodes WHERE id = ?', fId).changes) removed.nodes.push(fId);
        q.run('DELETE FROM fixes WHERE id = ?', fix.id);
        undo.fix = fix;
        effects.fixesRemoved.push({ id: fix.id, title: fix.title });
      }
      // It leaves its engineering case.
      for (const cr of q.all('SELECT case_id FROM case_reports WHERE report_id = ?', row.id)) {
        q.run('DELETE FROM case_reports WHERE case_id = ? AND report_id = ?', cr.case_id, row.id);
        undo.cases.push(cr.case_id);
        caseIds.add(cr.case_id);
      }
      // Facts the machine "remembered" because of it go.
      undo.facts = q.all('SELECT asset_id, fact, kind, source_report_id, fact_key, created_at, updated_at FROM memory_facts WHERE source_report_id = ?', row.id);
      q.run('DELETE FROM memory_facts WHERE source_report_id = ?', row.id);
      effects.facts += undo.facts.length;
      // And it comes out of the knowledge graph.
      const g = unweaveReport(rep, model);
      removed.nodes.push(...g.nodes); removed.edges.push(...g.edges);

      q.run(`INSERT INTO report_trash (id, asset_id, site_id, person_id, summary, created_at, row, undo, deleted_at, deleted_by, reason, via)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, row.id, row.asset_id, row.site_id, row.person_id, row.summary, row.created_at, row, undo, at, person?.id || null, clip(reason, 300) || null, via);
      q.run('DELETE FROM reports WHERE id = ?', row.id);
      assetIds.add(row.asset_id);
      deleted.push(trashSummary(q.get('SELECT * FROM report_trash WHERE id = ?', row.id)));
    }
    for (const id of caseIds) {
      const c = refreshCase(id, at);
      if (!c) continue;
      effects.cases.push({ id: c.id, title: c.title, occurrences: c.occurrences, status: c.status });
      // A case that only existed because of deleted reports, and that no engineer has touched,
      // goes away entirely (kept with the deleted reports so a restore brings it back).
      const untouched = !c.quick_fix && !c.root_cause && !c.product_action && !c.engineer && !c.ai_analysis;
      if (c.occurrences === 0 && untouched) {
        const cId = nodeId('case', String(c.id));
        const linked = q.all('SELECT src, dst FROM edges WHERE src = ? OR dst = ?', cId, cId).flatMap((e) => [e.src, e.dst]);
        for (const e of q.all('SELECT id FROM edges WHERE src = ? OR dst = ?', cId, cId)) removed.edges.push(e.id);
        q.run('DELETE FROM edges WHERE src = ? OR dst = ?', cId, cId);
        if (q.run('DELETE FROM nodes WHERE id = ?', cId).changes) removed.nodes.push(cId);
        removed.nodes.push(...pruneOrphans(linked));
        q.run('DELETE FROM eng_cases WHERE id = ?', c.id);
        effects.cases[effects.cases.length - 1].removed = true;
        for (const d of deleted) {
          const t = q.get('SELECT undo FROM report_trash WHERE id = ?', d.id);
          const undo = parseJson(t.undo, {});
          if ((undo.cases || []).includes(c.id)) q.run('UPDATE report_trash SET undo = ? WHERE id = ?', { ...undo, caseRows: [...(undo.caseRows || []), c] }, d.id);
        }
      }
    }
  });

  effects.graph = { edges: removed.edges.length, facts: removed.nodes.filter((id) => !/^(report|fix):/.test(id)).length };
  for (const id of alertIds) publish('alert-updated', { alert: alertRow(q.get('SELECT * FROM alerts WHERE id = ?', id)) });
  for (const c of effects.cases) publish(c.removed ? 'case-removed' : 'case', c.removed ? { id: c.id } : { case: q.get('SELECT * FROM eng_cases WHERE id = ?', c.id) });
  if (removed.nodes.length || removed.edges.length) publish('graph-removed', removed);
  for (const id of assetIds) { const st = recomputeAssetState(id); if (st) publish('asset', { ...getAsset(id), ...st }); }
  publish('report-deleted', { ids: deleted.map((d) => d.id), reports: deleted, by: person?.name || null, via });
  console.log(`[history] deleted report${deleted.length === 1 ? '' : 's'} ${deleted.map((d) => d.id).join(', ')} (${via}${person ? ` by ${person.name}` : ''})`);
  return { deleted, effects, did: describeDeletion(deleted, effects, lang) };
}

/** Plain-language list of everything a delete changed, for the person who asked for it. */
function describeDeletion(deleted, effects, lang = 'en') {
  const tt = translator(lang);
  const plural = (n, one, many) => (n === 1 ? tt(one, { n }) : tt(many, { n }));
  const did = deleted.map((r) => ({ kind: 'deleted', text: r.person_name ? tt('Deleted “{summary}”, reported by {name}.', { summary: clip(r.summary, 90), name: r.person_name }) : tt('Deleted “{summary}”.', { summary: clip(r.summary, 90) }), reportId: r.id }));
  for (const a of effects.alertsClosed) did.push({ kind: 'resolved', text: a.tasks ? tt('Closed its alert “{title}” and {tasks}.', { title: clip(a.title, 80), tasks: plural(a.tasks, '1 open task', '{n} open tasks') }) : tt('Closed its alert “{title}”.', { title: clip(a.title, 80) }) });
  for (const a of effects.alertsReopened) did.push({ kind: 'note', text: tt('Reopened “{title}”: the repair that closed it is no longer on record.', { title: clip(a.title, 80) }) });
  for (const f of effects.fixesRemoved) did.push({ kind: 'retracted', text: tt('Forgot the known fix “{title}” that was learned from it.', { title: clip(f.title, 80) }) });
  for (const c of effects.cases) did.push({ kind: 'case', text: c.occurrences ? tt('Took it out of CAT Engineering case #{id}, now {reports}.', { id: c.id, reports: plural(c.occurrences, '1 report', '{n} reports') }) : c.removed ? tt('CAT Engineering case #{id} existed only because of this report, so it was removed.', { id: c.id }) : tt('CAT Engineering case #{id} had no reports left, so it was closed.', { id: c.id }) });
  if (effects.graph.edges) did.push({ kind: 'graph', text: effects.graph.facts ? tt('Took {links} out of the knowledge graph, plus {facts} nothing else mentioned.', { links: plural(effects.graph.edges, '1 link', '{n} links'), facts: plural(effects.graph.facts, '1 fact', '{n} facts') }) : tt('Took {links} out of the knowledge graph.', { links: plural(effects.graph.edges, '1 link', '{n} links') }) });
  return did;
}

/* ------------------------------ restore ------------------------------ */

/** Put deleted reports back exactly as they were, with their alerts, case links, fix and graph links. */
export function restoreReports(ids, { personId = null } = {}) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, MAX_BATCH);
  const rows = wanted.map((id) => q.get('SELECT * FROM report_trash WHERE id = ?', id)).filter(Boolean)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  if (!rows.length) throw new HttpError(404, 'Nothing to restore — those reports are already back.');
  const at = nowIso();
  const delta = newDelta();
  const alertIds = new Set(); const caseIds = new Set(); const assetIds = new Set();
  const restored = [];

  tx(() => {
    for (const t of rows) {
      const r = parseJson(t.row, null);
      const undo = parseJson(t.undo, {});
      q.run('DELETE FROM report_trash WHERE id = ?', t.id);
      if (!r || q.get('SELECT id FROM reports WHERE id = ?', r.id)) continue;
      q.run(`INSERT INTO reports (id, asset_id, site_id, person_id, source, raw_text, photo_path, category, severity, summary, extraction, ai_mode, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, r.id, r.asset_id, r.site_id, r.person_id, r.source, r.raw_text, r.photo_path, r.category, r.severity, r.summary, r.extraction, r.ai_mode, r.created_at);
      const ex = parseJson(r.extraction, {});
      const asset = getAsset(r.asset_id);
      let rNode = nodeId('report', String(r.id));
      if (asset) {
        const person = r.person_id ? q.get('SELECT * FROM people WHERE id = ?', r.person_id) : null;
        const label = ex.retracted ? `${String(r.summary).replace(/ \(withdrawn\)$/, '').slice(0, 36)} (withdrawn)` : r.summary;
        rNode = weaveReport({ reportId: r.id, ex, label, asset, person, source: r.source, createdAt: r.created_at, similar: ex.similar || [], delta }).rNode;
      }
      for (const c of undo.caseRows || []) {
        if (q.get('SELECT id FROM eng_cases WHERE id = ?', c.id) || q.get('SELECT id FROM eng_cases WHERE case_key = ?', c.case_key)) continue;
        q.run(`INSERT INTO eng_cases (id, case_key, model, component, symptom, title, status, priority, occurrences, first_seen, last_seen, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'new', ?, 0, ?, ?, ?)`,
          c.id, c.case_key, c.model, c.component, c.symptom, c.title, c.priority, c.first_seen, c.last_seen, at);
        const caseNode = upsertNode('case', String(c.id), `Case #${c.id}: ${c.component}`, { caseId: c.id, priority: c.priority, status: 'new' }, delta, at);
        upsertEdge(caseNode, nodeId('model', c.model), 'CONCERNS', delta, at);
        if (q.get('SELECT id FROM nodes WHERE id = ?', nodeId('component', c.component))) upsertEdge(caseNode, nodeId('component', c.component), 'CONCERNS', delta, at);
      }
      for (const caseId of undo.cases || []) {
        if (!q.get('SELECT id FROM eng_cases WHERE id = ?', caseId)) continue;
        q.run('INSERT OR IGNORE INTO case_reports (case_id, report_id) VALUES (?, ?)', caseId, r.id);
        upsertEdge(rNode, nodeId('case', String(caseId)), 'PART_OF', delta, at);
        caseIds.add(caseId);
      }
      for (const a of undo.alertsClosed || []) {
        const cur = q.get('SELECT status FROM alerts WHERE id = ?', a.id);
        if (!cur || cur.status !== 'resolved') continue;
        q.run('UPDATE alerts SET status = ?, resolution = NULL, updated_at = ? WHERE id = ?', a.status || 'open', at, a.id);
        for (const id of a.tasks || []) q.run(`UPDATE action_items SET status = 'open', done_by = NULL, done_at = NULL WHERE id = ?`, id);
        alertIds.add(a.id);
      }
      for (const a of undo.alertsReopened || []) {
        const cur = q.get('SELECT status FROM alerts WHERE id = ?', a.id);
        if (!cur || cur.status === 'resolved') continue;
        q.run(`UPDATE alerts SET status = 'resolved', resolution = ?, ack_by = COALESCE(ack_by, ?), resolved_by_report = ?, updated_at = ? WHERE id = ?`, a.resolution, a.ack_by, r.id, a.closedAt || at, a.id);
        for (const id of a.tasks || []) q.run(`UPDATE action_items SET status = 'done', done_at = ? WHERE id = ? AND status = 'open'`, a.closedAt || at, id);
        alertIds.add(a.id);
      }
      const f = undo.fix;
      if (f && !q.get('SELECT id FROM fixes WHERE id = ?', f.id)) {
        q.run(`INSERT INTO fixes (id, model, component, symptom, title, steps, source, author, case_id, success, fail, created_at, report_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          f.id, f.model, f.component, f.symptom, f.title, f.steps, f.source, f.author, f.case_id, f.success, f.fail, f.created_at, f.report_id);
        const fNode = upsertNode('fix', String(f.id), String(f.title).slice(0, 40), { fixId: f.id, source: f.source }, delta, at);
        upsertEdge(rNode, fNode, 'APPLIED', delta, at);
        if (f.component && q.get('SELECT id FROM nodes WHERE id = ?', nodeId('component', f.component))) upsertEdge(fNode, nodeId('component', f.component), 'REPAIRS', delta, at);
        if (f.model) upsertEdge(fNode, nodeId('model', f.model), 'APPLIES_TO', delta, at);
      }
      for (const m of undo.facts || []) {
        q.run(`INSERT OR IGNORE INTO memory_facts (asset_id, fact, kind, source_report_id, fact_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          m.asset_id, m.fact, m.kind, m.source_report_id, m.fact_key, m.created_at, m.updated_at);
      }
      assetIds.add(r.asset_id);
      restored.push(r.id);
    }
    for (const id of caseIds) refreshCase(id, at);
  });

  const reports = restored.map((id) => withStatus(q.get(`SELECT r.*, p.name AS person_name, p.role AS person_role,
      (SELECT al.status FROM alerts al WHERE al.report_id = r.id ORDER BY al.id LIMIT 1) AS alert_status
      FROM reports r LEFT JOIN people p ON p.id = r.person_id WHERE r.id = ?`, id)));
  for (const id of alertIds) publish('alert-updated', { alert: alertRow(q.get('SELECT * FROM alerts WHERE id = ?', id)) });
  for (const id of caseIds) publish('case', { case: q.get('SELECT * FROM eng_cases WHERE id = ?', id) });
  if (delta.nodes.length || delta.edges.length) publish('graph', delta);
  for (const id of assetIds) { const st = recomputeAssetState(id); if (st) publish('asset', { ...getAsset(id), ...st }); }
  publish('report-restored', { ids: restored, reports });
  console.log(`[history] restored report${restored.length === 1 ? '' : 's'} ${restored.join(', ')}${personId ? ` (by ${personId})` : ''}`);
  return { restored: reports };
}

/* ------------------------------ which report did they mean? ------------------------------ */

// Words that say how to delete, not which report: they never count as a description.
const FILLER = new Set(`the a an my our your that this these those it its last latest previous recent most newest one ones report reports log logs
  entry entries note notes message messages record records request requests submission please delete deleted remove removed erase cancel scrap
  discard wipe withdraw get rid take out down throw away from about for on of to was were is are be been i me we us just earlier yesterday today
  morning afternoon evening night week hour hours minute minutes ago sent made filed logged said did do mistake wrong accident accidentally sorry
  ignore never mind scratch disregard forget false actually didn wasn isn there they them what when where here have has will would could should also
  still know think want need like thanks thank okay fine good alright with and or but all every everything first second third two three four five unit machine`.split(/\s+/));
const NUMBER = { two: 2, three: 3, four: 4, five: 5, '2': 2, '3': 3, '4': 4, '5': 5 };

/**
 * Rule-based reading of "delete …": which of this machine's reports it points at. Used when the AI
 * is off or didn't name valid ids. Returns ids to delete, or candidates for the person to pick from.
 */
export function findReportsToDelete(text, ex, asset, person) {
  const lower = String(text || '').toLowerCase();
  let pool = q.all(`SELECT r.*, p.name AS person_name FROM reports r LEFT JOIN people p ON p.id = r.person_id
                    WHERE r.asset_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 40`, asset.id).map(hydrateReport);
  if (!pool.length) return { ids: [], candidates: [], plural: false };
  if (person && /\b(my|mine|i (sent|made|filed|logged|reported|said|did))\b/.test(lower)) {
    const own = pool.filter((r) => r.person_id === person.id);
    if (own.length) pool = own;
  }
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  if (/\b(today|this morning|this afternoon|tonight)\b/.test(lower)) pool = pool.filter((r) => new Date(r.created_at) >= midnight);
  else if (/\byesterday\b/.test(lower)) pool = pool.filter((r) => { const d = new Date(r.created_at); return d < midnight && d >= new Date(midnight.getTime() - DAY); });
  if (!pool.length) return { ids: [], candidates: [], plural: false };

  const countM = lower.match(/\b(?:last|previous|latest)\s+(two|three|four|five|[2-5])\b/);
  const count = countM ? NUMBER[countM[1]] : 0;
  const all = /\b(all|every|everything)\b/.test(lower);
  const terms = [...(ex.components || []), ...(ex.symptoms || []).filter((s) => s !== 'Warning / fault code'), ...(ex.fault_codes || []), ...(ex.safety_hazards || [])];
  const words = [...new Set(lower.replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !FILLER.has(w)))];
  const score = (r) => {
    const e = r.extraction || {};
    const known = new Set([...(e.components || []), ...(e.symptoms || []), ...(e.fault_codes || []), ...(e.safety_hazards || [])]);
    const hay = `${r.summary} ${r.raw_text}`.toLowerCase();
    return terms.filter((t) => known.has(t)).length * 3 + words.filter((w) => hay.includes(w)).length;
  };
  const scored = terms.length || words.length
    ? pool.map((r) => ({ r, s: score(r) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || b.r.created_at.localeCompare(a.r.created_at))
    : [];
  if (scored.length) {
    if (all) return { ids: scored.map((x) => x.r.id).slice(0, MAX_BATCH), candidates: [], plural: true };
    if (count) return { ids: scored.slice(0, count).map((x) => x.r.id), candidates: [], plural: true };
    const tied = scored.filter((x) => x.s === scored[0].s);
    if (tied.length === 1 || /\b(last|latest|most recent|newest)\b/.test(lower)) return { ids: [scored[0].r.id], candidates: [], plural: false };
    return { ids: [], candidates: tied.slice(0, 5).map((x) => x.r), plural: false, why: 'ambiguous' };
  }
  if (all) return { ids: pool.map((r) => r.id).slice(0, MAX_BATCH), candidates: [], plural: true };
  if (count) return { ids: pool.slice(0, count).map((r) => r.id), candidates: [], plural: true };
  // "delete my last report", "scratch that": the newest one. A description that matched nothing: ask.
  if (!terms.length && !words.length) return { ids: [pool[0].id], candidates: [], plural: false };
  return { ids: [], candidates: pool.slice(0, 5), plural: false, why: 'no-match' };
}

/* ------------------------------ edit ------------------------------ */

const PARTS = new Set(COMPONENTS.map((c) => c.name));
const PROBLEMS = new Set(SYMPTOMS.map((x) => x.name));
const tidy = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const primaryProblem = (ex) => (ex.symptoms || []).find((x) => x !== 'Warning / fault code') || '';

function reportWithMeta(id) {
  const r = q.get(`SELECT r.*, p.name AS person_name, p.role AS person_role, a.model, a.family, s.name AS site_name,
      (SELECT al.status FROM alerts al WHERE al.report_id = r.id ORDER BY al.id LIMIT 1) AS alert_status
      FROM reports r LEFT JOIN people p ON p.id = r.person_id LEFT JOIN assets a ON a.id = r.asset_id LEFT JOIN sites s ON s.id = r.site_id WHERE r.id = ?`, id);
  return r ? { ...withStatus(r), notes: listNotes(id) } : null;
}

/**
 * Correct a report by hand: headline, urgency, what was said, the part, the problem, and the type of
 * issue. A new part or problem re-links the report in the knowledge graph; a new urgency carries
 * through to its open alert and engineering case. Every edit is recorded on the report.
 */
export function editReport(id, changes = {}, { personId = null } = {}) {
  id = Number(id);
  const row = q.get('SELECT r.*, a.model AS _model FROM reports r LEFT JOIN assets a ON a.id = r.asset_id WHERE r.id = ?', id);
  if (!row) throw new HttpError(404, q.get('SELECT id FROM report_trash WHERE id = ?', id) ? 'That report was deleted. Restore it first to edit it.' : 'Report not found.');
  const { _model: model, ...reportRow } = row;
  const rep = hydrateReport(reportRow);
  const ex = rep.extraction || {};
  const person = personId ? q.get('SELECT id, name FROM people WHERE id = ?', personId) : null;
  const next = { ...ex };
  const fields = [];
  let summary = rep.summary; let severity = rep.severity; let rawText = rep.raw_text;

  if (changes.summary !== undefined) {
    const v = tidy(changes.summary, 140);
    if (!v) throw new HttpError(400, 'The headline can’t be empty.');
    if (v !== summary) { summary = v; fields.push('headline'); }
  }
  if (changes.severity !== undefined) {
    if (!SEVERITIES.includes(changes.severity)) throw new HttpError(400, `Urgency must be one of ${SEVERITIES.join(', ')}.`);
    if (changes.severity !== severity) { severity = changes.severity; fields.push('urgency'); }
  }
  if (changes.raw_text !== undefined) {
    const v = String(changes.raw_text ?? '').trim().slice(0, 4000);
    if (!v) throw new HttpError(400, 'What was said can’t be empty.');
    if (v !== rawText) { rawText = v; fields.push('what was said'); }
  }
  if (changes.part !== undefined) {
    const v = tidy(changes.part, 80); const old = ex.components?.[0] || '';
    if (v && !PARTS.has(v)) throw new HttpError(400, `“${v}” isn’t a part Cat Track knows. Pick one from the list.`);
    if (v !== old) { next.components = v ? [v, ...(ex.components || []).filter((c) => c !== v && c !== old)] : (ex.components || []).filter((c) => c !== old); fields.push('part'); }
  }
  if (changes.problem !== undefined) {
    const v = tidy(changes.problem, 80); const old = primaryProblem(ex);
    if (v && !PROBLEMS.has(v)) throw new HttpError(400, `“${v}” isn’t a problem Cat Track knows. Pick one from the list.`);
    if (v !== old) { next.symptoms = v ? [v, ...(ex.symptoms || []).filter((x) => x !== v && x !== old)] : (ex.symptoms || []).filter((x) => x !== old); fields.push('problem'); }
  }
  if (changes.issue !== undefined) {
    const v = !changes.issue || changes.issue === 'auto' ? null : changes.issue;
    if (v && !ISSUE_TYPES[v]) throw new HttpError(400, 'Unknown type of issue.');
    if (v !== (ex.issue_override || null)) { if (v) next.issue_override = v; else delete next.issue_override; fields.push('type of issue'); }
  }
  if (!fields.length) return { report: reportWithMeta(id), changed: [] };

  const at = nowIso();
  Object.assign(next, { summary, severity });
  next.edits = [...(ex.edits || []), { at, by: person?.id || null, by_name: person?.name || null, fields }].slice(-20);
  const relink = fields.includes('part') || fields.includes('problem');
  const caseIds = q.all('SELECT case_id FROM case_reports WHERE report_id = ?', id).map((c) => c.case_id);
  const delta = newDelta();
  let removed = { nodes: [], edges: [] };
  const alertIds = [];
  tx(() => {
    q.run('UPDATE reports SET summary = ?, severity = ?, raw_text = ?, extraction = ? WHERE id = ?', summary, severity, rawText, next, id);
    const asset = getAsset(rep.asset_id);
    if (relink && asset) {
      // Take the old links out and weave the corrected report back in, keeping its case and fix links.
      removed = unweaveReport(rep, model);
      const author = rep.person_id ? q.get('SELECT * FROM people WHERE id = ?', rep.person_id) : null;
      const { rNode } = weaveReport({ reportId: id, ex: next, label: summary, asset, person: author, source: rep.source, createdAt: rep.created_at, similar: ex.similar || [], delta });
      for (const c of caseIds) if (q.get('SELECT id FROM nodes WHERE id = ?', nodeId('case', String(c)))) upsertEdge(rNode, nodeId('case', String(c)), 'PART_OF', delta, at);
      const fix = q.get('SELECT id FROM fixes WHERE report_id = ?', id);
      if (fix && q.get('SELECT id FROM nodes WHERE id = ?', nodeId('fix', String(fix.id)))) upsertEdge(rNode, nodeId('fix', String(fix.id)), 'APPLIED', delta, at);
    } else if (fields.includes('headline') || fields.includes('urgency')) {
      relabelNode('report', String(id), summary.slice(0, 48), { severity }, delta, at);
    }
    for (const a of q.all(`SELECT id FROM alerts WHERE report_id = ? AND status <> 'resolved'`, id)) {
      if (fields.includes('urgency')) q.run('UPDATE alerts SET severity = ?, updated_at = ? WHERE id = ?', severity, at, a.id);
      if (fields.includes('headline')) q.run('UPDATE alerts SET title = ?, updated_at = ? WHERE id = ?', `${rep.asset_id} · ${summary}`, at, a.id);
      if (fields.includes('urgency') || fields.includes('headline')) alertIds.push(a.id);
    }
    if (fields.includes('urgency')) for (const c of caseIds) refreshCase(c, at);
  });

  const readded = new Set(delta.nodes.map((n) => n.id));
  removed.nodes = removed.nodes.filter((nid) => !readded.has(nid));
  if (removed.nodes.length || removed.edges.length) publish('graph-removed', removed);
  if (delta.nodes.length || delta.edges.length) publish('graph', delta);
  for (const aid of alertIds) publish('alert-updated', { alert: alertRow(q.get('SELECT * FROM alerts WHERE id = ?', aid)) });
  if (fields.includes('urgency')) for (const c of caseIds) publish('case', { case: q.get('SELECT * FROM eng_cases WHERE id = ?', c) });
  const st = recomputeAssetState(rep.asset_id);
  if (st) publish('asset', { ...getAsset(rep.asset_id), ...st });
  const report = reportWithMeta(id);
  publish('report-updated', { reportId: id, status: 'edited', fields, by: person?.name || null, report });
  console.log(`[history] report ${id} edited (${fields.join(', ')})${person ? ` by ${person.name}` : ''}`);
  return { report, changed: fields };
}

/* ------------------------------ notes ------------------------------ */

export function listNotes(reportId) {
  return q.all('SELECT nt.*, p.name AS person_name FROM report_notes nt LEFT JOIN people p ON p.id = nt.person_id WHERE nt.report_id = ? ORDER BY nt.created_at, nt.id', Number(reportId));
}

export function addNote(reportId, text, { personId = null } = {}) {
  reportId = Number(reportId);
  const body = String(text ?? '').trim().slice(0, 1000);
  if (!body) throw new HttpError(400, 'Write the note first.');
  if (!q.get('SELECT id FROM reports WHERE id = ?', reportId)) throw new HttpError(404, 'Report not found.');
  const r = q.run('INSERT INTO report_notes (report_id, person_id, text, created_at) VALUES (?, ?, ?, ?)', reportId, personId || null, body, nowIso());
  const note = q.get('SELECT nt.*, p.name AS person_name FROM report_notes nt LEFT JOIN people p ON p.id = nt.person_id WHERE nt.id = ?', Number(r.lastInsertRowid));
  publish('report-note', { reportId, action: 'added', note });
  return { note, notes: listNotes(reportId) };
}

export function deleteNote(reportId, noteId) {
  const r = q.run('DELETE FROM report_notes WHERE id = ? AND report_id = ?', Number(noteId), Number(reportId));
  if (!r.changes) throw new HttpError(404, 'That note is already gone.');
  publish('report-note', { reportId: Number(reportId), action: 'deleted', noteId: Number(noteId) });
  return { notes: listNotes(reportId) };
}
