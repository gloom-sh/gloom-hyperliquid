import { useMemo, useState } from "react";
import { Box, Text, TextAttributes } from "gloomberb/ui";
import {
  DataTableView,
  PaneStatusBody,
  QueryBar,
  type DataTableColumn,
} from "gloomberb/components";
import { usePaneSettingValue, usePluginAppActions } from "gloomberb/react";
import { blendHex, colors } from "gloomberb/theme";
import type { PaneProps } from "gloomberb/types/plugin";
import type { BookLevel, MarketSnapshot, OrderBook } from "../market";
import { getMarketService } from "../runtime";
import {
  bookTickOptions,
  compact,
  missing,
  number,
  price,
  size,
  tick,
  time,
} from "./format";
import { useMarket, useLiveFooter } from "./hooks";

interface BookRow {
  id: string;
  side: "Bid" | "Ask" | "Spread";
  level: BookLevel | null;
}
export const bookPrecisionValue = (book?: OrderBook | null) =>
  book?.nSigFigs == null
    ? "raw"
    : book.nSigFigs === 5
      ? `5:${book.mantissa ?? 1}`
      : String(book.nSigFigs);
export function bookPrecisionConfig(value: string) {
  const [digits, step] = value.split(":");
  return digits === "raw"
    ? { nSigFigs: null }
    : {
        nSigFigs: Number(digits) as 2 | 3 | 4 | 5,
        ...(step ? { mantissa: Number(step) as 1 | 2 | 5 } : {}),
      };
}
/**
 * The ladder: asks above, bids below, one mid/spread row between them. The
 * depth bar is cumulative size and sits in the last column only. A row is
 * highlighted only while the book has the keyboard.
 */
