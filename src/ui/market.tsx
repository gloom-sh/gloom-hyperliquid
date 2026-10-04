import { useEffect, useState } from 'react';
import { Box, ScrollBox } from 'gloomberb/ui';
import { KeyValueRow, PaneStatusBody, QueryBar, Section, StatGrid, usePaneTabs } from 'gloomberb/components';
import { useAssetData, usePaneSettingValue, usePaneTitle, usePluginAppActions, usePluginPaneState } from 'gloomberb/react';
import type { PaneProps } from 'gloomberb/types/plugin';
import { resolveMarket, CANDLE_INTERVALS, type CandleInterval, type Market } from '../market';
import { loadCashReference, type CashReference } from '../cash';
import { getMarketService } from '../runtime';
import { compact, dateTime, number, percent, price, tone } from './format';
import { useAccount, useBoard, useClock, useLiveFooter, useMarket } from './hooks';
import { CandleChart } from './charts';
import { BOOK_PRECISION_OPTIONS, bookPrecisionConfig, bookPrecisionValue, BookView, TradeTape } from './book';
import { FundingHistory } from './analytics';
import { PositionsTable } from './account';
import { OrderTicket } from './ticket';

export function HyperliquidMarketPane(props: PaneProps) {
  const [coin] = usePaneSettingValue('market', 'BTC');
  const board = useBoard();
  const resolved = resolveMarket(board.markets, coin || 'BTC');
  usePaneTitle(`${resolved?.coin ?? coin ?? 'BTC'} perpetual`);
  if (!resolved) return <PaneStatusBody loading={!board.markets.length && !board.error} error={board.error} empty={board.markets.length > 0} emptyTitle={`No perpetual found for ${coin}.`} subject={coin} />;
  return <MarketView key={resolved.coin} {...props} coin={resolved.coin} />;
}
export function MarketView({ coin, embedded = false, ...props }: PaneProps & { coin: string; embedded?: boolean }) {
  const { focused, width, height } = props;
  const [focusZone, setFocusZone] = useState('chart');
  const [interval, setInterval] = usePluginPaneState<CandleInterval>(`interval:${coin}`, '15m');
  const [defaultTab] = usePaneSettingValue('defaultTab', 'Market');
  const [tab, setTab] = usePluginPaneState(`marketTab:${coin}`, ['Market', 'Chart', 'Book', 'Ticket', 'Trades', 'Funding', 'Open interest', 'Premium', 'Positions', 'Info'].find(v => v.toLowerCase() === defaultTab.toLowerCase()) ?? 'Market');
  const [initialLimitPrice] = usePaneSettingValue<number | undefined>('initialLimitPrice', undefined);
  const [bookPrice, setBookPrice] = useState<number | undefined>(initialLimitPrice);
  const snapshot = useMarket(coin, interval);
  const account = useAccount();
  const now = useClock(); const app = usePluginAppActions();
  const [cash, setCash] = useState<CashReference | null>(null);
  const provider = useAssetData();
  const symbol = snapshot.market?.underlyingSymbol;
  const market = snapshot.market;
  useEffect(() => {
    if (!symbol || !provider || !market?.mark) { setCash(null); return; }
    const controller = new AbortController();
    void loadCashReference(provider, symbol, market.mark, controller.signal).then(setCash).catch(() => {});
    return () => controller.abort();
  }, [symbol, provider, Math.floor(now / 60_000)]);
  const wide = width >= 135 && height >= 24;
  const views = wide ? ['Market', 'Chart', 'Book', 'Ticket', 'Trades', 'Funding', 'Open interest', 'Premium', 'Positions', 'Info'] : ['Market', 'Ticket', 'Book', 'Trades', 'Funding', 'Open interest', 'Premium', 'Positions', 'Info'];
  const tabs = usePaneTabs({ tabs: views.map(value => ({ value, label: value === 'Market' && !wide ? 'Chart' : value })), activeValue: tab, onSelect: setTab, focused, compact: true, dense: true, ...(embedded ? { queryBarWidth: width } : {}) });
  const seconds = Math.ceil((3_600_000 - now % 3_600_000) / 1000);
  useLiveFooter('hyperliquid-market', snapshot, [
    { id: 'ticket', key: 't', label: 'icket', onPress: () => setTab('Ticket') },
    { id: 'account', key: 'p', label: 'ositions', onPress: () => app.createPaneFromTemplate('hyperliquid-account-new') },
    { id: 'book', key: 'b', label: 'ook window', onPress: () => app.createPaneFromTemplate('hyperliquid-book-new', { symbol: coin }) },
    ...(symbol ? [{ id: 'cash', key: 'e', label: 'quity', onPress: () => app.openCommandBar(`DES ${symbol}`) }] : []),
    { id: 'wallet', key: 'w', label: 'allet', onPress: () => app.createPaneFromTemplate('hyperliquid-setup-new') },
  ], account.status);
  const stats = market ? [
    { label: 'Mark', value: price(market.mark, market.szDecimals) },
    { label: '24h rolling', value: percent(market.change24h), color: tone(market.change24h) },
    { label: 'Current /1h', value: percent(market.fundingHourly, 4), detail: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`, color: tone(market.fundingHourly) },
    { label: 'Open interest', value: `$${compact(market.oiUsd)}` },
    ...(height >= 20 ? [
      { label: 'Oracle', value: price(market.oracle, market.szDecimals) },
      { label: 'Premium', value: percent(market.premium), color: tone(market.premium) },
      { label: '24h volume', value: `$${compact(market.volume24h)}` },
      { label: 'Max leverage', value: `${market.maxLeverage}x`, detail: market.onlyIsolated ? 'Isolated only' : market.collateral },
    ] : []),
  ] : [];
  const statColumns = width >= 120 ? 4 : 2;
  const statsRows = Math.ceil(stats.length / statColumns);
  const bodyHeight = Math.max(5, height - tabs.rows - statsRows - 1);
  const pickPrice = (value: number) => { setBookPrice(value); if (!wide || tab !== 'Market') setTab('Ticket'); };
  const query = <QueryBar width={width} filters={[
    { id: 'interval', label: 'Candles', value: interval, options: CANDLE_INTERVALS.map(value => ({ value, label: value })), onChange: value => setInterval(value) },
    ...(tab === 'Book' || tab === 'Market' && wide ? [{ id: 'precision', label: 'Book', value: bookPrecisionValue(snapshot.book), options: BOOK_PRECISION_OPTIONS, onChange: (value: string) => getMarketService(snapshot.network).setBookAggregation(coin, bookPrecisionConfig(value)) }] : []),
  ]} meta={market ? `${market.assetClass}${market.alwaysOpen ? ' · 24/7' : ''} · ${market.dex || 'Native'} · ${market.collateral}` : undefined} />;
  return <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} overflow="hidden">{tabs.strip}{query}
    <PaneStatusBody loading={!market && !snapshot.error} error={!market ? snapshot.error : null} subject={coin}>
      <StatGrid width={width} items={stats} columns={statColumns} />
      {market && tab === 'Market' && wide ? <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
        <Box flexDirection="row" flexGrow={1} flexBasis={0} minHeight={0}>
          <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0} overflow="hidden" onMouseDown={() => setFocusZone('chart')}><CandleChart snapshot={snapshot} account={account.account} width={Math.max(40, width - 72)} height={Math.max(8, bodyHeight - 6)} focused={focused && focusZone === 'chart'} /></Box>
          <Box width={34} flexDirection="column" overflow="hidden" onMouseDown={() => setFocusZone('book')}><BookView snapshot={snapshot} width={34} height={Math.max(8, bodyHeight - 6)} focused={focused && focusZone === 'book'} compactView onPrice={pickPrice} /></Box>
          <Box width={38} flexDirection="column" overflow="hidden" onMouseDown={() => setFocusZone('ticket')}><OrderTicket market={market} book={snapshot.book} width={38} focused={focused && focusZone === 'ticket'} limitPrice={bookPrice} onClearPrice={() => setBookPrice(undefined)} /></Box>
        </Box>
        <Box height={6} minHeight={4}><PositionsTable account={account.account} width={width} height={6} focused={false} /></Box>
      </Box> : null}
      {(tab === 'Chart' || tab === 'Market' && !wide) ? <CandleChart snapshot={snapshot} account={account.account} width={width} height={bodyHeight} focused={focused} /> : null}
      {market && tab === 'Ticket' ? <OrderTicket market={market} book={snapshot.book} width={width} focused={focused} limitPrice={bookPrice} onClearPrice={() => setBookPrice(undefined)} /> : null}
      {tab === 'Book' ? <BookView snapshot={snapshot} width={width} height={bodyHeight} focused={focused} onPrice={pickPrice} /> : null}
      {tab === 'Trades' ? <TradeTape snapshot={snapshot} width={width} height={bodyHeight} focused={focused} /> : null}
      {tab === 'Funding' || tab === 'Open interest' || tab === 'Premium' ? <FundingHistory coin={market?.coin ?? coin} width={width} height={bodyHeight} focused={focused} metric={tab === 'Open interest' ? 'oi' : tab === 'Premium' ? 'premium' : 'funding'} /> : null}
      {tab === 'Positions' ? <PositionsTable account={account.account} width={width} height={bodyHeight} focused={focused} market={market?.coin} /> : null}
      {market && tab === 'Info' ? <ScrollBox flexGrow={1} contentOptions={{ flexDirection: 'column', padding: 1, gap: 1 }}>
        {cash ? <Section title="Cash reference"><KeyValueRow label={cash.label} value={`${price(cash.price)} USD`} /><KeyValueRow label="Perpetual premium" value={percent((market.mark ?? cash.price) / cash.price - 1)} /><KeyValueRow label="Cash as of UTC" value={cash.sessionDate ?? dateTime(cash.asOf)} /></Section> : null}
        <Section title="Contract"><KeyValueRow label="Market" value={market.coin} /><KeyValueRow label="Category" value={snapshot.annotation?.category ?? market.category ?? market.assetClass} />
          {snapshot.annotation?.description ? <KeyValueRow label="Underlying" value={snapshot.annotation.description} /> : null}
          <KeyValueRow label="Lot size" value={String(10 ** -market.szDecimals)} /><KeyValueRow label="Price precision" value={`5 significant digits, at most ${6 - market.szDecimals} decimals; integer prices allowed`} />
          <KeyValueRow label="Margin" value={market.onlyIsolated ? 'Isolated only' : 'Cross and isolated'} /><KeyValueRow label="Collateral" value={market.collateral} />
          <KeyValueRow label="Funding cap /1h" value={percent(market.fundingCap, 4, false)} /><KeyValueRow label="Current funding /8h" value={percent(market.funding8h, 4)} /><KeyValueRow label="Current simple APR" value={percent(market.fundingApr)} />
          {market.deployer ? <KeyValueRow label="Deployer" value={market.deployer} /> : null}{market.oracleUpdater ? <KeyValueRow label="Oracle updater" value={market.oracleUpdater} /> : null}
        </Section>
        <Section title="Margin tiers">{market.marginTiers.map(t => <KeyValueRow key={t.lowerBound} label={`From $${compact(t.lowerBound)}`} value={`${t.maxLeverage}x max · ${percent(1 / (t.maxLeverage * 2), 2, false)} maintenance`} />)}</Section>
      </ScrollBox> : null}
    </PaneStatusBody>
  </Box>;
}
