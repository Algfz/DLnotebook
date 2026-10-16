# montage.ps1 -- labeled side-by-side image strip via ffmpeg (hstack).
# ASCII ONLY.
# usage:  & .\tools\montage.ps1 -Out C:\tmp\cmp.jpg -Img "C:\a.jpg|truth" -Img "C:\b.png|MoGe" [-Height 720] [-Font C:\Windows\Fonts\arial.ttf]
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string[]]$Img,
  [int]$Height = 720,
  [string]$Font = "C:/Windows/Fonts/arial.ttf",
  [double]$FontSize = 26
)
$ErrorActionPreference = "Stop"
$ff = "ffmpeg"
$cmd = @()
foreach ($item in $Img) { $cmd += "-i"; $cmd += ($item -split "\|")[0] }
$fontEsc = $Font -replace ":", "\:"
$parts = @()
for ($i = 0; $i -lt $Img.Count; $i++) {
  $label = ($Img[$i] -split "\|")[1]
  if (-not $label) { $label = "panel$i" }
  $labelSafe = ($label -replace "'", "") -replace ":", "\:"
  $fc = "[$i`:v]scale=-2:$Height,drawtext=fontfile='$fontEsc':text='$labelSafe':x=14:y=12:fontsize=$FontSize`:fontcolor=black`:box=1`:boxcolor=white@0.75[v$i]"
  $parts += $fc
}
$stackIn = ($parts | ForEach-Object { $_ }) -join ";"
$labels = (0..($Img.Count - 1) | ForEach-Object { "[v$_]" }) -join ""
$stack = ";$labels" + "hstack=inputs=$($Img.Count)[out]"
$filter = $stackIn + $stack
& $ff -y -hide_banner -loglevel error @cmd -filter_complex $filter -map "[out]" -q:v 3 $Out
if (Test-Path $Out) { "montage -> $Out  ($((Get-Item $Out).Length) B)" } else { "montage FAILED" }
