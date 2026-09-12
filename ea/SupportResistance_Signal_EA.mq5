//+------------------------------------------------------------------+
//|                                    SupportResistance_Signal_EA.mq5 |
//|  Signal-only S/R. Finds recent fractal swing highs (resistance)   |
//|  and lows (support); fires a signal on rejection/bounce.          |
//|  Publishes to FX Commander - does NOT trade.                      |
//+------------------------------------------------------------------+
#property copyright "TradeCommand SignalEA"
#property version   "1.00"
#property description "Support/Resistance signal source for FX Commander (no trading)"

#include "SignalLib.mqh"

input group "=== Firebase ==="
input string Inp_ProjectID = "c0mmand3r";
input string Inp_ApiKey    = "AIzaSyCA3LUdogLeo7wdHEfxfPQtG4EG2SqEFtg";
input string Inp_Email     = "";       // Firebase account email
input string Inp_Password  = "";       // Firebase account password

input group "=== Detection ==="
input ENUM_TIMEFRAMES Inp_TF        = PERIOD_M15;  // Working timeframe
input int    Inp_Lookback   = 200;    // Bars scanned for swing levels
input int    Inp_Wing       = 2;      // Fractal wing (bars each side of a pivot)
input int    Inp_ProxPts    = 50;     // How close (points) price must get to the level
input group "=== Signal ==="
input double Inp_MinRR      = 2.0;    // TP as multiple of stop distance
input int    Inp_BufferPts  = 20;     // SL buffer beyond the level (points)
input double Inp_Lots       = 0.05;
input int    Inp_ExpiryMin  = 90;
input int    Inp_CooldownBars = 6;    // Min bars between signals of the same direction
input bool   Inp_AllowLong  = true;
input bool   Inp_AllowShort = true;

datetime g_lastBar = 0;
int      g_lastLongIdx = -100000, g_lastShortIdx = -100000; // bar-count throttle
long     g_barCounter = 0;

int OnInit()
{
   SignalLib_Init(Inp_ProjectID, Inp_ApiKey, Inp_Email, Inp_Password);
   Print("Support/Resistance signal EA on ", _Symbol);
   return INIT_SUCCEEDED;
}

// Nearest resistance = lowest fractal swing-high that is ABOVE price.
// Nearest support    = highest fractal swing-low that is BELOW price.
bool FindLevels(double price, double &resistance, double &support)
{
   resistance = 0; support = 0;
   int wing = MathMax(1, Inp_Wing);
   int scan = MathMin(Inp_Lookback, Bars(_Symbol, Inp_TF) - wing - 2);
   for(int i = wing + 1; i <= scan; i++)
   {
      double hi = iHigh(_Symbol, Inp_TF, i);
      double lo = iLow(_Symbol, Inp_TF, i);
      bool isSwingHigh = true, isSwingLow = true;
      for(int k = 1; k <= wing; k++)
      {
         if(iHigh(_Symbol, Inp_TF, i-k) >= hi || iHigh(_Symbol, Inp_TF, i+k) >= hi) isSwingHigh = false;
         if(iLow(_Symbol, Inp_TF, i-k)  <= lo || iLow(_Symbol, Inp_TF, i+k)  <= lo) isSwingLow  = false;
      }
      if(isSwingHigh && hi > price)
         if(resistance == 0 || hi < resistance) resistance = hi; // closest above
      if(isSwingLow && lo < price)
         if(support == 0 || lo > support) support = lo;          // closest below
   }
   return (resistance > 0 || support > 0);
}

void OnTick()
{
   // Remove any of our signals whose SL/TP was hit or that expired
   SignalLib_Prune();

   datetime bt = iTime(_Symbol, Inp_TF, 0);
   if(bt == g_lastBar) return;
   g_lastBar = bt;
   g_barCounter++;

   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   double prox   = Inp_ProxPts * point;
   double buffer = Inp_BufferPts * point;

   double c = iClose(_Symbol, Inp_TF, 1);
   double h = iHigh(_Symbol, Inp_TF, 1);
   double l = iLow(_Symbol, Inp_TF, 1);

   double resistance, support;
   if(!FindLevels(c, resistance, support)) return;

   // Evaluate both setups on this bar
   bool wantShort = Inp_AllowShort && resistance > 0 && h >= resistance - prox && c < resistance;
   bool wantLong  = Inp_AllowLong  && support   > 0 && l <= support   + prox && c > support;

   // A single bar tagging both a support and a resistance is ambiguous chop - skip it
   if(wantShort && wantLong) return;

   if(wantShort && (g_barCounter - g_lastShortIdx) >= Inp_CooldownBars)
   {
      double entry = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double sl    = resistance + buffer;
      double dist  = sl - entry;
      if(dist > 0)
      {
         double tp = entry - Inp_MinRR * dist;
         PublishSignal(_Symbol, "SELL", entry, sl, tp, Inp_Lots, "Support/Resistance", 65, Inp_ExpiryMin*60);
         g_lastShortIdx = (int)g_barCounter;
      }
   }
   else if(wantLong && (g_barCounter - g_lastLongIdx) >= Inp_CooldownBars)
   {
      double entry = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double sl    = support - buffer;
      double dist  = entry - sl;
      if(dist > 0)
      {
         double tp = entry + Inp_MinRR * dist;
         PublishSignal(_Symbol, "BUY", entry, sl, tp, Inp_Lots, "Support/Resistance", 65, Inp_ExpiryMin*60);
         g_lastLongIdx = (int)g_barCounter;
      }
   }
}
//+------------------------------------------------------------------+
