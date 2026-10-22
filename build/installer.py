"""Instalador e desinstalador da SannStation (Windows, por usuario, sem precisar de administrador).

Uso:
  SannStation-Setup.exe                      instalacao com janela
  SannStation-Setup.exe --silent [--dir D] [--no-desktop] [--no-launch]
  Desinstalar.exe --uninstall [--silent] [--purge]   (--purge apaga tambem a biblioteca e as capas)
"""
import ctypes
import os
import shutil
import subprocess
import sys
import threading
import uuid
import winreg
import zipfile
from pathlib import Path

APP = "SannStation"
OLD_APP = "Ludoteca"  # nome anterior: a instalacao antiga e removida ao instalar
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # rodando do codigo: acha o pacote sann
from sann.version import VERSION  # noqa: E402 - numero da versao num lugar so
RES = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
PAYLOAD = RES / "payload.zip"
ICON_PNG = RES / "sannstation.png"
DEFAULT_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Programs" / APP
DATA_DIR = Path(os.environ.get("APPDATA", Path.home())) / APP
UNINSTALL_KEY = rf"Software\Microsoft\Windows\CurrentVersion\Uninstall\{APP}"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
# Lista dos arquivos que o instalador colocou na pasta: o desinstalador apaga SO estes.
# (A pasta pode ser escolhida pelo usuario, ex. "D:\Jogos"; apagar a pasta inteira levaria junto arquivos dele.)
MANIFEST = "instalacao.manifest"
UNINSTALLER = "Desinstalar.exe"


FOLDERID_DESKTOP = "B4BFCC3A-DB2C-424C-B029-7FE99A87C641"
FOLDERID_PROGRAMS = "A77F5D77-2E2B-44C3-A6A2-ABA601054A51"  # Menu Iniciar > Programas do usuario


def known_folder(folder_id):
    """Caminho de uma pasta especial do Windows (respeita OneDrive e nomes com acento)."""
    class GUID(ctypes.Structure):
        _fields_ = [("d1", ctypes.c_uint32), ("d2", ctypes.c_uint16), ("d3", ctypes.c_uint16),
                    ("d4", ctypes.c_ubyte * 8)]

    u = uuid.UUID(folder_id)
    guid = GUID(u.time_low, u.time_mid, u.time_hi_version, (ctypes.c_ubyte * 8)(*u.bytes[8:]))
    out = ctypes.c_wchar_p()
    if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(out)) != 0:
        raise OSError(f"Pasta especial do Windows nao encontrada: {folder_id}")
    try:
        return Path(out.value)
    finally:
        ctypes.windll.ole32.CoTaskMemFree(out)


def start_menu_dir():
    try:
        return known_folder(FOLDERID_PROGRAMS)
    except OSError:
        return Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs"


def desktop_dir():
    try:
        return known_folder(FOLDERID_DESKTOP)
    except OSError:
        return Path.home() / "Desktop"


def make_shortcut(lnk, target, workdir):
    Path(lnk).parent.mkdir(parents=True, exist_ok=True)
    ps = ("$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK);"
          "$s.TargetPath=$env:TGT;$s.WorkingDirectory=$env:WD;$s.IconLocation=$env:TGT+',0';"
          "$s.Description='SannStation - biblioteca de jogos';$s.Save()")
    env = {**os.environ, "LNK": str(lnk), "TGT": str(target), "WD": str(workdir)}
    out = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], env=env,
                         capture_output=True, timeout=30, creationflags=NO_WINDOW)
    if out.returncode != 0 or not Path(lnk).exists():
        detail = out.stderr.decode("cp850", "replace").strip().splitlines()
        raise OSError(detail[0] if detail else "não foi possível criar o atalho")


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
        # So os arquivos do programa antigo; a pasta sai apenas se ficar vazia (pode ter arquivos do usuario).
        for name in (f"{OLD_APP}.exe", UNINSTALLER):
            try:
                (old_dir / name).unlink()
            except OSError:
                pass
        shutil.rmtree(old_dir / "_internal", ignore_errors=True)
        try:
            old_dir.rmdir()
        except OSError:
            pass
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
    uninstaller = target / UNINSTALLER
    if getattr(sys, "frozen", False) and Path(sys.executable).resolve() != uninstaller.resolve():
        shutil.copy2(sys.executable, uninstaller)
    files = [m.filename for m in members if not m.is_dir()] + [UNINSTALLER]
    (target / MANIFEST).write_text("\n".join(files) + "\n", "utf-8")
    progress(88, "Criando atalhos…")
    warnings = []
    places = [("Menu Iniciar", start_menu_dir())] + ([("Área de Trabalho", desktop_dir())] if desktop else [])
    for label, folder in places:
        try:
            make_shortcut(folder / f"{APP}.lnk", exe, target)
        except (OSError, subprocess.SubprocessError) as exc:
            warnings.append(f"Atalho em {label} não foi criado ({exc}).")
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
    return exe, warnings


