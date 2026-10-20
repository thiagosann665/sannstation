'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SOURCES = { manual: 'Adicionado manualmente', steam: 'Steam', epic: 'Epic Games', gog: 'GOG', 'rom-scan': 'Escaneamento de ROMs' };

const S = {
  games: [], emulators: [], settings: {}, running: [], dataDir: '',
  view: 'library', selected: null, filter: { type: 'all', value: null },
  search: '', sort: 'name', showHidden: false, size: 180,
  detected: null, detecting: null, consoleMaker: 'Todos',
};
let pollTimer = null;

// ------------------------------------------------------------------ utilidades

function loadPrefs() {
  try { Object.assign(S, JSON.parse(localStorage.getItem('sannstation-prefs') || localStorage.getItem('ludoteca-prefs') || '{}')); } catch { /* sem storage */ }
}
function savePrefs() {
  try { localStorage.setItem('sannstation-prefs', JSON.stringify({ sort: S.sort, size: S.size, showHidden: S.showHidden })); } catch { /* sem storage */ }
}

// Identifica esta janela para o programa saber quando todas foram fechadas.
const PAGE_ID = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);

async function api(path, body, method) {
  const opts = {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: { 'X-Token': window.LUDO_TOKEN, 'X-Page': PAGE_ID },
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch('/api' + path, opts);
  } catch {
    showOffline();
    throw new Error('Sem conexão com a SannStation. Ela foi fechada? Abra o programa de novo.');
  }
  hideOffline();
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && /Sessão expirada/.test(data.error || '')) {
    location.reload(); // o programa foi reaberto: pega o novo token
  }
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

// Aviso fixo quando o programa não responde; some sozinho quando ele volta.
function showOffline() {
  if ($('#offline')) return;
  const bar = document.createElement('div');
  bar.id = 'offline';
  bar.innerHTML = '<b>Sem conexão com a SannStation.</b> O programa foi fechado — abra a SannStation de novo pelo atalho. '
    + '<button class="btn small">Tentar de novo</button>';
  $('button', bar).addEventListener('click', () => location.reload());
  document.body.appendChild(bar);
}
function hideOffline() {
  $('#offline')?.remove();
}

function toast(msg, isErr = false, ms = 3800) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, true, 6000);
    return undefined;
  }
}

const coverUrl = (g) => (g.cover ? `/covers/${encodeURIComponent(g.cover)}` : '');
const heroUrl = (g) => (g.hero ? `/covers/${encodeURIComponent(g.hero)}` : '');
const gameById = (id) => S.games.find((g) => g.id === id);
const emuById = (id) => S.emulators.find((e) => e.id === id);
const isRunning = (g) => S.running.includes(g.id);

function fmtPlaytime(sec) {
  if (!sec) return 'Nenhum';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  return `${(sec / 3600).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} h`;
}
function fmtDate(ts) {
  if (!ts) return 'Nunca';
  const d = new Date(ts * 1000);
  const days = Math.floor((Date.now() - d) / 86400000);
  if (days === 0) return 'Hoje';
  if (days === 1) return 'Ontem';
  if (days < 7) return `Há ${days} dias`;
  return d.toLocaleDateString('pt-BR');
}
function cleanTitle(path) {
  const base = path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  const name = base.replace(/[([{].*?[)\]}]/g, ' ').replace(/[_.]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return name || base;
}
function platforms() {
  const set = new Set(['PC']);
  S.games.forEach((g) => g.platform && set.add(g.platform));
  S.emulators.forEach((e) => e.platform && set.add(e.platform));
  return [...set].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

// ------------------------------------------------------------------ dados

async function refresh(renderAll = true) {
  const st = await api('/state');
  Object.assign(S, { games: st.games, emulators: st.emulators, settings: st.settings, running: st.running, dataDir: st.dataDir });
  if (S.selected && !gameById(S.selected)) S.selected = null;
  if (renderAll) render();
  else renderSidebar();
  const openConsole = $('#consoleModal');
  if (openConsole) consoleModal(openConsole.dataset.id);
  schedulePoll();
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (!S.running.length) return;
  // Enquanto um jogo roda, atualiza o estado para registrar o tempo de jogo ao fechar.
  pollTimer = setTimeout(() => {
    const quiet = S.view !== 'library' || $('#modalRoot').childElementCount > 0;
    refresh(!quiet).catch(() => schedulePoll());
  }, 4000);
}

function visibleGames() {
  const q = S.search.trim().toLowerCase();
  const f = S.filter;
  let list = S.games.filter((g) => (f.type === 'hidden' ? g.hidden : S.showHidden || !g.hidden));
  if (f.type === 'fav') list = list.filter((g) => g.favorite);
  if (f.type === 'recent') list = list.filter((g) => g.lastPlayed);
  if (f.type === 'unplayed') list = list.filter((g) => !g.lastPlayed);
  if (f.type === 'platform') list = list.filter((g) => g.platform === f.value);
  if (f.type === 'tag') list = list.filter((g) => g.tags.includes(f.value));
  if (q) {
    list = list.filter((g) => g.name.toLowerCase().includes(q) || g.platform.toLowerCase().includes(q)
      || g.tags.some((t) => t.toLowerCase().includes(q)));
  }
  const byName = (a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true });
  const sorters = {
    name: byName,
    recent: (a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || byName(a, b),
    playtime: (a, b) => (b.playtime || 0) - (a.playtime || 0) || byName(a, b),
    added: (a, b) => (b.added || 0) - (a.added || 0) || byName(a, b),
  };
  const sort = f.type === 'recent' ? 'recent' : S.sort;
  return list.sort(sorters[sort] || byName);
}

// ------------------------------------------------------------------ renderização

function render() {
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === S.view));
  renderSidebar();
  const main = $('#main');
  const scroll = main.scrollTop;
  if (S.view === 'emulators') main.innerHTML = emulatorsView();
  else if (S.view === 'settings') main.innerHTML = settingsView();
  else if (S.view === 'appearance') main.innerHTML = appearanceView();
  else if (S.selected) main.innerHTML = detailView(gameById(S.selected));
  else main.innerHTML = libraryView();
  if (S.view === 'appearance' || (S.view === 'library' && !S.selected)) main.scrollTop = scroll;
  if (S.view === 'emulators') measureLogos(main);
  if (S.view === 'library' && S.selected) main.scrollTop = 0;
  updateChrome();
}

// Botão claro/escuro do topo e arte de fundo (modo "fundo ambiente").
function updateChrome() {
  $('#modeBtn').textContent = Theme.isLight() ? '☀' : '☾';
  const withArt = (g) => g && (g.hero || g.cover);
  const g = withArt(gameById(S.selected)) ? gameById(S.selected)
    : [...S.games].filter(withArt).sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))[0];
  const url = g ? heroUrl(g) || coverUrl(g) : '';
  document.documentElement.style.setProperty('--ambient', url ? `url("${url}")` : 'none');
}

