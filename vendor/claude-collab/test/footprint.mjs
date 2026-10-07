// Context-footprint measurement — reports the upfront token cost a host pays
// just for loading Collab, BEFORE any tool is called: the tool definitions
// (name + description + inputSchema) plus the server instructions, exactly as
// sent over the wire to the client.
//
// Run:  node test/footprint.mjs   (or: npm run footprint)
//
// Measured, not declared: it connects as a real MCP client and reads the
// actual listTools() payload + initialize instructions — nothing hand-counted.
// Token counts are ESTIMATED (~chars/4); treat as ±~15%. Characters are exact.
//
// Blast radius: spawns the MCP server over stdio and reads metadata only.
// Does NOT open a browser, hit the network, or touch any settings.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const estTokens = (s) => Math.ceil(s.length / 4); // rough proxy for Claude's tokenizer
const fmt = (n) => n.toLocaleString('en-US');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', 'tsx', join(ROOT, 'src', 'index.ts')],
  cwd: ROOT,
  stderr: 'ignore', // we only want the report on stdout
});
const client = new Client({ name: 'footprint', version: '0.0.0' }, { capabilities: {} });

try {
  await client.connect(transport);

  // Server instructions (sent at initialize). Prefer the live value; fall back
  // to the source file with the same {{PLAYBOOK_PATH}} substitution index.ts does.
  let instructions = '';
  try { instructions = client.getInstructions?.() ?? ''; } catch { /* older SDK */ }
  if (!instructions) {
    try {
      instructions = readFileSync(join(ROOT, 'INSTRUCTIONS.md'), 'utf-8')
        .replace('{{PLAYBOOK_PATH}}', join(ROOT, 'docs', 'PLAYBOOK.md'));
    } catch { /* none */ }
  }

  // Tool definitions, serialized the way they're sent to the model.
  const { tools } = await client.listTools();
  const rows = tools
    .map((t) => {
      const json = JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema });
      return { name: t.name, chars: json.length, tokens: estTokens(json) };
    })
    .sort((a, b) => b.tokens - a.tokens);

  const toolChars = rows.reduce((n, r) => n + r.chars, 0);
  const toolTokens = rows.reduce((n, r) => n + r.tokens, 0);
  const instrTokens = estTokens(instructions);
  const totalTokens = toolTokens + instrTokens;

  console.log(`\nClaude Collab — context footprint (${tools.length} tools)\n`);
  console.log('  Per-tool (largest first):');
  console.log('  ' + 'tool'.padEnd(26) + 'chars'.padStart(8) + '~tokens'.padStart(10));
  console.log('  ' + '-'.repeat(44));
  for (const r of rows) {
    console.log('  ' + r.name.padEnd(26) + fmt(r.chars).padStart(8) + fmt(r.tokens).padStart(10));
  }
  console.log('  ' + '-'.repeat(44));
  console.log('  ' + 'tool definitions total'.padEnd(26) + fmt(toolChars).padStart(8) + fmt(toolTokens).padStart(10));
  console.log('  ' + 'server instructions'.padEnd(26) + fmt(instructions.length).padStart(8) + fmt(instrTokens).padStart(10));
  console.log('  ' + '='.repeat(44));
  console.log('  ' + 'GRAND TOTAL (upfront)'.padEnd(26) + ''.padStart(8) + ('~' + fmt(totalTokens)).padStart(10));
  console.log(`\n  tokens estimated at ~chars/4 (±~15%); characters are exact.`);
  console.log(`  averages ~${Math.round(toolTokens / tools.length)} tokens/tool.\n`);
} finally {
  try { await client.close(); } catch { /* already closing */ }
}
