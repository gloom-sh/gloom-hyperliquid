import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Box,
  ScrollBox,
  Text,
  useUiCapabilities,
  type ScrollBoxRenderable,
} from "gloomberb/ui";
import {
  ActionRow,
  Button,
  Checkbox,
  SegmentedControl,
  Tabs,
  confirmDialog,
  useFieldRing,
  usePaneFooter,
} from "gloomberb/components";
import { useDialog } from "gloomberb/dialog";
import {
  useInputCapture,
  usePluginAppActions,
  usePluginConfigState,
  usePluginPaneState,
  useShortcut,
} from "gloomberb/react";
import { colors } from "gloomberb/theme";
import type { Market, OrderBook } from "../market";
import { previewTicket } from "../trading/orders";
import { availableForMarket } from "../trading/account";
import { tradingSettings } from "../settings";
import type {
  TicketPreview,
  TicketRequest,
  TradingResult,
} from "../trading/types";
import { configuredBuilder } from "../trading/builder";
import {
  missing,
  number,
  percent,
  price,
  shortAddress,
  size,
  usd,
  usdCompact,
} from "./format";
import { useAccount } from "./hooks";
import { placeError, type FieldId, type Place } from "./ticket-errors";
import { TicketContext } from "./ticket-parts";
import {
  ActionButton,
  AmountField,
  FieldNote,
  FigurePairs,
  LeverageControl,
  MenuChoices,
  SideToggle,
  type MenuControl,
} from "./controls";

type Kind = TicketRequest["kind"];
interface Draft {
  side: "buy" | "sell";
  kind: Kind;
  size: number;
  sizeUnit: TicketRequest["sizeUnit"];
  leverage: number;
  marginMode: "cross" | "isolated";
  limitPrice: number;
  triggerPrice: number;
  tif: "Gtc" | "Alo" | "Ioc";
  reduceOnly: boolean;
  takeProfit: number;
  stopLoss: number;
  twapMinutes: number;
  scaleStart: number;
  scaleEnd: number;
  scaleCount: number;
}

/** The everyday types are tabs; the rest wait behind More and join the tabs while chosen. */
const TAB_KINDS: Kind[] = ["market", "limit", "stop-market"];
const KIND_TAB: Record<Kind, string> = {
  market: "Market",
  limit: "Limit",
  "stop-market": "Stop",
  "stop-limit": "Stop limit",
  "take-profit-market": "TP market",
  "take-profit-limit": "TP limit",
  scale: "Scale",
  twap: "TWAP",
};
const MORE_KINDS: { value: Kind; label: string }[] = [
  { value: "stop-limit", label: "Stop limit" },
  { value: "take-profit-market", label: "Take-profit market" },
  { value: "take-profit-limit", label: "Take-profit limit" },
  { value: "scale", label: "Scale" },
  { value: "twap", label: "TWAP" },
];
const KIND_PHRASE: Record<Kind, string> = {
  market: "market",
  limit: "limit",
  "stop-market": "stop",
  "stop-limit": "stop limit",
  "take-profit-market": "take-profit",
  "take-profit-limit": "take-profit limit",
  scale: "scale",
  twap: "TWAP",
};
const PERCENTS = ["25", "50", "75", "100"];
/** Below this a market order's average fill is close enough to mark to leave unsaid. */
const SLIPPAGE_NOTE_PERCENT = 0.05;
const LABEL_WIDTH = 11;

type RingId =
  | FieldId
  | "side"
  | "kind"
  | "leverage"
  | "margin"
  | "applyLeverage"
  | "unit"
  | "percent"
  | "advanced"
  | "tpslUnit"
  | "reduceOnly"
  | "tif"
  | "submit";