function renderSidebar() {
  const visible = S.games.filter((g) => S.showHidden || !g.hidden);
  const count = (fn) => visible.filter(fn).length;
  const btn = (type, value, label, n) => {
    const active = S.filter.type === type && S.filter.value === value;
    return `<button class="filter${active ? ' active' : ''}" data-ftype="${type}" data-fvalue="${esc(value ?? '')}"><span>${esc(label)}</span><span class="n">${n}</span></button>`;
  };
  const tags = [...new Set(S.games.flatMap((g) => g.tags))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const hiddenCount = S.games.filter((g) => g.hidden).length;
  $('#filters').innerHTML = `
    <div class="filter-group">
      ${btn('all', null, 'Todos os jogos', visible.length)}
      ${btn('fav', null, '★ Favoritos', count((g) => g.favorite))}
      ${btn('recent', null, 'Jogados recentemente', count((g) => g.lastPlayed))}
      ${btn('unplayed', null, 'Nunca jogados', count((g) => !g.lastPlayed))}
      ${hiddenCount ? btn('hidden', null, 'Ocultos', hiddenCount) : ''}
    </div>
    <div class="filter-group"><div class="filter-title">PLATAFORMAS</div>
      ${[...new Set(visible.map((g) => g.platform))].sort().map((p) => btn('platform', p, p, count((g) => g.platform === p))).join('')}
    </div>
    ${tags.length ? `<div class="filter-group"><div class="filter-title">COLEÇÕES</div>${tags.map((t) => btn('tag', t, t, count((g) => g.tags.includes(t)))).join('')}</div>` : ''}`;
  const list = visibleGames();
  $('#count').textContent = `(${list.length})`;
  $('#gameList').innerHTML = list.map((g) => `
    <li data-id="${g.id}" class="${g.id === S.selected ? 'sel' : ''} ${isRunning(g) ? 'run' : ''}" title="${esc(g.name)}">
      ${g.cover ? `<img class="mini" src="${coverUrl(g)}" alt="" loading="lazy">` : '<span class="mini"></span>'}
      <span class="label">${esc(g.name)}${isRunning(g) ? ' — Executando' : ''}</span>
    </li>`).join('');
}

function filterTitle() {
  const f = S.filter;
  return { all: 'TODOS OS JOGOS', fav: 'FAVORITOS', recent: 'JOGADOS RECENTEMENTE', unplayed: 'NUNCA JOGADOS', hidden: 'OCULTOS' }[f.type]
    || String(f.value).toUpperCase();
}

function libraryView() {
  if (!S.games.length) {
    return `<div class="empty">
      <h2>Sua biblioteca está vazia</h2>
      <p>Adicione jogos instalados, importe das lojas ou configure um emulador para escanear suas ROMs.</p>
      <div class="row">
        <button class="btn primary" data-action="add-game">+ Adicionar jogo</button>
        <button class="btn" data-action="import" data-source="steam">Importar da Steam</button>
        <button class="btn" data-action="import" data-source="epic">Importar da Epic</button>
        <button class="btn" data-action="import" data-source="gog">Importar da GOG</button>
        <button class="btn" data-action="goto" data-view="emulators">Configurar emuladores</button>
      </div></div>`;
  }
  const list = visibleGames();
  const missing = S.games.filter((g) => !g.cover).length;
  return `<div class="page" style="--card:${S.size}px">
    <div class="toolbar">
      <div class="title">${esc(filterTitle())} <span>(${list.length})</span></div>
      <div class="spacer"></div>
      ${missing ? `<button class="btn small" data-action="fetch-missing">Baixar ${missing} capa${missing > 1 ? 's' : ''} faltando</button>` : ''}
      <label>Ordenar
        <select id="sortSel">
          ${[['name', 'Nome'], ['recent', 'Jogado por último'], ['playtime', 'Tempo de jogo'], ['added', 'Adicionado recentemente']]
            .map(([v, l]) => `<option value="${v}" ${S.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
      <label>Tamanho <input id="sizeRange" type="range" min="120" max="280" step="10" value="${S.size}"></label>
      <label><input id="hiddenChk" type="checkbox" ${S.showHidden ? 'checked' : ''}> Mostrar ocultos</label>
    </div>
    ${list.length ? `<div class="grid">${list.map(cardHtml).join('')}</div>` : '<p class="muted">Nenhum jogo corresponde a este filtro.</p>'}
  </div>`;
}

const LANDSCAPE_CONSOLES = new Set(['snes']);
function isLandscape(g) {
  if (!g || g.kind !== 'rom') return false;
  const emu = emuById(g.emulatorId);
  if (emu?.consoleId) return LANDSCAPE_CONSOLES.has(emu.consoleId);
  return /super nintendo|\bsnes\b|super famicom/i.test(`${g.platform} ${emu?.platform || ''}`);
}

function cardHtml(g) {
  return `<div class="card${isLandscape(g) ? ' landscape' : ''}" data-id="${g.id}" title="${esc(g.name)}">
    <div class="cover">
      ${g.cover ? `<img src="${coverUrl(g)}" alt="" loading="lazy">`
        : `<div class="ph"><span>${esc(g.name)}</span><button class="ph-btn" data-action="card-art" data-id="${g.id}">🔍 Buscar capa online</button></div>`}
      ${g.cover ? `<button class="card-art" data-action="card-art" data-id="${g.id}" title="Trocar capa">🖼</button>` : ''}
      ${isRunning(g) ? '<span class="badge">EXECUTANDO</span>' : ''}
      ${g.favorite ? '<span class="fav-star">★</span>' : ''}
    </div>
    <button class="card-play" data-action="play" data-id="${g.id}" title="Jogar">▶</button>
    <div class="card-title">${esc(g.name)}</div>
    <div class="card-sub">${esc(g.platform)}</div>
  </div>`;
}

function detailView(g) {
  const hero = heroUrl(g) || coverUrl(g);
  const emu = g.kind === 'rom' ? emuById(g.emulatorId) : null;
  const run = isRunning(g);
  const kindLabel = { exe: 'Executável', rom: 'ROM via emulador', url: 'Atalho / lançador externo' }[g.kind];
  return `<div class="detail">
    <div class="hero-wrap"><div class="hero ${heroUrl(g) ? '' : 'blur'}" style="${hero ? `background-image:url('${hero}')` : ''}">
      <div class="hero-fade"></div>
      <button class="back" data-action="back">‹ Biblioteca</button>
      <div class="hero-content">
        ${g.cover ? `<img class="detail-cover${isLandscape(g) ? ' landscape' : ''}" src="${coverUrl(g)}" alt="">` : ''}
        <h1>${esc(g.name)}</h1>
      </div>
    </div></div>
    <div class="detail-bar">
      <button class="play-btn ${run ? 'running' : ''}" data-action="play" data-id="${g.id}" ${run ? 'disabled' : ''}>${run ? '■ EXECUTANDO' : '▶ JOGAR'}</button>
      <div class="stat"><div class="k">Jogado por último</div><div class="v">${fmtDate(g.lastPlayed)}</div></div>
      <div class="stat"><div class="k">Tempo de jogo</div><div class="v">${g.kind === 'url' && !g.playtime ? '—' : fmtPlaytime(g.playtime)}</div></div>
      <div class="stat"><div class="k">Plataforma</div><div class="v">${esc(g.platform)}</div></div>
      <div class="spacer"></div>
      <div class="icon-btns">
        <button class="icon-btn ${g.favorite ? 'on' : ''}" data-action="toggle" data-field="favorite" data-id="${g.id}" title="Favorito">${g.favorite ? '★' : '☆'} Favorito</button>
        <button class="icon-btn" data-action="art" data-id="${g.id}">🖼 Capa e banner</button>
        <button class="icon-btn" data-action="edit" data-id="${g.id}">✎ Editar</button>
        ${g.kind !== 'url' ? `<button class="icon-btn" data-action="folder" data-id="${g.id}">📁 Abrir pasta</button>` : ''}
        <button class="icon-btn" data-action="toggle" data-field="hidden" data-id="${g.id}">${g.hidden ? '👁 Mostrar' : '🚫 Ocultar'}</button>
        <button class="icon-btn" data-action="delete" data-id="${g.id}">🗑 Remover</button>
      </div>
    </div>
    <div class="detail-body">
      <div class="panel">
        <h3>INFORMAÇÕES</h3>
        <div class="kv">
          <span class="k">Tipo</span><span>${kindLabel}</span>
          ${emu ? `<span class="k">Emulador</span><span>${esc(emu.name)}</span>` : ''}
          ${g.kind === 'rom' && !emu ? '<span class="k">Emulador</span><span style="color:var(--danger)">removido — edite o jogo</span>' : ''}
          <span class="k">${g.kind === 'url' ? 'Endereço' : 'Caminho'}</span><code>${esc(g.path)}</code>
          ${g.args ? `<span class="k">Argumentos</span><code>${esc(g.args)}</code>` : ''}
          <span class="k">Origem</span><span>${esc(SOURCES[g.source] || g.source)}</span>
          ${g.steamAppId ? `<span class="k">Steam AppID</span><span>${esc(g.steamAppId)}</span>` : ''}
          <span class="k">Adicionado</span><span>${fmtDate(g.added)}</span>
        </div>
        ${g.notes ? `<h3 style="margin-top:18px">NOTAS</h3><p class="notes">${esc(g.notes)}</p>` : ''}
      </div>
      <div class="panel">
        <h3>COLEÇÕES</h3>
        ${g.tags.length ? `<div class="chips">${g.tags.map((t) => `<button class="chip" data-action="tag" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>`
          : '<p class="muted" style="margin:0">Nenhuma coleção. Use “Editar” para organizar este jogo.</p>'}
        ${g.kind === 'url' ? '<p class="hint" style="margin-top:16px">Jogos abertos por lançadores externos (Steam, Epic) não têm o tempo de jogo medido aqui.</p>' : ''}
      </div>
    </div>
  </div>`;
}

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

function appearanceView() {
  const t = Theme.get();
  const same = (cfg) => Object.keys(Theme.DEFAULT).every((k) => String(cfg[k]) === String(t[k]));
  const seg = (key, opts) => `<div class="seg">${opts.map(([v, l]) => `<button data-action="theme-set" data-key="${key}" data-value="${v}"
    class="${String(t[key]) === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const toggle = (key, title, desc) => `<div class="opt"><div><div class="t">${title}</div><div class="d">${desc}</div></div>
    <label class="switch"><input type="checkbox" data-theme-toggle="${key}" ${t[key] ? 'checked' : ''}><span></span></label></div>`;
  const mock = (p) => `<div class="mock" style="background:${p.bg}"><div class="side" style="background:${p.panel}"></div>
    <div class="body"><div class="bar" style="background:${p.accent}"></div>${`<div class="c" style="background:${p.raised}"></div>`.repeat(4)}</div></div>`;
  const themeAccent = Theme.paletteOf(t.preset).accent;
  return `<div class="page">
    <h2>Aparência</h2><p class="sub">As mudanças aparecem na hora e são salvas automaticamente.</p>

    <div class="section"><h3>Estilos rápidos</h3><p>Combinações prontas de tema, fonte e efeitos. Depois é só ajustar o que quiser.</p>
      <div class="theme-grid">${Object.entries(Theme.STYLES).map(([k, s]) => {
        const p = Theme.THEMES[s.cfg.preset][s.cfg.mode === 'light' ? 'light' : 'dark'];
        return `<button class="theme-card style-card ${same(s.cfg) ? 'on' : ''}" data-action="theme-style" data-key="${k}">
          <div class="mock" style="background:linear-gradient(135deg, ${p.bg}, ${s.cfg.accent || p.accent})">${s.icon}</div>
          <div class="label"><span>${s.label}</span><small>${s.desc}</small></div></button>`;
      }).join('')}</div>
    </div>

    <div class="section"><h3>Tema de cores</h3><p>Cada tema tem versão escura e clara.</p>
      <div class="theme-grid">${Object.entries(Theme.THEMES).map(([k, th]) => `
        <button class="theme-card ${t.preset === k ? 'on' : ''}" data-action="theme-set" data-key="preset" data-value="${k}">
          ${mock(Theme.paletteOf(k))}<div class="label"><span>${th.label}</span></div></button>`).join('')}</div>
    </div>

    <div class="section"><h3>Modo</h3><p>“Sistema” acompanha o modo claro/escuro do Windows.</p>
      ${seg('mode', [['system', '🖥 Sistema'], ['dark', '☾ Escuro'], ['light', '☀ Claro']])}
    </div>

    <div class="section"><h3>Cor de destaque</h3><p>Usada em botões, seleção, links e brilhos.</p>
      <div class="swatches">
        <button class="swatch ${t.accent ? '' : 'on'}" data-action="theme-set" data-key="accent" data-value="" title="Padrão do tema"
          style="background:${themeAccent}"></button>
        ${Theme.ACCENTS.map((c) => `<button class="swatch ${t.accent.toLowerCase() === c ? 'on' : ''}" data-action="theme-set" data-key="accent"
          data-value="${c}" style="background:${c}" title="${c}"></button>`).join('')}
        <label class="swatch custom ${t.accent && !Theme.ACCENTS.includes(t.accent.toLowerCase()) ? 'on' : ''}" title="Escolher outra cor">
          <input type="color" id="accentPicker" value="${t.accent || themeAccent}"></label>
      </div>
    </div>

    <div class="section"><h3>Fonte</h3>
      <div class="seg">${Object.entries(Theme.FONTS).map(([k, f]) => `<button class="font-opt ${t.font === k ? 'on' : ''}" data-action="theme-set"
        data-key="font" data-value="${k}" style="font-family:${esc(f.css)}">${f.label}</button>`).join('')}</div>
      <p class="hint" style="margin-top:8px">Fontes diferentes de “Sistema” são carregadas do Google Fonts (precisa de internet).</p>
    </div>

    <div class="section"><h3>Formas e efeitos</h3>
      <div class="opts">
        <div class="opt"><div><div class="t">Arredondamento dos cantos</div><div class="d">De quadrado (0) a bem arredondado (20)</div></div>
          <div class="range-row"><input type="range" min="0" max="20" value="${t.radius}" data-theme-range="radius"><output>${t.radius}px</output></div></div>
        ${toggle('glass', 'Efeito vidro', 'Barras e janelas translúcidas com desfoque')}
        ${toggle('ambient', 'Fundo ambiente', 'A arte do jogo selecionado (ou do último jogado) aparece desfocada no fundo')}
        ${toggle('animations', 'Animações', 'Transições e efeitos de movimento')}
        <div class="opt"><div><div class="t">Ao passar o mouse nas capas</div></div>
          ${seg('hover', [['lift', 'Elevar'], ['glow', 'Brilho'], ['none', 'Só contorno']])}</div>
        <div class="opt"><div><div class="t">Densidade</div><div class="d">Compacta mostra mais jogos por tela</div></div>
          ${seg('density', [['comfortable', 'Confortável'], ['compact', 'Compacta']])}</div>
      </div>
    </div>

    <div class="section"><div class="row"><button class="btn ghost" data-action="theme-reset">Restaurar aparência padrão</button></div></div>
  </div>`;
}

function settingsView() {
  return `<div class="page">
    <h2>Configurações</h2><p class="sub">Importação de lojas, fontes de capas e dados.</p>
    <div class="section">
      <h3>Importar jogos instalados</h3>
      <p>Detecta jogos já instalados pelos lançadores. Jogos repetidos são ignorados, então pode importar de novo sempre que instalar algo.</p>
      <div class="row">
        <button class="btn" data-action="import" data-source="steam">Importar da Steam</button>
        <button class="btn" data-action="import" data-source="epic">Importar da Epic Games</button>
        <button class="btn" data-action="import" data-source="gog">Importar da GOG</button>
      </div>
    </div>
    <div class="section">
      <h3>Capas e banners</h3>
      <p>Sem configuração, as capas vêm da <b>Wikipedia</b> (jogos em geral) e do acervo <b>libretro</b> (jogos de emulador).
        Também dá para colar qualquer imagem do Google com Ctrl+V. Para dezenas de capas e banners alternativos, crie uma chave gratuita na
        <a href="https://www.steamgriddb.com/profile/preferences/api" target="_blank" rel="noopener">SteamGridDB</a> e cole aqui.</p>
      <div class="inline" style="max-width:560px">
        <input class="input" id="sgdbKey" type="password" placeholder="Chave de API da SteamGridDB" value="${esc(S.settings.steamgriddbKey || '')}" autocomplete="off">
        <button class="btn primary" data-action="save-key">Salvar</button>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="btn" data-action="fetch-missing">Baixar capas faltando</button>
        <span class="muted" style="font-size:13px">${S.games.filter((g) => !g.cover).length} jogo(s) sem capa</span>
      </div>
    </div>
    <div class="section">
      <h3>Dados</h3>
      <p>Biblioteca e capas ficam salvas localmente em:</p>
      <code style="word-break:break-all">${esc(S.dataDir)}</code>
    </div>
    <div class="section">
      <h3>Encerrar</h3>
      <p>A SannStation fecha sozinha quando você fecha a janela. Use este botão se ela continuar rodando em segundo plano.</p>
      <button class="btn danger" data-action="quit">Fechar SannStation</button>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ modais

function openModal(html, wide = false) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal${wide ? ' wide' : ''}">${html}</div></div>`;
  const backdrop = root.firstElementChild;
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeModal(); });
  $$('[data-close]', root).forEach((b) => b.addEventListener('click', closeModal));
  return $('.modal', root);
}
function closeModal() {
  if (artTarget && !artTarget.popup) artTarget = null;
  $('#modalRoot').innerHTML = '';
}

async function pick(mode, title, filetypes) {
  const r = await act(() => api('/pick', { mode, title, filetypes }));
  return r?.path || '';
}

function gameForm(existing) {
  const g = existing || {
    name: '', kind: 'exe', path: '', args: '', workdir: '', emulatorId: S.emulators[0]?.id || '',
    platform: 'PC', steamAppId: '', tags: [], notes: '',
  };
  const m = openModal(`
    <h2>${existing ? 'Editar jogo' : 'Adicionar jogo'}</h2>
    <form class="form" id="gameForm">
      <label>Tipo
        <select name="kind">
          <option value="exe">Executável instalado (.exe, .bat, .lnk)</option>
          <option value="rom">ROM / ISO aberta por emulador</option>
          <option value="url">Atalho ou URL (steam://, com.epicgames…, site)</option>
        </select></label>
      <label data-for="rom">Emulador
        <select name="emulatorId">${S.emulators.map((e) => `<option value="${e.id}">${esc(e.name)} — ${esc(e.platform)}</option>`).join('')
          || '<option value="">Nenhum emulador configurado</option>'}</select></label>
      <label><span id="pathLabel">Caminho</span>
        <div class="inline"><input name="path" required><button type="button" class="btn" data-pick="path">Procurar…</button></div></label>
      <label>Nome <input name="name" required></label>
      <label data-for="exe">Argumentos de inicialização <input name="args" placeholder="opcional, ex.: -windowed -skipintro"></label>
      <label data-for="exe">Pasta de trabalho
        <div class="inline"><input name="workdir" placeholder="padrão: pasta do executável"><button type="button" class="btn" data-pick="workdir">Procurar…</button></div></label>
      <div class="two">
        <label>Plataforma <input name="platform" list="platformList"></label>
        <label>Steam AppID <input name="steamAppId" placeholder="opcional — melhora as capas" inputmode="numeric"></label>
      </div>
      <datalist id="platformList">${platforms().map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      <label>Coleções <input name="tags" placeholder="separadas por vírgula: RPG, Zerados, Multiplayer"></label>
      <label>Notas <textarea name="notes" rows="3"></textarea></label>
      <div class="actions">
        <button type="button" class="btn ghost" data-close>Cancelar</button>
        <button class="btn primary" type="submit">${existing ? 'Salvar' : 'Adicionar'}</button>
      </div>
    </form>`);
  const form = $('#gameForm', m);
  const el = form.elements;
  for (const k of ['kind', 'path', 'name', 'args', 'workdir', 'platform', 'steamAppId', 'notes']) el[k].value = g[k] ?? '';
  if (g.emulatorId) el.emulatorId.value = g.emulatorId;
  el.tags.value = (g.tags || []).join(', ');

  const sync = () => {
    const kind = el.kind.value;
    $$('[data-for]', form).forEach((n) => { n.style.display = n.dataset.for === kind ? '' : 'none'; });
    $('#pathLabel', form).textContent = { exe: 'Executável', rom: 'Arquivo da ROM / ISO', url: 'Endereço' }[kind];
    $('[data-pick="path"]', form).style.display = kind === 'url' ? 'none' : '';
  };
  el.kind.addEventListener('change', () => {
    if (el.kind.value === 'rom' && (!el.platform.value || el.platform.value === 'PC')) el.platform.value = emuById(el.emulatorId.value)?.platform || '';
    if (el.kind.value !== 'rom' && !el.platform.value) el.platform.value = 'PC';
    sync();
  });
  el.emulatorId.addEventListener('change', () => { el.platform.value = emuById(el.emulatorId.value)?.platform || el.platform.value; });
  sync();

  $$('[data-pick]', form).forEach((b) => b.addEventListener('click', async () => {
    const field = b.dataset.pick;
    let path;
    if (field === 'workdir') {
      path = await pick('folder', 'Pasta de trabalho');
    } else if (el.kind.value === 'rom') {
      const emu = emuById(el.emulatorId.value);
      const pattern = emu?.extensions.map((x) => `*${x}`).join(' ');
      path = await pick('file', 'Escolha a ROM / ISO', pattern ? [[`ROMs de ${emu.name}`, pattern]] : []);
    } else {
      path = await pick('file', 'Escolha o executável do jogo', [['Executáveis e atalhos', '*.exe *.bat *.cmd *.lnk *.url']]);
    }
    if (!path) return;
    el[field].value = path;
    if (field === 'path' && !el.name.value) el.name.value = cleanTitle(path);
  }));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    data.tags = data.tags.split(',').map((t) => t.trim()).filter(Boolean);
    const saved = await act(() => (existing ? api(`/games/${existing.id}`, data, 'PUT') : api('/games', data)),
      existing ? 'Jogo atualizado.' : `“${data.name}” adicionado à biblioteca.`);
    if (!saved) return;
    closeModal();
    if (!existing) S.selected = saved.id;
    await refresh();
    if (!saved.cover) fetchArtFor([saved.id], true);
  });
  el[existing ? 'name' : 'path'].focus();
}

