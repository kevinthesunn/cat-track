// Human + agent collaboration: a tool-using model agent that can read the machine memory and
// knowledge graph, and take autonomous actions (create action items, notify a site crew).
// With no AI provider configured (or if the provider fails) it falls back to a deterministic answerer.
import { q, nowIso, parseJson, alertRow } from './db.js';
import { runToolAgent, complete, llmEnabled, llmInfo, agentMode, contextChars, describeLlmError } from './llm.js';
import { getAsset, assetMemory, recentReports, rankFixes, fixesForModel, normalizeAssetId, openAlertsForAsset } from './memory.js';
import { matchAll, COMPONENTS, SYMPTOMS, ROLES, fold } from './vocab.js';
import { publish } from './events.js';
import { searchDocs } from './docs.js';
import { translator, langName, normalizeLang, detectLang } from './i18n.js';

const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

function searchMemory({ query = '', asset_id, model, limit = 10 }) {
  const terms = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const comps = matchAll(COMPONENTS, String(query).toLowerCase());
  const syms = matchAll(SYMPTOMS, String(query).toLowerCase());
  const rows = q.all(
    `SELECT r.id, r.asset_id, r.created_at, r.severity, r.category, r.summary, r.raw_text, r.extraction, a.model, s.name AS site
       FROM reports r JOIN assets a ON a.id = r.asset_id LEFT JOIN sites s ON s.id = r.site_id ORDER BY r.created_at DESC LIMIT 800`);
  const aid = asset_id ? normalizeAssetId(asset_id) : null;
  const scored = rows.map((r) => {
    if (aid && r.asset_id !== aid) return null;
    if (model && !r.model.toLowerCase().includes(String(model).toLowerCase())) return null;
    const ex = parseJson(r.extraction, {});
    const hay = `${r.summary} ${r.raw_text} ${(ex.components || []).join(' ')} ${(ex.symptoms || []).join(' ')} ${(ex.fault_codes || []).join(' ')} ${(ex.conditions || []).join(' ')}`.toLowerCase();
    let score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
    score += comps.filter((c) => (ex.components || []).includes(c)).length * 3;
    score += syms.filter((c) => (ex.symptoms || []).includes(c)).length * 2;
    if (!terms.length && (aid || model)) score = 1;
    return score > 0 ? { id: r.id, date: r.created_at.slice(0, 10), asset: r.asset_id, model: r.model, site: r.site, severity: r.severity, category: r.category, summary: r.summary, quote: trunc(r.raw_text, 180), score } : null;
  }).filter(Boolean);
  return scored.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date)).slice(0, Math.min(20, limit));
}

function getMachine({ asset_id }) {
  const id = normalizeAssetId(asset_id);
  const a = getAsset(id);
  if (!a) return { error: `No machine with ID ${asset_id}` };
  const reports = recentReports(id, 8);
  const lastMech = reports.find((r) => r.category === 'mechanical');
  return {
    id: a.id, model: a.model, family: a.family, serial: a.serial, site: a.site_name, site_climate: a.site_climate,
    smu_hours: Math.round(a.smu_hours), status: a.status, health: a.health, last_service: a.last_service_at?.slice(0, 10), operator: a.operator_name,
    memory: assetMemory(id).map((m) => m.text),
    open_alerts: openAlertsForAsset(id).map((x) => ({ id: x.id, severity: x.severity, title: x.title })),
    recent_reports: reports.map((r) => ({ id: r.id, date: r.created_at.slice(0, 10), severity: r.severity, category: r.category, summary: r.summary, by: r.person_name })),
    recommended_fixes: lastMech ? rankFixes(a.model, lastMech.extraction.components, lastMech.extraction.symptoms).map((f) => ({ title: f.title, confidence_pct: f.confidence, worked: f.success, failed: f.fail })) : [],
  };
}

