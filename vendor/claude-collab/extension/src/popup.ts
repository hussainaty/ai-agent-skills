/**
 * Extension popup UI — connection status, toggle, and controls.
 */

const statusDot = document.getElementById('statusDot')!;
const statusLabel = document.getElementById('statusLabel')!;
const portInput = document.getElementById('portInput') as HTMLInputElement;
const tokenInput = document.getElementById('tokenInput') as HTMLInputElement;
const actionBtn = document.getElementById('actionBtn')!;
const toggleBtn = document.getElementById('toggleBtn')!;
const followBtn = document.getElementById('followBtn')!;
const tabsInfo = document.getElementById('tabsInfo')!;
const errorMsg = document.getElementById('errorMsg')!;

type ConnectionState = 'disconnected' | 'connecting' | 'connected';

function showError(msg: string) {
  errorMsg.textContent = msg;
  errorMsg.style.display = 'block';
}

function clearError() {
  errorMsg.textContent = '';
  errorMsg.style.display = 'none';
}

function updateUI(state: ConnectionState, info?: { port?: number; managedTabs?: number; hidden?: boolean; hasToken?: boolean; followTabs?: boolean }) {
  statusDot.className = 'dot ' + state;
  statusLabel.textContent = state === 'connected' ? `Connected (port ${info?.port || '?'})`
    : state === 'connecting' ? 'Connecting...'
    : info?.hasToken === false ? 'Needs auth token'
    : 'Disconnected';

  if (state === 'connected') {
    actionBtn.textContent = 'Disconnect';
    actionBtn.className = 'btn-disconnect';
    toggleBtn.style.display = 'block';
    toggleBtn.textContent = info?.hidden ? 'Show Widget' : 'Hide Widget';
    toggleBtn.className = info?.hidden ? 'btn-connect' : 'btn-toggle';
    followBtn.style.display = 'block';
    followBtn.textContent = info?.followTabs ? 'Follow Tabs: ON' : 'Follow Tabs: OFF';
    followBtn.className = info?.followTabs ? 'btn-follow active' : 'btn-follow';
    if (info?.managedTabs !== undefined) {
      tabsInfo.textContent = `Managing ${info.managedTabs} tab${info.managedTabs !== 1 ? 's' : ''}`;
    }
    clearError();
  } else {
    actionBtn.textContent = 'Connect';
    actionBtn.className = 'btn-connect';
    toggleBtn.style.display = 'none';
    followBtn.style.display = 'none';
    tabsInfo.textContent = '';
  }
}

// Get state from service worker
async function refreshState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'get-state' });
    if (response) {
      updateUI(response.state, { port: response.port, managedTabs: response.managedTabs, hidden: response.hidden, hasToken: response.hasToken, followTabs: response.followTabs });
      if (response.port) {
        portInput.value = String(response.port);
      }
      // Show masked token if one is stored
      const stored = await chrome.storage.local.get(['wsAuthToken']);
      if (stored.wsAuthToken) {
        tokenInput.value = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
        tokenInput.dataset.masked = 'true';
      }
    }
  } catch {
    updateUI('disconnected');
  }
}

actionBtn.addEventListener('click', async () => {
  const currentState = statusDot.className.includes('connected') && !statusDot.className.includes('dis')
    ? 'connected' : 'disconnected';

  if (currentState === 'connected') {
    clearError();
    await chrome.runtime.sendMessage({ type: 'disconnect' });
  } else {
    const port = parseInt(portInput.value) || 0;
    const rawToken = tokenInput.dataset.masked === 'true' ? '' : tokenInput.value;
    // Strip non-hex characters (handles accidental whitespace/quotes from paste)
    const token = rawToken.replace(/[^0-9a-fA-F]/g, '');
    if (port > 0) {
      chrome.storage.local.set({ wsPort: port });
    }
    clearError();
    updateUI('connecting');
    const response = await chrome.runtime.sendMessage({ type: 'connect', port, token });
    if (response && !response.ok && response.error) {
      showError(response.error);
      updateUI('disconnected');
    }
  }

  setTimeout(refreshState, 500);
});

toggleBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'toggle-widget' });
  setTimeout(refreshState, 300);
});

followBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'toggle-follow' });
  setTimeout(refreshState, 300);
});

// Clear masked state when user starts typing a new token
tokenInput.addEventListener('focus', () => {
  if (tokenInput.dataset.masked === 'true') {
    tokenInput.value = '';
    delete tokenInput.dataset.masked;
  }
});

// Strip non-hex characters on paste
tokenInput.addEventListener('paste', () => {
  setTimeout(() => {
    tokenInput.value = tokenInput.value.replace(/[^0-9a-fA-F]/g, '');
  }, 0);
});

// Show default port
portInput.placeholder = '19876';
portInput.value = '19876';

refreshState();
