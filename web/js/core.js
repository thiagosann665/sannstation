'use strict';
// Utilidades, estado global, acesso à API e filtros da biblioteca.

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SOURCES = { manual: 'Adicionado manualmente', steam: 'Steam', epic: 'Epic Games', gog: 'GOG', 'rom-scan': 'Escaneamento de ROMs' };

const S = {
  games: [], emulators: [], settings: {}, sessions: [], running: {}, dataDir: '', version: '',
  view: 'home', selected: null, filter: { type: 'all', value: null }, statsYear: new Date().getFullYear(), statsMode: 'month',
  search: '', sort: 'name', group: 'none', showHidden: false, size: 180,
  detected: null, detecting: null, consoleMaker: 'Todos',
};
let pollTimer = null;

// ------------------------------------------------------------------ utilidades

function loadPrefs() {
  try { Object.assign(S, JSON.parse(localStorage.getItem('sannstation-prefs') || localStorage.getItem('ludoteca-prefs') || '{}')); } catch { /* sem storage */ }
}
function savePrefs() {
  try { localStorage.setItem('sannstation-prefs', JSON.stringify({ sort: S.sort, group: S.group, size: S.size, showHidden: S.showHidden })); } catch { /* sem storage */ }
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
const isRunning = (g) => Boolean(g && S.running[g.id]); // running: id do jogo -> início (epoch)

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
  Object.assign(S, {
    games: st.games, emulators: st.emulators, settings: st.settings, sessions: st.sessions || [],
    running: st.running || {}, dataDir: st.dataDir, version: st.version || '',
  });
  if (S.selected && !gameById(S.selected)) S.selected = null;
  if (renderAll) render();
  else renderSidebar();
  const openConsole = $('#consoleModal');
  if (openConsole) consoleModal(openConsole.dataset.id);
  schedulePoll();
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (!Object.keys(S.running).length) return;
  // Enquanto um jogo roda, atualiza o estado para registrar o tempo de jogo ao fechar.
  pollTimer = setTimeout(() => {
    const quiet = !['library', 'home'].includes(S.view) || $('#modalRoot').childElementCount > 0;
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
  if (f.type === 'status') list = list.filter((g) => (g.status || '') === f.value);
  if (f.type === 'finishedYear') list = list.filter((g) => isFinished(g) && String(statusYear(g)) === f.value);
  if (f.type === 'genre') list = list.filter((g) => gameGenres(g).includes(f.value));
  if (f.type === 'smart') {
    const c = smartById(f.value);
    list = c ? list.filter((g) => smartMatches(g, c)) : [];
  }
  if (q) {
    list = list.filter((g) => g.name.toLowerCase().includes(q) || g.platform.toLowerCase().includes(q)
      || g.tags.some((t) => t.toLowerCase().includes(q)) || gameGenres(g).some((t) => t.toLowerCase().includes(q))
      || (g.meta?.developer || '').toLowerCase().includes(q));
  }
  const byName = (a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true });
  const sorters = {
    name: byName,
    recent: (a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || byName(a, b),
    playtime: (a, b) => (b.playtime || 0) - (a.playtime || 0) || byName(a, b),
    added: (a, b) => (b.added || 0) - (a.added || 0) || byName(a, b),
    year: (a, b) => (gameYear(b) || 0) - (gameYear(a) || 0) || byName(a, b),
  };
  const sort = f.type === 'recent' ? 'recent' : S.sort;
  return list.sort(sorters[sort] || byName);
}
