"""Regras de segurança (sann/firebase_rules.json) avaliadas pelo Firebase falso, sem rede."""
import unittest

from fakefirebase import Auth, FakeFirebase, split, translate

A, B, C = "a" * 28, "b" * 28, "c" * 28


class TranslateTest(unittest.TestCase):
    def test_translate(self):
        self.assertEqual(translate("auth != null && !data.exists()").split(), ["auth!=None", "and", "not", "data.exists()"])
        self.assertIn("R('^[A-Z]{2}$')", translate("$code.matches(/^[A-Z]{2}$/)"))
        self.assertIn('S("_")', translate("$chat.endsWith('_' + auth.uid)"))


class RulesTest(unittest.TestCase):
    def setUp(self):
        self.fb = FakeFirebase()

    def put(self, uid, path, value):
        return self.fb.write(Auth(uid) if uid else None, [(split(path), value)]) is None

    def patch(self, uid, base, updates):
        return self.fb.write(Auth(uid), [(split(base) + split(k), v) for k, v in updates.items()]) is None

    def read(self, uid, path):
        return self.fb.read(Auth(uid) if uid else None, split(path), {})[0] is None

    def pub(self, code, name="Ana"):
        return {"name": name, "code": code, "state": "online", "lastSeen": {".sv": "timestamp"}}

    def make_user(self, uid, code):
        self.assertTrue(self.put(uid, f"codes/{code}", uid))
        self.assertTrue(self.put(uid, f"users/{uid}/pub", self.pub(code)))

    def befriend(self, x, y, code_x="AAAAAAAA"):
        self.assertTrue(self.put(x, f"requests/{y}/{x}", {"name": "X", "code": code_x, "t": 1}))
        self.assertTrue(self.patch(y, "", {f"friends/{y}/{x}": True, f"friends/{x}/{y}": True, f"requests/{y}/{x}": None}))

    def test_codes(self):
        self.assertFalse(self.put(None, "codes/ABCDEFGH", A))  # sem login
        self.assertTrue(self.put(A, "codes/ABCDEFGH", A))
        self.assertFalse(self.put(B, "codes/ABCDEFGH", B))  # código já é de outro
        self.assertFalse(self.put(B, "codes/ABCDEFGH", None))  # não apaga código alheio
        self.assertFalse(self.put(B, "codes/abc", B))  # formato inválido
        self.assertFalse(self.put(B, "codes/ZZZZZZZZ", A))  # não reserva código em nome de outro
        self.assertTrue(self.read(B, "codes/ABCDEFGH"))
        self.assertFalse(self.read(B, "codes"))  # não dá para listar todos os códigos
        self.assertTrue(self.put(A, "codes/ABCDEFGH", None))  # dono apaga o próprio

    def test_pub_validation(self):
        self.put(A, "codes/ABCDEFGH", A)
        self.assertTrue(self.put(A, f"users/{A}/pub", self.pub("ABCDEFGH")))
        self.assertFalse(self.put(A, f"users/{A}/pub", self.pub("ZZZZZZZZ")))  # código que não é dele
        self.assertFalse(self.put(A, f"users/{A}/pub", {**self.pub("ABCDEFGH"), "state": "hackeando"}))
        self.assertFalse(self.put(A, f"users/{A}/pub", {**self.pub("ABCDEFGH"), "name": "x" * 41}))
        self.assertFalse(self.put(A, f"users/{A}/pub", {"name": "Ana"}))  # faltam campos
        self.assertFalse(self.put(B, f"users/{A}/pub", self.pub("ABCDEFGH")))  # perfil de outro

    def test_privacy_before_and_after_friendship(self):
        self.make_user(A, "AAAAAAAA")
        self.make_user(B, "BBBBBBBB")
        self.assertFalse(self.read(B, f"users/{A}"))
        self.assertFalse(self.read(B, f"users/{A}/library"))
        self.befriend(A, B)
        self.assertTrue(self.read(B, f"users/{A}"))
        self.assertTrue(self.read(A, f"users/{B}/pub"))
        self.assertFalse(self.read(C, f"users/{A}"))  # terceiro continua sem acesso
        self.assertFalse(self.read(C, f"friends/{A}"))  # nem a lista de amigos

    def test_cannot_force_friendship(self):
        self.make_user(A, "AAAAAAAA")
        # C tenta entrar sozinho na lista de amigos de A (para ler os dados dele)
        self.assertFalse(self.put(C, f"friends/{A}/{C}", True))
        # Mas pode adicionar A na própria lista (isso só dá acesso aos dados de C)
        self.assertTrue(self.put(C, f"friends/{C}/{A}", True))
        self.assertFalse(self.read(C, f"users/{A}"))
        # Com um pedido de A para C, C pode aceitar e escrever nas duas listas
        self.assertTrue(self.put(A, f"requests/{C}/{A}", {"name": "A", "code": "AAAAAAAA", "t": 1}))
        self.assertTrue(self.patch(C, "", {f"friends/{C}/{A}": True, f"friends/{A}/{C}": True, f"requests/{C}/{A}": None}))
        self.assertTrue(self.read(C, f"users/{A}"))

    def test_requests(self):
        req = {"name": "B", "code": "BBBBBBBB", "t": 1}
        self.assertTrue(self.put(B, f"requests/{A}/{B}", req))
        self.assertFalse(self.put(B, f"requests/{A}/{B}", {**req, "name": "Outro"}))  # não reescreve
        self.assertFalse(self.put(C, f"requests/{A}/{B}", req))  # não pede em nome de outro
        self.assertFalse(self.put(B, f"requests/{B}/{B}", req))  # nem para si mesmo
        self.assertFalse(self.read(B, f"requests/{A}"))  # só o destinatário lê
        self.assertTrue(self.read(A, f"requests/{A}"))
        self.assertTrue(self.put(A, f"requests/{A}/{B}", None))  # recusar
        self.assertTrue(self.put(B, f"requests/{A}/{B}", req))
        self.assertTrue(self.put(B, f"requests/{A}/{B}", None))  # cancelar

    def test_chat(self):
        self.make_user(A, "AAAAAAAA")
        self.make_user(B, "BBBBBBBB")
        chat = f"chats/{'_'.join(sorted([A, B]))}"
        msg = {"from": A, "text": "oi", "t": {".sv": "timestamp"}}
        self.assertFalse(self.put(A, f"{chat}/m1", msg))  # ainda não são amigos
        self.befriend(A, B)
        self.assertTrue(self.put(A, f"{chat}/m1", msg))
        self.assertFalse(self.put(A, f"{chat}/m1", {**msg, "text": "editado"}))  # mensagem não muda
        self.assertFalse(self.put(B, f"{chat}/m2", msg))  # B não manda em nome de A
        self.assertFalse(self.put(A, f"{chat}/m3", {**msg, "text": "x" * 1001}))
        self.assertTrue(self.read(B, chat))
        self.assertFalse(self.read(C, chat))
        self.assertFalse(self.put(C, f"{chat}/m4", {**msg, "from": C}))
        # Depois de desfazer a amizade, ninguém escreve mais
        self.assertTrue(self.patch(A, "", {f"friends/{A}/{B}": None, f"friends/{B}/{A}": None}))
        self.assertFalse(self.put(B, f"{chat}/m5", {**msg, "from": B}))


if __name__ == "__main__":
    unittest.main()
