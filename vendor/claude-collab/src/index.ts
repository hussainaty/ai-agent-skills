import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cleanup } from './browser.js';
import { reset as resetMessageStore } from './message-store.js';
import { hasTransport, getTransport, clearTransport } from './transport.js';
import { registerBrowseTool } from './tools/browse.js';
import { registerChatTool } from './tools/chat.js';
import { registerScreenshotTool } from './tools/screenshot.js';
import { registerSelectionsTool } from './tools/selections.js';
import { registerPreviewTool } from './tools/preview.js';
import { registerOptionsTool } from './tools/options.js';
import { registerCloseTool } from './tools/close.js';
import { registerExtractStylesTool } from './tools/extract-styles.js';
import { registerNavigateTool } from './tools/navigate.js';
import { registerExportChatTool } from './tools/export-chat.js';
import { registerEvaluateTool } from './tools/evaluate.js';
import { registerResizeTool } from './tools/resize.js';
import { registerTabsTool } from './tools/tabs.js';
import { registerInboxTool } from './tools/inbox.js';
import { registerVoiceTTSTool } from './tools/voice-tts.js';
import { registerExtractComponentTool } from './tools/extract-component.js';
import { registerExtractTokensTool } from './tools/extract-tokens.js';
import { registerA11yAuditTool } from './tools/a11y-audit.js';
import { registerVisualDiffTool } from './tools/visual-diff.js';
import { registerWireframeTool } from './tools/wireframe.js';
import { registerResponsiveAuditTool } from './tools/responsive-audit.js';
import { registerCollectTool } from './tools/collect.js';
import { registerMoodboardTool } from './tools/moodboard.js';
import { registerSynthesizeTool } from './tools/synthesize.js';
import { registerScanTool } from './tools/scan.js';
import { registerActTool } from './tools/act.js';

// Load instructions from INSTRUCTIONS.md (editable without recompiling)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');
// Claude Code truncates MCP server instructions at 2048 chars — INSTRUCTIONS.md
// must stay under that budget. Deep reference lives in docs/PLAYBOOK.md, whose
// absolute path is injected here so Claude can Read it on demand.
const INSTRUCTIONS_CHAR_BUDGET = 2048;
let instructions: string;
try {
  instructions = readFileSync(join(projectRoot, 'INSTRUCTIONS.md'), 'utf-8')
    .replace('{{PLAYBOOK_PATH}}', join(projectRoot, 'docs', 'PLAYBOOK.md'));
} catch {
  instructions = 'Claude Collab — AI-Powered Visual Collaboration Tool. See INSTRUCTIONS.md for full guide.';
}
if (instructions.length > INSTRUCTIONS_CHAR_BUDGET) {
  console.error(
    `[collab] WARNING: instructions are ${instructions.length} chars — ` +
    `Claude Code truncates at ${INSTRUCTIONS_CHAR_BUDGET}. Trim INSTRUCTIONS.md.`,
  );
}

const server = new McpServer(
  {
    name: 'collab',
    version: '0.8.0',  // keep in sync with package.json
  },
  {
    instructions,
  },
);

// Register all tools
registerBrowseTool(server);
registerChatTool(server);
registerScreenshotTool(server);
registerSelectionsTool(server);
registerPreviewTool(server);
registerOptionsTool(server);
registerCloseTool(server);
registerExtractStylesTool(server);
registerNavigateTool(server);
registerExportChatTool(server);
registerEvaluateTool(server);
registerResizeTool(server);
registerTabsTool(server);
registerInboxTool(server);
registerVoiceTTSTool(server);
registerExtractComponentTool(server);
registerExtractTokensTool(server);
registerA11yAuditTool(server);
registerVisualDiffTool(server);
registerWireframeTool(server);
registerResponsiveAuditTool(server);
registerCollectTool(server);
registerMoodboardTool(server);
registerSynthesizeTool(server);
registerScanTool(server);
registerActTool(server);

// Connect via stdio
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[collab] MCP server running on stdio');

// Cleanup on exit
async function handleExit() {
  if (hasTransport()) {
    await getTransport().cleanup();
  }
  clearTransport();
  resetMessageStore();
  await cleanup();
  process.exit(0);
}

process.on('SIGINT', handleExit);
process.on('SIGTERM', handleExit);
