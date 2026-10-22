"""Lê a configuração dos emuladores instalados: pastas de jogos, BIOS e saves.

Cada emulador guarda isso num lugar e num formato diferente. Aqui ficam os conhecidos (Dolphin, PCSX2,
DuckStation, PPSSPP, RetroArch, Cemu, Ryujinx, Azahar/Citra, RPCS3, mGBA, melonDS, Flycast, Mednafen,
ePSXe, xemu) e uma busca genérica de caminhos nos arquivos de configuração para os demais.

Nada aqui altera arquivos do emulador: só leitura.
"""
import fnmatch
import json
import os
import re
from pathlib import Path

IS_WIN = os.name == "nt"

# Família do emulador pelo nome do executável.
FAMILIES = [
    ("dolphin", ("dolphin*.exe",)), ("pcsx2", ("pcsx2*.exe",)), ("duckstation", ("duckstation*.exe",)),
    ("ppsspp", ("ppsspp*.exe",)), ("retroarch", ("retroarch*.exe",)), ("cemu", ("cemu*.exe",)),
    ("ryujinx", ("ryujinx*.exe",)), ("azahar", ("azahar*.exe", "citra*.exe", "lime3ds*.exe")),
    ("rpcs3", ("rpcs3*.exe",)), ("mgba", ("mgba*.exe",)), ("melonds", ("melonds*.exe",)),
    ("flycast", ("flycast*.exe",)), ("mednafen", ("mednafen*.exe",)), ("epsxe", ("epsxe*.exe",)),
    ("xemu", ("xemu*.exe",)), ("redream", ("redream*.exe",)),
]

CONFIG_EXTS = {".ini", ".cfg", ".conf", ".xml", ".json", ".toml", ".yml", ".yaml", ".lpl"}


def family_of(exe):
    name = re.split(r"[\\/]", str(exe))[-1].lower()  # aceita caminho do Windows em qualquer sistema
    for fam, pats in FAMILIES:
        if any(fnmatch.fnmatch(name, p) for p in pats):
            return fam
    return ""


def retroarch_core(args):
    """'swanstation' para args '-L "cores\\swanstation_libretro.dll" ...'."""
    m = re.search(r"cores[\\/]+([\w\-]+?)_libretro", args or "", re.I)
    return m.group(1).lower() if m else ""


# --------------------------------------------------------------------------- pastas do usuário

class Env:
    """Pastas do Windows usadas pelos emuladores (substituível nos testes)."""

    def __init__(self, appdata=None, localappdata=None, documents=None, home=None):
        self.home = Path(home or Path.home())
        self.appdata = Path(appdata or os.environ.get("APPDATA") or self.home / "AppData" / "Roaming")
        self.localappdata = Path(localappdata or os.environ.get("LOCALAPPDATA") or self.home / "AppData" / "Local")
        self.documents = Path(documents or _documents_dir() or self.home / "Documents")


def _documents_dir():
    """Pasta Documentos de verdade (pode estar no OneDrive ou em outro disco)."""
    if not IS_WIN:
        return None
    try:
        import ctypes
        import uuid
        from ctypes import wintypes

        class GUID(ctypes.Structure):
            _fields_ = [("d1", ctypes.c_uint32), ("d2", ctypes.c_uint16), ("d3", ctypes.c_uint16),
                        ("d4", ctypes.c_ubyte * 8)]

        u = uuid.UUID("FDD39AD0-238F-46AF-ADB4-6C85480369C7")
        guid = GUID(u.time_low, u.time_mid, u.time_hi_version, (ctypes.c_ubyte * 8)(*u.bytes[8:]))
        out = wintypes.LPWSTR()
        if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(out)) != 0:
            return None
        try:
            return Path(out.value)
        finally:
            ctypes.windll.ole32.CoTaskMemFree(out)
    except (OSError, AttributeError, ValueError):
        return None


# --------------------------------------------------------------------------- leitura de arquivos

def read_text(path, limit=4 * 1024 * 1024):
    try:
        p = Path(path)
        if not p.is_file() or p.stat().st_size > limit:
            return ""
        return p.read_text("utf-8", errors="ignore")
    except OSError:
        return ""


