# Downscale the 512/1024px icon masters into the standard icon size set.
# Masters are produced by screenshotting export-icon.html with headless Edge at
# 512/1024 (window sizes below ~128px hang or render blank, so never screenshot
# small sizes directly; pass --force-device-scale-factor=1 or Windows display
# scaling crops the shot).
Add-Type -AssemblyName System.Drawing

$png = Join-Path $PSScriptRoot "..\png"

function Resize-Png([string]$source, [string]$target, [int]$size) {
  $src = [System.Drawing.Image]::FromFile($source)
  try {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    # ImageAttributes with TileFlipXY wrap mode stops the bicubic filter from
    # sampling transparent black past the edges, which would darken the border.
    $attrs = New-Object System.Drawing.Imaging.ImageAttributes
    $attrs.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $g.DrawImage($src, $rect, 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
    $g.Dispose()
    $bmp.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "wrote $target"
  } finally {
    $src.Dispose()
  }
}

# 64+ keep the regular mark's proportions; 48 and below switch to the
# small variant so the branch survives taskbar/favicon rendering.
# 24 is the Windows 11 taskbar size at 100% scaling.
foreach ($size in 256, 128, 64) {
  Resize-Png "$png\threadlines-icon-512.png" "$png\threadlines-icon-$size.png" $size
}
foreach ($size in 48, 32, 24, 16) {
  Resize-Png "$png\threadlines-icon-small-512.png" "$png\threadlines-icon-$size.png" $size
}

# Apple touch icon: opaque, 180px, from the opaque 1024 master.
Resize-Png "$png\threadlines-icon-1024-opaque.png" "$png\threadlines-icon-apple-touch-180.png" 180
