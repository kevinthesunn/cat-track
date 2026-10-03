// Site map: the knowledge graph drawn as job sites → machines → reports. Each report is a circle
// coloured by urgency with an icon for the type of issue; the parts, problems and conditions it
// mentions hang off it. Filters for job site, time, urgency, issue type, status and extra layers.
// "Coming in" shows each report as it is received, then what Cat Track made of it.
(function () {
  const { api, esc, ago, dateTime, sevPill, statusPill, toast, connectStream, topbar, icon, emptyState, keyFacts, dropdown, kv, store, clip, problemOf, iconPaths, FAMILY_ICON, SOURCE_LABEL, REPORT_STATUS, t } = CT;
  const $ = (id) => document.getElementById(id);
  $('top').innerHTML = topbar('/graph');
  $('searchIcon').outerHTML = icon('search');
  $('zoomOut').innerHTML = icon('minus');
  $('zoomIn').innerHTML = icon('plus');
  $('fitBtn').innerHTML = icon('fit');
  $('sideBtn').innerHTML = `${icon('filter')} ${t('Filters')}`;
  $('moreChev').outerHTML = icon('chevron');

  // Side panel: Filters, or the live list of reports coming in.
  let pane = 'filters';
  function showPane(name) {
    pane = name;
    document.querySelectorAll('.side-tabs [data-pane]').forEach((b) => { const on = b.dataset.pane === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    $('paneFilters').classList.toggle('hidden', name !== 'filters');
    $('paneLive').classList.toggle('hidden', name !== 'live');
    if (name === 'live') $('liveDot').classList.add('hidden');
  }
  document.querySelector('.side-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-pane]'); if (b) showPane(b.dataset.pane); });

  /* ------------------------------ visual language ------------------------------ */
  const URGENCY = {
    critical: { label: 'Critical', color: '#e5484d', size: 21 },
    high: { label: 'High', color: '#ec7a2c', size: 18 },
    medium: { label: 'Medium', color: '#d9a800', size: 15 },
    low: { label: 'Low', color: '#3fa66b', size: 12 },
  };
  const ISSUES = CT.ISSUES;
  const ENTITY = {
    component: { label: 'Part', shape: 'dot', color: '#5f6772' },
    symptom: { label: 'Problem', shape: 'triangle', color: '#5f6772' },
    code: { label: 'Fault code', shape: 'box', color: '#3a3f47' },
    hazard: { label: 'Hazard', shape: 'triangleDown', color: '#5f6772' },
    condition: { label: 'Condition', shape: 'hexagon', color: '#5f6772' },
    case: { label: 'Engineering case', shape: 'star', color: '#3987e5' },
    fix: { label: 'Known fix', shape: 'square', color: '#3987e5' },
    person: { label: 'Person', shape: 'dot', color: '#8a8f96' },
    document: { label: 'Product document', shape: 'diamond', color: '#3987e5' },
  };
  // Parts, problems, hazards and conditions are vocabulary names, shown in the active language.
  const VOCAB = new Set(['component', 'symptom', 'hazard', 'condition']);
  const nodeName = (n) => (VOCAB.has(n.type) ? t(n.label) : n.label);
  const LAYERS = {
    parts: { label: 'Parts & problems', types: ['component', 'symptom', 'code', 'hazard'], on: true, swatch: '<circle cx="5" cy="9" r="4" fill="#5f6772"/><polygon points="13,4 18,13 8,13" fill="#5f6772"/>' },
    conditions: { label: 'Weather & conditions', types: ['condition'], on: true, swatch: '<polygon points="6,3 14,3 18,9 14,15 6,15 2,9" fill="#5f6772"/>' },
    cases: { label: 'Engineering cases & fixes', types: ['case', 'fix'], on: false, swatch: '<polygon points="10,1 12.4,6.8 18.6,7.2 13.8,11.1 15.4,17.2 10,13.8 4.6,17.2 6.2,11.1 1.4,7.2 7.6,6.8" fill="#3987e5"/>' },
    people: { label: 'Who reported', types: ['person'], on: false, swatch: '<circle cx="10" cy="9" r="5" fill="#8a8f96"/>' },
    docs: { label: 'Product documents', types: ['document'], on: false, swatch: '<polygon points="10,2 17,9 10,16 3,9" fill="#3987e5"/>' },
  };
  const LAYER_OF = {};
  for (const [k, l] of Object.entries(LAYERS)) for (const t of l.types) LAYER_OF[t] = k;
  const MACHINE_RING = { down: '#e5484d', attention: '#ec7a2c', operational: '#3fa66b' };
  const MACHINE_STATUS = { down: 'Down', attention: 'Needs attention', operational: 'Running' };
  const BG = '#0f1012';
  const MAX_SCALE = 2.4;
  const DAY = 86400000;
  const assetNode = (assetId) => `asset:${String(assetId).toLowerCase()}`;

  // Report and machine circles are SVG images: an icon on a filled disc.
  const imgCache = new Map();
  function badgeImage(name, bg, fg) {
    const key = `${name}|${bg}|${fg}`;
    if (!imgCache.has(key)) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" fill="${bg}"/><g transform="translate(24 24) scale(2)" fill="none" stroke="${fg}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">${iconPaths(name)}</g></svg>`;
      imgCache.set(key, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    }
    return imgCache.get(key);
  }
  const badge = (name, bg, cls = '') => `<span class="badge ${cls}" style="background:${bg}">${icon(name)}</span>`;
  function tip(title, metaHtml = '') {
    const el = document.createElement('div');
    el.innerHTML = `<div class="tip-t">${esc(title)}</div>${metaHtml ? `<div class="tip-m">${metaHtml}</div>` : ''}`;
    return el;
  }

  /* ------------------------------ data ------------------------------ */
  const data = { view: null, byId: new Map(), adj: new Map(), siteNode: new Map(), sites: [], reportCount: new Map() };
  const nodes = new vis.DataSet();
  const edges = new vis.DataSet();
  let visible = new Set();
  const nodeView = new vis.DataView(nodes, { filter: (n) => visible.has(n.id) });
  const edgeView = new vis.DataView(edges, { filter: (e) => visible.has(e.from) && visible.has(e.to) });
  let network = null;

  function ingest(v) {
    data.view = v;
    data.sites = v.sites;
    data.byId = new Map(v.nodes.map((n) => [n.id, n]));
    data.adj = new Map();
    for (const e of v.edges) {
      if (!data.adj.has(e.from)) data.adj.set(e.from, new Set());
      if (!data.adj.has(e.to)) data.adj.set(e.to, new Set());
      data.adj.get(e.from).add(e.to);
      data.adj.get(e.to).add(e.from);
    }
    data.siteNode = new Map(v.nodes.filter((n) => n.type === 'site').map((n) => [n.site_id, n.id]));
    data.reportCount = new Map();
    for (const n of v.nodes) if (n.type === 'report') { const a = assetNode(n.asset_id); data.reportCount.set(a, (data.reportCount.get(a) || 0) + 1); }
  }
  const reportsOf = () => data.view.nodes.filter((n) => n.type === 'report');
  const siteName = (siteId) => data.sites.find((s) => s.id === siteId)?.name || '';
  // A solved problem turns green and stays bright: its colour now says "fixed", not how urgent it was.
  const SOLVED = { label: 'Solved', color: '#3fa66b', size: 13 };
  const isSolved = (n) => n.type === 'report' && n.status === 'closed';
  const isFaded = (n) => n.type === 'report' && (['repair', 'withdrawn'].includes(n.status) || (n.status === 'logged' && n.severity === 'low'));
  const baseOpacity = (n) => (isFaded(n) ? 0.42 : 1);

  /* ------------------------------ styling ------------------------------ */
  const SITE_POS = {};
  function styleNode(n) {
    if (n.type === 'site') {
      const p = SITE_POS[n.id] || { x: 0, y: 0 };
      return {
        id: n.id, ct: n, x: p.x, y: p.y, fixed: { x: true, y: true }, shape: 'circularImage', image: badgeImage('pin', '#ffcd11', '#121212'), size: 32, borderWidth: 3, opacity: 1,
        color: { border: '#ffcd11', background: '#ffcd11', highlight: { border: '#ffffff', background: '#ffcd11' }, hover: { border: '#ffffff', background: '#ffcd11' } },
        label: undefined,
        title: tip(n.label, esc([n.location, n.climate].filter(Boolean).join(' · '))),
      };
    }
    if (n.type === 'asset') {
      return {
        id: n.id, ct: n, shape: 'circularImage', image: badgeImage(FAMILY_ICON[n.family] || 'excavator', '#24262b', '#ffcd11'), size: 19, borderWidth: 3, opacity: 1,
        color: { border: MACHINE_RING[n.status] || '#67665f', background: '#24262b', highlight: { border: '#ffffff', background: '#24262b' }, hover: { border: '#ffffff', background: '#24262b' } },
        label: n.label, font: { size: 15, color: '#f3f1ec', face: 'IBM Plex Mono', strokeWidth: 4, strokeColor: BG },
        title: tip(`${n.label} · ${n.model}`, `${esc(t(MACHINE_STATUS[n.status] || n.status))} · ${t('health {h}/100', { h: n.health })} · ${t('{n} open', { n: n.open_alerts })}`),
      };
    }
    if (n.type === 'report') {
      const u = URGENCY[n.severity] || URGENCY.low; const is = ISSUES[n.issue] || ISSUES.note;
      const solved = isSolved(n);
      const color = solved ? SOLVED.color : u.color;
      return {
        id: n.id, ct: n, shape: 'circularImage', image: badgeImage(solved ? 'check' : is.icon, color, '#111111'), size: solved ? SOLVED.size : u.size, borderWidth: 2, opacity: baseOpacity(n),
        color: { border: color, background: color, highlight: { border: '#ffffff', background: color }, hover: { border: '#ffffff', background: color } },
        label: clip(n.label, 30), font: { size: 11, color: '#d9d7d0', strokeWidth: 4, strokeColor: BG },
        title: tip(n.label, `${solved ? t('Solved (was {urgency})', { urgency: t(u.label).toLowerCase() }) : t(u.label)} · ${esc(t(is.label))}${solved && n.resolution ? `<br>${esc(clip(n.resolution, 90))}` : ''}<br>${esc(n.asset_id)} · ${esc(ago(n.created_at))}`),
      };
    }
    const ent = ENTITY[n.type] || ENTITY.component;
    const out = {
      id: n.id, ct: n, shape: ent.shape, size: Math.min(13, 6 + Math.log2((n.weight || 1) + 1) * 1.6), borderWidth: 1, opacity: 1,
      color: { background: ent.color, border: '#80868f', highlight: { background: '#d9d7d0', border: '#ffffff' }, hover: { background: ent.color, border: '#ffffff' } },
      label: clip(n.type === 'case' ? t('Case #{id}', { id: n.case_id }) : nodeName(n), 26), font: { size: 11, color: '#a9a79f', strokeWidth: 4, strokeColor: BG },
      title: tip(n.type === 'case' ? (n.title || n.label) : nodeName(n), esc(t(ent.label))),
    };
    if (n.type === 'code') Object.assign(out, { font: { size: 10, color: '#f3f1ec', face: 'IBM Plex Mono', strokeWidth: 0 }, margin: 5 });
    return out;
  }
  const EDGE = {
    LOCATED_AT: { color: 'rgba(255,205,17,.42)', width: 2, length: 230 },
    ABOUT: { color: 'rgba(196,194,186,.42)', width: 1.4, length: 85 },
    PART_OF: { color: 'rgba(57,135,229,.5)', width: 1, length: 110, dashes: [4, 4] },
    RESOLVES: { color: 'rgba(57,135,229,.45)', width: 1, length: 80 },
    RESOLVED_BY: { color: 'rgba(63,166,107,.6)', width: 1.6, length: 70 },
    REPAIRS: { color: 'rgba(57,135,229,.3)', width: 1, length: 90 },
    APPLIED: { color: 'rgba(57,135,229,.35)', width: 1, length: 90 },
    REPORTED_BY: { color: 'rgba(138,143,150,.22)', width: 1, length: 110 },
    other: { color: 'rgba(140,150,160,.22)', width: 1, length: 100 },
  };
  // A machine with many reports gets a wider ring (and sits further out from its site) so its
  // reports and their names don't pile on top of each other.
  const busy = (assetId) => Math.min(30, data.reportCount.get(assetId) || 0);
  function styleEdge(e) {
    const s = EDGE[e.type] || EDGE.other;
    const length = e.type === 'ABOUT' ? 60 + 7 * busy(e.to) : e.type === 'LOCATED_AT' ? 200 + 6 * busy(e.from) : s.length;
    return { id: e.id, from: e.from, to: e.to, ct: e, width: s.width, length, dashes: s.dashes || false, baseColor: s.color, color: { color: s.color, highlight: '#ffcd11', hover: '#ffcd11', inherit: false }, selectionWidth: 1.5, hoverWidth: 0.5 };
  }

  /* ------------------------------ starting layout ------------------------------ */
  // Job sites sit at fixed anchors so the map never drifts; machines ring their site, reports
  // ring their machine, and what reports mention starts between the reports that mention it.
  function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function seedPositions(v) {
    const r = rng(7); const pos = {};
    const sites = v.nodes.filter((n) => n.type === 'site');
    // Sites on an ellipse shaped like the screen: wide on a laptop, tall on a phone.
    const R = sites.length > 1 ? 900 : 0;
    const el = $('netCanvas'); const aspect = el.clientWidth && el.clientHeight ? el.clientWidth / el.clientHeight : 1.6;
    const rx = aspect < 0.85 ? R * 0.6 : R; const ry = aspect < 0.85 ? R * 1.3 : R;
    sites.forEach((s, i) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / sites.length; SITE_POS[s.id] = { x: Math.round(Math.cos(a) * rx), y: Math.round(Math.sin(a) * ry) }; pos[s.id] = SITE_POS[s.id]; });
    const ring = (center, items, radius) => items.forEach((n, i) => { const a = (i * 2 * Math.PI) / Math.max(1, items.length) + r() * 0.4; pos[n.id] = { x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius }; });
    for (const s of sites) ring(SITE_POS[s.id], v.nodes.filter((n) => n.type === 'asset' && n.site_id === s.site_id), 260);
    for (const a of v.nodes.filter((n) => n.type === 'asset')) ring(pos[a.id] || { x: 0, y: 0 }, v.nodes.filter((n) => n.type === 'report' && n.asset_id === a.asset_id), 60 + 7 * busy(a.id));
    for (const n of v.nodes) {
      if (pos[n.id]) continue;
      const near = [...(data.adj.get(n.id) || [])].map((id) => pos[id]).filter(Boolean);
      const c = near.length ? { x: near.reduce((s, p) => s + p.x, 0) / near.length, y: near.reduce((s, p) => s + p.y, 0) / near.length } : { x: 0, y: 0 };
      pos[n.id] = { x: c.x + (r() - 0.5) * 80, y: c.y + (r() - 0.5) * 80 };
    }
    return pos;
  }
  function anchorFor(n) {
    const at = (id) => { if (!id) return null; const p = network?.getPositions([id])[id]; if (p) return p; const d = nodes.get(id); return d && d.x != null ? { x: d.x, y: d.y } : null; };
    const jitter = (p, d) => (p ? { x: p.x + (Math.random() - 0.5) * d, y: p.y + (Math.random() - 0.5) * d } : { x: (Math.random() - 0.5) * 200, y: (Math.random() - 0.5) * 200 });
    if (n.type === 'report') return jitter(at(assetNode(n.asset_id)), 80);
    if (n.type === 'asset') return jitter(at(data.siteNode.get(n.site_id)), 200);
    const near = [...(data.adj.get(n.id) || [])].map(at).filter(Boolean);
    return jitter(near[0], 60);
  }

  /* ------------------------------ filters ------------------------------ */
  const saved = store.get('mapFilters', {}) || {};
  const qs = new URLSearchParams(location.search);
  const pick = (list, keys) => new Set((Array.isArray(list) ? list : keys).filter((k) => keys.includes(k)));
  const daysParam = Number(qs.get('days') ?? saved.days ?? 0);
  const f = {
    site: qs.has('site') ? qs.get('site') : saved.site || '',
    days: [0, 7, 30, 90].includes(daysParam) ? daysParam : 0,
    urgency: pick(saved.urgency, Object.keys(URGENCY)),
    issues: pick(saved.issues, Object.keys(ISSUES)),
    openOnly: Boolean(saved.openOnly),
    layers: pick(saved.layers ?? Object.keys(LAYERS).filter((k) => LAYERS[k].on), Object.keys(LAYERS)),
  };
  let follow = store.get('mapFollow', true);
  function saveFilters() {
    store.set('mapFilters', { site: f.site, days: f.days, urgency: [...f.urgency], issues: [...f.issues], openOnly: f.openOnly, layers: [...f.layers] });
    const u = new URL(location.href);
    if (f.site) u.searchParams.set('site', f.site); else u.searchParams.delete('site');
    if (f.days) u.searchParams.set('days', String(f.days)); else u.searchParams.delete('days');
    u.searchParams.delete('focus');
    history.replaceState(null, '', u);
  }
  function reportMatches(n, except = '') {
    if (f.site && n.site_id !== f.site) return false;
    if (f.days && Date.now() - new Date(n.created_at).getTime() > f.days * DAY) return false;
    if (except !== 'urgency' && !f.urgency.has(n.severity)) return false;
    if (except !== 'issues' && !f.issues.has(n.issue)) return false;
    if (except !== 'open' && f.openOnly && n.status !== 'open') return false;
    return true;
  }
  function computeVisible() {
    const out = new Set();
    const all = data.view.nodes;
    const siteOk = (id) => !f.site || id === f.site;
    for (const n of all) if ((n.type === 'site' || n.type === 'asset') && siteOk(n.site_id)) out.add(n.id);
    const reports = all.filter((n) => n.type === 'report' && reportMatches(n));
    for (const r of reports) out.add(r.id);
    const layerOn = (type) => f.layers.has(LAYER_OF[type]);
    for (const r of reports) {
      for (const id of data.adj.get(r.id) || []) { const n = data.byId.get(id); if (n && LAYER_OF[n.type] && layerOn(n.type)) out.add(id); }
    }
    // Fixes for cases/parts on screen; documents for parts, codes and hazards on screen.
    for (const n of all) {
      if ((n.type !== 'fix' && n.type !== 'document') || out.has(n.id) || !layerOn(n.type)) continue;
      for (const id of data.adj.get(n.id) || []) { if (out.has(id) && ['case', 'component', 'code', 'hazard'].includes(data.byId.get(id)?.type)) { out.add(n.id); break; } }
    }
    return { set: out, reports };
  }
  // A part, problem or condition mentioned at several sites would drag those sites together, so
  // each one is pulled only towards its "home" report (where it's mentioned most); its other links
  // are still drawn, but carry no force. That keeps every job site a clean cluster while the long
  // lines between sites show the shared problems.
  const CORE = new Set(['site', 'asset', 'report']);
  function assignHomes() {
    const homeOf = new Map();
    for (const id of visible) {
      const n = data.byId.get(id);
      if (!n || CORE.has(n.type)) continue;
      const near = [...(data.adj.get(id) || [])].filter((x) => visible.has(x)).map((x) => data.byId.get(x)).filter(Boolean);
      if (!near.length) continue;
      const reps = near.filter((x) => x.type === 'report');
      if (reps.length) {
        const perSite = {};
        for (const r of reps) perSite[r.site_id] = (perSite[r.site_id] || 0) + 1;
        const site = Object.keys(perSite).sort((a, b) => perSite[b] - perSite[a] || a.localeCompare(b))[0];
        homeOf.set(id, reps.filter((r) => r.site_id === site).sort((a, b) => b.created_at.localeCompare(a.created_at))[0].id);
      } else homeOf.set(id, near[0].id);
    }
    const upd = [];
    edges.forEach((e) => {
      const a = data.byId.get(e.from); const b = data.byId.get(e.to);
      const pulls = (a && b && CORE.has(a.type) && CORE.has(b.type)) || homeOf.get(e.from) === e.to || homeOf.get(e.to) === e.from;
      if (e.physics !== pulls) upd.push({ id: e.id, physics: pulls });
    });
    if (upd.length) edges.update(upd);
  }
  // vis-network's own storePositions() crashes when some nodes are filtered out, so do it here.
  function savePositions() {
    if (!network) return;
    const pos = network.getPositions();
    const upd = [];
    for (const [id, p] of Object.entries(pos)) { const d = nodes.get(id); if (d && !d.fixed) upd.push({ id, x: p.x, y: p.y }); }
    if (upd.length) nodes.update(upd);
  }
  let fitTimer = null;
  function applyFilters({ fit = true } = {}) {
    if (!data.view) return;
    savePositions();
    const { set, reports } = computeVisible();
    visible = set;
    assignHomes();
    nodeView.refresh();
    edgeView.refresh();
    if (focused && !visible.has(focused)) clearFocus(); else if (focused) highlight(focused);
    renderFilters();
    renderSummary(reports);
    renderEmpty(reports);
    renderSearchList();
    renderSiteTags();
    saveFilters();
    if (fit) { clearTimeout(fitTimer); fitTimer = setTimeout(() => fitView(true), 350); }
  }
  function resetFilters() {
    Object.assign(f, { site: '', days: 0, urgency: new Set(Object.keys(URGENCY)), issues: new Set(Object.keys(ISSUES)), openOnly: false });
    applyFilters();
  }

  /* ------------------------------ sidebar ------------------------------ */
  function renderFilters() {
    const reports = reportsOf();
    const count = (except, pred) => reports.filter((r) => reportMatches(r, except) && pred(r)).length;
    $('siteSel').value = f.site;
    $('timeSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.d) === f.days));
    $('openOnly').checked = f.openOnly;
    $('urgency').innerHTML = Object.entries(URGENCY).map(([k, u]) => `<button type="button" class="${f.urgency.has(k) ? '' : 'off'}" data-u="${k}" aria-pressed="${f.urgency.has(k)}"><span class="dot" style="background:${u.color}"></span>${t(u.label)}<span class="n">${count('urgency', (r) => r.severity === k)}</span></button>`).join('');
    $('issues').innerHTML = Object.entries(ISSUES).map(([k, is]) => `<button type="button" class="${f.issues.has(k) ? 'on' : ''}" data-i="${k}" title="${esc(t(is.hint))}" aria-pressed="${f.issues.has(k)}"><span class="box">${f.issues.has(k) ? icon('check') : ''}</span><span class="ic">${icon(is.icon)}</span><span class="lab">${esc(t(is.label))}</span><span class="n">${count('issues', (r) => r.issue === k)}</span></button>`).join('');
    $('layers').innerHTML = Object.entries(LAYERS).map(([k, l]) => `<button type="button" class="${f.layers.has(k) ? 'on' : ''}" data-l="${k}" aria-pressed="${f.layers.has(k)}"><span class="box">${f.layers.has(k) ? icon('check') : ''}</span><span class="lshape"><svg width="20" height="18" viewBox="0 0 20 18" aria-hidden="true">${l.swatch}</svg></span><span class="lab">${esc(t(l.label))}</span></button>`).join('');
  }
  function renderSummary(reports) {
    const open = reports.filter((r) => r.status === 'open').length;
    const machines = data.view.nodes.filter((n) => n.type === 'asset' && visible.has(n.id)).length;
    const cell = (n, one, many) => `<div><div class="v">${n}</div><div class="k">${n === 1 ? one : many}</div></div>`;
    $('sumline').innerHTML = cell(reports.length, t('report'), t('reports')) + cell(open, t('open issue'), t('open issues')) + cell(machines, t('machine'), t('machines'));
  }
  function renderEmpty(reports) {
    const box = $('emptyOver');
    if (reports.length) { box.classList.add('hidden'); return; }
    const anyAtAll = reportsOf().length > 0;
    box.innerHTML = `<div class="panel panel-pad" style="max-width:360px">${anyAtAll
      ? emptyState({ icon: 'filter', title: t('No reports match these filters'), body: t('Job sites and machines are still shown. Widen the time range or turn some urgencies and issue types back on.'), action: `<button class="btn sm primary" id="emptyReset">${t('Reset filters')}</button>` })
      : emptyState({ icon: 'mic', title: t('Nothing reported yet'), body: t('Send a report from the operator screen and it appears here, on its machine.'), action: `<a href="/operator">${t('Open the operator screen')}</a>` })}</div>`;
    box.classList.remove('hidden');
    $('emptyReset')?.addEventListener('click', resetFilters);
  }
  function renderKey() {
    $('key').innerHTML = `${Object.values(URGENCY).map((u) => `<span class="sw"><i style="background:${u.color}"></i>${t(u.label)}</span>`).join('')}<span class="sw"><i style="background:${SOLVED.color}">${icon('check')}</i>${t(SOLVED.label)}</span><span class="sw faded"><i style="background:#8a8f96"></i>${t('faded = repair or withdrawn')}</span><span class="muted">${t('icon = type of issue · zoom in for names')}</span>`;
  }
  function renderSearchList() {
    const order = ['site', 'asset', 'component', 'symptom', 'code', 'condition', 'hazard', 'case'];
    const seen = new Set(); const opts = [];
    for (const ty of order) {
      for (const n of data.view.nodes) {
        if (n.type !== ty) continue;
        const label = n.type === 'asset' ? `${n.label} · ${n.model}` : n.type === 'case' ? `${t('Case #{id}', { id: n.case_id })} · ${n.title || n.label}` : nodeName(n);
        if (seen.has(label)) continue;
        seen.add(label); opts.push(label);
      }
    }
    $('nodeList').innerHTML = opts.map((o) => `<option value="${esc(o)}"></option>`).join('');
  }

  $('siteSel').onchange = () => { f.site = $('siteSel').value; applyFilters(); };
  $('timeSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-d]'); if (!b) return; f.days = Number(b.dataset.d); applyFilters(); });
  $('openOnly').onchange = () => { f.openOnly = $('openOnly').checked; applyFilters(); };
  $('urgency').addEventListener('click', (e) => { const b = e.target.closest('[data-u]'); if (!b) return; const k = b.dataset.u; if (f.urgency.has(k)) f.urgency.delete(k); else f.urgency.add(k); applyFilters(); });
  $('issues').addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (!b) return; const k = b.dataset.i; if (f.issues.has(k)) f.issues.delete(k); else f.issues.add(k); applyFilters(); });
  $('layers').addEventListener('click', (e) => { const b = e.target.closest('[data-l]'); if (!b) return; const k = b.dataset.l; if (f.layers.has(k)) f.layers.delete(k); else f.layers.add(k); applyFilters({ fit: false }); });
  $('resetBtn').onclick = resetFilters;
  $('sideBtn').onclick = () => document.body.classList.toggle('side-open');
  $('backdrop').onclick = () => document.body.classList.remove('side-open');
  $('follow').checked = follow;
  $('follow').onchange = () => { follow = $('follow').checked; store.set('mapFollow', follow); };

  /* ------------------------------ fit, zoom and pan limits ------------------------------ */
  function bounds() {
    if (!network) return null;
    const pos = Object.values(network.getPositions());
    if (!pos.length) return null;
    const xs = pos.map((p) => p.x); const ys = pos.map((p) => p.y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }
  // Never let the map zoom out much past "everything fits" (the old view could shrink to a dot).
  function minScale() {
    const b = bounds(); const el = $('netCanvas');
    if (!b || !el.clientWidth) return 0.1;
    const fitScale = Math.min(el.clientWidth / (b.maxX - b.minX + 360), el.clientHeight / (b.maxY - b.minY + 360));
    return Math.max(0.05, Math.min(0.9, fitScale * 0.8));
  }
  const clampScale = (s) => Math.min(MAX_SCALE, Math.max(minScale(), s));
  // Fit everything visible, with a margin so the site name tags at the edges aren't cut off.
  function fitView(animate = true) {
    if (!network) return;
    const ids = [...visible].filter((id) => nodes.get(id));
    if (!ids.length) return;
    const before = { position: network.getViewPosition(), scale: network.getScale() };
    network.fit({ nodes: ids, minZoomLevel: 0.05, maxZoomLevel: 1.25, animation: false });
    // Leave room for the toolbar on top and the colour key at the bottom.
    const box = $('net').getBoundingClientRect();
    const top = Math.max(0, document.querySelector('.toolbar').getBoundingClientRect().bottom - box.top + 6);
    const bottom = Math.max(0, box.bottom - $('key').getBoundingClientRect().top + 6);
    const room = Math.max(0.4, (box.height - top - bottom) / box.height);
    const scale = network.getScale() * 0.88 * room;
    const fitted = network.getViewPosition();
    const target = { position: { x: fitted.x, y: fitted.y - (top - bottom) / 2 / scale }, scale };
    if (!animate) { network.moveTo(target); return; }
    network.moveTo(before);
    network.moveTo({ ...target, animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
  }
  // Keep the centre of the view over the map, so dragging can't lose it in empty space.
  function clampView() {
    const b = bounds(); if (!b) return;
    const v = network.getViewPosition();
    const x = Math.min(b.maxX, Math.max(b.minX, v.x)); const y = Math.min(b.maxY, Math.max(b.minY, v.y));
    if (Math.abs(x - v.x) > 1 || Math.abs(y - v.y) > 1) network.moveTo({ position: { x, y }, animation: { duration: 300, easingFunction: 'easeOutQuad' } });
  }
  const zoomBy = (k) => network && network.moveTo({ scale: clampScale(network.getScale() * k), animation: { duration: 220, easingFunction: 'easeOutQuad' } });
  $('zoomIn').onclick = () => zoomBy(1.35);
  $('zoomOut').onclick = () => zoomBy(1 / 1.35);
  $('fitBtn').onclick = () => fitView(true);

  /* ------------------------------ network ------------------------------ */
  function createNetwork() {
    network = new vis.Network($('netCanvas'), { nodes: nodeView, edges: edgeView }, {
      autoResize: true,
      layout: { improvedLayout: false, randomSeed: 7 },
      interaction: { hover: true, tooltipDelay: 140, zoomSpeed: 0.6, keyboard: false, navigationButtons: false, multiselect: false },
      physics: {
        // Short-range repulsion (nodes only push apart when close) and no central gravity: job sites
        // are fixed anchors, so clusters stay compact and never drift off or tangle together.
        solver: 'repulsion',
        repulsion: { nodeDistance: 120, centralGravity: 0, springLength: 70, springConstant: 0.05, damping: 0.14 },
        maxVelocity: 40, minVelocity: 0.75, timestep: 0.5,
        stabilization: { enabled: true, iterations: 450, updateInterval: 50, fit: false },
      },
      nodes: { borderWidthSelected: 4, scaling: { label: { enabled: false, drawThreshold: 7, maxVisible: 28 } } },
      edges: { smooth: false },
    });
    network.on('zoom', () => {
      const s = network.getScale(); const lo = minScale();
      if (s < lo) network.moveTo({ scale: lo }); else if (s > MAX_SCALE) network.moveTo({ scale: MAX_SCALE });
    });
    network.on('dragEnd', (p) => { if (!p.nodes.length) clampView(); });
    network.on('click', (p) => { if (p.nodes.length) select(p.nodes[0]); else if (!p.edges.length) clearFocus(); });
    network.on('doubleClick', (p) => { if (p.nodes.length) centreOn(p.nodes[0], 1.1); });
    network.on('afterDrawing', placeSiteTags);
    network.on('hoverNode', () => { $('netCanvas').style.cursor = 'pointer'; });
    network.on('blurNode', () => { $('netCanvas').style.cursor = ''; });
    return new Promise((resolve) => network.once('stabilizationIterationsDone', () => { $('loading').classList.add('hidden'); fitView(false); resolve(); }));
  }

  /* ------------------------------ job-site name tags ------------------------------ */
  // Canvas labels shrink with the zoom; site names are HTML tags pinned under each site instead.
  const siteTags = new Map();
  function renderSiteTags() {
    for (const [siteId, id] of data.siteNode) {
      let el = siteTags.get(id);
      if (!el) {
        el = document.createElement('button');
        el.type = 'button'; el.className = 'site-tag';
        el.onclick = () => { select(id); centreOn(id, 0.6, true); };
        $('siteTags').appendChild(el);
        siteTags.set(id, el);
      }
      const open = reportsOf().filter((r) => r.site_id === siteId && visible.has(r.id) && r.status === 'open').length;
      el.innerHTML = `${esc(siteName(siteId))}${open ? `<span class="n">${t('{n} open', { n: open })}</span>` : ''}`;
      el.hidden = !visible.has(id);
      if (!network) el.style.visibility = 'hidden';
    }
    placeSiteTags();
  }
  // Centre each tag under its site, but keep it on screen and off the other tags.
  function placeSiteTags() {
    if (!network) return;
    const scale = network.getScale();
    const W = $('siteTags').clientWidth;
    const placed = [];
    const list = [...siteTags].filter(([, el]) => !el.hidden).map(([id, el]) => ({ id, el, pos: network.getPositions([id])[id] })).filter((t) => t.pos)
      .map((t) => ({ ...t, p: network.canvasToDOM(t.pos) })).sort((a, b) => a.p.y - b.p.y);
    for (const t of list) {
      const w = t.el.offsetWidth; const h = t.el.offsetHeight;
      let x = Math.min(Math.max(6, t.p.x - w / 2), Math.max(6, W - w - 6));
      let y = t.p.y + 32 * scale + 6;
      for (const o of placed) if (x < o.x + o.w + 4 && o.x < x + w + 4 && y < o.y + o.h + 4 && o.y < y + h + 4) y = o.y + o.h + 4;
      placed.push({ x, y, w, h });
      t.el.style.visibility = '';
      t.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }
  }

  /* ------------------------------ focus: dim everything unrelated ------------------------------ */
  let focused = null;
  function neighbourhood(id) {
    const n = data.byId.get(id);
    const keep = new Set([id, ...(data.adj.get(id) || [])]);
    const add = (ids) => { for (const x of ids || []) keep.add(x); };
    if (n?.type === 'site') for (const m of [...keep]) if (data.byId.get(m)?.type === 'asset') add(data.adj.get(m));
    if (n && n.type !== 'site' && n.type !== 'report') for (const r of [...keep]) if (data.byId.get(r)?.type === 'report') add(data.adj.get(r));
    for (const m of [...keep]) { const x = data.byId.get(m); if (x?.type === 'asset') keep.add(data.siteNode.get(x.site_id)); }
    return keep;
  }
  function highlight(id) {
    focused = id;
    const keep = neighbourhood(id);
    const nu = []; const eu = [];
    for (const vid of visible) {
      const d = nodes.get(vid); if (!d) continue;
      const on = keep.has(vid);
      const font = styleNode(d.ct).font; // job sites have no canvas label (their name is an HTML tag)
      nu.push({ id: vid, opacity: on ? baseOpacity(d.ct) : 0.1, ...(font ? { font: { ...font, color: on ? font.color : 'rgba(150,150,150,.12)' } } : {}) });
    }
    edges.forEach((e) => { const on = keep.has(e.from) && keep.has(e.to); eu.push({ id: e.id, color: { ...e.color, color: on ? e.baseColor : 'rgba(120,120,120,.05)' } }); });
    nodes.update(nu); edges.update(eu);
  }
  function clearFocus() {
    const wasOpen = !$('drawer').classList.contains('hidden');
    $('drawer').classList.add('hidden');
    if (focused == null && !wasOpen) return;
    focused = null;
    const nu = []; const eu = [];
    nodes.forEach((d) => { const font = styleNode(d.ct).font; nu.push({ id: d.id, opacity: baseOpacity(d.ct), ...(font ? { font } : {}) }); });
    edges.forEach((e) => eu.push({ id: e.id, color: { ...e.color, color: e.baseColor } }));
    nodes.update(nu); edges.update(eu);
    network?.unselectAll();
  }
  function select(id) {
    highlight(id);
    network.selectNodes([id]);
    showDrawer(id);
  }
  // Show a node, widening the filters if they hide it.
  function reveal(n) {
    let changed = false;
    const widen = (cond, fn) => { if (cond) { fn(); changed = true; } };
    if (n.type === 'report') {
      widen(f.site && n.site_id !== f.site, () => { f.site = ''; });
      widen(f.days && Date.now() - new Date(n.created_at).getTime() > f.days * DAY, () => { f.days = 0; });
      widen(!f.urgency.has(n.severity), () => f.urgency.add(n.severity));
      widen(!f.issues.has(n.issue), () => f.issues.add(n.issue));
      widen(f.openOnly && n.status !== 'open', () => { f.openOnly = false; });
    } else if (n.type === 'site' || n.type === 'asset') {
      widen(f.site && n.site_id !== f.site, () => { f.site = ''; });
    } else {
      widen(LAYER_OF[n.type] && !f.layers.has(LAYER_OF[n.type]), () => f.layers.add(LAYER_OF[n.type]));
    }
    if (changed) applyFilters({ fit: false });
    if (!visible.has(n.id) && !['report', 'site', 'asset'].includes(n.type)) {
      Object.assign(f, { site: '', days: 0, urgency: new Set(Object.keys(URGENCY)), issues: new Set(Object.keys(ISSUES)), openOnly: false });
      applyFilters({ fit: false });
      changed = true;
    }
    if (changed) toast(t('Filters widened so it shows on the map.'));
    return changed;
  }
  // Centre on a node; with the details panel open, centre it in the part of the map still showing.
  function centreOn(id, minScale = 1, withDrawer = !$('drawer').classList.contains('hidden')) {
    const d = $('drawer'); const wide = window.innerWidth > 860;
    const offset = !withDrawer ? { x: 0, y: 0 } : wide ? { x: -Math.round((d.offsetWidth || 380) / 2 + 6), y: 0 } : { x: 0, y: -Math.round((d.offsetHeight || window.innerHeight * 0.6) / 2) };
    network.focus(id, { scale: clampScale(Math.max(minScale, network.getScale())), offset, animation: { duration: 550, easingFunction: 'easeInOutQuad' } });
  }
  function focusNode(id, { drawer = true, delay = 0 } = {}) {
    const n = data.byId.get(id); if (!n || !network) return;
    const widened = reveal(n);
    document.body.classList.remove('side-open');
    setTimeout(() => {
      if (!visible.has(id)) return;
      if (drawer) select(id); else highlight(id);
      centreOn(id, 1, drawer || !$('drawer').classList.contains('hidden'));
    }, Math.max(delay, widened ? 450 : 0));
  }

  /* ------------------------------ details drawer ------------------------------ */
  const urgencyDot = (r) => `<i style="background:${isSolved(r) ? SOLVED.color : (URGENCY[r.severity] || URGENCY.low).color};opacity:${baseOpacity(r)}"></i>`;
  const reportRows = (list) => list.map((r) => `<button class="rl" data-go="${esc(r.id)}">${urgencyDot(r)}<span>${esc(r.label)}</span><span class="w">${esc(r.asset_id)} · ${esc(ago(r.created_at))}</span></button>`).join('');
  const SEV_ORDER = Object.keys(URGENCY);
  const byUrgency = (a, b) => (b.status === 'open') - (a.status === 'open') || SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) || b.created_at.localeCompare(a.created_at);
  const linkedReports = (id) => [...(data.adj.get(id) || [])].map((x) => data.byId.get(x)).filter((x) => x?.type === 'report' && visible.has(x.id));
  const none = (what) => `<div class="muted" style="font-size:14px">${what}</div>`;

  function showDrawer(id) {
    const n = data.byId.get(id); if (!n) return;
    let html = '';
    const close = `<button class="btn sm ghost" id="closeDrawer" aria-label="${esc(t('Close details'))}">${icon('x')}</button>`;
    if (n.type === 'report') {
      const u = URGENCY[n.severity] || URGENCY.low; const is = ISSUES[n.issue] || ISSUES.note;
      const solved = isSolved(n);
      const mentions = [...(data.adj.get(id) || [])].map((x) => data.byId.get(x)).filter((x) => x && !['asset', 'report'].includes(x.type));
      const fixNode = mentions.find((m) => m.type === 'fix');
      html = `<div class="hd"><span class="ty">${badge(solved ? 'check' : is.icon, solved ? SOLVED.color : u.color)}${solved ? `${t(SOLVED.label)} · ` : ''}${esc(t(is.label))}</span>${close}</div>
        <h2>${esc(n.label)}</h2>
        ${keyFacts([
          [t('Machine'), `<button class="linkish" data-go="${esc(assetNode(n.asset_id))}">${esc(n.asset_id)}</button>`],
          [t('Location'), esc(siteName(n.site_id))],
          [solved ? t('Was') : t('Urgency'), sevPill(n.severity)],
          [t('Status'), esc(t(REPORT_STATUS[n.status] || n.status))],
          [t('When'), `<span title="${esc(dateTime(n.created_at))}">${esc(ago(n.created_at))}</span>`],
          [t('Reported by'), esc(n.person_name || t(SOURCE_LABEL[n.source] || n.source))],
          [t('Solved'), solved && n.solved_at ? `<span title="${esc(dateTime(n.solved_at))}">${esc(ago(n.solved_at))}</span>` : ''],
        ])}
        ${solved ? `<div class="solved-by">${icon('check')}<div><b>${t('Solved by')}</b><div>${esc(n.resolution || n.fix_title || t('Closed without a repair note'))}</div>${fixNode ? `<button class="chip" data-go="${esc(fixNode.id)}" style="margin-top:6px"><span class="k">${t('known fix')}</span>${esc(fixNode.label)}</button>` : ''}</div></div>` : ''}
        <div style="margin-top:12px">
          ${dropdown(t('What was said'), `<q class="said">${esc(n.raw_text)}</q>`)}
          ${dropdown(t('Details'), kv([[t('Summary'), esc(n.summary)], [t('Fault code'), esc(n.codes.join(', '))], [t('Conditions'), esc(n.conditions.map((c) => t(c)).join(', '))], [t('Hazards'), esc(n.hazards.map((h) => t(h)).join(', '))], [t('What to do'), esc(n.guidance)]]))}
          ${mentions.length ? dropdown(t('Connected on the map'), `<div class="chips">${mentions.map((m) => `<button class="chip" data-go="${esc(m.id)}"><span class="k">${esc(t((ENTITY[m.type] || {}).label || m.type))}</span>${esc(m.type === 'case' ? `#${m.case_id}` : nodeName(m))}</button>`).join('')}</div>`, { count: mentions.length }) : ''}
        </div>
        <div class="btns"><a class="btn sm primary" href="/asset?id=${encodeURIComponent(n.asset_id)}">${t('Machine history')} ${icon('arrow')}</a><a class="btn sm" href="/reports?asset=${encodeURIComponent(n.asset_id)}">${t('Report log')}</a></div>`;
    } else if (n.type === 'asset') {
      const reps = linkedReports(id).sort(byUrgency);
      html = `<div class="hd"><span class="ty">${badge(FAMILY_ICON[n.family] || 'excavator', '#ffcd11')}${t('Machine')}</span>${close}</div>
        <h2>${esc(n.label)} <span class="muted" style="font-weight:600">${esc(n.model)}</span></h2>
        ${keyFacts([[t('Location'), esc(siteName(n.site_id))], [t('Status'), statusPill(n.status)], [t('Health'), `${n.health}/100`], [t('Open issues'), String(n.open_alerts)], [t('Hours'), n.hours.toLocaleString(CT.locale)], [t('Operator'), esc(n.operator_name || '—')]])}
        <div style="margin-top:12px">${dropdown(t('Reports on the map'), reps.length ? reportRows(reps) : none(t('None with the current filters.')), { count: reps.length, open: true })}</div>
        <div class="btns"><a class="btn sm primary" href="/asset?id=${encodeURIComponent(n.asset_id)}">${t('Full history')} ${icon('arrow')}</a><a class="btn sm" href="/operator?unit=${encodeURIComponent(n.asset_id)}">${t('Report on it')}</a></div>`;
    } else if (n.type === 'site') {
      const machines = [...(data.adj.get(id) || [])].filter((x) => data.byId.get(x)?.type === 'asset');
      const reps = machines.flatMap((m) => linkedReports(m));
      const open = reps.filter((r) => r.status === 'open').sort(byUrgency);
      html = `<div class="hd"><span class="ty">${badge('pin', '#ffcd11')}${t('Job site')}</span>${close}</div>
        <h2>${esc(n.label)}</h2>
        ${keyFacts([[t('Location'), esc(n.location || '')], [t('Climate'), esc(n.climate || '')], [t('Machines'), String(machines.length)], [t('Reports'), String(reps.length)], [t('Open issues'), String(open.length)]])}
        <div style="margin-top:12px">${dropdown(t('Open issues here'), open.length ? reportRows(open) : none(t('Nothing open with the current filters.')), { count: open.length, open: true })}</div>
        <div class="btns">${f.site === n.site_id ? `<button class="btn sm" id="allSites">${t('Show all job sites')}</button>` : `<button class="btn sm primary" id="onlySite">${t('Show only this site')}</button>`}<a class="btn sm" href="/?site=${encodeURIComponent(n.site_id)}">${t('Dashboard')}</a></div>`;
    } else {
      const ent = ENTITY[n.type] || { label: n.type };
      const reps = linkedReports(id).sort(byUrgency);
      const machines = new Set(reps.map((r) => r.asset_id)); const sites = new Set(reps.map((r) => r.site_id));
      html = `<div class="hd"><span class="ty">${esc(t(ent.label))}</span>${close}</div>
        <h2>${esc(n.type === 'case' ? (n.title || n.label) : nodeName(n))}</h2>
        ${keyFacts([[t('Reports'), String(reps.length)], [t('Machines'), String(machines.size)], [t('Job sites'), String(sites.size)], ...(n.type === 'case' ? [[t('Priority'), esc(t(n.priority || ''))], [t('Case status'), esc(t((n.case_status || '').replace(/_/g, ' ')))]] : []), ...(n.meaning ? [[t('Means'), esc(n.meaning)]] : [])])}
        <div style="margin-top:12px">${dropdown(t('Reports that mention it'), reps.length ? reportRows(reps) : none(t('None with the current filters.')), { count: reps.length, open: true })}</div>
        <div class="btns">${n.type === 'case' && n.case_id ? `<a class="btn sm primary" href="/engineering?case=${n.case_id}">${t('Open the case')} ${icon('arrow')}</a>` : ''}${n.doc_id ? `<a class="btn sm primary" href="/library?doc=${n.doc_id}">${t('Open the document')} ${icon('arrow')}</a>` : ''}</div>`;
    }
    const d = $('drawer');
    d.innerHTML = html;
    d.classList.remove('hidden');
    $('closeDrawer').onclick = clearFocus;
    d.querySelectorAll('[data-go]').forEach((el) => el.onclick = () => focusNode(el.dataset.go));
    $('onlySite')?.addEventListener('click', () => { f.site = n.site_id; applyFilters(); });
    $('allSites')?.addEventListener('click', () => { f.site = ''; applyFilters(); });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { clearFocus(); document.body.classList.remove('side-open'); } });

  /* ------------------------------ search ------------------------------ */
  function find(q) {
    const s = q.trim().toLowerCase(); if (!s) return null;
    const norm = (x) => String(x || '').toLowerCase();
    const label = (n) => (n.type === 'asset' ? `${n.label} · ${n.model}` : n.type === 'case' ? `${t('Case #{id}', { id: n.case_id })} · ${n.title || n.label}` : nodeName(n));
    const flat = (x) => norm(x).replace(/[^a-z0-9]/g, '');
    const all = data.view.nodes.filter((n) => n.type !== 'report');
    return all.find((n) => norm(label(n)) === s) || all.find((n) => norm(n.label) === s)
      || all.find((n) => flat(n.label) === flat(s)) || all.find((n) => norm(label(n)).includes(s))
      || reportsOf().find((n) => norm(n.label).includes(s) || norm(n.raw_text).includes(s)) || null;
  }
  let lastSearch = '';
  function runSearch() {
    const value = $('search').value;
    if (!value.trim() || value === lastSearch) return;
    lastSearch = value;
    setTimeout(() => { lastSearch = ''; }, 600);
    const hit = find(value);
    if (hit) { focusNode(hit.id); $('search').blur(); } else toast(t('Nothing on the map matches that.'));
  }
  $('search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } });
  $('search').addEventListener('change', runSearch);

  /* ------------------------------ coming in: live processing ------------------------------ */
  const feed = [];
  const DID_TAG = { resolved: 'closed an issue', updated: 'updated an open issue', retracted: 'withdrew a report', help: 'help requested', learned: 'fix learned' };
  function outcomeTags(e) {
    const o = e.outcome || {};
    return [
      e.issue ? t((ISSUES[e.issue] || ISSUES.note).label) : '',
      o.newFacts ? (o.newFacts === 1 ? t('+1 new fact') : t('+{n} new facts', { n: o.newFacts })) : o.newLinks ? t('+{n} links', { n: o.newLinks }) : '',
      o.told ? t('{n} alerted', { n: o.told }) : '',
      o.caseId ? t('case #{id}', { id: o.caseId }) : '',
      ...(o.did || []).map((k) => DID_TAG[k] && t(DID_TAG[k])).filter(Boolean),
      e.intent === 'question' ? t('answered') : '',
    ].filter(Boolean);
  }
  function entryView(e) {
    if (e.state === 'pending') return { badge: '<span class="badge pending"></span>', t: `${e.asset_id} · ${e.person_name || t(SOURCE_LABEL[e.source] || 'new report')}`, m: t('Received. Working out what it is…'), tags: [] };
    if (e.state === 'failed') return { badge: badge('alert', URGENCY.critical.color), t: t('{id} · couldn’t process', { id: e.asset_id || t('Report') }), m: e.error || t('Unknown error'), tags: [] };
    if (e.state === 'handled') return { badge: badge('x', '#8a8f96'), t: e.deleted?.length ? (e.deleted.length === 1 ? t('Deleted 1 report') : t('Deleted {n} reports', { n: e.deleted.length })) : e.asking ? t('Asked which report to delete') : t('Delete request'), m: `${e.asset_id} · ${ago(e.at)}`, tags: [] };
    const r = e.report; const u = URGENCY[r.severity] || URGENCY.low;
    return { badge: badge((ISSUES[e.issue] || ISSUES.note).icon, u.color), t: r.label || problemOf(r).title, m: `${r.asset_id} · ${siteName(r.site_id)} · ${ago(r.created_at)}`, tags: outcomeTags(e) };
  }
  function renderFeed() {
    $('feed').innerHTML = feed.slice(0, 6).map((e, i) => {
      const v = entryView(e);
      return `<button type="button" class="fe ${e.fresh ? 'fresh' : ''}" data-i="${i}">${v.badge}<span style="min-width:0"><span class="t" style="display:block">${esc(v.t)}</span><span class="m" style="display:block">${esc(v.m)}</span>${v.tags.length ? `<span class="tags">${v.tags.map((t) => `<span>${esc(t)}</span>`).join('')}</span>` : ''}</span></button>`;
    }).join('') || `<div class="muted" style="font-size:13px">${t('New reports show up here the moment they arrive.')}</div>`;
    for (const e of feed) e.fresh = false;
  }
  $('feed').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-i]'); if (!b) return;
    const e = feed[Number(b.dataset.i)];
    if (e?.node) focusNode(e.node);
    else if (e?.asset_id) focusNode(assetNode(e.asset_id));
  });
  let bannerTimer = null;
  function showBanner(e) {
    const v = entryView(e);
    const el = $('banner');
    el.innerHTML = `${v.badge}<span><b>${esc(v.t)}</b><span class="muted"> · ${esc(e.state === 'done' ? v.tags.slice(0, 3).join(' · ') || v.m : v.m)}</span></span>`;
    el.classList.remove('hidden');
    el.onclick = () => { el.classList.add('hidden'); if (e.node) focusNode(e.node); };
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => el.classList.add('hidden'), e.state === 'pending' ? 20000 : 7000);
  }
  function upsertEntry(rid, patch) {
    let e = rid ? feed.find((x) => x.rid === rid) : null;
    if (!e) { e = { rid }; feed.unshift(e); }
    Object.assign(e, patch, { fresh: true });
    clearTimeout(e.timer);
    if (e.state === 'pending') e.timer = setTimeout(() => { if (e.state === 'pending') { Object.assign(e, { state: 'failed', error: t('No result from the server') }); renderFeed(); } }, 60000);
    if (feed.length > 20) feed.length = 20;
    renderFeed();
    showBanner(e);
    if (pane !== 'live') $('liveDot').classList.remove('hidden');
  }
  function seedFeed() {
    for (const r of reportsOf().slice(0, 4)) feed.push({ state: 'done', report: r, node: r.id, issue: r.issue });
    renderFeed();
  }

  /* ------------------------------ live updates ------------------------------ */
  const arriving = new Set();
  let reloadTimer = null; let reloading = false; let again = false;
  const scheduleReload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(reload, 350); };
  async function reload() {
    if (!data.view || !network) return;
    if (reloading) { again = true; return; }
    reloading = true;
    try { merge(await api('/api/graph/view')); } catch (err) { console.warn('[map] refresh failed; keeping the current map', err); }
    reloading = false;
    if (again) { again = false; scheduleReload(); }
  }
  function merge(v) {
    savePositions();
    const before = new Set(nodes.getIds());
    ingest(v);
    const incoming = new Set(v.nodes.map((n) => n.id));
    nodes.remove([...before].filter((id) => !incoming.has(id)));
    const adds = []; const upd = [];
    for (const n of v.nodes) { if (before.has(n.id)) upd.push(styleNode(n)); else adds.push({ ...styleNode(n), ...(n.type === 'site' ? {} : anchorFor(n)) }); }
    if (upd.length) nodes.update(upd);
    if (adds.length) nodes.add(adds);
    const eIn = new Set(v.edges.map((e) => e.id));
    edges.remove(edges.getIds().filter((id) => !eIn.has(id)));
    edges.update(v.edges.map(styleEdge));
    applyFilters({ fit: false });
    for (const id of [...arriving]) {
      if (!data.byId.has(id)) continue;
      arriving.delete(id);
      if (!visible.has(id)) continue;
      pulse(id);
      if (!follow) continue;
      // Give the layout a moment to place the new report before moving the camera to it.
      if ($('drawer').classList.contains('hidden')) focusNode(id, { delay: 700 });
      else setTimeout(() => { if (visible.has(id)) centreOn(id, 0.9); }, 700);
    }
  }
  function pulse(id) {
    const d = nodes.get(id); if (!d) return;
    nodes.update({ id, size: d.size * 1.7, borderWidth: 6, color: { ...d.color, border: '#ffffff' } });
    setTimeout(() => {
      const now = data.byId.get(id);
      if (!now || !nodes.get(id)) return;
      const s = styleNode(now);
      nodes.update({ id, size: s.size, borderWidth: s.borderWidth, color: s.color });
      if (focused) highlight(focused);
    }, 2400);
  }

  connectStream({
    'report-received': (e) => upsertEntry(e.rid, { state: 'pending', asset_id: e.asset_id, site_id: e.site_id, person_name: e.person_name, source: e.source, at: e.at }),
    report: (e) => {
      const node = `report:${e.report.id}`;
      upsertEntry(e.rid, { state: 'done', report: e.report, node, issue: e.issue, intent: e.intent, outcome: e.outcome });
      arriving.add(node);
      scheduleReload();
    },
    'report-handled': (e) => { upsertEntry(e.rid, { state: 'handled', asset_id: e.asset_id, deleted: e.deleted, asking: e.asking, at: new Date().toISOString() }); scheduleReload(); },
    'report-failed': (e) => upsertEntry(e.rid, { state: 'failed', error: e.error }),
    'report-updated': scheduleReload, 'report-deleted': scheduleReload, 'report-restored': scheduleReload,
    alert: scheduleReload, 'alert-updated': scheduleReload, case: scheduleReload, 'case-removed': scheduleReload,
    graph: scheduleReload, 'graph-removed': scheduleReload, asset: scheduleReload,
    hello: () => { if (data.view) scheduleReload(); },
  }, $('live'));

  /* ------------------------------ boot ------------------------------ */
  async function boot() {
    const v = await api('/api/graph/view');
    ingest(v);
    $('siteSel').innerHTML = `<option value="">${t('All job sites')}</option>${v.sites.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}`;
    if (f.site && !v.sites.some((s) => s.id === f.site)) f.site = '';
    const pos = seedPositions(v);
    nodes.add(v.nodes.map((n) => ({ ...styleNode(n), ...(n.type === 'site' ? {} : pos[n.id]) })));
    edges.add(v.edges.map(styleEdge));
    renderKey();
    applyFilters({ fit: false });
    seedFeed();
    await createNetwork();
    const focus = qs.get('focus');
    if (focus && data.byId.has(focus)) setTimeout(() => focusNode(focus), 300);
  }
  boot().catch((err) => {
    // A server started before the site map existed answers "Not found" for its data.
    const stale = /not found/i.test(err.message);
    $('loading').innerHTML = emptyState({
      icon: 'wifiOff', error: true, title: t('Couldn’t load the map'),
      body: stale ? t('The server is running an older version of Cat Track that doesn’t have the site map yet. Restart it (Ctrl-C, then <code>npm run demo</code>) and reload this page.') : esc(err.message),
    });
    $('loading').style.pointerEvents = 'auto';
  });
})();
