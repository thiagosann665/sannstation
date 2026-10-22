"""Amigos: lista de amigos entre usuários da SannStation, pelo Firebase (Realtime Database + login anônimo).

Cada usuário tem uma conta anônima (sem e-mail nem senha) e um código de amigo (ex.: K7Q2-MX9P). Os dados
ficam no projeto Firebase de quem configurou; os amigos entram colando um convite, que já traz o endereço
do servidor. Quem pode ler o quê é decidido pelas regras de segurança (sann/firebase_rules.json): seus dados
só são lidos por amigos aceitos.

Estrutura no banco:
  codes/{CÓDIGO} = uid                     reserva do código de amigo
  users/{uid}/pub                          nome, avatar, status (online, jogando…) e último sinal
  users/{uid}/avatar                       foto do avatar (data URL de ~10 KB; pub.img diz a versão)
  users/{uid}/activity/{id}                atividade recente (jogou, zerou…)
  users/{uid}/library/{id do jogo}         biblioteca resumida (nome, plataforma, horas, status)
  friends/{uid}/{uid do amigo} = true      lista de amigos (os dois lados)
  requests/{para}/{de}                     pedidos de amizade
  chats/{uidA_uidB}/{id}                   mensagens (uids em ordem alfabética)

Usa só a API REST (urllib): funciona nas mesmas redes que o resto do app, sem SDK nem dependências.
"""
import base64
import hashlib
import json
import os
import random
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

# Endereços do login anônimo. SANNSTATION_FIREBASE_AUTH aponta para o Firebase falso dos testes.
def _test_auth():
    return os.environ.get("SANNSTATION_FIREBASE_AUTH", "")


def auth_url():
    return _test_auth() or "https://identitytoolkit.googleapis.com/v1"


def token_url():
    return _test_auth() or "https://securetoken.googleapis.com/v1"


CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # sem 0/O e 1/I, que se confundem
SYNC_SECONDS = 25
ONLINE_WINDOW_MS = 80_000  # sem sinal há mais que isso = offline (o app manda sinal a cada SYNC_SECONDS)
LIBRARY_MIN_INTERVAL = 120  # biblioteca enviada no máximo a cada 2 min (o tempo de jogo muda a cada minuto)
ACTIVITY_KEEP = 40
INVITE_PREFIX = "SANN1."
AVATARS = ["🎮", "👾", "🕹️", "🐉", "🦊", "🐱", "🐼", "🦉", "🚀", "⚔️", "🍄", "⭐", "🔥", "🎧", "🏆", "💎"]
SERVER_TIME = {".sv": "timestamp"}
MAX_AVATAR_CHARS = 80_000  # foto do avatar já reduzida pelo app (128×128) fica em ~10-20 KB
_NO_VALUE = object()


class FriendsError(Exception):
    """Erro com mensagem pronta para mostrar ao usuário."""


class PermissionDenied(FriendsError):
    pass


def default_http(method, url, data=None, headers=None, timeout=15):
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"User-Agent": "SannStation", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


# --------------------------------------------------------------------------- configuração e convites

def parse_config(text):
    """apiKey e databaseURL do bloco `firebaseConfig` copiado do console do Firebase (ou de um JSON)."""
    text = str(text or "")
    found = {}
    for key in ("apiKey", "databaseURL", "projectId"):
        m = re.search(rf"""["']?{key}["']?\s*[:=]\s*["']([^"']+)["']""", text)
        if m:
            found[key] = m.group(1).strip()
    if not found.get("databaseURL") and found.get("projectId"):
        found["databaseURL"] = f"https://{found['projectId']}-default-rtdb.firebaseio.com"
    return found


def valid_db_url(url):
    try:
        parts = urllib.parse.urlsplit(str(url))
    except ValueError:
        return False
    host = (parts.hostname or "").lower()
    if parts.scheme == "https" and (host.endswith(".firebaseio.com") or host.endswith(".firebasedatabase.app")):
        return True
    return bool(_test_auth()) and parts.scheme == "http" and host == "127.0.0.1"  # só nos testes


