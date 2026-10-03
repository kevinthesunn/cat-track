// SQLite persistence for Cat Track (uses Node's built-in node:sqlite, no native deps).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(here, '..', 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const DB_PATH = process.env.CAT_TRACK_DB || path.join(DATA_DIR, 'cattrack.db');

export function resetDatabaseFile() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch { /* not present */ }
  }
}

if (process.argv.includes('--reseed')) resetDatabaseFile();

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, location TEXT, climate TEXT, lat REAL, lng REAL
);
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, site_id TEXT, specialty TEXT
);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, model TEXT NOT NULL, family TEXT NOT NULL, serial TEXT, site_id TEXT,
  year INTEGER, smu_hours REAL, fuel_pct REAL, status TEXT DEFAULT 'operational', health INTEGER DEFAULT 90,
  last_service_at TEXT, last_service_hours REAL, commissioned_at TEXT, operator_id TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id TEXT, site_id TEXT, person_id TEXT, source TEXT,
  raw_text TEXT, photo_path TEXT, category TEXT, severity TEXT, summary TEXT, extraction TEXT,
  ai_mode TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_asset ON reports(asset_id, created_at);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, label TEXT NOT NULL, props TEXT, weight INTEGER DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT, src TEXT NOT NULL, dst TEXT NOT NULL, type TEXT NOT NULL,
  weight INTEGER DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT, UNIQUE(src, dst, type)
);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, site_id TEXT, asset_id TEXT, report_id INTEGER, case_id INTEGER,
  kind TEXT, severity TEXT, title TEXT, body TEXT, audience TEXT, status TEXT DEFAULT 'open',
  ack_by TEXT, resolution TEXT, created_at TEXT NOT NULL, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS action_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, alert_id INTEGER, site_id TEXT, asset_id TEXT, text TEXT NOT NULL,
  assignee_role TEXT, status TEXT DEFAULT 'open', done_by TEXT, created_at TEXT NOT NULL, done_at TEXT
);
CREATE TABLE IF NOT EXISTS eng_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_key TEXT UNIQUE, model TEXT, component TEXT, symptom TEXT,
  title TEXT, status TEXT DEFAULT 'new', priority TEXT DEFAULT 'P3', occurrences INTEGER DEFAULT 0,
  first_seen TEXT, last_seen TEXT, quick_fix TEXT, root_cause TEXT, product_action TEXT, engineer TEXT,
  ai_analysis TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS case_reports (
  case_id INTEGER NOT NULL, report_id INTEGER NOT NULL, PRIMARY KEY (case_id, report_id)
);
CREATE TABLE IF NOT EXISTS fixes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT, component TEXT, symptom TEXT, title TEXT NOT NULL,
  steps TEXT, source TEXT, author TEXT, case_id INTEGER, success INTEGER DEFAULT 0, fail INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fix_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT, fix_id INTEGER NOT NULL, asset_id TEXT, report_id INTEGER,
  worked INTEGER NOT NULL, person_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id TEXT NOT NULL, fact TEXT NOT NULL, kind TEXT,
  source_report_id INTEGER, fact_key TEXT, created_at TEXT NOT NULL, updated_at TEXT,
  UNIQUE(asset_id, fact_key)
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, doc_type TEXT, product TEXT, filename TEXT, size INTEGER,
  file_path TEXT, pages INTEGER, text_chars INTEGER, summary TEXT, status TEXT, stage TEXT, steps TEXT, error TEXT,
  extraction TEXT, graph_summary TEXT, ai_mode TEXT, uploaded_by TEXT, created_at TEXT NOT NULL, integrated_at TEXT
);
CREATE TABLE IF NOT EXISTS doc_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id INTEGER NOT NULL, idx INTEGER NOT NULL, text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_doc ON doc_chunks(doc_id);
CREATE TABLE IF NOT EXISTS doc_models (
  doc_id INTEGER NOT NULL, model TEXT NOT NULL, PRIMARY KEY (doc_id, model)
);
CREATE TABLE IF NOT EXISTS report_trash (
  id INTEGER PRIMARY KEY, asset_id TEXT, site_id TEXT, person_id TEXT, summary TEXT, created_at TEXT,
  row TEXT NOT NULL, undo TEXT, deleted_at TEXT NOT NULL, deleted_by TEXT, reason TEXT, via TEXT
);
CREATE INDEX IF NOT EXISTS idx_report_trash_asset ON report_trash(asset_id, deleted_at);
CREATE TABLE IF NOT EXISTS report_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, report_id INTEGER NOT NULL, person_id TEXT, text TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_notes_report ON report_notes(report_id, created_at);
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id TEXT, metric TEXT, value REAL, unit TEXT, created_at TEXT NOT NULL
);
`);

// Additive migrations for databases created by earlier versions.
for (const sql of [
  'ALTER TABLE eng_cases ADD COLUMN ai_analysis_by TEXT',
  'ALTER TABLE alerts ADD COLUMN resolved_by_report INTEGER', // the repair report that closed it
  'ALTER TABLE fixes ADD COLUMN report_id INTEGER', // the report a field fix was learned from
  'ALTER TABLE reports ADD COLUMN lang TEXT', // language the report was given in (en/es/hi)
]) {
  try { db.exec(sql); } catch { /* column already exists */ }
}

export const nowIso = () => new Date().toISOString();

/** Convert JS values into something node:sqlite can bind (no undefined / booleans / objects). */
function bindable(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v;
}

const stmtCache = new Map();
function stmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}

export const q = {
  all: (sql, ...params) => stmt(sql).all(...params.map(bindable)),
  get: (sql, ...params) => stmt(sql).get(...params.map(bindable)),
  run: (sql, ...params) => stmt(sql).run(...params.map(bindable)),
};

export function tx(fn) {
  db.exec('BEGIN');
  try { const out = fn(); db.exec('COMMIT'); return out; }
  catch (err) { db.exec('ROLLBACK'); throw err; }
}

export function parseJson(text, fallback = null) {
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/**
 * Alerts store their audience as JSON text; always hand callers a real array. Each alert also
 * carries the key facts screens show without opening it: the part, the problem, the machine's
 * model, the site, and a headline without the machine prefix.
 */
export function alertRow(a) {
  if (!a) return a;
  const ex = a.report_id ? parseJson(q.get('SELECT extraction FROM reports WHERE id = ?', a.report_id)?.extraction, {}) : {};
  const asset = a.asset_id ? q.get('SELECT model FROM assets WHERE id = ?', a.asset_id) : null;
  const prefix = a.asset_id ? `${a.asset_id} · ` : '';
  return {
    ...a,
    audience: parseJson(a.audience, []),
    site_name: a.site_name || q.get('SELECT name FROM sites WHERE id = ?', a.site_id)?.name || null,
    model: asset?.model || null,
    part: ex.components?.[0] || null,
    problem: (ex.symptoms || []).find((s) => s !== 'Warning / fault code') || ex.symptoms?.[0] || null,
    hazard: ex.safety_hazards?.[0] || null,
    code: ex.fault_codes?.[0] || null,
    headline: prefix && String(a.title || '').startsWith(prefix) ? a.title.slice(prefix.length) : a.title,
  };
}
