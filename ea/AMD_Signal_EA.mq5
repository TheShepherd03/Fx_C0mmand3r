//+------------------------------------------------------------------+
//|                                              AMD_Signal_EA.mq5    |
//|   ICT AMD (Accumulation / Manipulation / Distribution) signal EA |
//|                                              Author: Sakhi        |
//+------------------------------------------------------------------+
#property copyright "Sakhi"
#property version   "1.00"
#property description "SIGNAL-ONLY ICT AMD model. Builds an accumulation range in a session window, waits for price to SWEEP that external liquidity (manipulation) and RECLAIM it, then PUBLISHES a signal to the FX Commander app: stop at the manipulation extreme, target the opposing liquidity (draw-to-draw). Optional BOS, higher-TF bias and SMT-divergence confluences. It never trades - the app/Bridge executes."

#include "SignalLib.mqh"

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
input int    Inp_ExpiryMin = 240;      // Signal expiry (minutes)
input string Inp_Source    = "AMD";    // Signal source label (shown on the card)

input group "=== Clock ==="
input ENUM_TIMEFRAMES InpWorkTF           = PERIOD_M5;  // Working timeframe (range + sweep + reclaim bars)
input double          InpSessionUTCOffset = 2.0;        // Your windows are written in UTC+this (2 = SAST)
input double          InpServerUTCOffset  = 99.0;       // Broker UTC offset - leave 99 to detect automatically

input group "=== AMD windows (session clock) ==="
input string InpAccumWindow  = "0000-0600";   // Accumulation window HHMM-HHMM (builds the range)
input string InpActiveWindow = "0600-1200";   // Manipulation+Distribution window (hunt the sweep/reclaim here)

input group "=== Setup ==="
input bool   InpAllowLong        = true;   // Allow longs (sweep of the accumulation LOW)
input bool   InpAllowShort       = true;   // Allow shorts (sweep of the accumulation HIGH)
input int    InpMaxPerDay        = 1;      // Max signals published per day
input int    InpReclaimBufferPts = 0;      // Reclaim confirmed when close is this far back inside the range (points)
input int    InpInvalidatePts    = 0;      // Close beyond the swept level by this = real break, cancel that side (0 = off)

input group "=== BOS confluence ==="
input bool   InpRequireBOS   = false;      // Also require a break of structure on the reclaim bar
input int    InpBOSLookback  = 6;          // Swing lookback for the BOS level (bars)

input group "=== Higher-TF bias confluence ==="
input bool            InpUseHTFBias  = false;        // Only take trades aligned with the HTF EMA
input ENUM_TIMEFRAMES InpHTFTimeframe = PERIOD_H1;   // Higher timeframe
input int             InpHTFEMAPeriod = 50;          // EMA period on the HTF

input group "=== SMT divergence confluence (approximate) ==="
input bool   InpUseSMT     = false;        // Require SMT divergence vs a correlated symbol
input string InpSMTSymbol  = "";           // Correlated symbol (e.g. US100 when trading US30). Blank = off
input int    InpSMTLookback = 10;          // Lookback for the new-high/low comparison (bars)

input group "=== Risk / targets ==="
input int    InpSLBufferPts = 20;     // Stop buffer beyond the manipulation extreme (points)
input int    InpMinStopPts  = 20;     // Min stop distance (points) - below this the setup is skipped
input double InpMinRR        = 2.0;   // Min risk:reward; below this the signal is skipped
input int    InpTPMode       = 0;     // Take profit: 0=Opposing liquidity (accum edge), 1=RR multiple of stop
input int    InpTPExtendPts  = 0;     // TPMode 0: push target this far BEYOND the accum edge (points)

input group "=== Journal ==="
input int    InpLogLevel     = 2;     // 0=errors, 1=signals, 2=full analysis
input bool   InpLogEveryBar  = false; // Level 2: also log bars where nothing happened

//+------------------------------------------------------------------+
//|                            State                                  |
//+------------------------------------------------------------------+
enum PHASE { PH_ACCUM, PH_ARMED };

