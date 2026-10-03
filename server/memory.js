// Machine memory: recall of similar past events across the fleet, fix ranking that learns from
// field feedback, distilled long-term facts per asset, and role-tailored insights.
import { q, parseJson } from './db.js';
import { sevRank } from './vocab.js';

const DAY = 86400000;
const daysAgo = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / DAY));
const PM_INTERVAL = 500;

export function normalizeAssetId(raw) {
  let s = String(raw || '').toUpperCase().trim();
  // Accept QR payloads that are URLs (…/operator.html?unit=EX-0412) or "CAT-EX-0412" style tags.
  const urlMatch = s.match(/[?&]UNIT=([A-Z0-9-]+)/);
  if (urlMatch) s = urlMatch[1];
  s = s.replace(/\s+/g, '').replace(/^CAT[-_]?/, '');
  const m = s.match(/^([A-Z]{2})-?(\d{3,4})$/);
  return m ? `${m[1]}-${m[2].padStart(4, '0')}` : s;
}

export function getAsset(id) {
  return q.get(
    `SELECT a.*, s.name AS site_name, s.location AS site_location, s.climate AS site_climate, p.name AS operator_name
       FROM assets a LEFT JOIN sites s ON s.id = a.site_id LEFT JOIN people p ON p.id = a.operator_id WHERE a.id = ?`, id);
}

export function hydrateReport(r) {
  if (!r) return r;
  return { ...r, extraction: parseJson(r.extraction, {}) };
}

export function recentReports(assetId, limit = 10) {
  return q.all(
    `SELECT r.*, p.name AS person_name, p.role AS person_role FROM reports r LEFT JOIN people p ON p.id = r.person_id
      WHERE r.asset_id = ? ORDER BY r.created_at DESC LIMIT ?`, assetId, limit).map(hydrateReport);
}

