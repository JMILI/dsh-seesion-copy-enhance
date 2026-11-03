<#
    dsh-seesion-copy-enhance - host route self-check.

    The clipboard gesture itself (click the copy button, paste into the composer) can only be
    exercised in the DSH Web UI; everything below is the Host half, which is what the Client half
    talks to. Run it after installing / after a DSH upgrade.

    Usage:
        powershell -ExecutionPolicy Bypass -File .\verify.ps1
        powershell -ExecutionPolicy Bypass -File .\verify.ps1 -Port 52694
        powershell -ExecutionPolicy Bypass -File .\verify.ps1 -Capture          # also capture a real message
#>
[CmdletBinding()]
param(
    [int]$Port,
    [switch]$Capture
)

$ErrorActionPreference = 'Stop'
$Base = '/dsh-seesion-copy-enhance'

function Resolve-Port {
    param([int]$Given)
    if ($Given) { return $Given }
    $pids = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    $candidates = @()
    if ($pids.Count) {
        try {
            $candidates = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
                Where-Object { $pids -contains $_.OwningProcess } |
                Select-Object -ExpandProperty LocalPort -Unique)
        } catch { }
    }
    foreach ($candidate in $candidates) {
        try {
            $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$candidate$Base/health" -UseBasicParsing -TimeoutSec 3
            if ($probe.StatusCode -eq 200) { return $candidate }
        } catch { }
    }
    throw 'Could not find the DSH web port. Pass -Port <port> (see the URL in the DSH window).'
}

$p = Resolve-Port -Given $Port
$root = "http://127.0.0.1:$p$Base"
Write-Host "DSH web port : $p"
Write-Host ''

# 1. health
$health = Invoke-RestMethod -Uri "$root/health" -TimeoutSec 15
Write-Host ('[1/4] health        : ok={0} sessions={1} bundles={2}' -f $health.ok, $health.sessions, $health.bundles)

# 2. inspect (shape only)
$inspect = Invoke-RestMethod -Uri "$root/inspect" -TimeoutSec 30
$media = 0
foreach ($session in $inspect.sessions) {
    foreach ($message in $session.messages) {
        $media += @($message.blocks | Where-Object { $_ -eq 'image' -or $_ -eq 'file' }).Count
    }
}
Write-Host ('[2/4] inspect       : {0} sessions, {1} media blocks' -f @($inspect.sessions).Count, $media)

# 3. capture + resolve round trip on the richest message
$target = $null
foreach ($session in $inspect.sessions) {
    foreach ($message in $session.messages) {
        $n = @($message.blocks | Where-Object { $_ -eq 'image' -or $_ -eq 'file' }).Count
        if ($n -gt 0 -and ($null -eq $target -or $n -gt $target.Count)) {
            $target = [pscustomobject]@{ SessionId = $session.id; Seq = $message.seq; Count = $n }
        }
    }
}
if ($null -eq $target) {
    Write-Host '[3/4] capture       : skipped (no message with media in the live sessions)'
    Write-Host '[4/4] resolve       : skipped'
    return
}
if (-not $Capture) {
    Write-Host ('[3/4] capture       : skipped (richest message has {0} media blocks; add -Capture to fetch it)' -f $target.Count)
    Write-Host '[4/4] resolve       : skipped'
    return
}
$body = @{ sessionId = $target.SessionId; seq = $target.Seq } | ConvertTo-Json -Compress
$captureResult = Invoke-RestMethod -Uri "$root/capture" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 180
$bytesOk = $true
$total = 0
foreach ($attachment in $captureResult.attachments) {
    $raw = [Convert]::FromBase64String($attachment.data)
    $total += $raw.Length
    if ($raw.Length -ne $attachment.bytes) { $bytesOk = $false }
}
Write-Host ('[3/4] capture       : ok={0} attachments={1} bytes={2} byte-exact={3} warnings={4}' -f `
    $captureResult.ok, @($captureResult.attachments).Count, $total, $bytesOk, @($captureResult.warnings).Count)

$resolveBody = @{ token = $captureResult.token } | ConvertTo-Json -Compress
$resolved = Invoke-RestMethod -Uri "$root/resolve" -Method Post -ContentType 'application/json' -Body $resolveBody -TimeoutSec 180
$same = ($resolved.text -eq $captureResult.text) -and (@($resolved.attachments).Count -eq @($captureResult.attachments).Count)
Write-Host ('[4/4] resolve       : round-trip identical={0} textChars={1}' -f $same, $captureResult.text.Length)