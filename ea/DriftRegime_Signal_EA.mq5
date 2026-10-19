//+------------------------------------------------------------------+
//|                                      DriftRegime_Signal_EA.mq5    |
//|  SIGNAL-ONLY forward-test of the drift-regime edge on Drift      |
//|  Switch indices. Publishes a BUY/SELL to the FX Commander app    |
//|  on each regime flip (slow dual-EMA + ATR hysteresis).           |
//|  NEVER trades. Attach to a Drift Switch Index 10, M15 chart.     |
//+------------------------------------------------------------------+
#property copyright "Sakhi"
#property version   "1.00"
#property description "Signal-only drift-regime follower (validated on Drift Switch Index 10 M15, PF ~1.3 IS/OOS on real ticks). Publishes on regime flip; never trades. Forward-test tool."

#include "SignalLib.mqh"

input group "=== Firebase (FX Commander) ==="
input string Inp_ProjectID = "c0mmand3r";
input string Inp_ApiKey    = "AIzaSyCA3LUdogLeo7wdHEfxfPQtG4EG2SqEFtg";
input string Inp_Email     = "";
input string Inp_Password  = "";

input group "=== Signal ==="
input double Inp_Lots       = 0.50;      // suggested lot (app re-sizes on execute)
input int    Inp_ExpiryMin  = 10080;     // signal expiry (min); 7d so it survives a drift leg
input string Inp_Source     = "DriftRegime";
input int    Inp_Confidence = 72;

input group "=== Regime (validated defaults: 35/150 on M15) ==="
input int    InpFastEMA       = 35;
input int    InpSlowEMA       = 150;
input int    InpATRPeriod     = 14;
input double InpFlipBufferATR = 0.5;     // hysteresis band = this * ATR
input double InpSLATR         = 6.0;     // indicative stop = ATR * this
input double InpTPATR         = 6.0;     // indicative target = ATR * this

int      hFast=INVALID_HANDLE, hSlow=INVALID_HANDLE, hATR=INVALID_HANDLE;
datetime g_lastBar=0;
int      g_pubDir=0;     // last published direction: 0 none, 1 long, -1 short
bool     g_adopted=false; // first evaluated bar after a start: take the current regime as known

int OnInit()
{
   hFast=iMA(_Symbol,PERIOD_CURRENT,InpFastEMA,0,MODE_EMA,PRICE_CLOSE);
   hSlow=iMA(_Symbol,PERIOD_CURRENT,InpSlowEMA,0,MODE_EMA,PRICE_CLOSE);
   hATR =iATR(_Symbol,PERIOD_CURRENT,InpATRPeriod);
   if(hFast==INVALID_HANDLE||hSlow==INVALID_HANDLE||hATR==INVALID_HANDLE) return INIT_FAILED;
   SignalLib_Init(Inp_ProjectID, Inp_ApiKey, Inp_Email, Inp_Password);
   Print("[DRIFTSIG] DriftRegime signal EA on ", _Symbol, " ", EnumToString(PERIOD_CURRENT),
         " | EMA ", InpFastEMA, "/", InpSlowEMA, " buffer ", DoubleToString(InpFlipBufferATR,2));
   return INIT_SUCCEEDED;
}
void OnDeinit(const int r){ if(hFast!=INVALID_HANDLE)IndicatorRelease(hFast); if(hSlow!=INVALID_HANDLE)IndicatorRelease(hSlow); if(hATR!=INVALID_HANDLE)IndicatorRelease(hATR); }

double B(int h){ double b[]; return (CopyBuffer(h,0,1,1,b)==1)? b[0] : 0; }

void OnTick()
{
   SignalLib_Prune();                       // keep the live signal's status/price fresh
   datetime t=iTime(_Symbol,PERIOD_CURRENT,0);
   if(t==g_lastBar) return; g_lastBar=t;    // act on bar close

   double f=B(hFast), s=B(hSlow), a=B(hATR);
   if(f==0||s==0||a==0) return;
   double band=InpFlipBufferATR*a;
   int regime=0;
   if(f > s+band) regime=1;
   else if(f < s-band) regime=-1;           // else neutral -> keep current published signal

   // After a (re)start the regime on the chart is not a flip: it was announced (or missed)
   // before. Adopt it silently; announcing it again would look like a fresh signal (and
   // be auto-traded). Only regime changes from here on are published.
   if(!g_adopted)
   {
      g_adopted=true;
      if(regime!=0) g_pubDir=regime;
      Print("[DRIFTSIG] start: current regime ", (regime==1 ? "BUY" : (regime==-1 ? "SELL" : "neutral")),
            " on ", _Symbol, " taken as known - only a flip from here on is published");
      return;
   }

   if(regime==0 || regime==g_pubDir) return;   // no flip

   int digits=(int)SymbolInfoInteger(_Symbol,SYMBOL_DIGITS);
   double ask=SymbolInfoDouble(_Symbol,SYMBOL_ASK), bid=SymbolInfoDouble(_Symbol,SYMBOL_BID);
   bool goLong=(regime==1);
   double entry = goLong? ask : bid;
   double sl    = goLong? entry-InpSLATR*a : entry+InpSLATR*a;
   double tp    = goLong? entry+InpTPATR*a : entry-InpTPATR*a;

   bool ok = PublishSignal(_Symbol, goLong?"BUY":"SELL",
                           NormalizeDouble(entry,digits), NormalizeDouble(sl,digits), NormalizeDouble(tp,digits),
                           Inp_Lots, Inp_Source, Inp_Confidence, Inp_ExpiryMin*60);
   if(ok){ g_pubDir=regime;
           Print("[DRIFTSIG] FLIP -> ", (goLong?"BUY":"SELL"), " ", _Symbol, " entry ", DoubleToString(entry,digits),
                 " SL ", DoubleToString(sl,digits), " TP ", DoubleToString(tp,digits)); }
   else    Print("[DRIFTSIG] publish failed");
}
//+------------------------------------------------------------------+
