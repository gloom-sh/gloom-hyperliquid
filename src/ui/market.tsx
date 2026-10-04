import { useEffect, useState } from "react";
import { Box, ScrollBox, Text } from "gloomberb/ui";
import {
  KeyValueRow,
  PaneStatusBody,
  QueryBar,
  Section,
  StatGrid,
  usePaneTabs,
} from "gloomberb/components";
import {
  useAssetData,
  usePaneSettingValue,
  usePaneTitle,
  usePluginAppActions,
  usePluginPaneState,
} from "gloomberb/react";
import { colors } from "gloomberb/theme";
import type { PaneProps } from "gloomberb/types/plugin";
import {
  resolveMarket,
  CANDLE_INTERVALS,
  type CandleInterval,
  type Market,
} from "../market";
import { loadCashReference, type CashReference } from "../cash";
import { getMarketService } from "../runtime";
import {
  bookTickOptions,
  compactAxis,
  countdown,
  dateTime,
  fundingRate,
  fundingTone,
  percent,
  price,
  tone,
  usdCompact,
} from "./format";
import {
  useAccount,
  useBoard,
  useClock,
  useLiveFooter,
  useMarket,
} from "./hooks";
import { CandleChart } from "./charts";
import {
  bookPrecisionConfig,
  bookPrecisionValue,
  BookView,
  TradeTape,
} from "./book";
import { FundingHistory } from "./analytics";
import { PositionsTable } from "./account";
import { OrderTicket } from "./ticket";

