// Cat Track server: REST API + Server-Sent Events + static panels.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')); } catch { /* .env is optional */ }

const express = (await import('express')).default;
const QRCode = (await import('qrcode')).default;
const { q, nowIso, UPLOAD_DIR, alertRow } = await import('./db.js');
const { sseHandler, publish, clientCount } = await import('./events.js');
const { getGraph, getNeighborhood, nodeDetail, graphStats, nodeId } = await import('./graph.js');
const { ingestReport, issueQuickFix, resolveAlert, resolveFromReport, HttpError, recipientsFor } = await import('./pipeline.js');
const memory = await import('./memory.js');
const { ask, analyzeCase } = await import('./agent.js');
const { acceptUpload, listDocuments, getDocument } = await import('./docs.js');
const { listReports, listDeleted, deleteReports, restoreReports, editReport, listNotes, addNote, deleteNote } = await import('./history.js');
const { COMPONENTS, SYMPTOMS, ISSUE_TYPES } = await import('./vocab.js');
const { graphView } = await import('./graphview.js');
const { needsSeed, seed } = await import('./seed.js');
const { setTelemetry, telemetryOn, latestTelemetry } = await import('./telemetry.js');
const { llmEnabled, llmInfo, sttInfo, transcribe } = await import('./llm.js');
const { normalizeLang } = await import('./i18n.js');

/** The language the client says it is showing (its Accept-Language header), or null. */
const headerLang = (req) => normalizeLang(String(req.get('accept-language') || '').split(',')[0]);

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const PORT = Number(process.env.PORT || 3000);

if (needsSeed()) await seed();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/samples', express.static(path.join(root, 'samples')));
app.use('/vendor/jsqr', express.static(path.join(root, 'node_modules', 'jsqr', 'dist')));
app.use('/vendor/vis-network', express.static(path.join(root, 'node_modules', 'vis-network', 'standalone', 'umd')));

const ALERT_ROW = alertRow;

// ---------- system ----------
app.get('/api/health', (_req, res) => {
  const info = llmInfo();
  res.json({ ok: true, ai: llmEnabled() ? 'llm' : 'rules', provider: info.provider, host: info.host, model: info.model, label: info.label, stt: sttInfo(), telemetry: telemetryOn(), clients: clientCount(), graph: graphStats() });
});
app.get('/api/stream', sseHandler);

// Voice notes recorded on the phone, turned into text by the server's speech model.
app.post('/api/transcribe', express.raw({ type: () => true, limit: '20mb' }), async (req, res) => {
  res.json(await transcribe(req.body, req.get('content-type') || 'audio/webm', normalizeLang(req.query.lang) || 'en'));
});
app.get('/api/vocab', (_req, res) => res.json({ components: COMPONENTS.map((c) => c.name), symptoms: SYMPTOMS.map((x) => x.name), issueTypes: ISSUE_TYPES, severities: ['critical', 'high', 'medium', 'low'] }));

async function publicBaseUrl(req) {
  try {
    const r = await fetch('http://127.0.0.1:4040/api/tunnels', { signal: AbortSignal.timeout(800) });
    const data = await r.json();
    const t = (data.tunnels || []).find((x) => x.public_url?.startsWith('https://') && String(x.config?.addr || '').endsWith(String(PORT)));
    if (t) return { url: t.public_url, kind: 'ngrok' };
  } catch { /* ngrok not running */ }
  const host = req.get('host') || `localhost:${PORT}`;
  if (!/^(localhost|127\.)/.test(host)) return { url: `${req.protocol}://${host}`, kind: 'host' };
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  return { url: lan ? `http://${lan.address}:${PORT}` : `http://localhost:${PORT}`, kind: lan ? 'lan' : 'local' };
}
app.get('/api/public-url', async (req, res) => res.json(await publicBaseUrl(req)));

