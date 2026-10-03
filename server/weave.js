// Weaves one report into the knowledge graph, and takes it back out again when the report is
// deleted. Both directions walk the same links so a delete followed by a restore is lossless.
import { q } from './db.js';
import { upsertNode, upsertEdge, nodeId } from './graph.js';
import { componentSystem } from './vocab.js';

/** The links between entities that one report reinforces (each report adds one observation to each). */
function entityLinks(ex, assetId, model, siteId) {
  const aId = nodeId('asset', assetId); const mId = nodeId('model', model); const sId = nodeId('site', siteId);
  const comps = (ex.components || []).map((c) => nodeId('component', c));
  const syms = (ex.symptoms || []).map((s) => nodeId('symptom', s));
  const codes = (ex.fault_codes || []).map((c) => nodeId('code', c));
  const conds = (ex.conditions || []).map((c) => nodeId('condition', c));
  const hazards = (ex.safety_hazards || []).map((h) => nodeId('hazard', h));
  return {
    structural: [[aId, mId, 'INSTANCE_OF'], [aId, sId, 'LOCATED_AT']],
    links: [
      ...comps.map((c) => [mId, c, 'HAS_COMPONENT']),
      ...comps.slice(0, 2).flatMap((c) => syms.map((s) => [c, s, 'SHOWS'])),
      ...codes.flatMap((k) => comps.slice(0, 1).map((c) => [k, c, 'INDICATES'])),
      ...syms.flatMap((s) => conds.map((c) => [s, c, 'CORRELATES_WITH'])),
      ...hazards.map((h) => [h, sId, 'OBSERVED_AT']),
    ],
    entities: [...comps, ...syms, ...codes, ...conds, ...hazards],
    anchors: [aId, mId, sId],
  };
}

/**
 * Add a report and everything it mentions to the graph. Returns the node ids callers link to next
 * (engineering cases hang off the report, model and first component).
 */
export function weaveReport({ reportId, ex, label, asset, person, source, createdAt, similar = [], delta }) {
  const at = createdAt;
  const rNode = upsertNode('report', String(reportId), String(label || ex.summary || '').slice(0, 48), { reportId, severity: ex.severity, category: ex.category, asset: asset.id, source, created_at: createdAt }, delta, at);
  const aNode = upsertNode('asset', asset.id, asset.id, { model: asset.model, family: asset.family, status: asset.status }, delta, at);
  const mNode = upsertNode('model', asset.model, asset.model, { family: asset.family }, delta, at);
  const sNode = upsertNode('site', asset.site_id, asset.site_name, { location: asset.site_location }, delta, at);
  upsertEdge(rNode, aNode, 'ABOUT', delta, at);
  upsertEdge(aNode, mNode, 'INSTANCE_OF', delta, at);
  upsertEdge(aNode, sNode, 'LOCATED_AT', delta, at);
  if (person) {
    const pNode = upsertNode('person', person.id, person.name, { role: person.role }, delta, at);
    upsertEdge(rNode, pNode, 'REPORTED_BY', delta, at);
  }
  const compNodes = (ex.components || []).map((c) => {
    const id = upsertNode('component', c, c, { system: componentSystem(c) }, delta, at);
    upsertEdge(rNode, id, 'AFFECTS', delta, at);
    upsertEdge(mNode, id, 'HAS_COMPONENT', delta, at);
    return id;
  });
  const symNodes = (ex.symptoms || []).map((s) => {
    const id = upsertNode('symptom', s, s, {}, delta, at);
    upsertEdge(rNode, id, 'EXHIBITS', delta, at);
    return id;
  });
  for (const cId of compNodes.slice(0, 2)) for (const sId of symNodes) upsertEdge(cId, sId, 'SHOWS', delta, at);
  for (const code of ex.fault_codes || []) {
    const id = upsertNode('code', code, code, {}, delta, at);
    upsertEdge(rNode, id, 'RAISED', delta, at);
    for (const cId of compNodes.slice(0, 1)) upsertEdge(id, cId, 'INDICATES', delta, at);
  }
  for (const cond of ex.conditions || []) {
    const id = upsertNode('condition', cond, cond, {}, delta, at);
    upsertEdge(rNode, id, 'UNDER', delta, at);
    for (const sId of symNodes) upsertEdge(sId, id, 'CORRELATES_WITH', delta, at);
  }
  for (const hz of ex.safety_hazards || []) {
    const id = upsertNode('hazard', hz, hz, {}, delta, at);
    upsertEdge(rNode, id, 'FLAGS', delta, at);
    upsertEdge(id, sNode, 'OBSERVED_AT', delta, at);
  }
  for (const s of similar.filter((x) => x.score >= 7).slice(0, 3)) {
    const other = nodeId('report', String(s.id));
    if (q.get('SELECT id FROM nodes WHERE id = ?', other)) upsertEdge(rNode, other, 'SIMILAR_TO', delta, at);
  }
  return { rNode, aNode, mNode, sNode, compNodes, symNodes };
}

