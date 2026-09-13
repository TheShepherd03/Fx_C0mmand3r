//+------------------------------------------------------------------+
//|                              RangeBreakout_MultiSession_EA.mq5   |
//|      MQL5 port of RangeBreakout_MultiSession_Indicator.pine      |
//|                                              Author: Sakhi       |
//+------------------------------------------------------------------+
#property copyright "Sakhi"
#property version   "2.00"
#property description "SIGNAL-ONLY multi-session range breakout. Builds a range in one time window and PUBLISHES a signal (with SL/TP) on a confirmed break in a second window, to the FX Commander app. It never trades - the app/Bridge executes. Ported from RangeBreakout_MultiSession_EA."

#include <Trade/Trade.mqh>
#include <Trade/PositionInfo.mqh>
#include "SignalLib.mqh"

CTrade        Trade;
CPositionInfo Pos;

#define SESSIONS 3

//+------------------------------------------------------------------+
//|                            Inputs                                 |
//+------------------------------------------------------------------+
input group "=== Firebase (FX Commander) ==="
input string Inp_ProjectID = "c0mmand3r";
input string Inp_ApiKey    = "AIzaSyCA3LUdogLeo7wdHEfxfPQtG4EG2SqEFtg";
input string Inp_Email     = "";       // Firebase account email (blank = use shared file)
input string Inp_Password  = "";       // Firebase account password (blank = use shared file)

input group "=== Signal publishing ==="
input double Inp_Lots      = 0.05;     // Suggested lot on the signal (app re-sizes on execute)
input int    Inp_ExpiryMin = 120;      // Signal expiry (minutes)

input group "=== Clock ==="
input ENUM_TIMEFRAMES InpWorkTF           = PERIOD_M5;  // Working timeframe (range + entry bars)
input double          InpSessionUTCOffset = 2.0;        // Your windows are written in UTC+this (2 = SAST)
input double          InpServerUTCOffset  = 99.0;       // Broker UTC offset - leave 99 to detect automatically

input group "=== Session 1 ==="
input bool   InpS1_On     = true;          // Enable this session
input string InpS1_Name   = "Tokyo";       // Label (journal + order comment)
input string InpS1_Range  = "0100-0130";   // Range window HHMM-HHMM
input string InpS1_Entry  = "0245-0300";   // Entry window HHMM-HHMM
input int    InpS1_MngH   = 4;             // Manage hour
input int    InpS1_MngM   = 45;            // Manage minute

input group "=== Session 2 ==="
input bool   InpS2_On     = true;          // Enable this session
input string InpS2_Name   = "London";      // Label (journal + order comment)
input string InpS2_Range  = "0800-0830";   // Range window HHMM-HHMM
input string InpS2_Entry  = "0945-1000";   // Entry window HHMM-HHMM
input int    InpS2_MngH   = 11;            // Manage hour
input int    InpS2_MngM   = 45;            // Manage minute

input group "=== Session 3 ==="
input bool   InpS3_On     = true;          // Enable this session
input string InpS3_Name   = "New York";    // Label (journal + order comment)
input string InpS3_Range  = "1300-1330";   // Range window HHMM-HHMM
input string InpS3_Entry  = "1445-1500";   // Entry window HHMM-HHMM
input int    InpS3_MngH   = 16;            // Manage hour
input int    InpS3_MngM   = 45;            // Manage minute

input group "=== Confirmation ==="
input bool   InpConfirmMatchesWork   = true;           // Confirmation bars = the working timeframe
input ENUM_TIMEFRAMES InpConfirmTF   = PERIOD_M5;      // Confirmation TF - used ONLY when the box above is false
input bool   InpCloseOnly            = false;          // true = bar must CLOSE beyond the edge
input bool   InpRequireBreakInWindow  = false;         // true = price must be INSIDE the range during the entry
                                                       // window before a break counts. false = any bar trading
                                                       // outside fires, even if price was already gone.
input bool   InpAllowLong            = true;           // Allow longs
input bool   InpAllowShort           = true;           // Allow shorts
input int    InpMaxTradesPerSession  = 1;              // Max trades per session per day

input group "=== Risk ==="
input double InpRiskPercent   = 25.0;   // Risk % of balance per trade
input double InpMinRR         = 2.0;    // Min risk:reward (TP multiple of stop distance)
input int    InpSLMode        = 0;      // Stop: 0=Opposite Range Edge, 1=Near Range Edge, 2=Confirmation Wick
input int    InpSLBufferPts   = 0;      // Stop buffer (points)
input int    InpMinStopPts    = 5;      // Min stop distance (points) - below this the setup is skipped
input double InpMaxLots       = 0.0;    // Hard lot cap (0 = broker max)