def parse_ini(text):
    """{seção minúscula: [(chave, valor), ...]} — aceita chaves repetidas (o PCSX2 e o DuckStation usam)."""
    out, section = {}, ""
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line[0] in "#;":
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip().lower()
            continue
        if "=" in line:
            key, value = line.split("=", 1)
            out.setdefault(section, []).append((key.strip(), value.strip().strip('"')))
    return out


def ini_values(ini, section, key):
    return [v for k, v in ini.get(section.lower(), []) if k.lower() == key.lower()]


def parse_retroarch_cfg(text):
    out = {}
    for line in text.splitlines():
        m = re.match(r'\s*([\w\-]+)\s*=\s*"?(.*?)"?\s*$', line)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def _resolve(base, value):
    """Caminho de uma configuração: absoluto, relativo à pasta do emulador, ou ':\\x' (RetroArch)."""
    if not value or value.lower() == "default":
        return None
    value = value.strip().strip('"')
    if value.startswith(":"):
        value = value[1:].lstrip("\\/")
        return Path(base) / value
    p = Path(value.replace("/", os.sep) if IS_WIN else value)
    return p if p.is_absolute() or re.match(r"^[A-Za-z]:[\\/]", value) else Path(base) / p


def _first_existing(*paths):
    for p in paths:
        if p and Path(p).exists():
            return Path(p)
    return None


# --------------------------------------------------------------------------- onde cada emulador guarda os dados

def data_dir(family, exe, env=None):
    """Pasta de dados/configuração do emulador (portátil ao lado do .exe, ou a do usuário)."""
    env = env or Env()
    exe_dir = Path(exe).parent
    if family == "dolphin":
        if (exe_dir / "portable.txt").exists():
            return exe_dir / "User"
        reg = _registry_value(r"Software\Dolphin Emulator", "UserConfigPath")
        return _first_existing(reg, env.appdata / "Dolphin Emulator", env.documents / "Dolphin Emulator") \
            or env.appdata / "Dolphin Emulator"
    if family == "pcsx2":
        if (exe_dir / "portable.ini").exists() or (exe_dir / "portable.txt").exists():
            return exe_dir
        return env.documents / "PCSX2"
    if family == "duckstation":
        if (exe_dir / "portable.txt").exists() or (exe_dir / "settings.ini").exists():
            return exe_dir
        return _first_existing(env.localappdata / "DuckStation", env.documents / "DuckStation") \
            or env.localappdata / "DuckStation"
    if family == "ppsspp":
        installed = exe_dir / "installed.txt"
        if installed.exists():
            custom = read_text(installed).strip().splitlines()
            return Path(custom[0]) if custom and custom[0].strip() else env.documents / "PPSSPP"
        return exe_dir / "memstick"
    if family == "retroarch":
        return exe_dir if (exe_dir / "retroarch.cfg").exists() else _first_existing(env.appdata / "RetroArch") or exe_dir
    if family == "cemu":
        return exe_dir if (exe_dir / "settings.xml").exists() or (exe_dir / "portable").is_dir() \
            else env.appdata / "Cemu"
    if family == "ryujinx":
        return exe_dir / "portable" if (exe_dir / "portable").is_dir() else env.appdata / "Ryujinx"
    if family == "azahar":
        if (exe_dir / "user").is_dir():
            return exe_dir / "user"
        return _first_existing(env.appdata / "Azahar", env.appdata / "Lime3DS", env.appdata / "Citra") \
            or env.appdata / "Azahar"
    if family == "mgba":
        return exe_dir if (exe_dir / "portable.ini").exists() else env.appdata / "mGBA"
    if family == "flycast":
        return exe_dir if (exe_dir / "emu.cfg").exists() else _first_existing(env.appdata / "flycast") or exe_dir
    if family == "xemu":
        return exe_dir if (exe_dir / "xemu.toml").exists() else env.appdata / "xemu" / "xemu"
    return exe_dir  # rpcs3, melonDS, mednafen, ePSXe e desconhecidos: ao lado do executável


def _registry_value(key, name):
    if not IS_WIN:
        return None
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as k:
            return Path(winreg.QueryValueEx(k, name)[0])
    except OSError:
        return None


# --------------------------------------------------------------------------- pastas de jogos

