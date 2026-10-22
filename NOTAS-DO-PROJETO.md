# Notas do projeto (para continuar o desenvolvimento)

Resumo do que foi construído e das decisões tomadas até a versão 1.1.0, para retomar em outra máquina
ou em outra sessão do Claude. Uso geral e instalação estão no [README](README.md).

## Arquitetura

- **`app.py`**: servidor HTTP local (só biblioteca padrão do Python) em `127.0.0.1:8765` + API JSON.
  Lança jogos/emuladores, mede tempo de jogo, baixa capas, importa Steam/Epic/GOG, detecta emuladores instalados.
- **`sann/`**: módulos do servidor, sem acesso ao banco (recebem dados e devolvem resultados; testáveis):
  - `version.py` (a versão, num lugar só), `procwatch.py` (tempo de jogo com Job Objects), `discs.py` (console pelo
    cabeçalho do disco e `.m3u`), `emucfg.py` (pastas de jogos, BIOS e saves de cada emulador), `meta.py` (Wikipedia),
    `updates.py` (Releases do GitHub) e `overlay.py` (cronômetro sobre o jogo, processo separado).
- **`web/`**: interface (HTML/CSS/JS puro, sem framework, sem bundler).
  - `js/*.js`: scripts clássicos que compartilham o escopo global, carregados em ordem pelo `index.html`
    (`core` → `library` → `emulators` → `settings` → `modals` → `covers` → `discover` → `collections` → `home` →
    `stats` → `updates` → `main`, que tem os eventos e a inicialização).
  - `theme.js`: temas/modo claro-escuro, aplicado no `<head>` (sem "piscar").
  - `consoles.js`: catálogo de 70 consoles com emuladores conhecidos, argumentos, extensões e logos.
  - `logos/`: logos oficiais dos consoles (Wikimedia Commons, ver `logos/CREDITOS.md`).
- **`build/`**: empacotamento. `build.ps1` gera tudo em `dist/` (PyInstaller):
  `SannStation-Setup-<versão>.exe` (instalador próprio, `installer.py`) e `SannStation-Portatil-<versão>.zip`.
  `make_icon.ps1` desenha o ícone "SS" com System.Drawing.
- Dados: `%APPDATA%\SannStation` (instalado), `data/` ao lado do exe (portátil, se existir `portable.txt`)
  ou `data/` no projeto (rodando `python app.py`).

## Decisões importantes (e por quê)

- **Janela**: abre no Edge em modo `--app`, **no perfil normal** do navegador. Usar um perfil separado
  (`--user-data-dir`) quebrava em PCs corporativos: o Edge fazia login/sincronizava o perfil novo e reiniciava
  o processo, e o app achava que a janela tinha fechado ("Failed to fetch").
- **Encerramento**: guiado pela própria página. Cada janela manda `X-Page` em todo pedido + ping a cada 15 s e
  avisa ao fechar (`sendBeacon` para `/api/bye`). O app encerra quando não há janelas abertas há 6 s e nenhum
  jogo está rodando. Janela que some sem avisar expira em 5 min.
  Desde a 1.0.6 o app também procura a janela "SannStation" no Windows (`app_window_open`): o Edge congela
  janelas minimizadas/em segundo plano e elas param o sinal de vida, mas continuam existindo.
  Só contam janelas de **navegador** (`BROWSER_PROCESSES`): uma pasta do Explorer chamada "SannStation"
  tem o mesmo título e impedia o app de fechar.
- **Segurança da API local**: token aleatório por execução (injetado no `index.html`, enviado em `X-Token`) e
  checagem do cabeçalho `Host` (contra DNS rebinding). `/api/hello` é a única rota sem token.
- **Capas, sem chave**: libretro (`thumbnails.libretro.com`, ROMs, casando pelo nome No-Intro/Redump) →
  Wikipedia (imagem do artigo do jogo) → arte oficial da Steam **só pelo AppID** (sem busca). A **busca na loja
  Steam foi removida**: a rede/antivírus corporativo bloqueava (`CERTIFICATE_VERIFY_FAILED`). SteamGridDB é
  opcional (chave grátis em Configurações). No seletor de capa dá para colar imagem do Google (Ctrl+V) ou arrastar.
- **Capas em paisagem para NES, Super Nintendo e Nintendo 64** (1.0.1, NES e N64 na 1.0.4): o card ocupa 2 colunas com a mesma altura das capas em pé
  (`isLandscape` em `app.js`, consoles em `LANDSCAPE_CONSOLES`; CSS usa container query `cqw`); capa em pé (NES americano)
  aparece inteira sobre fundo desfocado (`fitLandscapeCovers`).
