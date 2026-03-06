import {
  ConnectClient,
  HOST_READY_TYPE,
  HOST_READY_TIMEOUT,
  INTENT_ACTIONS,
} from '@unicitylabs/sphere-sdk/connect';
import {
  PostMessageTransport,
  ExtensionTransport,
} from '@unicitylabs/sphere-sdk/connect/browser';
import type {
  ConnectTransport,
  PublicIdentity,
} from '@unicitylabs/sphere-sdk/connect';

// ── Configuration ──────────────────────────────────────────────────────────
const WALLET_URL = 'https://sphere.unicity.network';
const GAME_WALLET_ADDRESS = '@boxyrun'; // Game operator's Unicity nametag
const ENTRY_FEE = 10;
const COIN_ID = 'UCT';
const FAUCET_URL = 'https://faucet.unicity.network/api/v1/faucet/request';
const SESSION_KEY = 'boxyrun-sphere-session';
const DEPOSIT_KEY = 'boxyrun-deposit-paid';

// ── State ──────────────────────────────────────────────────────────────────
interface WalletState {
  isConnected: boolean;
  isDepositPaid: boolean;
  identity: PublicIdentity | null;
  balance: number | null;
  error: string | null;
}

let client: ConnectClient | null = null;
let transport: ConnectTransport | null = null;
let popupWindow: Window | null = null;

const state: WalletState = {
  isConnected: false,
  isDepositPaid: false,
  identity: null,
  balance: null,
  error: null,
};

// ── Detection helpers ──────────────────────────────────────────────────────
function isInIframe(): boolean {
  try {
    return window.parent !== window && window.self !== window.top;
  } catch {
    return true;
  }
}

function hasExtension(): boolean {
  try {
    const sphere = (window as unknown as Record<string, unknown>).sphere;
    if (!sphere || typeof sphere !== 'object') return false;
    const isInstalled = (sphere as Record<string, unknown>).isInstalled;
    if (typeof isInstalled !== 'function') return false;
    return (isInstalled as () => boolean)() === true;
  } catch {
    return false;
  }
}

function waitForHostReady(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Wallet did not respond in time'));
    }, HOST_READY_TIMEOUT);

    function handler(event: MessageEvent) {
      if (event.data?.type === HOST_READY_TYPE) {
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        resolve();
      }
    }
    window.addEventListener('message', handler);
  });
}

// ── dApp metadata ──────────────────────────────────────────────────────────
const dappMeta = {
  name: 'Boxy Run',
  description: 'A 3D endless runner game on Unicity',
  url: location.origin,
} as const;

// ── Wallet operations ──────────────────────────────────────────────────────
async function connect(): Promise<void> {
  updateUI('connecting');

  try {
    if (isInIframe()) {
      transport = PostMessageTransport.forClient();
      client = new ConnectClient({ transport, dapp: dappMeta });
      const result = await client.connect();
      state.isConnected = true;
      state.identity = result.identity;
      sessionStorage.setItem(SESSION_KEY, result.sessionId);
    } else if (hasExtension()) {
      transport = ExtensionTransport.forClient();
      client = new ConnectClient({ transport, dapp: dappMeta });
      const result = await client.connect();
      state.isConnected = true;
      state.identity = result.identity;
    } else {
      // Popup mode
      if (!popupWindow || popupWindow.closed) {
        popupWindow = window.open(
          WALLET_URL + '/connect?origin=' + encodeURIComponent(location.origin),
          'sphere-wallet',
          'width=420,height=650',
        );
        if (!popupWindow) {
          throw new Error('Popup blocked. Please allow popups for this site.');
        }
      }

      transport?.destroy();
      transport = PostMessageTransport.forClient({
        target: popupWindow,
        targetOrigin: WALLET_URL,
      });

      await waitForHostReady();

      const resumeSessionId = sessionStorage.getItem(SESSION_KEY) ?? undefined;
      client = new ConnectClient({ transport, dapp: dappMeta, resumeSessionId });
      const result = await client.connect();
      state.isConnected = true;
      state.identity = result.identity;
      sessionStorage.setItem(SESSION_KEY, result.sessionId);
    }

    await refreshBalance();
    state.error = null;

    // Check if we have a pending deposit from before reload
    if (sessionStorage.getItem(DEPOSIT_KEY)) {
      sessionStorage.removeItem(DEPOSIT_KEY);
      state.isDepositPaid = true;
      updateUI('ready');
    } else {
      updateUI('connected');
    }
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Connection failed';
    state.isConnected = false;
    updateUI('disconnected');
  }
}

