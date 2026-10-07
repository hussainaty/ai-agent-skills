import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve paths relative to this file (../widget/)
const WIDGET_PATH = resolve(__dirname, '..', 'widget', 'collab-widget.js');
const IFRAME_BRIDGE_PATH = resolve(__dirname, '..', 'widget', 'iframe-bridge.js');
const TAB_MANAGER_PATH = resolve(__dirname, '..', 'widget', 'tab-manager.js');
const INSPECTOR_PATH = resolve(__dirname, '..', 'widget', 'inspector-panel.js');
const VOICE_MODULE_PATH = resolve(__dirname, '..', 'widget', 'voice-module.js');

/**
 * Read scripts with in-memory caching — avoids repeated synchronous disk I/O.
 * Files are cached for the server's lifetime. Restart to pick up changes.
 */
const scriptCache = new Map<string, string>();

function readCached(path: string): string {
  const cached = scriptCache.get(path);
  if (cached !== undefined) return cached;
  const content = readFileSync(path, 'utf-8');
  scriptCache.set(path, content);
  return content;
}

export function getWidgetScript(): string {
  return readCached(WIDGET_PATH);
}

export function getInspectorScript(): string {
  return readCached(INSPECTOR_PATH);
}

export function getTabManagerScript(): string {
  return readCached(TAB_MANAGER_PATH);
}

export function getVoiceModuleScript(): string {
  return readCached(VOICE_MODULE_PATH);
}

/**
 * Get the iframe bridge script wrapped in a DOMContentLoaded guard
 * for use with context.addInitScript(). Runs in all frames but only
 * activates when window.name starts with 'dc-frame-'.
 */
export function getIframeBridgeInitScript(): string {
  const source = readCached(IFRAME_BRIDGE_PATH);
  return `
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { ${source} });
    } else {
      ${source}
    }
  `;
}
