import { useMemo } from 'react';
import { Box } from 'gloomberb/ui';
import { CompositeChart, PaneStatusBody, pricePointsToResolvedSeries } from 'gloomberb/components';
import { colors } from 'gloomberb/theme';
import type { MarketSnapshot } from '../market';
import type { AccountSnapshot } from '../trading/types';
import { compact, price } from './format';

export function CandleChart({ snapshot, account, width, height, focused }: { snapshot: MarketSnapshot; account?: AccountSnapshot | null; width: number; height: number; focused: boolean }) {
  const points = useMemo(() => snapshot.candles.map(c => ({ date: new Date(c.time), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })), [snapshot.candles]);
  const series = useMemo(() => [
    pricePointsToResolvedSeries(points, { id: 'price', label: snapshot.market?.coin ?? 'Price', color: colors.positive, unit: 'USD', style: 'candles', axis: 'right', panelId: 'price' }),
    pricePointsToResolvedSeries(points.map(p => ({ date: p.date, close: p.volume })), { id: 'volume', label: 'Volume (coin)', color: colors.textDim, unit: 'coin', style: 'columns', axis: 'right', panelId: 'volume' }),
  ], [points, snapshot.market?.coin]);
  const position = account?.positions.find(p => p.coin === snapshot.market?.coin);
  const levels = [
    ...(position ? [
      { id: 'entry', value: Number(position.entryPx), color: colors.borderFocused, editable: false, actionable: false },
      ...(position.liquidationPx ? [{ id: 'liquidation', value: Number(position.liquidationPx), color: colors.negative, editable: false, actionable: false }] : []),
    ] : []),
    ...(account?.orders.filter(o => o.coin === snapshot.market?.coin).map(o => ({ id: `order-${o.oid}`, value: Number(o.isTrigger ? o.triggerPx : o.limitPx), color: o.side === 'B' ? colors.positive : colors.negative, editable: false, actionable: false })) ?? []),
  ];
  return <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} overflow="hidden">
    <PaneStatusBody loading={!points.length && !snapshot.error} error={!points.length ? snapshot.error : null} subject="candles" empty={!points.length && snapshot.status === 'live'} emptyTitle="No candles for this interval.">
      <CompositeChart series={series} panels={[{ id: 'price', height: 4 }, { id: 'volume', height: 1 }]}
        width={width} height={Math.max(6, height)} focused={focused} interactive navigable showLegend
        levels={{ seriesId: 'price', items: levels }} axisWidth={10} viewportResetKey={snapshot.market?.coin}
        formatAxisValue={(value, axis) => axis.unit === 'coin' ? compact(value) : price(value, snapshot.market?.szDecimals)}
        formatValue={(v, s) => s.id === 'volume' ? v.toLocaleString('en-US', { maximumFractionDigits: 3 }) : price(v, snapshot.market?.szDecimals)} />
    </PaneStatusBody>
  </Box>;
}
