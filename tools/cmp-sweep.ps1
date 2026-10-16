# cmp-sweep.ps1 -- model comparison: build per-model point clouds, render at the
# engine-truth camera (fov_y=55), and score against the truth frame.
# ASCII ONLY (PowerShell 5.1 chokes on BOM-less UTF-8 with non-ASCII bytes).
param(
  [string]$Seq = "C:\DLnotebook-media\tmp\seq\desert-full",
  [string]$Out = "C:\DLnotebook-media\tmp\cmp",
  [string[]]$Frames = @("f00001", "f00121", "f00301"),
  [string]$MogeScales = "0.25,0.5,1",
  [string]$Da3Scales = "1,2,4,8",
  [int]$Port = 8361
)
$ErrorActionPreference = "Continue"
$Py = "C:\Users\abc\.conda\envs\comfyui\python.exe"
$env:PYTHONPATH = "C:\D\DLnotebook\tools"
Set-Location C:\D\DLnotebook
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$cdp = $Port + 1000

function Render-One($cloud, $out, $fov, $ps) {
  & node tools\refrender.mjs --cloud $cloud --identity --fov-y $fov --point-size $ps `
      --far-pct 1.0 --far-min 60 --bg "#f0d24b" --out $out --w 1280 --h 720 `
      --port $script:Port --cdp-port $script:cdp --max-points 400000 2>&1 |
    Select-String -Pattern "render|Error|error" | ForEach-Object { $_.Line }
}

foreach ($f in $Frames) {
  $img = Join-Path $Seq "$f.jpg"
  if (-not (Test-Path $img)) { Write-Host "MISS $img"; continue }
  Write-Host "=== frame $f ==="
  & $Py tools\mkply.py --img $img --model moge --out $Out --tag $f --scales $MogeScales 2>&1 |
    Select-String -Pattern "mkply|MB" | ForEach-Object { $_.Line }
  & $Py tools\mkply.py --img $img --model da3 --out $Out --tag $f --scales $Da3Scales --process-res 504 2>&1 |
    Select-String -Pattern "mkply|MB" | ForEach-Object { $_.Line }

  foreach ($s in $MogeScales.Split(",")) {
    $p = Join-Path $Out ("moge-$f-s$s.ply")
    if (Test-Path $p) { Render-One $p (Join-Path $Out "ren-moge-$f-s$s.png") 55 0.05 }
  }
  foreach ($s in $Da3Scales.Split(",")) {
    $p = Join-Path $Out ("da3-$f-s$s.ply")
    if (Test-Path $p) { Render-One $p (Join-Path $Out "ren-da3-$f-s$s.png") 55 0.05 }
  }
  $renders = @()
  foreach ($s in $MogeScales.Split(",")) { $renders += "--render"; $renders += (Join-Path $Out "ren-moge-$f-s$s.png") }
  foreach ($s in $Da3Scales.Split(",")) { $renders += "--render"; $renders += (Join-Path $Out "ren-da3-$f-s$s.png") }
  & $Py tools\img-score.py --truth $img @renders --out (Join-Path $Out "score-$f.json")
}
Write-Host "[cmp-sweep] done"