async function disconnect(): Promise<void> {
  try {
    await client?.disconnect();
  } catch {
    // ignore
  }
  transport?.destroy();
  client = null;
  transport = null;
  popupWindow?.close();
  popupWindow = null;
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(DEPOSIT_KEY);

  state.isConnected = false;
  state.isDepositPaid = false;
  state.identity = null;
  state.balance = null;
  state.error = null;
  updateUI('disconnected');
}

async function refreshBalance(): Promise<void> {
  if (!client) return;
  try {
    const result = await client.query<Record<string, unknown>>('sphere_getBalance');
    // The balance response contains coin balances — look for UCT
    if (result && typeof result === 'object') {
      // Try common response shapes
      const balances = (result as any).balances || result;
      if (Array.isArray(balances)) {
        const uct = balances.find((b: any) => b.coinId === COIN_ID || b.symbol === COIN_ID);
        state.balance = uct ? parseFloat(uct.balance ?? uct.amount ?? '0') : 0;
      } else if (typeof balances === 'object') {
        state.balance = parseFloat((balances as any)[COIN_ID] ?? '0');
      }
    }
  } catch (err) {
    console.error('Failed to fetch balance:', err);
    // Try getAssets as fallback
    try {
      const assets = await client.query<any[]>('sphere_getAssets');
      if (Array.isArray(assets)) {
        const uct = assets.find((a: any) => a.coinId === COIN_ID || a.symbol === COIN_ID);
        state.balance = uct ? parseFloat(uct.balance ?? uct.amount ?? '0') : 0;
      }
    } catch {
      state.balance = null;
    }
  }
}

async function deposit(): Promise<boolean> {
  if (!client || !state.isConnected) {
    state.error = 'Not connected';
    return false;
  }

  if (state.balance !== null && state.balance < ENTRY_FEE) {
    state.error = `Insufficient balance. You need at least ${ENTRY_FEE} ${COIN_ID}.`;
    updateUI('connected');
    return false;
  }

  try {
    updateUI('depositing');
    await client.intent(INTENT_ACTIONS.SEND, {
      to: GAME_WALLET_ADDRESS,
      amount: ENTRY_FEE,
      coinId: COIN_ID,
      memo: 'Boxy Run entry fee',
    });

    state.isDepositPaid = true;
    state.error = null;
    await refreshBalance();
    updateUI('ready');
    return true;
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Deposit failed';
    state.isDepositPaid = false;
    updateUI('connected');
    return false;
  }
}

async function depositAndRestart(): Promise<void> {
  const success = await deposit();
  if (success) {
    // Persist deposit state across reload
    sessionStorage.setItem(DEPOSIT_KEY, 'true');
    document.location.reload();
  }
}

async function requestPayout(coins: number): Promise<boolean> {
  if (coins <= 0 || !state.identity) return false;

  const unicityId = state.identity.nametag?.replace(/^@/, '') || '';
  if (!unicityId) {
    console.error('No Unicity ID for payout');
    return false;
  }

  try {
    const response = await fetch(FAUCET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        unicityId,
        coin: 'unicity',
        amount: coins,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Payout failed:', errorText);
      return false;
    }

    const data = await response.json();
    console.log('Payout success:', data);
    return true;
  } catch (err) {
    console.error('Payout error:', err);
    return false;
  }
}

// ── UI updates ─────────────────────────────────────────────────────────────
type UIPhase = 'disconnected' | 'connecting' | 'connected' | 'depositing' | 'ready' | 'playing' | 'gameover';

