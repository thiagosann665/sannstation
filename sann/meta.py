"""Informações do jogo (ano, gênero, desenvolvedora, publicadora, descrição) a partir da Wikipedia.

Usa a caixa de informações ("Infobox video game") do artigo em inglês, que é a mais completa, e a
introdução do artigo em português quando existe (senão a em inglês). Sem chave de API.
"""
import difflib
import re
import urllib.parse

EN_API = "https://en.wikipedia.org/w/api.php"
PT_API = "https://pt.wikipedia.org/w/api.php"

GENRES_PT = {
    "action": "Ação", "action-adventure": "Ação e aventura", "action role-playing": "RPG de ação",
    "adventure": "Aventura", "role-playing": "RPG", "role-playing video game": "RPG", "rpg": "RPG",
    "japanese role-playing": "RPG japonês", "tactical role-playing": "RPG tático", "platform": "Plataforma",
    "platformer": "Plataforma", "platform game": "Plataforma", "puzzle": "Quebra-cabeça", "puzzle-platform": "Plataforma e quebra-cabeça",
    "racing": "Corrida", "kart racing": "Corrida", "sports": "Esporte", "fighting": "Luta", "beat 'em up": "Beat 'em up",
    "shooter": "Tiro", "first-person shooter": "Tiro em primeira pessoa", "third-person shooter": "Tiro em terceira pessoa",
    "shoot 'em up": "Shoot 'em up", "survival horror": "Survival horror", "horror": "Terror", "stealth": "Furtividade",
    "strategy": "Estratégia", "real-time strategy": "Estratégia em tempo real", "turn-based strategy": "Estratégia por turnos",
    "simulation": "Simulação", "life simulation": "Simulação de vida", "farm life sim": "Simulação de fazenda",
    "sandbox": "Sandbox", "survival": "Sobrevivência", "roguelike": "Roguelike", "roguelite": "Roguelite",
    "metroidvania": "Metroidvania", "hack and slash": "Hack and slash", "music": "Música", "rhythm": "Ritmo",
    "party": "Party game", "visual novel": "Visual novel", "open world": "Mundo aberto", "battle royale": "Battle royale",
    "mmorpg": "MMORPG", "massively multiplayer online role-playing": "MMORPG", "educational": "Educativo",
    "card": "Cartas", "digital collectible card": "Cartas", "point-and-click adventure": "Aventura point-and-click",
    "graphic adventure": "Aventura gráfica", "interactive fiction": "Ficção interativa", "run and gun": "Run and gun",
    "dungeon crawl": "Dungeon crawler", "tower defense": "Tower defense", "city-building": "Construção de cidades",
    "construction and management simulation": "Construção e gerenciamento", "vehicular combat": "Combate de veículos",
    "flight simulator": "Simulador de voo", "pinball": "Pinball", "maze": "Labirinto", "monster-taming": "Captura de monstros",
}

YEAR_RE = re.compile(r"\b(19[5-9]\d|20[0-4]\d)\b")


def _strip_templates(text, keep=("nowrap", "nobr", "lang", "nihongo")):
    """Remove {{predefinições}}; algumas (nowrap…) mantêm o primeiro parâmetro, listas viram itens."""
    def repl(m):
        inner = m.group(1)
        parts = [p.strip() for p in inner.split("|")]
        name = parts[0].lower().strip()
        if name in ("ubl", "unbulleted list", "plainlist", "flatlist", "hlist", "plain list", "flat list", "collapsible list"):
            items = [p for p in parts[1:] if p and "=" not in p.split("[[")[0]]
            return "\n".join(items) if items else ""
        if name in keep and len(parts) > 1:
            return parts[1]
        if name.startswith(("vgrelease", "video game release", "vgr")):
            return " ".join(parts[1:])
        if name in ("start date", "start date and age", "release date"):
            return " ".join(parts[1:])
        return ""
    prev = None
    while prev != text:  # predefinições aninhadas: resolve de dentro para fora
        prev = text
        text = re.sub(r"\{\{([^{}]*)\}\}", repl, text)
    return text


def clean_value(value):
    """Texto limpo de um campo da infobox (sem refs, links, negrito…), com itens separados por '\\n'."""
    v = re.sub(r"<!--.*?-->", "", value, flags=re.S)
    v = re.sub(r"<ref[^>]*/>", "", v)
    v = re.sub(r"<ref[^>]*>.*?</ref>", "", v, flags=re.S)
    v = re.sub(r"<br\s*/?>", "\n", v, flags=re.I)
    v = _strip_templates(v)
    v = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]+)\]\]", r"\1", v)
    v = re.sub(r"\[https?://\S+\s+([^\]]+)\]", r"\1", v)
    v = re.sub(r"<[^>]+>", "", v)
    v = v.replace("'''", "").replace("''", "").replace("&nbsp;", " ")
    v = re.sub(r"^\s*\*\s*", "", v, flags=re.M)
    return "\n".join(line.strip(" ,;") for line in v.splitlines() if line.strip(" ,;"))


