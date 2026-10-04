# Hyperliquid for Gloom

A live perpetuals workspace for the terminal and desktop app: the default
Hyperliquid dex and every active HIP-3 dex, market charts and books, funding
and open interest, and self-custody order entry.

Private development build for GLO-217. No registry listing or release.

| Command | View |
| --- | --- |
| `HLP` | Market board |
| `HLP BTC`, `HLP TSLA`, `HLP xyz:TSLA` | Market, chart, book and ticket |
| `HLM BTC` | Separate market pane |
| `HLB BTC` | Separate order book |
| `HLA` | Positions, orders, fills, funding and balances |
| `HLF` | Funding and OI analytics |
| `HLS` | Watch-only account or wallet connection |

The command bar also offers **Open Hyperliquid trading workspace** for a
docked market and account layout, and ticker actions can open a matching perp.
`HLP` is the plugin command. The host reserves `PERP` for market history and
`HL` for Help.

```sh
gloomberb plugin link /path/to/gloom-hyperliquid
gloomberb plugin doctor hyperliquid
gloomberb fn HLP --json
gloomberb fn HLP xyz:TSLA --json
gloomberb fn HLP --network testnet --json
```

Market data and watch-only accounts need no key. Trading uses a local API wallet
approved by your browser wallet; the plugin never asks for a seed phrase.
See [connection, fees, risks and methodology](docs/hyperliquid.md).

The official build charges Gloom's **0.1% builder fee per mainnet fill**,
in addition to exchange fees. The main wallet approves this fee before trading.
Testnet always skips it.

[Headless connection and trading](docs/headless-trading.md) covers secure key
import, scripted approval, order preview, placement, cancellation and closing.

## Development

```sh
bun install
ln -s /path/to/gloomberb node_modules/gloomberb
ln -s /path/to/gloomberb/node_modules/react node_modules/react
bun run typecheck
bun test
```

The host and React are peers, linked exactly as Gloom's installer links them.
The desktop browser entry delegates account operations to the native capability;
market and account subscriptions share one WebSocket per network.

Development verification uses read-only mainnet and throwaway testnet keys only.
See [implementation boundaries](docs/implementation.md) for the verification plan.

## License

MIT
