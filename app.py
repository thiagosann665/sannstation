#!/usr/bin/env python3
"""SannStation - organizador local da sua biblioteca de jogos, no estilo Steam.

Sem dependencias obrigatorias: apenas a biblioteca padrao do Python 3.9+.
Execute `python app.py` (ou SannStation.exe) e a interface abre em uma janela propria.
"""
import base64
import difflib
import fnmatch
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from sann import discs, emucfg, friends, meta, procwatch, updates
from sann.version import VERSION

APP_VERSION = VERSION  # numero da versao: sann/version.py
FROZEN = getattr(sys, "frozen", False)  # True quando roda como SannStation.exe (PyInstaller)
APP_DIR = Path(sys.executable).parent if FROZEN else Path(__file__).resolve().parent
RES_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR))  # arquivos que vao junto no .exe
WEB_DIR = RES_DIR / "web"
if os.environ.get("SANNSTATION_DATA"):
    DATA_DIR = Path(os.environ["SANNSTATION_DATA"])  # pasta de dados escolhida (testes, varias bibliotecas)
elif (APP_DIR / "portable.txt").exists():
    DATA_DIR = APP_DIR / "data"  # modo portatil: dados ao lado do programa
elif FROZEN:
    DATA_DIR = Path(os.environ.get("APPDATA") or Path.home()) / "SannStation"  # instalado: pasta do usuario
    _OLD_DATA_DIR = DATA_DIR.with_name("Ludoteca")  # nome antigo do aplicativo
    if _OLD_DATA_DIR.is_dir() and not DATA_DIR.exists():
        try:
            _OLD_DATA_DIR.rename(DATA_DIR)  # leva a biblioteca e as capas para o nome novo
        except OSError:
            shutil.copytree(_OLD_DATA_DIR, DATA_DIR, dirs_exist_ok=True)
else:
    DATA_DIR = APP_DIR / "data"
COVER_DIR = DATA_DIR / "covers"
CACHE_DIR = DATA_DIR / "cache"
DB_PATH = DATA_DIR / "library.json"
HOST = "127.0.0.1"
PORT = int(os.environ.get("SANNSTATION_PORT") or os.environ.get("LUDOTECA_PORT") or "8765")
TOKEN = secrets.token_urlsafe(32)
USER_AGENT = f"SannStation/{VERSION} (organizador local de jogos)"
IS_WIN = os.name == "nt"
MAX_IMAGE_BYTES = 25 * 1024 * 1024

db_lock = threading.RLock()
pick_lock = threading.Lock()
running = {}  # id do jogo -> timestamp de inicio
pages = {}  # id de cada janela/aba aberta -> ultimo sinal de vida (monotonic)
pages_lock = threading.Lock()
pages_empty_since = None  # quando a ultima janela fechou
ever_had_page = False

if FROZEN and (sys.stdout is None or sys.stderr is None):
    # Sem console (SannStation.exe): erros vao para um arquivo de log em vez de sumir.
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _log = open(DATA_DIR / "sannstation.log", "a", encoding="utf-8", buffering=1)  # noqa: SIM115
    sys.stdout = sys.stdout or _log
    sys.stderr = sys.stderr or _log

try:
    # Usa os certificados do Windows nas conexoes HTTPS (redes com proxy/antivirus que inspecionam HTTPS).
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass


class ApiError(Exception):
    pass


# --------------------------------------------------------------------------- banco de dados

# sessions: historico de partidas {"g": id do jogo, "s": inicio (epoch), "d": duracao em segundos}.
# friends: conta e preferencias da lista de amigos (sann/friends.py); fica so neste PC, nao vai para a interface.
DEFAULT_DB = {"games": [], "emulators": [], "settings": {"steamgriddbKey": ""}, "sessions": [], "friends": {}}


def fresh_default():
    return json.loads(json.dumps(DEFAULT_DB))


def load_db():
    if DB_PATH.exists():
        try:
            data = json.loads(DB_PATH.read_text("utf-8"))
            for key, value in fresh_default().items():
                data.setdefault(key, value)
            return data
        except (OSError, ValueError):
            DB_PATH.replace(DB_PATH.with_name(f"library.corrompido-{int(time.time())}.json"))
    return fresh_default()


DB = load_db()


def save_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = DB_PATH.with_suffix(".tmp")
    for attempt in range(3):
        try:  # a sincronizacao de amigos mexe em DB["friends"] em outra thread: se mudar no meio, tenta de novo
            text = json.dumps(DB, ensure_ascii=False, indent=2)
            break
        except RuntimeError:
            if attempt == 2:
                raise
            time.sleep(0.05)
    tmp.write_text(text, "utf-8")
    tmp.replace(DB_PATH)


GAME_FIELDS = {
    "name": str, "kind": str, "path": str, "args": str, "workdir": str, "emulatorId": str,
    "steamAppId": str, "platform": str, "tags": list, "favorite": bool, "hidden": bool,
    "notes": str, "source": str, "consoleId": str, "status": str,
}
# Status do jogo (vazio = sem status). statusAt guarda quando mudou: "zerados em 2026".
GAME_STATUSES = ("", "playing", "beaten", "completed", "abandoned", "wishlist")
# romDirs: pastas de ROMs deste emulador, escaneadas de novo ao abrir o app ([{"path", "recursive"}]).
EMULATOR_FIELDS = {"name": str, "path": str, "args": str, "extensions": list, "platform": str, "consoleId": str,
                   "romDirs": "dirs"}
GAME_KINDS = ("exe", "rom", "url")


def apply_fields(target, data, fields):
    for key, typ in fields.items():
        if key not in data:
            continue
        value = data[key]
        if typ == "dirs":
            target[key] = clean_dirs(value)
            continue
        if typ is list:
            if isinstance(value, str):
                value = value.split(",")
            seen, clean = set(), []
            for item in value or []:
                item = str(item).strip()
                if item and item.lower() not in seen:
                    seen.add(item.lower())
                    clean.append(item)
            value = clean
        elif typ is bool:
            value = bool(value)
        else:
            value = "" if value is None else str(value).strip()
        target[key] = value


def clean_dirs(value):
    out, seen = [], set()
    for item in value if isinstance(value, list) else []:
        item = item if isinstance(item, dict) else {"path": item}
        path = str(item.get("path") or "").strip()
        key = os.path.normcase(os.path.normpath(path)) if path else ""
        if path and key not in seen:
            seen.add(key)
            out.append({"path": path, "recursive": bool(item.get("recursive", True))})
    return out[:50]


def new_id():
    return uuid.uuid4().hex[:12]


def new_game(data):
    game = {
        "id": new_id(), "name": "", "kind": "exe", "path": "", "args": "", "workdir": "",
        "emulatorId": "", "steamAppId": "", "platform": "PC", "tags": [], "favorite": False,
        "hidden": False, "notes": "", "source": "manual", "cover": "", "hero": "",
        "playtime": 0, "lastPlayed": 0, "added": int(time.time()), "status": "", "statusAt": 0, "meta": {},
    }
    apply_fields(game, data, GAME_FIELDS)
    validate_game(game)
    return game


def validate_game(game):
    if not game["name"]:
        raise ApiError("Informe o nome do jogo.")
    if game["kind"] not in GAME_KINDS:
        raise ApiError("Tipo de jogo inválido.")
    if game.get("status", "") not in GAME_STATUSES:
        raise ApiError("Status inválido.")
    if not game["path"]:
        raise ApiError("Informe o caminho do jogo.")
    if game["kind"] == "rom" and not find(DB["emulators"], game["emulatorId"]):
        raise ApiError("Escolha um emulador para esta ROM.")


def find(items, item_id):
    return next((it for it in items if it["id"] == item_id), None)


def get_game(game_id):
    game = find(DB["games"], game_id)
    if not game:
        raise ApiError("Jogo não encontrado.")
    return game


def clean_title(stem):
    """'Super Mario World (USA) [!]' -> 'Super Mario World'."""
    name = re.sub(r"[\(\[\{].*?[\)\]\}]", " ", stem)
    name = re.sub(r"[_\.]+", " ", name)
    name = re.sub(r"\s{2,}", " ", name).strip(" -")
    return name or stem


# --------------------------------------------------------------------------- execucao

def build_command(game):
    if game["kind"] == "rom":
        emu = find(DB["emulators"], game["emulatorId"])
        if not emu:
            raise ApiError("O emulador deste jogo foi removido. Edite o jogo e escolha outro.")
        rom = Path(game["path"])
        if not rom.exists():
            raise ApiError(f"ROM não encontrada: {rom}")
        exe = emu["path"]
        # Argumentos do proprio jogo (ex.: outro core do RetroArch so para ele) substituem os do emulador.
        args = (game.get("args") or emu.get("args") or '"{rom}"')
        args = args.replace("{rom}", str(rom)).replace("{romdir}", str(rom.parent)).replace("{romname}", rom.stem)
        cwd = str(Path(exe).parent)
    else:
        exe = game["path"]
        args = game.get("args", "")
        cwd = game.get("workdir") or str(Path(exe).parent)
    if not Path(exe).exists():
        raise ApiError(f"Executável não encontrado: {exe}")
    if not Path(cwd).is_dir():
        cwd = str(Path(exe).parent)
    if IS_WIN:
        return f'"{exe}" {args}'.strip(), cwd
    return [exe, *shlex.split(args)], cwd


def open_with_system(target):
    if IS_WIN:
        os.startfile(target)  # noqa: S606 - abre atalhos/URLs com o programa padrao
    elif sys.platform == "darwin":
        subprocess.Popen(["open", target])
    else:
        subprocess.Popen(["xdg-open", target])


MIN_SESSION_SECONDS = 5  # abriu e fechou na hora (erro do emulador, ROM errada): nao conta como partida


def track_playtime(game_id, watched):
    """Espera o jogo fechar e soma o tempo. Salva a cada minuto: se o PC desligar, perde no maximo 1 min."""
    start = time.time()
    running[game_id] = start
    session = {"g": game_id, "s": int(start), "d": 0}
    with db_lock:
        DB["sessions"].append(session)
    credited = 0

    def credit():
        nonlocal credited
        elapsed = int(time.time() - start)
        with db_lock:
            game = find(DB["games"], game_id)
            if game:
                game["playtime"] = int(game.get("playtime", 0)) + elapsed - credited
            session["d"] = elapsed
            credited = elapsed
            save_db()

    FRIENDS.wake.set()  # amigos veem "jogando" sem esperar o proximo ciclo
    try:
        watched.wait(tick=credit, every=60)
    finally:
        running.pop(game_id, None)
        credit()
        if credited < MIN_SESSION_SECONDS:
            with db_lock:
                if session in DB["sessions"]:
                    DB["sessions"].remove(session)
                save_db()
        with db_lock:
            game = find(DB["games"], game_id)
            info = activity_game(game) if game else None
        if info and credited >= ACTIVITY_MIN_SECONDS:
            FRIENDS.queue_activity({"type": "played", **info, "d": credited})
        FRIENDS.wake.set()


