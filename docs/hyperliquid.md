# Hyperliquid perpetuals

`HLP` opens all active markets. A market argument opens its chart,
book, trades and ticket. A fully qualified name such as `xyz:TSLA` identifies one
dex unambiguously. A plain ticker prefers the default crypto market, then the most
liquid matching builder market. Delisted markets are excluded without changing
their exchange asset IDs.

## Market numbers

| Number | Definition |
| --- | --- |
| Mark | Hyperliquid's mark price, used for margin and unrealized PnL |
| Oracle | The exchange-reported reference price for that specific contract |
| Mid | Best bid/ask midpoint, kept separate from the mark |
| Premium | `mark / oracle - 1`, not a dated-futures basis |
| Rolling 24h | `mark / prevDayPx - 1`, not the change since UTC midnight |
| Current / 1h funding | Current hourly funding rate; positive means longs pay shorts |
| Current / 8h funding | Hourly rate multiplied by eight, not a payment interval |
| Simple APR | Hourly rate multiplied by 8,760, without compounding or a forecast |
| Historical funding | Server-observed funding from Gloom Cloud, separate from account paid-funding ledger |
| OI coin | Open interest in units of the contract |
| OI USD | OI coin multiplied by mark at the observation time |
| 24h volume | Exchange-reported notional traded volume |
| OI / volume | OI USD divided by 24h notional volume |

Hyperliquid pays funding hourly. The countdown points to the next UTC hour;
rates can change before that payment. HIP-3 funding multipliers and contract
rules can differ. The market information view includes available margin tiers,
collateral, maximum leverage and isolated-only restrictions. Price precision uses
Hyperliquid's five significant figures and `6 - szDecimals` decimal limit;
integer prices are exempt from the significant-figure limit. Size rounds down
to `szDecimals`.

**Predicted funding** is Hyperliquid's `predictedFundings` report of rates at
named venues. The reported interval is retained, and 8h/APR values normalize
that interval. The plugin does not connect to those venues or claim that these
are independently verified executable spreads.

**Historical funding, OI and premium** come from Gloom Cloud's
`/cloud/perps/history` and `/cloud/perps/rankings`. History starts when the server
began recording each market, with gaps retained. OI changes keep coin and USD
changes separate; price moves alone can change USD OI. Full history requires Pro.
The plugin keeps no local historical database. Live charts and current prices
continue directly from Hyperliquid when cloud history is unavailable.

The current host plugin API cannot forward its authenticated Cloud session to
these new routes. Anonymous ranking previews are supported where deployed;
history shows an explicit host-integration unavailable state. A supported host
transport can be injected when that API is exposed. Signing into Gloom alone
does not fix the missing transport in this host version.

**Cash comparisons** use the host's existing quote API for a known underlying
equity or index. A dated cash close is preferred outside its regular session;
otherwise the last reported cash price is shown with its observation time. Only
matching USD quotes are compared. These observations can have different clocks
from the 24/7 perp; the label and date stay visible. An unavailable host quote
does not cause a scrape or a substitute price.

Asset classes follow the exchange's contract categories, with conservative
fallbacks. Private-company and pre-IPO contracts do not acquire a fictitious
listed-equity price. Every dex retains its own collateral identity: USDC, USDH,
USDE and USDT0 are not pooled as if they were the same token.

## Connections and keys

Market data works without an account. **Watch-only** accepts a public address and
shows its positions, orders, fills and balances without a key or region gate.

**Connect wallet** generates a local trading API wallet. A short-lived page at
`127.0.0.1` lists injected browser wallets through EIP-6963 and the legacy
EIP-1193 interface. The browser wallet signs the trading approval directly with
Hyperliquid. Only the API wallet's public address reaches the page; its private
key stays in the native process. The approval lasts up to 90 days and the pane
shows its expiry. An expired approval requires connection again.

The [native headless commands](headless-trading.md) import an already approved
API wallet key and account address from an owner-only file or piped stdin.
There is no key field in the pane. The import command rejects main-wallet keys;
a separate explicit `connect-key` command lets the owner approve a generated
API wallet from a script without storing the main-wallet key. Never use a seed
phrase. An imported key must be recognized as approved for that account.

Storage first uses `Bun.secrets`, backed by the operating system's credential
store. When it is unavailable, the key is stored at
`<Gloom dataDir>/hyperliquid/<mainnet|testnet>/api-wallet.key` with permissions
`0600`, inside a `0700` directory. Public connection metadata, a monotonic nonce
and order reconciliation records live beside it. The desktop renderer receives
public status and account state over the native capability bridge, never a
stored private key. Credentials are never placed in a shared layout.

**Disconnect** removes the local credential and connection metadata. To revoke
the on-chain approval as well, use **Wallet** before disconnecting and sign
**Revoke trading approval** in the main wallet. Local deletion cannot revoke an
on-chain approval by itself. Keep machine access and backups secure: an API
wallet cannot withdraw, but it can trade and lose collateral.

### Headless host and SSH tunnel

Set **Wallet approval port** to an unused port, for example `8765`, in plugin
settings. The default `0` selects a random port. The native service also accepts
`GLOOM_HYPERLIQUID_APPROVAL_PORT`. The wallet pane always shows the full URL,
including its random token, even if a browser cannot be opened on the host.

```sh
ssh -N -L 8765:127.0.0.1:8765 your-server
```

Open the displayed `http://127.0.0.1:8765/<random-token>` URL in the local machine's
wallet browser. Forward the same port on both ends. The page binds only to
`127.0.0.1`, rejects unexpected hosts/origins, and expires after ten minutes.
The token grants access to that temporary local page; do not share it.

## Funds and collateral

