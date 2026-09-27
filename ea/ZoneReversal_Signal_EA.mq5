//+------------------------------------------------------------------+
//| ZoneReversal_Signal_EA — you draw supply/demand zones per symbol  |
//| in the Command0r app; this EA watches price interact with those   |
//| zones and publishes BUY/SELL SIGNALS (alert-only) to Firebase     |
//| /signals for you to execute manually (market or stop).            |
//|                                                                   |
//| Direction is AUTO from price position: a zone below price = demand |
//| (long bias), above price = supply (short bias). Confirmations     |
//| (any enabled one fires): rejection (wick in + close out),         |
//| sweep+reclaim (wick through far edge + close back in), engulfing.  |
//| Target = the next zone in the trade direction (fallback R:R).     |
//|                                                                   |
//| Reads zones from /zones/{account}. One instance watches ALL your  |
//| zoned symbols available on this terminal. Attach to ONE chart.    |
//| Uses the shared Firebase auth + PublishSignal in SignalLib.mqh.   |
//+------------------------------------------------------------------+
#property strict
#include "SignalLib.mqh"

input string          Inp_ProjectID   = "c0mmand3r";
input string          Inp_ApiKey      = "AIzaSyCA3LUdogLeo7wdHEfxfPQtG4EG2SqEFtg";
input string          Inp_Email       = "";
input string          Inp_Password    = "";
input ENUM_TIMEFRAMES Inp_ConfirmTF   = PERIOD_M5;   // timeframe that confirms the zone reaction
input int             Inp_RefreshSec  = 60;          // how often to re-read zones from Firebase
input bool            Inp_UseRejection= true;        // wick into zone + close back out
input bool            Inp_UseSweep    = true;        // wick through far edge + reclaim (strongest)
input bool            Inp_UseEngulf   = true;        // engulfing candle at the zone
input double          Inp_SLBufferATR = 0.5;         // SL padding beyond the zone = ATR * this
input double          Inp_MinRR       = 2.0;         // fallback TP R:R when no target zone ahead
input double          Inp_Lots        = 0.01;        // suggested lots (app re-sizes by risk %)
input int             Inp_ExpiryMin   = 120;         // how long the signal stays live in the app
input int             Inp_ATRPeriod   = 14;
input bool            Inp_EnableAlerts     = true;  // push alerts: zone approached / entered / broken
input bool            Inp_AlertApproach    = true;
input bool            Inp_AlertEnter       = true;
input bool            Inp_AlertCross       = true;
input double          Inp_ApproachATR      = 0.5;   // "near" = within this many ATRs of a zone edge
input double          Inp_RearmATR         = 1.5;   // alert again only after price has moved this many ATRs away
input int             Inp_AlertCooldownMin = 30;    // and at least this many minutes between repeat alerts for one zone
input int             Inp_StatusPushSec    = 10;    // refresh cadence of the app's live zone chart
input int             Inp_ChartBars        = 96;    // bars sent to the app chart

//--- cached zones (parallel arrays, one row per zoned symbol) ---
string   g_fbKey[];    // Firebase key of each zones node (zonestatus is written under the same key)
string   g_sym[];      // real symbol name
string   g_zones[];    // raw "H:L|H:L|..." string
bool     g_active[];
long     g_expire[];
datetime g_lastForming[];  // last seen forming-bar open time per symbol (new-bar detector)
datetime g_lastZoneFetch = 0;

//========================= JSON helpers =============================
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
      string raw=StringSubstr(src,p,e-p); StringTrimLeft(raw); StringTrimRight(raw);
      if(raw=="null") return "";
      return raw;
   }
   p++;
   int q=p;
   while(q < StringLen(src)){ ushort c=StringGetCharacter(src,q); if(c=='"' && StringGetCharacter(src,q-1)!='\\') break; q++; }
   return StringSubstr(src, p, q-p);
}

