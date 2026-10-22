'use strict';
// Janelas (modais): adicionar/editar jogo, capa e banner, emulador personalizado, escanear ROMs.

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
      <label><span id="argsLabel">Argumentos de inicialização</span> <input name="args" placeholder="opcional, ex.: -windowed -skipintro"></label>
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
    // ROM: argumentos próprios substituem os do emulador (ex.: outro core do RetroArch só para este jogo).
    const emu = emuById(el.emulatorId.value);
    $('#argsLabel', form).textContent = kind === 'rom' ? 'Argumentos só para este jogo (opcional)' : 'Argumentos de inicialização';
    el.args.placeholder = kind === 'rom' ? `padrão do emulador: ${emu?.args || '"{rom}"'}` : 'opcional, ex.: -windowed -skipintro';
    el.args.closest('label').style.display = kind === 'url' ? 'none' : '';
    $('[data-pick="path"]', form).style.display = kind === 'url' ? 'none' : '';
  };
  el.kind.addEventListener('change', () => {
    if (el.kind.value === 'rom' && (!el.platform.value || el.platform.value === 'PC')) el.platform.value = emuById(el.emulatorId.value)?.platform || '';
    if (el.kind.value !== 'rom' && !el.platform.value) el.platform.value = 'PC';
    sync();
  });
  el.emulatorId.addEventListener('change', () => { el.platform.value = emuById(el.emulatorId.value)?.platform || el.platform.value; sync(); });
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
    box.className = 'art-results' + (kind === 'hero' ? ' hero-mode' : shapeClass(g));
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
      <p class="hint">Todos os arquivos com as extensões <code>${esc(emu.extensions.join(' '))}</code> serão adicionados como jogos de <b>${esc(emu.platform || emu.name)}</b>. Arquivos já na biblioteca são ignorados.
        A pasta fica <b>vigiada</b>: ROMs novas colocadas nela entram sozinhas quando você abrir a SannStation.</p>
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
    const res = await act(() => api(`/emulators/${emu.id}/scan`, {
      folder: form.elements.folder.value, recursive: form.elements.recursive.checked, accepts: emuAccepts(emu),
    }));
    if (!res) return;
    closeModal();
    toast(`${res.found} arquivo(s) encontrado(s), ${res.added.length} novo(s) na biblioteca.`);
    await refresh();
    if (form.elements.art.checked && res.added.length) fetchArtFor(res.added);
  });
}
