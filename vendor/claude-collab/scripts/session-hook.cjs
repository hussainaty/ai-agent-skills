#!/usr/bin/env node
/**
 * Session lifecycle hook — fires after collab_browse and collab_close.
 *
 * After collab_browse: tells Claude to spawn a background listener agent.
 * After collab_close: tells Claude the session ended, no new listener needed.
 *
 * Reads tool_name from stdin JSON (provided by Claude Code hook system).
 */

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const tool = data.tool_name || '';

    const path = require('path');
    const fs = require('fs');
    const OWNER_FILE = path.join(__dirname, '..', '.owner-session');

    const listenerPath = path.join(__dirname, 'listener.cjs');
    if (tool.includes('collab_browse')) {
      // Claim collab ownership for this session — cancel/stop hooks in other
      // Claude sessions check this file and stay silent (they'd otherwise
      // deliver collab messages to every running terminal)
      if (data.session_id) {
        try { fs.writeFileSync(OWNER_FILE, String(data.session_id)); } catch {}
      }
      console.log(
        '[COLLAB-SETUP] CRITICAL — You MUST do these steps NOW, before anything else:\n' +
        '\n' +
        'STEP 1: Start the background message listener.\n' +
        '  Use the Bash tool with run_in_background: true.\n' +
        '  Copy this command EXACTLY — do NOT change the path:\n' +
        '  node "' + listenerPath + '"\n' +
        '\n' +
        'STEP 2: Send your first message using collab_chat with waitForReply: false.\n' +
        '\n' +
        'RULES:\n' +
        '- NEVER use waitForReply: true — it blocks hook delivery and causes message loss.\n' +
        '- The listener exits after delivering a message. You MUST start a new one immediately after responding via collab_chat.\n' +
        '- If you forget, the [COLLAB-LISTENER-DOWN] reminder will appear after your next tool call — obey it immediately.\n' +
        '- When you receive a [COLLAB] message, respond via collab_chat, THEN restart the listener.'
      );
    }

    if (tool.includes('collab_close')) {
      try { fs.unlinkSync(OWNER_FILE); } catch {}
      console.log(
        '[COLLAB-CLEANUP] Session ended. Do NOT spawn a new listener agent.'
      );
    }
  } catch {
    // Silent failure — don't block Claude
  }
});