export function BookView({
  snapshot,
  width,
  height,
  focused,
  onPrice,
  compactView = false,
}: {
  snapshot: MarketSnapshot;
  width: number;
  height: number;
  focused: boolean;
  onPrice?: (value: number) => void;
  compactView?: boolean;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const book = snapshot.book;
  const szDecimals = snapshot.market?.szDecimals;
  // Header and the spread row take two rows; the rest splits between sides.
  const levels = Math.max(3, Math.min(40, Math.floor((height - 2) / 2)));
  const rows = useMemo<BookRow[]>(() => {
    if (!book) return [];
    const asks = book.asks.slice(0, levels).reverse();
    return [
      ...asks.map((level, i) => ({
        id: `ask-${asks.length - 1 - i}`,
        side: "Ask" as const,
        level,
      })),
      { id: "spread", side: "Spread" as const, level: null },
      ...book.bids
        .slice(0, levels)
        .map((level, i) => ({ id: `bid-${i}`, side: "Bid" as const, level })),
    ];
  }, [book, levels]);
  const max = Math.max(1, ...rows.map((r) => r.level?.totalSize ?? 0));
  const bestAsk = Math.max(
    0,
    rows.findIndex((r) => r.side === "Spread") - 1,
  );
  const reference = book?.mid ?? snapshot.market?.mark;
  const columns: DataTableColumn[] = compactView
    ? [
        { id: "price", label: "Price", width: 11, align: "right" },
        { id: "size", label: "Size", width: 9, align: "right" },
        { id: "total", label: "Total", width: 10, align: "right" },
      ]
    : [
        { id: "price", label: "Price", width: 13, align: "right" },
        { id: "size", label: "Size", width: 13, align: "right" },
        { id: "total", label: "Total", width: 14, align: "right" },
        { id: "totalUsd", label: "Total USD", width: 12, align: "right" },
      ];
  const barColumn = columns.at(-1)!.id;
  return (
    <DataTableView<BookRow>
      focused={focused}
      rootWidth={width}
      rootHeight={height}
      rootBackgroundColor={colors.panel}
      columns={columns}
      items={rows}
      getItemKey={(r) => r.id}
      sortColumnId={null}
      sortDirection="asc"
      isNavigable={(r) => r.side !== "Spread"}
      selection={
        focused
          ? {
              kind: "index",
              selectedIndex: selected ?? bestAsk,
              onChange: setSelected,
            }
          : { kind: "none" }
      }
      selectedTextOverridesCellColor
      getRowBackgroundColor={(r) =>
        r.side === "Spread"
          ? blendHex(colors.panel, colors.border, 0.45)
          : undefined
      }
      onActivate={(r) => r.level && onPrice?.(r.level.price)}
      renderCell={(row, column) => {
        if (!row.level) {
          if (column.id === "price")
            return {
              text: price(book?.mid, szDecimals),
              value: book?.mid ?? null,
              color: colors.textBright,
              attributes: TextAttributes.BOLD,
            };
          if (column.id === "size")
            return {
              text: tick(book?.spread, reference, szDecimals),
              value: book?.spread ?? null,
              color: colors.textDim,
            };
          if (column.id === "total")
            return {
              text:
                book?.spreadBps == null
                  ? missing
                  : `${number(book.spreadBps, 2)} bp`,
              value: book?.spreadBps ?? null,
              color: colors.textDim,
            };
          return { text: "" };
        }
        const level = row.level;
        const color = row.side === "Bid" ? colors.positive : colors.negative;
        if (column.id === "price")
          return {
            text: price(level.price, szDecimals),
            value: level.price,
            color,
            onMouseDown: onPrice
              ? (event: { stopPropagation?: () => void }) => {
                  event.stopPropagation?.();
                  onPrice(level.price);
                }
              : undefined,
          };
        const value =
          column.id === "size"
            ? level.size
            : column.id === "total"
              ? level.totalSize
              : level.totalUsd;
        const label =
          column.id === "totalUsd" ? compact(value) : size(value, szDecimals);
        if (column.id !== barColumn) return { text: label, value };
        const ratio = level.totalSize / max;
        return {
          text: label,
          value,
          content: (
            <Box
              width="100%"
              height={1}
              position="relative"
              flexDirection="row"
              justifyContent="flex-end"
            >
              {ratio > 0.02 ? (
                <Box
                  position="absolute"
                  right={0}
                  top={0}
                  height={1}
                  width={`${Math.min(100, ratio * 100)}%`}
                  backgroundColor={blendHex(colors.panel, color, 0.2)}
                />
              ) : null}
              {/* Positioned after the bar so the number paints above it. */}
              <Box position="relative">
                <Text fg={colors.text}>{label}</Text>
              </Box>
            </Box>
          ),
        };
      }}
      emptyContent={
        !book && !snapshot.error ? (
          <PaneStatusBody loading subject="order book" />
        ) : undefined
      }
      emptyStateTitle={
        snapshot.error ? "Order book unavailable." : "No book levels."
      }
      emptyStateHint={snapshot.error ?? undefined}
    />
  );
}
export function TradeTape({
  snapshot,
  width,
  height,
  focused,
}: {
  snapshot: MarketSnapshot;
  width: number;
  height: number;
  focused: boolean;
}) {
  return (
    <DataTableView
      focused={focused}
      rootWidth={width}
      rootHeight={height}
      columns={[
        { id: "time", label: "Time UTC", width: 9, align: "left" },
        { id: "side", label: "Side", width: 5, align: "left" },
        { id: "price", label: "Price", width: 12, align: "right" },
        { id: "size", label: "Size", width: 12, align: "right" },
        { id: "value", label: "Value USD", width: 11, align: "right" },
      ]}
      items={snapshot.trades}
      getItemKey={(r) => r.id}
      selection={{ kind: "none" }}
      sortColumnId={null}
      sortDirection="desc"
      renderCell={(r, c) => ({
        text:
          c.id === "time"
            ? time(r.time)
            : c.id === "side"
              ? r.side === "buy"
                ? "Buy"
                : "Sell"
              : c.id === "price"
                ? price(r.price, snapshot.market?.szDecimals)
                : c.id === "size"
                  ? size(r.size, snapshot.market?.szDecimals)
                  : number(r.price * r.size, 0),
        value:
          c.id === "time"
            ? new Date(r.time).toISOString()
            : c.id === "price"
              ? r.price
              : c.id === "size"
                ? r.size
                : c.id === "value"
                  ? r.price * r.size
                  : undefined,
        color:
          c.id === "price" || c.id === "side"
            ? r.side === "buy"
              ? colors.positive
              : colors.negative
            : undefined,
      })}
      emptyContent={
        !snapshot.trades.length &&
        !snapshot.error &&
        snapshot.status !== "live" ? (
          <PaneStatusBody loading subject="trades" />
        ) : undefined
      }
      emptyStateTitle="No trades yet."
    />
  );
}
export function HyperliquidBookPane(props: PaneProps) {
  const [coin] = usePaneSettingValue("market", "BTC");
  const snapshot = useMarket(coin);
  const app = usePluginAppActions();
  useLiveFooter("hyperliquid-book", snapshot, [
    {
      id: "market",
      key: "m",
      label: "arket",
      onPress: () =>
        app.createPaneFromTemplate("hyperliquid-market-new", { symbol: coin }),
    },
  ]);
  return (
    <Box flexGrow={1} flexDirection="column" minHeight={0}>
      <QueryBar
        width={props.width}
        filters={[
          {
            id: "aggregation",
            label: "Tick",
            value: bookPrecisionValue(snapshot.book),
            options: bookTickOptions(
              snapshot.book?.mid ?? snapshot.market?.mark,
              snapshot.market?.szDecimals,
              bookPrecisionValue(snapshot.book),
            ),
            onChange: (value) => {
              getMarketService(snapshot.network).setBookAggregation(
                coin,
                bookPrecisionConfig(value),
              );
            },
          },
        ]}
      />
      <BookView
        snapshot={snapshot}
        {...props}
        height={Math.max(4, props.height - 1)}
        onPrice={(value) =>
          app.createPaneFromTemplate("hyperliquid-market-new", {
            symbol: coin,
            values: { initialLimitPrice: String(value), defaultTab: "Ticket" },
          })
        }
      />
    </Box>
  );
}
