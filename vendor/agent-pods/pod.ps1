# pod.ps1 - spawn/manage containerized agent browsers (agent pods)
#
#   .\pod.ps1 up <name> [-Cookies <profile>] [-Worktree <path>]
#   .\pod.ps1 down <name> | .\pod.ps1 down -All
#   .\pod.ps1 ls
#   .\pod.ps1 url <name>
#
# Each pod = one Chromium container: CDP on a unique localhost port (agent-browser,
# Playwright MCP, watchconsole all attach to it), noVNC web viewer so you can watch.
#
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads BOM-less files as ANSI and
# multi-byte characters can corrupt string parsing.

param(
    [Parameter(Position = 0)]
    [ValidateSet("up", "down", "ls", "url", "logs", "click", "move", "build", "help")]
    [string]$Cmd = "help",

    [Parameter(Position = 1)]
    [string]$Name,

    [Parameter(Position = 2)]
    [string]$Arg2,

    [Parameter(Position = 3)]
    [string]$Arg3,

    [string]$Cookies,
    [string]$Worktree,
    [string]$Selector,
    [string]$Cpus,
    [string]$Memory,
    [string]$Shm,
    [string]$ImageOverride,
    [switch]$All,
    [switch]$Follow,
    [int]$Tail = 100
)

$ErrorActionPreference = "Stop"
# Default image is the browser-only pod. claude-pod.ps1 passes -ImageOverride
# agent-pod-claude:latest to reuse all the up/cookie/log/profile logic here with
# the in-container-Claude image instead.
$Image = if ($ImageOverride) { $ImageOverride } else { "agent-pod:latest" }
$Label = "agent-pod"
$CdpBase = 9222   # pod N gets 9222+N (pod 1 -> 9223); 9222 stays your real Brave
$WebBase = 7900   # pod N gets 7900+N
$RepoRoot = $PSScriptRoot

# Compute caps (overridable per-call, or set machine-wide via env vars).
function FirstSet($a, $b) { if ($a) { $a } else { $b } }
$Cpus   = FirstSet $Cpus   (FirstSet $env:POD_CPUS   "8")
$Memory = FirstSet $Memory (FirstSet $env:POD_MEMORY "8g")
$Shm    = FirstSet $Shm    (FirstSet $env:POD_SHM    "2g")

# Browser baked into the image: chromium (default) or brave. Set POD_BROWSER=brave
# (User env var) to make every build/spawn use Brave on this machine.
$Browser = FirstSet $env:POD_BROWSER "chromium"

# Durable browser profiles. One folder per pod under here; mounted into the
# container at /data/profile so cookies, localStorage, and login state survive
# container removal/recreation. Override with POD_PROFILE_ROOT.
$ProfileRoot = FirstSet $env:POD_PROFILE_ROOT "D:\dev\sandbox\agent-pods\profiles"

# Durable container-log archive. One folder per pod under here; live-captured for
# the whole run so logs survive both json-file rotation AND teardown. Override with
# POD_LOG_ROOT. Folder name = pod name (e.g. weathercrm-wt1).
$LogRoot = FirstSet $env:POD_LOG_ROOT "D:\dev\sandbox"

function Start-PodLogCapture([string]$PodName) {
    $dir = Join-Path $LogRoot $PodName
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $file = Join-Path $dir "docker-$stamp.log"
    # Detached follower: merges stdout+stderr, appends for the life of the container.
    # docker logs -f exits on its own when the container is removed.
    Start-Process -FilePath "cmd.exe" -WindowStyle Hidden `
        -ArgumentList "/c docker logs -f --timestamps agent-pod-$PodName >> ""$file"" 2>&1" | Out-Null
    return $file
}

function Save-PodLogSnapshot([string]$PodName) {
    # Belt-and-suspenders at teardown: dump the full json-file ring before rm,
    # in case the live follower lagged or was never started (pre-existing pod).
    $dir = Join-Path $LogRoot $PodName
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $file = Join-Path $dir "docker-final-$stamp.log"
    Start-Process -FilePath "cmd.exe" -WindowStyle Hidden -Wait `
        -ArgumentList "/c docker logs --timestamps agent-pod-$PodName >> ""$file"" 2>&1" | Out-Null
}

