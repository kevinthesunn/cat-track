// Product library + document agent. Engineers upload spec sheets, policies and bulletins for new
// products; the agent reads each file, finds the products, parts, specs, service intervals, fault
// codes, policies and hazards in it, matches each one against what the knowledge graph already
// knows, and grows new branches for whatever is new. Documents are also chunked for retrieval so
// the record agent and the report reviewer can cite them.
import fs from 'node:fs';
import path from 'node:path';
import { q, tx, nowIso, UPLOAD_DIR, parseJson } from './db.js';
import { upsertNode, upsertEdge, nodeId, newDelta, slug } from './graph.js';
import { COMPONENTS, HAZARDS, canonical, matchAll, extractFaultCodes, normalizeCode, componentSystem } from './vocab.js';
import { llmEnabled, llmInfo, structured, docModel, describeLlmError } from './llm.js';
import { publish } from './events.js';

const DOC_DIR = path.join(UPLOAD_DIR, 'docs');
fs.mkdirSync(DOC_DIR, { recursive: true });

export const DOC_TYPES = ['spec_sheet', 'policy', 'service_bulletin', 'manual', 'other'];
export const DOC_TYPE_LABEL = { spec_sheet: 'Spec sheet', policy: 'Policy', service_bulletin: 'Service bulletin', manual: 'Manual', other: 'Document' };
const MAX_BYTES = 15 * 1024 * 1024;
const CHUNK_CHARS = 6000;
const MAX_AI_CHUNKS = 6; // ~36k characters are read by the model; everything is still searchable
const TEXT_EXT = ['.txt', '.md', '.markdown', '.csv', '.json', '.html', '.htm'];

const clientError = (status, message) => Object.assign(new Error(message), { status });
const uniqBy = (arr, key) => { const seen = new Set(); return arr.filter((x) => { const k = key(x); if (!k || seen.has(k)) return false; seen.add(k); return true; }); };
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/* ------------------------------ reading files ------------------------------ */

async function readText(buf, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const out = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(out.text) ? out.text : [String(out.text || '')];
    return { text: pages.join('\n\n'), pages: out.totalPages || pages.length };
  }
  if (ext === '.docx') {
    const mammoth = (await import('mammoth')).default;
    const out = await mammoth.extractRawText({ buffer: buf });
    return { text: out.value, pages: null };
  }
  if (TEXT_EXT.includes(ext)) {
    let text = buf.toString('utf8');
    if (ext.startsWith('.htm')) text = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    return { text, pages: null };
  }
  throw clientError(415, `Can't read ${ext || 'that'} files yet. Use PDF, Word (.docx), text, Markdown or CSV.`);
}

