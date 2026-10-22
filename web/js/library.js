'use strict';
// Biblioteca: barra lateral, grade de capas e página do jogo.

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
  if (S.view === 'emulators') { measureLogos(main); fillEmuCards(main); }
  if (S.view === 'library' && !S.selected) fitShapedCovers(main);
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
  const genres = allGenres().filter((x) => visible.some((g) => gameGenres(g).includes(x)));
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
    ${tags.length ? `<div class="filter-group"><div class="filter-title">COLEÇÕES</div>${tags.map((t) => btn('tag', t, t, count((g) => g.tags.includes(t)))).join('')}</div>` : ''}
    <div class="filter-group"><div class="filter-title">COLEÇÕES INTELIGENTES <button class="filter-add" data-action="smart-new" title="Nova coleção inteligente">+</button></div>
      ${smartCollections().map((c) => btn('smart', c.id, `⚡ ${c.name}`, count((g) => smartMatches(g, c)))).join('')
        || '<button class="filter hint-filter" data-action="smart-new"><span>⚡ Criar com regras…</span></button>'}
    </div>
    ${statusGroup(visible, btn, count)}
    ${genres.length ? `<div class="filter-group"><div class="filter-title">GÊNEROS</div>${genres.map((x) => btn('genre', x, x, count((g) => gameGenres(g).includes(x)))).join('')}</div>` : ''}`;
  const list = visibleGames();
  $('#count').textContent = `(${list.length})`;
  $('#gameList').innerHTML = list.map((g) => `
    <li data-id="${g.id}" class="${g.id === S.selected ? 'sel' : ''} ${isRunning(g) ? 'run' : ''}" title="${esc(g.name)}">
      ${g.cover ? `<img class="mini" src="${coverUrl(g)}" alt="" loading="lazy">` : '<span class="mini"></span>'}
      <span class="label">${esc(g.name)}${isRunning(g) ? ' — Executando' : ''}</span>
    </li>`).join('');
}

function statusGroup(visible, btn, count) {
  const used = Object.entries(STATUSES).filter(([k]) => visible.some((g) => g.status === k));
  const years = [...new Set(visible.filter(isFinished).map(statusYear).filter(Boolean))].sort((a, b) => b - a).slice(0, 3);
  if (!used.length) return '';
  return `<div class="filter-group"><div class="filter-title">STATUS</div>
    ${used.map(([k, v]) => btn('status', k, `${v.icon} ${v.label}`, count((g) => g.status === k))).join('')}
    ${years.map((y) => btn('finishedYear', String(y), `🏁 Zerados em ${y}`, count((g) => isFinished(g) && statusYear(g) === y))).join('')}
  </div>`;
}

function filterTitle() {
  const f = S.filter;
  if (f.type === 'smart') return `⚡ ${smartById(f.value)?.name || 'Coleção'}`.toUpperCase();
  if (f.type === 'status') return (STATUSES[f.value]?.label || 'Sem status').toUpperCase();
  if (f.type === 'finishedYear') return `ZERADOS EM ${f.value}`;
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
      ${S.filter.type === 'smart' ? `<button class="btn small" data-action="smart-edit" data-id="${esc(S.filter.value)}">✎ Editar coleção</button>` : ''}
      ${missing ? `<button class="btn small" data-action="fetch-missing">Baixar ${missing} capa${missing > 1 ? 's' : ''} faltando</button>` : ''}
      <label>Ordenar
        <select id="sortSel">
          ${[['name', 'Nome'], ['recent', 'Jogado por último'], ['playtime', 'Tempo de jogo'], ['added', 'Adicionado recentemente'], ['year', 'Ano de lançamento']]
            .map(([v, l]) => `<option value="${v}" ${S.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
      <label>Agrupar
        <select id="groupSel">${Object.entries(GROUPINGS).map(([v, gr]) => `<option value="${v}" ${S.group === v ? 'selected' : ''}>${gr.label}</option>`).join('')}</select></label>
      <label>Tamanho <input id="sizeRange" type="range" min="120" max="280" step="10" value="${S.size}"></label>
      <label><input id="hiddenChk" type="checkbox" ${S.showHidden ? 'checked' : ''}> Mostrar ocultos</label>
    </div>
    ${list.length ? gridHtml(list) : '<p class="muted">Nenhum jogo corresponde a este filtro.</p>'}
  </div>`;
}

// Prateleiras: a grade dividida em grupos (console, status, gênero, ano…). Cada agrupamento diz como
// achar o grupo de um jogo e a ordem dos grupos; outros módulos podem acrescentar agrupamentos.
const GROUPINGS = {
  none: { label: 'Nenhum' },
  platform: {
    label: 'Console / plataforma',
    of: (g) => [g.platform || 'Sem plataforma'],
    head: (name, games) => {
      const c = CONSOLES.find((x) => x.name === name) || consoleById(games[0]?.consoleId);
      return `${c && CONSOLE_LOGOS[c.id] ? logoHtml(c, 'small') : ''}<span>${esc(name)}</span>`;
    },
  },
  status: {
    label: 'Status',
    of: (g) => [g.status || ''],
    order: (a, b) => Object.keys(STATUSES).concat('').indexOf(a) - Object.keys(STATUSES).concat('').indexOf(b),
    head: (k) => `<span>${STATUSES[k] ? `${STATUSES[k].icon} ${STATUSES[k].label}` : 'Sem status'}</span>`,
  },
  genre: {
    label: 'Gênero',
    of: (g) => (gameGenres(g).length ? gameGenres(g) : ['Sem gênero']),
    order: (a, b) => (a === 'Sem gênero') - (b === 'Sem gênero') || a.localeCompare(b, 'pt-BR'),
  },
  year: {
    label: 'Ano de lançamento',
    of: (g) => [gameYear(g) ? String(gameYear(g)) : 'Ano desconhecido'],
    order: (a, b) => (b === 'Ano desconhecido' ? -1 : a === 'Ano desconhecido' ? 1 : b - a),
  },
};
function gridHtml(list) {
  const grouping = GROUPINGS[S.group];
  if (!grouping?.of) return `<div class="grid">${list.map(cardHtml).join('')}</div>`;
  const groups = new Map();
  list.forEach((g) => grouping.of(g).forEach((k) => {
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(g);
  }));
  const names = [...groups.keys()].sort(grouping.order || ((a, b) => String(a).localeCompare(String(b), 'pt-BR', { numeric: true })));
  return names.map((name) => `<section class="shelf">
    <h3 class="shelf-title">${grouping.head ? grouping.head(name, groups.get(name)) : `<span>${esc(name)}</span>`}<span class="n">${groups.get(name).length}</span></h3>
    <div class="grid">${groups.get(name).map(cardHtml).join('')}</div>
  </section>`).join('');
}

// Formato da capa por console: paisagem (caixas do NES/SNES/N64), quadrada (caixa de CD do PlayStation 1)
// ou em pé (padrão, todo o resto).
const COVER_SHAPES = { nes: 'landscape', snes: 'landscape', n64: 'landscape', ps1: 'square' };
const SHAPE_BY_PLATFORM = [
  [/super nintendo|\bsnes\b|super famicom|nintendo \(nes\)|\bnes\b|famicom|nintendo 64|\bn64\b/i, 'landscape'],
  [/^\s*playstation\s*(\(ps1?\)|1)?\s*$|\bpsx\b|\bps1\b|psone/i, 'square'],
];
function coverShape(g) {
  if (!g || g.kind !== 'rom') return '';
  const emu = emuById(g.emulatorId);
  const id = g.consoleId || emu?.consoleId;
  if (id) return COVER_SHAPES[id] || '';
  for (const text of [g.platform, emu?.platform]) {
    const hit = SHAPE_BY_PLATFORM.find(([re]) => re.test(text || ''));
    if (hit) return hit[1];
  }
  return '';
}
const shapeClass = (g) => (coverShape(g) ? ` ${coverShape(g)}` : '');

// Quando a imagem baixada não tem o formato do card (ex.: caixa em pé do NES num card em paisagem),
// mostra a capa inteira sobre um fundo desfocado da própria imagem, em vez de cortar.
function fitShapedCovers(root = document) {
  $$('.card.landscape .cover img, .card.square .cover img', root).forEach((img) => {
    const check = () => {
      const cover = img.parentElement;
      const box = cover.getBoundingClientRect();
      const ratio = (img.naturalWidth / img.naturalHeight) / (box.width / box.height || 1);
      const mismatch = ratio < 0.85 || ratio > 1.18;
      cover.classList.toggle('fit', mismatch);
      if (mismatch) cover.style.setProperty('--fit-bg', `url("${img.src}")`);
    };
    if (img.complete && img.naturalWidth) check();
    else img.addEventListener('load', check, { once: true });
  });
}

function cardHtml(g) {
  return `<div class="card${shapeClass(g)}" data-id="${g.id}" title="${esc(g.name)}">
    <div class="cover">
      ${g.cover ? `<img src="${coverUrl(g)}" alt="" loading="lazy">`
        : `<div class="ph"><span>${esc(g.name)}</span><button class="ph-btn" data-action="card-art" data-id="${g.id}">🔍 Buscar capa online</button></div>`}
      ${g.cover ? `<button class="card-art" data-action="card-art" data-id="${g.id}" title="Trocar capa">🖼</button>` : ''}
      ${isRunning(g) ? '<span class="badge">EXECUTANDO</span>' : ''}
      ${g.favorite ? '<span class="fav-star">★</span>' : ''}
      ${consoleBadge(g)}
    </div>
    <button class="card-play" data-action="play" data-id="${g.id}" title="Jogar">▶</button>
    <div class="card-title">${esc(g.name)}</div>
    <div class="card-sub">${esc(g.platform)}${STATUSES[g.status] ? ` · <span title="${STATUSES[g.status].label}">${STATUSES[g.status].icon}</span>` : ''}</div>
  </div>`;
}

// Painel "Sobre": descrição, ano, gênero e desenvolvedora (Wikipedia).
function aboutPanel(g) {
  const m = g.meta || {};
  if (!m.title) {
    return `<div class="about empty-about"><span class="muted">${m.notFound ? 'Não encontrei este jogo na Wikipedia.' : 'Sem informações sobre este jogo ainda.'}</span>
      <button class="btn small" data-action="meta" data-id="${g.id}">🔎 Buscar ano, gênero e descrição</button></div>`;
  }
  const facts = [
    m.year ? ['Lançamento', m.year] : null, m.developer ? ['Desenvolvedora', m.developer] : null,
    m.publisher && m.publisher !== m.developer ? ['Publicadora', m.publisher] : null, m.series ? ['Série', m.series] : null,
  ].filter(Boolean);
  return `<div class="about">
    <div class="about-text">${m.description ? `<p>${esc(m.description).replace(/\n\n/g, '</p><p>')}</p>` : ''}
      <div class="about-links"><a href="${esc(m.url)}" target="_blank" rel="noopener">Wikipedia ↗</a>
        <button class="linklike" data-action="meta" data-id="${g.id}">Atualizar</button></div></div>
    <div class="about-facts">
      ${gameGenres(g).length ? `<div class="chips">${gameGenres(g).map((x) => `<button class="chip" data-action="genre" data-genre="${esc(x)}">${esc(x)}</button>`).join('')}</div>` : ''}
      ${facts.map(([k, v]) => `<div class="fact"><span class="k">${k}</span><span>${esc(v)}</span></div>`).join('')}
    </div>
  </div>`;
}

// Logo do console no canto da capa dos jogos de emulador.
function consoleBadge(g) {
  if (g.kind !== 'rom' || S.group === 'platform') return '';
  const id = g.consoleId || emuById(g.emulatorId)?.consoleId;
  const file = id && CONSOLE_LOGOS[id];
  return file ? `<span class="console-badge" title="${esc(g.platform)}"><img src="/logos/${file}" alt="" loading="lazy"></span>` : '';
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
        ${g.cover ? `<img class="detail-cover${shapeClass(g)}" src="${coverUrl(g)}" alt="">` : ''}
        <h1>${esc(g.name)}</h1>
      </div>
    </div></div>
    <div class="detail-bar">
      <button class="play-btn ${run ? 'running' : ''}" data-action="play" data-id="${g.id}" ${run ? 'disabled' : ''}>${run ? '■ EXECUTANDO' : '▶ JOGAR'}</button>
      <div class="stat"><div class="k">Jogado por último</div><div class="v">${fmtDate(g.lastPlayed)}</div></div>
      <div class="stat"><div class="k">Tempo de jogo</div><div class="v">${g.kind === 'url' && !g.playtime ? '—' : fmtPlaytime(g.playtime)}</div></div>
      <div class="stat"><div class="k">Plataforma</div><div class="v">${esc(g.platform)}</div></div>
      <div class="stat"><div class="k">Status</div><div class="v"><select class="status-sel" data-status-id="${g.id}">
        <option value="">—</option>${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}" ${g.status === k ? 'selected' : ''}>${v.icon} ${v.label}</option>`).join('')}
      </select>${g.statusAt && g.status ? `<span class="status-date">desde ${new Date(g.statusAt * 1000).toLocaleDateString('pt-BR')}</span>` : ''}</div></div>
      <div class="spacer"></div>
      <div class="icon-btns">
        <button class="icon-btn ${g.favorite ? 'on' : ''}" data-action="toggle" data-field="favorite" data-id="${g.id}" title="Favorito">${g.favorite ? '★' : '☆'} Favorito</button>
        <button class="icon-btn" data-action="art" data-id="${g.id}">🖼 Capa e banner</button>
        <button class="icon-btn" data-action="edit" data-id="${g.id}">✎ Editar</button>
        ${g.kind !== 'url' ? `<button class="icon-btn" data-action="folder" data-id="${g.id}">📁 Abrir pasta</button>` : ''}
        ${g.kind === 'rom' && emu ? `<button class="icon-btn" data-action="saves" data-id="${g.id}">💾 Saves</button>` : ''}
        <button class="icon-btn" data-action="toggle" data-field="hidden" data-id="${g.id}">${g.hidden ? '👁 Mostrar' : '🚫 Ocultar'}</button>
        <button class="icon-btn" data-action="delete" data-id="${g.id}">🗑 Remover</button>
      </div>
    </div>
    ${aboutPanel(g)}
    <div class="detail-body">
      <div class="panel">
        <h3>INFORMAÇÕES</h3>
        <div class="kv">
          <span class="k">Tipo</span><span>${kindLabel}</span>
          ${emu ? `<span class="k">Emulador</span><span>${esc(emu.name)}</span>` : ''}
          ${g.kind === 'rom' && !emu ? '<span class="k">Emulador</span><span style="color:var(--danger)">removido — edite o jogo</span>' : ''}
          <span class="k">${g.kind === 'url' ? 'Endereço' : 'Caminho'}</span><code>${esc(g.path)}</code>
          ${g.args ? `<span class="k">${g.kind === 'rom' ? 'Argumentos (só deste jogo)' : 'Argumentos'}</span><code>${esc(g.args)}</code>` : ''}
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
