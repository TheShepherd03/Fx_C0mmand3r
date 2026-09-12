//+------------------------------------------------------------------+
//|                                        RangeBreakout_Signal_EA.mq5 |
//|  Signal-only range breakout. Builds a range during a daily window |
//|  then emits a BUY/SELL signal (with SL/TP) on a confirmed break.   |
//|  Does NOT trade - it only publishes signals to FX Commander.       |
//+------------------------------------------------------------------+
#property copyright "TradeCommand SignalEA"
#property version   "1.00"
#property description "Range breakout signal source for FX Commander (no trading)"

#include "SignalLib.mqh"

input group "=== Firebase ==="
input string Inp_ProjectID = "c0mmand3r";
input string Inp_ApiKey    = "AIzaSyCA3LUdogLeo7wdHEfxfPQtG4EG2SqEFtg";

input group "=== Range window (broker/server time) ==="
input ENUM_TIMEFRAMES Inp_TF          = PERIOD_M5;   // Working timeframe
input string          Inp_RangeStart  = "08:00";     // Range build start (HH:MM)
input string          Inp_RangeEnd    = "08:30";     // Range build end (HH:MM)
input string          Inp_EntryEnd    = "12:00";     // Stop looking for breaks after (HH:MM)

input group "=== Signal ==="
input bool   Inp_CloseBeyond = true;   // true = bar must CLOSE beyond edge; false = wick touch
input double Inp_MinRR       = 2.0;    // TP as multiple of stop distance
input int    Inp_BufferPts   = 10;     // SL buffer beyond opposite edge (points)
input double Inp_Lots        = 0.05;   // Suggested lot size for the signal
input int    Inp_ExpiryMin   = 60;     // Signal expiry (minutes)
input bool   Inp_AllowLong   = true;
input bool   Inp_AllowShort  = true;

// state
double   g_rangeHi = 0, g_rangeLo = 0;
bool     g_rangeReady = false;
int      g_rangeDay = -1;         // day-of-year the range was built for
bool     g_firedLong = false, g_firedShort = false;
datetime g_lastBar = 0;

int MinutesOfDay(string hhmm)
{
   int c = StringFind(hhmm, ":");
   if(c < 0) return -1;
   return (int)StringToInteger(StringSubstr(hhmm,0,c))*60 + (int)StringToInteger(StringSubstr(hhmm,c+1));
}

int OnInit()
{
   SignalLib_Init(Inp_ProjectID, Inp_ApiKey);
   Print("RangeBreakout signal EA on ", _Symbol);
   return INIT_SUCCEEDED;
}

void OnTick()
{
   // Act once per new bar on the working timeframe
   datetime bt = iTime(_Symbol, Inp_TF, 0);
   if(bt == g_lastBar) return;
   g_lastBar = bt;

   MqlDateTime now; TimeToStruct(TimeCurrent(), now);
   int mins = now.hour*60 + now.min;
   int rStart = MinutesOfDay(Inp_RangeStart);
   int rEnd   = MinutesOfDay(Inp_RangeEnd);
   int eEnd   = MinutesOfDay(Inp_EntryEnd);

   // New day -> reset
   if(now.day_of_year != g_rangeDay && mins < rStart)
   {
      g_rangeReady = false; g_firedLong = false; g_firedShort = false;
      g_rangeHi = 0; g_rangeLo = 0;
   }

   // Build the range across the window using completed bars
   if(mins >= rStart && mins <= rEnd)
   {
      double hi = iHigh(_Symbol, Inp_TF, 1);
      double lo = iLow(_Symbol, Inp_TF, 1);
      if(g_rangeHi == 0 || hi > g_rangeHi) g_rangeHi = hi;
      if(g_rangeLo == 0 || lo < g_rangeLo) g_rangeLo = lo;
      g_rangeReady = false;
      return;
   }

   // Just past the window -> lock the range
   if(!g_rangeReady && mins > rEnd && g_rangeHi > 0 && g_rangeLo > 0)
   {
      g_rangeReady = true;
      g_rangeDay = now.day_of_year;
      Print("Range locked ", _Symbol, " Hi=", g_rangeHi, " Lo=", g_rangeLo);
   }

   if(!g_rangeReady) return;
   if(eEnd >= 0 && mins > eEnd) return; // entry window closed

   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   double buffer = Inp_BufferPts * point;

   // Reference price of the last completed bar
   double c = iClose(_Symbol, Inp_TF, 1);
   double h = iHigh(_Symbol, Inp_TF, 1);
   double l = iLow(_Symbol, Inp_TF, 1);

   // Long break above range high
   if(Inp_AllowLong && !g_firedLong)
   {
      bool broke = Inp_CloseBeyond ? (c > g_rangeHi) : (h > g_rangeHi);
      if(broke)
      {
         double entry = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
         double sl    = g_rangeLo - buffer;
         double dist  = entry - sl;
         if(dist > 0)
         {
            double tp = entry + Inp_MinRR * dist;
            PublishSignal(_Symbol, "BUY", entry, sl, tp, Inp_Lots, "Range Breakout", 70, Inp_ExpiryMin*60);
            g_firedLong = true;
         }
      }
   }

   // Short break below range low
   if(Inp_AllowShort && !g_firedShort)
   {
      bool broke = Inp_CloseBeyond ? (c < g_rangeLo) : (l < g_rangeLo);
      if(broke)
      {
         double entry = SymbolInfoDouble(_Symbol, SYMBOL_BID);
         double sl    = g_rangeHi + buffer;
         double dist  = sl - entry;
         if(dist > 0)
         {
            double tp = entry - Inp_MinRR * dist;
            PublishSignal(_Symbol, "SELL", entry, sl, tp, Inp_Lots, "Range Breakout", 70, Inp_ExpiryMin*60);
            g_firedShort = true;
         }
      }
   }
}
//+------------------------------------------------------------------+
