# PolyGrisGris

A self-custody wallet browser extension for Ethereum and EVM chains (Manifest V3, Chromium 111+).

## Build and load

```bash
npm install
npm run build
```

Then open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and select the `dist/` folder.

## What works

- Create or import a 12-word wallet; multiple accounts from one phrase (m/44'/60'/0'/0/i)
- Recovery phrase encrypted at rest (PBKDF2-SHA256, 600k iterations, AES-256-GCM); auto-lock after 15 minutes
- Networks: Ethereum, Polygon, Base, Arbitrum, Optimism, Sepolia
- Send the native coin from the popup
- dApp support: EIP-1193 provider, EIP-6963 discovery, `window.ethereum` (only if no other wallet has claimed it)
- Approval windows for: connect, `eth_sendTransaction`, `personal_sign`, `eth_signTypedData_v3/v4`
- Per-site connections, revocable in Settings

## Deliberately not supported yet

`eth_sign` and `eth_signTransaction` (blind-signing risk), `wallet_addEthereumChain`, subscriptions, ERC-20/NFT views, hardware wallets, transaction history, gas controls.

## Before real funds

This is an unaudited prototype. Get an independent security review first, and at minimum:

- Replace public RPC endpoints with your own (and update `host_permissions`)
- Add transaction simulation and phishing/contract warnings
- Add gas estimation and fee display in the approval screen
- Add a Firefox build (needs `world: "MAIN"` support, Firefox 128+)