app.get('/api/qr.svg', async (req, res) => {
  const data = String(req.query.data || '').slice(0, 512);
  if (!data) return res.status(400).send('missing data');
  const svg = await QRCode.toString(data, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111111', light: '#ffffff' } });
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=300').send(svg);
});

// ---------- reference data ----------
app.get('/api/sites', (_req, res) => res.json(q.all('SELECT * FROM sites ORDER BY id')));
app.get('/api/people', (_req, res) => res.json(q.all('SELECT p.*, s.name AS site_name FROM people p LEFT JOIN sites s ON s.id = p.site_id ORDER BY p.role, p.name')));

// ---------- assets / machine memory ----------
app.get('/api/assets', (req, res) => {
  const site = req.query.site;
  const rows = q.all(`SELECT a.*, s.name AS site_name,
      (SELECT COUNT(*) FROM alerts al WHERE al.asset_id = a.id AND al.status <> 'resolved') AS open_alerts,
      (SELECT COUNT(*) FROM reports r WHERE r.asset_id = a.id) AS memory_count
      FROM assets a LEFT JOIN sites s ON s.id = a.site_id ${site ? 'WHERE a.site_id = ?' : ''} ORDER BY a.site_id, a.id`, ...(site ? [site] : []));
  res.json(rows);
});

app.get('/api/assets/:id', (req, res) => {
  const id = memory.normalizeAssetId(req.params.id);
  const asset = memory.getAsset(id);
  if (!asset) return res.status(404).json({ error: `Unknown unit ID "${req.params.id}"`, normalized: id });
  const reports = memory.recentReports(id, 12);
  const lastMech = reports.find((r) => r.category === 'mechanical');
  res.json({
    asset,
    memory: memory.assetMemory(id),
    reports,
    alerts: memory.openAlertsForAsset(id).map(ALERT_ROW),
    actions: q.all(`SELECT * FROM action_items WHERE asset_id = ? AND status = 'open' ORDER BY created_at DESC`, id),
    fixes: lastMech ? memory.rankFixes(asset.model, lastMech.extraction.components, lastMech.extraction.symptoms) : [],
    telemetry: latestTelemetry().filter((t) => t.asset_id === id),
    stats: q.get(`SELECT COUNT(*) AS total, SUM(category = 'mechanical') AS mechanical, SUM(category = 'maintenance') AS maintenance, SUM(category = 'safety') AS safety, MIN(created_at) AS first FROM reports WHERE asset_id = ?`, id),
  });
});
app.get('/api/assets/:id/timeline', (req, res) => {
  const id = memory.normalizeAssetId(req.params.id);
  res.json(memory.recentReports(id, 500));
});
app.get('/api/assets/:id/insights', (req, res) => {
  const out = memory.roleInsights(memory.normalizeAssetId(req.params.id), String(req.query.role || 'operator'));
  if (!out) return res.status(404).json({ error: 'Unknown asset' });
  res.json(out);
});
app.get('/api/assets/:id/graph', (req, res) => res.json(getNeighborhood(nodeId('asset', memory.normalizeAssetId(req.params.id)), 2, 90)));

// ---------- ingestion ----------
app.post('/api/reports', async (req, res) => {
  const { assetId, personId, text, source, photo, lang } = req.body || {};
  const out = await ingestReport({ assetId, personId, text, source: ['voice', 'text', 'inspection', 'repair', 'telemetry'].includes(source) ? source : 'text', photo, lang: normalizeLang(lang) || headerLang(req) });
  res.json(out);
});
app.get('/api/reports', (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 40);
  const site = req.query.site;
  res.json(q.all(`SELECT r.*, p.name AS person_name, p.role AS person_role, a.model FROM reports r LEFT JOIN people p ON p.id = r.person_id LEFT JOIN assets a ON a.id = r.asset_id
                  ${site ? 'WHERE r.site_id = ?' : ''} ORDER BY r.created_at DESC LIMIT ?`, ...(site ? [site] : []), limit).map(memory.hydrateReport));
});