// split a JSON object's direct children that are themselves objects -> keys[]/objs[]
int FirstLevelObjects(const string body, string &keys[], string &objs[])
{
   ArrayResize(keys,0); ArrayResize(objs,0);
   int n=StringLen(body), cnt=0;
   int i=StringFind(body,"{"); if(i<0) return 0;
   i++;
   while(i<n)
   {
      while(i<n){ ushort c=StringGetCharacter(body,i); if(c==' '||c=='\n'||c=='\r'||c=='\t'||c==',') i++; else break; }
      if(i>=n || StringGetCharacter(body,i)=='}') break;
      if(StringGetCharacter(body,i)!='"'){ i++; continue; }
      i++; int ks=i;
      while(i<n && !(StringGetCharacter(body,i)=='"' && StringGetCharacter(body,i-1)!='\\')) i++;
      string key=StringSubstr(body,ks,i-ks); i++;
      while(i<n && StringGetCharacter(body,i)!=':') i++;
      i++;
      while(i<n){ ushort c=StringGetCharacter(body,i); if(c==' '||c=='\n'||c=='\r'||c=='\t') i++; else break; }
      if(i>=n) break;
      if(StringGetCharacter(body,i)=='{')
      {
         int depth=0, os=i; bool instr=false;
         while(i<n)
         {
            ushort c=StringGetCharacter(body,i);
            if(instr){ if(c=='"' && StringGetCharacter(body,i-1)!='\\') instr=false; }
            else { if(c=='"') instr=true; else if(c=='{') depth++; else if(c=='}'){ depth--; if(depth==0){ i++; break; } } }
            i++;
         }
         ArrayResize(keys,cnt+1); ArrayResize(objs,cnt+1); keys[cnt]=key; objs[cnt]=StringSubstr(body,os,i-os); cnt++;
      }
      else
      {
         bool instr=false;
         while(i<n){ ushort c=StringGetCharacter(body,i);
            if(instr){ if(c=='"'&&StringGetCharacter(body,i-1)!='\\') instr=false; }
            else { if(c=='"') instr=true; else if(c==','||c=='}') break; } i++; }
      }
   }
   return cnt;
}

int ParseZones(const string z, double &zh[], double &zl[])
{
   ArrayResize(zh,0); ArrayResize(zl,0);
   string parts[]; int n=StringSplit(z,'|',parts), c=0;
   for(int i=0;i<n;i++)
   {
      string p=parts[i]; StringTrimLeft(p); StringTrimRight(p); if(p=="") continue;
      string hl[]; int m=StringSplit(p,':',hl); if(m<2) continue;
      double a=StringToDouble(hl[0]), b=StringToDouble(hl[1]);
      if(a<=0 && b<=0) continue;
      ArrayResize(zh,c+1); ArrayResize(zl,c+1); zh[c]=MathMax(a,b); zl[c]=MathMin(a,b); c++;
   }
   return c;
}

//========================= zone fetch ==============================
void FetchZones()
{
   if(!SignalLib_EnsureAuth()){ Print("Zones: no auth"); return; }
   string url = "https://" + g_sl_projectId + "-default-rtdb.firebaseio.com/zones/" + g_sl_accountId + ".json?auth=" + g_sl_idToken;
   char post[], res[]; string hdr;
   int r = WebRequest("GET", url, NULL, 8000, post, res, hdr);
   if(r != 200){ if(r!=-1) Print("Zones: GET HTTP ", r); return; }
   string body = CharArrayToString(res, 0, WHOLE_ARRAY, CP_UTF8);
   string keys[], objs[];
   int n = (StringLen(body) < 5 || body=="null") ? 0 : FirstLevelObjects(body, keys, objs);

   // a symbol removed in the app -> drop its live zonestatus node too
   for(int k=0;k<ArraySize(g_fbKey);k++)
   {
      bool still=false;
      for(int i=0;i<n;i++) if(keys[i]==g_fbKey[k]){ still=true; break; }
      if(!still) QueueZoneStatus(g_fbKey[k], "null");
   }
   // preserve existing per-symbol new-bar state by symbol name
   string oldSym[]; datetime oldForm[]; ArrayCopy(oldSym,g_sym); ArrayCopy(oldForm,g_lastForming);
   ArrayResize(g_sym,n); ArrayResize(g_zones,n); ArrayResize(g_active,n); ArrayResize(g_expire,n); ArrayResize(g_lastForming,n);
   ArrayResize(g_fbKey,n);
   for(int i=0;i<n;i++)
   {
      string sym = JStr(objs[i], "symbol"); if(sym=="") sym=keys[i];
      g_fbKey[i]   = keys[i];
      g_sym[i]     = sym;
      g_zones[i]   = JStr(objs[i], "zones");
      string act   = JStr(objs[i], "active");
      g_active[i]  = (act=="" || act=="true" || act=="1");
      g_expire[i]  = (long)StringToInteger(JStr(objs[i], "expiresAt"));
      g_lastForming[i] = 0;
      for(int k=0;k<ArraySize(oldSym);k++) if(oldSym[k]==sym){ g_lastForming[i]=oldForm[k]; break; }
   }
   Print("Zones: loaded ", n, " symbol(s) from Firebase");
}

