#!/usr/bin/env node
/**
 * Claude Collab setup — installs the Claude Code hooks automatically.
 *
 * Usage:
 *   npm run setup              Install hooks into global ~/.claude/settings.json
 *   npm run setup -- --project Install into ./.claude/settings.json (current project)
 *   npm run setup -- --remove  Remove Claude Collab hooks
 *
 * Idempotent: re-running replaces any existing Claude Collab hook entries
 * (including stale ones from a previous install location). A timestamped
 * backup of settings.json is written before any change.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT_ROOT = path.resolve(__dirname, '..');

// Forward slashes work on all platforms and avoid JSON escaping noise.
function scriptCmd(name) {
  return `node "${path.join(PROJECT_ROOT, 'scripts', name).replace(/\\/g, '/')}"`;
}

// Filenames used to recognize our entries regardless of install path.
const OUR_SCRIPTS = ['cancel-hook.cjs', 'stop-hook.cjs', 'session-hook.cjs', 'event-hook.cjs', 'notify-hook.js'];

// The canonical hook set (mirrors the tested reference configuration).
const HOOKS = {
  PreToolUse: {
    // No matcher: user messages must be able to interrupt ANY tool call,
    // not just collab_* ones. The script no-ops in <5ms when no collab
    // session is active (port files absent).
    hooks: [{ type: 'command', command: scriptCmd('cancel-hook.cjs'), timeout: 3 }],
  },
  Stop: {
    hooks: [{ type: 'command', command: scriptCmd('stop-hook.cjs'), timeout: 3 }],
  },
  PostToolUse: {
    // Unanchored on purpose: full names are mcp__<registration-name>__collab_browse,
    // and the registration name is whatever the user typed in `claude mcp add`.
    // Matching on the tool suffix works for any registration name.
    matcher: 'collab_browse|collab_close',
    hooks: [{ type: 'command', command: scriptCmd('session-hook.cjs'), timeout: 3 }],
  },
  PermissionRequest: {
    // Mirrors Claude Code permission prompts into the browser widget.
    hooks: [{ type: 'command', command: scriptCmd('notify-hook.js'), timeout: 5 }],
  },
};

function isOurs(entry) {
  const cmds = (entry && entry.hooks ? entry.hooks : [])
    .map((h) => String(h.command || ''));
  return cmds.some((c) => OUR_SCRIPTS.some((s) => c.includes(s)));
}

function main() {
  const args = process.argv.slice(2);
  const useProject = args.includes('--project');
  const remove = args.includes('--remove');

  // Sanity: all hook scripts must exist next to this one.
  for (const s of OUR_SCRIPTS) {
    if (!fs.existsSync(path.join(__dirname, s))) {
      console.error(`✗ Missing script: scripts/${s} — is the repo intact?`);
      process.exit(1);
    }
  }

  const settingsDir = useProject
    ? path.join(process.cwd(), '.claude')
    : path.join(os.homedir(), '.claude');
  const settingsPath = path.join(settingsDir, 'settings.json');

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    try {
      settings = JSON.parse(raw);
    } catch (e) {
      console.error(`✗ ${settingsPath} is not valid JSON — fix it first (not touching it).`);
      console.error(`  Parse error: ${e.message}`);
      process.exit(1);
    }
    // Backup before modifying
    const backupPath = `${settingsPath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(settingsPath, backupPath);
    console.log(`• Backed up settings to ${backupPath}`);
  } else if (remove) {
    console.log('• No settings file found — nothing to remove.');
    return;
  } else {
    fs.mkdirSync(settingsDir, { recursive: true });
    console.log(`• Creating ${settingsPath}`);
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};

  // Strip any existing Claude Collab entries (stale paths included).
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter((entry) => !isOurs(entry));
    removed += before - settings.hooks[event].length;
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }

  if (remove) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log(`✓ Removed ${removed} Claude Collab hook entr${removed === 1 ? 'y' : 'ies'} from ${settingsPath}`);
    return;
  }

  // Install fresh entries.
  for (const [event, entry] of Object.entries(HOOKS)) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    settings.hooks[event].push(entry);
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`✓ Installed Claude Collab hooks into ${settingsPath}`);
  if (removed > 0) console.log(`  (replaced ${removed} previous entr${removed === 1 ? 'y' : 'ies'})`);

  console.log(`
Next steps:
  1. Register the MCP server (run from anywhere):
       claude mcp add collab -- npx tsx "${path.join(PROJECT_ROOT, 'src', 'index.ts').replace(/\\/g, '/')}"
  2. Restart any running Claude Code session to pick up the hooks.
  3. In Claude Code, try:  "Use collab to open example.com"

For extension mode (your real Chrome), also run:  npm run build:ext
then load extension/dist via chrome://extensions (Developer mode → Load unpacked).
`);
}

main();
