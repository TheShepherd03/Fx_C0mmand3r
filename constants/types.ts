export interface Position {
  ticket: number;
  symbol: string;
  type: number; // 0=Buy, 1=Sell
  lots: number;
  openPrice: number;
  currentPrice: number;
  profit: number;
  sl: number;
  tp: number;
  magic: number;
  openTime: number; // Unix timestamp of when position was opened
  // Contract specs from the EA for accurate money math (money = priceDiff / tickSize * tickValue * lots)
  tickValue?: number;
  tickSize?: number;
  // Position management status (synced from the EA so the app can persist + display it)
  breakevenEnabled?: boolean;
  breakevenTriggered?: boolean;
  breakevenUsePercent?: boolean;
  breakevenPercent?: number;
  breakevenThreshold?: number;
  breakevenR?: number; // > 0: an auto trade's break-even at +N R (entry -> stop)
  trailingEnabled?: boolean;
  trailingPercentage?: number;
  timeLimit?: number; // seconds after openTime; 0/undefined = no auto-close timer
}

export interface AccountData {
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  marginLevel: number;
  currency?: string; // deposit currency code (e.g. "ZAR", "USD") from the Bridge EA
  lastUpdated: number;
  isOnline: boolean;
  isPaused?: boolean;
  positions?: Position[];
  orders?: Position[]; // Pending orders
}

export interface HistoryPoint {
  timestamp: number;
  equity: number;
  balance: number;
}

export interface ClosedTrade {
  ticket: number;      // position id
  symbol: string;
  type: number;        // 0 = Buy, 1 = Sell
  lots: number;
  entryPrice: number;
  exitPrice: number;
  profit: number;      // realized profit incl. swap + commission
  openTime: number;    // unix seconds
  closeTime: number;   // unix seconds
}

export interface PositionManagementSettings {
  ticket: number;
  breakevenEnabled: boolean;
  breakevenThreshold: number;
  trailingEnabled: boolean;
  trailingPercentage: number;
  timeLimit?: number;
  weekendClose: boolean;
  scaleInMultiplier?: number;
  scaleInThreshold?: number;
}

export interface EAScheduleSettings {
  enabled: boolean;
  pauseStartTime: string;
  pauseEndTime: string;
  pauseMode: number; // 0=NoNewTrades, 1=CloseAll, 2=MaintainOnly
}

export interface Signal {
  id: string;
  symbol: string;
  action: 'BUY' | 'SELL';
  price: number;
  currentPrice?: number;  // live price from the EA, for the entry->SL/TP progress bar
  sl: number;
  tp: number;
  lots: number;
  source: string; // Telegram channel name, EA name, etc.
  timestamp: number;
  status: 'pending' | 'executed' | 'rejected' | 'expired' | 'winning' | 'range';
  confidence: number; // 0-100 confidence level
  expiresAt?: number;    // unix seconds; discrete signals hide themselves after this
  tickValue?: number;    // money per tickSize move per 1.0 lot (for risk-based sizing)
  tickSize?: number;
  description?: string;
  riskRewardRatio?: number;
  timeframe?: string;
  // Zones EA extras (other sources leave them out)
  grade?: string;  // 'A' | 'B' | 'C'
  setup?: string;  // choch / bos (M3) / engulf / sweep (M5); reject on older signals
  trend?: string;  // 'with' | 'against' | 'flat' — vs the H1 trend, for information
  touch?: number;  // 1 = first visit to the zone since the EA started counting
  // Where price sits against the user's M3 EMA ribbon (every signal EA, from 2026-10-08):
  ema?: EmaState;     // the entry, when the signal fired (also kept in signalLog)
  emaNow?: EmaState;  // live while the signal is open (refreshed when it changes, checked every 30 s)
}

/** above / inside / below a band: EMA 5 and EMA 100 are bands (EMA of the lows .. of the highs);
 *  inside = between those two lines. EMA 200 (of closes) is a single line: above / below. */
export type EmaPos = 'above' | 'inside' | 'below';
export interface EmaState {
  tf?: string; // 'M3'
  e5?: EmaPos;
  e100?: EmaPos;
  e200?: EmaPos;
}
export const EMA_KEYS = ['e5', 'e100', 'e200'] as const;
export const EMA_LABEL: Record<(typeof EMA_KEYS)[number], string> = { e5: 'EMA 5', e100: 'EMA 100', e200: 'EMA 200' };

export const GRADES = ['A', 'B', 'C'] as const;
export type Grade = (typeof GRADES)[number];

/** "1st touch" / "2nd touch" / "3rd+ touch" (the EA's own labels). */
export const touchLabel = (t: number) => (t <= 1 ? '1st touch' : t === 2 ? '2nd touch' : '3rd+ touch');

/** "with H1 trend" / "against H1 trend" / "H1 flat". */
export const trendLabel = (t: string) =>
  t === 'with' ? 'with H1 trend' : t === 'against' ? 'against H1 trend' : 'H1 flat';

export interface SignalFilters {
  symbols: string[];
  sources: string[];
  minConfidence: number;
  actions: ('BUY' | 'SELL')[];
  status: ('pending' | 'executed' | 'rejected' | 'expired')[];
}