//========================= evaluation ==============================
double CalcATR(const MqlRates &rt[], int cnt, int period)
{
   int use = MathMin(period, cnt-1); if(use < 1) return 0;
   double sum=0;
   for(int i=cnt-use; i<cnt; i++)
   {
      double h=rt[i].high, l=rt[i].low, pc=rt[i-1].close;
      sum += MathMax(h-l, MathMax(MathAbs(h-pc), MathAbs(l-pc)));
   }
   return sum/use;
}

//========================= zone monitor state ======================
// Per zone, keyed "symbol|high|low": last proximity state, last closed-bar side
// (for "broken" detection), last event for the app, and alert cooldowns.
string   g_zk[];
string   g_zst[];      // far / near / inside ("" = not observed yet)
int      g_zside[];    // +1 closed above the zone, -1 below, 0 unknown
string   g_zev[];      // approached / entered / crossed / signal
long     g_zevAt[];    // UTC
datetime g_zApprAt[];
datetime g_zEntAt[];
bool     g_zArmA[];    // approach alert armed (re-armed once price is Inp_RearmATR away)
bool     g_zArmE[];    // "entered" alert armed

int ZIdx(const string k)
{
   for(int i=0;i<ArraySize(g_zk);i++) if(g_zk[i]==k) return i;
   int n=ArraySize(g_zk);
   ArrayResize(g_zk,n+1); ArrayResize(g_zst,n+1); ArrayResize(g_zside,n+1); ArrayResize(g_zev,n+1);
   ArrayResize(g_zevAt,n+1); ArrayResize(g_zApprAt,n+1); ArrayResize(g_zEntAt,n+1);
   ArrayResize(g_zArmA,n+1); ArrayResize(g_zArmE,n+1);
   g_zk[n]=k; g_zst[n]=""; g_zside[n]=0; g_zev[n]=""; g_zevAt[n]=0; g_zApprAt[n]=0; g_zEntAt[n]=0;
   g_zArmA[n]=false; g_zArmE[n]=false;
   return n;
}
string ZKey(const string sym, const double hi, const double lo, const int dg)
{
   return sym + "|" + DoubleToString(hi,dg) + "|" + DoubleToString(lo,dg);
}
void ZoneEvent(const int zi, const string ev) { g_zev[zi]=ev; g_zevAt[zi]=(long)TimeGMT(); }

// Per symbol: last zonestatus push (time + price) and last closed bar seen.
string   g_mk[];
datetime g_mPushAt[];
double   g_mPushPx[];
datetime g_mBar[];
int MIdx(const string s)
{
   for(int i=0;i<ArraySize(g_mk);i++) if(g_mk[i]==s) return i;
   int n=ArraySize(g_mk);
   ArrayResize(g_mk,n+1); ArrayResize(g_mPushAt,n+1); ArrayResize(g_mPushPx,n+1); ArrayResize(g_mBar,n+1);
   g_mk[n]=s; g_mPushAt[n]=0; g_mPushPx[n]=0; g_mBar[n]=0;
   return n;
}

