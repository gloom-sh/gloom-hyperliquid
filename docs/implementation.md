# Hyperliquid implementation

Tracking: GLO-217. The plugin remains private and is not registered or released.

## Integration boundary

`HLP [market]` opens the market board or a market. The host owns `PERP` and
already uses `HL` as an alias. Plugin pane and template IDs use `hyperliquid-`.
`HLM`, `HLB`, `HLA`, `HLF`, and `HLS` open the market, book, account, analytics,
and connection panes. A future action can open the built-in `PERP` view once
that function is available; this plugin has no dependency on it.

## Architecture

- One market service per network shares REST scheduling and a reference-counted
  WebSocket across panes. Asset contexts supply marks; midpoints stay separate.
  Open-interest history consists only of locally observed five-minute snapshots.
- Pure order and risk calculations are renderer-neutral. The maintained
  `@nktkas/hyperliquid` SDK handles typed exchange actions and signing, with
  `viem` for wallet interoperability. Both are MIT licensed.
- A native capability owns credentials and exchange submission. The desktop
  renderer calls it over the host's capability bridge. Browser bundles do not
  import native modules or store trading credentials.
- A short-lived loopback page presents the public API-wallet address to the
  user's injected browser wallet. The user's main wallet signs approvals and
  fund movements. The trading key stays on the machine.
- Mainnet and testnet credentials and acknowledgements are separate. Builder
  fees default to zero. Region failures block signing, never market data.

## Verification constraints

Development uses mainnet reads and testnet throwaway keys only. No mainnet
signed request, real funds, existing wallet, or Godel account is used. Host
execution uses a detached throwaway worktree and isolated HOME/profile. Test
evidence, screenshot review, scope coverage, and remaining decisions are recorded
in the final verification report.
