/** TypeScript declarations for the Claude Collab Widget (window.__dc) */

export interface ElementInfo {
  tag: string;
  id: string | null;
  classes: string[];
  text: string;
  rect: DOMRect;
  styles: {
    padding: string;
    margin: string;
    borderRadius: string;
    backgroundColor: string;
    color: string;
    fontSize: string;
    fontWeight: string;
    fontFamily: string;
    lineHeight: string;
    letterSpacing: string;
    boxShadow: string;
    border: string;
    display: string;
    gap: string;
    width: string;
    height: string;
  };
}

export interface ChatMessage {
  text: string;
  type: 'ai' | 'user' | 'system';
  time?: number;
}

export interface DesignCollabAPI {
  say(text: string): void;
  readNew(): string[];
  readAll(): ChatMessage[];
  getSelections(): ElementInfo[];
  renderPreview(html: string): void;
  hidePreview(): void;
  clearHighlights(): void;
  syncMessages(msgs: ChatMessage[]): void;
  system(text: string): void;
  exportChat(): string;
  clearChat(): void;
  renderOptions(targetSelector: string, options: { label: string; html: string }[]): void;
}

export interface VoiceModule {
  active: boolean;
  listening: boolean;
  speaking: boolean;
  playAudio(base64Data: string, mimeType?: string): Promise<void>;
  stopAudio(): void;
  toggle(): void;
  start(): void;
  stop(): void;
  wireUp(addMessage: Function, broadcast: Function, showThinking: Function): void;
}

export interface InspirationItem {
  id: string;
  category: string;
  note: string | null;
  selector: string;
  sourceUrl: string;
  sourceTitle: string;
  styles: Record<string, string>;
  dimensions: { width: number; height: number };
  tag: string;
  text: string;
  componentHtml: string | null;
  componentCss: string | null;
  screenshotB64: string | null;
  collectedAt: string;
}

export interface DesignCollabState {
  messages: ChatMessage[];
  lastReadIndex: number;
  clickMode: boolean;
  selectedElements: ElementInfo[];
  _tabId: string;
  _iframeOrigin?: string;
  api: DesignCollabAPI;
  voice?: VoiceModule;
  _inspirations?: InspirationItem[];
}

export interface TabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
  frameName: string;
}

export interface TabManagerAPI {
  createTab(url?: string, title?: string): number;
  switchTab(id: number): void;
  closeTab(id: number): void;
  getActiveTabId(): number;
  getActiveFrameName(): string;
  listTabs(): TabInfo[];
  updateTabInfo(id: number, url: string | null, title: string | null): void;
  setBarTheme(isDark: boolean): void;
}

declare global {
  interface Window {
    __dc: DesignCollabState;
    __dcBridge?: boolean;
    __dcTabs: TabManagerAPI;
  }
}