/**
 * Take a report out of the graph: its node and every link touching it go; links between entities
 * lose the observation it added (and disappear at zero); parts, symptoms, codes, conditions and
 * hazards that nothing else mentions any more are removed. Machines, models, sites and people stay.
 */
export function unweaveReport(report, model) {
  const removed = { nodes: [], edges: [] };
  const rId = nodeId('report', String(report.id));
  for (const e of q.all('SELECT id FROM edges WHERE src = ? OR dst = ?', rId, rId)) removed.edges.push(e.id);
  q.run('DELETE FROM edges WHERE src = ? OR dst = ?', rId, rId);
  if (q.run('DELETE FROM nodes WHERE id = ?', rId).changes) removed.nodes.push(rId);

  const { structural, links, entities, anchors } = entityLinks(report.extraction || {}, report.asset_id, model, report.site_id);
  for (const [src, dst, type] of structural) q.run('UPDATE edges SET weight = MAX(1, weight - 1) WHERE src = ? AND dst = ? AND type = ?', src, dst, type);
  for (const [src, dst, type] of links) {
    const e = q.get('SELECT id, weight FROM edges WHERE src = ? AND dst = ? AND type = ?', src, dst, type);
    if (!e) continue;
    if (e.weight <= 1) { q.run('DELETE FROM edges WHERE id = ?', e.id); removed.edges.push(e.id); }
    else q.run('UPDATE edges SET weight = weight - 1 WHERE id = ?', e.id);
  }
  for (const id of [...new Set(entities)]) {
    if (!q.get('SELECT id FROM nodes WHERE id = ?', id)) continue;
    const linked = q.get('SELECT 1 AS x FROM edges WHERE src = ? OR dst = ? LIMIT 1', id, id);
    if (!linked) { q.run('DELETE FROM nodes WHERE id = ?', id); removed.nodes.push(id); }
    else q.run('UPDATE nodes SET weight = MAX(1, weight - 1) WHERE id = ?', id);
  }
  for (const id of anchors) q.run('UPDATE nodes SET weight = MAX(1, weight - 1) WHERE id = ?', id);
  if (report.person_id) q.run('UPDATE nodes SET weight = MAX(1, weight - 1) WHERE id = ?', nodeId('person', report.person_id));
  return removed;
}

const ENTITY_TYPES = new Set(['component', 'symptom', 'code', 'condition', 'hazard']);

/** Remove parts, symptoms, codes, conditions and hazards that no longer link to anything. */
export function pruneOrphans(ids) {
  const gone = [];
  for (const id of new Set(ids)) {
    if (!ENTITY_TYPES.has(String(id).split(':')[0])) continue;
    if (q.get('SELECT 1 AS x FROM edges WHERE src = ? OR dst = ? LIMIT 1', id, id)) continue;
    if (q.run('DELETE FROM nodes WHERE id = ?', id).changes) gone.push(id);
  }
  return gone;
}