def encode_invite(api_key, db_url, code, name):
    raw = json.dumps({"k": api_key, "d": db_url, "c": code, "n": name}, separators=(",", ":")).encode()
    return INVITE_PREFIX + base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_invite(text):
    m = re.search(re.escape(INVITE_PREFIX) + r"([A-Za-z0-9_\-]+)", str(text or ""))
    if not m:
        return None
    try:
        payload = m.group(1)
        data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict) or not all(isinstance(data.get(k), str) for k in ("k", "d", "c")):
        return None
    return data


def clean_code(code):
    return re.sub(r"[^A-Z0-9]", "", str(code or "").upper())


def pretty_code(code):
    return f"{code[:4]}-{code[4:]}" if code and len(code) == 8 else code or ""


def chat_id(a, b):
    return "_".join(sorted([a, b]))


def now_ms():
    return int(time.time() * 1000)


# --------------------------------------------------------------------------- cliente REST do Firebase

class Firebase:
    def __init__(self, api_key, db_url, http=default_http):
        self.api_key = api_key
        self.db_url = db_url.rstrip("/")
        self.http = http
        self.uid = None
        self.refresh_token = None
        self.id_token = None
        self.expires = 0.0
        self.lock = threading.Lock()

    def _call(self, method, url, body=None, headers=None, timeout=15):
        try:
            return self.http(method, url, body, headers or {}, timeout)
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            reason = getattr(exc, "reason", exc)
            raise FriendsError(f"Sem conexão com o servidor de amigos ({reason}).") from exc

    def _auth_error(self, raw):
        try:
            msg = json.loads(raw)["error"]["message"]
        except (ValueError, KeyError, TypeError):
            msg = raw[:120].decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
        if "CONFIGURATION_NOT_FOUND" in msg:
            return FriendsError("O Authentication ainda não foi ativado no Firebase. Abra Authentication → Vamos começar → "
                                "Método de login → Anônimo → Ativar → Salvar, e tente de novo.")
        if "ADMIN_ONLY_OPERATION" in msg or "OPERATION_NOT_ALLOWED" in msg:
            return FriendsError("O login anônimo está desativado no Firebase. Ative em Authentication → Método de login → Anônimo.")
        if "API key" in msg or "API_KEY" in msg:
            return FriendsError("A apiKey do Firebase não é válida. Copie de novo o firebaseConfig do console.")
        return FriendsError(f"O Firebase recusou o login ({msg}).")

    def sign_up(self):
        status, raw = self._call("POST", f"{auth_url()}/accounts:signUp?key={urllib.parse.quote(self.api_key)}",
                                 json.dumps({"returnSecureToken": True}).encode(), {"Content-Type": "application/json"})
        if status != 200:
            raise self._auth_error(raw)
        data = json.loads(raw)
        self.uid, self.id_token, self.refresh_token = data["localId"], data["idToken"], data["refreshToken"]
        self.expires = time.time() + int(data.get("expiresIn", 3600))
        return self.uid, self.refresh_token

    def resume(self, uid, refresh_token):
        self.uid, self.refresh_token, self.id_token, self.expires = uid, refresh_token, None, 0.0

    def token(self):
        with self.lock:
            if self.id_token and time.time() < self.expires - 120:
                return self.id_token
            body = urllib.parse.urlencode({"grant_type": "refresh_token", "refresh_token": self.refresh_token}).encode()
            status, raw = self._call("POST", f"{token_url()}/token?key={urllib.parse.quote(self.api_key)}", body,
                                     {"Content-Type": "application/x-www-form-urlencoded"})
            if status != 200:
                raise self._auth_error(raw)
            data = json.loads(raw)
            self.id_token, self.refresh_token = data["id_token"], data.get("refresh_token", self.refresh_token)
            self.expires = time.time() + int(data.get("expires_in", 3600))
            return self.id_token

    def request(self, method, path, value=_NO_VALUE, query=None, timeout=15, _retry=True):
        q = {**(query or {}), "auth": self.token()}
        url = f"{self.db_url}/{urllib.parse.quote(path.strip('/'))}.json?{urllib.parse.urlencode(q)}"
        body = None if value is _NO_VALUE else json.dumps(value).encode()
        status, raw = self._call(method, url, body, {"Content-Type": "application/json"} if body is not None else {}, timeout)
        if status == 401:
            try:
                err = str(json.loads(raw).get("error", ""))
            except (ValueError, AttributeError):
                err = ""
            if _retry and "token" in err.lower():  # token vencido/recusado: renova e tenta de novo
                self.id_token = None
                return self.request(method, path, value, query, timeout, _retry=False)
            raise PermissionDenied("O servidor de amigos negou o acesso.")
        if status == 404:
            raise FriendsError("Banco de dados do Firebase não encontrado. Confira o databaseURL (Realtime Database criado?).")
        if status >= 400:
            raise FriendsError(f"Erro do servidor de amigos (HTTP {status}).")
        return json.loads(raw) if raw else None

    def get(self, path, **query):
        return self.request("GET", path, query={k: v for k, v in query.items() if v is not None})

    def put(self, path, value, timeout=15):
        return self.request("PUT", path, value, timeout=timeout)

    def patch(self, path, value):
        return self.request("PATCH", path, value)

    def post(self, path, value):
        return self.request("POST", path, value)

    def delete(self, path):
        return self.request("DELETE", path)


