"use strict";
var SphereConnect = (() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // node_modules/@unicitylabs/sphere-sdk/dist/connect/index.js
  var LOGGER_KEY = "__sphere_sdk_logger__";
  function getState() {
    const g = globalThis;
    if (!g[LOGGER_KEY]) {
      g[LOGGER_KEY] = { debug: false, tags: {}, handler: null };
    }
    return g[LOGGER_KEY];
  }
  function isEnabled(tag) {
    const state2 = getState();
    if (tag in state2.tags) return state2.tags[tag];
    return state2.debug;
  }
  var logger = {
    /**
     * Configure the logger. Can be called multiple times (last write wins).
     * Typically called by createBrowserProviders(), createNodeProviders(), or Sphere.init().
     */
    configure(config) {
      const state2 = getState();
      if (config.debug !== void 0) state2.debug = config.debug;
      if (config.handler !== void 0) state2.handler = config.handler;
    },
    /**
     * Enable/disable debug logging for a specific tag.
     * Per-tag setting overrides the global debug flag.
     *
     * @example
     * ```ts
     * logger.setTagDebug('Nostr', true);  // enable only Nostr logs
     * logger.setTagDebug('Nostr', false); // disable Nostr logs even if global debug=true
     * ```
     */
    setTagDebug(tag, enabled) {
      getState().tags[tag] = enabled;
    },
    /**
     * Clear per-tag override, falling back to global debug flag.
     */
    clearTagDebug(tag) {
      delete getState().tags[tag];
    },
    /** Returns true if debug mode is enabled for the given tag (or globally). */
    isDebugEnabled(tag) {
      if (tag) return isEnabled(tag);
      return getState().debug;
    },
    /**
     * Debug-level log. Only shown when debug is enabled (globally or for this tag).
     * Use for detailed operational information.
     */
    debug(tag, message, ...args) {
      if (!isEnabled(tag)) return;
      const state2 = getState();
      if (state2.handler) {
        state2.handler("debug", tag, message, ...args);
      } else {
        console.log(`[${tag}]`, message, ...args);
      }
    },
    /**
     * Warning-level log. ALWAYS shown regardless of debug flag.
     * Use for important but non-critical issues (timeouts, retries, degraded state).
     */
    warn(tag, message, ...args) {
      const state2 = getState();
      if (state2.handler) {
        state2.handler("warn", tag, message, ...args);
      } else {
        console.warn(`[${tag}]`, message, ...args);
      }
    },
    /**
     * Error-level log. ALWAYS shown regardless of debug flag.
     * Use for critical failures that should never be silenced.
     */
    error(tag, message, ...args) {
      const state2 = getState();
      if (state2.handler) {
        state2.handler("error", tag, message, ...args);
      } else {
        console.error(`[${tag}]`, message, ...args);
      }
    },
    /** Reset all logger state (debug flag, tags, handler). Primarily for tests. */
    reset() {
      const g = globalThis;
      delete g[LOGGER_KEY];
    }
  };
  var STORAGE_KEYS_ADDRESS = {
    /** Transfer outbox for this address (pre-flip key name; kept as the network-scoping witness) */
    OUTBOX: "outbox",
    /** Conversations for this address */
    CONVERSATIONS: "conversations",
    /** Messages for this address */
    MESSAGES: "messages",
    /** Group chat: joined groups for this address */
    GROUP_CHAT_GROUPS: "group_chat_groups",
    /** Group chat: messages for this address */
    GROUP_CHAT_MESSAGES: "group_chat_messages",
    /** Group chat: members for this address */
    GROUP_CHAT_MEMBERS: "group_chat_members",
    /** Group chat: processed event IDs for deduplication */
    GROUP_CHAT_PROCESSED_EVENTS: "group_chat_processed_events",
    /** Auto-return settings (pre-flip key name; kept as the network-scoping witness) */
    AUTO_RETURN: "auto_return",
    /** Auto-return dedup ledger (pre-flip key name; kept as the network-scoping witness) */
    AUTO_RETURN_LEDGER: "auto_return_ledger",
    /** Per-swap key prefix (pre-flip key name; kept as the network-scoping witness) */
    SWAP_RECORD_PREFIX: "swap:"
  };
  var NETWORK_SCOPED_ADDRESS_KEYS = [
    STORAGE_KEYS_ADDRESS.OUTBOX,
    STORAGE_KEYS_ADDRESS.AUTO_RETURN,
    STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER
  ];
  var NETWORK_SCOPED_ADDRESS_PREFIXES = [
    STORAGE_KEYS_ADDRESS.SWAP_RECORD_PREFIX,
    // 'swap:'
    "inv_ledger:"
    // AccountingModule INV_LEDGER_PREFIX
  ];
  var DEFAULT_NOSTR_RELAYS = [
    "wss://relay.unicity.network",
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.nostr.band"
  ];
  var DEFAULT_AGGREGATOR_URL = "https://aggregator.unicity.network/rpc";
  var DEV_AGGREGATOR_URL = "https://dev-aggregator.dyndns.org/rpc";
  var DEFAULT_BASE_PATH = "m/44'/0'/0'";
  var DEFAULT_DERIVATION_PATH = `${DEFAULT_BASE_PATH}/0/0`;
  var TOKEN_REGISTRY_URL = "https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/unicity-ids.testnet.json";
  var TEST_NOSTR_RELAYS = [
    "wss://nostr-relay.testnet.unicity.network"
  ];
  var DEFAULT_GROUP_RELAYS = [
    "wss://sphere-relay.unicity.network"
  ];
  var NETWORKS = {
    mainnet: {
      name: "Mainnet",
      aggregatorUrl: DEFAULT_AGGREGATOR_URL,
      nostrRelays: DEFAULT_NOSTR_RELAYS,
      groupRelays: DEFAULT_GROUP_RELAYS,
      tokenRegistryUrl: TOKEN_REGISTRY_URL
    },
    // v1 cutover: 'testnet' now POINTS AT TESTNET2 (the v2 gateway network). The
    // old goggregator testnet spoke the removed v1 protocol — a v2 engine cannot
    // run against it. 'testnet2' stays as an alias of the same configuration.
    testnet: {
      name: "Testnet2",
      networkId: 4,
      // v2 state-transition gateway (networkId 4 comes from the trust base). apiKey is env-injected.
      aggregatorUrl: "https://gateway.testnet2.unicity.network",
      nostrRelays: TEST_NOSTR_RELAYS,
      // reuse testnet infra (shared relays/ipfs)
      groupRelays: DEFAULT_GROUP_RELAYS,
      tokenRegistryUrl: "https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/unicity-ids.testnet2.json"
    },
    testnet2: {
      name: "Testnet2",
      networkId: 4,
      // v2 state-transition gateway (networkId 4 comes from the trust base). apiKey is env-injected.
      aggregatorUrl: "https://gateway.testnet2.unicity.network",
      nostrRelays: TEST_NOSTR_RELAYS,
      // reuse testnet infra (shared relays/ipfs)
      groupRelays: DEFAULT_GROUP_RELAYS,
      tokenRegistryUrl: "https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/unicity-ids.testnet2.json"
    },
    // NOTE: mainnet/dev still point at v1-era aggregators. The v2 engine cannot
    // operate against them until their gateways are cut over to the v2 protocol —
    // wallet operations on these networks fail loudly (AGGREGATOR_ERROR) until then.
    dev: {
      name: "Development",
      aggregatorUrl: DEV_AGGREGATOR_URL,
      nostrRelays: TEST_NOSTR_RELAYS,
      groupRelays: DEFAULT_GROUP_RELAYS,
      tokenRegistryUrl: TOKEN_REGISTRY_URL
    }
  };
  var SPHERE_NETWORKS = {
    testnet2: { id: NETWORKS.testnet2.networkId, name: "testnet2" }
  };
  var HOST_READY_TYPE = "sphere-connect:host-ready";
  var HOST_READY_TIMEOUT = 3e4;
  var SPHERE_CONNECT_NAMESPACE = "sphere-connect";
  var SPHERE_CONNECT_VERSION = "2.1";
  var RPC_METHODS = {
    GET_IDENTITY: "sphere_getIdentity",
    GET_BALANCE: "sphere_getBalance",
    GET_ASSETS: "sphere_getAssets",
    GET_FIAT_BALANCE: "sphere_getFiatBalance",
    GET_TOKENS: "sphere_getTokens",
    GET_HISTORY: "sphere_getHistory",
    RESOLVE: "sphere_resolve",
    SUBSCRIBE: "sphere_subscribe",
    UNSUBSCRIBE: "sphere_unsubscribe",
    DISCONNECT: "sphere_disconnect",
    GET_CONVERSATIONS: "sphere_getConversations",
    GET_MESSAGES: "sphere_getMessages",
    GET_DM_UNREAD_COUNT: "sphere_getDMUnreadCount",
    MARK_AS_READ: "sphere_markAsRead"
  };
  var INTENT_ACTIONS = {
    SEND: "send",
    DM: "dm",
    PAYMENT_REQUEST: "payment_request",
    RECEIVE: "receive",
    SIGN_MESSAGE: "sign_message",
    MINT: "mint"
  };
  var ERROR_CODES = {
    // Standard JSON-RPC
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
    // Sphere Connect (4xxx)
    NOT_CONNECTED: 4001,
    PERMISSION_DENIED: 4002,
    USER_REJECTED: 4003,
    SESSION_EXPIRED: 4004,
    ORIGIN_BLOCKED: 4005,
    RATE_LIMITED: 4006,
    UNSUPPORTED_PROTOCOL_VERSION: 4007,
    // Connect MAJOR mismatch (incompatible era)
    INCOMPATIBLE_NETWORK: 4008,
    // dApp targets a different network than the wallet
    // Wallet locked; THE SESSION IS STILL ALIVE. A QUERY may be retried after wallet:unlocked.
    // An INTENT already delegated to the wallet is NEVER answered with this code — it gets
    // INTENT_OUTCOME_UNKNOWN (4201) instead, because a retry could double-spend.
    WALLET_LOCKED: 4009,
    INSUFFICIENT_BALANCE: 4100,
    INVALID_RECIPIENT: 4101,
    TRANSFER_FAILED: 4102,
    INTENT_CANCELLED: 4200,
    /**
     * The intent was DELEGATED to the wallet and the host lost track of the answer — a host
     * deadline fired, or the wallet locked / logged out mid-flight. **The outcome is UNKNOWN:
     * the money may or may not have moved.**
     *
     * A dApp MUST NOT retry on this code. Reconcile out of band (poll the recipient, the
     * aggregator, or your own backend) and only then decide.
     *
     * This code exists because every other answer would be a lie. `INTENT_CANCELLED` (4200)
     * asserts the user declined and nothing happened; `WALLET_LOCKED` (4009) invites a retry
     * after the unlock. Sending either for an intent the wallet had already submitted is how a
     * paid-but-not-credited order — and then a double spend on retry — happens.
     */
    INTENT_OUTCOME_UNKNOWN: 4201
  };
  var WALLET_EVENTS = {
    /** Wallet is LOCKED — the session is STILL ALIVE. Requests are answered
     *  WALLET_LOCKED (4009) until `wallet:unlocked`. The dApp must NOT disconnect,
     *  must NOT clear its sessionId, and must NOT re-handshake.
     *  Payload: {@link WalletLockedPayload}. Pushed by ConnectHost.setLocked() and
     *  immediately after a handshake response carrying `locked: true`. */
    LOCKED: "wallet:locked",
    /** Wallet was unlocked — the SAME session continues: no re-handshake, no re-approval,
     *  no re-subscribe (the host re-arms the dApp's subscriptions before pushing this).
     *  Payload: {@link WalletUnlockedPayload} — carries the CURRENT identity, which may
     *  differ from the one the dApp connected with. Pushed by ConnectHost.updateSphere()
     *  on the locked -> live edge only. */
    UNLOCKED: "wallet:unlocked",
    /** The session is GONE (logout, wallet deleted, dApp sphere_disconnect, expiry seen at
     *  unlock, a different seed behind the lock screen, host destroy).
     *  The dApp must clear its session and re-handshake to continue. Unlocking does not cure it.
     *  Payload: {@link WalletDisconnectedPayload}. Pushed by ConnectHost.revokeSession(). */
    DISCONNECTED: "wallet:disconnected",
    /** Active wallet address changed. dApp should update displayed identity.
     *  Pushed automatically by ConnectHost — no sphere_subscribe needed. */
    IDENTITY_CHANGED: "identity:changed"
  };
  var AUTO_PUSHED_EVENTS = [
    WALLET_EVENTS.LOCKED,
    WALLET_EVENTS.UNLOCKED,
    WALLET_EVENTS.DISCONNECTED,
    WALLET_EVENTS.IDENTITY_CHANGED
  ];
  function isAutoPushedEvent(event) {
    return AUTO_PUSHED_EVENTS.includes(event);
  }
  function createRequestId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
  var SDK_VERSION = "0.15.0";
  var PERMISSION_SCOPES = {
    IDENTITY_READ: "identity:read",
    BALANCE_READ: "balance:read",
    TOKENS_READ: "tokens:read",
    HISTORY_READ: "history:read",
    EVENTS_SUBSCRIBE: "events:subscribe",
    RESOLVE_PEER: "resolve:peer",
    TRANSFER_REQUEST: "transfer:request",
    DM_REQUEST: "dm:request",
    DM_READ: "dm:read",
    DM_MANAGE: "dm:manage",
    PAYMENT_REQUEST: "payment:request",
    SIGN_REQUEST: "sign:request",
    MINT_REQUEST: "mint:request"
  };
  var ALL_PERMISSIONS = Object.values(PERMISSION_SCOPES);
  var DEFAULT_PERMISSIONS = [
    PERMISSION_SCOPES.IDENTITY_READ
  ];
  var METHOD_PERMISSIONS = {
    [RPC_METHODS.GET_IDENTITY]: PERMISSION_SCOPES.IDENTITY_READ,
    [RPC_METHODS.GET_BALANCE]: PERMISSION_SCOPES.BALANCE_READ,
    [RPC_METHODS.GET_ASSETS]: PERMISSION_SCOPES.BALANCE_READ,
    [RPC_METHODS.GET_FIAT_BALANCE]: PERMISSION_SCOPES.BALANCE_READ,
    [RPC_METHODS.GET_TOKENS]: PERMISSION_SCOPES.TOKENS_READ,
    [RPC_METHODS.GET_HISTORY]: PERMISSION_SCOPES.HISTORY_READ,
    [RPC_METHODS.RESOLVE]: PERMISSION_SCOPES.RESOLVE_PEER,
    [RPC_METHODS.SUBSCRIBE]: PERMISSION_SCOPES.EVENTS_SUBSCRIBE,
    [RPC_METHODS.UNSUBSCRIBE]: PERMISSION_SCOPES.EVENTS_SUBSCRIBE,
    [RPC_METHODS.GET_CONVERSATIONS]: PERMISSION_SCOPES.DM_READ,
    [RPC_METHODS.GET_MESSAGES]: PERMISSION_SCOPES.DM_READ,
    [RPC_METHODS.GET_DM_UNREAD_COUNT]: PERMISSION_SCOPES.DM_READ,
    [RPC_METHODS.MARK_AS_READ]: PERMISSION_SCOPES.DM_MANAGE
  };
  var INTENT_PERMISSIONS = {
    [INTENT_ACTIONS.SEND]: PERMISSION_SCOPES.TRANSFER_REQUEST,
    [INTENT_ACTIONS.DM]: PERMISSION_SCOPES.DM_REQUEST,
    [INTENT_ACTIONS.PAYMENT_REQUEST]: PERMISSION_SCOPES.PAYMENT_REQUEST,
    [INTENT_ACTIONS.RECEIVE]: PERMISSION_SCOPES.IDENTITY_READ,
    [INTENT_ACTIONS.SIGN_MESSAGE]: PERMISSION_SCOPES.SIGN_REQUEST,
    [INTENT_ACTIONS.MINT]: PERMISSION_SCOPES.MINT_REQUEST
  };
  var SETTLED_STATUSES = /* @__PURE__ */ new Set([
    "confirmed",
    "delivered",
    "completed"
  ]);
  var REALTIME_STATUS = {
    connected: "connected",
    degraded: "reconnecting",
    offline: "closed"
  };
  function toLegacyRequest(view, status) {
    return { ...view, symbol: view.symbol ?? "", status };
  }
  function paymentsOrNull(sphere) {
    try {
      return sphere.payments;
    } catch {
      return null;
    }
  }
  function legacyRequestPayload(sphere, update) {
    const view = paymentsOrNull(sphere)?.requests.list().find((request) => request.id === update.id);
    if (!view) {
      return {
        id: update.id,
        requestId: update.id,
        senderPubkey: "",
        amount: "",
        coinId: "",
        symbol: "",
        timestamp: Date.now(),
        status: update.status
      };
    }
    return toLegacyRequest(view, update.status);
  }
  function requestStatusAttacher(status) {
    return (sphere, forward) => sphere.on("payment_request:updated", (update) => {
      if (update.status === status) forward(legacyRequestPayload(sphere, update));
    });
  }
  function attentionAttacher(code, toLegacy) {
    return (sphere, forward) => sphere.on("transfer:attention", (attention) => {
      if (attention.code === code) forward(toLegacy(attention));
    });
  }
  function remoteUpdateAttacher(sphere, forward) {
    let sequence = 0;
    return sphere.on("inventory:updated", () => {
      sequence += 1;
      forward({ providerId: "wallet-api", name: "wallet-api", sequence, cid: "", added: 0, removed: 0 });
    });
  }
  var COMPAT_ATTACHERS = /* @__PURE__ */ new Map([
    // Old completion split, held: deliveryPending ? delivery_pending : confirmed, plus the
    // failed arm (manifest judgment call #1). Payloads are the TransferResult, unchanged.
    ["transfer:confirmed", (sphere, forward) => sphere.on("transfer:updated", (result) => {
      if (SETTLED_STATUSES.has(result.status) && result.deliveryPending !== true) forward(result);
    })],
    ["transfer:delivery_pending", (sphere, forward) => sphere.on("transfer:updated", (result) => {
      if (result.status !== "failed" && result.deliveryPending === true) forward(result);
    })],
    ["transfer:failed", (sphere, forward) => sphere.on("transfer:updated", (result) => {
      if (result.status === "failed") forward(result);
    })],
    // Same name on both wires, different payload: the raw v2 view has optional `symbol`;
    // legacy subscribers get the IncomingPaymentRequest shape via the shared mapping.
    ["payment_request:incoming", (sphere, forward) => sphere.on("payment_request:incoming", (view) => {
      forward(toLegacyRequest(view, view.status));
    })],
    ["payment_request:paid", requestStatusAttacher("paid")],
    ["payment_request:rejected", requestStatusAttacher("rejected")],
    ["payment_request:expired", requestStatusAttacher("expired")],
    // detail carries the old inner code (SPLIT_CHECKPOINT_LOST / CHECKPOINT_TRUSTBASE_MISMATCH).
    ["split:checkpoint-stuck", attentionAttacher("split:checkpoint-stuck", (attention) => ({
      transferId: attention.transferId,
      code: attention.detail ?? "",
      error: attention.detail ?? ""
    }))],
    ["delivery:undeliverable", attentionAttacher("delivery:undeliverable", (attention) => ({
      transferId: attention.transferId,
      recipientPubkey: "",
      attempts: 0,
      error: attention.detail ?? ""
    }))],
    ["delivery:deferred", attentionAttacher("delivery:deferred", (attention) => ({
      transferId: attention.transferId,
      recipientPubkey: "",
      reason: attention.detail ?? attention.code,
      deferredUntil: 0
    }))],
    ["realtime:status", (sphere, forward) => sphere.on("connection:status", (connection) => {
      forward({ status: REALTIME_STATUS[connection.status] ?? "closed" });
    })],
    // The server IS storage on the v2 vertical — a degraded connection is degraded storage.
    ["storage:degraded", (sphere, forward) => sphere.on("connection:status", (connection) => {
      if (connection.status !== "degraded") return;
      forward({ providerId: "wallet-api", error: "wallet-api connection degraded" });
    })],
    ["sync:completed", (sphere, forward) => sphere.on("inventory:updated", () => {
      forward({ source: "payments", count: paymentsOrNull(sphere)?.tokens().length ?? 0 });
    })],
    ["sync:remote-update", remoteUpdateAttacher]
  ]);
  var WALLET_LOCKED_MESSAGE = "Wallet is locked";
  var NOT_CONNECTED_MESSAGE = "Not connected";
  var LOCKED_ALLOWLIST = /* @__PURE__ */ new Set([
    RPC_METHODS.GET_IDENTITY,
    RPC_METHODS.SUBSCRIBE,
    RPC_METHODS.UNSUBSCRIBE,
    RPC_METHODS.DISCONNECT
  ]);
  var REFUSE_NOT_CONNECTED = {
    kind: "refuse",
    error: { code: ERROR_CODES.NOT_CONNECTED, message: NOT_CONNECTED_MESSAGE }
  };
  var REFUSE_LOCKED = {
    kind: "refuse",
    error: {
      code: ERROR_CODES.WALLET_LOCKED,
      message: WALLET_LOCKED_MESSAGE,
      data: { reason: "locked" }
    }
  };
  var EMPTY_WALLET_SNAPSHOT = Object.freeze({ capturedAt: 0 });
  var CHANNEL_ONLY_CODES = /* @__PURE__ */ new Set([
    ERROR_CODES.WALLET_LOCKED,
    ERROR_CODES.NOT_CONNECTED
  ]);
  var ConnectError = class extends Error {
    constructor(message, code, data) {
      super(message);
      this.code = code;
      this.data = data;
      this.name = "ConnectError";
    }
  };
  var DEFAULT_TIMEOUT = 3e4;
  var DEFAULT_INTENT_TIMEOUT = 12e4;
  var ConnectClient = class {
    constructor(config) {
      __publicField(this, "transport");
      __publicField(this, "dapp");
      __publicField(this, "requestedPermissions");
      __publicField(this, "timeout");
      __publicField(this, "intentTimeout");
      __publicField(this, "resumeSessionId");
      __publicField(this, "silent");
      __publicField(this, "network");
      __publicField(this, "sessionId", null);
      __publicField(this, "grantedPermissions", []);
      __publicField(this, "identity", null);
      __publicField(this, "walletNet", null);
      __publicField(this, "walletProto", null);
      __publicField(this, "locked", false);
      __publicField(this, "connected", false);
      __publicField(this, "pendingRequests", /* @__PURE__ */ new Map());
      __publicField(this, "eventHandlers", /* @__PURE__ */ new Map());
      __publicField(this, "unsubscribeTransport", null);
      // Handshake resolver (one-shot)
      __publicField(this, "handshakeResolver", null);
      this.transport = config.transport;
      this.dapp = config.dapp;
      this.requestedPermissions = config.permissions ?? [...ALL_PERMISSIONS];
      this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
      this.intentTimeout = config.intentTimeout ?? DEFAULT_INTENT_TIMEOUT;
      this.resumeSessionId = config.resumeSessionId ?? null;
      this.silent = config.silent ?? false;
      this.network = config.network;
    }
    // ===========================================================================
    // Connection
    // ===========================================================================
    /** Connect to the wallet. Returns session info and public identity. */
    async connect() {
      this.unsubscribeTransport = this.transport.onMessage(this.handleMessage.bind(this));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.handshakeResolver = null;
          reject(new Error("Connection timeout"));
        }, this.timeout);
        this.handshakeResolver = { resolve, reject, timer };
        this.transport.send({
          ns: SPHERE_CONNECT_NAMESPACE,
          v: SPHERE_CONNECT_VERSION,
          type: "handshake",
          direction: "request",
          permissions: this.requestedPermissions,
          dapp: this.dapp,
          sdkVersion: SDK_VERSION,
          ...this.network ? { network: this.network } : {},
          ...this.resumeSessionId ? { sessionId: this.resumeSessionId } : {},
          ...this.silent ? { silent: true } : {}
        });
      });
    }
    /** Disconnect from the wallet */
    async disconnect() {
      if (this.connected) {
        try {
          await this.query(RPC_METHODS.DISCONNECT);
        } catch {
        }
      }
      this.cleanup();
    }
    /** Whether currently connected */
    get isConnected() {
      return this.connected;
    }
    /** Granted permission scopes */
    get permissions() {
      return this.grantedPermissions;
    }
    /** Current session ID */
    get session() {
      return this.sessionId;
    }
    /** Public identity received during handshake */
    get walletIdentity() {
      return this.identity;
    }
    /** Wallet's active network, received during handshake. */
    get walletNetwork() {
      return this.walletNet;
    }
    /**
     * The wallet's Connect protocol version, captured from the handshake response `v`.
     * Null before the first handshake response and after a disconnect.
     *
     * Feature-detect with it: compare against '2.1' to decide whether the wallet can be
     * trusted to send wallet:unlocked / wallet:disconnected. A Connect 2.0 wallet destroys
     * the session on lock and never emits either, so a dApp waiting for them against one
     * waits forever.
     *
     * CAVEAT: on an ERROR response the host echoes the dApp's own `v` back
     * (ConnectHost.sendHandshakeResponse), so after a refused connection this may be the
     * dApp's version rather than the wallet's. Only trust it after a successful handshake.
     */
    get walletProtocol() {
      return this.walletProto;
    }
    /**
     * Whether the wallet was locked at the last handshake or lifecycle event.
     * A locked client is still CONNECTED: `isConnected` stays true and `session` stays valid.
     * Requests answer WALLET_LOCKED (4009) until `wallet:unlocked` arrives on the SAME
     * session — do not disconnect, do not clear the session, do not re-handshake.
     */
    get walletLocked() {
      return this.locked;
    }
    // ===========================================================================
    // Query (read data)
    // ===========================================================================
    /** Send a query request and return the result */
    async query(method, params) {
      if (!this.connected) throw new ConnectError("Not connected", ERROR_CODES.NOT_CONNECTED);
      const id = createRequestId();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`Query timeout: ${method}`));
        }, this.timeout);
        this.pendingRequests.set(id, {
          resolve,
          reject,
          timer,
          kind: "query"
        });
        this.transport.send({
          ns: SPHERE_CONNECT_NAMESPACE,
          v: SPHERE_CONNECT_VERSION,
          type: "request",
          id,
          method,
          params
        });
      });
    }
    // ===========================================================================
    // Intent (trigger wallet UI)
    // ===========================================================================
    /** Send an intent request. The wallet will open its UI for user confirmation. */
    async intent(action, params) {
      if (!this.connected) throw new ConnectError("Not connected", ERROR_CODES.NOT_CONNECTED);
      const id = createRequestId();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(
            new ConnectError(
              `Intent outcome unknown \u2014 do not retry; reconcile before acting: ${action}`,
              ERROR_CODES.INTENT_OUTCOME_UNKNOWN
            )
          );
        }, this.intentTimeout);
        this.pendingRequests.set(id, {
          resolve,
          reject,
          timer,
          kind: "intent"
        });
        this.transport.send({
          ns: SPHERE_CONNECT_NAMESPACE,
          v: SPHERE_CONNECT_VERSION,
          type: "intent",
          id,
          action,
          params
        });
      });
    }
    // ===========================================================================
    // Events
    // ===========================================================================
    /** Subscribe to a wallet event. Returns unsubscribe function. */
    on(event, handler) {
      if (!this.eventHandlers.has(event)) {
        this.eventHandlers.set(event, /* @__PURE__ */ new Set());
        if (this.connected && !isAutoPushedEvent(event)) {
          this.query(RPC_METHODS.SUBSCRIBE, { event }).catch((err) => logger.debug("Connect", "Event subscription failed", err));
        }
      }
      this.eventHandlers.get(event).add(handler);
      return () => {
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
          handlers.delete(handler);
          if (handlers.size === 0) {
            this.eventHandlers.delete(event);
            if (this.connected && !isAutoPushedEvent(event)) {
              this.query(RPC_METHODS.UNSUBSCRIBE, { event }).catch((err) => logger.debug("Connect", "Event unsubscription failed", err));
            }
          }
        }
      };
    }
    // ===========================================================================
    // Message Handling
    // ===========================================================================
    handleMessage(msg) {
      if (msg.type === "handshake" && msg.direction === "response") {
        this.handleHandshakeResponse(msg);
        return;
      }
      if (msg.type === "response") {
        this.handlePendingResponse(msg.id, msg.result, msg.error);
        return;
      }
      if (msg.type === "intent_result") {
        this.handlePendingResponse(msg.id, msg.result, msg.error);
        return;
      }
      if (msg.type === "event") {
        if (!this.connected || !this.sessionId) {
          logger.warn("Connect", `Ignoring wallet event before a session exists: ${msg.event}`);
          return;
        }
        if (msg.event === WALLET_EVENTS.LOCKED) {
          this.locked = true;
        } else if (msg.event === WALLET_EVENTS.UNLOCKED) {
          this.locked = false;
          const identity = msg.data?.identity;
          if (identity) this.identity = identity;
        } else if (msg.event === WALLET_EVENTS.DISCONNECTED) {
          this.connected = false;
        } else if (msg.event === WALLET_EVENTS.IDENTITY_CHANGED) {
          const data = msg.data;
          if (data && typeof data.chainPubkey === "string") this.identity = data;
        }
        this.dispatchEvent(msg.event, msg.data);
        if (msg.event === WALLET_EVENTS.DISCONNECTED) {
          this.cleanup();
        }
      }
    }
    dispatchEvent(event, data) {
      const handlers = this.eventHandlers.get(event);
      if (!handlers) return;
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (err) {
          logger.debug("Connect", "Event handler error", err);
        }
      }
    }
    handleHandshakeResponse(msg) {
      if (!this.handshakeResolver) return;
      clearTimeout(this.handshakeResolver.timer);
      const m = msg;
      this.walletProto = msg.v ?? null;
      if (m.error) {
        this.handshakeResolver.reject(new ConnectError(m.error.message, m.error.code, m.error.data));
        this.handshakeResolver = null;
        return;
      }
      if (msg.sessionId && msg.identity) {
        this.sessionId = msg.sessionId;
        this.grantedPermissions = msg.permissions;
        this.identity = msg.identity;
        this.walletNet = m.network ?? null;
        this.locked = m.locked === true;
        this.connected = true;
        if (m.warning) logger.warn("Connect", "Wallet deprecation notice", m.warning.message);
        this.handshakeResolver.resolve({
          sessionId: msg.sessionId,
          permissions: this.grantedPermissions,
          identity: msg.identity,
          // A resume DURING a lock succeeds: the dApp is connected on the same session and
          // must not re-handshake. It will get wallet:unlocked when the user unlocks.
          ...this.locked ? { locked: true } : {}
        });
      } else {
        this.handshakeResolver.reject(new Error("Connection rejected by wallet"));
      }
      this.handshakeResolver = null;
    }
    handlePendingResponse(id, result, error) {
      const pending = this.pendingRequests.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(id);
      if (error) {
        pending.reject(new ConnectError(error.message, error.code, error.data));
      } else {
        pending.resolve(result);
      }
    }
    // ===========================================================================
    // Cleanup
    // ===========================================================================
    cleanup() {
      if (this.unsubscribeTransport) {
        this.unsubscribeTransport();
        this.unsubscribeTransport = null;
      }
      if (this.handshakeResolver) {
        clearTimeout(this.handshakeResolver.timer);
        this.handshakeResolver.reject(new ConnectError("Disconnected", ERROR_CODES.NOT_CONNECTED));
        this.handshakeResolver = null;
      }
      for (const [, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(
          pending.kind === "intent" ? new ConnectError(
            "Intent outcome unknown \u2014 do not retry; reconcile before acting",
            ERROR_CODES.INTENT_OUTCOME_UNKNOWN
          ) : new ConnectError("Disconnected", ERROR_CODES.NOT_CONNECTED)
        );
      }
      this.pendingRequests.clear();
      this.eventHandlers.clear();
      this.connected = false;
      this.sessionId = null;
      this.grantedPermissions = [];
      this.identity = null;
      this.walletNet = null;
      this.walletProto = null;
      this.locked = false;
    }
  };

  // node_modules/@unicitylabs/sphere-sdk/dist/impl/browser/connect/index.js
  function majorOf(v) {
    return parseInt(String(v).split(".")[0], 10);
  }
  var STORAGE_KEYS_ADDRESS2 = {
    /** Transfer outbox for this address (pre-flip key name; kept as the network-scoping witness) */
    OUTBOX: "outbox",
    /** Conversations for this address */
    CONVERSATIONS: "conversations",
    /** Messages for this address */
    MESSAGES: "messages",
    /** Group chat: joined groups for this address */
    GROUP_CHAT_GROUPS: "group_chat_groups",
    /** Group chat: messages for this address */
    GROUP_CHAT_MESSAGES: "group_chat_messages",
    /** Group chat: members for this address */
    GROUP_CHAT_MEMBERS: "group_chat_members",
    /** Group chat: processed event IDs for deduplication */
    GROUP_CHAT_PROCESSED_EVENTS: "group_chat_processed_events",
    /** Auto-return settings (pre-flip key name; kept as the network-scoping witness) */
    AUTO_RETURN: "auto_return",
    /** Auto-return dedup ledger (pre-flip key name; kept as the network-scoping witness) */
    AUTO_RETURN_LEDGER: "auto_return_ledger",
    /** Per-swap key prefix (pre-flip key name; kept as the network-scoping witness) */
    SWAP_RECORD_PREFIX: "swap:"
  };
  var NETWORK_SCOPED_ADDRESS_KEYS2 = [
    STORAGE_KEYS_ADDRESS2.OUTBOX,
    STORAGE_KEYS_ADDRESS2.AUTO_RETURN,
    STORAGE_KEYS_ADDRESS2.AUTO_RETURN_LEDGER
  ];
  var NETWORK_SCOPED_ADDRESS_PREFIXES2 = [
    STORAGE_KEYS_ADDRESS2.SWAP_RECORD_PREFIX,
    // 'swap:'
    "inv_ledger:"
    // AccountingModule INV_LEDGER_PREFIX
  ];
  var DEFAULT_NOSTR_RELAYS2 = [
    "wss://relay.unicity.network",
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.nostr.band"
  ];
  var DEFAULT_AGGREGATOR_URL2 = "https://aggregator.unicity.network/rpc";
  var DEV_AGGREGATOR_URL2 = "https://dev-aggregator.dyndns.org/rpc";
  var DEFAULT_BASE_PATH2 = "m/44'/0'/0'";
  var DEFAULT_DERIVATION_PATH2 = `${DEFAULT_BASE_PATH2}/0/0`;
  var TOKEN_REGISTRY_URL2 = "https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/unicity-ids.testnet.json";
  var TEST_NOSTR_RELAYS2 = [
    "wss://nostr-relay.testnet.unicity.network"
  ];
  var DEFAULT_GROUP_RELAYS2 = [
    "wss://sphere-relay.unicity.network"
  ];
  var NETWORKS2 = {
    mainnet: {
      name: "Mainnet",
      aggregatorUrl: DEFAULT_AGGREGATOR_URL2,
      nostrRelays: DEFAULT_NOSTR_RELAYS2,
      groupRelays: DEFAULT_GROUP_RELAYS2,
      tokenRegistryUrl: TOKEN_REGISTRY_URL2
    },
    // v1 cutover: 'testnet' now POINTS AT TESTNET2 (the v2 gateway network). The
    // old goggregator testnet spoke the removed v1 protocol — a v2 engine cannot
    // run against it. 'testnet2' stays as an alias of the same configuration.
    testnet: {
      name: "Testnet2",
      networkId: 4,
      // v2 state-transition gateway (networkId 4 comes from the trust base). apiKey is env-injected.
      aggregatorUrl: "https://gateway.testnet2.unicity.network",
      nostrRelays: TEST_NOSTR_RELAYS2,
      // reuse testnet infra (shared relays/ipfs)
      groupRelays: DEFAULT_GROUP_RELAYS2,
      tokenRegistryUrl: "https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/unicity-ids.testnet2.json"
    },
    testnet2: {
      name: "Testnet2",
      networkId: 4,
      // v2 state-transition gateway (networkId 4 comes from the trust base). apiKey is env-injected.
      aggregatorUrl: "https://gateway.testnet2.unicity.network",
      nostrRelays: TEST_NOSTR_RELAYS2,
      // reuse testnet infra (shared relays/ipfs)
      groupRelays: DEFAULT_GROUP_RELAYS2,
      tokenRegistryUrl: "https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/unicity-ids.testnet2.json"
    },
    // NOTE: mainnet/dev still point at v1-era aggregators. The v2 engine cannot
    // operate against them until their gateways are cut over to the v2 protocol —
    // wallet operations on these networks fail loudly (AGGREGATOR_ERROR) until then.
    dev: {
      name: "Development",
      aggregatorUrl: DEV_AGGREGATOR_URL2,
      nostrRelays: TEST_NOSTR_RELAYS2,
      groupRelays: DEFAULT_GROUP_RELAYS2,
      tokenRegistryUrl: TOKEN_REGISTRY_URL2
    }
  };
  var SPHERE_NETWORKS2 = {
    testnet2: { id: NETWORKS2.testnet2.networkId, name: "testnet2" }
  };
  var SPHERE_CONNECT_NAMESPACE2 = "sphere-connect";
  var SPHERE_CONNECT_VERSION2 = "2.1";
  var RPC_METHODS2 = {
    GET_IDENTITY: "sphere_getIdentity",
    GET_BALANCE: "sphere_getBalance",
    GET_ASSETS: "sphere_getAssets",
    GET_FIAT_BALANCE: "sphere_getFiatBalance",
    GET_TOKENS: "sphere_getTokens",
    GET_HISTORY: "sphere_getHistory",
    RESOLVE: "sphere_resolve",
    SUBSCRIBE: "sphere_subscribe",
    UNSUBSCRIBE: "sphere_unsubscribe",
    DISCONNECT: "sphere_disconnect",
    GET_CONVERSATIONS: "sphere_getConversations",
    GET_MESSAGES: "sphere_getMessages",
    GET_DM_UNREAD_COUNT: "sphere_getDMUnreadCount",
    MARK_AS_READ: "sphere_markAsRead"
  };
  var INTENT_ACTIONS2 = {
    SEND: "send",
    DM: "dm",
    PAYMENT_REQUEST: "payment_request",
    RECEIVE: "receive",
    SIGN_MESSAGE: "sign_message",
    MINT: "mint"
  };
  var ERROR_CODES2 = {
    // Standard JSON-RPC
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
    // Sphere Connect (4xxx)
    NOT_CONNECTED: 4001,
    PERMISSION_DENIED: 4002,
    USER_REJECTED: 4003,
    SESSION_EXPIRED: 4004,
    ORIGIN_BLOCKED: 4005,
    RATE_LIMITED: 4006,
    UNSUPPORTED_PROTOCOL_VERSION: 4007,
    // Connect MAJOR mismatch (incompatible era)
    INCOMPATIBLE_NETWORK: 4008,
    // dApp targets a different network than the wallet
    // Wallet locked; THE SESSION IS STILL ALIVE. A QUERY may be retried after wallet:unlocked.
    // An INTENT already delegated to the wallet is NEVER answered with this code — it gets
    // INTENT_OUTCOME_UNKNOWN (4201) instead, because a retry could double-spend.
    WALLET_LOCKED: 4009,
    INSUFFICIENT_BALANCE: 4100,
    INVALID_RECIPIENT: 4101,
    TRANSFER_FAILED: 4102,
    INTENT_CANCELLED: 4200,
    /**
     * The intent was DELEGATED to the wallet and the host lost track of the answer — a host
     * deadline fired, or the wallet locked / logged out mid-flight. **The outcome is UNKNOWN:
     * the money may or may not have moved.**
     *
     * A dApp MUST NOT retry on this code. Reconcile out of band (poll the recipient, the
     * aggregator, or your own backend) and only then decide.
     *
     * This code exists because every other answer would be a lie. `INTENT_CANCELLED` (4200)
     * asserts the user declined and nothing happened; `WALLET_LOCKED` (4009) invites a retry
     * after the unlock. Sending either for an intent the wallet had already submitted is how a
     * paid-but-not-credited order — and then a double spend on retry — happens.
     */
    INTENT_OUTCOME_UNKNOWN: 4201
  };
  var WALLET_EVENTS2 = {
    /** Wallet is LOCKED — the session is STILL ALIVE. Requests are answered
     *  WALLET_LOCKED (4009) until `wallet:unlocked`. The dApp must NOT disconnect,
     *  must NOT clear its sessionId, and must NOT re-handshake.
     *  Payload: {@link WalletLockedPayload}. Pushed by ConnectHost.setLocked() and
     *  immediately after a handshake response carrying `locked: true`. */
    LOCKED: "wallet:locked",
    /** Wallet was unlocked — the SAME session continues: no re-handshake, no re-approval,
     *  no re-subscribe (the host re-arms the dApp's subscriptions before pushing this).
     *  Payload: {@link WalletUnlockedPayload} — carries the CURRENT identity, which may
     *  differ from the one the dApp connected with. Pushed by ConnectHost.updateSphere()
     *  on the locked -> live edge only. */
    UNLOCKED: "wallet:unlocked",
    /** The session is GONE (logout, wallet deleted, dApp sphere_disconnect, expiry seen at
     *  unlock, a different seed behind the lock screen, host destroy).
     *  The dApp must clear its session and re-handshake to continue. Unlocking does not cure it.
     *  Payload: {@link WalletDisconnectedPayload}. Pushed by ConnectHost.revokeSession(). */
    DISCONNECTED: "wallet:disconnected",
    /** Active wallet address changed. dApp should update displayed identity.
     *  Pushed automatically by ConnectHost — no sphere_subscribe needed. */
    IDENTITY_CHANGED: "identity:changed"
  };
  var AUTO_PUSHED_EVENTS2 = [
    WALLET_EVENTS2.LOCKED,
    WALLET_EVENTS2.UNLOCKED,
    WALLET_EVENTS2.DISCONNECTED,
    WALLET_EVENTS2.IDENTITY_CHANGED
  ];
  function isSphereConnectMessage(msg) {
    if (!msg || typeof msg !== "object") return false;
    const m = msg;
    if (m.ns !== SPHERE_CONNECT_NAMESPACE2) return false;
    if (m.type === "handshake") return true;
    if (typeof m.v !== "string") return false;
    return majorOf(m.v) === majorOf(SPHERE_CONNECT_VERSION2);
  }
  var PERMISSION_SCOPES2 = {
    IDENTITY_READ: "identity:read",
    BALANCE_READ: "balance:read",
    TOKENS_READ: "tokens:read",
    HISTORY_READ: "history:read",
    EVENTS_SUBSCRIBE: "events:subscribe",
    RESOLVE_PEER: "resolve:peer",
    TRANSFER_REQUEST: "transfer:request",
    DM_REQUEST: "dm:request",
    DM_READ: "dm:read",
    DM_MANAGE: "dm:manage",
    PAYMENT_REQUEST: "payment:request",
    SIGN_REQUEST: "sign:request",
    MINT_REQUEST: "mint:request"
  };
  var ALL_PERMISSIONS2 = Object.values(PERMISSION_SCOPES2);
  var DEFAULT_PERMISSIONS2 = [
    PERMISSION_SCOPES2.IDENTITY_READ
  ];
  var METHOD_PERMISSIONS2 = {
    [RPC_METHODS2.GET_IDENTITY]: PERMISSION_SCOPES2.IDENTITY_READ,
    [RPC_METHODS2.GET_BALANCE]: PERMISSION_SCOPES2.BALANCE_READ,
    [RPC_METHODS2.GET_ASSETS]: PERMISSION_SCOPES2.BALANCE_READ,
    [RPC_METHODS2.GET_FIAT_BALANCE]: PERMISSION_SCOPES2.BALANCE_READ,
    [RPC_METHODS2.GET_TOKENS]: PERMISSION_SCOPES2.TOKENS_READ,
    [RPC_METHODS2.GET_HISTORY]: PERMISSION_SCOPES2.HISTORY_READ,
    [RPC_METHODS2.RESOLVE]: PERMISSION_SCOPES2.RESOLVE_PEER,
    [RPC_METHODS2.SUBSCRIBE]: PERMISSION_SCOPES2.EVENTS_SUBSCRIBE,
    [RPC_METHODS2.UNSUBSCRIBE]: PERMISSION_SCOPES2.EVENTS_SUBSCRIBE,
    [RPC_METHODS2.GET_CONVERSATIONS]: PERMISSION_SCOPES2.DM_READ,
    [RPC_METHODS2.GET_MESSAGES]: PERMISSION_SCOPES2.DM_READ,
    [RPC_METHODS2.GET_DM_UNREAD_COUNT]: PERMISSION_SCOPES2.DM_READ,
    [RPC_METHODS2.MARK_AS_READ]: PERMISSION_SCOPES2.DM_MANAGE
  };
  var INTENT_PERMISSIONS2 = {
    [INTENT_ACTIONS2.SEND]: PERMISSION_SCOPES2.TRANSFER_REQUEST,
    [INTENT_ACTIONS2.DM]: PERMISSION_SCOPES2.DM_REQUEST,
    [INTENT_ACTIONS2.PAYMENT_REQUEST]: PERMISSION_SCOPES2.PAYMENT_REQUEST,
    [INTENT_ACTIONS2.RECEIVE]: PERMISSION_SCOPES2.IDENTITY_READ,
    [INTENT_ACTIONS2.SIGN_MESSAGE]: PERMISSION_SCOPES2.SIGN_REQUEST,
    [INTENT_ACTIONS2.MINT]: PERMISSION_SCOPES2.MINT_REQUEST
  };
  var SETTLED_STATUSES2 = /* @__PURE__ */ new Set([
    "confirmed",
    "delivered",
    "completed"
  ]);
  var REALTIME_STATUS2 = {
    connected: "connected",
    degraded: "reconnecting",
    offline: "closed"
  };
  function toLegacyRequest2(view, status) {
    return { ...view, symbol: view.symbol ?? "", status };
  }
  function paymentsOrNull2(sphere) {
    try {
      return sphere.payments;
    } catch {
      return null;
    }
  }
  function legacyRequestPayload2(sphere, update) {
    const view = paymentsOrNull2(sphere)?.requests.list().find((request) => request.id === update.id);
    if (!view) {
      return {
        id: update.id,
        requestId: update.id,
        senderPubkey: "",
        amount: "",
        coinId: "",
        symbol: "",
        timestamp: Date.now(),
        status: update.status
      };
    }
    return toLegacyRequest2(view, update.status);
  }
  function requestStatusAttacher2(status) {
    return (sphere, forward) => sphere.on("payment_request:updated", (update) => {
      if (update.status === status) forward(legacyRequestPayload2(sphere, update));
    });
  }
  function attentionAttacher2(code, toLegacy) {
    return (sphere, forward) => sphere.on("transfer:attention", (attention) => {
      if (attention.code === code) forward(toLegacy(attention));
    });
  }
  function remoteUpdateAttacher2(sphere, forward) {
    let sequence = 0;
    return sphere.on("inventory:updated", () => {
      sequence += 1;
      forward({ providerId: "wallet-api", name: "wallet-api", sequence, cid: "", added: 0, removed: 0 });
    });
  }
  var COMPAT_ATTACHERS2 = /* @__PURE__ */ new Map([
    // Old completion split, held: deliveryPending ? delivery_pending : confirmed, plus the
    // failed arm (manifest judgment call #1). Payloads are the TransferResult, unchanged.
    ["transfer:confirmed", (sphere, forward) => sphere.on("transfer:updated", (result) => {
      if (SETTLED_STATUSES2.has(result.status) && result.deliveryPending !== true) forward(result);
    })],
    ["transfer:delivery_pending", (sphere, forward) => sphere.on("transfer:updated", (result) => {
      if (result.status !== "failed" && result.deliveryPending === true) forward(result);
    })],
    ["transfer:failed", (sphere, forward) => sphere.on("transfer:updated", (result) => {
      if (result.status === "failed") forward(result);
    })],
    // Same name on both wires, different payload: the raw v2 view has optional `symbol`;
    // legacy subscribers get the IncomingPaymentRequest shape via the shared mapping.
    ["payment_request:incoming", (sphere, forward) => sphere.on("payment_request:incoming", (view) => {
      forward(toLegacyRequest2(view, view.status));
    })],
    ["payment_request:paid", requestStatusAttacher2("paid")],
    ["payment_request:rejected", requestStatusAttacher2("rejected")],
    ["payment_request:expired", requestStatusAttacher2("expired")],
    // detail carries the old inner code (SPLIT_CHECKPOINT_LOST / CHECKPOINT_TRUSTBASE_MISMATCH).
    ["split:checkpoint-stuck", attentionAttacher2("split:checkpoint-stuck", (attention) => ({
      transferId: attention.transferId,
      code: attention.detail ?? "",
      error: attention.detail ?? ""
    }))],
    ["delivery:undeliverable", attentionAttacher2("delivery:undeliverable", (attention) => ({
      transferId: attention.transferId,
      recipientPubkey: "",
      attempts: 0,
      error: attention.detail ?? ""
    }))],
    ["delivery:deferred", attentionAttacher2("delivery:deferred", (attention) => ({
      transferId: attention.transferId,
      recipientPubkey: "",
      reason: attention.detail ?? attention.code,
      deferredUntil: 0
    }))],
    ["realtime:status", (sphere, forward) => sphere.on("connection:status", (connection) => {
      forward({ status: REALTIME_STATUS2[connection.status] ?? "closed" });
    })],
    // The server IS storage on the v2 vertical — a degraded connection is degraded storage.
    ["storage:degraded", (sphere, forward) => sphere.on("connection:status", (connection) => {
      if (connection.status !== "degraded") return;
      forward({ providerId: "wallet-api", error: "wallet-api connection degraded" });
    })],
    ["sync:completed", (sphere, forward) => sphere.on("inventory:updated", () => {
      forward({ source: "payments", count: paymentsOrNull2(sphere)?.tokens().length ?? 0 });
    })],
    ["sync:remote-update", remoteUpdateAttacher2]
  ]);
  var WALLET_LOCKED_MESSAGE2 = "Wallet is locked";
  var NOT_CONNECTED_MESSAGE2 = "Not connected";
  var LOCKED_ALLOWLIST2 = /* @__PURE__ */ new Set([
    RPC_METHODS2.GET_IDENTITY,
    RPC_METHODS2.SUBSCRIBE,
    RPC_METHODS2.UNSUBSCRIBE,
    RPC_METHODS2.DISCONNECT
  ]);
  var REFUSE_NOT_CONNECTED2 = {
    kind: "refuse",
    error: { code: ERROR_CODES2.NOT_CONNECTED, message: NOT_CONNECTED_MESSAGE2 }
  };
  var REFUSE_LOCKED2 = {
    kind: "refuse",
    error: {
      code: ERROR_CODES2.WALLET_LOCKED,
      message: WALLET_LOCKED_MESSAGE2,
      data: { reason: "locked" }
    }
  };
  var EMPTY_WALLET_SNAPSHOT2 = Object.freeze({ capturedAt: 0 });
  var CHANNEL_ONLY_CODES2 = /* @__PURE__ */ new Set([
    ERROR_CODES2.WALLET_LOCKED,
    ERROR_CODES2.NOT_CONNECTED
  ]);
  var POPUP_CLOSE_CHECK_INTERVAL = 1e3;
  function originOf(targetOrigin) {
    if (targetOrigin === "*") return null;
    try {
      return [new URL(targetOrigin).origin];
    } catch {
      return null;
    }
  }
  var PostMessageTransport = class _PostMessageTransport {
    constructor(targetWindow, targetOrigin, allowedOrigins) {
      __publicField(this, "targetWindow");
      __publicField(this, "targetOrigin");
      __publicField(this, "allowedOrigins");
      __publicField(this, "handlers", /* @__PURE__ */ new Set());
      __publicField(this, "listener", null);
      __publicField(this, "popupCheckInterval", null);
      __publicField(this, "onPopupClosed", null);
      this.targetWindow = targetWindow;
      this.targetOrigin = targetOrigin;
      this.allowedOrigins = allowedOrigins ? new Set(allowedOrigins) : null;
      this.listener = (event) => {
        if (event.source && event.source !== this.targetWindow) {
          return;
        }
        if (this.allowedOrigins && !this.allowedOrigins.has("*") && !this.allowedOrigins.has(event.origin)) {
          return;
        }
        if (!isSphereConnectMessage(event.data)) {
          return;
        }
        for (const handler of this.handlers) {
          try {
            handler(event.data);
          } catch {
          }
        }
      };
      window.addEventListener("message", this.listener);
    }
    // ===========================================================================
    // Factory Methods
    // ===========================================================================
    /**
     * Create transport for the HOST side (wallet).
     *
     * iframe mode: target = iframe.contentWindow
     * popup mode:  target = window.opener
     */
    static forHost(target, options) {
      const targetWindow = target instanceof HTMLIFrameElement ? target.contentWindow : target;
      const targetOrigin = options.allowedOrigins[0] === "*" ? "*" : options.allowedOrigins[0];
      return new _PostMessageTransport(targetWindow, targetOrigin, options.allowedOrigins);
    }
    /**
     * Create transport for the CLIENT side (dApp).
     *
     * iframe mode: target defaults to window.parent
     * popup mode:  target = popup window (from window.open())
     */
    static forClient(options) {
      const target = options?.target ?? window.parent;
      const targetOrigin = options?.targetOrigin ?? "*";
      const allowedOrigins = originOf(targetOrigin);
      const transport2 = new _PostMessageTransport(target, targetOrigin, allowedOrigins);
      if (options?.target && options.target !== window.parent) {
        transport2.startPopupCloseDetection(options.target);
      }
      return transport2;
    }
    // ===========================================================================
    // ConnectTransport Interface
    // ===========================================================================
    send(message) {
      try {
        this.targetWindow.postMessage(message, this.targetOrigin);
      } catch {
      }
    }
    onMessage(handler) {
      this.handlers.add(handler);
      return () => {
        this.handlers.delete(handler);
      };
    }
    destroy() {
      if (this.listener) {
        window.removeEventListener("message", this.listener);
        this.listener = null;
      }
      if (this.popupCheckInterval) {
        clearInterval(this.popupCheckInterval);
        this.popupCheckInterval = null;
      }
      this.handlers.clear();
    }
    // ===========================================================================
    // Popup Close Detection
    // ===========================================================================
    /** Register a callback for when the popup window closes */
    onClose(callback) {
      this.onPopupClosed = callback;
    }
    startPopupCloseDetection(popup) {
      this.popupCheckInterval = setInterval(() => {
        if (popup.closed) {
          if (this.popupCheckInterval) {
            clearInterval(this.popupCheckInterval);
            this.popupCheckInterval = null;
          }
          if (this.onPopupClosed) {
            this.onPopupClosed();
          }
        }
      }, POPUP_CLOSE_CHECK_INTERVAL);
    }
  };
  var EXT_MSG_TO_HOST = "sphere-connect-ext:tohost";
  var EXT_MSG_TO_CLIENT = "sphere-connect-ext:toclient";
  function isExtensionConnectEnvelope(data) {
    return typeof data === "object" && data !== null && "type" in data && (data.type === EXT_MSG_TO_HOST || data.type === EXT_MSG_TO_CLIENT) && "payload" in data && isSphereConnectMessage(data.payload);
  }
  var ExtensionClientTransport = class {
    constructor() {
      __publicField(this, "handlers", /* @__PURE__ */ new Set());
      __publicField(this, "listener", null);
      this.listener = (event) => {
        if (!isExtensionConnectEnvelope(event.data)) return;
        if (event.data.type !== EXT_MSG_TO_CLIENT) return;
        for (const handler of this.handlers) {
          try {
            handler(event.data.payload);
          } catch {
          }
        }
      };
      window.addEventListener("message", this.listener);
    }
    send(message) {
      const envelope = {
        type: EXT_MSG_TO_HOST,
        payload: message
      };
      window.postMessage(envelope, "*");
    }
    onMessage(handler) {
      this.handlers.add(handler);
      return () => {
        this.handlers.delete(handler);
      };
    }
    destroy() {
      if (this.listener) {
        window.removeEventListener("message", this.listener);
        this.listener = null;
      }
      this.handlers.clear();
    }
  };
  var ExtensionHostTransport = class {
    constructor(chromeApi) {
      __publicField(this, "handlers", /* @__PURE__ */ new Set());
      // tabId of the currently connected dApp tab (used to send responses back)
      __publicField(this, "activeTabId", null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      __publicField(this, "chromeListener", null);
      __publicField(this, "chromeApi");
      this.chromeApi = chromeApi;
      this.chromeListener = (message, sender) => {
        if (!isExtensionConnectEnvelope(message)) return;
        if (message.type !== EXT_MSG_TO_HOST) return;
        if (sender.tab?.id !== void 0) {
          this.activeTabId = sender.tab.id;
        }
        const payload = message.payload;
        for (const handler of this.handlers) {
          try {
            handler(payload);
          } catch {
          }
        }
      };
      this.chromeApi.onMessage.addListener(this.chromeListener);
    }
    send(message) {
      if (this.activeTabId === null) return;
      const envelope = {
        type: EXT_MSG_TO_CLIENT,
        payload: message
      };
      try {
        this.chromeApi.tabs.sendMessage(this.activeTabId, envelope);
      } catch {
      }
    }
    onMessage(handler) {
      this.handlers.add(handler);
      return () => {
        this.handlers.delete(handler);
      };
    }
    destroy() {
      if (this.chromeListener) {
        this.chromeApi.onMessage.removeListener(this.chromeListener);
        this.chromeListener = null;
      }
      this.handlers.clear();
      this.activeTabId = null;
    }
  };
  var ExtensionTransport = {
    /**
     * Create transport for the CLIENT side (dApp page / inject script).
     * Sends via window.postMessage; receives via window.postMessage from content script.
     */
    forClient() {
      return new ExtensionClientTransport();
    },
    /**
     * Create transport for the HOST side (extension background service worker).
     * Receives via chrome.runtime.onMessage; sends via chrome.tabs.sendMessage.
     *
     * @param chromeApi - Pass `chrome` from the extension background context,
     *   or a mock for unit tests.
     */
    forHost(chromeApi) {
      return new ExtensionHostTransport(chromeApi);
    }
  };

  // src/sphere-connect.ts
  var WALLET_URL = "https://sphere.unicity.network";
  function gameWalletAddress() {
    if (typeof window !== "undefined" && window.__BOXY_ARENA_WALLET) {
      return window.__BOXY_ARENA_WALLET;
    }
    return "@boxyrunarena";
  }
  var ENTRY_FEE = 10;
  var COIN_ID = "UCT";
  var UCT_COIN_ID_HEX = "f581d30f593e4b369d684a4563b5246f07b1d265f7178a2c0a82b81f39c24dc0";
  var UCT_DECIMALS = 18;
  var FAUCET_URL = "https://faucet.unicity.network/api/v1/faucet/request";
  var SESSION_KEY = "boxyrun-sphere-session";
  var DEPOSIT_KEY = "boxyrun-deposit-paid";
  var client = null;
  var transport = null;
  var popupWindow = null;
  var uctCoinId = null;
  var uctDecimals = 0;
  var state = {
    isConnected: false,
    isDepositPaid: false,
    identity: null,
    balance: null,
    error: null,
    outcomeUnknown: false
  };
  function isInIframe() {
    try {
      return window.parent !== window && window.self !== window.top;
    } catch {
      return true;
    }
  }
  function hasExtension() {
    try {
      const sphere = window.sphere;
      if (!sphere || typeof sphere !== "object") return false;
      const isInstalled = sphere.isInstalled;
      if (typeof isInstalled !== "function") return false;
      return isInstalled() === true;
    } catch {
      return false;
    }
  }
  function waitForHostReady() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener("message", handler);
        reject(new Error("Wallet did not respond in time"));
      }, HOST_READY_TIMEOUT);
      function handler(event) {
        if (event.data?.type === HOST_READY_TYPE) {
          clearTimeout(timeout);
          window.removeEventListener("message", handler);
          resolve();
        }
      }
      window.addEventListener("message", handler);
    });
  }
  var dappMeta = {
    name: "Boxy Run",
    description: "A 3D endless runner game on Unicity",
    url: location.origin
  };
  var dappPermissions = [
    PERMISSION_SCOPES.IDENTITY_READ,
    PERMISSION_SCOPES.BALANCE_READ,
    PERMISSION_SCOPES.TRANSFER_REQUEST
  ];
  async function connect() {
    if (state.isConnected && client) {
      updateUI("connected");
      try {
        await refreshBalance();
      } catch {
      }
      return;
    }
    updateUI("connecting");
    try {
      let resumeSessionId;
      if (isInIframe()) {
        transport = PostMessageTransport.forClient();
      } else if (hasExtension()) {
        transport = ExtensionTransport.forClient();
      } else {
        const popupWasAlreadyOpen = popupWindow && !popupWindow.closed;
        if (!popupWindow || popupWindow.closed) {
          popupWindow = window.open(
            WALLET_URL + "/connect?origin=" + encodeURIComponent(location.origin),
            "sphere-wallet",
            "width=420,height=650"
          );
          if (!popupWindow) {
            throw new Error("Popup blocked. Please allow popups for this site.");
          }
        }
        transport?.destroy();
        transport = PostMessageTransport.forClient({
          target: popupWindow,
          targetOrigin: WALLET_URL
        });
        if (!popupWasAlreadyOpen) {
          try {
            await waitForHostReady();
          } catch {
          }
        }
        resumeSessionId = sessionStorage.getItem(SESSION_KEY) ?? void 0;
      }
      client = new ConnectClient({
        transport,
        dapp: dappMeta,
        permissions: [...dappPermissions],
        resumeSessionId,
        network: SPHERE_NETWORKS.testnet2
      });
      const result = await client.connect();
      state.isConnected = true;
      state.identity = result.identity;
      if (result.sessionId) {
        sessionStorage.setItem(SESSION_KEY, result.sessionId);
      }
      if (!state.identity?.nametag) {
        state.error = "No Unicity ID found. Please register a Unicity ID in Sphere to play.";
        updateUI("connected");
        return;
      }
      await refreshBalance();
      state.error = null;
      if (sessionStorage.getItem(DEPOSIT_KEY)) {
        sessionStorage.removeItem(DEPOSIT_KEY);
        state.isDepositPaid = true;
        updateUI("ready");
      } else {
        updateUI("connected");
      }
    } catch (err) {
      state.error = err instanceof Error ? err.message : "Connection failed";
      state.isConnected = false;
      updateUI("disconnected");
    }
  }
  async function disconnect() {
    try {
      await client?.disconnect();
    } catch {
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
    updateUI("disconnected");
  }
  async function refreshBalance() {
    if (!client) return;
    try {
      const assets = await client.query("sphere_getBalance");
      if (Array.isArray(assets)) {
        const uct = assets.find((a) => a.symbol === COIN_ID);
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
      console.error("Failed to fetch balance:", err);
      state.balance = null;
    }
  }
  function toBaseUnits(wholeTokens, decimals) {
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
    const [intPart, fracPart = ""] = wholeTokens.toFixed(decimals).split(".");
    const frac = (fracPart + "0".repeat(decimals)).slice(0, decimals);
    const units = BigInt(intPart) * scale + BigInt(frac || "0");
    if (units <= 0n) throw new Error(`Amount ${wholeTokens} is below one base unit`);
    return units.toString();
  }
  async function deposit(amount) {
    const sendAmount = amount ?? ENTRY_FEE;
    if (state.outcomeUnknown) {
      state.error = "A previous payment's outcome is still unknown. Reload the page and check your balance before paying again.";
      updateUI("connected");
      return false;
    }
    if (!client || !state.isConnected) {
      state.error = "Not connected";
      return false;
    }
    if (!state.identity?.nametag) {
      state.error = "Unicity ID required to play. Please register one in Sphere.";
      updateUI("connected");
      return false;
    }
    await refreshBalance();
    if (state.balance !== null && state.balance < sendAmount) {
      state.error = `Insufficient balance. You need at least ${sendAmount} ${COIN_ID}.`;
      updateUI("connected");
      return false;
    }
    try {
      updateUI("depositing");
      if (!uctCoinId) {
        uctCoinId = UCT_COIN_ID_HEX;
        uctDecimals = UCT_DECIMALS;
      }
      if (!uctDecimals) uctDecimals = UCT_DECIMALS;
      await client.intent(INTENT_ACTIONS.SEND, {
        to: gameWalletAddress(),
        amount: toBaseUnits(sendAmount, uctDecimals),
        coinId: uctCoinId,
        memo: "Boxy Run entry fee"
      });
      state.isDepositPaid = true;
      state.error = null;
      await refreshBalance();
      updateUI("ready");
      return true;
    } catch (err) {
      const code = err?.code;
      if (code === ERROR_CODES.INTENT_OUTCOME_UNKNOWN) {
        state.outcomeUnknown = true;
        state.error = "Payment sent, but the wallet could not confirm the outcome. Do NOT pay again \u2014 if it went through, your balance updates on its own within a minute.";
        state.isDepositPaid = false;
        updateUI("connected");
        return false;
      }
      if (code === ERROR_CODES.WALLET_LOCKED) {
        state.error = "Wallet is locked. Unlock it in Sphere, then try again.";
        state.isDepositPaid = false;
        updateUI("connected");
        return false;
      }
      state.error = err instanceof Error ? err.message : "Deposit failed";
      state.isDepositPaid = false;
      updateUI("connected");
      return false;
    }
  }
  async function depositAndRestart() {
    const success = await deposit();
    if (success) {
      sessionStorage.setItem(DEPOSIT_KEY, "true");
      document.location.reload();
    }
  }
  async function requestPayout(coins) {
    if (coins <= 0 || !state.identity) return false;
    const unicityId = state.identity.nametag?.replace(/^@/, "") || "";
    if (!unicityId) {
      console.error("No Unicity ID for payout");
      return false;
    }
    try {
      const response = await fetch(FAUCET_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          unicityId,
          coin: "unicity",
          amount: coins
        })
      });
      if (!response.ok) {
        const errorText = await response.text();
        console.error("Payout failed:", errorText);
        return false;
      }
      const data = await response.json();
      console.log("Payout success:", data);
      return true;
    } catch (err) {
      console.error("Payout error:", err);
      return false;
    }
  }
  function updateUI(phase) {
    const connectBtn = document.getElementById("sphere-connect-btn");
    const walletInfo = document.getElementById("sphere-wallet-info");
    const depositBtn = document.getElementById("sphere-deposit-btn");
    const walletBalance = document.getElementById("sphere-balance");
    const walletAddress = document.getElementById("sphere-address");
    const disconnectBtn = document.getElementById("sphere-disconnect-btn");
    const variableContent = document.getElementById("variable-content");
    const errorDiv = document.getElementById("sphere-error");
    if (connectBtn) connectBtn.style.display = "none";
    if (walletInfo) walletInfo.style.display = "none";
    if (depositBtn) depositBtn.style.display = "none";
    if (disconnectBtn) disconnectBtn.style.display = "none";
    if (errorDiv) {
      errorDiv.style.display = state.error ? "block" : "none";
      errorDiv.textContent = state.error || "";
    }
    if (state.isConnected) {
      if (walletAddress) {
        const id = state.identity;
        walletAddress.textContent = id?.nametag || id?.chainPubkey?.substring(0, 16) + "..." || "Connected";
      }
      if (walletBalance) {
        walletBalance.textContent = state.balance !== null ? state.balance + " " + COIN_ID : "...";
      }
    }
    switch (phase) {
      case "disconnected":
        if (connectBtn) {
          connectBtn.style.display = "block";
          connectBtn.textContent = "Connect Sphere Wallet";
          connectBtn.disabled = false;
        }
        if (variableContent) {
          variableContent.style.visibility = "visible";
          variableContent.innerHTML = "Connect your Sphere wallet to play";
        }
        break;
      case "connecting":
        if (connectBtn) {
          connectBtn.style.display = "block";
          connectBtn.textContent = "Connecting...";
          connectBtn.disabled = true;
        }
        break;
      case "connected":
        if (walletInfo) walletInfo.style.display = "block";
        if (disconnectBtn) disconnectBtn.style.display = "inline-block";
        if (state.identity?.nametag) {
          if (depositBtn) {
            depositBtn.style.display = "block";
            depositBtn.textContent = "Play (" + ENTRY_FEE + " " + COIN_ID + ")";
            depositBtn.disabled = false;
          }
          if (variableContent) {
            variableContent.style.visibility = "visible";
            variableContent.innerHTML = "Deposit " + ENTRY_FEE + " " + COIN_ID + " to start playing";
          }
        } else {
          if (variableContent) {
            variableContent.style.visibility = "visible";
            variableContent.innerHTML = "Unicity ID required to play";
          }
        }
        break;
      case "depositing":
        if (walletInfo) walletInfo.style.display = "block";
        if (depositBtn) {
          depositBtn.style.display = "block";
          depositBtn.textContent = "Confirming in wallet...";
          depositBtn.disabled = true;
        }
        break;
      case "ready":
        if (walletInfo) walletInfo.style.display = "block";
        if (disconnectBtn) disconnectBtn.style.display = "inline-block";
        if (variableContent) {
          variableContent.style.visibility = "visible";
          variableContent.innerHTML = "Press any button to begin";
        }
        break;
      case "playing":
        if (walletInfo) walletInfo.style.display = "block";
        break;
      case "gameover":
        if (walletInfo) walletInfo.style.display = "block";
        if (depositBtn) {
          depositBtn.style.display = "block";
          depositBtn.textContent = "Play Again (" + ENTRY_FEE + " " + COIN_ID + ")";
          depositBtn.disabled = false;
        }
        break;
    }
  }
  window.addEventListener("load", () => {
    const connectBtn = document.getElementById("sphere-connect-btn");
    const depositBtn = document.getElementById("sphere-deposit-btn");
    const disconnectBtn = document.getElementById("sphere-disconnect-btn");
    connectBtn?.addEventListener("click", () => connect());
    depositBtn?.addEventListener("click", () => depositAndRestart());
    disconnectBtn?.addEventListener("click", () => disconnect());
    if (sessionStorage.getItem(DEPOSIT_KEY)) {
      state.isDepositPaid = true;
    }
    const hasSession = isInIframe() || hasExtension() || sessionStorage.getItem(SESSION_KEY);
    if (hasSession) {
      connect();
    } else {
      updateUI("disconnected");
    }
  });
  setInterval(() => {
    if (state.isConnected && popupWindow && popupWindow.closed) {
      disconnect();
    }
  }, 1e3);
  window.SphereWallet = {
    get isConnected() {
      return state.isConnected;
    },
    get isDepositPaid() {
      return state.isDepositPaid;
    },
    get identity() {
      return state.identity;
    },
    get balance() {
      return state.balance;
    },
    get error() {
      return state.error;
    },
    get outcomeUnknown() {
      return state.outcomeUnknown;
    },
    get entryFee() {
      return ENTRY_FEE;
    },
    get coinId() {
      return COIN_ID;
    },
    connect,
    disconnect,
    deposit,
    depositAndRestart,
    requestPayout,
    refreshBalance,
    updateUI,
    resetDeposit() {
      state.isDepositPaid = false;
    }
  };
})();
