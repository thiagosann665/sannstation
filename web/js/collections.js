'use strict';
// Status do jogo, coleções inteligentes (regras que se atualizam sozinhas) e jogos duplicados.

// ------------------------------------------------------------------ status

const STATUSES = {
  playing: { label: 'Jogando', icon: '🎮' },
  beaten: { label: 'Zerado', icon: '🏁' },
  completed: { label: '100%', icon: '🏆' },
  abandoned: { label: 'Abandonado', icon: '💤' },
  wishlist: { label: 'Lista de desejos', icon: '🔖' },
};
const statusYear = (g) => (g.statusAt ? new Date(g.statusAt * 1000).getFullYear() : 0);
const isFinished = (g) => g.status === 'beaten' || g.status === 'completed';

async function setStatus(id, status) {
  const g = gameById(id);
  if (!g) return;
  const res = await act(() => api(`/games/${id}`, { status }, 'PUT'));
  if (res) {
    if (status && STATUSES[status]) toast(`${STATUSES[status].icon} ${g.name}: ${STATUSES[status].label}`);
    await refresh();
  }
}

// ------------------------------------------------------------------ informações (Wikipedia)

const gameYear = (g) => g.meta?.year || 0;
const gameGenres = (g) => g.meta?.genres || [];
const allGenres = () => [...new Set(S.games.flatMap(gameGenres))].sort((a, b) => a.localeCompare(b, 'pt-BR'));

async function fetchMeta(id, { quiet = false, title = '' } = {}) {
  const body = { quiet };
  if (title) body.title = title;
  if (quiet) {
    try { return await api(`/games/${id}/meta`, body); } catch { return null; }
  }
  const res = await act(() => api(`/games/${id}/meta`, body));
  if (res?.found) {
    toast('Informações atualizadas.');
    await refresh();
  }
  return res;
}

async function fetchMetaForAll(ids) {
  if (!ids.length) return toast('Todos os jogos já têm informações.');
  const box = toast('', false, 600000);
  let ok = 0;
  for (let i = 0; i < ids.length; i++) {
    box.innerHTML = `Buscando informações ${i + 1}/${ids.length}…<div class="progress"><div style="width:${(i / ids.length) * 100}%"></div></div>`;
    const r = await fetchMeta(ids[i], { quiet: true });
    if (r?.found) ok++;
    if (i % 10 === 9) await refresh(S.view === 'library' && !$('#modalRoot').childElementCount);
  }
  box.remove();
  await refresh(!$('#modalRoot').childElementCount);
  toast(`Informações encontradas para ${ok} de ${ids.length} jogo(s).`);
  return undefined;
}
const missingMeta = () => S.games.filter((g) => !g.meta?.fetched).map((g) => g.id);

// ------------------------------------------------------------------ coleções inteligentes

const DAY = 86400;
const now = () => Date.now() / 1000;
const SMART_FIELDS = {
  platform: { label: 'Plataforma', type: 'enum', options: () => platforms().filter((p) => S.games.some((g) => g.platform === p)).map((p) => [p, p]) },
  status: { label: 'Status', type: 'enum', options: () => [['', 'Sem status'], ...Object.entries(STATUSES).map(([k, v]) => [k, v.label])] },
  statusYear: { label: 'Ano do status (ex.: zerado em)', type: 'num' },
  favorite: { label: 'Favorito', type: 'bool' },
  playtime: { label: 'Tempo de jogo (horas)', type: 'num' },
  lastPlayed: { label: 'Jogado por último', type: 'days' },
  added: { label: 'Adicionado', type: 'days' },
  genre: { label: 'Gênero', type: 'list', options: () => allGenres().map((x) => [x, x]) },
  year: { label: 'Ano de lançamento', type: 'num' },
  tag: { label: 'Coleção', type: 'list', options: () => [...new Set(S.games.flatMap((g) => g.tags))].sort().map((x) => [x, x]) },
  kind: { label: 'Tipo', type: 'enum', options: () => [['exe', 'Executável'], ['rom', 'Emulador'], ['url', 'Lançador (Steam, Epic…)']] },
  name: { label: 'Nome', type: 'text' },
};
const SMART_OPS = {
  enum: [['is', 'é'], ['isnot', 'não é']],
  list: [['has', 'inclui'], ['hasnot', 'não inclui']],
  bool: [['is', 'é']],
  num: [['eq', 'igual a'], ['lt', 'menor que'], ['gt', 'maior que']],
  days: [['never', 'nunca'], ['within', 'nos últimos (dias)'], ['before', 'há mais de (dias)']],
  text: [['contains', 'contém'], ['notcontains', 'não contém']],
};
const SMART_TEMPLATES = [
  { name: 'SNES nunca jogados', match: 'all', rules: [{ field: 'platform', op: 'is', value: 'Super Nintendo (SNES)' }, { field: 'lastPlayed', op: 'never', value: '' }] },
  { name: 'Favoritos com menos de 1 h', match: 'all', rules: [{ field: 'favorite', op: 'is', value: 'true' }, { field: 'playtime', op: 'lt', value: '1' }] },
  { name: `Zerados em ${new Date().getFullYear()}`, match: 'any', rules: [{ field: 'statusYear', op: 'eq', value: String(new Date().getFullYear()) }] },
  { name: 'Parados há 6 meses', match: 'all', rules: [{ field: 'status', op: 'is', value: 'playing' }, { field: 'lastPlayed', op: 'before', value: '180' }] },
];

