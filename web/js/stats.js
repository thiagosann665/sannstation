'use strict';
// Estatísticas pessoais (horas por console, por semana/mês, dia da semana, mais jogados)
// e a retrospectiva do ano ("Wrapped"). Tudo calculado do histórico de partidas (S.sessions).

const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const hours = (sec) => sec / 3600;
const fmtHours = (sec) => (sec < 3600 ? `${Math.round(sec / 60)} min` : `${hours(sec).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} h`);

function sessionsIn(year) {
  return S.sessions.filter((s) => gameById(s.g) && (!year || new Date(s.s * 1000).getFullYear() === year));
}
function statYears() {
  const ys = new Set(S.sessions.map((s) => new Date(s.s * 1000).getFullYear()));
  ys.add(new Date().getFullYear());
  return [...ys].sort((a, b) => b - a);
}

function summarize(year) {
  const list = sessionsIn(year);
  const timed = list.filter((s) => s.d > 0);
  const perGame = new Map();
  list.forEach((s) => {
    const cur = perGame.get(s.g) || { game: gameById(s.g), seconds: 0, plays: 0 };
    cur.seconds += s.d || 0;
    cur.plays += 1;
    perGame.set(s.g, cur);
  });
  // Sem ano escolhido, o total de cada jogo vem do tempo acumulado (inclui o que foi jogado antes do histórico).
  if (!year) {
    S.games.filter((g) => g.playtime).forEach((g) => {
      const cur = perGame.get(g.id) || { game: g, seconds: 0, plays: 0 };
      cur.seconds = Math.max(cur.seconds, g.playtime);
      perGame.set(g.id, cur);
    });
  }
  const games = [...perGame.values()].sort((a, b) => b.seconds - a.seconds || b.plays - a.plays);
  const total = games.reduce((n, x) => n + x.seconds, 0);
  const perPlatform = new Map();
  games.forEach((x) => perPlatform.set(x.game.platform, (perPlatform.get(x.game.platform) || 0) + x.seconds));
  const weekday = Array(7).fill(0);
  const hour = Array(24).fill(0);
  timed.forEach((s) => {
    const d = new Date(s.s * 1000);
    weekday[d.getDay()] += s.d;
    hour[d.getHours()] += s.d;
  });
  const longest = timed.reduce((best, s) => (!best || s.d > best.d ? s : best), null);
  const finished = S.games.filter((g) => isFinished(g) && (!year || statusYear(g) === year));
  return {
    year, list, timed, games, total, longest, finished, weekday, hour,
    platforms: [...perPlatform.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]),
    avg: timed.length ? timed.reduce((n, s) => n + s.d, 0) / timed.length : 0,
  };
}

// Horas por semana (últimas 12) ou por mês (do ano escolhido, ou últimos 12 meses).
function timeSeries(sum, mode) {
  const buckets = [];
  if (mode === 'week') {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // segunda-feira desta semana
    for (let i = 11; i >= 0; i--) {
      const from = new Date(start);
      from.setDate(from.getDate() - i * 7);
      const to = new Date(from);
      to.setDate(to.getDate() + 7);
      buckets.push({ from, to, label: `${from.getDate()}/${from.getMonth() + 1}`, tip: `Semana de ${from.toLocaleDateString('pt-BR')}` });
    }
  } else if (sum.year) {
    for (let m = 0; m < 12; m++) {
      buckets.push({ from: new Date(sum.year, m, 1), to: new Date(sum.year, m + 1, 1), label: MONTHS[m], tip: `${MONTHS[m]}/${sum.year}` });
    }
  } else {
    const d = new Date();
    for (let i = 11; i >= 0; i--) {
      const from = new Date(d.getFullYear(), d.getMonth() - i, 1);
      buckets.push({ from, to: new Date(from.getFullYear(), from.getMonth() + 1, 1), label: MONTHS[from.getMonth()], tip: `${MONTHS[from.getMonth()]}/${from.getFullYear()}` });
    }
  }
  const src = mode === 'week' ? S.sessions : sum.timed;
  buckets.forEach((b) => {
    b.value = src.filter((s) => s.d > 0 && s.s * 1000 >= b.from && s.s * 1000 < b.to).reduce((n, s) => n + s.d, 0);
  });
  return buckets;
}

// ------------------------------------------------------------------ gráficos (HTML puro)

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

