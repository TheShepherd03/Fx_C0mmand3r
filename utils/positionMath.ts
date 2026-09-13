import { Position } from '@/constants/types';

/**
 * Convert a price distance into account money for a position.
 * money = |priceDiff| / tickSize * tickValue * lots
 * Falls back to the old forex heuristic only when tick specs are missing.
 */
export function moneyForPriceDiff(
  position: Pick<Position, 'tickValue' | 'tickSize' | 'lots'>,
  priceDiff: number,
): number {
  if (position.tickValue && position.tickSize && position.tickSize > 0) {
    return (Math.abs(priceDiff) / position.tickSize) * position.tickValue * position.lots;
  }
  return Math.abs(priceDiff) * position.lots * 100000;
}

/**
 * Risk to stop-loss for a single position, measured from the ENTRY price
 * (so it matches the amount shown in the position detail sheet).
 * Returns a positive number; 0 when there is no protective stop.
 */
export function riskToSL(position: Position): number {
  if (!position.sl || position.sl <= 0) return 0;
  return moneyForPriceDiff(position, position.openPrice - position.sl);
}

/**
 * Aggregate risk across positions: the sum of each position's entry→SL risk,
 * plus a count of positions that have no stop loss set.
 */
export function totalRisk(positions: Position[]): { risk: number; unprotected: number } {
  let risk = 0;
  let unprotected = 0;
  for (const p of positions) {
    if (!p.sl || p.sl <= 0) {
      unprotected++;
      continue;
    }
    risk += riskToSL(p);
  }
  return { risk, unprotected };
}

/** Sum of live P/L across positions. */
export function totalPnL(positions: Position[]): number {
  return positions.reduce((sum, p) => sum + (p.profit || 0), 0);
}