double   g_accHi = 0.0, g_accLo = 0.0;
bool     g_accReady = false;
bool     g_inAccumPrev = false;
int      g_dayKey = 0;
int      g_fired  = 0;

bool     g_sweptLow  = false;  double g_manipLow  = 0.0;
bool     g_sweptHigh = false;  double g_manipHigh = 0.0;
bool     g_longCancelled = false, g_shortCancelled = false;

datetime g_lastBar   = 0;
double   g_point     = 0.0;
int      g_digits    = 0;
int      g_htfEMA    = INVALID_HANDLE;

int      g_accStart, g_accEnd, g_actStart, g_actEnd;
bool     g_cfgOK = false;

double   g_serverUTC = 0.0, g_shiftHrs = 0.0;
bool     g_clockKnown = false;
bool     g_optimizing = false;

//+------------------------------------------------------------------+
//|                           Logging                                 |
//+------------------------------------------------------------------+
void Log(string m)         { if(!g_optimizing) Print("[AMD] ", m); }
void LogSig(string m)      { if(!g_optimizing && InpLogLevel >= 1) Print("[AMD] ", m); }
void LogAn(string m)       { if(!g_optimizing && InpLogLevel >= 2) Print("[AMD] ", m); }
string Px(double v)        { return DoubleToString(v, g_digits); }

//+------------------------------------------------------------------+
//|                      Time / window helpers                        |
//+------------------------------------------------------------------+
double DetectServerUTCOffset()
{
   datetime srv = TimeCurrent(), gmt = TimeGMT();
   if(srv <= 0 || gmt <= 0) return 0.0;
   double hours = (double)((long)srv - (long)gmt) / 3600.0;
   return MathRound(hours * 2.0) / 2.0;
}

void RefreshClockShift(bool announce)
{
   double srvUTC = (InpServerUTCOffset < 90.0) ? InpServerUTCOffset : DetectServerUTCOffset();
   double shift  = InpSessionUTCOffset - srvUTC;
   bool changed  = (!g_clockKnown || shift != g_shiftHrs);
   g_serverUTC   = srvUTC;
   g_shiftHrs    = shift;
   if(changed && g_clockKnown)
      Log(StringFormat("CLOCK SHIFT - broker moved to UTC%+.1f. Session shift now %+.1f h.", srvUTC, shift));
   g_clockKnown = true;
   if(announce)
      Log(StringFormat("Broker clock UTC%+.1f (%s) | windows in UTC%+.1f | shift %+.1f h",
                       srvUTC, (InpServerUTCOffset < 90.0) ? "input" : "auto", InpSessionUTCOffset, shift));
}

datetime ToSessionClock(datetime t) { return t + (int)MathRound(g_shiftHrs * 3600.0); }

int MinutesOfDay(datetime t) { MqlDateTime d; TimeToStruct(t, d); return d.hour * 60 + d.min; }
int DayKeyOf(datetime t)     { MqlDateTime d; TimeToStruct(t, d); return d.year*10000 + d.mon*100 + d.day; }

bool InWindow(int mod, int s, int e)
{
   if(s == e) return false;
   if(s < e)  return (mod >= s && mod < e);
   return (mod >= s || mod < e);
}

bool ParseWindow(string spec, int &s, int &e)
{
   string x = spec; StringTrimLeft(x); StringTrimRight(x); StringReplace(x, " ", "");
   int dash = StringFind(x, "-");
   if(dash < 0) return false;
   string a = StringSubstr(x, 0, dash), b = StringSubstr(x, dash + 1);
   if(StringLen(a) != 4 || StringLen(b) != 4) return false;
   int ah = (int)StringToInteger(StringSubstr(a,0,2)), am = (int)StringToInteger(StringSubstr(a,2,2));
   int bh = (int)StringToInteger(StringSubstr(b,0,2)), bm = (int)StringToInteger(StringSubstr(b,2,2));
   if(ah<0||ah>23||bh<0||bh>24||am<0||am>59||bm<0||bm>59) return false;
   s = ah*60+am; e = bh*60+bm; return true;
}

