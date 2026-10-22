"""Imagens de disco: qual console é (lendo o cabeçalho) e jogos de vários discos (.m3u).

A extensão .iso (ou .bin) é usada por vários consoles. Olhar dentro do arquivo evita, por exemplo,
que uma ISO de PS2 numa pasta misturada entre como jogo de GameCube.
Só lê alguns KB do começo do arquivo: rápido mesmo em pastas grandes.
"""
import re
import struct
from pathlib import Path

SECTOR = 2048
RAW_SECTOR = 2352
SYNC = b"\x00" + b"\xff" * 10 + b"\x00"

# Assinaturas no começo da área de dados (setor 0) de discos da Sega/3DO.
SEGA_MAGIC = ((b"SEGA SEGASATURN", "saturn"), (b"SEGADISCSYSTEM", "segacd"), (b"SEGA SEGAKATANA", "dreamcast"))

DISC_EXTS = {".iso", ".gcm", ".img", ".bin", ".cue", ".rvz", ".wia", ".gcz", ".wbfs", ".ciso", ".pbp",
             ".gdi", ".cdi", ".m3u", ".xiso"}


class _Track:
    """Lê setores de dados de uma imagem 'cozida' (2048 bytes/setor) ou 'crua' (2352, como .bin de CD)."""

    def __init__(self, fh, raw_offset=None):
        self.fh = fh
        self.raw_offset = raw_offset  # None = setores de 2048; senão deslocamento dos dados dentro de 2352

    def read(self, sector, size=SECTOR):
        if self.raw_offset is None:
            self.fh.seek(sector * SECTOR)
        else:
            self.fh.seek(sector * RAW_SECTOR + self.raw_offset)
        return self.fh.read(size)


def _open_track(fh):
    head = fh.read(16)
    fh.seek(0)
    if head[:12] == SYNC:  # setor cru de CD: modo 1 tem 16 bytes de cabeçalho, modo 2 tem 24
        return _Track(fh, 16 if head[15] == 1 else 24)
    return _Track(fh)