// ---------- report history: browse, delete, restore ----------
const assetParam = (v) => (v ? memory.normalizeAssetId(v) : null);
app.get('/api/reports/log', (req, res) => {
  const { asset, site, person, kind, status, q: search, before, limit } = req.query;
  res.json(listReports({ assetId: assetParam(asset), siteId: site || null, personId: person || null, kind, status, search, before, limit }));
});
app.get('/api/reports/deleted', (req, res) => res.json(listDeleted({ assetId: assetParam(req.query.asset), siteId: req.query.site || null, limit: req.query.limit })));
app.post('/api/reports/delete', (req, res) => {
  const { ids, personId, reason, via } = req.body || {};
  res.json(deleteReports(ids, { personId: personId || null, reason: String(reason || '').slice(0, 300), via: via === 'voice' ? 'voice' : 'manual' }));
});
app.post('/api/reports/restore', (req, res) => res.json(restoreReports(req.body?.ids, { personId: req.body?.personId || null })));
app.patch('/api/reports/:id', (req, res) => {
  const { personId, ...changes } = req.body || {};
  const allowed = ['summary', 'severity', 'raw_text', 'part', 'problem', 'issue'];
  res.json(editReport(Number(req.params.id), Object.fromEntries(Object.entries(changes).filter(([k]) => allowed.includes(k))), { personId: personId || null }));
});
app.get('/api/reports/:id/notes', (req, res) => res.json(listNotes(Number(req.params.id))));
app.post('/api/reports/:id/notes', (req, res) => res.json(addNote(Number(req.params.id), req.body?.text, { personId: req.body?.personId || null })));
app.delete('/api/reports/:id/notes/:noteId', (req, res) => res.json(deleteNote(Number(req.params.id), Number(req.params.noteId))));

// The operator picked which open issue their "it's fixed" report closes.
app.post('/api/reports/:id/resolve', (req, res) => {
  res.json(resolveFromReport(Number(req.params.id), Number(req.body?.alertId), req.body?.personId || null));
});