/** Find past reports that look like this observation (same machine, model, part, symptom, code, condition). */
export function recallSimilar(ex, asset, { excludeId = null, limit = 5 } = {}) {
  const rows = q.all(
    `SELECT r.id, r.asset_id, r.created_at, r.summary, r.severity, r.category, r.extraction, r.raw_text, a.model
       FROM reports r JOIN assets a ON a.id = r.asset_id
      WHERE r.category IN ('mechanical','safety','maintenance') ORDER BY r.created_at DESC LIMIT 600`);
  const set = (arr) => new Set(arr || []);
  const comps = set(ex.components); const syms = set(ex.symptoms); const codes = set(ex.fault_codes); const conds = set(ex.conditions);
  const scored = [];
  for (const r of rows) {
    if (r.id === excludeId) continue;
    const e = parseJson(r.extraction, {});
    let score = 0; const reasons = [];
    if (asset && r.asset_id === asset.id) { score += 3; reasons.push('same machine'); }
    else if (asset && r.model === asset.model) { score += 2; reasons.push(`same model (${r.model})`); }
    const sharedCodes = (e.fault_codes || []).filter((c) => codes.has(c));
    const sharedComps = (e.components || []).filter((c) => comps.has(c));
    const sharedSyms = (e.symptoms || []).filter((s) => syms.has(s) && s !== 'Warning / fault code');
    const sharedConds = (e.conditions || []).filter((c) => conds.has(c));
    score += sharedCodes.length * 4 + sharedComps.length * 2.5 + sharedSyms.length * 2 + sharedConds.length;
    sharedCodes.forEach((c) => reasons.push(`code ${c}`));
    sharedComps.forEach((c) => reasons.push(c));
    sharedSyms.forEach((s) => reasons.push(s.toLowerCase()));
    sharedConds.forEach((c) => reasons.push(c.toLowerCase()));
    if (!sharedComps.length && !sharedCodes.length && !sharedSyms.length) continue;
    if (r.category === 'maintenance') { score += 0.5; reasons.push('repair record'); }
    score -= Math.min(2, daysAgo(r.created_at) / 90);
    if (score >= 4.5) scored.push({ id: r.id, asset_id: r.asset_id, model: r.model, created_at: r.created_at, summary: r.summary, severity: r.severity, category: r.category, quote: r.raw_text, score: Math.round(score * 10) / 10, reasons });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Rank known fixes for a machine model + observation. Confidence is a Laplace-smoothed success rate, so field feedback directly reshapes future recommendations. */
export function rankFixes(model, components = [], symptoms = [], limit = 3) {
  const rows = q.all('SELECT * FROM fixes WHERE model IS NULL OR model = ?', model);
  const comps = new Set(components); const syms = new Set(symptoms);
  return rows
    .map((f) => {
      const compHit = f.component && comps.has(f.component);
      const symHit = f.symptom && syms.has(f.symptom);
      if (!compHit && !(symHit && !f.component)) return null;
      const confidence = (f.success + 1) / (f.success + f.fail + 2);
      const relevance = (compHit ? 2 : 0) + (symHit ? 1.5 : 0) + (f.model ? 0.5 : 0);
      return { ...f, confidence: Math.round(confidence * 100), rank: relevance * confidence };
    })
    .filter(Boolean)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit);
}

export function fixesForModel(model) {
  return q.all('SELECT * FROM fixes WHERE model = ? OR model IS NULL ORDER BY (success + 1.0) / (success + fail + 2.0) DESC LIMIT 12', model);
}

/** Durable facts this machine "remembers", distilled from its history and the fleet. */
export function assetMemory(assetId) {
  const asset = getAsset(assetId);
  if (!asset) return [];
  const facts = [];
  const reports = q.all(`SELECT * FROM reports WHERE asset_id = ? ORDER BY created_at DESC LIMIT 200`, assetId).map(hydrateReport);

  // Recurring problems (same component + symptom ≥ 2 times in 90 days)
  const recur = new Map();
  for (const r of reports) {
    if (r.category !== 'mechanical' || daysAgo(r.created_at) > 90) continue;
    const c = r.extraction.components?.[0]; const s = (r.extraction.symptoms || []).find((x) => x !== 'Warning / fault code');
    if (!c || !s) continue;
    const k = `${s}|${c}`;
    const v = recur.get(k) || { s, c, n: 0, last: r.created_at };
    v.n++; recur.set(k, v);
  }
  for (const v of recur.values()) {
    if (v.n >= 2) facts.push({ kind: 'pattern', level: v.n >= 3 ? 'high' : 'medium', text: `Recurring ${v.s.toLowerCase()} on ${v.c.toLowerCase()} — ${v.n}× in 90 days (last ${daysAgo(v.last)}d ago)` });
  }

  // Environmental correlations (symptom co-occurs with a condition ≥ 2 times)
  const env = new Map();
  for (const r of reports) {
    for (const s of r.extraction.symptoms || []) {
      if (s === 'Warning / fault code') continue;
      for (const c of r.extraction.conditions || []) {
        const k = `${s}|${c}`; env.set(k, (env.get(k) || 0) + 1);
      }
    }
  }
  for (const [k, n] of env) {
    if (n >= 2) { const [s, c] = k.split('|'); facts.push({ kind: 'environment', level: 'medium', text: `${s} tends to show up under ${c.toLowerCase()} (${n} reports)` }); }
  }

  // Fleet patterns this machine is part of
  const cases = q.all(
    `SELECT DISTINCT c.* FROM eng_cases c JOIN case_reports cr ON cr.case_id = c.id JOIN reports r ON r.id = cr.report_id
      WHERE r.asset_id = ? AND c.status <> 'closed' ORDER BY c.last_seen DESC`, assetId);
  for (const c of cases) {
    const machines = q.get(`SELECT COUNT(DISTINCT r.asset_id) AS n FROM case_reports cr JOIN reports r ON r.id = cr.report_id WHERE cr.case_id = ?`, c.id).n;
    facts.push({ kind: 'fleet', level: c.priority === 'P1' ? 'high' : 'medium', caseId: c.id, text: `Part of fleet pattern "${c.title}" — ${c.occurrences} reports on ${machines} machine${machines === 1 ? '' : 's'} (CAT Engineering: ${c.status.replace(/_/g, ' ')})` });
    if (c.quick_fix) facts.push({ kind: 'bulletin', level: 'info', caseId: c.id, text: `CAT quick fix available: ${c.quick_fix}` });
  }

  // Service interval
  if (asset.last_service_hours != null) {
    const since = Math.round(asset.smu_hours - asset.last_service_hours);
    const due = PM_INTERVAL - since;
    facts.push({ kind: 'service', level: due < 50 ? 'medium' : 'info', text: due > 0 ? `${since} h since last PM — next ${PM_INTERVAL} h service due in ~${due} h` : `PM overdue by ${-due} h` });
  }

  // Product documents that apply to this model (or to every machine)
  for (const d of q.all(`SELECT DISTINCT d.id, d.title, d.doc_type, d.integrated_at FROM documents d JOIN doc_models m ON m.doc_id = d.id
                         WHERE d.status = 'integrated' AND (m.model = ? OR m.model = '*') ORDER BY d.integrated_at DESC LIMIT 4`, asset.model)) {
    const kind = { spec_sheet: 'Spec sheet', policy: 'Policy', service_bulletin: 'Service bulletin', manual: 'Manual' }[d.doc_type] || 'Document';
    facts.push({ kind: 'document', level: 'info', docId: d.id, text: `${kind} on file: ${d.title} [D${d.id}]` });
  }

  // Stored facts (repairs, learned notes)
  for (const f of q.all('SELECT * FROM memory_facts WHERE asset_id = ? ORDER BY created_at DESC LIMIT 6', assetId)) {
    facts.push({ kind: f.kind || 'note', level: 'info', text: `${f.fact} (${daysAgo(f.created_at)}d ago)` });
  }
  const order = { high: 0, medium: 1, info: 2 };
  return facts.sort((a, b) => order[a.level] - order[b.level]);
}

export function openAlertsForAsset(assetId) {
  return q.all(`SELECT * FROM alerts WHERE asset_id = ? AND status <> 'resolved' ORDER BY created_at DESC`, assetId);
}

/** Health/status are derived from open issues + age so they always reflect current memory. */
export function recomputeAssetState(assetId) {
  const asset = q.get('SELECT * FROM assets WHERE id = ?', assetId);
  if (!asset) return null;
  const open = q.all(
    `SELECT al.severity, al.kind FROM alerts al WHERE al.asset_id = ? AND al.status <> 'resolved' AND al.kind IN ('mechanical','safety')`, assetId);
  let health = 100 - Math.min(22, asset.smu_hours / 700);
  let status = 'operational';
  for (const a of open) {
    health -= { critical: 35, high: 16, medium: 6, low: 0 }[a.severity] || 0;
    if (a.kind === 'mechanical' && a.severity === 'critical') status = 'down';
    else if (a.kind === 'mechanical' && a.severity === 'high' && status !== 'down') status = 'attention';
  }
  const recurring = assetMemory(assetId).filter((f) => f.kind === 'pattern').length;
  health -= recurring * 4;
  health = Math.max(8, Math.min(99, Math.round(health)));
  q.run('UPDATE assets SET health = ?, status = ?, updated_at = ? WHERE id = ?', health, status, new Date().toISOString(), assetId);
  return { ...asset, health, status };
}

/** Insights tailored to who is looking: operator, technician or fleet manager. */
export function roleInsights(assetId, role = 'operator') {
  const asset = getAsset(assetId);
  if (!asset) return null;
  const memory = assetMemory(assetId);
  const reports = recentReports(assetId, 40);
  const alerts = openAlertsForAsset(assetId);
  const items = [];
  const push = (title, detail, level = 'info') => items.push({ title, detail, level });
  const mech = reports.filter((r) => r.category === 'mechanical');
  const lastMech = mech[0];

  if (role === 'operator') {
    for (const f of memory.filter((m) => m.kind === 'pattern')) {
      const comp = f.text.match(/on (.+?) —/)?.[1] || 'this area';
      push(`Walkaround focus: ${comp}`, `${f.text}. Check it before you start and report any change.`, f.level);
    }
    for (const a of alerts.slice(0, 3)) push(`Open alert: ${a.title}`, a.body || '', a.severity === 'critical' ? 'high' : 'medium');
    for (const f of memory.filter((m) => m.kind === 'bulletin')) push('CAT quick fix in effect', f.text.replace('CAT quick fix available: ', ''), 'info');
    if (/hot/i.test(asset.site_climate || '')) push('Hot site conditions', 'Watch coolant and hydraulic oil temperature on long climbs; idle down before shutdown and keep radiator cores clear of dust.', 'medium');
    if (/wet|humid/i.test(asset.site_climate || '')) push('Wet ground', 'Clean mud packing from the undercarriage at end of shift and watch for soft ground near edges.', 'info');
    if (!items.length) push('All clear', 'No recurring issues on record for this machine. Do your normal walkaround.', 'info');
  } else if (role === 'technician') {
    for (const a of alerts) push(`Work order: ${a.title}`, a.body || '', a.severity === 'critical' || a.severity === 'high' ? 'high' : 'medium');
    if (lastMech) {
      const fixes = rankFixes(asset.model, lastMech.extraction.components, lastMech.extraction.symptoms);
      for (const f of fixes) push(`Recommended fix (${f.confidence}% field success)`, `${f.title}${f.steps ? ' — ' + f.steps : ''}`, f.confidence >= 70 ? 'info' : 'medium');
      for (const c of lastMech.extraction.likely_causes || []) push('Likely cause', c, 'medium');
    }
    const codeCounts = {};
    for (const r of reports) for (const c of r.extraction.fault_codes || []) codeCounts[c] = (codeCounts[c] || 0) + 1;
    const codes = Object.entries(codeCounts).sort((a, b) => b[1] - a[1]);
    if (codes.length) push('Fault code history', codes.map(([c, n]) => `${c} ×${n}`).join(', '), 'info');
    const repairs = reports.filter((r) => r.category === 'maintenance').slice(0, 3);
    if (repairs.length) push('Recent repairs', repairs.map((r) => `${r.created_at.slice(0, 10)}: ${r.summary}`).join(' · '), 'info');
    for (const f of memory.filter((m) => m.kind === 'environment')) push('Environmental correlation', f.text, 'info');
  } else {
    const last30 = reports.filter((r) => daysAgo(r.created_at) <= 30);
    const serious = last30.filter((r) => sevRank(r.severity) >= 2 && r.category === 'mechanical').length;
    const downtimeH = alerts.reduce((h, a) => h + ({ critical: 16, high: 6, medium: 2 }[a.severity] || 0), 0);
    push('Health score', `${asset.health}/100 — status ${asset.status}. ${serious} high/critical mechanical reports in the last 30 days.`, asset.health < 60 ? 'high' : asset.health < 80 ? 'medium' : 'info');
    push('Downtime risk (est.)', downtimeH ? `~${downtimeH} h of repair work queued from open alerts.` : 'No open repair work.', downtimeH > 8 ? 'high' : 'info');
    const svc = memory.find((m) => m.kind === 'service');
    if (svc) push('Service plan', svc.text, svc.level);
    for (const f of memory.filter((m) => m.kind === 'fleet')) push('Fleet-wide issue', f.text, f.level);
    const age = new Date().getFullYear() - (asset.year || new Date().getFullYear());
    push('Lifecycle', `${age} yr old, ${Math.round(asset.smu_hours).toLocaleString()} SMU hours, ${reports.length} memory entries recorded.`, 'info');
  }
  return { role, items };
}
