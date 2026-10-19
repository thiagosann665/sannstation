"""Instalador e desinstalador da SannStation (Windows, por usuario, sem precisar de administrador).

Uso:
  SannStation-Setup.exe                      instalacao com janela
  SannStation-Setup.exe --silent [--dir D] [--no-desktop] [--no-launch]
  Desinstalar.exe --uninstall [--silent] [--purge]   (--purge apaga tambem a biblioteca e as capas)
"""
import os
import shutil
import subprocess
import sys
import threading
import winreg
import zipfile
from pathlib import Path

APP = "SannStation"
OLD_APP = "Ludoteca"  # nome anterior: a instalacao antiga e removida ao instalar
VERSION = "1.0.0"
RES = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
PAYLOAD = RES / "payload.zip"
ICON_PNG = RES / "sannstation.png"
DEFAULT_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Programs" / APP
DATA_DIR = Path(os.environ.get("APPDATA", Path.home())) / APP
UNINSTALL_KEY = rf"Software\Microsoft\Windows\CurrentVersion\Uninstall\{APP}"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def start_menu_dir():
    return Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs"


def desktop_dir():
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", "[Environment]::GetFolderPath('Desktop')"],
                             capture_output=True, text=True, timeout=20, creationflags=NO_WINDOW)
        if out.stdout.strip():
            return Path(out.stdout.strip())
    except (OSError, subprocess.SubprocessError):
        pass
    return Path.home() / "Desktop"


def make_shortcut(lnk, target, workdir):
    ps = ("$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK);"
          "$s.TargetPath=$env:TGT;$s.WorkingDirectory=$env:WD;$s.IconLocation=$env:TGT+',0';"
          "$s.Description='SannStation - biblioteca de jogos';$s.Save()")
    env = {**os.environ, "LNK": str(lnk), "TGT": str(target), "WD": str(workdir)}
    subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], env=env, check=True,
                   timeout=30, creationflags=NO_WINDOW)


def close_running_app():
    for name in (APP, OLD_APP):
        subprocess.run(["taskkill", "/F", "/IM", f"{name}.exe"], capture_output=True, creationflags=NO_WINDOW)


def remove_old_install():
    """Remove a instalacao com o nome antigo (atalhos, registro e pasta). Os dados sao migrados pelo app."""
    key = rf"Software\Microsoft\Windows\CurrentVersion\Uninstall\{OLD_APP}"
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as k:
            old_dir = Path(winreg.QueryValueEx(k, "InstallLocation")[0])
    except OSError:
        return
    for lnk in (start_menu_dir() / f"{OLD_APP}.lnk", desktop_dir() / f"{OLD_APP}.lnk"):
        try:
            lnk.unlink()
        except OSError:
            pass
    if (old_dir / f"{OLD_APP}.exe").exists():
        shutil.rmtree(old_dir, ignore_errors=True)
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
    except OSError:
        pass


def dir_size_kb(path):
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file()) // 1024


def install(target, desktop, progress=lambda pct, msg: None):
    target = Path(target)
    progress(5, f"Fechando a {APP}, se estiver aberta…")
    close_running_app()
    progress(8, "Removendo a versão anterior…")
    remove_old_install()
    if (target / "_internal").exists():
        shutil.rmtree(target / "_internal", ignore_errors=True)
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(PAYLOAD) as z:
        members = z.infolist()
        for i, m in enumerate(members, 1):
            z.extract(m, target)
            if i % 25 == 0 or i == len(members):
                progress(10 + int(75 * i / len(members)), "Copiando arquivos…")
    exe = target / f"{APP}.exe"
    uninstaller = target / "Desinstalar.exe"
    if getattr(sys, "frozen", False) and Path(sys.executable).resolve() != uninstaller.resolve():
        shutil.copy2(sys.executable, uninstaller)
    progress(88, "Criando atalhos…")
    make_shortcut(start_menu_dir() / f"{APP}.lnk", exe, target)
    if desktop:
        make_shortcut(desktop_dir() / f"{APP}.lnk", exe, target)
    progress(95, "Registrando no Windows…")
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY) as k:
        values = {
            "DisplayName": APP, "DisplayVersion": VERSION, "Publisher": APP, "DisplayIcon": f"{exe},0",
            "InstallLocation": str(target), "UninstallString": f'"{uninstaller}" --uninstall',
            "QuietUninstallString": f'"{uninstaller}" --uninstall --silent',
        }
        for name, value in values.items():
            winreg.SetValueEx(k, name, 0, winreg.REG_SZ, value)
        for name in ("NoModify", "NoRepair"):
            winreg.SetValueEx(k, name, 0, winreg.REG_DWORD, 1)
        winreg.SetValueEx(k, "EstimatedSize", 0, winreg.REG_DWORD, dir_size_kb(target))
    progress(100, "Pronto!")
    return exe


def installed_dir():
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY) as k:
            return Path(winreg.QueryValueEx(k, "InstallLocation")[0])
    except OSError:
        return None


def uninstall(purge):
    target = installed_dir() or Path(sys.executable).parent
    close_running_app()
    for lnk in (start_menu_dir() / f"{APP}.lnk", desktop_dir() / f"{APP}.lnk"):
        try:
            lnk.unlink()
        except OSError:
            pass
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY)
    except OSError:
        pass
    if purge:
        shutil.rmtree(DATA_DIR, ignore_errors=True)
    # O desinstalador roda de dentro da pasta: apaga tudo depois que este processo terminar.
    if (target / f"{APP}.exe").exists() or (target / "Desinstalar.exe").exists():
        subprocess.Popen(f'cmd /c ping 127.0.0.1 -n 3 > nul & rmdir /s /q "{target}"',
                         creationflags=NO_WINDOW | subprocess.DETACHED_PROCESS, close_fds=True)


