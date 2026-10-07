/**
 * Transport abstraction layer for Claude Collab.
 *
 * Tools interact with the browser through this interface, which can be
 * backed by Playwright (existing) or a Chrome extension (new).
 *
 * evalWidget/evalFrame accept either a code string OR a function + arg.
 * PlaywrightTransport passes functions directly to page.evaluate().
 * ExtensionTransport serializes them to strings for WebSocket transport.
 */

import type { TabInfo } from './types.js';

export interface CaptureRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScreenshotOpts {
  /** CSS selector for element-level screenshot */
  selector?: string;
  /** Capture the full scrollable page (not just viewport) */
  fullPage?: boolean;
  /** Clip to specific region */
  clip?: CaptureRect;
}

export interface DesignTransport {
  /**
   * Evaluate JavaScript in the widget context (where window.__dc lives).
   * Accepts a code string or a function + single arg (like Playwright's page.evaluate).
   */
  evalWidget(code: string): Promise<any>;
  evalWidget(fn: Function, arg?: any): Promise<any>;

  /**
   * Evaluate JavaScript in the target page context (the site being designed on).
   * Accepts a code string or a function + single arg (like Playwright's frame.evaluate).
   */
  evalFrame(code: string): Promise<any>;
  evalFrame(fn: Function, arg?: any): Promise<any>;

  /** Open a URL — creates a new tab or navigates the current one */
  browse(url: string): Promise<{ tabId: number }>;

  /**
   * Attach to the user's currently active tab instead of opening a URL.
   * Extension mode only — Playwright transports own their browser and have
   * no user tab to join.
   */
  attach?(): Promise<{ tabId: number; url: string }>;

  /** Navigate the active tab to a URL, returns final URL */
  navigate(url: string): Promise<string>;

  /** List all managed tabs */
  listTabs(): Promise<TabInfo[]>;

  /** Switch to a tab by ID */
  switchTab(tabId: number): Promise<void>;

  /** Close a tab by ID */
  closeTab(tabId: number): Promise<void>;

  /** Take a screenshot */
  screenshot(opts?: ScreenshotOpts): Promise<Buffer>;

  /** Set the viewport size */
  setViewportSize(size: { width: number; height: number }): Promise<void>;

  /** Get the current viewport size */
  getViewportSize(): Promise<{ width: number; height: number } | null>;

  /** Check if the transport is connected and ready */
  isReady(): boolean;

  /** Get the current mode */
  getMode(): 'tabs' | 'single' | 'extension';

  /** Clean up resources */
  cleanup(): Promise<void>;
}

// ==================== Active Transport State ====================

let activeTransport: DesignTransport | null = null;

export function getTransport(): DesignTransport {
  if (!activeTransport) {
    throw new Error('No active transport. Call collab_browse first.');
  }
  return activeTransport;
}

export function setTransport(t: DesignTransport): void {
  activeTransport = t;
}

export function hasTransport(): boolean {
  return activeTransport !== null && activeTransport.isReady();
}

export function clearTransport(): void {
  activeTransport = null;
}

// ==================== Serialization Helper ====================

/**
 * Serialize a function + arg into an eval-ready string.
 * Used by ExtensionTransport to send code over WebSocket.
 *
 * Usage:
 *   serializeEval((sel) => document.querySelector(sel), "div.foo")
 *   → '((sel) => document.querySelector(sel))("div.foo")'
 */
export function serializeEval(fn: Function, arg?: any): string {
  const fnStr = fn.toString();
  if (arg === undefined) {
    return `(${fnStr})()`;
  }
  return `(${fnStr})(${JSON.stringify(arg)})`;
}
