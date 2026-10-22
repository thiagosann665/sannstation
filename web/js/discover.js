'use strict';
// Emulação "zero cliques": acha as pastas de jogos configuradas nos emuladores do PC, importa tudo,
// mantém as pastas vigiadas (ROMs novas entram sozinhas), avisa de BIOS faltando e abre a pasta de saves.

// ------------------------------------------------------------------ catálogo x emuladores configurados

// Entrada do catálogo (consoles.js) que corresponde a um emulador configurado.
function catalogEmuOf(emu) {
  const c = consoleById(emu.consoleId);
  return c?.emus.find((e) => e.name === emu.name)
    || CONSOLES.flatMap((x) => x.emus).find((e) => e.name === emu.name && e.args === emu.args) || null;
}

// Consoles que um emulador roda (Mesen roda NES, SNES, Game Boy…; um core do RetroArch, só os dele).
// Usado no escaneamento: numa pasta misturada, cada arquivo vai para o emulador certo.
function emuAccepts(emu) {
  const entry = catalogEmuOf(emu);
  if (!entry) return emu.consoleId ? [emu.consoleId] : null;
  return CONSOLES.filter((c) => c.emus.some((e) => e.key === entry.key)).map((c) => c.id);
}
function acceptsMap() {
  return Object.fromEntries(S.emulators.map((e) => [e.id, emuAccepts(e)]).filter(([, a]) => a));
}

// ------------------------------------------------------------------ pastas vigiadas

async function rescanWatched() {
  if (S.settings.autoScan === false || !S.emulators.some((e) => e.romDirs?.length)) return;
  try {
    const res = await api('/library/rescan', { accepts: acceptsMap() });
    if (!res.added.length) return;
    toast(`${res.added.length} jogo(s) novo(s) encontrado(s) nas suas pastas de ROMs.`, false, 6000);
    await refresh();
    fetchArtFor(res.added, true);
  } catch { /* sem problema: tenta de novo na próxima abertura */ }
}

// ------------------------------------------------------------------ descoberta