// Colunas de uma série só (cor de destaque), eixo em horas, tooltip por coluna e tabela acessível.
function columnChart(title, buckets, caption) {
  const maxH = niceMax(Math.max(...buckets.map((b) => hours(b.value))));
  const ticks = [0, maxH / 2, maxH];
  const best = buckets.reduce((a, b) => (b.value > a.value ? b : a), buckets[0]);
  return `<figure class="chart">
    <figcaption><b>${title}</b>${caption ? `<span>${caption}</span>` : ''}</figcaption>
    <div class="cols" role="img" aria-label="${esc(title)}">
      <div class="axis">${ticks.slice().reverse().map((t) => `<span>${t.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} h</span>`).join('')}</div>
      <div class="plot">
        ${ticks.map((t) => `<div class="gridline" style="bottom:${(t / maxH) * 100}%"></div>`).join('')}
        ${buckets.map((b) => `<div class="col" data-tip="${esc(b.tip)}: ${fmtHours(b.value)}">
          ${b === best && b.value ? `<span class="col-label" style="bottom:calc(${(hours(b.value) / maxH) * 100}% + 4px)">${fmtHours(b.value)}</span>` : ''}
          <span class="bar" style="height:${(hours(b.value) / maxH) * 100}%"></span></div>`).join('')}
      </div>
    </div>
    <div class="xlabels">${buckets.map((b) => `<span>${esc(b.label)}</span>`).join('')}</div>
    ${tableView(buckets.map((b) => [b.tip, fmtHours(b.value)]), ['Período', 'Tempo'])}
  </figure>`;
}

// Barras horizontais ordenadas (magnitude por categoria), valor na ponta.
function barList(title, rows, caption) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return `<figure class="chart">
    <figcaption><b>${title}</b>${caption ? `<span>${caption}</span>` : ''}</figcaption>
    <div class="hbars">${rows.map((r) => `<div class="hrow" data-tip="${esc(r.label)}: ${r.text}">
      <span class="hlabel">${r.icon || ''}<span>${esc(r.label)}</span></span>
      <span class="htrack"><span class="hbar" style="width:${Math.max(0.5, (r.value / max) * 100)}%"><span class="hval">${r.text}</span></span></span>
    </div>`).join('')}</div>
    ${tableView(rows.map((r) => [r.label, r.text]), ['', 'Tempo'])}
  </figure>`;
}

function tableView(rows, head) {
  return `<details class="table-view"><summary>Ver como tabela</summary><table>
    <thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></details>`;
}

// Tooltip único para todos os elementos com data-tip.
const tipEl = document.createElement('div');
tipEl.id = 'chartTip';
document.body.appendChild(tipEl);
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-tip]');
  if (!t) { tipEl.classList.remove('on'); return; }
  tipEl.textContent = t.dataset.tip;
  tipEl.classList.add('on');
});
document.addEventListener('mousemove', (e) => {
  if (!tipEl.classList.contains('on')) return;
  const x = Math.min(e.clientX + 14, innerWidth - tipEl.offsetWidth - 8);
  tipEl.style.transform = `translate(${x}px, ${e.clientY - tipEl.offsetHeight - 10}px)`;
});

// ------------------------------------------------------------------ tela

