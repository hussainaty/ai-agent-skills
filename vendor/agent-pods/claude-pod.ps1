# claude-pod.ps1 - in-container Claude pods (the agent runs INSIDE the sandbox).
#
#   .\claude-pod.ps1 build                       build agent-pod-claude:latest (base first)
#   .\claude-pod.ps1 up <name> [-Cookies <p>]    spawn a claude pod (reuses pod.ps1 logic)
#   .\claude-pod.ps1 login <name>                one-time interactive quota login (OAuth)
#   .\claude-pod.ps1 run <name> "<mission>"      dispatch a mission headless, get JSON back
#   .\claude-pod.ps1 shell <name>                interactive shell in the pod (as agent)
#   .\claude-pod.ps1 ls | down <name>            delegate to pod.ps1
#
# The host never runs the risky stuff: it only builds, spawns, logs in once, and
# dispatches. The browser-driving + posting all happen inside the container.
#
# Keep this file ASCII-only (PowerShell 5.1 reads BOM-less files as ANSI).

param(
    [Parameter(Position = 0)]
    [ValidateSet("build", "up", "login", "run", "shell", "ls", "down", "help")]
    [string]$Cmd = "help",

    [Parameter(Position = 1)]
    [string]$Name,

    [Parameter(Position = 2)]
    [string]$Mission,

    [string]$Cookies,
    [switch]$All
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Pod = Join-Path $Root "pod.ps1"
$ClaudeImage = "agent-pod-claude:latest"
$BaseImage = "agent-pod:latest"

function Container([string]$n) { "agent-pod-$n" }

switch ($Cmd) {

    "build" {
        # Base browser image must exist first (Dockerfile.claude is FROM it).
        $base = docker images -q $BaseImage
        if (-not $base) {
            Write-Host "Base image missing - building $BaseImage first..."
            & $Pod build
        }
        Write-Host "Building $ClaudeImage (Node + Claude Code + agent-browser + nodriver)..."
        docker build -f "$Root\Dockerfile.claude" -t $ClaudeImage $Root
        break
    }

    "up" {
        if (-not $Name) { throw "Usage: claude-pod.ps1 up <name> [-Cookies <profile>]" }
        # Make sure the claude image exists.
        if (-not (docker images -q $ClaudeImage)) {
            Write-Host "$ClaudeImage not built yet - building..."
            & "$Root\claude-pod.ps1" build
        }
        # Hashtable splat = NAMED binding (array splat passes positionally and
        # would swallow -ImageOverride as a positional arg).
        $splat = @{ ImageOverride = $ClaudeImage }
        if ($Cookies) { $splat.Cookies = $Cookies }
        & $Pod up $Name @splat
        Write-Host ""
        Write-Host "Claude pod '$Name' up. Next steps:" -ForegroundColor Green
        Write-Host "  1) One-time login (your quota):  .\claude-pod.ps1 login $Name"
        Write-Host "  2) Dispatch a mission:           .\claude-pod.ps1 run $Name ""<mission>"""
        break
    }

    "login" {
        if (-not $Name) { throw "Usage: claude-pod.ps1 login <name>" }
        Write-Host "Interactive Claude login INSIDE the pod (subscription quota, not API key)."
        Write-Host "Follow the OAuth URL it prints; approve in your browser; then /exit."
        Write-Host "Credentials persist on the pod profile mount (survive teardown)."
        Write-Host ""
        docker exec -it -u agent (Container $Name) claude
        break
    }

    "run" {
        if (-not $Name -or -not $Mission) { throw "Usage: claude-pod.ps1 run <name> ""<mission>""" }
        # Headless mission. bypass is safe: the container is the sandbox.
        docker exec -u agent (Container $Name) claude -p $Mission `
            --output-format json --dangerously-skip-permissions
        break
    }

    "shell" {
        if (-not $Name) { throw "Usage: claude-pod.ps1 shell <name>" }
        docker exec -it -u agent (Container $Name) bash
        break
    }

    "ls"   { & $Pod ls; break }

    "down" {
        if ($All) { & $Pod down -All }
        elseif ($Name) { & $Pod down $Name }
        else { throw "Usage: claude-pod.ps1 down <name> | down -All" }
        break
    }

    default {
        Write-Host @"
claude-pod - in-container Claude pods (agent runs INSIDE the Docker sandbox)

  claude-pod.ps1 build                    build agent-pod-claude:latest
  claude-pod.ps1 up <name> [-Cookies <p>] spawn a claude pod
  claude-pod.ps1 login <name>             one-time quota login (OAuth, persists)
  claude-pod.ps1 run <name> "<mission>"   dispatch a mission headless -> JSON
  claude-pod.ps1 shell <name>             interactive shell in the pod (agent user)
  claude-pod.ps1 ls                       list pods
  claude-pod.ps1 down <name> | down -All  remove pod(s)

The host only builds/spawns/logs-in/dispatches. All browser work is sandboxed.
"@
    }
}