// zonestatus entries queued this timer tick; sent as ONE root-level multi-path
// PATCH (short URL for the ~1024-char WebRequest limit, one round-trip for all symbols).
string g_zsBatch = "";
void QueueZoneStatus(const string fbKey, const string json)
{
   if(g_zsBatch != "") g_zsBatch += ",";
   g_zsBatch += "\"" + g_sl_accountId + "/" + fbKey + "\":" + json;
}
void FlushZoneStatus()
{
   if(g_zsBatch == "") return;
   if(!SignalLib_EnsureAuth()) return;                         // keep the batch; retry next tick
   string body = "{" + g_zsBatch + "}";
   g_zsBatch = "";
   string url = "https://" + g_sl_projectId + "-default-rtdb.firebaseio.com/zonestatus.json?auth=" + g_sl_idToken;
   char post[]; StringToCharArray(body, post, 0, StringLen(body), CP_UTF8);
   char res[]; string hdr;
   int code = WebRequest("PATCH", url, "Content-Type: application/json\r\n", 8000, post, res, hdr);
   if(code != 200) Print("Zones: zonestatus push HTTP ", code);
}

string TfName(const ENUM_TIMEFRAMES tf) { string s=EnumToString(tf); StringReplace(s,"PERIOD_",""); return s; }

// Zone alert push; tapping it opens the app's Zones screen on this symbol.
// Its own source ("Zone alerts") so the app can mute these without muting the
// zone SIGNALS; symbol mutes and quiet hours apply via SignalLib_NotifyFor.
void ZoneAlert(const string sym, const string title, const string body)
{
   if(!Inp_EnableAlerts) return;
   Print("Zones: alert  ", title, "  |  ", body);
   SignalLib_NotifyFor("Zone alerts", sym, title, body,
                       "{\"screen\":\"zones\",\"symbol\":\"" + SignalLib_JsonEsc(sym) +
                       "\",\"account\":\"" + g_sl_accountId + "\"}");
}

// resolve a possibly mis-cased/space-trimmed name to the broker's exact symbol
string ResolveSymbol(const string name)
{
   if(name=="") return "";
   if(SymbolInfoInteger(name, SYMBOL_DIGITS) > 0) return name;   // exact match
   string want=name; StringTrimLeft(want); StringTrimRight(want); StringToLower(want);
   int total=SymbolsTotal(false);
   for(int i=0;i<total;i++){ string s=SymbolName(i,false); string sl=s; StringToLower(sl); if(sl==want) return s; }
   return "";
}

// publish this terminal's available symbols to /symbols/{account} for the app's autocomplete
datetime g_lastSymPub = 0;
void PublishSymbolList()
{
   if(!SignalLib_EnsureAuth()) return;
   int total=SymbolsTotal(false); string arr="[";
   for(int i=0;i<total;i++){ string s=SymbolName(i,false); StringReplace(s,"\\","\\\\"); StringReplace(s,"\"","\\\""); if(i>0) arr+=","; arr+="\""+s+"\""; }
   arr+="]";
   string url="https://"+g_sl_projectId+"-default-rtdb.firebaseio.com/symbols/"+g_sl_accountId+".json?auth="+g_sl_idToken;
   char pd[]; StringToCharArray(arr, pd, 0, StringLen(arr), CP_UTF8); char res[]; string hdr;
   int r=WebRequest("PUT", url, "Content-Type: application/json\r\n", 8000, pd, res, hdr);
   Print("Zones: published ", total, " symbols to /symbols (HTTP ", r, ")");
}

