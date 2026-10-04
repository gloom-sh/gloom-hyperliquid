# Verification and scope ledger

Private draft PR: https://github.com/gloom-sh/gloom-hyperliquid/pull/1

This ledger distinguishes implemented paths from live verification. No mainnet
signed request, real funds, existing wallet, seed phrase or Godel account was
used in development. The public builder address was checked read-only; its key
was never accessed. No paid API key or third-party project was created.

## Scope

| Area | Implementation | Verification / limit |
| --- | --- | --- |
| Live board | Done: default + all HIP-3 dexes, classes, favorites, position filter, search/sort and persisted liquidity filters | Mainnet and testnet live reads, shared WS soak and forced reconnect |
| Market view | Done: real candles/volume, live book aggregation/depth, tape, stats, position/order levels, market metadata | Live terminal and desktop screenshot renderers |
| Historical analytics | Client/UI done: cloud history, funding extremes, OI changes and premium rankings; no local recorder | Platform PR #626 contract fixtures pass. Routes currently return 404 and public host API lacks authenticated Cloud requests. Live Pro history remains blocked by those integrations |
| Venue predictions / cash comparison | Done: exactly labelled Hyperliquid venue predictions, dated matching-USD host cash quotes and underlying action | Mainnet predictions live; cash projection checks; unavailable quotes stay blank |
| Watch-only account | Done: live balances, collateral identities, account mode, positions, orders, fills, history, funding, ledger, fees and TWAP | Public vault with open positions, terminal interactions and both screenshot sizes |
| Wallet connection | Done: injected browser wallets, local API-wallet approval, main-wallet fee approval, configurable loopback port/token and full URL, secure native import and scripted approval | Loopback security tests and scripted testnet validation. No live browser wallet or hardware-wallet signing in development |
| Orders and management | Done: market/limit, TIF, conditional orders, entry/position TP/SL, scale, reduce-only, leverage/margin, modify/cancel, partial close/reverse/close-all | Precision/signing/risk/request tests and funded testnet lifecycle (results recorded below) |
| TWAP | Done: testnet venue TWAP; mainnet local capped IOC slices with builder fee, pause/resume/cancel and persisted journal | Offline schedule/restart/uncertainty/race tests. Mainnet local execution intentionally not run live |
| Funds | Done: main-wallet bridge deposit, withdraw3, spot/perp/dex transfer and unified-mode request | Typed-action tests; only throwaway testnet fund movements exercised. Real bridge deposit requires owner's later run |
| Safety | Done: region/attestation gates, confirmations, fat-finger warnings, per-market stale checks, exact sizes, buying power, idempotency/reconciliation and persistent nonces | Unit tests plus testnet. Portfolio-margin opening trades blocked; legal review of country policy remains an owner task |
| Host integration | Done: HLP primary with no PERP alias, separate panes, docked workspace, ticker action, catalog, headless and settings | Host collision search, fn/catalog, doctor and browser build |
| Documentation | Done: methodology, keys/storage, fees, risk, regions, headless commands and SSH | README, hyperliquid.md and headless-trading.md |

## Integration gaps

- `PERP` is reserved by the owner's GLO-220 coordination decision. It was absent
  from the checked host revision `90fc2a0024c1d86f723d4138ee241abd0341e27a`.
  A future action opening its history pane is a follow-up, not a plugin dependency.
- Gloom's public plugin API has no authenticated generic Cloud request method.
  `httpFetch` does not forward the current session. The history client accepts a
  supported injected transport; it never reads internal auth tokens. Until a
  public bridge exists, Pro history cannot work even after signing into this host.
- The screenshot host discards ordinary footer info for external panes and may
  classify setup forms/unavailable states as empty. Images are manually reviewed;
  live/stale/auth/testnet footer behavior is checked in the actual terminal.
- Host password fields include their raw value in remote semantic metadata.
  The plugin therefore has no renderer key field and no key-import capability;
  import is native CLI only through protected file/stdin.
- Portfolio margin opening orders are blocked. Standard and unified modes have
  separate collateral handling. WalletConnect is not included; injected
  EIP-1193/EIP-6963 wallets and scripted owner approval are supported.

## Security model

API keys prefer `Bun.secrets` (OS credential store), with a `0600` file fallback
inside a `0700` directory at `<dataDir>/hyperliquid/<network>/`. Mainnet and
testnet are isolated. Disconnect removes local keys; exchange revocation needs
the main wallet. Main-wallet keys used by `connect-key` are never persisted.
The loopback page sees only public API-wallet details, binds to `127.0.0.1`, uses
an unguessable token, checks host/origin context and expires after ten minutes.

Every signed trading intent gets a persistent record before submission. Unknown
outcomes are reconciled and never resent automatically. CLI writes require
explicit network, account, intent ID and confirmation. Local TWAP reuses these
checks for each slice and pauses across process restarts or uncertainty.

The official mainnet builder fee is 0.1% in addition to exchange fees, addressed
only through `src/trading/builder.ts`; testnet and invalid addresses skip it.
Guard and main-wallet approval tests cover this distinction.

## Evidence

Screenshots are under
`~/.local/state/gloom-pm/hyperliquid/shots/`, at 1280x540 and 720x360 for board,
market/ticket, positions, setup and funding analytics. Public account reads use
`0x010461c14e146ac35fe42271bdc1134ee31c703a`; no credentials are needed.

Live transport evidence is under
`~/.local/state/gloom-pm/hyperliquid/verification/market-{mainnet,testnet}-soak.jsonl`.
Earlier local-OI experimental artifacts in that directory are obsolete and are
not part of this implementation. Current history always comes from the cloud.

The isolated host checkout is `/tmp/gloom-hyperliquid-host` and its test profile
is `/tmp/gloom-hyperliquid-home/profile`. The shared host checkout was not edited.

Dependencies added: `@nktkas/hyperliquid` for the typed exchange protocol and
signing, `viem` for wallet interoperability and independently checked EIP-712,
and `decimal.js` for exact size/notional/scale arithmetic. Host and React stay
peer dependencies.

Final test counts, funded testnet results and cleanup status are appended after
the final validation run.