function fleetOverview({ site_id } = {}) {
  const assets = q.all(`SELECT a.id, a.model, a.status, a.health, s.name AS site, a.site_id,
      (SELECT COUNT(*) FROM alerts al WHERE al.asset_id = a.id AND al.status <> 'resolved') AS open_alerts
      FROM assets a LEFT JOIN sites s ON s.id = a.site_id ${site_id ? 'WHERE a.site_id = ?' : ''} ORDER BY a.health ASC`, ...(site_id ? [site_id] : []));
  return { assets, open_cases: q.all(`SELECT id, title, priority, status, occurrences FROM eng_cases WHERE status <> 'closed' ORDER BY priority, last_seen DESC LIMIT 10`) };
}

function listCases({ status } = {}) {
  return q.all(`SELECT id, title, model, component, symptom, priority, status, occurrences, quick_fix, product_action, last_seen FROM eng_cases ${status ? 'WHERE status = ?' : ''} ORDER BY priority, last_seen DESC LIMIT 20`, ...(status ? [status] : []));
}

function findFixes({ model, component, symptom }) {
  return rankFixes(model || '', component ? [component] : [], symptom ? [symptom] : [], 5).map((f) => ({ id: f.id, title: f.title, steps: f.steps, model: f.model, confidence_pct: f.confidence, worked: f.success, failed: f.fail, source: f.source }));
}

function createActionItem({ asset_id, text, assignee_role }, ctx) {
  const a = getAsset(normalizeAssetId(asset_id));
  if (!a) return { error: `No machine with ID ${asset_id}` };
  if (!text) return { error: 'text is required' };
  const role = ROLES.includes(assignee_role) ? assignee_role : 'site_manager';
  const r = q.run(`INSERT INTO action_items (alert_id, site_id, asset_id, text, assignee_role, status, created_at) VALUES (NULL, ?, ?, ?, ?, 'open', ?)`,
    a.site_id, a.id, `${text} (via Cat Track agent${ctx.personName ? ` for ${ctx.personName}` : ''})`, role, nowIso());
  const item = q.get('SELECT * FROM action_items WHERE id = ?', Number(r.lastInsertRowid));
  publish('action', { item });
  return { created: true, action_item_id: item.id, site: a.site_name };
}

function notifySite({ site_id, title, message, severity = 'medium' }, ctx) {
  const site = q.get('SELECT * FROM sites WHERE id = ?', site_id);
  if (!site) return { error: `No site ${site_id}. Valid: ${q.all('SELECT id FROM sites').map((s) => s.id).join(', ')}` };
  const at = nowIso();
  const sev = ['low', 'medium', 'high', 'critical'].includes(severity) ? severity : 'medium';
  const r = q.run(`INSERT INTO alerts (site_id, asset_id, kind, severity, title, body, audience, status, created_at, updated_at) VALUES (?, NULL, 'agent', ?, ?, ?, ?, 'open', ?, ?)`,
    site.id, sev, String(title || 'Notice').slice(0, 140), `${message || ''}${ctx.personName ? ` — requested by ${ctx.personName}` : ''}`, ['site_manager', 'operator', 'technician'], at, at);
  const alert = alertRow(q.get('SELECT * FROM alerts WHERE id = ?', Number(r.lastInsertRowid)));
  publish('alert', { alert, actions: [], recipients: 0 });
  return { notified: true, alert_id: alert.id, site: site.name };
}

