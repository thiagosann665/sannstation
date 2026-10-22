'use strict';
// Telas de Aparência e Configurações.

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
        <button class="btn" data-action="official-covers">Usar capas oficiais nos jogos de emulador</button>
        <span class="muted" style="font-size:13px">${S.games.filter((g) => !g.cover).length} jogo(s) sem capa</span>
      </div>
    </div>
    <div class="section">
      <h3>Informações dos jogos</h3>
      <p>Ano de lançamento, gênero, desenvolvedora e descrição vêm da <b>Wikipedia</b> (em português quando existe).
        Com elas dá para filtrar por gênero, ordenar por ano e montar coleções inteligentes.</p>
      <div class="row">
        <button class="btn" data-action="meta-all">Buscar informações de ${missingMeta().length} jogo(s) sem informação</button>
      </div>
    </div>
    <div class="section">
      <h3>Organização</h3>
      <p>Mesmo jogo em regiões diferentes (USA, Europe…) ou em mais de uma loja (Steam e GOG).</p>
      <div class="row"><button class="btn" data-action="duplicates">Procurar jogos duplicados (${findDuplicates().length})</button></div>
    </div>
    <div class="section">
      <h3>Pastas de ROMs</h3>
      <div class="opts"><div class="opt"><div><div class="t">Procurar jogos novos ao abrir</div>
        <div class="d">ROMs colocadas nas pastas vigiadas dos emuladores entram sozinhas na biblioteca, com capa.</div></div>
        <label class="switch"><input type="checkbox" id="autoScanChk" ${S.settings.autoScan === false ? '' : 'checked'}><span></span></label></div></div>
      <div class="row" style="margin-top:12px"><button class="btn" data-action="discover">🎮 Encontrar jogos nos emuladores do PC</button></div>
    </div>
    <div class="section">
      <h3>Dados e backup</h3>
      <p>Biblioteca e capas ficam salvas localmente em:</p>
      <code style="word-break:break-all">${esc(S.dataDir)}</code>
      <p style="margin-top:14px">O backup junta num arquivo .zip a biblioteca, as capas e os <b>saves de todos os emuladores</b> configurados.</p>
      <div class="row">
        <button class="btn primary" data-action="backup">💾 Fazer backup…</button>
        <label class="check"><input type="checkbox" id="backupStates"> Incluir estados salvos (savestates — podem ser grandes)</label>
      </div>
    </div>
    <div class="section">
      <h3>Encerrar</h3>
      <p>A SannStation fecha sozinha quando você fecha a janela. Use este botão se ela continuar rodando em segundo plano.</p>
      <button class="btn danger" data-action="quit">Fechar SannStation</button>
    </div>
  </div>`;
}

async function makeBackup() {
  const folder = await pick('folder', 'Onde salvar o backup?');
  if (!folder) return;
  const box = toast('Fazendo backup…', false, 600000);
  const res = await act(() => api('/backup', { folder, states: $('#backupStates')?.checked || false }));
  box.remove();
  if (!res) return;
  const mb = (res.size / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  toast(`Backup salvo (${mb} MB, ${res.files} arquivos${res.saves.length ? `, saves de: ${res.saves.join(', ')}` : ''}): ${res.path}`, false, 12000);
}

let themeSaveTimer = null;
function setTheme(patch, rerender = true) {
  Theme.apply({ ...Theme.get(), ...patch });
  if (rerender && S.view === 'appearance') render();
  else updateChrome();
  clearTimeout(themeSaveTimer);
  themeSaveTimer = setTimeout(() => act(() => api('/settings', { theme: Theme.get() }, 'PUT')), 400);
}
