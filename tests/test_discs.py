import struct
import tempfile
import unittest
from pathlib import Path

from helpers import iso9660, raw_cd
from sann import discs


class DetectDiscTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, data):
        p = self.dir / name
        p.write_bytes(data)
        return p

    def test_gamecube_and_wii_iso(self):
        gc = bytearray(0x400)
        gc[0x1C:0x20] = b"\xc2\x33\x9f\x3d"
        wii = bytearray(0x400)
        wii[0x18:0x1C] = b"\x5d\x1c\x9e\xa3"
        self.assertEqual(discs.detect_disc_console(self.write("a.iso", bytes(gc))), "gamecube")
        self.assertEqual(discs.detect_disc_console(self.write("b.iso", bytes(wii))), "wii")

    def test_rvz_gcz_wbfs(self):
        rvz = b"RVZ\x01".ljust(0x48, b"\x00") + struct.pack(">I", 2) + b"\x00" * 8
        gcz = b"\x01\xc0\x0b\xb1" + struct.pack("<I", 0)
        self.assertEqual(discs.detect_disc_console(self.write("a.rvz", rvz)), "wii")
        self.assertEqual(discs.detect_disc_console(self.write("a.gcz", gcz)), "gamecube")
        self.assertEqual(discs.detect_disc_console(self.write("a.wbfs", b"WBFS")), "wii")

    def test_ps2_iso_by_system_cnf(self):
        iso = iso9660("PLAYSTATION", {"SYSTEM.CNF": b"BOOT2 = cdrom0:\\SLUS_203.12;1\r\nVER = 1.00\r\n"})
        self.assertEqual(discs.detect_disc_console(self.write("ps2.iso", iso)), "ps2")

    def test_ps1_raw_bin_through_cue(self):
        iso = iso9660("PLAYSTATION", {"SYSTEM.CNF": b"BOOT = cdrom:\\SCUS_941.63;1\r\n"})
        self.write("game.bin", raw_cd(iso))
        cue = self.write("game.cue", b'FILE "game.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n')
        self.assertEqual(discs.detect_disc_console(cue), "ps1")

    def test_psp_iso(self):
        iso = iso9660("PSP GAME", dirs=("PSP_GAME",))
        self.assertEqual(discs.detect_disc_console(self.write("psp.iso", iso)), "psp")

    def test_sega_discs(self):
        sat = raw_cd(b"SEGA SEGASATURN ".ljust(2048 * 17, b"\x00"), mode=1)
        self.write("sat.bin", sat)
        cue = self.write("sat.cue", b'FILE "sat.bin" BINARY\n')
        self.assertEqual(discs.detect_disc_console(cue), "saturn")
        self.assertEqual(discs.detect_disc_console(self.write("dc.gdi", b"3\n")), "dreamcast")

    def test_pbp_ps1_vs_psp(self):
        def pbp(psar):
            head = bytearray(b"\x00PBP".ljust(0x28, b"\x00"))
            struct.pack_into("<I", head, 0x24, 0x28)
            return bytes(head) + psar
        self.assertEqual(discs.detect_disc_console(self.write("a.pbp", pbp(b"PSISOIMG0000"))), "ps1")
        self.assertEqual(discs.detect_disc_console(self.write("b.pbp", pbp(b"NPUMDIMG"))), "psp")

    def test_unknown_is_empty(self):
        self.assertEqual(discs.detect_disc_console(self.write("x.iso", b"\x00" * 100)), "")
        self.assertEqual(discs.detect_disc_console(self.dir / "missing.iso"), "")


class MultiDiscTest(unittest.TestCase):
    def test_disc_group_key(self):
        self.assertEqual(discs.disc_group_key("Final Fantasy VIII (USA) (Disc 2).cue"), ("Final Fantasy VIII (USA)", 2))
        self.assertEqual(discs.disc_group_key("Metal Gear Solid (Disc B).cue"), ("Metal Gear Solid", 2))
        self.assertEqual(discs.disc_group_key("Chrono Cross (CD 1).chd"), ("Chrono Cross", 1))
        self.assertEqual(discs.disc_group_key("Discworld (USA).cue"), (None, 0))

    def test_groups_into_m3u_and_skips_referenced(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            names = [f"FF8 (USA) (Disc {i}).cue" for i in (2, 1, 3)] + ["Crash (USA).cue"]
            for n in names:
                (d / n).write_text("x")
            out, created = discs.group_multi_disc([d / n for n in names])
            m3u = d / "FF8 (USA).m3u"
            self.assertEqual(created, [m3u])
            self.assertEqual(m3u.read_text().splitlines(), [f"FF8 (USA) (Disc {i}).cue" for i in (1, 2, 3)])
            self.assertEqual(sorted(p.name for p in out), ["Crash (USA).cue", "FF8 (USA).m3u"])
            # segundo escaneamento: o .m3u já existe e entra na lista; os discos citados por ele saem
            again, created2 = discs.group_multi_disc(sorted(d.iterdir()))
            self.assertEqual(created2, [])
            self.assertEqual(sorted(p.name for p in again), ["Crash (USA).cue", "FF8 (USA).m3u"])

    def test_skip_keeps_discs_already_in_library(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            files = [d / f"Game (Disc {i}).cue" for i in (1, 2)]
            for f in files:
                f.write_text("x")
            out, created = discs.group_multi_disc(files, skip=lambda f: f.name.endswith("1).cue"))
            self.assertEqual(created, [])
            self.assertEqual(out, files)


if __name__ == "__main__":
    unittest.main()
