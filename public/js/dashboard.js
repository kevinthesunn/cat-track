// Dashboard: everything happening on the job sites at a glance — open alerts, machines, tasks,
// the latest reports, CAT Engineering cases and the record agent. One site or all of them.
(function () {
  const { api, esc, ago, dateTime, sevPill, statusPill, md, toast, connectStream, store, topbar, modal, icon, machineIcon, emptyState, skeleton, ROLE, SOURCE_LABEL,
    problemOf, metaLine, kv, keyRow, dropdown, toneOf, alertDetails, alertTitle, t } = CT;
  const $ = (id) => document.getElementById(id);
  $('top').innerHTML = topbar('/');

  const qs = new URLSearchParams(location.search);
  const state = { site: qs.has('site') ? qs.get('site') : store.get('site', ''), data: null, sites: [], people: [], tele: {}, cases: [], docs: 0 };
  const ROLE_ORDER = ['operator', 'technician', 'site_manager', 'safety_officer', 'fleet_manager'];
  const METRIC = { coolant_temp: 'coolant', hyd_oil_temp: 'hyd oil', trans_oil_temp: 'trans oil', engine_load: 'load', payload: 'payload', speed: 'speed' };
  const KIND = { mechanical: 'Mechanical', safety: 'Safety', operational: 'Site ops', bulletin: 'CAT bulletin', agent: 'Notice' };
  const PRIO_SEV = { P1: 'critical', P2: 'high', P3: 'medium' };

  $('alerts').innerHTML = skeleton(3, 'block');
  $('latest').innerHTML = skeleton(3);
  $('fleet').innerHTML = skeleton(4, 'block');
  $('actions').innerHTML = skeleton(4);
  $('cases').innerHTML = skeleton(3);

  const inScope = (siteId) => !state.site || siteId === state.site;
  const mgr = () => state.people.find((p) => p.role === 'site_manager' && p.site_id === (state.site || 'S1'));
  const siteName = (id) => state.sites.find((s) => s.id === id)?.name || '';
  const shortName = (name) => name.split(' ').slice(0, 2).join(' ');
  const when = (iso) => `<span title="${esc(dateTime(iso))}">${ago(iso)}</span>`;

  async function boot() {
    [state.sites, state.people] = await Promise.all([api('/api/sites'), api('/api/people')]);
    if (state.site && !state.sites.some((s) => s.id === state.site)) state.site = '';
    renderSites();
    api('/api/health').then((h) => { $('aiMode').textContent = h.ai === 'llm' ? h.label : t('offline'); }).catch(() => {});
    loadSide();
    await load();
  }
  function renderSites() {
    $('sites').innerHTML = [['', t('All job sites')], ...state.sites.map((s) => [s.id, shortName(s.name)])]
      .map(([id, label]) => `<button type="button" data-site="${esc(id)}" class="${state.site === id ? 'on' : ''}" title="${esc(id ? siteName(id) : t('Every job site'))}">${esc(label)}</button>`).join('');
  }
  $('sites').addEventListener('click', (e) => {
    const b = e.target.closest('[data-site]'); if (!b) return;
    state.site = b.dataset.site; store.set('site', state.site);
    const u = new URL(location.href); if (state.site) u.searchParams.set('site', state.site); else u.searchParams.delete('site'); history.replaceState(null, '', u);
    renderSites(); load();
  });

  async function load() {
    try { state.data = await api(`/api/dashboard${state.site ? `?site=${encodeURIComponent(state.site)}` : ''}`); }
    catch (err) { $('alerts').innerHTML = emptyState({ icon: 'wifiOff', error: true, title: t('Couldn’t reach the server'), body: `${esc(err.message)} ${t('This refreshes by itself when the connection is back.')}` }); return; }
    for (const t of state.data.latestTelemetry) (state.tele[t.asset_id] ||= {})[t.metric] = t;
    $('teleToggle').checked = state.data.telemetry;
    renderHead(); renderStats(); renderAlerts(); renderLatest(); renderFleet(); renderActions();
  }
  // Engineering cases and the library are fleet-wide, so they load once and refresh on their own events.
  async function loadSide() {
    try { state.cases = await api('/api/cases'); } catch { state.cases = []; }
    try { state.docs = (await api('/api/documents')).length; } catch { state.docs = 0; }
    renderCases(); renderLinks();
  }

  function renderHead() {
    const site = state.sites.find((s) => s.id === state.site);
    const m = mgr();
    $('siteLabel').textContent = site ? t('Dashboard · job site {id}', { id: site.id }) : t('Dashboard');
    $('siteTitle').textContent = site ? site.name : t('All job sites');
    $('siteSub').textContent = site ? [site.location, site.climate, m ? t('site manager {name}', { name: m.name }) : ''].filter(Boolean).join(' · ') : t('{sites} job sites · {machines} machines', { sites: state.sites.length, machines: state.data.kpis.assets });
    document.title = `${site ? site.name : t('Dashboard')} · Cat Track`;
    $('logLink').href = state.site ? `/reports?site=${encodeURIComponent(state.site)}` : '/reports';
  }

  function renderStats() {
    const k = state.data.kpis;
    const need = k.down + k.attention;
    $('stats').innerHTML = `
      <div class="hero"><div class="v">${need}</div><div class="k"><span class="mk ${k.down ? 'critical' : need ? 'high' : 'good'}"></span>${need === 1 ? t('machine needs attention') : need === 0 ? t('machines need attention, all running') : t('machines need attention')}</div></div>
      <div class="stat"><div class="v">${k.down}</div><div class="k">${k.down ? '<span class="mk critical"></span>' : ''}${t('down')}</div></div>
      <div class="stat"><div class="v">${k.openAlerts}</div><div class="k">${t('open alerts')}</div></div>
      <div class="stat"><div class="v">${k.openActions}</div><div class="k">${t('open tasks')}</div></div>
      <div class="stat"><div class="v">${k.reportsToday}</div><div class="k">${t('reports today')}</div></div>
      <div class="stat"><div class="v">${k.avgHealth}</div><div class="k">${t('average health')}</div></div>`;
  }

  /* ---------- alerts ---------- */
  function alertCard(a, flash) {
    return keyRow({
      tone: `${toneOf(a)} ${a.status === 'resolved' ? 'resolved' : ''} ${flash ? 'flash' : ''}`,
      attrs: `data-id="${a.id}"`,
      title: esc(alertTitle(a)),
      meta: metaLine([
        a.asset_id ? `<a class="id" href="/asset?id=${encodeURIComponent(a.asset_id)}">${esc(a.asset_id)}</a> ${esc(a.model || '')}` : t('Fleet bulletin'),
        !state.site ? esc(a.site_name || siteName(a.site_id)) : '',
        when(a.created_at),
      ]),
      right: `${a.kind === 'bulletin' ? `<span class="tag cat">${t('CAT bulletin')}</span>` : sevPill(a.severity)}${a.status !== 'open' ? `<span class="tag">${a.status === 'ack' ? t('seen') : t('closed')}</span>` : ''}`,
      body: alertDetails(a, [[t('Type'), esc(t(KIND[a.kind] || a.kind))], [t('Sent to'), (a.audience || []).map((r) => esc(t(ROLE[r] || r).toLowerCase())).join(', ')]])
        + (a.status !== 'resolved' ? `<div class="kr-actions">${a.status === 'open' ? `<button class="btn sm" data-ack="${a.id}">${t('Mark as seen')}</button>` : ''}<button class="btn sm ${a.kind === 'mechanical' ? 'primary' : ''}" data-resolve="${a.id}">${a.kind === 'mechanical' ? t('Log the repair') : t('Close')}</button></div>` : ''),
    });
  }
  function renderAlerts(flashId) {
    const open = state.data.alerts.filter((a) => a.status !== 'resolved');
    $('alertCount').textContent = open.length ? t('{n} open', { n: open.length }) : '';
    $('alerts').innerHTML = open.length ? open.map((a) => alertCard(a, a.id === flashId)).join('')
      : emptyState({ icon: 'check', title: t('Nothing open'), body: t('New alerts land here the moment someone reports a problem.') });
    $('alerts').querySelectorAll('[data-ack]').forEach((b) => b.onclick = () => ack(Number(b.dataset.ack)));
    $('alerts').querySelectorAll('[data-resolve]').forEach((b) => b.onclick = () => resolveDialog(Number(b.dataset.resolve)));
  }
  async function ack(id) {
    try { await api(`/api/alerts/${id}/ack`, { body: { personId: mgr()?.id } }); } catch (err) { toast(esc(err.message), 'high'); }
  }
  async function resolveDialog(id) {
    const a = state.data.alerts.find((x) => x.id === id);
    if (!a) return;
    let fixes = [];
    if (a.asset_id && a.kind === 'mechanical') { try { fixes = (await api(`/api/assets/${encodeURIComponent(a.asset_id)}`)).fixes; } catch { fixes = []; } }
    const crew = state.people.filter((p) => ['technician', 'site_manager', 'operator'].includes(p.role) && (!p.site_id || p.site_id === a.site_id));
    const m = modal(`<h2>${a.kind === 'mechanical' ? t('What fixed it?') : t('Close this alert')}</h2>
      <p class="muted">${esc(a.asset_id ? `${a.asset_id} · ` : '')}${esc(alertTitle(a))}</p>
      <label class="lbl" style="margin-top:14px">${t('Closed by')}</label>
      <select class="select" id="rsBy">${crew.map((p) => `<option value="${p.id}" ${p.role === 'technician' ? 'selected' : ''}>${esc(p.name)} · ${t(ROLE[p.role])}</option>`).join('')}</select>
      ${fixes.length ? `<label class="lbl" style="margin-top:14px">${t('Was it one of these?')}</label>
        <select class="select" id="rsFix"><option value="">${t('No, something else')}</option>${fixes.map((f) => `<option value="${f.id}">${esc(f.title)} ${t('(worked {n} of {total})', { n: f.success, total: f.success + f.fail })}</option>`).join('')}</select>` : ''}
      ${a.asset_id ? `<label class="lbl" style="margin-top:14px">${t('What was done')}</label>
        <textarea class="textarea" id="rsText" placeholder="${esc(t('Replaced the boom hose, routed it clear of the bracket, added a P-clamp.'))}"></textarea>` : ''}
      <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn ghost" id="rsCancel">${t('Cancel')}</button><button class="btn primary" id="rsGo">${a.kind === 'mechanical' ? t('Save repair') : t('Close alert')}</button></div>`);
    m.el.querySelector('#rsCancel').onclick = m.close;
    m.el.querySelector('#rsGo').onclick = async () => {
      const fixId = m.el.querySelector('#rsFix')?.value || null;
      const text = m.el.querySelector('#rsText')?.value.trim() || '';
      const resolution = text || (fixId ? fixes.find((f) => String(f.id) === fixId)?.title : '');
      m.el.querySelector('#rsGo').disabled = true;
      try {
        const out = await api(`/api/alerts/${id}/resolve`, { body: { personId: m.el.querySelector('#rsBy').value, resolution, fixId, worked: Boolean(fixId) } });
        m.close();
        toast(out.learnedFixId ? t('Repair saved as a known fix.') : fixId ? t('Repair saved. That fix’s record went up by one.') : t('Alert closed.'), 'good');
        load();
      } catch (err) { toast(esc(err.message), 'high'); m.el.querySelector('#rsGo').disabled = false; }
    };
  }

  /* ---------- latest reports ---------- */
  function renderLatest(flashId) {
    const reps = state.data.reports.slice(0, 6);
    $('latest').innerHTML = reps.length ? reps.map((r) => {
      const p = problemOf(r);
      const problem = ['mechanical', 'safety'].includes(r.category);
      return keyRow({
        tone: `${toneOf(r)} ${r.id === flashId ? 'flash' : ''}`,
        title: esc(p.title),
        meta: metaLine([`<span class="id">${esc(r.asset_id)}</span>`, !state.site ? esc(shortName(siteName(r.site_id))) : '', when(r.created_at)]),
        right: problem ? sevPill(r.severity) : `<span class="tag">${r.category === 'maintenance' ? t('repair') : r.source === 'telemetry' ? t('sensor') : t('note')}</span>`,
        body: kv([[t('Said'), `<q>${esc(r.raw_text)}</q>`], [t('Reported by'), esc([r.person_name, t(SOURCE_LABEL[r.source] || r.source).toLowerCase()].filter(Boolean).join(' · '))]])
          + `<div class="kr-actions"><a class="btn sm" href="/reports?q=${encodeURIComponent(r.asset_id)}">${t('Open in the report log')}</a></div>`,
      });
    }).join('') : emptyState({ icon: 'mic', title: t('Nothing reported yet'), body: t('Voice notes from the operator screen show up here.'), action: `<a href="/operator">${t('Open the operator screen')}</a>` });
  }

  /* ---------- machines ---------- */
  function teleLine(assetId) {
    const t = state.tele[assetId];
    if (!t || !state.data.telemetry) return '';
    return Object.values(t).slice(0, 2).map((r) => `${CT.t(METRIC[r.metric] || r.metric)} ${Math.round(r.value)}${r.unit}`).join(' · ');
  }
  function renderFleet() {
    const assets = state.data.assets;
    $('fleetCount').textContent = `${assets.length}`;
    $('fleet').innerHTML = assets.length ? assets.map((a) => `<a class="unit ${a.status}" href="/asset?id=${encodeURIComponent(a.id)}">
      <span class="ic">${machineIcon(a.family)}</span>
      <span style="min-width:0"><span class="id">${esc(a.id)}</span> <span class="m">${esc(a.model)}</span><div class="m">${a.open_alerts ? (a.open_alerts === 1 ? t('1 open alert') : t('{n} open alerts', { n: a.open_alerts })) : esc(!state.site ? shortName(a.site_name || '') : t(a.family))}</div><div class="tele" data-tele="${esc(a.id)}">${teleLine(a.id)}</div></span>
      <span class="r">${statusPill(a.status)}<div class="health ${a.health < 60 ? 'bad' : a.health < 80 ? 'mid' : ''}" title="${t('Health {n}/100', { n: a.health })}"><i style="width:${a.health}%"></i></div></span></a>`).join('')
      : emptyState({ icon: 'pin', title: t('No machines here'), body: t('Machines show up once they’re assigned to this job site.') });
  }

  /* ---------- tasks ---------- */
  function renderActions() {
    const items = state.data.actions;
    const open = items.filter((i) => i.status === 'open');
    $('actCount').textContent = open.length ? t('{n} to do', { n: open.length }) : '';
    if (!items.length) { $('actions').innerHTML = emptyState({ icon: 'check', title: t('No tasks'), body: t('Tasks are written when someone reports a problem, split by who should do them.') }); return; }
    const groups = {};
    for (const it of items) (groups[it.assignee_role] ||= []).push(it);
    $('actions').innerHTML = ROLE_ORDER.filter((r) => groups[r]).map((r, i) => dropdown(t(ROLE[r]), groups[r].map((it) => `
      <div class="act-item ${it.status === 'done' ? 'done' : ''}" data-act="${it.id}" role="checkbox" aria-checked="${it.status === 'done'}" tabindex="0"><span class="box">${it.status === 'done' ? icon('check') : ''}</span>
      <div><div class="txt">${esc(it.text)}</div><div class="meta">${it.asset_id ? esc(it.asset_id) + ' · ' : ''}${ago(it.created_at)}${!state.site && it.site_name ? ' · ' + esc(shortName(it.site_name)) : ''}</div></div></div>`).join(''),
      { count: t('{n} open', { n: groups[r].filter((x) => x.status === 'open').length }), open: i === 0, attrs: `data-role="${r}"` })).join('');
    $('actions').querySelector('.dd')?.style.setProperty('border-top', '0');
    $('actions').querySelectorAll('[data-act]').forEach((el) => {
      const toggle = async () => { try { await api(`/api/actions/${el.dataset.act}/toggle`, { body: {} }); } catch (err) { toast(esc(err.message), 'high'); } };
      el.onclick = toggle;
      el.onkeydown = (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); } };
    });
  }

  /* ---------- engineering, library, tags ---------- */
  function renderCases() {
    const open = state.cases.filter((c) => c.status !== 'closed').sort((a, b) => a.priority.localeCompare(b.priority) || String(b.last_seen).localeCompare(String(a.last_seen)));
    $('cases').innerHTML = open.length ? open.slice(0, 5).map((c) => `<a class="case-row" href="/engineering?case=${c.id}"><span class="sev sev-${PRIO_SEV[c.priority] || 'medium'}"><i></i>${esc(c.priority)}</span><span class="t">${esc(c.title)}</span><span class="n">${t('{reports} rep · {machines} mach', { reports: c.occurrences, machines: c.machines })}</span></a>`).join('')
      + (open.length > 5 ? `<div class="muted" style="font-size:13px;padding-top:8px">${t('+{n} more open cases', { n: open.length - 5 })}</div>` : '')
      : emptyState({ icon: 'file', title: t('No open cases'), body: t('A case opens when a machine reports a mechanical failure; repeats across the fleet raise its priority.') });
  }
  function renderLinks() {
    $('links').innerHTML = `
      <a href="/engineering">${icon('wrench')} ${t('CAT Engineering')}<span class="m">${t('{n} open', { n: state.cases.filter((c) => c.status !== 'closed').length })}</span></a>
      <a href="/library">${icon('file')} ${t('Product library')}<span class="m">${state.docs === 1 ? t('1 doc') : t('{n} docs', { n: state.docs })}</span></a>
      <a href="/tags">${icon('qr')} ${t('Print machine QR tags')}</a>`;
  }

  /* ---------- ask the record ---------- */
  const SUGGEST = ['Which machines need attention?', 'Any overheating on the 777s?', 'What do we know about boom hose leaks?'];
  $('askChips').innerHTML = SUGGEST.map((x) => `<button class="chip" type="button">${esc(t(x))}</button>`).join('');
  $('askChips').querySelectorAll('.chip').forEach((c) => c.onclick = () => { $('askInput').value = c.textContent; $('askForm').requestSubmit(); });
  $('askForm').onsubmit = async (e) => {
    e.preventDefault();
    const qText = $('askInput').value.trim();
    if (!qText) return;
    $('askInput').value = '';
    const log = $('askLog');
    log.insertAdjacentHTML('beforeend', `<div class="bubble me">${esc(qText)}</div><div class="bubble bot" id="pending"><span class="sk line" style="width:220px"></span><span class="sk line" style="width:160px"></span></div>`);
    log.scrollTop = log.scrollHeight;
    try {
      const out = await api('/api/ask', { body: { question: qText, role: 'site_manager', personId: mgr()?.id, lang: CT.lang } });
      $('pending').outerHTML = answerBubble(out);
    } catch (err) {
      $('pending').outerHTML = `<div class="bubble bot">${emptyState({ icon: 'wifiOff', error: true, title: t('No answer'), body: esc(err.message) })}</div>`;
    }
    log.scrollTop = log.scrollHeight;
  };
  function answerBubble(out) {
    const trace = out.trace?.length ? `<div class="trace">${t('looked at:')} ${[...new Set(out.trace.map((t) => t.tool.replace(/_/g, ' ')))].map(esc).join(', ')}</div>` : '';
    const pending = out.pending ? `<div class="trace" data-pending="${esc(out.pending)}">${t('from the record · asking {model} for a fuller answer…', { model: esc(out.model) })}</div>` : '';
    return `<div class="bubble bot md" ${out.pending ? `data-answer="${esc(out.pending)}"` : ''}>${md(out.answer)}${trace}${pending}</div>`;
  }

  /* ---------- sensors ---------- */
  $('teleToggle').onchange = async () => {
    try { const r = await api('/api/telemetry', { body: { on: $('teleToggle').checked } }); toast(r.on ? t('Simulated sensors on. Readings over a limit become reports.') : t('Simulated sensors off.')); }
    catch (err) { toast(esc(err.message), 'high'); }
  };

  /* ---------- live ---------- */
  let reloadTimer = null; let sideTimer = null;
  const softReload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(load, 400); };
  const sideReload = () => { clearTimeout(sideTimer); sideTimer = setTimeout(loadSide, 600); };
  connectStream({
    report: ({ report }) => { if (inScope(report.site_id)) softReload(); },
    'report-updated': ({ report }) => { if (!report || inScope(report.site_id)) softReload(); },
    'report-deleted': softReload, 'report-restored': softReload,
    alert: ({ alert }) => { if (!inScope(alert.site_id) || !state.data) return; toast(`<b>${esc(alert.asset_id ? alert.asset_id + ' · ' : '')}${esc(alertTitle(alert))}</b>`, alert.severity); softReload(); },
    'alert-updated': ({ alert }) => { if (inScope(alert.site_id)) softReload(); },
    action: ({ item }) => { if (inScope(item.site_id)) softReload(); },
    asset: (a) => { if (inScope(a.site_id)) softReload(); },
    case: sideReload, 'case-removed': sideReload, 'doc-step': sideReload,
    telemetry: ({ readings }) => {
      for (const r of readings) (state.tele[r.asset_id] ||= {})[r.metric] = r;
      document.querySelectorAll('[data-tele]').forEach((el) => { el.textContent = teleLine(el.dataset.tele); });
    },
    'telemetry-status': ({ on }) => { $('teleToggle').checked = on; if (state.data) { state.data.telemetry = on; renderFleet(); } },
    hello: () => { if (state.data) { softReload(); sideReload(); } },
    answer: (ev) => {
      const el = document.querySelector(`[data-answer="${CSS.escape(ev.id)}"]`);
      if (!el) return;
      if (ev.error) { el.querySelector('[data-pending]').textContent = t('from the record · the AI didn’t answer ({error})', { error: ev.error }); return; }
      el.outerHTML = `<div class="bubble bot md">${md(ev.answer)}<div class="trace">${esc(ev.model)} · ${ev.seconds}s${ev.trace?.length ? ` · ${t('looked at:')} ${[...new Set(ev.trace.map((t) => t.tool.replace(/_/g, ' ')))].map(esc).join(', ')}` : ''}</div></div>`;
      $('askLog').scrollTop = $('askLog').scrollHeight;
    },
  }, $('live'));

  boot().catch((err) => { $('alerts').innerHTML = emptyState({ icon: 'wifiOff', error: true, title: t('Couldn’t load the dashboard'), body: esc(err.message) }); });
})();