input group "=== Management ==="
input int    InpManageAction     = 0;    // At manage time: 0=Close, 1=Break-Even, 2=BE if winning else Close
input int    InpBEOffsetPts      = 0;    // Break-even offset (points)
input bool   InpFlatBeforeRange  = true; // Close any survivor before a new range window opens

input group "=== Execution ==="
input int    InpMaxSpreadPoints = 0;       // Max spread to allow entry (0 = off)
input int    InpSlippagePoints  = 20;      // Max slippage (points)
input long   InpMagicNumber     = 770100;  // Base magic (session index is added: 770100/770101/770102)

input group "=== Journal ==="
input int    InpLogLevel      = 2;     // 0=errors, 1=trades, 2=full analysis
input bool   InpLogEveryBar   = false; // Level 2: also log bars where nothing happened

//+------------------------------------------------------------------+
//|                            Types                                  |
//+------------------------------------------------------------------+
struct SessionCfg
{
   bool   on;
   string name;
   int    r_start, r_end;      // minutes-of-day
   int    e_start, e_end;      // minutes-of-day
   int    mng;                 // minutes-of-day
   long   magic;
   bool   valid;
};

struct SessionState
{
   double   rangeHi, rangeLo;
   bool     ready;
   int      trades;
   bool     managed;
   int      dayKey;            // yyyymmdd of the session clock
   bool     inRangePrev;
   bool     insideSeen;        // price seen inside the range during this entry window
   bool     beDone;
   ulong    ticket;
   double   enPx, slPx, tpPx;
   int      dir;               // 0 flat, 1 long, -1 short
};

SessionCfg   g_cfg[SESSIONS];
SessionState g_st[SESSIONS];

datetime g_lastBar   = 0;
double   g_point     = 0.0;
double   g_tickSize  = 0.0;
double   g_tickValue = 0.0;
int      g_digits    = 0;
ENUM_TIMEFRAMES g_confTF = PERIOD_M5;

double g_serverUTC = 0.0;    // broker's offset from UTC, in hours
double g_shiftHrs  = 0.0;    // hours to add to server time to reach the session clock
bool   g_clockKnown = false;

//+------------------------------------------------------------------+
//|                           Logging                                 |
//+------------------------------------------------------------------+
// During optimization every Print costs time and disk across thousands of
// passes, so the whole journal goes quiet regardless of InpLogLevel. A single
// backtest still logs normally - that is where you read the analysis.
bool g_optimizing = false;

void Log(string msg)
{
   if(g_optimizing) return;
   Print("[RBMS] ", msg);
}

void LogTrade(string msg)
{
   if(g_optimizing) return;
   if(InpLogLevel >= 1) Print("[RBMS] ", msg);
}

void LogAnalysis(string msg)
{
   if(g_optimizing) return;
   if(InpLogLevel >= 2) Print("[RBMS] ", msg);
}

string Px(double v)
{
   return DoubleToString(v, g_digits);
}

//+------------------------------------------------------------------+
//|                      Time / window helpers                        |
//+------------------------------------------------------------------+
// Broker's own offset from UTC, read off the terminal. Brokers sit on whole or
// half hours, so the raw difference is snapped to the nearest 30 minutes to
// absorb the second-or-two skew between the two clock reads.
double DetectServerUTCOffset()
{
   datetime srv = TimeCurrent();
   datetime gmt = TimeGMT();
   if(srv <= 0 || gmt <= 0) return 0.0;
   double hours = (double)((long)srv - (long)gmt) / 3600.0;
   return MathRound(hours * 2.0) / 2.0;
}

// Recomputed every new bar. When the broker rolls EET->EEST the detected offset
// changes and the shift follows it, so windows written in a fixed UTC offset
// stay pinned to the right wall-clock time all year.
void RefreshClockShift(bool announce)
{
   double srvUTC = (InpServerUTCOffset < 90.0) ? InpServerUTCOffset : DetectServerUTCOffset();
   double shift  = InpSessionUTCOffset - srvUTC;

   bool changed = (!g_clockKnown || shift != g_shiftHrs);

   g_serverUTC  = srvUTC;
   g_shiftHrs   = shift;

   if(changed && g_clockKnown)
      Log(StringFormat("CLOCK SHIFT - broker moved to UTC%+.1f. Session shift is now %+.1f h. "
                       "Windows stay pinned to UTC%+.1f.",
                       srvUTC, shift, InpSessionUTCOffset));

   g_clockKnown = true;

   if(announce)
   {
      Log(StringFormat("Broker clock: UTC%+.1f (%s) | windows written in UTC%+.1f | shift %+.1f h",
                       srvUTC,
                       (InpServerUTCOffset < 90.0) ? "from input" : "auto-detected",
                       InpSessionUTCOffset, shift));
   }
}