# --------------------------------------------------------------------------- interface

def run_gui_install():
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    root = tk.Tk()
    root.title(f"Instalar {APP}")
    root.resizable(False, False)
    try:
        icon = tk.PhotoImage(file=str(ICON_PNG))
        root.iconphoto(True, icon)
    except tk.TclError:
        icon = None
    frm = ttk.Frame(root, padding=22)
    frm.grid()
    head = ttk.Frame(frm)
    head.grid(row=0, column=0, columnspan=3, sticky="w", pady=(0, 14))
    if icon:
        small = icon.subsample(4)
        root._small = small  # mantem a referencia viva
        ttk.Label(head, image=small).grid(row=0, column=0, rowspan=2, padx=(0, 14))
    ttk.Label(head, text=f"{APP} {VERSION}", font=("Segoe UI", 16, "bold")).grid(row=0, column=1, sticky="w")
    ttk.Label(head, text="Sua biblioteca de jogos, emuladores e capas em um só lugar.").grid(row=1, column=1, sticky="w")

    ttk.Label(frm, text="Pasta de instalação:").grid(row=1, column=0, columnspan=3, sticky="w")
    path_var = tk.StringVar(value=str(installed_dir() or DEFAULT_DIR))
    ttk.Entry(frm, textvariable=path_var, width=58).grid(row=2, column=0, columnspan=2, sticky="we", pady=4)

    def browse():
        chosen = filedialog.askdirectory(initialdir=path_var.get(), title="Escolha onde instalar")
        if chosen:
            path_var.set(str(Path(chosen) / APP if Path(chosen).name.lower() != APP.lower() else Path(chosen)))

    ttk.Button(frm, text="Alterar…", command=browse).grid(row=2, column=2, padx=(6, 0))
    desk_var = tk.BooleanVar(value=True)
    launch_var = tk.BooleanVar(value=True)
    ttk.Checkbutton(frm, text="Criar atalho na Área de Trabalho", variable=desk_var).grid(row=3, column=0, columnspan=3, sticky="w", pady=(10, 0))
    ttk.Checkbutton(frm, text=f"Abrir a {APP} ao terminar", variable=launch_var).grid(row=4, column=0, columnspan=3, sticky="w")
    ttk.Label(frm, text=f"Sua biblioteca e capas ficam em {DATA_DIR} e são mantidas nas atualizações.",
              foreground="#666", wraplength=470).grid(row=5, column=0, columnspan=3, sticky="w", pady=(10, 0))
    bar = ttk.Progressbar(frm, length=470, maximum=100)
    bar.grid(row=6, column=0, columnspan=3, pady=(16, 4), sticky="we")
    status = ttk.Label(frm, text="")
    status.grid(row=7, column=0, columnspan=3, sticky="w")
    btns = ttk.Frame(frm)
    btns.grid(row=8, column=0, columnspan=3, sticky="e", pady=(12, 0))
    cancel = ttk.Button(btns, text="Cancelar", command=root.destroy)
    go = ttk.Button(btns, text="Instalar")
    cancel.grid(row=0, column=0, padx=4)
    go.grid(row=0, column=1)

    def progress(pct, msg):
        root.after(0, lambda: (bar.configure(value=pct), status.configure(text=msg)))

    def finish(exe, error):
        if error:
            go.state(["!disabled"])
            cancel.state(["!disabled"])
            messagebox.showerror(APP, f"A instalação falhou:\n\n{error}")
            return
        if launch_var.get():
            subprocess.Popen([str(exe)], cwd=str(exe.parent), close_fds=True)
        messagebox.showinfo(APP, f"{APP} instalada com sucesso!\n\nProcure por “{APP}” no Menu Iniciar.")
        root.destroy()

    def worker(target, desktop):
        try:
            exe = install(target, desktop, progress)
            root.after(0, lambda: finish(exe, None))
        except Exception as exc:  # noqa: BLE001
            root.after(0, lambda e=exc: finish(None, e))

    def start():
        go.state(["disabled"])
        cancel.state(["disabled"])
        threading.Thread(target=worker, args=(path_var.get(), desk_var.get()), daemon=True).start()

    go.configure(command=start)
    root.bind("<Return>", lambda e: start())
    root.mainloop()


def run_gui_uninstall():
    import tkinter as tk
    from tkinter import messagebox

    root = tk.Tk()
    root.withdraw()
    if not messagebox.askyesno(APP, f"Remover a {APP} deste computador?"):
        return
    purge = messagebox.askyesno(
        APP, f"Apagar também sua biblioteca, configurações e capas baixadas?\n\n{DATA_DIR}\n\n"
             "Escolha “Não” para manter tudo caso reinstale depois.", default="no")
    uninstall(purge)
    messagebox.showinfo(APP, f"A {APP} foi removida.")


def main():
    args = sys.argv[1:]
    silent = "--silent" in args
    if "--uninstall" in args or Path(sys.executable).stem.lower() == "desinstalar":
        if silent:
            uninstall("--purge" in args)
        else:
            run_gui_uninstall()
        return
    if silent:
        target = Path(args[args.index("--dir") + 1]) if "--dir" in args else DEFAULT_DIR
        exe = install(target, "--no-desktop" not in args)
        if "--no-launch" not in args:
            subprocess.Popen([str(exe)], cwd=str(exe.parent), close_fds=True)
        return
    run_gui_install()


if __name__ == "__main__":
    main()
