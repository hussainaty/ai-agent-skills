# run.ps1 - manage a per-run log folder so every stream of one QA/verify run lands
# together: one run = one folder = the complete black box (best for AI search).
#
#   run.ps1 start <pod> [-Purpose "verify #54"]   mint folder, print its path, set active
#   run.ps1 path  <pod>                            print the active run folder
#   run.ps1 end   <pod>                            stamp the end time + finalize the name
#
# Layout:  <AB_TRACE_ROOT>\<pod>\<start>-<end>\   (default root D:\dev\sandbox)
#   env.json        run header (git SHA, pod, cwd, purpose, host, timestamps)
#   console.txt     browser console        (redirect watchconsole/watchall here)
#   network.txt     requests/responses
#   performance.txt perf metrics, long tasks, layout shifts
#   api.txt         /api/* calls
#   convex.txt      Convex mutations/queries
#   server.txt      WeatherCRM next-dev stdout
#   transcript.jsonl agent-browser actions (ab.ps1 writes this automatically)
#
# Docker container logs stay continuous at the pod root (docker-*.log) since they
# span every run in a pod's lifetime - they are NOT per-run.
#
# Folder name = <start>-<end> (matches the watcher's braveconsole-<start>-<end> style).
# Keep ASCII-only (PowerShell 5.1 reads BOM-less files as ANSI).

param(
    [Parameter(Position = 0)][ValidateSet("start", "end", "path")] [string]$Cmd = "path",
    [Parameter(Position = 1)][string]$Pod,
    [string]$Purpose = ""
)

$ErrorActionPreference = "Stop"
if (-not $Pod) { throw "Usage: run.ps1 <start|end|path> <pod> [-Purpose <text>]" }

$root = if ($env:AB_TRACE_ROOT) { $env:AB_TRACE_ROOT } else { "D:\dev\sandbox" }
$podDir = Join-Path $root $Pod
$ptr = Join-Path $podDir ".current-run"

function Stamp { Get-Date -Format "yyyyMMdd_HHmmss" }

switch ($Cmd) {

    "start" {
        New-Item -ItemType Directory -Force -Path $podDir | Out-Null
        $start = Stamp
        $runDir = Join-Path $podDir "$start-RUNNING"
        New-Item -ItemType Directory -Force -Path $runDir | Out-Null

        $sha = ""
        try { $sha = "$(& git rev-parse --short HEAD 2>$null)".Trim() } catch {}
        $hdr = [ordered]@{
            type    = "env"
            pod     = $Pod
            purpose = $Purpose
            started = (Get-Date).ToString("o")
            cwd     = (Get-Location).Path
            gitSha  = $sha
            host    = $env:COMPUTERNAME
        }
        ($hdr | ConvertTo-Json) | Out-File (Join-Path $runDir "env.json") -Encoding utf8
        # Pre-create the stream files so a reader sees the full expected set.
        foreach ($f in "console.txt","network.txt","performance.txt","api.txt","convex.txt","server.txt","transcript.jsonl") {
            New-Item -ItemType File -Force -Path (Join-Path $runDir $f) | Out-Null
        }
        Set-Content -Path $ptr -Value $runDir -Encoding ascii
        Write-Output $runDir
    }

    "path" {
        if (Test-Path $ptr) { Write-Output ((Get-Content $ptr -Raw).Trim()) }
        else { throw "No active run for '$Pod'. Start one: run.ps1 start $Pod" }
    }

    "end" {
        if (-not (Test-Path $ptr)) { throw "No active run for '$Pod'." }
        $runDir = (Get-Content $ptr -Raw).Trim()
        if (-not (Test-Path $runDir)) { throw "Active run folder missing: $runDir" }
        $end = Stamp
        $final = $runDir -replace "-RUNNING$", "-$end"
        # Stamp end time into env.json.
        $envFile = Join-Path $runDir "env.json"
        if (Test-Path $envFile) {
            $e = Get-Content $envFile -Raw | ConvertFrom-Json
            $e | Add-Member -NotePropertyName ended -NotePropertyValue (Get-Date).ToString("o") -Force
            ($e | ConvertTo-Json) | Out-File $envFile -Encoding utf8
        }
        Rename-Item -Path $runDir -NewName (Split-Path $final -Leaf)
        Remove-Item $ptr -ErrorAction SilentlyContinue
        Write-Output $final
    }
}
