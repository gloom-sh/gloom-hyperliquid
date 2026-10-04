import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, ScrollBox, Text, useUiCapabilities, type BoxRenderable } from 'gloomberb/ui';
import { Button, Checkbox, FieldGrid, Notice, QueryBar, SegmentedControl, StatGrid, confirmDialog, useFieldRing, usePaneFooter, type GridField } from 'gloomberb/components';
import { useDialog } from 'gloomberb/dialog';
import { useInputCapture, usePluginAppActions, usePluginConfigState, usePluginPaneState, useShortcut } from 'gloomberb/react';
import { colors } from 'gloomberb/theme';
import type { Market, OrderBook } from '../market';
import { previewTicket } from '../trading/orders';
import { availableForMarket } from '../trading/account';
import { tradingSettings } from '../settings';
import type { TicketPreview, TicketRequest, TradingResult } from '../trading/types';
import { configuredBuilder } from '../trading/builder';
import { number, price, shortAddress, usd } from './format';
import { useAccount } from './hooks';

const ORDER_KINDS: { value: TicketRequest['kind']; label: string }[] = [
  { value: 'market', label: 'Market' }, { value: 'limit', label: 'Limit' },
  { value: 'stop-market', label: 'Stop market' }, { value: 'stop-limit', label: 'Stop limit' },
  { value: 'take-profit-market', label: 'Take-profit market' }, { value: 'take-profit-limit', label: 'Take-profit limit' },
  { value: 'twap', label: 'TWAP' }, { value: 'scale', label: 'Scale' },
];
interface Draft { side: 'buy' | 'sell'; kind: TicketRequest['kind']; size: number; sizeUnit: TicketRequest['sizeUnit']; leverage: number; marginMode: 'cross' | 'isolated'; limitPrice: number; triggerPrice: number; tif: 'Gtc' | 'Alo' | 'Ioc'; reduceOnly: boolean; takeProfit: number; stopLoss: number; twapMinutes: number; scaleStart: number; scaleEnd: number; scaleCount: number }