function artModal(g, kind = 'cover') {
  const m = openModal(`
    <h2>Capa e banner — ${esc(g.name)}</h2>
    <div class="seg"><button data-kind="cover" class="${kind === 'cover' ? 'on' : ''}">Capa (vertical)</button><button data-kind="hero" class="${kind === 'hero' ? 'on' : ''}">Banner de fundo</button></div>
    <div class="art-current" id="artCurrent"></div>
    <form class="inline" id="artSearch">
      <input class="input" name="q" value="${esc(g.name)}" placeholder="Nome do jogo para buscar">
      <button class="btn primary">Buscar</button>
    </form>
    <div class="art-results" id="artResults"></div>
    <div class="drop-hint big" id="artDrop">Achou no <b>Google Imagens</b>? Clique com o botão direito na imagem →
      <b>Copiar imagem</b> e aperte <b>Ctrl+V</b> aqui. Também dá para arrastar a imagem para esta janela.</div>
    <form class="inline" id="artUrl">
      <input class="input" name="url" placeholder="…ou cole o endereço de uma imagem (https://…)">
      <button class="btn">Usar URL</button>
    </form>
    <div class="actions">
      <a class="btn" id="artGoogle" target="_blank" rel="noopener">🔎 Google Imagens</a>
      <button class="btn" id="artLocal">Escolher arquivo do PC…</button>
      <button class="btn danger" id="artRemove">Remover atual</button>
      <div class="spacer"></div>
      <button class="btn ghost" data-close>Fechar</button>
    </div>`, true);

  const showCurrent = () => {
    const cur = gameById(g.id);
    const url = kind === 'cover' ? coverUrl(cur) : heroUrl(cur);
    $('#artCurrent', m).innerHTML = url ? `<img src="${url}" alt=""> Imagem atual` : `Nenhum${kind === 'cover' ? 'a capa' : ' banner'} definido${kind === 'cover' ? 'a' : ''}.`;
    $('#artRemove', m).disabled = !url;
  };
  const applied = async (res, msg) => {
    if (!res || res.cancelled) return;
    toast(msg);
    await refresh();
    showCurrent();
  };
  const search = async () => {
    const box = $('#artResults', m);
    box.className = 'art-results' + (kind === 'hero' ? ' hero-mode' : isLandscape(g) ? ' landscape' : '');
    box.innerHTML = '<p class="muted">Buscando imagens…</p>';
    const q = $('#artSearch', m).elements.q.value;
    const res = await act(() => api(`/games/${g.id}/art/search?kind=${kind}&q=${encodeURIComponent(q)}`));
    if (!res) { box.innerHTML = '<p class="muted">Falha na busca.</p>'; return; }
    if (!res.results.length) {
      box.innerHTML = `<p class="muted">Nada encontrado aqui. Tente outro nome ou use o botão <b>Google Imagens</b> e cole a imagem (Ctrl+V).${kind === 'hero' && !S.settings.steamgriddbKey ? ' Para banners, a SteamGridDB (Configurações) tem muitas opções.' : ''}</p>`;
      return;
    }
    box.innerHTML = res.results.map((r, i) => `<div class="art-opt" data-i="${i}" title="${esc(r.title)}">
      <img src="${esc(r.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer"><div class="src">${esc(r.source)}${r.title ? ' · ' + esc(r.title) : ''}</div></div>`).join('');
    $$('.art-opt img', box).forEach((img) => img.addEventListener('error', () => img.closest('.art-opt').remove()));
    $$('.art-opt', box).forEach((opt) => opt.addEventListener('click', async () => {
      opt.style.opacity = '.5';
      const r = res.results[+opt.dataset.i];
      await applied(await act(() => api(`/games/${g.id}/art/url`, { kind, url: r.url })), 'Imagem aplicada.');
      opt.style.opacity = '';
    }));
  };

  $$('.seg button', m).forEach((b) => b.addEventListener('click', () => {
    kind = b.dataset.kind;
    $$('.seg button', m).forEach((x) => x.classList.toggle('on', x === b));
    showCurrent();
    syncGoogle();
    search();
  }));
  $('#artSearch', m).addEventListener('submit', (e) => { e.preventDefault(); search(); });
  $('#artUrl', m).addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = e.target.elements.url.value.trim();
    if (url) await applied(await act(() => api(`/games/${g.id}/art/url`, { kind, url })), 'Imagem aplicada.');
  });
  const googleBtn = $('#artGoogle', m);
  const syncGoogle = () => { googleBtn.href = googleImagesUrl($('#artSearch', m).elements.q.value || g.name, kind); };
  $('#artSearch', m).elements.q.addEventListener('input', syncGoogle);
  syncGoogle();
  enableDrop(m);
  artTarget = { id: g.id, kind: () => kind, done: async () => { await refresh(); showCurrent(); } };
  $('#artLocal', m).addEventListener('click', async () => applied(await act(() => api(`/games/${g.id}/art/local`, { kind })), 'Imagem aplicada.'));
  $('#artRemove', m).addEventListener('click', async () => applied(await act(() => api(`/games/${g.id}/art/${kind}`, undefined, 'DELETE')), 'Imagem removida.'));
  showCurrent();
  search();
}

