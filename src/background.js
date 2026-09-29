import {
  HDNodeWallet, Mnemonic, Wallet, JsonRpcProvider, Network,
  formatEther, parseEther, isAddress, getBytes, isHexString, toUtf8String,
} from 'ethers';

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const EXT_URL = chrome.runtime.getURL('');
const AUTOLOCK_MINUTES = 15;
const PBKDF2_ITERATIONS = 600_000;

// Public RPCs are fine for a prototype. Swap in your own endpoints (and update
// host_permissions in manifest.json) before shipping.
const NETWORKS = {
  1:        { name: 'Ethereum', symbol: 'ETH',  rpc: 'https://ethereum-rpc.publicnode.com',         explorer: 'https://etherscan.io' },
  137:      { name: 'Polygon',  symbol: 'POL',  rpc: 'https://polygon-bor-rpc.publicnode.com',      explorer: 'https://polygonscan.com' },
  8453:     { name: 'Base',     symbol: 'ETH',  rpc: 'https://mainnet.base.org',                    explorer: 'https://basescan.org' },
  42161:    { name: 'Arbitrum', symbol: 'ETH',  rpc: 'https://arb1.arbitrum.io/rpc',                explorer: 'https://arbiscan.io' },
  10:       { name: 'Optimism', symbol: 'ETH',  rpc: 'https://mainnet.optimism.io',                 explorer: 'https://optimistic.etherscan.io' },
  11155111: { name: 'Sepolia',  symbol: 'ETH',  rpc: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io' },
};

class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const USER_REJECTED = () => new RpcError(4001, 'User rejected the request.');

const enc = new TextEncoder();
const dec = new TextDecoder();
const hexChain = (n) => '0x' + n.toString(16);

/* ------------------------------------------------------------------ */
/* Encrypted vault (PBKDF2-SHA256 → AES-256-GCM via WebCrypto)         */
/* ------------------------------------------------------------------ */

const toB64 = (u8) => { let s = ''; u8.forEach((b) => (s += String.fromCharCode(b))); return btoa(s); };
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function sealVault(phrase, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(phrase)));
  return { v: 1, kdf: 'pbkdf2-sha256', iterations: PBKDF2_ITERATIONS, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) };
}

async function openVault(vault, password) {
  try {
    const key = await deriveKey(password, fromB64(vault.salt), vault.iterations);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(vault.iv) }, key, fromB64(vault.ct));
    return dec.decode(pt);
  } catch {
    throw new Error('Wrong password.');
  }
}

/* ------------------------------------------------------------------ */
/* Storage + key helpers                                               */
/* ------------------------------------------------------------------ */

const DEFAULTS = { vault: null, accountCount: 1, selected: 0, chainId: 1, connected: {}, backedUp: true };
const settings = () => chrome.storage.local.get(DEFAULTS);
const save = (obj) => chrome.storage.local.set(obj);

// The decrypted phrase only ever lives in chrome.storage.session (memory only,
// cleared when the browser closes, not readable from content scripts).
async function getPhrase() {
  const { phrase } = await chrome.storage.session.get('phrase');
  return phrase || null;
}

let rootCache = null;
function rootFor(phrase) {
  if (rootCache?.phrase !== phrase) {
    rootCache = { phrase, root: HDNodeWallet.fromSeed(Mnemonic.fromPhrase(phrase).computeSeed()) };
  }
  return rootCache.root;
}
const accountAt = (phrase, i) => rootFor(phrase).derivePath(`44'/60'/0'/0/${i}`);

const providers = new Map();
function providerFor(chainId) {
  if (!providers.has(chainId)) {
    const net = Network.from(chainId);
    providers.set(chainId, new JsonRpcProvider(NETWORKS[chainId].rpc, net, { staticNetwork: net }));
  }
  return providers.get(chainId);
}

async function activeSigner() {
  const [s, phrase] = await Promise.all([settings(), getPhrase()]);
  if (!phrase) throw new RpcError(4100, 'PolyGrisGris is locked.');
  const acct = accountAt(phrase, s.selected);
  return { wallet: new Wallet(acct.privateKey, providerFor(s.chainId)), chainId: s.chainId, address: acct.address };
}

function normalizePhrase(p) { return p.trim().toLowerCase().split(/\s+/).join(' '); }