/** Leverage is a domain control: the exact value is also editable in the shared field grid. */
function LeverageSlider({ value, max, onChange, onFocus, focused, width }: { value: number; max: number; onChange: (value: number) => void; onFocus: () => void; focused: boolean; width: number }) {
  const native = useUiCapabilities().nativePaneChrome;
  const track = useRef<BoxRenderable | null>(null);
  const [dragging, setDragging] = useState(false);
  const change = (event: { x?: number; clientX?: number; currentTarget?: { getBoundingClientRect?: () => { left: number; width: number } }; preventDefault?: () => void }) => {
    const bounds = event.currentTarget?.getBoundingClientRect?.();
    const left = bounds?.left ?? track.current?.x ?? 0;
    const size = bounds?.width ?? track.current?.width ?? width;
    const x = event.clientX ?? event.x;
    if (x == null) return;
    event.preventDefault?.(); onChange(Math.max(1, Math.min(max, Math.round(1 + (x - left) / Math.max(1, Number(size)) * (max - 1)))));
  };
  useShortcut(event => {
    if (event.name !== 'left' && event.name !== 'right') return;
    event.preventDefault(); onChange(Math.max(1, Math.min(max, value + (event.name === 'right' ? 1 : -1))));
  }, { enabled: focused, scope: 'hyperliquid-leverage', phase: 'before' });
  const ratio = (value - 1) / Math.max(1, max - 1) * 100;
  return <Box flexDirection="column" paddingX={1}>
    <Box flexDirection="row" justifyContent="space-between"><Text fg={colors.textDim}>Leverage</Text><Text fg={colors.textBright}>{value}x / {max}x</Text></Box>
    <Box ref={track} height={1} width="100%" position="relative" cursor="pointer" backgroundColor={colors.border}
      role="slider" aria-label="Leverage" aria-valuemin={1} aria-valuemax={max} aria-valuenow={value}
      onMouseDown={(event: any) => { onFocus(); setDragging(true); change(event); }} onMouseDrag={(event: any) => change(event)} onMouseDragEnd={() => setDragging(false)} onMouseMove={(event: any) => { if (dragging) change(event); }} onMouseUp={() => setDragging(false)}
      style={native ? { height: '4px', minHeight: '4px', margin: '9px 0', borderRadius: '2px' } : undefined}>
      <Box height={1} width={`${ratio}%`} backgroundColor={colors.borderFocused} style={native ? { height: '4px', minHeight: '4px' } : undefined} />
      <Box position="absolute" left={`${Math.min(97, ratio)}%`} height={1} width={1} backgroundColor={colors.textBright} style={native ? { width: '10px', height: '10px', minHeight: '10px', top: '-3px', borderRadius: '50%' } : undefined} />
    </Box>
  </Box>;
}
export function OrderTicket({ market, book, width, focused, limitPrice, onClearPrice }: { market: Market; book?: OrderBook | null; width: number; focused: boolean; limitPrice?: number; onClearPrice?: () => void }) {
  const account = useAccount();
  const app = usePluginAppActions();
  const dialog = useDialog();
  const [defaultUnit] = usePluginConfigState<TicketRequest['sizeUnit']>('sizeUnit', 'usd');
  const [defaultLeverage] = usePluginConfigState('defaultLeverage', 3);
  const [leverageBehavior] = usePluginConfigState('leverageBehavior', 'position');
  const [confirmations] = usePluginConfigState<boolean | string>('confirmations', true);
  const [draft, setDraft] = usePluginPaneState<Draft>(`ticket:${market.coin}`, { side: 'buy', kind: 'market', size: 0, sizeUnit: defaultUnit, leverage: Math.min(defaultLeverage, market.maxLeverage), marginMode: market.onlyIsolated ? 'isolated' : 'cross', limitPrice: market.mark ?? 0, triggerPrice: 0, tif: 'Gtc', reduceOnly: false, takeProfit: 0, stopLoss: 0, twapMinutes: 30, scaleStart: 0, scaleEnd: 0, scaleCount: 5 });
  const [active, setActive] = useState<string | null>(null);
  useInputCapture(focused && active != null);
  const [slippageBps] = usePluginConfigState('slippageBps', 50);
  const [maxOrderUsd] = usePluginConfigState('maxOrderUsd', 10_000);
  const [fatFingerPercent] = usePluginConfigState('fatFingerPercent', 5);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clientId = useRef(crypto.randomUUID());
  const submitting = useRef(false);
  const edited = useRef(false);
  const leverageInitialized = useRef(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => { edited.current = true; setDraft(old => ({ ...old, [key]: value })); setError(null); setMessage(null); clientId.current = crypto.randomUUID(); };
  useEffect(() => {
    if (!account.account || leverageInitialized.current) return;
    leverageInitialized.current = true;
    const position = account.account.positions.find(p => p.coin === market.coin);
    if (leverageBehavior === 'position' && position && !edited.current && draft.size === 0) {
      setDraft(old => ({ ...old, leverage: Math.min(market.maxLeverage, position.leverage.value), marginMode: market.onlyIsolated ? 'isolated' : position.leverage.type }));
    }
  }, [account.account, leverageBehavior, market.coin]);
  useEffect(() => { if (limitPrice != null) { setDraft(old => ({ ...old, kind: 'limit', limitPrice })); clientId.current = crypto.randomUUID(); onClearPrice?.(); } }, [limitPrice]);
  const ticket = useMemo<TicketRequest>(() => ({ ...draft,
    market: { coin: market.coin, dex: market.dex, assetId: market.assetId, szDecimals: market.szDecimals, maxLeverage: market.maxLeverage, onlyIsolated: market.onlyIsolated, mark: market.mark ?? 0, deployerFeeScale: market.deployerFeeScale ?? (market.dex ? 1 : 0), growthMode: market.growthMode === 'enabled', collateral: market.collateral, marginTiers: market.marginTiers },
    marginMode: market.onlyIsolated ? 'isolated' : draft.marginMode, takeProfit: draft.takeProfit || undefined, stopLoss: draft.stopLoss || undefined, clientId: clientId.current,
  }), [draft, market]);
  const preview = useMemo(() => previewTicket(ticket, {
    available: account.account ? availableForMarket(account.account, ticket.market) : 0,
    makerRate: Number(account.account?.fees?.userAddRate ?? 0.00015), takerRate: Number(account.account?.fees?.userCrossRate ?? 0.00045),
    referralDiscount: Number(account.account?.fees?.activeReferralDiscount ?? 0),
    positionSize: Number(account.account?.positions.find(p => p.coin === market.coin)?.szi ?? 0),
    accountValue: account.account?.accountValue, crossMaintenanceMargin: account.account?.maintenanceMargin,
    book: book ? [book.bids.map(l => ({ px: String(l.price), sz: String(l.size) })), book.asks.map(l => ({ px: String(l.price), sz: String(l.size) }))] : undefined,
  }, { ...tradingSettings({ slippageBps, maxOrderUsd, fatFingerPercent, confirmations }), builder: configuredBuilder(account.network) }), [ticket, account.account, book, slippageBps, maxOrderUsd, fatFingerPercent, confirmations]);
  const submit = async () => {
    if (submitting.current || busy || account.status?.mode !== 'trading') return;
    submitting.current = true;
    const expectedAddress = account.status.address;
    setError(null);
    try {
      const current = await account.invoke<TicketPreview>('preview', { ticket });
      if (current.errors.length) { setError(current.errors.join(' ')); return; }
      if (confirmations !== false && confirmations !== 'false' || current.warnings.length) {
        const confirmed = await confirmDialog(dialog, { title: `${draft.side === 'buy' ? 'Buy / Long' : 'Sell / Short'} ${market.coin}`, body: [
          `Account ${shortAddress(expectedAddress)}`,
          `${draft.kind} · ${current.size} ${market.symbol} · ${usd(current.notional)}`,
          `Price cap ${price(Number(current.price), market.szDecimals)} · ${draft.leverage}x ${ticket.marginMode}`,
          `Estimated fee ${usd(current.fee)}${configuredBuilder(account.network) ? " including Gloom's 0.1% builder fee" : ''}`,
          ...current.warnings,
        ], confirmLabel: 'Submit order', confirmVariant: draft.side === 'buy' ? 'primary' : 'danger' });
        if (!confirmed) return;
      }
      setBusy(true);
      const result = await account.invoke<TradingResult>('submit', { ticket, confirmed: true, expectedAddress });
      setMessage(result.message);
      if (result.state === 'accepted') { clientId.current = crypto.randomUUID(); setDraft(old => ({ ...old, size: 0 })); await account.refresh(); }
      if (result.state !== 'accepted') setError(result.message);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { submitting.current = false; setBusy(false); }
  };
  const applyLeverage = async () => {
    if (busy || account.status?.mode !== 'trading') return;
    const expectedAddress = account.status.address;
    const confirmed = await confirmDialog(dialog, { title: `Set ${market.coin} leverage`, body: `Account ${shortAddress(expectedAddress)}: ${draft.leverage}x ${ticket.marginMode}`, confirmLabel: 'Apply leverage', confirmVariant: 'primary' });
    if (!confirmed) return; setBusy(true); setError(null);
    try { await account.invoke('leverage', { coin: market.coin, leverage: draft.leverage, marginMode: ticket.marginMode, clientId: crypto.randomUUID(), expectedAddress }); setMessage('Leverage updated.'); await account.refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  usePaneFooter('hyperliquid-ticket-result', () => ({ info: busy ? [{ id: 'sending', parts: [{ text: 'Submitting', tone: 'warning' }] }] : message || error ? [{ id: 'result', parts: [{ text: error ?? message ?? '', tone: error ? 'negative' : 'positive' }] }] : [] }), [busy, message, error]);
  const fields: GridField[] = [
    { id: 'size', label: `Size (${draft.sizeUnit === 'coin' ? market.symbol : draft.sizeUnit === 'usd' ? 'USD' : '% buying power'})`, value: draft.size, onValue: value => set('size', value) },
    { id: 'leverage', label: 'Leverage', value: draft.leverage, suffix: 'x', onValue: value => set('leverage', Math.max(1, Math.min(market.maxLeverage, Math.round(value)))) },
    ...(draft.kind.includes('limit') ? [{ id: 'limit', label: 'Limit price', value: draft.limitPrice, onValue: (value: number) => set('limitPrice', value) }] : []),
    ...(draft.kind.includes('stop') || draft.kind.includes('take-profit') ? [{ id: 'trigger', label: 'Trigger price', value: draft.triggerPrice, onValue: (value: number) => set('triggerPrice', value) }] : []),
    ...(draft.kind === 'twap' ? [{ id: 'twap', label: 'Duration (min)', value: draft.twapMinutes, onValue: (value: number) => set('twapMinutes', Math.round(value)) }] : []),
    ...(draft.kind === 'scale' ? [
      { id: 'scaleStart', label: 'First price', value: draft.scaleStart, onValue: (v: number) => set('scaleStart', v) },
      { id: 'scaleEnd', label: 'Last price', value: draft.scaleEnd, onValue: (v: number) => set('scaleEnd', v) },
      { id: 'scaleCount', label: 'Orders', value: draft.scaleCount, onValue: (v: number) => set('scaleCount', Math.round(v)) },
    ] : []),
    { id: 'tp', label: 'Take profit', value: draft.takeProfit, placeholder: 'Optional', onValue: value => set('takeProfit', value) },
    { id: 'sl', label: 'Stop loss', value: draft.stopLoss, placeholder: 'Optional', onValue: value => set('stopLoss', value) },
  ];
  useFieldRing({ ids: ['side', 'leverageSlider', ...fields.map(f => f.id), 'reduceOnly', 'applyLeverage', 'submit', 'reset'], activeId: active, onActivate: setActive, enabled: focused, scope: 'hyperliquid-ticket', actions: { applyLeverage: () => void applyLeverage(), side: () => set('side', draft.side === 'buy' ? 'sell' : 'buy'), reduceOnly: () => set('reduceOnly', !draft.reduceOnly), submit: () => void submit(), reset: () => set('size', 0) } });
  useShortcut(event => {
    if (event.name === 'escape') { event.preventDefault(); setActive(null); }
    if ((event.name === 'enter' || event.name === 'return') && active && fields.some(f => f.id === active)) { event.preventDefault(); event.stopPropagation(); setActive(null); void submit(); }
  }, { enabled: focused && active != null, allowEditable: true, phase: 'before', scope: 'hyperliquid-ticket-submit' });
  return <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}><ScrollBox flexGrow={1} contentOptions={{ flexDirection: 'column' }}>
    <QueryBar width={width} filters={[
      { id: 'kind', label: 'Order', value: draft.kind, options: ORDER_KINDS, onChange: value => set('kind', value) },
      { id: 'margin', label: 'Margin', value: ticket.marginMode, options: [{ value: 'cross', label: 'Cross', disabled: market.onlyIsolated }, { value: 'isolated', label: 'Isolated' }], onChange: value => set('marginMode', value) },
    ]} />
    <Box paddingX={1} marginTop={1}><SegmentedControl value={draft.side} options={[{ value: 'buy', label: 'Buy / Long' }, { value: 'sell', label: 'Sell / Short' }]} onChange={value => { setActive('side'); set('side', value as Draft['side']); }} focused={focused && active === 'side'} /></Box>
    <StatGrid width={width} columns={1} items={[{ label: 'Available', value: account.account ? number(availableForMarket(account.account, ticket.market)) : '--', detail: market.collateral }]} />
    <LeverageSlider value={draft.leverage} max={market.maxLeverage} onChange={value => set('leverage', value)} onFocus={() => setActive('leverageSlider')} focused={focused && active === 'leverageSlider'} width={width - 2} />
    <QueryBar width={width} filters={[
      { id: 'unit', label: 'Size', value: draft.sizeUnit, options: [{ value: 'usd', label: 'USD' }, { value: 'coin', label: market.symbol }, { value: 'percent', label: '% buying power' }], onChange: value => set('sizeUnit', value) },
      ...(draft.kind.includes('limit') || draft.kind === 'scale' ? [{ id: 'tif', label: 'TIF', value: draft.tif, options: [{ value: 'Gtc', label: 'GTC' }, { value: 'Alo', label: 'Post only' }, { value: 'Ioc', label: 'IOC' }], onChange: (value: string) => set('tif', value as Draft['tif']) }] : []),
    ]} />
    <FieldGrid width={width} fields={fields} activeId={active} onActivate={setActive} onDeactivate={() => setActive(null)} focused={focused} keyboard={false} columns={width >= 50 ? 2 : 1} />
    <Box paddingX={1} marginTop={1}><Checkbox label="Reduce only" active={active === 'reduceOnly'} checked={draft.reduceOnly} onChange={value => { setActive('reduceOnly'); set('reduceOnly', value); }} /></Box>
    <StatGrid width={width} columns={width >= 50 ? 2 : 1} items={[
      { label: 'Order value', value: usd(preview?.notional) }, { label: 'Margin', value: usd(preview?.marginRequired) },
      { label: 'Est. liquidation', value: ticket.marginMode === 'cross' ? '--' : price(preview?.liquidationPrice, market.szDecimals) },
      { label: account.account?.fees ? 'Est. fee' : 'Est. base fee', value: usd(preview?.fee) }, { label: 'Average fill', value: price(preview?.averageFill, market.szDecimals) },
      { label: 'Est. slippage', value: preview?.slippagePercent == null ? '--' : `${number(preview.slippagePercent, 3)}%` },
    ]} />
    {configuredBuilder(account.network) ? <Box paddingX={1}><Text fg={colors.textDim}>including Gloom's 0.1% builder fee</Text></Box> : null}
    {preview?.errors.length && draft.size > 0 ? <Box paddingX={1}><Notice tone="negative">{preview.errors.join(' ')}</Notice></Box> : null}
    {preview?.warnings.length && (draft.size > 0 || draft.kind === 'twap') ? <Box paddingX={1}><Notice tone="warning">{preview.warnings.join(' ')}</Notice></Box> : null}
  </ScrollBox>
    {account.status?.mode !== 'trading' ? <Box paddingX={1} paddingY={1}><Button label={account.status?.mode === 'watch' ? 'Connect a trading wallet' : 'Connect wallet'} onPress={() => app.createPaneFromTemplate('hyperliquid-setup-new')} variant="primary" /></Box> : <Box paddingX={1} paddingY={1} flexDirection="row" flexWrap="wrap" gap={1}>
      <Button label={busy ? 'Submitting...' : `${draft.side === 'buy' ? 'Buy / Long' : 'Sell / Short'} ${market.symbol}`} variant={draft.side === 'buy' ? 'primary' : 'danger'} active={active === 'submit'} disabled={busy || !preview || preview.errors.length > 0 || !!error} onPress={() => void submit()} />
      <Button label="Apply leverage" compact variant="secondary" active={active === 'applyLeverage'} disabled={busy} onPress={() => void applyLeverage()} />
      <Button label="Reset" variant="secondary" active={active === 'reset'} disabled={busy} onPress={() => set('size', 0)} />
    </Box>}
  </Box>;
}
