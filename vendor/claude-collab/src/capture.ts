import { getTransport, type CaptureRect } from './transport.js';

// Re-export CaptureRect for tools that import from capture
export type { CaptureRect };

/**
 * Capture a screenshot of the active frame or a specific clip region.
 * Delegates to the active transport's screenshot method.
 */
export async function captureActiveFrame(clip?: CaptureRect): Promise<Buffer> {
  const transport = getTransport();
  return await transport.screenshot({ clip: clip || undefined });
}

/**
 * Process capture rect requests from chat replies, returning MCP content blocks.
 * Used by both chat.ts and inbox.ts.
 */
export async function fulfillCaptureRects(
  replies: Array<{ text: string; imageData?: string; mimeType?: string; captureRect?: CaptureRect }>,
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>,
): Promise<void> {
  // Attach any direct base64 images
  for (const r of replies) {
    if (r.imageData) {
      content.push({
        type: 'image' as const,
        data: r.imageData,
        mimeType: r.mimeType || 'image/png',
      });
    }
  }

  // Fulfill capture rect requests
  for (const r of replies) {
    if (r.captureRect) {
      try {
        const buffer = await captureActiveFrame(r.captureRect);
        content.push({
          type: 'image' as const,
          data: buffer.toString('base64'),
          mimeType: 'image/png',
        });
      } catch (err) {
        console.error('[collab] Capture failed:', err);
        content.push({
          type: 'text' as const,
          text: JSON.stringify({ captureError: String(err) }),
        });
      }
    }
  }
}
