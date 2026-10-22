"""Amigos de ponta a ponta: dois usuários contra o Firebase falso (com as regras de segurança de verdade)."""
import os
import time
import unittest

from fakefirebase import FakeFirebase
from sann import friends as fr

CONFIG = """
const firebaseConfig = {
  apiKey: "AIzaFake",
  authDomain: "sann-teste.firebaseapp.com",
  databaseURL: "%s",
  projectId: "sann-teste",
};
"""


class FriendsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake = FakeFirebase().start()
        os.environ["SANNSTATION_FIREBASE_AUTH"] = cls.fake.url

    @classmethod
    def tearDownClass(cls):
        cls.fake.stop()
        os.environ.pop("SANNSTATION_FIREBASE_AUTH", None)

    def user(self, name):
        store = {}
        svc = fr.Friends(store, lambda: None, version="test")
        cfg = fr.parse_config(CONFIG % self.fake.url)
        svc.setup(cfg["apiKey"], cfg["databaseURL"], name)
        return svc

    def local(self, game=None, library=None):
        return {"state": "online", "game": game, "library": library if library is not None else {}}

    def pair(self):
        ana, beto = self.user("Ana"), self.user("Beto")
        res = beto.join(ana.invite())  # Beto cola o convite da Ana
        self.assertEqual(res["status"], "sent")
        ana.sync(self.local())
        self.assertEqual([r["name"] for r in ana.snapshot()["requests"]], ["Beto"])
        ana.accept(beto.me)
        ana.sync(self.local())
        beto.sync(self.local())
        return ana, beto

    def test_config_parsing_and_invite(self):
        cfg = fr.parse_config(CONFIG % "https://x-default-rtdb.firebaseio.com")
        self.assertEqual(cfg["apiKey"], "AIzaFake")
        self.assertEqual(fr.parse_config('{"apiKey": "k", "projectId": "p"}')["databaseURL"], "https://p-default-rtdb.firebaseio.com")
        self.assertTrue(fr.valid_db_url("https://x.europe-west1.firebasedatabase.app"))
        self.assertFalse(fr.valid_db_url("https://evil.example.com"))
        inv = fr.encode_invite("k", "https://x.firebaseio.com", "ABCDEFGH", "Ana")
        self.assertEqual(fr.decode_invite(f"Entra aí: {inv} !")["c"], "ABCDEFGH")
        self.assertIsNone(fr.decode_invite("SANN1.@@@"))
        self.assertEqual(fr.clean_code("k7q2-mx9p"), "K7Q2MX9P")

    def test_setup_claims_code(self):
        ana = self.user("Ana")
        snap = ana.snapshot()
        self.assertTrue(snap["configured"])
        self.assertRegex(snap["me"]["code"], r"^[A-Z2-9]{4}-[A-Z2-9]{4}$")
        self.assertEqual(self.fake.data["codes"][fr.clean_code(snap["me"]["code"])], ana.me)

    def test_friendship_presence_and_events(self):
        ana, beto = self.pair()
        self.assertEqual([f["name"] for f in ana.snapshot()["friends"]], ["Beto"])
        self.assertEqual([f["name"] for f in beto.snapshot()["friends"]], ["Ana"])
        self.assertEqual(beto.snapshot()["sent"], [])  # pedido aceito sai da lista de enviados
        beto.sync(self.local(game={"n": "Chrono Trigger", "p": "Super Nintendo (SNES)", "c": "snes", "since": 1}))
        ana.sync(self.local())
        f = ana.snapshot()["friends"][0]
        self.assertEqual((f["state"], f["game"]["n"]), ("playing", "Chrono Trigger"))
        self.assertIn("playing", [e["type"] for e in ana.snapshot()["events"]])
        beto.go_offline()
        ana.sync(self.local())
        self.assertEqual(ana.snapshot()["friends"][0]["state"], "offline")

    def test_privacy_switch_hides_game(self):
        ana, beto = self.pair()
        beto.set_profile(shareGame=False)
        beto.sync(self.local(game={"n": "Segredo", "p": "PC", "c": ""}))
        ana.sync(self.local())
        f = ana.snapshot()["friends"][0]
        self.assertEqual(f["state"], "online")
        self.assertIsNone(f["game"])

    def test_activity_and_library(self):
        ana, beto = self.pair()
        beto.queue_activity({"type": "played", "n": "Hollow Knight", "p": "PC", "d": 3600})
        beto.queue_activity({"type": "status", "n": "Hollow Knight", "p": "PC", "st": "beaten"})
        beto._lib_at = 0  # sem esperar o intervalo mínimo entre envios da biblioteca
        beto.sync(self.local(library={"g1": {"n": "Hollow Knight", "p": "PC", "pt": 3600, "st": "beaten"}}))
        ana.sync(self.local())
        acts = ana.snapshot()["friends"][0]["activity"]
        self.assertEqual([a["type"] for a in acts], ["status", "played"])  # mais recente primeiro
        self.assertEqual(ana.library(beto.me)["g1"]["n"], "Hollow Knight")
        beto.set_profile(shareLibrary=False)
        self.assertEqual(ana.library(beto.me), {})

    def test_chat_unread_and_invite(self):
        ana, beto = self.pair()
        ana.send(beto.me, "bora jogar?", invite={"n": "Super Mario World", "p": "Super Nintendo (SNES)", "c": "snes"})
        beto.sync(self.local())
        f = beto.snapshot()["friends"][0]
        self.assertTrue(f["unread"])
        msgs = beto.chat(ana.me)
        self.assertEqual((msgs[0]["text"], msgs[0]["inv"]["n"]), ("bora jogar?", "Super Mario World"))
        self.assertIn("message", [e["type"] for e in beto.snapshot()["events"]])
        beto.mark_read(ana.me, msgs[-1]["id"])
        beto.send(ana.me, "bora!")
        self.assertEqual([m["text"] for m in ana.chat(beto.me, after=msgs[0]["id"])], ["bora!"])
        beto.sync(self.local())
        self.assertFalse(beto.snapshot()["friends"][0]["unread"])

    def test_add_by_code_errors_and_mutual_requests(self):
        ana, beto = self.user("Ana"), self.user("Beto")
        with self.assertRaises(fr.FriendsError):
            ana.add(ana.snapshot()["me"]["code"])
        with self.assertRaises(fr.FriendsError):
            ana.add("ZZZZ-ZZZZ")
        ana.add(beto.snapshot()["me"]["code"])
        res = beto.add(ana.snapshot()["me"]["code"])  # os dois pediram: o segundo pedido vira aceite
        self.assertEqual(res["status"], "accepted")
        beto.sync(self.local())
        self.assertEqual(len(beto.snapshot()["friends"]), 1)
        with self.assertRaises(fr.FriendsError):
            beto.add(ana.snapshot()["me"]["code"])

    def test_remove_and_leave(self):
        ana, beto = self.pair()
        beto.remove(ana.me)
        ana.sync(self.local())
        beto.sync(self.local())
        self.assertEqual(ana.snapshot()["friends"], [])
        self.assertEqual(beto.snapshot()["friends"], [])
        with self.assertRaises(fr.PermissionDenied):
            beto.fb.get(f"users/{ana.me}/pub")
        carlos = self.user("Carlos")
        carlos_code = fr.clean_code(carlos.snapshot()["me"]["code"])
        carlos.leave()
        self.assertFalse(carlos.configured())
        self.assertNotIn(carlos_code, self.fake.data.get("codes", {}))

    def test_token_refresh(self):
        ana = self.user("Ana")
        self.fake.token_seconds = 1  # tokens vencem logo
        ana.fb.id_token, ana.fb.expires = None, 0
        ana.sync(self.local())
        time.sleep(1.2)
        ana.fb.expires = time.time() + 999  # o app acha que o token vale, mas o servidor diz que venceu
        ana.sync(self.local())
        self.assertEqual(ana.snapshot()["error"], "")
        self.fake.token_seconds = 3600

    def test_setup_errors(self):
        svc = fr.Friends({}, lambda: None)
        with self.assertRaises(fr.FriendsError):
            svc.setup("k", "https://evil.example.com", "Ana")
        with self.assertRaises(fr.FriendsError):
            svc.join("convite errado")


if __name__ == "__main__":
    unittest.main()
