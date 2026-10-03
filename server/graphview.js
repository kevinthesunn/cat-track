// The knowledge graph as the map screen draws it: job sites → machines → reports, plus what each
// report mentions (parts, problems, codes, conditions, hazards) and, on request, the engineering
// cases, fixes, people and product documents around them. Reports carry urgency, issue type and
// status so the screen can colour, iconify and filter them without asking the server again.
import { q, parseJson } from './db.js';
import { nodeId } from './graph.js';
import { issueClass } from './vocab.js';

const REPORT_LINKS = {
  AFFECTS: 'component', EXHIBITS: 'symptom', RAISED: 'code', UNDER: 'condition', FLAGS: 'hazard',
  PART_OF: 'case', REPORTED_BY: 'person', APPLIED: 'fix', RESOLVED_BY: 'fix',
};

function reportStatus(r, ex) {
  if (ex.retracted) return 'withdrawn';
  if (r.alert_status) return r.alert_status === 'resolved' ? 'closed' : 'open';
  if (r.category === 'maintenance') return 'repair';
  return 'logged';
}

function problemTitle(r, ex) {
  const part = ex.components?.[0];
  const problem = (ex.symptoms || []).find((s) => s !== 'Warning / fault code') || ex.symptoms?.[0];
  const hazard = ex.safety_hazards?.[0];
  if (r.category === 'maintenance') return part ? `Repair · ${part}` : r.summary;
  if (part && problem) return `${part} · ${problem}`;
  if (hazard) return hazard;
  return part || r.summary;
}

export function graphView() {
  const sites = q.all('SELECT id, name, location, climate FROM sites ORDER BY id');
  const assets = q.all(`SELECT a.id, a.model, a.family, a.status, a.health, a.site_id, a.smu_hours, p.name AS operator_name,
      (SELECT COUNT(*) FROM alerts al WHERE al.asset_id = a.id AND al.status <> 'resolved') AS open_alerts
      FROM assets a LEFT JOIN people p ON p.id = a.operator_id ORDER BY a.id`);
  const reports = q.all(`SELECT r.id, r.asset_id, r.site_id, r.source, r.category, r.severity, r.summary, r.raw_text, r.extraction, r.created_at,
      p.name AS person_name, p.role AS person_role,
      (SELECT al.status FROM alerts al WHERE al.report_id = r.id ORDER BY al.id LIMIT 1) AS alert_status,
      (SELECT al.resolution FROM alerts al WHERE al.report_id = r.id ORDER BY al.id LIMIT 1) AS resolution,
      (SELECT al.updated_at FROM alerts al WHERE al.report_id = r.id AND al.status = 'resolved' ORDER BY al.id LIMIT 1) AS solved_at,
      (SELECT f.title FROM edges e JOIN nodes n ON n.id = e.dst JOIN fixes f ON f.id = CAST(substr(n.id, 5) AS INTEGER)
         WHERE e.src = 'report:' || r.id AND e.type = 'RESOLVED_BY' LIMIT 1) AS fix_title
      FROM reports r LEFT JOIN people p ON p.id = r.person_id ORDER BY r.created_at DESC`);

  const nodes = []; const edges = [];
  for (const s of sites) nodes.push({ id: nodeId('site', s.id), type: 'site', label: s.name, site_id: s.id, location: s.location, climate: s.climate });
  for (const a of assets) {
    const id = nodeId('asset', a.id);
    nodes.push({ id, type: 'asset', label: a.id, asset_id: a.id, model: a.model, family: a.family, status: a.status, health: a.health, site_id: a.site_id, operator_name: a.operator_name, open_alerts: a.open_alerts, hours: Math.round(a.smu_hours || 0) });
    edges.push({ id: `loc:${a.id}`, from: id, to: nodeId('site', a.site_id), type: 'LOCATED_AT' });
  }
  const reportIds = new Set();
  for (const r of reports) {
    const ex = parseJson(r.extraction, {});
    const id = nodeId('report', String(r.id));
    reportIds.add(id);
    nodes.push({
      id, type: 'report', label: problemTitle(r, ex), report_id: r.id, asset_id: r.asset_id, site_id: r.site_id,
      severity: r.severity, category: r.category, issue: issueClass({ ...r, extraction: ex }), status: reportStatus(r, ex),
      created_at: r.created_at, source: r.source, person_name: r.person_name, person_role: r.person_role,
      summary: r.summary, raw_text: r.raw_text, part: ex.components?.[0] || null,
      problem: (ex.symptoms || []).find((s) => s !== 'Warning / fault code') || ex.symptoms?.[0] || null,
      codes: ex.fault_codes || [], conditions: ex.conditions || [], hazards: ex.safety_hazards || [], guidance: ex.operator_guidance || '',
      resolution: r.alert_status === 'resolved' ? r.resolution || r.fix_title || null : null, solved_at: r.alert_status === 'resolved' ? r.solved_at : null, fix_title: r.fix_title || null,
    });
    edges.push({ id: `about:${r.id}`, from: id, to: nodeId('asset', r.asset_id), type: 'ABOUT' });
  }

  // What each report mentions, from the knowledge graph itself.
  const linked = new Set();
  const types = Object.keys(REPORT_LINKS);
  for (const e of q.all(`SELECT id, src, dst, type FROM edges WHERE src LIKE 'report:%' AND type IN (${types.map(() => '?').join(',')})`, ...types)) {
    if (!reportIds.has(e.src)) continue;
    edges.push({ id: `e:${e.id}`, from: e.src, to: e.dst, type: e.type });
    linked.add(e.dst);
  }
  // Fixes for the cases on screen, and the parts they repair.
  for (const e of q.all(`SELECT e.id, e.src, e.dst, e.type FROM edges e WHERE e.src LIKE 'fix:%' AND e.type IN ('RESOLVES', 'REPAIRS')`)) {
    if (!linked.has(e.dst)) continue;
    edges.push({ id: `e:${e.id}`, from: e.src, to: e.dst, type: e.type });
    linked.add(e.src);
  }
  // Product documents that cover the parts, codes and hazards on screen.
  for (const e of q.all(`SELECT e.id, e.src, e.dst, e.type FROM edges e WHERE e.src LIKE 'document:%' AND e.type IN ('SPECIFIES', 'EXPLAINS', 'ADDRESSES')`)) {
    if (!linked.has(e.dst)) continue;
    edges.push({ id: `e:${e.id}`, from: e.src, to: e.dst, type: e.type });
    linked.add(e.src);
  }
  const ids = [...linked];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    for (const n of q.all(`SELECT id, type, label, props, weight FROM nodes WHERE id IN (${chunk.map(() => '?').join(',')})`, ...chunk)) {
      const props = parseJson(n.props, {});
      nodes.push({ id: n.id, type: n.type, label: n.label, weight: n.weight, case_id: props.caseId || null, doc_id: props.docId || null, priority: props.priority || null, meaning: props.meaning || null });
    }
  }
  for (const n of nodes) {
    if (n.type !== 'case' || !n.case_id) continue;
    const c = q.get('SELECT title, status, priority, occurrences FROM eng_cases WHERE id = ?', n.case_id);
    if (c) Object.assign(n, { title: c.title, case_status: c.status, priority: c.priority, occurrences: c.occurrences });
  }
  const known = new Set(nodes.map((n) => n.id));
  return { sites, nodes, edges: edges.filter((e) => known.has(e.from) && known.has(e.to)) };
}