const TOOLS = [
  { name: 'search_memory', description: 'Search every field report, inspection, repair and telemetry anomaly in the fleet memory by keywords (components, symptoms, fault codes, conditions). Optionally filter to one machine or model.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, asset_id: { type: 'string', description: 'e.g. EX-0412' }, model: { type: 'string', description: 'e.g. "Cat 336"' }, limit: { type: 'integer' } }, required: ['query'] } },
  { name: 'get_machine', description: 'Full memory profile of one machine: status, health, hours, distilled memory facts, open alerts, recent reports and recommended fixes.',
    input_schema: { type: 'object', properties: { asset_id: { type: 'string' } }, required: ['asset_id'] } },
  { name: 'fleet_overview', description: 'Status and health of every machine (optionally one site) plus open CAT Engineering cases. Sites: S1 Riverside Highway Expansion, S2 North Ridge Quarry, S3 Harbor Logistics Park.',
    input_schema: { type: 'object', properties: { site_id: { type: 'string' } } } },
  { name: 'list_engineering_cases', description: 'Fleet-wide mechanical issue cases tracked by CAT Engineering, with occurrences, priority, quick fixes and product actions.',
    input_schema: { type: 'object', properties: { status: { type: 'string', enum: ['new', 'investigating', 'quick_fix_issued', 'product_update', 'closed'] } } } },
  { name: 'find_fixes', description: 'Known fixes ranked by real field success rate for a model + component/symptom.',
    input_schema: { type: 'object', properties: { model: { type: 'string' }, component: { type: 'string' }, symptom: { type: 'string' } }, required: ['model'] } },
  { name: 'search_documents', description: 'Search the product library: spec sheets, policies and service bulletins engineers uploaded. Use it for specs, service intervals, procedures, policies and what a fault code means. Cite results as [D<id>].',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, model: { type: 'string', description: 'e.g. "Cat 336" to prefer documents about that model' } }, required: ['query'] } },
  { name: 'create_action_item', description: 'ACTION: add a task to a job-site action list for a machine. Only use when the user asks you to do/assign/schedule something.',
    input_schema: { type: 'object', properties: { asset_id: { type: 'string' }, text: { type: 'string' }, assignee_role: { type: 'string', enum: ROLES } }, required: ['asset_id', 'text', 'assignee_role'] } },
  { name: 'notify_site', description: 'ACTION: push an alert to everyone on a job site. Only use when the user asks you to notify/tell/warn a crew.',
    input_schema: { type: 'object', properties: { site_id: { type: 'string' }, title: { type: 'string' }, message: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] } }, required: ['site_id', 'title', 'message'] } },
];

const HANDLERS = { search_documents: ({ query, model }) => searchDocs(String(query || ''), { model: model || null, limit: 4 }), search_memory: searchMemory, get_machine: getMachine, fleet_overview: fleetOverview, list_engineering_cases: listCases, find_fixes: findFixes, create_action_item: createActionItem, notify_site: notifySite };