string ModTxt(int m) { return StringFormat("%02d:%02d", m/60, m%60); }

//+------------------------------------------------------------------+
//|                        Swing helpers                              |
//+------------------------------------------------------------------+
// Highest high / lowest low over `count` closed bars starting at shift `start`.
double HighestHigh(int count, int start)
{
   double hi = -DBL_MAX;
   for(int i = 0; i < count; i++) { double h = iHigh(_Symbol, InpWorkTF, start + i); if(h > hi) hi = h; }
   return hi;
}
double LowestLow(int count, int start)
{
   double lo = DBL_MAX;
   for(int i = 0; i < count; i++) { double l = iLow(_Symbol, InpWorkTF, start + i); if(l < lo) lo = l; }
   return lo;
}

//+------------------------------------------------------------------+
//|                     Confluence checks                             |
//+------------------------------------------------------------------+
// HTF EMA bias: long only above the EMA, short only below.
bool HTFBiasOK(bool wantLong)
{
   if(!InpUseHTFBias) return true;
   if(g_htfEMA == INVALID_HANDLE) return true;
   double ema[]; if(CopyBuffer(g_htfEMA, 0, 1, 1, ema) < 1) return true;   // no data yet -> don't block
   double c = iClose(_Symbol, InpHTFTimeframe, 1);
   if(c == 0.0) return true;
   return wantLong ? (c > ema[0]) : (c < ema[0]);
}

// Approximate SMT divergence vs a correlated symbol, evaluated on the reclaim bar (shift 1).
// Bullish: THIS symbol made a fresh lookback low (it swept) but the correlated one did NOT.
// Bearish: THIS symbol made a fresh lookback high but the correlated one did NOT.
bool SMTOK(bool wantLong)
{
   if(!InpUseSMT || InpSMTSymbol == "") return true;
   if(!SymbolInfoInteger(InpSMTSymbol, SYMBOL_SELECT))
      SymbolSelect(InpSMTSymbol, true);
   int n = MathMax(3, InpSMTLookback);
   if(wantLong)
   {
      double myLow   = iLow(_Symbol, InpWorkTF, 1);
      double corrLow = iLow(InpSMTSymbol, InpWorkTF, 1);
      if(corrLow == 0.0) return true;   // no data -> don't block
      double myPrevLow = DBL_MAX, corrPrevLow = DBL_MAX;
      for(int i = 0; i < n; i++)
      {
         double a = iLow(_Symbol, InpWorkTF, 2 + i);       if(a < myPrevLow)   myPrevLow = a;
         double b = iLow(InpSMTSymbol, InpWorkTF, 2 + i);  if(b < corrPrevLow) corrPrevLow = b;
      }
      bool myNewLow   = (myLow   <= myPrevLow);
      bool corrNewLow = (corrLow <= corrPrevLow);
      return (myNewLow && !corrNewLow);
   }
   else
   {
      double myHigh   = iHigh(_Symbol, InpWorkTF, 1);
      double corrHigh = iHigh(InpSMTSymbol, InpWorkTF, 1);
      if(corrHigh == 0.0) return true;
      double myPrevHigh = -DBL_MAX, corrPrevHigh = -DBL_MAX;
      for(int i = 0; i < n; i++)
      {
         double a = iHigh(_Symbol, InpWorkTF, 2 + i);       if(a > myPrevHigh)   myPrevHigh = a;
         double b = iHigh(InpSMTSymbol, InpWorkTF, 2 + i);  if(b > corrPrevHigh) corrPrevHigh = b;
      }
      bool myNewHigh   = (myHigh   >= myPrevHigh);
      bool corrNewHigh = (corrHigh >= corrPrevHigh);
      return (myNewHigh && !corrNewHigh);
   }
}

