//+------------------------------------------------------------------+
//|                                        SupplyDemand_Signal_EA.mq5 |
//|  Signal-only Supply/Demand. Marks a zone at the origin of a       |
//|  strong impulse candle; fires a signal when price retests it.     |
//|  Publishes to FX Commander - does NOT trade.                      |
//+------------------------------------------------------------------+
#property copyright "TradeCommand SignalEA"
#property version   "1.00"
#property description "Supply/Demand signal source for FX Commander (no trading)"

#include "SignalLib.mqh"

input group "=== Firebase ==="
input string Inp_ProjectID = "c0mmand3r";
input string Inp_ApiKey    = "AIzaSyCA3LUdogLeo7wdHEfxfPQtG4EG2SqEFtg";

input group "=== Detection ==="
input ENUM_TIMEFRAMES Inp_TF        = PERIOD_M15;  // Working timeframe
input int    Inp_ATRPeriod  = 14;     // ATR period for impulse sizing
input double Inp_ImpulseATR = 1.8;    // Impulse candle body >= this * ATR
input group "=== Signal ==="
input double Inp_MinRR      = 2.0;     // TP as multiple of stop distance
input int    Inp_BufferPts  = 20;      // SL buffer beyond the zone (points)
input double Inp_Lots       = 0.05;
input int    Inp_ExpiryMin  = 120;
input bool   Inp_AllowLong  = true;
input bool   Inp_AllowShort = true;

int      g_atr = INVALID_HANDLE;
datetime g_lastBar = 0;

// Active zones (most recent of each)
double g_demandLow=0, g_demandHigh=0; bool g_demandActive=false;
double g_supplyLow=0, g_supplyHigh=0; bool g_supplyActive=false;

int OnInit()
{
   g_atr = iATR(_Symbol, Inp_TF, Inp_ATRPeriod);
   if(g_atr == INVALID_HANDLE) { Print("SD: ATR handle failed"); return INIT_FAILED; }
   SignalLib_Init(Inp_ProjectID, Inp_ApiKey);
   Print("Supply/Demand signal EA on ", _Symbol);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { if(g_atr!=INVALID_HANDLE) IndicatorRelease(g_atr); }

double ATRValue()
{
   double b[]; if(CopyBuffer(g_atr, 0, 1, 1, b) <= 0) return 0; return b[0];
}

void OnTick()
{
   // Remove any of our signals whose SL/TP was hit or that expired
   SignalLib_Prune();

   datetime bt = iTime(_Symbol, Inp_TF, 0);
   if(bt == g_lastBar) return;
   g_lastBar = bt;

   double atr = ATRValue();
   if(atr <= 0) return;

   double point  = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   double buffer = Inp_BufferPts * point;

   // Inspect the last completed bar for a fresh impulse -> define a new zone
   double o = iOpen(_Symbol, Inp_TF, 1);
   double c = iClose(_Symbol, Inp_TF, 1);
   double h = iHigh(_Symbol, Inp_TF, 1);
   double l = iLow(_Symbol, Inp_TF, 1);
   double body = MathAbs(c - o);

   if(body >= Inp_ImpulseATR * atr)
   {
      if(c > o) // bullish impulse -> demand zone at its base (low..open)
      {
         g_demandLow = l; g_demandHigh = o; g_demandActive = true;
      }
      else       // bearish impulse -> supply zone at its base (open..high)
      {
         g_supplyLow = o; g_supplyHigh = h; g_supplyActive = true;
      }
   }

   // Retest of demand -> BUY (price dips into zone but holds)
   if(Inp_AllowLong && g_demandActive && l <= g_demandHigh && c > g_demandLow)
   {
      double entry = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double sl    = g_demandLow - buffer;
      double dist  = entry - sl;
      if(dist > 0)
      {
         double tp = entry + Inp_MinRR * dist;
         PublishSignal(_Symbol, "BUY", entry, sl, tp, Inp_Lots, "Supply/Demand", 68, Inp_ExpiryMin*60);
      }
      g_demandActive = false; // consume the zone
   }

   // Retest of supply -> SELL (price rallies into zone but rejects)
   if(Inp_AllowShort && g_supplyActive && h >= g_supplyLow && c < g_supplyHigh)
   {
      double entry = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double sl    = g_supplyHigh + buffer;
      double dist  = sl - entry;
      if(dist > 0)
      {
         double tp = entry - Inp_MinRR * dist;
         PublishSignal(_Symbol, "SELL", entry, sl, tp, Inp_Lots, "Supply/Demand", 68, Inp_ExpiryMin*60);
      }
      g_supplyActive = false; // consume the zone
   }
}
//+------------------------------------------------------------------+