def _iso9660_root(track):
    """Nomes (maiúsculos, sem ';1') do diretório raiz de um ISO9660, ou None se não for ISO9660."""
    pvd = track.read(16)
    if pvd[1:6] != b"CD001":
        return None, b""
    system_id = pvd[8:40]
    root = pvd[156:190]
    extent = struct.unpack_from("<I", root, 2)[0]
    length = min(struct.unpack_from("<I", root, 10)[0], 64 * 1024)
    data = b"".join(track.read(extent + i) for i in range((length + SECTOR - 1) // SECTOR))
    names, entries, pos = set(), {}, 0
    while pos < len(data):
        rec_len = data[pos]
        if rec_len == 0:  # fim dos registros neste setor: pula para o próximo
            pos = (pos // SECTOR + 1) * SECTOR
            continue
        name_len = data[pos + 32]
        name = data[pos + 33:pos + 33 + name_len].decode("ascii", "ignore").upper().split(";")[0]
        names.add(name)
        entries[name] = (struct.unpack_from("<I", data, pos + 2)[0], struct.unpack_from("<I", data, pos + 10)[0])
        pos += rec_len
    return {"names": names, "entries": entries}, system_id


def _detect_track(track):
    sector0 = track.read(0, 64)
    for magic, console in SEGA_MAGIC:
        if sector0.startswith(magic):
            return console
    if sector0.startswith(b"\x01ZZZZZ\x01"):
        return "3do"
    root, system_id = _iso9660_root(track)
    if root is None:
        return ""
    names = root["names"]
    if "PSP_GAME" in names or system_id.startswith(b"PSP GAME"):
        return "psp"
    if "SYSTEM.CNF" in names:
        extent, size = root["entries"]["SYSTEM.CNF"]
        cnf = track.read(extent, min(size, SECTOR)).upper()
        return "ps2" if b"BOOT2" in cnf else "ps1"
    if system_id.startswith(b"PLAYSTATION"):
        return "ps1"
    return ""


def _detect_plain(path):
    with open(path, "rb") as fh:
        head = fh.read(0x40)
        if len(head) >= 0x20:
            if head[0x1C:0x20] == b"\xc2\x33\x9f\x3d":
                return "gamecube"
            if head[0x18:0x1C] == b"\x5d\x1c\x9e\xa3":
                return "wii"
        fh.seek(0x10000)
        if fh.read(20) == b"MICROSOFT*XBOX*MEDIA":
            return "xbox"
        fh.seek(0)
        return _detect_track(_open_track(fh))


def _cue_data_file(cue):
    """Primeiro arquivo (faixa de dados) citado no .cue."""
    try:
        text = cue.read_text("utf-8", errors="ignore")
    except OSError:
        return None
    m = re.search(r'^\s*FILE\s+"([^"]+)"', text, re.M | re.I) or re.search(r"^\s*FILE\s+(\S+)", text, re.M | re.I)
    return cue.parent / m.group(1) if m else None


def m3u_entries(m3u):
    """Arquivos listados num .m3u (caminhos relativos à pasta dele)."""
    try:
        lines = Path(m3u).read_text("utf-8", errors="ignore").splitlines()
    except OSError:
        return []
    return [Path(m3u).parent / line.strip() for line in lines if line.strip() and not line.startswith("#")]


def detect_disc_console(path):
    """'ps1', 'ps2', 'psp', 'gamecube', 'wii', 'saturn', 'segacd', 'dreamcast', 'xbox', '3do' ou '' (não sei)."""
    path = Path(path)
    ext = path.suffix.lower()
    try:
        if ext == ".wbfs":
            return "wii"
        if ext in (".gdi", ".cdi"):
            return "dreamcast"
        if ext == ".ciso":
            return "gamecube"
        if ext in (".rvz", ".wia"):
            with open(path, "rb") as fh:
                head = fh.read(0x50)
            if head[:3] in (b"RVZ", b"WIA") and len(head) >= 0x4C:
                return {1: "gamecube", 2: "wii"}.get(struct.unpack_from(">I", head, 0x48)[0], "")
            return ""
        if ext == ".gcz":
            with open(path, "rb") as fh:
                head = fh.read(8)
            if head[:4] == b"\x01\xc0\x0b\xb1":
                return {0: "gamecube", 1: "wii"}.get(struct.unpack_from("<I", head, 4)[0], "")
            return ""
        if ext == ".pbp":
            with open(path, "rb") as fh:
                head = fh.read(0x28)
                if head[:4] != b"\x00PBP":
                    return ""
                fh.seek(struct.unpack_from("<I", head, 0x24)[0])  # data.psar: jogos de PS1 trazem a ISO aqui
                psar = fh.read(16)
            return "ps1" if psar.startswith((b"PSISOIMG", b"PSTITLEIMG")) else "psp"
        if ext == ".cue":
            data = _cue_data_file(path)
            return detect_disc_console(data) if data and data.suffix.lower() != ".cue" and data.is_file() else ""
        if ext == ".m3u":
            first = next((p for p in m3u_entries(path) if p.suffix.lower() != ".m3u"), None)
            return detect_disc_console(first) if first and first.is_file() else ""
        if ext in (".iso", ".gcm", ".img", ".bin", ".xiso"):
            return _detect_plain(path)
    except (OSError, struct.error, IndexError, ValueError):
        return ""
    return ""


# --------------------------------------------------------------------------- jogos de vários discos

DISC_RE = re.compile(r"\s*[\(\[]?\b(?:disc|disk|cd|disco)\s*([0-9]+|[a-d])\b(?:\s*of\s*\d+)?[\)\]]?", re.I)


def disc_group_key(path):
    """('Final Fantasy VIII (USA)', 2) para 'Final Fantasy VIII (USA) (Disc 2).cue'; (None, 0) se não for disco N."""
    stem = Path(path).stem
    m = DISC_RE.search(stem)
    if not m:
        return None, 0
    token = m.group(1).lower()
    number = int(token) if token.isdigit() else "abcd".index(token) + 1
    base = (stem[:m.start()] + stem[m.end():]).strip(" -_")
    base = re.sub(r"\s{2,}", " ", base)
    return base, number


def group_multi_disc(files, write=True, skip=None):
    """Junta 'Jogo (Disc 1)', 'Jogo (Disc 2)'… num .m3u ao lado deles.

    Recebe a lista de arquivos de um escaneamento e devolve (arquivos, m3u_criados): os discos de um mesmo
    jogo são trocados pelo .m3u. Arquivos já citados por um .m3u existente na pasta também saem da lista,
    para o jogo não aparecer duas vezes. Se não der para gravar o .m3u (pasta só leitura), mantém os discos.
    skip(arquivo) -> True deixa o grupo daquele disco como está (ex.: discos que já estão na biblioteca).
    """
    files = [Path(f) for f in files]
    referenced = set()
    for f in files:
        if f.suffix.lower() == ".m3u":
            referenced.update(p.resolve() for p in m3u_entries(f))
    groups = {}
    for f in files:
        if f.suffix.lower() == ".m3u" or f.resolve() in referenced:
            continue
        base, number = disc_group_key(f)
        if base:
            groups.setdefault((f.parent, base.lower(), f.suffix.lower()), []).append((number, f, base))
    replaced, created = {}, []
    for (folder, _, _), discs in groups.items():
        if len(discs) < 2 or (skip and any(skip(f) for _, f, _ in discs)):
            continue
        discs.sort()
        m3u = folder / f"{discs[0][2]}.m3u"
        if not m3u.exists():
            if not write:
                continue
            try:
                m3u.write_text("\n".join(f.name for _, f, _ in discs) + "\n", "utf-8")
                created.append(m3u)
            except OSError:
                continue
        for _, f, _ in discs:
            replaced[f] = m3u
    out, seen = [], set()
    for f in files:
        if f.resolve() in referenced and f.suffix.lower() != ".m3u":
            continue
        target = replaced.get(f, f)
        if target not in seen:
            seen.add(target)
            out.append(target)
    return out, created