def installed_dir():
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY) as k:
            return Path(winreg.QueryValueEx(k, "InstallLocation")[0])
    except OSError:
        return None


def installed_files(target):
    """Arquivos da instalacao (caminhos relativos). Sem manifesto (versao <= 1.0.6): so os nomes conhecidos."""
    manifest = target / MANIFEST
    if manifest.is_file():
        names = [n.strip() for n in manifest.read_text("utf-8", errors="replace").splitlines() if n.strip()]
    else:
        internal = target / "_internal"
        names = [f"{APP}.exe", UNINSTALLER]
        if internal.is_dir():
            names += [str(f.relative_to(target)) for f in internal.rglob("*") if f.is_file()]
    base = target.resolve()
    safe = []
    for name in names:
        path = (target / name).resolve()
        if base in path.parents:  # ignora caminhos absolutos ou com ".." no manifesto
            safe.append(path)
    return safe


def remove_empty_dirs(target, files):
    """Remove, de baixo para cima, as subpastas que ficaram vazias (nunca pastas com arquivos do usuario)."""
    base = target.resolve()
    dirs = {d for f in files for d in f.parents if base in d.parents}
    for d in sorted(dirs, key=lambda p: len(p.parts), reverse=True):
        try:
            d.rmdir()  # so funciona se estiver vazia
        except OSError:
            pass


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
    if not target.is_dir():
        return
    files = installed_files(target)
    me = Path(sys.executable).resolve()
    leftovers = []  # arquivos em uso (o proprio desinstalador): apagados depois que este processo terminar
    for f in files:
        if f == me:
            leftovers.append(f)
            continue
        try:
            f.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            leftovers.append(f)
    remove_empty_dirs(target, files)
    try:
        (target / MANIFEST).unlink()
    except OSError:
        pass
    # "rmdir" sem /s so remove a pasta se ela ficou vazia: arquivos do usuario nunca sao apagados.
    cmds = ["ping 127.0.0.1 -n 3 > nul"] + [f'del /f /q "{f}"' for f in leftovers] + [f'rmdir "{target}"']
    subprocess.Popen("cmd /c " + " & ".join(cmds),
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

    def finish(result, error):
        if error:
            go.state(["!disabled"])
            cancel.state(["!disabled"])
            messagebox.showerror(APP, f"A instalação falhou:\n\n{error}")
            return
        exe, warnings = result
        if launch_var.get():
            subprocess.Popen([str(exe)], cwd=str(exe.parent), close_fds=True)
        msg = f"{APP} instalada com sucesso!\n\nProcure por “{APP}” no Menu Iniciar."
        if warnings:
            msg += "\n\nAviso:\n" + "\n".join(warnings) + f"\n\nO programa fica em:\n{exe}"
            messagebox.showwarning(APP, msg)
        else:
            messagebox.showinfo(APP, msg)
        root.destroy()

    def worker(target, desktop):
        try:
            result = install(target, desktop, progress)
            root.after(0, lambda: finish(result, None))
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
        exe, warnings = install(target, "--no-desktop" not in args)
        for w in warnings:
            print(w)
        if "--no-launch" not in args:
            subprocess.Popen([str(exe)], cwd=str(exe.parent), close_fds=True)
        return
    run_gui_install()


if __name__ == "__main__":
    main()