function chunkText(text) {
  const paras = text.replace(/\r/g, '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = []; let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length > CHUNK_CHARS) { chunks.push(cur); cur = ''; }
    if (p.length > CHUNK_CHARS) { for (let i = 0; i < p.length; i += CHUNK_CHARS) chunks.push(p.slice(i, i + CHUNK_CHARS)); continue; }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/* --------------------------- naming & matching --------------------------- */

/** "CAT® 336", "336", "Cat 337 hx" → "Cat 336" / "Cat 337 HX"; "D6" → "Cat D6". */
export function normalizeModel(raw) {
  const s = String(raw || '').replace(/®|™/g, '').replace(/\s+/g, ' ').trim();
  const m = s.match(/^(?:cat(?:erpillar)?\s*)?([0-9]{2,3}[a-z]{0,2}|d\d{1,2}[a-z]?)(?:\s+(xe|gc|hx|next gen|hybrid|lrc))?\b/i);
  if (!m) return null;
  return `Cat ${m[1].toUpperCase()}${m[2] ? ' ' + (m[2].toLowerCase() === 'next gen' ? 'Next Gen' : m[2].toUpperCase()) : ''}`;
}
const MODEL_RE = /\b(?:cat(?:erpillar)?)\s*®?\s*([0-9]{2,3}[a-z]{0,2}|d\d{1,2}[a-z]?)(?:\s+(xe|gc|hx|next gen|hybrid|lrc))?\b/gi;

const tokens = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
function jaccard(a, b) {
  const A = tokens(a); const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const t of A) if (B.has(t)) n++;
  return n / (A.size + B.size - n);
}

/** Map a part name onto the shared vocabulary or an existing graph node; otherwise it's a new branch. */
function resolveComponent(raw) {
  const name = canonical(COMPONENTS, raw);
  if (!name) return null;
  if (COMPONENTS.some((c) => c.name === name)) return name;
  const existing = q.all("SELECT label FROM nodes WHERE type = 'component'").map((r) => r.label);
  const best = existing.map((l) => [l, jaccard(l, name)]).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 0.5 ? best[0] : name;
}
const nodeExists = (type, key) => Boolean(q.get('SELECT 1 FROM nodes WHERE id = ?', nodeId(type, key)));

/* ------------------------------ understanding ------------------------------ */

const POLICY_RE = /\b(must|shall|is required|are required|required to|prohibited|do not|never|no one may|may not)\b/i;

/** Offline reading: deterministic patterns, used alone without a model and as a safety net with one. */
export function ruleDocExtract(text, { docType = 'other', product = '' } = {}) {
  const lower = text.toLowerCase();
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map((s) => s.trim()).filter((s) => s.length > 12);
  const models = new Set();
  for (const m of text.matchAll(MODEL_RE)) { const n = normalizeModel(`${m[1]} ${m[2] || ''}`); if (n) models.add(n); }
  const hint = normalizeModel(product); if (hint) models.add(hint);
  const firstModel = hint || [...models][0] || '';
  const specs = [];
  for (const l of lines) {
    const m = l.match(/^[-•*]?\s*([A-Za-z][A-Za-z0-9 ()/.,'-]{2,48}?)\s*[:\t]\s*([0-9][0-9.,]*)\s*([A-Za-z°%/³²]+(?:[ /][A-Za-z]+)?)?\s*$/);
    if (m && !/every|interval|page/i.test(m[1])) specs.push({ model: firstModel, label: m[1].trim(), value: m[2], unit: (m[3] || '').trim(), component: matchAll(COMPONENTS, m[1].toLowerCase())[0] || '' });
  }
  const intervals = [];
  for (const s of sentences.concat(lines)) {
    const m = s.match(/every\s+([0-9][0-9,]*)\s*(?:h\b|hours?|hrs?|service hours)/i);
    if (m) intervals.push({ task: clip(s, 140), hours: Number(m[1].replace(/,/g, '')), component: matchAll(COMPONENTS, s.toLowerCase())[0] || '', condition: /dust/i.test(s) ? 'dusty sites' : '' });
  }
  const fault_codes = extractFaultCodes(text).map((code) => {
    const where = sentences.find((s) => s.toUpperCase().replace(/\s+/g, ' ').includes(code)) || lines.find((l) => l.toUpperCase().includes(code)) || '';
    return { code, meaning: clip(where.replace(new RegExp(code.replace(/ /g, '\\s*'), 'i'), '').replace(/^[\s:–-]+/, ''), 120), component: matchAll(COMPONENTS, where.toLowerCase())[0] || '' };
  });
  const policies = sentences.filter((s) => POLICY_RE.test(s)).slice(0, 25).map((s) => {
    const targets = [...s.matchAll(MODEL_RE)].map((m) => normalizeModel(`${m[1]} ${m[2] || ''}`)).filter(Boolean);
    return {
      rule: clip(s, 220),
      category: /safe|injur|hazard|ppe|lockout|exclusion|spotter|fire/i.test(s) ? 'safety' : /service|filter|oil|inspect|clean|replace|grease/i.test(s) ? 'maintenance' : /warrant/i.test(s) ? 'warranty' : 'operations',
      applies_to: targets.length ? targets : /all (machines|equipment|units)|every machine|fleet/i.test(s) ? ['all machines'] : firstModel ? [firstModel] : [],
    };
  });
  const title = clip(lines.find((l) => l.length > 3) || 'Untitled document', 120);
  return {
    title, doc_type: DOC_TYPES.includes(docType) ? docType : 'other',
    summary: clip(sentences.slice(0, 2).join(' '), 320),
    products: [...models].map((m) => ({ model: m, family: '', is_new_product: false })),
    components: matchAll(COMPONENTS, lower).map((name) => ({ name, note: '' })),
    specs: uniqBy(specs, (s) => `${s.label}|${s.value}`), intervals: uniqBy(intervals, (i) => `${i.hours}|${i.task.slice(0, 50)}`),
    fault_codes, policies, hazards: matchAll(HAZARDS, lower),
  };
}

const DOC_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'doc_type', 'summary', 'products', 'components', 'specs', 'intervals', 'fault_codes', 'policies', 'hazards'],
  properties: {
    title: { type: 'string' },
    doc_type: { type: 'string', enum: DOC_TYPES },
    summary: { type: 'string', description: '2-3 plain sentences: what the document is and what changes for crews' },
    products: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['model', 'family', 'is_new_product'], properties: { model: { type: 'string', description: 'e.g. "Cat 337 HX"' }, family: { type: 'string', description: 'e.g. "Hydraulic Excavator"' }, is_new_product: { type: 'boolean' } } } },
    components: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'note'], properties: { name: { type: 'string' }, note: { type: 'string', description: 'what the document says about it, under 120 characters' } } } },
    specs: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['model', 'label', 'value', 'unit', 'component'], properties: { model: { type: 'string' }, label: { type: 'string' }, value: { type: 'string' }, unit: { type: 'string' }, component: { type: 'string', description: 'related part, or empty' } } } },
    intervals: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['task', 'hours', 'component', 'condition'], properties: { task: { type: 'string' }, hours: { type: 'number' }, component: { type: 'string' }, condition: { type: 'string', description: 'e.g. "dusty sites", or empty' } } } },
    fault_codes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['code', 'meaning', 'component'], properties: { code: { type: 'string' }, meaning: { type: 'string' }, component: { type: 'string' } } } },
    policies: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['rule', 'category', 'applies_to'], properties: { rule: { type: 'string', description: 'one imperative sentence' }, category: { type: 'string', enum: ['safety', 'maintenance', 'operations', 'warranty', 'environmental', 'other'] }, applies_to: { type: 'array', items: { type: 'string' }, description: 'models, machine families, or "all machines"' } } } },
    hazards: { type: 'array', items: { type: 'string' } },
  },
};