def rom_folders(family, exe, env=None):
    """Pastas de jogos configuradas no emulador: [{'dir', 'recursive', 'console'}]. console '' = qualquer."""
    env = env or Env()
    base = data_dir(family, exe, env)
    found = []

    def add(path, recursive=True, console=""):
        if path:
            found.append({"dir": str(path), "recursive": recursive, "console": console})

    if family == "dolphin":
        ini = parse_ini(read_text(base / "Config" / "Dolphin.ini"))
        recursive = (ini_values(ini, "General", "RecursiveISOPaths") or ["False"])[0].lower() == "true"
        for k, v in ini.get("general", []):
            if re.fullmatch(r"ISOPath\d+", k, re.I):
                add(_resolve(base, v), recursive)
    elif family in ("pcsx2", "duckstation"):
        ini = parse_ini(read_text(base / ("inis/PCSX2.ini" if family == "pcsx2" else "settings.ini")))
        for v in ini_values(ini, "GameList", "RecursivePaths"):
            add(_resolve(base, v), True)
        for v in ini_values(ini, "GameList", "Paths"):
            add(_resolve(base, v), False)
    elif family == "ppsspp":
        ini = parse_ini(read_text(base / "PSP" / "SYSTEM" / "ppsspp.ini"))
        for v in ini_values(ini, "General", "CurrentDirectory"):
            add(_resolve(base, v), True)
        for _, v in ini.get("pinnedpaths", []):
            add(_resolve(base, v), True)
        for k, v in ini.get("recent", []):
            if k.lower().startswith("filename"):
                p = _resolve(base, v)
                add(p.parent if p else None, False)
    elif family == "retroarch":
        found += _retroarch_folders(exe, base)
    elif family == "cemu":
        text = read_text(base / "settings.xml")
        for m in re.finditer(r"<GamePaths>(.*?)</GamePaths>", text, re.S):
            for e in re.findall(r"<Entry>(.*?)</Entry>", m.group(1)):
                add(_resolve(base, e.strip()), True)
    elif family == "ryujinx":
        try:
            cfg = json.loads(read_text(base / "Config.json") or "{}")
        except ValueError:
            cfg = {}
        for d in cfg.get("game_dirs", []) or []:
            add(_resolve(base, str(d)), True)
    elif family == "azahar":
        ini = parse_ini(read_text(base / "config" / "qt-config.ini"))
        for section in ini.values():
            for k, v in section:
                if re.search(r"gamedirs\\\d+\\path$", k, re.I) and v and not v.startswith("INSTALLED") \
                        and not v.startswith("SYSTEM"):
                    add(_resolve(base, v), True)
    elif family == "rpcs3":
        for line in read_text(base / "config" / "games.yml").splitlines():
            m = re.match(r"^\s*[A-Z]{4}\d{5}\s*:\s*(.+?)\s*$", line)
            if m:
                game_dir = _resolve(base, m.group(1).strip("'\""))
                add(game_dir.parent if game_dir else None, False)
    elif family == "mgba":
        ini = parse_ini(read_text(base / "config.ini"))
        for v in ini_values(ini, "ports.qt", "lastDirectory"):
            add(_resolve(base, v), False)
    elif family == "melonds":
        for name in ("melonDS.toml", "melonDS.ini"):
            for m in re.finditer(r"LastROMFolder\s*=\s*\"?([^\"\r\n]+)", read_text(base / name)):
                add(_resolve(base, m.group(1)), False)
    elif family == "flycast":
        ini = parse_ini(read_text(base / "emu.cfg"))
        for v in ini_values(ini, "config", "Dreamcast.ContentPath"):
            for part in v.split(";"):
                add(_resolve(base, part), True)
    if not found:
        found = [{"dir": d, "recursive": True, "console": ""} for d in generic_folders(exe, base)]
    return _dedupe_existing(found)