function statsView() {
  const years = statYears();
  if (S.statsYear !== 0 && !years.includes(S.statsYear)) S.statsYear = new Date().getFullYear();
  const sum = summarize(S.statsYear || 0);
  const mode = S.statsMode || 'month';
  const label = S.statsYear ? `em ${S.statsYear}` : 'no total';
  const tile = (k, v, sub = '') => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
  const top = sum.games.filter((x) => x.seconds > 0).slice(0, 10);
  const plats = sum.platforms.slice(0, 8);
  const other = sum.platforms.slice(8).reduce((n, [, v]) => n + v, 0);
  if (other) plats.push(['Outros', other]);
  const noTime = sum.list.filter((s) => !s.d).length;
  const series = timeSeries(sum, mode);
  const favDay = sum.weekday.some(Boolean) ? WEEKDAYS[sum.weekday.indexOf(Math.max(...sum.weekday))] : '—';
  return `<div class="page stats">
    <div class="toolbar">
      <div><h2>Estatísticas</h2><p class="sub" style="margin:0">Calculadas das suas partidas. Jogos abertos pela Steam/Epic contam a partida, mas não o tempo.</p></div>
      <div class="spacer"></div>
      <div class="seg">${[0, ...years].map((y) => `<button class="${(S.statsYear || 0) === y ? 'on' : ''}" data-action="stats-year" data-value="${y}">${y || 'Tudo'}</button>`).join('')}</div>
      ${S.statsYear ? `<button class="btn primary" data-action="wrapped" data-year="${S.statsYear}">✨ Retrospectiva ${S.statsYear}</button>` : ''}
    </div>
    <div class="hero-stat"><div class="v">${fmtHours(sum.total)}</div><div class="k">jogadas ${label}</div></div>
    <div class="tiles">
      ${tile('Jogos diferentes', sum.games.filter((x) => x.seconds > 0 || x.plays).length)}
      ${tile('Partidas', sum.list.length, noTime ? `${noTime} sem tempo medido` : '')}
      ${tile('Zerados', sum.finished.length, S.statsYear ? `em ${S.statsYear}` : 'no total')}
      ${tile('Média por partida', sum.avg ? fmtHours(sum.avg) : '—')}
      ${tile('Partida mais longa', sum.longest ? fmtHours(sum.longest.d) : '—', sum.longest ? esc(gameById(sum.longest.g)?.name || '') : '')}
      ${tile('Dia favorito', favDay)}
    </div>
    ${sum.total || sum.list.length ? `<div class="chart-grid">
      <div class="chart-card">
        <div class="seg small">${[['month', 'Por mês'], ['week', 'Por semana']].map(([v, l]) => `<button class="${mode === v ? 'on' : ''}" data-action="stats-mode" data-value="${v}">${l}</button>`).join('')}</div>
        ${columnChart(mode === 'week' ? 'Horas por semana' : 'Horas por mês', series, mode === 'week' ? 'últimas 12 semanas' : (S.statsYear ? String(S.statsYear) : 'últimos 12 meses'))}
      </div>
      <div class="chart-card">${barList('Horas por console', plats.map(([p, v]) => {
        const c = CONSOLES.find((x) => x.name === p);
        return { label: p, value: v, text: fmtHours(v), icon: c && CONSOLE_LOGOS[c.id] ? logoHtml(c, 'small') : '' };
      }), label)}</div>
      <div class="chart-card">${columnChart('Quando você joga', WEEKDAYS.map((d, i) => ({ label: d.slice(0, 3), tip: d, value: sum.weekday[i] })), 'por dia da semana')}</div>
      <div class="chart-card">${barList('Mais jogados', top.map((x) => ({
        label: x.game.name, value: x.seconds, text: fmtHours(x.seconds),
        icon: x.game.cover ? `<img class="hicon" src="${coverUrl(x.game)}" alt="">` : '<span class="hicon"></span>',
      })), label)}</div>
    </div>` : '<div class="empty"><h2>Nenhuma partida registrada ainda</h2><p>Jogue pela SannStation e o tempo de cada partida aparece aqui.</p></div>'}
  </div>`;
}

// ------------------------------------------------------------------ retrospectiva do ano

