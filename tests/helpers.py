"""Gera imagens de disco mínimas para os testes (só os bytes que a detecção lê)."""
import struct

SECTOR = 2048


def _dir_record(name, extent, size, is_dir=False):
    raw = name.encode("ascii")
    length = 33 + len(raw) + (len(raw) + 1) % 2
    rec = bytearray(length)
    rec[0] = length
    struct.pack_into("<I", rec, 2, extent)
    struct.pack_into("<I", rec, 10, size)
    rec[25] = 2 if is_dir else 0
    rec[32] = len(raw)
    rec[33:33 + len(raw)] = raw
    return bytes(rec)


def iso9660(system_id="", files=None, dirs=()):
    """Bytes de uma ISO9660 (setores de 2048) com arquivos {nome: conteúdo} e pastas na raiz."""
    files = files or {}
    sectors = [bytes(SECTOR)] * 16
    pvd = bytearray(SECTOR)
    pvd[0] = 1
    pvd[1:6] = b"CD001"
    pvd[8:40] = system_id.encode("ascii").ljust(32)
    root_extent = 17
    records = [_dir_record("\x00", root_extent, SECTOR, True), _dir_record("\x01", root_extent, SECTOR, True)]
    next_extent = 18
    data_sectors = []
    for name in dirs:
        records.append(_dir_record(name, next_extent, SECTOR, True))
        data_sectors.append(bytes(SECTOR))
        next_extent += 1
    for name, content in files.items():
        records.append(_dir_record(name + ";1", next_extent, len(content)))
        data_sectors.append(content.ljust(SECTOR, b"\x00"))
        next_extent += 1
    root = b"".join(records).ljust(SECTOR, b"\x00")
    pvd[156:190] = _dir_record("\x00", root_extent, SECTOR, True)[:34].ljust(34, b"\x00")
    sectors += [bytes(pvd), root] + data_sectors
    return b"".join(sectors)


def raw_cd(iso_bytes, mode=2):
    """Converte setores de 2048 em setores crus de 2352 (como um .bin de CD), com sync e cabeçalho."""
    out = bytearray()
    sync = b"\x00" + b"\xff" * 10 + b"\x00"
    for i in range(0, len(iso_bytes), SECTOR):
        header = sync + bytes([0, 2, 0, mode])
        sub = b"\x00" * 8 if mode == 2 else b""
        body = iso_bytes[i:i + SECTOR]
        out += (header + sub + body).ljust(2352, b"\x00")
    return bytes(out)
