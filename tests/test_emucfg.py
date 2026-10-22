import json
import tempfile
import unittest
from pathlib import Path

from sann import emucfg


class EmuCfgTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.env = emucfg.Env(appdata=self.root / "appdata", localappdata=self.root / "local",
                              documents=self.root / "docs", home=self.root)
        self.games = self.root / "Games"
        self.games.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def exe(self, rel):
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("exe")
        return p

    def test_family_and_core(self):
        self.assertEqual(emucfg.family_of(r"C:\Emu\duckstation-qt-x64-ReleaseLTCG.exe"), "duckstation")
        self.assertEqual(emucfg.family_of("PCSX2-Qt.exe"), "pcsx2")
        self.assertEqual(emucfg.family_of("snes9x.exe"), "")
        self.assertEqual(emucfg.retroarch_core('-L "cores\\swanstation_libretro.dll" "{rom}"'), "swanstation")

    def test_duckstation_portable_folders_and_bios(self):
        exe = self.exe("Duck/duckstation-qt.exe")
        (exe.parent / "portable.txt").write_text("")
        (exe.parent / "settings.ini").write_text(
            f"[GameList]\nRecursivePaths = {self.games}\nPaths = {self.root / 'Other'}\n[BIOS]\nSearchDirectory = bios\n")
        (self.root / "Other").mkdir()
        folders = emucfg.rom_folders("duckstation", exe, self.env)
        self.assertEqual([(f["dir"], f["recursive"]) for f in folders],
                         [(str(self.games), True), (str(self.root / "Other"), False)])
        status = emucfg.bios_status(exe, "", "ps1", self.env)
        self.assertFalse(status["ok"])
        self.assertEqual(status["dir"], str(exe.parent / "bios"))
        (exe.parent / "bios").mkdir()
        (exe.parent / "bios" / "scph5501.bin").write_bytes(b"\x00" * 512 * 1024)
        self.assertTrue(emucfg.bios_status(exe, "", "ps1", self.env)["ok"])
        self.assertIsNone(emucfg.bios_status(exe, "", "snes", self.env))

    def test_pcsx2_documents_folder(self):
        exe = self.exe("PCSX2/pcsx2-qt.exe")
        ini = self.env.documents / "PCSX2" / "inis" / "PCSX2.ini"
        ini.parent.mkdir(parents=True)
        ini.write_text(f"[GameList]\nRecursivePaths = {self.games}\nRecursivePaths = {self.root / 'missing'}\n")
        self.assertEqual([f["dir"] for f in emucfg.rom_folders("pcsx2", exe, self.env)], [str(self.games)])
        status = emucfg.bios_status(exe, "", "ps2", self.env)
        self.assertEqual(status["dir"], str(self.env.documents / "PCSX2" / "bios"))

    def test_dolphin_iso_paths(self):
        exe = self.exe("Dolphin/Dolphin.exe")
        (exe.parent / "portable.txt").write_text("")
        cfg = exe.parent / "User" / "Config" / "Dolphin.ini"
        cfg.parent.mkdir(parents=True)
        cfg.write_text(f"[General]\nISOPaths = 1\nISOPath0 = {self.games}\nRecursiveISOPaths = True\n")
        (exe.parent / "User" / "GC").mkdir()
        self.assertEqual(emucfg.rom_folders("dolphin", exe, self.env),
                         [{"dir": str(self.games), "recursive": True, "console": ""}])
        self.assertEqual([d["label"] for d in emucfg.save_dirs(exe, "", self.env)], ["Cartões de memória (GameCube)"])

    def test_retroarch_playlists_bios_and_saves(self):
        exe = self.exe("RetroArch/retroarch.exe")
        ra = exe.parent
        (ra / "retroarch.cfg").write_text('playlist_directory = ":\\playlists"\nsystem_directory = "default"\n'
                                          f'rgui_browser_directory = "{self.games}"\n')
        (ra / "playlists").mkdir()
        snes = self.root / "SNES"
        snes.mkdir()
        lpl = {"items": [{"path": str(snes / "Chrono Trigger.zip#Chrono Trigger.sfc"), "label": "Chrono Trigger"}]}
        (ra / "playlists" / "Nintendo - Super Nintendo Entertainment System.lpl").write_text(json.dumps(lpl))
        folders = emucfg.rom_folders("retroarch", exe, self.env)
        self.assertEqual(folders[0]["dir"], str(snes))
        self.assertEqual(folders[0]["system"], "Nintendo - Super Nintendo Entertainment System")
        self.assertIn(str(self.games), [f["dir"] for f in folders])
        status = emucfg.bios_status(exe, '-L "cores\\swanstation_libretro.dll" "{rom}"', "ps1", self.env)
        self.assertEqual(status["dir"], str(ra / "system"))
        self.assertFalse(status["ok"])
        (ra / "saves").mkdir()
        self.assertEqual([d["kind"] for d in emucfg.save_dirs(exe, "", self.env)], ["saves"])

    def test_generic_folders_from_config_text(self):
        exe = self.exe("Snes9x/snes9x-x64.exe")
        (exe.parent / "snes9x.conf").write_text(f"[Settings\\Win\\Files]\nDir:Roms = {self.games}\n")
        found = emucfg.rom_folders("", exe, self.env)
        # caminho POSIX (os testes rodam em Linux também): a busca genérica é para caminhos do Windows
        self.assertIsInstance(found, list)
        self.assertEqual(emucfg.PATH_RE.findall('ROMs="D:\\Jogos\\SNES"; outro'), ["D:\\Jogos\\SNES"])


if __name__ == "__main__":
    unittest.main()