function docSystemPrompt() {
  const models = [...new Set([...q.all("SELECT label FROM nodes WHERE type = 'model'").map((r) => r.label), ...q.all('SELECT DISTINCT model FROM assets').map((r) => r.model)])];
  return `You are the document agent of Cat Track, a knowledge graph for Caterpillar machines and job sites. Engineers upload spec sheets, policies and service bulletins for new products. Read the excerpt and extract only facts it states — never invent values.
Map onto what the graph already knows wherever it fits; use a new name only for something genuinely new:
- Models already in the graph: ${models.join(', ')}. Write models as "Cat <number> <suffix>", e.g. "Cat 337 HX". is_new_product = true when the document introduces a model not in that list.
- Canonical part names: ${COMPONENTS.map((c) => c.name).join('; ')}.
- Safety hazard names: ${HAZARDS.map((h) => h.name).join('; ')}.
- Fault codes like "CID 110 FMI 15", "SPN 3364 FMI 4", "E3301".
- intervals.hours is a number of service hours. Policies are rules people must follow; keep each to one sentence.
If a list has nothing in this excerpt, return an empty array.`;
}

async function modelDocExtract(chunks, meta) {
  const parts = [];
  const use = chunks.slice(0, MAX_AI_CHUNKS);
  for (let i = 0; i < use.length; i++) {
    progress(meta.id, 'understand', `Reading part ${i + 1} of ${use.length} with ${llmInfo().provider === 'openai-compatible' ? docModel().split('/').pop() : llmInfo().label}`);
    const out = await structured({
      system: docSystemPrompt(), schema: DOC_SCHEMA, model: docModel(), maxTokens: 3500,
      text: `Document type chosen by the uploader: ${DOC_TYPE_LABEL[meta.docType] || 'unknown'}\nProduct named by the uploader: ${meta.product || '(none)'}\nFile: ${meta.filename}\nExcerpt ${i + 1} of ${use.length}:\n"""${use.at(i)}"""`,
    });
    parts.push(out);
  }
  const arr = (x) => (Array.isArray(x) ? x : []);
  const first = parts[0] || {};
  return {
    title: clip(first.title || meta.filename, 120),
    doc_type: DOC_TYPES.includes(first.doc_type) ? first.doc_type : meta.docType,
    summary: clip(first.summary || '', 400),
    products: uniqBy(parts.flatMap((p) => arr(p.products)).map((p) => ({ ...p, model: normalizeModel(p.model) || clip(p.model, 40) })), (p) => p.model),
    components: uniqBy(parts.flatMap((p) => arr(p.components)), (c) => String(c.name || '').toLowerCase()),
    specs: uniqBy(parts.flatMap((p) => arr(p.specs)), (s) => `${s.model}|${s.label}`.toLowerCase()),
    intervals: uniqBy(parts.flatMap((p) => arr(p.intervals)).map((i) => ({ ...i, hours: Number(i.hours) || 0 })), (i) => `${i.hours}|${String(i.task).slice(0, 50)}`.toLowerCase()),
    fault_codes: uniqBy(parts.flatMap((p) => arr(p.fault_codes)).map((c) => ({ ...c, code: normalizeCode(c.code) })), (c) => c.code),
    policies: uniqBy(parts.flatMap((p) => arr(p.policies)), (p) => String(p.rule || '').toLowerCase().slice(0, 60)),
    hazards: [...new Set(parts.flatMap((p) => arr(p.hazards)))],
  };
}

