# ShopSim — запуск на Windows (PowerShell, без Python).
# Поднимает минимальный HTTP-сервер на .NET и открывает игру в браузере.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8123
$url  = "http://127.0.0.1:$port/index.html"

Write-Host ""
Write-Host "  ShopSim — локальный сервер" -ForegroundColor Cyan
Write-Host "  Адрес: $url"
Write-Host "  Остановить: Ctrl+C или закройте это окно."
Write-Host ""

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$port/")
$listener.Start()
Start-Process $url

$types = @{
  '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.css'='text/css; charset=utf-8'
  '.json'='application/json'; '.webmanifest'='application/manifest+json'; '.png'='image/png'; '.jpg'='image/jpeg'
  '.svg'='image/svg+xml'; '.ico'='image/x-icon'; '.wasm'='application/wasm'; '.mp3'='audio/mpeg'; '.ogg'='audio/ogg'
}

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $path = $ctx.Request.Url.LocalPath
    if ($path -eq '/' -or [string]::IsNullOrEmpty($path)) { $path = '/index.html' }
    $file = Join-Path $root ($path.TrimStart('/') -replace '/', '\')
    if (Test-Path $file -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($file)
      $ext = [System.IO.Path]::GetExtension($file).ToLower()
      $ctx.Response.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
      $ctx.Response.Headers.Add('Cache-Control', 'no-cache')
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
      $msg = [Text.Encoding]::UTF8.GetBytes("404: $path")
      $ctx.Response.OutputStream.Write($msg, 0, $msg.Length)
    }
    $ctx.Response.OutputStream.Close()
  } catch [System.Net.HttpListenerException] {
    break
  } catch {
    Write-Host "  Ошибка: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}
$listener.Close()
