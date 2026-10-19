import { useEffect, useState } from 'react';
import { limitToLast, onValue, query, ref, update } from 'firebase/database';

import { authReady, database } from '@/firebaseConfig';

/* -------------------------------------------------------------------------- *
 * AI auto trade, per account (2026-10-09). A Claude Code routine on the trading PC
 * reads a briefing of the account's zones every few minutes, decides, and hands its
 * decisions to that account's Bridge EA, which sizes them and enforces the guardrails.
 *
 *   autotrade/{account}/ai   { on, since, riskPct, dailyLossPct, mode }   (this screen)
 *   prefs/ai                 { intervalMin }   minutes between AI runs, every account
 *   aiStatus/{account}       { lastRunAt, runId, summary, nActions, rejected }   (the routine)
 *   aiLog/{account}/{id}     one row per AI action: { at, op, symbol, side, type, entry, sl,
 *                            tp, ticket, fraction, expiry, reason, status } + the Bridge's
 *                            { result: done|refused|failed, message, ticket, lots, doneAt }
 * The Bridge tags AI trades with magic AI_MAGIC (comment "FX Commander AI").
 * -------------------------------------------------------------------------- */

export const AI_MAGIC = 20261009;

export type AiMode = 'zones' | 'zones+between';

export interface AiSettings {
  on: boolean;
  since: number;
  riskPct: number;
  dailyLossPct: number;
  mode: AiMode;
}

export interface AiStatus {
  lastRunAt: number;
  runId: string;
  summary: string;
  nActions: number;
  rejected: number;
}

export type AiOp = 'open' | 'modify' | 'close' | 'cancel';

export interface AiLogEntry {
  id: string;
  at: number;
  op: AiOp;
  symbol: string;
  side: string;
  type: string;
  entry: number;
  sl: number;
  tp: number;
  ticket: number;
  fraction: number;
  reason: string;
  result: 'done' | 'refused' | 'failed' | '';
  message: string;
  lots: number;
}

export const AI_RISK_OPTIONS = [0.25, 0.5, 1, 2];
export const AI_LOSS_OPTIONS = [2, 5, 10, 20];
export const AI_INTERVAL_OPTIONS = [5, 10, 15, 30, 60];
export const DEFAULT_AI: AiSettings = { on: false, since: 0, riskPct: 1, dailyLossPct: 5, mode: 'zones' };
export const DEFAULT_AI_INTERVAL = 5;

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Listen to one Firebase path once signed in; `parse` turns its value into state. */
function useLive<T>(path: string | null, initial: T, parse: (val: any) => T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    setValue(initial);
    if (!path) return;
    let cancelled = false;
    let off = () => {};
    authReady.then(() => {
      if (cancelled) return;
      off = onValue(
        ref(database, path),
        (snap) => setValue(parse(snap.val())),
        (e) => console.error(`Failed to read ${path}:`, e),
      );
    });
    return () => {
      cancelled = true;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  return value;
}

export function useAiSettings(account: string | null): AiSettings {
  return useLive(account ? `autotrade/${account}/ai` : null, DEFAULT_AI, (v) => ({
    on: v?.on === true,
    since: num(v?.since, 0),
    riskPct: num(v?.riskPct, DEFAULT_AI.riskPct) > 0 ? num(v?.riskPct, DEFAULT_AI.riskPct) : DEFAULT_AI.riskPct,
    dailyLossPct: Math.max(0, num(v?.dailyLossPct, DEFAULT_AI.dailyLossPct)),
    mode: v?.mode === 'zones+between' ? 'zones+between' : 'zones',
  }));
}

export function useAiInterval(): number {
  return useLive('prefs/ai/intervalMin', DEFAULT_AI_INTERVAL, (v) =>
    typeof v === 'number' && v >= 5 ? v : DEFAULT_AI_INTERVAL,
  );
}

export function useAiStatus(account: string | null): AiStatus | null {
  return useLive<AiStatus | null>(account ? `aiStatus/${account}` : null, null, (v) =>
    v && typeof v === 'object'
      ? {
          lastRunAt: num(v.lastRunAt, 0),
          runId: str(v.runId),
          summary: str(v.summary),
          nActions: num(v.nActions, 0),
          rejected: num(v.rejected, 0),
        }
      : null,
  );
}

/** The newest AI actions on an account, newest first. */
export function useAiLog(account: string | null, limit = 20): AiLogEntry[] {
  const [entries, setEntries] = useState<AiLogEntry[]>([]);
  useEffect(() => {
    setEntries([]);
    if (!account) return;
    let cancelled = false;
    let off = () => {};
    authReady.then(() => {
      if (cancelled) return;
      off = onValue(
        query(ref(database, `aiLog/${account}`), limitToLast(limit)),
        (snap) => {
          const list: AiLogEntry[] = [];
          snap.forEach((child) => {
            const v = child.val();
            if (!v || typeof v !== 'object') return;
            const op = v.op === 'open' || v.op === 'modify' || v.op === 'close' || v.op === 'cancel' ? v.op : null;
            if (!op) return;
            const result = v.result === 'done' || v.result === 'refused' || v.result === 'failed' ? v.result : '';
            list.push({
              id: child.key ?? '',
              at: num(v.at, num(v.doneAt, 0)),
              op,
              symbol: str(v.symbol),
              side: str(v.side),
              type: str(v.type),
              entry: num(v.entry, 0),
              sl: num(v.sl, 0),
              tp: num(v.tp, 0),
              ticket: num(v.ticket, 0),
              fraction: num(v.fraction, 1),
              reason: str(v.reason),
              result,
              message: str(v.message),
              lots: num(v.lots, 0),
            });
          });
          setEntries(list.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id)));
        },
        (e) => console.error('Failed to read the AI log:', e),
      );
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [account, limit]);
  return entries;
}

export function saveAi(account: string, fields: Partial<AiSettings>) {
  return update(ref(database, `autotrade/${account}/ai`), fields);
}

export function saveAiInterval(minutes: number) {
  return update(ref(database, 'prefs/ai'), { intervalMin: minutes });
}