// Server time shifted into the clock the session windows are written in.
datetime ToSessionClock(datetime server_time)
{
   return server_time + (int)MathRound(g_shiftHrs * 3600.0);
}

int MinutesOfDay(datetime t)
{
   MqlDateTime d;
   TimeToStruct(t, d);
   return d.hour * 60 + d.min;
}

int DayKeyOf(datetime t)
{
   MqlDateTime d;
   TimeToStruct(t, d);
   return d.year * 10000 + d.mon * 100 + d.day;
}

// Inclusive of start, exclusive of end - matches Pine's session semantics.
// Handles a window that wraps past midnight.
bool InWindow(int mod, int start_mod, int end_mod)
{
   if(start_mod == end_mod) return false;
   if(start_mod < end_mod)  return (mod >= start_mod && mod < end_mod);
   return (mod >= start_mod || mod < end_mod);
}

// "0100-0130" -> start/end minutes-of-day. Returns false on a malformed string.
bool ParseWindow(string spec, int &start_mod, int &end_mod)
{
   string s = spec;
   StringTrimLeft(s);
   StringTrimRight(s);
   StringReplace(s, " ", "");

   int dash = StringFind(s, "-");
   if(dash < 0) return false;

   string a = StringSubstr(s, 0, dash);
   string b = StringSubstr(s, dash + 1);
   if(StringLen(a) != 4 || StringLen(b) != 4) return false;

   int ah = (int)StringToInteger(StringSubstr(a, 0, 2));
   int am = (int)StringToInteger(StringSubstr(a, 2, 2));
   int bh = (int)StringToInteger(StringSubstr(b, 0, 2));
   int bm = (int)StringToInteger(StringSubstr(b, 2, 2));

   if(ah < 0 || ah > 23 || bh < 0 || bh > 24) return false;
   if(am < 0 || am > 59 || bm < 0 || bm > 59) return false;

   start_mod = ah * 60 + am;
   end_mod   = bh * 60 + bm;
   return true;
}

string ModToText(int mod)
{
   return StringFormat("%02d:%02d", mod / 60, mod % 60);
}

//+------------------------------------------------------------------+
//|                       Position helpers                            |
//+------------------------------------------------------------------+
bool FindSessionPosition(int idx, ulong &ticket_out)
{
   // Signal-only build: this EA never opens positions, so it must never find /
   // manage / close any. Short-circuit so all trade-management paths are inert.
   return false;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong tk = PositionGetTicket(i);
      if(tk == 0) continue;
      if(!PositionSelectByTicket(tk)) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
      if(PositionGetInteger(POSITION_MAGIC) != g_cfg[idx].magic) continue;
      ticket_out = tk;
      return true;
   }
   ticket_out = 0;
   return false;
}

// Realised P/L of a closed position, for the journal.
double ClosedPositionProfit(ulong position_id)
{
   if(!HistorySelectByPosition(position_id)) return 0.0;
   double total = 0.0;
   int deals = HistoryDealsTotal();
   for(int i = 0; i < deals; i++)
   {
      ulong dt = HistoryDealGetTicket(i);
      if(dt == 0) continue;
      total += HistoryDealGetDouble(dt, DEAL_PROFIT)
             + HistoryDealGetDouble(dt, DEAL_SWAP)
             + HistoryDealGetDouble(dt, DEAL_COMMISSION);
   }
   return total;
}

//+------------------------------------------------------------------+
//|                         Lot sizing                                |
//+------------------------------------------------------------------+
// Mirrors SessionSweep_EA: ask MT5 for the true loss on 1 lot, so the size
// stays correct on crosses and over long backtests. Falls back to the
// tick approximation only if the calculator refuses.
double CalcLotsByRisk(double entry, double stop)
{
   double riskAmt = AccountInfoDouble(ACCOUNT_BALANCE) * InpRiskPercent / 100.0;
   if(riskAmt <= 0.0) return 0.0;

   double loss_per_lot = 0.0;
   bool   got = false;

   if(entry > stop)
      got = OrderCalcProfit(ORDER_TYPE_BUY, _Symbol, 1.0, entry, stop, loss_per_lot);
   else
      got = OrderCalcProfit(ORDER_TYPE_SELL, _Symbol, 1.0, entry, stop, loss_per_lot);

   if(!got || loss_per_lot == 0.0)
   {
      double dist = MathAbs(entry - stop);
      if(dist <= 0.0 || g_tickSize <= 0.0) return 0.0;
      loss_per_lot = (dist / g_tickSize) * g_tickValue;
      if(loss_per_lot <= 0.0) return 0.0;
   }
   else
   {
      loss_per_lot = MathAbs(loss_per_lot);
   }

   double lots = riskAmt / loss_per_lot;

   double minLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double lotStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);

   if(InpMaxLots > 0.0 && maxLot > InpMaxLots) maxLot = InpMaxLots;
   if(lotStep > 0.0) lots = MathFloor(lots / lotStep) * lotStep;
   if(lots < minLot) lots = 0.0;          // below broker minimum: skip, do not silently upsize
   if(lots > maxLot) lots = maxLot;

   return NormalizeDouble(lots, 2);
}

