# serve.ps1 -- zero-install static server for DLnotebook (Windows PowerShell only).
#
# Why this file exists (2026-11-01):
#   A friend cloned the repo and had NO Node.js and NO Python installed, so both
#   tools/dev-server.js and python -m http.server were unavailable. Windows always
#   ships PowerShell, so this script is the last-resort runtime: it serves the repo
#   over plain TCP and speaks just enough HTTP/1.1 for the browser.
#
# What it does NOT do: /api/log, /api/shot, live reload. Those only matter to the
# tooling, not to playing the game.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File tools\serve.ps1 [-Port 8080]
#
# IMPORTANT: keep this file ASCII-only (English comments). PowerShell 5.1 reads a
#   BOM-less .ps1 as ANSI, so any Chinese here is decoded wrong and can even break
#   parsing (a stray byte can look like a quote). Same rule as the .bat launcher.

param(
  [int]$Port = 8080,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

$root  = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

$MIME = @{
  ".html" = "text/html; charset=utf-8"
  ".htm"  = "text/html; charset=utf-8"
  ".js"   = "text/javascript; charset=utf-8"
  ".mjs"  = "text/javascript; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".svg"  = "image/svg+xml"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".jpeg" = "image/jpeg"
  ".webp" = "image/webp"
  ".ico"  = "image/x-icon"
  ".mp3"  = "audio/mpeg"
  ".wav"  = "audio/wav"
  ".ogg"  = "audio/ogg"
  ".mp4"  = "video/mp4"
  ".woff2"= "font/woff2"
  ".txt"  = "text/plain; charset=utf-8"
  ".md"   = "text/plain; charset=utf-8"
}

function Write-Response {
  param($Stream, [int]$Status, [string]$Reason, [string]$Type, [byte[]]$Body, [bool]$HeadOnly)
  $len = if ($null -eq $Body) { 0 } else { $Body.Length }
  $head = "HTTP/1.1 $Status $Reason`r`n" +
          "Content-Type: $Type`r`n" +
          "Content-Length: $len`r`n" +
          "Cache-Control: no-store`r`n" +
          "Connection: close`r`n`r`n"
  $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
  $Stream.Write($hb, 0, $hb.Length)
  if (-not $HeadOnly -and $len -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
  $Stream.Flush()
}

# Graceful shutdown. Calling Close() right after Write can emit RST before the send
# buffer drains -- the browser then reports ERR_CONNECTION_RESET and large files get
# truncated. Correct order: Shutdown(Send) -> consume until EOF -> Close.
function Close-Client {
  param($Client)
  try {
    $Client.NoDelay = $true
    $Client.Client.Shutdown([System.Net.Sockets.SocketShutdown]::Send)
  } catch { }
  try {
    $Client.Client.ReceiveTimeout = 50
    $buf = New-Object byte[] 1024
    $n = $Client.Client.Receive($buf)
    while ($n -gt 0) { $n = $Client.Client.Receive($buf) }
  } catch { }
  try { $Client.Close() } catch { }
}

# The level-picker in the client asks /api/levels for the list of levels. Without it
# the start screen says "levels/ not found" and the game cannot start.
# Keep this JSON shape identical to tools/dev-server.js.
function Get-LevelsJson {
  $lvRoot = Join-Path $root "levels"
  $out = @()
  if (-not (Test-Path -LiteralPath $lvRoot)) { return "[]" }
  foreach ($dir in (Get-ChildItem -LiteralPath $lvRoot -Directory -ErrorAction SilentlyContinue)) {
    $lvFile = Join-Path $dir.FullName "level.json"
    if (-not (Test-Path -LiteralPath $lvFile -PathType Leaf)) { continue }
    try {
      $raw = [System.IO.File]::ReadAllText($lvFile, [System.Text.Encoding]::UTF8)
      $j = $raw | ConvertFrom-Json
      $meta = $j.meta

      $title = $dir.Name
      $subtitle = ""
      $artist = ""
      $difficulty = 0
      $tags = @()
      $cover = $null
      if ($meta) {
        if ($meta.title)      { $title = [string]$meta.title }
        if ($meta.subtitle)   { $subtitle = [string]$meta.subtitle }
        if ($meta.artist)     { $artist = [string]$meta.artist }
        if ($meta.difficulty) { $difficulty = $meta.difficulty }
        if ($meta.tags)       { $tags = @($meta.tags) }
        if ($meta.cover) {
          if (Test-Path -LiteralPath (Join-Path $dir.FullName ([string]$meta.cover))) { $cover = [string]$meta.cover }
        }
      }
      $latency = 0
      if ($j.latency_ms) { $latency = $j.latency_ms }
      $duration = 0
      if ($j.timing -and $j.timing.duration) { $duration = $j.timing.duration }

      $out += [pscustomobject]@{
        dir        = $dir.Name
        title      = $title
        subtitle   = $subtitle
        artist     = $artist
        difficulty = $difficulty
        tags       = $tags
        cover      = $cover
        music      = $j.music
        latency_ms = $latency
        duration   = $duration
      }
    } catch {
      # a broken level.json must not take the whole server down
    }
  }
  return (ConvertTo-Json -InputObject @($out) -Depth 6 -Compress)
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
try {
  # ReuseAddress: otherwise a previously killed run leaves the port in TIME_WAIT and
  # the next double-click fails with "port already in use" for up to 2 minutes.
  $listener.Server.SetSocketOption([System.Net.Sockets.SocketOptionLevel]::Socket,
                                   [System.Net.Sockets.SocketOptionName]::ReuseAddress, $true)
  $listener.Start()
} catch {
  Write-Host ""
  Write-Host "  Cannot listen on port $Port (already in use?)."
  Write-Host "  Close the other window, or start with a different port:  -Port 8081"
  Write-Host ""
  exit 1
}

Write-Host ""
Write-Host "  DLnotebook  (PowerShell static server - no Node.js needed)"
Write-Host "  address: http://localhost:$Port"
Write-Host ""
Write-Host "  Keep this window open while playing. Press Ctrl+C to stop."
Write-Host ""

if (-not $NoBrowser) {
  try { Start-Process "http://localhost:$Port" | Out-Null }
  catch { Write-Host "  (could not open the browser, open the address manually)" }
}

while ($true) {
  $client = $null
  try {
    $client = $listener.AcceptTcpClient()
    $client.ReceiveTimeout = 5000
    $stream = $client.GetStream()

    # Read the request line, then drain headers (we only need the first line).
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
    $requestLine = $reader.ReadLine()
    if ([string]::IsNullOrWhiteSpace($requestLine)) { Close-Client $client; continue }
    while ($true) {
      $line = $reader.ReadLine()
      if ([string]::IsNullOrEmpty($line)) { break }
    }

    $parts  = $requestLine.Split(" ")
    $method = $parts[0]
    $rawPath = if ($parts.Length -ge 2) { $parts[1] } else { "/" }
    $rawPath = ($rawPath -split "\?")[0]
    $rawPath = [System.Uri]::UnescapeDataString($rawPath)

    $headOnly = ($method -eq "HEAD")
    if ($method -eq "POST" -and $rawPath.StartsWith("/api/")) {
      # /api/log and /api/shot are dev-tool channels; answer politely so the client
      # console stays clean, but do not actually record anything.
      Write-Response $stream 204 "No Content" "text/plain; charset=utf-8" $null $false
      Close-Client $client; continue
    }
    if ($method -ne "GET" -and -not $headOnly) {
      Write-Response $stream 405 "Method Not Allowed" "text/plain; charset=utf-8" ([System.Text.Encoding]::UTF8.GetBytes("405")) $false
      Close-Client $client; continue
    }

    if ($rawPath -eq "/api/levels") {
      $json = Get-LevelsJson
      Write-Response $stream 200 "OK" "application/json; charset=utf-8" ([System.Text.Encoding]::UTF8.GetBytes($json)) $headOnly
      Close-Client $client; continue
    }

    # "/" maps to src/index.html; everything else is a path under the repo root.
    $rel = if ($rawPath -eq "/") { "src/index.html" } else { $rawPath.TrimStart("/") }
    $rel = $rel -replace "/", "\"
    $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))

    if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
      Write-Response $stream 403 "Forbidden" "text/plain; charset=utf-8" ([System.Text.Encoding]::UTF8.GetBytes("403")) $false
      Close-Client $client; continue
    }

    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
      Write-Response $stream 404 "Not Found" "text/plain; charset=utf-8" ([System.Text.Encoding]::UTF8.GetBytes("404 " + $rawPath)) $false
      Close-Client $client; continue
    }

    $ext  = [System.IO.Path]::GetExtension($full).ToLower()
    $type = if ($MIME.ContainsKey($ext)) { $MIME[$ext] } else { "application/octet-stream" }
    $bytes = [System.IO.File]::ReadAllBytes($full)
    Write-Response $stream 200 "OK" $type $bytes $headOnly
    Close-Client $client
  } catch {
    try { if ($client) { Close-Client $client } } catch { }
  }
}