function fieldValue(g, field) {
  switch (field) {
    case 'platform': return g.platform;
    case 'status': return g.status || '';
    case 'statusYear': return isFinished(g) ? statusYear(g) : 0;
    case 'favorite': return Boolean(g.favorite);
    case 'playtime': return (g.playtime || 0) / 3600;
    case 'lastPlayed': return g.lastPlayed || 0;
    case 'added': return g.added || 0;
    case 'genre': return gameGenres(g);
    case 'year': return gameYear(g);
    case 'tag': return g.tags;
    case 'kind': return g.kind;
    case 'name': return g.name;
    default: return '';
  }
}
function ruleMatches(g, r) {
  const v = fieldValue(g, r.field);
  const n = parseFloat(String(r.value).replace(',', '.'));
  switch (r.op) {
    case 'is': return SMART_FIELDS[r.field]?.type === 'bool' ? v === (r.value === 'true') : String(v) === r.value;
    case 'isnot': return String(v) !== r.value;
    case 'has': return v.some((x) => x.toLowerCase() === String(r.value).toLowerCase());
    case 'hasnot': return !v.some((x) => x.toLowerCase() === String(r.value).toLowerCase());
    case 'eq': return Number.isFinite(n) && Math.abs(v - n) < 1e-9;
    case 'lt': return Number.isFinite(n) && v < n;
    case 'gt': return Number.isFinite(n) && v > n;
    case 'never': return !v;
    case 'within': return Boolean(v) && Number.isFinite(n) && now() - v <= n * DAY;
    case 'before': return Boolean(v) && Number.isFinite(n) && now() - v > n * DAY;
    case 'contains': return String(v).toLowerCase().includes(String(r.value).toLowerCase());
    case 'notcontains': return !String(v).toLowerCase().includes(String(r.value).toLowerCase());
    default: return false;
  }
}
function smartMatches(g, c) {
  if (!c.rules.length) return true;
  return c.match === 'any' ? c.rules.some((r) => ruleMatches(g, r)) : c.rules.every((r) => ruleMatches(g, r));
}
const smartCollections = () => S.settings.smartCollections || [];
const smartById = (id) => smartCollections().find((c) => c.id === id);

async function saveSmartCollections(list, msg) {
  const ok = await act(() => api('/settings', { smartCollections: list }, 'PUT'), msg);
  if (ok) await refresh();
  return ok;
}

