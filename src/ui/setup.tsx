import { useEffect, useState } from "react";
import { Box, ScrollBox, Text, useRendererHost } from "gloomberb/ui";
import {
  Button,
  Checkbox,
  ExternalLink,
  FieldGrid,
  KeyValueRow,
  Notice,
  QueryBar,
  Section,
  TextField,
  confirmDialog,
  openUrl,
  useFieldRing,
  usePaneTabs,
} from "gloomberb/components";
import { useDialog } from "gloomberb/dialog";
import {
  useInputCapture,
  usePaneSettingValue,
  usePluginConfigState,
  usePluginPaneState,
} from "gloomberb/react";
import type { PaneProps } from "gloomberb/types/plugin";
import { colors } from "gloomberb/theme";
import type { WalletSession } from "../trading/types";
import { configuredBuilder } from "../trading/builder";
import { dateTime, number } from "./format";
import { useAccount, useLiveFooter, useNetwork } from "./hooks";

export function HyperliquidSetupPane({ focused, width }: PaneProps) {
  const state = useAccount();
  const dialog = useDialog();
  const renderer = useRendererHost();
  const [network, setNetwork] = useNetwork();
  const [defaultTab] = usePaneSettingValue("defaultTab", "Connect");
  const [tab, setTab] = usePluginPaneState(
    "setupTab",
    ["Connect", "Watch-only", "Advanced", "Settings"].find(
      (value) => value.toLowerCase() === defaultTab.toLowerCase(),
    ) ?? "Connect",
  );
  const [address, setAddress] = useState("");
  const [risk, setRisk] = useState(false);
  const [eligible, setEligible] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [session, setSession] = useState<WalletSession | null>(null);
  const [slippage, setSlippage] = usePluginConfigState("slippageBps", 50);
  const [confirmations, setConfirmations] = usePluginConfigState(
    "confirmations",
    true,
  );
  const [maxOrder, setMaxOrder] = usePluginConfigState("maxOrderUsd", 10_000);
  const [fatFinger, setFatFinger] = usePluginConfigState("fatFingerPercent", 5);
  const [port, setPort] = usePluginConfigState("approvalPort", 0);
  const [defaultLeverage, setDefaultLeverage] = usePluginConfigState(
    "defaultLeverage",
    3,
  );
  const [sizeUnit, setSizeUnit] = usePluginConfigState("sizeUnit", "usd");
  const [leverageBehavior, setLeverageBehavior] = usePluginConfigState(
    "leverageBehavior",
    "position",
  );
  useInputCapture(focused && active != null);
  const tabs = usePaneTabs({
    tabs: ["Connect", "Watch-only", "Advanced", "Settings"].map((value) => ({
      value,
      label: value,
    })),
    activeValue: tab,
    onSelect: (value) => {
      setTab(value);
      setActive(null);
    },
    focused: focused && active == null,
    compact: true,
  });
  const run = async (task: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await task();
      await state.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const connect = () =>
    run(async () => {
      await state.invoke("acknowledge", { risk, eligible });
      const result = await state.invoke<WalletSession>("connect");
      setSession(result);
      try {
        openUrl(result.url);
      } catch {
        setMessage("Open the approval URL below in your wallet browser.");
      }
    });
  const watch = () =>
    run(async () => {
      await state.invoke("watch", { address: address.trim() });
      setMessage("Watching account.");
    });
  const disconnect = () =>
    run(async () => {
      const confirmed = await confirmDialog(dialog, {
        title: "Disconnect wallet",
        body: "Remove the locally stored API wallet key and watched account. Revoke the API wallet in your wallet management page if you also want to revoke its exchange permission.",
        confirmLabel: "Disconnect",
      });
      if (confirmed) {
        await state.invoke("disconnect");
        setSession(null);
        setMessage("Disconnected. Local key removed.");
      }
    });
  const wallet = () =>
    run(async () => {
      const result = await state.invoke<WalletSession>("wallet");
      setSession(result);
      try {
        openUrl(result.url);
      } catch {
        setMessage("Open the approval URL below in your wallet browser.");
      }
    });
  useEffect(() => {
    if (!session || busy) return;
    let stopped = false;
    const timer = setInterval(() => {
      if (!stopped)
        void state
          .invoke("connectionStatus")
          .then(() => state.refresh())
          .catch(() => {});
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [session, busy, state.invoke]);
  useEffect(() => {
    setSession(null);
    setError(null);
  }, [network]);
  const fields =
    tab === "Watch-only"
      ? ["address", "save"]
      : tab === "Settings"
        ? [
            "slippage",
            "maxOrder",
            "fatFinger",
            "port",
            "defaultLeverage",
            "confirmations",
          ]
        : ["risk", "eligible", "save"];
  const ring = useFieldRing({
    ids: fields,
    activeId: active,
    onActivate: setActive,
    enabled: focused && tab !== "Advanced",
    scope: "hyperliquid-setup",
    actions: {
      confirmations: () => setConfirmations(!confirmations),
      risk: () => setRisk(!risk),
      eligible: () => setEligible(!eligible),
      save: () => {
        void (tab === "Watch-only" ? watch() : connect());
      },
    },
  });
  useLiveFooter(
    "hyperliquid-setup",
    {
      network,
      // The auth segment already names the connection; this one carries only
      // progress and the last result.
      status: busy ? "working" : (message ?? undefined),
      error: error ?? state.error,
    },
    [
      ...(state.status?.address
        ? [
            {
              id: "disconnect",
              key: "d",
              label: "isconnect",
              onPress: () => void disconnect(),
            },
            {
              id: "wallet",
              key: "w",
              label: "allet management",
              onPress: () => void wallet(),
            },
          ]
        : []),
      ...(session
        ? [
            {
              id: "copy",
              key: "c",
              label: "opy approval URL",
              onPress: () => {
                void renderer
                  .copyText(session.url)
                  .then(() => setMessage("Approval URL copied."))
                  .catch(() => setMessage("Select the full URL to copy it."));
              },
            },
            {
              id: "open",
              key: "o",
              label: "pen approval page",
              onPress: () => openUrl(session.url),
            },
          ]
        : []),
    ],
    state.status,
  );
  const acknowledgment = (
    <>
      <Box ref={ring.nodeRef("risk")}>
        <Checkbox
          label="I understand perpetuals can liquidate my collateral."
          checked={risk}
          active={active === "risk"}
          onChange={setRisk}
        />
      </Box>
      <Box ref={ring.nodeRef("eligible")}>
        <Checkbox
          label="I am eligible under Hyperliquid's terms and not a restricted person."
          checked={eligible}
          active={active === "eligible"}
          onChange={setEligible}
        />
      </Box>
    </>
  );
  return (
    <Box flexGrow={1} flexDirection="column" minHeight={0}>
      {tabs.strip}
      <QueryBar
        width={width}
        filters={[
          {
            id: "network",
            label: "Network",
            value: network,
            options: [
              { value: "mainnet", label: "Mainnet" },
              { value: "testnet", label: "Testnet" },
            ],
            onChange: setNetwork,
          },
          ...(tab === "Settings"
            ? [
                {
                  id: "sizeUnit",
                  label: "Default size",
                  value: sizeUnit,
                  options: [
                    { value: "usd", label: "USD" },
                    { value: "coin", label: "Coin" },
                    { value: "percent", label: "% buying power" },
                  ],
                  onChange: setSizeUnit,
                },
                {
                  id: "leverageBehavior",
                  label: "Leverage",
                  value: leverageBehavior,
                  options: [
                    {
                      value: "position",
                      label: "Position or default",
                    },
                    { value: "default", label: "Default" },
                  ],
                  onChange: setLeverageBehavior,
                },
              ]
            : []),
        ]}
      />
      <ScrollBox
        flexGrow={1}
        // Sections bring their own top margin; the body adds no gap of its own.
        contentOptions={{
          flexDirection: "column",
          paddingX: 1,
          paddingBottom: 1,
        }}
      >
        {state.status?.address ? (
          <Section title="Connection">
            <KeyValueRow label="Account" value={state.status.address} />
            <KeyValueRow label="Mode" value={state.status.mode} />
            {state.status.agentAddress ? (
              <KeyValueRow
                label="API wallet"
                value={state.status.agentAddress}
              />
            ) : null}
            {state.status.expiresAt ? (
              <KeyValueRow
                label="Agent expiry UTC"
                value={dateTime(state.status.expiresAt)}
              />
            ) : null}
            {state.status.region ? (
              <KeyValueRow
                label="Region check"
                value={
                  state.status.region.allowed
                    ? (state.status.region.country ?? "Passed")
                    : (state.status.region.reason ?? "Trading unavailable")
                }
              />
            ) : null}
            {state.status.storage ? (
              <KeyValueRow
                label="Key storage"
                value={
                  state.status.storage === "keychain"
                    ? "OS keychain"
                    : "Local owner-only file"
                }
              />
            ) : null}
          </Section>
        ) : null}
        {tab === "Connect" ? (
          <Section
            title={
              state.status?.mode === "trading"
                ? "Renew API wallet approval"
                : "Approve a local API wallet"
            }
          >
            {acknowledgment}
            <Box marginTop={1} flexDirection="row" ref={ring.nodeRef("save")}>
              <Button
                label={busy ? "Preparing approval..." : "Connect wallet"}
                variant="primary"
                disabled={busy || !risk || !eligible}
                onPress={() => void connect()}
              />
            </Box>
          </Section>
        ) : null}
        {tab === "Watch-only" ? (
          <Section title="Watch an account">
            <Box ref={ring.nodeRef("address")}>
              <TextField
                label="Address"
                labelWidth={9}
                value={address}
                onChange={setAddress}
                focused={focused && active === "address"}
                active={active === "address"}
                onMouseDown={() => setActive("address")}
                placeholder="0x..."
                width={Math.min(width - 4, 56)}
                onSubmit={() => void watch()}
              />
            </Box>
            <Box marginTop={1} flexDirection="row" ref={ring.nodeRef("save")}>
              <Button
                label={busy ? "Saving..." : "Watch account"}
                variant="primary"
                disabled={busy || !/^0x[0-9a-fA-F]{40}$/.test(address)}
                onPress={() => void watch()}
              />
            </Box>
          </Section>
        ) : null}
        {tab === "Advanced" ? (
          <Section title="Existing API Wallet">
            <Text wrapText fg={colors.textDim}>
              Import an approved API wallet from the command line, with the key
              in a protected file or standard input. Never paste it into a pane
              or a command argument.
            </Text>
            <Text selectable wrapText fg={colors.textBright}>
              gloomberb hyperliquid import-key --network {network} --key-file
              /private/path/trading.key --address 0xYOUR_ACCOUNT_ADDRESS --yes
              --acknowledge-risk --eligible
            </Text>
          </Section>
        ) : null}
        {tab === "Settings" ? (
          <Section title="Trading settings">
            <FieldGrid
              width={width - 4}
              focused={focused}
              keyboard={false}
              activeId={active}
              onActivate={setActive}
              onDeactivate={() => setActive(null)}
              columns={1}
              fields={[
                {
                  id: "slippage",
                  label: "Slippage cap",
                  value: Number(slippage),
                  valueText: number(Number(slippage), 0),
                  suffix: "bp",
                  onValue: setSlippage,
                },
                {
                  id: "maxOrder",
                  label: "Order guard",
                  value: Number(maxOrder),
                  valueText: number(Number(maxOrder), 0),
                  suffix: "USD",
                  onValue: setMaxOrder,
                },
                {
                  id: "fatFinger",
                  label: "Price guard",
                  value: Number(fatFinger),
                  valueText: String(Number(fatFinger)),
                  suffix: "%",
                  onValue: setFatFinger,
                },
                {
                  id: "port",
                  label: "Wallet port",
                  value: Number(port),
                  valueText: Number(port) ? String(port) : "Random",
                  onValue: (value) =>
                    setPort(Math.max(0, Math.min(65535, Math.round(value)))),
                },
                {
                  id: "defaultLeverage",
                  label: "Leverage",
                  value: Number(defaultLeverage),
                  valueText: String(Number(defaultLeverage)),
                  suffix: "x",
                  onValue: (value) =>
                    setDefaultLeverage(
                      Math.max(1, Math.min(100, Math.round(value))),
                    ),
                },
              ]}
            />
            <Box ref={ring.nodeRef("confirmations")}>
              <Checkbox
                label="Confirm each order"
                checked={
                  confirmations !== false && String(confirmations) !== "false"
                }
                active={active === "confirmations"}
                onChange={setConfirmations}
              />
            </Box>
            <KeyValueRow
              label="Gloom builder fee"
              labelWidth={18}
              value={
                configuredBuilder(network)
                  ? "0.1%, explicit wallet approval required"
                  : network === "testnet"
                    ? "Off on testnet"
                    : "0.1% configured; inactive until builder address is set"
              }
            />
          </Section>
        ) : null}
        {session ? (
          <Section title="Wallet approval page">
            <Text fg={colors.borderFocused} selectable wrapText>
              {session.url}
            </Text>
            <KeyValueRow
              label="Page expires UTC"
              value={dateTime(session.expiresAt)}
            />
            <ExternalLink url={session.url} label="Open wallet approval page" />
            <Text fg={colors.textDim} wrapText>
              Over SSH, forward this port and open the URL on your computer.
            </Text>
          </Section>
        ) : null}
        {error ? <Notice tone="negative">{error}</Notice> : null}
      </ScrollBox>
    </Box>
  );
}
