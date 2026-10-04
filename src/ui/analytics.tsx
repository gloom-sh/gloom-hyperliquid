import { useCallback, useMemo, useState } from "react";
import { Box } from "gloomberb/ui";
import {
  Button,
  ChartTableHeader,
  DataTableView,
  PaneStatusBody,
  QueryBar,
  scalarPoint,
  staticSeries,
  usePaneTabs,
  useQueryBarSearch,
  type DataTableColumn,
} from "gloomberb/components";
import {
  useAsyncResource,
  useAutoRefresh,
  usePaneSettingValue,
  usePluginAppActions,
  usePluginPaneState,
} from "gloomberb/react";
import type { PaneProps } from "gloomberb/types/plugin";
import { colors } from "gloomberb/theme";
import type {
  CloudRankedMarket,
  CloudResult,
  PredictedFunding,
} from "../market";
import { getCloudPerpsClient } from "../market/cloud-history";
import {
  compact,
  dateTime,
  fundingRate,
  fundingTone,
  number,
  percent,
  price,
  tone,
} from "./format";
import { useBoard, useLiveFooter, useNetwork } from "./hooks";

const RANGE_OPTIONS = [1, 7, 30, 90, 365].map((days) => ({
  value: String(days),
  label:
    days === 1
      ? "1D"
      : days === 7
        ? "1W"
        : days === 30
          ? "1M"
          : days === 90
            ? "3M"
            : "1Y",
}));
const VENUES: Record<string, string> = {
  BinPerp: "Binance",
  BybitPerp: "Bybit",
  HlPerp: "Hyperliquid",
  OkxPerp: "OKX",
};
const venueName = (venue: string) => VENUES[venue] ?? venue;
const RESOLUTION_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
const RESOLUTION_LABEL = { minute: "1m", hour: "1h", day: "1d" };
function CloudStateBody({
  result,
  loading,
  retry,
}: {
  result?: CloudResult<unknown> | null;
  loading: boolean;
  retry: () => void;
}) {
  const app = usePluginAppActions();
  const title =
    result?.state === "sign-in"
      ? "Sign in for perpetual history."
      : result?.state === "pro-required"
        ? "Perpetual history is included with Pro."
        : result?.state === "testnet"
          ? "Historical analytics cover mainnet."
          : result?.state === "collecting"
            ? "History is still collecting."
            : "Historical analytics unavailable.";
  // A retry only helps a failed request; a host without plugin cloud access or
  // a testnet connection gives the same answer every time.
  const retryable =
    result?.state !== "testnet" && result?.state !== "host-unavailable";
  return (
    <PaneStatusBody
      loading={loading && !result}
      subject="historical analytics"
      empty
      emptyTitle={title}
      emptyMessage={
        result?.error ??
        "Historical analytics are not available from Gloom Cloud yet."
      }
      actions={
        result?.state === "sign-in" ? (
          <Button
            label="Sign in"
            variant="primary"
            onPress={() => app.openCommandBar("Sign in")}
          />
        ) : result?.state === "pro-required" ? (
          <Button
            label="Upgrade to Pro"
            variant="primary"
            onPress={() => app.openCommandBar("Upgrade to Pro")}
          />
        ) : retryable ? (
          <Button label="Try again" onPress={retry} />
        ) : undefined
      }
    />
  );
}
export function FundingHistory({
  coin,
  width,
  height,
  focused,
  metric = "funding",
}: {
  coin: string;
  width: number;
  height: number;
  focused: boolean;
  metric?: "funding" | "oi" | "premium";
}) {
  const [network] = useNetwork();
  const [days, setDays] = usePluginPaneState(`historyRange:${coin}`, "7");
  const [resolution, setResolution] = usePluginPaneState(
    `historyResolution:${coin}`,
    "auto",
  );
  const [fundingKind, setFundingKind] = usePluginPaneState(
    `fundingKind:${coin}`,
    "current",
  );
  const client = useMemo(() => getCloudPerpsClient(network), [network]);
  const loader = useCallback(
    () =>
      client.history(coin, {
        days: Number(days),
        resolution: resolution as "auto" | "minute" | "hour" | "day",
      }),
    [client, coin, days, resolution],
  );
  const resource = useAsyncResource(loader);
  useAutoRefresh(resource.updatedAt, resource.reload, { intervalMs: 60_000 });
  const data = resource.data?.data;
  const paid = metric === "funding" && fundingKind === "historical";
  const rows = useMemo(() => {
    if (!data) return [];
    const points = paid
      ? data.funding.map((p) => ({
          time: p.time,
          primary: p.rate / p.intervalHours,
          secondary: p.premium,
          mark: null as number | null,
          oracle: null as number | null,
          resolution: `${p.intervalHours}h`,
          duration: p.intervalHours * 3_600_000,
          sampleCount: null as number | null,
          firstObservedAt: p.observedAt,
          observedAt: p.observedAt,
        }))
      : data.points.map((p) => ({
          time: p.time,
          primary:
            p.sampleCount === 0
              ? null
              : metric === "oi"
                ? p.oiUsd
                : metric === "premium"
                  ? p.premium
                  : p.fundingRate != null && p.fundingIntervalHours
                    ? p.fundingRate / p.fundingIntervalHours
                    : null,
          secondary:
            metric === "oi"
              ? p.oiCoin
              : metric === "premium"
                ? null
                : p.premium,
          mark: p.mark,
          oracle: p.oracle,
          resolution: RESOLUTION_LABEL[p.resolution],
          duration: RESOLUTION_MS[p.resolution],
          sampleCount: p.sampleCount,
          firstObservedAt: p.firstObservedAt,
          observedAt: p.lastObservedAt,
        }));
    return points
      .map((point, index) => ({
        ...point,
        change:
          index > 0 &&
          point.primary != null &&
          points[index - 1]!.primary &&
          point.duration === points[index - 1]!.duration &&
          point.time - points[index - 1]!.time <= point.duration
            ? point.primary / points[index - 1]!.primary! - 1
            : null,
      }))
      .reverse();
  }, [data, paid, metric]);
  const [selected, setSelected] = useState<number | null>(null);
  const columns: DataTableColumn[] = [
    {
      id: "time",
      label: paid ? "Funding UTC" : "Time UTC",
      width: 21,
      align: "left",
    },
    {
      id: "primary",
      label:
        metric === "oi"
          ? "OI USD"
          : metric === "premium"
            ? "Mark / oracle %"
            : paid
              ? "Historical /1h %"
              : "Observed /1h %",
      width: 18,
      align: "right",
    },
    ...(metric === "oi"
      ? [
          {
            id: "secondary",
            label: "OI coin",
            width: 17,
            align: "right" as const,
          },
          {
            id: "change",
            label: "OI USD change %",
            width: 18,
            align: "right" as const,
          },
        ]
      : metric === "premium"
        ? [
            { id: "mark", label: "Mark", width: 15, align: "right" as const },
            {
              id: "oracle",
              label: "Oracle",
              width: 15,
              align: "right" as const,
            },
          ]
        : [
            {
              id: "secondary",
              label: paid ? "Funding premium %" : "Mark / oracle %",
              width: 20,
              align: "right" as const,
            },
          ]),
    {
      id: "resolution",
      label: paid ? "Interval" : "Actual resolution",
      width: 18,
      align: "left",
    },
    ...(!paid
      ? [
          {
            id: "sampleCount",
            label: "Samples",
            width: 10,
            align: "right" as const,
          },
          {
            id: "firstObservedAt",
            label: "First observed UTC",
            width: 21,
            align: "left" as const,
          },
        ]
      : []),
    {
      id: "observedAt",
      label: paid ? "Observed UTC" : "Last observed UTC",
      width: 21,
      align: "left",
    },
  ];
  const history = useMemo(() => {
    const chronological = [...rows].reverse();
    const points: ReturnType<typeof scalarPoint>[] = [];
    let gaps = false;
    chronological.forEach((point, index) => {
      const previous = chronological[index - 1];
      // A null is a chart boundary, never a fabricated observation or value.
      if (
        previous &&
        (point.duration !== previous.duration ||
          point.time - previous.time > previous.duration)
      ) {
        points.push(
          scalarPoint(
            new Date(
              previous.time +
                Math.min(previous.duration, (point.time - previous.time) / 2),
            ),
            null,
          ),
        );
        gaps = true;
      }
      points.push({
        ...scalarPoint(
          new Date(point.time),
          point.primary == null
            ? null
            : point.primary * (metric === "oi" ? 1 : 100),
        ),
        observedAt: new Date(point.observedAt),
      });
      if (point.primary == null) gaps = true;
    });
    const valid = chronological.filter((point) => point.primary != null);
    const effectiveResolution =
      [...new Set(chronological.map((point) => point.resolution))].join("/") ||
      (data ? RESOLUTION_LABEL[data.resolution] : "--");
    const first = valid[0],
      last = valid.at(-1);
    const coverage =
      first && last
        ? `${dateTime(paid ? first.time : first.firstObservedAt)} to ${dateTime(paid ? last.time : last.observedAt)} UTC`
        : "No observations";
    return {
      points,
      gaps,
      effectiveResolution,
      coverage,
      samples: paid
        ? null
        : chronological.reduce(
            (sum, point) => sum + (point.sampleCount ?? 0),
            0,
          ),
    };
  }, [rows, metric, paid, data]);
  const series = useMemo(
    () => [
      {
        ...staticSeries(history.points, {
          id: "history",
          label:
            metric === "oi"
              ? "OI USD"
              : metric === "premium"
                ? "Mark / oracle premium"
                : paid
                  ? "Historical funding /1h"
                  : "Observed funding /1h",
          color: colors.borderFocused,
          style: "line",
          calendarSpaced: true,
        }),
        unit: metric === "oi" ? "USD" : "%",
        unitGroup: metric === "oi" ? "currency" : "percentage",
      },
    ],
    [history.points, metric, paid],
  );
  useLiveFooter("hyperliquid-history", {
    network,
    status: resource.loading
      ? "loading history"
      : data && !resource.data?.locked
        ? `${data.truncated ? "Truncated" : resource.data?.state === "partial" ? "Partial" : "Historical"} · ${history.effectiveResolution}${history.gaps ? " · Gaps" : ""} · Coverage ${history.coverage}`
        : undefined,
    asOf: data && !resource.data?.locked ? resource.data?.asOf : null,
    error:
      resource.error ??
      (data?.truncated
        ? "History truncated; shorten the range or choose a coarser resolution."
        : null),
  });
  const query = (
    <QueryBar
      width={width}
      meta={
        data && !resource.data?.locked
          ? `Actual ${history.effectiveResolution}`
          : undefined
      }
      filters={[
        {
          id: "days",
          label: "Range",
          value: days,
          options: RANGE_OPTIONS,
          onChange: setDays,
        },
        {
          id: "resolution",
          label: "Resolution",
          value: resolution,
          options: ["auto", "minute", "hour", "day"].map((value) => ({
            value,
            label: value === "auto" ? "Auto" : value,
          })),
          onChange: setResolution,
        },
        ...(metric === "funding"
          ? [
              {
                id: "fundingKind",
                label: "Funding",
                value: fundingKind,
                options: [
                  { value: "current", label: "Observed rate" },
                  { value: "historical", label: "Historical funding" },
                ],
                onChange: setFundingKind,
              },
            ]
          : []),
      ]}
    />
  );
  if (
    !data ||
    resource.data?.locked ||
    (!rows.length && resource.data?.state === "collecting")
  )
    return (
      <Box flexGrow={1} flexDirection="column">
        {query}
        <CloudStateBody
          result={resource.data}
          loading={resource.loading}
          retry={resource.reload}
        />
      </Box>
    );
  if (!rows.length)
    return (
      <Box flexGrow={1} flexDirection="column">
        {query}
        <PaneStatusBody
          empty
          emptyTitle="No history in this range."
          emptyMessage="Choose another range or wait for new observations."
        />
      </Box>
    );
  return (
    <DataTableView
      focused={focused}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={rows}
      getItemKey={(r) => String(r.time)}
      sortColumnId={null}
      sortDirection="desc"
      selection={{
        kind: "index",
        selectedIndex: selected,
        onChange: setSelected,
      }}
      rootBefore={
        <ChartTableHeader
          width={width}
          height={height}
          tableRows={rows.length}
          tableColumns={columns}
          query={query}
          chart={{
            series,
            cursorDate:
              selected == null ? null : new Date(rows[selected]?.time ?? 0),
            onCursorDateChange: (date) => {
              const index = date
                ? rows.findIndex((row) => row.time === date.getTime())
                : -1;
              setSelected(index < 0 ? null : index);
            },
            formatValue: (value) =>
              metric === "oi" ? compact(value) : `${value.toFixed(4)}%`,
          }}
        />
      }
      renderCell={(row, column) => {
        const value = row[column.id as keyof typeof row];
        if (column.id === "resolution")
          return { text: String(value), value: String(value) };
        if (column.id === "sampleCount")
          return {
            text: number(value as number | null, 0),
            value: value as number | null,
          };
        if (
          column.id === "time" ||
          column.id === "observedAt" ||
          column.id === "firstObservedAt"
        )
          return {
            text: dateTime(value as number),
            value: value ? new Date(value).toISOString() : null,
          };
        if (column.id === "mark" || column.id === "oracle")
          return { text: price(value as number | null), value };
        const numeric = value as number | null;
        const percentage = metric !== "oi" || column.id === "change";
        return {
          text: percentage ? percent(numeric, 4) : compact(numeric),
          value: numeric == null ? null : numeric * (percentage ? 100 : 1),
          color: percentage ? tone(numeric, 4) : undefined,
        };
      }}
      emptyStateTitle="No history in this range."
    />
  );
}
const RANK_COLUMNS: Record<string, DataTableColumn[]> = {
  Funding: [
    { id: "coin", label: "Market", width: 18, align: "left" },
    { id: "assetClass", label: "Class", width: 10, align: "left" },
    { id: "fundingApr", label: "Simple APR", width: 14, align: "right" },
    { id: "funding8h", label: "Rate /8h %", width: 14, align: "right" },
    { id: "fundingKind", label: "Rate type", width: 12, align: "left" },
    { id: "oiUsd", label: "OI USD", width: 14, align: "right" },
    { id: "volume24h", label: "24h vol USD", width: 14, align: "right" },
    { id: "observedAt", label: "As of UTC", width: 21, align: "left" },
  ],
  "Open interest": [
    { id: "coin", label: "Market", width: 18, align: "left" },
    { id: "assetClass", label: "Class", width: 10, align: "left" },
    { id: "oiUsd", label: "OI USD", width: 14, align: "right" },
    { id: "oiChange1h", label: "OI coin 1h %", width: 16, align: "right" },
    { id: "oiChange24h", label: "OI coin 24h %", width: 17, align: "right" },
    { id: "oiChange1hUsd", label: "OI USD 1h %", width: 16, align: "right" },
    { id: "oiChange24hUsd", label: "OI USD 24h %", width: 17, align: "right" },
    { id: "observedAt", label: "As of UTC", width: 21, align: "left" },
  ],
  Premium: [
    { id: "coin", label: "Market", width: 18, align: "left" },
    { id: "assetClass", label: "Class", width: 10, align: "left" },
    { id: "premium", label: "Mark / oracle %", width: 18, align: "right" },
    {
      id: "closedMarketPremium",
      label: "Closed cash %",
      width: 16,
      align: "right",
    },
    { id: "mark", label: "Mark", width: 14, align: "right" },
    { id: "oracle", label: "Oracle", width: 14, align: "right" },
    { id: "oiUsd", label: "OI USD", width: 14, align: "right" },
    { id: "observedAt", label: "As of UTC", width: 21, align: "left" },
  ],
};
export function HyperliquidAnalyticsPane({
  focused,
  width,
  height,
}: PaneProps) {
  const board = useBoard();
  const app = usePluginAppActions();
  const [defaultTab] = usePaneSettingValue("defaultTab", "Funding");
  const [tab, setTab] = usePluginPaneState(
    "analyticsTab",
    ["Funding", "Open interest", "Premium", "Predicted"].find(
      (value) => value.toLowerCase() === defaultTab.toLowerCase(),
    ) ?? "Funding",
  );
  const [category, setCategory] = usePluginPaneState("analyticsClass", "All");
  const [query, setQuery] = usePluginPaneState("analyticsQuery", "");
  const [fundingSide, setFundingSide] = usePluginPaneState(
    "fundingSide",
    "positive",
  );
  const [premiumKind, setPremiumKind] = usePluginPaneState(
    "premiumKind",
    "oracle",
  );
  const [sort, setSort] = usePluginPaneState("analyticsSortV2", {
    id: "",
    direction: "desc" as "asc" | "desc",
  });
  const [selected, setSelected] = useState<string | null>(null);
  const search = useQueryBarSearch();
  const client = useMemo(
    () => getCloudPerpsClient(board.network),
    [board.network],
  );
  const loader = useCallback(() => client.rankings(), [client]);
  const resource = useAsyncResource(tab === "Predicted" ? null : loader);
  useAutoRefresh(resource.updatedAt, resource.reload, { intervalMs: 60_000 });
  const tabs = usePaneTabs({
    tabs: ["Funding", "Open interest", "Premium", "Predicted"].map((value) => ({
      value,
      label: value,
    })),
    activeValue: tab,
    onSelect: (value) => {
      setTab(value);
      setSort({ id: "", direction: "desc" });
    },
    focused: focused && !search.active,
    compact: true,
    dense: true,
  });
  const rankings = resource.data?.data;
  const section =
    tab === "Funding"
      ? fundingSide === "negative"
        ? "fundingNegative"
        : "fundingPositive"
      : tab === "Open interest"
        ? "oiSurges"
        : premiumKind === "cash"
          ? "closedMarketDislocations"
          : "premiumDislocations";
  const rows = useMemo(() => {
    const rows = (rankings?.[section] ?? []).filter(
      (m) =>
        (category === "All" || m.assetClass === category) &&
        (!query || m.coin.toLowerCase().includes(query.toLowerCase())),
    );
    return sort.id
      ? [...rows].sort((a, b) => {
          const av = a[sort.id as keyof CloudRankedMarket],
            bv = b[sort.id as keyof CloudRankedMarket];
          if (av == null) return 1;
          if (bv == null) return -1;
          return (
            (typeof av === "number" && typeof bv === "number"
              ? av - bv
              : String(av).localeCompare(String(bv))) *
            (sort.direction === "asc" ? 1 : -1)
          );
        })
      : rows;
  }, [rankings, section, category, query, sort]);
  const [mountedAt] = useState(Date.now);
  // Predictions arrive after the market list; an empty list stays "loading"
  // for a short while instead of claiming that none were returned.
  const predictedLoading =
    !board.predictedFundings.length &&
    !board.error &&
    Date.now() - mountedAt < 20_000;
  const predicted = board.predictedFundings.filter(
    (p) =>
      (!query || p.coin.toLowerCase().includes(query.toLowerCase())) &&
      (category === "All" ||
        board.markets.find((m) => m.coin === p.coin)?.assetClass === category),
  );
  useLiveFooter(
    "hyperliquid-analytics",
    tab === "Predicted"
      ? board
      : {
          network: board.network,
          // An unavailable or locked state is the body's message; the
          // footer does not repeat it or show its internal state name.
          status: resource.loading
            ? "loading rankings"
            : rankings && !resource.data?.locked
              ? "updated"
              : undefined,
          asOf: rankings && !resource.data?.locked ? resource.data?.asOf : null,
          error: resource.error,
        },
    [
      {
        id: "market",
        key: "m",
        label: "arket",
        disabled: !selected,
        onPress: () =>
          selected &&
          app.createPaneFromTemplate("hyperliquid-market-new", {
            symbol: selected.split("|")[0] ?? selected,
          }),
      },
    ],
  );
  const before = (
    <>
      {tabs.strip}
      <QueryBar
        width={width}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: "Search perpetuals",
          focused,
          ...search.searchProps,
        }}
        filters={[
          {
            id: "class",
            label: "Class",
            value: category,
            defaultValue: "All",
            options: [
              "All",
              "Crypto",
              "Stocks",
              "Indices",
              "Energy",
              "Metals",
              "FX",
            ].map((value) => ({ value, label: value })),
            onChange: setCategory,
          },
          ...(tab === "Funding"
            ? [
                {
                  id: "side",
                  label: "Extreme",
                  value: fundingSide,
                  options: [
                    { value: "positive", label: "Positive funding" },
                    { value: "negative", label: "Negative funding" },
                  ],
                  onChange: setFundingSide,
                },
              ]
            : []),
          ...(tab === "Premium"
            ? [
                {
                  id: "premiumKind",
                  label: "Premium",
                  value: premiumKind,
                  options: [
                    { value: "oracle", label: "Versus oracle" },
                    { value: "cash", label: "Versus closed cash" },
                  ],
                  onChange: setPremiumKind,
                },
              ]
            : []),
        ]}
        meta={
          tab === "Predicted"
            ? "Venue estimates reported by Hyperliquid"
            : undefined
        }
      />
    </>
  );
  if (tab === "Predicted")
    return (
      <DataTableView<PredictedFunding>
        focused={focused}
        keyboardNavigation={!search.active}
        rootWidth={width}
        rootHeight={height}
        rootBefore={before}
        columns={[
          { id: "coin", label: "Market", width: 14, align: "left" },
          { id: "venue", label: "Venue", width: 12, align: "left" },
          { id: "rate", label: "Rate", width: 11, align: "right" },
          {
            id: "intervalHours",
            label: "Interval",
            width: 8,
            align: "right",
          },
          { id: "per8h", label: "Rate /8h", width: 11, align: "right" },
          { id: "apr", label: "Simple APR", width: 11, align: "right" },
          {
            id: "nextFundingTime",
            label: "Next payment UTC",
            width: 19,
            align: "left",
          },
        ]}
        emptyContent={
          predictedLoading ? (
            <PaneStatusBody loading subject="predicted funding" />
          ) : undefined
        }
        items={[...predicted].sort((a, b) => {
          const av = a[(sort.id || "apr") as keyof PredictedFunding],
            bv = b[(sort.id || "apr") as keyof PredictedFunding];
          return (
            (typeof av === "number" && typeof bv === "number"
              ? av - bv
              : String(av).localeCompare(String(bv))) *
            (sort.direction === "asc" ? 1 : -1)
          );
        })}
        selection={{
          kind: "id",
          selectedId: selected,
          getId: (r) => `${r.coin}|${r.venue}`,
          onChange: setSelected,
        }}
        getItemKey={(r) => `${r.coin}|${r.venue}`}
        sortColumnId={sort.id || "apr"}
        sortDirection={sort.direction}
        onHeaderClick={(id) =>
          setSort((old) => ({
            id,
            direction:
              old.id === id && old.direction === "desc" ? "asc" : "desc",
          }))
        }
        onActivate={(row) =>
          app.createPaneFromTemplate("hyperliquid-market-new", {
            symbol: row.coin,
          })
        }
        renderCell={(row, column) => {
          if (column.id === "rate" || column.id === "per8h")
            return {
              text: fundingRate(row[column.id]),
              value: row[column.id] * 100,
              color: fundingTone(row[column.id]),
            };
          if (column.id === "apr")
            return {
              text: percent(row.apr),
              value: row.apr * 100,
              color: tone(row.apr, 2),
            };
          if (column.id === "intervalHours")
            return { text: `${row.intervalHours}h`, value: row.intervalHours };
          if (column.id === "nextFundingTime")
            return {
              text: dateTime(row.nextFundingTime),
              value: new Date(row.nextFundingTime).toISOString(),
            };
          if (column.id === "venue") return { text: venueName(row.venue) };
          return { text: row.coin };
        }}
        selectedTextOverridesCellColor
        emptyStateTitle="No predicted funding returned."
      />
    );
  if (!rankings || resource.data?.locked)
    return (
      <Box flexDirection="column" flexGrow={1}>
        {before}
        <CloudStateBody
          result={resource.data}
          loading={resource.loading}
          retry={resource.reload}
        />
      </Box>
    );
  return (
    <DataTableView<CloudRankedMarket>
      focused={focused}
      keyboardNavigation={!search.active}
      rootWidth={width}
      rootHeight={height}
      rootBefore={before}
      columns={RANK_COLUMNS[tab] ?? RANK_COLUMNS.Funding!}
      items={rows}
      getItemKey={(r) => r.coin}
      selection={{
        kind: "id",
        selectedId: selected,
        getId: (r) => r.coin,
        onChange: setSelected,
      }}
      sortColumnId={sort.id || null}
      sortDirection={sort.direction}
      onHeaderClick={(id) =>
        setSort((old) => ({
          id,
          direction: old.id === id && old.direction === "desc" ? "asc" : "desc",
        }))
      }
      onActivate={(row) =>
        app.createPaneFromTemplate("hyperliquid-market-new", {
          symbol: row.coin,
        })
      }
      renderCell={(row, column) => {
        const value = row[column.id as keyof CloudRankedMarket];
        const percentage = [
          "fundingApr",
          "funding8h",
          "premium",
          "closedMarketPremium",
          "oiChange1h",
          "oiChange24h",
          "oiChange1hUsd",
          "oiChange24hUsd",
        ].includes(column.id);
        return {
          text: percentage
            ? percent(value as number | null, column.id === "funding8h" ? 4 : 2)
            : column.id === "observedAt"
              ? dateTime(Number(value))
              : typeof value === "number"
                ? ["mark", "oracle"].includes(column.id)
                  ? price(value)
                  : compact(value)
                : String(value ?? "--"),
          value:
            typeof value === "number"
              ? value * (percentage ? 100 : 1)
              : undefined,
          color: percentage
            ? tone(value as number | null, column.id === "funding8h" ? 4 : 2)
            : undefined,
        };
      }}
      selectedTextOverridesCellColor
      emptyStateTitle="No ranked markets in this view."
    />
  );
}
