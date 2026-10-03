// CAT Engineering: fleet-wide mechanical cases with field evidence, root-cause analysis,
// and the two ways back out: a quick fix to the field, or a design change to the product.
(function () {
  const { api, esc, ago, dateShort, sevPill, md, toast, connectStream, store, topbar, modal, icon, emptyState, skeleton, ROLE, SOURCE_LABEL, metaLine, kv, keyRow, toneOf, t } = CT;
  const $ = (id) => document.getElementById(id);
  document.getElementById('top').innerHTML = topbar('/engineering');

  const STATUSES = ['new', 'investigating', 'quick_fix_issued', 'product_update', 'closed'];
  const STATUS_LABEL = { new: 'New', investigating: 'Investigating', quick_fix_issued: 'Quick fix sent', product_update: 'Design change', closed: 'Closed' };
  const PRIO_SEV = { P1: 'critical', P2: 'high', P3: 'medium' };
  const prio = (p) => `<span class="sev sev-${PRIO_SEV[p] || 'medium'}"><i></i>${esc(p)}</span>`;
  const state = { cases: [], selected: Number(new URLSearchParams(location.search).get('case')) || null, detail: null, engineers: [], filter: 'open' };

  $('cases').innerHTML = `<div style="padding:12px">${skeleton(4, 'block')}</div>`;
  $('detail').innerHTML = `<span class="sk line" style="width:30%"></span><span class="sk title" style="height:34px;margin-top:14px"></span>${skeleton(1, 'block')}${skeleton(5)}`;

  async function boot() {
    const people = await api('/api/people');
    state.engineers = people.filter((p) => p.role === 'cat_engineer');
    $('engineerSel').innerHTML = state.engineers.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}, ${esc(t(p.specialty).toLowerCase())}</option>`).join('');
    $('engineerSel').value = store.get('engineer', state.engineers[0]?.name);
    $('engineerSel').onchange = () => store.set('engineer', $('engineerSel').value);
    $('statusFilter').onchange = () => { state.filter = $('statusFilter').value; renderCases(); };
    await loadCases();
  }
  const me = () => $('engineerSel').value;

  async function loadCases() {
    try { state.cases = await api('/api/cases'); }
    catch (err) { $('cases').innerHTML = `<div style="padding:0 18px">${emptyState({ icon: 'wifiOff', error: true, title: t('Couldn’t load cases'), body: esc(err.message) })}</div>`; return; }
    if (!state.selected && state.cases[0]) state.selected = state.cases[0].id;
    renderStats(); renderCases();
    if (state.selected) await loadDetail(state.selected);
    else $('detail').innerHTML = emptyState({ icon: 'file', title: t('No cases yet'), body: t('A case opens the first time a machine reports a mechanical failure. Reports on the same model and part are added to it, so patterns show up on their own.') });
  }

  async function renderStats() {
    const open = state.cases.filter((c) => c.status !== 'closed');
    const p1 = open.filter((c) => c.priority === 'P1');
    let fixLine = '';
    try {
      const fixes = await api('/api/fixes');
      const tried = fixes.reduce((n, f) => n + f.success + f.fail, 0);
      const worked = fixes.reduce((n, f) => n + f.success, 0);
      fixLine = `<div class="stat"><div class="v">${fixes.filter((f) => f.source === 'field').length}</div><div class="k">${t('fixes learned from technicians')}</div></div>
        <div class="stat"><div class="v">${tried ? Math.round((worked / tried) * 100) + '%' : '—'}</div><div class="k">${t('of tried fixes worked ({worked} of {tried})', { worked, tried })}</div></div>`;
    } catch { /* optional */ }
    $('stats').innerHTML = `
      <div class="hero"><div class="v">${p1.length}</div><div class="k"><span class="mk ${p1.length ? 'critical' : 'good'}"></span>${p1.length === 1 ? t('pattern showing up on more than one machine') : t('patterns showing up on more than one machine')}</div></div>
      <div class="stat"><div class="v">${open.length}</div><div class="k">${t('open cases')}</div></div>
      <div class="stat"><div class="v">${state.cases.reduce((n, c) => n + c.occurrences, 0)}</div><div class="k">${t('field reports behind them')}</div></div>${fixLine}`;
  }

  function renderCases() {
    const f = state.filter;
    const list = state.cases.filter((c) => (f === 'all' ? true : f === 'open' ? c.status !== 'closed' : c.status === f));
    $('caseCount').textContent = `${list.length}`;
    $('cases').innerHTML = list.length ? list.map((c) => `<button class="case-item ${c.id === state.selected ? 'sel' : ''}" data-id="${c.id}">
      <div class="row spread">${prio(c.priority)}<span class="tag">${esc(t(STATUS_LABEL[c.status]))}</span></div>
      <div class="tt">${esc(c.title)}</div>
      <div class="mm">#${c.id} · ${c.occurrences === 1 ? t('1 report') : t('{n} reports', { n: c.occurrences })} · ${c.machines === 1 ? t('1 machine') : t('{n} machines', { n: c.machines })} · ${c.sites === 1 ? t('1 site') : t('{n} sites', { n: c.sites })} · ${ago(c.last_seen)}</div></button>`).join('')
      : `<div style="padding:0 18px">${emptyState({ icon: 'search', title: t('No cases marked “{status}”', { status: esc(t(STATUS_LABEL[f] || f)) }), body: t('Try “All cases” to see everything, including closed ones.') })}</div>`;
    $('cases').querySelectorAll('[data-id]').forEach((b) => b.onclick = () => { state.selected = Number(b.dataset.id); renderCases(); loadDetail(state.selected); const u = new URL(location.href); u.searchParams.set('case', state.selected); history.replaceState(null, '', u); });
  }

  async function loadDetail(id) {
    try { state.detail = await api(`/api/cases/${id}`); renderDetail(); }
    catch (err) { $('detail').innerHTML = emptyState({ icon: 'file', error: true, title: t('Case #{id} couldn’t be opened', { id }), body: esc(err.message) }); }
  }

  const bars = (rows, total, none) => rows.length
    ? rows.slice(0, 6).map((r) => `<div class="bar-row" title="${esc(t('{name}: {n} of {total} reports', { name: t(r.name), n: r.n, total }))}"><span class="lab">${esc(t(r.name))}</span><span class="bar"><i style="width:${Math.round((r.n / total) * 100)}%"></i></span><span class="val">${t('{n} of {total}', { n: r.n, total })}</span></div>`).join('')
    : `<div class="muted" style="font-size:13px;margin-top:6px">${none}</div>`;

  function renderDetail() {
    const d = state.detail; const c = d.case;
    const idx = STATUSES.indexOf(c.status);
    const total = d.reports.length;
    const sym = d.symptoms.filter((s) => s.name !== 'Warning / fault code');
    $('detail').innerHTML = `
      <div class="detail-head">
        <div class="row spread wrap"><span class="row" style="gap:8px">${prio(c.priority)}<span class="mono muted" style="font-size:12px">${t('case #{id}', { id: c.id })}</span>${c.engineer ? `<span class="muted" style="font-size:13px">· ${esc(c.engineer)}</span>` : `<span class="muted" style="font-size:13px">· ${t('unassigned')}</span>`}</span>
          <span class="mono faint" style="font-size:12px">${t('first {date}', { date: dateShort(c.first_seen) })} · ${t('latest {ago}', { ago: ago(c.last_seen) })}</span></div>
        <h2>${esc(c.title)}</h2>
        <div class="status-track">${STATUSES.map((s, i) => `<span class="${i === idx ? 'on' : i < idx ? 'past' : ''}">${t(STATUS_LABEL[s])}</span>`).join('')}</div>
      </div>
      <div class="evidence">
        <div><div class="sec-title">${t('Machines affected')}</div>${d.machines.map((m) => `<div class="mrow"><a class="id" href="/asset?id=${encodeURIComponent(m.id)}">${esc(m.id)}</a><span class="muted">${esc(m.site)}</span><span class="mono muted" style="font-size:12px">${t('{n} h', { n: m.hours.toLocaleString(CT.locale) })}</span></div>`).join('')}</div>
        <div><div class="sec-title">${t('Conditions when reported')}</div>${bars(d.conditions, total, t('Nobody mentioned heat, dust, grade or load.'))}</div>
        <div><div class="sec-title">${t('Codes and symptoms')}</div>${bars([...d.codes, ...sym], total, t('No fault codes reported.'))}</div>
      </div>

      <div class="analysis">
        <div class="row spread wrap"><span><b>${t('Root cause, from the evidence')}</b><span class="muted" style="font-size:13px"> · ${c.ai_analysis ? (c.ai_analysis_by && c.ai_analysis_by !== 'rules' ? t('written by {name}', { name: esc(c.ai_analysis_by) }) : t('counted by the rule engine')) : t('not analysed yet')}</span></span><button class="btn sm" id="analyzeBtn">${icon('search')} ${c.ai_analysis ? t('Read it again') : t('Read the evidence')}</button></div>
        <details class="dd" id="aiBox" style="margin-top:10px" ${analysisPendingFor === c.id || analysisOpen === c.id ? 'open' : ''}><summary><span>${c.ai_analysis ? t('Show the write-up') : t('What this does')}</span>${icon('chevron', 'chev')}</summary>
        <div class="md dd-body" id="aiText">${analysisPendingFor === c.id ? `<div class="muted" style="font-size:13px;margin-bottom:10px" id="aiPending">${t('{model} is reading all {n} reports; its write-up will replace this when it arrives.', { model: esc(analysisModel), n: total })}</div>` : ''}${c.ai_analysis ? md(c.ai_analysis) : `<span class="muted">${t('Reads all {n} reports, their conditions and fault codes, and every repair on these machines, then proposes a cause, a field fix and a design change.', { n: total })}</span>`}</div></details>
      </div>

      <div class="two">
        <div>
          <div class="sec-title">${t('From the field')} · ${total === 1 ? t('1 report') : t('{n} reports', { n: total })}</div>
          ${d.reports.map((r) => keyRow({
            tone: toneOf(r),
            title: `<a class="id" href="/asset?id=${encodeURIComponent(r.asset_id)}">${esc(r.asset_id)}</a> <span style="font-weight:500">${esc(r.site_name || '')}</span>`,
            meta: metaLine([dateShort(r.created_at), t('{n} h', { n: Math.round(r.smu_hours).toLocaleString(CT.locale) }), esc((r.extraction.conditions || []).map((x) => t(x)).join(', ').toLowerCase()), esc((r.extraction.fault_codes || []).join(', '))]),
            right: sevPill(r.severity),
            body: kv([
              [t('Said'), `<q>${esc(r.raw_text)}</q>`],
              [t('Reported by'), esc(`${r.person_name || t(SOURCE_LABEL[r.source])}${r.person_role ? ', ' + t(ROLE[r.person_role]).toLowerCase() : ''}`)],
              [t('Photo'), r.photo_path ? `<img src="${esc(r.photo_path)}" alt="${esc(t('Photo from the field'))}" style="max-width:160px;border-radius:3px;border:1px solid var(--line)">` : ''],
            ]),
          })).join('')}
        </div>
        <div>
          <div class="sec-title">${t('Fixes tried, ranked by field results')}</div>
          ${d.fixes.length ? d.fixes.map((f) => `<div class="fix-row"><div class="row spread" style="align-items:flex-start;gap:12px"><b style="font-weight:600">${esc(f.title)}</b><span class="tag ${f.source === 'engineering' ? 'cat' : ''}">${f.source === 'engineering' ? 'CAT' : t('field')}</span></div>
            <div class="conf" title="${esc(t('{pct}% estimated success', { pct: f.confidence }))}"><i style="width:${f.confidence}%"></i></div><div class="muted" style="font-size:12px;margin-top:5px">${t('Worked {n} of {total} times', { n: f.success, total: f.success + f.fail })} · ${esc(f.author || t('unknown'))}</div></div>`).join('')
            : emptyState({ icon: 'wrench', title: t('No fix on record yet'), body: t('The first technician to log a repair for this will create one, and every later result will re-rank it.') })}
          ${d.repairs.length ? `<div class="sec-title" style="margin-top:22px">${t('Recent repairs on these machines')}</div>${d.repairs.slice(0, 4).map((r) => keyRow({ tone: 'repair', title: esc(r.asset_id), meta: dateShort(r.created_at), body: `<div style="font-size:14px;color:var(--ink-2)">${esc(r.raw_text)}</div>` })).join('')}` : ''}
          ${c.quick_fix ? `<div class="card" style="margin-top:18px;box-shadow:inset 4px 0 0 var(--cat)"><div class="sec-title" style="margin:0 0 4px">${t('In the field now')}</div>${esc(c.quick_fix)}</div>` : ''}
          ${c.product_action ? `<div class="card" style="margin-top:10px"><div class="sec-title" style="margin:0 0 4px">${t('Design change planned')}</div>${esc(c.product_action)}${c.root_cause ? `<div class="muted" style="font-size:13px;margin-top:6px">${t('Cause: {cause}', { cause: esc(c.root_cause) })}</div>` : ''}</div>` : ''}
          <div class="sec-title" style="margin-top:22px">${t('Next step')}</div>
          <div class="actions-bar">
            <button class="btn primary" id="qfBtn">${icon('send')} ${t('Send a quick fix to the field')}</button>
            <button class="btn" id="puBtn">${icon('file')} ${t('Log a design change')}</button>
            ${c.status === 'new' ? `<button class="btn" data-st="investigating">${t('Take this case')}</button>` : ''}
            ${c.status !== 'closed' ? `<button class="btn ghost" data-st="closed">${t('Close case')}</button>` : `<button class="btn ghost" data-st="investigating">${t('Reopen')}</button>`}
          </div>
        </div>
      </div>`;
    $('analyzeBtn').onclick = analyze;
    $('qfBtn').onclick = quickFixDialog;
    $('puBtn').onclick = productDialog;
    $('detail').querySelectorAll('[data-st]').forEach((b) => b.onclick = () => setStatus(b.dataset.st));
  }

  async function analyze() {
    const btn = $('analyzeBtn'); btn.disabled = true; btn.textContent = t('Reading…');
    $('aiBox').open = true;
    $('aiText').innerHTML = `${skeleton(4)}`;
    try {
      const out = await api(`/api/cases/${state.selected}/analyze`, { body: {} });
      analysisOpen = state.selected;
      $('aiBox').open = true;
      $('aiText').innerHTML = md(out.analysis) + (out.pending ? `<div class="muted" style="font-size:13px;margin-top:10px;border-top:1px dashed var(--line-strong);padding-top:8px" id="aiPending">${t('That’s the rule engine’s count. {model} is reading all {n} reports for a root cause; its write-up will replace this, usually within a minute.', { model: esc(out.model), n: state.detail.reports.length })}</div>` : '');
      analysisPendingFor = out.pending ? state.selected : null;
      analysisModel = out.model;
      btn.innerHTML = `${icon('search')} ${t('Read it again')}`;
    } catch (err) { $('aiText').innerHTML = emptyState({ icon: 'wifiOff', error: true, title: t('Analysis failed'), body: esc(err.message) }); btn.innerHTML = `${icon('search')} ${t('Try again')}`; }
    btn.disabled = false;
  }

  function quickFixDialog() {
    const c = state.detail.case; const best = state.detail.fixes[0];
    const m = modal(`<h2>${t('Send a quick fix to the field')}</h2>
      <p class="muted">${t('Every job site running a {model} gets an alert, and each of those machines gets a task for its technician. Their results feed back into this fix’s record.', { model: esc(c.model) })}</p>
      <label class="lbl" style="margin-top:14px">${t('The fix, in one line')}</label><input class="input" id="qfTitle" value="${esc(best ? best.title : '')}" placeholder="${esc(t('What the technician should do'))}">
      <label class="lbl" style="margin-top:14px">${t('Steps')}</label><textarea class="textarea" id="qfSteps" placeholder="${esc(t("Step by step, as you'd say it to a technician"))}">${esc(best?.steps || '')}</textarea>
      <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn ghost" id="qfCancel">${t('Cancel')}</button><button class="btn primary" id="qfGo">${icon('send')} ${t('Send to every {model} site', { model: esc(c.model) })}</button></div>`);
    m.el.querySelector('#qfCancel').onclick = m.close;
    m.el.querySelector('#qfGo').onclick = async () => {
      const title = m.el.querySelector('#qfTitle').value.trim();
      if (!title) { toast(t('Write the fix in one line first.'), 'high'); return; }
      try {
        const out = await api(`/api/cases/${c.id}/quick-fix`, { body: { title, steps: m.el.querySelector('#qfSteps').value.trim(), engineer: me() } });
        m.close(); toast(out.sitesNotified === 1 ? t('Sent to 1 job site. Crews will see it on their phones now.') : t('Sent to {n} job sites. Crews will see it on their phones now.', { n: out.sitesNotified }), 'good'); loadCases();
      } catch (err) { toast(esc(err.message), 'high'); }
    };
  }

  function productDialog() {
    const c = state.detail.case;
    const m = modal(`<h2>${t('Log a design change')}</h2>
      <p class="muted">${t('For the permanent fix. Fleet managers at affected sites are told it’s coming.')}</p>
      <label class="lbl" style="margin-top:14px">${t('Cause')}</label><input class="input" id="puRoot" value="${esc(c.root_cause || '')}" placeholder="${esc(t('Hose rubs on the boom-foot bracket as the boom articulates'))}">
      <label class="lbl" style="margin-top:14px">${t('Change')}</label><textarea class="textarea" id="puAct" placeholder="${esc(t('Revise bracket geometry and hose routing on new builds; retrofit kit for machines in the field'))}">${esc(c.product_action || '')}</textarea>
      <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn ghost" id="puCancel">${t('Cancel')}</button><button class="btn primary" id="puGo">${t('Save')}</button></div>`);
    m.el.querySelector('#puCancel').onclick = m.close;
    m.el.querySelector('#puGo').onclick = async () => {
      const product_action = m.el.querySelector('#puAct').value.trim();
      if (!product_action) { toast(t('Describe the change first.'), 'high'); return; }
      try {
        await api(`/api/cases/${c.id}/status`, { body: { status: 'product_update', engineer: me(), product_action, root_cause: m.el.querySelector('#puRoot').value.trim() } });
        m.close(); toast(t('Saved. Fleet managers on affected sites have been told.'), 'good'); loadCases();
      } catch (err) { toast(esc(err.message), 'high'); }
    };
  }

  let analysisPendingFor = null; let analysisModel = ''; let analysisOpen = null;

  async function setStatus(status) {
    try { await api(`/api/cases/${state.selected}/status`, { body: { status, engineer: me() } }); loadCases(); } catch (err) { toast(esc(err.message), 'high'); }
  }

  let reloadTimer = null;
  connectStream({
    case: ({ case: c, reportId, analysis, error }) => {
      if (analysis && c.id === analysisPendingFor) {
        analysisPendingFor = null;
        toast(analysis === 'llm' ? t('{model} finished its root-cause write-up for case #{id}.', { model: esc(c.ai_analysis_by), id: c.id }) : t('The AI write-up for case #{id} didn’t come back ({error}). The rule engine’s count stays.', { id: c.id, error: esc(error || t('no response')) }), analysis === 'llm' ? 'good' : 'high');
      }
      if (analysis === 'failed' && c.id === state.selected) { const p = document.getElementById('aiPending'); if (p) p.textContent = t('The AI write-up didn’t come back ({error}). Showing the rule engine’s count.', { error: error || t('no response') }); return; }
      clearTimeout(reloadTimer); reloadTimer = setTimeout(loadCases, 300);
      if (reportId) toast(t('New report on <b>case #{id}</b>, {title}. That’s {n} now.', { id: c.id, title: esc(c.title), n: c.occurrences }), c.priority === 'P1' ? 'high' : '');
    },
    fix: () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(loadCases, 300); },
    'case-removed': ({ id }) => {
      if (state.selected === id) { state.selected = null; toast(t('Case #{id} was removed: the only report behind it was deleted.', { id })); }
      clearTimeout(reloadTimer); reloadTimer = setTimeout(loadCases, 300);
    },
  }, $('live'));

  boot().catch((err) => { $('detail').innerHTML = emptyState({ icon: 'wifiOff', error: true, title: t('Couldn’t load the engineering view'), body: esc(err.message) }); });
})();