//+------------------------------------------------------------------+
//|                     Config resolution                             |
//+------------------------------------------------------------------+
bool BuildCfg(int idx, bool on, string name, string rangeSpec, string entrySpec, int mh, int mm)
{
   g_cfg[idx].on    = on;
   g_cfg[idx].name  = name;
   g_cfg[idx].magic = InpMagicNumber + idx;
   g_cfg[idx].valid = false;

   if(!ParseWindow(rangeSpec, g_cfg[idx].r_start, g_cfg[idx].r_end))
   {
      Log(StringFormat("CONFIG ERROR - session %d (%s): range window '%s' is not HHMM-HHMM. Session disabled.",
                       idx + 1, name, rangeSpec));
      g_cfg[idx].on = false;
      return false;
   }
   if(!ParseWindow(entrySpec, g_cfg[idx].e_start, g_cfg[idx].e_end))
   {
      Log(StringFormat("CONFIG ERROR - session %d (%s): entry window '%s' is not HHMM-HHMM. Session disabled.",
                       idx + 1, name, entrySpec));
      g_cfg[idx].on = false;
      return false;
   }
   if(mh < 0 || mh > 23 || mm < 0 || mm > 59)
   {
      Log(StringFormat("CONFIG ERROR - session %d (%s): manage time %d:%d out of range. Session disabled.",
                       idx + 1, name, mh, mm));
      g_cfg[idx].on = false;
      return false;
   }

   g_cfg[idx].mng   = mh * 60 + mm;
   g_cfg[idx].valid = true;
   return true;
}

void ResetState(int idx)
{
   g_st[idx].rangeHi     = 0.0;
   g_st[idx].rangeLo     = 0.0;
   g_st[idx].ready       = false;
   g_st[idx].trades      = 0;
   g_st[idx].managed     = false;
   g_st[idx].dayKey      = 0;
   g_st[idx].inRangePrev = false;
   g_st[idx].insideSeen  = false;
   g_st[idx].beDone      = false;
   g_st[idx].ticket      = 0;
   g_st[idx].enPx        = 0.0;
   g_st[idx].slPx        = 0.0;
   g_st[idx].tpPx        = 0.0;
   g_st[idx].dir         = 0;
}