def _retroarch_folders(exe, base):
    cfg = parse_retroarch_cfg(read_text(base / "retroarch.cfg"))
    exe_dir = Path(exe).parent
    out = []
    playlists = _resolve(exe_dir, cfg.get("playlist_directory", "")) or base / "playlists"
    try:
        lpls = sorted(Path(playlists).glob("*.lpl"))
    except OSError:
        lpls = []
    for lpl in lpls:
        system = lpl.stem  # "Nintendo - Super Nintendo Entertainment System"
        dirs = set()
        for rom in _lpl_paths(read_text(lpl)):
            rom = rom.split("#")[0]  # "jogo.zip#jogo.sfc": arquivo dentro do .zip
            p = _resolve(exe_dir, rom)
            if p:
                dirs.add(p.parent)
        for d in sorted(dirs, key=str):
            out.append({"dir": str(d), "recursive": False, "system": system, "console": ""})
    browser = _resolve(exe_dir, cfg.get("rgui_browser_directory", ""))
    if browser:
        out.append({"dir": str(browser), "recursive": True, "console": ""})
    return out


def _lpl_paths(text):
    text = text.strip()
    if text.startswith("{"):
        try:
            return [str(item.get("path", "")) for item in json.loads(text).get("items", []) if item.get("path")]
        except ValueError:
            return []
    lines = text.splitlines()  # formato antigo: 6 linhas por jogo, a primeira é o caminho
    return [lines[i] for i in range(0, len(lines), 6) if lines[i].strip()]


PATH_RE = re.compile(r"[A-Za-z]:[\\/][^\"'<>|\r\n\t=;,]*")


def generic_folders(exe, base=None, limit=60):
    """Caminhos absolutos citados nos arquivos de configuração do emulador (para emuladores sem leitor próprio)."""
    exe_dir = Path(exe).parent
    roots = {exe_dir, Path(base)} if base else {exe_dir}
    found = []
    for root in roots:
        for cfg in _config_files(root):
            for m in PATH_RE.finditer(read_text(cfg, limit=512 * 1024)):
                p = Path(m.group(0).strip().rstrip("\\/").replace("\\\\", "\\"))
                if not p.suffix:  # pasta (se for arquivo, a pasta dele)
                    found.append(str(p))
                elif len(p.suffix) <= 5:
                    found.append(str(p.parent))
                if len(found) >= limit:
                    return found
    return found


def _config_files(root, depth=2):
    out = []
    stack = [(Path(root), 0)]
    while stack:
        folder, level = stack.pop()
        try:
            with os.scandir(folder) as it:
                entries = list(it)
            for entry in entries:
                if entry.is_dir(follow_symlinks=False):
                    if level < depth and entry.name.lower() not in ("cores", "shaders", "assets", "cache", "logs"):
                        stack.append((Path(entry.path), level + 1))
                elif Path(entry.name).suffix.lower() in CONFIG_EXTS:
                    out.append(Path(entry.path))
        except OSError:
            continue
    return out[:200]


def _dedupe_existing(items):
    out, seen = [], set()
    for it in items:
        key = os.path.normcase(os.path.normpath(it["dir"]))
        if key in seen:
            continue
        seen.add(key)
        if Path(it["dir"]).is_dir():
            out.append(it)
    return out


# --------------------------------------------------------------------------- BIOS

PS1_BIOS = ["scph5500.bin", "scph5501.bin", "scph5502.bin", "scph1001.bin", "scph7001.bin", "scph7502.bin",
            "scph101.bin", "scph1000.bin", "ps-22a.bin", "ps-30a.bin", "ps-41a.bin"]
SATURN_BIOS = ["sega_101.bin", "mpr-17933.bin"]
SEGACD_BIOS = ["bios_CD_U.bin", "bios_CD_E.bin", "bios_CD_J.bin"]

# (console, núcleo do RetroArch) -> (subpasta dentro de 'system', arquivos aceitos)
RETROARCH_BIOS = {
    ("ps1", "swanstation"): ("", PS1_BIOS),
    ("ps1", "mednafen_psx_hw"): ("", ["scph5500.bin", "scph5501.bin", "scph5502.bin"]),
    ("ps1", "mednafen_psx"): ("", ["scph5500.bin", "scph5501.bin", "scph5502.bin"]),
    ("ps2", "pcsx2"): ("pcsx2/bios", ["*.bin"]),
    ("segacd", "genesis_plus_gx"): ("", SEGACD_BIOS),
    ("saturn", "mednafen_saturn"): ("", SATURN_BIOS),
    ("pcecd", "mednafen_pce_fast"): ("", ["syscard3.pce"]),
    ("pcfx", "mednafen_pcfx"): ("", ["pcfx.rom"]),
    ("dreamcast", "flycast"): ("dc", ["dc_boot.bin"]),
    ("naomi", "flycast"): ("dc", ["naomi.zip"]),
    ("fds", "mesen"): ("", ["disksys.rom"]),
}
MEDNAFEN_BIOS = {"ps1": ["scph5500.bin", "scph5501.bin", "scph5502.bin"], "saturn": SATURN_BIOS,
                 "pcecd": ["syscard3.pce"], "pcfx": ["pcfx.rom"]}


