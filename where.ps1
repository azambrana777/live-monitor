# Prints the links to open the board from another device, token included.
# ASCII only (see allow-lan.ps1 for why).
$root = $PSScriptRoot
$cfg = Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json
$port = $cfg.port
$token = $cfg.access.token
# The token lives in config.local.json (it overrides config.json).
$localFile = Join-Path $root 'config.local.json'
if (Test-Path $localFile) {
  $local = Get-Content $localFile -Raw | ConvertFrom-Json
  if ($local.access -and $local.access.token) { $token = $local.access.token }
}

function Show-Link($label, $host_) {
  $url = "http://${host_}:${port}/"
  if ($token) { $url += "?token=$token" }
  Write-Host ("  {0,-22} {1}" -f $label, $url)
}

Write-Host ''
if ($token) {
  Write-Host 'Abre esto en el telefono (el token queda recordado en ese dispositivo):'
} else {
  Write-Host 'Sin token el tablero solo escucha en 127.0.0.1: los enlaces de red de abajo no funcionaran.'
}
Write-Host ''
Show-Link 'en este equipo' 'localhost'

if ($token) {
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object {
    $_.IPAddress -notlike '127.*' -and
    $_.IPAddress -notlike '169.254.*' -and          # link-local: no llegan a ningun sitio
    $_.InterfaceAlias -notlike '*WSL*' -and
    $_.InterfaceAlias -notlike '*Loopback*'
  } |
  ForEach-Object {
    $label = if ($_.InterfaceAlias -like '*Tailscale*') { 'Tailscale' } else { 'red local' }
    Show-Link $label $_.IPAddress
  }
}

$ts = 'C:\Program Files\Tailscale\tailscale.exe'
if (Test-Path $ts) {
  $name = (& $ts status --json | ConvertFrom-Json).Self.DNSName
  if ($name -and $token) { Show-Link 'Tailscale (nombre)' $name.TrimEnd('.') }
} else {
  Write-Host ''
  Write-Host '  Tailscale no esta instalado: para entrar desde fuera de casa, instalalo'
  Write-Host '  en este equipo y en el telefono (https://tailscale.com/download).'
}

if (-not $token) {
  Write-Host ''
  Write-Host 'AVISO: no hay access.token. El tablero solo escucha en 127.0.0.1 (esta maquina).' -ForegroundColor Yellow
  Write-Host 'Para abrirlo a la red, pon access.token en config.local.json y reinicia.' -ForegroundColor Yellow
}
Write-Host ''
