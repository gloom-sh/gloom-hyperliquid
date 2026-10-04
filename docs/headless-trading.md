# Headless connection and trading

These commands run in the native process on the machine holding the local API
wallet. Every command requires an explicit `--network mainnet|testnet`. Results
are JSON; rejected and unknown trading outcomes exit nonzero. This guide is for
the account owner. Development verification never submits mainnet signed requests.

Use `gloomberb help hyperliquid` for the installed command reference. A custom
`GLOOMBERB_HOME` must contain a config whose `dataDir` points into that profile;
use the same profile for setup, trading and the app.

## Import an approved API wallet

Put an already approved API wallet's hexadecimal private key in a file owned by
your user with mode `0600`, inside a private directory. Do not put secrets in
shell arguments, shell history, environment variables, pane fields or JSON
capability requests. Symlinks and group/world-readable files are rejected. The
plugin never accepts a recovery phrase.

```sh
gloomberb hyperliquid import-key --network testnet \
  --key-file /private/path/trading.key --address 0xYOUR_ACCOUNT_ADDRESS \
  --yes --acknowledge-risk --eligible
```

Alternatively pipe from a trusted secret source to `--key-stdin`. Do not use a
literal `echo PRIVATE_KEY` command. Interactive stdin is refused because it
would echo. Import validates the API-wallet role, account and expiry against the
selected exchange. A main-wallet key cannot be imported as a trading key.

## Approve from a script without a browser wallet

`connect-key` reads the **main wallet's key**, generates a separate API wallet
locally, and signs its approval. The main key is kept in memory only and is not
stored or sent to the desktop renderer. The API key is saved using the normal
OS keychain/owner-only-file storage. Run only with your own fresh wallet and
read Hyperliquid's terms first.

```sh
gloomberb hyperliquid connect-key --network testnet \
  --key-file /private/path/main-wallet.key \
  --yes --acknowledge-risk --eligible
```

On mainnet this also asks the main wallet to approve Gloom's **0.1% builder fee**
(maxFeeRate `0.1%`, f=100), in addition to exchange fees, for
`0x84085f25eDDdFc86D8b66343f97D68e4D5Bd1096`. The command prints this disclosure
before signing. Testnet skips builder approval and fees. It never signs as the
builder. Region lookup and restricted-person/risk checks still apply. Failed or
uncertain approval is not retried automatically; inspect status before retrying.

For a browser wallet on another machine, keep this command running:

```sh
gloomberb hyperliquid connect --network testnet --approval-port 8765 \
  --yes --acknowledge-risk --eligible
```

Forward `ssh -N -L 8765:127.0.0.1:8765 server` and open the full printed token URL
in the local browser. The server binds only to `127.0.0.1`. `wallet --yes` opens
management for an existing connection. Ctrl+C closes the short-lived page.

## Preview, place, cancel and close

Inspect the local public connection and account first:

```sh
gloomberb hyperliquid status --network testnet
gloomberb hyperliquid account --network testnet
```

Preview a small order using a price you select from the live market. The example
price is deliberately illustrative; replace it with an appropriate price and
review the output's notional, margin, fees, warnings and errors before sending.
A post-only order can still fill after it rests. Hyperliquid generally requires
at least $10 notional; rounding may put an exact $10 request below the minimum.

```sh
gloomberb hyperliquid preview --network testnet --market BTC \
  --side buy --kind limit --price 10000 --size 20 --unit usd \
  --tif Alo --leverage 1

gloomberb hyperliquid order --network testnet --market BTC \
  --side buy --kind limit --price 10000 --size 20 --unit usd \
  --tif Alo --leverage 1 --address 0xYOUR_ACCOUNT_ADDRESS \
  --client-id trial-entry-001 --yes
```

The account address must match the local connection. Use a stable, unique client
intent ID per action. Reuse the **same** ID to reconcile an uncertain response;
do not invent another ID or blindly repeat a command after timeout. An accepted
response does not mean a full fill. Inspect its individual statuses and the
account's Orders/Fills. The service never retries signed requests automatically.

Cancel the returned numeric order ID (replace `123456`):

```sh
gloomberb hyperliquid cancel --network testnet --oid 123456 \
  --address 0xYOUR_ACCOUNT_ADDRESS --client-id trial-cancel-001 --yes
```

`--all --market BTC` explicitly cancels all open BTC orders; `--all` cancels all
open orders. For an actual position, close with a capped IOC order:

```sh
gloomberb hyperliquid close --network testnet --market BTC --kind market \
  --percent 100 --slippage-bps 50 --address 0xYOUR_ACCOUNT_ADDRESS \
  --client-id trial-close-001 --yes
```

Closing is reduce-only. A slippage cap does not guarantee a fill; inspect the
remaining position afterward. A limit close needs `--kind limit --price PRICE`.
For the owner's later real round trip, change the network only after reviewing
the builder fee, account, market, price and amount; these examples themselves
were not executed on mainnet. The CLI covers market/limit entry and management;
conditional orders, scale and TWAP are available in the pane ticket.

## Disconnect

```sh
gloomberb hyperliquid disconnect --network testnet --yes
```

This deletes the local API-wallet credential. It does not revoke the exchange
approval; use wallet management to revoke with the main wallet before deleting
local access. Never use a leaked/reused seed or any address derived from it.