const DISMISSED_KEY = 'sannstation-discover-dismissed';
function dismissedProposals() {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]')); } catch { return new Set(); }
}
function rememberDismissed(keys) {
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...new Set([...dismissedProposals(), ...keys])])); } catch { /* sem storage */ }
}
const normPath = (p) => String(p || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
const isInside = (file, dir) => normPath(file).startsWith(normPath(dir) + '\\');

// Monta a lista de executáveis a verificar: emuladores encontrados no PC + os já configurados.
function discoverCandidates() {
  const byPath = new Map();
  const add = (path, consoleId, exts) => {
    if (!path || !consoleId) return;
    const key = normPath(path);
    if (!byPath.has(key)) byPath.set(key, { path, consoles: {} });
    byPath.get(key).consoles[consoleId] = exts;
  };
  CONSOLES.forEach((c) => c.emus.forEach((e) => detectedPaths(e).forEach((p) => add(p, c.id, c.ext))));
  S.emulators.forEach((e) => add(e.path, e.consoleId, e.extensions));
  return [...byPath.values()];
}

// Qual emulador usar para um console encontrado: o já configurado, senão o do catálogo que achou a pasta.
function chooseEmulator(consoleId, exePath) {
  const c = consoleById(consoleId);
  const configured = configuredFor(c).find((e) => normPath(e.path) === normPath(exePath)) || configuredFor(c)[0];
  if (configured) return { existing: configured };
  const entry = c.emus.find((e) => detectedPaths(e).some((p) => normPath(p) === normPath(exePath)));
  return entry ? { entry, path: exePath } : null;
}

function buildProposals(results) {
  const proposals = new Map(); // console -> proposta
  results.forEach((r) => r.folders.forEach((f) => Object.entries(f.counts).forEach(([cid, n]) => {
    const c = consoleById(cid);
    const emu = c && chooseEmulator(cid, r.path);
    if (!emu) return;
    const known = S.games.filter((g) => isInside(g.path, f.dir) && (g.consoleId === cid || emuById(g.emulatorId)?.consoleId === cid)).length;
    const fresh = Math.max(0, n - known);
    const watched = emu.existing?.romDirs?.some((d) => normPath(d.path) === normPath(f.dir));
    if (!fresh && watched) return;
    if (!proposals.has(cid)) proposals.set(cid, { console: c, emu, folders: [], fresh: 0 });
    const p = proposals.get(cid);
    if (!p.folders.some((x) => normPath(x.dir) === normPath(f.dir))) {
      p.folders.push({ dir: f.dir, recursive: f.recursive, count: n, fresh });
      p.fresh += fresh;
    }
  })));
  return [...proposals.values()].filter((p) => p.fresh > 0)
    .map((p) => ({ ...p, key: `${p.console.id}|${p.folders.map((f) => normPath(f.dir)).sort().join('|')}` }))
    .sort((a, b) => b.fresh - a.fresh);
}

async function discoverGames({ auto = false } = {}) {
  if (S.discovering) return S.discovering;
  S.discovering = (async () => {
    if (!S.detected) await detectEmulators();
    const candidates = discoverCandidates();
    if (!candidates.length) {
      if (!auto) toast('Nenhum emulador encontrado no PC. Configure um console na aba Emuladores.', true, 6000);
      return;
    }
    const busy = auto ? null : toast('Lendo as pastas de jogos dos emuladores…', false, 120000);
    let res;
    try {
      res = await api('/emulators/discover', { emulators: candidates });
    } catch (e) {
      toast(e.message, true);
      return;
    } finally {
      busy?.remove();
    }
    let proposals = buildProposals(res.results);
    if (auto) {
      const dismissed = dismissedProposals();
      proposals = proposals.filter((p) => !dismissed.has(p.key));
    }
    if (proposals.length) discoverModal(proposals);
    else if (!auto) toast('Os emuladores não têm pastas com jogos novos. Use “Escanear ROMs” para escolher uma pasta.', false, 7000);
  })().finally(() => { S.discovering = null; });
  return S.discovering;
}

function discoverModal(proposals) {
  const total = proposals.reduce((n, p) => n + p.fresh, 0);
  const m = openModal(`
    <h2>Encontrei jogos nos seus emuladores</h2>
    <p class="hint" style="margin-top:-6px">Pastas de jogos configuradas nos emuladores do seu PC. Elas ficam vigiadas:
      ROMs novas que você colocar lá entram sozinhas na biblioteca, com capa.</p>
    <div class="disc-list">${proposals.map((p, i) => {
      const emuName = p.emu.existing ? p.emu.existing.name : p.emu.entry.name;
      return `<label class="disc-row">
        <input type="checkbox" data-i="${i}" checked>
        ${logoHtml(p.console)}
        <span class="disc-info">
          <span class="disc-title">${esc(p.console.name)} <span class="muted">· ${esc(emuName)}${p.emu.existing ? '' : ' (será configurado)'}</span></span>
          ${p.folders.map((f) => `<span class="disc-dir"><code>${esc(f.dir)}</code> — ${f.fresh} novo(s)</span>`).join('')}
        </span>
        <span class="disc-n">${p.fresh}</span>
      </label>`;
    }).join('')}</div>
    <div class="actions">
      <button class="btn ghost" data-close>Agora não</button>
      <button class="btn primary" id="discGo">Importar ${total} jogo(s)</button>
    </div>`, true);
  measureLogos(m);
  const checks = $$('input[type=checkbox]', m);
  const sync = () => {
    const n = checks.filter((c) => c.checked).reduce((s, c) => s + proposals[+c.dataset.i].fresh, 0);
    $('#discGo', m).textContent = `Importar ${n} jogo(s)`;
    $('#discGo', m).disabled = !n;
  };
  checks.forEach((c) => c.addEventListener('change', sync));
  $$('[data-close]', m).forEach((b) => b.addEventListener('click', () => rememberDismissed(proposals.map((p) => p.key)), { once: true }));
  $('#discGo', m).addEventListener('click', async () => {
    const chosen = checks.filter((c) => c.checked).map((c) => proposals[+c.dataset.i]);
    rememberDismissed(proposals.filter((p) => !chosen.includes(p)).map((p) => p.key));
    closeModal();
    await importProposals(chosen);
  });
}

async function importProposals(chosen) {
  const box = toast('', false, 600000);
  const added = [];
  for (let i = 0; i < chosen.length; i++) {
    const p = chosen[i];
    box.innerHTML = `Importando ${esc(p.console.name)} (${i + 1}/${chosen.length})…<div class="progress"><div style="width:${(i / chosen.length) * 100}%"></div></div>`;
    try {
      let emu = p.emu.existing;
      if (!emu) {
        const c = p.console;
        emu = await api('/emulators', {
          name: p.emu.entry.name, path: p.emu.path, args: p.emu.entry.args, extensions: c.ext, platform: c.name, consoleId: c.id,
        });
        S.emulators.push(emu);
      }
      for (const f of p.folders) {
        const res = await api(`/emulators/${emu.id}/scan`, { folder: f.dir, recursive: f.recursive, accepts: emuAccepts(emu) });
        added.push(...res.added);
      }
    } catch (e) {
      toast(`${p.console.name}: ${e.message}`, true, 7000);
    }
  }
  box.remove();
  await refresh();
  toast(`${added.length} jogo(s) importado(s). Baixando as capas…`, false, 6000);
  if (added.length) fetchArtFor(added);
}

// ------------------------------------------------------------------ BIOS, saves e pastas vigiadas no card do emulador

const emuInfoCache = new Map();
async function emuInfo(id, fresh = false) {
  if (fresh || !emuInfoCache.has(id)) emuInfoCache.set(id, api(`/emulators/${id}/info`).catch(() => null));
  return emuInfoCache.get(id);
}

function biosLine(bios) {
  if (!bios) return '';
  const label = esc(bios.label || 'BIOS');
  return bios.ok ? `<div class="meta bios ok">✓ ${label} encontrada</div>`
    : `<div class="meta bios missing">⚠ ${label} não encontrada — coloque <b>${esc(bios.files.join(' ou '))}</b> em
      <code>${esc(bios.dir)}</code> <button class="btn small ghost" data-action="open-dir" data-path="${esc(bios.dir)}">Abrir pasta</button></div>`;
}

// Completa os cards de emulador (.emu[data-emu-id]) com BIOS, saves e pastas vigiadas.
function fillEmuCards(root = document) {
  $$('.emu[data-emu-id]', root).forEach(async (card) => {
    const emu = emuById(card.dataset.emuId);
    const slot = $('.emu-extra', card);
    if (!emu || !slot) return;
    const dirs = (emu.romDirs || []).map((d) => `<span class="watch">📁 <code>${esc(d.path)}</code>
      <button class="x" data-action="unwatch" data-id="${emu.id}" data-path="${esc(d.path)}" title="Parar de vigiar esta pasta">✕</button></span>`).join('');
    slot.innerHTML = dirs ? `<div class="meta">Pastas vigiadas: ${dirs}</div>` : '';
    const info = await emuInfo(emu.id);
    if (!info || !slot.isConnected) return;
    const saves = info.saves.map((d) => `<button class="btn small ghost" data-action="open-dir" data-path="${esc(d.dir)}">💾 ${esc(d.label)}</button>`).join('');
    slot.insertAdjacentHTML('beforeend', biosLine(info.bios) + (saves ? `<div class="row saves">${saves}</div>` : ''));
  });
}

async function unwatch(id, path) {
  const emu = emuById(id);
  if (!emu) return;
  const romDirs = (emu.romDirs || []).filter((d) => normPath(d.path) !== normPath(path));
  if (await act(() => api(`/emulators/${id}`, { romDirs }, 'PUT'), 'A pasta não será mais vigiada (os jogos continuam na biblioteca).')) await refresh();
}

// Saves do jogo: abre a pasta direto, ou mostra as opções quando há mais de uma.
async function openSaves(g) {
  const emu = emuById(g.emulatorId);
  if (!emu) return toast('Este jogo não tem emulador.', true);
  const info = await emuInfo(emu.id, true);
  const dirs = info?.saves || [];
  if (!dirs.length) return toast(`Não encontrei a pasta de saves do ${emu.name}. Ela aparece depois que o emulador salva algo pela primeira vez.`, true, 7000);
  if (dirs.length === 1) return act(() => api('/open-dir', { path: dirs[0].dir }));
  openModal(`<h2>Saves — ${esc(emu.name)}</h2>
    <div class="emu-list">${dirs.map((d) => `<div class="emu"><div class="info"><div class="name">${esc(d.label)}</div>
      <div class="meta"><code>${esc(d.dir)}</code></div></div>
      <div class="actions"><button class="btn small primary" data-action="open-dir" data-path="${esc(d.dir)}">Abrir</button></div></div>`).join('')}</div>
    <p class="hint">Dica: em Configurações → Backup, os saves de todos os emuladores vão junto com a biblioteca.</p>
    <div class="actions"><button class="btn ghost" data-close>Fechar</button></div>`);
  return undefined;
}

// Antes de abrir um jogo cujo emulador precisa de BIOS: avisa em vez de deixar o jogo falhar sem explicação.
function biosModal(g, bios) {
  const emu = emuById(g.emulatorId);
  const m = openModal(`<h2>⚠ ${esc(bios.label || 'BIOS')} não encontrada</h2>
    <p>O <b>${esc(emu?.name || 'emulador')}</b> precisa de <b>${esc(bios.files.join(' ou '))}</b> para rodar
      jogos de ${esc(g.platform)}. Sem isso, o jogo provavelmente não abre (ou abre só uma tela preta).</p>
    <p>Coloque o arquivo nesta pasta:</p>
    <p><code style="word-break:break-all">${esc(bios.dir)}</code></p>
    <p class="hint">A BIOS é copiada do seu próprio console; a SannStation não baixa esse arquivo.</p>
    <div class="actions">
      <button class="btn" data-action="open-dir" data-path="${esc(bios.dir)}">📁 Abrir pasta</button>
      <div class="spacer"></div>
      <button class="btn ghost" data-close>Cancelar</button>
      <button class="btn primary" id="biosForce">Jogar mesmo assim</button>
    </div>`);
  $('#biosForce', m).addEventListener('click', () => { closeModal(); launchGame(g.id, true); });
}
