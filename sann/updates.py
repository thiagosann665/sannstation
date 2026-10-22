"""Procura versões novas nas Releases do GitHub e escolhe o instalador para atualizar."""
import re

REPO = "thiagosann665/sannstation"
LATEST_URL = f"https://api.github.com/repos/{REPO}/releases/latest"
DOWNLOAD_PREFIX = f"https://github.com/{REPO}/releases/download/"
SETUP_RE = re.compile(r"^SannStation-Setup-[\d.]+\.exe$")


def parse_version(text):
    """'v1.10.2' -> (1, 10, 2). Partes não numéricas ('1.2.0-beta') param a leitura."""
    parts = []
    for piece in str(text).strip().lstrip("vV").split("."):
        m = re.match(r"\d+", piece)
        if not m:
            break
        parts.append(int(m.group(0)))
    return tuple(parts) or (0,)


def is_newer(latest, current):
    a, b = parse_version(latest), parse_version(current)
    width = max(len(a), len(b))
    return a + (0,) * (width - len(a)) > b + (0,) * (width - len(b))


def check(get_json, current):
    """{"available": bool, "version", "notes", "page", "setup"} a partir da última Release publicada."""
    rel = get_json(LATEST_URL)
    if rel.get("draft") or rel.get("prerelease"):
        return {"available": False}
    version = str(rel.get("tag_name") or "").lstrip("vV")
    setup = next((a.get("browser_download_url") for a in rel.get("assets", [])
                  if SETUP_RE.match(str(a.get("name", ""))) and str(a.get("browser_download_url", "")).startswith(DOWNLOAD_PREFIX)),
                 None)
    return {"available": bool(version) and is_newer(version, current), "version": version,
            "notes": str(rel.get("body") or "")[:4000], "page": str(rel.get("html_url") or ""), "setup": setup}
