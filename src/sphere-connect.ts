import {
  ConnectClient,
  HOST_READY_TYPE,
  HOST_READY_TIMEOUT,
  INTENT_ACTIONS,
  PERMISSION_SCOPES,
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
// The arena wallet is the single on-chain source of truth. Every UCT held
// by a player on the game ledger corresponds to a UCT sitting in this wallet.
// Distinct from any @boxyrun personal wallet to avoid co-mingling.
//
// Resolved LAZILY (at deposit-time, not module-load-time) so staging and prod
// can target different arena wallets: the server injects
// `window.__BOXY_ARENA_WALLET` into the served HTML based on its own
// ARENA_WALLET_NAMETAG env var. We must defer the read because this script
// loads before the inline injection runs, so an eagerly-resolved const would
// bake in the production fallback even on staging.
function gameWalletAddress(): string {
	if (typeof window !== 'undefined' && (window as any).__BOXY_ARENA_WALLET) {
		return (window as any).__BOXY_ARENA_WALLET as string;
	}
	return '@boxyrunarena';
}
const ENTRY_FEE = 10;
const COIN_ID = 'UCT';
const UCT_COIN_ID_HEX = '455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89';
const UCT_DECIMALS = 18;
const FAUCET_URL = 'https://faucet.unicity.network/api/v1/faucet/request';
const SESSION_KEY = 'boxyrun-sphere-session';
const DEPOSIT_KEY = 'boxyrun-deposit-paid';
/**
 * Server-side session token (NOT the Sphere wallet session). Issued by
 * /api/auth/verify after the client signs the server's challenge nonce
 * with the wallet's chain key. Stored in sessionStorage so reconnects
 * within the same tab don't trigger a new wallet popup.
 */
const AUTH_SESSION_KEY = 'boxyrun-auth-session';
let authSessionId: string | null = null;
let authedNametag: string | null = null;

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
let uctCoinId: string | null = null; // hex coinId resolved from wallet
let uctDecimals: number = 0;

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

const dappPermissions = [
  PERMISSION_SCOPES.IDENTITY_READ,
  PERMISSION_SCOPES.BALANCE_READ,
  PERMISSION_SCOPES.TRANSFER_REQUEST,
] as const;

// ── Wallet operations ──────────────────────────────────────────────────────
async function connect(): Promise<void> {
  // If already connected with a valid client, just refresh and return
  if (state.isConnected && client) {
    updateUI('connected');
    try { await refreshBalance(); } catch { /* ignore */ }
    return;
  }

  updateUI('connecting');

  try {
    // Set up transport based on environment
    let resumeSessionId: string | undefined;
    if (isInIframe()) {
      transport = PostMessageTransport.forClient();
    } else if (hasExtension()) {
      transport = ExtensionTransport.forClient();
    } else {
      // Popup mode
      const popupWasAlreadyOpen = popupWindow && !popupWindow.closed;
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

      // Only wait for HOST_READY if we just opened the popup fresh.
      // An already-open popup won't re-send that message.
      if (!popupWasAlreadyOpen) {
        try {
          await waitForHostReady();
        } catch {
          // Timeout waiting for popup ready — continue anyway, client.connect will fail fast if needed
        }
      }
      resumeSessionId = sessionStorage.getItem(SESSION_KEY) ?? undefined;
    }

    // Connect via the resolved transport
    client = new ConnectClient({
      transport, dapp: dappMeta, permissions: [...dappPermissions], resumeSessionId,
    });
    const result = await client.connect();
    state.isConnected = true;
    state.identity = result.identity;
    if (result.sessionId) {
      sessionStorage.setItem(SESSION_KEY, result.sessionId);
    }

    if (!state.identity?.nametag) {
      state.error = 'No Unicity ID found. Please register a Unicity ID in Sphere to play.';
      updateUI('connected');
      return;
    }

    // Establish the server-side session (Sphere-signed nametag auth).
    // Without this, every mutating REST and WS request will be 401.
    await ensureAuthSession();

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
  // Drop the server-side auth session too — leaving it would let a
  // fresh wallet keep the previous account's session token.
  sessionStorage.removeItem(AUTH_SESSION_KEY);
  authSessionId = null;
  authedNametag = null;

  state.isConnected = false;
  state.isDepositPaid = false;
  state.identity = null;
  state.balance = null;
  state.error = null;
  updateUI('disconnected');
}

/**
 * Establish a server-side session bound to this nametag by signing the
 * server's nonce with the wallet's chain key. After this returns, every
 * REST and WS request is gated by the resulting session token.
 *
 * Cached in sessionStorage so a page navigation within the same tab
 * doesn't require a fresh wallet prompt. Cleared on disconnect.
 */
async function ensureAuthSession(): Promise<string | null> {
  if (!client || !state.identity?.nametag) return null;
  const nametag = state.identity.nametag.replace(/^@/, '').toLowerCase();
  // Cached session valid for this nametag — reuse.
  if (authSessionId && authedNametag === nametag) return authSessionId;
  const cached = sessionStorage.getItem(AUTH_SESSION_KEY);
  if (cached) {
    try {
      const { sessionId, nametag: t, expiresAt } = JSON.parse(cached);
      if (t === nametag && typeof expiresAt === 'number' && expiresAt > Date.now()) {
        authSessionId = sessionId;
        authedNametag = nametag;
        return sessionId;
      }
    } catch { /* fall through to fresh handshake */ }
  }

  try {
    // Step 1: ask server for a 32-byte nonce bound to this nametag.
    const challengeRes = await fetch('/api/auth/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nametag }),
    });
    if (!challengeRes.ok) return null;
    const { challengeId, nonce } = await challengeRes.json();

    // Step 2: have the wallet sign the nonce. The Sphere SDK's
    // SIGN_MESSAGE intent invokes the wallet's chain-key signer; the
    // server then verifies against the chainPubkey published with the
    // nametag.
    const signature = await client.intent(INTENT_ACTIONS.SIGN_MESSAGE, {
      message: nonce,
    } as any);

    // Step 3: post the signature back; on success, mint a session.
    const verifyRes = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId, signature }),
    });
    if (!verifyRes.ok) return null;
    const { sessionId, expiresAt } = await verifyRes.json();
    authSessionId = sessionId;
    authedNametag = nametag;
    sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({
      sessionId, nametag, expiresAt,
    }));
    return sessionId;
  } catch (err) {
    console.error('[auth] handshake failed:', err);
    return null;
  }
}

