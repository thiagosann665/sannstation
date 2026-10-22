'use strict';
// Tela inicial "O que jogar agora?": continue jogando, neste dia, roleta e jogos esquecidos.

const playableGames = () => S.games.filter((g) => !g.hidden && g.status !== 'wishlist');
const ago = (ts) => {
  const days = Math.floor((now() - ts) / DAY);
  if (days < 1) return 'hoje';
  if (days === 1) return 'ontem';
  if (days < 30) return `há ${days} dias`;
  const months = Math.floor(days / 30.4);
  if (months < 12) return `há ${months} ${months === 1 ? 'mês' : 'meses'}`;
  const years = Math.floor(days / 365);
  return `há ${years} ${years === 1 ? 'ano' : 'anos'}`;
};

// Sorteio estável no dia: a lista de esquecidos não muda a cada clique, só de um dia para o outro.
function dailyShuffle(list) {
  const seed = new Date().toDateString();
  const hash = (s) => [...s].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0), 2166136261);
  return [...list].sort((a, b) => hash(seed + a.id) - hash(seed + b.id));
}

function continuePlaying() {
  return playableGames().filter((g) => g.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 3);
}

function forgottenGames() {
  const old = playableGames().filter((g) => !g.lastPlayed && g.added && now() - g.added > 60 * DAY
    && !['beaten', 'completed', 'abandoned'].includes(g.status));
  return dailyShuffle(old).slice(0, 6);
}