async function startSession(phrase) {
  await chrome.storage.session.set({ phrase });
  chrome.alarms.create('autolock', { delayInMinutes: AUTOLOCK_MINUTES });
}
const touch = async () => { if (await getPhrase()) chrome.alarms.create('autolock', { delayInMinutes: AUTOLOCK_MINUTES }); };

async function lock() {
  await chrome.storage.session.remove('phrase');
  rootCache = null;
  chrome.alarms.clear('autolock');
  broadcast('accountsChanged');
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'autolock') lock(); });

/* ------------------------------------------------------------------ */
/* Tab events (accountsChanged / chainChanged)                         */
/* ------------------------------------------------------------------ */

async function broadcast(event) {
  const s = await settings();
  const data = event === 'chainChanged' ? hexChain(s.chainId) : null;
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id != null) chrome.tabs.sendMessage(t.id, { type: 'event', event, data }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Approval windows                                                    */
/* ------------------------------------------------------------------ */

const pending = new Map();

function requestApproval(kind, origin, data) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const entry = { id, kind, origin, data, windowId: null, resolve, reject };
    pending.set(id, entry);
    chrome.windows
      .create({ url: chrome.runtime.getURL('popup.html#/approve'), type: 'popup', width: 400, height: 680 })
      .then((w) => { entry.windowId = w.id; })
      .catch((err) => { pending.delete(id); reject(err); });
  });
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, p] of pending) {
    if (p.windowId === windowId) { pending.delete(id); p.reject(USER_REJECTED()); }
  }
});

/* ------------------------------------------------------------------ */
/* State for the popup                                                 */
/* ------------------------------------------------------------------ */

async function getState() {
  const s = await settings();
  const phrase = await getPhrase();
  const unlocked = !!phrase && !!s.vault;
  const accounts = unlocked
    ? Array.from({ length: s.accountCount }, (_, i) => ({ index: i, address: accountAt(phrase, i).address }))
    : [];
  return {
    hasWallet: !!s.vault,
    unlocked,
    backedUp: s.backedUp,
    accounts,
    selected: s.selected,
    network: { chainId: s.chainId, ...NETWORKS[s.chainId] },
    networks: Object.entries(NETWORKS).map(([id, n]) => ({ chainId: Number(id), name: n.name, symbol: n.symbol })),
    sites: Object.keys(s.connected),
  };
}

const shortAmount = (wei) => {
  const [i, f = ''] = formatEther(wei).split('.');
  const frac = f.slice(0, 5).replace(/0+$/, '');
  return frac ? `${i}.${frac}` : i;
};

/* ------------------------------------------------------------------ */
/* Popup (UI) actions                                                  */
/* ------------------------------------------------------------------ */

async function storeNewVault(phrase, password, backedUp) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('Use a password with at least 8 characters.');
  await save({ vault: await sealVault(phrase, password), accountCount: 1, selected: 0, connected: {}, backedUp });
  await startSession(phrase);
}