- **Capas quadradas para PlayStation 1** (1.0.5): formato por console em `COVER_SHAPES` (`app.js`); a grade
  alinha as capas pela base (`align-items: end`), como numa estante. Imagem fora do formato → `fitShapedCovers`.
- **Console de cada ROM pelo arquivo** (1.0.3): `detect_rom_console` usa a extensão (`.sfc` = SNES…) e olha dentro
  de `.zip`. Corrige jogos que entraram pelo emulador de outro console (ex.: SNES zipado no emulador de NES);
  `fix_rom_consoles` roda ao abrir o app. Configurações → "Usar capas oficiais" troca as capas pelas do libretro.
- **`truststore`** é incluído no build para usar os certificados do Windows nas conexões HTTPS.
- **Instalador** próprio em Python (não havia Inno Setup): instala por usuário em
  `%LOCALAPPDATA%\Programs\SannStation`, sem admin, cria atalhos e entrada em *Aplicativos instalados*.
  Remove a instalação antiga com o nome "Ludoteca"; o app migra `%APPDATA%\Ludoteca` → `%APPDATA%\SannStation`.
  O instalador grava `instalacao.manifest` com os arquivos que colocou na pasta, e o desinstalador apaga **só esses**
  (a pasta sai apenas se ficar vazia). Antes ele fazia `rmdir /s` na pasta inteira, e quem instalasse em
  `D:\Jogos` perdia a pasta toda. Instalações antigas sem manifesto: apaga só `SannStation.exe`, `Desinstalar.exe` e `_internal`.

- **Histórico de partidas** (`DB.sessions`: jogo, início, duração) é a base de estatísticas, “neste dia” e retrospectiva.
  Partidas de lançadores externos entram com duração 0 (contam como partida, não como tempo).
- **Tempo de jogo** (1.1): o jogo roda num Job Object do Windows, criado suspenso e retomado já dentro do Job, e o
  tempo para quando o Job fica sem processos. O tempo é gravado a cada minuto.
- **Pastas de jogos dos emuladores** (1.1): `emucfg.rom_folders` lê o formato de cada emulador; sem leitor próprio,
  procura caminhos absolutos nos arquivos de configuração. `reasonable_rom_dir` impede escanear disco inteiro/pastas do
  sistema. Pastas importadas ou escaneadas viram `romDirs` do emulador (vigiadas, escaneadas ao abrir o app).
- **Pastas misturadas** (1.1): a interface manda os consoles que cada emulador roda (`accepts`, tirado do catálogo);
  arquivo de outro console fica de fora. `.iso`/`.bin` têm o console lido do cabeçalho (`discs.py`).
- **Atualização** (1.1): instalador da Release, só se a URL for de Releases deste repositório e o arquivo começar com
  `MZ`; roda com `--silent --dir <pasta atual>` e o app se encerra. Portátil/código só abrem a página.

## Como desenvolver

```
python app.py                                   # roda do código (dados em data/)
powershell -ExecutionPolicy Bypass -File build\build.ps1   # gera instalador e portátil em dist/
```

Porta alternativa: variável `SANNSTATION_PORT`. Pasta de dados alternativa: `SANNSTATION_DATA`. Versão: `sann/version.py`.
Testes: `python -m unittest discover -s tests` (rodam no GitHub Actions no Windows e no Linux). Release: tag `vX.Y.Z`.

## O que não foi testado (sem acesso no PC de desenvolvimento)

- Importação real de Steam/Epic/GOG (nenhum desses instalado).
- Emuladores reais (a detecção foi testada com executáveis falsos); argumentos de linha de comando de
  emuladores menos comuns seguem a documentação de cada um.
- Fluxo real de copiar imagem no Google e colar (testado com eventos simulados).

## O que não foi testado em Windows real (1.1)

- Job Objects, cronômetro sobre o jogo (Tk + estilo transparente a cliques) e atualização pelo instalador: código Windows,
  coberto por teste automático só no GitHub Actions (Job Objects) ou não coberto (os outros dois).
- Leitores de configuração dos emuladores: testados com arquivos no formato documentado de cada um, não com instalações reais.
- Wikipedia: parser testado com infoboxes de exemplo (a rede do ambiente de desenvolvimento bloqueava a Wikipedia).

## Ideias de próximos passos

- Modo TV com controle (Gamepad API), estilo Big Picture.
- Assinar o executável (evita o aviso "O Windows protegeu o computador").