function emulatorForm(existing) {
  const e = existing || { name: '', path: '', args: '"{rom}"', extensions: [], platform: '' };
  const m = openModal(`
    <h2>${existing ? 'Editar emulador' : 'Emulador personalizado'}</h2>
    <form class="form" id="emuForm">
      <div class="two">
        <label>Nome <input name="name" required></label>
        <label>Plataforma <input name="platform" list="emuPlatforms" placeholder="ex.: PlayStation 2"></label>
      </div>
      <datalist id="emuPlatforms">${platforms().map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      <label>Executável do emulador
        <div class="inline"><input name="path" required><button type="button" class="btn" id="emuPick">Procurar…</button></div></label>
      <label>Argumentos <input name="args"></label>
      <p class="hint">Variáveis: <code>{rom}</code> caminho completo da ROM · <code>{romdir}</code> pasta da ROM · <code>{romname}</code> nome sem extensão. Use aspas em volta: <code>"{rom}"</code></p>
      <label>Extensões de arquivo <input name="extensions" placeholder=".iso, .chd, .cue"></label>
      <div class="actions">
        <button type="button" class="btn ghost" data-close>Cancelar</button>
        <button class="btn primary" type="submit">${existing ? 'Salvar' : 'Adicionar'}</button>
      </div>
    </form>`);
  const form = $('#emuForm', m);
  const el = form.elements;
  el.name.value = e.name;
  el.platform.value = e.platform;
  el.path.value = e.path;
  el.args.value = e.args;
  el.extensions.value = e.extensions.join(', ');
  $('#emuPick', form).addEventListener('click', async () => {
    const path = await pick('file', 'Escolha o executável do emulador', [['Executáveis', '*.exe *.bat *.cmd']]);
    if (path) el.path.value = path;
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const data = {
      name: el.name.value, platform: el.platform.value, path: el.path.value, args: el.args.value,
      extensions: el.extensions.value.split(/[,\s]+/).filter(Boolean).map((x) => (x.startsWith('.') ? x : '.' + x).toLowerCase()),
    };
    const saved = await act(() => (existing ? api(`/emulators/${existing.id}`, data, 'PUT') : api('/emulators', data)),
      existing ? 'Emulador atualizado.' : 'Emulador adicionado.');
    if (!saved) return;
    closeModal();
    await refresh();
    if (!existing) scanModal(saved);
  });
}