function updateUI(phase: UIPhase) {
  const connectBtn = document.getElementById('sphere-connect-btn') as HTMLButtonElement | null;
  const walletInfo = document.getElementById('sphere-wallet-info');
  const depositBtn = document.getElementById('sphere-deposit-btn') as HTMLButtonElement | null;
  const walletBalance = document.getElementById('sphere-balance');
  const walletAddress = document.getElementById('sphere-address');
  const disconnectBtn = document.getElementById('sphere-disconnect-btn');
  const variableContent = document.getElementById('variable-content');
  const errorDiv = document.getElementById('sphere-error');

  // Reset visibility
  if (connectBtn) connectBtn.style.display = 'none';
  if (walletInfo) walletInfo.style.display = 'none';
  if (depositBtn) depositBtn.style.display = 'none';
  if (disconnectBtn) disconnectBtn.style.display = 'none';

  // Show error if any
  if (errorDiv) {
    errorDiv.style.display = state.error ? 'block' : 'none';
    errorDiv.textContent = state.error || '';
  }

  // Update wallet info whenever connected
  if (state.isConnected) {
    if (walletAddress) {
      const id = state.identity;
      walletAddress.textContent =
        id?.nametag || ((id as any)?.chainPubkey?.substring(0, 16) + '...') || 'Connected';
    }
    if (walletBalance) {
      walletBalance.textContent =
        state.balance !== null ? state.balance + ' ' + COIN_ID : '...';
    }
  }

  switch (phase) {
    case 'disconnected':
      if (connectBtn) {
        connectBtn.style.display = 'block';
        connectBtn.textContent = 'Connect Sphere Wallet';
        connectBtn.disabled = false;
      }
      if (variableContent) {
        variableContent.style.visibility = 'visible';
        variableContent.innerHTML = 'Connect your Sphere wallet to play';
      }
      break;

    case 'connecting':
      if (connectBtn) {
        connectBtn.style.display = 'block';
        connectBtn.textContent = 'Connecting...';
        connectBtn.disabled = true;
      }
      break;

    case 'connected':
      if (walletInfo) walletInfo.style.display = 'block';
      if (disconnectBtn) disconnectBtn.style.display = 'inline-block';
      if (depositBtn) {
        depositBtn.style.display = 'block';
        depositBtn.textContent = 'Play (' + ENTRY_FEE + ' ' + COIN_ID + ')';
        depositBtn.disabled = false;
      }
      if (variableContent) {
        variableContent.style.visibility = 'visible';
        variableContent.innerHTML = 'Deposit ' + ENTRY_FEE + ' ' + COIN_ID + ' to start playing';
      }
      break;

    case 'depositing':
      if (walletInfo) walletInfo.style.display = 'block';
      if (depositBtn) {
        depositBtn.style.display = 'block';
        depositBtn.textContent = 'Confirming in wallet...';
        depositBtn.disabled = true;
      }
      break;

    case 'ready':
      if (walletInfo) walletInfo.style.display = 'block';
      if (disconnectBtn) disconnectBtn.style.display = 'inline-block';
      if (variableContent) {
        variableContent.style.visibility = 'visible';
        variableContent.innerHTML = 'Press any button to begin';
      }
      break;

    case 'playing':
      if (walletInfo) walletInfo.style.display = 'block';
      break;

    case 'gameover':
      if (walletInfo) walletInfo.style.display = 'block';
      if (depositBtn) {
        depositBtn.style.display = 'block';
        depositBtn.textContent = 'Play Again (' + ENTRY_FEE + ' ' + COIN_ID + ')';
        depositBtn.disabled = false;
      }
      break;
  }
}

// ── Wire up DOM events ─────────────────────────────────────────────────────
window.addEventListener('load', () => {
  const connectBtn = document.getElementById('sphere-connect-btn');
  const depositBtn = document.getElementById('sphere-deposit-btn');
  const disconnectBtn = document.getElementById('sphere-disconnect-btn');

  connectBtn?.addEventListener('click', () => connect());
  depositBtn?.addEventListener('click', () => {
    if (state.isDepositPaid) {
      // "Play Again" after game over — deposit and restart
      depositAndRestart();
    } else {
      deposit();
    }
  });
  disconnectBtn?.addEventListener('click', () => disconnect());

  // Try auto-reconnect if we have a saved session
  const hasSession = isInIframe() || hasExtension() || sessionStorage.getItem(SESSION_KEY);
  if (hasSession) {
    connect();
  } else {
    updateUI('disconnected');
  }
});

// Poll for popup window close
setInterval(() => {
  if (state.isConnected && popupWindow && popupWindow.closed) {
    disconnect();
  }
}, 1000);

// ── Global API for game.js ─────────────────────────────────────────────────
(window as any).SphereWallet = {
  get isConnected() { return state.isConnected; },
  get isDepositPaid() { return state.isDepositPaid; },
  get identity() { return state.identity; },
  get balance() { return state.balance; },
  get error() { return state.error; },
  get entryFee() { return ENTRY_FEE; },
  get coinId() { return COIN_ID; },
  connect,
  disconnect,
  deposit,
  depositAndRestart,
  requestPayout,
  refreshBalance,
  updateUI,
  resetDeposit() {
    state.isDepositPaid = false;
  },
};
