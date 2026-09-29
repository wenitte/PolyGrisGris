// Runs in the page's own JS world. Exposes an EIP-1193 provider + EIP-6963 announcement.
(() => {
  const TO_WALLET = 'polygrisgris-content';
  const FROM_WALLET = 'polygrisgris-inpage';

  const pending = new Map();
  let nextId = 1;

  const makeError = (e) => Object.assign(new Error(e?.message ?? 'Unknown wallet error'), { code: e?.code ?? -32603 });

  class PolyGrisGrisProvider {
    constructor() {
      this.isPolyGrisGris = true;
      this.chainId = null;
      this.selectedAddress = null;
      this.networkVersion = null;
      this._listeners = new Map();
      window.addEventListener('message', (e) => this._onMessage(e));
      this.request({ method: 'eth_chainId' }).then((id) => this._setChain(id)).catch(() => {});
      this.request({ method: 'eth_accounts' }).then((a) => { this.selectedAddress = a[0] ?? null; }).catch(() => {});
    }

    _setChain(id) {
      const first = this.chainId === null;
      if (id === this.chainId) return;
      this.chainId = id;
      this.networkVersion = String(parseInt(id, 16));
      if (first) this._emit('connect', { chainId: id }); else this._emit('chainChanged', id);
    }

    _onMessage(e) {
      if (e.source !== window || e.data?.target !== FROM_WALLET) return;
      const d = e.data;
      if (d.event) {
        if (d.event === 'chainChanged') this._setChain(d.data);
        if (d.event === 'accountsChanged') {
          this.selectedAddress = d.data[0] ?? null;
          this._emit('accountsChanged', d.data);
        }
        return;
      }
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      if (d.ok) p.resolve(d.result); else p.reject(makeError(d.error));
    }

    request(args) {
      if (!args || typeof args.method !== 'string') {
        return Promise.reject(Object.assign(new Error('Invalid request arguments.'), { code: -32600 }));
      }
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        window.postMessage({ target: TO_WALLET, id, method: args.method, params: args.params ?? [] }, window.location.origin);
      });
    }

    // Legacy shims
    enable() { return this.request({ method: 'eth_requestAccounts' }); }
    send(a, b) {
      if (typeof a === 'string') return this.request({ method: a, params: b });
      return this.sendAsync(a, b);
    }
    sendAsync(payload, cb) {
      this.request({ method: payload.method, params: payload.params })
        .then((result) => cb(null, { id: payload.id, jsonrpc: '2.0', result }))
        .catch((error) => cb(error, null));
    }
    isConnected() { return true; }

    on(evt, fn) {
      if (!this._listeners.has(evt)) this._listeners.set(evt, new Set());
      this._listeners.get(evt).add(fn);
      return this;
    }
    addListener(evt, fn) { return this.on(evt, fn); }
    once(evt, fn) {
      const wrap = (...a) => { this.removeListener(evt, wrap); fn(...a); };
      return this.on(evt, wrap);
    }
    removeListener(evt, fn) { this._listeners.get(evt)?.delete(fn); return this; }
    off(evt, fn) { return this.removeListener(evt, fn); }
    removeAllListeners(evt) { evt ? this._listeners.delete(evt) : this._listeners.clear(); return this; }
    _emit(evt, data) {
      this._listeners.get(evt)?.forEach((fn) => { try { fn(data); } catch (err) { console.error(err); } });
    }
  }

  const provider = new PolyGrisGrisProvider();

  const logo =
    'data:image/svg+xml;base64,' +
    btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="31" fill="#2A1533"/>' +
        '<path d="M32 12 46 34 32 54 18 34Z" fill="none" stroke="#E2B64A" stroke-width="4" stroke-linejoin="round"/></svg>',
    );

  const info = Object.freeze({
    uuid: 'b7e9c1d4-5a3f-4c8e-9a21-6f0d2e8b7c35',
    name: 'PolyGrisGris',
    icon: logo,
    rdns: 'app.polygrisgris',
  });

  const announce = () =>
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();

  // Only claim window.ethereum if no other wallet already has it.
  if (!window.ethereum) {
    Object.defineProperty(window, 'ethereum', { value: provider, configurable: true, writable: true });
  }
  window.polygrisgris = provider;
})();