function scanModal(emu) {
  const m = openModal(`
    <h2>Escanear ROMs — ${esc(emu.name)}</h2>
    <form class="form" id="scanForm">
      <p class="hint">Todos os arquivos com as extensões <code>${esc(emu.extensions.join(' '))}</code> serão adicionados como jogos de <b>${esc(emu.platform || emu.name)}</b>. Arquivos já na biblioteca são ignorados.</p>
      <label>Pasta das ROMs
        <div class="inline"><input name="folder" required><button type="button" class="btn" id="scanPick">Procurar…</button></div></label>
      <label class="check"><input type="checkbox" name="recursive" checked> Incluir subpastas</label>
      <label class="check"><input type="checkbox" name="art" checked> Baixar capas automaticamente</label>
      <div class="actions">
        <button type="button" class="btn ghost" data-close>Agora não</button>
        <button class="btn primary" type="submit">Escanear</button>
      </div>
    </form>`);
  const form = $('#scanForm', m);
  $('#scanPick', form).addEventListener('click', async () => {
    const p = await pick('folder', 'Pasta das ROMs');
    if (p) form.elements.folder.value = p;
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await act(() => api(`/emulators/${emu.id}/scan`, { folder: form.elements.folder.value, recursive: form.elements.recursive.checked }));
    if (!res) return;
    closeModal();
    toast(`${res.found} arquivo(s) encontrado(s), ${res.added.length} novo(s) na biblioteca.`);
    await refresh();
    if (form.elements.art.checked && res.added.length) fetchArtFor(res.added);
  });
}