void EvaluateSymbol(const int si)
{
   if(!g_active[si]) return;
   if(g_expire[si] > 0 && (long)TimeGMT() > g_expire[si]) return;
   string sym = ResolveSymbol(g_sym[si]);
   if(sym == "") return;                                       // symbol not on this terminal
   SymbolSelect(sym, true);

   datetime forming = (datetime)SeriesInfoInteger(sym, Inp_ConfirmTF, SERIES_LASTBAR_DATE);
   if(forming == 0) return;
   if(g_lastForming[si] == forming) return;                    // no new bar yet
   bool first = (g_lastForming[si]==0);
   g_lastForming[si] = forming;
   if(first) return;                                           // don't fire on the very first sight

   double zh[], zl[]; int nz = ParseZones(g_zones[si], zh, zl);
   if(nz == 0) return;

   MqlRates rt[]; ArraySetAsSeries(rt, false);
   int need = Inp_ATRPeriod + 3;
   if(CopyRates(sym, Inp_ConfirmTF, 1, need, rt) < need) return;   // shift1..needed closed bars, chronological
   int L = ArraySize(rt)-1;                                    // last closed bar (shift 1)
   double o=rt[L].open, h=rt[L].high, l=rt[L].low, c=rt[L].close;
   double po=rt[L-1].open, pc=rt[L-1].close;                   // prior bar body
   double atr = CalcATR(rt, ArraySize(rt), Inp_ATRPeriod); if(atr<=0) return;

   double bid=SymbolInfoDouble(sym,SYMBOL_BID), ask=SymbolInfoDouble(sym,SYMBOL_ASK);
   if(bid<=0||ask<=0) return;
   double px=(bid+ask)/2.0;
   int digits=(int)SymbolInfoInteger(sym,SYMBOL_DIGITS);

   // pick the best (highest-confidence) confirmation across all zones
   int    best_dir=0; double best_entry=0, best_sl=0; int best_conf=0; int best_zone=-1; string best_kind="";
   for(int z=0; z<nz; z++)
   {
      double Zh=zh[z], Zl=zl[z], mid=(Zh+Zl)/2.0;
      bool demand = (px >= mid);                               // AUTO from price position
      int dir=0, conf=0; string kind="";
      if(demand)
      {
         bool interact = (l <= Zh);                            // bar reached into/under the zone
         bool sweep    = Inp_UseSweep     && (l <  Zl) && (c > Zl);
         bool reject   = Inp_UseRejection && interact && (c > Zh);
         bool engulf   = Inp_UseEngulf    && (c > o) && (c >= pc) && (o <= po) && interact; // bullish engulf
         if(sweep || reject || engulf)
         {
            dir=1;
            if(sweep){ conf=80; kind="sweep"; } else if(engulf){ conf=65; kind="engulf"; } else { conf=55; kind="reject"; }
         }
      }
      else
      {
         bool interact = (h >= Zl);
         bool sweep    = Inp_UseSweep     && (h >  Zh) && (c < Zh);
         bool reject   = Inp_UseRejection && interact && (c < Zl);
         bool engulf   = Inp_UseEngulf    && (c < o) && (c <= pc) && (o >= po) && interact; // bearish engulf
         if(sweep || reject || engulf)
         {
            dir=-1;
            if(sweep){ conf=80; kind="sweep"; } else if(engulf){ conf=65; kind="engulf"; } else { conf=55; kind="reject"; }
         }
      }
      if(dir==0) continue;

      double entry = (dir>0)? ask : bid;
      double buf   = atr*Inp_SLBufferATR;
      double sl    = (dir>0)? (MathMin(Zl,l)-buf) : (MathMax(Zh,h)+buf);
      if((dir>0 && sl>=entry) || (dir<0 && sl<=entry)) continue;
      if(conf > best_conf){ best_conf=conf; best_dir=dir; best_entry=entry; best_sl=sl; best_zone=z; best_kind=kind; }
   }
   if(best_dir==0) return;

   // TP = nearest zone in the trade direction; else fallback R:R
   double tp=0; double risk=MathAbs(best_entry-best_sl);
   if(best_dir>0)
   {
      double bestLow=DBL_MAX;
      for(int z=0;z<nz;z++) if(zl[z] > best_entry && zl[z] < bestLow) bestLow=zl[z];
      tp = (bestLow<DBL_MAX)? bestLow : best_entry + risk*Inp_MinRR;
   }
   else
   {
      double bestHigh=-DBL_MAX;
      for(int z=0;z<nz;z++) if(zh[z] < best_entry && zh[z] > bestHigh) bestHigh=zh[z];
      tp = (bestHigh>-DBL_MAX)? bestHigh : best_entry - risk*Inp_MinRR;
   }
   double rr = (risk>0)? MathAbs(tp-best_entry)/risk : 0;
   if(rr < 0.5) return;                                         // reject terrible targets
   int conf = (int)MathMin(95.0, best_conf + MathMin(15.0, rr*5.0));

   string action = (best_dir>0)? "BUY" : "SELL";
   Print("Zones: ", sym, " ", action, " (", best_kind, ") entry=", DoubleToString(best_entry,digits),
         " sl=", DoubleToString(best_sl,digits), " tp=", DoubleToString(tp,digits), " rr=", DoubleToString(rr,1), " conf=", conf);
   ZoneEvent(ZIdx(ZKey(sym, zh[best_zone], zl[best_zone], digits)), "signal");
   PublishSignal(sym, action, best_entry, best_sl, tp, Inp_Lots, "Zones", conf, Inp_ExpiryMin*60, best_kind);
}

