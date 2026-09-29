const app = document.getElementById('app');
const isApproval = location.hash === '#/approve';
let S = null; // latest wallet state

/* ---------- helpers ---------- */

async function call(action, payload = {}) {
  const r = await chrome.runtime.sendMessage({ type: 'ui', action, ...payload });
  if (!r?.ok) throw new Error(r?.error?.message || 'Something went wrong.');
  return r.result;
}

// Builds DOM nodes with text nodes only, so dapp-supplied strings can never inject markup.
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function mount(...nodes) { app.replaceChildren(...nodes); }
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function errorLine() { return h('div', { class: 'err', role: 'alert' }); }
async function guarded(button, errEl, fn) {
  button.disabled = true;
  errEl.textContent = '';
  try { await fn(); } catch (e) { errEl.textContent = e.message; button.disabled = false; }
}

const LOGO = () => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<path d="M24 10h16l-3 10c10 5 17 14 17 24 0 10-10 16-22 16S10 54 10 44c0-10 7-19 17-24z" fill="#43244F"/>' +
    '<path d="M24 10h16" stroke="#E2B64A" stroke-width="3" stroke-linecap="round"/>' +
    '<path d="M25 20q7 5 14 0" fill="none" stroke="#E2B64A" stroke-width="3" stroke-linecap="round"/>' +
    '<path d="M32 33l7 11-7 11-7-11z" fill="none" stroke="#E2B64A" stroke-width="2.5" stroke-linejoin="round"/>';
  return svg;
};

const brand = () => h('div', { class: 'brand' }, (() => { const l = LOGO(); l.setAttribute('width', 24); l.setAttribute('height', 24); return l; })(), 'PolyGrisGris');

/* ---------- boot ---------- */

async function boot() {
  S = await call('state');
  if (!S.hasWallet) return welcome();
  if (!S.unlocked) return unlockScreen();
  if (isApproval) return approvalScreen();
  return home();
}

/* ---------- onboarding ---------- */

function welcome() {
  const hero = h('div', { class: 'hero' }, LOGO(), h('h1', {}, 'Your keys stay in the pouch.'),
    h('p', {}, 'A wallet for Ethereum and the chains built on it. Keys are encrypted on this device and never leave it.'));
  mount(
    hero,
    h('div', { class: 'spacer' }),
    h('button', { onclick: createScreen }, 'Create a wallet'),
    h('button', { class: 'ghost', onclick: importScreen }, 'Import a wallet'),
  );
}

function passwordFields() {
  const pw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'At least 8 characters' });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Repeat password' });
  const fields = [h('label', {}, 'Password', pw), h('label', {}, 'Confirm password', pw2)];
  const value = () => {
    if (pw.value.length < 8) throw new Error('Use a password with at least 8 characters.');
    if (pw.value !== pw2.value) throw new Error('The passwords do not match.');
    return pw.value;
  };
  return { fields, value };
}

function createScreen() {
  const { fields, value } = passwordFields();
  const err = errorLine();
  const go = h('button', {}, 'Create wallet');
  go.onclick = () => guarded(go, err, async () => {
    const { phrase } = await call('create', { password: value() });
    phraseScreen(phrase);
  });
  mount(brand(), h('h2', {}, 'Choose a password'),
    h('p', {}, 'It unlocks PolyGrisGris on this device. We cannot recover it for you.'),
    ...fields, err, h('div', { class: 'spacer' }), go, h('button', { class: 'link', onclick: welcome }, 'Back'));
}

function phraseScreen(phrase) {
  const ok = h('button', {}, 'I wrote it down');
  ok.onclick = async () => { await call('confirmBackup'); boot(); };
  mount(brand(), h('h2', {}, 'Your recovery phrase'),
    h('p', {}, 'These 12 words are the only way to restore your wallet. Write them on paper, in order, and keep them offline. Anyone who has them can take your funds.'),
    h('ol', { class: 'words' }, phrase.split(' ').map((w) => h('li', {}, w))),
    h('div', { class: 'spacer' }), ok);
}

function importScreen() {
  const phrase = h('textarea', { placeholder: 'twelve words separated by spaces', spellcheck: 'false', autocomplete: 'off' });
  const { fields, value } = passwordFields();
  const err = errorLine();
  const go = h('button', {}, 'Import wallet');
  go.onclick = () => guarded(go, err, async () => {
    await call('importWallet', { phrase: phrase.value, password: value() });
    boot();
  });
  mount(brand(), h('h2', {}, 'Import a wallet'), h('label', {}, 'Recovery phrase', phrase), ...fields, err,
    h('div', { class: 'spacer' }), go, h('button', { class: 'link', onclick: welcome }, 'Back'));
}

