//+------------------------------------------------------------------+
//| NewsSignal_EA — generates DIRECTIONAL trade signals from economic |
//| news "surprises" (actual vs forecast) on the Forex Factory feed   |
//| and publishes them to Firebase /signals for the Command0r app.    |
//|                                                                   |
//| Model: when a whitelisted high-impact event releases and its      |
//| ACTUAL beats/misses FORECAST past a threshold, the affected       |
//| currency is judged strong/weak, and we emit BUY/SELL signals on   |
//| the pairs that currency touches (direction derived from each      |
//| symbol's base/quote, so gold XAUUSD reacts inversely to USD).     |
//| ALERT-ONLY: publishes to the Signals feed + push notification;    |
//| the user executes manually from the app.                          |
//|                                                                   |
//| REQUIRES: whitelist  https://nfs.faireconomy.media  in            |
//| Tools > Options > Expert Advisors (Firebase hosts already are).   |
//| Attach to ONE chart on the HFM terminal (runs off its own timer). |
//+------------------------------------------------------------------+
#property strict
#include "SignalLib.mqh"   // shared Firebase auth + PublishSignal(...) + JAson

input string Inp_ProjectID      = "c0mmand3r";
input string Inp_ApiKey         = "AIzaSyCA3LUdogLeo7wdHEfxfPQtG4EG2SqEFtg";
input string Inp_Email          = "";        // blank = shared cred file
input string Inp_Password       = "";        // blank = shared cred file
input string Inp_FeedURL        = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
input string Inp_Symbols        = "EURUSD,GBPUSD,USDJPY,XAUUSD,AUDUSD,USDCAD,NZDUSD,USDCHF"; // universe to signal
input string Inp_MinImpact      = "High";    // "High" or "High,Medium"
input double Inp_MinSurprisePct = 3.0;       // min |actual-forecast|/|forecast| % to fire
input int    Inp_ReactWindowMin = 10;        // only fire if the event released within the last N min
input int    Inp_ExpiryMinutes  = 30;        // how long the signal stays live in the app
input double Inp_Lots           = 0.01;      // suggested lots (app re-sizes by risk %)
input int    Inp_ATRPeriod      = 14;
input ENUM_TIMEFRAMES Inp_ATRTF = PERIOD_M15;
input double Inp_SLMult         = 2.0;        // SL = ATR * mult (news moves are large)
input double Inp_RR             = 1.5;        // TP = SL distance * RR
input double Inp_FallbackSLPct  = 0.15;       // SL = price*this% if ATR unavailable
input int    Inp_FastPollSec    = 30;         // poll cadence near an event
input int    Inp_SlowPollSec    = 600;        // poll cadence when no event is near
input int    Inp_NearWindowMin  = 20;         // "near" = a high-impact event within +/- this many min

//--- state ---------------------------------------------------------
string g_signaled[];     // event keys already evaluated (primed or fired) -> never re-fire
string g_symList[];      // parsed Inp_Symbols
string g_atrSym[];       // ATR handle cache (symbol)
int    g_atrHnd[];       // ATR handle cache (handle)
bool   g_nearEvent=false;

//==================================================================
//  JSON helpers (same focused parser as NewsFeed_EA)
//==================================================================
string JStr(const string src, const string name)
{
   int p = StringFind(src, "\""+name+"\":");
   if(p < 0) return "";
   p += StringLen(name) + 3;
   while(p < StringLen(src) && StringGetCharacter(src,p)==' ') p++;
   if(p >= StringLen(src)) return "";
   if(StringGetCharacter(src,p) != '"')
   {
      int e=p;
      while(e < StringLen(src)){ ushort c=StringGetCharacter(src,e); if(c==',' || c=='}') break; e++; }
      string raw=StringSubstr(src,p,e-p);
      StringTrimLeft(raw); StringTrimRight(raw);
      if(raw=="null") return "";
      return raw;
   }
   p++;
   int q=p;
   while(q < StringLen(src)){ ushort c=StringGetCharacter(src,q); if(c=='"' && StringGetCharacter(src,q-1)!='\\') break; q++; }
   return StringSubstr(src, p, q-p);
}

