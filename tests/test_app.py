"""Testes do servidor (app.py): funções da biblioteca e rotas da API num servidor de verdade."""
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ["SANNSTATION_DATA"] = str(Path(TMP.name) / "data")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app  # noqa: E402

from helpers import iso9660  # noqa: E402


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class LibraryFunctionsTest(unittest.TestCase):
    def test_clean_title(self):
        self.assertEqual(app.clean_title("Super Mario World (USA) [!]"), "Super Mario World")
        self.assertEqual(app.clean_title("Final_Fantasy.VII (Disc 1)"), "Final Fantasy VII")

    def test_parse_vdf(self):
        vdf = '"libraryfolders" { "0" { "path" "C:\\\\Steam" "apps" { "10" "1" } } }'
        self.assertEqual(app.parse_vdf(vdf)["libraryfolders"]["0"]["path"], "C:\\Steam")

    def test_apply_fields_lists_and_dirs(self):
        target = {}
        app.apply_fields(target, {"tags": "RPG, rpg ,  Zerados", "romDirs": ["D:/a", {"path": "D:/a"}, {"path": "D:/b", "recursive": False}]},
                         {"tags": list, "romDirs": "dirs"})
        self.assertEqual(target["tags"], ["RPG", "Zerados"])
        self.assertEqual(target["romDirs"], [{"path": "D:/a", "recursive": True}, {"path": "D:/b", "recursive": False}])

    def test_rom_console_for_mixed_folders(self):
        with tempfile.TemporaryDirectory() as d:
            ps2 = Path(d) / "gow.iso"
            ps2.write_bytes(iso9660("PLAYSTATION", {"SYSTEM.CNF": b"BOOT2 = cdrom0:\\SCUS_974.81;1\r\n"}))
            sfc = Path(d) / "smw.sfc"
            sfc.write_text("x")
            self.assertIsNone(app.rom_console_for(ps2, "gamecube", {"gamecube", "wii"}))  # outro console: fica de fora
            self.assertEqual(app.rom_console_for(ps2, "gamecube", None), "ps2")  # emulador antigo: entra como antes
            self.assertEqual(app.rom_console_for(sfc, "nes", {"nes", "snes"}), "snes")  # Mesen roda os dois

    def test_count_roms_counts_discs_once(self):
        with tempfile.TemporaryDirectory() as d:
            for i in (1, 2, 3):
                (Path(d) / f"FF8 (Disc {i}).cue").write_text("x")
            (Path(d) / "Crash.cue").write_text("x")
            (Path(d) / "x.zip").write_text("x")  # extensão de vários consoles sem cabeçalho: não chuta
            self.assertEqual(app.count_roms(d, True, {"ps1": [".cue"]}), {"ps1": 2})
            self.assertEqual(app.count_roms(d, True, {"nes": [".zip"], "snes": [".zip"]}), {})

    def test_reasonable_rom_dir(self):
        self.assertFalse(app.reasonable_rom_dir(Path.home()))
        self.assertFalse(app.reasonable_rom_dir(Path(Path.home().anchor)))
        with tempfile.TemporaryDirectory() as d:
            self.assertTrue(app.reasonable_rom_dir(d))

    def test_clean_smart_collections(self):
        out = app.clean_smart_collections([{"name": " RPGs ", "match": "x", "rules": [{"field": "genre", "op": "has", "value": "RPG"}]},
                                           {"name": ""}, "lixo"])
        self.assertEqual(len(out), 1)
        self.assertEqual((out[0]["name"], out[0]["match"]), ("RPGs", "all"))


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.PORT = free_port()
        cls.server = app.Server((app.HOST, app.PORT), app.Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{app.PORT}"
        html = urllib.request.urlopen(cls.base + "/").read().decode()
        cls.token = html.split('LUDO_TOKEN = "')[1].split('"')[0]
        cls.roms = Path(TMP.name) / "roms"
        cls.roms.mkdir()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def api(self, path, body=None, method=None, token=True, host=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["X-Token"] = self.token
        if host:
            headers["Host"] = host
        req = urllib.request.Request(self.base + "/api" + path, method=method or ("POST" if body is not None else "GET"),
                                     data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_security(self):
        self.assertEqual(self.api("/state", token=False)[0], 403)
        self.assertEqual(self.api("/state", host="evil.example:80")[0], 403)
        self.assertEqual(self.api("/hello", token=False)[1]["version"], app.APP_VERSION)

    def test_game_crud_status_and_validation(self):
        code, g = self.api("/games", {"name": "Teste", "kind": "exe", "path": sys.executable})
        self.assertEqual(code, 200)
        code, g2 = self.api(f"/games/{g['id']}", {"status": "beaten"}, "PUT")
        self.assertEqual(g2["status"], "beaten")
        self.assertGreater(g2["statusAt"], 0)
        self.assertEqual(self.api(f"/games/{g['id']}", {"status": "inventado"}, "PUT")[0], 400)
        self.assertEqual(self.api(f"/games/{g['id']}", method="DELETE")[0], 200)

    def test_scan_m3u_watched_folder_and_rescan(self):
        folder = self.roms / "ps1"
        folder.mkdir()
        for i in (1, 2):
            (folder / f"Legend (USA) (Disc {i}).cue").write_text("x")
        code, emu = self.api("/emulators", {"name": "DuckStation", "path": sys.executable, "extensions": [".cue", ".m3u"],
                                            "platform": "PlayStation", "consoleId": "ps1"})
        self.assertEqual(code, 200)
        code, res = self.api(f"/emulators/{emu['id']}/scan", {"folder": str(folder), "accepts": ["ps1"]})
        self.assertEqual((code, res["found"]), (200, 1))
        self.assertTrue((folder / "Legend (USA).m3u").exists())
        state = self.api("/state")[1]
        self.assertEqual(next(e for e in state["emulators"] if e["id"] == emu["id"])["romDirs"],
                         [{"path": str(folder), "recursive": True}])
        (folder / "Novo Jogo (USA).cue").write_text("x")
        code, res = self.api("/library/rescan", {"accepts": {emu["id"]: ["ps1"]}})
        self.assertEqual(len(res["added"]), 1)
        self.assertEqual(self.api("/library/rescan", {})[1]["added"], [])

    def test_launch_records_session(self):
        code, g = self.api("/games", {"name": "Dorminhoco", "kind": "exe", "path": sys.executable,
                                      "args": '-c "import time; time.sleep(6)"'})
        self.assertEqual(self.api(f"/games/{g['id']}/launch", {})[0], 200)
        self.assertIn(g["id"], self.api("/ping")[1]["running"])
        for _ in range(40):
            time.sleep(0.5)
            if g["id"] not in self.api("/ping")[1]["running"]:
                break
        state = self.api("/state")[1]
        sessions = [s for s in state["sessions"] if s["g"] == g["id"]]
        self.assertEqual(len(sessions), 1)
        self.assertGreaterEqual(sessions[0]["d"], 5)
        game = next(x for x in state["games"] if x["id"] == g["id"])
        self.assertEqual(game["playtime"], sessions[0]["d"])

    def test_backup_includes_library_and_saves(self):
        import zipfile
        emu_dir = Path(TMP.name) / "RetroArch"
        (emu_dir / "saves").mkdir(parents=True)
        (emu_dir / "saves" / "Chrono Trigger.srm").write_bytes(b"save")
        exe = emu_dir / "retroarch.exe"
        exe.write_text("x")
        self.api("/emulators", {"name": "RetroArch · Snes9x", "path": str(exe), "extensions": [".sfc"], "consoleId": "snes"})
        out = Path(TMP.name) / "backups"
        out.mkdir()
        code, res = self.api("/backup", {"folder": str(out)})
        self.assertEqual(code, 200)
        names = zipfile.ZipFile(res["path"]).namelist()
        self.assertIn("library.json", names)
        self.assertTrue(any(n.endswith("/Chrono Trigger.srm") and n.startswith("saves/") for n in names), names)

    def test_settings_validation(self):
        code, st = self.api("/settings", {"autoScan": False, "smartCollections": [{"name": "X", "rules": []}],
                                          "dupIgnore": ["a|b"]}, "PUT")
        self.assertEqual(code, 200)
        self.assertFalse(st["autoScan"])
        self.assertEqual(st["smartCollections"][0]["name"], "X")


@unittest.skipUnless(os.name == "nt", "Job Objects só existem no Windows")
class ProcWatchWindowsTest(unittest.TestCase):
    def test_waits_for_child_processes(self):
        from sann import procwatch
        # O processo principal abre um filho que dorme 4 s e sai na hora (como um launcher).
        code = ("import subprocess, sys; subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(4)'], "
                "creationflags=0x00000008)")
        start = time.time()
        procwatch.start(f'"{sys.executable}" -c "{code}"', None).wait()
        self.assertGreaterEqual(time.time() - start, 3.5)


if __name__ == "__main__":
    unittest.main()