/* ---------------------------- graph integration ---------------------------- */

function writeToGraph(doc, ex) {
  const at = nowIso();
  const delta = newDelta();
  const dNode = upsertNode('document', String(doc.id), clip(ex.title, 48), { docId: doc.id, docType: ex.doc_type, filename: doc.filename }, delta, at);
  const modelIds = new Map();
  const linkModel = (name) => q.run('INSERT OR IGNORE INTO doc_models (doc_id, model) VALUES (?, ?)', doc.id, name);
  for (const p of ex.products) {
    const name = normalizeModel(p.model) || clip(p.model, 40);
    if (!name) continue;
    const isNewNode = !nodeExists('model', name);
    const hasMachines = Boolean(q.get('SELECT 1 FROM assets WHERE model = ?', name));
    const id = upsertNode('model', name, name, { family: p.family || '', ...(isNewNode ? { source: 'document', newProduct: !hasMachines } : {}) }, delta, at);
    upsertEdge(dNode, id, 'DESCRIBES', delta, at);
    modelIds.set(name, id);
    linkModel(name);
  }
  const mainModel = [...modelIds.keys()][0] || null;
  const modelNodeFor = (raw) => { const n = normalizeModel(raw); return n && modelIds.get(n) ? modelIds.get(n) : n && nodeExists('model', n) ? nodeId('model', n) : null; };
  const compNode = (raw) => {
    const name = resolveComponent(raw);
    if (!name) return null;
    return upsertNode('component', name, name, { system: componentSystem(name) }, delta, at);
  };
  for (const c of ex.components) {
    const id = compNode(c.name);
    if (!id) continue;
    upsertEdge(dNode, id, 'SPECIFIES', delta, at);
    for (const mId of modelIds.values()) upsertEdge(mId, id, 'HAS_COMPONENT', delta, at);
  }
  for (const s of ex.specs) {
    if (!s.label || !s.value) continue;
    const model = normalizeModel(s.model) || mainModel || 'unspecified';
    const label = `${clip(s.label, 30)}: ${clip(s.value, 16)}${s.unit ? ' ' + clip(s.unit, 10) : ''}`;
    const id = upsertNode('spec', `${model}|${s.label}`, label, { model, label: s.label, value: s.value, unit: s.unit || '', docId: doc.id }, delta, at);
    upsertEdge(modelNodeFor(s.model) || modelIds.get(mainModel) || dNode, id, 'HAS_SPEC', delta, at);
    upsertEdge(dNode, id, 'DEFINES', delta, at);
    if (s.component) { const c = compNode(s.component); if (c) upsertEdge(id, c, 'FOR', delta, at); }
  }
  for (const it of ex.intervals) {
    if (!it.task) continue;
    const hours = Number(it.hours) || null;
    const label = hours && !/every/i.test(it.task) ? `${clip(it.task, 34)} every ${hours} h` : clip(it.task, 48);
    const id = upsertNode('procedure', `${mainModel || doc.id}|${slug(it.task).slice(0, 40)}|${hours}`, label, { hours, condition: it.condition || '', docId: doc.id }, delta, at);
    upsertEdge(modelIds.get(mainModel) || dNode, id, 'REQUIRES', delta, at);
    upsertEdge(dNode, id, 'DEFINES', delta, at);
    if (it.component) { const c = compNode(it.component); if (c) upsertEdge(id, c, 'FOR', delta, at); }
    if (it.condition) {
      const cond = canonical([{ name: 'Dusty', re: /dust/ }, { name: 'High ambient heat', re: /heat|hot/ }, { name: 'Wet / muddy ground', re: /mud|wet|rain/ }, { name: 'Cold weather', re: /cold|freez/ }], it.condition);
      if (cond && nodeExists('condition', cond)) upsertEdge(id, nodeId('condition', cond), 'WHEN', delta, at);
    }
  }
  for (const fc of ex.fault_codes) {
    if (!fc.code) continue;
    const id = upsertNode('code', fc.code, fc.code, fc.meaning ? { meaning: clip(fc.meaning, 160) } : {}, delta, at);
    upsertEdge(dNode, id, 'EXPLAINS', delta, at);
    if (fc.component) { const c = compNode(fc.component); if (c) upsertEdge(id, c, 'INDICATES', delta, at); }
  }
  const hazardIds = new Map();
  for (const h of ex.hazards) {
    const name = canonical(HAZARDS, h);
    if (!name) continue;
    const id = upsertNode('hazard', name, name, {}, delta, at);
    upsertEdge(dNode, id, 'ADDRESSES', delta, at);
    hazardIds.set(name, id);
  }
  const sites = q.all('SELECT id FROM sites').map((s) => nodeId('site', s.id));
  for (const p of ex.policies) {
    if (!p.rule) continue;
    const id = upsertNode('policy', `${doc.id}|${slug(p.rule).slice(0, 48)}`, clip(p.rule, 48), { rule: clip(p.rule, 400), category: p.category || 'other', docId: doc.id }, delta, at);
    upsertEdge(dNode, id, 'ESTABLISHES', delta, at);
    for (const target of Array.isArray(p.applies_to) ? p.applies_to : []) {
      const m = modelNodeFor(target);
      if (m) { upsertEdge(id, m, 'APPLIES_TO', delta, at); linkModel(normalizeModel(target)); continue; }
      if (/all|fleet|every/i.test(target)) { for (const s of sites) upsertEdge(id, s, 'APPLIES_TO', delta, at); linkModel('*'); continue; }
      const fam = q.all('SELECT DISTINCT model FROM assets WHERE lower(family) LIKE ?', `%${String(target).toLowerCase().replace(/s$/, '')}%`);
      for (const f of fam) { upsertEdge(id, nodeId('model', f.model), 'APPLIES_TO', delta, at); linkModel(f.model); }
    }
    for (const hz of matchAll(HAZARDS, p.rule.toLowerCase())) { const h = hazardIds.get(hz) || upsertNode('hazard', hz, hz, {}, delta, at); upsertEdge(id, h, 'ADDRESSES', delta, at); }
  }
  // What changed: new branches vs. existing knowledge it attached to.
  const nodes = uniqBy(delta.nodes, (n) => n.id);
  const fresh = nodes.filter((n) => n.isNew && n.type !== 'document');
  const linked = nodes.filter((n) => !n.isNew && n.type !== 'document');
  const byType = {};
  for (const n of fresh) (byType[n.type] ||= []).push(n.label);
  return {
    delta,
    summary: {
      newNodes: fresh.length, linkedExisting: linked.length, newEdges: uniqBy(delta.edges, (e) => e.id).filter((e) => e.isNew).length,
      newByType: byType, linkedSample: linked.slice(0, 12).map((n) => ({ type: n.type, label: n.label, id: n.id })),
      newSample: fresh.slice(0, 40).map((n) => ({ type: n.type, label: n.label, id: n.id })),
    },
  };
}