long IsoToUtc(const string iso)
{
   if(StringLen(iso) < 19) return 0;
   MqlDateTime dt; ZeroMemory(dt);
   dt.year = (int)StringToInteger(StringSubstr(iso,0,4));
   dt.mon  = (int)StringToInteger(StringSubstr(iso,5,2));
   dt.day  = (int)StringToInteger(StringSubstr(iso,8,2));
   dt.hour = (int)StringToInteger(StringSubstr(iso,11,2));
   dt.min  = (int)StringToInteger(StringSubstr(iso,14,2));
   dt.sec  = (int)StringToInteger(StringSubstr(iso,17,2));
   long local = (long)StructToTime(dt);
   long off = 0;
   string tail = StringSubstr(iso, 19);
   int sp = -1; int sign = 1;
   for(int i=0;i<StringLen(tail);i++){ ushort c=StringGetCharacter(tail,i); if(c=='+'){sp=i;sign=1;break;} if(c=='-'){sp=i;sign=-1;break;} }
   if(sp >= 0)
   {
      int oh = (int)StringToInteger(StringSubstr(tail, sp+1, 2));
      int om = (int)StringToInteger(StringSubstr(tail, sp+4, 2));
      off = sign * (oh*3600 + om*60);
   }
   return local - off;
}

//==================================================================
//  Number parsing: "236K"->236000, "3.2%"->3.2, "-0.1%"->-0.1
//==================================================================
double ParseNewsValue(string s, bool &ok)
{
   ok = false;
   StringTrimLeft(s); StringTrimRight(s);
   if(s=="") return 0.0;
   StringReplace(s, ",", "");
   StringReplace(s, "%", "");
   StringReplace(s, "$", "");
   StringReplace(s, "<", ""); StringReplace(s, ">", "");
   StringTrimLeft(s); StringTrimRight(s);
   if(s=="") return 0.0;
   double mult = 1.0;
   int L = StringLen(s);
   ushort last = StringGetCharacter(s, L-1);
   if(last=='K'||last=='k'){ mult=1e3;  s=StringSubstr(s,0,L-1); }
   else if(last=='M'||last=='m'){ mult=1e6;  s=StringSubstr(s,0,L-1); }
   else if(last=='B'||last=='b'){ mult=1e9;  s=StringSubstr(s,0,L-1); }
   else if(last=='T'||last=='t'){ mult=1e12; s=StringSubstr(s,0,L-1); }
   StringTrimLeft(s); StringTrimRight(s);
   bool hasDigit=false;
   for(int i=0;i<StringLen(s);i++){ ushort c=StringGetCharacter(s,i); if(c>='0'&&c<='9'){ hasDigit=true; break; } }
   if(!hasDigit) return 0.0;
   ok = true;
   return StringToDouble(s) * mult;
}

//==================================================================
//  Indicator direction map.  +1 : higher actual  => stronger currency
//                            -1 : higher actual  => weaker currency (inverted)
//                             0 : not whitelisted => skip (don't guess)
//==================================================================
int IndicatorSign(const string titleRaw)
{
   string t = titleRaw; StringToUpper(t);
   // --- inverted (higher = weaker currency) ---
   if(StringFind(t,"UNEMPLOYMENT RATE")>=0)    return -1;
   if(StringFind(t,"JOBLESS")>=0)              return -1;
   if(StringFind(t,"UNEMPLOYMENT CLAIMS")>=0)  return -1;
   if(StringFind(t,"INITIAL CLAIMS")>=0)       return -1;
   if(StringFind(t,"CONTINUING CLAIMS")>=0)    return -1;
   if(StringFind(t,"MISERY")>=0)               return -1;
   // --- normal (higher = stronger currency) ---
   if(StringFind(t,"CPI")>=0)                  return  1;
   if(StringFind(t,"INFLATION")>=0)            return  1;
   if(StringFind(t,"PPI")>=0)                  return  1;
   if(StringFind(t,"GDP")>=0)                  return  1;
   if(StringFind(t,"RETAIL SALES")>=0)         return  1;
   if(StringFind(t,"PMI")>=0)                  return  1;
   if(StringFind(t,"ISM")>=0)                  return  1;
   if(StringFind(t,"NON-FARM")>=0)             return  1;
   if(StringFind(t,"NONFARM")>=0)              return  1;
   if(StringFind(t,"PAYROLL")>=0)              return  1;
   if(StringFind(t,"EMPLOYMENT CHANGE")>=0)    return  1;
   if(StringFind(t,"INTEREST RATE")>=0)        return  1;
   if(StringFind(t,"RATE DECISION")>=0)        return  1;
   if(StringFind(t,"CASH RATE")>=0)            return  1;
   if(StringFind(t,"OFFICIAL BANK RATE")>=0)   return  1;
   if(StringFind(t,"RETAIL")>=0)               return  1;
   if(StringFind(t,"DURABLE GOODS")>=0)        return  1;
   if(StringFind(t,"INDUSTRIAL PRODUCTION")>=0)return  1;
   if(StringFind(t,"TRADE BALANCE")>=0)        return  1;
   if(StringFind(t,"CURRENT ACCOUNT")>=0)      return  1;
   if(StringFind(t,"CONFIDENCE")>=0)           return  1;
   if(StringFind(t,"SENTIMENT")>=0)            return  1;
   if(StringFind(t,"IFO")>=0)                  return  1;
   if(StringFind(t,"ZEW")>=0)                  return  1;
   if(StringFind(t,"WAGE")>=0)                 return  1;
   if(StringFind(t,"EARNINGS")>=0)             return  1;
   if(StringFind(t,"AVERAGE HOURLY")>=0)       return  1;
   return 0;   // unknown -> skip
}

