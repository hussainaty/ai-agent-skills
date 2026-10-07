import { z } from 'zod';
import { writeFileSync } from 'fs';
import { resolve, relative, isAbsolute } from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';

export function registerExportChatTool(server: McpServer): void {
  server.tool(
    'collab_export_chat',
    'Export the full chat history from the widget. Use this to save conversation context before it gets lost to context window compaction, or to create a session log. Optionally writes to a file.',
    {
      filePath: z.string().optional().describe('Absolute file path to write the chat export to. If omitted, returns the chat JSON directly.'),
    },
    async ({ filePath }) => {
      const t = getTransport();

      const chatJson = await t.evalWidget(() => window.__dc.api.exportChat());

      if (filePath) {
        const absPath = resolve(filePath);
        // Prevent path traversal — only allow writes under cwd
        const cwd = process.cwd();
        const rel = relative(cwd, absPath);
        if (rel.startsWith('..') || isAbsolute(rel)) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Path must be under the current working directory' }) }],
          };
        }
        writeFileSync(absPath, chatJson, 'utf-8');
        console.error(`[collab_export_chat] Chat exported to ${absPath}`);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ exported: true, path: absPath, messageCount: JSON.parse(chatJson).length }),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: chatJson,
        }],
      };
    },
  );
}
