#!/usr/bin/env pwsh
# VOID//ai-launcher — Windows PowerShell installer
# Usage: ./scripts/install.ps1
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir
$NodeMin   = 18

function Ok   ($msg) { Write-Host "  [OK] $msg"   -ForegroundColor Green }
function Warn ($msg) { Write-Host "  [!!] $msg"   -ForegroundColor Yellow }
function Die  ($msg) { Write-Host "  [XX] $msg"   -ForegroundColor Red; exit 1 }

function Test-NodeVersionOk {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) { return $false }
    $verStr = (& node -v) -replace '^v', ''
    $major = [int]($verStr.Split('.')[0])
    return $major -ge $NodeMin
}

Write-Host "`n-- Node.js 확인 --" -ForegroundColor Green
if (Test-NodeVersionOk) {
    Ok "Node.js $(node -v) 확인됨"
} else {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Warn "Node.js $NodeMin+ 미검출 — winget으로 설치합니다: winget install OpenJS.NodeJS.LTS"
        winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    } else {
        Die "Node.js가 없고 winget도 없습니다. https://nodejs.org 에서 LTS를 설치한 뒤 새 터미널에서 다시 실행하세요."
    }

    if (-not (Test-NodeVersionOk)) {
        Die "Node.js 설치 후에도 확인 실패. 새 PowerShell 창을 열어 PATH를 갱신한 뒤 다시 시도하세요."
    }
    Ok "Node.js $(node -v) 설치 확인됨"
}

Write-Host "`n-- VOID//ai-launcher 설치 --" -ForegroundColor Green
& node "$RootDir\cmd_generator.js" @args
exit $LASTEXITCODE