async function refreshBalance(): Promise<void> {
  if (!client) return;
  try {
    // getBalance returns Asset[] with { coinId (hex), symbol, totalAmount (smallest units), decimals }
    const assets = await client.query<any[]>('sphere_getBalance');
    if (Array.isArray(assets)) {
      const uct = assets.find((a: any) => a.symbol === COIN_ID);
      if (uct) {
        uctCoinId = uct.coinId;
        uctDecimals = uct.decimals || UCT_DECIMALS;
        state.balance = Number(uct.totalAmount) / Math.pow(10, uctDecimals);
      } else {
        uctCoinId = UCT_COIN_ID_HEX;
        uctDecimals = UCT_DECIMALS;
        state.balance = 0;
      }
    }
  } catch (err) {
    console.error('Failed to fetch balance:', err);
    state.balance = null;
  }
}

async function deposit(amount?: number): Promise<boolean> {
  const sendAmount = amount ?? ENTRY_FEE;

  if (!client || !state.isConnected) {
    state.error = 'Not connected';
    return false;
  }

  if (!state.identity?.nametag) {
    state.error = 'Unicity ID required to play. Please register one in Sphere.';
    updateUI('connected');
    return false;
  }

  // Refresh balance before pre-flight check — stale cache from connect
  // time can read 0 even when UCT has since arrived in the wallet.
  await refreshBalance();

  if (state.balance !== null && state.balance < sendAmount) {
    state.error = `Insufficient balance. You need at least ${sendAmount} ${COIN_ID}.`;
    updateUI('connected');
    return false;
  }

  try {
    updateUI('depositing');
    if (!uctCoinId) {
      uctCoinId = UCT_COIN_ID_HEX;
      uctDecimals = UCT_DECIMALS;
    }
    await client.intent(INTENT_ACTIONS.SEND, {
      to: gameWalletAddress(),
      amount: sendAmount,
      coinId: uctCoinId,
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
      if (state.identity?.nametag) {
        if (depositBtn) {
          depositBtn.style.display = 'block';
          depositBtn.textContent = 'Play (' + ENTRY_FEE + ' ' + COIN_ID + ')';
          depositBtn.disabled = false;
        }
        if (variableContent) {
          variableContent.style.visibility = 'visible';
          variableContent.innerHTML = 'Deposit ' + ENTRY_FEE + ' ' + COIN_ID + ' to start playing';
        }
      } else {
        if (variableContent) {
          variableContent.style.visibility = 'visible';
          variableContent.innerHTML = 'Unicity ID required to play';
        }
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
  depositBtn?.addEventListener('click', () => depositAndRestart());
  disconnectBtn?.addEventListener('click', () => disconnect());

  // Restore deposit state immediately so the game doesn't block on async reconnect
  if (sessionStorage.getItem(DEPOSIT_KEY)) {
    state.isDepositPaid = true;
  }

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
  /** Server-side session token. Null until ensureAuthSession resolves. */
  get authSession() { return authSessionId; },
  connect,
  disconnect,
  deposit,
  depositAndRestart,
  requestPayout,
  refreshBalance,
  updateUI,
  /**
   * Force-refresh the auth session (usually unnecessary — `connect()`
   * does this automatically). Useful if the server says the session
   * has expired and the page wants to re-handshake without forcing a
   * full reload.
   */
  ensureAuthSession,
  resetDeposit() {
    state.isDepositPaid = false;
  },
};
