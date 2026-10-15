# Opens the board's port on the Windows firewall so a phone on the same network
# (or over Tailscale) can reach it. Run ONCE, as Administrator:
#   powershell -ExecutionPolicy Bypass -File allow-lan.ps1
#
# The firewall is only half of it: without access.token the board listens on
# 127.0.0.1 only. Set access.token in config.local.json and restart the board
# before a phone can reach it.
#
# ASCII only: Windows PowerShell reads a BOM-less .ps1 as Windows-1252 and a
# UTF-8 dash there ends a string early.
param(
  [int]$Port = 7420,
  # The board hands its per-task hfs/hts servers a port from this range, so one
  # rule covers every worktree instead of a Windows prompt per new binary.
  [string]$ServicePorts = '18080-18200',
  [string]$RuleName = 'hfs-monitor board',
  [string]$ServiceRuleName = 'hfs-monitor servers',
  [switch]$Remove
)

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host 'Hace falta ejecutar esto como Administrador.' -ForegroundColor Yellow
  Write-Host 'Abre PowerShell con boton derecho > "Ejecutar como administrador" y repite.'
  exit 1
}

if ($Remove) {
  foreach ($name in @($RuleName, $ServiceRuleName)) {
    Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  }
  Write-Host "Reglas eliminadas. Los puertos $Port y $ServicePorts vuelven a estar cerrados desde fuera."
  exit 0
}

if (Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue) {
  Write-Host "La regla '$RuleName' ya existe."
} else {
  # Private profile only: never opened on a public/coffee-shop network.
  New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
  Write-Host "Regla creada: entrada TCP $Port permitida en redes PRIVADAS."
}

if (Get-NetFirewallRule -DisplayName $ServiceRuleName -ErrorAction SilentlyContinue) {
  Write-Host "La regla '$ServiceRuleName' ya existe."
} else {
  New-NetFirewallRule -DisplayName $ServiceRuleName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $ServicePorts -Profile Private | Out-Null
  Write-Host "Regla creada: entrada TCP $ServicePorts (servidores hfs/hts) en redes PRIVADAS."
}

Write-Host ''
Write-Host 'Recuerda: sin access.token el tablero solo escucha en 127.0.0.1. Pon access.token en' -ForegroundColor Yellow
Write-Host 'config.local.json y reinicia el tablero para que sea accesible desde la red.' -ForegroundColor Yellow
Write-Host ''
Write-Host 'Comprueba que tu red esta marcada como Privada:'
Get-NetConnectionProfile | Select-Object Name, NetworkCategory | Format-Table -AutoSize
