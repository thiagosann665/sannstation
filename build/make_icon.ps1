# Gera o icone da SannStation ("SS" azul sobre fundo escuro arredondado) em PNG e ICO.
# Uso: powershell -ExecutionPolicy Bypass -File build\make_icon.ps1 <pasta de saida>
param([string]$OutDir = (Join-Path $PSScriptRoot 'assets'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force $OutDir | Out-Null

function Get-FontFamily {
    foreach ($name in 'Segoe UI Black', 'Arial Black', 'Segoe UI') {
        $f = New-Object System.Drawing.FontFamily($name) -ErrorAction SilentlyContinue
        if ($f) { return $f }
    }
}

function New-IconPng([int]$size, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'; $g.InterpolationMode = 'HighQualityBicubic'
    $g.Clear([System.Drawing.Color]::Transparent)

    # Fundo: quadrado arredondado com degrade escuro e borda sutil
    $r = [single]($size * 0.22); $s = [single]$size
    $bg = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bg.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90); $bg.AddArc($s - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
    $bg.AddArc($s - 2 * $r, $s - 2 * $r, 2 * $r, 2 * $r, 0, 90); $bg.AddArc(0, $s - 2 * $r, 2 * $r, 2 * $r, 90, 90)
    $bg.CloseFigure()
    $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.PointF(0, 0)), (New-Object System.Drawing.PointF(0, $s)),
        [System.Drawing.Color]::FromArgb(255, 37, 49, 66), [System.Drawing.Color]::FromArgb(255, 13, 17, 24))
    $g.FillPath($bgBrush, $bg)
    if ($size -ge 48) {
        $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(70, 110, 190, 255), [single]([Math]::Max(1, $size / 96)))
        $g.DrawPath($pen, $bg)
    }

    # "SS": letras grossas, levemente sobrepostas, com degrade azul
    $family = Get-FontFamily
    $text = New-Object System.Drawing.Drawing2D.GraphicsPath
    $fmt = [System.Drawing.StringFormat]::GenericTypographic
    $em = [single]($size * 0.70)
    $text.AddString('S', $family, 0, $em, (New-Object System.Drawing.PointF(0, 0)), $fmt)
    $one = $text.GetBounds()
    $text2 = New-Object System.Drawing.Drawing2D.GraphicsPath
    $text2.AddString('S', $family, 0, $em, (New-Object System.Drawing.PointF([single]($one.Width * 0.80), 0)), $fmt)
    $text.AddPath($text2, $false)
    $b = $text.GetBounds()
    $m = New-Object System.Drawing.Drawing2D.Matrix
    $m.Translate([single](($s - $b.Width) / 2 - $b.X), [single](($s - $b.Height) / 2 - $b.Y))
    $text.Transform($m)
    $tb = $text.GetBounds()
    $fg = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.PointF($tb.Left, $tb.Top)), (New-Object System.Drawing.PointF($tb.Right, $tb.Bottom)),
        [System.Drawing.Color]::FromArgb(255, 120, 216, 255), [System.Drawing.Color]::FromArgb(255, 26, 110, 230))
    if ($size -ge 32) {
        # contorno escuro separa as duas letras onde elas se sobrepoem
        $outline = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 16, 21, 29), [single]($size / 40))
        $outline.LineJoin = 'Round'
        $g.DrawPath($outline, $text2)
    }
    $g.FillPath($fg, $text)
    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = @()
foreach ($sz in $sizes) {
    $p = Join-Path $OutDir "icon-$sz.png"
    New-IconPng $sz $p
    $pngs += , @($sz, [IO.File]::ReadAllBytes($p))
}
Copy-Item (Join-Path $OutDir 'icon-256.png') (Join-Path $OutDir 'sannstation.png') -Force

# ICO com as imagens em PNG (suportado desde o Windows Vista)
$ms = New-Object IO.MemoryStream
$w = New-Object IO.BinaryWriter($ms)
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$pngs.Count)
$offset = 6 + 16 * $pngs.Count
foreach ($e in $pngs) {
    $sz = $e[0] % 256; $len = $e[1].Length
    $w.Write([byte]$sz); $w.Write([byte]$sz); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$len); $w.Write([UInt32]$offset)
    $offset += $len
}
foreach ($e in $pngs) { $w.Write([byte[]]$e[1]) }
[IO.File]::WriteAllBytes((Join-Path $OutDir 'sannstation.ico'), $ms.ToArray())
Get-ChildItem $OutDir -Filter 'icon-*.png' | Remove-Item
Write-Host "Icone gerado em $OutDir"
