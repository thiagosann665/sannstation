"""Cronômetro da sessão sobre o jogo (opcional, em Configurações).

Roda num processo separado (SannStation.exe --overlay ...), para não misturar a janela do Tk com o
servidor. Mostra uma pílula discreta no canto da tela, sempre por cima, que não captura o mouse
(os cliques passam para o jogo). Fecha sozinho quando o jogo fecha.

Limitação: jogos em tela cheia exclusiva desenham por cima de tudo; nesses o cronômetro não aparece
(em janela sem bordas, que é o padrão da maioria dos jogos e emuladores atuais, aparece).
"""
import json
import os
import sys
import time
import urllib.request


def _still_running(port, token, game_id):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/ping", headers={"X-Token": token, "X-Page": ""})
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            return game_id in json.loads(r.read()).get("running", {})
    except (OSError, ValueError):
        return False  # app fechou: o cronômetro fecha junto


def _click_through(root):
    """No Windows: janela transparente a cliques, fora da barra de tarefas."""
    if os.name != "nt":
        return
    import ctypes

    GWL_EXSTYLE = -20
    WS_EX_LAYERED, WS_EX_TRANSPARENT, WS_EX_TOOLWINDOW, WS_EX_NOACTIVATE = 0x80000, 0x20, 0x80, 0x08000000
    user32 = ctypes.windll.user32
    hwnd = user32.GetParent(root.winfo_id()) or root.winfo_id()
    style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
    user32.SetWindowLongW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)


def run(argv):
    """argv: --overlay <id do jogo> <início epoch> <porta> <nome do jogo>; token na variável SANNSTATION_TOKEN."""
    try:
        i = argv.index("--overlay")
        game_id, start, port, name = argv[i + 1], float(argv[i + 2]), argv[i + 3], argv[i + 4]
    except (ValueError, IndexError):
        return
    token = os.environ.get("SANNSTATION_TOKEN", "")
    try:
        import tkinter as tk
    except ImportError:
        return
    root = tk.Tk()
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    try:
        root.attributes("-alpha", 0.82)
    except tk.TclError:
        pass
    root.configure(bg="#11151c")
    label = tk.Label(root, text="", fg="#ffffff", bg="#11151c", font=("Segoe UI", 11, "bold"), padx=14, pady=6)
    label.pack()
    short = name if len(name) <= 28 else name[:27] + "…"

    def place():
        root.update_idletasks()
        w, h = root.winfo_width(), root.winfo_height()
        root.geometry(f"+{root.winfo_screenwidth() - w - 24}+{root.winfo_screenheight() - h - 64}")

    last_check = [0.0]

    def tick():
        elapsed = int(time.time() - start)
        h, rem = divmod(elapsed, 3600)
        label.configure(text=f"⏱ {h}:{rem // 60:02d}:{rem % 60:02d}  ·  {short}")
        place()
        if time.time() - last_check[0] > 5:
            last_check[0] = time.time()
            if not _still_running(port, token, game_id):
                root.destroy()
                return
        root.after(1000, tick)

    root.after(50, lambda: _click_through(root))
    tick()
    root.mainloop()


if __name__ == "__main__":
    run(sys.argv)
