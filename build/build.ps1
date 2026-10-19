# Gera os arquivos de distribuicao da SannStation:
#   dist\SannStation-Setup-<versao>.exe   instalador (por usuario, sem administrador)
#   dist\SannStation-Portatil-<versao>.zip versao portatil (descompacte e rode SannStation.exe; dados ficam na pasta)
# Uso: powershell -ExecutionPolicy Bypass -File build\build.ps1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Build = Join-Path $Root 'build'
$Version = (Select-String -Path (Join-Path $Root 'app.py') -Pattern '^APP_VERSION = "(.+)"').Matches[0].Groups[1].Value
$Out = Join-Path $Root 'dist'
Set-Location $Root

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

Step "Ambiente de build (Python venv + PyInstaller)"
$Py = Join-Path $Build '.venv\Scripts\python.exe'
if (-not (Test-Path $Py)) {
    python -m venv (Join-Path $Build '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao criar o venv. O Python 3.9+ esta instalado?' }
}
& $Py -m pip install --quiet --disable-pip-version-check pyinstaller truststore
if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar o PyInstaller.' }

Step "Icone"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Build 'make_icon.ps1') (Join-Path $Build 'assets')
Copy-Item (Join-Path $Build 'assets\sannstation.png') (Join-Path $Root 'web\icon.png') -Force

Step "SannStation.exe"
$Common = @('--noconfirm', '--clean', '--distpath', (Join-Path $Build 'dist'), '--workpath', (Join-Path $Build 'work'), '--specpath', $Build)
& $Py -m PyInstaller @Common --windowed --name SannStation --icon (Join-Path $Build 'assets\sannstation.ico') `
    --add-data "$(Join-Path $Root 'web');web" --version-file (Join-Path $Build 'version_info.txt') (Join-Path $Root 'app.py')
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller falhou (app).' }

Step "Pacote para o instalador"
$AppDist = Join-Path $Build 'dist\SannStation'
Remove-Item (Join-Path $AppDist 'portable.txt'), (Join-Path $AppDist 'data') -Recurse -Force -ErrorAction SilentlyContinue
$Payload = Join-Path $Build 'payload.zip'
Remove-Item $Payload -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $AppDist '*') -DestinationPath $Payload -CompressionLevel Optimal

Step "Instalador"
& $Py -m PyInstaller @Common --onefile --windowed --name "SannStation-Setup-$Version" --icon (Join-Path $Build 'assets\sannstation.ico') `
    --add-data "$Payload;." --add-data "$(Join-Path $Build 'assets\sannstation.png');." (Join-Path $Build 'installer.py')
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller falhou (instalador).' }

Step "Saida em $Out"
New-Item -ItemType Directory -Force $Out | Out-Null
Copy-Item (Join-Path $Build "dist\SannStation-Setup-$Version.exe") $Out -Force
$Portable = Join-Path $Out "SannStation-Portatil-$Version.zip"
Remove-Item $Portable -Force -ErrorAction SilentlyContinue
$Tmp = Join-Path $Build 'portable\SannStation'
Remove-Item (Join-Path $Build 'portable') -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $Tmp | Out-Null
Copy-Item (Join-Path $AppDist '*') $Tmp -Recurse
Set-Content -Path (Join-Path $Tmp 'portable.txt') -Value 'Modo portatil: a biblioteca e as capas ficam na pasta "data" ao lado do programa.' -Encoding UTF8
Compress-Archive -Path $Tmp -DestinationPath $Portable -CompressionLevel Optimal
Get-ChildItem $Out | Format-Table Name, @{n='Tamanho (MB)'; e={[math]::Round($_.Length / 1MB, 1)}} -AutoSize