const uiActions = {
  state: () => getState(),

  async create({ password }) {
    const phrase = Wallet.createRandom().mnemonic.phrase;
    await storeNewVault(phrase, password, false);
    return { phrase };
  },

  async importWallet({ phrase, password }) {
    const clean = normalizePhrase(phrase || '');
    if (!Mnemonic.isValidMnemonic(clean)) throw new Error('That recovery phrase is not valid. Check the words and their order.');
    await storeNewVault(clean, password, true);
    return true;
  },

  async unlock({ password }) {
    const { vault } = await settings();
    if (!vault) throw new Error('No wallet found.');
    await startSession(await openVault(vault, password));
    broadcast('accountsChanged');
    return true;
  },

  async lock() { await lock(); return true; },

  async exportPhrase({ password }) {
    const { vault } = await settings();
    return openVault(vault, password);
  },

  async confirmBackup() { await save({ backedUp: true }); return true; },

  async addAccount() {
    const s = await settings();
    await save({ accountCount: s.accountCount + 1, selected: s.accountCount });
    broadcast('accountsChanged');
    return true;
  },

  async selectAccount({ index }) {
    const s = await settings();
    if (!Number.isInteger(index) || index < 0 || index >= s.accountCount) throw new Error('Unknown account.');
    await save({ selected: index });
    broadcast('accountsChanged');
    return true;
  },

  async switchNetwork({ chainId }) {
    if (!NETWORKS[chainId]) throw new Error('Unknown network.');
    await save({ chainId });
    broadcast('chainChanged');
    return true;
  },

  async balance() {
    const { address, wallet, chainId } = await activeSigner();
    const bal = await wallet.provider.getBalance(address);
    return { display: shortAmount(bal), symbol: NETWORKS[chainId].symbol };
  },

  async sendNative({ to, amount }) {
    if (!isAddress(to)) throw new Error('That is not a valid address.');
    let value;
    try { value = parseEther(String(amount)); } catch { throw new Error('Enter a valid amount.'); }
    if (value <= 0n) throw new Error('Amount must be greater than zero.');
    const { wallet, chainId } = await activeSigner();
    const tx = await wallet.sendTransaction({ to, value });
    return { hash: tx.hash, explorer: `${NETWORKS[chainId].explorer}/tx/${tx.hash}` };
  },

  async disconnectSite({ origin }) {
    const s = await settings();
    delete s.connected[origin];
    await save({ connected: s.connected });
    broadcast('accountsChanged');
    return true;
  },

  async pending(_msg, sender) {
    const wid = sender.tab?.windowId;
    const p = [...pending.values()].find((x) => x.windowId === wid) ?? [...pending.values()].find((x) => x.windowId == null);
    if (!p) return null;
    const s = await settings();
    return { id: p.id, kind: p.kind, origin: p.origin, data: p.data, network: NETWORKS[s.chainId].name };
  },

  async resolve({ id, approved }) {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    if (approved) p.resolve(true); else p.reject(USER_REJECTED());
    return true;
  },
};

/* ------------------------------------------------------------------ */
/* Dapp (EIP-1193) requests                                            */
/* ------------------------------------------------------------------ */

const UNSUPPORTED = new Set(['eth_sign', 'eth_signTransaction', 'eth_subscribe', 'eth_unsubscribe']);