//+------------------------------------------------------------------+
//|                            OnInit                                 |
//+------------------------------------------------------------------+
int OnInit()
{
   g_optimizing = (bool)MQLInfoInteger(MQL_OPTIMIZATION);
   g_point  = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   g_digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);

   RefreshClockShift(false);
   SignalLib_Init(Inp_ProjectID, Inp_ApiKey, Inp_Email, Inp_Password);

   g_cfgOK = ParseWindow(InpAccumWindow, g_accStart, g_accEnd)
          && ParseWindow(InpActiveWindow, g_actStart, g_actEnd);
   if(!g_cfgOK)
      Log("CONFIG ERROR - accumulation/active window is not HHMM-HHMM. EA will not run.");

   if(InpUseHTFBias)
   {
      g_htfEMA = iMA(_Symbol, InpHTFTimeframe, InpHTFEMAPeriod, 0, MODE_EMA, PRICE_CLOSE);
      if(g_htfEMA == INVALID_HANDLE) Log("WARNING: could not create HTF EMA handle; bias filter disabled at runtime.");
   }
   if(InpUseSMT && InpSMTSymbol != "") SymbolSelect(InpSMTSymbol, true);

   Log("=================================================================");
   Log("ICT AMD Signal EA v1.00  -  " + _Symbol);
   Log("=================================================================");
   Log(StringFormat("Work TF %s | accumulation %s-%s | active %s-%s (session clock)",
                    EnumToString(InpWorkTF), ModTxt(g_accStart), ModTxt(g_accEnd),
                    ModTxt(g_actStart), ModTxt(g_actEnd)));
   Log(StringFormat("Broker clock UTC%+.1f (%s) | windows in UTC%+.1f | shift %+.1f h",
                    g_serverUTC, (InpServerUTCOffset < 90.0) ? "input" : "auto",
                    InpSessionUTCOffset, g_shiftHrs));
   Log(StringFormat("Long %s | Short %s | max %d/day | min RR 1:%.2f | SL buffer %d pts | min stop %d pts",
                    InpAllowLong?"on":"off", InpAllowShort?"on":"off", InpMaxPerDay,
                    InpMinRR, InpSLBufferPts, InpMinStopPts));
   Log(StringFormat("Confluences: BOS %s | HTF bias %s (%s EMA%d) | SMT %s (%s)",
                    InpRequireBOS?"on":"off", InpUseHTFBias?"on":"off",
                    EnumToString(InpHTFTimeframe), InpHTFEMAPeriod,
                    (InpUseSMT && InpSMTSymbol!="")?"on":"off", InpSMTSymbol));
   if(MQLInfoInteger(MQL_TESTER) && InpServerUTCOffset >= 90.0)
      Log("NOTE: in the tester TimeGMT() comes from the PC clock. If the shift looks wrong, set "
          "InpServerUTCOffset to the broker's real offset (HFM = 2 winter / 3 summer).");
   Log("=================================================================");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   if(g_htfEMA != INVALID_HANDLE) IndicatorRelease(g_htfEMA);
   Log(StringFormat("Stopped (reason %d).", reason));
}

//+------------------------------------------------------------------+
//|                        Daily reset                                |
//+------------------------------------------------------------------+
void ResetDay(int dayKey)
{
   g_dayKey        = dayKey;
   g_accHi         = 0.0;  g_accLo = 0.0;  g_accReady = false;
   g_inAccumPrev   = false;
   g_fired         = 0;
   g_sweptLow      = false; g_manipLow  = 0.0;
   g_sweptHigh     = false; g_manipHigh = 0.0;
   g_longCancelled = false; g_shortCancelled = false;
}