/* ------------------------------- the agent -------------------------------- */

const STEP_LABEL = { read: 'Reading the file', understand: 'Finding products, parts, specs, codes and policies', link: 'Matching against the knowledge graph', write: 'Writing to the knowledge graph', done: 'Done', failed: 'Stopped' };

function progress(id, step, detail = '') {
  const row = q.get('SELECT steps FROM documents WHERE id = ?', id);
  const steps = parseJson(row?.steps, []);
  steps.push({ step, label: STEP_LABEL[step] || step, detail, at: nowIso() });
  q.run('UPDATE documents SET stage = ?, steps = ? WHERE id = ?', step, steps, id);
  publish('doc-step', { id, step, label: STEP_LABEL[step] || step, detail });
}

export function getDocument(id) {
  const d = q.get('SELECT d.*, p.name AS uploaded_by_name FROM documents d LEFT JOIN people p ON p.id = d.uploaded_by WHERE d.id = ?', id);
  if (!d) return null;
  return { ...d, extraction: parseJson(d.extraction, null), graph_summary: parseJson(d.graph_summary, null), steps: parseJson(d.steps, []), models: q.all('SELECT model FROM doc_models WHERE doc_id = ?', id).map((r) => r.model) };
}
export function listDocuments() {
  return q.all(`SELECT d.id, d.title, d.doc_type, d.product, d.filename, d.size, d.pages, d.status, d.stage, d.ai_mode, d.graph_summary, d.created_at, d.integrated_at, p.name AS uploaded_by_name
                FROM documents d LEFT JOIN people p ON p.id = d.uploaded_by ORDER BY d.created_at DESC`).map((d) => ({ ...d, graph_summary: parseJson(d.graph_summary, null) }));
}

