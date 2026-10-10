param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("UserPromptSubmit", "Stop", "Interrupt", "SessionEnd")]
  [string]$Event,
  [Parameter(Mandatory = $true)]
  [string]$StatePath,
  [Parameter(Mandatory = $true)]
  [string]$PendingPath,
  [Parameter(Mandatory = $true)]
  [string]$EnabledPath,
  [Parameter(Mandatory = $true)]
  [string]$Owner
)

$ErrorActionPreference = "Stop"

function Get-CodexExecutable {
  $configured = $env:CODEX_CLI_PATH
  if ($configured -and (Test-Path -LiteralPath $configured -PathType Leaf)) {
    return $configured
  }

  $installed = Join-Path $env:LOCALAPPDATA "Programs\OpenAI\Codex\bin\codex.exe"
  if (Test-Path -LiteralPath $installed -PathType Leaf) {
    return $installed
  }

  $fromPath = Get-Command codex.exe -ErrorAction SilentlyContinue
  if (-not $fromPath) { $fromPath = Get-Command codex -ErrorAction SilentlyContinue }
  if ($fromPath) {
    return $fromPath.Source
  }

  return $null
}

function Read-RpcResult {
  param(
    [System.IO.StreamWriter]$Writer,
    [System.IO.StreamReader]$Reader,
    [int]$Id,
    [string]$Method,
    [hashtable]$Params
  )

  $request = @{ id = $Id; method = $Method; params = $Params } | ConvertTo-Json -Compress -Depth 16
  $Writer.WriteLine($request)
  $Writer.Flush()
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ([DateTime]::UtcNow -lt $deadline) {
    $read = $Reader.ReadLineAsync()
    if (-not $read.Wait(10000) -or $null -eq $read.Result) {
      throw "Codex App Server timed out"
    }
    if ([string]::IsNullOrWhiteSpace($read.Result)) { continue }
    $message = $read.Result | ConvertFrom-Json
    if ([string]$message.id -ne [string]$Id) { continue }
    if ($message.error) { throw [string]$message.error.message }
    return $message.result
  }

  throw "Codex App Server timed out"
}

function Get-TurnStatus {
  param([string]$SessionId, [string]$TurnId)

  $codex = Get-CodexExecutable
  if (-not $codex) { return $null }

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo.FileName = $codex
  $process.StartInfo.Arguments = "app-server --listen stdio://"
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.CreateNoWindow = $true
  $process.StartInfo.RedirectStandardInput = $true
  $process.StartInfo.RedirectStandardOutput = $true

  $started = $false
  try {
    if (-not $process.Start()) { return $null }
    $started = $true
    $writer = $process.StandardInput
    $reader = $process.StandardOutput
    $null = Read-RpcResult -Writer $writer -Reader $reader -Id 1 -Method "initialize" -Params @{
      clientInfo = @{ name = "capsulemeterx-shutdown-hook"; title = "CapsuleMeterX"; version = "0.2.2" }
    }
    $writer.WriteLine('{"method":"initialized"}')
    $writer.Flush()

    $requestId = 2
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
      $result = Read-RpcResult -Writer $writer -Reader $reader -Id $requestId -Method "thread/turns/list" -Params @{
        threadId = $SessionId
        limit = 100
      }
      $requestId++
      $turn = @($result.data) | Where-Object { [string]$_.id -eq $TurnId } | Select-Object -First 1
      if ($turn -and [string]$turn.status -in @("completed", "failed", "interrupted")) {
        return [string]$turn.status
      }
      Start-Sleep -Milliseconds 250
    }
    return $null
  } catch {
    return $null
  } finally {
    if ($started -and -not $process.HasExited) {
      $process.Kill()
      $process.WaitForExit()
    }
    $process.Dispose()
  }
}

function Invoke-ShutdownCommand {
  param([string]$Arguments)

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo.FileName = Join-Path $env:SystemRoot "System32\shutdown.exe"
  $process.StartInfo.Arguments = $Arguments
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.CreateNoWindow = $true
  if (-not $process.Start()) { return $false }
  $process.WaitForExit(5000) | Out-Null
  $success = $process.HasExited -and $process.ExitCode -eq 0
  $process.Dispose()
  return $success
}

function Cancel-PendingShutdown {
  if (-not (Test-Path -LiteralPath $PendingPath -PathType Leaf)) { return }
  $null = Invoke-ShutdownCommand -Arguments "/a"
  Remove-Item -LiteralPath $PendingPath -Force -ErrorAction SilentlyContinue
}