Deposits, withdrawals, collateral transfers and account-mode changes are signed
by the main browser wallet, not by the API wallet. The page supports USDC
deposits through Hyperliquid's Arbitrum bridge, withdrawals to the connected
wallet, spot/perp USDC transfers and named-dex collateral transfers. It does
not silently swap collateral tokens. The bridge's minimum deposit and withdrawal
fee are disclosed before signing.

Standard accounts keep collateral per dex. Unified accounts share eligible
collateral by token; the account pane names the detected mode. Opening new
positions in portfolio-margin mode is currently blocked because its risk-weighted
collateral requires an exchange-specific margin solver. Existing positions and
reduce-only management remain available.

## Orders and fees

Market orders are IOC limits with a configurable slippage cap; a fill is not
guaranteed. Limit orders support GTC, post-only ALO and IOC. Stop and take-profit
orders support market or limit execution. Attached TP/SL uses `normalTpsl`;
position protection uses `positionTpsl`. TWAP and scale orders retain their own
size and duration validation. A partial fill or a rejected child order remains
an exchange outcome to inspect, not a successful full execution.

The ticket keeps the everyday path on screen: side, Market, Limit or Stop
(stop limit, take-profit, scale and TWAP are under **More**), the size in USD
or coin, and one button that names the action or says why it cannot act yet.
The 25, 50, 75 and 100% buttons size the order as a share of buying power at
the chosen leverage, or of the position when reduce only is on.
Leverage sits under the order types: drag or click its track, step it with
`-` and `+`, type a number, or pick a common value (1x up to the market's
maximum); Cross or Isolated is beside the common values. The order sets the
leverage and margin mode on the account when it is placed. With an open
position at another leverage or mode, **Apply 10x** appears and sets them
right away, after the same confirmation.
TP/SL (as a price or as a % distance from the entry price), reduce only and
time in force are under **Advanced**, which each pane remembers open or closed.
In a wide pane the order figures, this market's position and its nearest open
orders sit beside the inputs.

From the keyboard, Tab, Shift+Tab, `j` and `k` walk the ticket's controls.
Left and Right switch the side, order type, margin mode, size unit, percentage
and time in force, and step the leverage (Shift+Left and Shift+Right jump
between the common values); digits type a leverage. Enter or Space opens More
and Advanced, toggles reduce only and presses Apply and the action button;
Enter in the leverage applies it where Apply shows, Enter in another field
submits, and Esc leaves the ticket's controls.

Ticket estimates include size rounding, margin, maker/taker fees and visible
book slippage. The average fill and slippage appear only when a market order
moves the price noticeably. Estimated liquidation is shown only where the
isolated-position calculation is supported; existing positions use the
exchange's liquidation price. A cross-margin account has shared risk and is not
represented by a single-position liquidation guess.

On the chart, open orders are quieter lines in the side's colour drawn over the
candles (translucent on the desktop); the position's entry and liquidation keep
full strength.

The official Gloom builder fee is **0.1% (10 basis points) per perp fill**, in
addition to exchange fees. The address and `f = 100` live in
`src/trading/builder.ts`. The official builder is
`0x84085f25eDDdFc86D8b66343f97D68e4D5Bd1096`. Invalid, placeholder and zero
addresses disable both the fee and its approval. Testnet always skips builder
fees. The approval page discloses
the fee before the main wallet signs a maximum **0.1%** approval, the ticket says
**including Gloom's 0.1% builder fee**, and the wallet page offers revocation.
Hyperliquid's native TWAP action does not accept builder fees. Mainnet TWAP
therefore runs locally as capped IOC slices, each with the same builder fee.
Keep Gloom running: shutdown or restart pauses remaining slices, and resuming
requires an explicit action. Unknown execution outcomes pause the schedule and block resumption;
inspect Orders and Fills, then cancel that uncertain schedule before creating a
new intent for any remaining quantity. Cancel stops future slices but cannot undo one
already submitted. Testnet uses the venue's native TWAP. The ticket discloses
this difference before submission.

Order confirmations are configurable. Size and distance-from-mark guards require
explicit confirmation. Stable client order IDs, a persisted monotonic nonce and
an intent journal protect submissions. A timeout is an unknown outcome: the
plugin queries order status and never automatically resends a signed request.

## Regions and risk

Trading requires a first-run risk and restricted-person acknowledgement plus a
recent region lookup. A failed lookup blocks trading and leaves data available.
The jurisdiction policy is centralized in `src/trading/regions.ts`. Country-only
location cannot establish Ontario or sanctioned subregions, so the initial
policy blocks Canada and Ukraine conservatively pending legal guidance, along
with the United States and configured sanctioned jurisdictions. Citizenship and
entity restrictions also require the user's attestation; an IP check alone does
not establish eligibility. Do not use a VPN to evade restrictions.

Leverage can liquidate collateral. Exchange, oracle, deployer, bridge, network,
token and local-key risks remain with the user. HIP-3 liquidity and oracle
quality vary widely. Minimum volume/OI filters help identify liquidity but do
not guarantee executable prices or protect against losses.

## Network access

Historical analytics use `api.gloom.sh`. Live data and signed exchange actions go directly to `api.hyperliquid.xyz` or
`api.hyperliquid-testnet.xyz`; region checks use `www.cloudflare.com`. The local
approval page is served only on `127.0.0.1`. Browser wallets use their own RPC
for Arbitrum transactions. The plugin has no analytics SDK, custodian,
third-party authentication service or required API key. WalletConnect is not
included; use an injected EIP-1193/EIP-6963 wallet.

Reference: [Hyperliquid API documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api),
[funding](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding),
[terms](https://app.hyperliquid.xyz/terms).