// ------------------------------------------------------------------ ações

// ------------------------------------------------------------------ seletor rápido de capas no card

const artCache = new Map(); // id do jogo -> resultados da busca online (evita buscar de novo)

// Destino de uma imagem colada (Ctrl+V) ou arrastada: o seletor de capa que estiver aberto.
let artTarget = null; // { id, kind: () => 'cover' | 'hero', done: async () => {} }

const googleImagesUrl = (name, kind) =>
  `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(`${name} ${kind === 'hero' ? 'wallpaper' : 'capa jogo'}`)}`;

function readAsDataUrl(file) {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = () => fail(r.error);
    r.readAsDataURL(file);
  });
}

// Aceita imagem (arquivo/print), endereço https da imagem ou HTML com <img> (o que o Google entrega ao arrastar).
async function applyTransfer(dt) {
  if (!artTarget || !dt) return false;
  const { id } = artTarget;
  const kind = artTarget.kind();
  let res;
  const file = [...(dt.files || [])].find((f) => f.type.startsWith('image/'))
    || [...(dt.items || [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile())[0];
  if (file) {
    toast('Enviando imagem…');
    res = await act(() => readAsDataUrl(file).then((data) => api(`/games/${id}/art/upload`, { kind, data })), 'Imagem aplicada.');
  } else {
    const html = dt.getData && dt.getData('text/html');
    const fromHtml = html && (html.match(/<img[^>]+src="([^"]+)"/i) || [])[1];
    const text = (dt.getData && (dt.getData('text/uri-list') || dt.getData('text/plain')) || '').trim().split('\n')[0];
    const src = (fromHtml || text || '').replace(/&amp;/g, '&');
    if (src.startsWith('data:image/')) {
      res = await act(() => api(`/games/${id}/art/upload`, { kind, data: src }), 'Imagem aplicada.');
    } else if (/^https?:\/\//i.test(src)) {
      res = await act(() => api(`/games/${id}/art/url`, { kind, url: src }), 'Imagem aplicada.');
    } else {
      return false;
    }
  }
  if (res) await artTarget?.done();
  return true;
}

document.addEventListener('paste', (e) => {
  if (!artTarget) return;
  const hasImage = [...(e.clipboardData?.items || [])].some((i) => i.type.startsWith('image/'));
  if (e.target.closest?.('input, textarea') && !hasImage) return; // texto colado num campo segue normal
  e.preventDefault();
  applyTransfer(e.clipboardData).then((ok) => {
    if (!ok) toast('A área de transferência não tem uma imagem. No Google, clique com o botão direito na imagem → “Copiar imagem”.', true, 6000);
  });
});
function enableDrop(el) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop-on'); });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop-on'); });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drop-on');
    applyTransfer(e.dataTransfer).then((ok) => { if (!ok) toast('Não reconheci uma imagem nisso que foi arrastado.', true); });
  });
}

function closeCardPop() {
  if ($('#cardPop') && artTarget?.popup) artTarget = null;
  $('#cardPop')?.remove();
}

