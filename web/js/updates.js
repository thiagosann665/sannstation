'use strict';
// Atualização automática: procura uma versão nova nas Releases do GitHub (uma vez por dia)
// e oferece instalar. Na versão instalada, baixa o instalador e a SannStation reabre sozinha.

const UPDATE_KEY = 'sannstation-update';
function updatePrefs() {
  try { return JSON.parse(localStorage.getItem(UPDATE_KEY) || '{}'); } catch { return {}; }
}
function saveUpdatePrefs(patch) {
  try { localStorage.setItem(UPDATE_KEY, JSON.stringify({ ...updatePrefs(), ...patch })); } catch { /* sem storage */ }
}

async function checkUpdates({ manual = false } = {}) {
  if (!manual && (S.settings.checkUpdates === false || Date.now() - (updatePrefs().checkedAt || 0) < 86400000)) return;
  let info;
  try {
    info = await api(`/update/check${manual ? '?force=1' : ''}`);
  } catch (e) {
    if (manual) toast(e.message, true);
    return;
  }
  saveUpdatePrefs({ checkedAt: Date.now() });
  S.update = info;
  if (!info.available) {
    if (manual) toast(`Você está na versão mais recente (${info.current}).`);
    return;
  }
  if (!manual && updatePrefs().skipped === info.version) return;
  showUpdateBar(info);
}

function showUpdateBar(info) {
  $('#updateBar')?.remove();
  const bar = document.createElement('div');
  bar.id = 'updateBar';
  const auto = info.mode === 'installed' && info.setup;
  bar.innerHTML = `<span>🎉 <b>SannStation ${esc(info.version)}</b> disponível (você tem a ${esc(info.current)}).</span>
    <div class="spacer"></div>
    ${info.page ? `<a class="btn small ghost" href="${esc(info.page)}" target="_blank" rel="noopener">Novidades ↗</a>` : ''}
    ${auto ? '<button class="btn small primary" data-up="install">Atualizar agora</button>'
      : info.page ? `<a class="btn small primary" href="${esc(info.page)}" target="_blank" rel="noopener">Baixar</a>` : ''}
    <button class="btn small ghost" data-up="later" title="Não avisar desta versão de novo">Pular esta versão</button>
    <button class="x" data-up="close" title="Fechar">✕</button>`;
  document.body.insertBefore(bar, $('.layout'));
  bar.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-up]');
    if (!b) return;
    if (b.dataset.up === 'close') bar.remove();
    if (b.dataset.up === 'later') { saveUpdatePrefs({ skipped: info.version }); bar.remove(); }
    if (b.dataset.up === 'install') {
      if (Object.keys(S.running).length) return toast('Feche o jogo antes de atualizar.', true);
      b.disabled = true;
      b.textContent = 'Baixando…';
      const res = await act(() => api('/update/install', {}));
      if (!res) { b.disabled = false; b.textContent = 'Atualizar agora'; return undefined; }
      S.updating = true; // o app vai fechar: sem o aviso de "sem conexão"
      bar.innerHTML = `<span>⏳ Instalando a versão ${esc(res.installing)}… a SannStation fecha e reabre sozinha em alguns segundos.</span>`;
      const started = Date.now();
      const poll = setInterval(async () => {
        try {
          const r = await fetch('/api/hello', { cache: 'no-store' }).then((x) => x.json());
          if (r.version === res.installing) {
            clearInterval(poll);
            bar.innerHTML = `<span>✅ Versão ${esc(res.installing)} instalada. A nova janela já abriu — esta pode ser fechada.</span>`;
            setTimeout(() => window.close(), 1500);
          }
        } catch { /* ainda reiniciando */ }
        if (Date.now() - started > 180000) clearInterval(poll);
      }, 2000);
    }
    return undefined;
  });
}
