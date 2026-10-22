'use strict';
// Emuladores por console: detecção no PC, escolha do emulador e catálogo.

// ------------------------------------------------------------------ emuladores por console

const MAKER_GROUPS = ['Nintendo', 'Sony', 'Microsoft', 'Sega', 'NEC', 'SNK', 'Atari', 'Arcade', 'Computador', 'Outros'];
const makerGroup = (c) => (MAKER_GROUPS.includes(c.maker) ? c.maker : 'Outros');
const consoleById = (id) => CONSOLES.find((c) => c.id === id);
const emuCard = (e) => {
  const n = S.games.filter((g) => g.emulatorId === e.id).length;
  return `<div class="emu">
    <div class="info">
      <div class="name">${esc(e.name)} <span class="muted" style="font-size:13px">· ${esc(e.platform || 'sem plataforma')} · ${n} jogo(s)</span></div>
      <div class="meta">${esc(e.path)}</div>
      <div class="meta">Argumentos: <code>${esc(e.args)}</code> · Extensões: ${esc(e.extensions.join(' '))}</div>
    </div>
    <div class="actions">
      <button class="btn small primary" data-action="emu-scan" data-id="${e.id}">Escanear ROMs</button>
      <button class="btn small" data-action="emu-edit" data-id="${e.id}">Editar</button>
      <button class="btn small danger" data-action="emu-delete" data-id="${e.id}">Remover</button>
    </div>
  </div>`;
};

// Logo oficial do console (ou do fabricante), sobre um selo claro para que logos escuros fiquem legíveis.
function logoHtml(c, size = '') {
  const file = CONSOLE_LOGOS[c.id];
  if (!file) return `<span class="ct-icon ${size}">${CONSOLE_ICONS[c.maker] || '🎮'}</span>`;
  return `<span class="ct-icon logo ${size}"><img src="/logos/${file}" alt="${esc(c.name)}" loading="lazy"></span>`;
}
function measureLogos(root = document) {
  // Se algum logo faltar, volta para o ícone genérico.
  $$('.ct-icon.logo img', root).forEach((img) => img.addEventListener('error', () => {
    const box = img.parentElement;
    box.classList.remove('logo');
    box.textContent = '🎮';
  }, { once: true }));
}

// Emuladores já configurados para um console (pelo id do catálogo, ou pelo nome da plataforma nos antigos).
function configuredFor(c) {
  return S.emulators.filter((e) => e.consoleId === c.id || (!e.consoleId && e.platform === c.name));
}
function detectedPaths(emu) {
  if (!S.detected) return [];
  return [...new Set(emu.exe.flatMap((p) => S.detected.found[p] || []))];
}

function detectEmulators() {
  if (S.detecting) return S.detecting;
  const patterns = [...new Set(CONSOLES.flatMap((c) => c.emus.flatMap((e) => e.exe)))];
  S.detecting = api('/emulators/detect', { patterns })
    .then((r) => {
      S.detected = r;
      const n = Object.values(r.found).filter((paths) => paths.length).length;
      toast(n ? `${n} emulador(es) encontrado(s) no PC.` : 'Nenhum emulador conhecido encontrado. Use “Procurar manualmente” no console desejado.');
    })
    .catch((e) => toast(e.message, true))
    .finally(() => {
      S.detecting = null;
      refreshEmulatorScreens();
    });
  refreshEmulatorScreens();
  return S.detecting;
}

function refreshEmulatorScreens() {
  if (S.view === 'emulators' && !$('#modalRoot').childElementCount) render();
  const open = $('#consoleModal');
  if (open) consoleModal(open.dataset.id);
}

function emulatorsView() {
  if (S.detected === null && !S.detecting) setTimeout(detectEmulators, 0); // primeira visita: procura sozinho
  const found = S.detected ? Object.values(S.detected.found).filter((p) => p.length).length : 0;
  const status = S.detecting ? '<span class="spin"></span> Procurando emuladores instalados no PC…'
    : S.detected ? `${found} emulador(es) encontrado(s) no PC${S.detected.timedOut ? ' (busca parcial — tempo esgotado)' : ''}.` : '';
  const known = new Set(CONSOLES.map((c) => c.id));
  const custom = S.emulators.filter((e) => !(e.consoleId && known.has(e.consoleId)) && !CONSOLES.some((c) => !e.consoleId && e.platform === c.name));
  const maker = S.consoleMaker || 'Todos';
  const tile = (c) => {
    const conf = configuredFor(c);
    const det = c.emus.filter((e) => detectedPaths(e).length).length;
    const games = S.games.filter((g) => conf.some((e) => e.id === g.emulatorId)).length;
    const st = conf.length ? `<span class="ct-status ok">✓ ${conf.length} emulador · ${games} jogo(s)</span>`
      : det ? `<span class="ct-status found">● ${det} encontrado(s) no PC</span>` : '<span class="ct-status">Não configurado</span>';
    return `<button class="console-tile ${conf.length ? 'on' : ''}" data-action="console" data-id="${c.id}" data-search="${esc(`${c.name} ${c.maker} ${c.emus.map((e) => e.name).join(' ')}`.toLowerCase())}">
      ${logoHtml(c)}
      <span class="ct-info"><span class="ct-name">${esc(c.name)}</span><span class="ct-meta">${esc(c.maker)} · ${c.year} · ${c.emus.length} emulador(es)</span>${st}</span>
    </button>`;
  };
  const groups = MAKER_GROUPS.filter((g) => maker === 'Todos' || g === maker).map((g) => {
    const list = CONSOLES.filter((c) => makerGroup(c) === g);
    return list.length ? `<div class="console-group"><h3>${g === 'Computador' ? 'Computadores' : g}</h3><div class="console-grid">${list.map(tile).join('')}</div></div>` : '';
  }).join('');
  return `<div class="page">
    <div class="toolbar">
      <div><h2>Emuladores</h2><p class="sub" style="margin:0">Escolha o console, localize o emulador no seu PC e comece a usar.</p></div>
      <div class="spacer"></div>
      <button class="btn" data-action="emu-detect" ${S.detecting ? 'disabled' : ''}>🔎 Procurar emuladores no PC</button>
      <button class="btn ghost" data-action="emu-edit">+ Emulador personalizado</button>
    </div>
    <p class="detect-status">${status}</p>
    <div class="toolbar">
      <input class="input" id="consoleSearch" type="search" placeholder="Buscar console ou emulador… (ex.: PlayStation, Dolphin)" style="max-width:360px" autocomplete="off">
      <div class="seg">${['Todos', ...MAKER_GROUPS].map((g) => `<button class="${maker === g ? 'on' : ''}" data-action="console-maker" data-value="${g}">${g === 'Computador' ? 'Computadores' : g}</button>`).join('')}</div>
    </div>
    ${groups}
    ${custom.length ? `<div class="console-group"><h3>Emuladores personalizados</h3><div class="emu-list">${custom.map(emuCard).join('')}</div></div>` : ''}
  </div>`;
}