ACTIVITY_MIN_SECONDS = 300  # partidas curtas nao viram atividade para os amigos


def activity_game(game):
    return {"n": game["name"], "p": game.get("platform", ""), "c": game_console_id(game)}


def start_overlay(game):
    """Cronometro da sessao sobre o jogo, num processo separado (sann/overlay.py)."""
    args = ["--overlay", game["id"], str(time.time()), str(PORT), game["name"]]
    cmd = [sys.executable, *args] if FROZEN else [sys.executable, str(Path(__file__).resolve()), *args]
    try:
        subprocess.Popen(cmd, env={**os.environ, "SANNSTATION_TOKEN": TOKEN}, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except OSError:
        pass  # sem cronometro: o jogo abre normalmente


def launch(game):
    if game["id"] in running:
        raise ApiError("Este jogo já está em execução.")
    if game["kind"] == "url" or Path(game["path"]).suffix.lower() in (".lnk", ".url"):
        # Lancadores externos (steam://, Epic, atalhos): nao da para medir o tempo de jogo.
        try:
            open_with_system(game["path"])
        except OSError as exc:
            raise ApiError(f"O Windows não conseguiu abrir “{game['path']}”. O lançador (Steam/Epic) está instalado? "
                           f"({exc.strerror or exc})") from exc
        DB["sessions"].append({"g": game["id"], "s": int(time.time()), "d": 0})  # partida sem tempo medido
    else:
        cmd, cwd = build_command(game)
        flags = subprocess.CREATE_NEW_PROCESS_GROUP if IS_WIN else 0
        try:
            watched = procwatch.start(cmd, cwd, flags)
        except OSError as exc:
            raise ApiError(f"Não foi possível iniciar o jogo: {exc}") from exc
        threading.Thread(target=track_playtime, args=(game["id"], watched), daemon=True).start()
        if DB["settings"].get("sessionOverlay"):
            start_overlay(game)
    game["lastPlayed"] = int(time.time())
    save_db()


# --------------------------------------------------------------------------- capas e artes

STEAM_CDN = "https://cdn.cloudflare.steamstatic.com/steam/apps/{appid}/{file}"
STEAM_FILES = {"cover": ("library_600x900_2x.jpg", "library_600x900.jpg", "header.jpg"),
               "hero": ("library_hero.jpg", "page_bg_raw.jpg", "header.jpg")}
SGDB_API = "https://www.steamgriddb.com/api/v2"
ART_KINDS = ("cover", "hero")  # baixadas sozinhas
ALL_ART = ART_KINDS + ("anim",)  # anim: capa animada (SteamGridDB), aparece ao passar o mouse


def http_get(url, headers=None, timeout=20, limit=MAX_IMAGE_BYTES):
    if urllib.parse.urlsplit(url).scheme not in ("http", "https"):
        raise ApiError("Use um endereço http:// ou https://.")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read(limit + 1)
        if len(data) > limit:
            raise ApiError("Arquivo grande demais.")
        return data, resp.headers.get("Content-Type", "")


def http_json(url, headers=None):
    return json.loads(http_get(url, headers, limit=5 * 1024 * 1024)[0])


def sniff_image(data):
    if data.startswith(b"\xff\xd8"):
        return ".jpg"
    if data.startswith(b"\x89PNG"):
        return ".png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    if data.startswith(b"GIF8"):
        return ".gif"
    return None


def store_image(game, kind, data, content_type=""):
    # O tipo vem dos bytes, nao do cabecalho HTTP: CDNs as vezes devolvem HTML de erro com status 200.
    ext = sniff_image(data)
    if not ext:
        raise ApiError("O arquivo não é uma imagem válida (JPG, PNG, WEBP ou GIF).")
    COVER_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{game['id']}-{kind}-{int(time.time() * 1000)}{ext}"
    (COVER_DIR / name).write_bytes(data)
    remove_image(game, kind)
    game[kind] = name


def remove_image(game, kind):
    old = game.get(kind)
    game[kind] = ""
    if old:
        try:
            (COVER_DIR / old).unlink()
        except OSError:
            pass


def sgdb_key():
    return DB["settings"].get("steamgriddbKey", "").strip()


def sgdb_get(path):
    try:
        return http_json(SGDB_API + path, {"Authorization": f"Bearer {sgdb_key()}"})
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise ApiError("Chave da SteamGridDB inválida. Confira em Configurações.") from exc
        raise


def sgdb_query(kind):
    """Endpoint e filtros da SteamGridDB para cada tipo de arte."""
    if kind == "anim":
        return "grids", "?dimensions=600x900,342x482,660x930&types=animated"
    if kind == "cover":
        return "grids", "?dimensions=600x900,342x482,660x930&types=static"
    return "heroes", ""


def sgdb_candidates(term, kind, max_games=3, per_game=12):
    endpoint, dims = sgdb_query(kind)
    out = []
    games = sgdb_get(f"/search/autocomplete/{urllib.parse.quote(term)}").get("data", [])[:max_games]
    for g in games:
        for art in sgdb_get(f"/{endpoint}/game/{g['id']}{dims}").get("data", [])[:per_game]:
            out.append({"url": art["url"], "thumb": art.get("thumb") or art["url"],
                        "source": "SteamGridDB", "title": g.get("name", term)})
    return out


def sgdb_candidates_for_appid(appid, kind):
    endpoint, dims = sgdb_query(kind)
    try:
        data = sgdb_get(f"/{endpoint}/steam/{appid}{dims}").get("data", [])
    except urllib.error.HTTPError:
        return []
    return [{"url": a["url"], "thumb": a.get("thumb") or a["url"], "source": "SteamGridDB", "title": ""}
            for a in data[:12]]


WIKI_API = "https://en.wikipedia.org/w/api.php"
WIKI_SUFFIX = re.compile(r"\s*\((?:(\d{4}) )?(?:video )?game\)$", re.I)  # "(2005 video game)" -> "(2005)"


def wikipedia_candidates(term, limit=8):
    """Capas dos artigos de jogos da Wikipedia (busca rapida, sem chave). Devolve [] se a rede falhar."""
    query = urllib.parse.urlencode({
        "action": "query", "format": "json", "generator": "search", "gsrlimit": limit,
        "gsrsearch": f'{term} hastemplate:"Infobox video game"', "prop": "pageimages",
        "piprop": "thumbnail", "pithumbsize": 600, "pilicense": "any",
    })
    try:
        pages = http_json(f"{WIKI_API}?{query}").get("query", {}).get("pages", {}).values()
    except (ApiError, urllib.error.URLError, TimeoutError, ValueError, OSError):
        return []
    out = []
    for page in sorted(pages, key=lambda pg: pg.get("index", 99)):
        thumb = (page.get("thumbnail") or {}).get("source")
        if thumb and (page.get("thumbnail") or {}).get("width", 0) >= 120:
            out.append({"url": thumb, "thumb": thumb, "source": "Wikipedia",
                        "title": WIKI_SUFFIX.sub(lambda m: f" ({m.group(1)})" if m.group(1) else "",
                                                     page.get("title", ""))})
    return out


def wikipedia_best(name):
    """So a capa cujo titulo bate com o nome do jogo (para baixar sozinho sem errar de jogo)."""
    wanted = _norm_title(name)
    for cand in wikipedia_candidates(name, limit=5):
        if difflib.SequenceMatcher(None, wanted, _norm_title(cand["title"])).ratio() >= 0.85:
            return cand["url"]
    return None


def steam_urls(appid, kind):
    return [STEAM_CDN.format(appid=appid, file=f) for f in STEAM_FILES[kind]]


# Acervo de capas do libretro (thumbnails.libretro.com): capas oficiais nomeadas pelo padrao No-Intro/Redump,
# o mesmo nome que as ROMs costumam ter. Otimo para jogos de emulador, sem precisar de chave.
LIBRETRO_THUMBS = "https://thumbnails.libretro.com"
LIBRETRO_SYSTEMS = {
    "nes": ["Nintendo - Nintendo Entertainment System"], "fds": ["Nintendo - Family Computer Disk System"],
    "snes": ["Nintendo - Super Nintendo Entertainment System"], "n64": ["Nintendo - Nintendo 64"],
    "gamecube": ["Nintendo - GameCube"], "wii": ["Nintendo - Wii"], "wiiu": ["Nintendo - Wii U"],
    "gb": ["Nintendo - Game Boy"], "gbc": ["Nintendo - Game Boy Color"], "gba": ["Nintendo - Game Boy Advance"],
    "nds": ["Nintendo - Nintendo DS"], "3ds": ["Nintendo - Nintendo 3DS"], "virtualboy": ["Nintendo - Virtual Boy"],
    "pokemini": ["Nintendo - Pokemon Mini"], "gw": ["Handheld Electronic Game"],
    "ps1": ["Sony - PlayStation"], "ps2": ["Sony - PlayStation 2"], "ps3": ["Sony - PlayStation 3"],
    "ps4": ["Sony - PlayStation 4"], "psp": ["Sony - PlayStation Portable"], "psvita": ["Sony - PlayStation Vita"],
    "xbox": ["Microsoft - Xbox"], "xbox360": ["Microsoft - Xbox 360"],
    "sg1000": ["Sega - SG-1000"], "mastersystem": ["Sega - Master System - Mark III"],
    "megadrive": ["Sega - Mega Drive - Genesis"], "gamegear": ["Sega - Game Gear"],
    "segacd": ["Sega - Mega-CD - Sega CD"], "32x": ["Sega - 32X"], "saturn": ["Sega - Saturn"],
    "dreamcast": ["Sega - Dreamcast"], "naomi": ["Sega - Naomi", "Sega - Naomi 2", "Atomiswave"],
    "model2": ["MAME"], "model3": ["MAME"],
    "pce": ["NEC - PC Engine - TurboGrafx 16", "NEC - PC Engine SuperGrafx"],
    "pcecd": ["NEC - PC Engine CD - TurboGrafx-CD"], "pcfx": ["NEC - PC-FX"], "pc98": ["NEC - PC-98"],
    "neogeo": ["SNK - Neo Geo", "FBNeo - Arcade Games"], "neogeocd": ["SNK - Neo Geo CD"],
    "ngp": ["SNK - Neo Geo Pocket Color", "SNK - Neo Geo Pocket"],
    "atari2600": ["Atari - 2600"], "atari5200": ["Atari - 5200"], "atari7800": ["Atari - 7800"],
    "atari800": ["Atari - 8-bit"], "lynx": ["Atari - Lynx"], "jaguar": ["Atari - Jaguar"], "atarist": ["Atari - ST"],
    "wonderswan": ["Bandai - WonderSwan Color", "Bandai - WonderSwan"], "supervision": ["Watara - Supervision"],
    "3do": ["The 3DO Company - 3DO"], "cdi": ["Philips - CD-i"], "colecovision": ["Coleco - ColecoVision"],
    "intellivision": ["Mattel - Intellivision"], "vectrex": ["GCE - Vectrex"], "odyssey2": ["Magnavox - Odyssey2"],
    "channelf": ["Fairchild - Channel F"], "arcade": ["MAME", "FBNeo - Arcade Games"], "dos": ["DOS"],
    "c64": ["Commodore - 64"], "amiga": ["Commodore - Amiga"], "msx": ["Microsoft - MSX", "Microsoft - MSX2"],
    "zxspectrum": ["Sinclair - ZX Spectrum"], "cpc": ["Amstrad - CPC"], "x68000": ["Sharp - X68000"],
    "scummvm": ["ScummVM"], "tic80": ["TIC-80"],
}
LIBRETRO_FOLDERS = {"cover": "Named_Boxarts", "hero": "Named_Titles"}
REGION_ORDER = ("(usa", "(world", "(europe", "(brazil", "(japan")
LIBRETRO_BAD_CHARS = re.compile(r'[&*/:`<>?\\|"]')  # o libretro troca estes caracteres por "_" nos nomes
_libretro_index = {}  # (sistema, pasta) -> lista de nomes de arquivo (sem .png)
_libretro_lock = threading.Lock()


def _norm_title(name):
    name = re.sub(r"[\(\[].*?[\)\]]", " ", name.lower())
    name = name.replace("&", "and")
    name = re.sub(r"^the |, the\b", " ", name)
    return re.sub(r"[^a-z0-9]", "", name)


LIBRETRO_CACHE_DAYS = 14  # a lista de capas de cada console muda pouco: baixa de novo a cada 2 semanas


def _libretro_cache_file(system, folder):
    safe = re.sub(r"[^\w\-]+", "_", f"{system}__{folder}")
    return CACHE_DIR / "libretro" / f"{safe}.json"


def libretro_index(system, folder):
    """Nomes das capas de um console no libretro. Fica em memoria e em disco (data/cache/libretro)."""
    key = (system, folder)
    with _libretro_lock:
        if key in _libretro_index:
            return _libretro_index[key]
    cache = _libretro_cache_file(system, folder)
    stale = None
    try:
        cached = json.loads(cache.read_text("utf-8"))
        if time.time() - cached.get("fetched", 0) < LIBRETRO_CACHE_DAYS * 86400:
            with _libretro_lock:
                _libretro_index[key] = cached["names"]
            return cached["names"]
        stale = cached["names"]
    except (OSError, ValueError, KeyError, TypeError):
        pass
    url = f"{LIBRETRO_THUMBS}/{urllib.parse.quote(system)}/{folder}/"
    try:
        html = http_get(url, timeout=40, limit=40 * 1024 * 1024)[0].decode("utf-8", "ignore")
        names = [urllib.parse.unquote(h)[:-4] for h in re.findall(r'href="([^"/?][^"]*\.png)"', html)]
    except (ApiError, urllib.error.URLError, TimeoutError, ValueError, OSError):
        return stale or []  # sem rede: usa a lista antiga, se houver (sem guardar em memoria: tenta de novo depois)
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({"fetched": int(time.time()), "names": names}, ensure_ascii=False), "utf-8")
    except OSError:
        pass
    with _libretro_lock:
        _libretro_index[key] = names
    return names


