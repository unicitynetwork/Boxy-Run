import {
  ConnectClient,
  ERROR_CODES,
  HOST_READY_TYPE,
  HOST_READY_TIMEOUT,
  INTENT_ACTIONS,
  PERMISSION_SCOPES,
  SPHERE_NETWORKS,
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
// TESTNET2 UCT, from the network's own registry (unicity-ids.testnet2.json).
// The id carried here before — 455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89
// — is the v1 testnet coin and is absent from the testnet2 registry entirely.
// This fallback is more reachable than it looks: it fires whenever the wallet
// reports no UCT asset, which is exactly the state of every wallet after the
// 2026-08-29 reset, so a wrong value here sends a coinId nobody holds.
const UCT_COIN_ID_HEX = 'f581d30f593e4b369d684a4563b5246f07b1d265f7178a2c0a82b81f39c24dc0';
const UCT_DECIMALS = 18;
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
  /**
   * Set when a deposit answered INTENT_OUTCOME_UNKNOWN (4201): the wallet had
   * the intent and the outcome is unknown. Nothing may re-issue that payment.
   *
   * Deliberately IN-MEMORY, so a reload clears it — that is the design, not an
   * oversight. Nothing in this page can learn whether the payment landed, so
   * the reconciliation has to be a human one: reload, read the real balance and
   * the game ledger (which the arena watcher credits from the chain), then
   * decide. Persisting it to sessionStorage would block the retry the player is
   * entitled to after checking, with nothing able to clear the flag. What the
   * guard must prevent is the reflexive same-session re-click, and it does.
   */
  outcomeUnknown: boolean;
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
  outcomeUnknown: false,
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

    // Connect via the resolved transport.
    //
    // The wallet host runs TWO handshake gates, both of which this client must
    // satisfy (connect/compatibility.ts in the SDK):
    //
    //  1. Network (INCOMPATIBLE_NETWORK, 4008) — the dApp must declare a
    //     `network` whose id equals the wallet's active networkId. Omitting it
    //     is itself a rejection. testnet2 (networkId 4) is the network the
    //     deployed wallet and the arena wallet both run on.
    //  2. npm-SDK floor (UNSUPPORTED_PROTOCOL_VERSION, 4007) — the host
    //     enforces `minSdkVersion`, defaulting to DEFAULT_MIN_CLIENT_SDK_VERSION
    //     = '0.14.1-0' (the P11 flip: the v1 payments era is gone). The
    //     ConnectClient reports its own package version, so a dApp bundled
    //     against sphere-sdk < 0.14.1 is refused at the handshake no matter
    //     what it sends. That is the hard reason this app tracks 0.15.x.
    client = new ConnectClient({
      transport, dapp: dappMeta, permissions: [...dappPermissions], resumeSessionId,
      network: SPHERE_NETWORKS.testnet2,
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
  state.outcomeUnknown = false;
  updateUI('disconnected');
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

/**
 * Convert a whole-token amount (what the UI and the game ledger speak) into
 * BASE UNITS (the smallest indivisible unit) as a decimal integer string.
 *
 * WHY THIS EXISTS — money-critical. The Connect `send` intent changed its
 * `amount` contract: it used to carry a whole-token decimal, and now carries
 * base units, validated by the wallet as /^\d+$/ and > 0. Both forms PASS that
 * validation, so the old whole-token value is not rejected — it is silently
 * reinterpreted. Sending `10` for a UCT entry fee would move 10 * 10^-18 UCT
 * (dust) instead of 10 UCT: the player is debited nothing, and the arena
 * watcher credits nothing (its integer divide by 10^18 floors to 0), with no
 * error surfaced anywhere. Always convert here, at the dApp's UI edge.
 *
 * Done with BigInt, not Math.pow — 10 * 10**18 exceeds Number.MAX_SAFE_INTEGER
 * and would serialise in exponential notation, failing the wallet's regex.
 */
function toBaseUnits(wholeTokens: number, decimals: number): string {
  if (!Number.isFinite(wholeTokens) || wholeTokens <= 0) {
    throw new Error(`Invalid amount: ${wholeTokens}`);
  }
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }
  const scale = 10n ** BigInt(decimals);
  if (Number.isInteger(wholeTokens)) {
    return (BigInt(wholeTokens) * scale).toString();
  }
  // Fractional input: go through a fixed-point string so we never round-trip
  // through a float that cannot represent the value exactly.
  const [intPart, fracPart = ''] = wholeTokens.toFixed(decimals).split('.');
  const frac = (fracPart + '0'.repeat(decimals)).slice(0, decimals);
  const units = BigInt(intPart) * scale + BigInt(frac || '0');
  if (units <= 0n) throw new Error(`Amount ${wholeTokens} is below one base unit`);
  return units.toString();
}

async function deposit(amount?: number): Promise<boolean> {
  const sendAmount = amount ?? ENTRY_FEE;

  // A previous deposit's outcome is unknown; re-issuing it is the double-spend
  // this guard exists to prevent. Only a reload (after the player has checked
  // their balance) clears it.
  if (state.outcomeUnknown) {
    state.error =
      'A previous payment\'s outcome is still unknown. Reload the page and check ' +
      'your balance before paying again.';
    updateUI('connected');
    return false;
  }

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
    // Never scale by a zero/absent decimals — that would send whole-token
    // digits as base units, i.e. dust, which the wallet happily accepts.
    if (!uctDecimals) uctDecimals = UCT_DECIMALS;
    // `amount` is in BASE UNITS — see toBaseUnits() for why this conversion is
    // not optional. `coinId` must be lowercase even-length hex; the wallet
    // rejects a short symbol like 'UCT' with INVALID_PARAMS.
    await client.intent(INTENT_ACTIONS.SEND, {
      to: gameWalletAddress(),
      amount: toBaseUnits(sendAmount, uctDecimals),
      coinId: uctCoinId,
      memo: 'Boxy Run entry fee',
    });

    state.isDepositPaid = true;
    state.error = null;
    await refreshBalance();
    updateUI('ready');
    return true;
  } catch (err) {
    // INTENT_OUTCOME_UNKNOWN (4201): the wallet HAD the intent and the answer
    // was lost — a host deadline fired, or the wallet locked mid-flight. The
    // money may or may not have moved. Treating it like an ordinary failure is
    // how a player pays twice: the old code re-enabled "Play" on every throw,
    // and the natural next click re-issues the same transfer. There is no
    // retry that is safe here, so refuse to offer one and let the arena
    // watcher's on-chain credit settle it — that ledger is the source of truth
    // and its tx_id is UNIQUE, so a deposit that DID land still credits.
    const code = (err as { code?: unknown })?.code;
    if (code === ERROR_CODES.INTENT_OUTCOME_UNKNOWN) {
      state.outcomeUnknown = true;
      state.error =
        'Payment sent, but the wallet could not confirm the outcome. Do NOT pay again — ' +
        'if it went through, your balance updates on its own within a minute.';
      state.isDepositPaid = false;
      updateUI('connected');
      return false;
    }
    if (code === ERROR_CODES.WALLET_LOCKED) {
      state.error = 'Wallet is locked. Unlock it in Sphere, then try again.';
      state.isDepositPaid = false;
      updateUI('connected');
      return false;
    }
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
  get outcomeUnknown() { return state.outcomeUnknown; },
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
