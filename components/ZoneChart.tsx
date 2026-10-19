import React, { memo, useMemo, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import Svg, { Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { useTheme } from '@/contexts/ThemeContext';
import { IconSymbol } from '@/components/ui/icon-symbol';

// ---------------------------------------------------------------------------
// Model — the node a zone EA publishes at `zonestatus/{accountId}/{symbolKey}`
// (symbolKey = the same sanitized key the app writes at zones/{accountId}/…).
// The app only READS this node.
// ---------------------------------------------------------------------------

export type ZoneRole = 'demand' | 'supply';
export type ZoneState = 'inside' | 'near' | 'far';

export interface Candle {
  t: number; // bar time, UTC epoch seconds
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface LiveZone {
  high: number;
  low: number;
  role: ZoneRole;
  state: ZoneState;
  dist: number | null;    // price distance to the zone
  distAtr: number | null; // the same distance in ATR multiples
  lastEvent: string;      // 'approached' | 'entered' | 'crossed' | 'signal' | ''
  lastEventAt: number;    // UTC epoch seconds (0 = none)
}

export interface ZoneStatus {
  symbol: string;
  price: number | null;
  digits: number;
  atr: number | null;
  tf: string;
  updated: number;        // UTC epoch seconds (0 = unknown)
  candles: Candle[];      // oldest -> newest
  zones: LiveZone[];      // top -> bottom (high, descending)
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

// RTDB hands dense arrays back as arrays, but sparse ones (or maps) as objects.
const asList = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v as Record<string, unknown>) : [];

// [t,o,h,l,c] (or {t,o,h,l,c}) -> Candle; null if any value is missing.
function parseCandle(raw: unknown): Candle | null {
  const vals =
    raw && typeof raw === 'object' && !Array.isArray(raw) && 't' in raw
      ? (['t', 'o', 'h', 'l', 'c'] as const).map((k) => num((raw as Record<string, unknown>)[k]))
      : asList(raw).slice(0, 5).map(num);
  if (vals.length < 5 || vals.some((v) => v === null)) return null;
  const [t, o, h, l, c] = vals as number[];
  // Keep the wick bounding the body even if the feed is slightly off.
  return { t, o, c, h: Math.max(h, o, c), l: Math.min(l, o, c) };
}

function parseZone(raw: unknown, price: number | null): LiveZone | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const a = num(r.high);
  const b = num(r.low);
  if (a === null || b === null) return null;
  const high = Math.max(a, b);
  const low = Math.min(a, b);
  const role = String(r.role ?? '').toLowerCase();
  const state = String(r.state ?? '').toLowerCase();
  const priceInside = price !== null && price >= low && price <= high;
  return {
    high,
    low,
    role: role === 'supply' || role === 'demand' ? role : price !== null && low > price ? 'supply' : 'demand',
    state: state === 'inside' || state === 'near' || state === 'far' ? state : priceInside ? 'inside' : 'far',
    dist: num(r.dist),
    distAtr: num(r.distAtr),
    lastEvent: typeof r.lastEvent === 'string' ? r.lastEvent.trim() : '',
    lastEventAt: num(r.lastEventAt) ?? 0,
  };
}

const guessDigits = (price: number | null) => {
  if (price === null) return 2;
  const p = Math.abs(price);
  return p >= 1000 ? 2 : p >= 10 ? 3 : 5;
};

/** Normalise a raw zonestatus node; null when the node doesn't exist. */
export function parseZoneStatus(raw: unknown): ZoneStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const candles = asList(r.candles)
    .map((c) => parseCandle(c))
    .filter((c): c is Candle => c !== null)
    .sort((a, b) => a.t - b.t);
  const price = num(r.price) ?? (candles.length ? candles[candles.length - 1].c : null);
  const d = num(r.digits);
  const digits = d !== null && d >= 0 && d <= 10 ? Math.round(d) : guessDigits(price);
  const zones = asList(r.zones)
    .map((z) => parseZone(z, price))
    .filter((z): z is LiveZone => z !== null)
    .sort((a, b) => b.high - a.high);
  return {
    symbol: typeof r.symbol === 'string' ? r.symbol : '',
    price,
    digits,
    atr: num(r.atr),
    tf: typeof r.tf === 'string' ? r.tf : '',
    updated: num(r.updated) ?? 0,
    candles,
    zones,
  };
}

/** Hottest zone state in a raw zonestatus node ('inside' > 'near'); skips the candles. */
export function zoneAlertLevel(raw: unknown): 'inside' | 'near' | null {
  if (!raw || typeof raw !== 'object') return null;
  let level: 'inside' | 'near' | null = null;
  for (const z of asList((raw as Record<string, unknown>).zones)) {
    const s = z && typeof z === 'object' ? String((z as Record<string, unknown>).state ?? '').toLowerCase() : '';
    if (s === 'inside') return 'inside';
    if (s === 'near') level = 'near';
  }
  return level;
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

const CHART_HEIGHT = 220;
const AXIS_H = 16;              // bottom strip for time labels
const TOP_PAD = 2;
const TAG_H = 16;               // current-price tag
const MIN_SLOT_FOR_CANDLES = 2; // px per bar; denser than this draws a close line
const DASH = [4, 3];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const r1 = (v: number) => Math.round(v * 10) / 10;
const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

// 1/2/5 x 10^k step giving roughly `target` gridlines across `span`.
function niceStep(span: number, target: number): number {
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / mag;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
}

interface Geometry {
  plotW: number;
  plotBottom: number;
  gutter: number;
  lineMode: boolean;
  upWicks: string;
  downWicks: string;
  upBodies: string;
  downBodies: string;
  line: string;
  bands: { y: number; h: number; role: ZoneRole; state: ZoneState }[];
  ticks: { y: number; label: string; showLabel: boolean }[];
  priceY: number | null;
  tagY: number;
  priceLabel: string;
  times: { x: number; label: string; anchor: 'start' | 'middle' | 'end' }[];
}

function buildGeometry(
  candles: Candle[],
  zones: LiveZone[],
  price: number | null,
  digits: number,
  width: number,
  height: number
): Geometry | null {
  const n = candles.length;
  if (n === 0 || width <= 0) return null;

  // Y-range covers every candle, every zone and the live price, plus 5% headroom.
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candles) {
    if (c.l < lo) lo = c.l;
    if (c.h > hi) hi = c.h;
  }
  for (const z of zones) {
    if (z.low < lo) lo = z.low;
    if (z.high > hi) hi = z.high;
  }
  if (price !== null) {
    lo = Math.min(lo, price);
    hi = Math.max(hi, price);
  }
  if (!(hi > lo)) {
    const flat = Math.abs(hi) * 0.001 || 1;
    lo -= flat;
    hi += flat;
  }
  const headroom = (hi - lo) * 0.05;
  lo -= headroom;
  hi += headroom;

  const fmt = (v: number) => v.toFixed(digits);
  const priceLabel = price !== null ? fmt(price) : '';
  // Right gutter sized to the widest price label (digits ~5.7px wide at 10pt bold).
  const labelChars = Math.max(priceLabel.length, fmt(hi).length, fmt(lo).length);
  const gutter = Math.ceil(labelChars * 5.8 + 10);
  const plotW = Math.max(1, width - gutter);
  const plotBottom = height - AXIS_H;
  const plotH = plotBottom - TOP_PAD;
  const yOf = (v: number) => TOP_PAD + ((hi - v) / (hi - lo)) * plotH;

  // Candles as four batched paths (up/down x wick/body): a handful of SVG nodes
  // however many bars there are.
  const slot = plotW / n;
  const lineMode = slot < MIN_SLOT_FOR_CANDLES;
  let upWicks = '';
  let downWicks = '';
  let upBodies = '';
  let downBodies = '';
  let line = '';
  if (lineMode) {
    line = candles.map((c, i) => `${i ? 'L' : 'M'}${r1((i + 0.5) * slot)} ${r1(yOf(c.c))}`).join('');
  } else {
    const bodyW = Math.min(9, Math.max(1, slot * 0.65));
    for (let i = 0; i < n; i++) {
      const c = candles[i];
      const x = (i + 0.5) * slot;
      const wick = `M${r1(x)} ${r1(yOf(c.h))}V${r1(yOf(c.l))}`;
      const top = yOf(Math.max(c.o, c.c));
      const bodyH = Math.max(1, yOf(Math.min(c.o, c.c)) - top);
      const body = `M${r1(x - bodyW / 2)} ${r1(top)}h${r1(bodyW)}v${r1(bodyH)}h${r1(-bodyW)}Z`;
      if (c.c >= c.o) {
        upWicks += wick;
        upBodies += body;
      } else {
        downWicks += wick;
        downBodies += body;
      }
    }
  }

  // Zone bands (at least 2px tall so razor-thin zones stay visible).
  const bands = zones.map((z) => {
    const yTop = yOf(z.high);
    const yBot = yOf(z.low);
    const h = Math.max(2, yBot - yTop);
    return { y: (yTop + yBot) / 2 - h / 2, h, role: z.role, state: z.state };
  });

  const priceY = price !== null ? yOf(price) : null;
  const tagY = priceY !== null ? Math.min(Math.max(priceY - TAG_H / 2, 0), plotBottom - TAG_H) : 0;

  // Round-number gridlines; labels that would collide with the price tag or
  // clip at the edges are dropped (the line stays).
  const step = niceStep(hi - lo, 4);
  const decimals = Math.min(digits, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
  const ticks: Geometry['ticks'] = [];
  const firstTick = Math.ceil(lo / step) * step;
  for (let i = 0; i < 12; i++) {
    const v = firstTick + i * step;
    if (v > hi) break;
    const y = yOf(v);
    const clearOfTag = priceY === null || Math.abs(y - priceY) > TAG_H - 2;
    ticks.push({ y: r1(y), label: v.toFixed(decimals), showLabel: clearOfTag && y > 8 && y < plotBottom - 4 });
  }

  // Time labels: first / middle / last bar (HH:mm, or a date for multi-day spans).
  const spanSec = candles[n - 1].t - candles[0].t;
  const fmtT = (t: number) => {
    const d = new Date(t * 1000);
    return spanSec > 36 * 3600 ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  const mid = Math.floor(n / 2);
  const times: Geometry['times'] =
    n >= 3
      ? [
          { x: 0, label: fmtT(candles[0].t), anchor: 'start' },
          { x: r1((mid + 0.5) * slot), label: fmtT(candles[mid].t), anchor: 'middle' },
          { x: r1(plotW), label: fmtT(candles[n - 1].t), anchor: 'end' },
        ]
      : [{ x: 0, label: fmtT(candles[0].t), anchor: 'start' }];

  return {
    plotW,
    plotBottom,
    gutter,
    lineMode,
    upWicks,
    downWicks,
    upBodies,
    downBodies,
    line,
    bands,
    ticks,
    priceY,
    tagY,
    priceLabel,
    times,
  };
}

/** A zone draft awaiting approval: drawn as a cyan dashed band; `selected` = the one being reviewed. */
export interface DraftBand {
  high: number;
  low: number;
  selected?: boolean;
}

export const DRAFT_COLOR = '#00BCD4';

export interface ZoneChartProps {
  candles: Candle[];
  zones: LiveZone[];
  drafts?: DraftBand[];
  price: number | null;
  digits: number;
  height?: number;
}

/**
 * Price chart with supply/demand zones: candlesticks (a close line when bars
 * are too dense), each zone as a translucent full-width band (demand = profit,
 * supply = loss; "inside" = stronger fill + solid edges, "near" = dashed
 * edges), and a dashed current-price line with a price tag on the right.
 * Width fills the parent (measured), height defaults to 220.
 */
const NO_DRAFTS: DraftBand[] = [];

function ZoneChartImpl({ candles, zones, drafts = NO_DRAFTS, price, digits, height = CHART_HEIGHT }: ZoneChartProps) {
  const { theme } = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const [measured, setMeasured] = useState(0);
  // Until measured: window minus screen padding (2x16) and card padding (2x16).
  const width = measured > 0 ? measured : Math.max(0, windowWidth - 64);

  const onLayout = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w > 0 && w !== measured) setMeasured(w);
  };

  // Drafts share the live zones' y-scale (they're included in the range so every
  // proposal is visible), then get their own cyan dashed bands.
  const allZones = useMemo<LiveZone[]>(
    () =>
      drafts.length
        ? [...zones, ...drafts.map((d) => ({ high: d.high, low: d.low, role: 'demand' as const, state: 'far' as const } as LiveZone))]
        : zones,
    [zones, drafts]
  );
  const geo = useMemo(
    () => buildGeometry(candles, allZones, price, digits, width, height),
    [candles, allZones, price, digits, width, height]
  );

  if (!geo) {
    return (
      <View onLayout={onLayout} style={[styles.empty, { height, borderColor: theme.colors.border }]}>
        <IconSymbol name="chart.line.uptrend.xyaxis" size={26} color={theme.colors.textTertiary} />
        <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
          Waiting for price data from the EA…
        </Text>
      </View>
    );
  }

  const up = theme.colors.profit;
  const down = theme.colors.loss;

  return (
    <View onLayout={onLayout} style={{ height }}>
      <Svg width={width} height={height}>
        {/* Gridlines */}
        {geo.ticks.map((t, i) => (
          <Line
            key={`grid-${i}`}
            x1={0}
            x2={geo.plotW}
            y1={t.y}
            y2={t.y}
            stroke={theme.colors.border}
            strokeWidth={1}
            strokeOpacity={0.7}
          />
        ))}

        {/* Draft bands (awaiting approval): cyan, dashed; the one being reviewed is bolder */}
        {geo.bands.slice(zones.length).map((b, i) => {
          const sel = !!drafts[i]?.selected;
          return (
            <React.Fragment key={`draft-${i}`}>
              <Rect x={0} y={b.y} width={geo.plotW} height={b.h} fill={DRAFT_COLOR} fillOpacity={sel ? 0.28 : 0.1} />
              <Line x1={0} x2={geo.plotW} y1={b.y} y2={b.y} stroke={DRAFT_COLOR} strokeWidth={sel ? 2 : 1} strokeDasharray={DASH} />
              <Line x1={0} x2={geo.plotW} y1={b.y + b.h} y2={b.y + b.h} stroke={DRAFT_COLOR} strokeWidth={sel ? 2 : 1} strokeDasharray={DASH} />
            </React.Fragment>
          );
        })}

        {/* Zone bands */}
        {geo.bands.slice(0, zones.length).map((b, i) => {
          const color = b.role === 'supply' ? down : up;
          const inside = b.state === 'inside';
          const edged = inside || b.state === 'near';
          return (
            <React.Fragment key={`zone-${i}`}>
              <Rect x={0} y={b.y} width={geo.plotW} height={b.h} fill={color} fillOpacity={inside ? 0.34 : 0.18} />
              {edged && (
                <>
                  <Line
                    x1={0}
                    x2={geo.plotW}
                    y1={b.y}
                    y2={b.y}
                    stroke={color}
                    strokeWidth={inside ? 1.5 : 1}
                    strokeDasharray={inside ? undefined : DASH}
                  />
                  <Line
                    x1={0}
                    x2={geo.plotW}
                    y1={b.y + b.h}
                    y2={b.y + b.h}
                    stroke={color}
                    strokeWidth={inside ? 1.5 : 1}
                    strokeDasharray={inside ? undefined : DASH}
                  />
                </>
              )}
            </React.Fragment>
          );
        })}

        {/* Price action */}
        {geo.lineMode ? (
          <Path d={geo.line} stroke={theme.colors.text} strokeWidth={1.5} strokeLinejoin="round" fill="none" />
        ) : (
          <>
            {!!geo.upWicks && <Path d={geo.upWicks} stroke={up} strokeWidth={1} fill="none" />}
            {!!geo.downWicks && <Path d={geo.downWicks} stroke={down} strokeWidth={1} fill="none" />}
            {!!geo.upBodies && <Path d={geo.upBodies} fill={up} />}
            {!!geo.downBodies && <Path d={geo.downBodies} fill={down} />}
          </>
        )}

        {/* Time axis */}
        <Line
          x1={0}
          x2={geo.plotW}
          y1={geo.plotBottom}
          y2={geo.plotBottom}
          stroke={theme.colors.border}
          strokeWidth={1}
        />
        {geo.times.map((t, i) => (
          <SvgText
            key={`time-${i}`}
            x={t.x}
            y={geo.plotBottom + AXIS_H - 3}
            fill={theme.colors.textTertiary}
            fontSize={10}
            textAnchor={t.anchor}
          >
            {t.label}
          </SvgText>
        ))}

        {/* Price-axis labels */}
        {geo.ticks
          .filter((t) => t.showLabel)
          .map((t, i) => (
            <SvgText
              key={`tick-${i}`}
              x={geo.plotW + 6}
              y={t.y + 3.5}
              fill={theme.colors.textTertiary}
              fontSize={10}
            >
              {t.label}
            </SvgText>
          ))}

        {/* Current price: dashed line + tag */}
        {geo.priceY !== null && (
          <>
            <Line
              x1={0}
              x2={geo.plotW}
              y1={geo.priceY}
              y2={geo.priceY}
              stroke={theme.colors.primary}
              strokeWidth={1}
              strokeDasharray={[3, 3]}
            />
            <Rect
              x={geo.plotW + 3}
              y={geo.tagY}
              width={geo.gutter - 3}
              height={TAG_H}
              rx={4}
              fill={theme.colors.primary}
            />
            <SvgText
              x={geo.plotW + 3 + (geo.gutter - 3) / 2}
              y={geo.tagY + 11.5}
              fill="#FFFFFF"
              fontSize={10}
              fontWeight="bold"
              textAnchor="middle"
            >
              {geo.priceLabel}
            </SvgText>
          </>
        )}
      </Svg>
    </View>
  );
}

export const ZoneChart = memo(ZoneChartImpl);

const styles = StyleSheet.create({
  empty: {
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  emptyText: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
});