export function OrderTicket({
  market,
  book,
  width,
  focused,
  limitPrice,
  onClearPrice,
}: {
  market: Market;
  book?: OrderBook | null;
  width: number;
  focused: boolean;
  limitPrice?: number;
  onClearPrice?: () => void;
}) {
  const account = useAccount();
  const app = usePluginAppActions();
  const dialog = useDialog();
  const native = useUiCapabilities().nativePaneChrome;
  const [defaultUnit] = usePluginConfigState<TicketRequest["sizeUnit"]>(
    "sizeUnit",
    "usd",
  );
  const [defaultLeverage] = usePluginConfigState("defaultLeverage", 3);
  const [leverageBehavior] = usePluginConfigState(
    "leverageBehavior",
    "position",
  );
  const [confirmations] = usePluginConfigState<boolean | string>(
    "confirmations",
    true,
  );
  const [draft, setDraft] = usePluginPaneState<Draft>(`ticket:${market.coin}`, {
    side: "buy",
    kind: "market",
    size: 0,
    sizeUnit: defaultUnit,
    leverage: Math.min(defaultLeverage, market.maxLeverage),
    marginMode: market.onlyIsolated ? "isolated" : "cross",
    limitPrice: market.mark ?? 0,
    triggerPrice: 0,
    tif: "Gtc",
    reduceOnly: false,
    takeProfit: 0,
    stopLoss: 0,
    twapMinutes: 30,
    scaleStart: 0,
    scaleEnd: 0,
    scaleCount: 5,
  });
  const [advanced, setAdvanced] = usePluginPaneState("ticketAdvanced", false);
  const [tpslUnit, setTpslUnit] = usePluginPaneState<"price" | "percent">(
    "ticketTpslUnit",
    "price",
  );
  const [active, setActive] = useState<RingId | null>(null);
  const [slippageBps] = usePluginConfigState("slippageBps", 50);
  const [maxOrderUsd] = usePluginConfigState("maxOrderUsd", 10_000);
  const [fatFingerPercent] = usePluginConfigState("fatFingerPercent", 5);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clientId = useRef(crypto.randomUUID());
  const submitting = useRef(false);
  const edited = useRef(false);
  const leverageInitialized = useRef(false);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const moreMenu = useRef<MenuControl | null>(null);
  const update = (patch: Partial<Draft>) => {
    edited.current = true;
    setDraft((old) => ({ ...old, ...patch }));
    setError(null);
    setMessage(null);
    clientId.current = crypto.randomUUID();
  };
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    update({ [key]: value } as Partial<Draft>);
  useEffect(() => {
    if (!account.account || leverageInitialized.current) return;
    leverageInitialized.current = true;
    const position = account.account.positions.find(
      (p) => p.coin === market.coin,
    );
    if (
      leverageBehavior === "position" &&
      position &&
      !edited.current &&
      draft.size === 0
    ) {
      setDraft((old) => ({
        ...old,
        leverage: Math.min(market.maxLeverage, position.leverage.value),
        marginMode: market.onlyIsolated ? "isolated" : position.leverage.type,
      }));
    }
  }, [account.account, leverageBehavior, market.coin]);
  useEffect(() => {
    if (limitPrice != null) {
      setDraft((old) => ({ ...old, kind: "limit", limitPrice }));
      clientId.current = crypto.randomUUID();
      onClearPrice?.();
    }
  }, [limitPrice]);
  const ticket = useMemo<TicketRequest>(
    () => ({
      ...draft,
      market: {
        coin: market.coin,
        dex: market.dex,
        assetId: market.assetId,
        szDecimals: market.szDecimals,
        maxLeverage: market.maxLeverage,
        onlyIsolated: market.onlyIsolated,
        mark: market.mark ?? 0,
        deployerFeeScale: market.deployerFeeScale ?? (market.dex ? 1 : 0),
        growthMode: market.growthMode === "enabled",
        collateral: market.collateral,
        marginTiers: market.marginTiers,
      },
      marginMode: market.onlyIsolated ? "isolated" : draft.marginMode,
      takeProfit: draft.takeProfit || undefined,
      stopLoss: draft.stopLoss || undefined,
      clientId: clientId.current,
    }),
    [draft, market],
  );
  const preview = useMemo(
    () =>
      previewTicket(
        ticket,
        {
          available: account.account
            ? availableForMarket(account.account, ticket.market)
            : 0,
          makerRate: Number(account.account?.fees?.userAddRate ?? 0.00015),
          takerRate: Number(account.account?.fees?.userCrossRate ?? 0.00045),
          referralDiscount: Number(
            account.account?.fees?.activeReferralDiscount ?? 0,
          ),
          positionSize: Number(
            account.account?.positions.find((p) => p.coin === market.coin)
              ?.szi ?? 0,
          ),
          accountValue: account.account?.accountValue,
          crossMaintenanceMargin: account.account?.maintenanceMargin,
          book: book
            ? [
                book.bids.map((l) => ({
                  px: String(l.price),
                  sz: String(l.size),
                })),
                book.asks.map((l) => ({
                  px: String(l.price),
                  sz: String(l.size),
                })),
              ]
            : undefined,
        },
        {
          ...tradingSettings({
            slippageBps,
            maxOrderUsd,
            fatFingerPercent,
            confirmations,
          }),
          builder: configuredBuilder(account.network),
        },
      ),
    [
      ticket,
      account.account,
      book,
      slippageBps,
      maxOrderUsd,
      fatFingerPercent,
      confirmations,
    ],
  );
  const submit = async () => {
    if (submitting.current || busy || account.status?.mode !== "trading")
      return;
    submitting.current = true;
    const expectedAddress = account.status.address;
    setError(null);
    try {
      const current = await account.invoke<TicketPreview>("preview", {
        ticket,
      });
      if (current.errors.length) {
        setError(current.errors.join(" "));
        return;
      }
      if (
        (confirmations !== false && confirmations !== "false") ||
        current.warnings.length
      ) {
        const confirmed = await confirmDialog(dialog, {
          title: `${draft.side === "buy" ? "Buy / Long" : "Sell / Short"} ${market.coin}`,
          body: [
            `Account ${shortAddress(expectedAddress)}`,
            `${draft.kind} · ${current.size} ${market.symbol} · ${usd(current.notional)}`,
            `Price cap ${price(Number(current.price), market.szDecimals)} · ${draft.leverage}x ${ticket.marginMode}`,
            `Estimated fee ${usd(current.fee)}${configuredBuilder(account.network) ? " including Gloom's 0.1% builder fee" : ""}`,
            ...current.warnings,
          ],
          confirmLabel: "Submit order",
          confirmVariant: draft.side === "buy" ? "primary" : "danger",
        });
        if (!confirmed) return;
      }
      setBusy(true);
      const result = await account.invoke<TradingResult>("submit", {
        ticket,
        confirmed: true,
        expectedAddress,
      });
      setMessage(result.message);
      if (result.state === "accepted") {
        clientId.current = crypto.randomUUID();
        setDraft((old) => ({ ...old, size: 0 }));
        await account.refresh();
      }
      if (result.state !== "accepted") setError(result.message);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const applyLeverage = async (
    leverage: number,
    marginMode: "cross" | "isolated",
  ) => {
    if (busy || account.status?.mode !== "trading") return;
    const expectedAddress = account.status.address;
    const mode = market.onlyIsolated ? "isolated" : marginMode;
    const confirmed = await confirmDialog(dialog, {
      title: `Set ${market.coin} leverage`,
      body: `Account ${shortAddress(expectedAddress)}: ${leverage}x ${mode}`,
      confirmLabel: "Apply leverage",
      confirmVariant: "primary",
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await account.invoke("leverage", {
        coin: market.coin,
        leverage,
        marginMode: mode,
        clientId: crypto.randomUUID(),
        expectedAddress,
      });
      setMessage("Leverage updated.");
      await account.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  usePaneFooter(
    "hyperliquid-ticket-result",
    () => ({
      info: busy
        ? [{ id: "sending", parts: [{ text: "Submitting", tone: "warning" }] }]
        : message || error
          ? [
              {
                id: "result",
                parts: [
                  {
                    text: error ?? message ?? "",
                    tone: error ? "negative" : "positive",
                  },
                ],
              },
            ]
          : [],
    }),
    [busy, message, error],
  );

  const buy = draft.side === "buy";
  const trading = account.status?.mode === "trading";
  const priceText = (value: number) =>
    value > 0 ? price(value, market.szDecimals) : "";
  const triggered =
    draft.kind.startsWith("stop-") || draft.kind.startsWith("take-profit-");
  const limited = draft.kind.endsWith("limit");
  const showTif = limited || draft.kind === "scale";
  // TP/SL as a percentage moves away from the price the order enters at.
  const reference =
    (limited ? draft.limitPrice : triggered ? draft.triggerPrice : 0) ||
    market.mark ||
    0;
  const direction = buy ? 1 : -1;
  const tpPercent = (value: number) =>
    reference > 0 && value > 0 ? (value / reference - 1) * 100 * direction : 0;
  const slPercent = (value: number) =>
    reference > 0 && value > 0 ? (1 - value / reference) * 100 * direction : 0;
  const tpFromPercent = (value: number) =>
    value > 0 && reference > 0
      ? reference * (1 + (direction * value) / 100)
      : 0;
  const slFromPercent = (value: number) =>
    value > 0 && reference > 0
      ? reference * (1 - (direction * value) / 100)
      : 0;
  const twoDecimals = (value: number) => Math.round(value * 100) / 100;

  // Problems show once there is a size to judge; until then the button alone
  // says what is missing.
  const problems = (draft.size > 0 ? preview.errors : [])
    .map((message) => ({ message, ...placeError(message, draft.kind) }))
    .filter((problem) => !problem.quiet);
  const problemAt = (place: Place) =>
    problems.find((problem) => problem.place === place);
  const warnings =
    draft.size > 0 || draft.kind === "twap" ? preview.warnings : [];
  const fill =
    draft.kind === "market" &&
    preview.averageFill &&
    preview.slippagePercent != null &&
    Math.abs(preview.slippagePercent) >= SLIPPAGE_NOTE_PERCENT
      ? `Avg fill ${price(preview.averageFill, market.szDecimals)} · ${number(preview.slippagePercent, 2)}% slippage`
      : null;

  const available = account.account
    ? availableForMarket(account.account, ticket.market)
    : null;
  const builder = configuredBuilder(account.network);
  const position = account.account?.positions.find(
    (p) => p.coin === market.coin,
  );
  const coins = Number(preview.size);
  // An open position carries the account's leverage for this market. The
  // order sets the chosen leverage as it is placed; Apply sets it now.
  const leveragePending =
    trading &&
    !!position &&
    (draft.leverage !== position.leverage.value ||
      ticket.marginMode !== position.leverage.type);
  const applyChosenLeverage = () =>
    void applyLeverage(draft.leverage, ticket.marginMode);
  const switchUnit = (unit: "usd" | "coin") => {
    if (unit === draft.sizeUnit) return;
    // Convert what is entered so the order keeps its size in the new unit.
    const next =
      draft.size > 0 && coins > 0
        ? unit === "coin"
          ? coins
          : Number(preview.notional.toFixed(2))
        : 0;
    update({ sizeUnit: unit, size: next });
  };

  // Primary action: what it does, or why it cannot.
  const firstError = preview.errors[0]
    ? placeError(preview.errors[0], draft.kind)
    : null;
  const action = !trading
    ? {
        label:
          account.status?.mode === "watch"
            ? "Connect a trading wallet"
            : "Connect wallet",
        tone: "neutral" as const,
        disabled: false,
        run: () => app.createPaneFromTemplate("hyperliquid-setup-new"),
      }
    : busy
      ? {
          label: "Submitting...",
          tone: draft.side,
          disabled: true,
          run: () => {},
        }
      : firstError
        ? {
            label: firstError.short,
            tone: draft.side,
            disabled: true,
            run: () => {},
          }
        : error
          ? {
              label: "Change the order to retry",
              tone: draft.side,
              disabled: true,
              run: () => {},
            }
          : {
              label:
                draft.kind === "market"
                  ? `${buy ? "Buy / Long" : "Sell / Short"} ${market.symbol}`
                  : `${draft.kind === "twap" ? "Start" : "Place"} ${KIND_PHRASE[draft.kind]} ${draft.side}`,
              tone: draft.side,
              disabled: false,
              run: () => void submit(),
            };

  const kindFields: FieldId[] = [
    ...(triggered ? (["trigger"] as const) : []),
    ...(limited ? (["limit"] as const) : []),
    ...(draft.kind === "twap" ? (["twap"] as const) : []),
    ...(draft.kind === "scale"
      ? (["scaleStart", "scaleEnd", "scaleCount"] as const)
      : []),
  ];
  const textFields = new Set<RingId>([
    ...kindFields,
    "leverage",
    "size",
    "tp",
    "sl",
  ]);
  const ringIds: RingId[] = [
    "side",
    "kind",
    "leverage",
    "margin",
    ...(leveragePending ? (["applyLeverage"] as const) : []),
    ...kindFields,
    "size",
    "unit",
    "percent",
    "advanced",
    ...(advanced
      ? ([
          "tpslUnit",
          "tp",
          "sl",
          "reduceOnly",
          ...(showTif ? (["tif"] as const) : []),
        ] as RingId[])
      : []),
    "submit",
  ];
  useInputCapture(focused && active != null && textFields.has(active));
  const ring = useFieldRing<RingId>({
    ids: ringIds,
    activeId: active,
    onActivate: setActive,
    enabled: focused,
    scope: "hyperliquid-ticket",
    scrollRef,
    actions: {
      side: () => set("side", buy ? "sell" : "buy"),
      kind: () => moreMenu.current?.open(),
      margin: () => {
        if (!market.onlyIsolated)
          set(
            "marginMode",
            ticket.marginMode === "cross" ? "isolated" : "cross",
          );
      },
      applyLeverage: applyChosenLeverage,
      unit: () => switchUnit(draft.sizeUnit === "coin" ? "usd" : "coin"),
      advanced: () => setAdvanced(!advanced),
      tpslUnit: () => setTpslUnit(tpslUnit === "price" ? "percent" : "price"),
      reduceOnly: () => set("reduceOnly", !draft.reduceOnly),
      submit: () => {
        if (!action.disabled) action.run();
      },
    },
  });
  const tabKinds = TAB_KINDS.includes(draft.kind)
    ? TAB_KINDS
    : [...TAB_KINDS, draft.kind];
  useShortcut(
    (event) => {
      if (event.name !== "left" && event.name !== "right") return;
      event.preventDefault();
      event.stopPropagation();
      const index = tabKinds.indexOf(draft.kind);
      const next =
        tabKinds[
          Math.max(
            0,
            Math.min(
              tabKinds.length - 1,
              index + (event.name === "right" ? 1 : -1),
            ),
          )
        ]!;
      if (next !== draft.kind) set("kind", next);
    },
    {
      enabled: focused && active === "kind",
      phase: "before",
      scope: "hyperliquid-ticket-kind",
    },
  );
  useShortcut(
    (event) => {
      if (event.name === "escape") {
        event.preventDefault();
        setActive(null);
      }
      if (
        (event.name === "enter" || event.name === "return") &&
        active &&
        textFields.has(active)
      ) {
        event.preventDefault();
        event.stopPropagation();
        setActive(null);
        // Enter in the leverage applies it where Apply shows; elsewhere it
        // places the order.
        if (active !== "leverage") void submit();
        else if (leveragePending) applyChosenLeverage();
      }
    },
    {
      enabled: focused && active != null,
      allowEditable: true,
      phase: "before",
      scope: "hyperliquid-ticket-submit",
    },
  );

  const twoColumns = width >= 84;
  const leftWidth = twoColumns
    ? Math.max(44, Math.min(58, Math.floor(width * 0.55)))
    : Math.min(width, 64);
  const rightWidth = twoColumns
    ? Math.max(30, Math.min(64, width - leftWidth - 3))
    : 0;
  const inner = leftWidth - 2;
  // The desktop spaces the groups apart; a terminal row is too dear for gaps.
  const groupGap = native ? { style: { rowGap: 6 } } : {};

  const field = (
    id: FieldId,
    label: string,
    value: number,
    display: string,
    onValue: (value: number) => void,
    options: {
      placeholder?: string;
      trailing?: ReactNode;
      inputWidth?: number;
      error?: string;
    } = {},
  ) => (
    <Box key={id} flexDirection="column" flexShrink={0}>
      <AmountField
        label={label}
        value={value}
        display={display}
        placeholder={options.placeholder}
        active={active === id}
        focused={focused}
        onActivate={() => setActive(id)}
        onValue={onValue}
        width={inner}
        labelWidth={LABEL_WIDTH}
        inputWidth={options.inputWidth}
        trailing={options.trailing}
        fieldRef={ring.nodeRef(id)}
      />
      {options.error ? (
        <Box paddingLeft={LABEL_WIDTH + 1}>
          <Text fg={colors.negative} wrapText>
            {options.error}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
  const errorText = (place: Place) => problemAt(place)?.message;
  // Every input ends at one edge, leaving room after it for the size's unit
  // switch (each option is its label and a cell either side).
  const inputWidth = Math.max(
    8,
    inner - LABEL_WIDTH - 2 - (5 + market.symbol.length + 2),
  );

  const kindRows = kindFields.map((id) => {
    switch (id) {
      case "trigger":
        return field(
          id,
          "Trigger",
          draft.triggerPrice,
          priceText(draft.triggerPrice),
          (v) => set("triggerPrice", v),
          { inputWidth, error: errorText("trigger") },
        );
      case "limit":
        return field(
          id,
          "Price",
          draft.limitPrice,
          priceText(draft.limitPrice),
          (v) => set("limitPrice", v),
          { inputWidth, error: errorText("limit") },
        );
      case "twap":
        return field(
          id,
          "Duration",
          draft.twapMinutes,
          String(draft.twapMinutes),
          (v) => set("twapMinutes", Math.round(v)),
          {
            inputWidth,
            trailing: <FieldNote>min</FieldNote>,
            error: errorText("twap"),
          },
        );
      case "scaleStart":
        return field(
          id,
          "First price",
          draft.scaleStart,
          priceText(draft.scaleStart),
          (v) => set("scaleStart", v),
          { inputWidth, error: errorText("scaleStart") },
        );
      case "scaleEnd":
        return field(
          id,
          "Last price",
          draft.scaleEnd,
          priceText(draft.scaleEnd),
          (v) => set("scaleEnd", v),
          { inputWidth },
        );
      default:
        return field(
          id,
          "Orders",
          draft.scaleCount,
          String(draft.scaleCount),
          (v) => set("scaleCount", Math.round(v)),
          { inputWidth },
        );
    }
  });

  const percentValue =
    draft.sizeUnit === "percent" && PERCENTS.includes(String(draft.size))
      ? String(draft.size)
      : "";
  const sizeNote =
    draft.sizeUnit !== "coin" && coins > 0
      ? `${size(coins, market.szDecimals)} ${market.symbol}`
      : "";
  const sizeRows = (
    <Box flexDirection="column" flexShrink={0} {...groupGap}>
      {field(
        "size",
        "Size",
        draft.size,
        draft.size > 0
          ? draft.sizeUnit === "coin"
            ? size(draft.size, market.szDecimals)
            : number(draft.size, draft.sizeUnit === "usd" ? 2 : 0)
          : "",
        (v) => set("size", v),
        {
          placeholder: draft.sizeUnit === "percent" ? "% of max" : "0.00",
          inputWidth: inputWidth - (draft.sizeUnit === "percent" ? 3 : 0),
          // A percentage chip puts the size in % of buying power; the
          // switch shows it while it lasts and converts back to USD or coin.
          trailing: (
            <Box ref={ring.nodeRef("unit")}>
              <SegmentedControl
                value={draft.sizeUnit}
                options={[
                  { value: "usd", label: "USD" },
                  { value: "coin", label: market.symbol },
                  ...(draft.sizeUnit === "percent"
                    ? [{ value: "percent", label: "%" }]
                    : []),
                ]}
                onChange={(v) => {
                  setActive("unit");
                  if (v !== "percent") switchUnit(v as "usd" | "coin");
                }}
                focused={focused && active === "unit"}
              />
            </Box>
          ),
          error: errorText("size"),
        },
      )}
      {/* Under the input when there is room for what the size works out to beside it. */}
      <Box
        flexDirection="row"
        paddingLeft={inner >= 50 ? LABEL_WIDTH + 1 : 0}
        width={inner}
        height={1}
        gap={1}
        flexShrink={0}
        ref={ring.nodeRef("percent")}
      >
        <SegmentedControl
          value={percentValue}
          options={PERCENTS.map((value) => ({ value, label: `${value}%` }))}
          onChange={(value) => {
            setActive("percent");
            update({ sizeUnit: "percent", size: Number(value) });
          }}
          focused={focused && active === "percent"}
        />
        <Box flexGrow={1} />
        <FieldNote>{sizeNote}</FieldNote>
      </Box>
    </Box>
  );

  const marginError = errorText("margin");
  const leverageRows = (
    <Box flexDirection="column" flexShrink={0} {...groupGap}>
      <LeverageControl
        value={draft.leverage}
        max={market.maxLeverage}
        onChange={(value) => set("leverage", value)}
        marginMode={ticket.marginMode}
        onlyIsolated={market.onlyIsolated}
        onMarginMode={(mode) => set("marginMode", mode)}
        active={active === "leverage" || active === "margin" ? active : null}
        focused={focused}
        onActivate={setActive}
        width={inner}
        labelWidth={LABEL_WIDTH}
        leverageRef={ring.nodeRef("leverage")}
        marginRef={ring.nodeRef("margin")}
      />
      {marginError ? (
        <Box width={inner} flexShrink={0}>
          <Text fg={colors.negative} wrapText>
            {marginError}
          </Text>
        </Box>
      ) : null}
      <Box
        flexDirection="row"
        width={inner}
        height={1}
        gap={1}
        alignItems="center"
        flexShrink={0}
      >
        {leveragePending ? (
          <Box flexShrink={0} ref={ring.nodeRef("applyLeverage")}>
            <Button
              label={`Apply ${draft.leverage}x`}
              title={`Set ${market.coin} to ${draft.leverage}x ${ticket.marginMode} now`}
              compact={native}
              disabled={busy}
              active={focused && active === "applyLeverage"}
              onPress={() => {
                setActive("applyLeverage");
                applyChosenLeverage();
              }}
            />
          </Box>
        ) : null}
        <Box flexGrow={1} />
        <Box flexShrink={1} overflow="hidden">
          <Text fg={colors.textDim}>
            {`Available ${
              available == null
                ? missing
                : number(available, available >= 10_000 ? 0 : 2)
            } ${market.collateral}`}
          </Text>
        </Box>
      </Box>
    </Box>
  );

  const kindTabs = (
    <Box
      flexDirection="row"
      width={inner}
      alignItems="center"
      flexShrink={0}
      ref={ring.nodeRef("kind")}
    >
      {/* Tabs fill their container; this one is as wide as its tabs so More follows them. */}
      <Box flexShrink={0} style={native ? { flex: "0 0 auto" } : undefined}>
        <Tabs
          tabs={tabKinds.map((kind) => ({
            value: kind,
            label: KIND_TAB[kind],
          }))}
          activeValue={draft.kind}
          onSelect={(value) => {
            setActive("kind");
            if (value !== draft.kind) set("kind", value as Kind);
          }}
          focused={focused && active === "kind"}
          keyboardNavigation={false}
          paneMenu={false}
          compact
          dense
          scrollable={false}
        />
      </Box>
      <MenuChoices
        title="Order type"
        choices={MORE_KINDS}
        value={TAB_KINDS.includes(draft.kind) ? null : draft.kind}
        controlRef={moreMenu}
        onSelect={(kind) => {
          setActive("kind");
          set("kind", kind);
        }}
        trigger={
          <Button
            label="More order types"
            displayLabel="More"
            variant="plain"
            compact
            onPress={() => {
              setActive("kind");
              moreMenu.current?.open();
            }}
          />
        }
      />
    </Box>
  );

  const tpslSummary = [
    draft.takeProfit > 0
      ? `TP ${price(draft.takeProfit, market.szDecimals)}`
      : "",
    draft.stopLoss > 0 ? `SL ${price(draft.stopLoss, market.szDecimals)}` : "",
    draft.reduceOnly ? "Reduce only" : "",
    showTif && draft.tif !== "Gtc"
      ? draft.tif === "Alo"
        ? "Post only"
        : "IOC"
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const advancedError =
    !advanced &&
    (problemAt("tp") ?? problemAt("sl") ?? problemAt("reduceOnly"))?.short;
  // TP and SL are stored as prices; in % mode the field edits the distance
  // from the entry price and the price shows beside it, and the other way round.
  const protection = (kind: "tp" | "sl") => {
    const stored = kind === "tp" ? draft.takeProfit : draft.stopLoss;
    const distance = kind === "tp" ? tpPercent(stored) : slPercent(stored);
    const inPercent = tpslUnit === "percent";
    return field(
      kind,
      kind === "tp" ? "Take profit" : "Stop loss",
      inPercent ? twoDecimals(distance) : stored,
      inPercent ? (stored > 0 ? number(distance, 2) : "") : priceText(stored),
      (value) =>
        set(
          kind === "tp" ? "takeProfit" : "stopLoss",
          inPercent
            ? kind === "tp"
              ? tpFromPercent(value)
              : slFromPercent(value)
            : value,
        ),
      {
        inputWidth,
        trailing: (
          <FieldNote>
            {stored > 0
              ? inPercent
                ? price(stored, market.szDecimals)
                : percent((kind === "tp" ? distance : -distance) / 100)
              : inPercent
                ? "%"
                : ""}
          </FieldNote>
        ),
        error: errorText(kind),
      },
    );
  };
  const advancedRows = advanced ? (
    <Box flexDirection="column" flexShrink={0} {...groupGap}>
      <Box
        flexDirection="row"
        width={inner}
        height={1}
        gap={1}
        flexShrink={0}
        ref={ring.nodeRef("tpslUnit")}
      >
        <Box width={LABEL_WIDTH} flexShrink={0}>
          <Text fg={active === "tpslUnit" ? colors.textBright : colors.textDim}>
            TP / SL
          </Text>
        </Box>
        <SegmentedControl
          value={tpslUnit}
          options={[
            { value: "price", label: "Price" },
            { value: "percent", label: "%" },
          ]}
          onChange={(value) => {
            setActive("tpslUnit");
            setTpslUnit(value as "price" | "percent");
          }}
          focused={focused && active === "tpslUnit"}
        />
      </Box>
      {protection("tp")}
      {protection("sl")}
      <Box
        flexDirection="column"
        flexShrink={0}
        ref={ring.nodeRef("reduceOnly")}
      >
        <Checkbox
          label="Reduce only"
          active={focused && active === "reduceOnly"}
          checked={draft.reduceOnly}
          onChange={(value) => {
            setActive("reduceOnly");
            set("reduceOnly", value);
          }}
        />
        {errorText("reduceOnly") ? (
          <Text fg={colors.negative} wrapText>
            {errorText("reduceOnly")}
          </Text>
        ) : null}
      </Box>
      {showTif ? (
        <Box
          flexDirection="row"
          width={inner}
          height={1}
          gap={1}
          flexShrink={0}
          ref={ring.nodeRef("tif")}
        >
          <Box width={LABEL_WIDTH} flexShrink={0}>
            <Text fg={active === "tif" ? colors.textBright : colors.textDim}>
              TIF
            </Text>
          </Box>
          <SegmentedControl
            value={draft.tif}
            options={[
              { value: "Gtc", label: "GTC" },
              { value: "Alo", label: "Post only" },
              { value: "Ioc", label: "IOC" },
            ]}
            onChange={(value) => {
              setActive("tif");
              set("tif", value as Draft["tif"]);
            }}
            focused={focused && active === "tif"}
          />
        </Box>
      ) : null}
    </Box>
  ) : null;
  const advancedRow = (
    <Box flexShrink={0} width={inner} ref={ring.nodeRef("advanced")}>
      <ActionRow
        label="Advanced"
        expanded={advanced}
        active={focused && active === "advanced"}
        width={inner}
        onPress={() => {
          setActive("advanced");
          setAdvanced(!advanced);
        }}
      >
        {!advanced && (advancedError || tpslSummary) ? (
          <Box flexGrow={1} flexShrink={1} overflow="hidden">
            <Text fg={advancedError ? colors.negative : colors.textDim}>
              {advancedError || tpslSummary}
            </Text>
          </Box>
        ) : null}
      </ActionRow>
    </Box>
  );

  const notes = [
    ...problems
      .filter((problem) => !problem.place)
      .map((problem) => ({ text: problem.message, color: colors.negative })),
    ...warnings.map((text) => ({ text, color: colors.warning })),
    ...(fill ? [{ text: fill, color: colors.warning }] : []),
  ];
  const noteRows = notes.length ? (
    <Box flexDirection="column" flexShrink={0} width={inner}>
      {notes.map((note) => (
        <Text key={note.text} fg={note.color} wrapText>
          {note.text}
        </Text>
      ))}
    </Box>
  ) : null;

  const money = (value: number | null | undefined) =>
    value != null && Math.abs(value) >= 100_000
      ? usdCompact(value)
      : usd(value);
  const liquidation =
    ticket.marginMode === "cross"
      ? `${missing} cross`
      : price(preview.liquidationPrice, market.szDecimals);
  const feeLabel = account.account?.fees ? "Fees" : "Base fees";
  const builderNote = builder ? (
    <Box flexShrink={0} width={inner} overflow="hidden">
      <Text fg={colors.textDim}>including Gloom's 0.1% builder fee</Text>
    </Box>
  ) : null;

  const button = (
    <Box flexShrink={0} ref={ring.nodeRef("submit")}>
      <ActionButton
        label={action.label}
        tone={action.tone}
        disabled={action.disabled}
        active={focused && active === "submit"}
        onPress={() => {
          setActive("submit");
          action.run();
        }}
        width={inner}
      />
    </Box>
  );

  const inputs = (
    <Box
      flexDirection="column"
      width={leftWidth}
      paddingX={1}
      flexShrink={0}
      {...(native ? { style: { rowGap: 8 } } : {})}
    >
      <Box ref={ring.nodeRef("side")} flexShrink={0}>
        <SideToggle
          value={draft.side}
          onChange={(side) => {
            setActive("side");
            set("side", side);
          }}
          focused={focused && active === "side"}
          width={inner}
        />
      </Box>
      {kindTabs}
      {leverageRows}
      {kindRows.length ? (
        <Box flexDirection="column" flexShrink={0} {...groupGap}>
          {kindRows}
        </Box>
      ) : null}
      {sizeRows}
      {advancedRow}
      {advancedRows}
      {noteRows}
      {twoColumns ? null : (
        <FigurePairs
          width={inner}
          labelWidth={7}
          items={[
            { label: "Value", value: money(preview.notional) },
            { label: "Margin", value: money(preview.marginRequired) },
            { label: "Liq.", value: liquidation },
            {
              label: feeLabel === "Fees" ? "Fees" : "Base fee",
              value: usd(preview.fee),
            },
          ]}
        />
      )}
      {button}
      {twoColumns ? null : builderNote}
    </Box>
  );

  return (
    <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
      <ScrollBox
        ref={scrollRef}
        flexGrow={1}
        contentOptions={{ flexDirection: "column", paddingTop: native ? 1 : 0 }}
      >
        <Box flexDirection="row" gap={2} flexShrink={0}>
          {inputs}
          {twoColumns ? (
            <TicketContext
              width={rightWidth}
              market={market}
              account={account.account}
              position={position}
              summary={[
                { label: "Order value", value: usd(preview.notional) },
                { label: "Margin", value: usd(preview.marginRequired) },
                { label: "Est. liq. price", value: liquidation },
                { label: feeLabel, value: usd(preview.fee) },
              ]}
              builder={!!builder}
            />
          ) : null}
        </Box>
      </ScrollBox>
    </Box>
  );
}