def parse_infobox(wikitext):
    """{campo: valor bruto} da 'Infobox video game' (campos em minúsculas)."""
    m = re.search(r"\{\{\s*Infobox video game", wikitext, re.I)
    if not m:
        return {}
    depth, i = 0, m.start()
    while i < len(wikitext) - 1:  # acha o fim da infobox contando chaves
        pair = wikitext[i:i + 2]
        if pair == "{{":
            depth += 1
            i += 2
            continue
        if pair == "}}":
            depth -= 1
            i += 2
            if depth == 0:
                break
            continue
        i += 1
    body = wikitext[m.end():i - 2]
    fields, depth_t, depth_l, buf, j = {}, 0, 0, [], 0
    while j < len(body):
        two = body[j:j + 2]
        if two in ("{{", "}}", "[[", "]]"):  # pares contam uma vez so (e "}}}}" sao dois pares)
            if two == "{{":
                depth_t += 1
            elif two == "}}":
                depth_t -= 1
            elif two == "[[":
                depth_l += 1
            else:
                depth_l -= 1
            buf.append(two)
            j += 2
            continue
        ch = body[j]
        if ch == "|" and depth_t == 0 and depth_l == 0:
            _store(fields, "".join(buf))
            buf = []
        else:
            buf.append(ch)
        j += 1
    if buf:
        _store(fields, "".join(buf))
    return fields


def _store(fields, chunk):
    if "=" in chunk:
        k, v = chunk.split("=", 1)
        fields[k.strip().lower()] = v.strip()


def _items(value):
    return [x.strip() for x in re.split(r"\n|,(?![^(]*\))", clean_value(value)) if x.strip()]


def translate_genre(genre):
    g = genre.strip()
    return GENRES_PT.get(g.lower(), GENRES_PT.get(re.sub(r"\s+(game|video game)s?$", "", g.lower()), g[:1].upper() + g[1:]))


def meta_from_infobox(fields):
    released = clean_value(fields.get("released", "") or fields.get("release", ""))
    years = [int(y) for y in YEAR_RE.findall(released)]
    genres = []
    for g in _items(fields.get("genre", "")):
        t = translate_genre(g)
        if t and t not in genres and len(t) < 40:
            genres.append(t)
    first = lambda key: (_items(fields.get(key, "")) or [""])[0][:80]  # noqa: E731
    return {"year": min(years) if years else 0, "genres": genres[:4], "developer": first("developer"),
            "publisher": first("publisher"), "series": first("series")}


def _norm(name):
    name = re.sub(r"[\(\[].*?[\)\]]", " ", name.lower()).replace("&", "and")
    name = re.sub(r"^the |, the\b", " ", name)
    return re.sub(r"[^a-z0-9]", "", name)


def best_title(results, name):
    """Título de artigo mais parecido com o nome do jogo (ou None se nada for parecido o bastante)."""
    wanted = _norm(name)
    best, score = None, 0.0
    for title in results:
        clean = re.sub(r"\s*\((?:\d{4} )?(?:video )?game\)$", "", title, flags=re.I)
        ratio = difflib.SequenceMatcher(None, wanted, _norm(clean)).ratio()
        if ratio > score:
            best, score = title, ratio
    return best if score >= 0.82 else None


def fetch_meta(name, get_json, title=None):
    """Busca as informações de um jogo. get_json(url) faz a requisição (fica no app, que sabe de rede).

    Devolve {"title", "year", "genres", "developer", "publisher", "series", "description", "url"} ou None.
    """
    if not title:
        q = urllib.parse.urlencode({"action": "query", "format": "json", "list": "search", "srlimit": 6,
                                    "srsearch": f'{name} hastemplate:"Infobox video game"'})
        hits = [h["title"] for h in get_json(f"{EN_API}?{q}").get("query", {}).get("search", [])]
        title = best_title(hits, name)
        if not title:
            return None
    q = urllib.parse.urlencode({"action": "query", "format": "json", "formatversion": 2, "redirects": 1,
                                "titles": title, "prop": "revisions|extracts|langlinks", "rvprop": "content",
                                "rvslots": "main", "rvsection": 0, "exintro": 1, "explaintext": 1, "lllang": "pt"})
    pages = get_json(f"{EN_API}?{q}").get("query", {}).get("pages", [])
    if not pages or pages[0].get("missing"):
        return None
    page = pages[0]
    wikitext = ((page.get("revisions") or [{}])[0].get("slots", {}).get("main", {}).get("content", ""))
    meta = meta_from_infobox(parse_infobox(wikitext))
    description = (page.get("extract") or "").strip()
    url = "https://en.wikipedia.org/wiki/" + urllib.parse.quote(page.get("title", title).replace(" ", "_"))
    pt_title = next((ll.get("title") for ll in page.get("langlinks", []) if ll.get("lang") == "pt"), None)
    if pt_title:
        q = urllib.parse.urlencode({"action": "query", "format": "json", "formatversion": 2, "titles": pt_title,
                                    "prop": "extracts", "exintro": 1, "explaintext": 1})
        try:
            pt_pages = get_json(f"{PT_API}?{q}").get("query", {}).get("pages", [])
            pt_text = (pt_pages[0].get("extract") or "").strip() if pt_pages else ""
            if pt_text:
                description = pt_text
                url = "https://pt.wikipedia.org/wiki/" + urllib.parse.quote(pt_title.replace(" ", "_"))
        except (OSError, ValueError):
            pass
    meta.update({"title": page.get("title", title), "description": _short(description), "url": url})
    return meta


def _short(text, limit=1200):
    text = re.sub(r"\n{2,}", "\n\n", text)
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(". ", 1)[0]
    return cut + "."