//========================= zone monitor ============================
// Every timer tick: per zone compute role / proximity / distance, alert on
// far->near ("approached") and ->inside ("entered"), detect breaks on CLOSED
// bars ("crossed"), and publish zonestatus/{account}/{key} for the app chart.
void MonitorSymbol(const int si)
{
   if(!g_active[si]) return;
   if(g_expire[si] > 0 && (long)TimeGMT() > g_expire[si]) return;
   string sym = ResolveSymbol(g_sym[si]);
   if(sym == "") return;                                       // not on this terminal
   SymbolSelect(sym, true);

   double zh[], zl[]; int nz = ParseZones(g_zones[si], zh, zl);
   if(nz == 0) return;

   MqlRates rt[]; ArraySetAsSeries(rt, false);
   int got = CopyRates(sym, Inp_ConfirmTF, 0, MathMax(Inp_ChartBars, Inp_ATRPeriod + 3), rt);  // incl. forming bar
   if(got < Inp_ATRPeriod + 3) return;
   double atr = CalcATR(rt, got - 1, Inp_ATRPeriod);           // closed bars only
   if(atr <= 0) return;

   double bid=SymbolInfoDouble(sym,SYMBOL_BID), ask=SymbolInfoDouble(sym,SYMBOL_ASK);
   if(bid<=0 || ask<=0) return;
   double px  = (bid+ask)/2.0;
   int    dg  = (int)SymbolInfoInteger(sym,SYMBOL_DIGITS);
   double thr = atr * Inp_ApproachATR;

   int mi = MIdx(sym);
   datetime closedT = rt[got-2].time;                          // last CLOSED bar
   bool newBar     = (g_mBar[mi] != closedT);
   bool firstSight = (g_mBar[mi] == 0);
   g_mBar[mi] = closedT;
   double lastClose = rt[got-2].close;
   datetime now = TimeGMT();

   string zonesJson = "";
   for(int z=0; z<nz; z++)
   {
      double H=zh[z], L=zl[z], mid=(H+L)/2.0;
      string role  = (px >= mid) ? "demand" : "supply";
      double dist  = (px>=L && px<=H) ? 0.0 : (px > H ? px-H : L-px);
      string state = (dist == 0.0) ? "inside" : (dist <= thr ? "near" : "far");
      int zi = ZIdx(ZKey(sym,H,L,dg));
      bool first = (g_zst[zi] == "");
      string band = DoubleToString(L,dg) + " - " + DoubleToString(H,dg);

      // One alert per approach: re-arm only once price has moved well away
      // (Inp_RearmATR), so chop around the "near" line or between stacked zones
      // doesn't repeat. Already close at start-up (restart / new zone) = quiet.
      if(dist > atr * Inp_RearmATR) { g_zArmA[zi] = true; g_zArmE[zi] = true; }
      else if(first)                { g_zArmA[zi] = false; g_zArmE[zi] = false; }
      int cooldown = Inp_AlertCooldownMin * 60;
      if(state == "near" && g_zArmA[zi])
      {
         g_zArmA[zi] = false; ZoneEvent(zi, "approached");
         if(Inp_AlertApproach && now - g_zApprAt[zi] >= cooldown)
         {
            g_zApprAt[zi] = now;
            ZoneAlert(sym, sym + ": approaching " + role + " zone",
                      band + "  |  price " + DoubleToString(px,dg) + " (" + DoubleToString(dist/atr,1) + "x ATR away)");
         }
      }
      if(state == "inside" && g_zArmE[zi])
      {
         g_zArmE[zi] = false; g_zArmA[zi] = false; ZoneEvent(zi, "entered");
         if(Inp_AlertEnter && now - g_zEntAt[zi] >= cooldown)
         {
            g_zEntAt[zi] = now;
            ZoneAlert(sym, sym + ": testing " + role + " zone", band + "  |  price is in the zone - watch for a reaction");
         }
      }
      g_zst[zi] = state;

      if(newBar)                                               // broken = a close on the opposite side
      {
         int side = (lastClose > H) ? 1 : ((lastClose < L) ? -1 : 0);
         if(!firstSight && side != 0 && g_zside[zi] != 0 && side != g_zside[zi])
         {
            ZoneEvent(zi, "crossed");
            if(Inp_AlertCross)
               ZoneAlert(sym, sym + ": zone broken",
                         band + " closed " + (side<0 ? "below" : "above") + " - now acting as " + (side<0 ? "supply" : "demand"));
         }
         if(side != 0) g_zside[zi] = side;
      }

      if(zonesJson != "") zonesJson += ",";
      zonesJson += "{\"high\":" + DoubleToString(H,dg) + ",\"low\":" + DoubleToString(L,dg) +
                   ",\"role\":\"" + role + "\",\"state\":\"" + state + "\",\"dist\":" + DoubleToString(dist,dg) +
                   ",\"distAtr\":" + DoubleToString(dist/atr,2) + ",\"lastEvent\":\"" + g_zev[zi] +
                   "\",\"lastEventAt\":" + IntegerToString(g_zevAt[zi]) + "}";
   }

   // Live chart feed for the app: every Inp_StatusPushSec while price moves,
   // once a minute when it doesn't (market closed) so "updated" stays fresh.
   bool moved = newBar || (px != g_mPushPx[mi]);
   if(now - g_mPushAt[mi] < (moved ? Inp_StatusPushSec : 60)) return;
   g_mPushAt[mi] = now; g_mPushPx[mi] = px;
   long off = (long)TimeTradeServer() - (long)TimeGMT();       // broker server offset
   off = (long)MathRound(off / 900.0) * 900;
   string candles = "";
   int from = MathMax(0, got - Inp_ChartBars);
   for(int b=from; b<got; b++)
   {
      if(candles != "") candles += ",";
      candles += "[" + IntegerToString((long)rt[b].time - off) + "," + DoubleToString(rt[b].open,dg) + "," +
                 DoubleToString(rt[b].high,dg) + "," + DoubleToString(rt[b].low,dg) + "," + DoubleToString(rt[b].close,dg) + "]";
   }
   string node = "{\"symbol\":\"" + SignalLib_JsonEsc(sym) + "\",\"price\":" + DoubleToString(px,dg) +
                 ",\"digits\":" + IntegerToString(dg) + ",\"atr\":" + DoubleToString(atr,dg) +
                 ",\"tf\":\"" + TfName(Inp_ConfirmTF) + "\",\"updated\":" + IntegerToString((long)now) +
                 ",\"candles\":[" + candles + "],\"zones\":[" + zonesJson + "]}";
   QueueZoneStatus(g_fbKey[si], node);
}

