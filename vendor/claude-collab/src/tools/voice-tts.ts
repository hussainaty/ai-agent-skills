import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransport } from '../transport.js';

// Dynamic import for edge-tts (ESM) — cached class + reusable instance
let EdgeTTS: any = null;
let ttsInstance: any = null;
async function getEdgeTTS() {
  if (!EdgeTTS) {
    const mod = await import('@andresaya/edge-tts');
    EdgeTTS = mod.EdgeTTS;
  }
  if (!ttsInstance) {
    ttsInstance = new EdgeTTS();
  }
  return ttsInstance;
}

export function registerVoiceTTSTool(server: McpServer): void {
  server.tool(
    'collab_voice_tts',
    'Speak text aloud in the collab browser using Edge TTS. The audio plays in the browser and the mic is muted during playback to prevent echo.',
    {
      text: z.string().describe('Text to speak aloud'),
      voice: z.string().default('en-US-AriaNeural').describe('Edge TTS voice name (e.g., en-US-AriaNeural, en-US-GuyNeural, he-IL-AvriNeural)'),
    },
    async ({ text, voice }) => {
      const t = getTransport();

      try {
        const tts = await getEdgeTTS();

        await tts.synthesize(text, voice);
        const base64Audio = tts.toBase64();

        if (!base64Audio) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: 'Edge TTS returned empty audio' }),
            }],
          };
        }

        // Inject audio into browser and play via voice module
        const played = await t.evalWidget(({ audio, mime }: { audio: string; mime: string }) => {
          if (window.__dc?.voice?.playAudio) {
            window.__dc.voice.playAudio(audio, mime);
            return true;
          }
          // Fallback: play directly without voice module
          const a = new Audio('data:' + mime + ';base64,' + audio);
          a.play();
          return true;
        }, { audio: base64Audio, mime: 'audio/mp3' });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, played, textLength: text.length }),
          }],
        };
      } catch (err) {
        console.error('[voice-tts] Error:', err);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: String(err) }),
          }],
        };
      }
    },
  );
}
