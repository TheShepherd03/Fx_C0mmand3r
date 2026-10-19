import { useEffect, useState } from 'react';
import { limitToLast, onValue, query, ref, set, update } from 'firebase/database';

import { authReady, database } from '@/firebaseConfig';

/* -------------------------------------------------------------------------- *
 * Auto trade, per account. The APP writes the settings; the Bridge EA on that
 * account's terminal opens new signals from the switched-on sources by itself.
 *
 *   autotrade/{account}
 *     sources: { "<sourceKey>": { on, since, symbols? } }
 *              since = UTC seconds when switched on; only setups that appear after it trade.
 *              symbols = { "<symbolKey>": true } - the source trades only these symbols;
 *              missing = every symbol
 *     riskPct: % of the balance risked per trade (lots sized from the signal's stop)
 *     capPct:  when riskPct buys less than the broker's minimum lot, the minimum lot is
 *              still taken while it risks no more than this % of the balance; else skipped
 *     maxOpenRiskPct: nothing new opens while the open trades already risk more than this %
 *              of the balance - the dashboard's TOTAL RISK (each trade's entry -> stop loss;
 *              trades without a stop loss don't count)
 *     beR:     auto trades' own break-even - stop to entry once price is this many R in profit
 *              (R = entry -> stop); missing / 0 = none. Auto trades never take the Trade
 *              Control break-even (a % of price).
 *
 *   autotradeLog/{account}/{utc}_{signalKey}       one row per attempt (the Bridge writes)
 *     { at, result: opened|skipped|failed, source, symbol, action, signalKey, sl, tp,
 *       lots, risk, riskPct, currency, ticket, reason }
 *
 * Source keys use the same rule as prefs/signals ("Supply/Demand" -> "Supply_Demand").
 * -------------------------------------------------------------------------- */

export interface AutoTradeSource {
  on: boolean;
  since: number;
  /** Symbol keys this source may trade; null = every symbol. */
  symbols: string[] | null;
}

export interface AutoTradeSettings {
  sources: Record<string, AutoTradeSource>;
  riskPct: number;
  capPct: number;
  maxOpenRiskPct: number;
  beR: number;
}

export type AutoTradeResult = 'opened' | 'skipped' | 'failed';

export interface AutoTradeLogEntry {
  id: string;
  at: number;
  result: AutoTradeResult;
  source: string;
  symbol: string;
  action: string;
  signalKey: string;
  sl: number;
  tp: number;
  lots: number;
  risk: number;
  riskPct: number;
  currency: string;
  ticket: number;
  reason: string;
  why: string; // the AI's own reason (source "AI")
}

export const RISK_OPTIONS = [0.5, 1, 2, 3, 5];
export const CAP_OPTIONS = [2, 5, 10, 20];
export const OPEN_RISK_OPTIONS = [10, 25, 50, 75];
export const DEFAULT_RISK_PCT = 1;
export const DEFAULT_CAP_PCT = 5;
export const DEFAULT_OPEN_RISK_PCT = 50; // same default as the Bridge (AT_DEFAULT_OPEN_RISK)
export const BE_R_OPTIONS = [0, 0.5, 1, 2]; // 0 = off

export const EMPTY_AUTO_TRADE: AutoTradeSettings = {
  sources: {},
  riskPct: DEFAULT_RISK_PCT,
  capPct: DEFAULT_CAP_PCT,
  maxOpenRiskPct: DEFAULT_OPEN_RISK_PCT,
  beR: 0,
};

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function normalizeSettings(val: any): AutoTradeSettings {
  const sources: Record<string, AutoTradeSource> = {};
  if (val?.sources && typeof val.sources === 'object') {
    Object.keys(val.sources).forEach((k) => {
      const s = val.sources[k];
      if (!s || typeof s !== 'object') return;
      const list =
        s.symbols && typeof s.symbols === 'object'
          ? Object.keys(s.symbols).filter((sym) => s.symbols[sym] === true)
          : [];
      sources[k] = { on: s.on === true, since: num(s.since, 0), symbols: list.length ? list : null };
    });
  }
  const riskPct = num(val?.riskPct, DEFAULT_RISK_PCT);
  const maxOpenRiskPct = num(val?.maxOpenRiskPct, DEFAULT_OPEN_RISK_PCT);
  return {
    sources,
    riskPct: riskPct > 0 ? riskPct : DEFAULT_RISK_PCT,
    capPct: Math.max(0, num(val?.capPct, DEFAULT_CAP_PCT)),
    maxOpenRiskPct: maxOpenRiskPct > 0 ? maxOpenRiskPct : DEFAULT_OPEN_RISK_PCT,
    beR: Math.max(0, num(val?.beR, 0)),
  };
}

