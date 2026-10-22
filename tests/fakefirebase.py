"""Firebase falso para os testes: login anônimo + REST do Realtime Database + regras de segurança.

Aplica o mesmo arquivo de regras que vai para o Firebase de verdade (sann/firebase_rules.json), com a
semântica do Realtime Database: .read/.write descem em cascata (basta um "true" num ancestral), .validate
roda em todo nó gravado que não fica nulo (e nos ancestrais), `root`/`data` são os dados antes da escrita
e `newData` depois. Atualizações de vários caminhos (PATCH) são checadas caminho por caminho e aplicadas
juntas ou nada. As expressões das regras são traduzidas para Python (o subconjunto usado nas regras).

Uso: srv = FakeFirebase(); srv.start(); ... srv.url  (base do banco e do login)
"""
import copy
import json
import random
import re
import string
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RULES_PATH = Path(__file__).resolve().parent.parent / "sann" / "firebase_rules.json"
PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz"


# --------------------------------------------------------------------------- linguagem das regras

class S(str):
    """String das regras (com os métodos do Realtime Database)."""

    @property
    def length(self):
        return len(self)

    def contains(self, x):
        return str(x) in self

    def beginsWith(self, x):  # noqa: N802 - nome da linguagem das regras
        return self.startswith(str(x))

    def endsWith(self, x):  # noqa: N802
        return self.endswith(str(x))

    def replace(self, a, b):  # troca todas as ocorrências, como nas regras
        return S(str.replace(self, str(a), str(b)))

    def matches(self, regex):
        return re.search(regex.pattern, self) is not None

    def toLowerCase(self):  # noqa: N802
        return S(self.lower())

    def __add__(self, other):
        return S(str(self) + str(other))


class R:
    def __init__(self, pattern):
        self.pattern = pattern


def wrap(v):
    return S(v) if isinstance(v, str) else v


class Snap:
    def __init__(self, root, parts):
        self.root, self.parts = root, list(parts)

    def _value(self):
        node = self.root
        for p in self.parts:
            if not isinstance(node, dict) or p not in node:
                return None
            node = node[p]
        return node

    def child(self, path):
        return Snap(self.root, self.parts + [p for p in str(path).split("/") if p])

    def parent(self):
        return Snap(self.root, self.parts[:-1])

    def exists(self):
        return self._value() is not None

    def val(self):
        return wrap(self._value())

    def hasChild(self, name):  # noqa: N802
        return self.child(name).exists()

    def hasChildren(self, names=None):  # noqa: N802
        v = self._value()
        if names is None:
            return isinstance(v, dict) and bool(v)
        return all(self.child(n).exists() for n in names)

    def isString(self):  # noqa: N802
        return isinstance(self._value(), str)

    def isNumber(self):  # noqa: N802
        v = self._value()
        return isinstance(v, (int, float)) and not isinstance(v, bool)

    def isBoolean(self):  # noqa: N802
        return isinstance(self._value(), bool)


class Auth:
    def __init__(self, uid):
        self.uid = S(uid)


TOKEN_RE = re.compile(r"""\s*(?:
    (?P<str>'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")
  | (?P<regex>/(?:\\.|[^/\\])+/[a-z]*)
  | (?P<op>===|!==|==|!=|<=|>=|&&|\|\||[!<>+\-*%(),.\[\]])
  | (?P<num>\d+(?:\.\d+)?)
  | (?P<id>\$?[A-Za-z_][A-Za-z0-9_]*)
)""", re.X)


def translate(expr):
    """Expressão das regras -> expressão Python equivalente."""
    out, pos, prev = [], 0, None
    while pos < len(expr):
        if expr[pos:].strip() == "":
            break
        m = TOKEN_RE.match(expr, pos)
        if not m:
            raise ValueError(f"não entendi a regra perto de: {expr[pos:pos + 20]!r}")
        pos = m.end()
        kind = m.lastgroup
        tok = m.group(kind)
        if kind == "regex" and prev != "(":  # "/" fora de matches(...) seria divisão
            raise ValueError("divisão não suportada")
        if kind == "str":
            out.append(f"S({json.dumps(json.loads(tok) if tok[0] == chr(34) else tok[1:-1])})")
        elif kind == "regex":
            body = tok[1:tok.rindex("/")]
            out.append(f"R({body!r})")
        elif kind == "op":
            out.append({"===": " == ", "!==": " != ", "&&": " and ", "||": " or ", "!": " not "}.get(tok, tok))
        elif kind == "id":
            out.append({"null": "None", "true": "True", "false": "False"}.get(tok, "V_" + tok[1:] if tok.startswith("$") else tok))
        else:
            out.append(tok)
        prev = tok
    return "".join(out)