def _has_file(folder, patterns, min_size=0, max_size=None):
    try:
        with os.scandir(folder) as it:
            entries = list(it)
        for entry in entries:
            if not entry.is_file():
                continue
            size = entry.stat().st_size
            if size < min_size or (max_size and size > max_size):
                continue
            name = entry.name.lower()
            if any(fnmatch.fnmatch(name, p.lower()) for p in patterns):
                return True
    except OSError:
        return False
    return False


def bios_status(exe, args, console, env=None):
    """Verifica se o emulador tem a BIOS que este console precisa.

    Devolve None quando não há o que checar (console sem BIOS ou emulador que não precisa/não conhecemos),
    ou {"ok": bool, "dir": pasta onde ela deve estar, "files": nomes aceitos, "label": descrição}.
    """
    env = env or Env()
    family = family_of(exe)
    base = data_dir(family, exe, env)
    exe_dir = Path(exe).parent

    def result(folder, files, ok, label=""):
        return {"ok": bool(ok), "dir": str(folder), "files": files, "label": label}

    if family == "duckstation" and console == "ps1":
        ini = parse_ini(read_text(base / "settings.ini"))
        folder = _resolve(base, (ini_values(ini, "BIOS", "SearchDirectory") or ["bios"])[0])
        ok = _has_file(folder, ["*"], 512 * 1024, 4 * 1024 * 1024 + 1)  # a DuckStation reconhece pelo conteúdo
        return result(folder, ["scph5501.bin (ou outra BIOS de PS1)"], ok, "BIOS do PlayStation")
    if family == "pcsx2" and console == "ps2":
        ini = parse_ini(read_text(base / "inis" / "PCSX2.ini"))
        folder = _resolve(base, (ini_values(ini, "Folders", "Bios") or ["bios"])[0])
        ok = _has_file(folder, ["*"], 4 * 1024 * 1024, 16 * 1024 * 1024)
        return result(folder, ["BIOS do PS2 (arquivo .bin de 4 MB)"], ok, "BIOS do PlayStation 2")
    if family == "epsxe" and console == "ps1":
        folder = exe_dir / "bios"
        return result(folder, ["scph1001.bin (ou outra BIOS de PS1)"],
                      _has_file(folder, ["*"], 512 * 1024, 512 * 1024), "BIOS do PlayStation")
    if family == "mednafen" and console in MEDNAFEN_BIOS:
        cfg = read_text(exe_dir / "mednafen.cfg")
        m = re.search(r"^filesys\.path_firmware\s+(.+)$", cfg, re.M)
        folder = _resolve(exe_dir, m.group(1).strip()) if m else exe_dir / "firmware"
        files = MEDNAFEN_BIOS[console]
        ok = _has_file(folder, files) or _has_file(exe_dir, files)
        return result(folder, files, ok)
    if family == "flycast" and console in ("dreamcast", "naomi"):
        folder = base / "data"
        files = ["dc_boot.bin"] if console == "dreamcast" else ["naomi.zip"]
        return result(folder, files, _has_file(folder, files) or _has_file(base, files))
    if family == "retroarch":
        key = (console, retroarch_core(args))
        if key not in RETROARCH_BIOS:
            return None
        cfg = parse_retroarch_cfg(read_text(base / "retroarch.cfg"))
        system = _resolve(exe_dir, cfg.get("system_directory", "")) or exe_dir / "system"
        sub, files = RETROARCH_BIOS[key]
        folder = Path(system) / sub if sub else Path(system)
        return result(folder, files, _has_file(folder, files))
    if family == "ryujinx" and console == "switch":
        folder = base / "system"
        return result(folder, ["prod.keys"], _has_file(folder, ["prod.keys"]), "Chaves do Switch")
    if family == "rpcs3" and console == "ps3":
        folder = exe_dir / "dev_flash"
        ok = (folder / "vsh").is_dir() or (folder / "sys" / "external").is_dir()
        return result(folder, ["firmware do PS3 (Arquivo → Instalar firmware no RPCS3)"], ok, "Firmware do PS3")
    if family == "xemu" and console == "xbox":
        text = read_text(base / "xemu.toml")
        needed = {k: re.search(rf"^\s*{k}\s*=\s*['\"](.+?)['\"]", text, re.M) for k in
                  ("bootrom_path", "flashrom_path", "hdd_path")}
        missing = [k for k, m in needed.items() if not (m and Path(m.group(1)).is_file())]
        return result(base, ["MCPX boot ROM, BIOS (flash) e disco rígido configurados no xemu"], not missing,
                      "Arquivos do Xbox")
    return None


