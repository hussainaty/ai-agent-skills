/**
 * Playwright-backed transport for Claude Collab.
 * Wraps the existing browser.ts module into the DesignTransport interface.
 */

import type { DesignTransport, ScreenshotOpts } from './transport.js';
import type { TabInfo } from './types.js';
import {
  ensureBrowser,
  ensureBrowserSingle,
  openNewTab,
  navigateIframe,
  getPage,
  getActiveFrame,
  isSingleMode,
  getMode as getBrowserMode,
  isBrowserReady,
  listAllTabs,
  switchToTab,
  closeTabById,
  cleanup as browserCleanup,
} from './browser.js';

export class PlaywrightTransport implements DesignTransport {
  private browseMode: 'tabs' | 'single' = 'tabs';

  async evalWidget(fnOrCode: Function | string, arg?: any): Promise<any> {
    const page = getPage();
    if (typeof fnOrCode === 'string') {
      return await page.evaluate(fnOrCode);
    }
    return await page.evaluate(fnOrCode as any, arg);
  }

  async evalFrame(fnOrCode: Function | string, arg?: any): Promise<any> {
    const frame = await getActiveFrame();
    if (typeof fnOrCode === 'string') {
      return await frame.evaluate(fnOrCode);
    }
    return await frame.evaluate(fnOrCode as any, arg);
  }

  async browse(url: string): Promise<{ tabId: number }> {
    if (this.browseMode === 'single') {
      await ensureBrowserSingle(url);
      return { tabId: 0 };
    }
    await ensureBrowser();
    const { tabId } = await openNewTab(url);
    return { tabId };
  }

  /** Set the browse mode for subsequent browse() calls */
  setBrowseMode(mode: 'tabs' | 'single'): void {
    this.browseMode = mode;
  }

  async navigate(url: string): Promise<string> {
    const frame = await navigateIframe(url);
    return frame.url();
  }

  async listTabs(): Promise<TabInfo[]> {
    const tabs = await listAllTabs();
    // listAllTabs returns a subset; the actual data from __dcTabs includes frameName
    return tabs as unknown as TabInfo[];
  }

  async switchTab(tabId: number): Promise<void> {
    await switchToTab(tabId);
  }

  async closeTab(tabId: number): Promise<void> {
    await closeTabById(tabId);
  }

  async screenshot(opts?: ScreenshotOpts): Promise<Buffer> {
    const page = getPage();

    if (opts?.selector) {
      // Element screenshot
      const frame = await getActiveFrame();
      const el = await frame.$(opts.selector);
      if (el) {
        return await el.screenshot({ type: 'png' });
      }
      return await page.screenshot({ type: 'png' });
    }

    if (isSingleMode()) {
      return await page.screenshot({
        type: 'png',
        fullPage: opts?.fullPage,
        clip: opts?.clip ? { x: opts.clip.x, y: opts.clip.y, width: opts.clip.w, height: opts.clip.h } : undefined,
      });
    }

    // Tabs mode: screenshot the active tab's iframe element
    const frameName = await page.evaluate(() => window.__dcTabs.getActiveFrameName());
    const iframeEl = await page.$(`#${frameName}`);
    if (iframeEl) {
      return await iframeEl.screenshot({ type: 'png' });
    }

    return await page.screenshot({
      type: 'png',
      clip: opts?.clip ? { x: opts.clip.x, y: opts.clip.y, width: opts.clip.w, height: opts.clip.h } : undefined,
    });
  }

  async setViewportSize(size: { width: number; height: number }): Promise<void> {
    const page = getPage();
    await page.setViewportSize(size);
  }

  async getViewportSize(): Promise<{ width: number; height: number } | null> {
    const page = getPage();
    return page.viewportSize();
  }

  isReady(): boolean {
    return isBrowserReady();
  }

  getMode(): 'tabs' | 'single' | 'extension' {
    return getBrowserMode();
  }

  async cleanup(): Promise<void> {
    await browserCleanup();
  }
}