async function handleRpc(method, params, origin) {
  const s = await settings();
  const phrase = await getPhrase();

  const connectedAccounts = () =>
    phrase && s.connected[origin] ? [accountAt(phrase, s.selected).address] : [];

  const requireAccount = async () => {
    const fresh = await settings();
    const p = await getPhrase();
    if (!p || !fresh.connected[origin]) throw new RpcError(4100, 'Not authorized. Call eth_requestAccounts first.');
    return accountAt(p, fresh.selected).address;
  };

  const connect = async () => {
    const existing = connectedAccounts();
    if (existing.length) return existing;
    await requestApproval('connect', origin, {});
    const fresh = await settings();
    fresh.connected[origin] = true;
    await save({ connected: fresh.connected });
    const p = await getPhrase();
    if (!p) throw new RpcError(4100, 'PolyGrisGris is locked.');
    return [accountAt(p, fresh.selected).address];
  };

  switch (method) {
    case 'eth_chainId': return hexChain(s.chainId);
    case 'net_version': return String(s.chainId);
    case 'eth_accounts': return connectedAccounts();
    case 'eth_coinbase': return connectedAccounts()[0] ?? null;
    case 'eth_requestAccounts': return connect();

    case 'wallet_getPermissions':
      return connectedAccounts().length ? [{ parentCapability: 'eth_accounts' }] : [];
    case 'wallet_requestPermissions':
      await connect();
      return [{ parentCapability: 'eth_accounts' }];

    case 'wallet_switchEthereumChain': {
      const id = Number(params?.[0]?.chainId);
      if (!NETWORKS[id]) throw new RpcError(4902, 'Unrecognized chain. PolyGrisGris cannot add custom chains yet.');
      await requireAccount();
      await save({ chainId: id });
      broadcast('chainChanged');
      return null;
    }

    case 'eth_sendTransaction': {
      const account = await requireAccount();
      const tx = params?.[0] ?? {};
      if (tx.from && tx.from.toLowerCase() !== account.toLowerCase()) throw new RpcError(4100, 'The "from" address is not the active account.');
      if (tx.to != null && !isAddress(tx.to)) throw new RpcError(-32602, 'Invalid "to" address.');
      const data = tx.data ?? tx.input ?? '0x';
      if (!isHexString(data)) throw new RpcError(-32602, 'Invalid transaction data.');
      const request = { to: tx.to ?? undefined, value: tx.value ?? '0x0', data, gasLimit: tx.gas ?? tx.gasLimit, nonce: tx.nonce };
      if (tx.maxFeePerGas != null) {
        request.maxFeePerGas = tx.maxFeePerGas;
        if (tx.maxPriorityFeePerGas != null) request.maxPriorityFeePerGas = tx.maxPriorityFeePerGas;
      } else if (tx.gasPrice != null) {
        request.gasPrice = tx.gasPrice;
      }
      for (const k of Object.keys(request)) if (request[k] === undefined) delete request[k];

      let valueWei;
      try { valueWei = BigInt(request.value); } catch { throw new RpcError(-32602, 'Invalid value.'); }
      await requestApproval('tx', origin, {
        from: account,
        to: tx.to ?? null,
        value: formatEther(valueWei),
        symbol: NETWORKS[s.chainId].symbol,
        data,
      });
      const { wallet } = await activeSigner();
      const sent = await wallet.sendTransaction(request);
      return sent.hash;
    }

    case 'personal_sign': {
      const account = await requireAccount();
      const [message, address] = params ?? [];
      if (address && address.toLowerCase() !== account.toLowerCase()) throw new RpcError(4100, 'Address does not match the active account.');
      const bytes = isHexString(message) ? getBytes(message) : enc.encode(String(message));
      let text;
      try { text = toUtf8String(bytes); } catch { text = null; }
      await requestApproval('sign', origin, { text, hex: text === null ? message : null });
      const { wallet } = await activeSigner();
      return wallet.signMessage(bytes);
    }

    case 'eth_signTypedData_v3':
    case 'eth_signTypedData_v4': {
      const account = await requireAccount();
      const [address, raw] = params ?? [];
      if (address && address.toLowerCase() !== account.toLowerCase()) throw new RpcError(4100, 'Address does not match the active account.');
      let typed;
      try { typed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new RpcError(-32602, 'Invalid typed data.'); }
      const { domain, types, message } = typed ?? {};
      if (!domain || !types || !message) throw new RpcError(-32602, 'Invalid typed data.');
      if (domain.chainId != null && Number(domain.chainId) !== s.chainId) {
        throw new RpcError(-32602, `Typed data is for chain ${Number(domain.chainId)} but the wallet is on chain ${s.chainId}.`);
      }
      const cleanTypes = { ...types };
      delete cleanTypes.EIP712Domain;
      await requestApproval('typed', origin, { json: JSON.stringify(typed, null, 2) });
      const { wallet } = await activeSigner();
      return wallet.signTypedData(domain, cleanTypes, message);
    }

    default:
      if (UNSUPPORTED.has(method)) throw new RpcError(4200, `${method} is not supported by PolyGrisGris.`);
      if (/^(eth|net|web3)_/.test(method)) return providerFor(s.chainId).send(method, params ?? []);
      throw new RpcError(4200, `The method ${method} is not supported.`);
  }
}

/* ------------------------------------------------------------------ */
/* Message routing                                                     */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const fromExtensionPage = typeof sender.url === 'string' && sender.url.startsWith(EXT_URL);

      if (msg?.type === 'ui' && fromExtensionPage) {
        const fn = uiActions[msg.action];
        if (!fn) throw new Error('Unknown action.');
        const result = await fn(msg, sender);
        if (msg.action !== 'state' && msg.action !== 'lock') touch();
        sendResponse({ ok: true, result });
        return;
      }

      if (msg?.type === 'rpc' && sender.tab && !fromExtensionPage) {
        const origin = sender.origin ?? new URL(sender.url).origin;
        if (!/^https?:\/\//.test(origin)) throw new RpcError(4100, 'Unsupported origin.');
        if (typeof msg.method !== 'string' || (msg.params != null && !Array.isArray(msg.params))) {
          throw new RpcError(-32600, 'Invalid request.');
        }
        const result = await handleRpc(msg.method, msg.params ?? [], origin);
        sendResponse({ ok: true, result });
        return;
      }

      throw new Error('Unauthorized sender.');
    } catch (err) {
      sendResponse({
        ok: false,
        error: { code: typeof err.code === 'number' ? err.code : -32603, message: err.shortMessage || err.message || 'Internal error' },
      });
    }
  })();
  return true;
});
