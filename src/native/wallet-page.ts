import { createHash, randomBytes } from "node:crypto";
import { WALLET_TYPES } from "../trading/wallet-actions";
import type {
  Address,
  Network,
  TradingSettings,
  WalletSession,
} from "../trading/types";

interface WalletPageConfig {
  network: Network;
  agentAddress?: Address;
  agentName?: string;
  address?: Address;
  expiresAt: number;
  builder?: TradingSettings["builder"];
  types: typeof WALLET_TYPES;
  api: string;
  tokenPath: string;
}
/** This function is serialized locally. It receives public addresses only, never private keys. */
function walletBrowser(config: WalletPageConfig) {
  const get = (id: string) => document.getElementById(id)!;
  const status = get("status");
  const wallets = new Map<string, { name: string; provider: any }>();
  let provider: any;
  let account = "";
  let pending = false;
  const say = (message: string) => {
    status.textContent = message;
  };
  const value = (id: string) => (get(id) as HTMLInputElement).value.trim();
  const addWallet = (id: string, name: string, p: any) => {
    if (wallets.has(id)) return;
    wallets.set(id, { name, provider: p });
    const option = document.createElement("option");
    option.value = id;
    option.textContent = name;
    (get("wallets") as HTMLSelectElement).append(option);
  };
  window.addEventListener("eip6963:announceProvider", (event: any) =>
    addWallet(
      event.detail.info.uuid,
      event.detail.info.name,
      event.detail.provider,
    ),
  );
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  if ((window as any).ethereum)
    addWallet("injected", "Browser wallet", (window as any).ethereum);
  const run = (fn: () => Promise<void>) => async () => {
    if (pending) return;
    pending = true;
    for (const b of document.querySelectorAll("button")) b.disabled = true;
    try {
      if (Date.now() > config.expiresAt)
        throw new Error("This page expired. Open Wallet again in Gloom.");
      const region = await fetch(config.tokenPath + "/region", {
        cache: "no-store",
      }).then((r) => r.json());
      if (!region.allowed)
        throw new Error(region.reason || "Trading unavailable.");
      await fn();
    } catch (error) {
      say(error instanceof Error ? error.message : "Wallet request failed.");
    } finally {
      pending = false;
      for (const b of document.querySelectorAll("button")) b.disabled = false;
    }
  };
  const connect = async () => {
    provider = wallets.get(value("wallets"))?.provider;
    if (!provider)
      throw new Error(
        "Enable an injected browser wallet, then reload this page.",
      );
    const addresses = await provider.request({ method: "eth_requestAccounts" });
    account = String(addresses[0]).toLowerCase();
    if (config.address && account !== config.address.toLowerCase())
      throw new Error("Select the account connected to Gloom.");
    get("account").textContent = account;
  };
  const amount = () => {
    const a = value("amount");
    if (!/^\d+(\.\d{1,6})?$/.test(a) || Number(a) <= 0)
      throw new Error("Enter a positive amount, with at most six decimals.");
    return a;
  };
  const sign = async (
    type: keyof typeof config.types,
    fields: Record<string, unknown>,
  ) => {
    await connect();
    const signatureChainId = String(
      await provider.request({ method: "eth_chainId" }),
    );
    const nonce = Date.now(),
      action = {
        type,
        signatureChainId,
        hyperliquidChain: config.network === "testnet" ? "Testnet" : "Mainnet",
        ...fields,
        ...(type === "withdraw3" ? { time: nonce } : { nonce }),
      };
    const types = config.types[type];
    const domain = {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: Number(signatureChainId),
      verifyingContract: "0x0000000000000000000000000000000000000000",
    };
    const typed = {
      domain,
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        ...types,
      },
      primaryType: Object.keys(types)[0],
      message: action,
    };
    say("Review the request in your wallet.");
    const signature: string = await provider.request({
      method: "eth_signTypedData_v4",
      params: [account, JSON.stringify(typed)],
    });
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature))
      throw new Error("Unsupported wallet signature.");
    const recovery = parseInt(signature.slice(130, 132), 16);
    const response = await fetch(config.api + "/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        nonce,
        signature: {
          r: signature.slice(0, 66),
          s: "0x" + signature.slice(66, 130),
          v: recovery < 27 ? recovery + 27 : recovery,
        },
      }),
    });
    const result = await response.json();
    if (!response.ok || result.status !== "ok")
      throw new Error(
        typeof result.response === "string"
          ? result.response
          : "Hyperliquid rejected the request.",
      );
    say("Accepted by Hyperliquid. Gloom will update automatically.");
  };
  get("connect").onclick = run(async () => {
    await connect();
    say("Wallet connected. Review the action you want to perform.");
  });
  get("approve").onclick = run(async () => {
    if (!config.agentAddress)
      throw new Error("Open Connect wallet in Gloom first.");
    if (!(get("risk") as HTMLInputElement).checked)
      throw new Error("Read and acknowledge the trading risks first.");
    await sign("approveAgent", {
      agentAddress: config.agentAddress.toLowerCase(),
      agentName: config.agentName,
    });
    if (config.builder)
      await sign("approveBuilderFee", {
        maxFeeRate: "0.1%",
        builder: config.builder.address.toLowerCase(),
      });
  });
  get("revoke").onclick = run(async () => {
    if (!config.agentName)
      throw new Error(
        "Imported API wallets must be revoked in Hyperliquid using their original name.",
      );
    await sign("approveAgent", {
      agentAddress: "0x0000000000000000000000000000000000000000",
      agentName: config.agentName,
    });
    say(
      "Trading approval revoked. Disconnect in Gloom to remove the local key.",
    );
  });
  get("fee").onclick = run(async () => {
    if (!config.builder) throw new Error("No builder fee is configured.");
    await sign("approveBuilderFee", {
      maxFeeRate: "0%",
      builder: config.builder.address.toLowerCase(),
    });
  });
  get("withdraw").onclick = run(async () => {
    await connect();
    const a = amount();
    if (Number(a) <= 1)
      throw new Error("Withdrawal must exceed the 1 USDC bridge fee.");
    if (
      !confirm(
        "Withdraw " +
          a +
          " USDC to " +
          account +
          " on Arbitrum? The bridge charges a 1 USDC fee.",
      )
    )
      return;
    await sign("withdraw3", { destination: account, amount: a });
  });
  get("deposit").onclick = run(async () => {
    await connect();
    const a = amount();
    if (Number(a) < 5)
      throw new Error(
        "Minimum bridge deposit is 5 USDC. Smaller deposits are lost.",
      );
    const chainId = config.network === "testnet" ? "0x66eee" : "0xa4b1";
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId }],
    });
    const actual = await provider.request({ method: "eth_chainId" });
    if (BigInt(actual) !== BigInt(chainId))
      throw new Error("Wrong wallet network.");
    const bridge =
      config.network === "testnet"
        ? "0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89"
        : "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7";
    const token =
      config.network === "testnet"
        ? "0x1baAbB04529D43a73232B713C0FE471f7c7334d5"
        : "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
    const [whole, decimal = ""] = a.split(".");
    const units = BigInt(whole!) * 1_000_000n + BigInt(decimal.padEnd(6, "0"));
    if (
      !confirm(
        "Deposit " +
          a +
          " USDC from " +
          account +
          " using the Arbitrum bridge?",
      )
    )
      return;
    const tx = await provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: account,
          to: token,
          data:
            "0xa9059cbb" +
            bridge.slice(2).toLowerCase().padStart(64, "0") +
            units.toString(16).padStart(64, "0"),
          value: "0x0",
        },
      ],
    });
    say(
      "Submitted to Arbitrum: " +
        tx +
        ". Wait for confirmation and the Gloom balance update.",
    );
  });
  get("transfer").onclick = run(async () => {
    await connect();
    const a = amount(),
      source = value("source"),
      destination = value("destination");
    if (source === destination)
      throw new Error("Choose different source and destination balances.");
    if (
      !confirm(
        "Transfer " +
          a +
          " " +
          value("token") +
          " from " +
          source +
          " to " +
          destination +
          "?",
      )
    )
      return;
    if (
      (source === "spot" && destination === "perp") ||
      (source === "perp" && destination === "spot")
    ) {
      if (value("token") !== "USDC")
        throw new Error(
          "Spot/perp transfer supports USDC here. Use a dex transfer for another token.",
        );
      await sign("usdClassTransfer", {
        amount: a,
        toPerp: destination === "perp",
      });
    } else
      await sign("sendAsset", {
        destination: account,
        sourceDex: source === "perp" ? "" : source,
        destinationDex: destination === "perp" ? "" : destination,
        token: value("token"),
        amount: a,
        fromSubAccount: "",
      });
  });
  get("unify").onclick = run(async () => {
    await connect();
    if (
      !confirm(
        "Enable unified account mode? Spot collateral will back eligible perpetual positions. Review Hyperliquid margin rules before continuing.",
      )
    )
      return;
    await sign("userSetAbstraction", {
      user: account,
      abstraction: "unifiedAccount",
    });
  });
}
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function startWalletPage(options: {
  network: Network;
  agentAddress?: Address;
  agentName?: string;
  address?: Address;
  builder?: TradingSettings["builder"];
  approvalPort?: number;
  checkRegion: () => Promise<{ allowed: boolean; reason?: string }>;
}): WalletSession & { close: () => void } {
  const token = randomBytes(32).toString("hex"),
    tokenPath = "/" + token,
    expiresAt = Date.now() + 10 * 60_000;
  const api =
    options.network === "testnet"
      ? "https://api.hyperliquid-testnet.xyz"
      : "https://api.hyperliquid.xyz";
  const config: WalletPageConfig = {
    ...options,
    expiresAt,
    types: WALLET_TYPES,
    api,
    tokenPath,
  };
  const script = `(${walletBrowser.toString()})(${JSON.stringify(config).replace(/</g, "\\u003c")})`;
  const hash = createHash("sha256").update(script).digest("base64");
  const fee = options.builder
    ? "Orders include Gloom's 0.1% builder fee. Approval permits a maximum of 0.1% per fill. You can revoke it below."
    : "No builder fee is active.";
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gloom Hyperliquid wallet</title><style>body{margin:0;background:#101419;color:#e5ebef;font:15px system-ui}main{max-width:680px;margin:48px auto;padding:24px}h1{font-size:26px}h2{font-size:18px;margin-top:32px}p{color:#aab8c3;line-height:1.5}.network{color:${options.network === "testnet" ? "#f7b955" : "#70d9c2"};font-weight:700}label{display:block;margin:14px 0}input,select,button{box-sizing:border-box;background:#1b242d;color:inherit;border:1px solid #3c4e5b;border-radius:5px;padding:10px;font:inherit}input:not([type=checkbox]),select{width:100%;margin-top:5px}button{margin:5px 8px 5px 0;cursor:pointer}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #70d9c2}button:disabled{opacity:.5;cursor:wait}#status{padding:16px 0;color:#f7b955;white-space:pre-wrap;overflow-wrap:anywhere}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}code{overflow-wrap:anywhere;font-size:12px}a{color:#70d9c2}</style><main><div class="network">${options.network === "testnet" ? "TESTNET · No real funds" : "MAINNET · Real funds"}</div><h1>Connect your wallet to Gloom</h1><p>Your browser wallet signs approvals and fund movements directly with Hyperliquid. The locally generated trading key never enters this page and cannot withdraw.</p><label>Browser wallet<select id="wallets"></select></label><button id="connect">Connect browser wallet</button><p id="account">${escape(options.address ?? "No wallet connected")}</p><h2>Trading approval</h2><p>API wallet: <code>${escape(options.agentAddress ?? "No local API wallet")}</code></p><p>${escape(fee)}</p><label><input type="checkbox" id="risk"> I understand leveraged trading can liquidate my collateral, and I am not a restricted person under Hyperliquid's terms.</label><button id="approve">Approve trading for 90 days</button><button id="revoke">Revoke trading approval</button>${options.builder ? '<button id="fee">Revoke builder fee approval</button>' : '<button id="fee" hidden>Revoke builder fee</button>'}<h2>Funds</h2><label>USDC amount<input id="amount" inputmode="decimal" placeholder="0.00" autocomplete="off"></label><button id="deposit">Deposit from Arbitrum</button><button id="withdraw">Withdraw to this wallet</button><p>The legacy Arbitrum bridge requires at least 5 USDC per deposit. Withdrawal fee: 1 USDC. Check your wallet network and address before signing.</p><h2>Collateral balances</h2><div class="row"><label>From<input id="source" value="perp" placeholder="perp, spot, or dex name"></label><label>To<input id="destination" value="spot" placeholder="perp, spot, or dex name"></label></div><label>Token<input id="token" value="USDC" placeholder="USDC or TOKEN:token-id"></label><button id="transfer">Transfer collateral</button><button id="unify">Enable unified account</button><p>Use the exact dex name (for example xyz) for a HIP-3 balance. A transfer to another collateral requires that collateral token; this page does not swap tokens.</p><div id="status" role="status" aria-live="polite"></div><p>This local page expires in 10 minutes. <a href="https://app.hyperliquid.xyz/terms" target="_blank" rel="noreferrer">Hyperliquid terms</a></p></main><script>${script}</script></html>`;
  let server: Bun.Server<undefined>;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.approvalPort ?? 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const expected = `127.0.0.1:${server.port}`;
      const headers = {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; connect-src 'self' ${api}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      };
      if (
        request.headers.get("host") !== expected ||
        Date.now() > expiresAt ||
        request.method !== "GET" ||
        !["none", "same-origin", null].includes(
          request.headers.get("sec-fetch-site"),
        )
      )
        return new Response("Not available", { status: 403, headers });
      if (url.pathname === tokenPath + "/region")
        return Response.json(await options.checkRegion(), { headers });
      if (url.pathname !== tokenPath + "/")
        return new Response("Not found", { status: 404, headers });
      return new Response(html, {
        headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
      });
    },
  });
  const timer = setTimeout(() => server.stop(true), 10 * 60_000);
  timer.unref();
  return {
    url: `http://127.0.0.1:${server.port}${tokenPath}/`,
    expiresAt,
    agentAddress: options.agentAddress,
    close: () => {
      clearTimeout(timer);
      server.stop(true);
    },
  };
}
