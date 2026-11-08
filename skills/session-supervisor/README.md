# Session Supervisor

One skill and MCP for managing Codex and Claude Code sessions. The supervisor selects an authorized project and session; each client keeps its own history, authentication and model settings. This package does not include any credentials or subscriptions.

## Setup

Install Python 3.11 or later, Codex and/or Claude Code, and configure the provider access you intend to use. From this folder create an environment and install `requirements.txt`. The optional `claude-agent-sdk` package adds supported Claude session-history discovery and rename/tag capabilities. It is not needed for the Codex reader or basic Claude CLI discovery.

```sh
python -m venv .venv
# Activate .venv using the instructions for your shell, then:
python -m pip install -r requirements.txt
# Optional, for Claude SDK session-history and rename/tag features:
python -m pip install claude-agent-sdk
```

Copy this entire folder to a supported skills directory, for example project `.agents/skills/session-supervisor` for Codex or `.claude/skills/session-supervisor` for Claude Code. Do not overwrite an existing skill without reviewing it.

Register the MCP using the absolute paths to that folder's `scripts/session_mcp.py` and your environment's Python executable. Examples below use placeholders; replace them with your actual absolute paths:

```sh
codex mcp add session_supervisor -- /path/to/python /path/to/session-supervisor/scripts/session_mcp.py
claude mcp add -s user session_supervisor -- /path/to/python /path/to/session-supervisor/scripts/session_mcp.py
```

On Windows use the environment's `Scripts/python.exe` and quote paths containing spaces. Restart or reload the client if it does not immediately discover the new server. Neither registration signs in or starts a model request.

## What works

- Codex: project-scoped session listing, status, bounded authorized outcome, Goal status and account-limit reads. Prefer native Codex app tools for host-supported project/chat creation, moving, messages and archival. This MCP does not claim to control app-only operations or prove sidebar visibility.
- Claude Code: project-scoped discovery and status; explicitly authorized creation, resume and background stop requests; optional SDK rename and tag. Saved-history discovery and rename/tag need the optional SDK. Resume is intentionally limited to a verified stopped background session; a CLI snapshot cannot establish atomic idleness across other apps. Claude handles its own rate limits.
- A durable Codex wake scheduler is included as a **component** with an explicit host adapter contract. It waits without model inference and rejects ambiguous states. It has not been connected to a real host with atomic idle-only, deduplicated dispatch and cancellation fencing. It does not automatically wake a stopped desktop chat. Do not install a guessed background workaround and call it working.

For real Claude start/resume calls, the supervisor waits for a bounded period and never terminates the Claude process merely because that wait expires. CLI output is not captured on that detached-safe path; inspect the authorized session or SDK summary afterward. Continued operation across MCP, computer, or operating-system shutdown is not guaranteed.

Claude model calls require the user's explicit authorization and the target machine's own valid provider access; no cost or free entitlement is assumed. A returned acceptance is not proof that a task completed. Optional Claude outcome text can contain project information; masking common credential patterns is best effort only.

## Verification

Run `python -m unittest discover -s tests -v` from this folder. These tests use temporary directories and fake hosts; they do not validate real model access, real rate-limit recovery or desktop integration. See `references/` for exact boundaries and supported interfaces.

OpenCode and Hermes are delegated workers when separately installed and available; this package does not bundle their MCP bridges or model credentials. The supervisor sends a complete plan and tests, reuses a related worker session, and reviews its result. Actual token savings are not guaranteed.
