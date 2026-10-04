import { useState } from "react";
import { Box, Text } from "gloomberb/ui";
import {
  Button,
  DialogFrame,
  FieldLabel,
  KeyValueRow,
  Section,
  SegmentedControl,
} from "gloomberb/components";
import { useDialogKeyboard, type PromptContext } from "gloomberb/dialog";
import { colors } from "gloomberb/theme";
import type { Market } from "../market";
import type { AccountSnapshot } from "../trading/types";
import { missing, percent, price, signed, size, tone, usd } from "./format";
import { LeverageSlider, sideColor } from "./controls";

export interface MarginChoice {
  marginMode: "cross" | "isolated";
  leverage: number;
  apply: boolean;
}

/** Cross or isolated and the leverage, set together; Apply leverage changes the account now. */
export function MarginDialog({
  resolve,
  coin,
  marginMode,
  leverage,
  max,
  onlyIsolated,
  canApply,
}: PromptContext<MarginChoice> & {
  coin: string;
  marginMode: "cross" | "isolated";
  leverage: number;
  max: number;
  onlyIsolated: boolean;
  canApply: boolean;
}) {
  const [mode, setMode] = useState(onlyIsolated ? "isolated" : marginMode);
  const [value, setValue] = useState(leverage);
  const stops = [
    ...(onlyIsolated ? [] : ["mode"]),
    "leverage",
    ...(canApply ? ["apply"] : []),
    "done",
  ];
  const [focus, setFocus] = useState(stops[0]!);
  const finish = (apply: boolean) =>
    resolve({ marginMode: mode, leverage: value, apply });
  useDialogKeyboard(
    (event) => {
      const consume = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      const index = stops.indexOf(focus);
      if (
        event.name === "tab" ||
        event.name === "down" ||
        event.name === "up" ||
        event.name === "j" ||
        event.name === "k"
      ) {
        consume();
        const back = event.shift || event.name === "up" || event.name === "k";
        setFocus(
          stops[(index + (back ? -1 : 1) + stops.length) % stops.length]!,
        );
        return;
      }
      if (event.name === "left" || event.name === "right") {
        consume();
        const delta = event.name === "right" ? 1 : -1;
        if (focus === "mode")
          setMode((old) => (old === "cross" ? "isolated" : "cross"));
        else if (focus === "leverage")
          setValue((old) =>
            Math.max(1, Math.min(max, old + delta * (event.shift ? 5 : 1))),
          );
        else if (canApply) setFocus(focus === "apply" ? "done" : "apply");
        return;
      }
      if (
        event.name === "enter" ||
        event.name === "return" ||
        event.name === "space"
      ) {
        consume();
        if (focus === "mode" && event.name === "space")
          setMode((old) => (old === "cross" ? "isolated" : "cross"));
        else finish(focus === "apply");
      }
    },
    { allowEditable: true },
  );
  return (
    <DialogFrame title={`${coin} margin`}>
      <Box flexDirection="column" width={44} gap={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          <FieldLabel label="Margin" active={focus === "mode"} width={10} />
          <SegmentedControl
            value={mode}
            options={[
              { value: "cross", label: "Cross", disabled: onlyIsolated },
              { value: "isolated", label: "Isolated" },
            ]}
            onChange={(next) => {
              setFocus("mode");
              setMode(next as "cross" | "isolated");
            }}
          />
        </Box>
        <Box flexDirection="row" gap={1} alignItems="center">
          <FieldLabel
            label="Leverage"
            active={focus === "leverage"}
            width={10}
          />
          <LeverageSlider
            value={value}
            max={max}
            onChange={(next) => {
              setFocus("leverage");
              setValue(next);
            }}
            focused={focus === "leverage"}
            width={33}
          />
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button
            label="Done"
            variant="primary"
            active={focus === "done"}
            onPress={() => finish(false)}
          />
          {canApply ? (
            <Button
              label="Apply leverage"
              variant="secondary"
              active={focus === "apply"}
              onPress={() => finish(true)}
            />
          ) : null}
        </Box>
      </Box>
    </DialogFrame>
  );
}

/** Beside a wide ticket: the order's figures, then this market's position and resting orders. */
export function TicketContext({
  width,
  market,
  account,
  position,
  summary,
  builder,
}: {
  width: number;
  market: Market;
  account: AccountSnapshot | null;
  position: AccountSnapshot["positions"][number] | undefined;
  summary: { label: string; value: string }[];
  builder: boolean;
}) {
  const labelWidth = 16;
  const row = (label: string, value: string, color?: string) => (
    <KeyValueRow
      key={label}
      label={label}
      value={value}
      color={color}
      labelWidth={labelWidth}
      width={width}
      emphasis={false}
    />
  );
  const orders = (account?.orders ?? [])
    .filter((o) => o.coin === market.coin)
    .map((o) => ({
      ...o,
      at: Number(o.isTrigger ? o.triggerPx : o.limitPx),
    }));
  // The orders nearest the mark matter first; the account pane lists the rest.
  const nearest = [...orders]
    .sort(
      (a, b) =>
        Math.abs(a.at - (market.mark ?? a.at)) -
        Math.abs(b.at - (market.mark ?? b.at)),
    )
    .slice(0, 6)
    .sort((a, b) => b.at - a.at);
  const szi = Number(position?.szi ?? 0);
  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      <Section title="Order" width={width} marginTop={0}>
        {summary.map((item) => row(item.label, item.value))}
        {builder ? (
          <Box paddingLeft={width >= labelWidth + 34 ? labelWidth : 0}>
            <Text fg={colors.textDim}>including Gloom's 0.1% builder fee</Text>
          </Box>
        ) : null}
      </Section>
      {position && szi ? (
        <Section title="Position" width={width}>
          {row(
            "Size",
            `${szi > 0 ? "Long" : "Short"} ${size(Math.abs(szi), market.szDecimals)} ${market.symbol}`,
            szi > 0 ? colors.positive : colors.negative,
          )}
          {row("Entry", price(Number(position.entryPx), market.szDecimals))}
          {row(
            "Unrealized PnL",
            `${signed(Number(position.unrealizedPnl))} (${percent(Number(position.returnOnEquity))})`,
            tone(Number(position.unrealizedPnl)),
          )}
          {row(
            "Liq. price",
            position.liquidationPx == null
              ? missing
              : price(Number(position.liquidationPx), market.szDecimals),
          )}
          {row(
            "Margin",
            `${usd(Number(position.marginUsed))} (${position.leverage.value}x ${position.leverage.type})`,
          )}
        </Section>
      ) : null}
      {nearest.length ? (
        <Section title="Open Orders" width={width}>
          {nearest.map((o) => (
            <Box key={o.oid} flexDirection="row" height={1} gap={1}>
              <Box width={5} flexShrink={0}>
                <Text fg={sideColor(o.side === "B" ? "buy" : "sell")}>
                  {o.side === "B" ? "Buy" : "Sell"}
                </Text>
              </Box>
              <Box width={12} flexShrink={0} alignItems="flex-end">
                <Text fg={colors.text}>
                  {size(Number(o.sz), market.szDecimals)}
                </Text>
              </Box>
              <Box width={11} flexShrink={0} alignItems="flex-end">
                <Text fg={colors.text}>{price(o.at, market.szDecimals)}</Text>
              </Box>
              <Box flexShrink={1} overflow="hidden">
                <Text fg={colors.textDim}>{o.orderType}</Text>
              </Box>
            </Box>
          ))}
        </Section>
      ) : null}
    </Box>
  );
}