function normalizeEntry(id: string, v: any): AutoTradeLogEntry | null {
  if (!v || typeof v !== 'object') return null;
  const result = v.result === 'opened' || v.result === 'skipped' || v.result === 'failed' ? v.result : null;
  if (!result) return null;
  return {
    id,
    at: num(v.at, 0),
    result,
    source: typeof v.source === 'string' ? v.source : '',
    symbol: typeof v.symbol === 'string' ? v.symbol : '',
    action: typeof v.action === 'string' ? v.action : '',
    signalKey: typeof v.signalKey === 'string' ? v.signalKey : '',
    sl: num(v.sl, 0),
    tp: num(v.tp, 0),
    lots: num(v.lots, 0),
    risk: num(v.risk, 0),
    riskPct: num(v.riskPct, 0),
    currency: typeof v.currency === 'string' ? v.currency : '',
    ticket: num(v.ticket, 0),
    reason: typeof v.reason === 'string' ? v.reason : '',
    why: typeof v.why === 'string' ? v.why : '',
  };
}

/** Live `autotrade/{account}`. */
export function useAutoTradeSettings(account: string | null) {
  const [settings, setSettings] = useState<AutoTradeSettings>(EMPTY_AUTO_TRADE);

  useEffect(() => {
    setSettings(EMPTY_AUTO_TRADE);
    if (!account) return;
    let cancelled = false;
    let unsubscribe = () => {};
    authReady.then(() => {
      if (cancelled) return;
      unsubscribe = onValue(
        ref(database, `autotrade/${account}`),
        (snapshot) => setSettings(normalizeSettings(snapshot.val())),
        (error) => console.error('Failed to read auto trade settings:', error),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [account]);

  return settings;
}

/** The Bridge's latest auto-trade attempts for an account, newest first. */
export function useAutoTradeLog(account: string | null, limit = 30) {
  const [entries, setEntries] = useState<AutoTradeLogEntry[]>([]);

  useEffect(() => {
    setEntries([]);
    if (!account) return;
    let cancelled = false;
    let unsubscribe = () => {};
    authReady.then(() => {
      if (cancelled) return;
      unsubscribe = onValue(
        query(ref(database, `autotradeLog/${account}`), limitToLast(limit)),
        (snapshot) => {
          const list: AutoTradeLogEntry[] = [];
          snapshot.forEach((child) => {
            const e = normalizeEntry(child.key ?? '', child.val());
            if (e) list.push(e);
          });
          setEntries(list.sort((a, b) => b.at - a.at));
        },
        (error) => console.error('Failed to read the auto trade log:', error),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [account, limit]);

  return entries;
}

/** Switch auto trade for one source on/off. On = from now: earlier setups never trade. */
export function saveAutoTradeSource(account: string, sourceKey: string, on: boolean) {
  const values: Record<string, unknown> = { on };
  if (on) values.since = Math.floor(Date.now() / 1000);
  return update(ref(database, `autotrade/${account}/sources/${sourceKey}`), values);
}

export type AutoTradeLevel = 'riskPct' | 'capPct' | 'maxOpenRiskPct' | 'beR';

export function saveAutoTradeLevel(account: string, field: AutoTradeLevel, value: number) {
  return update(ref(database, `autotrade/${account}`), { [field]: value });
}

/** The symbols a source may auto trade (keys as the EAs write them); null / [] = every symbol. */
export function saveAutoTradeSymbols(account: string, sourceKey: string, symbolKeys: string[] | null) {
  const value = symbolKeys && symbolKeys.length ? Object.fromEntries(symbolKeys.map((k) => [k, true])) : null;
  return set(ref(database, `autotrade/${account}/sources/${sourceKey}/symbols`), value);
}
