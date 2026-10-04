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
| Historical analytics | Partial, awaiting host/server integration: client/UI implements cloud history, funding extremes, OI changes and premium rankings; no local recorder | Platform PR #626 contract fixtures pass. Routes currently return 404 and public host API lacks authenticated Cloud requests. Live Pro history remains blocked by those integrations |
| Venue predictions / cash comparison | Done: exactly labelled Hyperliquid venue predictions, dated matching-USD host cash quotes and underlying action | Mainnet predictions live; cash projection checks; unavailable quotes stay blank |
| Watch-only account | Done: live balances, collateral identities, account mode, positions, orders, fills, history, funding, ledger, fees and TWAP | Public vault with open positions, terminal interactions and both screenshot sizes |
| Wallet connection | Done: injected browser wallets, local API-wallet approval, main-wallet fee approval, configurable loopback port/token and full URL, secure native import and scripted approval | Loopback security tests and scripted testnet validation. No live browser wallet or hardware-wallet signing in development |
| Orders and management | Done: market/limit, TIF, conditional orders, entry/position TP/SL, scale, reduce-only, leverage/margin, modify/cancel, partial close/reverse/close-all | Precision/signing/risk/request tests and funded testnet lifecycle (results recorded below) |
| TWAP | Done: testnet venue TWAP; mainnet local capped IOC slices with builder fee, pause/resume/cancel and persisted journal | Offline schedule/restart/uncertainty/race tests. Mainnet local execution intentionally not run live |
| Funds | Implemented; bridge execution partially verified: main-wallet deposit, withdraw3, spot/perp/dex transfer and unified-mode request | Typed-action checks. The single testnet withdraw3 attempt was rejected by the bridge with no debit. Real bridge deposit/withdrawal and browser signing remain for the owner |
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
outcomes are reconciled and never resent automatically. Signed CLI order-management commands require
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

## Validation results (2026-10-04)

- `bun run typecheck`: passed.
- `bun test`: 74 passed, 343 assertions, zero failures across nine files.
- `gloomberb plugin doctor hyperliquid`: all checks passed, including the desktop
  browser entry (343 KB at this revision).
- `fn HLP BTC --json`: real market and order book, with the explicit Cloud
  history-unavailable result. `fn HLP --network testnet --limit 5 --json`:
  complete, five rows, no errors. Catalog contains HLP/HLM/HLB/HLA/HLF/HLS.
- Mainnet transport soak: more than three minutes, 98 board and 134 detail
  updates, nine mark changes; forced reconnect recovered in about 1.3 seconds.
  Testnet: more than three minutes, 92 board and 130 detail updates, seven mark
  changes; recovered in about 1.24 seconds. Sockets stopped after disposal.
- Terminal: HLP BTC, chart/book/ticket, keyboard wallet navigation, public
  watch-only account with 177 positions, and mainnet/testnet switching verified.
  A false account-change race discovered here was fixed and retested. Footer
  status, TESTNET and watch-only indicators were visible. Bounded logs contained
  no React hook/update-depth/listener warnings. Our tmux session was stopped.
- All 13 screenshots were opened and reviewed: five required views at both
  sizes, plus compact ticket and both predicted-funding views. Cloud history
  shows its true unavailable state; predicted-funding tables use live data.

## Funded testnet evidence

Only the generated throwaway account
`0x3dD36eb4677E32b42EA46dB1C936DDDBbfbf0459` was used. The owner supplied 499 mock
USDC after the unsigned faucet rejected the address for lacking mainnet history.
Testnet skips builder fees and builder approval.

The service lifecycle passed approveAgent, ALO limit, modify, cancel, a BTC market
fill with attached TP/SL, position-level TP/SL, cancellation of both bracket
variants, 50% close, reverse and close-all. That phase ended with zero positions,
orders and TWAPs. The native CLI separately passed connect-key from a protected
file, resting order, cancellation, market fill and full close; every command
exited zero. Its account finished flat with 498.942231 mock USDC at that checkpoint.

Public evidence lives under
`~/.local/state/gloom-pm/hyperliquid/verification/testnet-wallet-p80HTX/`:
`funded-evidence.json` and `cli-evidence.json`. These supersede the earlier
unfunded-only evidence. Generated testnet credentials remain in owner-only files
in the isolated test directories, outside the repository. No production key was
created or accessed.

Mainnet signed behavior, browser/hardware-wallet signing and real bridge deposits
remain for the owner's later fresh-wallet round trip. The builder address is
already configured; no mainnet key needs to be supplied to development. A legal
review of the conservative region list and public Cloud auth transport remain
follow-ups.


Additional funded checks passed isolated margin add/remove, leverage changes,
two-leg scale orders and cancellation, standalone stop-limit/TP-limit orders and
cancellation, and native TWAP start/cancel (its first fill was closed). The local
persisted scheduler sent two real testnet IOC fills of 0.00018 BTC each with a
controlled test clock, paused after restart, required explicit resume, and then
closed the combined 0.00036 BTC position. This verifies scheduler execution and
restart behavior; it is not a full-duration mainnet execution test.

The actual `import-key` command passed using the already-approved generated key
from an owner-only file, including exchange expiry verification. No secret was
printed. The single `withdraw3` request for 2 mock USDC to the same throwaway
address received the definitive exchange error `Error withdrawing from bridge`;
there was no debit or withdrawal ledger entry. It was not retried.

Final independent REST and WebSocket checks at **2026-10-04 00:56:23 UTC** showed
**498.881492 mock USDC, zero positions, zero open orders and zero active TWAPs**.
All verification helpers exited. Our tmux sessions and screenshot processes were
stopped; no shared checkout or unrelated processes were changed.

Additional public evidence files in the same owner-only verification directory:
`extra-evidence.json`, `local-twap-evidence.json`, `import-evidence.json`,
`withdraw-evidence.json`, and `final-evidence.json`. The older
`trading-security.md` summary has been updated to point to these funded results.

2026-10-04 close regression: reproduced the idle-stop race with a 17-second testnet collateral delay; fixed CLI/pane close, close-all and exact percentage sizing; three full BTC closes, 50% close, limit close/cancel and delayed close-all during pane removal passed; final REST/WS checks show zero positions/orders/TWAPs (498.560973 mock USDC); typecheck, 84 tests/413 assertions and doctor pass; evidence: `close-matrix-fixed.json`, `closeall-regression.json`, `close-final-evidence.json` in the same verification directory.

2026-10-04 CLI rate-limit regression: catalog failures/empty results retain their real cause; info reads make up to three HTTP 429 attempts with backoff and Retry-After, while signed sends remain single-attempt; offline tests cover recovery, exhaustion, cancellation and preview/order/close errors; typecheck, 95 tests/483 assertions and doctor pass; no UI files changed or mainnet signed requests sent.
