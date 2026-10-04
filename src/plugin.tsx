import type { GloomPlugin, GloomPluginContext, PaneDef, PaneTemplateDef } from 'gloomberb/types/plugin';
import { HyperliquidBoardPane, HyperliquidMarketPane, HyperliquidAccountPane, HyperliquidBookPane, HyperliquidAnalyticsPane, HyperliquidSetupPane } from './ui';
import { disposeRuntime, getMarketService } from './runtime';
import { configSchema } from './settings';
import { hyperliquidHeadless, analyticsHeadless, accountHeadless, setupHeadless } from './headless';
import { resolveMarket } from './market/normalize';

export const HOSTS = ['api.hyperliquid.xyz', 'api.hyperliquid-testnet.xyz', 'app.hyperliquid.xyz', 'api.gloom.sh', 'www.cloudflare.com', 'arb1.arbitrum.io', 'sepolia-rollup.arbitrum.io', '127.0.0.1'];
const pane = (id: string, name: string, component: PaneDef['component'], width = 140, height = 36): PaneDef => ({
  id: `hyperliquid-${id}`, name, component, defaultPosition: 'right', defaultMode: 'floating', defaultFloatingSize: { width, height }, tableExport: true,
  portableShare: { private: { settings: ['watchAddress'], state: true } },
  settings: { fields: [{ key: 'market', label: 'Market', type: 'text', placeholder: 'BTC or xyz:TSLA' }] },
});
export const PANES = [
  { ...pane('board', 'Hyperliquid', HyperliquidBoardPane), headless: hyperliquidHeadless },
  pane('market', 'Hyperliquid Market', HyperliquidMarketPane, 160, 42),
  pane('book', 'Hyperliquid Book', HyperliquidBookPane, 50, 32),
  pane('account', 'Hyperliquid Account', HyperliquidAccountPane, 140, 32),
  pane('analytics', 'Hyperliquid Analytics', HyperliquidAnalyticsPane),
  pane('setup', 'Hyperliquid Wallet', HyperliquidSetupPane, 90, 32),
];
const template = (id: string, code: string, label: string, hasMarket = false): PaneTemplateDef => ({
  id: `hyperliquid-${id}-new`, paneId: `hyperliquid-${id}`, label,
  description: `Open ${label.toLowerCase()}.`, keywords: ['hyperliquid', 'perpetuals', 'trading', code],
  shortcut: { prefix: code, ...(hasMarket ? { argKind: 'text' as const, argPlaceholder: 'market', argOptional: true, openWithoutArg: true } : {}) },
  headless: id === 'account' ? accountHeadless : id === 'analytics' ? analyticsHeadless : id === 'setup' ? setupHeadless : hyperliquidHeadless,
  createInstance: (_ctx, options) => {
    const market = (options?.arg ?? options?.symbol ?? (id === 'market' || id === 'book' ? 'BTC' : '')).trim();
    const initialLimitPrice = Number(options?.values?.initialLimitPrice);
    return { title: market ? `${label} ${market}` : label, settings: { market,
      ...(Number.isFinite(initialLimitPrice) && initialLimitPrice > 0 ? { initialLimitPrice, defaultTab: 'Ticket' } : {}),
    }, params: { market }, placement: 'floating' };
  },
});
export function setupShared(ctx: GloomPluginContext): void {
  ctx.registerTickerAction({
    id: 'hyperliquid-open-perpetual', label: 'Open Hyperliquid perpetual', keywords: ['hyperliquid', 'perp', 'trade'],
    async execute(ticker) {
      const network = ctx.configState.get('network') === 'testnet' ? 'testnet' : 'mainnet';
      const service = getMarketService(network);
      await service.refresh();
      const market = resolveMarket(service.getSnapshot().markets, ticker.metadata.ticker);
      if (!market) { ctx.notify({ body: `No active perpetual for ${ticker.metadata.ticker}.` }); return; }
      ctx.createPaneFromTemplate('hyperliquid-market-new', { arg: market.coin });
    },
  });
  ctx.registerCommand({
    id: 'hyperliquid-workspace', label: 'Open Hyperliquid trading workspace', category: 'navigation', keywords: ['hyperliquid', 'workspace', 'docked'],
    wizard: [{ key: 'market', label: 'Market', defaultValue: 'BTC', type: 'text' }],
    execute(values) {
      const market = values?.market || 'BTC';
      ctx.createPaneFromTemplate('hyperliquid-docked-market', { arg: market });
      ctx.createPaneFromTemplate('hyperliquid-docked-account', { arg: market });
    },
  });
}

export const hyperliquidPlugin: GloomPlugin = {
  id: 'hyperliquid', name: 'Hyperliquid', version: '0.1.0', toggleable: true,
  description: 'Live perpetual markets, analytics and self-custody trading', homepage: 'https://github.com/gloom-sh/gloom-hyperliquid',
  targets: ['cli', 'tui', 'desktop'], hosts: HOSTS, configSchema, panes: PANES,
  paneTemplates: [template('board', 'HLP', 'Hyperliquid', true), template('market', 'HLM', 'Hyperliquid Market', true), template('book', 'HLB', 'Hyperliquid Book', true), template('account', 'HLA', 'Hyperliquid Account'), template('analytics', 'HLF', 'Hyperliquid Analytics'), template('setup', 'HLS', 'Hyperliquid Wallet'),
    { id: 'hyperliquid-docked-market', paneId: 'hyperliquid-market', label: 'Hyperliquid docked market', description: 'Chart, book and order ticket', createInstance: (_ctx, options) => ({ instanceId: 'hyperliquid-market:workspace', title: `Hyperliquid ${options?.arg || 'BTC'}`, settings: { market: options?.arg || 'BTC' }, placement: 'docked', relativePosition: 'right' }) },
    { id: 'hyperliquid-docked-account', paneId: 'hyperliquid-account', label: 'Hyperliquid docked account', description: 'Positions and orders below the market', createInstance: () => ({ instanceId: 'hyperliquid-account:workspace', placement: 'docked', relativeToPaneId: 'hyperliquid-market:workspace', relativePosition: 'below' }) },
  ],
  setup: setupShared, dispose: disposeRuntime,
};