//========================= lifecycle ===============================
int OnInit()
{
   SignalLib_Init(Inp_ProjectID, Inp_ApiKey, Inp_Email, Inp_Password);
   // TimeGMT, not TimeCurrent: TimeCurrent freezes while the market is closed,
   // which would stop zone refreshes (and the app chart) all weekend.
   FetchZones(); g_lastZoneFetch = TimeGMT();
   PublishSymbolList(); g_lastSymPub = TimeGMT();
   EventSetTimer(5);
   Print("ZoneReversal_Signal_EA started. TF=", EnumToString(Inp_ConfirmTF));
   return INIT_SUCCEEDED;
}
void OnTimer()
{
   if(TimeGMT() - g_lastZoneFetch >= Inp_RefreshSec){ FetchZones(); g_lastZoneFetch = TimeGMT(); }
   if(TimeGMT() - g_lastSymPub >= 1800){ PublishSymbolList(); g_lastSymPub = TimeGMT(); }  // refresh symbol list ~30min
   for(int i=0;i<ArraySize(g_sym);i++) MonitorSymbol(i);   // proximity alerts + live chart feed
   FlushZoneStatus();
   for(int i=0;i<ArraySize(g_sym);i++) EvaluateSymbol(i);  // confirmation signals (once per new bar)
   SignalLib_Prune();   // remove hit/expired signals from the feed (same as the other signal EAs)
}
void OnDeinit(const int reason){ EventKillTimer(); }
void OnTick(){}
//+------------------------------------------------------------------+
