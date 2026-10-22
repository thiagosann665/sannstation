'use strict';
// Capas: seletor rápido no card, colar/arrastar imagem, download automático e capas oficiais.

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
  if (coverShape(g)) pop.classList.add(coverShape(g));
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
    if (!gameById(ids[i])?.meta?.fetched) await fetchMeta(ids[i], { quiet: true }); // ano, gênero e descrição
    if (i % 5 === 4) await refresh(S.view === 'library' && !$('#modalRoot').childElementCount);
  }
  box?.remove();
  await refresh(!$('#modalRoot').childElementCount);
  if (!quiet || ok) toast(`Imagens encontradas para ${ok} de ${ids.length} jogo(s).${ok < ids.length ? ' Use “Capa e banner” para escolher manualmente os restantes.' : ''}`);
}

// Troca as capas dos jogos de emulador pelas oficiais do libretro (caixa do console certo, nome da ROM).
async function officialCovers() {
  const ids = S.games.filter((g) => g.kind === 'rom').map((g) => g.id);
  if (!ids.length) return toast('Não há jogos de emulador na biblioteca.');
  if (!confirm(`Trocar as capas de ${ids.length} jogo(s) de emulador pelas capas oficiais do libretro?\n\n`
    + 'Jogos sem capa oficial correspondente mantêm a capa atual.')) return undefined;
  const box = toast('', false, 600000);
  let ok = 0;
  for (let i = 0; i < ids.length; i++) {
    box.innerHTML = `Trocando capas ${i + 1}/${ids.length}…<div class="progress"><div style="width:${(i / ids.length) * 100}%"></div></div>`;
    try {
      if ((await api(`/games/${ids[i]}/art/official`, {})).replaced) ok++;
    } catch { /* segue para o próximo */ }
    if (i % 10 === 9) await refresh(S.view === 'library' && !$('#modalRoot').childElementCount);
  }
  box.remove();
  await refresh();
  toast(`${ok} de ${ids.length} capa(s) trocada(s) pela oficial.${ok < ids.length ? ' As demais não tinham capa oficial correspondente e ficaram como estavam.' : ''}`, false, 8000);
  return undefined;
}
