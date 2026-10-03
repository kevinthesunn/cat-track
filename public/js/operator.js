// Operator panel: identify the unit (type / QR), dictate what's happening, and get the
// machine's memory + crew alerts back in seconds.
(function () {
  const { topbar, api, esc, ago, dateShort, dateTime, sevPill, statusPill, healthBar, md, toast, undoBar, connectStream, store, icon, machineIcon, emptyState, skeleton, ROLE, SOURCE_LABEL, REPORT_STATUS, modal,
    clip, problemOf, metaLine, keyFacts, kv, keyRow, dropdown, toneOf, alertDetails, alertTitle, t } = CT;
  const $ = (id) => document.getElementById(id);

  const state = { unit: null, people: [], me: null, photo: null, listening: false, tts: store.get('tts', true), lastResult: null };

  // Sample reports in the operator's language. Same order and same machine as the English buttons in operator.html.
  const SAMPLES = {
    es: [
      { text: 'Otra vez fuga de aceite hidráulico en la manguera de la pluma, cerca del soporte del bastidor. Gotea bastante. Hace mucho calor hoy.', unit: 'EX-0412' },
      { text: 'El motor se calienta mucho subiendo la rampa de acarreo. Se encendió la alarma de temperatura del refrigerante, código CID 110 FMI 15. Hoy hay mucho polvo.', unit: 'HT-0764' },
      { text: 'Ruido de rechinido en la rueda guía de la oruga izquierda al girar. Está peor desde ayer.', unit: 'DZ-0107' },
      { text: 'Terreno blando junto al borde de la zanja del lado norte. El cucharón casi se desliza. Mantengan las máquinas alejadas.', unit: 'EX-0519' },
      { text: 'Acaba de encenderse la alarma de temperatura del refrigerante subiendo la rampa. ¿Qué debo hacer?', unit: 'HT-0764' },
      { text: 'Ya arreglé la fuga de la manguera de la pluma: cambié la manguera y la redirigí lejos del soporte del bastidor.', unit: 'EX-0412' },
      { text: 'Necesito un técnico aquí. La oruga izquierda se ve floja y la rueda guía rechina.', unit: 'DZ-0107' },
      { text: '¿Cuándo es el próximo servicio de esta máquina?', unit: 'DZ-0107' },
      { text: 'Corrección a mi último reporte: quise decir el cilindro del brazo, no el de la pluma.', unit: 'EX-0412' },
      { text: 'Borra mi último reporte, lo envié por error.', unit: 'EX-0412' },
      { text: 'Elimina el reporte sobre la fuga de la manguera de la pluma.', unit: 'EX-0412' },
    ],
    hi: [
      { text: 'बूम होज़ से फिर हाइड्रोलिक तेल लीक हो रहा है, फ्रेम ब्रैकेट के पास से। लगातार टपक रहा है। आज बहुत गर्मी है।', unit: 'EX-0412' },
      { text: 'हॉल रोड की चढ़ाई पर इंजन बहुत गर्म हो रहा है। कूलेंट टेम्परेचर की चेतावनी आ गई, कोड CID 110 FMI 15। आज बहुत धूल है।', unit: 'HT-0764' },
      { text: 'मोड़ लेते समय बाएँ ट्रैक के आइडलर से घिसाव जैसी आवाज़ आ रही है। कल से लगातार बिगड़ रही है।', unit: 'DZ-0107' },
      { text: 'उत्तर तरफ खाई के किनारे ज़मीन नरम है। बकेट लगभग फिसल गई। मशीनों को किनारे से दूर रखें।', unit: 'EX-0519' },
      { text: 'रैंप चढ़ते समय अभी कूलेंट टेम्परेचर की चेतावनी आ गई। मुझे क्या करना चाहिए?', unit: 'HT-0764' },
      { text: 'बूम होज़ का लीक ठीक कर दिया। होज़ बदल दी और उसे फ्रेम ब्रैकेट से दूर कर दिया।', unit: 'EX-0412' },
      { text: 'यहाँ एक टेक्नीशियन भेजो। बायाँ ट्रैक ढीला लग रहा है और आइडलर से आवाज़ आ रही है।', unit: 'DZ-0107' },
      { text: 'इस मशीन की अगली सर्विस कब है?', unit: 'DZ-0107' },
      { text: 'मेरी पिछली रिपोर्ट में सुधार: मेरा मतलब स्टिक सिलेंडर था, बूम नहीं।', unit: 'EX-0412' },
      { text: 'मेरी पिछली रिपोर्ट हटा दो, गलती से भेज दी थी।', unit: 'EX-0412' },
      { text: 'बूम होज़ के लीक वाली रिपोर्ट हटा दो।', unit: 'EX-0412' },
    ],
  };

  // ---------- static chrome ----------
  $('top').innerHTML = topbar('/operator');
  $('scanBtn').innerHTML = `${icon('qr')}<span>${t('Scan')}</span>`;
  $('photoBtn').innerHTML = `${icon('camera')} ${t('Add photo')}`;
  $('submitBtn').innerHTML = `${icon('send')} ${t('Send to Cat Track')}`;
  const renderTts = () => { $('ttsBtn').innerHTML = `${icon(state.tts ? 'speaker' : 'mute')}<span>${state.tts ? t('Reads replies aloud') : t('Replies muted')}</span>`; $('ttsBtn').setAttribute('aria-pressed', String(state.tts)); };
  renderTts();
  $('ttsBtn').onclick = () => { state.tts = !state.tts; store.set('tts', state.tts); renderTts(); if (!state.tts) window.speechSynthesis?.cancel(); toast(state.tts ? t('Spoken responses on') : t('Spoken responses off')); };

  // ---------- who is reporting (personalization) ----------
  function renderMe() {
    const p = state.me;
    $('meChip').innerHTML = `${icon('user')}<span>${p ? t('Reporting as <b>{name}</b>', { name: esc(p.name) }) : t('Who’s reporting?')}</span>${icon('chevron')}`;
  }
  async function loadPeople() {
    state.people = await api('/api/people');
    const saved = store.get('me');
    const unitOp = state.unit?.asset.operator_id;
    state.me = state.people.find((p) => p.id === saved) || state.people.find((p) => p.id === unitOp) || state.people.find((p) => p.role === 'operator') || null;
    renderMe();
  }
  $('meChip').onclick = () => {
    const field = state.people.filter((p) => ['operator', 'technician', 'site_manager', 'safety_officer'].includes(p.role));
    const m = modal(`<h2>${t("Who's reporting?")}</h2><p class="muted" style="margin-top:-4px">${t('Your name goes on the record so the technician knows who to ask, and the advice you hear back matches your job.')}</p>
      <div class="people-list">${field.map((p) => `<button data-id="${p.id}" class="${state.me?.id === p.id ? 'sel' : ''}"><span><b>${esc(p.name)}</b><br><span class="muted" style="font-size:13px">${t(ROLE[p.role] || p.role)}${p.site_name ? ' · ' + esc(p.site_name) : ''}</span></span>${state.me?.id === p.id ? icon('check') : ''}</button>`).join('')}</div>`);
    m.el.querySelectorAll('button[data-id]').forEach((b) => b.onclick = () => {
      state.me = state.people.find((p) => p.id === b.dataset.id); store.set('me', state.me.id); renderMe(); m.close();
      if (hist.scope === 'mine') { hist.next = null; loadHistory(); }
      toast(t('Reporting as {name}', { name: esc(state.me.name) }), 'good');
    });
  };

  // ---------- unit lookup ----------
  const recent = () => store.get('recentUnits', []);
  function renderRecent() {
    const list = recent();
    const defaults = ['EX-0412', 'HT-0761', 'DZ-0107', 'WL-0241'];
    const units = [...new Set([...list, ...defaults])].slice(0, 6);
    $('recentUnits').innerHTML = units.map((u) => `<button class="chip" data-u="${esc(u)}">${esc(u)}</button>`).join('');
    $('recentUnits').querySelectorAll('[data-u]').forEach((b) => b.onclick = () => { $('unitInput').value = b.dataset.u; loadUnit(b.dataset.u); });
  }

  let loadSeq = 0;
  async function loadUnit(raw, { quiet = false } = {}) {
    const id = String(raw || '').trim();
    if (!id) return;
    const seq = ++loadSeq;
    $('unitError').classList.add('hidden');
    if (!state.unit || state.unit.asset.id !== id.toUpperCase()) {
      $('unitCard').innerHTML = `<div class="unit-head"><span class="sk" style="width:60px;height:60px"></span><div><span class="sk title"></span><span class="sk line" style="width:70%"></span></div></div><div style="margin-top:16px">${skeleton(3)}</div>`;
    }
    try {
      const data = await api(`/api/assets/${encodeURIComponent(id)}`);
      if (seq !== loadSeq) return;
      const firstLoad = !state.unit || state.unit.asset.id !== data.asset.id;
      state.unit = data;
      $('unitInput').value = data.asset.id;
      store.set('recentUnits', [data.asset.id, ...recent().filter((u) => u !== data.asset.id)].slice(0, 6));
      renderRecent();
      renderUnit();
      updateSubmit();
      if (firstLoad) {
        // Until someone explicitly picks who they are, assume the machine's assigned operator.
        if (!store.get('me') && data.asset.operator_id && state.people.length) {
          state.me = state.people.find((p) => p.id === data.asset.operator_id) || state.me; renderMe();
        }
        loadFeed();
        hist.next = null; loadHistory();
        if (!quiet) navigator.vibrate?.(30);
        const url = new URL(location.href); url.searchParams.set('unit', data.asset.id); history.replaceState(null, '', url);
      }
    } catch (err) {
      if (seq !== loadSeq) return;
      state.unit = null;
      renderNotFound(id, err.message);
      updateSubmit();
    }
  }

  function renderUnit() {
    const { asset, memory, alerts } = state.unit;
    const since = asset.last_service_hours != null ? Math.round(asset.smu_hours - asset.last_service_hours) : null;
    const mem = memory.filter((m) => m.kind !== 'service').slice(0, 6);
    $('unitCard').innerHTML = `
      <div class="unit-head">
        <div class="unit-ico">${machineIcon(asset.family)}</div>
        <div class="grow">
          <div class="row spread" style="align-items:flex-start"><div class="unit-model">${esc(asset.model)}</div>${statusPill(asset.status)}</div>
          <div class="unit-sub"><span class="id" style="color:var(--ink)">${esc(asset.id)}</span> · ${esc(t(asset.family))} · ${t('S/N')} <span class="mono">${esc(asset.serial)}</span></div>
          <div class="unit-sub">${esc(asset.site_name)}</div>
        </div>
      </div>
      <div style="margin-top:14px">
        <div class="row spread" style="font-size:13px;margin-bottom:6px"><span class="muted">${t('Health, from open issues and age')}</span><span class="mono">${asset.health}/100</span></div>
        ${healthBar(asset.health)}
      </div>
      <div class="meta-grid">
        <div class="meta"><div class="k">${t('Hours')}</div><div class="v">${Math.round(asset.smu_hours).toLocaleString(CT.locale)}</div></div>
        <div class="meta"><div class="k">${t('Fuel')}</div><div class="v">${Math.round(asset.fuel_pct)}%</div></div>
        <div class="meta"><div class="k">${t('Open issues')}</div><div class="v">${alerts.length}</div></div>
        <div class="meta"><div class="k">${t('Last service')}</div><div class="v">${dateShort(asset.last_service_at)}</div></div>
        <div class="meta"><div class="k">${t('Since PM')}</div><div class="v">${since != null ? t('{n} h', { n: since }) : '—'}</div></div>
        <div class="meta"><div class="k">${t('On record')}</div><div class="v"><a href="#history" style="color:inherit">${state.unit.stats.total === 1 ? t('1 entry') : t('{n} entries', { n: state.unit.stats.total })}</a></div></div>
      </div>
      <div style="margin-top:12px">
        ${alerts.length ? dropdown(t('Open issues on {id}', { id: esc(asset.id) }), alerts.map((a) => `<div class="issue-line">${sevPill(a.severity)}<span>${esc(alertTitle(a))}</span><span class="faint mono">${ago(a.created_at)}</span></div>`).join(''), { count: alerts.length }) : ''}
        ${dropdown(t('What this machine remembers'), mem.length ? `<ul class="mem-list">${mem.map((m) => `<li class="${m.level}">${icon(m.kind === 'fleet' ? 'graph' : m.kind === 'bulletin' ? 'wrench' : m.kind === 'pattern' ? 'alert' : m.kind === 'document' ? 'file' : 'history')}<span>${esc(m.text.replace(/ \[D\d+\]$/, ''))}</span></li>`).join('')}</ul>` : `<div class="muted" style="font-size:14px">${t('Nothing unusual on record for this machine.')}</div>`, { count: mem.length })}
      </div>
      <div class="row spread wrap" style="margin-top:14px;font-size:14px"><span class="muted">${t('Assigned to {name}', { name: esc(asset.operator_name || t('nobody yet')) })}</span><a href="/asset?id=${encodeURIComponent(asset.id)}">${t('Full history for {id}', { id: esc(asset.id) })}</a></div>`;
  }

  function renderNoUnit() {
    $('unitCard').innerHTML = `<div class="nounit" style="padding:0"><div class="tag-art">${icon('qr')}</div><div>
      <div style="font-weight:600">${t('Which machine are you on?')}</div>
      <div class="muted" style="font-size:14px;margin-top:4px">${t('There’s a Cat Track tag inside the cab door. Tap {scan} and point your camera at it, or type the unit number printed under the code. It looks like {example}.', { scan: `<b style="color:var(--ink)">${t('Scan')}</b>`, example: '<span class="id" style="color:var(--ink)">EX-0412</span>' })}</div></div></div>`;
    $('feed').innerHTML = emptyState({ icon: 'pin', title: t('No job site yet'), body: t('Alerts for the machine’s site appear here once you pick a machine.') });
    $('histList').innerHTML = emptyState({ icon: 'history', title: t('No machine picked'), body: t('Once you pick a machine, everything reported on it shows up here, newest first.') });
  }
  let allAssets = null;
  async function renderNotFound(raw, message) {
    const typed = String(raw).toUpperCase();
    $('unitCard').innerHTML = emptyState({ icon: 'search', error: true, title: t('No machine called “{id}”', { id: esc(typed) }), body: `${esc(message.startsWith('Unknown') ? t('It isn’t in the fleet record. Check the tag — unit numbers are two letters and four digits.') : message)}` });
    try {
      allAssets ||= await api('/api/assets');
      const digits = typed.replace(/\D/g, '');
      const near = allAssets.filter((a) => (digits && a.id.includes(digits.slice(-3))) || a.id.startsWith(typed.slice(0, 2))).slice(0, 4);
      if (near.length) {
        $('unitCard').insertAdjacentHTML('beforeend', `<div class="row wrap" style="padding:0 2px 6px 48px"><span class="muted" style="font-size:13px">${t('Did you mean')}</span>${near.map((a) => `<button class="chip" data-near="${esc(a.id)}"><span class="k">${esc(a.model)}</span><span class="id">${esc(a.id)}</span></button>`).join('')}</div>`);
        $('unitCard').querySelectorAll('[data-near]').forEach((b) => b.onclick = () => { unitInput.value = b.dataset.near; loadUnit(b.dataset.near); });
      }
    } catch { /* suggestions are optional */ }
  }

  const unitInput = $('unitInput');
  let typeTimer = null;
  unitInput.addEventListener('input', () => {
    clearTimeout(typeTimer);
    const v = unitInput.value.trim();
    if (/^(CAT[-\s]?)?[A-Za-z]{2}[-\s]?\d{3,4}$/i.test(v)) typeTimer = setTimeout(() => loadUnit(v), 350);
  });
  unitInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadUnit(unitInput.value); unitInput.blur(); } });
  unitInput.addEventListener('change', () => loadUnit(unitInput.value));

  // ---------- QR scanner ----------
  let scanStream = null; let scanRaf = 0; let scanEl = null;
  function stopScan() {
    cancelAnimationFrame(scanRaf);
    scanStream?.getTracks().forEach((t) => t.stop());
    scanStream = null;
    scanEl?.remove(); scanEl = null;
  }
  function handleQr(text) {
    stopScan();
    navigator.vibrate?.([40, 30, 40]);
    const m = String(text).match(/[?&]unit=([A-Za-z0-9-]+)/i);
    const id = m ? m[1] : String(text).trim();
    unitInput.value = id.toUpperCase();
    toast(t('Scanned {id}', { id: esc(id.toUpperCase()) }), 'good');
    loadUnit(id);
  }
  async function decodeImageFile(file) {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, 1000 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const code = window.jsQR && window.jsQR(d.data, d.width, d.height, { inversionAttempts: 'attemptBoth' });
    if (code && code.data) handleQr(code.data); else toast(t('No QR code found in that photo — try again closer.'), 'high');
  }
  async function startScan() {
    scanEl = document.createElement('div');
    scanEl.className = 'scanner';
    scanEl.innerHTML = `<video playsinline muted autoplay></video><div class="frame"></div>
      <div class="bar"><b style="font-family:var(--font-cond);font-size:20px;letter-spacing:.06em">${t('SCAN MACHINE TAG')}</b><button class="btn" id="scanClose">${icon('x')} ${t('Close')}</button></div>
      <div class="msg" id="scanMsg">${t('Point at the QR tag on the machine')}</div>`;
    document.body.appendChild(scanEl);
    scanEl.querySelector('#scanClose').onclick = stopScan;
    const msg = scanEl.querySelector('#scanMsg');
    const photoFallback = () => {
      msg.innerHTML = `<label class="btn primary" style="margin-top:8px">${icon('camera')} ${t('Take a photo of the tag')}<input type="file" accept="image/*" capture="environment" class="hidden" id="qrFile"></label>`;
      scanEl.querySelector('#qrFile').onchange = (e) => { const f = e.target.files[0]; if (f) decodeImageFile(f).catch(() => toast(t('Could not read that photo'), 'high')); };
    };
    if (!navigator.mediaDevices?.getUserMedia) {
      msg.innerHTML = `${t('Live camera needs HTTPS.')} `;
      photoFallback();
      return;
    }
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (err) {
      msg.textContent = `${err.name === 'NotAllowedError' ? t('Camera permission denied.') : t('Camera unavailable.')} `;
      photoFallback();
      return;
    }
    if (!scanEl) { scanStream.getTracks().forEach((t) => t.stop()); return; }
    const video = scanEl.querySelector('video');
    video.srcObject = scanStream;
    try { await video.play(); } catch { /* autoplay with muted+playsinline normally succeeds */ }
    let detector = null;
    if ('BarcodeDetector' in window) {
      try { const fmts = await window.BarcodeDetector.getSupportedFormats(); if (fmts.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; }
    }
    const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let last = 0; let busy = false;
    const loop = async (t) => {
      if (!scanStream) return;
      scanRaf = requestAnimationFrame(loop);
      if (busy || t - last < 140 || video.readyState < 2) return;
      last = t; busy = true;
      try {
        if (detector) {
          const codes = await detector.detect(video);
          if (codes[0]?.rawValue) return handleQr(codes[0].rawValue);
        } else if (window.jsQR) {
          const w = Math.min(640, video.videoWidth); const h = Math.round(video.videoHeight * (w / video.videoWidth));
          if (w && h) {
            canvas.width = w; canvas.height = h;
            ctx.drawImage(video, 0, 0, w, h);
            const img = ctx.getImageData(0, 0, w, h);
            const code = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
            if (code?.data) return handleQr(code.data);
          }
        }
      } catch { /* keep scanning */ } finally { busy = false; }
    };
    scanRaf = requestAnimationFrame(loop);
  }
  $('scanBtn').onclick = startScan;

  // ---------- voice ----------
  // Two ways to turn speech into text:
  //  1. Record on the phone and let the server transcribe it (Whisper on the AI key). Works on
  //     iPhone, Android, Firefox and desktop browsers, copes with engine noise, knows Cat part names.
  //  2. The browser's own speech recognition, when the server can't transcribe.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canRecord = Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  const isPhone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const dictateBtn = $('dictateBtn');
  const reportText = $('reportText');
  let mode = SR ? 'browser' : 'none';
  let usedVoice = false;
  state.voice = 'idle'; // idle | starting | recording | transcribing
  const rec = { stream: null, recorder: null, chunks: [], ctx: null, raf: 0, started: 0, timer: 0, autoStop: 0, speechSeen: false, quietSince: 0, lastBlob: null, sr: null, srBase: '', keepHint: false };

  const joinText = (...parts) => parts.map((p) => (p || '').trim()).filter(Boolean).join(' ');
  const hint = (html) => { $('dictateHint').innerHTML = html; };
  const clock = () => { const s = Math.floor((Date.now() - rec.started) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  function idleHint() {
    if (mode !== 'none') hint(t('Tap, then say what you see, hear or smell. Tap again when you’re done.'));
    else if (!window.isSecureContext) hint(t('The microphone only works on the secure (https) link. You can type below.'));
    else hint(t('This browser can’t use the microphone here. Type below, or use the mic key on your keyboard.'));
  }
  function renderDictate() {
    const v = state.voice;
    dictateBtn.classList.toggle('listening', v === 'recording');
    dictateBtn.classList.toggle('busy', v === 'starting' || v === 'transcribing');
    dictateBtn.disabled = v === 'starting' || v === 'transcribing' || mode === 'none';
    const label = v === 'recording' ? t('Tap to stop · {time}', { time: clock() }) : v === 'transcribing' ? t('Writing it down') : v === 'starting' ? t('Opening mic') : mode === 'none' ? t('Type below') : t('Tap to talk');
    dictateBtn.innerHTML = `${icon(v === 'recording' ? 'stop' : 'mic')}<span class="lab">${label}</span>`;
    dictateBtn.setAttribute('aria-label', v === 'recording' ? t('Stop recording') : t('Start recording'));
    updateSubmit();
  }
  function micError(err) {
    const n = err?.name || '';
    if (n === 'NotAllowedError' || n === 'SecurityError') return t('Microphone access is blocked. Allow it for this site in the browser settings (on iPhone: Settings › Safari › Microphone), then tap again.');
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return t('No microphone found on this device.');
    if (n === 'NotReadableError' || n === 'AbortError') return t('The microphone is busy in another app (a call or voice memo?). Close it and tap again.');
    return t('Couldn’t open the microphone: {error}', { error: esc(err?.message || n || t('unknown error')) });
  }

  /* ----- 1. record, then transcribe on the server ----- */
  function pickMime() {
    for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac', 'audio/ogg;codecs=opus']) {
      try { if (MediaRecorder.isTypeSupported(t)) return t; } catch { /* keep looking */ }
    }
    return '';
  }
  async function startRecording() {
    window.speechSynthesis?.cancel();
    state.voice = 'starting'; renderDictate();
    // iPhone only lets audio start inside the tap, so the meter's AudioContext is made before awaiting the mic.
    const Ctx = window.AudioContext || window.webkitAudioContext;
    let ctx = null;
    try { ctx = Ctx ? new Ctx() : null; } catch { ctx = null; }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (err) {
      try { ctx?.close(); } catch { /* ignore */ }
      state.voice = 'idle'; renderDictate(); hint(micError(err));
      return;
    }
    const mime = pickMime();
    let recorder;
    try { recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined); }
    catch { try { recorder = new MediaRecorder(stream); } catch { recorder = null; } }
    if (!recorder) {
      stream.getTracks().forEach((t) => t.stop()); try { ctx?.close(); } catch { /* ignore */ }
      mode = SR ? 'browser' : 'none'; state.voice = 'idle'; renderDictate();
      hint(SR ? t('Recording isn’t supported here, so the browser will listen instead. Tap again.') : t('This browser can’t record audio. Type your report below.'));
      return;
    }
    Object.assign(rec, { stream, recorder, ctx, chunks: [], started: Date.now(), speechSeen: false, quietSince: 0 });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    recorder.onstop = onRecordingStopped;
    recorder.onerror = (e) => { hint(t('Recording stopped: {error}', { error: esc(e.error?.message || t('unknown error')) })); stopVoice(); };
    recorder.start(1000); // a chunk every second, so nothing is lost if the phone cuts it short
    startMeter();
    state.voice = 'recording';
    rec.timer = setInterval(() => { const lab = dictateBtn.querySelector('.lab'); if (lab) lab.textContent = t('Tap to stop · {time}', { time: clock() }); }, 250);
    rec.autoStop = setTimeout(stopVoice, 120_000);
    navigator.vibrate?.(25);
    renderDictate();
    hint(t('Listening. Tap again when you’re done; it also stops by itself after a pause.'));
  }
  // Ring around the button follows your voice, so you can see the mic is hearing you.
  // A pause of 3.5 s after speaking stops the recording, so gloves can stay on.
  function startMeter() {
    const { ctx, stream } = rec;
    if (!ctx) return;
    try {
      ctx.resume?.();
      const an = ctx.createAnalyser(); an.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const loop = () => {
        if (state.voice !== 'recording') return;
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        dictateBtn.style.setProperty('--lvl', Math.min(1, rms * 7).toFixed(3));
        const now = Date.now();
        if (rms > 0.045) { rec.speechSeen = true; rec.quietSince = 0; }
        else if (rec.speechSeen && rms < 0.018 && now - rec.started > 2000) {
          rec.quietSince ||= now;
          if (now - rec.quietSince > 3500) { stopVoice(); return; }
        }
        rec.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch { /* the meter is a nicety; recording still works without it */ }
  }
  function releaseMic() {
    rec.stream?.getTracks().forEach((t) => t.stop());
    rec.stream = null;
    try { rec.ctx?.close(); } catch { /* already closed */ }
    rec.ctx = null;
  }
  async function onRecordingStopped() {
    releaseMic();
    const ms = Date.now() - rec.started;
    const blob = new Blob(rec.chunks, { type: rec.recorder?.mimeType || 'audio/webm' });
    rec.chunks = [];
    if (ms < 700 || blob.size < 1000) { state.voice = 'idle'; renderDictate(); hint(t('That was too short. Tap, talk, then tap again.')); return; }
    rec.lastBlob = blob;
    await sendForText(blob);
  }
  async function sendForText(blob) {
    state.voice = 'transcribing'; renderDictate();
    hint(t('Writing down what you said…'));
    try {
      let res;
      try { res = await fetch(`/api/transcribe?lang=${encodeURIComponent(CT.lang)}`, { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm', 'ngrok-skip-browser-warning': '1' }, body: blob }); }
      catch { throw new Error(t('No signal, so the recording couldn’t be sent.')); }
      let data = null;
      try { data = await res.json(); } catch { /* not JSON */ }
      if (!res.ok) throw new Error(data?.error || t('The server couldn’t transcribe it ({status}).', { status: res.status }));
      if (!data.text) { hint(t('Didn’t catch any words. Move away from the engine noise and try again.')); rec.lastBlob = null; return; }
      reportText.value = joinText(reportText.value, data.text);
      usedVoice = true; rec.lastBlob = null;
      hint(t('Got it. Fix anything it misheard, then send.'));
    } catch (err) {
      hint(`${esc(err.message)} <button class="btn sm" type="button" id="retryVoice">${t('Try again')}</button>`);
      $('retryVoice')?.addEventListener('click', () => { if (rec.lastBlob) sendForText(rec.lastBlob); });
    } finally {
      if (state.voice === 'transcribing') state.voice = 'idle';
      renderDictate();
    }
  }

  /* ----- 2. the browser's own speech recognition ----- */
  function startBrowserListening() {
    window.speechSynthesis?.cancel();
    const sr = new SR();
    rec.sr = sr;
    sr.lang = CT.speech;
    sr.interimResults = true;
    // Phones repeat or never finish results in continuous mode; one phrase at a time, restarted, is reliable.
    sr.continuous = !isPhone;
    sr.maxAlternatives = 1;
    rec.srBase = reportText.value;
    sr.onresult = (e) => {
      let finalT = ''; let interim = '';
      if (sr.continuous) {
        for (let i = 0; i < e.results.length; i++) { const r = e.results[i]; if (r.isFinal) finalT += `${r[0].transcript} `; else interim += r[0].transcript; }
      } else {
        // Android repeats earlier words inside later results; the newest result holds the whole phrase.
        const last = e.results[e.results.length - 1];
        if (last.isFinal) finalT = last[0].transcript; else interim = last[0].transcript;
      }
      reportText.value = joinText(rec.srBase, finalT, interim);
      if (finalT && !sr.continuous) rec.srBase = reportText.value;
      usedVoice = true;
      hint(interim ? `<span class="interim">${esc(interim)}</span>` : t('Listening…'));
      updateSubmit();
    };
    sr.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      const msgs = { 'not-allowed': 'Microphone access is blocked. Allow it for this site and tap again.', 'service-not-allowed': 'Speech recognition is off on this device (on iPhone, turn on Siri & Dictation). You can type instead.', network: 'Speech recognition needs a network connection.', 'audio-capture': 'No microphone found.' };
      rec.keepHint = true; // onend must not replace this; the wording is translated, so it can't be matched by text
      hint(msgs[e.error] ? t(msgs[e.error]) : t('Voice error: {error}', { error: esc(e.error) }));
      state.voice = 'idle'; renderDictate();
    };
    sr.onend = () => {
      rec.srBase = reportText.value;
      if (state.voice === 'recording') {
        // Restart after a short gap; restarting inside onend fails on some phones.
        setTimeout(() => { if (state.voice !== 'recording') return; try { sr.start(); } catch { stopVoice(); } }, 250);
        return;
      }
      if (!rec.keepHint) hint(reportText.value.trim() ? t('Got it. Fix anything it misheard, then send.') : t('Didn’t catch anything. Move away from the engine noise and try again.'));
      updateSubmit();
    };
    try {
      sr.start();
      rec.keepHint = false;
      rec.started = Date.now();
      state.voice = 'recording';
      rec.timer = setInterval(() => { const lab = dictateBtn.querySelector('.lab'); if (lab) lab.textContent = t('Tap to stop · {time}', { time: clock() }); }, 250);
      rec.autoStop = setTimeout(stopVoice, 90_000);
      navigator.vibrate?.(25);
      hint(t('Listening…'));
    } catch (err) { rec.keepHint = true; hint(t('Couldn’t start the microphone: {error}', { error: esc(err.message) })); }
    renderDictate();
  }

  function startVoice() {
    if (state.voice !== 'idle') return;
    if (mode === 'server') startRecording();
    else if (mode === 'browser') startBrowserListening();
    else { reportText.focus(); idleHint(); }
  }
  function stopVoice() {
    if (state.voice !== 'recording') return;
    clearInterval(rec.timer); clearTimeout(rec.autoStop); cancelAnimationFrame(rec.raf);
    dictateBtn.style.setProperty('--lvl', '0');
    if (rec.recorder && rec.recorder.state !== 'inactive') {
      state.voice = 'transcribing'; renderDictate();
      try { rec.recorder.stop(); } catch { onRecordingStopped(); }
      return;
    }
    state.voice = 'idle';
    try { rec.sr?.stop(); } catch { /* already stopped */ }
    renderDictate();
  }
  dictateBtn.onclick = () => (state.voice === 'recording' ? stopVoice() : startVoice());
  // Switching apps or locking the phone ends the recording cleanly instead of leaving the mic open.
  document.addEventListener('visibilitychange', () => { if (document.hidden && state.voice === 'recording') stopVoice(); });
  renderDictate();
  idleHint();
  api('/api/health').then((h) => {
    if (h.stt && canRecord) { mode = 'server'; renderDictate(); idleHint(); }
  }).catch(() => {});

  reportText.addEventListener('input', () => { if (state.voice === 'recording' && rec.sr) rec.srBase = reportText.value; updateSubmit(); });
  $('clearBtn').onclick = () => { reportText.value = ''; rec.srBase = ''; usedVoice = false; clearPhoto(); updateSubmit(); };
  document.querySelectorAll('.examples .ex').forEach((b, i) => b.onclick = () => {
    const s = SAMPLES[CT.lang]?.[i];
    reportText.value = s ? s.text : b.textContent.trim();
    if (!state.unit) { const pick = s ? s.unit : (() => { const x = b.textContent; return /idler|track/i.test(x) || /next service/i.test(x) ? 'DZ-0107' : /coolant|haul road|ramp/i.test(x) ? 'HT-0764' : /trench/i.test(x) ? 'EX-0519' : 'EX-0412'; })(); unitInput.value = pick; loadUnit(pick); }
    updateSubmit();
    b.closest('details').open = false;
    reportText.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // ---------- photo ----------
  function clearPhoto() { state.photo = null; $('photoPrev').classList.add('hidden'); $('photoInput').value = ''; }
  $('photoRemove').onclick = clearPhoto;
  $('photoInput').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const img = await createImageBitmap(file);
      const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      state.photo = c.toDataURL('image/jpeg', 0.82);
      $('photoPrev').querySelector('img').src = state.photo;
      $('photoPrev').classList.remove('hidden');
    } catch { toast(t('Could not read that image'), 'high'); }
  };

  // ---------- submit ----------
  function updateSubmit() {
    const talking = state.voice && state.voice !== 'idle';
    const ok = Boolean(state.unit) && reportText.value.trim().length > 2 && !talking;
    $('submitBtn').disabled = !ok;
    $('submitBtn').innerHTML = !state.unit ? t('Pick a machine first') : talking ? (state.voice === 'transcribing' ? t('Writing down what you said…') : t('Tap the mic to finish first')) : `${icon('send')} ${t('Send report on {id}', { id: esc(state.unit.asset.id) })}`;
  }

  const STEPS = ['Working out what you need', 'Filing it under this machine', 'Checking what’s open and what’s happened before', 'Doing what you asked', 'Telling the people who need to know'];
  const INTENT = { new_issue: 'New problem', update_existing: 'Update to an open issue', resolved: 'Marked as fixed', request_advice: 'Asked for advice', request_help: 'Asked for help', question: 'Question', correction: 'Correction', delete_report: 'Delete request', routine_log: 'Routine log' };
  const DID_ICON = { resolved: 'check', learned: 'history', updated: 'activity', retracted: 'x', deleted: 'x', help: 'user', note: 'alert', case: 'wrench', graph: 'graph' };
  const plain = (t) => String(t || '').replace(/\*\*|\[[RD]\d+\]/g, '').replace(/\s+/g, ' ').trim();
  function runSteps() {
    $('progressBox').classList.remove('hidden');
    $('steps').innerHTML = STEPS.map((s) => `<li><span class="b"></span>${t(s)}</li>`).join('');
    const lis = [...$('steps').children];
    let i = 0;
    lis[0].classList.add('active');
    const timer = setInterval(() => {
      if (i < lis.length - 1) { lis[i].classList.remove('active'); lis[i].classList.add('done'); lis[i].querySelector('.b').innerHTML = icon('check'); i++; lis[i].classList.add('active'); }
    }, 650);
    return () => { clearInterval(timer); lis.forEach((li) => { li.classList.remove('active'); li.classList.add('done'); li.querySelector('.b').innerHTML = icon('check'); }); };
  }

  $('submitBtn').onclick = async () => {
    if (state.voice !== 'idle') return;
    const text = reportText.value.trim();
    if (!state.unit || !text) return;
    $('submitBtn').disabled = true;
    state.submitting = true;
    $('resultBox').classList.add('hidden');
    const finish = runSteps();
    $('progressBox').scrollIntoView({ behavior: 'smooth', block: 'center' });
    try {
      const out = await api('/api/reports', { body: { assetId: state.unit.asset.id, personId: state.me?.id, text, source: usedVoice ? 'voice' : 'text', photo: state.photo, lang: CT.lang } });
      out.said = text;
      finish();
      state.lastResult = out;
      setTimeout(() => {
        $('progressBox').classList.add('hidden');
        renderResult(out);
        const early = out.report && earlyUpdates.get(out.report.id);
        if (early) { earlyUpdates.delete(out.report.id); applyReview(early); }
        const earlySol = out.report && earlySolutions.get(out.report.id);
        if (earlySol) { earlySolutions.delete(out.report.id); applySolution(earlySol); }
      }, 350);
      reportText.value = ''; rec.srBase = ''; usedVoice = false; clearPhoto();
      loadUnit(state.unit.asset.id, { quiet: true });
      navigator.vibrate?.(out.report && out.extraction.severity === 'critical' ? [80, 50, 80, 50, 80] : 40);
    } catch (err) {
      finish();
      $('progressBox').classList.add('hidden');
      toast(t('Couldn’t send: {error} Your words are still in the box.', { error: esc(err.message) }), 'high');
    } finally {
      state.submitting = false;
      updateSubmit();
    }
  };

  function speak(text) {
    if (!state.tts || !window.speechSynthesis || !text) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.02; u.lang = CT.speech;
      window.speechSynthesis.speak(u);
    } catch { /* TTS unavailable */ }
  }

  function aiLine(out) {
    const ex = out.report?.extraction || out.extraction;
    if (ex.ai_status === 'pending') return `<div class="ai-line">${icon('clock')}<span>${t('<b>{model}</b> is reviewing this report. This card updates by itself when it’s done, usually within a minute. The crew has already been told.', { model: esc(out.aiLabel || t('The AI model')) })}</span></div>`;
    if (ex.ai_status === 'reviewed' && ex.ai_seconds) { // a background review that finished after the card was shown
      const added = [...(out.aiAdded?.components || []), ...(out.aiAdded?.symptoms || []), ...(out.aiAdded?.fault_codes || []), ...(out.aiAdded?.conditions || [])];
      return `<div class="ai-line">${icon('check')}<span>${ex.ai_seconds ? t('Reviewed by <b>{model}</b> in {n}s.', { model: esc(ex.ai_label), n: ex.ai_seconds }) : t('Reviewed by <b>{model}</b>.', { model: esc(ex.ai_label) })}${ex.rules_severity && ex.rules_severity !== ex.severity ? ` ${t('Severity raised from {from} to {to}.', { from: esc(t(ex.rules_severity)), to: esc(t(ex.severity)) })}` : ''}${added.length ? ` ${t('It also picked out: {items}.', { items: esc(added.map((x) => t(x)).join(', ')) })}` : ''}</span></div>`;
    }
    if (ex.ai_status === 'failed') return `<div class="ai-line">${icon('alert')}<span>${t('The AI review didn’t come back ({error}). What you see is the rule engine’s read, which is what the crew received.', { error: esc(ex.ai_error || t('no response')) })}</span></div>`;
    return '';
  }

  // ---------- the troubleshooting answer, built from this machine's record ----------
  const SCOPE_TAG = { 'this machine': 'this machine', 'same model': 'same model', 'applies to model': 'document', 'fleet reference': 'fleet' };
  const SRC_LABEL = { report: 'Report', alert: 'Issue', memory: 'Memory', graph: 'Graph', fix: 'Known fix', case: 'Eng. case', document: 'Document', fleet_reference: 'Other machine' };
  function srcChips(ids, sol) {
    const chips = (ids || []).map((id) => sol.sources.find((s) => s.id === id)).filter(Boolean)
      .map((s) => `<a class="chip src ${esc(s.scope.replace(/\s+/g, '-'))}" href="${esc(s.href)}" title="${esc(`${t(SRC_LABEL[s.type] || s.type)}: ${s.title} (${t(s.scope)})`)}"><span class="k">${esc(t(SCOPE_TAG[s.scope] || s.scope))}</span>${esc(s.id)}</a>`);
    return chips.length ? `<span class="srcs">${chips.join('')}</span>` : `<span class="srcs"><span class="chip src general"><span class="k">${t('general')}</span>${t('safety practice')}</span></span>`;
  }
  function solutionHtml(out) {
    const sol = out.solution;
    if (!sol) return '';
    const a = out.asset;
    const li = (it) => `<li><div>${esc(it.text)}</div>${it.caution ? `<div class="caution">${icon('alert')}${esc(it.caution)}</div>` : ''}${srcChips(it.sources, sol)}</li>`;
    const row = (it) => `<div class="sol-row">${it.scope ? `<span class="scope ${esc(it.scope.replace(/\s+/g, '-'))}">${esc(t(it.scope))}</span>` : ''}<div>${esc(it.text)}</div>${srcChips(it.sources, sol)}</div>`;
    const fixRow = (it) => `<div class="sol-row fix" data-fix="${it.fix_id || ''}">
        ${it.scope ? `<span class="scope ${esc(it.scope.replace(/\s+/g, '-'))}">${esc(t(it.scope))}</span>` : ''}<div>${esc(it.text)}</div>
        ${it.confidence_pct != null ? `<div class="conf"><i style="width:${it.confidence_pct}%"></i></div>` : ''}${srcChips(it.sources, sol)}
        ${it.fix_id ? `<div class="row wrap" style="margin-top:8px"><span class="muted" style="font-size:13px">${t('Tried it?')}</span><button class="btn sm" data-sfb="1">${icon('thumbUp')} ${t('It worked')}</button><button class="btn sm" data-sfb="0">${icon('thumbDown')} ${t('It didn’t')}</button></div>` : ''}
      </div>`;
    const status = sol.pending
      ? `<span class="sol-status pending">${icon('clock')}${t('<b>{model}</b> is reading {id}’s record now; this answer updates by itself.', { model: esc(sol.model || t('The AI model')), id: esc(a.id) })}</span>`
      : sol.mode === 'llm' ? `<span class="sol-status">${icon('check')}${sol.seconds ? t('Answered by <b>{model}</b> in {secs}s from {id}’s record ({n} records checked).', { model: esc(sol.model || 'AI'), secs: sol.seconds, id: esc(a.id), n: sol.scope?.records_considered ?? 0 }) : t('Answered by <b>{model}</b> from {id}’s record ({n} records checked).', { model: esc(sol.model || 'AI'), id: esc(a.id), n: sol.scope?.records_considered ?? 0 })}</span>`
        : sol.failed ? `<span class="sol-status">${icon('alert')}${t('The AI answer didn’t come back ({error}). This is the rule engine’s answer from {id}’s record.', { error: esc(sol.error || t('no response')), id: esc(a.id) })}</span>`
          : `<span class="sol-status">${icon('check')}${t('Built from {id}’s record by the rule engine ({n} records checked).', { id: esc(a.id), n: sol.scope?.records_considered ?? 0 })}</span>`;
    return `<div class="sol">
      <div class="sol-head"><span class="tag cat">${t('What to do')}</span><span class="muted">${t('for {id} · {model}', { id: esc(a.id), model: esc(a.model) })}</span></div>
      <h3 class="sol-h">${esc(sol.headline)}</h3>
      ${sol.safety_first ? `<div class="sol-safety">${icon('alert')}<div><b>${t('Safety first')}</b>${esc(sol.safety_first)}</div></div>` : ''}
      ${sol.do_now.length ? `<ol class="next-steps sol-steps">${sol.do_now.map(li).join('')}</ol>` : ''}
      ${sol.not_on_record.length ? `<div class="sol-none">${icon('search')}<div>${sol.not_on_record.map(esc).join('<br>')}</div></div>` : ''}
      <div class="res-dd" style="margin-top:10px">
        ${sol.record_shows.length ? dropdown(t('What {id}’s record shows', { id: esc(a.id) }), sol.record_shows.map(row).join(''), { open: true, count: sol.record_shows.length }) : ''}
        ${sol.worked_before.length ? dropdown(t('What fixed it before'), sol.worked_before.map(fixRow).join(''), { open: true, count: sol.worked_before.length }) : ''}
        ${sol.sources.length ? dropdown(t('Records used'), sol.sources.map((s) => `<a class="src-line" href="${esc(s.href)}"><span class="chip src ${esc(s.scope.replace(/\s+/g, '-'))}"><span class="k">${esc(t(SCOPE_TAG[s.scope] || s.scope))}</span>${esc(s.id)}</span><span>${esc(t(SRC_LABEL[s.type] || s.type))} · ${esc(s.title)}</span></a>`).join(''), { count: sol.sources.length }) : ''}
      </div>
      <div class="sol-foot">${status}</div>
    </div>`;
  }
  function wireSolution(box, out) {
    box.querySelectorAll('.sol-row.fix[data-fix] [data-sfb]').forEach((b) => b.onclick = async () => {
      const rowEl = b.closest('.sol-row');
      const fixId = Number(rowEl.dataset.fix);
      rowEl.querySelectorAll('[data-sfb]').forEach((x) => { x.disabled = true; });
      try {
        const r = await api(`/api/fixes/${fixId}/feedback`, { body: { worked: b.dataset.sfb === '1', assetId: out.asset.id, reportId: out.report.id, personId: state.me?.id } });
        const conf = rowEl.querySelector('.conf i'); if (conf) conf.style.width = `${r.fix.confidence}%`;
        b.parentElement.innerHTML = `<span class="muted" style="font-size:13px">${t('Saved. Now worked {n} of {total} times; the next crew sees your result.', { n: r.fix.success, total: r.fix.success + r.fix.fail })}</span>`;
        toast(t('Saved. This changes how the fix is ranked for everyone.'), 'good');
      } catch (err) { toast(esc(err.message), 'high'); rowEl.querySelectorAll('[data-sfb]').forEach((x) => { x.disabled = false; }); }
    });
  }
  const solutionSpeech = (sol) => [sol.safety_first, ...sol.do_now.slice(0, 4).map((s, i) => `${i + 1}. ${s.text}`)].filter(Boolean).join(' ');

  function renderResult(out, { quiet = false } = {}) {
    if (out.intent === 'delete_report') return renderDeleteResult(out, { quiet });
    const ex = out.report?.extraction || out.extraction;
    const chip = (label, items, cls = '') => (items || []).map((x) => `<span class="chip ${cls}"><span class="k">${t(label)}</span>${esc(t(x))}</span>`).join('');
    // With a troubleshooting answer on the card, it carries the steps and the known fixes itself.
    const sol = out.solution || null;
    const fix = out.intent === 'resolved' || sol ? null : out.fixes[0];
    const box = $('resultBox');
    const informational = ['resolved', 'question', 'routine_log'].includes(out.intent);
    const p = problemOf({ ...out.report, extraction: ex });
    const a = out.asset;
    const todo = out.intent === 'question' ? '' : out.intent === 'resolved' ? (ex.resolution ? t('Repair noted: {text}', { text: ex.resolution }) : '') : ex.operator_guidance;
    const steps = out.advice || [];
    const route = (d) => `<div class="route">${icon(DID_ICON[d.kind] || 'check')}<div>${esc(d.text)}</div></div>`;
    const told = out.routed.reduce((n, r) => n + (r.count || 0), 0);
    const picked = chip('part', ex.components) + chip('symptom', ex.symptoms) + chip('code', ex.fault_codes) + chip('condition', ex.conditions) + chip('hazard', ex.safety_hazards, 'hazard');
    box.innerHTML = `
      <div class="result-banner ${out.intent === 'resolved' ? 'low' : esc(ex.severity)}">
        <div class="row wrap" style="gap:6px">${out.intent ? `<span class="tag cat">${esc(t(INTENT[out.intent] || out.intent))}</span>` : ''}${ex.ai_status === 'pending' ? `<span class="tag">${t('AI reviewing…')}</span>` : ''}</div>
        <div class="h">${esc(p.title)}</div>
        ${keyFacts([
          [t('Machine'), `${esc(a.id)} <span class="muted" style="font-weight:500">${esc(a.model)}</span>`],
          [t('Location'), esc(a.site_name)],
          [t('Part'), esc(t(p.part || ''))],
          [t('Problem'), esc(t(p.problem || p.hazard || ''))],
          [t('Priority'), informational ? '' : sevPill(ex.severity)],
          [t('Code'), esc(p.code || '')],
          [t('When'), t('Just now')],
        ])}
      </div>
      ${out.needsChoice ? `<div class="res-sec" id="choice"><h4>${esc(out.needsChoice.prompt)}</h4>${out.needsChoice.options.map((o) => `<button class="pick" data-close="${o.id}"><b>${esc(alertTitle(o))}</b><div class="m">${metaLine([sevPill(o.severity), ago(o.created_at)])}</div></button>`).join('')}<button class="btn ghost sm" style="margin-top:8px" data-close="none">${t('None of these')}</button></div>` : ''}
      ${solutionHtml(out)}
      <div class="res-dd">
        ${out.answer ? dropdown(t('Answer'), `<div class="md answer">${md(out.answer.text)}</div><div class="faint mono" style="font-size:11px;margin-top:8px">${out.answer.mode === 'llm' ? t('answered by {model} from this machine’s record', { model: esc(out.answer.model || 'AI') }) : t('answered from the record')}</div>`, { open: true }) : ''}
        ${!sol && (todo || steps.length) ? dropdown(steps.length ? t('What to do next') : t('What to do'), `${todo ? `<p class="guidance" style="margin:0 0 10px">${esc(todo)}</p>` : ''}${steps.length ? `<ol class="next-steps">${steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}`, { open: out.intent === 'request_advice' || ex.severity === 'critical', count: steps.length ? (steps.length === 1 ? t('1 step') : t('{n} steps', { n: steps.length })) : null }) : ''}
        ${out.did?.length ? dropdown(t('What Cat Track did'), out.did.map(route).join(''), { count: out.did.length }) : ''}
        ${informational && !out.routed.length ? '' : dropdown(t('Who’s been told'), out.routed.length
          ? out.routed.map((r) => `<div class="route">${icon(r.to === 'CAT Engineering' ? 'wrench' : 'alert')}<div><b>${esc(t(r.to))}</b><div class="muted" style="font-size:13px">${esc(r.detail || '')}</div></div></div>`).join('')
          : `<div class="muted">${out.intent === 'update_existing' ? t('The people on the open issue see your update on it.') : t('Nobody new. It went on the machine’s record without paging anyone.')}</div>`, { count: told ? (told === 1 ? t('1 person') : t('{n} people', { n: told })) : t('nobody') })}
        ${out.actions.length ? dropdown(t('Tasks created'), out.actions.map((x) => `<div class="act"><span class="who">${esc(t(ROLE[x.assignee_role] || x.assignee_role))}</span><span>${esc(x.text)}</span></div>`).join(''), { count: out.actions.length }) : ''}
        ${fix ? dropdown(t('What fixed this before'), `<div class="fix-card">
          <b>${esc(fix.title)}</b>
          ${fix.steps ? `<div class="muted" style="font-size:13px;margin-top:4px">${esc(fix.steps)}</div>` : ''}
          <div class="conf"><i style="width:${fix.confidence}%"></i></div>
          <div class="muted" style="font-size:13px;margin-top:6px" id="fixStat">${t('Worked {n} of {total} times on {model} machines.', { n: fix.success, total: fix.success + fix.fail, model: esc(a.model) })}</div>
          <div class="row wrap" style="margin-top:10px"><span class="muted" style="font-size:13px">${t('Tried it?')}</span><button class="btn sm" data-fb="1">${icon('thumbUp')} ${t('It worked')}</button><button class="btn sm" data-fb="0">${icon('thumbDown')} ${t('It didn’t')}</button></div>
        </div>`, { count: t('{n}% success', { n: fix.confidence }) }) : ''}
        ${out.similar.length ? dropdown(t('Seen before'), out.similar.slice(0, 3).map((x) => `<div class="sim"><div class="row spread"><span class="id">${esc(x.asset_id)}</span><span class="faint mono" style="font-size:12px">${dateShort(x.created_at)}</span></div><div>${esc(x.summary)}</div><div class="faint" style="font-size:12px;margin-top:2px">${t('matched on {reasons}', { reasons: esc(x.reasons.slice(0, 4).map((r) => t(r)).join(', ')) })}</div></div>`).join(''), { count: out.similar.length }) : ''}
        ${(ex.likely_causes || []).length ? dropdown(t('Likely causes'), ex.likely_causes.map((c) => `<div class="act"><span class="who">${t('possible')}</span><span>${esc(c)}</span></div>`).join(''), { count: ex.likely_causes.length }) : ''}
        ${dropdown(t('Details'), kv([
          [t('You said'), `<q>${esc(out.report.raw_text)}</q>`],
          [t('Summary'), ex.summary !== p.title ? esc(ex.summary) : ''],
          [t('Picked out'), picked ? `<div class="chips">${picked}</div>` : ''],
          [t('Read by'), ex.ai_status === 'reviewed' || ex.ai_mode === 'llm' ? esc(ex.ai_label || 'AI') : t('rule engine')],
          [t('On the record'), `${out.graph.newNodes === 1 ? t('1 new fact') : t('{n} new facts', { n: out.graph.newNodes })}, ${t('{n} new links', { n: out.graph.newEdges })}, ${t('{n} confirmed', { n: out.graph.reinforced })}`],
        ]) + aiLine(out) + (out.report.photo_path ? `<img src="${esc(out.report.photo_path)}" alt="${t('Photo attached to this report')}" style="margin-top:12px;max-width:100%;border-radius:4px;border:1px solid var(--line)">` : ''))}
      </div>
      <button class="btn block lg" style="margin-top:14px" id="newReport">${icon('mic')} ${t('Report something else')}</button>`;
    box.classList.remove('hidden');
    if (!quiet) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (sol) wireSolution(box, out);
    box.querySelectorAll('[data-fb]').forEach((b) => b.onclick = async () => {
      try {
        const r = await api(`/api/fixes/${fix.id}/feedback`, { body: { worked: b.dataset.fb === '1', assetId: out.asset.id, reportId: out.report.id, personId: state.me?.id } });
        box.querySelector('#fixStat').textContent = t('Now worked {n} of {total} times. Thanks — the next crew will see your result.', { n: r.fix.success, total: r.fix.success + r.fix.fail });
        box.querySelectorAll('[data-fb]').forEach((x) => { x.disabled = true; });
        toast(t('Saved. This changes how the fix is ranked for everyone.'), 'good');
      } catch (err) { toast(esc(err.message), 'high'); }
    });
    box.querySelector('#newReport').onclick = () => { box.classList.add('hidden'); $('reportBox').scrollIntoView({ behavior: 'smooth' }); };
    box.querySelectorAll('[data-close]').forEach((b) => b.onclick = async () => {
      const choice = box.querySelector('#choice');
      if (b.dataset.close === 'none') { choice.innerHTML = `<div class="muted">${t('Left everything open. Saved as a repair record on this machine.')}</div>`; return; }
      box.querySelectorAll('[data-close]').forEach((x) => { x.disabled = true; });
      try {
        const r = await api(`/api/reports/${out.report.id}/resolve`, { body: { alertId: Number(b.dataset.close), personId: state.me?.id } });
        choice.innerHTML = `<div class="route">${icon('check')}<div>${t('Closed “{title}”, with its tasks.', { title: esc(alertTitle(r.alert)) })}${r.learnedFixId ? ` ${t('Your repair is saved as a known fix.')}` : ''}</div></div>`;
        out.needsChoice = null;
        toast(t('Issue closed.'), 'good');
        loadUnit(out.asset.id, { quiet: true });
      } catch (err) { toast(esc(err.message), 'high'); box.querySelectorAll('[data-close]').forEach((x) => { x.disabled = false; }); }
    });
    if (!quiet) {
      const lead = out.intent === 'resolved'
        ? (out.did?.find((d) => d.kind === 'resolved') ? `Done. ${out.did.find((d) => d.kind === 'resolved').text}` : out.needsChoice ? 'Got it. Which issue did you fix? Pick it on screen.' : 'Repair noted.')
        : out.intent === 'question' && out.answer ? plain(out.answer.text).slice(0, 320)
          : sol ? `${ex.severity === 'critical' ? 'Critical. ' : ''}${solutionSpeech(sol)}`
            : `${ex.severity === 'critical' ? 'Critical. ' : ''}${out.advice?.length ? `Here's what to do. ${out.advice.map((x, i) => `${i + 1}. ${x}`).join(' ')}` : ex.operator_guidance}`;
      const tail = out.routed.length ? ` I've alerted ${out.routed.map((r) => r.to).join(' and ')}.` : out.did?.find((d) => d.kind === 'help') ? ` ${out.did.find((d) => d.kind === 'help').text}.` : '';
      speak(`${lead}${tail}`);
    }
  }

  // ---------- "delete my last report" ----------
  const whoWhen = (r) => metaLine([esc(r.person_name || t(SOURCE_LABEL[r.source] || '')), `<span title="${esc(dateTime(r.created_at))}">${ago(r.created_at)}</span>`]);

  function renderDeleteResult(out, { quiet = false } = {}) {
    const box = $('resultBox');
    const gone = out.deleted || [];
    const choice = out.needsChoice;
    const one = gone.length === 1 ? gone[0] : null;
    const others = (out.did || []).filter((d) => d.kind !== 'deleted');
    const route = (d) => `<div class="route">${icon(DID_ICON[d.kind] || 'check')}<div>${esc(d.text)}</div></div>`;
    const head = one ? t('Deleted: {title}', { title: problemOf(one).title }) : gone.length ? t('Deleted {n} reports', { n: gone.length }) : choice?.confirm ? choice.prompt : choice ? t('Which report should go?') : out.undone ? t('Put back') : t('Nothing was deleted');
    box.innerHTML = `
      <div class="result-banner">
        <div class="row wrap" style="gap:6px"><span class="tag cat">${t(INTENT.delete_report)}</span></div>
        <div class="h">${esc(head)}</div>
        ${one ? keyFacts([[t('Machine'), esc(one.asset_id)], [t('Part'), esc(t(problemOf(one).part || ''))], [t('Priority'), ['mechanical', 'safety'].includes(one.category) ? sevPill(one.severity) : ''], [t('Reported'), ago(one.created_at)], [t('By'), esc(one.person_name || t(SOURCE_LABEL[one.source] || ''))]]) : ''}
        ${!gone.length && !choice && out.did?.[0] ? `<div class="guidance">${esc(out.did[0].text)}</div>` : ''}
        ${choice?.confirm ? `<div class="guidance">${t('Nothing goes until you confirm.')}</div>` : ''}
      </div>
      ${gone.length > 1 ? `<div class="res-sec">${gone.map((d) => keyRow({ tone: toneOf(d), title: esc(problemOf(d).title), meta: whoWhen(d), body: kv([[t('Said'), `<q>${esc(d.raw_text)}</q>`]]) })).join('')}</div>` : ''}
      ${gone.length ? `<button class="btn block" id="undoDelete" style="margin-top:12px">${icon('history')} ${gone.length === 1 ? t('Undo, put it back') : t('Undo, put them back')}</button>` : ''}
      ${gone.length ? `<div class="res-dd" style="margin-top:12px">${one ? dropdown(t('What was said'), `<q class="said">${esc(one.raw_text)}</q>`) : ''}${others.length ? dropdown(t('What else changed'), others.map(route).join(''), { count: others.length }) : ''}</div>` : ''}
      ${choice && !choice.confirm ? `<div class="res-sec" id="choice"><h4>${esc(choice.prompt)}</h4>${choice.options.map((o) => `<button class="pick" data-del="${o.id}"><b>${esc(problemOf(o).title)}</b><div class="m">${whoWhen(o)}</div></button>`).join('')}
        <button class="btn ghost sm" style="margin-top:8px" data-keep>${t('Keep everything')}</button></div>` : ''}
      ${choice?.confirm ? `<div class="res-sec" id="choice"><h4>${t('These would go')}</h4>${choice.options.map((o) => `<div class="issue-line"><span>${esc(problemOf(o).title)}</span><span class="faint">${whoWhen(o)}</span></div>`).join('')}
        <div class="row wrap" style="margin-top:12px"><button class="btn danger" data-del-all>${icon('x')} ${t('Delete all {n}', { n: choice.options.length })}</button><button class="btn ghost" data-keep>${t('Keep them')}</button></div></div>` : ''}
      <button class="btn block lg" style="margin-top:14px" id="newReport">${icon('mic')} ${t('Report something else')}</button>`;
    box.classList.remove('hidden');
    if (!quiet) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    box.querySelector('#newReport').onclick = () => { box.classList.add('hidden'); $('reportBox').scrollIntoView({ behavior: 'smooth' }); };
    box.querySelector('#undoDelete')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        const r = await api('/api/reports/restore', { body: { ids: gone.map((d) => d.id), personId: state.me?.id } });
        Object.assign(out, { deleted: [], needsChoice: null, undone: true, did: [{ kind: 'note', text: r.restored.length === 1 ? t('The report is back on the record, with its alerts and links.') : t('{n} reports are back on the record, with their alerts and links.', { n: r.restored.length }) }] });
        renderDeleteResult(out, { quiet: true });
        toast(t('Put back on the record.'), 'good');
      } catch (err) { toast(esc(err.message), 'high'); e.currentTarget.disabled = false; }
    });
    const doDelete = async (ids) => {
      box.querySelectorAll('[data-del],[data-del-all],[data-keep]').forEach((x) => { x.disabled = true; });
      try {
        const r = await api('/api/reports/delete', { body: { ids, personId: state.me?.id, reason: out.said || '', via: 'voice' } });
        Object.assign(out, { deleted: r.deleted, did: r.did, needsChoice: null });
        renderDeleteResult(out, { quiet: true });
        toast(r.deleted.length === 1 ? t('Deleted the report.') : t('Deleted {n} reports.', { n: r.deleted.length }), 'good');
      } catch (err) { toast(esc(err.message), 'high'); box.querySelectorAll('[data-del],[data-del-all],[data-keep]').forEach((x) => { x.disabled = false; }); }
    };
    box.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => doDelete([Number(b.dataset.del)]));
    box.querySelector('[data-del-all]')?.addEventListener('click', () => doDelete(choice.options.map((o) => o.id)));
    box.querySelector('[data-keep]')?.addEventListener('click', () => {
      Object.assign(out, { needsChoice: null, did: [{ kind: 'note', text: t('Kept everything. Nothing was deleted.') }] });
      renderDeleteResult(out, { quiet: true });
    });
    if (!quiet) {
      speak(one ? `Deleted the report: ${plain(problemOf(one).title)}. Tap undo if that was the wrong one.`
        : gone.length ? `Deleted ${gone.length} reports. Tap undo if that was wrong.`
          : choice?.confirm ? `That would delete ${choice.options.length} reports. Confirm on screen if you mean it.`
            : choice ? 'Which report should I delete? Pick it on screen.' : plain(out.did?.[0]?.text || 'Nothing was deleted.'));
    }
  }

  // ---------- this machine's earlier reports ----------
  const hist = { scope: store.get('histScope', 'all'), items: [], next: null, total: 0, seq: 0 };
  function histRow(r) {
    const p = problemOf(r);
    const problem = ['mechanical', 'safety'].includes(r.category);
    return keyRow({
      tone: toneOf(r), attrs: `data-id="${r.id}"`,
      title: esc(p.title),
      meta: metaLine([`<span title="${esc(dateTime(r.created_at))}">${ago(r.created_at)}</span>`, esc(r.person_name || t(SOURCE_LABEL[r.source] || r.source))]),
      right: `${problem ? sevPill(r.severity) : ''}<span class="rep-status ${esc(r.status)}"><i></i>${esc(t(REPORT_STATUS[r.status] || r.status))}</span>`,
      body: kv([
        [t('Said'), `<q>${esc(r.raw_text)}</q>`],
        [t('Summary'), r.summary !== p.title ? esc(r.summary) : ''],
        [t('Fault code'), esc(p.code || '')],
        [t('Reported by'), esc([r.person_name, t(SOURCE_LABEL[r.source] || r.source).toLowerCase()].filter(Boolean).join(', '))],
        [t('When'), esc(dateTime(r.created_at))],
        [t('What to do'), problem ? esc(r.extraction?.operator_guidance || '') : ''],
      ]) + `<div class="kr-actions"><button class="btn sm" type="button" data-rm="${r.id}">${icon('x')} ${t('Delete this report')}</button></div>`,
    });
  }
  function renderHistory() {
    if (!state.unit) return;
    const id = state.unit.asset.id;
    $('histTitle').textContent = t('Earlier reports on {id}', { id });
    $('histScope').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.s === hist.scope));
    $('histCount').textContent = hist.total ? t('{n} on record', { n: hist.total }) : '';
    const mine = hist.scope === 'mine';
    $('histList').innerHTML = hist.items.length ? hist.items.map(histRow).join('')
      : emptyState({ icon: 'history', title: mine ? t('Nothing from {name} on {id} yet', { name: esc(state.me?.name.split(' ')[0] || t('you')), id: esc(id) }) : t('Nothing on record for {id} yet', { id: esc(id) }), body: mine ? t('Switch to Everyone to see what the rest of the crew reported.') : t('The first voice note, repair or sensor alarm on this machine starts its history.') });
    $('histMore').innerHTML = hist.next ? `<button class="btn ghost sm" type="button" id="histMoreBtn" style="margin-top:8px">${t('Show older reports')}</button>`
      : hist.total > 6 ? `<a href="/reports?asset=${encodeURIComponent(id)}" style="display:inline-block;margin-top:10px;font-size:14px">${t('Open {id} in the report log', { id: esc(id) })}</a>` : '';
    $('histMoreBtn')?.addEventListener('click', () => loadHistory({ more: true }));
  }
  async function loadHistory({ more = false } = {}) {
    if (!state.unit) return;
    const seq = ++hist.seq;
    const id = state.unit.asset.id;
    if (!more) $('histList').innerHTML = hist.items.length && hist.items[0].asset_id === id ? $('histList').innerHTML : skeleton(3, 'block');
    const qs = new URLSearchParams({ asset: id, limit: more ? '10' : '6' });
    if (hist.scope === 'mine' && state.me) qs.set('person', state.me.id);
    if (more && hist.next) qs.set('before', hist.next);
    try {
      const [page, deleted] = await Promise.all([api(`/api/reports/log?${qs}`), more ? null : api(`/api/reports/deleted?asset=${encodeURIComponent(id)}&limit=10`)]);
      if (seq !== hist.seq) return;
      hist.items = more ? [...hist.items, ...page.reports] : page.reports;
      hist.next = page.next; hist.total = page.total;
      renderHistory();
      if (deleted) renderDeleted(deleted);
    } catch (err) {
      if (seq === hist.seq && !more) $('histList').innerHTML = emptyState({ icon: 'wifiOff', error: true, title: t('Couldn’t load earlier reports'), body: esc(err.message) });
    }
  }
  function renderDeleted(rows) {
    const el = $('histDeleted');
    el.classList.toggle('hidden', !rows.length);
    if (!rows.length) return;
    el.querySelector('summary').textContent = t('Deleted from {id} ({n})', { id: state.unit.asset.id, n: `${rows.length}${rows.length === 10 ? '+' : ''}` });
    $('histDeletedList').innerHTML = rows.map((x) => keyRow({
      tone: 'withdrawn',
      title: esc(problemOf(x).title),
      meta: metaLine([t('deleted {when}', { when: ago(x.deleted_at) }), x.deleted_by_name ? t('by {name}', { name: esc(x.deleted_by_name) }) : '', x.via === 'voice' ? t('by voice') : '']),
      body: kv([[t('Said'), `<q>${esc(x.raw_text || '')}</q>`], [t('Reported by'), esc([x.person_name, ago(x.created_at)].filter(Boolean).join(', '))], [t('Why deleted'), x.reason ? `<q>${esc(x.reason)}</q>` : '']])
        + `<div class="kr-actions"><button class="btn sm" type="button" data-restore="${x.id}">${icon('history')} ${t('Restore')}</button></div>`,
    })).join('');
  }
  $('histScope').querySelectorAll('button').forEach((b) => b.onclick = () => { hist.scope = b.dataset.s; store.set('histScope', hist.scope); hist.next = null; hist.items = []; loadHistory(); });
  $('history').addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      const id = Number(rm.dataset.rm);
      const row = rm.closest('.kr'); row.classList.add('gone');
      try {
        const r = await api('/api/reports/delete', { body: { ids: [id], personId: state.me?.id, via: 'manual' } });
        const d = r.deleted[0];
        undoBar(t('Deleted “{title}”.', { title: esc(clip(problemOf(d).title, 60)) }), async () => { await api('/api/reports/restore', { body: { ids: [id], personId: state.me?.id } }); toast(t('Put back on the record.'), 'good'); });
      } catch (err) { row.classList.remove('gone'); toast(esc(err.message), 'high'); }
      return;
    }
    const rs = e.target.closest('[data-restore]');
    if (rs) {
      rs.disabled = true;
      try { await api('/api/reports/restore', { body: { ids: [Number(rs.dataset.restore)], personId: state.me?.id } }); toast(t('Put back on the record.'), 'good'); }
      catch (err) { rs.disabled = false; toast(esc(err.message), 'high'); }
    }
  });
  let histTimer = null;
  const softHistory = () => { clearTimeout(histTimer); histTimer = setTimeout(() => { hist.next = null; loadHistory(); }, 250); };

  // The model review can finish before the submit response arrives (fast providers), so park it.
  const earlyUpdates = new Map();
  function applyReview({ report, status, added }) {
    const out = state.lastResult;
    if (!out || $('resultBox').classList.contains('hidden')) return;
    out.report = report; out.extraction = report.extraction; out.aiAdded = added;
    renderResult(out, { quiet: true });
    if (status === 'reviewed') toast(t('{model} finished reviewing your report.', { model: esc(report.extraction.ai_label) }), 'good');
  }
  // Same for the model's troubleshooting answer: it replaces the rule engine's on the card.
  const earlySolutions = new Map();
  function applySolution(ev) {
    const out = state.lastResult;
    if (!out || $('resultBox').classList.contains('hidden')) return;
    if (ev.status === 'done' && ev.solution) {
      out.solution = ev.solution;
      renderResult(out, { quiet: true });
      toast(t('{model} finished reading {id}’s record.', { model: esc(ev.solution.model || t('The AI model')), id: esc(out.asset.id) }), 'good');
    } else if (out.solution) {
      out.solution = { ...out.solution, pending: false, failed: true, error: ev.error };
      renderResult(out, { quiet: true });
    }
  }
  const park = (map, key, ev) => { map.set(key, ev); if (map.size > 20) map.delete(map.keys().next().value); };

  // ---------- live site alerts ----------
  let feedAlerts = [];
  async function loadFeed() {
    if (!state.unit) return;
    $('feedTitle').textContent = t('Alerts at {site}', { site: state.unit.asset.site_name });
    $('feed').innerHTML = skeleton(2, 'block');
    try { feedAlerts = await api(`/api/alerts?site=${encodeURIComponent(state.unit.asset.site_id)}`); renderFeed(); } catch { /* keep old */ }
  }
  function renderFeed(flashId) {
    $('feedCount').textContent = feedAlerts.length ? t('{n} open', { n: feedAlerts.length }) : '';
    $('feed').innerHTML = feedAlerts.length
      ? feedAlerts.slice(0, 8).map((a) => keyRow({
        tone: `${toneOf(a)} ${a.id === flashId ? 'flash' : ''}`,
        title: esc(alertTitle(a)),
        meta: metaLine([a.asset_id ? `<span class="id">${esc(a.asset_id)}</span> ${esc(a.model || '')}` : t('Every machine of this model'), `<span title="${esc(dateTime(a.created_at))}">${ago(a.created_at)}</span>`]),
        right: a.kind === 'bulletin' ? '<span class="tag cat">CAT</span>' : sevPill(a.severity),
        body: alertDetails(a),
      })).join('')
      : emptyState({ icon: 'shield', title: t('Nothing open at {site}', { site: esc(state.unit.asset.site_name) }), body: t('When anyone on this site reports a problem, it shows up here within a second, and your phone buzzes.') });
  }

  connectStream({
    alert: ({ alert }) => {
      if (!state.unit || alert.site_id !== state.unit.asset.site_id) return;
      feedAlerts = [alert, ...feedAlerts.filter((a) => a.id !== alert.id)];
      renderFeed(alert.id);
      const ownReport = state.submitting && alert.asset_id === state.unit.asset.id;
      if (!ownReport && state.lastResult?.alert?.id !== alert.id) {
        toast(`${icon('alert')} <b>${esc(alert.asset_id ? alert.asset_id + ' · ' : '')}${esc(alertTitle(alert))}</b>`, alert.severity);
        navigator.vibrate?.([60, 40, 60]);
      }
    },
    'alert-updated': ({ alert }) => {
      if (!state.unit || alert.site_id !== state.unit.asset.site_id) return;
      if (alert.status === 'resolved') feedAlerts = feedAlerts.filter((a) => a.id !== alert.id);
      else if (feedAlerts.some((a) => a.id === alert.id)) feedAlerts = feedAlerts.map((a) => (a.id === alert.id ? alert : a));
      else feedAlerts = [alert, ...feedAlerts].sort((a, b) => b.created_at.localeCompare(a.created_at)); // reopened
      renderFeed();
    },
    report: ({ report }) => { if (state.unit && report.asset_id === state.unit.asset.id) softHistory(); },
    'report-deleted': ({ reports }) => { if (state.unit && reports.some((r) => r.asset_id === state.unit.asset.id)) softHistory(); },
    'report-restored': ({ reports }) => { if (state.unit && reports.some((r) => r.asset_id === state.unit.asset.id)) softHistory(); },
    asset: (asset) => { if (state.unit && asset.id === state.unit.asset.id) loadUnit(asset.id, { quiet: true }); },
    'report-updated': (ev) => {
      if (state.unit && ev.report?.asset_id === state.unit.asset.id) softHistory();
      const out = state.lastResult;
      if (!out || out.report?.id !== ev.reportId) { park(earlyUpdates, ev.reportId, ev); return; }
      applyReview(ev);
    },
    solution: (ev) => {
      const out = state.lastResult;
      if (!out || out.report?.id !== ev.reportId) { park(earlySolutions, ev.reportId, ev); return; }
      applySolution(ev);
    },
  }, $('live'));

  // ---------- boot ----------
  renderRecent();
  updateSubmit();
  loadPeople().catch(() => toast(t('Could not load crew list'), 'high'));
  const qs = new URLSearchParams(location.search).get('unit');
  if (qs) { unitInput.value = qs.toUpperCase(); loadUnit(qs, { quiet: true }); } else renderNoUnit();
})();
