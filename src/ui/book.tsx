import { useMemo, useState } from 'react';
import { Box, Text, useUiCapabilities } from 'gloomberb/ui';
import { DataTableView, QueryBar, StatGrid, type DataTableColumn } from 'gloomberb/components';
import { usePaneSettingValue, usePluginAppActions } from 'gloomberb/react';
import { colors } from 'gloomberb/theme';
import type { PaneProps } from 'gloomberb/types/plugin';
import type { BookLevel, MarketSnapshot, OrderBook } from '../market';
import { getMarketService } from '../runtime';
import { compact, number, price, time } from './format';
import { useMarket, useLiveFooter } from './hooks';

const COLUMNS: DataTableColumn[] = [
  { id: 'side', label: 'Side', width: 4, align: 'left' }, { id: 'price', label: 'Price', width: 13, align: 'right' },
  { id: 'size', label: 'Size', width: 12, align: 'right' }, { id: 'total', label: 'Total', width: 12, align: 'right' },
];
interface BookRow { id: string; side: 'Bid' | 'Ask'; level: BookLevel }
export const BOOK_PRECISION_OPTIONS = [
  { value: 'raw', label: 'Full precision' },
  ...[2, 3, 4].map(n => ({ value: String(n), label: `${n} significant digits` })),
  ...[1, 2, 5].map(n => ({ value: `5:${n}`, label: `5 digits, step ${n}` })),
];
export const bookPrecisionValue = (book?: OrderBook | null) => book?.nSigFigs == null ? 'raw' : book.nSigFigs === 5 ? `5:${book.mantissa ?? 1}` : String(book.nSigFigs);
export function bookPrecisionConfig(value: string) {
  const [digits, step] = value.split(':');
  return digits === 'raw' ? { nSigFigs: null } : { nSigFigs: Number(digits) as 2 | 3 | 4 | 5, ...(step ? { mantissa: Number(step) as 1 | 2 | 5 } : {}) };
}
export function BookView({ snapshot, width, height, focused, onPrice, compactView = false }: { snapshot: MarketSnapshot; width: number; height: number; focused: boolean; onPrice?: (value: number) => void; compactView?: boolean }) {
  const native = useUiCapabilities().nativePaneChrome;
  const [selected, setSelected] = useState<number | null>(null);
  const levels = Math.max(3, Math.min(14, Math.floor((height - 4) / 2)));
  const rows = useMemo<BookRow[]>(() => [
    ...(snapshot.book?.asks.slice(0, levels).reverse().map((level, i) => ({ id: `ask-${i}`, side: 'Ask' as const, level })) ?? []),
    ...(snapshot.book?.bids.slice(0, levels).map((level, i) => ({ id: `bid-${i}`, side: 'Bid' as const, level })) ?? []),
  ], [snapshot.book, levels]);
  const max = Math.max(1, ...rows.map(r => r.level.totalSize));
  return <DataTableView<BookRow> focused={focused} rootWidth={width} rootHeight={height} rootBackgroundColor={colors.panel}
    columns={compactView ? [{ id: 'price', label: 'Price', width: 14, align: 'right' }, { id: 'size', label: 'Size', width: 15, align: 'right' }] : COLUMNS} items={rows} getItemKey={r => r.id}
    sortColumnId={null} sortDirection="asc" selection={{ kind: 'index', selectedIndex: selected, onChange: setSelected }}
    selectedTextOverridesCellColor onActivate={r => onPrice?.(r.level.price)}
    rootBefore={<StatGrid width={width} columns={compactView ? 1 : 2} items={[
      { label: 'Spread', value: price(snapshot.book?.spread, snapshot.market?.szDecimals), detail: snapshot.book?.spreadBps == null ? undefined : `${number(snapshot.book.spreadBps, 2)} bp` },
      ...(!compactView ? [{ label: 'Mid', value: price(snapshot.book?.mid, snapshot.market?.szDecimals) }] : []),
    ]} />}
    renderCell={(row, column) => {
      const color = row.side === 'Bid' ? colors.positive : colors.negative;
      if (column.id === 'side') return { text: row.side, color };
      if (column.id === 'price') return { text: price(row.level.price, snapshot.market?.szDecimals), value: row.level.price, color };
      const value = column.id === 'size' ? row.level.size : row.level.totalSize;
      const label = number(value, snapshot.market?.szDecimals ?? 3);
      return { text: label, value, content: <Box width="100%" height={1} position="relative" justifyContent="flex-end">
        <Box position="absolute" right={0} top={0} height={1} width={`${Math.max(1, row.level.totalSize / max * 100)}%`} backgroundColor={color} style={native ? { opacity: 0.13 } : undefined} />
        <Text fg={colors.text}>{label}</Text>
      </Box> };
    }} emptyStateTitle={snapshot.error ? 'Order book unavailable.' : 'Waiting for book levels.'} emptyStateHint={snapshot.error ?? undefined} />;
}
export function TradeTape({ snapshot, width, height, focused }: { snapshot: MarketSnapshot; width: number; height: number; focused: boolean }) {
  return <DataTableView focused={focused} rootWidth={width} rootHeight={height} columns={[
    { id: 'time', label: 'Time UTC', width: 9, align: 'left' }, { id: 'side', label: 'Side', width: 5, align: 'left' },
    { id: 'price', label: 'Price', width: 13, align: 'right' }, { id: 'size', label: 'Size', width: 13, align: 'right' }, { id: 'value', label: 'Value USD', width: 12, align: 'right' },
  ]} items={snapshot.trades} getItemKey={r => r.id} selection={{ kind: 'none' }} sortColumnId={null} sortDirection="desc"
    renderCell={(r, c) => ({ text: c.id === 'time' ? time(r.time) : c.id === 'side' ? r.side.toUpperCase() : c.id === 'price' ? price(r.price, snapshot.market?.szDecimals) : c.id === 'size' ? number(r.size, snapshot.market?.szDecimals) : compact(r.price * r.size), color: c.id === 'price' || c.id === 'side' ? r.side === 'buy' ? colors.positive : colors.negative : undefined })}
    emptyStateTitle="Waiting for trades." />;
}
export function HyperliquidBookPane(props: PaneProps) {
  const [coin] = usePaneSettingValue('market', 'BTC');
  const snapshot = useMarket(coin);
  const app = usePluginAppActions();
  useLiveFooter('hyperliquid-book', snapshot, [{ id: 'market', key: 'm', label: 'arket', onPress: () => app.createPaneFromTemplate('hyperliquid-market-new', { symbol: coin }) }]);
  return <Box flexGrow={1} flexDirection="column" minHeight={0}>
    <QueryBar width={props.width} filters={[{ id: 'aggregation', label: 'Precision', value: bookPrecisionValue(snapshot.book), options: BOOK_PRECISION_OPTIONS, onChange: value => {
      getMarketService(snapshot.network).setBookAggregation(coin, bookPrecisionConfig(value));
    } }]} />
    <BookView snapshot={snapshot} {...props} height={Math.max(4, props.height - 1)} onPrice={value => app.createPaneFromTemplate('hyperliquid-market-new', { symbol: coin, values: { initialLimitPrice: String(value), defaultTab: 'Ticket' } })} />
  </Box>;
}