def game_console_id(game):
    if game.get("kind") != "rom":
        return ""
    if game.get("consoleId"):
        return game["consoleId"]
    emu = find(DB["emulators"], game.get("emulatorId", ""))
    return (emu or {}).get("consoleId", "") or detect_rom_console(game.get("path", ""))


def libretro_candidates(game, kind, term="", limit=8):
    """URLs de capas do libretro que correspondem ao jogo, das mais provaveis para as menos."""
    systems = LIBRETRO_SYSTEMS.get(game_console_id(game), [])
    if not systems:
        return []
    stem_safe = LIBRETRO_BAD_CHARS.sub("_", Path(game.get("path", "")).stem).lower()
    wanted = _norm_title(term or game["name"])
    scored = []
    for system in systems:
        by_norm = {}
        for n in libretro_index(system, LIBRETRO_FOLDERS[kind]):
            by_norm.setdefault(_norm_title(n), []).append(n)
        close = difflib.get_close_matches(wanted, list(by_norm), n=4, cutoff=0.82) if wanted else []
        for rank_title, norm in enumerate(close):
            for n in by_norm[norm]:
                low = n.lower()
                region = next((i for i, r in enumerate(REGION_ORDER) if r in low), len(REGION_ORDER))
                exact = 0 if low == stem_safe else 1  # mesmo nome do arquivo da ROM: certeiro
                scored.append(((exact, rank_title, region, len(n)), system, n))
    scored.sort()
    out = []
    for _, system, n in scored[:limit]:
        url = f"{LIBRETRO_THUMBS}/{urllib.parse.quote(system)}/{LIBRETRO_FOLDERS[kind]}/{urllib.parse.quote(n)}.png"
        out.append({"url": url, "thumb": url, "source": "libretro", "title": n})
    return out


def search_art(game, kind, term):
    term = (term or game["name"]).strip()
    if kind == "anim":  # so a SteamGridDB tem capas animadas
        if not sgdb_key():
            return []
        results = sgdb_candidates_for_appid(game["steamAppId"], kind) if game.get("steamAppId") else []
        try:
            results += sgdb_candidates(term, kind)
        except (urllib.error.URLError, ValueError, TimeoutError):
            pass
        return results
    results = libretro_candidates(game, kind, term)
    if sgdb_key():
        if game.get("steamAppId"):
            results += sgdb_candidates_for_appid(game["steamAppId"], kind)
        try:
            results += sgdb_candidates(term, kind)
        except (urllib.error.URLError, ValueError, TimeoutError):
            pass
    if kind == "cover":
        results += wikipedia_candidates(term)
    if game.get("steamAppId"):
        # Jogos importados da Steam ja tem o AppID: a arte oficial vem direto do CDN, sem busca.
        url = steam_urls(game["steamAppId"], kind)[1 if kind == "cover" else 0]
        results.append({"url": url, "thumb": url, "source": "Arte oficial", "title": game["name"]})
    seen, unique = set(), []
    for r in results:
        if r["url"] not in seen:
            seen.add(r["url"])
            unique.append(r)
    return unique


def auto_art(game):
    """Baixa capa e banner que estiverem faltando, tentando as melhores fontes primeiro."""
    missing = [k for k in ART_KINDS if not game.get(k)]
    if not missing:
        return []
    appid = game.get("steamAppId")
    is_rom = game.get("kind") == "rom"
    got = []
    for kind in missing:
        urls = []
        if is_rom and kind == "cover":
            urls += [c["url"] for c in libretro_candidates(game, kind, limit=2)]
        if appid:
            urls += steam_urls(appid, kind)
            if sgdb_key():
                urls += [c["url"] for c in sgdb_candidates_for_appid(appid, kind)[:2]]
        if sgdb_key():
            try:
                urls += [c["url"] for c in sgdb_candidates(game["name"], kind, max_games=1, per_game=2)]
            except (ApiError, urllib.error.URLError, ValueError, TimeoutError):
                pass
        if is_rom and kind == "hero":
            urls += [c["url"] for c in libretro_candidates(game, kind, limit=1)]  # tela-titulo como banner
        if kind == "cover":
            best = wikipedia_best(game["name"])
            if best:
                urls.append(best)
        for url in urls:
            try:
                data, ctype = http_get(url)
                store_image(game, kind, data, ctype)
                got.append(kind)
                break
            except (ApiError, urllib.error.URLError, ValueError, TimeoutError, OSError):
                continue
    return got


# --------------------------------------------------------------------------- importadores

def parse_vdf(text):
    """Parser minimo do formato KeyValues (VDF) usado pela Steam."""
    root = {}
    stack, key = [root], None
    for string, brace in re.findall(r'"((?:\\.|[^"\\])*)"|([{}])', text):
        if brace == "{":
            child = {}
            stack[-1][key or ""] = child
            stack.append(child)
            key = None
        elif brace == "}":
            if len(stack) > 1:
                stack.pop()
            key = None
        else:
            string = string.replace("\\\\", "\\").replace('\\"', '"')
            if key is None:
                key = string
            else:
                stack[-1][key] = string
                key = None
    return root


def steam_root():
    if IS_WIN:
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as k:
                path = Path(winreg.QueryValueEx(k, "SteamPath")[0])
                if path.exists():
                    return path
        except OSError:
            pass
        candidates = [r"C:\Program Files (x86)\Steam", r"C:\Program Files\Steam"]
    else:
        home = Path.home()
        candidates = [home / ".steam/steam", home / ".local/share/Steam",
                      home / "Library/Application Support/Steam"]
    return next((Path(p) for p in candidates if Path(p).exists()), None)


STEAM_SKIP = re.compile(r"redistributable|steamworks|proton|steam linux runtime|steamvr|soundtrack", re.I)


def import_steam():
    root = steam_root()
    if not root:
        raise ApiError("Steam não encontrada neste computador.")
    libraries = {root}
    vdf = root / "steamapps" / "libraryfolders.vdf"
    if vdf.exists():
        folders = parse_vdf(vdf.read_text("utf-8", errors="ignore")).get("libraryfolders", {})
        for entry in folders.values():
            if isinstance(entry, dict) and entry.get("path"):
                libraries.add(Path(entry["path"]))
    found = []
    for lib in libraries:
        for acf in (lib / "steamapps").glob("appmanifest_*.acf"):
            state = parse_vdf(acf.read_text("utf-8", errors="ignore")).get("AppState", {})
            appid, name = state.get("appid"), state.get("name")
            if not appid or not name or appid == "228980" or STEAM_SKIP.search(name):
                continue
            found.append({"name": name, "kind": "url", "path": f"steam://rungameid/{appid}",
                          "platform": "PC", "steamAppId": appid, "source": "steam", "tags": ["Steam"]})
    return found