//+------------------------------------------------------------------+
//|                       Publish a signal                            |
//+------------------------------------------------------------------+
void FireSignal(bool goLong, double manipExtreme)
{
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double buf = InpSLBufferPts * g_point;

   double entry = goLong ? ask : bid;
   double sl    = goLong ? (manipExtreme - buf) : (manipExtreme + buf);
   double dist  = goLong ? (entry - sl) : (sl - entry);

   if(dist < InpMinStopPts * g_point)
   {
      LogSig(StringFormat("SKIP %s - stop distance %.1f pts below floor %d",
                          goLong?"LONG":"SHORT", dist / g_point, InpMinStopPts));
      return;
   }
   long stopsLv = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);
   if(stopsLv > 0 && dist < stopsLv * g_point)
   {
      LogSig(StringFormat("SKIP %s - stop %.1f pts inside broker stops level %d",
                          goLong?"LONG":"SHORT", dist / g_point, (int)stopsLv));
      return;
   }

   // Take profit: draw-to-draw (opposing accumulation edge) or a straight RR multiple.
   double ext = InpTPExtendPts * g_point;
   double tp;
   if(InpTPMode == 0) tp = goLong ? (g_accHi + ext) : (g_accLo - ext);
   else               tp = goLong ? (entry + InpMinRR * dist) : (entry - InpMinRR * dist);

   double reward = goLong ? (tp - entry) : (entry - tp);
   double rr = (dist > 0.0) ? reward / dist : 0.0;
   if(rr < InpMinRR)
   {
      LogSig(StringFormat("SKIP %s - RR 1:%.2f below floor 1:%.2f (entry %s SL %s TP %s)",
                          goLong?"LONG":"SHORT", rr, InpMinRR, Px(entry), Px(sl), Px(tp)));
      return;
   }

   int conf = 68;
   if(InpRequireBOS) conf += 6;
   if(InpUseHTFBias) conf += 6;
   if(InpUseSMT && InpSMTSymbol != "") conf += 8;
   if(conf > 92) conf = 92;

   sl = NormalizeDouble(sl, g_digits);
   tp = NormalizeDouble(tp, g_digits);

   LogSig("-----------------------------------------------------------------");
   LogSig(StringFormat("SIGNAL %s  entry %s  stop %s  target %s  RR 1:%.2f  conf %d",
                       goLong?"LONG":"SHORT", Px(entry), Px(sl), Px(tp), rr, conf));
   LogSig(StringFormat("  accumulation %s-%s | manipulation extreme %s",
                       Px(g_accLo), Px(g_accHi), Px(manipExtreme)));

   bool ok = PublishSignal(_Symbol, goLong ? "BUY" : "SELL", entry, sl, tp,
                           Inp_Lots, Inp_Source, conf, Inp_ExpiryMin * 60);
   if(ok) { g_fired++; LogSig("  PUBLISHED"); }
   else     LogSig("  PUBLISH FAILED");
   LogSig("-----------------------------------------------------------------");
}