// The full path one report took: what it said, what was understood, who was alerted, which case it joined.
app.get('/api/reports/:id/trace', (req, res) => {
  const id = Number(req.params.id);
  const report = memory.hydrateReport(q.get(`SELECT r.*, p.name AS person_name, p.role AS person_role, a.model, a.family, s.name AS site_name
      FROM reports r LEFT JOIN people p ON p.id = r.person_id LEFT JOIN assets a ON a.id = r.asset_id LEFT JOIN sites s ON s.id = r.site_id WHERE r.id = ?`, id));
  if (!report) return res.status(404).json({ error: q.get('SELECT id FROM report_trash WHERE id = ?', id) ? 'This report was deleted. Restore it from the report log to see it again.' : 'Report not found' });
  const alert = alertRow(q.get('SELECT * FROM alerts WHERE report_id = ? ORDER BY id LIMIT 1', id));
  const ids = (report.extraction.similar || []).map((s) => s.id);
  const similar = ids.length ? q.all(`SELECT id, asset_id, created_at, summary FROM reports WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
  const engCase = q.get('SELECT c.* FROM eng_cases c JOIN case_reports cr ON cr.case_id = c.id WHERE cr.report_id = ?', id);
  res.json({
    report, alert,
    actions: alert ? q.all('SELECT * FROM action_items WHERE alert_id = ?', alert.id) : [],
    recipients: alert ? recipientsFor(alert.site_id, alert.audience).filter((p) => p.id !== report.person_id) : [],
    similar: similar.map((s) => ({ ...s, ...(report.extraction.similar || []).find((x) => x.id === s.id) })),
    case: engCase || null,
  });
});

// ---------- site command center ----------
app.get('/api/dashboard', (req, res) => {
  const site = req.query.site || null;
  const w = (col) => (site ? `WHERE ${col} = ?` : '');
  const p = site ? [site] : [];
  const alerts = q.all(`SELECT al.*, s.name AS site_name FROM alerts al LEFT JOIN sites s ON s.id = al.site_id ${site ? 'WHERE al.site_id = ? AND' : 'WHERE'} (al.status <> 'resolved' OR al.updated_at > ?) ORDER BY CASE al.status WHEN 'open' THEN 0 WHEN 'ack' THEN 1 ELSE 2 END, al.created_at DESC LIMIT 60`, ...p, new Date(Date.now() - 86400000).toISOString()).map(ALERT_ROW);
  const actions = q.all(`SELECT ai.*, s.name AS site_name FROM action_items ai LEFT JOIN sites s ON s.id = ai.site_id ${site ? 'WHERE ai.site_id = ? AND' : 'WHERE'} (ai.status = 'open' OR ai.done_at > ?) ORDER BY ai.status DESC, ai.created_at DESC LIMIT 80`, ...p, new Date(Date.now() - 6 * 3600000).toISOString());
  const assets = q.all(`SELECT a.*, s.name AS site_name, (SELECT COUNT(*) FROM alerts al WHERE al.asset_id = a.id AND al.status <> 'resolved') AS open_alerts FROM assets a LEFT JOIN sites s ON s.id = a.site_id ${w('a.site_id')} ORDER BY CASE a.status WHEN 'down' THEN 0 WHEN 'attention' THEN 1 ELSE 2 END, a.health`, ...p);
  const reports = q.all(`SELECT r.*, p.name AS person_name, p.role AS person_role FROM reports r LEFT JOIN people p ON p.id = r.person_id ${w('r.site_id')} ORDER BY r.created_at DESC LIMIT 25`, ...p).map(memory.hydrateReport);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  res.json({
    kpis: {
      assets: assets.length,
      down: assets.filter((a) => a.status === 'down').length,
      attention: assets.filter((a) => a.status === 'attention').length,
      openAlerts: alerts.filter((a) => a.status !== 'resolved').length,
      openActions: actions.filter((a) => a.status === 'open').length,
      reportsToday: q.get(`SELECT COUNT(*) AS n FROM reports WHERE created_at >= ? ${site ? 'AND site_id = ?' : ''}`, today.toISOString(), ...p).n,
      avgHealth: assets.length ? Math.round(assets.reduce((s, a) => s + a.health, 0) / assets.length) : 0,
    },
    alerts, actions, assets, reports, graph: graphStats(), telemetry: telemetryOn(), latestTelemetry: latestTelemetry(),
  });
});
app.get('/api/alerts', (req, res) => {
  const site = req.query.site;
  res.json(q.all(`SELECT * FROM alerts WHERE status <> 'resolved' ${site ? 'AND site_id = ?' : ''} ORDER BY created_at DESC LIMIT 30`, ...(site ? [site] : [])).map(ALERT_ROW));
});
app.post('/api/alerts/:id/ack', (req, res) => {
  const id = Number(req.params.id);
  const r = q.run(`UPDATE alerts SET status = CASE WHEN status = 'open' THEN 'ack' ELSE status END, ack_by = ?, updated_at = ? WHERE id = ?`, req.body?.personId || null, nowIso(), id);
  if (!r.changes) return res.status(404).json({ error: 'Alert not found' });
  const alert = ALERT_ROW(q.get('SELECT * FROM alerts WHERE id = ?', id));
  publish('alert-updated', { alert });
  res.json({ alert });
});
app.post('/api/alerts/:id/resolve', async (req, res) => {
  const { personId, resolution, fixId, worked } = req.body || {};
  res.json(await resolveAlert(Number(req.params.id), { personId, resolution: resolution ? String(resolution).slice(0, 300) : null, fixId: fixId ? Number(fixId) : null, worked: Boolean(worked) }));
});
app.post('/api/actions/:id/toggle', (req, res) => {
  const id = Number(req.params.id);
  const item = q.get('SELECT * FROM action_items WHERE id = ?', id);
  if (!item) return res.status(404).json({ error: 'Action item not found' });
  const done = item.status !== 'done';
  q.run('UPDATE action_items SET status = ?, done_by = ?, done_at = ? WHERE id = ?', done ? 'done' : 'open', done ? req.body?.personId || null : null, done ? nowIso() : null, id);
  const updated = q.get('SELECT * FROM action_items WHERE id = ?', id);
  publish('action', { item: updated });
  res.json({ item: updated });
});
app.post('/api/fixes/:id/feedback', (req, res) => {
  const id = Number(req.params.id);
  const fix = q.get('SELECT * FROM fixes WHERE id = ?', id);
  if (!fix) return res.status(404).json({ error: 'Fix not found' });
  const worked = Boolean(req.body?.worked);
  q.run(`UPDATE fixes SET ${worked ? 'success = success + 1' : 'fail = fail + 1'} WHERE id = ?`, id);
  q.run('INSERT INTO fix_feedback (fix_id, asset_id, report_id, worked, person_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, req.body?.assetId || null, req.body?.reportId || null, worked ? 1 : 0, req.body?.personId || null, nowIso());
  const updated = q.get('SELECT * FROM fixes WHERE id = ?', id);
  const confidence = Math.round(((updated.success + 1) / (updated.success + updated.fail + 2)) * 100);
  publish('fix', { fix: { ...updated, confidence } });
  res.json({ fix: { ...updated, confidence } });
});
app.get('/api/fixes', (_req, res) => res.json(q.all('SELECT *, ROUND((success + 1) * 100.0 / (success + fail + 2)) AS confidence FROM fixes ORDER BY created_at DESC')));

// ---------- CAT engineering ----------
app.get('/api/cases', (_req, res) => {
  res.json(q.all(`SELECT c.*, (SELECT COUNT(DISTINCT r.asset_id) FROM case_reports cr JOIN reports r ON r.id = cr.report_id WHERE cr.case_id = c.id) AS machines,
      (SELECT COUNT(DISTINCT r.site_id) FROM case_reports cr JOIN reports r ON r.id = cr.report_id WHERE cr.case_id = c.id) AS sites
      FROM eng_cases c ORDER BY CASE c.status WHEN 'closed' THEN 1 ELSE 0 END, c.priority, c.last_seen DESC`));
});
app.get('/api/cases/:id', (req, res) => {
  const id = Number(req.params.id);
  const c = q.get('SELECT * FROM eng_cases WHERE id = ?', id);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const reports = q.all(`SELECT r.*, a.model, a.smu_hours, s.name AS site_name, s.climate, p.name AS person_name, p.role AS person_role FROM case_reports cr
      JOIN reports r ON r.id = cr.report_id JOIN assets a ON a.id = r.asset_id LEFT JOIN sites s ON s.id = r.site_id LEFT JOIN people p ON p.id = r.person_id
      WHERE cr.case_id = ? ORDER BY r.created_at DESC`, id).map(memory.hydrateReport);
  const count = (key) => {
    const m = {};
    for (const r of reports) for (const x of r.extraction[key] || []) m[x] = (m[x] || 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
  };
  const machines = [...new Map(reports.map((r) => [r.asset_id, { id: r.asset_id, site: r.site_name, hours: Math.round(r.smu_hours) }])).values()];
  const repairs = machines.length ? q.all(`SELECT r.id, r.asset_id, r.created_at, r.summary, r.raw_text FROM reports r WHERE r.category = 'maintenance' AND r.asset_id IN (${machines.map(() => '?').join(',')}) ORDER BY r.created_at DESC LIMIT 10`, ...machines.map((m) => m.id)) : [];
  res.json({
    case: c, reports, machines, conditions: count('conditions'), codes: count('fault_codes'), symptoms: count('symptoms'),
    fixes: memory.rankFixes(c.model, [c.component], [c.symptom], 6),
    feedback: q.all(`SELECT ff.*, f.title FROM fix_feedback ff JOIN fixes f ON f.id = ff.fix_id WHERE f.model = ? AND f.component = ? ORDER BY ff.created_at DESC LIMIT 10`, c.model, c.component),
    repairs,
  });
});
app.post('/api/cases/:id/analyze', async (req, res) => {
  const out = await analyzeCase(Number(req.params.id));
  if (!out) return res.status(404).json({ error: 'Case not found' });
  publish('case', { case: q.get('SELECT * FROM eng_cases WHERE id = ?', Number(req.params.id)) });
  res.json(out);
});
app.post('/api/cases/:id/quick-fix', (req, res) => {
  const { title, steps, engineer } = req.body || {};
  res.json(issueQuickFix(Number(req.params.id), { title: String(title || '').slice(0, 200), steps: String(steps || '').slice(0, 1200), engineer }));
});
app.post('/api/cases/:id/status', (req, res) => {
  const id = Number(req.params.id);
  const { status, engineer, product_action, root_cause } = req.body || {};
  const allowed = ['new', 'investigating', 'quick_fix_issued', 'product_update', 'closed'];
  if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });
  const r = q.run(`UPDATE eng_cases SET status = ?, engineer = COALESCE(?, engineer), product_action = COALESCE(?, product_action), root_cause = COALESCE(?, root_cause), updated_at = ? WHERE id = ?`,
    status, engineer || null, product_action ? String(product_action).slice(0, 600) : null, root_cause ? String(root_cause).slice(0, 600) : null, nowIso(), id);
  if (!r.changes) return res.status(404).json({ error: 'Case not found' });
  const c = q.get('SELECT * FROM eng_cases WHERE id = ?', id);
  if (status === 'product_update' && product_action) {
    // Let fleet managers know a permanent fix is coming.
    const sites = q.all('SELECT DISTINCT site_id FROM assets WHERE model = ?', c.model);
    for (const s of sites) {
      const at = nowIso();
      const ar = q.run(`INSERT INTO alerts (site_id, asset_id, case_id, kind, severity, title, body, audience, status, created_at, updated_at) VALUES (?, NULL, ?, 'bulletin', 'low', ?, ?, ?, 'open', ?, ?)`,
        s.site_id, c.id, `CAT product update planned · ${c.model} ${c.component.toLowerCase()}`, String(product_action), ['fleet_manager', 'site_manager', 'technician'], at, at);
      publish('alert', { alert: ALERT_ROW(q.get('SELECT * FROM alerts WHERE id = ?', Number(ar.lastInsertRowid))), actions: [], recipients: 0 });
    }
  }
  publish('case', { case: c });
  res.json({ case: c });
});

// ---------- product library ----------
app.get('/api/documents', (_req, res) => res.json(listDocuments()));
app.get('/api/documents/:id', (req, res) => {
  const d = getDocument(Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'Document not found' });
  res.json(d);
});
app.post('/api/documents', (req, res) => {
  const { filename, data, docType, product, uploadedBy } = req.body || {};
  res.json(acceptUpload({ filename, data, docType, product, uploadedBy }));
});

// ---------- knowledge graph ----------
app.get('/api/graph', (req, res) => res.json(getGraph({ includeReports: req.query.reports !== '0' })));
app.get('/api/graph/stats', (_req, res) => res.json(graphStats()));
app.get('/api/graph/view', (_req, res) => res.json(graphView()));
app.get('/api/graph/node', (req, res) => {
  const d = nodeDetail(String(req.query.id || ''));
  if (!d) return res.status(404).json({ error: 'Node not found' });
  if (d.node.type === 'report') d.report = memory.hydrateReport(q.get('SELECT r.*, p.name AS person_name FROM reports r LEFT JOIN people p ON p.id = r.person_id WHERE r.id = ?', d.node.props.reportId));
  res.json(d);
});

// ---------- agent ----------
app.post('/api/ask', async (req, res) => {
  const { question, assetId, role, personId, lang } = req.body || {};
  res.json(await ask({ question: String(question || '').slice(0, 1000), assetId, role, personId, lang: normalizeLang(lang) || headerLang(req) }));
});

// ---------- telemetry simulator ----------
app.post('/api/telemetry', (req, res) => res.json({ on: setTelemetry(Boolean(req.body?.on)) }));
app.get('/api/telemetry', (_req, res) => res.json({ on: telemetryOn(), latest: latestTelemetry() }));

app.get('/api/recipients', (req, res) => res.json(recipientsFor(String(req.query.site || ''), String(req.query.roles || '').split(',').filter(Boolean))));

// ---------- errors ----------
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  const status = err instanceof HttpError ? err.status : err.type === 'entity.too.large' ? 413 : Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: status === 413 && err.type === 'entity.too.large' ? 'Upload too large (max 15 MB).' : err.message || 'Server error' });
});

app.listen(PORT, () => {
  console.log(`\n  Cat Track running → http://localhost:${PORT}`);
  const info = llmInfo();
  console.log(`  AI: ${llmEnabled() ? `${info.model} via ${info.host}` : 'offline rule engine (configure AI_BASE_URL / AI_API_KEY / AI_MODEL in .env)'}`);
  console.log(`  Graph: ${graphStats().nodes} nodes / ${graphStats().edges} edges\n`);
});