//+------------------------------------------------------------------+
//|                            OnInit                                 |
//+------------------------------------------------------------------+
int OnInit()
{
   g_optimizing = (bool)MQLInfoInteger(MQL_OPTIMIZATION);

   g_point     = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   g_tickSize  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   g_tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   g_digits    = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   // No PERIOD_CURRENT sentinel: in MQL5 that normally means the CHART
   // timeframe, which is not what it meant here. An explicit flag says so.
   g_confTF    = InpConfirmMatchesWork ? InpWorkTF : InpConfirmTF;

   RefreshClockShift(false);

   Trade.SetExpertMagicNumber(InpMagicNumber);
   Trade.SetDeviationInPoints(InpSlippagePoints);
   Trade.SetTypeFillingBySymbol(_Symbol);

   SignalLib_Init(Inp_ProjectID, Inp_ApiKey, Inp_Email, Inp_Password);

   BuildCfg(0, InpS1_On, InpS1_Name, InpS1_Range, InpS1_Entry, InpS1_MngH, InpS1_MngM);
   BuildCfg(1, InpS2_On, InpS2_Name, InpS2_Range, InpS2_Entry, InpS2_MngH, InpS2_MngM);
   BuildCfg(2, InpS3_On, InpS3_Name, InpS3_Range, InpS3_Entry, InpS3_MngH, InpS3_MngM);

   for(int i = 0; i < SESSIONS; i++) ResetState(i);

   string slTxt = (InpSLMode == 0) ? "Opposite Range Edge"
                : (InpSLMode == 1) ? "Near Range Edge"
                :                    "Confirmation Wick";
   string mngTxt = (InpManageAction == 0) ? "Close"
                 : (InpManageAction == 1) ? "Break-Even"
                 :                          "BE if winning, else Close";

   Log("=================================================================");
   Log("RangeBreakout MultiSession EA v1.00  -  " + _Symbol);
   Log("=================================================================");
   Log(StringFormat("Work TF: %s   Confirm TF: %s   Confirmation: %s",
                    EnumToString(InpWorkTF), EnumToString(g_confTF),
                    InpCloseOnly ? "Close Only" : "Wick or Close"));
   Log(StringFormat("Broker clock UTC%+.1f (%s)  |  windows written in UTC%+.1f  |  shift %+.1f h",
                    g_serverUTC,
                    (InpServerUTCOffset < 90.0) ? "set by input" : "auto-detected",
                    InpSessionUTCOffset, g_shiftHrs));
   Log(StringFormat("Server time %s  ->  session clock %s",
                    TimeToString(TimeCurrent(), TIME_DATE | TIME_MINUTES),
                    TimeToString(ToSessionClock(TimeCurrent()), TIME_DATE | TIME_MINUTES)));

   if(MQLInfoInteger(MQL_TESTER) && InpServerUTCOffset >= 90.0)
      Log("NOTE: in the Strategy Tester TimeGMT() is modelled from the PC clock, not the broker's. "
          "If the shift above looks wrong for a backtest, set InpServerUTCOffset to the broker's "
          "real offset (HFM is 2 in winter, 3 in summer) instead of leaving it on auto.");
   Log(StringFormat("Risk %.2f%% of balance | RR 1:%.2f | Stop: %s (buffer %d pts, floor %d pts)",
                    InpRiskPercent, InpMinRR, slTxt, InpSLBufferPts, InpMinStopPts));
   Log(StringFormat("Manage action: %s (BE offset %d pts) | Max %d trade(s) per session per day",
                    mngTxt, InpBEOffsetPts, InpMaxTradesPerSession));
   Log(StringFormat("Symbol: digits=%d point=%s tick=%s tickval=%.5f minlot=%.2f step=%.2f",
                    g_digits, Px(g_point), Px(g_tickSize), g_tickValue,
                    SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN),
                    SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP)));
   Log("-----------------------------------------------------------------");

   int active = 0;
   for(int i = 0; i < SESSIONS; i++)
   {
      if(!g_cfg[i].valid) continue;
      if(g_cfg[i].on)
      {
         active++;
         Log(StringFormat("Session %d  %-10s ON   range %s-%s   entry %s-%s   manage %s   magic %d",
                          i + 1, g_cfg[i].name,
                          ModToText(g_cfg[i].r_start), ModToText(g_cfg[i].r_end),
                          ModToText(g_cfg[i].e_start), ModToText(g_cfg[i].e_end),
                          ModToText(g_cfg[i].mng), (int)g_cfg[i].magic));
      }
      else
      {
         Log(StringFormat("Session %d  %-10s OFF", i + 1, g_cfg[i].name));
      }
   }
   Log("-----------------------------------------------------------------");

   if(active == 0)
      Log("WARNING: every session is disabled - this EA will not trade.");

   if(InpRiskPercent >= 10.0)
      Log(StringFormat("WARNING: risk is %.1f%% per trade. Four consecutive losses is roughly a %.0f%% drawdown.",
                       InpRiskPercent, (1.0 - MathPow(1.0 - InpRiskPercent / 100.0, 4)) * 100.0));

   if(!AccountInfoInteger(ACCOUNT_TRADE_EXPERT))
      Log("WARNING: algo trading is disabled for this account/terminal.");

   Log("=================================================================");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   Log(StringFormat("Stopped (reason %d).", reason));
}