function smartModal(existing, template) {
  const draft = JSON.parse(JSON.stringify(existing || template || { name: '', match: 'all', rules: [{ field: 'platform', op: 'is', value: '' }] }));
  const m = openModal(`
    <h2>${existing ? 'Editar coleção inteligente' : 'Nova coleção inteligente'}</h2>
    <p class="hint" style="margin-top:-6px">Os jogos entram e saem sozinhos conforme as regras: jogou, mudou o status ou adicionou um jogo, a coleção se atualiza.</p>
    ${existing ? '' : `<div class="chips smart-templates">${SMART_TEMPLATES.map((t, i) => `<button class="chip" data-tpl="${i}">⚡ ${esc(t.name)}</button>`).join('')}</div>`}
    <form class="form" id="smartForm">
      <div class="two">
        <label>Nome <input name="name" required maxlength="60" placeholder="ex.: RPGs para terminar"></label>
        <label>Combinar <select name="match"><option value="all">Todas as regras</option><option value="any">Qualquer regra</option></select></label>
      </div>
      <div id="smartRules" class="smart-rules"></div>
      <div class="row"><button type="button" class="btn small" id="smartAdd">+ Regra</button><span class="muted" id="smartCount"></span></div>
      <div class="actions">
        ${existing ? '<button type="button" class="btn danger" id="smartDel">Excluir coleção</button>' : ''}
        <div class="spacer"></div>
        <button type="button" class="btn ghost" data-close>Cancelar</button>
        <button class="btn primary" type="submit">${existing ? 'Salvar' : 'Criar coleção'}</button>
      </div>
    </form>`, true);
  const form = $('#smartForm', m);
  const box = $('#smartRules', m);
  const ruleHtml = (r, i) => {
    const f = SMART_FIELDS[r.field] || SMART_FIELDS.platform;
    const ops = SMART_OPS[f.type];
    let input;
    if (f.type === 'bool') input = `<select data-k="value"><option value="true">sim</option><option value="false">não</option></select>`;
    else if (f.type === 'days' && r.op === 'never') input = '<span></span>';
    else if (f.options) input = `<select data-k="value">${f.options().map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`;
    else input = `<input data-k="value" ${f.type === 'text' ? '' : 'inputmode="decimal"'} placeholder="${f.type === 'days' ? 'dias' : 'valor'}">`;
    return `<div class="smart-rule" data-i="${i}">
      <select data-k="field">${Object.entries(SMART_FIELDS).map(([k, x]) => `<option value="${k}">${x.label}</option>`).join('')}</select>
      <select data-k="op">${ops.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
      ${input}
      <button type="button" class="btn small ghost" data-del title="Remover regra">✕</button>
    </div>`;
  };
  const draw = () => {
    box.innerHTML = draft.rules.map(ruleHtml).join('') || '<p class="muted">Sem regras: todos os jogos entram.</p>';
    $$('.smart-rule', box).forEach((row) => {
      const r = draft.rules[+row.dataset.i];
      const f = SMART_FIELDS[r.field];
      if (!SMART_OPS[f.type].some(([k]) => k === r.op)) r.op = SMART_OPS[f.type][0][0];
      $('[data-k=field]', row).value = r.field;
      $('[data-k=op]', row).value = r.op;
      const val = $('[data-k=value]', row);
      if (val) {
        if (val.tagName === 'SELECT' && ![...val.options].some((o) => o.value === r.value)) r.value = val.options[0]?.value ?? '';
        val.value = r.value;
      }
      row.addEventListener('change', (e) => {
        const k = e.target.dataset.k;
        if (!k) return;
        r[k] = e.target.value;
        if (k === 'field') { r.op = ''; r.value = ''; }
        if (k !== 'value') draw();
        count();
      });
      row.addEventListener('input', (e) => { if (e.target.dataset.k === 'value') { r.value = e.target.value; count(); } });
      $('[data-del]', row).addEventListener('click', () => { draft.rules.splice(+row.dataset.i, 1); draw(); });
    });
    count();
  };
  const count = () => {
    draft.match = form.elements.match.value;
    const n = S.games.filter((g) => !g.hidden && smartMatches(g, draft)).length;
    $('#smartCount', m).textContent = `${n} jogo(s) nesta coleção agora`;
  };
  form.elements.name.value = draft.name;
  form.elements.match.value = draft.match;
  form.elements.match.addEventListener('change', count);
  $('#smartAdd', m).addEventListener('click', () => { draft.rules.push({ field: 'status', op: 'is', value: '' }); draw(); });
  $$('[data-tpl]', m).forEach((b) => b.addEventListener('click', () => {
    Object.assign(draft, JSON.parse(JSON.stringify(SMART_TEMPLATES[+b.dataset.tpl])));
    form.elements.name.value = draft.name;
    form.elements.match.value = draft.match;
    draw();
  }));
  $('#smartDel', m)?.addEventListener('click', async () => {
    if (!confirm(`Excluir a coleção “${existing.name}”? Os jogos continuam na biblioteca.`)) return;
    if (await saveSmartCollections(smartCollections().filter((c) => c.id !== existing.id), 'Coleção excluída.')) {
      closeModal();
      S.filter = { type: 'all', value: null };
      render();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const item = { id: existing?.id || Math.random().toString(36).slice(2, 12), name: form.elements.name.value.trim(), match: form.elements.match.value, rules: draft.rules };
    const list = existing ? smartCollections().map((c) => (c.id === existing.id ? item : c)) : [...smartCollections(), item];
    if (await saveSmartCollections(list, existing ? 'Coleção atualizada.' : `Coleção “${item.name}” criada.`)) {
      closeModal();
      S.filter = { type: 'smart', value: item.id };
      S.selected = null;
      S.view = 'library';
      render();
    }
  });
  draw();
}

// ------------------------------------------------------------------ duplicados

function normTitle(name) {
  return String(name).toLowerCase().replace(/[([{].*?[)\]}]/g, ' ').replace(/[™®©]/g, '').replace(/&/g, 'and')
    .replace(/^the |, the\b/g, ' ').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}
const dupKey = (g) => `${normTitle(g.name)}|${g.kind === 'rom' ? (g.consoleId || emuById(g.emulatorId)?.consoleId || g.platform) : 'pc'}`;

function findDuplicates() {
  const ignored = new Set(S.settings.dupIgnore || []);
  const groups = new Map();
  S.games.forEach((g) => {
    const key = dupKey(g);
    if (!normTitle(g.name) || ignored.has(key)) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  });
  return [...groups.entries()].filter(([, list]) => list.length > 1).map(([key, games]) => ({ key, games }));
}

function duplicatesModal() {
  const groups = findDuplicates();
  if (!groups.length) return toast('Nenhum jogo duplicado na biblioteca. 👍');
  const row = (g) => `<div class="dup-game">
      ${g.cover ? `<img src="${coverUrl(g)}" alt="">` : '<span class="mini"></span>'}
      <div class="info"><div class="name">${esc(g.name)} ${g.hidden ? '<span class="muted">(oculto)</span>' : ''}</div>
        <div class="meta">${esc(g.platform)} · ${esc(SOURCES[g.source] || g.source)} · ${fmtPlaytime(g.playtime)}</div>
        <div class="meta"><code>${esc(g.path)}</code></div></div>
      <div class="actions">
        ${g.hidden ? '' : `<button class="btn small" data-dup="hide" data-id="${g.id}">Ocultar</button>`}
        <button class="btn small danger" data-dup="remove" data-id="${g.id}">Remover</button>
      </div></div>`;
  const m = openModal(`<h2>Jogos duplicados</h2>
    <p class="hint" style="margin-top:-6px">Mesmo jogo em versões de regiões diferentes, ou em mais de uma loja. Oculte ou remova o que sobra
      — remover não apaga nenhum arquivo do jogo.</p>
    <div class="dup-list">${groups.map((gr) => `<div class="dup-group" data-key="${esc(gr.key)}">
      <div class="dup-head"><b>${esc(gr.games[0].name)}</b> <span class="muted">· ${gr.games.length} cópias</span>
        <button class="btn small ghost" data-dup="ignore" data-key="${esc(gr.key)}">Não são duplicados</button></div>
      ${gr.games.map(row).join('')}</div>`).join('')}</div>
    <div class="actions"><button class="btn ghost" data-close>Fechar</button></div>`, true);
  m.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-dup]');
    if (!b) return;
    if (b.dataset.dup === 'ignore') {
      const list = [...(S.settings.dupIgnore || []), b.dataset.key];
      if (await act(() => api('/settings', { dupIgnore: list }, 'PUT'))) { await refresh(false); duplicatesModal(); }
    } else if (b.dataset.dup === 'hide') {
      if (await act(() => api(`/games/${b.dataset.id}`, { hidden: true }, 'PUT'))) { await refresh(false); duplicatesModal(); }
    } else if (b.dataset.dup === 'remove') {
      if (await act(() => api(`/games/${b.dataset.id}`, undefined, 'DELETE'), 'Removido da biblioteca.')) {
        await refresh(false);
        if (findDuplicates().length) duplicatesModal(); else { closeModal(); toast('Pronto: nenhum duplicado restante.'); }
      }
    }
  });
  return undefined;
}
