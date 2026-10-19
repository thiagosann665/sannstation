# Notas do projeto (para continuar o desenvolvimento)

Resumo do que foi construído e das decisões tomadas até a versão 1.0.0, para retomar em outra máquina
ou em outra sessão do Claude. Uso geral e instalação estão no [README](README.md).

## Arquitetura

- **`app.py`**: servidor HTTP local (só biblioteca padrão do Python) em `127.0.0.1:8765` + API JSON.
  Lança jogos/emuladores, mede tempo de jogo, baixa capas, importa Steam/Epic/GOG, detecta emuladores instalados.
- **`web/`**: interface (HTML/CSS/JS puro, sem framework).
  - `app.js`: telas (biblioteca, detalhe, emuladores, aparência, configurações), modais e seletores de capa.
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
- **Segurança da API local**: token aleatório por execução (injetado no `index.html`, enviado em `X-Token`) e
  checagem do cabeçalho `Host` (contra DNS rebinding). `/api/hello` é a única rota sem token.
- **Capas, sem chave**: libretro (`thumbnails.libretro.com`, ROMs, casando pelo nome No-Intro/Redump) →
  Wikipedia (imagem do artigo do jogo) → arte oficial da Steam **só pelo AppID** (sem busca). A **busca na loja
  Steam foi removida**: a rede/antivírus corporativo bloqueava (`CERTIFICATE_VERIFY_FAILED`). SteamGridDB é
  opcional (chave grátis em Configurações). No seletor de capa dá para colar imagem do Google (Ctrl+V) ou arrastar.
- **`truststore`** é incluído no build para usar os certificados do Windows nas conexões HTTPS.
- **Instalador** próprio em Python (não havia Inno Setup): instala por usuário em
  `%LOCALAPPDATA%\Programs\SannStation`, sem admin, cria atalhos e entrada em *Aplicativos instalados*.
  Remove a instalação antiga com o nome "Ludoteca"; o app migra `%APPDATA%\Ludoteca` → `%APPDATA%\SannStation`.

## Como desenvolver

```
python app.py                                   # roda do código (dados em data/)
powershell -ExecutionPolicy Bypass -File build\build.ps1   # gera instalador e portátil em dist/
```

Porta alternativa: variável `SANNSTATION_PORT`. Versão: `APP_VERSION` em `app.py`.

## O que não foi testado (sem acesso no PC de desenvolvimento)

- Importação real de Steam/Epic/GOG (nenhum desses instalado).
- Emuladores reais (a detecção foi testada com executáveis falsos); argumentos de linha de comando de
  emuladores menos comuns seguem a documentação de cada um.
- Fluxo real de copiar imagem no Google e colar (testado com eventos simulados).

## Ideias de próximos passos

- Ler as pastas de jogos já configuradas dentro de cada emulador (Dolphin, PCSX2, DuckStation…) e escanear sozinho.
- Mostrar o logo do console em miniatura no card de cada jogo emulado.
- Assinar o executável (evita o aviso "O Windows protegeu o computador").