function consoleModal(id) {
  const c = consoleById(id);
  if (!c) return;
  const conf = configuredFor(c);
  const inUse = (emu, path) => conf.some((e) => e.path.toLowerCase() === path.toLowerCase() && e.args === emu.args);
  const row = (emu, i) => {
    const paths = detectedPaths(emu);
    const used = paths.find((p) => inUse(emu, p));
    return `<div class="emu-opt ${paths.length ? 'found' : ''}" data-i="${i}">
      <div class="info">
        <div class="name">${esc(emu.name)}</div>
        ${paths.length ? (paths.length > 1
          ? `<select class="input emu-path">${paths.map((p) => `<option>${esc(p)}</option>`).join('')}</select>`
          : `<div class="meta found-path">✓ Encontrado: <code>${esc(paths[0])}</code></div>`)
          : `<div class="meta">${S.detecting ? 'Procurando…' : 'Não encontrado no PC'} · procura por <code>${esc(emu.exe.join(', '))}</code></div>`}
        ${emu.core ? `<div class="meta">Precisa do núcleo <b>${esc(emu.core)}</b> no RetroArch (Menu principal → Atualizador online → Baixar núcleos).</div>` : ''}
      </div>
      <div class="actions">
        ${used ? '<span class="in-use">✓ Em uso</span>'
          : paths.length ? '<button class="btn small primary" data-emu="use">Usar este</button>' : ''}
        <button class="btn small" data-emu="locate" ${S.detecting ? 'disabled' : ''}>🔎 Localizar</button>
        <button class="btn small" data-emu="pick">📁 Procurar manualmente…</button>
        ${emu.url ? `<a class="btn small ghost" href="${esc(emu.url)}" target="_blank" rel="noopener">Baixar ↗</a>` : ''}
      </div>
    </div>`;
  };
  const html = `
    <div id="consoleModal" data-id="${c.id}">
      <div class="console-head">${logoHtml(c, 'big')}<h2>${esc(c.name)}</h2></div>
      <p class="hint" style="margin:-8px 0 16px">${esc(c.maker)} · ${c.year} · Arquivos aceitos: <code>${esc(c.ext.join(' '))}</code></p>
      ${conf.length ? `<h3 class="modal-sub">Seus emuladores para este console</h3><div class="emu-list">${conf.map(emuCard).join('')}</div>` : ''}
      <h3 class="modal-sub">Emuladores disponíveis</h3>
      <div class="emu-opts">${c.emus.map(row).join('')}</div>
      <div class="actions"><button class="btn ghost" data-close>Fechar</button></div>
    </div>`;
  const existing = $('#consoleModal');
  const m = existing ? existing.closest('.modal') : openModal(html, true);
  if (existing) {
    m.innerHTML = html;
    $$('[data-close]', m).forEach((b) => b.addEventListener('click', closeModal));
  }

  measureLogos(m);
  $$('.emu-opt', m).forEach((rowEl) => {
    const emu = c.emus[+rowEl.dataset.i];
    const chosenPath = () => $('.emu-path', rowEl)?.value || detectedPaths(emu)[0];
    $('[data-emu="use"]', rowEl)?.addEventListener('click', () => useEmulator(c, emu, chosenPath()));
    $('[data-emu="locate"]', rowEl).addEventListener('click', async () => {
      await detectEmulators();
      if (!detectedPaths(emu).length) toast(`${emu.name} não foi encontrado automaticamente. Use “Procurar manualmente…”.`, true, 6000);
    });
    $('[data-emu="pick"]', rowEl).addEventListener('click', async () => {
      const path = await pick('file', `Onde está o ${emu.name}?`, [[emu.name, emu.exe.join(' ')], ['Executáveis', '*.exe']]);
      if (path) useEmulator(c, emu, path);
    });
  });
}

async function useEmulator(c, emu, path) {
  const saved = await act(() => api('/emulators', {
    name: emu.name, path, args: emu.args, extensions: c.ext, platform: c.name, consoleId: c.id,
  }), `${emu.name} configurado para ${c.name}.`);
  if (!saved) return;
  await refresh(false);
  closeModal();
  scanModal(saved);
}
