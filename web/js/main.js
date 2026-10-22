'use strict';
// Ações, eventos da interface e inicialização. Carregado por último.

async function launchGame(id, force = false) {
  const g = gameById(id);
  if (!g || isRunning(g)) return;
  const res = await act(() => api(`/games/${id}/launch`, force ? { force: true } : {}));
  if (!res) return;
  if (res.needsBios) { biosModal(g, res.needsBios); return; }
  toast(`Iniciando ${g.name}…`);
  await refresh();
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


function goto(view) {
  S.view = view;
  if (view !== 'library') S.selected = null;
  render();
}

// ------------------------------------------------------------------ eventos

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action], [data-ftype], #gameList li, .card, .cont-card, .memo, .tabs button');
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
  if (!a && t.matches('#gameList li, .card, .cont-card, .memo')) {
    S.backView = S.view === 'home' ? 'home' : 'library'; // "‹ Voltar" leva de volta para onde estava
    S.selected = t.dataset.id;
    S.view = 'library';
    return render();
  }
  e.stopPropagation();
  switch (a) {
    case 'play': return launchGame(id);
    case 'back': S.selected = null; S.view = S.backView || 'library'; S.backView = null; return render();
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
    case 'official-covers': return officialCovers();
    case 'discover': return discoverGames();
    case 'smart-new': return smartModal();
    case 'roulette': return spinRoulette();
    case 'open-game': S.selected = id; S.view = 'library'; return render();
    case 'wrapped': return openWrapped(+t.dataset.year);
    case 'stats-year': S.statsYear = +t.dataset.value; return render();
    case 'stats-mode': S.statsMode = t.dataset.value; return render();
    case 'smart-edit': return smartModal(smartById(id));
    case 'genre': S.filter = { type: 'genre', value: t.dataset.genre }; S.selected = null; return render();
    case 'meta': return fetchMeta(id);
    case 'meta-all': return fetchMetaForAll(missingMeta());
    case 'duplicates': return duplicatesModal();
    case 'open-dir': return act(() => api('/open-dir', { path: t.dataset.path, create: true }));
    case 'unwatch': return unwatch(id, t.dataset.path);
    case 'saves': return openSaves(gameById(id));
    case 'fetch-missing': return fetchArtFor(S.games.filter((g) => !g.cover).map((g) => g.id));
    case 'backup': return makeBackup();
    case 'save-key': {
      const key = $('#sgdbKey').value;
      return act(() => api('/settings', { steamgriddbKey: key }, 'PUT'), key ? 'Chave da SteamGridDB salva.' : 'Chave removida.').then(() => refresh(false));
    }
    default: return undefined;
  }
});

// Cronômetro da sessão: pílula no topo enquanto um jogo roda (e no título da janela).
function fmtClock(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}
function updateSessionPill() {
  const box = $('#sessionPill');
  const runs = Object.entries(S.running).map(([id, start]) => [gameById(id), start]).filter(([g]) => g);
  if (!runs.length) {
    if (box.childElementCount) box.innerHTML = '';
    if (document.title !== 'SannStation') document.title = 'SannStation';
    return;
  }
  const [g, start] = runs[0];
  const sec = Math.max(0, Date.now() / 1000 - start);
  box.innerHTML = `<button class="session-pill" data-action="open-game" data-id="${g.id}" title="Sessão atual">
    <span class="dot"></span><span class="pill-name">${esc(g.name)}</span><b>${fmtClock(sec)}</b>${runs.length > 1 ? `<span class="muted">+${runs.length - 1}</span>` : ''}</button>`;
  // O título precisa começar com "SannStation " (é assim que o app reconhece a própria janela).
  document.title = `SannStation · ▶ ${g.name} · ${Math.floor(sec / 60)} min`;
}
setInterval(updateSessionPill, 1000);

document.addEventListener('submit', (e) => {
  if (e.target.id === 'rouletteForm') { e.preventDefault(); spinRoulette(); }
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
  if (e.target.id === 'groupSel') { S.group = e.target.value; savePrefs(); render(); }
  if (e.target.dataset.statusId) setStatus(e.target.dataset.statusId, e.target.value);
  if (e.target.id === 'overlayChk') {
    act(() => api('/settings', { sessionOverlay: e.target.checked }, 'PUT')).then(() => refresh(false));
  }
  if (e.target.id === 'autoScanChk') {
    act(() => api('/settings', { autoScan: e.target.checked }, 'PUT'), e.target.checked ? 'Pastas vigiadas ativadas.' : 'Pastas vigiadas desativadas.').then(() => refresh(false));
  }
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
refresh().then(async () => {
  await rescanWatched(); // ROMs novas nas pastas vigiadas entram sozinhas
  if (!S.games.length) discoverGames({ auto: true }); // primeira vez: procura emuladores e jogos no PC
}).catch((e) => {
  $('#main').innerHTML = `<div class="empty"><h2>Não foi possível conectar</h2><p>${esc(e.message)}</p><p>Verifique se a janela da SannStation (python app.py) continua aberta.</p></div>`;
});