//==================================================================
//  small utilities
//==================================================================
bool AlreadySignaled(const string key)
{
   for(int i=0;i<ArraySize(g_signaled);i++) if(g_signaled[i]==key) return true;
   return false;
}
void MarkSignaled(const string key)
{
   int n=ArraySize(g_signaled); ArrayResize(g_signaled,n+1); g_signaled[n]=key;
}
bool ImpactAllowed(const string imp)
{
   string want = Inp_MinImpact; StringToUpper(want);
   string i = imp; StringToUpper(i);
   if(StringFind(want, i) >= 0 && i!="") return true;
   return false;
}
bool SymbolAvailable(const string sym)
{
   return (SymbolInfoInteger(sym, SYMBOL_DIGITS) > 0);
}
double GetAtr(const string sym)
{
   int idx=-1;
   for(int i=0;i<ArraySize(g_atrSym);i++) if(g_atrSym[i]==sym){ idx=i; break; }
   if(idx<0)
   {
      int h = iATR(sym, Inp_ATRTF, Inp_ATRPeriod);
      if(h==INVALID_HANDLE) return 0.0;
      int n=ArraySize(g_atrSym); ArrayResize(g_atrSym,n+1); ArrayResize(g_atrHnd,n+1);
      g_atrSym[n]=sym; g_atrHnd[n]=h; idx=n;
   }
   double buf[];
   if(CopyBuffer(g_atrHnd[idx], 0, 1, 1, buf) < 1) return 0.0;
   return buf[0];
}

//==================================================================
//  Publish signals for one released event
//==================================================================
void EmitForEvent(const string currency, const int strength, const int confidence, const string title)
{
   for(int i=0;i<ArraySize(g_symList);i++)
   {
      string sym = g_symList[i];
      if(!SymbolAvailable(sym)) continue;
      string base  = SymbolInfoString(sym, SYMBOL_CURRENCY_BASE);
      string quote = SymbolInfoString(sym, SYMBOL_CURRENCY_PROFIT);
      int side = 0;   // +1 BUY, -1 SELL
      if(currency==base)       side = (strength>0)?  1 : -1;   // base strengthens -> buy the pair
      else if(currency==quote) side = (strength>0)? -1 :  1;   // quote strengthens -> sell the pair
      else continue;                                           // symbol not affected by this currency

      double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
      double bid = SymbolInfoDouble(sym, SYMBOL_BID);
      if(ask<=0 || bid<=0) continue;
      double entry = (side>0)? ask : bid;
      double atr = GetAtr(sym);
      double slDist = (atr>0)? atr*Inp_SLMult : entry*(Inp_FallbackSLPct/100.0)*Inp_SLMult;
      if(slDist<=0) continue;
      double sl, tp;
      if(side>0){ sl = entry - slDist;            tp = entry + slDist*Inp_RR; }
      else      { sl = entry + slDist;            tp = entry - slDist*Inp_RR; }

      string action = (side>0)? "BUY" : "SELL";
      PublishSignal(sym, action, entry, sl, tp, Inp_Lots, "News", confidence, Inp_ExpiryMinutes*60);
   }
}

