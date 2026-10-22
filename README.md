# SannStation

<img src="build/assets/sannstation.png" width="96" alt="">

Organizador local da sua biblioteca de jogos, no estilo da Steam: jogos instalados, lojas, emuladores e capas em um só lugar.

## Instalação (usuário final)

Baixe na página de [Releases](https://github.com/thiagosann665/sannstation/releases/latest). Há duas opções — nenhuma precisa de Python nem de administrador:

| Arquivo | Para quê |
|---|---|
| `SannStation-Setup-<versão>.exe` | **Instalador.** Instala em `%LOCALAPPDATA%\Programs\SannStation`, cria atalhos no Menu Iniciar e na Área de Trabalho e aparece em *Configurações → Aplicativos instalados* (com desinstalador). |
| `SannStation-Portatil-<versão>.zip` | **Portátil.** Descompacte em qualquer pasta (ou pendrive) e abra `SannStation.exe`. A biblioteca fica na pasta `data` ao lado do programa. |

- A biblioteca e as capas da versão instalada ficam em `%APPDATA%\SannStation` e **são mantidas** ao atualizar ou reinstalar.
- A janela abre em modo aplicativo do Microsoft Edge (já vem no Windows 10/11). Fechar a janela encerra o programa
  (se um jogo estiver aberto, ele espera o jogo fechar para registrar o tempo de jogo).
- Abrir a SannStation de novo com ela já aberta só traz a janela de volta.
- Como o .exe não tem assinatura digital paga, o Windows pode mostrar “O Windows protegeu o computador”:
  clique em **Mais informações → Executar assim mesmo**.
- Instalação silenciosa: `SannStation-Setup-<versão>.exe --silent [--dir PASTA] [--no-desktop] [--no-launch]`.
- A versão instalada se atualiza sozinha: quando sai uma Release nova, aparece **Atualizar agora** no topo.
- Desinstalar apaga só os arquivos que o instalador colocou (a pasta escolhida não é apagada inteira).

## Gerar o .exe e o instalador (desenvolvimento)

Precisa do **Python 3.9+**. Um comando gera tudo em `dist/`:

```
powershell -ExecutionPolicy Bypass -File build\build.ps1
```

Para rodar direto do código, sem gerar .exe: `python app.py` (ou `start.bat`). Nesse modo os dados ficam em `data/`
(ou na pasta da variável `SANNSTATION_DATA`).

Testes (só biblioteca padrão): `python -m unittest discover -s tests`. Eles rodam também no GitHub Actions a cada push.

**Lançar uma versão:** mude o número em `sann/version.py`, faça o commit e envie a tag (`git tag v1.2.0 && git push origin v1.2.0`).
O GitHub Actions roda os testes, gera o instalador e o portátil no Windows e publica a Release.

## O que dá para fazer

| Recurso | Onde |
|---|---|
| **O que jogar agora?** Continue jogando, neste dia em outros anos, esquecidos e a roleta **Me surpreenda** | **Início** |
| Estatísticas: horas por mês/semana, por console, dia da semana, mais jogados, e a **retrospectiva do ano** | **Estatísticas** |
| **Encontrar meus jogos**: lê as pastas de jogos já configuradas nos emuladores do PC e importa tudo | Emuladores (ou sozinho na primeira vez) |
| Pastas vigiadas: ROMs novas entram sozinhas ao abrir o app, com capa | Configurações → Pastas de ROMs |
| Status (Jogando, Zerado, 100%, Abandonado, Lista de desejos) e “Zerados em 2026” | Página do jogo / barra lateral |
| Ano, gênero, desenvolvedora e descrição (Wikipedia, em português quando existe) | Página do jogo → Sobre |
| Coleções inteligentes por regras (ex.: “SNES e nunca jogado”) | Barra lateral → Coleções inteligentes |
| Jogos duplicados (regiões ou lojas diferentes) | Configurações → Organização |
| Aviso de BIOS faltando antes de abrir o jogo, botão Saves e backup com os saves dos emuladores | Página do jogo / Configurações |
| Jogos de vários discos viram um só (`.m3u`); prateleiras por console, status, gênero ou ano | Automático / Biblioteca → Agrupar |
| Capas animadas (SteamGridDB), cor da capa na página do jogo, trailer e cronômetro da sessão | Biblioteca / página do jogo |
| Adicionar jogo instalado (.exe, .bat, .lnk) com argumentos e pasta de trabalho | **+ Adicionar jogo** |
| Importar jogos da **Steam**, **Epic Games** e **GOG** já instalados | Configurações (ou tela inicial vazia) |
| Configurar emuladores com modelos prontos (RetroArch, PCSX2, DuckStation, PPSSPP, Dolphin, Cemu, Ryujinx, Citra/Azahar, melonDS, mGBA, Snes9x, Project64, Xenia, RPCS3) | Emuladores |
| Escanear uma pasta de ROMs/ISOs e adicionar tudo de uma vez (nomes limpos: `Jogo (USA) [!]` → `Jogo`) | Emuladores → Escanear pasta |
| Baixar **capas** e **banners** automaticamente, buscar e escolher entre várias, colar URL ou usar imagem do PC | Página do jogo → Capa e banner |
| Favoritos, coleções (tags), ocultar jogos, busca (atalho `/`), filtros por plataforma, ordenação, tamanho da grade | Barra lateral / topo da grade |
| Tempo de jogo e “jogado por último” | Página do jogo |
| Temas, modo claro/escuro, cor de destaque, fonte, efeito vidro, fundo ambiente | **Aparência** (e botão ☾/☀ no topo) |

### Aparência

- **Estilos rápidos:** Clássico (Steam), Moderno (vidro + arte de fundo), Minimalista (claro e compacto) e Neon (synthwave com brilho).
- **8 temas de cores**, cada um com versão escura e clara: Steam, Meia-noite (preto OLED), Nórdico, Drácula, Synthwave, Floresta, Retrô Âmbar e Oceano.
- **Modo:** Sistema (acompanha o Windows), Escuro ou Claro. O botão ☾/☀ no topo alterna rápido.
- **Cor de destaque:** 10 cores prontas ou qualquer cor pelo seletor.
- **Fonte:** Sistema, Inter, Poppins, Nunito, Rajdhani ou Orbitron (as do Google Fonts precisam de internet).
- **Efeitos:** arredondamento dos cantos, efeito vidro, fundo ambiente com a arte do jogo, animações, estilo ao passar o mouse nas capas e densidade compacta.

Tudo é salvo em `data/library.json` e aplicado antes da página aparecer, sem “piscar”.

### Capas

Fontes, em ordem de prioridade (tudo automático ao adicionar/importar jogos, sem precisar de chave):

1. **Jogos de emulador (ROMs):** capas oficiais do acervo do **libretro** (thumbnails.libretro.com), casadas pelo
   nome do arquivo da ROM.
2. **Qualquer jogo:** capa do artigo do jogo na **Wikipedia** (busca em menos de 1 segundo).
   Jogos importados da Steam usam também a arte oficial pelo AppID.
3. **Google Imagens:** o botão abre a busca no navegador; clique com o botão direito numa imagem →
   *Copiar imagem* e aperte **Ctrl+V** no seletor de capa (ou arraste a imagem para ele).
4. **SteamGridDB** (opcional, chave grátis): dezenas de capas e banners alternativos para qualquer jogo.

- **Direto no card:** passe o mouse sobre a capa e clique em 🖼 (ou em “🔍 Buscar capa online” nos jogos sem capa).
  Abre um seletor com várias capas encontradas online — clique em uma para aplicar. Também dá para buscar por outro nome,
  usar “⚡ Melhor automática” ou abrir “Mais opções…” (URL, arquivo do PC e banner).

- Sem configuração, as capas vêm da Wikipedia e do libretro (ROMs); preencha o **Steam AppID** de jogos da Steam para usar a arte oficial.
- Para capas de **qualquer** jogo, inclusive emulados, crie uma chave gratuita em
  [steamgriddb.com/profile/preferences/api](https://www.steamgriddb.com/profile/preferences/api) e cole em **Configurações**.

### Emuladores

A aba **Emuladores** já traz **70 consoles e computadores** (Nintendo, Sony, Microsoft, Sega, NEC, SNK, Atari, Arcade,
MS-DOS, Commodore, MSX, ZX Spectrum…), cada um com os emuladores conhecidos e a configuração pronta.
Cada card mostra o **logo oficial** do console (ou do fabricante), tirado do Wikimedia Commons — créditos em `web/logos/CREDITOS.md`.

1. Ao abrir a aba, a SannStation **procura sozinha** os emuladores instalados no PC (Arquivos de Programas, AppData,
   Área de Trabalho, Downloads, Documentos, raiz de cada disco, atalhos do Menu Iniciar, programas instalados e bibliotecas da Steam).
2. Clique no console → em cada emulador aparece **“Usar este”** se ele foi encontrado, **“Localizar”** para procurar de novo,
   **“Procurar manualmente…”** para apontar o .exe e **“Baixar ↗”** para o site oficial.
3. Depois de escolher, já abre o **escaneamento da pasta de ROMs** daquele console.

Para RetroArch, cada console usa um núcleo (core) específico — baixe-o no próprio RetroArch em
*Menu principal → Atualizador online → Baixar núcleos*.

### Argumentos dos emuladores

Variáveis disponíveis: `{rom}` (caminho completo), `{romdir}` (pasta) e `{romname}` (nome sem extensão).
Exemplo para RetroArch com SNES: `-L "cores\snes9x_libretro.dll" "{rom}"` — crie um emulador por sistema trocando o core.

### Observações

- O tempo de jogo é medido para executáveis e ROMs, incluindo os processos que o jogo abrir (launchers e emuladores que se reiniciam
  não zeram a contagem) e salvo a cada minuto. Jogos abertos pela Steam/Epic (`steam://…`) contam a partida, mas não o tempo, pois o processo é do lançador.
- Remover um jogo da SannStation **não apaga** nenhum arquivo do jogo.
- Tudo fica salvo em `data/` (`library.json` + pasta `covers/`). Faça backup dessa pasta para guardar sua biblioteca.
- O servidor só aceita conexões do próprio computador (`127.0.0.1`) e exige um token gerado a cada execução.
