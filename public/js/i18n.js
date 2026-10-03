// Language layer for every Cat Track screen. English text is the key: t('Send report') looks the
// English up in the active catalog (public/i18n/<lang>.js) and falls back to the English itself,
// so a missing translation never blanks a label. Loaded before common.js.
(function () {
  const LANGS = {
    en: { label: 'EN', name: 'English', locale: 'en-US', speech: 'en-US' },
    es: { label: 'ES', name: 'Español', locale: 'es-MX', speech: 'es-MX' },
    hi: { label: 'हिं', name: 'हिन्दी', locale: 'hi-IN', speech: 'hi-IN' },
  };
  const KEY = 'cattrack:lang';
  const catalogs = (window.CT_I18N = window.CT_I18N || {});

  const normalize = (code) => {
    const c = String(code || '').toLowerCase().split(/[-_]/)[0];
    return LANGS[c] ? c : null;
  };
  function resolve() {
    const url = new URLSearchParams(location.search).get('lang');
    if (normalize(url)) { try { localStorage.setItem(KEY, JSON.stringify(normalize(url))); } catch { /* ignore */ } return normalize(url); }
    try { const saved = normalize(JSON.parse(localStorage.getItem(KEY))); if (saved) return saved; } catch { /* ignore */ }
    for (const l of navigator.languages || [navigator.language]) { const n = normalize(l); if (n) return n; }
    return 'en';
  }
  const lang = resolve();
  const meta = LANGS[lang];
  document.documentElement.lang = lang;

  const missing = new Set();
  /** Translate an English string, substituting {name} placeholders from vars. */
  function t(key, vars) {
    if (key == null) return '';
    const k = String(key);
    let out = k;
    if (lang !== 'en') {
      const hit = catalogs[lang] && catalogs[lang][k];
      if (typeof hit === 'string') out = hit;
      else if (!missing.has(k) && /[a-z]/i.test(k)) { missing.add(k); if (window.CT_I18N_DEBUG) console.debug('[i18n] missing', lang, JSON.stringify(k)); }
    }
    if (vars) out = out.replace(/\{(\w+)\}/g, (m, name) => (vars[name] != null ? String(vars[name]) : m));
    return out;
  }

  function setLang(code) {
    const n = normalize(code) || 'en';
    try { localStorage.setItem(KEY, JSON.stringify(n)); } catch { /* ignore */ }
    const u = new URL(location.href); u.searchParams.delete('lang');
    location.replace(u.toString());
  }

  /**
   * Translate static markup: [data-i18n] text, [data-i18n-attr="placeholder,title"] attributes.
   * The English is stored on the element the first time, so applying again (after page scripts
   * have written a translation) doesn't look the translation up as if it were a key.
   */
  function apply(root = document) {
    if (lang === 'en') return;
    for (const el of root.querySelectorAll('[data-i18n]')) {
      let key = el.getAttribute('data-i18n');
      if (!key) {
        if (el.children.length) continue;
        key = el.textContent.trim();
        if (key) el.setAttribute('data-i18n', key);
      }
      if (key && el.children.length === 0) el.textContent = t(key);
    }
    for (const el of root.querySelectorAll('[data-i18n-attr]')) {
      for (const attr of el.getAttribute('data-i18n-attr').split(',').map((s) => s.trim()).filter(Boolean)) {
        const store = `data-i18n-orig-${attr}`;
        let v = el.getAttribute(store);
        if (v == null) { v = el.getAttribute(attr) || ''; if (v) el.setAttribute(store, v); }
        if (v) el.setAttribute(attr, t(v));
      }
    }
    for (const el of root.querySelectorAll('[data-i18n-html]')) {
      let key = el.getAttribute('data-i18n-html');
      if (!key) { key = el.innerHTML.trim(); if (key) el.setAttribute('data-i18n-html', key); }
      if (key) el.innerHTML = t(key);
    }
  }

  /** The EN / ES / हिं control for the header. */
  const picker = () => `<label class="lang-pick"><span class="sr-only">${t('Language')}</span><select aria-label="${t('Language')}" onchange="I18N.setLang(this.value)">${Object.entries(LANGS).map(([c, m]) => `<option value="${c}" ${c === lang ? 'selected' : ''} title="${m.name}">${m.label}</option>`).join('')}</select></label>`;

  const fmtDate = (iso, opts) => (iso ? new Date(iso).toLocaleDateString(meta.locale, opts) : '');
  const fmtDateTime = (iso, opts) => (iso ? new Date(iso).toLocaleString(meta.locale, opts) : '');
  const fmtNum = (n) => Number(n).toLocaleString(meta.locale);

  window.I18N = { lang, locale: meta.locale, speech: meta.speech, LANGS, t, setLang, apply, picker, fmtDate, fmtDateTime, fmtNum, missing };
  // Run now, while the markup above this script is still English and before the page script
  // rewrites it, and once more at DOMContentLoaded for anything parsed after this script.
  apply();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => apply());
})();