/** Accept an upload and hand it to the agent in the background. */
export function acceptUpload({ filename, data, docType, product, uploadedBy }) {
  const name = path.basename(String(filename || '')).replace(/[^\w.\- ()]/g, '_').slice(0, 120);
  if (!name) throw clientError(400, 'The file needs a name.');
  const buf = Buffer.from(String(data || ''), 'base64');
  if (!buf.length) throw clientError(400, 'The file is empty.');
  if (buf.length > MAX_BYTES) throw clientError(413, 'Files up to 15 MB, please.');
  const ext = path.extname(name).toLowerCase();
  if (!['.pdf', '.docx', ...TEXT_EXT].includes(ext)) throw clientError(415, `Can't read ${ext || 'that'} files yet. Use PDF, Word (.docx), text, Markdown or CSV.`);
  const stored = `${Date.now()}-${slug(path.basename(name, ext)).slice(0, 60)}${ext}`;
  fs.writeFileSync(path.join(DOC_DIR, stored), buf);
  const r = q.run(`INSERT INTO documents (title, doc_type, product, filename, size, file_path, status, stage, steps, uploaded_by, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, 'processing', 'queued', '[]', ?, ?)`,
    path.basename(name, ext), DOC_TYPES.includes(docType) ? docType : 'other', String(product || '').slice(0, 80) || null, name, buf.length, `/uploads/docs/${stored}`, uploadedBy || null, nowIso());
  const id = Number(r.lastInsertRowid);
  publish('doc', { doc: getDocument(id) });
  integrateDocument(id, buf).catch((err) => console.warn('[docs] integration crashed:', err));
  return getDocument(id);
}

async function integrateDocument(id, buf) {
  const doc = q.get('SELECT * FROM documents WHERE id = ?', id);
  const fail = (message) => {
    progress(id, 'failed', message);
    q.run("UPDATE documents SET status = 'failed', error = ? WHERE id = ?", message, id);
    publish('doc', { doc: getDocument(id) });
  };
  try {
    progress(id, 'read', doc.filename);
    const { text, pages } = await readText(buf, doc.filename);
    const clean = text.replace(/\u0000/g, '').trim();
    if (clean.length < 40) return fail('No readable text found. If this is a scanned PDF, export it with text (OCR) and upload again.');
    const chunks = chunkText(clean);
    tx(() => {
      q.run('DELETE FROM doc_chunks WHERE doc_id = ?', id);
      chunks.forEach((c, i) => q.run('INSERT INTO doc_chunks (doc_id, idx, text) VALUES (?, ?, ?)', id, i, c));
      q.run('UPDATE documents SET pages = ?, text_chars = ? WHERE id = ?', pages, clean.length, id);
    });
    progress(id, 'read', `${pages ? `${pages} page${pages === 1 ? '' : 's'}, ` : ''}${clean.length.toLocaleString()} characters in ${chunks.length} section${chunks.length === 1 ? '' : 's'}`);

    const meta = { id, filename: doc.filename, docType: doc.doc_type, product: doc.product };
    const rules = ruleDocExtract(clean, { docType: doc.doc_type, product: doc.product });
    let ex = rules; let aiMode = 'rules'; let aiNote = '';
    if (llmEnabled()) {
      try {
        ex = await modelDocExtract(chunks, meta);
        aiMode = 'llm';
        // Safety net: keep anything the patterns found that the model skipped.
        ex.products = uniqBy([...ex.products, ...rules.products], (p) => p.model);
        ex.fault_codes = uniqBy([...ex.fault_codes, ...rules.fault_codes], (c) => c.code);
        if (!ex.specs.length) ex.specs = rules.specs;
        if (!ex.intervals.length) ex.intervals = rules.intervals;
      } catch (err) {
        aiNote = `AI reading failed (${describeLlmError(err)}); used pattern matching instead.`;
        console.warn(`[docs] ${doc.filename}: ${aiNote}`);
      }
    }
    if (chunks.length > MAX_AI_CHUNKS && aiMode === 'llm') aiNote = `The model read the first ${MAX_AI_CHUNKS} of ${chunks.length} sections; the rest is searchable but not mapped into the graph.`;
    progress(id, 'understand', `${ex.products.length} product${ex.products.length === 1 ? '' : 's'}, ${ex.components.length} parts, ${ex.specs.length} specs, ${ex.intervals.length} service intervals, ${ex.fault_codes.length} fault codes, ${ex.policies.length} policies${aiNote ? ` · ${aiNote}` : ''}`);

    progress(id, 'link', 'Snapping names to the shared vocabulary and existing nodes');
    const { delta, summary } = tx(() => writeToGraph({ ...doc, id }, ex));
    progress(id, 'write', `${summary.newNodes} new branch${summary.newNodes === 1 ? '' : 'es'}, ${summary.linkedExisting} existing node${summary.linkedExisting === 1 ? '' : 's'} linked, ${summary.newEdges} new links`);

    q.run(`UPDATE documents SET title = ?, doc_type = ?, summary = ?, extraction = ?, graph_summary = ?, ai_mode = ?, status = 'integrated', error = ?, integrated_at = ? WHERE id = ?`,
      ex.title || doc.title, ex.doc_type || doc.doc_type, ex.summary, ex, summary, aiMode === 'llm' ? docModel() : 'rules', aiNote || null, nowIso(), id);
    progress(id, 'done', aiMode === 'llm' ? `Read by ${docModel().split('/').pop()}` : 'Read by pattern matching (no AI provider)');
    publish('graph', { nodes: uniqBy(delta.nodes, (n) => n.id), edges: uniqBy(delta.edges, (e) => e.id) });
    publish('doc', { doc: getDocument(id) });
    console.log(`[docs] ${doc.filename}: +${summary.newNodes} nodes, ${summary.linkedExisting} linked (${aiMode})`);
  } catch (err) {
    console.warn('[docs] integration failed:', err);
    fail(err.status ? err.message : `Couldn't process this file: ${err.message}`);
  }
}

