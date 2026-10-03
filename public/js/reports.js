// Reports: the log of every report across the fleet, newest first. New reports drop in live.
// Each report can be opened to read, edit (headline, urgency, part, problem, type, words), annotate
// with notes, or delete (with undo). Deleted reports wait in their own tab and can be restored.
(function () {
  const { api, esc, ago, dateShort, dateTime, sevPill, toast, undoBar, connectStream, store, topbar, icon, emptyState, skeleton, ROLE, SOURCE_LABEL, REPORT_STATUS, ISSUES, problemOf, kv, clip, t } = CT;
  const $ = (id) => document.getElementById(id);
  $('top').innerHTML = topbar('/reports');
  $('qIcon').outerHTML = icon('search');

  const params = new URLSearchParams(location.search);
  const state = {
    tab: params.get('tab') === 'deleted' ? 'deleted' : 'record',
    q: params.get('q') || '', site: params.get('site') || '', asset: (params.get('asset') || '').toUpperCase(), person: params.get('person') || '',
    kind: ISSUES[params.get('kind')] ? params.get('kind') : '', openOnly: params.get('status') === 'open',
    items: [], next: null, total: 0, counts: {}, deletedCount: 0, deleted: [], people: [], assets: [], sites: [], vocab: null,
    open: new Set(), editing: null, seen: new Set(), fresh: new Set(), seq: 0, pending: 0,
  };
  const me = () => state.people.find((p) => p.id === $('me').value) || null;
  const SEV = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

  function syncUrl() {
    const u = new URL(location.href);
    for (const k of ['q', 'site', 'asset', 'person', 'kind']) { if (state[k]) u.searchParams.set(k, state[k]); else u.searchParams.delete(k); }
    if (state.openOnly) u.searchParams.set('status', 'open'); else u.searchParams.delete('status');
    if (state.tab === 'deleted') u.searchParams.set('tab', 'deleted'); else u.searchParams.delete('tab');
    history.replaceState(null, '', u);
  }

  /* ---------- filters ---------- */
  function renderKinds() {
    const on = state.tab === 'record';
    $('kinds').style.display = on ? '' : 'none';
    $('openWrap').style.display = on ? '' : 'none';
    if (!on) return;
    const all = Object.values(state.counts).reduce((a, b) => a + b, 0);
    $('kinds').innerHTML = `<button class="chip ${!state.kind ? 'on' : ''}" type="button" data-k="">${t('All')}<span class="n">${all}</span></button>`
      + Object.entries(ISSUES).map(([k, is]) => `<button class="chip ${state.kind === k ? 'on' : ''}" type="button" data-k="${k}" title="${esc(t(is.hint))}"><span class="ic">${icon(is.icon)}</span>${esc(t(is.label))}<span class="n">${state.counts[k] || 0}</span></button>`).join('');
  }
  $('kinds').addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (!b) return; state.kind = b.dataset.k; reload(); });
  $('openOnly').checked = state.openOnly;
  $('openOnly').onchange = () => { state.openOnly = $('openOnly').checked; reload(); };
  function renderAssetOptions() {
    const list = state.assets.filter((a) => !state.site || a.site_id === state.site);
    $('asset').innerHTML = `<option value="">${t('All machines')}</option>${list.map((a) => `<option value="${esc(a.id)}">${esc(a.id)} · ${esc(a.model)}</option>`).join('')}`;
    if (state.asset && !list.some((a) => a.id === state.asset)) state.asset = '';
    $('asset').value = state.asset;
  }
  async function loadFilters() {
    const [sites, assets, people, vocab] = await Promise.all([api('/api/sites'), api('/api/assets'), api('/api/people'), api('/api/vocab')]);
    Object.assign(state, { assets, people, sites, vocab });
    $('site').innerHTML = `<option value="">${t('All sites')}</option>${sites.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}`;
    $('site').value = state.site;
    renderAssetOptions();
    const crew = people.filter((p) => p.role !== 'cat_engineer');
    $('person').innerHTML = `<option value="">${t('Anyone')}</option>${crew.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} · ${esc(t(ROLE[p.role] || p.role))}</option>`).join('')}`;
    $('person').value = state.person;
    $('me').innerHTML = people.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} · ${esc(t(ROLE[p.role] || p.role))}</option>`).join('');
    const saved = store.get('logMe');
    $('me').value = people.some((p) => p.id === saved) ? saved : (people.find((p) => p.role === 'site_manager') || people[0])?.id || '';
  }
  $('me').onchange = () => store.set('logMe', $('me').value);
  let typeTimer = null;
  $('q').value = state.q;
  $('q').addEventListener('input', () => { clearTimeout(typeTimer); typeTimer = setTimeout(() => { state.q = $('q').value.trim(); reload(); }, 250); });
  $('site').onchange = () => { state.site = $('site').value; renderAssetOptions(); reload(); };
  $('asset').onchange = () => { state.asset = $('asset').value; reload(); };
  $('person').onchange = () => { state.person = $('person').value; reload(); };
  document.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { state.tab = b.dataset.tab; state.editing = null; renderTabs(); reload(); });
  function renderTabs() { document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab)); }

  /* ---------- data ---------- */
  const filtersOn = () => Boolean(state.q || state.site || state.asset || state.person || state.kind || state.openOnly);
  async function reload({ more = false, keep = false } = {}) {
    syncUrl();
    const seq = ++state.seq;
    if (!more && !keep) $('list').innerHTML = skeleton(5, 'block');
    try {
      if (state.tab === 'record') {
        const qs = new URLSearchParams({ limit: String(keep ? Math.max(30, state.items.length) : 30) });
        for (const [k, v] of [['q', state.q], ['site', state.site], ['asset', state.asset], ['person', state.person], ['kind', state.kind]]) if (v) qs.set(k, v);
        if (state.openOnly) qs.set('status', 'open');
        if (more && state.next) qs.set('before', state.next);
        const page = await api(`/api/reports/log?${qs}`);
        if (seq !== state.seq) return;
        state.items = more ? [...state.items, ...page.reports] : page.reports;
        Object.assign(state, { next: page.next, total: page.total, deletedCount: page.deleted, counts: page.counts || {} });
        // Highlight reports that arrived live; not ones that appear because a filter changed.
        state.fresh = keep && state.seen.size ? new Set(page.reports.map((r) => r.id).filter((id) => !state.seen.has(id))) : new Set();
        for (const r of page.reports) state.seen.add(r.id);
        if (state.fresh.size) setTimeout(() => { state.fresh.clear(); document.querySelectorAll('tbody.rec.fresh').forEach((el) => el.classList.remove('fresh')); }, 2800);
      } else {
        const qs = new URLSearchParams({ limit: '100' });
        if (state.asset) qs.set('asset', state.asset); else if (state.site) qs.set('site', state.site);
        const rows = await api(`/api/reports/deleted?${qs}`);
        if (seq !== state.seq) return;
        const term = state.q.toLowerCase();
        const who = state.people.find((p) => p.id === state.person)?.name;
        state.deleted = rows.filter((t) => (!term || `${t.summary} ${t.raw_text} ${t.asset_id} ${t.person_name || ''}`.toLowerCase().includes(term)) && (!who || t.person_name === who));
        state.deletedCount = rows.length;
      }
      state.pending = 0; $('pendingBar').classList.add('hidden');
      render();
    } catch (err) {
      if (seq !== state.seq) return;
      $('list').innerHTML = emptyState({ icon: 'wifiOff', error: true, title: t('Couldn’t load reports'), body: esc(err.message), action: `<button class="btn sm" id="retry">${t('Try again')}</button>` });
      $('retry')?.addEventListener('click', () => reload());
    }
  }

  /* ---------- rows ---------- */
  const siteName = (r) => r.site_name || state.sites.find((x) => x.id === r.site_id)?.name || '';
  const modelOf = (r) => r.model || state.assets.find((a) => a.id === r.asset_id)?.model || '';
  const isProblem = (r) => ['mechanical', 'safety'].includes(r.category);
  const kindTag = (r) => (isProblem(r) ? sevPill(r.severity) : `<span class="tag">${r.category === 'maintenance' ? t('repair') : r.source === 'telemetry' ? t('sensor') : t('note')}</span>`);
  function row(key, cells, more, cls = '') {
    const open = state.open.has(key);
    return `<tbody class="rec ${cls} ${open ? 'open' : ''}" data-key="${esc(key)}">
      <tr class="main" tabindex="0" aria-expanded="${open}">${cells}<td class="tog">${icon('chevron', 'chev')}</td></tr>
      <tr class="more"><td colspan="7">${more}</td></tr></tbody>`;
  }
  const notesBlock = (r) => `<div class="notes"><h4>${t('Notes')}${r.notes?.length ? ` · ${r.notes.length}` : ''}</h4>
    ${(r.notes || []).map((n) => `<div class="note"><div><div class="by">${esc(n.person_name || t('Someone'))} · <span title="${esc(dateTime(n.created_at))}">${esc(ago(n.created_at))}</span></div><div class="txt">${esc(n.text)}</div></div><button class="btn ghost sm" type="button" data-del-note="${n.id}" data-report="${r.id}" aria-label="${esc(t('Delete this note'))}">${icon('x')}</button></div>`).join('')}
    <form class="note-form" data-note-form="${r.id}"><textarea class="textarea" name="text" rows="1" maxlength="1000" placeholder="${esc(t('Add a note for the crew or the technician…'))}" aria-label="${esc(t('New note'))}"></textarea><button class="btn sm" type="submit">${t('Add note')}</button></form></div>`;
  function viewBlock(r) {
    const p = problemOf(r);
    const last = r.extraction?.edits?.slice(-1)[0];
    return kv([
      [t('Said'), `<q>${esc(r.raw_text)}</q>`],
      [t('Summary'), r.summary !== p.title ? esc(r.summary) : ''],
      [t('Type'), esc(t((ISSUES[r.issue] || ISSUES.note).label)) + (r.extraction?.issue_override ? ` <span class="faint">${t('(set by hand)')}</span>` : '')],
      [t('Fault code'), esc((r.extraction?.fault_codes || []).join(', '))],
      [t('Conditions'), esc((r.extraction?.conditions || []).map((c) => t(c)).join(', '))],
      [t('Reported by'), esc([r.person_name ? `${r.person_name}${r.person_role ? `, ${t(ROLE[r.person_role] || r.person_role).toLowerCase()}` : ''}` : '', t(SOURCE_LABEL[r.source] || r.source).toLowerCase(), dateTime(r.created_at)].filter(Boolean).join(' · '))],
      [t('What to do'), isProblem(r) ? esc(r.extraction?.operator_guidance || '') : ''],
    ]) + (last ? `<div class="edited">${last.by_name ? t('Edited {ago} by {name}', { ago: esc(ago(last.at)), name: esc(last.by_name) }) : t('Edited {ago}', { ago: esc(ago(last.at)) })} · ${esc(last.fields.join(', '))}</div>` : '')
      + `<div class="detail-actions"><button class="btn sm" type="button" data-edit="${r.id}">${icon('note')} ${t('Edit')}</button><button class="btn sm ghost" type="button" data-rm="${r.id}">${icon('x')} ${t('Delete')}</button></div>`
      + notesBlock(r);
  }
  function editBlock(r) {
    const v = state.vocab || { components: [], symptoms: [] };
    const part = r.extraction?.components?.[0] || '';
    const problem = (r.extraction?.symptoms || []).find((x) => x !== 'Warning / fault code') || '';
    const auto = ISSUES[r.issue] && !r.extraction?.issue_override ? ` (${t('now: {label}', { label: t(ISSUES[r.issue].label) })})` : '';
    return `<form class="edit-form" data-edit-form="${r.id}">
      <div class="edit-grid">
        <div class="two"><label class="lbl" for="e-sum-${r.id}">${t('Headline')}</label><input class="input" id="e-sum-${r.id}" name="summary" maxlength="140" value="${esc(r.summary)}" required></div>
        <div><label class="lbl" for="e-sev-${r.id}">${t('Urgency')}</label><select class="select" id="e-sev-${r.id}" name="severity">${Object.entries(SEV).map(([k, l]) => `<option value="${k}" ${r.severity === k ? 'selected' : ''}>${esc(t(l))}</option>`).join('')}</select></div>
        <div><label class="lbl" for="e-part-${r.id}">${t('Part')}</label><input class="input" id="e-part-${r.id}" name="part" list="partList" value="${esc(part)}" placeholder="${esc(t('None'))}"></div>
        <div><label class="lbl" for="e-prob-${r.id}">${t('Problem')}</label><input class="input" id="e-prob-${r.id}" name="problem" list="problemList" value="${esc(problem)}" placeholder="${esc(t('None'))}"></div>
        <div><label class="lbl" for="e-iss-${r.id}">${t('Type of issue')}</label><select class="select" id="e-iss-${r.id}" name="issue"><option value="auto">${t('Automatic')}${esc(auto)}</option>${Object.entries(ISSUES).map(([k, is]) => `<option value="${k}" ${r.extraction?.issue_override === k ? 'selected' : ''}>${esc(t(is.label))}</option>`).join('')}</select></div>
        <div class="full"><label class="lbl" for="e-raw-${r.id}">${t('What was said')}</label><textarea class="textarea" id="e-raw-${r.id}" name="raw_text" maxlength="4000" required>${esc(r.raw_text)}</textarea></div>
      </div>
      <datalist id="partList">${v.components.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist>
      <datalist id="problemList">${v.symptoms.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist>
      <div class="detail-actions"><button class="btn sm primary" type="submit">${t('Save changes')}</button><button class="btn sm ghost" type="button" data-cancel-edit>${t('Cancel')}</button><span class="muted" style="font-size:13px;align-self:center">${t('A new part or problem re-links the report on the graph.')}</span></div>
    </form>`;
  }
  function recordRow(r) {
    const p = problemOf(r);
    const is = ISSUES[r.issue] || ISSUES.note;
    const fresh = state.fresh.has(r.id);
    return row(`r${r.id}`, `
      <td class="when" title="${esc(dateTime(r.created_at))}">${dateShort(r.created_at)}<span class="ago">${ago(r.created_at)}</span></td>
      <td class="unit"><a class="id" href="/asset?id=${encodeURIComponent(r.asset_id)}">${esc(r.asset_id)}</a><span class="m">${esc(modelOf(r))}</span></td>
      <td class="loc">${esc(siteName(r))}</td>
      <td class="what"><b><span class="iss" title="${esc(t(is.label))}">${icon(is.icon)}</span>${esc(p.title)}${r.notes?.length ? `<span class="nb" title="${esc(r.notes.length === 1 ? t('1 note') : t('{n} notes', { n: r.notes.length }))}">${icon('chat')}${r.notes.length}</span>` : ''}</b></td>
      <td class="pri">${kindTag(r)}</td>
      <td class="st"><span class="rep-status ${esc(r.status)}"><i></i>${esc(t(REPORT_STATUS[r.status] || r.status))}</span></td>`,
      state.editing === r.id ? editBlock(r) : viewBlock(r),
      `${r.status === 'withdrawn' ? 'withdrawn' : ''} ${fresh ? 'fresh' : ''}`);
  }
  function deletedRow(d) {
    const p = problemOf(d);
    return row(`d${d.id}`, `
      <td class="when" title="${esc(dateTime(d.deleted_at))}">${dateShort(d.deleted_at)}<span class="ago">${t('deleted {ago}', { ago: ago(d.deleted_at) })}</span></td>
      <td class="unit"><a class="id" href="/asset?id=${encodeURIComponent(d.asset_id)}">${esc(d.asset_id)}</a><span class="m">${esc(modelOf(d))}</span></td>
      <td class="loc">${esc(siteName(d))}</td>
      <td class="what"><b>${esc(p.title)}</b></td>
      <td class="pri">${kindTag(d)}</td>
      <td class="st">${esc(d.deleted_by_name || t('Someone'))}<span class="m">${d.via === 'voice' ? t('by voice') : t('by hand')}</span></td>`,
      kv([
        [t('Said'), `<q>${esc(d.raw_text || '')}</q>`],
        [t('Why deleted'), d.reason ? `<q>${esc(d.reason)}</q>` : ''],
        [t('Reported by'), esc([d.person_name, dateTime(d.created_at)].filter(Boolean).join(' · '))],
      ]) + `<div class="detail-actions"><button class="btn sm" type="button" data-restore="${d.id}">${icon('history')} ${t('Restore')}</button><span class="muted" style="font-size:13px;align-self:center">${t('Brings back its alert, case link, notes and graph links.')}</span></div>`);
  }
  function render() {
    renderTabs(); renderKinds();
    $('nRecord').textContent = state.tab === 'record' ? state.total.toLocaleString(CT.locale) : '';
    $('nDeleted').textContent = state.deletedCount ? String(state.deletedCount) : '';
    if (state.tab === 'record') {
      $('list').innerHTML = state.items.length
        ? `<table class="log"><thead><tr><th>${t('When')}</th><th>${t('Machine')}</th><th>${t('Location')}</th><th>${t('Problem')}</th><th>${t('Priority')}</th><th>${t('Now')}</th><th></th></tr></thead>${state.items.map(recordRow).join('')}</table>`
        : filtersOn() ? emptyState({ icon: 'search', title: t('No reports match'), body: t('Try fewer words, or clear the filters.'), action: `<button class="btn sm" id="clear">${t('Clear filters')}</button>` })
          : emptyState({ icon: 'mic', title: t('Nothing on record yet'), body: t('Reports from the operator screen, sensor alarms and repairs land here.'), action: `<a href="/operator">${t('Open the operator screen')}</a>` });
      $('foot').innerHTML = state.items.length ? `<span>${t('{shown} of {total}', { shown: state.items.length.toLocaleString(CT.locale), total: state.total.toLocaleString(CT.locale) })}</span>${state.next ? `<button class="btn sm" id="older">${t('Load older reports')}</button>` : ''}` : '';
    } else {
      $('list').innerHTML = state.deleted.length
        ? `<table class="log"><thead><tr><th>${t('Deleted')}</th><th>${t('Machine')}</th><th>${t('Location')}</th><th>${t('Problem')}</th><th>${t('Priority')}</th><th>${t('By')}</th><th></th></tr></thead>${state.deleted.map(deletedRow).join('')}</table>`
        : emptyState({ icon: 'check', title: filtersOn() ? t('No deleted reports match') : t('Nothing has been deleted'), body: t('Deleted reports wait here and can be restored.') });
      $('foot').innerHTML = '';
    }
    $('older')?.addEventListener('click', (e) => { e.currentTarget.disabled = true; reload({ more: true }); });
    $('clear')?.addEventListener('click', () => { Object.assign(state, { q: '', site: '', asset: '', person: '', kind: '', openOnly: false }); $('q').value = ''; $('site').value = ''; $('person').value = ''; $('openOnly').checked = false; renderAssetOptions(); reload(); });
    if (state.editing) document.querySelector(`[data-edit-form="${state.editing}"] input[name="summary"]`)?.focus();
  }

  /* ---------- interactions ---------- */
  const toggle = (main) => {
    const rec = main.closest('tbody.rec');
    const open = rec.classList.toggle('open');
    main.setAttribute('aria-expanded', String(open));
    if (open) state.open.add(rec.dataset.key); else state.open.delete(rec.dataset.key);
  };
  const restore = async (ids) => { await api('/api/reports/restore', { body: { ids, personId: me()?.id } }); toast(t('Put back on the record.'), 'good'); };
  const findItem = (id) => state.items.find((r) => r.id === Number(id));
  function patchItem(report) {
    const i = state.items.findIndex((r) => r.id === report.id);
    if (i >= 0) state.items[i] = { ...state.items[i], ...report };
  }
  $('list').addEventListener('keydown', (e) => {
    const main = e.target.closest('tr.main');
    if (main && e.target === main && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(main); }
  });
  $('list').addEventListener('click', async (e) => {
    const main = e.target.closest('tr.main');
    if (main && !e.target.closest('a')) { toggle(main); return; }
    const ed = e.target.closest('[data-edit]');
    if (ed) { state.editing = Number(ed.dataset.edit); render(); return; }
    if (e.target.closest('[data-cancel-edit]')) { state.editing = null; render(); flushPending(); return; }
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      const id = Number(rm.dataset.rm);
      const rec = rm.closest('tbody'); rec.classList.add('gone'); rm.disabled = true;
      try {
        const r = await api('/api/reports/delete', { body: { ids: [id], personId: me()?.id, via: 'manual' } });
        const extra = r.did.filter((d) => d.kind !== 'deleted').length;
        const title = esc(clip(problemOf(r.deleted[0]).title, 60));
        undoBar(!extra ? t('Deleted “{title}”.', { title }) : extra === 1 ? t('Deleted “{title}” and undid 1 thing it caused.', { title }) : t('Deleted “{title}” and undid {n} things it caused.', { title, n: extra }), () => restore([id]));
      } catch (err) { rec.classList.remove('gone'); rm.disabled = false; toast(esc(err.message), 'high'); }
      return;
    }
    const rs = e.target.closest('[data-restore]');
    if (rs) {
      rs.disabled = true; rs.closest('tbody').classList.add('gone');
      try { await restore([Number(rs.dataset.restore)]); } catch (err) { rs.disabled = false; rs.closest('tbody').classList.remove('gone'); toast(esc(err.message), 'high'); }
      return;
    }
    const dn = e.target.closest('[data-del-note]');
    if (dn) {
      dn.disabled = true;
      try {
        const out = await api(`/api/reports/${dn.dataset.report}/notes/${dn.dataset.delNote}`, { method: 'DELETE' });
        const r = findItem(dn.dataset.report); if (r) { r.notes = out.notes; render(); }
      } catch (err) { dn.disabled = false; toast(esc(err.message), 'high'); }
    }
  });
  $('list').addEventListener('submit', async (e) => {
    const nf = e.target.closest('[data-note-form]');
    if (nf) {
      e.preventDefault();
      const text = nf.text.value.trim();
      if (!text) { nf.text.focus(); return; }
      const btn = nf.querySelector('button'); btn.disabled = true;
      try {
        const out = await api(`/api/reports/${nf.dataset.noteForm}/notes`, { body: { text, personId: me()?.id } });
        const r = findItem(nf.dataset.noteForm); if (r) r.notes = out.notes;
        render(); flushPending();
        toast(t('Note added.'), 'good');
      } catch (err) { btn.disabled = false; toast(esc(err.message), 'high'); }
      return;
    }
    const ef = e.target.closest('[data-edit-form]');
    if (ef) {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(ef).entries());
      const btn = ef.querySelector('button[type="submit"]'); btn.disabled = true;
      try {
        const out = await api(`/api/reports/${ef.dataset.editForm}`, { method: 'PATCH', body: { ...body, personId: me()?.id } });
        state.editing = null;
        patchItem(out.report);
        render(); flushPending();
        toast(out.changed.length ? t('Saved: {fields}.', { fields: esc(out.changed.join(', ')) }) : t('Nothing changed.'), out.changed.length ? 'good' : '');
      } catch (err) { btn.disabled = false; toast(esc(err.message), 'high'); }
    }
  });
  // Enter adds a note; Shift+Enter makes a new line.
  $('list').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && e.target.matches('.note-form textarea')) { e.preventDefault(); e.target.form.requestSubmit(); }
  });

  /* ---------- live ---------- */
  // Never re-draw the list under someone who is editing or writing a note; offer the update instead.
  const busy = () => state.editing != null || [...document.querySelectorAll('.note-form textarea')].some((t) => t.value.trim() || t === document.activeElement);
  function flushPending() { if (state.pending) reload({ keep: true }); }
  let softTimer = null;
  const soft = () => {
    clearTimeout(softTimer);
    softTimer = setTimeout(() => {
      if (!busy()) { reload({ keep: true }); return; }
      state.pending += 1;
      const bar = $('pendingBar');
      bar.innerHTML = `<span>${t('New activity in the log.')}</span><button class="btn sm" type="button" id="applyPending">${t('Show it')}</button>`;
      bar.classList.remove('hidden');
      $('applyPending').onclick = () => { state.editing = null; reload({ keep: true }); };
    }, 300);
  };
  connectStream({
    report: ({ report }) => { if (state.tab === 'record') toast(`${t('New report')} · <span class="id">${esc(report.asset_id)}</span> ${esc(problemOf(report).title)}`); soft(); },
    'report-updated': soft, 'report-deleted': soft, 'report-restored': soft, 'report-note': soft,
    hello: () => { if (state.items.length || state.deleted.length) soft(); },
  }, $('live'));

  renderTabs();
  $('list').innerHTML = skeleton(5, 'block');
  loadFilters().catch(() => toast(t('Couldn’t load the filter lists'), 'high')).finally(() => reload());
})();