//+------------------------------------------------------------------+
//|                         Entry evaluation                          |
//+------------------------------------------------------------------+
// Returns true if a trade was opened. Writes the reasoning either way.
bool TryEntry(int idx, datetime barClock, double cH, double cL, double cC)
{
   SessionCfg cfg = g_cfg[idx];

   if(g_st[idx].trades >= InpMaxTradesPerSession)
   {
      LogAnalysis(StringFormat("%s | entry window | SKIP - daily cap reached (%d/%d)",
                               cfg.name, g_st[idx].trades, InpMaxTradesPerSession));
      return false;
   }

   if(InpRequireBreakInWindow && !g_st[idx].insideSeen)
   {
      if(InpLogEveryBar)
         LogAnalysis(StringFormat("%s | entry window | SKIP - price was already outside the zone when the "
                                  "window opened, so no break can occur", cfg.name));
      return false;
   }

   double hi = g_st[idx].rangeHi;
   double lo = g_st[idx].rangeLo;

   bool brokeUp   = InpCloseOnly ? (cC > hi) : (cH > hi);
   bool brokeDown = InpCloseOnly ? (cC < lo) : (cL < lo);

   if(!brokeUp && !brokeDown)
   {
      if(InpLogEveryBar)
         LogAnalysis(StringFormat("%s | entry window | no break. range %s-%s  bar H=%s L=%s C=%s",
                                  cfg.name, Px(lo), Px(hi), Px(cH), Px(cL), Px(cC)));
      return false;
   }

   // Both edges pierced on one bar: the side the confirmation bar closed on wins.
   double mid = (hi + lo) / 2.0;
   bool goLong  = brokeUp   && InpAllowLong  && (!brokeDown || cC >= mid);
   bool goShort = brokeDown && InpAllowShort && (!brokeUp   || cC <  mid);

   if(brokeUp && !InpAllowLong && !goShort)
   {
      LogAnalysis(StringFormat("%s | BREAK UP above %s but longs are disabled", cfg.name, Px(hi)));
      return false;
   }
   if(brokeDown && !InpAllowShort && !goLong)
   {
      LogAnalysis(StringFormat("%s | BREAK DOWN below %s but shorts are disabled", cfg.name, Px(lo)));
      return false;
   }
   if(!goLong && !goShort) return false;

   double ask  = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid  = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   long   sprd = (long)SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);

   if(InpMaxSpreadPoints > 0 && sprd > InpMaxSpreadPoints)
   {
      LogTrade(StringFormat("%s | BREAK %s REJECTED - spread %d pts > limit %d",
                            cfg.name, goLong ? "UP" : "DOWN", (int)sprd, InpMaxSpreadPoints));
      return false;
   }

   double buf   = InpSLBufferPts * g_point;
   double entry = goLong ? ask : bid;
   double sl    = 0.0;

   if(goLong)
   {
      if(InpSLMode == 0)      sl = lo - buf;
      else if(InpSLMode == 1) sl = hi - buf;
      else                    sl = cL - buf;
   }
   else
   {
      if(InpSLMode == 0)      sl = hi + buf;
      else if(InpSLMode == 1) sl = lo + buf;
      else                    sl = cH + buf;
   }

   double dist = goLong ? (entry - sl) : (sl - entry);

   if(dist < InpMinStopPts * g_point)
   {
      LogTrade(StringFormat("%s | BREAK %s REJECTED - stop distance %.1f pts below floor of %d",
                            cfg.name, goLong ? "UP" : "DOWN", dist / g_point, InpMinStopPts));
      return false;
   }

   // Broker's own minimum stop distance.
   long stopLevel = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);
   if(stopLevel > 0 && dist < stopLevel * g_point)
   {
      LogTrade(StringFormat("%s | BREAK %s REJECTED - stop %.1f pts inside broker stops level of %d",
                            cfg.name, goLong ? "UP" : "DOWN", dist / g_point, (int)stopLevel));
      return false;
   }

   double tp   = goLong ? (entry + InpMinRR * dist) : (entry - InpMinRR * dist);
   double lots = Inp_Lots;   // suggested size only; the app re-sizes on execute

   sl = NormalizeDouble(sl, g_digits);
   tp = NormalizeDouble(tp, g_digits);

   LogTrade("-----------------------------------------------------------------");
   LogTrade(StringFormat("%s | SIGNAL %s  at %s (session clock)",
                         cfg.name, goLong ? "LONG" : "SHORT",
                         TimeToString(barClock, TIME_DATE | TIME_MINUTES)));
   LogTrade(StringFormat("  range      %s - %s  (width %.1f pts)", Px(lo), Px(hi), (hi - lo) / g_point));
   LogTrade(StringFormat("  confirm    H=%s L=%s C=%s  (%s)",
                         Px(cH), Px(cL), Px(cC), InpCloseOnly ? "close beyond edge" : "wick or close"));
   LogTrade(StringFormat("  entry      %s   stop %s   target %s   RR 1:%.2f",
                         Px(entry), Px(sl), Px(tp), InpMinRR));

   // Publish to the app instead of trading. SignalLib prunes it on SL/TP hit or
   // expiry; the app/Bridge executes it at the user's chosen size.
   bool ok = PublishSignal(_Symbol, goLong ? "BUY" : "SELL", entry, sl, tp,
                           lots, "Range Breakout", 72, Inp_ExpiryMin * 60);
   if(!ok)
   {
      LogTrade("  SIGNAL PUBLISH FAILED");
      LogTrade("-----------------------------------------------------------------");
      return false;
   }

   g_st[idx].ticket = 0;               // signal-only: nothing to manage
   g_st[idx].enPx   = entry;
   g_st[idx].slPx   = sl;
   g_st[idx].tpPx   = tp;
   g_st[idx].dir    = goLong ? 1 : -1;
   g_st[idx].beDone = false;
   g_st[idx].trades++;

   LogTrade(StringFormat("  PUBLISHED  %s signal  entry %s  stop %s  target %s",
                         goLong ? "BUY" : "SELL", Px(entry), Px(sl), Px(tp)));
   LogTrade("-----------------------------------------------------------------");
   return true;
}

