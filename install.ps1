$ErrorActionPreference = "Stop"
$dest = Join-Path $env:LOCALAPPDATA "BrainConnector"
$shop = "https://raw.githubusercontent.com/rockmed888-ship-it/brain-connector-site/main"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Brain Connector needs Node.js."
  Write-Host "Install it from https://nodejs.org, close this window, then run the install again."
  exit 1
}
foreach ($name in @("brain.mjs", "local-mcp.mjs", "memory-mcp.mjs", "url-mcp.mjs")) {
  Invoke-WebRequest -Uri "$shop/$name" -OutFile (Join-Path $dest $name) -UseBasicParsing
}
Set-Content -Path (Join-Path $dest "shop.txt") -Value $shop -Encoding ASCII
Set-Content -Path (Join-Path $dest "brain.cmd") -Value "@echo off`r`nnode `"$dest\brain.mjs`" %*`r`n" -Encoding ASCII
foreach ($js in @("brain.mjs", "local-mcp.mjs", "memory-mcp.mjs", "url-mcp.mjs")) {
  $path = Join-Path $dest $js
  & node --check $path
  if ($LASTEXITCODE -ne 0) {
    Write-Host "$js did not pass a syntax check."
    exit 1
  }
}
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $userPath) { $userPath = "" }
if ($userPath -notlike "*${dest}*") {
  [Environment]::SetEnvironmentVariable("Path", ($userPath.TrimEnd(";") + ";" + $dest), "User")
}
Write-Host "Brain Connector is installed."
Write-Host ""
Write-Host "Which AI should this brain plug into?"
Write-Host "Say grok, gpt, claude, or all."
$who = "all"
try {
  $typed = Read-Host "brain"
  if ($typed) { $who = $typed.Trim() }
} catch {
  Write-Host "No answer. Plugging grok, gpt, and claude."
}
& node (Join-Path $dest "brain.mjs") plug $who
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Open a new chat in that AI. The brain is already connected."
