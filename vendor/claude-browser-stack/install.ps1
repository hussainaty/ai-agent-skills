# Symlink the claude-browser-stack skills into ~/.claude/skills/
# Re-runnable: replaces existing links of the same name.
# Requires Developer Mode enabled, or run from an elevated (admin) shell,
# so that symlink/junction creation is permitted.

$ErrorActionPreference = 'Stop'

$RepoDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillsSrc = Join-Path $RepoDir 'skills'
$SkillsDst = Join-Path $HOME '.claude\skills'

if (-not (Test-Path $SkillsDst)) { New-Item -ItemType Directory -Force -Path $SkillsDst | Out-Null }

Get-ChildItem -Path $SkillsSrc -Directory | ForEach-Object {
    $name = $_.Name
    $dst  = Join-Path $SkillsDst $name
    if (Test-Path $dst) {
        Write-Host "  replacing existing: $name"
        Remove-Item $dst -Recurse -Force
    }
    New-Item -ItemType SymbolicLink -Path $dst -Target $_.FullName | Out-Null
    Write-Host "  linked: $name"
}

Write-Host ""
Write-Host "Done. Skills linked into $SkillsDst"
Write-Host "Next: 'npm install -g agent-browser; agent-browser install' (engine),"
Write-Host "and 'npm install -g chrome-remote-interface' (for /watchall and /watchconsole)."
