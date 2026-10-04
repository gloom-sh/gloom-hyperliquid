import { useMemo } from "react";
import { Box, useUiCapabilities } from "gloomberb/ui";
import {
  CompositeChart,
  PaneStatusBody,
  pricePointsToResolvedSeries,
} from "gloomberb/components";
import { blendHex, colors } from "gloomberb/theme";
import type { MarketSnapshot } from "../market";
import type { AccountSnapshot } from "../trading/types";
import { compactAxis, price, size } from "./format";

export function CandleChart({
  snapshot,
  account,
  width,
  height,
  focused,
}: {
  snapshot: MarketSnapshot;
  account?: AccountSnapshot | null;
  width: number;
  height: number;
  focused: boolean;
}) {
  const points = useMemo(
    () =>
      snapshot.candles.map((c) => ({
        date: new Date(c.time),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      })),
    [snapshot.candles],
  );
  const series = useMemo(
    () => [
      pricePointsToResolvedSeries(points, {
        id: "price",
        label: snapshot.market?.coin ?? "Price",
        color: colors.positive,
        unit: "USD",
        style: "candles",
        axis: "right",
        panelId: "price",
      }),
      pricePointsToResolvedSeries(
        points.map((p) => ({ date: p.date, close: p.volume })),
        {
          id: "volume",
          label: `Volume ${snapshot.market?.symbol ?? ""}`.trim(),
          color: colors.textDim,
          unit: "coin",
          style: "columns",
          axis: "right",
          panelId: "volume",
        },
      ),
    ],
    [points, snapshot.market?.coin, snapshot.market?.symbol],
  );
  const native = useUiCapabilities().nativePaneChrome;
  const position = account?.positions.find(
    (p) => p.coin === snapshot.market?.coin,
  );
  // Levels draw over the candles. Resting orders are context: on the desktop
  // a translucent side colour lets the candles show through where a line
  // crosses them; the terminal has no translucency, so it gets a dimmed blend.
  // Entry and liquidation keep full strength.
  const orderColor = (buy: boolean) => {
    const side = buy ? colors.positive : colors.negative;
    return native && /^#[0-9a-f]{6}$/i.test(side)
      ? `${side}80`
      : blendHex(colors.bg, side, 0.6);
  };
  const levels = [
    ...(position
      ? [
          {
            id: "entry",
            value: Number(position.entryPx),
            color: colors.borderFocused,
            editable: false,
            actionable: false,
          },
          ...(position.liquidationPx
            ? [
                {
                  id: "liquidation",
                  value: Number(position.liquidationPx),
                  color: colors.warning,
                  editable: false,
                  actionable: false,
                },
              ]
            : []),
        ]
      : []),
    ...(account?.orders
      .filter((o) => o.coin === snapshot.market?.coin)
      .map((o) => ({
        id: `order-${o.oid}`,
        value: Number(o.isTrigger ? o.triggerPx : o.limitPx),
        color: orderColor(o.side === "B"),
        editable: false,
        actionable: false,
      })) ?? []),
  ];
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      minHeight={0}
      overflow="hidden"
    >
      {/* The live candle can arrive before the history request; one candle
          is still loading, not a chart. */}
      <PaneStatusBody
        loading={
          !snapshot.error &&
          (points.length === 1 ||
            (!points.length && snapshot.status !== "live"))
        }
        error={points.length < 2 ? snapshot.error : null}
        subject="candles"
        empty={!points.length && snapshot.status === "live"}
        emptyTitle="No candles for this interval."
      >
        <CompositeChart
          series={series}
          panels={[
            { id: "price", height: 4 },
            { id: "volume", height: 1 },
          ]}
          width={width}
          height={Math.max(6, height)}
          focused={focused}
          interactive
          navigable
          showLegend
          levels={{ seriesId: "price", items: levels }}
          axisWidth={10}
          viewportResetKey={snapshot.market?.coin}
          formatAxisValue={(value, axis) =>
            axis.unit === "coin"
              ? compactAxis(value)
              : price(value, snapshot.market?.szDecimals)
          }
          formatValue={(v, s) =>
            s.id === "volume"
              ? size(v, snapshot.market?.szDecimals)
              : price(v, snapshot.market?.szDecimals)
          }
        />
      </PaneStatusBody>
    </Box>
  );
}