function unlockScreen() {
  const pw = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password', autofocus: 'true' });
  const err = errorLine();
  const go = h('button', {}, 'Unlock');
  const run = () => guarded(go, err, async () => { await call('unlock', { password: pw.value }); boot(); });
  go.onclick = run;
  pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  mount(h('div', { class: 'hero' }, LOGO(), h('h1', {}, 'Welcome back')), h('label', {}, 'Password', pw), err, h('div', { class: 'spacer' }), go);
  pw.focus();
}

/* ---------- home ---------- */

async function home() {
  const acct = S.accounts[S.selected];
  const bal = h('div', { class: 'balance' }, '…');
  call('balance').then((b) => bal.replaceChildren(b.display, h('small', {}, b.symbol)))
    .catch(() => bal.replaceChildren('—', h('small', {}, 'network unreachable')));

  const netSelect = h('select', { 'aria-label': 'Network', onchange: async (e) => { await call('switchNetwork', { chainId: Number(e.target.value) }); boot(); } },
    S.networks.map((n) => h('option', { value: n.chainId, selected: n.chainId === S.network.chainId }, n.name)));

  const copy = h('button', { class: 'icon', title: 'Copy address' }, 'Copy');
  copy.onclick = async () => { await navigator.clipboard.writeText(acct.address); copy.textContent = 'Copied'; setTimeout(() => (copy.textContent = 'Copy'), 1200); };

  const acctSelect = h('select', { 'aria-label': 'Account', onchange: async (e) => { await call('selectAccount', { index: Number(e.target.value) }); boot(); } },
    S.accounts.map((a) => h('option', { value: a.index, selected: a.index === S.selected }, `Account ${a.index + 1} · ${short(a.address)}`)));

  mount(
    h('div', { class: 'row between' }, brand(), h('div', { class: 'row' },
      h('button', { class: 'icon', onclick: settingsScreen }, 'Settings'),
      h('button', { class: 'icon', onclick: async () => { await call('lock'); boot(); } }, 'Lock'))),
    !S.backedUp && h('div', { class: 'banner' }, 'You have not confirmed a backup of your recovery phrase. ',
      h('button', { class: 'link', onclick: () => revealScreen() }, 'Back it up now')),
    h('div', { class: 'card stack' }, netSelect, bal),
    h('div', { class: 'card stack' }, acctSelect, h('div', { class: 'row between' }, h('span', { class: 'addr' }, acct.address), copy),
      h('button', { class: 'link', onclick: async () => { await call('addAccount'); boot(); } }, 'Add another account')),
    h('div', { class: 'spacer' }),
    h('button', { onclick: () => sendScreen() }, `Send ${S.network.symbol}`),
  );
}

function sendScreen() {
  const to = h('input', { placeholder: '0x…', spellcheck: 'false', autocomplete: 'off' });
  const amount = h('input', { placeholder: '0.0', inputmode: 'decimal' });
  const err = errorLine();
  const review = h('button', {}, 'Review');
  review.onclick = () => {
    err.textContent = '';
    if (!/^0x[0-9a-fA-F]{40}$/.test(to.value.trim())) { err.textContent = 'Enter a valid 0x address.'; return; }
    if (!(Number(amount.value) > 0)) { err.textContent = 'Enter an amount greater than zero.'; return; }
    confirmSend(to.value.trim(), amount.value.trim());
  };
  mount(brand(), h('h2', {}, `Send ${S.network.symbol}`), h('p', {}, `On ${S.network.name}.`),
    h('label', {}, 'Recipient', to), h('label', {}, `Amount (${S.network.symbol})`, amount), err,
    h('div', { class: 'spacer' }), review, h('button', { class: 'link', onclick: boot }, 'Cancel'));
}

function confirmSend(to, amount) {
  const err = errorLine();
  const go = h('button', {}, 'Send now');
  go.onclick = () => guarded(go, err, async () => {
    const r = await call('sendNative', { to, amount });
    mount(brand(), h('h2', { class: 'ok' }, 'Sent'), h('p', {}, 'Your transaction was submitted to the network.'),
      h('div', { class: 'card addr' }, r.hash),
      h('a', { href: r.explorer, target: '_blank', rel: 'noreferrer' }, 'View on block explorer'),
      h('div', { class: 'spacer' }), h('button', { onclick: boot }, 'Done'));
  });
  mount(brand(), h('h2', {}, 'Confirm'),
    h('dl', { class: 'kv card' }, h('dt', {}, 'Network'), h('dd', {}, S.network.name), h('dt', {}, 'To'), h('dd', { class: 'addr' }, to),
      h('dt', {}, 'Amount'), h('dd', {}, `${amount} ${S.network.symbol}`)),
    h('p', {}, 'The network fee is added when the transaction is sent. Transactions cannot be undone.'),
    err, h('div', { class: 'spacer' }), go, h('button', { class: 'link', onclick: sendScreen }, 'Back'));
}