def import_epic():
    base = Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "Epic/EpicGamesLauncher/Data/Manifests"
    if not base.exists():
        raise ApiError("Epic Games Launcher não encontrado neste computador.")
    found = []
    for item in base.glob("*.item"):
        try:
            data = json.loads(item.read_text("utf-8", errors="ignore"))
        except ValueError:
            continue
        cats = [c.lower() for c in data.get("AppCategories", [])]
        if "addons" in cats or ("games" not in cats and cats):
            continue
        app, ns, cat_id = data.get("AppName"), data.get("CatalogNamespace"), data.get("CatalogItemId")
        if not app or not data.get("DisplayName"):
            continue
        ident = f"{ns}%3A{cat_id}%3A{app}" if ns and cat_id else app
        found.append({"name": data["DisplayName"], "kind": "url",
                      "path": f"com.epicgames.launcher://apps/{ident}?action=launch&silent=true",
                      "platform": "PC", "source": "epic", "tags": ["Epic Games"]})
    return found


def import_gog():
    if not IS_WIN:
        raise ApiError("A importação da GOG só está disponível no Windows.")
    import winreg
    found = []
    for key_path in (r"SOFTWARE\WOW6432Node\GOG.com\Games", r"SOFTWARE\GOG.com\Games"):
        try:
            root = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key_path)
        except OSError:
            continue
        with root:
            for i in range(winreg.QueryInfoKey(root)[0]):
                try:
                    with winreg.OpenKey(root, winreg.EnumKey(root, i)) as k:
                        val = lambda n: str(winreg.QueryValueEx(k, n)[0])  # noqa: E731
                        exe = val("exe")
                        name = val("gameName")
                        try:
                            workdir = val("workingDir")
                        except OSError:
                            workdir = val("path")
                        try:
                            args = val("launchParam")
                        except OSError:
                            args = ""
                except OSError:
                    continue
                found.append({"name": name, "kind": "exe", "path": exe, "args": args, "workdir": workdir,
                              "platform": "PC", "source": "gog", "tags": ["GOG"]})
        if found:
            break
    if not found:
        raise ApiError("Nenhum jogo da GOG encontrado.")
    return found


IMPORTERS = {"steam": import_steam, "epic": import_epic, "gog": import_gog}


def add_many(entries):
    existing = {os.path.normcase(g["path"]) for g in DB["games"]}
    added = []
    for entry in entries:
        key = os.path.normcase(entry["path"])
        if key in existing:
            continue
        existing.add(key)
        game = new_game(entry)
        DB["games"].append(game)
        added.append(game["id"])
    if added:
        save_db()
    return added


# Console identificado pelo proprio arquivo da ROM (so extensoes que pertencem a um unico console).
ROM_EXT_CONSOLE = {
    ".sfc": "snes", ".smc": "snes", ".fig": "snes", ".swc": "snes", ".bs": "snes",
    ".nes": "nes", ".unf": "nes", ".unif": "nes", ".fds": "fds",
    ".gb": "gb", ".gbc": "gbc", ".gba": "gba", ".nds": "nds", ".3ds": "3ds",
    ".z64": "n64", ".n64": "n64", ".v64": "n64", ".vb": "virtualboy", ".min": "pokemini",
    ".md": "megadrive", ".gen": "megadrive", ".smd": "megadrive", ".sms": "mastersystem",
    ".gg": "gamegear", ".32x": "32x", ".sg": "sg1000",
    ".pce": "pce", ".sgx": "pce", ".ngp": "ngp", ".ngc": "ngp", ".ws": "wonderswan", ".wsc": "wonderswan",
    ".a26": "atari2600", ".a52": "atari5200", ".a78": "atari7800", ".lnx": "lynx", ".j64": "jaguar",
    ".col": "colecovision", ".int": "intellivision", ".vec": "vectrex",
}
# Nomes iguais aos do catalogo de consoles da interface (web/consoles.js).
CONSOLE_NAMES = {
    "snes": "Super Nintendo (SNES)", "nes": "Nintendo (NES)", "fds": "Famicom Disk System",
    "gb": "Game Boy", "gbc": "Game Boy Color", "gba": "Game Boy Advance", "nds": "Nintendo DS",
    "3ds": "Nintendo 3DS", "n64": "Nintendo 64", "virtualboy": "Virtual Boy", "pokemini": "Pokémon Mini",
    "megadrive": "Mega Drive / Genesis", "mastersystem": "Master System", "gamegear": "Game Gear",
    "32x": "Sega 32X", "sg1000": "SG-1000", "pce": "PC Engine / TurboGrafx-16",
    "ngp": "Neo Geo Pocket / Color", "wonderswan": "WonderSwan / Color", "atari2600": "Atari 2600",
    "atari5200": "Atari 5200", "atari7800": "Atari 7800", "lynx": "Atari Lynx", "jaguar": "Atari Jaguar",
    "colecovision": "ColecoVision", "intellivision": "Intellivision", "vectrex": "Vectrex",
    "ps1": "PlayStation", "ps2": "PlayStation 2", "psp": "PlayStation Portable", "gamecube": "GameCube",
    "wii": "Wii", "saturn": "Sega Saturn", "segacd": "Sega CD / Mega-CD", "dreamcast": "Dreamcast",
    "xbox": "Xbox", "3do": "3DO",
}


def detect_rom_console(path):
    """'snes', 'ps2', 'wii'... pela extensao ou pelo cabecalho do disco; para .zip, olha o arquivo de dentro.
    '' se nao der para saber."""
    path = Path(path)
    ext = path.suffix.lower()
    if ext in ROM_EXT_CONSOLE:
        return ROM_EXT_CONSOLE[ext]
    if ext in discs.DISC_EXTS:
        return discs.detect_disc_console(path)
    if ext == ".zip":
        try:
            with zipfile.ZipFile(path) as z:
                found = {ROM_EXT_CONSOLE.get(Path(n).suffix.lower()) for n in z.namelist()} - {None}
        except (OSError, zipfile.BadZipFile, ValueError):
            return ""
        if len(found) == 1:
            return found.pop()
    return ""


def fix_rom_consoles():
    """Marca o console de cada ROM pelo arquivo (corrige jogos de SNES que entraram por um emulador de NES etc.)."""
    changed = 0
    with db_lock:
        for game in DB["games"]:
            if game.get("kind") != "rom" or game.get("consoleId"):
                continue
            emu = find(DB["emulators"], game.get("emulatorId", "")) or {}
            detected = detect_rom_console(game.get("path", ""))
            game["consoleId"] = detected or emu.get("consoleId", "") or ""
            if detected and detected != emu.get("consoleId"):
                game["platform"] = CONSOLE_NAMES.get(detected, game.get("platform", ""))
            changed += 1
        if changed:
            save_db()
    return changed


MAX_SCAN_FILES = 50000


def iter_files(root, recursive, max_depth=12, limit=MAX_SCAN_FILES):
    """Arquivos de uma pasta (e subpastas), sem seguir atalhos de pasta e sem pastas ocultas."""
    stack, count = [(Path(root), 0)], 0
    while stack:
        folder, depth = stack.pop()
        try:
            entries = sorted(os.scandir(folder), key=lambda e: e.name.lower())
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    if recursive and depth < max_depth and not entry.name.startswith((".", "$")):
                        stack.append((Path(entry.path), depth + 1))
                elif entry.is_file():
                    count += 1
                    if count > limit:
                        return
                    yield Path(entry.path)
            except OSError:
                continue


def rom_console_for(path, emu_console, accepts):
    """Console do arquivo para este emulador, ou None se for de outro console que ele nao roda.

    accepts: consoles que o emulador roda (vem do catalogo da interface). Sem essa lista (emuladores
    antigos/personalizados), o arquivo entra com o console detectado, como antes.
    """
    detected = detect_rom_console(path)
    if not detected or not emu_console or detected == emu_console:
        return detected or emu_console
    if accepts is None:
        return detected
    return detected if detected in accepts else None


def scan_roms(emu, folder, recursive, accepts=None):
    """Jogos novos de uma pasta: (entradas para add_many, total de arquivos de ROM encontrados)."""
    root = Path(folder)
    if not root.is_dir():
        raise ApiError("Pasta não encontrada.")
    exts = {("." + e.lstrip(".")).lower() for e in emu.get("extensions", [])}
    if not exts:
        raise ApiError("Este emulador não tem extensões configuradas.")
    files = [f for f in iter_files(root, recursive) if f.suffix.lower() in exts]
    with db_lock:
        known = {os.path.normcase(g["path"]) for g in DB["games"]}
    if ".m3u" in exts:
        # Jogos de varios discos viram um .m3u (o emulador troca de disco sozinho). Discos que ja estao
        # na biblioteca ficam como estao, para nao duplicar o jogo.
        files, _ = discs.group_multi_disc(files, skip=lambda f: os.path.normcase(str(f)) in known)
    total = len(files)
    # So os arquivos novos passam pela deteccao (le o cabecalho): o rescan ao abrir o app fica rapido.
    files = [f for f in files if os.path.normcase(str(f)) not in known]
    platform = emu.get("platform") or emu["name"]
    emu_console = emu.get("consoleId", "")
    accepts = set(accepts) if accepts is not None else None
    entries = []
    for f in files:
        console = rom_console_for(f, emu_console, accepts)
        if console is None:
            continue  # arquivo de outro console (pasta misturada): fica para o emulador certo
        entries.append({"name": clean_title(f.stem), "kind": "rom", "path": str(f), "emulatorId": emu["id"],
                        "consoleId": console, "source": "rom-scan", "tags": [],
                        "platform": CONSOLE_NAMES.get(console, platform) if console != emu_console else platform})
    return entries, total


# Sistema do libretro (nome da playlist do RetroArch) -> console
LIBRETRO_SYSTEM_CONSOLE = {}


def _system_console(system):
    if not LIBRETRO_SYSTEM_CONSOLE:
        for cid, systems in LIBRETRO_SYSTEMS.items():
            for sysname in systems:
                LIBRETRO_SYSTEM_CONSOLE.setdefault(sysname.lower(), cid)
    return LIBRETRO_SYSTEM_CONSOLE.get((system or "").lower(), "")


def count_roms(folder, recursive, consoles, limit=4000, deadline=None):
    """Quantos jogos de cada console ha na pasta: {console: n}. consoles = {console: [extensoes]}."""
    by_ext = {}
    for cid, exts in consoles.items():
        for e in exts:
            by_ext.setdefault(("." + str(e).lstrip(".")).lower(), []).append(cid)
    counts = {}
    for f in iter_files(folder, recursive, max_depth=4, limit=limit):
        if deadline and time.monotonic() > deadline:
            break
        cands = by_ext.get(f.suffix.lower())
        if not cands:
            continue
        base, disc = discs.disc_group_key(f)
        if base and disc > 1:
            continue  # disco 2, 3...: conta o jogo uma vez so
        detected = detect_rom_console(f)
        if detected:
            cid = detected if detected in cands else None
        else:
            cid = cands[0] if len(cands) == 1 else None  # extensao ambigua sem cabecalho: nao chuta
        if cid:
            counts[cid] = counts.get(cid, 0) + 1
    return counts