//+------------------------------------------------------------------+
//|                       Manage-time action                          |
//+------------------------------------------------------------------+
void DoManage(int idx)
{
   ulong tk = 0;
   if(!FindSessionPosition(idx, tk)) return;
   if(!PositionSelectByTicket(tk)) return;

   SessionCfg cfg   = g_cfg[idx];
   double open      = PositionGetDouble(POSITION_PRICE_OPEN);
   double cur       = PositionGetDouble(POSITION_PRICE_CURRENT);
   double pnl       = PositionGetDouble(POSITION_PROFIT);
   bool   isLong    = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
   bool   inProfit  = isLong ? (cur > open) : (cur < open);

   bool doClose = (InpManageAction == 0) || (InpManageAction == 2 && !inProfit);

   if(doClose)
   {
      LogTrade(StringFormat("%s | MANAGE TIME - closing %s at %s (open %s, floating %.2f %s)",
                            cfg.name, isLong ? "LONG" : "SHORT", Px(cur), Px(open),
                            pnl, AccountInfoString(ACCOUNT_CURRENCY)));
      if(!Trade.PositionClose(tk))
         LogTrade(StringFormat("%s | MANAGE CLOSE FAILED - retcode %d (%s)",
                               cfg.name, Trade.ResultRetcode(), Trade.ResultRetcodeDescription()));
      return;
   }

   if(g_st[idx].beDone)
      return;

   double off = InpBEOffsetPts * g_point;
   double be  = isLong ? (open + off) : (open - off);
   double sl  = PositionGetDouble(POSITION_SL);
   double tp  = PositionGetDouble(POSITION_TP);

   bool improves = isLong ? (be > sl) : (be < sl);
   if(!improves)
   {
      LogTrade(StringFormat("%s | MANAGE TIME - break-even %s is not an improvement on stop %s, left alone",
                            cfg.name, Px(be), Px(sl)));
      g_st[idx].beDone = true;
      return;
   }

   be = NormalizeDouble(be, g_digits);
   if(Trade.PositionModify(tk, be, tp))
   {
      g_st[idx].slPx  = be;
      g_st[idx].beDone = true;
      LogTrade(StringFormat("%s | MANAGE TIME - stop moved to break-even %s (was %s, floating %.2f %s)",
                            cfg.name, Px(be), Px(sl), pnl, AccountInfoString(ACCOUNT_CURRENCY)));
   }
   else
   {
      LogTrade(StringFormat("%s | MANAGE MODIFY FAILED - retcode %d (%s)",
                            cfg.name, Trade.ResultRetcode(), Trade.ResultRetcodeDescription()));
   }
}