/* ---------- settings ---------- */

function settingsScreen() {
  const sites = S.sites.length
    ? S.sites.map((o) => h('div', { class: 'row between' }, h('span', { class: 'addr' }, o),
      h('button', { class: 'icon', onclick: async () => { await call('disconnectSite', { origin: o }); S = await call('state'); settingsScreen(); } }, 'Disconnect')))
    : [h('p', { class: 'small' }, 'No sites are connected.')];
  mount(brand(), h('h2', {}, 'Settings'),
    h('div', { class: 'card stack' }, h('strong', {}, 'Connected sites'), ...sites),
    h('button', { class: 'ghost', onclick: () => revealScreen() }, 'Show recovery phrase'),
    h('div', { class: 'spacer' }), h('button', { class: 'link', onclick: boot }, 'Back'));
}

function revealScreen() {
  const pw = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
  const err = errorLine();
  const go = h('button', {}, 'Show phrase');
  go.onclick = () => guarded(go, err, async () => {
    const phrase = await call('exportPhrase', { password: pw.value });
    const done = h('button', {}, 'I wrote it down');
    done.onclick = async () => { await call('confirmBackup'); boot(); };
    mount(brand(), h('h2', {}, 'Your recovery phrase'), h('div', { class: 'warn small' }, 'Nobody from PolyGrisGris will ever ask for this. Make sure no one is watching your screen.'),
      h('ol', { class: 'words' }, phrase.split(' ').map((w) => h('li', {}, w))), h('div', { class: 'spacer' }), done);
  });
  mount(brand(), h('h2', {}, 'Confirm your password'), h('label', {}, 'Password', pw), err, h('div', { class: 'spacer' }), go,
    h('button', { class: 'link', onclick: boot }, 'Cancel'));
}

/* ---------- dapp approvals ---------- */

async function approvalScreen() {
  const p = await call('pending');
  if (!p) { mount(brand(), h('h2', {}, 'Nothing to approve'), h('button', { onclick: () => window.close() }, 'Close')); return; }

  const finish = async (approved) => { await call('resolve', { id: p.id, approved }); window.close(); };
  const site = h('div', { class: 'card' }, h('div', { class: 'small muted' }, 'Site'), h('div', { class: 'addr' }, p.origin));
  const reject = h('button', { class: 'ghost', onclick: () => finish(false) }, 'Reject');
  const approve = (label) => h('button', { onclick: () => finish(true) }, label);
  const actions = (label) => h('div', { class: 'row' }, reject, approve(label));

  if (p.kind === 'connect') {
    mount(brand(), h('h2', {}, 'Connect to this site?'), site,
      h('p', {}, 'It will be able to see your public address and ask you to approve transactions and signatures. It cannot move funds without your approval.'),
      h('div', { class: 'spacer' }), actions('Connect'));
  } else if (p.kind === 'tx') {
    const d = p.data;
    const hasData = d.data && d.data !== '0x';
    mount(brand(), h('h2', {}, 'Approve transaction'), site,
      h('dl', { class: 'kv card' }, h('dt', {}, 'Network'), h('dd', {}, p.network), h('dt', {}, 'To'), h('dd', { class: 'addr' }, d.to ?? 'New contract'),
        h('dt', {}, 'Amount'), h('dd', {}, `${d.value} ${d.symbol}`), hasData && h('dt', {}, 'Data'), hasData && h('dd', {}, h('pre', {}, d.data))),
      hasData && h('div', { class: 'warn small' }, 'This calls a smart contract. Only approve it if you trust this site and understand what it does.'),
      h('div', { class: 'spacer' }), actions('Send'));
  } else if (p.kind === 'sign') {
    mount(brand(), h('h2', {}, 'Sign message'), site,
      h('div', { class: 'card' }, h('pre', {}, p.data.text ?? p.data.hex)),
      p.data.text === null && h('div', { class: 'warn small' }, 'This is raw data that cannot be read as text. Only sign it if you trust this site.'),
      h('div', { class: 'spacer' }), actions('Sign'));
  } else if (p.kind === 'typed') {
    mount(brand(), h('h2', {}, 'Sign typed data'), site, h('div', { class: 'card' }, h('pre', {}, p.data.json)),
      h('div', { class: 'warn small' }, 'Signed data can authorize token transfers or approvals. Read it carefully.'),
      h('div', { class: 'spacer' }), actions('Sign'));
  } else {
    mount(brand(), h('h2', {}, 'Unknown request'), reject);
  }
}

boot().catch((e) => mount(h('p', { class: 'err' }, e.message)));