try {
  if ($Owner -ne "CapsuleMeterXCodexTaskMonitor" -or
      -not (Test-Path -LiteralPath $EnabledPath -PathType Leaf)) { exit 0 }

  $inputText = [Console]::In.ReadToEnd()
  if (-not $inputText) { exit 0 }
  $payload = $inputText | ConvertFrom-Json
  $sessionId = [string]$payload.session_id
  if (-not $sessionId) { exit 0 }

  $turnId = [string]$payload.turn_id
  $turnStatus = $null
  if ($Event -eq "Stop") {
    if (-not $turnId) { exit 0 }
    $turnStatus = Get-TurnStatus -SessionId $sessionId -TurnId $turnId
  }

  $mutex = [System.Threading.Mutex]::new($false, "Local\CapsuleMeterXCodexTaskMonitor")
  $locked = $false
  try {
    try {
      $locked = $mutex.WaitOne(5000)
    } catch [System.Threading.AbandonedMutexException] {
      $locked = $true
    }
    if (-not $locked) { exit 0 }

    $state = if (Test-Path -LiteralPath $StatePath -PathType Leaf) {
      Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
    } else {
      [pscustomobject]@{ activeTurns = @(); completionEligible = $true }
    }

    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $active = @{}
    foreach ($item in @($state.activeTurns)) {
      if ($item.key -and ($now - [int64]$item.startedAt) -lt 86400) {
        $active[[string]$item.key] = [int64]$item.startedAt
      }
    }

    $key = if ($turnId) { "$sessionId|$turnId" } else { $null }
    $shouldSchedule = $false
    $completionEligible = if ($null -eq $state.completionEligible) { $true } else { [bool]$state.completionEligible }

    switch ($Event) {
      "UserPromptSubmit" {
        if ($active.Count -eq 0) { $completionEligible = $true }
        if ($key) { $active[$key] = $now }
        Cancel-PendingShutdown
      }
      "Stop" {
        $wasTracked = $key -and $active.ContainsKey($key)
        if ($key) { $null = $active.Remove($key) }
        if ($turnStatus -ne "completed") { $completionEligible = $false }
        $shouldSchedule = $wasTracked -and $turnStatus -eq "completed" -and $active.Count -eq 0 -and $completionEligible
      }
      "Interrupt" {
        if ($key -and $active.ContainsKey($key)) { $completionEligible = $false }
        if ($key) { $null = $active.Remove($key) }
        Cancel-PendingShutdown
      }
      "SessionEnd" {
        $removedSessionTurn = $false
        foreach ($activeKey in @($active.Keys)) {
          if ($activeKey.StartsWith("$sessionId|", [StringComparison]::Ordinal)) {
            $null = $active.Remove($activeKey)
            $removedSessionTurn = $true
          }
        }
        if ($removedSessionTurn) { $completionEligible = $false }
      }
    }

    if ($active.Count -eq 0) { $completionEligible = $true }

    $records = @($active.GetEnumerator() | ForEach-Object {
      [pscustomobject]@{ key = $_.Key; startedAt = $_.Value }
    })
    $nextState = [pscustomobject]@{
      activeTurns = $records
      completionEligible = $completionEligible
    }
    $stateDirectory = Split-Path -Parent $StatePath
    if (-not (Test-Path -LiteralPath $stateDirectory)) {
      New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    }
    $nextState | ConvertTo-Json -Compress -Depth 6 | Set-Content -LiteralPath $StatePath -Encoding utf8

    if ($shouldSchedule) {
      if (-not (Test-Path -LiteralPath $EnabledPath -PathType Leaf)) { exit 0 }
      $pendingDirectory = Split-Path -Parent $PendingPath
      if (-not (Test-Path -LiteralPath $pendingDirectory)) {
        New-Item -ItemType Directory -Path $pendingDirectory -Force | Out-Null
      }
      [pscustomobject]@{ scheduledAt = $now } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath $PendingPath -Encoding utf8
      if (-not (Test-Path -LiteralPath $EnabledPath -PathType Leaf)) {
        Remove-Item -LiteralPath $PendingPath -Force -ErrorAction SilentlyContinue
        exit 0
      }
      if (-not (Invoke-ShutdownCommand -Arguments '/s /t 60 /c "CapsuleMeterX: Codex task completed"')) {
        Remove-Item -LiteralPath $PendingPath -Force -ErrorAction SilentlyContinue
      } elseif (-not (Test-Path -LiteralPath $EnabledPath -PathType Leaf)) {
        $null = Invoke-ShutdownCommand -Arguments "/a"
        Remove-Item -LiteralPath $PendingPath -Force -ErrorAction SilentlyContinue
      }
    }
  } finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
} catch {
  exit 0
}
