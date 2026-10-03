// Shared helpers for every Cat Track panel.
(function () {
  // One stroke icon set (1.75px, round caps) — no emoji, no sparkles.
  const ICONS = {
    mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
    qr: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM18 18h3v3h-3zM14 20h2M20 14h1"/>',
    camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    speaker: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    mute: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>',
    graph: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
    activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    image: '<rect x="3" y="3" width="18" height="18"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    radio: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/>',
    clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
    pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    thumbUp: '<path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>',
    thumbDown: '<path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/>',
    history: '<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><polyline points="12 7 12 12 15 14"/>',
    search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>',
    tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
    arrow: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    wifiOff: '<line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.58 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
    chevron: '<polyline points="6 9 12 15 18 9"/>',
    // Job-site issue types (the map's icons).
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    bolt: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    cloud: '<path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"/><line x1="8" y1="19" x2="8" y2="21"/><line x1="8" y1="13" x2="8" y2="15"/><line x1="16" y1="19" x2="16" y2="21"/><line x1="16" y1="13" x2="16" y2="15"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="12" y1="15" x2="12" y2="17"/>',
    delivery: '<rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
    note: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
    fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
    filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    // Equipment families, drawn side-on.
    excavator: '<rect x="2" y="17" width="12" height="4" rx="2"/><path d="M4 17v-4h7l1.5 4"/><path d="M6 13v-3h4v3"/><path d="M11 12l4-7 6 3-1.5 4"/><path d="M19.5 12l1.5 3.5h-3.5"/>',
    truck: '<path d="M2 15V7l12-1.5V15"/><path d="M14 9h4l3.5 3.5V15"/><line x1="2" y1="15" x2="22" y2="15"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="18" r="2.5"/>',
    dozer: '<rect x="3" y="16" width="14" height="5" rx="2.5"/><path d="M5 16v-5h6l2 2h3v3"/><path d="M7 11V7h4v4"/><path d="M17 18h3"/><path d="M20 9c1.4 2.5 1.4 8.5 0 12"/>',
    loader: '<circle cx="6.5" cy="18" r="2.5"/><circle cx="15.5" cy="18" r="2.5"/><path d="M3 16V9h5l1.5 3H16v4"/><path d="M5 9V5.5h3.5V9"/><path d="M16 12l3-2.5"/><path d="M19 9.5h3v5.5h-2.5z"/>',
    grader: '<path d="M2 14h4V8h5v6h11"/><circle cx="4.5" cy="18" r="2"/><circle cx="10" cy="18" r="2"/><circle cx="20" cy="18" r="2"/><path d="M13 14l-1.5 4h5"/>',
  };
  const iconPaths = (name) => ICONS[name] || '';
  const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  const FAMILY_ICON = { 'Hydraulic Excavator': 'excavator', 'Off-Highway Truck': 'truck', 'Track-Type Dozer': 'dozer', 'Wheel Loader': 'loader', 'Motor Grader': 'grader' };
  const machineIcon = (family, cls = '') => icon(FAMILY_ICON[family] || 'excavator', cls);

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Language: English text is the key; see /js/i18n.js. Everything user-visible goes through t().
  const I = window.I18N || { lang: 'en', locale: undefined, speech: 'en-US', t: (k, v) => String(k).replace(/\{(\w+)\}/g, (m, n) => (v && v[n] != null ? v[n] : m)), picker: () => '', apply: () => {} };
  const t = I.t;

  async function api(path, opts = {}) {
    const init = { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: { 'ngrok-skip-browser-warning': '1', 'Accept-Language': I.lang } };
    if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    let res;
    try { res = await fetch(path, init); } catch { throw new Error(t('No connection to Cat Track. Check your signal and try again.')); }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw new Error((data && data.error) || t('Request failed ({status})', { status: res.status }));
    return data;
  }

  function ago(iso) {
    if (!iso) return '';
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 45) return t('just now');
    if (s < 3600) return t('{n} min ago', { n: Math.round(s / 60) });
    if (s < 86400) return t('{n} h ago', { n: Math.round(s / 3600) });
    if (s < 86400 * 30) return t('{n} d ago', { n: Math.round(s / 86400) });
    return new Date(iso).toLocaleDateString(I.locale, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  const dateShort = (iso) => (iso ? new Date(iso).toLocaleDateString(I.locale, { month: 'short', day: 'numeric' }) : '');
  const dateTime = (iso) => (iso ? new Date(iso).toLocaleString(I.locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

  // Label tables stay English here; look them up with lbl() so they render in the active language.
  const lbl = (table, key, fallback = '') => t(table[key] || fallback || key || '');
  const SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
  const sevPill = (sev) => `<span class="sev sev-${esc(sev || 'low')}"><i></i>${esc(t(SEV_LABEL[sev] || sev || 'Info'))}</span>`;
  const STATUS_LABEL = { operational: 'Running', attention: 'Needs attention', down: 'Down' };
  const statusPill = (st) => `<span class="st st-${esc(st)}"><i></i>${esc(t(STATUS_LABEL[st] || st))}</span>`;
  const healthBar = (h) => `<div class="health ${h < 60 ? 'bad' : h < 80 ? 'mid' : ''}" role="meter" aria-valuenow="${h}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.max(3, Math.min(100, h))}%"></i></div>`;
  const ROLE = { operator: 'Operator', technician: 'Technician', site_manager: 'Site manager', safety_officer: 'Safety officer', fleet_manager: 'Fleet manager', cat_engineer: 'CAT engineer' };
  const SOURCE_ICON = { voice: 'mic', text: 'chat', telemetry: 'radio', repair: 'wrench', inspection: 'check' };
  const SOURCE_LABEL = { voice: 'Voice note', text: 'Typed report', telemetry: 'Sensor alarm', repair: 'Repair record', inspection: 'Inspection' };
  // Types of job-site issue (computed per report by the server; one icon each, independent of urgency).
  const ISSUES = {
    hazard: { label: 'Safety hazard', icon: 'alert', hint: 'People at risk: unstable ground, pedestrians, fire, injury' },
    malfunction: { label: 'Malfunction', icon: 'bolt', hint: 'Not working right: overheating, warnings, fault codes, power, controls' },
    mechanical: { label: 'Wear & damage', icon: 'gear', hint: 'Leaks, cracks, noise, worn or broken parts' },
    weather: { label: 'Weather & ground', icon: 'cloud', hint: 'Rain, heat, dust, mud, visibility' },
    logistics: { label: 'Logistics', icon: 'delivery', hint: 'Fuel, parts, crew, schedule, deliveries' },
    maintenance: { label: 'Repair & service', icon: 'wrench', hint: 'Repairs, services and inspections that were done' },
    note: { label: 'Note or question', icon: 'note', hint: 'Routine logs and questions' },
  };
  // Where a report stands now (computed by the server from its alert, category and corrections).
  const REPORT_STATUS = { open: 'Open issue', closed: 'Issue closed', withdrawn: 'Withdrawn', repair: 'Repair', logged: 'On record' };

  // ---------- key facts up front, everything else one tap away ----------
  const clip = (t, n) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };

  /**
   * What's wrong, in a few words, from a report (its extraction) or an alert (its key fields):
   * "Cooling system · Overheating", a hazard, "Repair · Hydraulic hose", or a short headline.
   */
  function problemOf(src = {}) {
    const ex = src.extraction || {};
    const part = src.part ?? ex.components?.[0] ?? null;
    const problem = src.problem ?? ((ex.symptoms || []).find((x) => x !== 'Warning / fault code') || ex.symptoms?.[0] || null);
    const hazard = src.hazard ?? ex.safety_hazards?.[0] ?? null;
    const code = src.code ?? ex.fault_codes?.[0] ?? null;
    let title;
    if (src.category === 'maintenance') title = part ? `${t('Repair')} · ${t(part)}` : clip(src.summary, 64);
    else if (part && problem) title = `${t(part)} · ${t(problem)}`;
    else if (hazard) title = t(hazard);
    else if (part) title = t(part);
    else title = clip(src.headline || src.summary || src.title, 64);
    return { title, part, problem, hazard, code };
  }
  const metaLine = (parts) => parts.filter(Boolean).join('<span class="sep"> · </span>');
  /** Labelled key facts in a compact grid: [[label, html], …]; empty values are skipped. */
  const keyFacts = (items) => `<dl class="keyfacts">${items.filter(([, v]) => v).map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
  /** Label/value rows for the inside of a dropdown. */
  const kv = (rows) => `<dl class="kv">${rows.filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  /** One row: the key facts as its summary, everything else inside. */
  const keyRow = ({ tone = '', title, meta = '', right = '', body = '', open = false, attrs = '' }) =>
    `<details class="kr ${tone}" ${open ? 'open' : ''} ${attrs}><summary><span class="kr-main"><span class="kr-title">${title}</span>${meta ? `<span class="kr-meta">${meta}</span>` : ''}</span>${right ? `<span class="kr-right">${right}</span>` : ''}${icon('chevron', 'chev')}</summary><div class="kr-body">${body}</div></details>`;
  /** A collapsible section: a label (and count) you tap to see the rest. */
  const dropdown = (label, inner, { open = false, count = null, attrs = '' } = {}) =>
    `<details class="dd" ${open ? 'open' : ''} ${attrs}><summary><span>${label}${count != null ? `<span class="n">${count}</span>` : ''}</span>${icon('chevron', 'chev')}</summary><div class="dd-body">${inner}</div></details>`;
  /** An alert body is guidance + "What worked before…" + "Sent to CAT Engineering…" + appended updates; split it for labelled rows. */
  function splitAlertBody(body) {
    const [first, ...updates] = String(body || '').split('\n');
    let todo = first;
    const take = (re) => { const m = todo.match(re); if (!m) return null; todo = todo.replace(m[0], ' ').replace(/\s+/g, ' ').trim(); return m[1].trim(); };
    const engineering = take(/((?:Sent to|Escalated to) CAT Engineering[^]*?)(?=What worked before:|$)/);
    const before = take(/What worked before:\s*([^]*?\))\.?/);
    return { todo: todo.trim(), before, engineering, updates: updates.map((u) => u.trim()).filter(Boolean) };
  }
  /** The inside of an alert's dropdown: what to do, what worked before, the escalation, updates. */
  function alertDetails(a, extra = []) {
    const b = splitAlertBody(a.body);
    return kv([
      [t('What to do'), esc(b.todo)],
      [t('Worked before'), esc(b.before || '')],
      [t('CAT Engineering'), esc(b.engineering || '')],
      [t('Updates'), b.updates.map(esc).join('<br>')],
      [t('Fault code'), esc(a.code || '')],
      [t('Fixed'), esc(a.resolution || '')],
      ...extra,
    ]);
  }
  const alertTitle = (a) => (a.kind === 'bulletin' ? clip(a.headline || a.title, 72) : problemOf(a).title);
  const toneOf = (r) => (r.status === 'withdrawn' ? 'withdrawn' : r.category === 'maintenance' ? 'repair' : r.kind === 'bulletin' || r.kind === 'agent' ? 'bulletin' : r.severity || '');

  /** Unglamorous states. */
  const emptyState = ({ icon: ic = 'inbox', title, body = '', action = '', error = false }) =>
    `<div class="empty-state ${error ? 'error' : ''}">${icon(ic)}<div class="t">${title}</div>${body ? `<div class="b">${body}</div>` : ''}${action ? `<div class="a">${action}</div>` : ''}</div>`;
  const skeleton = (rows = 3, kind = 'line') => Array.from({ length: rows }, (_, i) => `<span class="sk ${kind}" style="width:${kind === 'line' ? 92 - ((i * 17) % 40) : 100}%"></span>`).join('');

  /** Tiny, safe markdown: **bold**, "- " bullets, [R12] report refs, line breaks. */
  function md(text) {
    const lines = esc(text || '').split(/\n/);
    let html = ''; let inList = false;
    const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\[R(\d+)\]/g, '<span class="ref">R$1</span>').replace(/\[D(\d+)\]/g, '<a class="ref" href="/library?doc=$1">D$1</a>').replace(/^#{1,4}\s*(.+)$/, '<strong>$1</strong>');
    for (const raw of lines) {
      const line = raw.trim();
      const bullet = line.match(/^[-*•]\s+(.*)$/);
      if (bullet) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(bullet[1])}</li>`; continue; }
      if (inList) { html += '</ul>'; inList = false; }
      if (line) html += `<p>${inline(line)}</p>`;
    }
    if (inList) html += '</ul>';
    return html;
  }

  function toast(msg, kind = '') {
    let box = document.getElementById('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = msg;
    box.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 400); }, 5000);
  }

  /** Live updates over SSE, with reconnect and a visible banner when the link drops. */
  function connectStream(handlers, liveEl) {
    let es; let retry = 0; let bannerTimer = null; let banner = null;
    const showBanner = () => {
      if (banner) return;
      banner = document.createElement('div');
      banner.className = 'conn-banner';
      banner.innerHTML = `${icon('wifiOff')}<span>${t('Live updates paused — reconnecting. Anything on this screen may be out of date.')}</span>`;
      const bar = document.querySelector('.topbar, .op-top');
      if (bar) bar.after(banner); else document.body.prepend(banner);
    };
    const setLive = (on) => {
      if (liveEl) { liveEl.classList.toggle('on', on); const txt = liveEl.querySelector('.txt'); if (txt) txt.textContent = on ? t('Live') : t('Offline'); }
      clearTimeout(bannerTimer);
      if (on) { banner?.remove(); banner = null; } else bannerTimer = setTimeout(showBanner, 4000);
    };
    const open = () => {
      es = new EventSource('/api/stream');
      es.addEventListener('hello', () => { retry = 0; setLive(true); });
      for (const [type, fn] of Object.entries(handlers)) {
        es.addEventListener(type, (e) => { try { fn(JSON.parse(e.data)); } catch (err) { console.error(type, err); } });
      }
      es.onerror = () => { setLive(false); es.close(); setTimeout(open, Math.min(10000, 1000 * 2 ** retry++)); };
    };
    open();
    return () => es && es.close();
  }

  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(`cattrack:${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(`cattrack:${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  function topbar(active, extra = '') {
    // Four tabs. Engineering, the library, QR tags and machine pages hang off the Dashboard.
    const links = [['/', 'Dashboard'], ['/reports', 'Reports'], ['/graph', 'Graph'], ['/operator', 'Operator']];
    const tab = links.some(([h]) => h === active) ? active : '/';
    return `<header class="topbar">
      <a class="brand" href="/" aria-label="${t('Cat Track dashboard')}">CAT<span class="b2">&nbsp;TRACK</span></a>
      <nav class="nav">${links.map(([h, l]) => `<a href="${h}" class="${tab === h ? 'active' : ''}" ${tab === h ? 'aria-current="page"' : ''}>${t(l)}</a>`).join('')}</nav>
      <div class="grow"></div>${extra}
      ${I.picker()}
      <span class="live" id="live"><span class="dot"></span><span class="txt">${t('Connecting')}</span></span>
    </header>`;
  }

  /** A bar along the bottom with a single Undo; it goes away on its own after a few seconds. */
  function undoBar(message, onUndo, { seconds = 10 } = {}) {
    document.querySelector('.undo-bar')?.remove();
    const bar = document.createElement('div');
    bar.className = 'undo-bar';
    bar.setAttribute('role', 'status');
    bar.innerHTML = `<span class="m">${message}</span><button class="btn sm" type="button">${t('Undo')}</button>`;
    document.body.appendChild(bar);
    const close = () => { clearTimeout(timer); bar.remove(); };
    const timer = setTimeout(close, seconds * 1000);
    const btn = bar.querySelector('button');
    btn.onclick = async () => {
      btn.disabled = true;
      try { await onUndo(); close(); } catch (err) { toast(esc(err.message), 'high'); btn.disabled = false; }
    };
    return close;
  }

  function modal(html) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
    document.addEventListener('keydown', function onKey(e) { if (e.key === 'Escape') { back.remove(); document.removeEventListener('keydown', onKey); } });
    document.body.appendChild(back);
    return { el: back.querySelector('.modal'), close: () => back.remove() };
  }

  window.CT = { api, esc, ago, dateShort, dateTime, sevPill, statusPill, healthBar, md, toast, undoBar, connectStream, store, topbar, modal, icon, machineIcon, emptyState, skeleton, ROLE, SOURCE_ICON, SOURCE_LABEL, STATUS_LABEL, REPORT_STATUS, ISSUES, clip, problemOf, metaLine, keyFacts, kv, keyRow, dropdown, toneOf, splitAlertBody, alertDetails, alertTitle, iconPaths, FAMILY_ICON, t, lbl, lang: I.lang, locale: I.locale, speech: I.speech };
})();