class Rules:
    def __init__(self, rules):
        self.tree = rules["rules"]
        self._cache = {}

    def _eval(self, expr, env):
        code = self._cache.get(expr)
        if code is None:
            code = self._cache[expr] = compile(translate(expr), "<regra>", "eval")
        try:
            return bool(eval(code, {"__builtins__": {}, "S": S, "R": R}, env))  # noqa: S307 - expressões do arquivo de regras
        except Exception:  # noqa: BLE001 - erro numa regra = negado, como no Firebase
            return False

    def levels(self, parts):
        """[(nó de regras, variáveis $, profundidade)] da raiz até o caminho (para onde houver regras)."""
        node, variables, out = self.tree, {}, [(self.tree, {}, 0)]
        for depth, part in enumerate(parts, 1):
            if part in node:
                node = node[part]
            else:
                wild = next((k for k in node if k.startswith("$")), None)
                if wild is None:
                    break
                variables = {**variables, "V_" + wild[1:]: S(part)}
                node = node[wild]
            out.append((node, dict(variables), depth))
        return out

    def env(self, auth, old, new, parts, variables):
        return {"auth": auth, "root": Snap(old, []), "data": Snap(old, parts), "newData": Snap(new, parts),
                "now": int(time.time() * 1000), **variables}

    def can(self, kind, auth, old, new, parts):
        for node, variables, depth in self.levels(parts):
            if f".{kind}" in node and self._eval(node[f".{kind}"], self.env(auth, old, new, parts[:depth], variables)):
                return True
        return False

    def validate(self, auth, old, new, parts):
        """.validate nos ancestrais e em todo o conteúdo novo gravado em `parts`."""
        for node, variables, depth in self.levels(parts)[:-1]:
            sub = parts[:depth]
            if ".validate" in node and Snap(new, sub).exists() and not self._eval(node[".validate"], self.env(auth, old, new, sub, variables)):
                return False
        levels = self.levels(parts)
        if len(levels) != len(parts) + 1:
            return True  # sem regras neste caminho: nada a validar
        node, variables, _ = levels[-1]
        return self._validate_tree(auth, old, new, list(parts), node, variables)

    def _validate_tree(self, auth, old, new, parts, node, variables):
        value = Snap(new, parts)._value()
        if value is None:
            return True
        if ".validate" in node and not self._eval(node[".validate"], self.env(auth, old, new, parts, variables)):
            return False
        if isinstance(value, dict):
            for key in value:
                if key in node:
                    child, child_vars = node[key], variables
                else:
                    wild = next((k for k in node if k.startswith("$")), None)
                    if wild is None:
                        continue
                    child, child_vars = node[wild], {**variables, "V_" + wild[1:]: S(key)}
                if not self._validate_tree(auth, old, new, parts + [key], child, child_vars):
                    return False
        return True


# --------------------------------------------------------------------------- banco de dados

def split(path):
    return [p for p in path.strip("/").split("/") if p]


def resolve_server_values(v, now_ms):
    if isinstance(v, dict):
        if v == {".sv": "timestamp"}:
            return now_ms
        return {k: resolve_server_values(x, now_ms) for k, x in v.items()}
    return v


def prune(v):
    if isinstance(v, dict):
        out = {k: prune(x) for k, x in v.items()}
        out = {k: x for k, x in out.items() if x is not None}
        return out or None
    return v


def set_path(root, parts, value):
    if not parts:
        return prune(copy.deepcopy(value))
    root = copy.deepcopy(root) if isinstance(root, dict) else {}
    node = root
    for p in parts[:-1]:
        if not isinstance(node.get(p), dict):
            node[p] = {}
        node = node[p]
    node[parts[-1]] = copy.deepcopy(value)
    return prune(root) or {}


def get_path(root, parts):
    return Snap(root, parts)._value()


