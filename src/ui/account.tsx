import { useMemo, useRef, useState } from 'react';
import { Box } from 'gloomberb/ui';
import { Button, DataTableView, EmptyState, StatGrid, TextPromptDialog, confirmDialog, usePaneTabs, type DataTableColumn } from 'gloomberb/components';
import { useDialog } from 'gloomberb/dialog';
import { usePaneSettingValue, usePluginAppActions, usePluginPaneState } from 'gloomberb/react';
import type { PaneProps } from 'gloomberb/types/plugin';
import type { AccountSnapshot, TicketRequest, TradingOperation } from '../trading/types';
import { getMarketService } from '../runtime';
import { dateTime, number, percent, price, tone, usd } from './format';
import { useAccount, useBoard, useLiveFooter } from './hooks';

type Row = { key: string; coin?: string; oid?: number; raw?: unknown; [id: string]: unknown };
const col = (id: string, label: string, width = 14, align: 'left' | 'right' = 'right'): DataTableColumn => ({ id, label, width, align });
const COLUMNS: Record<string, DataTableColumn[]> = {
  Positions: [col('coin', 'Market', 17, 'left'), col('side', 'Side', 6, 'left'), col('size', 'Size', 15), col('entry', 'Entry', 13), col('mark', 'Mark', 13), col('pnl', 'Unrealized', 15), col('roe', 'ROE %', 11), col('liquidation', 'Liquidation', 13), col('margin', 'Margin', 13), col('leverage', 'Leverage', 11), col('funding', 'Funding since open', 19), col('collateral', 'Collateral', 12, 'left')],
  Orders: [col('coin', 'Market', 17, 'left'), col('side', 'Side', 6, 'left'), col('type', 'Type', 20, 'left'), col('size', 'Size', 12), col('price', 'Price', 13), col('trigger', 'Trigger', 13), col('flags', 'Flags', 22, 'left'), col('time', 'Placed UTC', 21, 'left'), col('oid', 'Order ID', 16)],
  History: [col('coin', 'Market', 17, 'left'), col('status', 'Status', 24, 'left'), col('side', 'Side', 6, 'left'), col('size', 'Size', 12), col('price', 'Price', 13), col('type', 'Type', 18, 'left'), col('time', 'Updated UTC', 21, 'left')],
  Fills: [col('coin', 'Market', 17, 'left'), col('direction', 'Direction', 20, 'left'), col('size', 'Size', 12), col('price', 'Price', 13), col('pnl', 'Closed PnL USD', 15), col('fee', 'Fee', 12), col('feeToken', 'Fee token', 10, 'left'), col('liquidity', 'Liquidity', 10, 'left'), col('time', 'Filled UTC', 21, 'left')],
  Funding: [col('coin', 'Market', 17, 'left'), col('payment', 'Payment USD', 15), col('rate', 'Paid /1h %', 15), col('size', 'Position size', 15), col('time', 'Paid UTC', 21, 'left')],
  Ledger: [col('type', 'Type', 23, 'left'), col('amount', 'Amount', 18), col('token', 'Token', 12, 'left'), col('time', 'Time UTC', 21, 'left'), col('hash', 'Transaction', 28, 'left')],
  Balances: [col('coin', 'Account / token', 22, 'left'), col('value', 'Value / total', 18), col('available', 'Available', 18), col('held', 'Held / margin', 18), col('maintenance', 'Maintenance', 18), col('collateral', 'Collateral', 12, 'left')],
  Fees: [col('name', 'Fee schedule', 28, 'left'), col('value', 'Rate', 20)],
  TWAP: [col('coin', 'Market', 17, 'left'), col('status', 'Status', 13, 'left'), col('execution', 'Execution', 14, 'left'), col('side', 'Side', 6, 'left'), col('size', 'Size', 14), col('filled', 'Filled', 14), col('minutes', 'Minutes', 10), col('nextTime', 'Next slice UTC', 21, 'left'), col('reduce', 'Reduce only', 14, 'left'), col('reason', 'Detail', 36, 'left'), col('id', 'TWAP ID', 43, 'left')],
};
function rowsFor(account: AccountSnapshot, tab: string): Row[] {
  const markets = getMarketService(account.network).getSnapshot().markets;
  const metadata = (coin: string, dex?: string) => ({ decimals: markets.find(m => m.coin === coin)?.szDecimals, collateral: account.balances.find(b => b.dex === dex)?.collateral ?? markets.find(m => m.coin === coin)?.collateral ?? '--' });
  if (tab === 'Positions') return account.positions.map(p => ({ key: p.coin, ...metadata(p.coin, p.dex), coin: p.coin, side: Number(p.szi) > 0 ? 'Long' : 'Short', size: Math.abs(Number(p.szi)), positionSize: Number(p.szi), entry: Number(p.entryPx), mark: Number(p.szi) ? Number(p.positionValue) / Math.abs(Number(p.szi)) : null, pnl: Number(p.unrealizedPnl), roe: Number(p.returnOnEquity), liquidation: p.liquidationPx == null ? null : Number(p.liquidationPx), margin: Number(p.marginUsed), leverage: `${p.leverage.value}x ${p.leverage.type}`, funding: Number(p.cumFunding.sinceOpen), raw: p }));
  if (tab === 'Orders') return account.orders.map(o => ({ key: String(o.oid), ...metadata(o.coin), oid: o.oid, coin: o.coin, side: o.side === 'B' ? 'Buy' : 'Sell', type: o.orderType, size: Number(o.sz), price: Number(o.limitPx), trigger: o.isTrigger ? Number(o.triggerPx) : null, flags: [o.reduceOnly ? 'Reduce only' : '', o.isPositionTpsl ? 'Position TP/SL' : '', o.children.length ? 'Attached TP/SL' : ''].filter(Boolean).join(', ') || '--', time: o.timestamp, raw: o }));
  if (tab === 'History') return account.orderHistory.map(h => ({ key: String(h.order.oid), ...metadata(h.order.coin), coin: h.order.coin, status: h.status, side: h.order.side === 'B' ? 'Buy' : 'Sell', size: Number(h.order.sz), price: Number(h.order.limitPx), type: h.order.orderType, time: h.statusTimestamp }));
  if (tab === 'Fills') return account.fills.map(f => ({ key: `${f.tid}:${f.oid}`, ...metadata(f.coin), coin: f.coin, direction: f.dir, size: Number(f.sz), price: Number(f.px), pnl: Number(f.closedPnl), fee: Number(f.fee), feeToken: f.feeToken, liquidity: f.crossed ? 'Taker' : 'Maker', time: f.time }));
  if (tab === 'Funding') return account.funding.map(f => ({ key: f.hash, ...metadata(f.delta.coin), coin: f.delta.coin, payment: Number(f.delta.usdc), rate: Number(f.delta.fundingRate), size: Number(f.delta.szi), time: f.time }));
  if (tab === 'Ledger') return account.ledger.map((entry, i) => { const d = entry.delta as unknown as Record<string, unknown>; return { key: `${entry.hash}:${i}`, type: d.type, amount: d.usdc ?? d.amount ?? d.ntli ?? '--', token: d.token ?? (d.usdc ? 'USDC' : '--'), time: entry.time, hash: entry.hash }; });
  if (tab === 'Balances') return [...account.balances.map(b => ({ key: `dex:${b.dex}`, coin: b.dex || 'Native perpetuals', collateral: b.collateral, value: b.accountValue, available: b.available, held: b.marginUsed, maintenance: b.maintenanceMargin })), ...account.spot.balances.map(b => ({ key: `spot:${b.coin}`, coin: b.coin, value: Number(b.total), available: Number(b.total) - Number(b.hold), held: Number(b.hold), maintenance: null }))];
  if (tab === 'Fees') { const f = account.fees; return f ? [
    { key: 'taker', name: 'Perpetual taker', value: percent(Number(f.userCrossRate), 4, false) },
    { key: 'maker', name: 'Perpetual maker', value: percent(Number(f.userAddRate), 4, false) },
    { key: 'spotTaker', name: 'Spot taker', value: percent(Number(f.userSpotCrossRate), 4, false) },
    { key: 'spotMaker', name: 'Spot maker', value: percent(Number(f.userSpotAddRate), 4, false) },
    { key: 'referral', name: 'Referral discount', value: percent(Number(f.activeReferralDiscount), 2, false) },
  ] : []; }
  if (tab === 'TWAP') return account.twaps.map((entry, i) => { const t = entry as Record<string, unknown>; const v = (t.state ?? t) as Record<string, unknown>; const status = typeof t.status === 'object' && t.status ? (t.status as Record<string, unknown>).status : t.status; return { key: String(t.twapId ?? i), ...metadata(String(v.coin ?? '')), id: t.twapId, coin: String(v.coin ?? '--'), side: v.side === 'B' ? 'Buy' : 'Sell', size: Number(v.sz), filled: Number(v.executedSz), minutes: v.minutes, reduce: v.reduceOnly ? 'Yes' : 'No', execution: t.local ? 'This computer' : 'Exchange', local: !!t.local, status: status ?? 'running', reason: t.reason, nextTime: t.nextTime }; });
  return [];
}
export function PositionsTable({ account, width, height, focused, market }: { account: AccountSnapshot | null; width: number; height: number; focused: boolean; market?: string }) {
  const app = usePluginAppActions();
  const rows = account ? rowsFor(account, 'Positions').filter(r => !market || r.coin === market) : [];
  return <DataTableView<Row> focused={focused} rootWidth={width} rootHeight={height} columns={COLUMNS.Positions!} items={rows} selection={{ kind: 'none' }} sortColumnId={null} sortDirection="asc" getItemKey={r => r.key} renderCell={renderCell} onActivate={r => app.createPaneFromTemplate('hyperliquid-account-new')} emptyStateTitle={account ? 'No open positions.' : 'Connect a wallet or watch an address.'} />;
}
function renderCell(row: Row, column: DataTableColumn) {
  const value = row[column.id];
  const decimals = typeof row.decimals === 'number' ? row.decimals : undefined;
  if (typeof value === 'number' && ['entry', 'mark', 'price', 'liquidation', 'trigger'].includes(column.id)) return { text: price(value, decimals ?? 0), value };
  if (typeof value === 'number' && ['size', 'filled'].includes(column.id)) return { text: number(value, decimals ?? (Number.isInteger(value) ? 0 : 4)), value };
  return { text: value == null ? '--' : ['time', 'nextTime'].includes(column.id) ? dateTime(Number(value)) : ['roe', 'rate'].includes(column.id) ? percent(Number(value), column.id === 'rate' ? 4 : 2) : typeof value === 'number' ? number(value, ['oid', 'id', 'minutes'].includes(column.id) ? 0 : ['size', 'entry', 'mark', 'price', 'liquidation', 'trigger', 'fee'].includes(column.id) ? Math.abs(value) < 1 ? 6 : 4 : 2) : String(value), value: typeof value === 'number' ? ['roe', 'rate'].includes(column.id) ? value * 100 : value : undefined, color: ['pnl', 'roe', 'payment'].includes(column.id) ? tone(Number(value)) : undefined };
}
export function HyperliquidAccountPane({ focused, width, height }: PaneProps) {
  const state = useAccount(); const app = usePluginAppActions(); const dialog = useDialog();
  const board = useBoard();
  const [defaultTab] = usePaneSettingValue('defaultTab', 'Positions');
  const [tab, setTab] = usePluginPaneState('accountTab', Object.keys(COLUMNS).find(v => v.toLowerCase() === defaultTab.toLowerCase()) ?? 'Positions');
  const [selected, setSelected] = usePluginPaneState<string | null>('accountSelected', null);
  const [sort, setSort] = useState({ id: '', direction: 'desc' as 'asc' | 'desc' });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingAction = useRef(false);
  const rows = useMemo(() => {
    const rows = state.account ? rowsFor(state.account, tab) : [];
    if (!sort.id) return rows;
    return rows.sort((a, b) => { const av = a[sort.id], bv = b[sort.id]; return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av ?? '').localeCompare(String(bv ?? ''))) * (sort.direction === 'asc' ? 1 : -1); });
  }, [state.account, tab, sort, board.markets]);
  const current = rows.find(r => r.key === selected) ?? rows[0];
  const tabs = usePaneTabs(state.account ? { tabs: Object.keys(COLUMNS).map(value => ({ value, label: value === 'Orders' ? 'Open orders' : value === 'History' ? 'Order history' : value })), activeValue: tab, onSelect: setTab, focused, compact: true, dense: true } : null);
  const ask = (title: string, initialValue = '') => dialog.prompt<string>({ content: ctx => <TextPromptDialog {...ctx} title={title} initialValue={initialValue} placeholder="" /> });
  const act = async (operation: TradingOperation, payload: Record<string, unknown>, title: string, detail?: string) => {
    if (busy || pendingAction.current) return;
    pendingAction.current = true;
    const expectedAddress = state.status?.address;
    try {
      const confirmed = await confirmDialog(dialog, { title, body: [`Account ${expectedAddress ?? '--'}`, detail ?? title], confirmLabel: 'Confirm', confirmVariant: 'danger' });
      if (!confirmed) return;
      setBusy(true); setMessage(null);
      const result = await state.invoke<{ message?: string }>(operation, { ...payload, expectedAddress, confirmed: true, clientId: crypto.randomUUID() }); setMessage(result?.message ?? 'Request completed.'); await state.refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { pendingAction.current = false; setBusy(false); }
  };
  const close = async () => {
    if (!current?.coin) return;
    const input = await ask(`Close ${current.coin}: percent, optional limit price`, '100'); if (!input) return;
    const [share, limit] = input.split(/[,\s]+/).map(Number);
    if (!share || share < 0 || share > 100 || limit != null && !(limit > 0)) { setMessage('Enter 1 to 100 percent and an optional positive limit price.'); return; }
    await act('close', { coin: current.coin, percent: share, kind: limit ? 'limit' : 'market', limitPrice: limit }, `Close ${share}% of ${current.coin}`, limit ? `Limit ${limit}` : 'Market order with your configured slippage cap.');
  };
  const margin = async () => { if (!current?.coin) return; const value = await ask(`Isolated margin USD for ${current.coin} (+ add, - remove)`); if (!value || !Number.isFinite(Number(value))) return; await act('margin', { coin: current.coin, amount: Number(value) }, `Change margin by ${usd(Number(value))}`); };
  const tpsl = async () => {
    if (!current?.coin) return;
    const value = await ask(`TP and SL prices for ${current.coin} (0 to omit)`, '0 0'); if (!value) return;
    const [tp, sl] = value.split(/[,\s]+/).map(Number); const m = getMarketService(state.network).getSnapshot().markets.find(m => m.coin === current.coin);
    if (!m?.mark || !Number.isFinite(tp) || !Number.isFinite(sl)) { setMessage('Enter two valid prices.'); return; }
    const ticket: TicketRequest = { market: { ...m, mark: m.mark, deployerFeeScale: m.deployerFeeScale ?? undefined, growthMode: m.growthMode === 'enabled' }, side: Number(current.positionSize) > 0 ? 'buy' : 'sell', kind: 'market', size: Math.abs(Number(current.size)), sizeUnit: 'coin', leverage: Number(String(current.leverage).split('x')[0]), marginMode: String(current.leverage).includes('isolated') ? 'isolated' : 'cross', reduceOnly: true, takeProfit: tp || undefined, stopLoss: sl || undefined, positionTpsl: true, clientId: crypto.randomUUID() };
    await act('submit', { ticket }, `Set position TP/SL on ${current.coin}`, `Take profit ${tp || '--'} · stop loss ${sl || '--'}`);
  };
  const modify = async () => {
    if (!current?.coin || !current.oid) return;
    const existing = state.account?.orders.find(o => o.oid === current.oid);
    if (!existing) return;
    if (existing.isPositionTpsl) { setMessage('Edit position TP/SL from the Positions tab.'); return; }
    const kinds: Record<string, TicketRequest['kind']> = { Limit: 'limit', 'Stop Market': 'stop-market', 'Stop Limit': 'stop-limit', 'Take Profit Market': 'take-profit-market', 'Take Profit Limit': 'take-profit-limit' };
    const kind = kinds[existing.orderType];
    if (!kind) { setMessage('This order type cannot be modified.'); return; }
    const value = await ask(`Modify ${current.coin}: size, limit price${existing.isTrigger ? ', trigger price' : ''}`, `${existing.sz} ${existing.limitPx}${existing.isTrigger ? ` ${existing.triggerPx}` : ''}`); if (!value) return;
    const [size, limit, trigger] = value.split(/[,\s]+/).map(Number);
    const m = getMarketService(state.network).getSnapshot().markets.find(m => m.coin === current.coin);
    if (!m?.mark || !size || !limit || existing.isTrigger && !trigger) { setMessage('Enter positive size and prices.'); return; }
    const position = state.account?.positions.find(p => p.coin === current.coin);
    const ticket: TicketRequest = { market: { ...m, mark: m.mark, deployerFeeScale: m.deployerFeeScale ?? undefined, growthMode: m.growthMode === 'enabled' }, side: existing.side === 'B' ? 'buy' : 'sell', kind, size, sizeUnit: 'coin', leverage: position?.leverage.value ?? 1, marginMode: position?.leverage.type ?? (m.onlyIsolated ? 'isolated' : 'cross'), limitPrice: limit, triggerPrice: existing.isTrigger ? trigger : undefined, tif: existing.tif === 'Alo' ? 'Alo' : existing.tif === 'Ioc' ? 'Ioc' : 'Gtc', reduceOnly: existing.reduceOnly, clientId: crypto.randomUUID() };
    await act('modify', { oid: current.oid, ticket }, `Modify ${current.coin} ${existing.orderType}`, `${size} @ ${limit}${trigger ? ` · trigger ${trigger}` : ''}`);
  };
  const trading = state.status?.mode === 'trading';
  useLiveFooter('hyperliquid-account', { network: state.network, status: busy ? 'Submitting' : state.account?.stale ? 'stale' : state.account ? 'live' : 'connecting', asOf: state.account?.updatedAt, error: message ?? state.error }, [
    ...(trading && current && tab === 'Positions' ? [
      { id: 'close', key: 'c', label: 'lose', onPress: () => void close() },
      { id: 'reverse', key: 'v', label: 'reverse', title: 'Reverse position', onPress: () => void act('reverse', { coin: current.coin }, `Reverse ${current.coin}`) },
      { id: 'tpsl', key: 't', label: 'p/sl', onPress: () => void tpsl() },
      { id: 'margin', key: 'i', label: 'solated margin', onPress: () => void margin() },
      { id: 'closeAll', key: 'a', label: 'close all', title: 'Close all positions', onPress: () => void act('closeAll', {}, 'Close all positions', 'Submit reduce-only market orders for every open position.') },
    ] : []),
    ...(trading && tab === 'Orders' ? [
      { id: 'cancel', key: 'x', label: 'cancel', title: 'Cancel order', disabled: !current, onPress: () => current && void act('cancel', { coin: current.coin, oid: current.oid }, `Cancel ${current.coin} order`) },
      { id: 'modify', key: 'm', label: 'odify', disabled: !current, onPress: () => void modify() },
      { id: 'cancelMarket', key: 'c', label: 'ancel market', disabled: !current, onPress: () => current && void act('cancel', { coin: current.coin }, `Cancel all ${current.coin} orders`) },
      { id: 'cancelAll', key: 'a', label: 'cancel all', title: 'Cancel all orders', onPress: () => void act('cancel', {}, 'Cancel all open orders') },
    ] : []),
    ...(trading && tab === 'TWAP' && current ? [{ id: 'cancelTwap', key: 'x', label: 'cancel', title: 'Cancel TWAP', onPress: () => void act('twapCancel', { coin: current.coin, twapId: current.id }, `Cancel ${current.coin} TWAP`) }] : []),
    ...(trading && tab === 'TWAP' && current?.local && current.status === 'paused' ? [{ id: 'resumeTwap', key: 's', label: 'tart remaining', title: 'Resume local TWAP', onPress: () => void act('twapResume', { twapId: current.id }, `Resume ${current.coin} TWAP`, 'Continue the remaining slices while Gloom stays open on this computer.') }] : []),
    { id: 'wallet', key: 'w', label: 'allet', onPress: () => app.createPaneFromTemplate('hyperliquid-setup-new') },
  ], state.status);
  if (!state.account) return <EmptyState title={state.loading ? 'Loading account...' : 'Watch or connect a wallet.'} hint={state.error ?? 'Watch-only needs an account address. Trading uses your own wallet.'} actions={<Button label="Set up wallet" variant="primary" onPress={() => app.createPaneFromTemplate('hyperliquid-setup-new')} />} />;
  const figures = [
    { label: 'Value (USDC)', value: number(state.account.accountValue) }, { label: 'Available USDC', value: number(state.account.available) },
    { label: 'Margin USDC', value: number(state.account.marginUsed) }, { label: 'PnL USDC', value: number(state.account.unrealizedPnl), color: tone(state.account.unrealizedPnl) },
    ...(height >= 20 ? [{ label: 'Withdrawable USDC', value: number(state.account.withdrawable) }, { label: 'Cross margin', value: percent(state.account.crossMarginRatio, 2, false) }, { label: 'Maint. USDC', value: number(state.account.maintenanceMargin) }, { label: 'Account mode', value: state.account.abstraction === 'default' || state.account.abstraction === 'disabled' ? 'Standard' : state.account.abstraction === 'unifiedAccount' ? 'Unified' : 'Portfolio margin' }] : []),
  ];
  return <DataTableView<Row> focused={focused} rootWidth={width} rootHeight={height} rootBefore={<>{tabs.strip}<StatGrid width={width} items={figures} /></>} columns={COLUMNS[tab] ?? COLUMNS.Positions!} items={rows} getItemKey={r => r.key} renderCell={renderCell} selectedTextOverridesCellColor
    selection={{ kind: 'id', selectedId: current?.key ?? null, getId: r => r.key, onChange: setSelected }} sortColumnId={sort.id || null} sortDirection={sort.direction} onHeaderClick={id => setSort(old => ({ id, direction: old.id === id && old.direction === 'desc' ? 'asc' : 'desc' }))}
    onActivate={row => row.coin && app.createPaneFromTemplate('hyperliquid-market-new', { symbol: row.coin })} emptyStateTitle={`No ${tab.toLowerCase()}.`} />;
}