export function HyperliquidMarketPane(props: PaneProps) {
  const [coin] = usePaneSettingValue("market", "BTC");
  const board = useBoard();
  const resolved = resolveMarket(board.markets, coin || "BTC");
  usePaneTitle(`${resolved?.coin ?? coin ?? "BTC"} perpetual`);
  if (!resolved)
    return (
      <PaneStatusBody
        loading={!board.markets.length && !board.error}
        error={board.error}
        empty={board.markets.length > 0}
        emptyTitle={`No perpetual found for ${coin}.`}
        subject={coin}
      />
    );
  return <MarketView key={resolved.coin} {...props} coin={resolved.coin} />;
}
export function MarketView({
  coin,
  embedded = false,
  ...props
}: PaneProps & { coin: string; embedded?: boolean }) {
  const { focused, width, height } = props;
  const [focusZone, setFocusZone] = useState("chart");
  const [interval, setInterval] = usePluginPaneState<CandleInterval>(
    `interval:${coin}`,
    "15m",
  );
  const [defaultTab] = usePaneSettingValue("defaultTab", "Market");
  const [tab, setTab] = usePluginPaneState(
    `marketTab:${coin}`,
    [
      "Market",
      "Chart",
      "Book",
      "Ticket",
      "Trades",
      "Funding",
      "Open interest",
      "Premium",
      "Positions",
      "Info",
    ].find((v) => v.toLowerCase() === defaultTab.toLowerCase()) ?? "Market",
  );
  const [initialLimitPrice] = usePaneSettingValue<number | undefined>(
    "initialLimitPrice",
    undefined,
  );
  const [bookPrice, setBookPrice] = useState<number | undefined>(
    initialLimitPrice,
  );
  const snapshot = useMarket(coin, interval);
  const account = useAccount();
  const now = useClock();
  const app = usePluginAppActions();
  const [cash, setCash] = useState<CashReference | null>(null);
  const provider = useAssetData();
  const symbol = snapshot.market?.underlyingSymbol;
  const market = snapshot.market;
  useEffect(() => {
    if (!symbol || !provider || !market?.mark) {
      setCash(null);
      return;
    }
    const controller = new AbortController();
    void loadCashReference(provider, symbol, market.mark, controller.signal)
      .then(setCash)
      .catch(() => {});
    return () => controller.abort();
  }, [symbol, provider, Math.floor(now / 60_000)]);
  const wide = width >= 135 && height >= 24;
  const views = wide
    ? [
        "Market",
        "Chart",
        "Book",
        "Ticket",
        "Trades",
        "Funding",
        "Open interest",
        "Premium",
        "Positions",
        "Info",
      ]
    : [
        "Market",
        "Ticket",
        "Book",
        "Trades",
        "Funding",
        "Open interest",
        "Premium",
        "Positions",
        "Info",
      ];
  const tabs = usePaneTabs({
    tabs: views.map((value) => ({
      value,
      label: value === "Market" && !wide ? "Chart" : value,
    })),
    activeValue: tab,
    onSelect: setTab,
    focused,
    compact: true,
    dense: true,
    ...(embedded ? { queryBarWidth: width } : {}),
  });
  const untilFunding = 3_600_000 - (now % 3_600_000);
  useLiveFooter(
    "hyperliquid-market",
    snapshot,
    [
      {
        id: "ticket",
        key: "t",
        label: "icket",
        onPress: () => setTab("Ticket"),
      },
      {
        id: "account",
        key: "p",
        label: "ositions",
        onPress: () => app.createPaneFromTemplate("hyperliquid-account-new"),
      },
      {
        id: "book",
        key: "b",
        label: "ook window",
        onPress: () =>
          app.createPaneFromTemplate("hyperliquid-book-new", { symbol: coin }),
      },
      ...(symbol
        ? [
            {
              id: "cash",
              key: "e",
              label: "quity",
              onPress: () => app.openCommandBar(`DES ${symbol}`),
            },
          ]
        : []),
      {
        id: "wallet",
        key: "w",
        label: "allet",
        onPress: () => app.createPaneFromTemplate("hyperliquid-setup-new"),
      },
    ],
    account.status,
  );
  const stats = market
    ? [
        { label: "Mark", value: price(market.mark, market.szDecimals) },
        {
          label: "24h change",
          value: percent(market.change24h),
          color: tone(market.change24h, 2),
        },
        {
          label: "Funding /1h",
          value: fundingRate(market.fundingHourly),
          detail: countdown(untilFunding),
          color: fundingTone(market.fundingHourly),
        },
        { label: "Open interest", value: usdCompact(market.oiUsd) },
        ...(height >= 20
          ? [
              {
                label: "Oracle",
                value: price(market.oracle, market.szDecimals),
              },
              {
                label: "Premium",
                value: percent(market.premium),
                color: tone(market.premium, 2),
              },
              { label: "24h volume", value: usdCompact(market.volume24h) },
              {
                label: "Max leverage",
                value: `${market.maxLeverage}x`,
                detail: market.onlyIsolated ? "isolated only" : undefined,
              },
            ]
          : []),
      ]
    : [];
  const statColumns = width >= 120 ? 4 : 2;
  const statsRows = Math.ceil(stats.length / statColumns);
  const bodyHeight = Math.max(5, height - tabs.rows - statsRows - 1);
  const pickPrice = (value: number) => {
    setBookPrice(value);
    if (!wide || tab !== "Market") setTab("Ticket");
  };
  const query = (
    <QueryBar
      width={width}
      filters={[
        {
          id: "interval",
          label: "Candles",
          value: interval,
          options: CANDLE_INTERVALS.map((value) => ({ value, label: value })),
          onChange: (value) => setInterval(value),
        },
        ...(tab === "Book" || (tab === "Market" && wide)
          ? [
              {
                id: "precision",
                label: tab === "Book" ? "Tick" : "Book tick",
                value: bookPrecisionValue(snapshot.book),
                options: bookTickOptions(
                  snapshot.book?.mid ?? market?.mark,
                  market?.szDecimals,
                  bookPrecisionValue(snapshot.book),
                ),
                onChange: (value: string) =>
                  getMarketService(snapshot.network).setBookAggregation(
                    coin,
                    bookPrecisionConfig(value),
                  ),
              },
            ]
          : []),
      ]}
      meta={
        market
          ? [
              market.assetClass,
              market.alwaysOpen ? "24/7" : "",
              market.dex,
              market.collateral,
            ]
              .filter(Boolean)
              .join(" · ")
          : undefined
      }
    />
  );
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      minHeight={0}
      overflow="hidden"
    >
      {tabs.strip}
      {query}
      <PaneStatusBody
        loading={!market && !snapshot.error}
        error={!market ? snapshot.error : null}
        subject={coin}
      >
        <StatGrid width={width} items={stats} columns={statColumns} />
        {market && tab === "Market" && wide ? (
          <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
            <Box flexDirection="row" flexGrow={1} flexBasis={0} minHeight={0}>
              <Box
                flexDirection="column"
                flexGrow={1}
                flexBasis={0}
                minWidth={0}
                overflow="hidden"
                onMouseDown={() => setFocusZone("chart")}
              >
                <CandleChart
                  snapshot={snapshot}
                  account={account.account}
                  width={Math.max(40, width - 72)}
                  height={Math.max(8, bodyHeight - 6)}
                  focused={focused && focusZone === "chart"}
                />
              </Box>
              <Box
                width={34}
                flexDirection="column"
                overflow="hidden"
                onMouseDown={() => setFocusZone("book")}
              >
                <BookView
                  snapshot={snapshot}
                  width={34}
                  height={Math.max(8, bodyHeight - 6)}
                  focused={focused && focusZone === "book"}
                  compactView
                  onPrice={pickPrice}
                />
              </Box>
              <Box
                width={38}
                flexDirection="column"
                overflow="hidden"
                onMouseDown={() => setFocusZone("ticket")}
              >
                <OrderTicket
                  market={market}
                  book={snapshot.book}
                  width={38}
                  focused={focused && focusZone === "ticket"}
                  limitPrice={bookPrice}
                  onClearPrice={() => setBookPrice(undefined)}
                />
              </Box>
            </Box>
            <Box height={6} minHeight={4}>
              <PositionsTable
                account={account.account}
                width={width}
                height={6}
                focused={false}
                first={market.coin}
                loading={account.loading}
              />
            </Box>
          </Box>
        ) : null}
        {tab === "Chart" || (tab === "Market" && !wide) ? (
          <CandleChart
            snapshot={snapshot}
            account={account.account}
            width={width}
            height={bodyHeight}
            focused={focused}
          />
        ) : null}
        {market && tab === "Ticket" ? (
          <OrderTicket
            market={market}
            book={snapshot.book}
            width={width}
            focused={focused}
            limitPrice={bookPrice}
            onClearPrice={() => setBookPrice(undefined)}
          />
        ) : null}
        {tab === "Book" ? (
          <BookView
            snapshot={snapshot}
            width={width}
            height={bodyHeight}
            focused={focused}
            onPrice={pickPrice}
          />
        ) : null}
        {tab === "Trades" ? (
          <TradeTape
            snapshot={snapshot}
            width={width}
            height={bodyHeight}
            focused={focused}
          />
        ) : null}
        {tab === "Funding" || tab === "Open interest" || tab === "Premium" ? (
          <FundingHistory
            coin={market?.coin ?? coin}
            width={width}
            height={bodyHeight}
            focused={focused}
            metric={
              tab === "Open interest"
                ? "oi"
                : tab === "Premium"
                  ? "premium"
                  : "funding"
            }
          />
        ) : null}
        {tab === "Positions" ? (
          <PositionsTable
            account={account.account}
            width={width}
            height={bodyHeight}
            focused={focused}
            market={market?.coin}
            loading={account.loading}
          />
        ) : null}
        {market && tab === "Info" ? (
          <MarketInfo
            market={market}
            category={snapshot.annotation?.category}
            underlying={snapshot.annotation?.description}
            cash={cash}
            width={width}
          />
        ) : null}
      </PaneStatusBody>
    </Box>
  );
}

