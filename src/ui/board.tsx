import { useCallback, useMemo, useRef } from 'react';
import { DataTableStackView, PaneStatusBody, QueryBar, usePaneTabs, useQueryBarSearch, type DataTableColumn } from 'gloomberb/components';
import { usePaneSettingValue, usePluginAppActions, usePluginConfigState, usePluginPaneState } from 'gloomberb/react';
import { colors } from 'gloomberb/theme';
import type { PaneProps } from 'gloomberb/types/plugin';
import type { Market } from '../market';
import { compact, number, percent, price, tone } from './format';
import { useAccount, useBoard, useLiveFooter } from './hooks';
import { MarketView, HyperliquidMarketPane } from './market';

export const MARKET_COLUMNS: DataTableColumn[] = [
  { id: 'coin', label: 'Market', width: 17, align: 'left' }, { id: 'dex', label: 'DEX', width: 8, align: 'left' },
  { id: 'assetClass', label: 'Class', width: 13, align: 'left' }, { id: 'mark', label: 'Mark', width: 13, align: 'right' },
  { id: 'change24h', label: '24h rolling %', width: 14, align: 'right' },
  { id: 'fundingHourly', label: 'Current /1h', width: 12, align: 'right' },
  { id: 'fundingApr', label: 'Simple APR', width: 11, align: 'right' },
  { id: 'oiUsd', label: 'OI USD', width: 12, align: 'right' },
  { id: 'volume24h', label: '24h vol USD', width: 12, align: 'right' },
  { id: 'oracle', label: 'Oracle', width: 13, align: 'right' },
  { id: 'premium', label: 'Premium %', width: 11, align: 'right' },
  { id: 'funding8h', label: 'Current /8h', width: 12, align: 'right' },
  { id: 'oiCoin', label: 'OI coin', width: 14, align: 'right' },
  { id: 'oiVolume', label: 'OI / vol', width: 10, align: 'right' },
  { id: 'maxLeverage', label: 'Max lev', width: 9, align: 'right' },
  { id: 'onlyIsolated', label: 'Margin', width: 10, align: 'left' },
  { id: 'collateral', label: 'Collateral', width: 11, align: 'left' },
];
const CLASSES = ['All', 'Stocks', 'Indices', 'Energy', 'Metals', 'FX', 'Crypto', 'Favorites', 'My positions'];
export function marketCell(row: Market, id: string) {
  const value = row[id as keyof Market];
  if (['fundingHourly', 'funding8h', 'fundingApr', 'premium', 'change24h'].includes(id)) return { text: percent(value as number | null, id === 'fundingHourly' || id === 'funding8h' ? 4 : 2), value: value == null ? null : Number(value) * 100, color: tone(value as number | null) };
  if (id === 'mark' || id === 'oracle') return { text: price(value as number | null, row.szDecimals), value: value as number | null, color: colors.textBright };
  if (['oiUsd', 'volume24h', 'oiCoin'].includes(id)) return { text: compact(value as number | null), value: value as number | null };
  if (id === 'maxLeverage') return { text: `${row.maxLeverage}x`, value: row.maxLeverage };
  if (id === 'onlyIsolated') return { text: row.onlyIsolated ? 'Isolated' : 'Cross / iso' };
  if (id === 'assetClass') return { text: `${row.assetClass}${['Stocks', 'Indices', 'Energy', 'Metals', 'FX'].includes(row.assetClass) ? ' 24/7' : ''}` };
  if (id === 'oiVolume') return { text: value == null ? '--' : `${number(value as number)}x`, value: value as number | null };
  if (id === 'dex') return { text: row.dex || 'Native', color: colors.textDim };
  return { text: String(value ?? '--') };
}
export function HyperliquidBoardPane(props: PaneProps) {
  const [market] = usePaneSettingValue<string>('market', '');
  return market ? <HyperliquidMarketPane {...props} /> : <Board {...props} />;
}
function Board(props: PaneProps) {
  const { focused, width, height } = props;
  const board = useBoard();
  const account = useAccount();
  const app = usePluginAppActions();
  const [category, setCategory] = usePluginPaneState('category', 'All');
  const [query, setQuery] = usePluginPaneState('query', '');
  const [dex, setDex] = usePluginPaneState('dex', 'all');
  const [minVolume, setMinVolume] = usePluginConfigState('minVolumeUsd', 0);
  const [minOi, setMinOi] = usePluginConfigState('minOiUsd', 0);
  const [favorites, setFavorites] = usePluginConfigState<string[]>('favorites', []);
  const [sort, setSort] = usePluginPaneState('boardSort', { id: 'volume24h', direction: 'desc' as 'asc' | 'desc' });
  const [selected, setSelected] = usePluginPaneState<string | null>('boardSelected', null);
  const [open, setOpen] = usePluginPaneState<string | null>('boardOpen', null);
  const search = useQueryBarSearch();
  const rows = useMemo(() => {
    const positions = new Set(account.account?.positions.map(p => p.coin));
    return board.markets.filter(m =>
      (category === 'All' || category === 'Favorites' && favorites.includes(m.coin) || category === 'My positions' && positions.has(m.coin) || m.assetClass === category) &&
      (!query || `${m.coin} ${m.assetClass}`.toLowerCase().includes(query.toLowerCase())) &&
      (dex === 'all' || m.dex === dex) && (m.volume24h ?? 0) >= minVolume && (m.oiUsd ?? 0) >= minOi,
    ).sort((a, b) => {
      const av = a[sort.id as keyof Market], bv = b[sort.id as keyof Market];
      if (av == null) return 1; if (bv == null) return -1;
      return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))) * (sort.direction === 'asc' ? 1 : -1);
    });
  }, [board.markets, query, dex, category, minVolume, minOi, favorites, sort, account.account?.positions]);
  const selectedMarket = rows.find(m => m.coin === selected) ?? rows[0];
  const toggleFavorite = useCallback(() => { if (selectedMarket) setFavorites(old => old.includes(selectedMarket.coin) ? old.filter(v => v !== selectedMarket.coin) : [...old, selectedMarket.coin]); }, [selectedMarket, setFavorites]);
  const tabs = usePaneTabs(open ? null : { tabs: CLASSES.map(value => ({ value, label: value })), activeValue: category, onSelect: setCategory, focused: focused && !search.active, compact: true, dense: true });
  useLiveFooter('hyperliquid-board', board, [
    { id: 'favorite', key: 'f', label: 'avorite', title: 'Toggle favorite', disabled: !selectedMarket, onPress: toggleFavorite },
    { id: 'market', key: 'm', label: 'arket window', disabled: !selectedMarket, onPress: () => selectedMarket && app.createPaneFromTemplate('hyperliquid-market-new', { symbol: selectedMarket.coin }) },
    { id: 'analytics', key: 'a', label: 'nalytics', onPress: () => app.createPaneFromTemplate('hyperliquid-analytics-new') },
    { id: 'wallet', key: 'w', label: 'allet', onPress: () => app.createPaneFromTemplate('hyperliquid-setup-new') },
  ], account.status, !open);
  const favoritesRef = useRef(favorites); favoritesRef.current = favorites;
  const renderCell = useCallback((row: Market, column: DataTableColumn) => {
    const cell = marketCell(row, column.id);
    if (column.id === 'coin') return { ...cell, text: `${favoritesRef.current.includes(row.coin) ? '* ' : ''}${row.coin}`, color: colors.textBright };
    if (column.id === 'mark') return { ...cell, color: row.tickDirection && Date.now() - row.priceTime < 750 ? tone(row.tickDirection) : colors.textBright };
    return cell;
  }, []);
  const thresholdOptions = [{ value: '0', label: 'Any' }, { value: '100000', label: '$100K' }, { value: '1000000', label: '$1M' }, { value: '10000000', label: '$10M' }, { value: '100000000', label: '$100M' }];
  return <DataTableStackView<Market>
    focused={focused} keyboardNavigation={!search.active} rootWidth={width} rootHeight={height}
    rootBackgroundColor={colors.panel} rootBefore={<>{tabs.strip}<QueryBar width={width}
      search={{ value: query, onChange: setQuery, placeholder: 'Search perpetuals', focused, ...search.searchProps }}
      filters={[
        { id: 'dex', label: 'DEX', value: dex, defaultValue: 'all', options: [{ value: 'all', label: 'All DEXes' }, ...Array.from(new Set(board.markets.map(m => m.dex))).map(value => ({ value, label: value || 'Native' }))], onChange: setDex },
        { id: 'volume', label: 'Vol ≥', value: String(minVolume), defaultValue: '0', options: thresholdOptions, onChange: value => setMinVolume(Number(value)) },
        { id: 'oi', label: 'OI ≥', value: String(minOi), defaultValue: '0', options: thresholdOptions, onChange: value => setMinOi(Number(value)) },
      ]} />
    </>}
    columns={MARKET_COLUMNS} items={rows} getItemKey={row => row.coin} renderCell={renderCell}
    selectedTextOverridesCellColor getRowVersion={row => `${row.asOf}:${row.mark}:${favorites.includes(row.coin)}`}
    selection={{ kind: 'id', selectedId: selectedMarket?.coin ?? null, getId: row => row.coin, onChange: setSelected }}
    sortColumnId={sort.id} sortDirection={sort.direction} onHeaderClick={id => setSort(previous => ({ id, direction: previous.id === id && previous.direction === 'desc' ? 'asc' : 'desc' }))}
    onActivate={row => setOpen(row.coin)} detailOpen={!!open} onBack={() => setOpen(null)} detailTitle={open ?? ''}
    detailContent={open ? <MarketView {...props} height={Math.max(5, height - 1)} coin={open} embedded /> : null}
    emptyContent={!board.markets.length ? <PaneStatusBody loading={!board.error} error={board.error} subject="perpetual markets" /> : undefined}
    emptyStateTitle="No markets match these filters." emptyStateHint="Change the class, DEX, or minimum volume." virtualize
  />;
}