# --------------------------------------------------------------------------- saves

def save_dirs(exe, args="", env=None):
    """Pastas de saves e estados do emulador que existem: [{'label', 'dir', 'kind': 'saves'|'states'}]."""
    env = env or Env()
    family = family_of(exe)
    base = data_dir(family, exe, env)
    exe_dir = Path(exe).parent
    items = []

    def add(label, path, kind="saves"):
        if path:
            items.append({"label": label, "dir": str(path), "kind": kind})

    if family == "dolphin":
        add("Cartões de memória (GameCube)", base / "GC")
        add("Saves do Wii", base / "Wii" / "title")
        add("Estados salvos", base / "StateSaves", "states")
    elif family == "pcsx2":
        ini = parse_ini(read_text(base / "inis" / "PCSX2.ini"))
        add("Cartões de memória", _resolve(base, (ini_values(ini, "Folders", "MemoryCards") or ["memcards"])[0]))
        add("Estados salvos", _resolve(base, (ini_values(ini, "Folders", "Savestates") or ["sstates"])[0]), "states")
    elif family == "duckstation":
        ini = parse_ini(read_text(base / "settings.ini"))
        add("Cartões de memória", _resolve(base, (ini_values(ini, "MemoryCards", "Directory") or ["memcards"])[0]))
        add("Estados salvos", base / "savestates", "states")
    elif family == "ppsspp":
        add("Saves", base / "PSP" / "SAVEDATA")
        add("Estados salvos", base / "PSP" / "PPSSPP_STATE", "states")
    elif family == "retroarch":
        cfg = parse_retroarch_cfg(read_text(base / "retroarch.cfg"))
        add("Saves", _resolve(exe_dir, cfg.get("savefile_directory", "")) or exe_dir / "saves")
        add("Estados salvos", _resolve(exe_dir, cfg.get("savestate_directory", "")) or exe_dir / "states", "states")
    elif family == "cemu":
        add("Saves", base / "mlc01" / "usr" / "save")
    elif family == "ryujinx":
        add("Saves", base / "bis" / "user" / "save")
    elif family == "azahar":
        add("Saves (SD)", base / "sdmc" / "Nintendo 3DS")
        add("Estados salvos", base / "states", "states")
    elif family == "rpcs3":
        add("Saves", exe_dir / "dev_hdd0" / "home" / "00000001" / "savedata")
    elif family == "flycast":
        add("Saves (VMU)", base / "data")
    elif family == "mednafen":
        add("Saves", exe_dir / "sav")
        add("Estados salvos", exe_dir / "mcs", "states")
    elif family == "epsxe":
        add("Cartões de memória", exe_dir / "memcards")
        add("Estados salvos", exe_dir / "sstates", "states")
    elif family == "xemu":
        add("Disco rígido do Xbox (saves)", base)
    else:
        for name, kind in (("saves", "saves"), ("save", "saves"), ("sav", "saves"), ("memcards", "saves"),
                           ("states", "states"), ("savestates", "states"), ("sstates", "states")):
            add(name, exe_dir / name, kind)
    return [it for it in items if Path(it["dir"]).is_dir()]