function wrappedSlides(year) {
  const sum = summarize(year);
  const slides = [];
  const cover = (g, cls = '') => (g?.cover ? `<img class="w-cover ${cls}" src="${coverUrl(g)}" alt="">` : '');
  slides.push(`<div class="w-kicker">SannStation</div><h1>Seu ${year}<br>em jogos</h1><p>Toque ou use as setas para avançar.</p>`);
  const days = sum.total / 86400;
  slides.push(`<div class="w-kicker">Tempo de jogo</div><div class="w-big">${fmtHours(sum.total)}</div>
    <p>${days >= 1 ? `Isso dá <b>${days.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} dias</b> inteiros` : `Isso dá <b>${Math.max(1, Math.round(sum.total / 7200))} filme(s)</b> de 2 horas`}
      em ${sum.list.length} partidas de ${sum.games.filter((x) => x.plays).length} jogos diferentes.</p>`);
  const best = sum.games[0];
  if (best?.seconds) {
    slides.push(`<div class="w-kicker">Seu jogo do ano</div>${cover(best.game, 'big')}<h2>${esc(best.game.name)}</h2>
      <p><b>${fmtHours(best.seconds)}</b> em ${best.plays} partida(s) — ${Math.round((best.seconds / sum.total) * 100)}% do seu tempo.</p>`);
  }
  const top5 = sum.games.filter((x) => x.seconds).slice(0, 5);
  if (top5.length > 1) {
    slides.push(`<div class="w-kicker">Seu top ${top5.length}</div><ol class="w-top">${top5.map((x) => `<li>${cover(x.game, 'mini')}<span>${esc(x.game.name)}</span><b>${fmtHours(x.seconds)}</b></li>`).join('')}</ol>`);
  }
  const plat = sum.platforms[0];
  if (plat) {
    const c = CONSOLES.find((x) => x.name === plat[0]);
    slides.push(`<div class="w-kicker">Console favorito</div>${c && CONSOLE_LOGOS[c.id] ? `<div class="w-logo"><img src="/logos/${CONSOLE_LOGOS[c.id]}" alt=""></div>` : ''}
      <h2>${esc(plat[0])}</h2><p><b>${fmtHours(plat[1])}</b> — ${Math.round((plat[1] / sum.total) * 100)}% das suas horas.</p>`);
  }
  if (sum.finished.length) {
    slides.push(`<div class="w-kicker">Zerados em ${year}</div><div class="w-big">${sum.finished.length}</div>
      <div class="w-covers">${sum.finished.slice(0, 8).map((g) => cover(g, 'mini') || `<span class="w-chip">${esc(g.name)}</span>`).join('')}</div>`);
  }
  if (sum.timed.length) {
    const h = sum.hour;
    const slots = [['madrugada', h.slice(0, 6)], ['manhã', h.slice(6, 12)], ['tarde', h.slice(12, 18)], ['noite', h.slice(18)]]
      .map(([k, arr]) => [k, arr.reduce((n, v) => n + v, 0)]).sort((a, b) => b[1] - a[1]);
    const day = WEEKDAYS[sum.weekday.indexOf(Math.max(...sum.weekday))];
    const persona = { madrugada: 'Coruja da madrugada 🦉', manhã: 'Jogador matinal ☀', tarde: 'Jogador da tarde 🎮', noite: 'Jogador da noite 🌙' }[slots[0][0]];
    slides.push(`<div class="w-kicker">Seu estilo</div><h2>${persona}</h2><p>Você joga mais à <b>${slots[0][0]}</b>, e o seu dia favorito é <b>${day.toLowerCase()}</b>.</p>`);
  }
  if (sum.longest) {
    const g = gameById(sum.longest.g);
    slides.push(`<div class="w-kicker">Maratona</div><div class="w-big">${fmtHours(sum.longest.d)}</div>
      <p>Sua partida mais longa: <b>${esc(g?.name || '')}</b>, em ${new Date(sum.longest.s * 1000).toLocaleDateString('pt-BR')}.</p>`);
  }
  slides.push(`<div class="w-kicker">Fim</div><h1>Até ${year + 1}! 🎮</h1><p>Que venham mais jogos zerados.</p>`);
  return { slides, sum };
}

function openWrapped(year) {
  const { slides, sum } = wrappedSlides(year);
  if (!sum.list.length) return toast(`Ainda não há partidas registradas em ${year}.`, true);
  const best = sum.games[0]?.game;
  const art = best ? heroUrl(best) || coverUrl(best) : '';
  const el = document.createElement('div');
  el.id = 'wrapped';
  el.innerHTML = `<div class="w-bg" style="${art ? `background-image:url('${art}')` : ''}"></div>
    <div class="w-dots">${slides.map((_, i) => `<span data-i="${i}"></span>`).join('')}</div>
    <button class="w-x" title="Fechar (Esc)">✕</button>
    <div class="w-slide"></div>`;
  document.body.appendChild(el);
  let i = 0;
  const show = () => {
    $('.w-slide', el).innerHTML = `<div class="w-inner">${slides[i]}</div>`;
    $$('.w-dots span', el).forEach((d, j) => d.classList.toggle('on', j <= i));
  };
  const close = () => { el.remove(); document.removeEventListener('keydown', key, true); };
  const go = (d) => {
    i += d;
    if (i >= slides.length) return close();
    i = Math.max(0, i);
    return show();
  };
  const key = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'ArrowRight' || e.key === ' ') go(1);
    if (e.key === 'ArrowLeft') go(-1);
  };
  el.addEventListener('click', (e) => {
    if (e.target.closest('.w-x')) return close();
    if (e.target.closest('.w-dots span')) { i = +e.target.dataset.i; return show(); }
    return go(e.clientX < innerWidth / 3 ? -1 : 1);
  });
  document.addEventListener('keydown', key, true);
  show();
  return undefined;
}
