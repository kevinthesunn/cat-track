// Machine memory page: one asset's whole life — profile, distilled memory, role insights,
// lifecycle timeline, its slice of the knowledge graph, and a chat with the machine.
(function () {
  const { api, esc, ago, dateShort, dateTime, sevPill, statusPill, md, toast, connectStream, store, topbar, icon, machineIcon, emptyState, skeleton, ROLE, SOURCE_ICON, SOURCE_LABEL,
    problemOf, metaLine, kv, keyRow, toneOf, alertDetails, alertTitle, t } = CT;
  const $ = (id) => document.getElementById(id);
  document.getElementById('top').innerHTML = topbar('');
  const id = (new URLSearchParams(location.search).get('id') || '').toUpperCase();
  const state = { data: null, role: store.get('assetRole', 'operator'), filter: 'all', timeline: [] };
  if (!id) { $('hero').innerHTML = emptyState({ icon: 'search', title: t('No machine picked'), body: t('Open a machine from a job site, or add ?id=EX-0412 to the address.'), action: `<a href="/">${t('Go to the dashboard')}</a>` }); return; }

  function ring(h) {
    const c = 2 * Math.PI * 44; const off = c * (1 - h / 100);
    const col = h < 60 ? 'var(--critical)' : h < 80 ? 'var(--warn)' : 'var(--good)';
    return `<div class="ring" role="meter" aria-label="${t('Health {h} of 100', { h })}"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" stroke="var(--s3)" stroke-width="8" fill="none"/><circle cx="50" cy="50" r="44" stroke="${col}" stroke-width="8" fill="none" stroke-dasharray="${c}" stroke-dashoffset="${off}"/></svg><div class="val">${h}<small>${t('HEALTH')}</small></div></div>`;
  }

  async function load() {
    const [data, timeline] = await Promise.all([api(`/api/assets/${encodeURIComponent(id)}`), api(`/api/assets/${encodeURIComponent(id)}/timeline`)]);
    state.data = data; state.timeline = timeline;
    document.title = `${data.asset.id} · Machine Memory`;
    renderHero(); renderMemory(); renderOpen(); renderTimeline(); loadInsights();
  }

  async function renderHero() {
    const a = state.data.asset;
    const since = a.last_service_hours != null ? Math.round(a.smu_hours - a.last_service_hours) : null;
    let pub = location.origin;
    try { pub = (await api('/api/public-url')).url; } catch { /* use origin */ }
    $('hero').innerHTML = `
      <div class="ico">${machineIcon(a.family)}</div>
      <div>
        <div class="row wrap" style="gap:10px">${statusPill(a.status)}<span class="id">${esc(a.id)}</span><span class="faint mono" style="font-size:12px">${t('S/N')} ${esc(a.serial)}</span></div>
        <h1 style="margin-top:10px">${esc(a.model)} <span class="muted" style="font-weight:600">${esc(t(a.family))}</span></h1>
        <div class="facts">
          <div class="fact"><div class="k">${t('Job site')}</div><div class="v">${esc(a.site_name)}</div></div>
          <div class="fact"><div class="k">${t('Hours')}</div><div class="v">${Math.round(a.smu_hours).toLocaleString(CT.locale)}</div></div>
          <div class="fact"><div class="k">${t('Fuel')}</div><div class="v">${Math.round(a.fuel_pct)}%</div></div>
          <div class="fact"><div class="k">${t('Since last PM')}</div><div class="v">${since != null ? t('{n} h', { n: since }) : '—'}</div></div>
          <div class="fact"><div class="k">${t('Built')}</div><div class="v">${a.year}</div></div>
          <div class="fact"><div class="k">${t('Operator')}</div><div class="v">${esc(a.operator_name || '—')}</div></div>
        </div>
      </div>
      <div class="row" style="gap:18px;align-items:flex-start">${ring(a.health)}<a href="/operator?unit=${encodeURIComponent(a.id)}" title="${t('Open the report screen for {id}', { id: esc(a.id) })}"><img class="qr-mini" alt="${t('QR tag for {id}', { id: esc(a.id) })}" src="/api/qr.svg?data=${encodeURIComponent(`${pub}/operator?unit=${a.id}`)}"></a></div>`;
    $('graphLink').href = `/graph?focus=${encodeURIComponent('asset:' + a.id.toLowerCase())}`;
  }

  function renderMemory() {
    const mem = state.data.memory;
    const ic = { pattern: 'alert', environment: 'activity', fleet: 'graph', bulletin: 'wrench', service: 'clock', repair: 'wrench', note: 'history', document: 'file' };
    $('memory').innerHTML = mem.length ? mem.map((m) => `<div class="mem">${icon(ic[m.kind] || 'history')}<span>${m.docId ? `<a href="/library?doc=${m.docId}">${esc(m.text.replace(/ \[D\d+\]$/, ''))}</a>` : esc(m.text)}</span></div>`).join('') : emptyState({ icon: 'history', title: t('Nothing distilled yet'), body: t('After a few reports, repeat problems and links to conditions like heat or dust show up here.') });
  }

  function renderOpen() {
    const { alerts, actions } = state.data;
    $('openItems').innerHTML = (alerts.length || actions.length)
      ? alerts.map((a) => keyRow({
          tone: toneOf(a), title: esc(alertTitle(a)),
          meta: metaLine([ago(a.created_at), a.status === 'ack' ? t('seen') : t('open')]),
          right: sevPill(a.severity),
          body: alertDetails(a, [[t('Tasks'), actions.filter((t) => t.alert_id === a.id).map((t) => `<b style="font-weight:600">${esc(CT.t(ROLE[t.assignee_role] || t.assignee_role))}:</b> ${esc(t.text)}`).join('<br>')]]),
        })).join('') +
        (actions.some((t) => !alerts.some((a) => a.id === t.alert_id)) ? keyRow({ title: t('Other open tasks'), meta: t('{n} to do', { n: actions.filter((t) => !alerts.some((a) => a.id === t.alert_id)).length }), body: actions.filter((t) => !alerts.some((a) => a.id === t.alert_id)).map((t) => `<div class="mem">${icon('check')}<span><span class="label" style="margin-right:6px">${esc(CT.t(ROLE[t.assignee_role] || t.assignee_role))}</span>${esc(t.text)}</span></div>`).join('') }) : '')
      : emptyState({ icon: 'check', title: t('Nothing open on this machine'), body: t('No unresolved alerts or tasks. New ones appear the moment someone reports a problem.') });
  }

  async function loadInsights() {
    $('roleTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.r === state.role));
    try {
      const out = await api(`/api/assets/${encodeURIComponent(id)}/insights?role=${state.role}`);
      $('insights').innerHTML = out.items.map((i) => keyRow({ tone: i.level === 'high' ? 'high' : i.level === 'medium' ? 'medium' : '', title: esc(i.title), body: `<div style="font-size:14px;color:var(--ink-2)">${esc(i.detail)}</div>` })).join('');
    } catch (err) { $('insights').innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
  }
  $('roleTabs').querySelectorAll('button').forEach((b) => b.onclick = () => { state.role = b.dataset.r; store.set('assetRole', state.role); loadInsights(); });

  const FILTERS = { all: 'Everything', issues: 'Problems', repairs: 'Repairs and service', safety: 'Safety', telemetry: 'Sensor alarms' };
  function renderTimeline() {
    $('filters').innerHTML = Object.entries(FILTERS).map(([k, l]) => `<button class="chip ${state.filter === k ? 'on' : ''}" data-f="${k}">${t(l)}</button>`).join('');
    $('filters').querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { state.filter = b.dataset.f; renderTimeline(); });
    const f = state.filter;
    const items = state.timeline.filter((r) => f === 'all' || (f === 'issues' && r.category === 'mechanical') || (f === 'repairs' && r.category === 'maintenance') || (f === 'safety' && r.category === 'safety') || (f === 'telemetry' && r.source === 'telemetry'));
    const n = state.timeline.length;
    const date = n ? new Date(state.timeline[n - 1].created_at).toLocaleDateString(CT.locale, { month: 'short', year: 'numeric' }) : '';
    $('tlCount').textContent = n ? (n === 1 ? t('1 entry since {date}', { date }) : t('{n} entries since {date}', { n, date })) : '';
    const emptyCopy = { all: ['Nothing on record yet', 'The first report, repair or sensor alarm for this machine starts its history.'], issues: ['No problems reported', 'Nobody has reported a mechanical problem on this machine.'], repairs: ['No repairs or services logged', 'Repairs logged from the job-site view will appear here.'], safety: ['No safety reports', 'No hazards have been reported around this machine.'], telemetry: ['No sensor alarms', 'Turn on simulated sensors in the job-site view; readings over a limit are filed here.'] }[f];
    $('timeline').innerHTML = items.map((r) => {
      const p = problemOf(r);
      const problem = ['mechanical', 'safety'].includes(r.category);
      return keyRow({
        tone: toneOf(r), title: esc(p.title),
        meta: metaLine([`<span title="${esc(dateTime(r.created_at))}">${dateShort(r.created_at)}</span>`, esc(r.person_name || t(SOURCE_LABEL[r.source] || r.source))]),
        right: problem ? sevPill(r.severity) : `<span class="tag">${r.category === 'maintenance' ? t('repair') : r.source === 'telemetry' ? t('sensor') : t('note')}</span>`,
        body: kv([
          [t('Said'), `<q>${esc(r.raw_text)}</q>`],
          [t('Summary'), r.summary !== p.title ? esc(r.summary) : ''],
          [t('Fault code'), esc((r.extraction.fault_codes || []).join(', '))],
          [t('Conditions'), esc((r.extraction.conditions || []).map((c) => t(c)).join(', '))],
          [t('Reported by'), esc([r.person_name, t(SOURCE_LABEL[r.source] || r.source).toLowerCase(), dateTime(r.created_at)].filter(Boolean).join(' · '))],
          [t('Photo'), r.photo_path ? `<img src="${esc(r.photo_path)}" alt="${t('Photo attached to this report')}" style="max-width:180px;border-radius:3px;border:1px solid var(--line)">` : ''],
        ]),
      });
    }).join('') || emptyState({ icon: 'history', title: t(emptyCopy[0]), body: t(emptyCopy[1]) });
  }

  // ---------- mini graph ----------
  async function loadMini() {
    const g = await api(`/api/assets/${encodeURIComponent(id)}/graph`);
    const COLORS = { site: '#ffcd11', asset: '#ffcd11', model: '#ffcd11', case: '#199e70', fix: '#199e70', document: '#199e70', policy: '#199e70', component: '#3987e5', condition: '#3987e5', spec: '#3987e5', procedure: '#3987e5', symptom: '#d95926', code: '#d95926', hazard: '#d95926', person: '#8a8f96', report: '#5d6269' };
    const nodes = new vis.DataSet(g.nodes.map((n) => ({ id: n.id, label: n.type === 'report' ? undefined : n.label, title: n.label, color: COLORS[n.type] || '#888', shape: n.type === 'asset' ? 'dot' : n.type === 'symptom' ? 'triangle' : n.type === 'case' ? 'star' : 'dot', size: n.id === `asset:${id.toLowerCase()}` ? 22 : n.type === 'report' ? 5 : 10, font: { color: '#d9dde1', size: 11, strokeWidth: 3, strokeColor: '#0f1113' } })));
    const edges = new vis.DataSet(g.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, color: { color: 'rgba(140,150,160,.3)' }, width: Math.min(4, 0.6 + Math.log2(e.weight || 1)) })));
    new vis.Network($('mini'), { nodes, edges }, { physics: { solver: 'forceAtlas2Based', stabilization: { iterations: 150 } }, edges: { smooth: false }, interaction: { hover: true } });
    if (!g.nodes.length) $('mini').innerHTML = emptyState({ icon: 'graph', title: t('No connections yet'), body: t('Once this machine has a report, its parts and symptoms link up here.') });
  }

  // ---------- ask ----------
  api('/api/health').then((h) => { $('aiMode').textContent = h.ai === 'llm' ? h.label : t('offline'); }).catch(() => {});
  const SUGGEST = ['Has this happened before?', 'What should I check before my shift?', 'What fixed it last time?', 'Are other machines having this problem?'];
  $('askChips').innerHTML = SUGGEST.map((s) => `<button class="chip" type="button">${esc(t(s))}</button>`).join('');
  $('askChips').querySelectorAll('.chip').forEach((c) => c.onclick = () => { $('askInput').value = c.textContent; $('askForm').requestSubmit(); });
  $('askLog').innerHTML = `<div class="bubble bot muted">${t('Answers come only from {id}’s record and its model’s fleet history, with report numbers so you can check them.', { id: esc(id) })}</div>`;
  $('askForm').onsubmit = async (e) => {
    e.preventDefault();
    const qText = $('askInput').value.trim();
    if (!qText) return;
    $('askInput').value = '';
    const log = $('askLog');
    log.insertAdjacentHTML('beforeend', `<div class="bubble me">${esc(qText)}</div><div class="bubble bot" id="pending"><span class="sk line" style="width:220px"></span><span class="sk line" style="width:150px"></span></div>`);
    log.scrollTop = log.scrollHeight;
    try {
      const role = state.role === 'fleet_manager' ? 'fleet_manager' : state.role;
      const out = await api('/api/ask', { body: { question: qText, assetId: id, role, lang: CT.lang } });
      document.getElementById('pending').outerHTML = `<div class="bubble bot md" ${out.pending ? `data-answer="${esc(out.pending)}"` : ''}>${md(out.answer)}${out.pending ? `<div class="trace" data-pending>${t('straight from the record · asking {model} for a fuller answer…', { model: esc(out.model) })}</div>` : ''}</div>`;
    } catch (err) { document.getElementById('pending').outerHTML = `<div class="bubble bot">${emptyState({ icon: 'wifiOff', error: true, title: t('No answer'), body: esc(err.message) })}</div>`; }
    log.scrollTop = log.scrollHeight;
  };

  let timer = null;
  connectStream({
    report: ({ report }) => { if (report.asset_id === id) { toast(t('New on this machine: {summary}', { summary: esc(report.summary) })); clearTimeout(timer); timer = setTimeout(load, 300); } },
    'report-updated': ({ report }) => { if (report?.asset_id === id) { clearTimeout(timer); timer = setTimeout(load, 300); } },
    'report-deleted': ({ reports }) => { if (reports.some((r) => r.asset_id === id)) { clearTimeout(timer); timer = setTimeout(() => { load(); loadMini().catch(() => {}); }, 300); } },
    'report-restored': ({ reports }) => { if (reports.some((r) => r.asset_id === id)) { clearTimeout(timer); timer = setTimeout(() => { load(); loadMini().catch(() => {}); }, 300); } },
    answer: (ev) => {
      const el = document.querySelector(`[data-answer="${CSS.escape(ev.id)}"]`);
      if (!el) return;
      if (ev.error) { el.querySelector('[data-pending]').textContent = t('straight from the record · the AI didn’t answer ({error})', { error: ev.error }); return; }
      el.outerHTML = `<div class="bubble bot md">${md(ev.answer)}<div class="trace">${t('{model} · {seconds}s', { model: esc(ev.model), seconds: ev.seconds })}</div></div>`;
      $('askLog').scrollTop = $('askLog').scrollHeight;
    },
    asset: (a) => { if (a.id === id) { clearTimeout(timer); timer = setTimeout(load, 300); } },
  }, $('live'));

  $('insights').innerHTML = skeleton(4); $('memory').innerHTML = skeleton(3); $('timeline').innerHTML = skeleton(6);
  load().catch((err) => { $('hero').innerHTML = emptyState({ icon: 'search', error: true, title: t('Couldn’t open {id}', { id: esc(id) }), body: esc(err.message), action: `<a href="/">${t('Back to the dashboard')}</a>` }); $('insights').innerHTML = ''; $('memory').innerHTML = ''; $('timeline').innerHTML = ''; });
  loadMini().catch(() => { $('mini').innerHTML = `<div class="empty">${t('Graph unavailable')}</div>`; });
})();