//+------------------------------------------------------------------+
//|                     Per-bar processing                            |
//+------------------------------------------------------------------+
void ProcessBar(datetime barClock, double bH, double bL, double bC)
{
   int mod    = MinutesOfDay(barClock);
   int dayKey = DayKeyOf(barClock);
   if(dayKey != g_dayKey)
   {
      if(g_dayKey != 0) LogAn(StringFormat("--- new day %d (prev day fired %d) ---", dayKey, g_fired));
      ResetDay(dayKey);
   }

   bool inAccum  = InWindow(mod, g_accStart, g_accEnd);
   bool inActive = InWindow(mod, g_actStart, g_actEnd);

   // ---- Accumulation: build the range ----
   if(inAccum)
   {
      if(!g_inAccumPrev) { g_accHi = bH; g_accLo = bL; LogAn(StringFormat("accumulation OPEN %s  H=%s L=%s", ModTxt(mod), Px(bH), Px(bL))); }
      else { if(bH > g_accHi) g_accHi = bH; if(bL < g_accLo) g_accLo = bL; }
   }
   else if(g_inAccumPrev)
   {
      g_accReady = (g_accHi > g_accLo);
      LogAn(StringFormat("accumulation CLOSED  zone %s - %s  (width %.1f pts)  %s",
                         Px(g_accLo), Px(g_accHi), (g_accHi - g_accLo)/g_point,
                         g_accReady ? "ARMED" : "degenerate - no setup"));
   }
   g_inAccumPrev = inAccum;

   // ---- Manipulation + Distribution: hunt the sweep + reclaim ----
   if(!inActive || !g_accReady || g_fired >= InpMaxPerDay) return;

   double reclaimBuf    = InpReclaimBufferPts * g_point;
   double invalidateBuf = InpInvalidatePts    * g_point;

   // LONG: sweep BELOW the accumulation low (external sellside liquidity), then reclaim it.
   if(InpAllowLong && !g_longCancelled && g_fired < InpMaxPerDay)
   {
      if(bL < g_accLo)
      {
         if(!g_sweptLow) { g_sweptLow = true; g_manipLow = bL; LogAn(StringFormat("swept LOW %s (below %s) - manipulation down", Px(bL), Px(g_accLo))); }
         else if(bL < g_manipLow) g_manipLow = bL;
      }
      if(g_sweptLow)
      {
         if(InpInvalidatePts > 0 && bC < g_accLo - invalidateBuf)
         {
            g_longCancelled = true;
            LogAn(StringFormat("LONG cancelled - close %s decisively below %s (real breakdown)", Px(bC), Px(g_accLo)));
         }
         else if(bC > g_accLo + reclaimBuf)
         {
            bool bos = (!InpRequireBOS) || (bC > HighestHigh(InpBOSLookback, 2));
            if(!bos)          LogAn("reclaim seen but no bullish BOS yet - waiting");
            else if(!HTFBiasOK(true)) LogAn("reclaim + BOS but HTF bias is bearish - skip long");
            else if(!SMTOK(true))     LogAn("reclaim + BOS but no bullish SMT divergence - skip long");
            else              FireSignal(true, g_manipLow);
         }
      }
   }

   // SHORT: sweep ABOVE the accumulation high (external buyside liquidity), then reclaim it.
   if(InpAllowShort && !g_shortCancelled && g_fired < InpMaxPerDay)
   {
      if(bH > g_accHi)
      {
         if(!g_sweptHigh) { g_sweptHigh = true; g_manipHigh = bH; LogAn(StringFormat("swept HIGH %s (above %s) - manipulation up", Px(bH), Px(g_accHi))); }
         else if(bH > g_manipHigh) g_manipHigh = bH;
      }
      if(g_sweptHigh)
      {
         if(InpInvalidatePts > 0 && bC > g_accHi + invalidateBuf)
         {
            g_shortCancelled = true;
            LogAn(StringFormat("SHORT cancelled - close %s decisively above %s (real breakout)", Px(bC), Px(g_accHi)));
         }
         else if(bC < g_accHi - reclaimBuf)
         {
            bool bos = (!InpRequireBOS) || (bC < LowestLow(InpBOSLookback, 2));
            if(!bos)           LogAn("reclaim seen but no bearish BOS yet - waiting");
            else if(!HTFBiasOK(false)) LogAn("reclaim + BOS but HTF bias is bullish - skip short");
            else if(!SMTOK(false))     LogAn("reclaim + BOS but no bearish SMT divergence - skip short");
            else               FireSignal(false, g_manipHigh);
         }
      }
   }

   if(InpLogEveryBar)
      LogAn(StringFormat("bar %s  H=%s L=%s C=%s  sweptLo=%d sweptHi=%d fired=%d",
                         ModTxt(mod), Px(bH), Px(bL), Px(bC), g_sweptLow, g_sweptHigh, g_fired));
}

//+------------------------------------------------------------------+
//|                            OnTick                                 |
//+------------------------------------------------------------------+
void OnTick()
{
   if(!g_cfgOK) return;
   datetime barTime = iTime(_Symbol, InpWorkTF, 0);
   if(barTime == 0) return;
   SignalLib_Prune();                    // keep published signals' status/price live; prune on SL/TP/expiry
   if(barTime == g_lastBar) return;      // act on bar close only
   g_lastBar = barTime;

   RefreshClockShift(false);             // follows a broker DST roll without a restart

   datetime closed = iTime(_Symbol, InpWorkTF, 1);
   if(closed == 0) return;
   double bH = iHigh (_Symbol, InpWorkTF, 1);
   double bL = iLow  (_Symbol, InpWorkTF, 1);
   double bC = iClose(_Symbol, InpWorkTF, 1);
   if(bH == 0.0 || bL == 0.0) return;

   ProcessBar(ToSessionClock(closed), bH, bL, bC);
}
//+------------------------------------------------------------------+
