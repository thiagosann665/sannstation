"""Acompanha um jogo ou emulador e todos os processos que ele abrir, para medir o tempo de jogo.

Muitos jogos abrem por um "launcher" que inicia o jogo de verdade e fecha logo em seguida; alguns emuladores
se reiniciam ao trocar de configuração. Esperar só o primeiro processo mediria poucos segundos.

No Windows, o processo é colocado num Job Object antes de começar a rodar (é criado suspenso). Tudo o que ele
abrir entra no mesmo Job, e o jogo só "fecha" quando o Job fica sem processos. Fora do Windows, ou se o Job
não puder ser usado, espera o processo principal (comportamento antigo).
"""
import os
import subprocess
import time

IS_WIN = os.name == "nt"
POLL_SECONDS = 2.0


class Watched:
    """Um processo iniciado. wait(tick, every) bloqueia até o jogo fechar, chamando tick() a cada `every` s."""

    def __init__(self, proc, job=None):
        self.proc = proc
        self._job = job

    def active_processes(self):
        count = _job_active_processes(self._job) if self._job is not None else None
        if count is None:  # sem Job (ou a consulta falhou): vale o processo principal
            return 0 if self.proc.poll() is not None else 1
        return count

    def wait(self, tick=None, every=60.0):
        last = time.monotonic()
        try:
            while self.active_processes() > 0:
                time.sleep(POLL_SECONDS)
                if tick and time.monotonic() - last >= every:
                    last = time.monotonic()
                    tick()
        finally:
            if self._job is not None:
                _close_handle(self._job)
                self._job = None


def start(cmd, cwd, creationflags=0):
    """Inicia `cmd` (como subprocess.Popen) e devolve um Watched. Pode lançar OSError."""
    common = dict(cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not IS_WIN:
        return Watched(subprocess.Popen(cmd, creationflags=creationflags, **common))
    job = _create_job()
    if job is None:
        return Watched(subprocess.Popen(cmd, creationflags=creationflags, **common))
    proc = subprocess.Popen(cmd, creationflags=creationflags | CREATE_SUSPENDED, **common)
    handle = int(proc._handle)  # noqa: SLF001 - handle do processo criado pelo Popen
    ok = _kernel32().AssignProcessToJobObject(job, handle)
    _ntdll().NtResumeProcess(handle)  # o processo foi criado suspenso: começa a rodar agora, já dentro do Job
    if not ok:
        _close_handle(job)
        return Watched(proc)
    return Watched(proc, job)


# --------------------------------------------------------------------------- Windows (ctypes)

CREATE_SUSPENDED = 0x00000004
JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1

_k32 = None
_nt = None


def _kernel32():
    global _k32
    if _k32 is None:
        import ctypes
        from ctypes import wintypes

        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
        k.CreateJobObjectW.restype = wintypes.HANDLE
        k.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        k.AssignProcessToJobObject.restype = wintypes.BOOL
        k.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD,
                                                ctypes.POINTER(wintypes.DWORD)]
        k.QueryInformationJobObject.restype = wintypes.BOOL
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        _k32 = k
    return _k32


def _ntdll():
    global _nt
    if _nt is None:
        import ctypes
        from ctypes import wintypes

        n = ctypes.WinDLL("ntdll")
        n.NtResumeProcess.argtypes = [wintypes.HANDLE]
        _nt = n
    return _nt


def _create_job():
    try:
        job = _kernel32().CreateJobObjectW(None, None)
    except OSError:
        return None
    return job or None


def _job_active_processes(job):
    import ctypes
    from ctypes import wintypes

    class Accounting(ctypes.Structure):
        _fields_ = [("TotalUserTime", ctypes.c_int64), ("TotalKernelTime", ctypes.c_int64),
                    ("ThisPeriodTotalUserTime", ctypes.c_int64), ("ThisPeriodTotalKernelTime", ctypes.c_int64),
                    ("TotalPageFaultCount", wintypes.DWORD), ("TotalProcesses", wintypes.DWORD),
                    ("ActiveProcesses", wintypes.DWORD), ("TotalTerminatedProcesses", wintypes.DWORD)]

    info = Accounting()
    if not _kernel32().QueryInformationJobObject(job, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
                                                 ctypes.byref(info), ctypes.sizeof(info), None):
        return None
    return info.ActiveProcesses


def _close_handle(handle):
    try:
        _kernel32().CloseHandle(handle)
    except OSError:
        pass