function placeCardPop(pop, card) {
  const r = card.querySelector('.cover').getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const gap = 12;
  let left = r.right + gap;
  if (left + w > innerWidth - 8) left = r.left - w - gap;
  if (left < 8) left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
  const top = Math.max(8, Math.min(r.top, innerHeight - h - 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function toggleCardPop(id, card) {
  if ($('#cardPop')?.dataset.id === id) return closeCardPop();
  closeCardPop();
  const g = gameById(id);
  if (!g || !card) return;
  const pop = document.createElement('div');
  pop.id = 'cardPop';
  pop.dataset.id = id;
  if (isLandscape(g)) pop.classList.add('landscape');
  pop.innerHTML = `
    <div class="pop-head">
      <div><div class="pop-title">Escolher capa</div><div class="pop-sub">${esc(g.name)}</div></div>
      <button class="pop-x" title="Fechar">✕</button>
    </div>
    <form class="pop-search"><input class="input" name="q" value="${esc(g.name)}" placeholder="Nome para buscar"><button class="btn small">Buscar</button></form>
    <div class="pop-grid"><p class="muted">Buscando capas online…</p></div>
    <div class="drop-hint">Achou no Google? <b>Copie a imagem e cole aqui (Ctrl+V)</b> ou arraste para cá.</div>
    <div class="pop-foot">
      <button class="btn small" data-pop="auto">⚡ Melhor automática</button>
      <a class="btn small" href="${googleImagesUrl(g.name, 'cover')}" target="_blank" rel="noopener">🔎 Google Imagens</a>
      <button class="btn small ghost" data-pop="more">Mais…</button>
    </div>`;
  document.body.appendChild(pop);
  placeCardPop(pop, card);
  enableDrop(pop);
  artTarget = { id, kind: () => 'cover', popup: true, done: async () => { closeCardPop(); await refresh(); } };

  const grid = $('.pop-grid', pop);
  const showResults = (results) => {
    if (!results.length) {
      grid.innerHTML = '<p class="muted">Nenhuma capa encontrada. Tente outro nome, ou use o Google Imagens e cole a imagem aqui.</p>';
      return;
    }
    grid.innerHTML = results.map((r, i) => `<button class="pop-opt" data-i="${i}" title="${esc(r.source)}${r.title ? ' · ' + esc(r.title) : ''}">
      <img src="${esc(r.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span>${esc(r.source)}</span></button>`).join('');
    $$('img', grid).forEach((img) => img.addEventListener('error', () => {
      img.closest('.pop-opt').remove();
      if (!grid.querySelector('.pop-opt')) showResults([]);
    }));
    $$('.pop-opt', grid).forEach((b) => b.addEventListener('click', async () => {
      $$('.pop-opt', grid).forEach((x) => x.classList.toggle('busy', x === b));
      const res = await act(() => api(`/games/${id}/art/url`, { kind: 'cover', url: results[+b.dataset.i].url }), 'Capa atualizada.');
      if (!res) { b.classList.remove('busy'); return; }
      closeCardPop();
      await refresh();
    }));
  };
  const search = async (q) => {
    grid.innerHTML = '<p class="muted">Buscando capas online…</p>';
    const key = `${id}|${q}`;
    if (!artCache.has(key)) {
      try {
        const res = await api(`/games/${id}/art/search?kind=cover&q=${encodeURIComponent(q)}`);
        artCache.set(key, res.results);
      } catch (e) {
        if ($('#cardPop') !== pop) return;
        grid.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
        return;
      }
    }
    if ($('#cardPop') === pop) {
      showResults(artCache.get(key));
      placeCardPop(pop, card); // a altura mudou com os resultados
    }
  };

  $('.pop-x', pop).addEventListener('click', closeCardPop);
  $('.pop-search', pop).addEventListener('submit', (e) => { e.preventDefault(); search(e.target.elements.q.value.trim() || g.name); });
  $('[data-pop="more"]', pop).addEventListener('click', () => { closeCardPop(); artModal(g); });
  $('[data-pop="auto"]', pop).addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Baixando…';
    if (g.cover) await act(() => api(`/games/${id}/art/cover`, undefined, 'DELETE'));
    const r = await act(() => api(`/games/${id}/art/auto`, {}));
    closeCardPop();
    await refresh();
    if (r) toast(r.downloaded.includes('cover') ? 'Capa baixada automaticamente.' : 'Não encontrei uma capa automática. Escolha uma da lista ou use “Mais opções…”.', !r.downloaded.includes('cover'));
  });
  search(g.name);
}

async function fetchArtFor(ids, quiet = false) {
  if (!ids.length) return;
  const box = quiet ? null : toast('', false, 600000);
  let ok = 0;
  for (let i = 0; i < ids.length; i++) {
    if (box) box.innerHTML = `Baixando capas ${i + 1}/${ids.length}…<div class="progress"><div style="width:${(i / ids.length) * 100}%"></div></div>`;
    try {
      const r = await api(`/games/${ids[i]}/art/auto`, {});
      if (r.downloaded.length) ok++;
    } catch { /* segue para o próximo */ }
    if (i % 5 === 4) await refresh(S.view === 'library' && !$('#modalRoot').childElementCount);
  }
  box?.remove();
  await refresh(!$('#modalRoot').childElementCount);
  if (!quiet || ok) toast(`Imagens encontradas para ${ok} de ${ids.length} jogo(s).${ok < ids.length ? ' Use “Capa e banner” para escolher manualmente os restantes.' : ''}`);
}

async function launchGame(id) {
  const g = gameById(id);
  if (!g || isRunning(g)) return;
  const ok = await act(() => api(`/games/${id}/launch`, {}), `Iniciando ${g.name}…`);
  if (ok) await refresh();
}

async function importFrom(source) {
  const label = { steam: 'Steam', epic: 'Epic Games', gog: 'GOG' }[source];
  const res = await act(() => api(`/import/${source}`, {}));
  if (!res) return;
  toast(`${label}: ${res.found} jogo(s) encontrado(s), ${res.added.length} novo(s).`);
  await refresh();
  if (res.added.length) fetchArtFor(res.added);
}

async function toggleField(id, field) {
  const g = gameById(id);
  await act(() => api(`/games/${id}`, { [field]: !g[field] }, 'PUT'));
  await refresh();
}

async function deleteGame(id) {
  const g = gameById(id);
  if (!confirm(`Remover “${g.name}” da biblioteca?\n\nNenhum arquivo do jogo é apagado — só o item da SannStation.`)) return;
  if (await act(() => api(`/games/${id}`, undefined, 'DELETE'), 'Jogo removido da biblioteca.')) {
    S.selected = null;
    await refresh();
  }
}

async function deleteEmulator(id) {
  const e = emuById(id);
  const n = S.games.filter((g) => g.emulatorId === id).length;
  if (!confirm(`Remover o emulador “${e.name}”?`)) return;
  const alsoGames = n > 0 && confirm(`Remover também os ${n} jogo(s) deste emulador da biblioteca?\n\n(OK = remover jogos, Cancelar = manter jogos)`);
  if (await act(() => api(`/emulators/${id}${alsoGames ? '?removeGames=1' : ''}`, undefined, 'DELETE'), 'Emulador removido.')) await refresh();
}

let themeSaveTimer = null;
function setTheme(patch, rerender = true) {
  Theme.apply({ ...Theme.get(), ...patch });
  if (rerender && S.view === 'appearance') render();
  else updateChrome();
  clearTimeout(themeSaveTimer);
  themeSaveTimer = setTimeout(() => act(() => api('/settings', { theme: Theme.get() }, 'PUT')), 400);
}

function goto(view) {
  S.view = view;
  if (view !== 'library') S.selected = null;
  render();
}

// ------------------------------------------------------------------ eventos

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action], [data-ftype], #gameList li, .card, .tabs button');
  if (!t) return;
  if (t.matches('.tabs button')) return goto(t.dataset.view);
  if (t.dataset.ftype) {
    S.filter = { type: t.dataset.ftype, value: t.dataset.fvalue || null };
    S.selected = null;
    S.view = 'library';
    return render();
  }
  const a = t.dataset.action;
  const id = t.dataset.id;
  if (!a && t.matches('#gameList li, .card')) {
    S.selected = t.dataset.id;
    S.view = 'library';
    return render();
  }
  e.stopPropagation();
  switch (a) {
    case 'play': return launchGame(id);
    case 'back': S.selected = null; return render();
    case 'edit': return gameForm(gameById(id));
    case 'art': return artModal(gameById(id));
    case 'toggle': return toggleField(id, t.dataset.field);
    case 'delete': return deleteGame(id);
    case 'folder': return act(() => api(`/games/${id}/open-folder`, {}));
    case 'tag': S.filter = { type: 'tag', value: t.dataset.tag }; S.selected = null; return render();
    case 'add-game': return gameForm();
    case 'import': return importFrom(t.dataset.source);
    case 'goto': return goto(t.dataset.view);
    case 'console': return consoleModal(id);
    case 'console-maker': S.consoleMaker = t.dataset.value; return render();
    case 'emu-detect': return detectEmulators();
    case 'emu-edit': return emulatorForm(id ? emuById(id) : null);
    case 'emu-scan': return scanModal(emuById(id));
    case 'emu-delete': return deleteEmulator(id);
    case 'card-art': return toggleCardPop(id, t.closest('.card'));
    case 'theme-set': {
      const patch = { [t.dataset.key]: t.dataset.value };
      if (t.dataset.key === 'preset') patch.accent = ''; // tema novo volta para a cor de destaque dele
      return setTheme(patch);
    }
    case 'theme-style': return setTheme(Theme.STYLES[t.dataset.key].cfg);
    case 'theme-reset': return setTheme(Theme.DEFAULT);
    case 'quit':
      if (!confirm('Fechar a SannStation?')) return undefined;
      return api('/quit', {}).finally(() => {
        document.body.innerHTML = '<div class="empty"><h2>SannStation fechada</h2><p>Pode fechar esta janela.</p></div>';
        setTimeout(() => window.close(), 400);
      });
    case 'fetch-missing': return fetchArtFor(S.games.filter((g) => !g.cover).map((g) => g.id));
    case 'save-key': {
      const key = $('#sgdbKey').value;
      return act(() => api('/settings', { steamgriddbKey: key }, 'PUT'), key ? 'Chave da SteamGridDB salva.' : 'Chave removida.').then(() => refresh(false));
    }
    default: return undefined;
  }
});

