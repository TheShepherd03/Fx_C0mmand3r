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
  // Position management status
  breakevenEnabled?: boolean;
  breakevenTriggered?: boolean;
  trailingEnabled?: boolean;
  trailingPercentage?: number;
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
  orders?: Position[]; // Pending orders
}

export interface HistoryPoint {
  timestamp: number;
  equity: number;
  balance: number;
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
  sl: number;
  tp: number;
  lots: number;
  source: string; // Telegram channel name, EA name, etc.
  timestamp: number;
  status: 'pending' | 'executed' | 'rejected' | 'expired';
  confidence: number; // 0-100 confidence level
  description?: string;
  riskRewardRatio?: number;
  timeframe?: string;
}

export interface SignalFilters {
  symbols: string[];
  sources: string[];
  minConfidence: number;
  actions: ('BUY' | 'SELL')[];
  status: ('pending' | 'executed' | 'rejected' | 'expired')[];
}
