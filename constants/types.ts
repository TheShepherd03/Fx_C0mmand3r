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
}

export interface AccountData {
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  marginLevel: number;
  lastUpdated: number;
  isOnline: boolean;
  positions?: Position[];
}

export interface HistoryPoint {
  timestamp: number;
  equity: number;
  balance: number;
}