def reasonable_rom_dir(path):
    """Evita escanear o disco inteiro ou pastas do sistema vindas de uma configuracao."""
    p = Path(path)
    try:
        p = p.resolve()
    except OSError:
        return False
    if p.parent == p or not p.is_dir():
        return False
    blocked = {Path.home(), Path(os.environ.get("SYSTEMROOT", "C:/Windows"))}
    for env in ("PROGRAMFILES", "PROGRAMFILES(X86)", "APPDATA", "LOCALAPPDATA", "USERPROFILE"):
        if os.environ.get(env):
            blocked.add(Path(os.environ[env]))
    return all(os.path.normcase(str(p)) != os.path.normcase(str(b)) for b in blocked)


def discover_folders(candidates, budget=40.0):
    """Le as pastas de jogos configuradas em cada emulador e conta os jogos de cada console."""
    deadline = time.monotonic() + budget
    results = []
    for cand in candidates[:60]:
        exe = str(cand.get("path") or "")
        consoles = {str(k): [str(e) for e in v] for k, v in (cand.get("consoles") or {}).items() if isinstance(v, list)}
        if not exe or not Path(exe).is_file() or not consoles:
            continue
        family = emucfg.family_of(exe)
        folders = []
        for f in emucfg.rom_folders(family, exe):
            if time.monotonic() > deadline or not reasonable_rom_dir(f["dir"]):
                continue
            hint = _system_console(f.get("system"))
            subset = {hint: consoles[hint]} if hint in consoles else consoles
            counts = count_roms(f["dir"], f["recursive"], subset, deadline=deadline)
            if counts:
                folders.append({"dir": f["dir"], "recursive": f["recursive"], "counts": counts})
        results.append({"path": exe, "family": family, "folders": folders})
    return {"results": results, "timedOut": time.monotonic() > deadline}


# --------------------------------------------------------------------------- localizar emuladores instalados

SKIP_DIRS = {"windows", "$recycle.bin", "system volume information", "node_modules", ".git", "__pycache__",
             "windowsapps", "programdata", "packages", "temp", "tmp", "cache", "caches", "microsoft",
             "recovery", "perflogs", "msocache", "intel", "amd", "nvidia", "drivers", "$windows.~ws", "$windows.~bt"}


def search_roots():
    """Pastas onde emuladores costumam ficar, com a profundidade maxima de busca em cada uma."""
    home = Path.home()
    roots = []
    for env in ("PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432"):
        if os.environ.get(env):
            roots.append((Path(os.environ[env]), 3))
    if os.environ.get("LOCALAPPDATA"):
        roots += [(Path(os.environ["LOCALAPPDATA"]) / "Programs", 3), (Path(os.environ["LOCALAPPDATA"]), 2)]
    if os.environ.get("APPDATA"):
        roots.append((Path(os.environ["APPDATA"]), 2))
    roots += [(home / name, 4) for name in ("Desktop", "Downloads", "Documents", "OneDrive", "scoop/apps")]
    roots.append((home, 3))
    if IS_WIN:
        for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
            drive = Path(f"{letter}:/")
            if drive.exists():
                roots.append((drive, 3))
    steam = steam_root()
    if steam:
        roots.append((steam / "steamapps" / "common", 2))
        vdf = steam / "steamapps" / "libraryfolders.vdf"
        if vdf.exists():
            for entry in parse_vdf(vdf.read_text("utf-8", errors="ignore")).get("libraryfolders", {}).values():
                if isinstance(entry, dict) and entry.get("path"):
                    roots.append((Path(entry["path"]) / "steamapps" / "common", 2))
    return roots


def start_menu_targets():
    """Executaveis apontados pelos atalhos do Menu Iniciar e da Area de Trabalho."""
    if not IS_WIN:
        return []
    script = (
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
        "$s=New-Object -ComObject WScript.Shell;"
        "$d=@([Environment]::GetFolderPath('StartMenu'),[Environment]::GetFolderPath('CommonStartMenu'),"
        "[Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonDesktopDirectory'));"
        "$d|?{$_ -and (Test-Path $_)}|%{Get-ChildItem $_ -Recurse -Filter *.lnk -EA SilentlyContinue}|"
        "%{try{$s.CreateShortcut($_.FullName).TargetPath}catch{}}|?{$_ -like '*.exe'}"
    )
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                             capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return [line.strip() for line in out.stdout.splitlines() if line.strip()]
    except (OSError, subprocess.SubprocessError):
        return []