function systemPrompt(ctx, mode = 'tools') {
  const who = ctx.personName ? `${ctx.personName}, a ${ctx.role.replace('_', ' ')}` : `a ${ctx.role.replace('_', ' ')}`;
  const tailor = {
    operator: 'Operators are in the cab: answer in 2-4 short plain sentences, safety first, no jargon.',
    technician: 'Technicians want specifics: likely causes, fault codes, fixes with success rates, parts and steps.',
    site_manager: 'Site managers want impact: which machines, what risk, what the crew should do, downtime.',
    safety_officer: 'Safety officers want hazards, exposure, and controls.',
    fleet_manager: 'Fleet managers want fleet-level patterns, health, downtime and cost risk.',
    cat_engineer: 'CAT engineers want fleet-wide evidence: occurrences, conditions, hours, codes, and root-cause hypotheses.',
  }[ctx.role] || '';
  return `You are the Cat Track memory agent: the voice of a persistent memory layer for Caterpillar machines and job sites.
You are talking with ${who}. ${tailor}
${ctx.assetId ? `They are looking at machine ${ctx.assetId}; questions about "it" or "this machine" refer to it.` : ''}
${ctx.scoped && ctx.assetId ? `Asked from the cab of ${ctx.assetId}: answer from ${ctx.assetId}'s own record (its reports, alerts, repairs, memory, service state) and documents that apply to its model. Do not bring in other machines unless the question asks about the fleet; if you mention a fix learned elsewhere, say it comes from another machine of the same model.` : ''}
${mode === 'rag'
    ? 'Answer ONLY from the records provided with the question. Cite reports as [R<id>], product documents as [D<id>], and machines by ID. If the records don\'t contain the answer, say so plainly. You cannot take actions in this mode; if asked to assign or notify, say which task or notice you would create.'
    : 'Always ground answers in the memory by calling tools first. Cite reports as [R<id>], product documents as [D<id>], and machines by ID. For specs, service intervals, policies or what a fault code means, search the product library. If the memory doesn\'t contain the answer, say so.\nOnly call create_action_item or notify_site when the user explicitly asks for an action; confirm what you did.'}
Specs, intervals and rules apply only to the models, machine families or conditions they name (see applies_to and the text): never carry a figure or rule from one model over to another, and say which machine each figure is for. Don't pad answers with general advice the records don't support.
${ctx.lang && ctx.lang !== 'en' ? `Answer in ${langName(ctx.lang)}${ctx.lang === 'hi' ? ' (Devanagari script)' : ''}, even though the records are in English. Keep machine IDs, fault codes, model numbers and citations like [R12] exactly as they are.` : ''}
Keep answers under 170 words. Use short bullet lists when listing more than two items. Today is ${new Date().toISOString().slice(0, 10)}.`;
}

/** Offline answerer: pattern-matches the question onto the same tools. */
// Question cues in English, Spanish and Hindi (Devanagari + Roman). Matched against the folded question.
const Q = {
  action: /\b(assign|schedule|create|add) (a |an )?(task|action)\b|\b(asigna|asignar|programa|programar|crea|crear|agrega|agregar|anade|anadir) (una? )?(tarea|accion)\b|(काम|टास्क|कार्य) (जोड़|जोड|बना|दे)|\b(task|kaam|kam) (jodo|jod|banao|bana|do|de)\b/,
  tech: /\btech|tecnico|mecanico|टेक्नीशियन|मैकेनिक|technician|mistri|मिस्त्री/,
  cases: /\bcase|engineering|fleet[- ]wide|pattern|casos?|ingenieria|patron|केस|इंजीनियरिंग|पैटर्न|\bkes\b|\bpattern\b/,
  fleet: /\bfleet|status|down|which machines|all machines|overview|health|flota|estado|paradas?|que maquinas|todas las maquinas|resumen|salud|फ्लीट|स्थिति|बंद|कौन सी मशीन|सभी मशीन|सेहत|\bkaun si machine|\bsab machine|\bband\b|\bhalat\b/,
  docs: /\b(spec|specs|specification|policy|policies|interval|how often|procedure|bulletin|rated|capacity|torque|pressure|horsepower|kw|weight|new product|especificacion(es)?|politicas?|intervalo|cada cuanto|procedimiento|boletin|capacidad|presion|potencia|peso|producto nuevo|spec|niyam|antaral|kitni baar|prakriya|kshamta|dabav|vajan|wazan)\b|स्पेक|नीति|अंतराल|कितनी बार|प्रक्रिया|बुलेटिन|क्षमता|टॉर्क|दबाव|प्रेशर|वज़न|वजन|नया प्रोडक्ट/,
  code: /code|cid|fmi|codigo|कोड/,
};

/** Offline answerer: pattern-matches the question onto the same tools. */
function rulesAnswer(question, ctx) {
  const tt = translator(ctx.lang);
  const ql = fold(question);
  const trace = [];
  const idMatch = question.match(/\b([A-Za-z]{2})[- ]?(\d{3,4})\b/);
  const assetId = idMatch ? normalizeAssetId(idMatch[0]) : ctx.assetId;
  const lines = [];
  const wantsAction = Q.action.test(ql);
  if (wantsAction && assetId) {
    const r = createActionItem({ asset_id: assetId, text: question.replace(/^.*?(to|:|para|que|को|कि)\s*/i, ''), assignee_role: Q.tech.test(ql) ? 'technician' : 'site_manager' }, ctx);
    trace.push({ tool: 'create_action_item', input: { asset_id: assetId }, ok: !r.error });
    return { answer: r.error ? r.error : tt('Done — added an action item for **{id}** at {site}.', { id: assetId, site: r.site }), trace, mode: 'rules' };
  }
  if (Q.cases.test(ql) && !assetId) {
    const cases = listCases({}); trace.push({ tool: 'list_engineering_cases', input: {}, ok: true });
    lines.push(tt('**{n} open CAT Engineering cases:**', { n: cases.filter((c) => c.status !== 'closed').length }));
    for (const c of cases.slice(0, 6)) lines.push(tt('- **#{id} {title}** — {n} reports, {priority}, {status}{fix}', { id: c.id, title: c.title, n: c.occurrences, priority: tt.v(c.priority), status: c.status.replace(/_/g, ' '), fix: c.quick_fix ? tt(' · quick fix: {fix}', { fix: c.quick_fix }) : '' }));
    return { answer: lines.join('\n'), trace, mode: 'rules' };
  }
  if (Q.fleet.test(ql) && !assetId) {
    const f = fleetOverview({}); trace.push({ tool: 'fleet_overview', input: {}, ok: true });
    const bad = f.assets.filter((a) => a.status !== 'operational');
    lines.push(tt('**{n} machines tracked — {bad} need attention:**', { n: f.assets.length, bad: bad.length }));
    for (const a of bad.slice(0, 8)) lines.push(tt('- **{id}** ({model}, {site}) — {status}, health {health}, {alerts} open alert(s)', { id: a.id, model: a.model, site: a.site, status: tt.v(a.status), health: a.health, alerts: a.open_alerts }));
    if (!bad.length) lines.push(tt('- Everything is operational.'));
    return { answer: lines.join('\n'), trace, mode: 'rules' };
  }
  if (Q.docs.test(ql)) {
    const docs = searchDocs(question, { model: assetId ? getAsset(assetId)?.model : null, limit: 3 });
    trace.push({ tool: 'search_documents', input: { query: question }, ok: true });
    if (docs.length) {
      lines.push(tt('**From the product library:**'));
      for (const d of docs) lines.push(`- [D${d.doc_id}] **${d.title}** (${d.doc_type}): “${trunc(d.excerpt, 260)}”`);
      return { answer: lines.join('\n'), trace, mode: 'rules' };
    }
  }
  const topical = matchAll(COMPONENTS, ql).length || matchAll(SYMPTOMS, ql).length || Q.code.test(ql);
  if (assetId && getAsset(assetId)) {
    const m = getMachine({ asset_id: assetId }); trace.push({ tool: 'get_machine', input: { asset_id: assetId }, ok: true });
    if (topical) {
      const hits = searchMemory({ query: question, asset_id: assetId, limit: 5 }); trace.push({ tool: 'search_memory', input: { query: question, asset_id: assetId }, ok: true });
      lines.push(hits.length ? (hits.length === 1 ? tt('**{id} has 1 related memory entry:**', { id: assetId }) : tt('**{id} has {n} related memory entries:**', { id: assetId, n: hits.length })) : tt('No related reports on {id}.', { id: assetId }));
      for (const h of hits) lines.push(`- ${h.date} [R${h.id}] ${h.summary} (${tt.v(h.severity)})`);
    } else {
      lines.push(tt('**{id} · {model}** at {site} — {status}, health {health}/100, {hours} SMU h.', { id: m.id, model: m.model, site: m.site, status: tt.v(m.status), health: m.health, hours: m.smu_hours.toLocaleString() }));
      if (m.memory.length) { lines.push(tt('**What it remembers:**')); m.memory.slice(0, 4).forEach((x) => lines.push(`- ${x}`)); }
      if (m.recent_reports.length) { lines.push(tt('**Latest:**')); m.recent_reports.slice(0, 3).forEach((r) => lines.push(`- ${r.date} [R${r.id}] ${r.summary}`)); }
    }
    if (m.recommended_fixes.length) lines.push(tt('**Best known fix:** {title} ({pct}% field success)', { title: m.recommended_fixes[0].title, pct: m.recommended_fixes[0].confidence_pct }));
    return { answer: lines.join('\n'), trace, mode: 'rules' };
  }
  if (topical) {
    const modelMatch = ql.match(/\b(336|320|777|950|966|140|d6|d8)s?\b/);
    const model = modelMatch ? `Cat ${modelMatch[1].toUpperCase()}` : undefined;
    const hits = searchMemory({ query: question, model, limit: 6 }); trace.push({ tool: 'search_memory', input: { query: question, model }, ok: true });
    lines.push(hits.length ? tt('**Found {n} related reports across the fleet:**', { n: hits.length }) : tt('Nothing in memory matches that yet.'));
    for (const h of hits) lines.push(`- ${h.date} **${h.asset}** (${h.model}) [R${h.id}] ${h.summary}`);
    const comps = matchAll(COMPONENTS, ql); const syms = matchAll(SYMPTOMS, ql);
    if (hits[0]) {
      const fixes = rankFixes(hits[0].model, comps.length ? comps : [], syms);
      if (fixes[0]) lines.push(tt('**Best known fix:** {title} ({pct}% field success)', { title: fixes[0].title, pct: fixes[0].confidence }));
    }
    return { answer: lines.join('\n'), trace, mode: 'rules' };
  }
  return { answer: tt('I can answer from the fleet memory. Try: "What\'s wrong with EX-0412?", "Which machines are down?", "Any overheating on the 777s?", or "Show engineering cases". (Configure an AI provider in .env for full natural-language answers.)'), trace, mode: 'rules' };
}

export async function ask({ question, assetId, role = 'operator', personId, lang }) {
  const qText = String(question || '').trim();
  const l = detectLang(qText, lang);
  if (!qText) return { answer: translator(l)('Ask me anything about your machines.'), trace: [], mode: 'rules' };
  const person = personId ? q.get('SELECT * FROM people WHERE id = ?', personId) : null;
  const ctx = { role: person?.role || role, personName: person?.name, assetId: assetId ? normalizeAssetId(assetId) : null, lang: l };
  const instant = rulesAnswer(qText, ctx);
  // Actions already taken by the rule path don't need a second opinion.
  if (!llmEnabled() || instant.trace.some((t) => t.tool === 'create_action_item')) return instant;
  const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  answerWithModel(id, qText, ctx).catch((err) => console.warn('[agent] background answer failed:', err.message));
  return { ...instant, pending: id, model: llmInfo().label };
}

/** Everything the record holds that bears on the question, gathered up front for a single model call. */
function gatherContext(question, ctx) {
  const ql = question.toLowerCase();
  const idMatch = question.match(/\b([A-Za-z]{2})[- ]?(\d{3,4})\b/);
  const assetId = idMatch && getAsset(normalizeAssetId(idMatch[0])) ? normalizeAssetId(idMatch[0]) : ctx.assetId;
  const parts = {}; const trace = [];
  const note = (tool, input) => trace.push({ tool, input, ok: true });
  if (assetId && getAsset(assetId)) {
    parts.machine = getMachine({ asset_id: assetId }); note('get_machine', { asset_id: assetId });
    parts.this_machine_reports = searchMemory({ query: question, asset_id: assetId, limit: 8 }); note('search_memory', { asset_id: assetId });
    // From the cab, other machines' reports stay out unless the question is about the fleet.
    if (!ctx.scoped || /fleet|other machines|across|all machines/.test(ql)) parts.same_model_reports = searchMemory({ query: question, model: parts.machine.model, limit: 8 }).filter((r) => r.asset !== assetId);
  } else {
    const modelMatch = ql.match(/\b(336|320|777|950|966|140|d6|d8)s?\b/);
    const model = modelMatch ? `Cat ${modelMatch[1].toUpperCase()}` : undefined;
    parts.matching_reports = searchMemory({ query: question, model, limit: 12 }); note('search_memory', { query: question, model });
  }
  if (!assetId || (!ctx.scoped && /fleet|status|down|attention|which machines|all machines|overview|health|risk/.test(ql)) || /fleet|which machines|all machines/.test(ql)) { parts.fleet = fleetOverview({}); note('fleet_overview', {}); }
  // Repairs, fixes and engineering cases for every machine/model the matching reports touch, so the model
  // never concludes "nothing was fixed" just because the question didn't name the part.
  const hits = [...(parts.this_machine_reports || []), ...(parts.same_model_reports || []), ...(parts.matching_reports || [])];
  const assets = [...new Set([assetId, ...hits.map((h) => h.asset)].filter(Boolean))].slice(0, 8);
  const models = [...new Set([parts.machine?.model, ...hits.map((h) => h.model)].filter(Boolean))].slice(0, 4);
  if (assets.length) {
    parts.repairs_on_these_machines = q.all(`SELECT id, asset_id, created_at, raw_text FROM reports WHERE category = 'maintenance' AND asset_id IN (${assets.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 12`, ...assets)
      .map((r) => ({ id: r.id, date: r.created_at.slice(0, 10), asset: r.asset_id, text: trunc(r.raw_text, 160) }));
  }
  if (models.length) {
    parts.known_fixes = models.flatMap((m) => fixesForModel(m).map((f) => ({ model: f.model || 'any', component: f.component, symptom: f.symptom, fix: f.title, worked: f.success, failed: f.fail, source: f.source })));
    parts.engineering_cases = listCases({}).filter((c) => models.includes(c.model));
    note('find_fixes', { models }); note('list_engineering_cases', { models });
  } else if (/case|engineering|pattern|fleet[- ]wide|design|other machines/.test(ql)) {
    parts.engineering_cases = listCases({}); note('list_engineering_cases', {});
  }
  const docs = searchDocs(question, { model: parts.machine?.model || models[0] || null, limit: 3 });
  if (docs.length) { parts.product_documents = docs; note('search_documents', { query: question }); }
  return { parts, trace };
}

async function modelAnswer(question, ctx) {
  if (agentMode() === 'rag') {
    const { parts, trace } = gatherContext(question, ctx);
    const answer = await complete({ system: systemPrompt(ctx, 'rag'), prompt: `Question: ${question}\n\nRecords from Cat Track (JSON):\n${JSON.stringify(parts).slice(0, contextChars())}`, maxTokens: 1500 });
    return { answer: answer || '(no answer)', trace };
  }
  return runToolAgent({ system: systemPrompt(ctx), question, tools: TOOLS, handlers: HANDLERS, ctx });
}

/** Answer now (awaited) — used when a field report turns out to be a question. */
export async function answerNow({ question, assetId, role = 'operator', personId, scoped = false, lang }) {
  const qText = String(question || '').trim();
  const person = personId ? q.get('SELECT * FROM people WHERE id = ?', personId) : null;
  const ctx = { role: person?.role || role, personName: person?.name, assetId: assetId ? normalizeAssetId(assetId) : null, scoped: Boolean(scoped), lang: normalizeLang(lang) || detectLang(qText) };
  if (!llmEnabled()) return rulesAnswer(qText, ctx);
  try {
    return { ...(await modelAnswer(qText, ctx)), mode: 'llm', model: llmInfo().label };
  } catch (err) {
    console.warn('[agent] answerNow failed, using rules:', describeLlmError(err));
    return { ...rulesAnswer(qText, ctx), note: `AI unavailable (${describeLlmError(err)})` };
  }
}

async function answerWithModel(id, question, ctx) {
  const started = Date.now();
  try {
    const out = await modelAnswer(question, ctx);
    publish('answer', { id, ...out, model: llmInfo().label, seconds: Math.round((Date.now() - started) / 1000) });
  } catch (err) {
    console.warn('[agent] model answer failed:', describeLlmError(err));
    publish('answer', { id, error: describeLlmError(err) });
  }
}

/** Engineering portal: root-cause hypothesis for a fleet case. */
export async function analyzeCase(caseId) {
  const c = q.get('SELECT * FROM eng_cases WHERE id = ?', caseId);
  if (!c) return null;
  const reps = q.all(`SELECT r.*, a.smu_hours, a.site_id, s.climate FROM case_reports cr JOIN reports r ON r.id = cr.report_id JOIN assets a ON a.id = r.asset_id LEFT JOIN sites s ON s.id = a.site_id WHERE cr.case_id = ? ORDER BY r.created_at`, caseId)
    .map((r) => ({ ...r, extraction: parseJson(r.extraction, {}) }));
  const condCount = {}; const codeCount = {};
  for (const r of reps) {
    for (const x of r.extraction.conditions || []) condCount[x] = (condCount[x] || 0) + 1;
    for (const x of r.extraction.fault_codes || []) codeCount[x] = (codeCount[x] || 0) + 1;
  }
  const fixes = rankFixes(c.model, [c.component], [c.symptom], 5);
  let text;
  if (!text) {
    const topCond = Object.entries(condCount).sort((a, b) => b[1] - a[1]);
    const topCode = Object.entries(codeCount).sort((a, b) => b[1] - a[1]);
    const assets = [...new Set(reps.map((r) => r.asset_id))];
    const hrs = reps.map((r) => r.smu_hours);
    text = [
      `**Pattern:** ${reps.length} reports of ${c.symptom.toLowerCase()} at the ${c.component.toLowerCase()} on ${assets.length} ${c.model} machine(s) (${assets.join(', ')}), machine hours ${Math.round(Math.min(...hrs)).toLocaleString()}–${Math.round(Math.max(...hrs)).toLocaleString()}.`,
      topCond.length ? `**Environmental correlation:** ${topCond.map(([k, n]) => `${k} in ${n}/${reps.length}`).join(', ')}.` : '**Environmental correlation:** none detected.',
      topCode.length ? `**Fault codes:** ${topCode.map(([k, n]) => `${k} ×${n}`).join(', ')}.` : '',
      fixes[0] ? `**Best field fix so far:** ${fixes[0].title} — ${fixes[0].confidence}% success over ${fixes[0].success + fixes[0].fail} uses.` : '**Best field fix so far:** none recorded.',
      `**Recommendation:** ${reps.length >= 3 && assets.length >= 2 ? 'Systemic — candidate for a product/design review and a fleet service bulletin.' : 'Monitor; gather more field evidence.'}`,
    ].filter(Boolean).join('\n');
  }
  q.run("UPDATE eng_cases SET ai_analysis = ?, ai_analysis_by = 'rules', updated_at = ? WHERE id = ?", text, nowIso(), caseId);
  const pending = llmEnabled();
  if (pending) analyzeCaseWithModel(c, reps, fixes).catch((err) => console.warn('[agent] case analysis failed:', err.message));
  return { analysis: text, mode: 'rules', pending, model: pending ? llmInfo().label : null, conditions: condCount, codes: codeCount };
}

async function analyzeCaseWithModel(c, reps, fixes) {
  try {
    const evidence = reps.map((r) => `[R${r.id}] ${r.created_at.slice(0, 10)} ${r.asset_id} (${Math.round(r.smu_hours)} h, site climate: ${r.climate}) sev=${r.severity}: "${trunc(r.raw_text, 240)}" conditions=${(r.extraction.conditions || []).join('/') || '-'} codes=${(r.extraction.fault_codes || []).join('/') || '-'}`).join('\n');
    const text = await complete({
      system: 'You are a Caterpillar reliability engineer reviewing fleet field evidence. Be specific, evidence-based and concise (under 220 words). Write plain text with these bold headings on their own lines: **Pattern**, **Likely root cause**, **Field quick fix**, **Long-term product action**, **Confidence**. Use "- " for bullets. Cite reports as [R<id>]. Do not invent part numbers or procedures that are not supported by the evidence.',
      prompt: `Case #${c.id}: ${c.title}\nModel: ${c.model} · Component: ${c.component} · Symptom: ${c.symptom}\n\nField evidence:\n${evidence}\n\nKnown fixes and field results:\n${fixes.map((f) => `- ${f.title}: worked ${f.success}, failed ${f.fail}`).join('\n') || '- none'}`,
    });
    if (!text) throw new Error('empty answer');
    q.run('UPDATE eng_cases SET ai_analysis = ?, ai_analysis_by = ?, updated_at = ? WHERE id = ?', text, llmInfo().label, nowIso(), c.id);
    publish('case', { case: q.get('SELECT * FROM eng_cases WHERE id = ?', c.id), analysis: 'llm' });
  } catch (err) {
    console.warn('[agent] case analysis via model failed:', describeLlmError(err));
    publish('case', { case: q.get('SELECT * FROM eng_cases WHERE id = ?', c.id), analysis: 'failed', error: describeLlmError(err) });
  }
}
