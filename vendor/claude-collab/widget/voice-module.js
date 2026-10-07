/**
 * Voice Module for Claude Collab Widget
 *
 * Adds speech-to-text (STT) and text-to-speech (TTS) to the collab widget.
 * - STT: Web Speech API (SpeechRecognition) — continuous, auto-sends on silence
 * - TTS: Audio playback of base64 audio injected by MCP server via Edge TTS
 * - Echo prevention: mic mutes while TTS plays
 * - No buttons needed for conversation — mic button is just on/off toggle
 */
(() => {
  if (!window.__dc) { console.warn('[voice] Widget not ready'); return; }
  if (window.__dc.voice) return 'Voice already active';

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.warn('[voice] SpeechRecognition not supported');
    return;
  }

  // ==================== STATE ====================
  const voice = window.__dc.voice = {
    active: false,          // Is voice mode on?
    listening: false,       // Is STT currently listening?
    speaking: false,        // Is TTS currently playing?
    recognition: null,      // SpeechRecognition instance
    currentAudio: null,     // Currently playing Audio element
    lang: 'en-US',          // Recognition language
    pendingTranscript: '',  // Accumulates interim results
  };

  // ==================== STT ====================
  let recognition = null;
  let restartTimeout = null;
  let finalTranscript = '';
  let sendTimeout = null;

  function createRecognition() {
    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = voice.lang;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      voice.listening = true;
      updateMicUI();
      console.log('[voice] STT started');
    };

    rec.onend = () => {
      voice.listening = false;
      updateMicUI();
      console.log('[voice] STT ended');

      // Auto-restart if voice mode is still active and not speaking
      if (voice.active && !voice.speaking) {
        if (restartTimeout) { clearTimeout(restartTimeout); restartTimeout = null; }
        restartTimeout = setTimeout(() => {
          restartTimeout = null;
          if (voice.active && !voice.speaking) startListening();
        }, 300);
      }
    };

    rec.onerror = (e) => {
      console.warn('[voice] STT error:', e.error);
      voice.listening = false;
      updateMicUI();

      // Don't restart on "not-allowed" or "service-not-allowed"
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        voice.active = false;
        updateMicUI();
        window.__dc.api.system('Microphone access denied. Check browser permissions.');
        return;
      }

      // "aborted" needs care: our own aborts (stopListening, TTS mute, retry)
      // null or replace `recognition` first, so rec !== recognition there.
      // An abort on the CURRENT instance means another tab took the browser-wide
      // speech session — restarting would steal it back and the tabs would
      // fight forever (with a permission prompt each round). Release instead.
      if (e.error === 'aborted') {
        if (rec === recognition && voice.active) voice.release();
        return;
      }

      // Auto-restart on transient errors — clear existing timeout first to prevent leaks
      if (voice.active && !voice.speaking) {
        if (restartTimeout) { clearTimeout(restartTimeout); restartTimeout = null; }
        restartTimeout = setTimeout(() => {
          restartTimeout = null;
          if (voice.active && !voice.speaking) startListening();
        }, 1000);
      }
    };

    rec.onresult = (e) => {
      let interim = '';
      let newFinal = '';

      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) {
          newFinal += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }

      // Accumulate final results (don't reset — previous finals may be waiting to send)
      if (newFinal) {
        finalTranscript += (finalTranscript ? ' ' : '') + newFinal;
      }

      // Show interim transcript as typing indicator
      voice.pendingTranscript = interim || finalTranscript;
      updateTranscriptUI(voice.pendingTranscript);

      // When we get a final result, queue it for sending
      if (finalTranscript.trim()) {
        // Clear any previous send timeout (user is still talking)
        if (sendTimeout) clearTimeout(sendTimeout);

        // Wait a beat for more speech, then send everything accumulated
        sendTimeout = setTimeout(() => {
          sendVoiceMessage(finalTranscript.trim());
          finalTranscript = '';
          voice.pendingTranscript = '';
          updateTranscriptUI('');
        }, 800);
      }
    };

    return rec;
  }

  function startListening() {
    if (voice.listening) return;
    // Allow starting during TTS if in interrupt mode
    if (voice.speaking && !voice._ttsInterruptMode) return;
    try {
      if (!recognition) recognition = createRecognition();
      recognition.start();
    } catch (e) {
      console.warn('[voice] Failed to start STT:', e);
      // May already be running — abort and retry
      try { recognition.abort(); } catch (_) {}
      recognition = createRecognition();
      setTimeout(() => {
        try { recognition.start(); } catch (_) {}
      }, 200);
    }
  }

  function stopListening() {
    if (restartTimeout) { clearTimeout(restartTimeout); restartTimeout = null; }
    if (sendTimeout) { clearTimeout(sendTimeout); sendTimeout = null; }
    if (recognition) {
      try { recognition.abort(); } catch (_) {}
      recognition = null;
    }
    voice.listening = false;
    voice.pendingTranscript = '';
    updateTranscriptUI('');
    updateMicUI();
  }

  function sendVoiceMessage(text) {
    if (!text) return;
    // Use the widget's send mechanism
    const dc = window.__dc;
    const addMessage = dc._addMessage;
    const broadcast = dc._broadcast;
    const showThinking = dc._showThinking;

    if (addMessage) {
      addMessage(text, 'user', false, null, null, 'voice');
      if (broadcast) broadcast({ text, type: 'user', source: 'voice' });
      if (showThinking) showThinking();
    }
    // Relay through the widget's shared relay — works in extension mode
    // (MessageChannel) and Playwright mode (binding). The old direct
    // window.__dcRelayMessage call hit a no-op stub in extension mode and
    // voice messages silently vanished.
    var relay = dc._relayMessage || window.__dcRelayMessage;
    if (relay) {
      relay(text).catch(function() {
        if (addMessage) addMessage('⚠ Voice message not delivered — Claude is not connected to this tab', 'system');
      });
    } else if (addMessage) {
      addMessage('⚠ Voice message not delivered — no relay channel', 'system');
    }
  }

  // ==================== TTS PLAYBACK ====================
  // MCP server injects audio via: window.__dc.voice.playAudio(base64, mime)
  voice.playAudio = function(base64Data, mimeType) {
    return new Promise((resolve, reject) => {
      // Stop any currently playing audio
      if (voice.currentAudio) {
        voice.currentAudio.pause();
        voice.currentAudio = null;
      }

      // MUTE STT during TTS to prevent feedback loop —
      // the mic picks up the speaker output and sends it back as "user" speech
      stopListening();
      voice.speaking = true;
      updateMicUI();

      const audio = new Audio('data:' + (mimeType || 'audio/mp3') + ';base64,' + base64Data);
      voice.currentAudio = audio;

      audio.onended = () => {
        voice.speaking = false;
        voice.currentAudio = null;
        // Clear any residual transcript from pre-mute capture
        finalTranscript = '';
        voice.pendingTranscript = '';
        updateTranscriptUI('');
        updateMicUI();
        // Resume listening after a longer cooldown so mic doesn't catch audio tail
        if (voice.active) {
          setTimeout(() => startListening(), 800);
        }
        resolve();
      };

      audio.onerror = (e) => {
        console.warn('[voice] Audio playback error:', e);
        voice.speaking = false;
        voice.currentAudio = null;
        finalTranscript = '';
        voice.pendingTranscript = '';
        updateTranscriptUI('');
        updateMicUI();
        if (voice.active) {
          setTimeout(() => startListening(), 800);
        }
        reject(e);
      };

      audio.play().catch(err => {
        console.warn('[voice] Audio play() rejected:', err);
        voice.speaking = false;
        voice.currentAudio = null;
        updateMicUI();
        if (voice.active) setTimeout(() => startListening(), 800);
        reject(err);
      });
    });
  };

  // Stop TTS playback (e.g., user interrupts)
  voice.stopAudio = function() {
    if (voice.currentAudio) {
      voice.currentAudio.pause();
      voice.currentAudio = null;
    }
    // Also stop browser speech synthesis
    if (speechSynthesis) {
      speechSynthesis.cancel();
    }
    voice.speaking = false;
    voice._ttsInterruptMode = false;
    updateMicUI();
  };

  // ==================== UI ====================
  let micBtn = null;
  let transcriptEl = null;

  function injectUI() {
    // Mic button — goes in header, before camera button
    const headerActions = document.querySelector('.dc-chat .dc-header-actions');
    if (!headerActions) return;

    micBtn = document.createElement('button');
    micBtn.className = 'dc-btn dc-mic';
    micBtn.title = 'Toggle voice mode';
    micBtn.textContent = '\uD83C\uDF99\uFE0F'; // 🎙️
    micBtn.style.cssText = 'font-size: 14px; transition: opacity 0.2s, filter 0.2s; opacity: 0.5;';

    micBtn.addEventListener('click', toggleVoice);

    // Insert before camera button in header
    const captureBtn = headerActions.querySelector('.dc-capture');
    if (captureBtn) {
      headerActions.insertBefore(micBtn, captureBtn);
    } else {
      const minBtn = headerActions.querySelector('.dc-minimize');
      if (minBtn) headerActions.insertBefore(micBtn, minBtn);
      else headerActions.appendChild(micBtn);
    }

    const inputArea = document.querySelector('.dc-input-area');

    // Transcript overlay — shows interim speech text
    transcriptEl = document.createElement('div');
    transcriptEl.className = 'dc-voice-transcript';
    transcriptEl.style.cssText = 'display: none; padding: 4px 10px; font-size: 12px; color: #a78bfa; background: rgba(167,139,250,0.08); border-radius: 6px; margin: 0 8px 4px; font-style: italic; min-height: 0; transition: all 0.2s;';

    // Insert transcript above input area
    const chatEl = inputArea.closest('.dc-chat');
    if (chatEl) {
      chatEl.insertBefore(transcriptEl, inputArea);
    }
  }

  function toggleVoice() {
    voice.active = !voice.active;
    if (voice.active) {
      // Claim the mic browser-wide: Chrome allows ONE speech session per
      // browser, so other tabs' widgets must release theirs or they steal
      // the session back and forth ("aborted" loops, silent transcripts)
      try {
        // Non-http(s) origins fail as postMessage targets ("file://" silently
        // drops, "null" throws) — claim lost, other tabs never release, mic fight.
        window.postMessage({ __dcRelay: true, action: 'voice-active' },
          /^https?:/.test(window.location.origin) ? window.location.origin : '*');
      } catch (_) {}
      startListening();
      window.__dc.api.system('Voice mode ON — speak naturally');
    } else {
      stopListening();
      voice.stopAudio();
      window.__dc.api.system('Voice mode OFF');
    }
    updateMicUI();
  }

  // Called (via service worker broadcast) when another tab takes the mic
  voice.release = function () {
    if (!voice.active) return;
    voice.active = false;
    stopListening();
    voice.stopAudio();
    updateMicUI();
    window.__dc.api.system('Voice mode moved to another tab — mic released here.');
  };

  function updateMicUI() {
    if (!micBtn) return;
    if (!voice.active) {
      micBtn.style.opacity = '0.5';
      micBtn.style.filter = '';
      micBtn.style.background = 'transparent';
      micBtn.title = 'Toggle voice mode (OFF)';
    } else if (voice.speaking) {
      micBtn.style.opacity = '1';
      micBtn.style.filter = 'hue-rotate(180deg)'; // blue tint while speaking
      micBtn.style.background = 'rgba(96,165,250,0.15)';
      micBtn.title = 'AI is speaking...';
    } else if (voice.listening) {
      micBtn.style.opacity = '1';
      micBtn.style.filter = '';
      micBtn.style.background = 'rgba(239,68,68,0.15)';
      micBtn.title = 'Listening... speak now';
    } else {
      micBtn.style.opacity = '0.8';
      micBtn.style.filter = '';
      micBtn.style.background = 'rgba(167,139,250,0.1)';
      micBtn.title = 'Voice mode ON (paused)';
    }
  }

  let transcriptDebounce = null;
  function updateTranscriptUI(text) {
    if (!transcriptEl) return;
    if (transcriptDebounce) clearTimeout(transcriptDebounce);
    transcriptDebounce = setTimeout(() => {
      if (text) {
        transcriptEl.textContent = text;
        transcriptEl.style.display = 'block';
      } else {
        transcriptEl.style.display = 'none';
        transcriptEl.textContent = '';
      }
    }, 150);
  }

  // ==================== BROWSER TTS (FAST PATH) ====================
  // Uses browser's built-in speechSynthesis for instant playback — no server round trip.
  // Auto-speaks AI messages when voice mode is active.

  let browserVoice = null; // cached SpeechSynthesisVoice

  function getBrowserVoice() {
    if (browserVoice) return browserVoice;
    const voices = speechSynthesis.getVoices();
    // Prefer natural-sounding English voices
    const preferred = ['Microsoft Aria', 'Microsoft Jenny', 'Google US English', 'Samantha', 'Karen'];
    for (const name of preferred) {
      const v = voices.find(v => v.name.includes(name));
      if (v) { browserVoice = v; return v; }
    }
    // Fallback: first English voice
    browserVoice = voices.find(v => v.lang.startsWith('en')) || voices[0];
    return browserVoice;
  }

  // Preload voices (they load async in some browsers)
  if (typeof speechSynthesis !== 'undefined' && speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.addEventListener('voiceschanged', () => { browserVoice = null; getBrowserVoice(); });
  }

  function speakBrowser(text) {
    return new Promise((resolve) => {
      if (!text || !speechSynthesis) { resolve(); return; }

      // MUTE STT during TTS to prevent feedback loop
      stopListening();
      voice.speaking = true;
      updateMicUI();

      // Cancel any ongoing speech
      speechSynthesis.cancel();

      const utter = new SpeechSynthesisUtterance(text);
      const v = getBrowserVoice();
      if (v) utter.voice = v;
      utter.rate = 1.05;
      utter.pitch = 1.0;

      utter.onend = () => {
        voice.speaking = false;
        finalTranscript = '';
        voice.pendingTranscript = '';
        updateTranscriptUI('');
        updateMicUI();
        if (voice.active) setTimeout(() => startListening(), 800);
        resolve();
      };
      utter.onerror = () => {
        voice.speaking = false;
        finalTranscript = '';
        voice.pendingTranscript = '';
        updateTranscriptUI('');
        updateMicUI();
        if (voice.active) setTimeout(() => startListening(), 800);
        resolve();
      };

      speechSynthesis.speak(utter);
    });
  }

  // Expose for direct use and for widget's addMessage to call
  voice.speakBrowser = speakBrowser;

  // ==================== EXPOSE INTERNALS ====================
  // The widget needs to expose addMessage/broadcast/showThinking for voice to use
  // These get wired up after widget initialization
  voice.wireUp = function(addMessage, broadcast, showThinking) {
    window.__dc._addMessage = addMessage;
    window.__dc._broadcast = broadcast;
    window.__dc._showThinking = showThinking;
  };

  voice.toggle = toggleVoice;
  voice.start = () => { voice.active = true; startListening(); updateMicUI(); };
  voice.stop = () => { voice.active = false; stopListening(); voice.stopAudio(); updateMicUI(); };

  // Inject UI after a short delay to ensure widget DOM is ready
  setTimeout(injectUI, 100);

  return 'Voice module loaded';
})();