def last_items(fb, path, n, start_after=None):
    """Itens mais recentes de uma lista por chave (ids do Firebase são cronológicos): [(id, valor)]."""
    query = {"orderBy": '"$key"', "limitToLast": n}
    if start_after:
        query["startAt"] = json.dumps(start_after)
    data = fb.get(path, **query) or {}
    items = sorted(data.items()) if isinstance(data, dict) else []
    return [(k, v) for k, v in items if k != start_after and isinstance(v, dict)]


# --------------------------------------------------------------------------- serviço de amigos

class Friends:
    """Conta, amigos, presença, atividade, biblioteca e chat. `store` é salvo pelo app (fica só neste PC)."""

    def __init__(self, store, save, http=default_http, version="", cache_dir=None):
        self.store = store
        self.cache_dir = cache_dir  # fotos dos avatares (minha e dos amigos), para a interface
        self.save = save
        self.http = http
        self.version = version
        self.lock = threading.RLock()
        self.fb = None
        self.wake = threading.Event()
        self.friends = {}  # uid -> dados do amigo (do último sync)
        self.requests = {}  # uid -> pedido recebido
        self.error = ""
        self.last_sync = 0
        self.offset = 0  # relógio do servidor - relógio local (ms)
        self.events = []
        self._seq = 0
        self._synced_once = False
        self._lib_hash = None
        self._lib_at = 0.0
        self._trimmed = False
        if self.configured():
            self._client()

    # -- estado local
    def configured(self):
        return bool(self.store.get("apiKey") and self.store.get("databaseURL") and self.store.get("uid")
                    and self.store.get("refreshToken"))

    @property
    def me(self):
        return self.store.get("uid", "")

    def _client(self):
        self.fb = Firebase(self.store["apiKey"], self.store["databaseURL"], self.http)
        self.fb.resume(self.store["uid"], self.store["refreshToken"])

    def _persist(self):
        if self.fb and self.fb.refresh_token and self.fb.refresh_token != self.store.get("refreshToken"):
            self.store["refreshToken"] = self.fb.refresh_token
        self.save()

    def _require(self):
        if not self.configured() or not self.fb:
            raise FriendsError("Amigos ainda não configurados.")
        return self.fb

    def flag(self, key):
        return self.store.get(key, True) is not False

    def _event(self, kind, **data):
        self._seq += 1
        self.events.append({"id": self._seq, "type": kind, **data})
        del self.events[:-50]

    # -- configuração
    def setup(self, api_key, db_url, name):
        api_key, db_url = str(api_key or "").strip(), str(db_url or "").strip().rstrip("/")
        name = str(name or "").strip()[:40] or "Jogador"
        if not api_key:
            raise FriendsError("Cole o firebaseConfig (precisa ter a apiKey).")
        if not valid_db_url(db_url):
            raise FriendsError("databaseURL inválido. Ele termina em firebaseio.com ou firebasedatabase.app "
                               "(Realtime Database → copie o endereço no topo da aba Dados).")
        with self.lock:
            fb = Firebase(api_key, db_url, self.http)
            uid, refresh = fb.sign_up()
            try:
                code = self._claim_code(fb, uid)
            except PermissionDenied as exc:
                raise FriendsError("O Firebase negou a gravação. Publique as regras de segurança da SannStation "
                                   "(Realtime Database → Regras) e tente de novo.") from exc
            self.store.clear()
            self.store.update({"apiKey": api_key, "databaseURL": db_url, "uid": uid, "refreshToken": refresh,
                               "code": code, "name": name, "avatar": random.choice(AVATARS), "shareGame": True,
                               "shareLibrary": True, "shareActivity": True, "sent": {}, "lastRead": {}, "pending": []})
            self.fb = fb
            self._write_pub({"state": "online"})
            self._persist()
            self.wake.set()

    def _claim_code(self, fb, uid):
        for _ in range(8):
            code = "".join(random.choice(CODE_ALPHABET) for _ in range(8))
            if fb.get(f"codes/{code}") is None:
                try:
                    fb.put(f"codes/{code}", uid)
                    return code
                except PermissionDenied:
                    continue  # outro usuário pegou o mesmo código no mesmo instante
        raise PermissionDenied("sem código")

    def invite(self):
        self._require()
        return encode_invite(self.store["apiKey"], self.store["databaseURL"], self.store["code"], self.store.get("name", ""))

    def join(self, invite_text, name=""):
        """Entra pelo convite de um amigo: configura o servidor (se preciso) e envia o pedido de amizade."""
        data = decode_invite(invite_text)
        if not data:
            raise FriendsError("Convite inválido. Ele começa com SANN1. — peça para seu amigo copiar de novo.")
        if not self.configured():
            self.setup(data["k"], data["d"], name or "Jogador")
        elif (data["k"], data["d"].rstrip("/")) != (self.store["apiKey"], self.store["databaseURL"]):
            raise FriendsError("Este convite é de outro servidor de amigos. Peça o código de amigo em vez do convite.")
        return self.add(data["c"])

    def set_profile(self, **changes):
        fb = self._require()
        with self.lock:
            if "name" in changes:
                name = str(changes["name"] or "").strip()[:40]
                if not name:
                    raise FriendsError("Escolha um nome.")
                self.store["name"] = name
            if changes.get("avatar") in AVATARS:
                self.store["avatar"] = changes["avatar"]
                if self.store.get("img"):  # escolheu um emoji: sai a foto
                    fb.delete(f"users/{self.me}/avatar")
                    self.store.pop("img", None)
            for key in ("shareGame", "shareLibrary", "shareActivity"):
                if isinstance(changes.get(key), bool):
                    self.store[key] = changes[key]
            if changes.get("shareLibrary") is False:
                fb.delete(f"users/{self.me}/library")
                self._lib_hash = None
            if changes.get("shareActivity") is False:
                fb.delete(f"users/{self.me}/activity")
                self.store["pending"] = []
            self._persist()
        self.wake.set()

    def set_avatar_image(self, data_url):
        """Foto do avatar (data URL já reduzida pela interface). Os amigos baixam só quando a versão muda."""
        fb = self._require()
        raw = self._decode_image(data_url)
        if raw is None:
            raise FriendsError("Imagem inválida. Use JPG, PNG ou WEBP.")
        if len(data_url) > MAX_AVATAR_CHARS:
            raise FriendsError("Imagem grande demais para avatar.")
        version = hashlib.sha1(raw).hexdigest()[:12]
        with self.lock:
            fb.put(f"users/{self.me}/avatar", data_url)
            self.store["img"] = version
            self._save_avatar(self.me, version, raw)
            self._persist()
        self.wake.set()

    def clear_avatar_image(self):
        fb = self._require()
        with self.lock:
            fb.delete(f"users/{self.me}/avatar")
            self.store.pop("img", None)
            self._persist()
        self.wake.set()

    @staticmethod
    def _decode_image(data_url):
        m = re.match(r"^data:image/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$", str(data_url or ""))
        if not m:
            return None
        try:
            raw = base64.b64decode(m.group(2), validate=True)
        except (ValueError, TypeError):
            return None
        is_image = raw.startswith(b"\xff\xd8") or raw.startswith(b"\x89PNG") or (raw[:4] == b"RIFF" and raw[8:12] == b"WEBP")
        return raw if is_image else None

    def _avatar_path(self, uid, version):
        if not self.cache_dir or not re.fullmatch(r"[A-Za-z0-9]{1,64}", uid) or not re.fullmatch(r"[0-9a-f]{1,40}", str(version)):
            return None
        return self.cache_dir / f"{uid}-{version}.img"

    def _save_avatar(self, uid, version, raw):
        path = self._avatar_path(uid, version)
        if not path:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            for old in path.parent.glob(f"{uid}-*.img"):  # versões antigas da mesma pessoa
                if old != path:
                    old.unlink(missing_ok=True)
            path.write_bytes(raw)
        except OSError:
            pass

    def avatar_url(self, uid, version, fb=None):
        """Endereço local da foto (baixa do servidor se ainda não tiver esta versão). '' se não houver foto."""
        path = self._avatar_path(uid, version) if version else None
        if not path:
            return ""
        if not path.exists() and fb is not None:
            try:
                raw = self._decode_image(fb.get(f"users/{uid}/avatar"))
            except FriendsError:
                raw = None
            if raw is None:
                return ""
            self._save_avatar(uid, version, raw)
        return f"/avatars/{path.name}" if path.exists() else ""

    def leave(self):
        """Apaga do servidor tudo o que é deste usuário e desfaz as amizades. Os dados locais do app ficam."""
        fb = self._require()
        with self.lock:
            me = self.me
            updates = {f"users/{me}": None, f"codes/{self.store['code']}": None}
            for uid in list(fb.get(f"friends/{me}") or {}):
                updates[f"friends/{me}/{uid}"] = None
                updates[f"friends/{uid}/{me}"] = None
            for uid in list(fb.get(f"requests/{me}") or {}):
                updates[f"requests/{me}/{uid}"] = None
            for uid in list(self.store.get("sent", {})):
                updates[f"requests/{uid}/{me}"] = None
            fb.patch("", updates)
            self.store.clear()
            self.fb = None
            self.friends, self.requests = {}, {}
            self.save()

    # -- amizades
    def add(self, code):
        fb = self._require()
        code = clean_code(code)
        if len(code) != 8:
            raise FriendsError("O código de amigo tem 8 letras e números (ex.: K7Q2-MX9P).")
        if code == self.store.get("code"):
            raise FriendsError("Esse é o seu próprio código. Mande ele para seu amigo.")
        uid = fb.get(f"codes/{code}")
        if not isinstance(uid, str):
            raise FriendsError("Código de amigo não encontrado. Confira as letras.")
        with self.lock:
            if uid in self.friends or fb.get(f"friends/{self.me}/{uid}"):
                raise FriendsError("Vocês já são amigos.")
            if fb.get(f"requests/{self.me}/{uid}"):  # ele já tinha pedido: aceita direto
                self.accept(uid)
                return {"status": "accepted", "uid": uid}
            try:
                fb.put(f"requests/{uid}/{self.me}", {"name": self.store.get("name", "Jogador"), "code": self.store["code"],
                                                     "avatar": self.store.get("avatar", ""), "t": SERVER_TIME})
            except PermissionDenied:
                pass  # já existe um pedido pendente para essa pessoa
            self.store.setdefault("sent", {})[uid] = {"code": code, "t": now_ms()}
            self._persist()
        self.wake.set()
        return {"status": "sent", "uid": uid}

    def accept(self, uid):
        fb = self._require()
        fb.patch("", {f"friends/{self.me}/{uid}": True, f"friends/{uid}/{self.me}": True, f"requests/{self.me}/{uid}": None})
        with self.lock:
            self.requests.pop(uid, None)
        self.wake.set()

    def decline(self, uid):
        self._require().delete(f"requests/{self.me}/{uid}")
        with self.lock:
            self.requests.pop(uid, None)

    def cancel(self, uid):
        self._require().delete(f"requests/{uid}/{self.me}")
        with self.lock:
            self.store.get("sent", {}).pop(uid, None)
            self._persist()

    def remove(self, uid):
        self._require().patch("", {f"friends/{self.me}/{uid}": None, f"friends/{uid}/{self.me}": None})
        with self.lock:
            self.friends.pop(uid, None)

    # -- dados dos amigos
    def library(self, uid):
        data = self._require().get(f"users/{uid}/library")
        return data if isinstance(data, dict) else {}

    def chat(self, uid, after=None):
        fb = self._require()
        msgs = [{"id": k, "from": v.get("from"), "text": v.get("text", ""), "t": v.get("t", 0), "inv": v.get("inv")}
                for k, v in last_items(fb, f"chats/{chat_id(self.me, uid)}", 80, after)]
        return msgs

    def send(self, uid, text, invite=None):
        fb = self._require()
        text = str(text or "").strip()[:1000]
        msg = {"from": self.me, "text": text, "t": SERVER_TIME}
        if isinstance(invite, dict) and invite.get("n"):
            msg["inv"] = {k: str(invite.get(k, ""))[:120] for k in ("n", "p", "c")}
        if not text and "inv" not in msg:
            raise FriendsError("Mensagem vazia.")
        key = fb.post(f"chats/{chat_id(self.me, uid)}", msg)["name"]
        self.mark_read(uid, key)
        return key

    def mark_read(self, uid, key):
        with self.lock:
            last = self.store.setdefault("lastRead", {})
            if key and key > last.get(uid, ""):
                last[uid] = key
                self._persist()
            if uid in self.friends:
                self.friends[uid]["unread"] = False

    def queue_activity(self, item):
        if not self.configured() or not self.flag("shareActivity"):
            return
        with self.lock:
            pending = self.store.setdefault("pending", [])
            pending.append({**item, "t": now_ms()})
            del pending[:-30]
            self.save()
        self.wake.set()

    # -- sincronização
    def _write_pub(self, local):
        pub = {"name": self.store.get("name") or "Jogador", "avatar": self.store.get("avatar", "🎮"),
               "code": self.store["code"], "state": local.get("state", "online"), "lastSeen": SERVER_TIME,
               "v": self.version}
        if self.store.get("img"):
            pub["img"] = self.store["img"]
        game = local.get("game")
        if game and self.flag("shareGame"):
            pub.update(state="playing", game={k: str(game.get(k, ""))[:120] for k in ("n", "p", "c")},
                       since=int(game.get("since", 0)))
        elif pub["state"] == "playing":
            pub["state"] = "online"
        res = self.fb.put(f"users/{self.me}/pub", pub, timeout=local.get("timeout", 15))
        seen = res.get("lastSeen") if isinstance(res, dict) else None
        if not isinstance(seen, (int, float)):
            seen = self.fb.get(f"users/{self.me}/pub/lastSeen")
        if isinstance(seen, (int, float)):
            self.offset = int(seen) - now_ms()

    def server_now(self):
        return now_ms() + self.offset

    def friend_state(self, pub):
        if not isinstance(pub, dict):
            return "offline"
        if pub.get("state") == "offline" or self.server_now() - int(pub.get("lastSeen") or 0) > ONLINE_WINDOW_MS:
            return "offline"
        return pub.get("state") if pub.get("state") in ("online", "away", "playing") else "online"

    def sync(self, local):
        """Um ciclo: publica meu status/atividade/biblioteca e lê amigos, pedidos e últimas mensagens."""
        if not self.configured():
            return
        with self.lock:
            fb = self.fb
            me = self.me
            try:
                self._write_pub(local)
                self._push_activity(fb, me)
                self._push_library(fb, me, local.get("library"))
                friend_ids = [u for u, v in (fb.get(f"friends/{me}") or {}).items() if v is True]
                requests = fb.get(f"requests/{me}") or {}
                fresh = {}
                for uid in friend_ids:
                    fresh[uid] = self._read_friend(fb, uid)
                self._diff(fresh, requests)
                self.friends = {u: f for u, f in fresh.items() if f is not None}
                self.requests = {u: r for u, r in requests.items() if isinstance(r, dict)}
                sent = self.store.setdefault("sent", {})
                for uid in [u for u in sent if u in self.friends]:
                    sent.pop(uid)
                self.error = ""
                self.last_sync = time.time()
                self._synced_once = True
                self._persist()
            except FriendsError as exc:
                self.error = str(exc)

    def _push_activity(self, fb, me):
        pending = self.store.get("pending") or []
        while pending and self.flag("shareActivity"):
            item = pending[0]
            fb.post(f"users/{me}/activity", {k: v for k, v in item.items() if v not in (None, "")})
            pending.pop(0)
            self.save()
        if not self._trimmed and self.flag("shareActivity"):
            keys = sorted(fb.get(f"users/{me}/activity", shallow="true") or {})
            if len(keys) > ACTIVITY_KEEP:
                fb.patch(f"users/{me}/activity", {k: None for k in keys[:-ACTIVITY_KEEP]})
            self._trimmed = True

    def _push_library(self, fb, me, library):
        if library is None or not self.flag("shareLibrary"):
            return
        digest = hashlib.sha1(json.dumps(library, sort_keys=True).encode()).hexdigest()
        if digest == self._lib_hash:
            return
        if self._lib_hash is not None and time.time() - self._lib_at < LIBRARY_MIN_INTERVAL:
            return
        fb.put(f"users/{me}/library", library or None)
        self._lib_hash, self._lib_at = digest, time.time()

    def _read_friend(self, fb, uid):
        try:
            pub = fb.get(f"users/{uid}/pub")
            activity = last_items(fb, f"users/{uid}/activity", 15)
        except PermissionDenied:
            return None  # ele desfez a amizade
        last = last_items(fb, f"chats/{chat_id(self.me, uid)}", 1)
        last_msg = {"id": last[0][0], **last[0][1]} if last else None
        read_key = self.store.get("lastRead", {}).get(uid, "")
        pub = pub if isinstance(pub, dict) else {}
        return {"uid": uid, "name": pub.get("name") or "Amigo", "avatar": pub.get("avatar") or "🎮",
                "img": self.avatar_url(uid, pub.get("img"), fb),
                "code": pretty_code(pub.get("code", "")), "state": self.friend_state(pub), "game": pub.get("game"),
                "since": pub.get("since", 0), "lastSeen": pub.get("lastSeen", 0),
                "activity": [{"id": k, **v} for k, v in reversed(activity)],
                "lastMsg": last_msg, "unread": bool(last_msg and last_msg.get("from") != self.me and last_msg["id"] > read_key)}

    def _diff(self, fresh, requests):
        if not self._synced_once:
            return  # primeira leitura: nada é novidade
        sent = self.store.get("sent", {})
        for uid, req in requests.items():
            if uid not in self.requests and isinstance(req, dict):
                self._event("request", uid=uid, name=req.get("name", "Alguém"))
        for uid, f in fresh.items():
            if f is None:
                continue
            old = self.friends.get(uid)
            if old is None:
                if uid in sent:
                    self._event("accepted", uid=uid, name=f["name"])
                continue
            if old["state"] == "offline" and f["state"] != "offline":
                self._event("online", uid=uid, name=f["name"])
            if f["state"] == "playing" and f.get("game") and (old.get("game") or {}).get("n") != f["game"].get("n"):
                self._event("playing", uid=uid, name=f["name"], game=f["game"].get("n", ""))
            new_msg, old_msg = f.get("lastMsg"), old.get("lastMsg")
            if f["unread"] and new_msg and (not old_msg or new_msg["id"] != old_msg["id"]):
                self._event("message", uid=uid, name=f["name"], text=new_msg.get("text", ""), inv=new_msg.get("inv"))

    def go_offline(self):
        """Avisa que saiu (ao fechar o app). Melhor esforço: sem rede, os amigos veem offline em ~1 min."""
        if not self.configured():
            return
        try:
            with self.lock:
                self._write_pub({"state": "offline", "timeout": 4})
        except FriendsError:
            pass

    # -- para a interface
    def snapshot(self, since=0):
        with self.lock:
            if not self.configured():
                return {"configured": False, "avatars": AVATARS}
            order = {"playing": 0, "online": 1, "away": 2, "offline": 3}
            friends = sorted(self.friends.values(), key=lambda f: (order.get(f["state"], 9), f["name"].lower()))
            return {
                "configured": True, "avatars": AVATARS, "error": self.error, "lastSync": self.last_sync,
                "serverNow": self.server_now(),
                "me": {"uid": self.me, "name": self.store.get("name", ""), "avatar": self.store.get("avatar", "🎮"),
                       "img": self.avatar_url(self.me, self.store.get("img")),
                       "code": pretty_code(self.store.get("code", "")), "shareGame": self.flag("shareGame"),
                       "shareLibrary": self.flag("shareLibrary"), "shareActivity": self.flag("shareActivity")},
                "friends": friends,
                "requests": [{"uid": u, "name": r.get("name", "Alguém"), "avatar": r.get("avatar") or "🎮",
                              "code": pretty_code(r.get("code", ""))} for u, r in self.requests.items()],
                "sent": [{"uid": u, "code": pretty_code(s.get("code", ""))} for u, s in self.store.get("sent", {}).items()],
                "events": [e for e in self.events if e["id"] > since],
                "eventSeq": self._seq,
            }