const INFO_LABEL_WIDTH = 16;
const titleCase = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);
function MarketInfo({
  market,
  category,
  underlying,
  cash,
  width,
}: {
  market: Market;
  category?: string;
  underlying?: string;
  cash: CashReference | null;
  width: number;
}) {
  const twoColumns = width >= 100;
  const columnWidth = twoColumns ? Math.floor((width - 4) / 2) : width - 2;
  const row = (label: string, value: string, color?: string) => (
    <KeyValueRow
      key={label}
      label={label}
      value={value}
      color={color}
      labelWidth={INFO_LABEL_WIDTH}
      width={columnWidth}
    />
  );
  const contract = (
    <Section title="Contract">
      {row("Category", titleCase(category ?? market.category ?? market.assetClass))}
      {row("Lot size", String(10 ** -market.szDecimals))}
      {row(
        "Tick",
        `5 significant digits, ${6 - market.szDecimals} decimals max`,
      )}
      {row("Margin", market.onlyIsolated ? "Isolated only" : "Cross or isolated")}
      {row("Collateral", market.collateral)}
      {market.deployer ? row("Deployer", market.deployer) : null}
      {market.oracleUpdater ? row("Oracle updater", market.oracleUpdater) : null}
      {underlying ? (
        <Box width={columnWidth} paddingTop={1}>
          <Text fg={colors.textDim} wrapText>
            {underlying}
          </Text>
        </Box>
      ) : null}
    </Section>
  );
  const funding = (
    <Box flexDirection="column">
      <Section title="Funding">
        {row(
          "Current /8h",
          fundingRate(market.funding8h),
          fundingTone(market.funding8h),
        )}
        {row(
          "Simple APR",
          percent(market.fundingApr),
          tone(market.fundingApr, 2),
        )}
        {row("Cap /1h", percent(market.fundingCap, 2, false))}
      </Section>
      {cash ? (
        <Section title="Cash Reference">
          {row(cash.label, `${price(cash.price)} USD`)}
          {row(
            "Perp premium",
            percent((market.mark ?? cash.price) / cash.price - 1),
            tone((market.mark ?? cash.price) / cash.price - 1, 2),
          )}
          {row("As of UTC", cash.sessionDate ?? dateTime(cash.asOf))}
        </Section>
      ) : null}
      <Section title="Margin Tiers">
        {market.marginTiers.map((t) =>
          row(
            `From $${compactAxis(t.lowerBound)}`,
            `${t.maxLeverage}x max · ${percent(1 / (t.maxLeverage * 2), 2, false)} maintenance`,
          ),
        )}
      </Section>
    </Box>
  );
  // Sections carry their own top margin, so the containers add no gap.
  return (
    <ScrollBox
      flexGrow={1}
      contentOptions={{ flexDirection: "column", paddingX: 1 }}
    >
      <Box flexDirection={twoColumns ? "row" : "column"} gap={twoColumns ? 2 : 0}>
        <Box width={columnWidth} flexDirection="column">
          {contract}
        </Box>
        <Box width={columnWidth} flexDirection="column">
          {funding}
        </Box>
      </Box>
    </ScrollBox>
  );
}
