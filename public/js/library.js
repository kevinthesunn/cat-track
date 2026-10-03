// Product library: engineers add spec sheets, policies and bulletins; the document agent maps them
// into the knowledge graph and this page shows what it did, step by step.
(function () {
  const { api, esc, ago, dateShort, toast, connectStream, store, topbar, icon, emptyState, skeleton, t } = CT;
  const $ = (id) => document.getElementById(id);
  document.getElementById('top').innerHTML = topbar('/library');
  $('dropIcon').outerHTML = icon('file');

  const TYPE = { spec_sheet: 'Spec sheet', policy: 'Policy', service_bulletin: 'Service bulletin', manual: 'Manual', other: 'Document' };
  const NODE = { model: 'Product', component: 'Part', spec: 'Spec', procedure: 'Service interval', code: 'Fault code', policy: 'Policy', hazard: 'Hazard', condition: 'Condition' };
  const state = { docs: [], selected: Number(new URLSearchParams(location.search).get('doc')) || null, detail: null, file: null };

  $('docs').innerHTML = `<div style="padding:12px 18px">${skeleton(3, 'block')}</div>`;
  $('detail').innerHTML = `<span class="sk line" style="width:30%"></span><span class="sk title" style="height:34px;margin-top:12px"></span>${skeleton(6)}`;

  // ---------- form ----------
  async function bootForm() {
    const [people, assets] = await Promise.all([api('/api/people'), api('/api/assets')]);
    const eng = people.filter((p) => p.role === 'cat_engineer');
    $('uploader').innerHTML = eng.map((p) => `<option value="${p.id}">${esc(p.name)}, ${esc((p.specialty || '').toLowerCase())}</option>`).join('');
    $('uploader').value = store.get('uploader', eng[0]?.id);
    $('uploader').onchange = () => store.set('uploader', $('uploader').value);
    $('models').innerHTML = [...new Set(assets.map((a) => a.model))].map((m) => `<option value="${esc(m)}">`).join('');
  }
  const fmtSize = (b) => (b > 1e6 ? t('{n} MB', { n: (b / 1e6).toFixed(1) }) : t('{n} KB', { n: Math.max(1, Math.round(b / 1e3)) }));
  function pick(file) {
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { toast(t('That file is over 15 MB.'), 'high'); return; }
    state.file = file;
    $('picked').innerHTML = `${icon('file')}<span class="grow">${esc(file.name)}</span><span class="mono muted">${fmtSize(file.size)}</span><button class="btn sm ghost" id="unpick" aria-label="${t('Remove file')}">${icon('x')}</button>`;
    $('picked').classList.remove('hidden');
    $('unpick').onclick = (e) => { e.preventDefault(); state.file = null; $('file').value = ''; $('picked').classList.add('hidden'); $('go').disabled = true; };
    $('go').disabled = false;
    if (/polic/i.test(file.name)) $('docType').value = 'policy';
    else if (/bulletin|sb-/i.test(file.name)) $('docType').value = 'service_bulletin';
    else if (/spec/i.test(file.name)) $('docType').value = 'spec_sheet';
  }
  $('file').onchange = (e) => pick(e.target.files[0]);
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => pick(e.dataTransfer.files[0]));

  const toBase64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error(t('Could not read the file')));
    r.readAsDataURL(file);
  });
  async function upload(file, docType, product) {
    $('go').disabled = true; $('go').textContent = t('Uploading…');
    try {
      const doc = await api('/api/documents', { body: { filename: file.name, data: await toBase64(file), docType, product, uploadedBy: $('uploader').value } });
      state.selected = doc.id;
      state.docs = [doc, ...state.docs.filter((d) => d.id !== doc.id)];
      renderList(); showDetail(doc);
      state.file = null; $('file').value = ''; $('picked').classList.add('hidden'); $('product').value = '';
      toast(t('Added. The document agent is reading it now.'), 'good');
    } catch (err) {
      toast(t('Couldn’t add that file: {error}', { error: esc(err.message) }), 'high');
    } finally {
      $('go').textContent = t('Add to the library'); $('go').disabled = !state.file;
    }
  }
  $('go').onclick = () => state.file && upload(state.file, $('docType').value, $('product').value.trim());
  document.querySelectorAll('[data-sample]').forEach((b) => b.onclick = async () => {
    try {
      const res = await fetch(`/samples/${b.dataset.sample}`, { headers: { 'ngrok-skip-browser-warning': '1' } });
      if (!res.ok) throw new Error(t('sample missing ({status})', { status: res.status }));
      const blob = await res.blob();
      await upload(new File([blob], b.dataset.sample, { type: blob.type }), b.dataset.type, b.dataset.product);
    } catch (err) { toast(esc(err.message), 'high'); }
  });

  // ---------- list ----------
  async function loadList() {
    try { state.docs = await api('/api/documents'); }
    catch (err) { $('docs').innerHTML = `<div style="padding:0 18px">${emptyState({ icon: 'wifiOff', error: true, title: t('Couldn’t load the library'), body: esc(err.message) })}</div>`; return; }
    if (!state.selected && state.docs[0]) state.selected = state.docs[0].id;
    renderList();
    if (state.selected) loadDetail(state.selected); else renderEmptyDetail();
  }
  function renderList() {
    $('docCount').textContent = state.docs.length ? String(state.docs.length) : '';
    $('docs').innerHTML = state.docs.length ? state.docs.map((d) => `<button class="doc-item ${d.id === state.selected ? 'sel' : ''}" data-id="${d.id}">
      <span class="state ${esc(d.status)}" title="${esc(t(d.status))}"></span>
      <span><div class="tt">${esc(d.title)}</div><div class="mm">${esc(t(TYPE[d.doc_type] || d.doc_type))}${d.product ? ' · ' + esc(d.product) : ''} · ${d.status === 'integrated' && d.graph_summary ? t('+{n} branches', { n: d.graph_summary.newNodes }) : d.status === 'failed' ? t('failed') : t('reading…')} · ${ago(d.created_at)}</div></span></button>`).join('')
      : `<div style="padding:0 18px">${emptyState({ icon: 'file', title: t('Nothing here yet'), body: t('Add a spec sheet or policy on the left. Every document here is something the field agent can cite.') })}</div>`;
    $('docs').querySelectorAll('[data-id]').forEach((b) => b.onclick = () => { state.selected = Number(b.dataset.id); renderList(); loadDetail(state.selected); const u = new URL(location.href); u.searchParams.set('doc', state.selected); history.replaceState(null, '', u); });
  }

  // ---------- detail ----------
  function renderEmptyDetail() {
    $('detail').innerHTML = emptyState({ icon: 'file', title: t('The library is empty'), body: t('When a new product ships, add its spec sheet, policies and bulletins here. The document agent finds the models, parts, specs, service intervals, fault codes and rules in each file, links them to what the fleet already knows, and creates new branches for anything new. Try one of the demo documents to see it work.') });
  }
  async function loadDetail(id) {
    try { showDetail(await api(`/api/documents/${id}`)); }
    catch (err) { $('detail').innerHTML = emptyState({ icon: 'file', error: true, title: t('Couldn’t open that document'), body: esc(err.message) }); }
  }
  const stepsHtml = (d) => `<ul class="steps">${(d.steps || []).map((s, i, arr) => `<li class="${s.step === 'failed' ? 'bad' : d.status === 'processing' && i === arr.length - 1 ? 'now' : ''}"><span class="b"></span><span><b style="font-weight:600">${esc(t(s.label))}</b>${s.detail ? `<div class="d">${esc(s.detail)}</div>` : ''}</span><span class="when">${new Date(s.at).toLocaleTimeString(CT.locale, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span></li>`).join('') || `<li class="now"><span class="b"></span><span>${t('Waiting to start')}</span><span></span></li>`}</ul>`;
  const table = (cols, rows) => `<table class="data"><thead><tr>${cols.map((c) => `<th>${c ? t(c) : ''}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;

  function showDetail(d) {
    state.detail = d;
    const head = `<div class="row spread wrap"><span class="row" style="gap:8px"><span class="tag ${d.doc_type === 'policy' ? '' : 'cat'}">${esc(t(TYPE[d.doc_type] || d.doc_type))}</span>${d.product ? `<span class="id">${esc(d.product)}</span>` : ''}</span>
        <span class="mono faint" style="font-size:12px">${d.uploaded_by_name ? t('added {when} by {name}', { when: ago(d.created_at), name: esc(d.uploaded_by_name) }) : t('added {when}', { when: ago(d.created_at) })}</span></div>
      <h2>${esc(d.title)}</h2>
      <div class="meta-line">${esc(d.filename)} · ${d.size ? fmtSize(d.size) : ''}${d.pages ? ` · ${d.pages === 1 ? t('1 page') : t('{n} pages', { n: d.pages })}` : ''}${d.text_chars ? ` · ${t('{n} characters', { n: d.text_chars.toLocaleString(CT.locale) })}` : ''}${d.ai_mode ? ` · ${t('read by {model}', { model: esc(d.ai_mode === 'rules' ? t('pattern matching') : d.ai_mode.split('/').pop()) })}` : ''}</div>`;
    if (d.status === 'processing') {
      $('detail').innerHTML = `${head}<div class="sec-title">${t('The document agent is working')}</div>${stepsHtml(d)}<div style="margin-top:18px">${skeleton(4)}</div>`;
      return;
    }
    if (d.status === 'failed') {
      $('detail').innerHTML = `${head}<div style="margin-top:14px">${emptyState({ icon: 'alert', error: true, title: t('The agent couldn’t finish this one'), body: esc(d.error || t('Unknown error')) })}</div><div class="sec-title">${t('What it tried')}</div>${stepsHtml(d)}`;
      return;
    }
    const ex = d.extraction || {}; const g = d.graph_summary || { newNodes: 0, linkedExisting: 0, newEdges: 0, newByType: {}, newSample: [], linkedSample: [] };
    const focus = (id) => `/graph?focus=${encodeURIComponent(id)}`;
    const newGroups = Object.entries(g.newByType || {});
    const newChips = (type) => (g.newSample || []).filter((n) => n.type === type).map((n) => `<a class="chip new" href="${focus(n.id)}"><span class="k">${t('new')}</span>${esc(n.label)}</a>`).join('');
    const products = (ex.products || []);
    $('detail').innerHTML = `${head}
      ${ex.summary ? `<p style="font-size:16px;line-height:1.5;margin-top:14px;max-width:70ch">${esc(ex.summary)}</p>` : ''}
      ${d.error ? `<div class="muted" style="font-size:13px;margin-top:8px">${esc(d.error)}</div>` : ''}
      <div class="statline" style="margin-top:18px">
        <div class="hero"><div class="v">+${g.newNodes}</div><div class="k"><span class="mk good"></span>${t('new branches in the knowledge graph')}</div></div>
        <div class="stat"><div class="v">${g.linkedExisting}</div><div class="k">${t('existing nodes it attached to')}</div></div>
        <div class="stat"><div class="v">${g.newEdges}</div><div class="k">${t('new links')}</div></div>
      </div>
      <div class="row wrap"><a class="btn primary" href="${focus('document:' + d.id)}">${icon('graph')} ${t('See it in the graph')}</a><a class="btn" href="${esc(d.file_path)}" target="_blank" rel="noopener">${icon('file')} ${t('Open the original')}</a></div>
      ${newGroups.length ? `<div class="sec-title">${t('New branches')}</div>${newGroups.map(([type]) => `<div class="branch-group"><span class="label">${esc(t(NODE[type] || type))}</span><div class="chips">${newChips(type)}</div></div>`).join('')}` : `<div class="sec-title">${t('New branches')}</div><div class="muted" style="font-size:14px">${t('Nothing new — everything in this document attached to knowledge the graph already had.')}</div>`}
      ${(g.linkedSample || []).length ? `<div class="sec-title">${t('Attached to what the fleet already knows')}</div><div class="chips">${g.linkedSample.map((n) => `<a class="chip" href="${focus(n.id)}"><span class="k">${esc(t(NODE[n.type] || n.type))}</span>${esc(n.label)}</a>`).join('')}</div>` : ''}
      ${products.length ? `<div class="sec-title">${t('Products')}</div>${table(['Model', 'Family', ''], products.map((p) => `<tr><td class="num">${esc(p.model)}</td><td>${esc(p.family || '—')}</td><td>${p.is_new_product ? `<span class="tag cat">${t('new product')}</span>` : ''}</td></tr>`))}` : ''}
      ${(ex.specs || []).length ? `<div class="sec-title">${t('Specs')}</div>${table(['Spec', 'Value', 'Model'], ex.specs.map((s) => `<tr><td>${esc(s.label)}</td><td class="num">${esc(s.value)} ${esc(s.unit || '')}</td><td class="num">${esc(s.model || '')}</td></tr>`))}` : ''}
      ${(ex.intervals || []).length ? `<div class="sec-title">${t('Service intervals')}</div>${table(['Task', 'Every', 'When'], ex.intervals.map((i) => `<tr><td>${esc(i.task)}</td><td class="num">${i.hours ? t('{n} h', { n: esc(i.hours) }) : '—'}</td><td>${esc(i.condition || '')}</td></tr>`))}` : ''}
      ${(ex.fault_codes || []).length ? `<div class="sec-title">${t('Fault codes')}</div>${table(['Code', 'Meaning', 'Part'], ex.fault_codes.map((c) => `<tr><td class="num">${esc(c.code)}</td><td>${esc(c.meaning || '')}</td><td>${esc(c.component || '')}</td></tr>`))}` : ''}
      ${(ex.policies || []).length ? `<div class="sec-title">${t('Rules people must follow')}</div>${table(['Rule', 'Type', 'Applies to'], ex.policies.map((p) => `<tr><td>${esc(p.rule)}</td><td>${esc(p.category || '')}</td><td>${esc((p.applies_to || []).join(', '))}</td></tr>`))}` : ''}
      ${(ex.hazards || []).length ? `<div class="sec-title">${t('Hazards it addresses')}</div><div class="chips">${ex.hazards.map((h) => `<span class="chip">${esc(h)}</span>`).join('')}</div>` : ''}
      <details style="margin-top:22px"><summary class="muted" style="cursor:pointer;font-size:14px">${t('What the agent did, step by step')}</summary><div style="margin-top:8px">${stepsHtml(d)}</div></details>`;
  }

  // ---------- live ----------
  connectStream({
    doc: ({ doc }) => {
      state.docs = [doc, ...state.docs.filter((x) => x.id !== doc.id)].sort((a, b) => b.created_at.localeCompare(a.created_at));
      renderList();
      if (doc.id === state.selected) showDetail(doc);
      if (doc.status === 'integrated') toast(t('“{title}” is in the graph: +{n} branches.', { title: esc(doc.title), n: doc.graph_summary?.newNodes ?? 0 }), 'good');
      if (doc.status === 'failed') toast(t('“{title}” couldn’t be processed.', { title: esc(doc.title) }), 'high');
    },
    'doc-step': ({ id, step, label, detail }) => {
      if (id !== state.selected || !state.detail || state.detail.status !== 'processing') return;
      state.detail.steps = [...(state.detail.steps || []), { step, label, detail, at: new Date().toISOString() }];
      showDetail(state.detail);
    },
  }, $('live'));

  bootForm().catch(() => {});
  loadList();
})();