function Get-Pods {
    # No quoted keys in the go-template: PowerShell 5.1 mangles embedded quotes
    # when passing args to native exes. Index is derived from the published CDP port.
    $out = docker ps -a --filter "label=$Label" --format "{{.Names}}|{{.Ports}}|{{.Status}}"
    $pods = @()
    foreach ($line in $out) {
        if (-not $line) { continue }
        $parts = $line -split "\|"
        if ($parts[1] -notmatch "127\.0\.0\.1:(\d+)->9222/tcp") { continue }
        $cdp = [int]$Matches[1]
        $index = $cdp - $CdpBase
        $pods += [pscustomobject]@{
            Name   = $parts[0] -replace "^agent-pod-", ""
            Index  = $index
            Cdp    = $cdp
            Watch  = "http://localhost:$($WebBase + $index)/vnc.html?autoconnect=true" + "&resize=scale"
            Status = $parts[2]
        }
    }
    return $pods
}

function Wait-Cdp([int]$Port) {
    for ($i = 0; $i -lt 60; $i++) {
        try {
            Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 2 | Out-Null
            return $true
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    return $false
}

switch ($Cmd) {

    "build" {
        Write-Host "Building $Image with browser=$Browser ..."
        docker build --build-arg "BROWSER=$Browser" -t $Image $RepoRoot
        break
    }

    "up" {
        if (-not $Name) { throw "Usage: pod.ps1 up [name] -Cookies [profile] -Worktree [path]" }
        $existing = Get-Pods | Where-Object { $_.Name -eq $Name }
        if ($existing) { throw "Pod '$Name' already exists (status: $($existing.Status)). Use 'pod.ps1 down $Name' first." }

        # Image present?
        $img = docker images -q $Image
        if (-not $img) {
            Write-Host "Image not built yet - building (browser=$Browser)..."
            docker build --build-arg "BROWSER=$Browser" -t $Image $RepoRoot
        }

        # First free index 1..50
        $used = @(Get-Pods | ForEach-Object { $_.Index })
        $index = 0
        foreach ($i in 1..50) {
            if ($used -notcontains $i) { $index = $i; break }
        }
        if ($index -eq 0) { throw "No free pod slot (1..50 all used)." }
        $cdp = $CdpBase + $index
        $web = $WebBase + $index
        $profileDir = Join-Path $ProfileRoot $Name
        New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

        docker run -d `
            --name "agent-pod-$Name" `
            --label "$Label=true" `
            --label "$Label.index=$index" `
            --cpus $Cpus `
            --memory $Memory `
            --shm-size $Shm `
            --restart unless-stopped `
            --log-opt max-size=50m `
            --log-opt max-file=5 `
            -v "${profileDir}:/data/profile" `
            -p "127.0.0.1:${cdp}:9222" `
            -p "127.0.0.1:${web}:7900" `
            $Image | Out-Null

        Write-Host "Waiting for CDP on $cdp..."
        if (-not (Wait-Cdp $cdp)) {
            docker logs "agent-pod-$Name" --tail 30
            throw "Pod started but CDP never came up on $cdp. Logs above."
        }

        # Start durable live log capture for the whole run.
        $logFile = Start-PodLogCapture $Name

        # Cookies: inject into the default browser context (covers Playwright MCP
        # etc). agent-browser uses its own isolated context, so the state file
        # path also goes into pod.json for `agent-browser state load`.
        $stateFile = $null
        if ($Cookies) {
            $stateFile = Join-Path $RepoRoot "cookie-profiles\$Cookies.json"
            if (-not (Test-Path $stateFile)) { throw "No cookie profile at $stateFile. Run cookies.mjs export first." }
            node "$RepoRoot\cookies.mjs" load --profile $Cookies --port $cdp
        }

        $watch = "http://localhost:$web/vnc.html?autoconnect=true" + "&resize=scale"

        # Bind to worktree
        if ($Worktree) {
            $claudeDir = Join-Path $Worktree ".claude"
            if (-not (Test-Path $claudeDir)) { New-Item -ItemType Directory -Path $claudeDir | Out-Null }
            $pod = @{ name = $Name; cdp = $cdp; watch = $watch; profile = $profileDir }
            if ($stateFile) { $pod.state = $stateFile }
            $podJson = $pod | ConvertTo-Json
            [System.IO.File]::WriteAllText((Join-Path $claudeDir "pod.json"), $podJson)
            Write-Host "Bound to worktree: $(Join-Path $claudeDir 'pod.json')"
        }

        Write-Host ""
        Write-Host "Pod '$Name' is up ($Browser, ${Cpus} cpu / ${Memory} ram / ${Shm} shm)." -ForegroundColor Green
        Write-Host "  CDP:    127.0.0.1:$cdp"
        Write-Host "  Drive:  agent-browser --session $Name --cdp $cdp open <url>"
        Write-Host "  Profile: $profileDir"
        if ($stateFile) {
            Write-Host "  Auth:   agent-browser --session $Name --cdp $cdp state load $stateFile"
        }
        Write-Host "  Watch:  $watch"
        Write-Host "  Logs:   $logFile (live capture)"
        break
    }

    "down" {
        if ($All) {
            $pods = Get-Pods
            if ($pods) {
                foreach ($p in $pods) { Save-PodLogSnapshot $p.Name }
                docker rm -f ($pods | ForEach-Object { "agent-pod-$($_.Name)" }) | Out-Null
                Write-Host "All pods removed (logs archived under $LogRoot)."
            }
            else { Write-Host "No pods." }
        } elseif ($Name) {
            Save-PodLogSnapshot $Name
            docker rm -f "agent-pod-$Name" | Out-Null
            Write-Host "Pod '$Name' removed (logs archived under $LogRoot\$Name)."
        } else {
            throw "Usage: pod.ps1 down [name] OR pod.ps1 down -All"
        }
        break
    }

    "ls" {
        $pods = Get-Pods
        if (-not $pods) { Write-Host "No pods. Your real Brave stays on CDP 9222."; break }
        $pods | Format-Table Name, Cdp, Watch, Status -AutoSize
        break
    }

    "url" {
        if (-not $Name) { throw "Usage: pod.ps1 url [name]" }
        $pod = Get-Pods | Where-Object { $_.Name -eq $Name }
        if (-not $pod) { throw "No pod named '$Name'." }
        Write-Host $pod.Watch
        break
    }

    "logs" {
        if (-not $Name) { throw "Usage: pod.ps1 logs [name] -Tail 100 -Follow" }
        # Container stdout: Xvfb + Chromium + socat + x11vnc + websockify.
        # Live view here (json-file, rotated 5x50MB). For the durable full-run
        # archive (survives rotation + teardown) see $LogRoot\<name>\.
        # Restart count = how many times it has died.
        $restarts = docker inspect --format "{{.RestartCount}} restarts, status={{.State.Status}}, started={{.State.StartedAt}}" "agent-pod-$Name"
        Write-Host $restarts
        if ($Follow) { docker logs "agent-pod-$Name" --tail $Tail --timestamps --follow }
        else { docker logs "agent-pod-$Name" --tail $Tail --timestamps }
        break
    }

    { $_ -in "click", "move" } {
        # pod.ps1 click [name] -Selector "button.submit"
        # pod.ps1 click [name] <x> <y>     (viewport CSS px)
        if (-not $Name) { throw "Usage: pod.ps1 click [name] -Selector <sel> | pod.ps1 click [name] <x> <y>" }
        $pod = Get-Pods | Where-Object { $_.Name -eq $Name }
        if (-not $pod) { throw "No pod named '$Name'." }
        $cargs = @("$RepoRoot\cursor.mjs", $Cmd, "--pod", $Name, "--port", $pod.Cdp)
        if ($Selector) { $cargs += @("--selector", $Selector) }
        elseif ($Arg2 -and $Arg3) { $cargs += @("--x", $Arg2, "--y", $Arg3) }
        else { throw "Provide -Selector <sel> or positional <x> <y>." }
        node @cargs
        break
    }

    default {
        Write-Host @"
agent-pods - containerized browsers for parallel Claude Code sessions

  pod.ps1 build                                      build the image
  pod.ps1 up [name] -Cookies [p] -Worktree [dir]     spawn pod (CDP + watch URL)
  pod.ps1 ls                                         list pods + ports
  pod.ps1 url [name]                                 print watch URL
  pod.ps1 logs [name] -Tail 100 -Follow              container logs + restart count
  pod.ps1 click [name] -Selector <sel>               glide real cursor + click
  pod.ps1 click [name] <x> <y>                       click viewport coords
  pod.ps1 move  [name] -Selector <sel>               glide cursor only (hover)
  pod.ps1 down [name] | down -All                    remove pod(s)

Port 9222 is reserved for your real local browser. Pods get 9223+.
"@
    }
}