def registry_install_paths():
    """Executaveis e pastas de instalacao registrados em 'Aplicativos instalados' do Windows."""
    if not IS_WIN:
        return [], []
    import winreg
    exes, dirs = [], []
    keys = [(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
            (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall")]
    for hive, path in keys:
        try:
            root = winreg.OpenKey(hive, path)
        except OSError:
            continue
        with root:
            for i in range(winreg.QueryInfoKey(root)[0]):
                try:
                    with winreg.OpenKey(root, winreg.EnumKey(root, i)) as k:
                        for name in ("DisplayIcon", "InstallLocation"):
                            try:
                                value = str(winreg.QueryValueEx(k, name)[0]).strip().strip('"')
                            except OSError:
                                continue
                            if name == "DisplayIcon":
                                value = value.split(",")[0].strip('"')
                                if value.lower().endswith(".exe"):
                                    exes.append(value)
                            elif value:
                                dirs.append(value)
                except OSError:
                    continue
    return exes, dirs


def detect_executables(patterns, budget=25.0):
    """Procura no PC executaveis cujo nome bate com os padroes (ex.: 'pcsx2*.exe')."""
    pats = {}
    for p in patterns:
        if isinstance(p, str) and p.strip():
            pats.setdefault(p.strip().lower(), p.strip())
    found = {orig: [] for orig in pats.values()}
    seen = set()

    def check(path):
        name = os.path.basename(path).lower()
        hits = [orig for low, orig in pats.items() if fnmatch.fnmatch(name, low)]
        if not hits:
            return
        norm = os.path.normcase(os.path.abspath(path))
        if norm in seen or not os.path.isfile(path):
            return
        seen.add(norm)
        for orig in hits:
            found[orig].append(str(Path(path)))

    for low in pats:
        if "*" not in low and (hit := shutil.which(low)):
            check(hit)
    for target in start_menu_targets():
        check(target)
    reg_exes, reg_dirs = registry_install_paths()
    for exe in reg_exes:
        check(exe)
    roots = [(Path(d), 2) for d in reg_dirs] + search_roots()

    deadline = time.monotonic() + budget
    timed_out = False
    visited = set()
    for root, depth in roots:
        stack = [(str(root), 0)]
        while stack:
            if time.monotonic() > deadline:
                timed_out = True
                break
            folder, level = stack.pop()
            key = os.path.normcase(folder)
            if key in visited:
                continue
            visited.add(key)
            try:
                with os.scandir(folder) as it:
                    for entry in it:
                        try:
                            if entry.is_dir(follow_symlinks=False):
                                if level < depth and entry.name.lower() not in SKIP_DIRS and not entry.name.startswith("."):
                                    stack.append((entry.path, level + 1))
                            elif entry.name.lower().endswith(".exe"):
                                check(entry.path)
                        except OSError:
                            continue
            except OSError:
                continue
        if timed_out:
            break
    return {"found": found, "timedOut": timed_out}


# --------------------------------------------------------------------------- backup

def make_backup(folder, include_states=False):
    """Zip com a biblioteca, as capas e os saves de cada emulador configurado."""
    name = f"SannStation-backup-{time.strftime('%Y-%m-%d-%H%M')}.zip"
    target = folder / name
    with db_lock:
        db_json = json.dumps(DB, ensure_ascii=False, indent=2)
        emus = [dict(e) for e in DB["emulators"]]
    files = 0
    saved_dirs, skipped = [], []
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("library.json", db_json)
        for f in iter_files(COVER_DIR, False):
            z.write(f, f"covers/{f.name}")
            files += 1
        done = set()
        for emu in emus:
            for d in emucfg.save_dirs(emu["path"], emu.get("args", "")):
                key = os.path.normcase(d["dir"])
                if key in done or (d["kind"] == "states" and not include_states):
                    continue
                done.add(key)
                label = re.sub(r'[<>:"/\\|?*]+', "_", f"{emu['name']} - {d['label']}")
                saved_dirs.append(f"{emu['name']}: {d['label']}")
                root = Path(d["dir"])
                for f in iter_files(root, True):
                    try:
                        z.write(f, f"saves/{label}/{f.relative_to(root).as_posix()}")
                        files += 1
                    except OSError:
                        skipped.append(str(f))  # arquivo em uso pelo emulador: segue com os outros
        z.writestr("LEIA-ME.txt", "Backup da SannStation.\n\nlibrary.json e covers/: copie para a pasta de dados "
                   f"({DATA_DIR}) para restaurar a biblioteca.\nsaves/: copie cada pasta de volta para o lugar "
                   "dela no emulador (o nome indica qual e).\n")
    return {"path": str(target), "files": files, "saves": saved_dirs, "skipped": skipped[:20],
            "size": target.stat().st_size}


# --------------------------------------------------------------------------- seletor de arquivos nativo

def pick_path(mode, title, filetypes):
    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError as exc:
        raise ApiError("Seletor de arquivos indisponível (tkinter não instalado). Cole o caminho manualmente.") from exc
    with pick_lock:
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        try:
            if mode == "folder":
                path = filedialog.askdirectory(parent=root, title=title or "Escolha uma pasta")
            else:
                types = [(str(label), str(pattern)) for label, pattern in (filetypes or [])]
                path = filedialog.askopenfilename(parent=root, title=title or "Escolha um arquivo",
                                                  filetypes=types + [("Todos os arquivos", "*.*")])
        finally:
            root.destroy()
    return str(Path(path)) if path else ""


# --------------------------------------------------------------------------- rotas da API

ROUTES = []


def route(method, pattern):
    def deco(fn):
        ROUTES.append((method, re.compile(pattern), fn))
        return fn
    return deco


def public_state():
    return {"games": DB["games"], "emulators": DB["emulators"], "settings": DB["settings"],
            "sessions": DB["sessions"], "running": {gid: int(t) for gid, t in running.items()},
            "dataDir": str(DATA_DIR), "version": APP_VERSION, "friendsOn": FRIENDS.configured()}


@route("GET", r"/state")
def r_state(body, query):
    with db_lock:
        return public_state()


@route("POST", r"/games")
def r_game_create(body, query):
    with db_lock:
        game = new_game(body)
        DB["games"].append(game)
        save_db()
        return game


@route("PUT", r"/games/(\w+)")
def r_game_update(game_id, body, query):
    with db_lock:
        game = get_game(game_id)
        updated = dict(game)
        apply_fields(updated, body, GAME_FIELDS)
        validate_game(updated)
        changed_status = updated.get("status", "") != game.get("status", "")
        if changed_status:
            updated["statusAt"] = int(time.time()) if updated["status"] else 0
        game.update(updated)
        save_db()
        result, info = dict(game), activity_game(game)
    if changed_status and result["status"] in ("playing", "beaten", "completed"):
        FRIENDS.queue_activity({"type": "status", **info, "st": result["status"]})
    return result


@route("DELETE", r"/games/(\w+)")
def r_game_delete(game_id, body, query):
    with db_lock:
        game = get_game(game_id)
        for kind in ALL_ART:
            remove_image(game, kind)
        DB["games"].remove(game)
        DB["sessions"] = [ses for ses in DB["sessions"] if ses.get("g") != game_id]
        save_db()


def bios_problem(game):
    """Status da BIOS quando o emulador do jogo precisa de uma que nao esta no lugar; senao None."""
    if game.get("kind") != "rom":
        return None
    emu = find(DB["emulators"], game.get("emulatorId", ""))
    if not emu:
        return None
    status = emucfg.bios_status(emu["path"], game.get("args") or emu.get("args", ""), game_console_id(game))
    return status if status and not status["ok"] else None


@route("POST", r"/games/(\w+)/launch")
def r_launch(game_id, body, query):
    with db_lock:
        game = get_game(game_id)
        if not body.get("force"):
            problem = bios_problem(game)
            if problem:
                return {"needsBios": problem}  # a interface avisa e pergunta se abre mesmo assim
        launch(game)


@route("POST", r"/games/(\w+)/open-folder")
def r_open_folder(game_id, body, query):
    with db_lock:
        game = get_game(game_id)
    if game["kind"] == "url":
        raise ApiError("Este jogo é aberto por um lançador externo; não há pasta associada.")
    target = Path(game["path"])
    if not target.exists():
        raise ApiError(f"Caminho não encontrado: {target}")
    if IS_WIN:
        subprocess.Popen(["explorer", "/select,", str(target)])
    else:
        open_with_system(str(target.parent))


@route("GET", r"/games/(\w+)/art/search")
def r_art_search(game_id, body, query):
    kind = query.get("kind", "cover")
    if kind not in ALL_ART:
        raise ApiError("Tipo de arte inválido.")
    with db_lock:
        game = dict(get_game(game_id))
    try:
        return {"results": search_art(game, kind, query.get("q", ""))}
    except urllib.error.URLError as exc:
        raise ApiError(f"Falha ao buscar imagens: {exc.reason}") from exc


def _art_kind(body):
    kind = body.get("kind", "cover")
    if kind not in ALL_ART:
        raise ApiError("Tipo de arte inválido.")
    return kind


@route("POST", r"/games/(\w+)/art/url")
def r_art_url(game_id, body, query):
    kind = _art_kind(body)
    try:
        data, ctype = http_get(str(body.get("url", "")).strip())
    except urllib.error.HTTPError as exc:
        raise ApiError(f"Não foi possível baixar a imagem (HTTP {exc.code}).") from exc
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise ApiError(f"Não foi possível baixar a imagem: {exc}") from exc
    with db_lock:
        game = get_game(game_id)
        store_image(game, kind, data, ctype)
        save_db()
        return game


@route("POST", r"/games/(\w+)/art/local")
def r_art_local(game_id, body, query):
    kind = _art_kind(body)
    path = pick_path("file", "Escolha uma imagem", [("Imagens", "*.jpg *.jpeg *.png *.webp *.gif")])
    if not path:
        return {"cancelled": True}
    with db_lock:
        game = get_game(game_id)
        store_image(game, kind, Path(path).read_bytes())
        save_db()
        return game


@route("POST", r"/games/(\w+)/art/upload")
def r_art_upload(game_id, body, query):
    kind = _art_kind(body)
    try:
        data = base64.b64decode(str(body.get("data", "")).split(",")[-1], validate=True)
    except ValueError as exc:
        raise ApiError("Imagem inválida.") from exc
    if len(data) > MAX_IMAGE_BYTES:
        raise ApiError("Imagem grande demais.")
    with db_lock:
        game = get_game(game_id)
        store_image(game, kind, data)
        save_db()
        return game


@route("POST", r"/games/(\w+)/art/auto")
def r_art_auto(game_id, body, query):
    with db_lock:
        snapshot = dict(get_game(game_id))
    got = auto_art(snapshot)  # rede fora do lock
    with db_lock:
        game = find(DB["games"], game_id)
        if game:
            for kind in got:
                remove_image(game, kind)
                game[kind] = snapshot[kind]
            save_db()
    return {"downloaded": got}


@route("POST", r"/games/(\w+)/meta")
def r_game_meta(game_id, body, query):
    """Busca ano, genero, desenvolvedora e descricao na Wikipedia (rede fora do lock)."""
    with db_lock:
        name = get_game(game_id)["name"]
    title = str(body.get("title") or "").strip() or None
    try:
        info = meta.fetch_meta(name, http_json, title=title)
    except (ApiError, urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        if body.get("quiet"):
            return {"found": False}
        raise ApiError(f"Não foi possível consultar a Wikipedia: {exc}") from exc
    if not info:
        if body.get("quiet"):
            with db_lock:  # marca a tentativa para nao buscar de novo a cada abertura
                game = find(DB["games"], game_id)
                if game and not (game.get("meta") or {}).get("title"):
                    game["meta"] = {"fetched": int(time.time()), "notFound": True}
                    save_db()
            return {"found": False}
        raise ApiError("Não encontrei este jogo na Wikipedia. Confira o nome do jogo (Editar).")
    info["fetched"] = int(time.time())
    with db_lock:
        game = get_game(game_id)
        game["meta"] = info
        save_db()
        return {"found": True, "game": game}


@route("POST", r"/games/(\w+)/art/official")
def r_art_official(game_id, body, query):
    """Troca a capa de um jogo de emulador pela capa oficial do libretro (se houver uma correspondente)."""
    with db_lock:
        snapshot = dict(get_game(game_id))
    for cand in libretro_candidates(snapshot, "cover", limit=2):
        try:
            data, ctype = http_get(cand["url"])
        except (ApiError, urllib.error.URLError, ValueError, TimeoutError, OSError):
            continue
        with db_lock:
            game = get_game(game_id)
            store_image(game, "cover", data, ctype)
            save_db()
        return {"replaced": True, "title": cand["title"]}
    return {"replaced": False}


@route("DELETE", r"/games/(\w+)/art/(cover|hero|anim)")
def r_art_delete(game_id, kind, body, query):
    with db_lock:
        game = get_game(game_id)
        remove_image(game, kind)
        save_db()
        return game


@route("POST", r"/emulators")
def r_emu_create(body, query):
    with db_lock:
        emu = {"id": new_id(), "name": "", "path": "", "args": '"{rom}"', "extensions": [], "platform": "", "consoleId": ""}
        apply_fields(emu, body, EMULATOR_FIELDS)
        if not emu["name"] or not emu["path"]:
            raise ApiError("Informe o nome e o executável do emulador.")
        DB["emulators"].append(emu)
        save_db()
        return emu


@route("PUT", r"/emulators/(\w+)")
def r_emu_update(emu_id, body, query):
    with db_lock:
        emu = find(DB["emulators"], emu_id)
        if not emu:
            raise ApiError("Emulador não encontrado.")
        apply_fields(emu, body, EMULATOR_FIELDS)
        save_db()
        return emu


@route("DELETE", r"/emulators/(\w+)")
def r_emu_delete(emu_id, body, query):
    with db_lock:
        emu = find(DB["emulators"], emu_id)
        if not emu:
            raise ApiError("Emulador não encontrado.")
        DB["emulators"].remove(emu)
        if query.get("removeGames") == "1":
            gone = set()
            for game in [g for g in DB["games"] if g.get("emulatorId") == emu_id]:
                for kind in ALL_ART:
                    remove_image(game, kind)
                DB["games"].remove(game)
                gone.add(game["id"])
            DB["sessions"] = [ses for ses in DB["sessions"] if ses.get("g") not in gone]
        save_db()


@route("POST", r"/emulators/discover")
def r_emu_discover(body, query):
    cands = body.get("emulators")
    if not isinstance(cands, list):
        raise ApiError("Nenhum emulador para verificar.")
    return discover_folders([c for c in cands if isinstance(c, dict)])


@route("GET", r"/emulators/(\w+)/info")
def r_emu_info(emu_id, body, query):
    with db_lock:
        emu = find(DB["emulators"], emu_id)
        if not emu:
            raise ApiError("Emulador não encontrado.")
        emu = dict(emu)
    return {"bios": emucfg.bios_status(emu["path"], emu.get("args", ""), emu.get("consoleId", "")),
            "saves": emucfg.save_dirs(emu["path"], emu.get("args", "")), "family": emucfg.family_of(emu["path"])}


@route("POST", r"/library/rescan")
def r_rescan(body, query):
    """Procura ROMs novas nas pastas vigiadas de todos os emuladores (roda ao abrir o app)."""
    accepts = body.get("accepts") if isinstance(body.get("accepts"), dict) else {}
    with db_lock:
        emus = [dict(e) for e in DB["emulators"] if e.get("romDirs")]
    added = []
    for emu in emus:
        for d in emu["romDirs"]:
            if not Path(d["path"]).is_dir():
                continue
            try:
                entries, _ = scan_roms(emu, d["path"], d.get("recursive", True), accepts.get(emu["id"]))
            except ApiError:
                continue
            with db_lock:
                added += add_many(entries)
    return {"added": added}


@route("POST", r"/open-dir")
def r_open_dir(body, query):
    target = Path(str(body.get("path") or ""))
    if not target.is_dir() and body.get("create") and target.parent.is_dir():
        try:
            target.mkdir()  # pasta da BIOS ainda nao existe: cria para o usuario colocar o arquivo
        except OSError:
            pass
    if not target.is_dir():
        raise ApiError(f"Pasta não encontrada: {target}")
    open_with_system(str(target))


@route("POST", r"/backup")
def r_backup(body, query):
    folder = Path(str(body.get("folder") or ""))
    if not folder.is_dir():
        raise ApiError("Escolha uma pasta para salvar o backup.")
    return make_backup(folder, bool(body.get("states")))


@route("POST", r"/emulators/detect")
def r_emu_detect(body, query):
    patterns = body.get("patterns") or []
    if not isinstance(patterns, list) or not patterns:
        raise ApiError("Nenhum executável para procurar.")
    return detect_executables(patterns[:500])


@route("POST", r"/emulators/(\w+)/scan")
def r_emu_scan(emu_id, body, query):
    with db_lock:
        emu = find(DB["emulators"], emu_id)
        if not emu:
            raise ApiError("Emulador não encontrado.")
        folder = str(body.get("folder", "")).strip()
        recursive = bool(body.get("recursive", True))
        accepts = body.get("accepts") if isinstance(body.get("accepts"), list) else None
        entries, total = scan_roms(emu, folder, recursive, accepts)
        if body.get("remember", True):  # vira pasta vigiada: ROMs novas entram sozinhas ao abrir o app
            emu["romDirs"] = clean_dirs(emu.get("romDirs", []) + [{"path": folder, "recursive": recursive}])
        added = add_many(entries)
        save_db()
        return {"found": total, "added": added}


@route("POST", r"/import/(steam|epic|gog)")
def r_import(source, body, query):
    entries = IMPORTERS[source]()
    with db_lock:
        return {"found": len(entries), "added": add_many(entries)}


@route("GET", r"/ping")
def r_ping(body, query):
    return {"running": {gid: int(t) for gid, t in running.items()}}


@route("POST", r"/quit")
def r_quit(body, query):
    threading.Thread(target=lambda: (FRIENDS.go_offline(), time.sleep(0.3), os._exit(0)), daemon=True).start()


def clean_smart_collections(items):
    """Colecoes inteligentes: {id, name, match: all|any, rules: [{field, op, value}]}. A interface avalia as regras."""
    out = []
    for c in items[:50]:
        if not isinstance(c, dict) or not str(c.get("name", "")).strip():
            continue
        rules = [{"field": str(r.get("field", ""))[:24], "op": str(r.get("op", ""))[:16], "value": str(r.get("value", ""))[:80]}
                 for r in (c.get("rules") or [])[:12] if isinstance(r, dict)]
        out.append({"id": re.sub(r"\W", "", str(c.get("id") or new_id()))[:24] or new_id(),
                    "name": str(c["name"]).strip()[:60], "match": "any" if c.get("match") == "any" else "all",
                    "rules": rules})
    return out


# --------------------------------------------------------------------------- amigos

def friends_save():
    with db_lock:
        save_db()


FRIENDS = friends.Friends(DB["friends"], friends_save, version=APP_VERSION)
AWAY_SECONDS = 120  # janela sem sinal ha 2 min (minimizada/congelada pelo Edge) = "ausente"


def default_friends_server():
    """Servidor de amigos que ja vem no app (sann/firebase_config.json, opcional): os amigos nao configuram nada."""
    try:
        cfg = json.loads((RES_DIR / "sann" / "firebase_config.json").read_text("utf-8"))
        if cfg.get("apiKey") and friends.valid_db_url(cfg.get("databaseURL", "")):
            return cfg
    except (OSError, ValueError, AttributeError):
        pass
    return None


def compact_game(g):
    item = {"n": g["name"], "p": g.get("platform", ""), "c": game_console_id(g), "pt": int(g.get("playtime") or 0),
            "st": g.get("status", ""), "lp": int(g.get("lastPlayed") or 0), "y": (g.get("meta") or {}).get("year", 0),
            "f": bool(g.get("favorite"))}
    return {k: v for k, v in item.items() if v not in ("", 0, False, None)}


def friends_local():
    """O que os amigos veem de mim agora: status, jogo aberto e biblioteca resumida."""
    with db_lock:
        game = None
        if running:
            gid, start = next(iter(running.items()))
            g = find(DB["games"], gid)
            if g:
                game = {**activity_game(g), "since": int(start * 1000)}
        library = {g["id"]: compact_game(g) for g in DB["games"] if not g.get("hidden")}
    with pages_lock:
        recent = any(time.monotonic() - seen < AWAY_SECONDS for seen in pages.values())
    return {"state": "online" if recent or game else "away", "game": game, "library": library}


def friends_loop():
    while True:
        FRIENDS.wake.wait(friends.SYNC_SECONDS)
        FRIENDS.wake.clear()
        if FRIENDS.configured():
            FRIENDS.sync(friends_local())


def friends_call(fn):
    """Erros do servico de amigos viram mensagens para a interface."""
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except friends.FriendsError as exc:
            raise ApiError(str(exc)) from exc
    return wrapper


def friends_state(since=0):
    return {**FRIENDS.snapshot(since), "defaultServer": bool(default_friends_server())}


UID = r"([A-Za-z0-9]{1,64})"


@route("GET", r"/friends")
def r_friends(body, query):
    try:
        since = int(query.get("since") or 0)
    except ValueError:
        since = 0
    return friends_state(since)


@route("GET", r"/friends/rules")
def r_friends_rules(body, query):
    return {"rules": (RES_DIR / "sann" / "firebase_rules.json").read_text("utf-8")}


@route("POST", r"/friends/setup")
@friends_call
def r_friends_setup(body, query):
    name = str(body.get("name") or "").strip()
    if body.get("useDefault"):
        cfg = default_friends_server()
        if not cfg:
            raise ApiError("Este app não tem um servidor de amigos padrão.")
    else:
        cfg = friends.parse_config(body.get("config", ""))
        if str(body.get("databaseURL") or "").strip():
            cfg["databaseURL"] = str(body["databaseURL"]).strip()
    FRIENDS.setup(cfg.get("apiKey", ""), cfg.get("databaseURL", ""), name)
    FRIENDS.sync(friends_local())
    return friends_state()


@route("POST", r"/friends/join")
@friends_call
def r_friends_join(body, query):
    res = FRIENDS.join(body.get("invite", ""), str(body.get("name") or "").strip())
    FRIENDS.sync(friends_local())
    return {**friends_state(), "result": res}


@route("POST", r"/friends/add")
@friends_call
def r_friends_add(body, query):
    text = str(body.get("code") or "")
    res = FRIENDS.join(text) if friends.decode_invite(text) else FRIENDS.add(text)
    FRIENDS.sync(friends_local())
    return {**friends_state(), "result": res}


@route("GET", r"/friends/invite")
@friends_call
def r_friends_invite(body, query):
    return {"invite": FRIENDS.invite()}


@route("PUT", r"/friends/profile")
@friends_call
def r_friends_profile(body, query):
    FRIENDS.set_profile(**{k: body[k] for k in ("name", "avatar", "shareGame", "shareLibrary", "shareActivity") if k in body})
    FRIENDS.sync(friends_local())
    return friends_state()


@route("POST", r"/friends/sync")
@friends_call
def r_friends_sync(body, query):
    FRIENDS.sync(friends_local())
    return friends_state()


@route("POST", r"/friends/leave")
@friends_call
def r_friends_leave(body, query):
    FRIENDS.leave()
    return friends_state()


@route("POST", rf"/friends/{UID}/(accept|decline|cancel)")
@friends_call
def r_friends_answer(uid, action, body, query):
    getattr(FRIENDS, action)(uid)
    FRIENDS.sync(friends_local())
    return friends_state()


@route("DELETE", rf"/friends/{UID}")
@friends_call
def r_friends_remove(uid, body, query):
    FRIENDS.remove(uid)
    return friends_state()


@route("GET", rf"/friends/{UID}/library")
@friends_call
def r_friends_library(uid, body, query):
    return {"library": FRIENDS.library(uid)}


@route("GET", rf"/friends/{UID}/chat")
@friends_call
def r_friends_chat(uid, body, query):
    return {"messages": FRIENDS.chat(uid, query.get("after") or None), "me": FRIENDS.me}


@route("POST", rf"/friends/{UID}/chat")
@friends_call
def r_friends_send(uid, body, query):
    key = FRIENDS.send(uid, body.get("text", ""), body.get("invite"))
    return {"id": key}


@route("POST", rf"/friends/{UID}/read")
@friends_call
def r_friends_read(uid, body, query):
    FRIENDS.mark_read(uid, str(body.get("id") or ""))


# --------------------------------------------------------------------------- atualizacao

_update_cache = {"at": 0.0, "result": None}


def install_mode():
    """'installed' (instalador), 'portable' (zip) ou 'dev' (python app.py)."""
    if not FROZEN:
        return "dev"
    return "portable" if (APP_DIR / "portable.txt").exists() else "installed"


@route("GET", r"/update/check")
def r_update_check(body, query):
    if query.get("force") != "1" and _update_cache["result"] and time.time() - _update_cache["at"] < 6 * 3600:
        return _update_cache["result"]
    try:
        result = updates.check(http_json, APP_VERSION)
    except (ApiError, urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        raise ApiError(f"Não foi possível verificar atualizações: {exc}") from exc
    result.update({"current": APP_VERSION, "mode": install_mode()})
    _update_cache.update(at=time.time(), result=result)
    return result


@route("POST", r"/update/install")
def r_update_install(body, query):
    """Baixa o instalador da Release e roda em modo silencioso; ele fecha e reabre a SannStation."""
    info = _update_cache["result"]
    if not info or not info.get("available") or not info.get("setup"):
        raise ApiError("Nenhuma atualização disponível para instalar.")
    if install_mode() != "installed":
        raise ApiError("Atualização automática só na versão instalada. Baixe a nova versão na página da Release.")
    if running:
        raise ApiError("Feche o jogo antes de atualizar (o tempo de jogo dele ainda está sendo medido).")
    data = http_get(info["setup"], timeout=120, limit=300 * 1024 * 1024)[0]
    if not data.startswith(b"MZ"):
        raise ApiError("O arquivo baixado não é um instalador válido.")
    target = CACHE_DIR / "update" / f"SannStation-Setup-{info['version']}.exe"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    subprocess.Popen([str(target), "--silent", "--dir", str(APP_DIR)], creationflags=flags, close_fds=True)
    threading.Thread(target=lambda: (FRIENDS.go_offline(), time.sleep(1.5), os._exit(0)), daemon=True).start()
    return {"installing": info["version"]}


@route("PUT", r"/settings")
def r_settings(body, query):
    with db_lock:
        if "steamgriddbKey" in body:
            DB["settings"]["steamgriddbKey"] = str(body["steamgriddbKey"]).strip()
        for flag in ("autoScan", "checkUpdates", "sessionOverlay"):
            if isinstance(body.get(flag), bool):
                DB["settings"][flag] = body[flag]
        if isinstance(body.get("smartCollections"), list):
            DB["settings"]["smartCollections"] = clean_smart_collections(body["smartCollections"])
        if isinstance(body.get("dupIgnore"), list):
            DB["settings"]["dupIgnore"] = [str(k)[:200] for k in body["dupIgnore"]][:1000]
        if isinstance(body.get("theme"), dict):
            # Guarda apenas valores simples; quem valida os nomes/opcoes e o theme.js.
            DB["settings"]["theme"] = {str(k)[:40]: v for k, v in list(body["theme"].items())[:40]
                                       if isinstance(v, (str, bool, int, float)) and len(str(v)) <= 80}
        save_db()
        return DB["settings"]


@route("POST", r"/pick")
def r_pick(body, query):
    mode = "folder" if body.get("mode") == "folder" else "file"
    return {"path": pick_path(mode, body.get("title", ""), body.get("filetypes", []))}


# --------------------------------------------------------------------------- servidor HTTP

STATIC_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
                ".jpg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon"}


class Handler(BaseHTTPRequestHandler):
    server_version = "SannStation"

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def send_body(self, status, data, ctype, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, status, payload):
        self.send_body(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                       "application/json; charset=utf-8", {"Cache-Control": "no-store"})

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            data = json.loads(self.rfile.read(min(length, 40 * 1024 * 1024)))
        except ValueError as exc:
            raise ApiError("JSON inválido.") from exc
        return data if isinstance(data, dict) else {}

    def dispatch(self, method):
        # Bloqueia DNS rebinding: so aceita acessos pelo proprio endereco local.
        host = (self.headers.get("Host") or "").lower()
        if host not in (f"127.0.0.1:{PORT}", f"localhost:{PORT}"):
            return self.send_json(403, {"error": "Host não permitido."})
        parts = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(parts.path)
        if path.startswith("/api/"):
            return self.handle_api(method, path[4:], dict(urllib.parse.parse_qsl(parts.query)))
        if method != "GET":
            return self.send_json(405, {"error": "Método não permitido."})
        return self.serve_static(path)

    def handle_api(self, method, path, query):
        if method == "GET" and path == "/hello":  # usado para detectar uma SannStation ja aberta
            return self.send_json(200, {"app": "sannstation", "version": APP_VERSION})
        if method == "POST" and path == "/bye":  # a janela avisa que esta fechando
            if secrets.compare_digest(query.get("t", ""), TOKEN):
                page_closed(query.get("p", ""))
            return self.send_json(200, {"ok": True})
        # O token so existe na pagina servida por nos; outros sites nao conseguem chamar a API.
        if not secrets.compare_digest(self.headers.get("X-Token", ""), TOKEN):
            return self.send_json(403, {"error": "Sessão expirada. Recarregue a página."})
        page_seen(self.headers.get("X-Page", ""))
        for route_method, pattern, fn in ROUTES:
            match = pattern.fullmatch(path)
            if route_method == method and match:
                try:
                    body = self.read_json() if method in ("POST", "PUT") else {}
                    result = fn(*match.groups(), body=body, query=query)
                except ApiError as exc:
                    return self.send_json(400, {"error": str(exc)})
                except Exception as exc:  # noqa: BLE001
                    traceback.print_exc()
                    return self.send_json(500, {"error": f"Erro interno: {exc}"})
                return self.send_json(200, result if result is not None else {"ok": True})
        return self.send_json(404, {"error": "Rota não encontrada."})

    def serve_static(self, path):
        if path in ("/", "/index.html"):
            with db_lock:
                theme = json.dumps(DB["settings"].get("theme", {}), ensure_ascii=False).replace("</", "<\\/")
            html = (WEB_DIR / "index.html").read_text("utf-8").replace("__TOKEN__", TOKEN).replace("__THEME__", theme)
            return self.send_body(200, html.encode("utf-8"), STATIC_TYPES[".html"], {"Cache-Control": "no-store"})
        if path.startswith("/covers/"):
            name = path[len("/covers/"):]
            file = COVER_DIR / name
            if re.fullmatch(r"[\w\-]+\.(jpg|png|webp|gif)", name) and file.is_file():
                return self.send_body(200, file.read_bytes(), STATIC_TYPES[file.suffix],
                                      {"Cache-Control": "max-age=31536000, immutable"})
            return self.send_json(404, {"error": "Imagem não encontrada."})
        file = (WEB_DIR / path.lstrip("/")).resolve()
        if file.is_file() and WEB_DIR.resolve() in file.parents and file.suffix in STATIC_TYPES:
            return self.send_body(200, file.read_bytes(), STATIC_TYPES[file.suffix], {"Cache-Control": "no-cache"})
        return self.send_json(404, {"error": "Não encontrado."})


class Server(ThreadingHTTPServer):
    # A fila padrao (5) recusa conexoes quando a grade carrega dezenas de capas ao mesmo tempo.
    request_queue_size = 128
    daemon_threads = True


def find_browser():
    """Edge (sempre presente no Windows 10/11) ou Chrome, para abrir em modo janela de aplicativo."""
    candidates = []
    if IS_WIN:
        for env in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA"):
            base = os.environ.get(env)
            if base:
                candidates += [Path(base) / "Microsoft/Edge/Application/msedge.exe",
                               Path(base) / "Google/Chrome/Application/chrome.exe"]
    else:
        candidates += [Path(p) for p in filter(None, (shutil.which("google-chrome"), shutil.which("chromium"),
                                                        shutil.which("microsoft-edge")))]
    return next((b for b in candidates if b.exists()), None)


def open_window(url):
    """Abre a interface numa janela propria (sem barra de endereco), no perfil normal do navegador.

    Nao usamos um perfil separado: em PCs corporativos o Edge faz login/sincroniza o perfil novo e
    reinicia o processo, o que parecia "janela fechada". Quem diz se a janela esta aberta e a propria pagina.
    """
    browser = find_browser()
    if browser:
        try:
            subprocess.Popen([str(browser), f"--app={url}", "--window-size=1400,900"])
            return
        except OSError:
            pass
    webbrowser.open(url)


def already_running():
    """Se ja existe uma SannStation nesta porta, devolve True (para so reabrir a janela dela)."""
    try:
        with urllib.request.urlopen(f"http://{HOST}:{PORT}/api/hello", timeout=2) as r:
            return json.loads(r.read()).get("app") == "sannstation"
    except (OSError, ValueError):
        return False


def page_seen(page_id):
    global pages_empty_since, ever_had_page
    if not page_id:
        return
    with pages_lock:
        pages[page_id[:64]] = time.monotonic()
        pages_empty_since = None
        ever_had_page = True


def page_closed(page_id):
    global pages_empty_since
    with pages_lock:
        pages.pop(page_id[:64], None)
        if not pages:
            pages_empty_since = time.monotonic()


PAGE_STALE_SECONDS = 300  # janela sem sinal de vida por este tempo deixa de contar (se a janela tambem sumiu)
WINDOW_TITLE = "SannStation"  # titulo da pagina = titulo da janela do Edge em modo app


# Processos de navegador que podem mostrar a janela da SannStation (modo app ou aba).
BROWSER_PROCESSES = {"msedge.exe", "chrome.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe"}


def app_window_open():
    """True se existe uma janela de navegador com o titulo da SannStation (mesmo minimizada ou congelada).

    O Edge congela/suspende janelas em segundo plano para economizar energia; uma janela congelada para de
    mandar sinal de vida, mas continua existindo. E isso que impede o app de encerrar por engano.
    So contam janelas de navegador: uma pasta do Explorer chamada "SannStation" (a da instalacao ou a dos
    dados) tem o mesmo titulo e, sem esse filtro, impedia o app de fechar.
    """
    if not IS_WIN:
        return False
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
                                                    ctypes.POINTER(wintypes.DWORD)]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    names = {}  # pid -> nome do executavel (cache durante esta varredura)
    found = []

    def process_name(hwnd):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value not in names:
            name = ""
            handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
            if handle:
                try:
                    buf = ctypes.create_unicode_buffer(1024)
                    size = wintypes.DWORD(len(buf))
                    if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                        name = os.path.basename(buf.value).lower()
                finally:
                    kernel32.CloseHandle(handle)
            names[pid.value] = name
        return names[pid.value]

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def callback(hwnd, _):
        length = user32.GetWindowTextLengthW(hwnd)
        if length and length < 512:
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buf, length + 1)
            title = buf.value
            # Janela de app ("SannStation") ou aba ativa num navegador ("SannStation - ... Microsoft Edge")
            if (title == WINDOW_TITLE or title.startswith(WINDOW_TITLE + " ")) and process_name(hwnd) in BROWSER_PROCESSES:
                found.append(hwnd)
                return False
        return True

    user32.EnumWindows(callback, 0)
    return bool(found)


def watch_and_exit(server, started):
    """Encerra quando a janela da SannStation fechar de verdade e nenhum jogo estiver rodando.

    Sinais usados: a janela avisa ao fechar (/api/bye) e manda sinal de vida a cada 15 s; e, no Windows,
    a propria janela "SannStation" e procurada na lista de janelas abertas. So encerra quando nao ha
    janela nem pagina ativa por 6 s seguidos (tolera recarregar a pagina).
    """
    global pages_empty_since
    gone_since = None
    while True:
        time.sleep(1)
        now = time.monotonic()
        with pages_lock:
            for pid, seen in list(pages.items()):
                if now - seen > PAGE_STALE_SECONDS:
                    pages.pop(pid)
                    if not pages:
                        pages_empty_since = now
            has_pages = bool(pages)
            seen_any = ever_had_page
        if running or has_pages or app_window_open():
            gone_since = None
            continue
        if not seen_any and now - started < 600:
            continue  # a janela ainda nao abriu (PC lento): espera ate 10 min
        gone_since = gone_since or now
        if now - gone_since > 6:
            FRIENDS.go_offline()
            server.shutdown()
            return


def main():
    if "--overlay" in sys.argv:  # processo do cronometro sobre o jogo
        from sann import overlay
        overlay.run(sys.argv)
        return
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    COVER_DIR.mkdir(parents=True, exist_ok=True)
    fix_rom_consoles()
    url = f"http://{HOST}:{PORT}/"
    headless = "--no-browser" in sys.argv
    try:
        server = Server((HOST, PORT), Handler)
    except OSError:
        if already_running():
            if not headless:
                open_window(url)  # segunda execucao: so mostra a janela da que ja esta aberta
            return
        msg = f"A porta {PORT} está ocupada por outro programa. Defina SANNSTATION_PORT para usar outra porta."
        print(msg)
        if FROZEN and IS_WIN:
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, msg, "SannStation", 0x10)
        sys.exit(1)
    print(f"SannStation {APP_VERSION} rodando em {url}")
    print(f"Dados em {DATA_DIR}")
    print("Feche a janela (ou Ctrl+C) para encerrar.")
    threading.Thread(target=friends_loop, daemon=True).start()
    if not headless:
        open_window(url)
        threading.Thread(target=watch_and_exit, args=(server, time.monotonic()), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