//+------------------------------------------------------------------+
//|                     Per-session bar processing                    |
//+------------------------------------------------------------------+
void ProcessSession(int idx, datetime barClock, double bH, double bL,
                    double cH, double cL, double cC)
{
   if(!g_cfg[idx].on || !g_cfg[idx].valid) return;

   SessionCfg cfg = g_cfg[idx];
   int mod    = MinutesOfDay(barClock);
   int dayKey = DayKeyOf(barClock);

   // ---- daily reset ------------------------------------------------
   if(g_st[idx].dayKey != dayKey)
   {
      if(g_st[idx].dayKey != 0)
         LogAnalysis(StringFormat("%s | --- new day %d --- (previous day: %d trade(s))",
                                  cfg.name, dayKey, g_st[idx].trades));
      g_st[idx].dayKey      = dayKey;
      g_st[idx].trades      = 0;
      g_st[idx].ready       = false;
      g_st[idx].managed     = false;
      g_st[idx].rangeHi     = 0.0;
      g_st[idx].rangeLo     = 0.0;
      g_st[idx].inRangePrev = false;
      g_st[idx].insideSeen  = false;
   }

   bool inRange = InWindow(mod, cfg.r_start, cfg.r_end);
   bool inEntry = InWindow(mod, cfg.e_start, cfg.e_end);

   // ---- flatten a survivor before a fresh range --------------------
   if(InpFlatBeforeRange && inRange && !g_st[idx].inRangePrev)
   {
      ulong tk = 0;
      if(FindSessionPosition(idx, tk))
      {
         LogTrade(StringFormat("%s | new range window opening - closing the previous trade first", cfg.name));
         if(!Trade.PositionClose(tk))
            LogTrade(StringFormat("%s | PRE-RANGE CLOSE FAILED - retcode %d", cfg.name, Trade.ResultRetcode()));
      }
   }

   // ---- range construction -----------------------------------------
   if(inRange)
   {
      if(!g_st[idx].inRangePrev)
      {
         g_st[idx].rangeHi = bH;
         g_st[idx].rangeLo = bL;
         LogAnalysis(StringFormat("%s | range window OPEN at %s - first bar H=%s L=%s",
                                  cfg.name, ModToText(mod), Px(bH), Px(bL)));
      }
      else
      {
         if(bH > g_st[idx].rangeHi) g_st[idx].rangeHi = bH;
         if(bL < g_st[idx].rangeLo) g_st[idx].rangeLo = bL;
      }
   }
   else if(g_st[idx].inRangePrev)
   {
      // window just closed
      bool good = (g_st[idx].rangeHi > g_st[idx].rangeLo);
      g_st[idx].ready = good;
      if(good)
         LogAnalysis(StringFormat("%s | range window CLOSED - zone %s to %s  (width %.1f pts). Armed.",
                                  cfg.name, Px(g_st[idx].rangeLo), Px(g_st[idx].rangeHi),
                                  (g_st[idx].rangeHi - g_st[idx].rangeLo) / g_point));
      else
         LogAnalysis(StringFormat("%s | range window CLOSED but the zone is degenerate - no setup today",
                                  cfg.name));
   }
   g_st[idx].inRangePrev = inRange;

   // ---- manage time -------------------------------------------------
   if(!g_st[idx].managed && mod >= cfg.mng)
   {
      g_st[idx].managed = true;
      ulong tk = 0;
      if(FindSessionPosition(idx, tk))
         DoManage(idx);
      else
         LogAnalysis(StringFormat("%s | manage time %s reached - nothing open",
                                  cfg.name, ModToText(cfg.mng)));
   }

   // ---- track whether price was ever inside the zone this window ----
   // A break is only a BREAKOUT if price was inside first. Without this the
   // EA fires on any bar trading outside the range, including days where
   // price left the zone during the 75 minutes between the two windows and
   // never came back.
   if(inEntry && g_st[idx].ready)
   {
      if(cH <= g_st[idx].rangeHi && cL >= g_st[idx].rangeLo)
         g_st[idx].insideSeen = true;
   }

   // ---- entry -------------------------------------------------------
   if(!inEntry || !g_st[idx].ready) return;

   ulong open_tk = 0;
   if(FindSessionPosition(idx, open_tk))
   {
      if(InpLogEveryBar)
         LogAnalysis(StringFormat("%s | entry window | already in a trade (ticket %d)",
                                  cfg.name, (int)open_tk));
      return;
   }

   TryEntry(idx, barClock, cH, cL, cC);
}

//+------------------------------------------------------------------+
//|                        Close detection                            |
//+------------------------------------------------------------------+
void ReportClosures()
{
   for(int i = 0; i < SESSIONS; i++)
   {
      if(g_st[i].ticket == 0) continue;

      ulong tk = 0;
      if(FindSessionPosition(i, tk)) continue;   // still open

      double profit = ClosedPositionProfit(g_st[i].ticket);
      string verdict = (profit > 0.0) ? "WIN" : (profit < 0.0 ? "LOSS" : "SCRATCH");

      LogTrade(StringFormat("%s | CLOSED %s  -  %s %.2f %s  (entry %s, stop %s, target %s)",
                            g_cfg[i].name, verdict,
                            profit >= 0.0 ? "+" : "", profit, AccountInfoString(ACCOUNT_CURRENCY),
                            Px(g_st[i].enPx), Px(g_st[i].slPx), Px(g_st[i].tpPx)));

      g_st[i].ticket = 0;
      g_st[i].dir    = 0;
   }
}

//+------------------------------------------------------------------+
//|                            OnTick                                 |
//+------------------------------------------------------------------+
void OnTick()
{
   datetime barTime = iTime(_Symbol, InpWorkTF, 0);
   if(barTime == 0) return;
   SignalLib_Prune();                     // remove published signals whose SL/TP hit or expired
   if(barTime == g_lastBar) return;       // bar-close driven, like the indicator
   g_lastBar = barTime;

   RefreshClockShift(false);   // tracks a broker DST roll without a restart
   ReportClosures();

   // The bar that just closed is shift 1 on the working timeframe.
   datetime closedBarTime = iTime(_Symbol, InpWorkTF, 1);
   if(closedBarTime == 0) return;

   double bH = iHigh(_Symbol, InpWorkTF, 1);
   double bL = iLow (_Symbol, InpWorkTF, 1);
   if(bH == 0.0 || bL == 0.0) return;

   // Confirmation source: last CLOSED bar of the confirmation timeframe.
   double cH = iHigh (_Symbol, g_confTF, 1);
   double cL = iLow  (_Symbol, g_confTF, 1);
   double cC = iClose(_Symbol, g_confTF, 1);
   if(cH == 0.0 || cL == 0.0) return;

   datetime barClock = ToSessionClock(closedBarTime);

   for(int i = 0; i < SESSIONS; i++)
      ProcessSession(i, barClock, bH, bL, cH, cL, cC);
}
//+------------------------------------------------------------------+
