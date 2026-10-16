# Parallel chunked downloader for HuggingFace repos via hf-mirror.
# A single connection through the local proxy tops out near 2.7 MB/s; N range requests in
# parallel reach ~20+ MB/s. ASCII-only on purpose: PowerShell 5.1 mis-parses UTF-8 without BOM.
# Resumes a partial <file> by appending the remaining byte range.
# Usage: & .\tools\fetch-hf.ps1 -Repo depth-anything/DA3NESTED-GIANT-LARGE [-Chunks 10] [-Only model.safetensors]
# NOTE: PowerShell variables are case-insensitive - never name a local $parts next to param $Parts.
param(
  [Parameter(Mandatory=$true)][string]$Repo,
  [string]$OutDir,
  [int]$Chunks = 10,
  [string]$Only = "",
  [switch]$Force
)
$ProgressPreference = 'SilentlyContinue'
$endpoint = "https://hf-mirror.com"
if (-not $OutDir) { $OutDir = Join-Path "C:\DLnotebook-media\models" ($Repo -replace '/', '__') }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$meta = & curl.exe -s -L -m 60 "$endpoint/api/models/$Repo" | ConvertFrom-Json
if (-not $meta.siblings) { throw "cannot list repo: $Repo" }

foreach ($s in $meta.siblings) {
  $f = $s.rfilename
  if ($f -match '^\.') { continue }
  if ($Only -and $f -ne $Only) { continue }
  $out = Join-Path $OutDir ($f -replace '/', '\')
  New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
  $url = "$endpoint/$Repo/resolve/main/$f"
  $size = [int64]((& curl.exe -sIL -m 60 $url | Select-String -Pattern '^content-length:\s*(\d+)' | Select-Object -Last 1).Matches.Groups[1].Value)
  if ($size -le 0) { Write-Output "[err ] no size: $f"; continue }
  $have = if (Test-Path $out) { (Get-Item $out).Length } else { [int64]0 }
  if ($have -ge $size -and -not $Force) { Write-Output ("[skip] {0,8:n1}MB  {1}" -f ($have / 1MB), $f); continue }
  Get-ChildItem "$out.part*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  $t0 = Get-Date
  if ($size -le 6MB -or $Chunks -le 1) {
    if ($have -gt 0) { & curl.exe -s -L --retry 5 --retry-all-errors -m 7200 -C - -o $out $url }
    else { & curl.exe -s -L --retry 5 --retry-all-errors -m 7200 -o $out $url }
  }
  else {
    # download [from, size-1] in $Chunks pieces; $have bytes are already on disk (append mode)
    $from = $have
    $remain = $size - $from
    $per = [int64][math]::Ceiling($remain / $Chunks)
    $chunkFiles = @(); $dlProcs = @()
    for ($i = 0; $i -lt $Chunks; $i++) {
      $a = $from + $i * $per
      if ($a -ge $size) { break }
      $b = [int64][math]::Min($a + $per - 1, $size - 1)
      $p = "$out.part$i"; $chunkFiles += $p
      $dlProcs += Start-Process -FilePath "curl.exe" -ArgumentList @("-s", "-L", "--retry", "5", "--retry-all-errors", "-m", "7200", "-r", "$a-$b", "-o", $p, $url) -NoNewWindow -PassThru
    }
    foreach ($pr in $dlProcs) { $pr.WaitForExit() }
    $total = 0; foreach ($p in $chunkFiles) { if (Test-Path $p) { $total += (Get-Item $p).Length } }
    if ($total -ne $remain) { Write-Output "[err ] partial failure ($total/$remain bytes), .part kept: $f"; continue }
    $mode = if ($have -gt 0) { "Append" } else { "Create" }
    $fs = [System.IO.File]::Open($out, [System.IO.FileMode]::$mode)
    foreach ($p in $chunkFiles) { $in = [System.IO.File]::OpenRead($p); $in.CopyTo($fs); $in.Dispose() }
    $fs.Dispose()
    Remove-Item $chunkFiles -ErrorAction SilentlyContinue
  }
  $dt = ((Get-Date) - $t0).TotalSeconds
  $now = if (Test-Path $out) { (Get-Item $out).Length } else { 0 }
  $tag = if ($now -ge $size) { "ok  " } else { "PART" }
  Write-Output ("[{0}] {1,8:n1}MB / {2,8:n1}MB  {3,6:n1}s  {4,5:n1}MB/s  {5}" -f $tag, ($now / 1MB), ($size / 1MB), $dt, (($now - $have) / 1MB / [math]::Max($dt, 0.1)), $f)
}
Write-Output "DONE $Repo"