document.addEventListener('dblclick', (e) => {
  const t = e.target.closest('#gameList li, .card');
  if (t && !e.target.closest('.card-play, .card-art, .ph-btn')) launchGame(t.dataset.id);
});
// Fecha o seletor rápido de capas ao clicar fora dele ou rolar a grade.
document.addEventListener('mousedown', (e) => {
  if ($('#cardPop') && !e.target.closest('#cardPop, [data-action="card-art"]')) closeCardPop();
});
$('#main').addEventListener('scroll', () => closeCardPop(), { passive: true });
window.addEventListener('resize', () => closeCardPop());

document.addEventListener('change', (e) => {
  if (e.target.id === 'sortSel') { S.sort = e.target.value; savePrefs(); render(); }
  if (e.target.id === 'hiddenChk') { S.showHidden = e.target.checked; savePrefs(); render(); }
  if (e.target.dataset.themeToggle) setTheme({ [e.target.dataset.themeToggle]: e.target.checked });
  if (e.target.dataset.themeRange) setTheme({ [e.target.dataset.themeRange]: +e.target.value });
  if (e.target.id === 'accentPicker') setTheme({ accent: e.target.value });
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'consoleSearch') {
    const q = e.target.value.trim().toLowerCase();
    $$('.console-tile').forEach((t) => { t.style.display = !q || t.dataset.search.includes(q) ? '' : 'none'; });
    $$('.console-group').forEach((g) => {
      const tiles = $$('.console-tile', g);
      g.style.display = !tiles.length || tiles.some((t) => t.style.display !== 'none') ? '' : 'none';
    });
  }
  // Pré-visualização ao vivo enquanto arrasta; o 'change' acima salva e redesenha.
  if (e.target.dataset.themeRange) {
    Theme.apply({ ...Theme.get(), [e.target.dataset.themeRange]: +e.target.value });
    e.target.nextElementSibling.textContent = `${e.target.value}px`;
  }
  if (e.target.id === 'accentPicker') Theme.apply({ ...Theme.get(), accent: e.target.value });
  if (e.target.id === 'sizeRange') {
    S.size = +e.target.value;
    $('.page')?.style.setProperty('--card', `${S.size}px`);
    savePrefs();
  }
});
$('#search').addEventListener('input', (e) => {
  S.search = e.target.value;
  if (S.view !== 'library') S.view = 'library';
  S.selected = null;
  render();
});
$('#addGameBtn').addEventListener('click', () => gameForm());
$('#modeBtn').addEventListener('click', () => setTheme({ mode: Theme.isLight() ? 'dark' : 'light' }));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if ($('#cardPop')) closeCardPop();
    else if ($('#modalRoot').childElementCount) closeModal();
    else if (S.selected) { S.selected = null; render(); }
  }
  if (e.key === '/' && !e.target.closest('input, textarea, select')) { e.preventDefault(); $('#search').focus(); }
});

loadPrefs();
// Sinal de vida: o programa encerra sozinho quando todas as janelas fecham.
setInterval(() => api('/ping').catch(() => {}), 15000);
window.addEventListener('pagehide', () => {
  navigator.sendBeacon(`/api/bye?t=${encodeURIComponent(window.LUDO_TOKEN)}&p=${encodeURIComponent(PAGE_ID)}`);
});
refresh().catch((e) => {
  $('#main').innerHTML = `<div class="empty"><h2>Não foi possível conectar</h2><p>${esc(e.message)}</p><p>Verifique se a janela da SannStation (python app.py) continua aberta.</p></div>`;
});