class FakeFirebase:
    def __init__(self, rules_path=RULES_PATH):
        self.rules = Rules(json.loads(Path(rules_path).read_text("utf-8")))
        self.data = {}
        self.tokens = {}  # id token -> (uid, expira em)
        self.refresh = {}  # refresh token -> uid
        self.lock = threading.Lock()
        self.token_seconds = 3600
        self.requests = 0
        self._last_push = (0, [])
        self.server = None

    # -- login anônimo
    def _new_token(self, uid):
        tok = "tok-" + "".join(random.choices(string.ascii_letters, k=24))
        self.tokens[tok] = (uid, time.time() + self.token_seconds)
        return tok

    def sign_up(self):
        uid = "".join(random.choices(string.ascii_letters + string.digits, k=28))
        ref = "ref-" + "".join(random.choices(string.ascii_letters, k=24))
        self.refresh[ref] = uid
        return {"localId": uid, "idToken": self._new_token(uid), "refreshToken": ref, "expiresIn": str(self.token_seconds)}

    def refresh_token(self, ref):
        uid = self.refresh.get(ref)
        if not uid:
            return None
        return {"user_id": uid, "id_token": self._new_token(uid), "refresh_token": ref, "expires_in": str(self.token_seconds)}

    def auth_for(self, token):
        if not token:
            return None, None
        entry = self.tokens.get(token)
        if not entry:
            return None, "Could not parse auth token."
        if entry[1] < time.time():
            return None, "Auth token is expired"
        return Auth(entry[0]), None

    # -- banco
    def push_id(self):
        now = int(time.time() * 1000)
        last_t, last_rand = self._last_push
        if now == last_t:
            rand = list(last_rand)
            for i in range(11, -1, -1):
                if rand[i] < 63:
                    rand[i] += 1
                    break
                rand[i] = 0
        else:
            rand = [random.randrange(64) for _ in range(12)]
        self._last_push = (now, rand)
        t, chars = now, []
        for _ in range(8):
            chars.append(PUSH_CHARS[t % 64])
            t //= 64
        return "".join(reversed(chars)) + "".join(PUSH_CHARS[r] for r in rand)

    def write(self, auth, updates):
        """updates: [(partes do caminho, valor)]. Tudo ou nada. Devolve None ou a mensagem de erro."""
        now = int(time.time() * 1000)
        old = self.data
        new = old
        resolved = []
        for parts, value in updates:
            value = resolve_server_values(value, now)
            resolved.append((parts, value))
            new = set_path(new, parts, value)
        for parts, _ in resolved:
            if not self.rules.can("write", auth, old, new, parts):
                return "Permission denied"
            if not self.rules.validate(auth, old, new, parts):
                return "Permission denied"
        self.data = new
        return None

    def read(self, auth, parts, query):
        if not self.rules.can("read", auth, self.data, self.data, parts):
            return "Permission denied", None
        value = copy.deepcopy(get_path(self.data, parts))
        if isinstance(value, dict):
            if query.get("shallow") == "true":
                return None, {k: True for k in value}
            if query.get("orderBy") == '"$key"':
                keys = sorted(value)
                if "startAt" in query:
                    keys = [k for k in keys if k >= json.loads(query["startAt"])]
                if "endAt" in query:
                    keys = [k for k in keys if k <= json.loads(query["endAt"])]
                if "limitToLast" in query:
                    keys = keys[-int(query["limitToLast"]):]
                if "limitToFirst" in query:
                    keys = keys[:int(query["limitToFirst"])]
                value = {k: value[k] for k in keys} or None
        return None, value

    # -- servidor HTTP
    def start(self):
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def reply(self, code, payload):
                body = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def body(self):
                n = int(self.headers.get("Content-Length") or 0)
                return self.rfile.read(n) if n else b""

            def handle_any(self, method):
                fake.requests += 1
                url = urllib.parse.urlsplit(self.path)
                query = dict(urllib.parse.parse_qsl(url.query))
                raw = self.body()
                if url.path.endswith("/accounts:signUp"):
                    return self.reply(200, fake.sign_up())
                if url.path.endswith("/token"):
                    form = dict(urllib.parse.parse_qsl(raw.decode()))
                    res = fake.refresh_token(form.get("refresh_token", ""))
                    return self.reply(200, res) if res else self.reply(400, {"error": {"message": "INVALID_REFRESH_TOKEN"}})
                if not url.path.endswith(".json"):
                    return self.reply(404, {"error": "404 Not Found"})
                parts = split(urllib.parse.unquote(url.path[:-5]))
                auth, err = fake.auth_for(query.get("auth"))
                if err:
                    return self.reply(401, {"error": err})
                with fake.lock:
                    if method == "GET":
                        err, value = fake.read(auth, parts, query)
                        return self.reply(401, {"error": err}) if err else self.reply(200, value)
                    value = json.loads(raw) if raw else None
                    if method == "PUT":
                        err = fake.write(auth, [(parts, value)])
                        out = resolve_server_values(value, int(time.time() * 1000))
                    elif method == "DELETE":
                        err, out = fake.write(auth, [(parts, None)]), None
                    elif method == "PATCH":
                        if not isinstance(value, dict):
                            return self.reply(400, {"error": "Invalid data; couldn't parse JSON object."})
                        err = fake.write(auth, [(parts + split(k), v) for k, v in value.items()])
                        out = value
                    elif method == "POST":
                        key = fake.push_id()
                        err, out = fake.write(auth, [(parts + [key], value)]), {"name": key}
                    else:
                        return self.reply(405, {"error": "method"})
                    return self.reply(401, {"error": err}) if err else self.reply(200, out)

            def do_GET(self):
                self.handle_any("GET")

            def do_PUT(self):
                self.handle_any("PUT")

            def do_PATCH(self):
                self.handle_any("PATCH")

            def do_POST(self):
                # O REST do Firebase aceita X-HTTP-Method-Override; o login usa POST normal.
                self.handle_any(self.headers.get("X-HTTP-Method-Override", "POST"))

            def do_DELETE(self):
                self.handle_any("DELETE")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        return self

    def stop(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()


if __name__ == "__main__":  # python tests/fakefirebase.py  -> servidor para testar o app à mão
    srv = FakeFirebase().start()
    print(srv.url, flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        srv.stop()