/* -------------------------------- retrieval -------------------------------- */

const STOP = new Set('the and for with what how does this that are was were has have when which who from into your about there their them they then than does should could would can any all per its our out use used using'.split(' '));

/** Keyword search over document text; documents tied to `model` rank higher. */
export function searchDocs(query, { model = null, limit = 4, excerpt = 700 } = {}) {
  const terms = [...tokens(query)].filter((t) => !STOP.has(t));
  if (!terms.length) return [];
  const linked = new Set(model ? q.all("SELECT doc_id FROM doc_models WHERE model = ? OR model = '*'", model).map((r) => r.doc_id) : []);
  const rows = q.all(`SELECT c.doc_id, c.idx, c.text, d.title, d.doc_type, d.product FROM doc_chunks c JOIN documents d ON d.id = c.doc_id WHERE d.status = 'integrated'`);
  const scored = rows.map((r) => {
    const low = r.text.toLowerCase();
    let score = 0; let firstHit = -1;
    for (const t of terms) {
      let i = low.indexOf(t); let n = 0;
      while (i >= 0 && n < 3) { if (firstHit < 0 || i < firstHit) firstHit = i; n++; i = low.indexOf(t, i + t.length); }
      score += n;
    }
    if (linked.has(r.doc_id)) score += 3;
    return { r, score, firstHit };
  }).filter((x) => x.score >= 2).sort((a, b) => b.score - a.score);
  const out = []; const perDoc = new Map();
  for (const { r, firstHit } of scored) {
    if ((perDoc.get(r.doc_id) || 0) >= 2) continue;
    perDoc.set(r.doc_id, (perDoc.get(r.doc_id) || 0) + 1);
    const start = Math.max(0, firstHit - 200);
    const applies = q.all('SELECT model FROM doc_models WHERE doc_id = ?', r.doc_id).map((m) => (m.model === '*' ? 'all machines (site-wide rules)' : m.model));
    out.push({ doc_id: r.doc_id, ref: `D${r.doc_id}`, title: r.title, doc_type: DOC_TYPE_LABEL[r.doc_type] || r.doc_type, applies_to: applies, excerpt: clip(r.text.slice(start, start + excerpt), excerpt) });
    if (out.length >= limit) break;
  }
  return out;
}