// Partidas de anos anteriores no mesmo dia (ou na mesma semana, se não houver no dia).
function onThisDay() {
  const today = new Date();
  const sameDay = (d, slack) => {
    const ref = new Date(d.getFullYear(), today.getMonth(), today.getDate());
    return Math.abs(d - ref) <= slack * DAY * 1000;
  };
  for (const slack of [0.99, 3.5]) {
    const hits = new Map();
    S.sessions.forEach((s) => {
      const d = new Date(s.s * 1000);
      if (d.getFullYear() >= today.getFullYear() || !gameById(s.g) || !sameDay(d, slack)) return;
      const key = `${d.getFullYear()}|${s.g}`;
      const cur = hits.get(key) || { year: d.getFullYear(), game: gameById(s.g), seconds: 0, when: s.s };
      cur.seconds += s.d || 0;
      hits.set(key, cur);
    });
    if (hits.size) return { exact: slack < 1, items: [...hits.values()].sort((a, b) => b.year - a.year || b.seconds - a.seconds).slice(0, 3) };
  }
  return null;
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Boa madrugada' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

function homeView() {
  if (!S.games.length) return libraryView();
  const cont = continuePlaying();
  const forgotten = forgottenGames();
  const day = onThisDay();
  const playing = playableGames().filter((g) => g.status === 'playing' && !cont.includes(g)).slice(0, 6);
  const month = new Date().getMonth();
  const wrapYear = month === 0 ? new Date().getFullYear() - 1 : new Date().getFullYear();
  const showWrapped = (month === 11 || month === 0) && S.sessions.some((s) => new Date(s.s * 1000).getFullYear() === wrapYear && s.d > 0);
  const contCard = (g) => {
    const art = heroUrl(g) || coverUrl(g);
    const last = S.sessions.filter((s) => s.g === g.id).at(-1);
    return `<div class="cont-card" data-id="${g.id}">
      <div class="cont-bg" style="${art ? `background-image:url('${art}')` : ''}"></div>
      <div class="cont-body">
        ${g.cover ? `<img class="cont-cover${shapeClass(g)}" src="${coverUrl(g)}" alt="">` : ''}
        <div class="cont-info">
          <div class="cont-name">${esc(g.name)}</div>
          <div class="cont-meta">${esc(g.platform)} · ${g.playtime ? `${fmtPlaytime(g.playtime)} no total` : 'tempo não medido'}</div>
          <div class="cont-meta">Jogado ${ago(g.lastPlayed)}${last?.d ? ` por ${fmtPlaytime(last.d)}` : ''}</div>
          <button class="btn primary play-small" data-action="play" data-id="${g.id}" ${isRunning(g) ? 'disabled' : ''}>${isRunning(g) ? '■ Executando' : '▶ Continuar'}</button>
        </div>
      </div>
    </div>`;
  };
  return `<div class="page home" style="--card:${Math.min(S.size, 170)}px">
    <div class="home-head">
      <div><h2>${greeting()}! O que vamos jogar?</h2>
        <p class="sub">${S.games.length} jogos na biblioteca · ${fmtPlaytime(S.games.reduce((n, g) => n + (g.playtime || 0), 0))} jogadas ao todo</p></div>
      <div class="spacer"></div>
      <button class="btn primary big" data-action="roulette">🎲 Me surpreenda</button>
    </div>
    ${showWrapped ? `<button class="wrapped-banner" data-action="wrapped" data-year="${wrapYear}">✨ <b>Sua retrospectiva ${wrapYear}</b> está pronta — veja seu ano na SannStation <span>›</span></button>` : ''}
    ${cont.length ? `<section class="home-sec"><h3>Continue jogando</h3><div class="cont-row">${cont.map(contCard).join('')}</div></section>` : ''}
    ${day ? `<section class="home-sec"><h3>${day.exact ? 'Neste dia' : 'Nesta semana'}, em outros anos</h3><div class="memo-row">${day.items.map((m) => {
      const years = new Date().getFullYear() - m.year;
      return `<div class="memo" data-id="${m.game.id}">
        ${m.game.cover ? `<img src="${coverUrl(m.game)}" alt="">` : '<span class="mini"></span>'}
        <p>Há ${years} ${years === 1 ? 'ano' : 'anos'}${day.exact ? '' : ', nesta semana,'} você jogou <b>${esc(m.game.name)}</b>${m.seconds ? ` por ${fmtPlaytime(m.seconds)}` : ''}.</p>
      </div>`;
    }).join('')}</div></section>` : ''}
    ${playing.length ? `<section class="home-sec"><h3>🎮 Você está jogando</h3><div class="grid">${playing.map(cardHtml).join('')}</div></section>` : ''}
    ${forgotten.length ? `<section class="home-sec"><h3>Esquecidos <span class="muted">— na biblioteca há meses e nunca abertos</span></h3>
      <div class="grid">${forgotten.map(cardHtml).join('')}</div></section>` : ''}
    <section class="home-sec"><h3>Roleta</h3>${rouletteForm()}</section>
  </div>`;
}

// ------------------------------------------------------------------ roleta

function rouletteForm() {
  const plats = [...new Set(playableGames().map((g) => g.platform))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const tags = [...new Set(S.games.flatMap((g) => g.tags))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  return `<form class="roulette-form" id="rouletteForm">
    <label>Console <select name="platform"><option value="">Qualquer um</option>${plats.map((p) => `<option>${esc(p)}</option>`).join('')}</select></label>
    <label>Coleção <select name="coll"><option value="">Qualquer uma</option>
      ${tags.map((t) => `<option value="tag:${esc(t)}">${esc(t)}</option>`).join('')}
      ${smartCollections().map((c) => `<option value="smart:${esc(c.id)}">⚡ ${esc(c.name)}</option>`).join('')}</select></label>
    <label class="check"><input type="checkbox" name="unfinished" checked> Só os que ainda não zerei</label>
    <button class="btn primary" type="submit">🎲 Girar</button>
  </form>`;
}

function rouletteCandidates(opts) {
  return playableGames().filter((g) => {
    if (opts.platform && g.platform !== opts.platform) return false;
    if (opts.unfinished && ['beaten', 'completed', 'abandoned'].includes(g.status)) return false;
    if (opts.coll?.startsWith('tag:') && !g.tags.includes(opts.coll.slice(4))) return false;
    if (opts.coll?.startsWith('smart:')) {
      const c = smartById(opts.coll.slice(6));
      if (c && !smartMatches(g, c)) return false;
    }
    return true;
  });
}

function rouletteOpts() {
  const f = $('#rouletteForm');
  if (!f) return { platform: '', coll: '', unfinished: true };
  return { platform: f.elements.platform.value, coll: f.elements.coll.value, unfinished: f.elements.unfinished.checked };
}

function spinRoulette(opts = rouletteOpts()) {
  const pool = rouletteCandidates(opts);
  if (!pool.length) return toast('Nenhum jogo com esses filtros. Tente outro console ou coleção.', true);
  const winner = pool[Math.floor(Math.random() * pool.length)];
  const W = 128;
  const GAP = 12;
  const LEN = 34;
  const WIN_AT = 28;
  const strip = Array.from({ length: LEN }, (_, i) => (i === WIN_AT ? winner : pool[Math.floor(Math.random() * pool.length)]));
  const tile = (g) => `<div class="rl-tile" style="width:${W}px">${g.cover ? `<img src="${coverUrl(g)}" alt="">`
    : `<span>${esc(g.name)}</span>`}</div>`;
  const m = openModal(`<h2>🎲 Roleta</h2>
    <p class="hint" style="margin-top:-6px">${pool.length} jogo(s) na roleta.</p>
    <div class="rl-window"><div class="rl-marker"></div><div class="rl-strip" style="gap:${GAP}px">${strip.map(tile).join('')}</div></div>
    <div class="rl-result" id="rlResult"></div>
    <div class="actions"><button class="btn ghost" data-close>Fechar</button></div>`, true);
  const stripEl = $('.rl-strip', m);
  const win = $('.rl-window', m);
  const animated = Theme.get().animations !== false;
  requestAnimationFrame(() => {
    const target = WIN_AT * (W + GAP) + W / 2 - win.clientWidth / 2 + (Math.random() - 0.5) * W * 0.6;
    stripEl.style.transition = `transform ${animated ? 4.2 : 0.3}s cubic-bezier(.12,.62,.08,1)`;
    stripEl.style.transform = `translateX(${-target}px)`;
  });
  let shown = false;
  const show = () => {
    if (shown || !m.isConnected) return;
    shown = true;
    $$('.rl-tile', m)[WIN_AT].classList.add('won');
    $('#rlResult', m).innerHTML = `<div class="rl-win">
      <div><div class="rl-name">${esc(winner.name)}</div>
        <div class="muted">${esc(winner.platform)}${winner.playtime ? ` · ${fmtPlaytime(winner.playtime)} jogadas` : ' · nunca jogado'}${gameGenres(winner).length ? ` · ${esc(gameGenres(winner).join(', '))}` : ''}</div></div>
      <div class="spacer"></div>
      <button class="btn" id="rlAgain">🎲 Girar de novo</button>
      <button class="btn" data-rl="open">Ver página</button>
      <button class="btn primary" data-rl="play">▶ Jogar</button>
    </div>`;
    $('#rlAgain', m).addEventListener('click', () => spinRoulette(opts));
    $('[data-rl=open]', m).addEventListener('click', () => { closeModal(); S.view = 'library'; S.selected = winner.id; render(); });
    $('[data-rl=play]', m).addEventListener('click', () => { closeModal(); launchGame(winner.id); });
  };
  stripEl.addEventListener('transitionend', show, { once: true });
  setTimeout(show, animated ? 4600 : 600); // garante o resultado mesmo se a transição não disparar
  return undefined;
}
