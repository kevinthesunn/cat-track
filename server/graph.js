// The knowledge graph: every report, machine, component, symptom, fault code, condition,
// person, engineering case and fix becomes a node; relationships strengthen (weight++) each
// time they are observed again, so the graph keeps growing and reinforcing what it knows.
import { q, nowIso, parseJson } from './db.js';

export const slug = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const nodeId = (type, key) => `${type}:${slug(key)}`;

export function newDelta() { return { nodes: [], edges: [] }; }

export function upsertNode(type, key, label, props = {}, delta = null, at = nowIso()) {
  const id = nodeId(type, key);
  const existing = q.get('SELECT id, props, weight FROM nodes WHERE id = ?', id);
  let node;
  if (existing) {
    const merged = { ...parseJson(existing.props, {}), ...props };
    q.run('UPDATE nodes SET props = ?, label = ?, weight = weight + 1, updated_at = ? WHERE id = ?', merged, label, at, id);
    node = { id, type, label, props: merged, weight: existing.weight + 1, isNew: false };
  } else {
    q.run('INSERT INTO nodes (id, type, label, props, weight, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)', id, type, label, props, at, at);
    node = { id, type, label, props, weight: 1, isNew: true };
  }
  if (delta) delta.nodes.push(node);
  return id;
}

export function upsertEdge(src, dst, type, delta = null, at = nowIso()) {
  if (!src || !dst || src === dst) return;
  const existing = q.get('SELECT id, weight FROM edges WHERE src = ? AND dst = ? AND type = ?', src, dst, type);
  let edge;
  if (existing) {
    q.run('UPDATE edges SET weight = weight + 1, updated_at = ? WHERE id = ?', at, existing.id);
    edge = { id: existing.id, from: src, to: dst, type, weight: existing.weight + 1, isNew: false };
  } else {
    const r = q.run('INSERT INTO edges (src, dst, type, weight, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)', src, dst, type, at, at);
    edge = { id: Number(r.lastInsertRowid), from: src, to: dst, type, weight: 1, isNew: true };
  }
  if (delta) delta.edges.push(edge);
}

/** Update a node's label/props without counting it as a new observation. */
export function relabelNode(type, key, label, props = {}, delta = null, at = nowIso()) {
  const id = nodeId(type, key);
  const existing = q.get('SELECT props, weight FROM nodes WHERE id = ?', id);
  if (!existing) return upsertNode(type, key, label, props, delta, at);
  const merged = { ...parseJson(existing.props, {}), ...props };
  q.run('UPDATE nodes SET label = ?, props = ?, updated_at = ? WHERE id = ?', label, merged, at, id);
  if (delta) delta.nodes.push({ id, type, label, props: merged, weight: existing.weight, isNew: false });
  return id;
}

const toNode = (n) => ({ id: n.id, type: n.type, label: n.label, props: parseJson(n.props, {}), weight: n.weight, created_at: n.created_at });
const toEdge = (e) => ({ id: e.id, from: e.src, to: e.dst, type: e.type, weight: e.weight });

export function getGraph({ includeReports = true } = {}) {
  const nodes = q.all(includeReports ? 'SELECT * FROM nodes' : "SELECT * FROM nodes WHERE type <> 'report'").map(toNode);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = q.all('SELECT * FROM edges').map(toEdge).filter((e) => ids.has(e.from) && ids.has(e.to));
  return { nodes, edges };
}

/** Neighbourhood of a node out to `depth` hops (used for asset mini-graphs and node detail). */
export function getNeighborhood(rootId, depth = 2, limit = 160) {
  const seen = new Set([rootId]);
  let frontier = [rootId];
  const edgeMap = new Map();
  for (let d = 0; d < depth && frontier.length; d++) {
    const next = [];
    for (const id of frontier) {
      const rows = q.all('SELECT * FROM edges WHERE src = ? OR dst = ? ORDER BY weight DESC LIMIT 60', id, id);
      for (const e of rows) {
        edgeMap.set(e.id, e);
        for (const other of [e.src, e.dst]) {
          if (!seen.has(other) && seen.size < limit) { seen.add(other); next.push(other); }
        }
      }
    }
    frontier = next;
  }
  const nodes = [...seen].map((id) => q.get('SELECT * FROM nodes WHERE id = ?', id)).filter(Boolean).map(toNode);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = [...edgeMap.values()].filter((e) => ids.has(e.src) && ids.has(e.dst)).map(toEdge);
  return { nodes, edges };
}

export function nodeDetail(id) {
  const n = q.get('SELECT * FROM nodes WHERE id = ?', id);
  if (!n) return null;
  const links = q.all(
    `SELECT e.type, e.weight, e.src, e.dst, n.label AS other_label, n.type AS other_type, n.id AS other_id
       FROM edges e JOIN nodes n ON n.id = CASE WHEN e.src = ? THEN e.dst ELSE e.src END
      WHERE e.src = ? OR e.dst = ? ORDER BY e.weight DESC LIMIT 80`, id, id, id);
  return {
    node: toNode(n),
    links: links.map((l) => ({ type: l.type, weight: l.weight, direction: l.src === id ? 'out' : 'in', other: { id: l.other_id, label: l.other_label, type: l.other_type } })),
  };
}

export function graphStats() {
  const nodes = q.get('SELECT COUNT(*) AS c FROM nodes').c;
  const edges = q.get('SELECT COUNT(*) AS c FROM edges').c;
  const byType = q.all('SELECT type, COUNT(*) AS c FROM nodes GROUP BY type ORDER BY c DESC');
  return { nodes, edges, byType };
}
