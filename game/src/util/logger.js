/* ShopSim — журнал ошибок и отладка. Классический скрипт: загружается до модулей. */
(function () {
  const MAX = 200;
  const log = { errors: [], warns: [], info: [] };
  const errBox = () => document.getElementById('err');
  const errText = () => document.getElementById('errtext');
  const show = (title, msg) => {
    const box = errBox(), txt = errText();
    if (!box || !txt) return;
    txt.textContent = (txt.textContent ? txt.textContent + '\n' : '') + title + ': ' + msg;
    box.classList.remove('hidden');
  };
  function fmt(args) {
    return Array.prototype.map.call(args, (a) => {
      if (a instanceof Error) return (a.stack || a.message || String(a));
      if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
      return String(a);
    }).join(' ');
  }
  const api = {
    log: function () { const s = fmt(arguments); log.info.push(s); if (log.info.length > MAX) log.info.shift(); if (window.__debug) console.log('[shop]', s); },
    warn: function () { const s = fmt(arguments); log.warns.push(s); if (log.warns.length > MAX) log.warns.shift(); console.warn('[shop]', s); },
    error: function () { const s = fmt(arguments); log.errors.push(s); if (log.errors.length > MAX) log.errors.shift(); console.error('[shop]', s); if (!window.__silentErrors) show('Ошибка', s); },
    dump: () => JSON.parse(JSON.stringify(log)),
    clear: () => { log.errors.length = 0; log.warns.length = 0; },
  };
  window.ShopLog = api;
  window.addEventListener('error', (e) => api.error(e.message + ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0)));
  window.addEventListener('unhandledrejection', (e) => api.error('Promise: ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason)));
})();