//==================================================================
//  Fetch + process the feed.  primeOnly=true : just mark existing
//  actuals as seen (no signals) so a fresh attach doesn't replay
//  the whole day's releases.
//==================================================================
void ProcessFeed(bool primeOnly)
{
   if(!SignalLib_EnsureAuth()){ if(!primeOnly) Print("NewsSignal: no auth, skip"); return; }

   char post[], res[]; string hdr;
   ResetLastError();
   int r = WebRequest("GET", Inp_FeedURL, NULL, 15000, post, res, hdr);
   if(r == -1){ Print("NewsSignal: WebRequest failed err=", GetLastError(), " (whitelist ", Inp_FeedURL, "?)"); return; }
   if(r != 200){ Print("NewsSignal: HTTP ", r); return; }
   string body = CharArrayToString(res, 0, WHOLE_ARRAY, CP_UTF8);

   string b = body;
   int lb = StringFind(b,"["); int rb = StringFind(b,"]");
   if(lb >= 0 && rb > lb) b = StringSubstr(b, lb+1, rb-lb-1);
   string elems[]; int ec=0; ArrayResize(elems,0);
   int start=0;
   for(int i=0;i+2 < StringLen(b); i++)
      if(StringGetCharacter(b,i)=='}' && StringGetCharacter(b,i+1)==',' && StringGetCharacter(b,i+2)=='{')
      { ArrayResize(elems, ec+1); elems[ec++] = StringSubstr(b, start, i-start+1); start = i+2; }
   ArrayResize(elems, ec+1); elems[ec++] = StringSubstr(b, start);

   long now = (long)TimeGMT();
   long nearest = -1;
   int fired=0;

   for(int i=0;i<ec;i++)
   {
      string e = elems[i];
      if(StringFind(e,"\"title\"") < 0) continue;
      string title = JStr(e,"title");
      string cur   = JStr(e,"country");
      string imp   = JStr(e,"impact");
      string act   = JStr(e,"actual");
      string fc    = JStr(e,"forecast");
      string pv    = JStr(e,"previous");
      long   ts    = IsoToUtc(JStr(e,"date"));
      if(ts<=0 || cur=="") continue;
      if(!ImpactAllowed(imp)) continue;

      // track nearest high-impact event for adaptive polling
      long d = (ts>now)? ts-now : now-ts;
      if(nearest<0 || d<nearest) nearest=d;

      string key = IntegerToString((int)ts) + "_" + cur + "_" + title;
      if(act=="") continue;                 // not released yet
      if(AlreadySignaled(key)) continue;    // seen before

      // At attach (prime) OR for actuals that released outside the react window,
      // record as seen but DON'T fire.
      bool recent = (now - ts) <= (long)Inp_ReactWindowMin*60 && (ts - now) <= 120;
      if(primeOnly || !recent){ MarkSignaled(key); continue; }

      // --- surprise ---
      int isign = IndicatorSign(title);
      if(isign==0){ MarkSignaled(key); continue; }        // not a whitelisted indicator
      bool oka=false, okf=false;
      double av = ParseNewsValue(act, oka);
      double fv = ParseNewsValue(fc,  okf);
      if(!okf){ fv = ParseNewsValue(pv, okf); }           // fall back to previous
      if(!oka || !okf){ MarkSignaled(key); continue; }
      double denom = MathMax(MathAbs(fv), 1e-6);
      double relPct = MathAbs(av - fv) / denom * 100.0;
      int dir = (av>fv)? 1 : ((av<fv)? -1 : 0);
      if(dir==0 || relPct < Inp_MinSurprisePct){ MarkSignaled(key); continue; }

      int strength = dir * isign;                          // +1 currency strong, -1 weak
      int conf = (int)MathRound(MathMin(95.0, 40.0 + relPct*3.0));
      Print("NewsSignal: ", cur, " ", title, "  act=", act, " fc=", fc,
            "  surprise=", DoubleToString(relPct,1), "%  -> ", (strength>0?"STRONG":"WEAK"), " conf=", conf);
      EmitForEvent(cur, strength, conf, title);
      MarkSignaled(key);
      fired++;
   }

   // adaptive re-arm: fast poll when a high-impact event is within the near window
   g_nearEvent = (nearest>=0 && nearest <= (long)Inp_NearWindowMin*60);
   int nextSec = g_nearEvent ? Inp_FastPollSec : Inp_SlowPollSec;
   EventKillTimer(); EventSetTimer(MathMax(15, nextSec));
   if(!primeOnly && fired>0) Print("NewsSignal: emitted signals for ", fired, " event(s)");
}

//==================================================================
int OnInit()
{
   SignalLib_Init(Inp_ProjectID, Inp_ApiKey, Inp_Email, Inp_Password);
   // parse symbol universe
   ArrayResize(g_symList,0);
   string parts[]; int n = StringSplit(Inp_Symbols, ',', parts);
   for(int i=0;i<n;i++){ string s=parts[i]; StringTrimLeft(s); StringTrimRight(s); if(s!=""){ int k=ArraySize(g_symList); ArrayResize(g_symList,k+1); g_symList[k]=s; SymbolSelect(s,true); } }
   ProcessFeed(true);                 // prime: mark existing actuals as seen (no signals)
   EventSetTimer(Inp_FastPollSec);    // ProcessFeed re-arms adaptively after each run
   Print("NewsSignal_EA started. Universe=", Inp_Symbols, "  impact=", Inp_MinImpact, "  minSurprise=", Inp_MinSurprisePct, "%");
   return INIT_SUCCEEDED;
}
void OnTimer(){ ProcessFeed(false); }
void OnDeinit(const int reason)
{
   EventKillTimer();
   for(int i=0;i<ArraySize(g_atrHnd);i++) if(g_atrHnd[i]!=INVALID_HANDLE) IndicatorRelease(g_atrHnd[i]);
}
void OnTick(){}
//+------------------------------------------------------------------+
