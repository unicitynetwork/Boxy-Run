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
  var SphereError = class extends Error {
    constructor(message, code, cause) {
      super(message);
      __publicField(this, "code");
      __publicField(this, "cause");
      this.name = "SphereError";
      this.code = code;
      this.cause = cause;
    }
  };
  var STORAGE_KEYS_GLOBAL = {
    /** Encrypted BIP39 mnemonic */
    MNEMONIC: "mnemonic",
    /** Encrypted master private key */
    MASTER_KEY: "master_key",
    /** BIP32 chain code */
    CHAIN_CODE: "chain_code",
    /** HD derivation path (full path like m/44'/0'/0'/0/0) */
    DERIVATION_PATH: "derivation_path",
    /** Base derivation path (like m/44'/0'/0' without chain/index) */
    BASE_PATH: "base_path",
    /** Derivation mode: bip32, wif_hmac, legacy_hmac */
    DERIVATION_MODE: "derivation_mode",
    /** Wallet source: mnemonic, file, unknown */
    WALLET_SOURCE: "wallet_source",
    /** Wallet existence flag */
    WALLET_EXISTS: "wallet_exists",
    /** Current active address index */
    CURRENT_ADDRESS_INDEX: "current_address_index",
    /** Nametag cache per address (separate from tracked addresses registry) */
    ADDRESS_NAMETAGS: "address_nametags",
    /** Active addresses registry (JSON: TrackedAddressesStorage) */
    TRACKED_ADDRESSES: "tracked_addresses",
    /** Last processed Nostr wallet event timestamp (unix seconds), keyed per pubkey */
    LAST_WALLET_EVENT_TS: "last_wallet_event_ts",
    /** Last processed Nostr DM (gift-wrap) event timestamp (unix seconds), keyed per pubkey */
    LAST_DM_EVENT_TS: "last_dm_event_ts",
    /** Group chat: last used relay URL (stale data detection) — global, same relay for all addresses */
    GROUP_CHAT_RELAY_URL: "group_chat_relay_url",
    /** Cached token registry JSON (fetched from remote) */
    TOKEN_REGISTRY_CACHE: "token_registry_cache",
    /** Timestamp of last token registry cache update (ms since epoch) */
    TOKEN_REGISTRY_CACHE_TS: "token_registry_cache_ts",
    /** Cached price data JSON (from CoinGecko or other provider) */
    PRICE_CACHE: "price_cache",
    /** Timestamp of last price cache update (ms since epoch) */
    PRICE_CACHE_TS: "price_cache_ts"
  };
  var STORAGE_KEYS_ADDRESS = {
    /** Pending transfers for this address */
    PENDING_TRANSFERS: "pending_transfers",
    /** Transfer outbox for this address */
    OUTBOX: "outbox",
    /** Conversations for this address */
    CONVERSATIONS: "conversations",
    /** Messages for this address */
    MESSAGES: "messages",
    /** Transaction history for this address */
    TRANSACTION_HISTORY: "transaction_history",
    /** Pending V5 finalization tokens (unconfirmed instant split tokens) */
    PENDING_V5_TOKENS: "pending_v5_tokens",
    /**
     * FINISHED v2 token blobs awaiting transport delivery. Written the moment a
     * transfer/split output is certified on-chain (the source is already spent),
     * removed after successful delivery — survives transport failures + crashes
     * so the recipient's token is never lost with the process.
     */
    PENDING_V2_DELIVERIES: "pending_v2_deliveries",
    /** Group chat: joined groups for this address */
    GROUP_CHAT_GROUPS: "group_chat_groups",
    /** Group chat: messages for this address */
    GROUP_CHAT_MESSAGES: "group_chat_messages",
    /** Group chat: members for this address */
    GROUP_CHAT_MEMBERS: "group_chat_members",
    /** Group chat: processed event IDs for deduplication */
    GROUP_CHAT_PROCESSED_EVENTS: "group_chat_processed_events",
    /** Processed V5 split group IDs for Nostr re-delivery dedup */
    PROCESSED_SPLIT_GROUP_IDS: "processed_split_group_ids",
    /** Processed V6 combined transfer IDs for Nostr re-delivery dedup */
    PROCESSED_COMBINED_TRANSFER_IDS: "processed_combined_transfer_ids",
    // Invoice / Accounting storage keys
    /** Set of cancelled invoice IDs (JSON string array) */
    CANCELLED_INVOICES: "cancelled_invoices",
    /** Set of closed invoice IDs (JSON string array) */
    CLOSED_INVOICES: "closed_invoices",
    /** Frozen balances for terminated invoices (JSON map: invoiceId → FrozenInvoiceBalances) */
    FROZEN_BALANCES: "frozen_balances",
    /** Auto-return settings (JSON: AutoReturnSettings) */
    AUTO_RETURN: "auto_return",
    /** Auto-return dedup ledger (JSON: AutoReturnLedger) */
    AUTO_RETURN_LEDGER: "auto_return_ledger",
    /** Invoice-transfer index metadata (JSON: Record<invoiceId, { terminated, frozenAt? }>) */
    INV_LEDGER_INDEX: "inv_ledger_index",
    /** Token scan state watermarks (JSON: Record<tokenId, txCount>) */
    TOKEN_SCAN_STATE: "token_scan_state",
    // Swap storage keys
    /** Per-swap key: swap:{swapId} */
    SWAP_RECORD_PREFIX: "swap:",
    /** Lightweight index array for listing */
    SWAP_INDEX: "swap_index"
  };
  var NETWORK_SCOPED_ADDRESS_KEYS = [
    STORAGE_KEYS_ADDRESS.PENDING_TRANSFERS,
    STORAGE_KEYS_ADDRESS.OUTBOX,
    STORAGE_KEYS_ADDRESS.TRANSACTION_HISTORY,
    STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS,
    STORAGE_KEYS_ADDRESS.PENDING_V2_DELIVERIES,
    STORAGE_KEYS_ADDRESS.PROCESSED_SPLIT_GROUP_IDS,
    STORAGE_KEYS_ADDRESS.PROCESSED_COMBINED_TRANSFER_IDS,
    STORAGE_KEYS_ADDRESS.CANCELLED_INVOICES,
    STORAGE_KEYS_ADDRESS.CLOSED_INVOICES,
    STORAGE_KEYS_ADDRESS.FROZEN_BALANCES,
    STORAGE_KEYS_ADDRESS.AUTO_RETURN,
    STORAGE_KEYS_ADDRESS.AUTO_RETURN_LEDGER,
    STORAGE_KEYS_ADDRESS.INV_LEDGER_INDEX,
    STORAGE_KEYS_ADDRESS.TOKEN_SCAN_STATE,
    STORAGE_KEYS_ADDRESS.SWAP_INDEX
  ];
  var NETWORK_SCOPED_ADDRESS_PREFIXES = [
    STORAGE_KEYS_ADDRESS.SWAP_RECORD_PREFIX,
    // 'swap:'
    "inv_ledger:"
    // AccountingModule INV_LEDGER_PREFIX
  ];
  var STORAGE_KEYS = {
    ...STORAGE_KEYS_GLOBAL,
    ...STORAGE_KEYS_ADDRESS
  };
  var DEFAULT_NOSTR_RELAYS = [
    "wss://relay.unicity.network",
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.nostr.band"
  ];
  var DEFAULT_AGGREGATOR_URL = "https://aggregator.unicity.network/rpc";
  var DEV_AGGREGATOR_URL = "https://dev-aggregator.dyndns.org/rpc";
  var DEFAULT_IPFS_GATEWAYS = [
    "https://unicity-ipfs1.dyndns.org"
  ];
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
      ipfsGateways: DEFAULT_IPFS_GATEWAYS,
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
      ipfsGateways: DEFAULT_IPFS_GATEWAYS,
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
      ipfsGateways: DEFAULT_IPFS_GATEWAYS,
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
      ipfsGateways: DEFAULT_IPFS_GATEWAYS,
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
  var SPHERE_CONNECT_VERSION = "2.0";
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
    MARK_AS_READ: "sphere_markAsRead",
    GET_INVOICES: "sphere_getInvoices",
    GET_INVOICE_STATUS: "sphere_getInvoiceStatus"
  };
  var INTENT_ACTIONS = {
    SEND: "send",
    DM: "dm",
    PAYMENT_REQUEST: "payment_request",
    RECEIVE: "receive",
    SIGN_MESSAGE: "sign_message",
    CREATE_INVOICE: "create_invoice",
    CLOSE_INVOICE: "close_invoice",
    CANCEL_INVOICE: "cancel_invoice",
    PAY_INVOICE: "pay_invoice",
    RETURN_INVOICE_PAYMENT: "return_invoice_payment",
    IMPORT_INVOICE: "import_invoice",
    SEND_INVOICE_RECEIPTS: "send_invoice_receipts",
    SEND_CANCELLATION_NOTICES: "send_cancellation_notices",
    SET_AUTO_RETURN: "set_auto_return",
    MINT: "mint"
  };
  function createRequestId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
  var SDK_VERSION = "0.10.3";
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
    MINT_REQUEST: "mint:request",
    INVOICE_READ: "invoice:read",
    INVOICE_WRITE: "invoice:write"
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
    [RPC_METHODS.MARK_AS_READ]: PERMISSION_SCOPES.DM_MANAGE,
    [RPC_METHODS.GET_INVOICES]: PERMISSION_SCOPES.INVOICE_READ,
    [RPC_METHODS.GET_INVOICE_STATUS]: PERMISSION_SCOPES.INVOICE_READ
  };
  var INTENT_PERMISSIONS = {
    [INTENT_ACTIONS.SEND]: PERMISSION_SCOPES.TRANSFER_REQUEST,
    [INTENT_ACTIONS.DM]: PERMISSION_SCOPES.DM_REQUEST,
    [INTENT_ACTIONS.PAYMENT_REQUEST]: PERMISSION_SCOPES.PAYMENT_REQUEST,
    [INTENT_ACTIONS.RECEIVE]: PERMISSION_SCOPES.IDENTITY_READ,
    [INTENT_ACTIONS.SIGN_MESSAGE]: PERMISSION_SCOPES.SIGN_REQUEST,
    [INTENT_ACTIONS.CREATE_INVOICE]: PERMISSION_SCOPES.INVOICE_WRITE,
    [INTENT_ACTIONS.CLOSE_INVOICE]: PERMISSION_SCOPES.INVOICE_WRITE,
    [INTENT_ACTIONS.CANCEL_INVOICE]: PERMISSION_SCOPES.INVOICE_WRITE,
    [INTENT_ACTIONS.PAY_INVOICE]: PERMISSION_SCOPES.TRANSFER_REQUEST,
    [INTENT_ACTIONS.RETURN_INVOICE_PAYMENT]: PERMISSION_SCOPES.TRANSFER_REQUEST,
    [INTENT_ACTIONS.IMPORT_INVOICE]: PERMISSION_SCOPES.INVOICE_WRITE,
    [INTENT_ACTIONS.SEND_INVOICE_RECEIPTS]: PERMISSION_SCOPES.INVOICE_WRITE,
    [INTENT_ACTIONS.SEND_CANCELLATION_NOTICES]: PERMISSION_SCOPES.INVOICE_WRITE,
    [INTENT_ACTIONS.SET_AUTO_RETURN]: PERMISSION_SCOPES.INVOICE_WRITE,
    [INTENT_ACTIONS.MINT]: PERMISSION_SCOPES.MINT_REQUEST
  };
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
    // ===========================================================================
    // Query (read data)
    // ===========================================================================
    /** Send a query request and return the result */
    async query(method, params) {
      if (!this.connected) throw new SphereError("Not connected", "NOT_INITIALIZED");
      const id = createRequestId();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`Query timeout: ${method}`));
        }, this.timeout);
        this.pendingRequests.set(id, {
          resolve,
          reject,
          timer
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
      if (!this.connected) throw new SphereError("Not connected", "NOT_INITIALIZED");
      const id = createRequestId();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`Intent timeout: ${action}`));
        }, this.intentTimeout);
        this.pendingRequests.set(id, {
          resolve,
          reject,
          timer
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
        if (this.connected) {
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
            if (this.connected) {
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
        const handlers = this.eventHandlers.get(msg.event);
        if (handlers) {
          for (const handler of handlers) {
            try {
              handler(msg.data);
            } catch (err) {
              logger.debug("Connect", "Event handler error", err);
            }
          }
        }
      }
    }
    handleHandshakeResponse(msg) {
      if (!this.handshakeResolver) return;
      clearTimeout(this.handshakeResolver.timer);
      const m = msg;
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
        this.connected = true;
        if (m.warning) logger.warn("Connect", "Wallet deprecation notice", m.warning.message);
        this.handshakeResolver.resolve({
          sessionId: msg.sessionId,
          permissions: this.grantedPermissions,
          identity: msg.identity
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
      for (const [, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Disconnected"));
      }
      this.pendingRequests.clear();
      this.eventHandlers.clear();
      this.connected = false;
      this.sessionId = null;
      this.grantedPermissions = [];
      this.identity = null;
      this.walletNet = null;
    }
  };

  // node_modules/@unicitylabs/sphere-sdk/dist/impl/browser/connect/index.js
  function majorOf(v) {
    return parseInt(String(v).split(".")[0], 10);
  }
  var STORAGE_KEYS_GLOBAL2 = {
    /** Encrypted BIP39 mnemonic */
    MNEMONIC: "mnemonic",
    /** Encrypted master private key */
    MASTER_KEY: "master_key",
    /** BIP32 chain code */
    CHAIN_CODE: "chain_code",
    /** HD derivation path (full path like m/44'/0'/0'/0/0) */
    DERIVATION_PATH: "derivation_path",
    /** Base derivation path (like m/44'/0'/0' without chain/index) */
    BASE_PATH: "base_path",
    /** Derivation mode: bip32, wif_hmac, legacy_hmac */
    DERIVATION_MODE: "derivation_mode",
    /** Wallet source: mnemonic, file, unknown */
    WALLET_SOURCE: "wallet_source",
    /** Wallet existence flag */
    WALLET_EXISTS: "wallet_exists",
    /** Current active address index */
    CURRENT_ADDRESS_INDEX: "current_address_index",
    /** Nametag cache per address (separate from tracked addresses registry) */
    ADDRESS_NAMETAGS: "address_nametags",
    /** Active addresses registry (JSON: TrackedAddressesStorage) */
    TRACKED_ADDRESSES: "tracked_addresses",
    /** Last processed Nostr wallet event timestamp (unix seconds), keyed per pubkey */
    LAST_WALLET_EVENT_TS: "last_wallet_event_ts",
    /** Last processed Nostr DM (gift-wrap) event timestamp (unix seconds), keyed per pubkey */
    LAST_DM_EVENT_TS: "last_dm_event_ts",
    /** Group chat: last used relay URL (stale data detection) — global, same relay for all addresses */
    GROUP_CHAT_RELAY_URL: "group_chat_relay_url",
    /** Cached token registry JSON (fetched from remote) */
    TOKEN_REGISTRY_CACHE: "token_registry_cache",
    /** Timestamp of last token registry cache update (ms since epoch) */
    TOKEN_REGISTRY_CACHE_TS: "token_registry_cache_ts",
    /** Cached price data JSON (from CoinGecko or other provider) */
    PRICE_CACHE: "price_cache",
    /** Timestamp of last price cache update (ms since epoch) */
    PRICE_CACHE_TS: "price_cache_ts"
  };
  var STORAGE_KEYS_ADDRESS2 = {
    /** Pending transfers for this address */
    PENDING_TRANSFERS: "pending_transfers",
    /** Transfer outbox for this address */
    OUTBOX: "outbox",
    /** Conversations for this address */
    CONVERSATIONS: "conversations",
    /** Messages for this address */
    MESSAGES: "messages",
    /** Transaction history for this address */
    TRANSACTION_HISTORY: "transaction_history",
    /** Pending V5 finalization tokens (unconfirmed instant split tokens) */
    PENDING_V5_TOKENS: "pending_v5_tokens",
    /**
     * FINISHED v2 token blobs awaiting transport delivery. Written the moment a
     * transfer/split output is certified on-chain (the source is already spent),
     * removed after successful delivery — survives transport failures + crashes
     * so the recipient's token is never lost with the process.
     */
    PENDING_V2_DELIVERIES: "pending_v2_deliveries",
    /** Group chat: joined groups for this address */
    GROUP_CHAT_GROUPS: "group_chat_groups",
    /** Group chat: messages for this address */
    GROUP_CHAT_MESSAGES: "group_chat_messages",
    /** Group chat: members for this address */
    GROUP_CHAT_MEMBERS: "group_chat_members",
    /** Group chat: processed event IDs for deduplication */
    GROUP_CHAT_PROCESSED_EVENTS: "group_chat_processed_events",
    /** Processed V5 split group IDs for Nostr re-delivery dedup */
    PROCESSED_SPLIT_GROUP_IDS: "processed_split_group_ids",
    /** Processed V6 combined transfer IDs for Nostr re-delivery dedup */
    PROCESSED_COMBINED_TRANSFER_IDS: "processed_combined_transfer_ids",
    // Invoice / Accounting storage keys
    /** Set of cancelled invoice IDs (JSON string array) */
    CANCELLED_INVOICES: "cancelled_invoices",
    /** Set of closed invoice IDs (JSON string array) */
    CLOSED_INVOICES: "closed_invoices",
    /** Frozen balances for terminated invoices (JSON map: invoiceId → FrozenInvoiceBalances) */
    FROZEN_BALANCES: "frozen_balances",
    /** Auto-return settings (JSON: AutoReturnSettings) */
    AUTO_RETURN: "auto_return",
    /** Auto-return dedup ledger (JSON: AutoReturnLedger) */
    AUTO_RETURN_LEDGER: "auto_return_ledger",
    /** Invoice-transfer index metadata (JSON: Record<invoiceId, { terminated, frozenAt? }>) */
    INV_LEDGER_INDEX: "inv_ledger_index",
    /** Token scan state watermarks (JSON: Record<tokenId, txCount>) */
    TOKEN_SCAN_STATE: "token_scan_state",
    // Swap storage keys
    /** Per-swap key: swap:{swapId} */
    SWAP_RECORD_PREFIX: "swap:",
    /** Lightweight index array for listing */
    SWAP_INDEX: "swap_index"
  };
  var NETWORK_SCOPED_ADDRESS_KEYS2 = [
    STORAGE_KEYS_ADDRESS2.PENDING_TRANSFERS,
    STORAGE_KEYS_ADDRESS2.OUTBOX,
    STORAGE_KEYS_ADDRESS2.TRANSACTION_HISTORY,
    STORAGE_KEYS_ADDRESS2.PENDING_V5_TOKENS,
    STORAGE_KEYS_ADDRESS2.PENDING_V2_DELIVERIES,
    STORAGE_KEYS_ADDRESS2.PROCESSED_SPLIT_GROUP_IDS,
    STORAGE_KEYS_ADDRESS2.PROCESSED_COMBINED_TRANSFER_IDS,
    STORAGE_KEYS_ADDRESS2.CANCELLED_INVOICES,
    STORAGE_KEYS_ADDRESS2.CLOSED_INVOICES,
    STORAGE_KEYS_ADDRESS2.FROZEN_BALANCES,
    STORAGE_KEYS_ADDRESS2.AUTO_RETURN,
    STORAGE_KEYS_ADDRESS2.AUTO_RETURN_LEDGER,
    STORAGE_KEYS_ADDRESS2.INV_LEDGER_INDEX,
    STORAGE_KEYS_ADDRESS2.TOKEN_SCAN_STATE,
    STORAGE_KEYS_ADDRESS2.SWAP_INDEX
  ];
  var NETWORK_SCOPED_ADDRESS_PREFIXES2 = [
    STORAGE_KEYS_ADDRESS2.SWAP_RECORD_PREFIX,
    // 'swap:'
    "inv_ledger:"
    // AccountingModule INV_LEDGER_PREFIX
  ];
  var STORAGE_KEYS2 = {
    ...STORAGE_KEYS_GLOBAL2,
    ...STORAGE_KEYS_ADDRESS2
  };
  var DEFAULT_NOSTR_RELAYS2 = [
    "wss://relay.unicity.network",
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.nostr.band"
  ];
  var DEFAULT_AGGREGATOR_URL2 = "https://aggregator.unicity.network/rpc";
  var DEV_AGGREGATOR_URL2 = "https://dev-aggregator.dyndns.org/rpc";
  var DEFAULT_IPFS_GATEWAYS2 = [
    "https://unicity-ipfs1.dyndns.org"
  ];
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
      ipfsGateways: DEFAULT_IPFS_GATEWAYS2,
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
      ipfsGateways: DEFAULT_IPFS_GATEWAYS2,
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
      ipfsGateways: DEFAULT_IPFS_GATEWAYS2,
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
      ipfsGateways: DEFAULT_IPFS_GATEWAYS2,
      groupRelays: DEFAULT_GROUP_RELAYS2,
      tokenRegistryUrl: TOKEN_REGISTRY_URL2
    }
  };
  var SPHERE_NETWORKS2 = {
    testnet2: { id: NETWORKS2.testnet2.networkId, name: "testnet2" }
  };
  var SPHERE_CONNECT_NAMESPACE2 = "sphere-connect";
  var SPHERE_CONNECT_VERSION2 = "2.0";
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
    MARK_AS_READ: "sphere_markAsRead",
    GET_INVOICES: "sphere_getInvoices",
    GET_INVOICE_STATUS: "sphere_getInvoiceStatus"
  };
  var INTENT_ACTIONS2 = {
    SEND: "send",
    DM: "dm",
    PAYMENT_REQUEST: "payment_request",
    RECEIVE: "receive",
    SIGN_MESSAGE: "sign_message",
    CREATE_INVOICE: "create_invoice",
    CLOSE_INVOICE: "close_invoice",
    CANCEL_INVOICE: "cancel_invoice",
    PAY_INVOICE: "pay_invoice",
    RETURN_INVOICE_PAYMENT: "return_invoice_payment",
    IMPORT_INVOICE: "import_invoice",
    SEND_INVOICE_RECEIPTS: "send_invoice_receipts",
    SEND_CANCELLATION_NOTICES: "send_cancellation_notices",
    SET_AUTO_RETURN: "set_auto_return",
    MINT: "mint"
  };
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
    MINT_REQUEST: "mint:request",
    INVOICE_READ: "invoice:read",
    INVOICE_WRITE: "invoice:write"
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
    [RPC_METHODS2.MARK_AS_READ]: PERMISSION_SCOPES2.DM_MANAGE,
    [RPC_METHODS2.GET_INVOICES]: PERMISSION_SCOPES2.INVOICE_READ,
    [RPC_METHODS2.GET_INVOICE_STATUS]: PERMISSION_SCOPES2.INVOICE_READ
  };
  var INTENT_PERMISSIONS2 = {
    [INTENT_ACTIONS2.SEND]: PERMISSION_SCOPES2.TRANSFER_REQUEST,
    [INTENT_ACTIONS2.DM]: PERMISSION_SCOPES2.DM_REQUEST,
    [INTENT_ACTIONS2.PAYMENT_REQUEST]: PERMISSION_SCOPES2.PAYMENT_REQUEST,
    [INTENT_ACTIONS2.RECEIVE]: PERMISSION_SCOPES2.IDENTITY_READ,
    [INTENT_ACTIONS2.SIGN_MESSAGE]: PERMISSION_SCOPES2.SIGN_REQUEST,
    [INTENT_ACTIONS2.CREATE_INVOICE]: PERMISSION_SCOPES2.INVOICE_WRITE,
    [INTENT_ACTIONS2.CLOSE_INVOICE]: PERMISSION_SCOPES2.INVOICE_WRITE,
    [INTENT_ACTIONS2.CANCEL_INVOICE]: PERMISSION_SCOPES2.INVOICE_WRITE,
    [INTENT_ACTIONS2.PAY_INVOICE]: PERMISSION_SCOPES2.TRANSFER_REQUEST,
    [INTENT_ACTIONS2.RETURN_INVOICE_PAYMENT]: PERMISSION_SCOPES2.TRANSFER_REQUEST,
    [INTENT_ACTIONS2.IMPORT_INVOICE]: PERMISSION_SCOPES2.INVOICE_WRITE,
    [INTENT_ACTIONS2.SEND_INVOICE_RECEIPTS]: PERMISSION_SCOPES2.INVOICE_WRITE,
    [INTENT_ACTIONS2.SEND_CANCELLATION_NOTICES]: PERMISSION_SCOPES2.INVOICE_WRITE,
    [INTENT_ACTIONS2.SET_AUTO_RETURN]: PERMISSION_SCOPES2.INVOICE_WRITE,
    [INTENT_ACTIONS2.MINT]: PERMISSION_SCOPES2.MINT_REQUEST
  };
  var POPUP_CLOSE_CHECK_INTERVAL = 1e3;
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
      const transport2 = new _PostMessageTransport(target, targetOrigin, null);
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
  var UCT_COIN_ID_HEX = "455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89";
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
    error: null
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
  async function deposit(amount) {
    const sendAmount = amount ?? ENTRY_FEE;
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
      await client.intent(INTENT_ACTIONS.SEND, {
        to: gameWalletAddress(),
        amount: sendAmount,
        coinId: uctCoinId,
        memo: "Boxy Run entry fee"
      });
      state.isDepositPaid = true;
      state.error = null;
      await refreshBalance();
      updateUI("ready");
      return true;
    } catch (err) {
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
