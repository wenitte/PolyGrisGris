// Isolated-world bridge: page (inpage.js) <-> background service worker.
const TO_PAGE = 'polygrisgris-inpage';
const FROM_PAGE = 'polygrisgris-content';

const post = (payload) => window.postMessage({ target: TO_PAGE, ...payload }, window.location.origin);

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.target !== FROM_PAGE) return;
  const { id, method, params } = e.data;
  if (typeof id !== 'number' || typeof method !== 'string') return;

  chrome.runtime
    .sendMessage({ type: 'rpc', method, params })
    .then((reply) => post({ id, ...(reply ?? { ok: false, error: { code: -32603, message: 'No response from wallet.' } }) }))
    .catch((err) => post({ id, ok: false, error: { code: -32603, message: String(err?.message ?? err) } }));
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'event') return;
  if (msg.event === 'accountsChanged') {
    // Accounts depend on this site's permissions, so ask the wallet what this origin may see.
    chrome.runtime
      .sendMessage({ type: 'rpc', method: 'eth_accounts', params: [] })
      .then((r) => post({ event: 'accountsChanged', data: r?.ok ? r.result : [] }))
      .catch(() => {});
  } else {
    post({ event: msg.event, data: msg.data });
  }
});
