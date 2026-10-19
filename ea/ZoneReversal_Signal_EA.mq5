//+------------------------------------------------------------------+
//| ZoneReversal_Signal_EA — you draw supply/demand zones per symbol  |
//| in the Command0r app; this EA watches price interact with those   |
//| zones and publishes BUY/SELL SIGNALS (alert-only) to Firebase     |
//| /signals for you to execute manually (market or stop).            |
//|                                                                   |
//| Direction is AUTO from price position: a zone below price = demand |
//| (long bias), above price = supply (short bias). ONE "Zones" stream |
//| of confirmations (since 2026-10-05, the user's choice):           |
//|  choch / bos (A) - M3 structure turns inside the zone: price made  |
//|           its low/high in the zone, then the first M3 close beyond |
//|           the last swing before it. CHoCH when price came in       |
//|           making lower highs (higher lows), BOS when it came in as |
//|           a pullback still making higher highs (lower lows)        |
//|  engulf (B) - a real M5 engulfing candle (body covers the prior)   |
//|  sweep  (B) - pierce the far edge (stop run), no acceptance beyond |
//|           it, then a strong M5 candle closes back beyond the zone  |
//|           and breaks the highs/lows made since                     |
//|  reject (off) - wick into the zone, M5 close back out: dropped,    |
//|           it lost on the approved zones (PF 0.75, Oct 1-5 test)    |
//| An engulfing whose candle broke through the far edge is grade C.  |
//| Every signal carries the grade, H1 trend (info) and touch number. |
//| One live signal per symbol: the first confirmation wins, repeat   |
//| triggers wait until it hits TP/SL or expires.                     |
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
// (Inputs renamed 2026-10-05: an attached EA keeps its saved values, so changed defaults need new names.)
input bool            Inp_RejectSetup = false;       // M5 rejection (wick into zone + close back out): off - lost on the approved zones
input bool            Inp_UseSweep    = true;        // stop run through the far edge + reclaim + displacement + structure break
input int             Inp_SweepLookback = 6;         // bars back to look for the sweep candle
input double          Inp_DisplaceATR = 0.5;         // "strong" candle = body of at least this many ATRs
input bool            Inp_UseEngulf   = true;        // real engulfing candle at the zone
input bool            Inp_UseStructure = true;       // structure turn inside the zone: CHoCH or BOS (grade A)
input ENUM_TIMEFRAMES Inp_StructTF    = PERIOD_M3;   // timeframe of the CHoCH / BOS
input int             Inp_StructLookback = 40;       // bars scanned for the low/high made in the zone
input double          Inp_StructSLBufferATR = 0.25;  // CHoCH/BOS stop beyond that low/high = M5 ATR * this
input ENUM_TIMEFRAMES Inp_TrendTF     = PERIOD_H1;   // trend shown on each signal (close vs rising/falling EMA)
input int             Inp_TrendEMA    = 50;
input bool            Inp_TrendInGrade = false;      // true = counter-trend signals drop one grade
input double          Inp_TouchLeaveATR = 1.0;       // a new zone touch counts only after price left by this many ATRs
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
input int             Inp_RetireCrossings  = 2;     // retire a zone once price has closed through it this many times since the morning refresh (0 = never); the zone-refresh watcher then replaces it

//--- cached zones (parallel arrays, one row per zoned symbol) ---
string   g_fbKey[];    // Firebase key of each zones node (zonestatus is written under the same key)
string   g_sym[];      // real symbol name
string   g_zones[];    // raw "H:L|H:L|..." string
bool     g_active[];
long     g_expire[];
datetime g_lastForming[];  // last seen forming-bar open time per symbol (new-bar detector)
datetime g_lastLtf[];      // same for the structure (CHoCH / BOS) timeframe
string   g_setAt[];        // "setAt" of the zone set (written by the morning zone refresh; unchanged by same-day replacements)
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

// The {...} object that is the value of "key" (first occurrence), or "" if missing / not an object.
string JObjectFor(const string body, const string key)
{
   int p = StringFind(body, "\"" + key + "\":");
   if(p < 0) return "";
   int s = p + StringLen(key) + 3, n = StringLen(body);
   while(s < n && StringGetCharacter(body, s) == ' ') s++;
   if(s >= n || StringGetCharacter(body, s) != '{') return "";
   int depth = 0; bool inStr = false;
   for(int i = s; i < n; i++)
   {
      ushort c = StringGetCharacter(body, i);
      if(inStr) { if(c == '\\') { i++; continue; } if(c == '"') inStr = false; continue; }
      if(c == '"') inStr = true;
      else if(c == '{') depth++;
      else if(c == '}') { depth--; if(depth == 0) return StringSubstr(body, s, i - s + 1); }
   }
   return "";
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
   string base = "https://" + g_sl_projectId + "-default-rtdb.firebaseio.com/";
   string url = base + "zones/" + g_sl_accountId + ".json?auth=" + g_sl_idToken;
   // MQL's WebRequest fails on URLs over ~1020 chars (the ~905-char token is in the query);
   // with a long account id (e.g. Swyft Markets, 60 chars) read the parent node and pick
   // this account out of it.
   bool viaParent = (StringLen(url) > 1015);
   if(viaParent) url = base + "zones.json?auth=" + g_sl_idToken;
   char post[], res[]; string hdr;
   int r = WebRequest("GET", url, NULL, 8000, post, res, hdr);
   if(r != 200){ if(r!=-1) Print("Zones: GET HTTP ", r); return; }
   string body = CharArrayToString(res, 0, WHOLE_ARRAY, CP_UTF8);
   if(viaParent) body = JObjectFor(body, g_sl_accountId);     // "" when this account has no zones yet
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
   string oldSym[]; datetime oldForm[], oldLtf[]; ArrayCopy(oldSym,g_sym); ArrayCopy(oldForm,g_lastForming); ArrayCopy(oldLtf,g_lastLtf);
   ArrayResize(g_sym,n); ArrayResize(g_zones,n); ArrayResize(g_active,n); ArrayResize(g_expire,n); ArrayResize(g_lastForming,n);
   ArrayResize(g_lastLtf,n);
   ArrayResize(g_fbKey,n);
   ArrayResize(g_setAt,n);
   for(int i=0;i<n;i++)
   {
      string sym = JStr(objs[i], "symbol"); if(sym=="") sym=keys[i];
      g_fbKey[i]   = keys[i];
      g_sym[i]     = sym;
      g_zones[i]   = JStr(objs[i], "zones");
      string act   = JStr(objs[i], "active");
      g_active[i]  = (act=="" || act=="true" || act=="1");
      g_expire[i]  = (long)StringToInteger(JStr(objs[i], "expiresAt"));
      g_setAt[i]   = JStr(objs[i], "setAt");
      g_lastForming[i] = 0; g_lastLtf[i] = 0;
      for(int k=0;k<ArraySize(oldSym);k++) if(oldSym[k]==sym){ g_lastForming[i]=oldForm[k]; if(k<ArraySize(oldLtf)) g_lastLtf[i]=oldLtf[k]; break; }
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
datetime g_zSweepAt[]; // sweep candle already signalled (one signal per sweep)
datetime g_zStructAt[]; // low/high in the zone already signalled as a CHoCH / BOS (one per visit)
int      g_zCross[];   // closes through the zone (side flips) since the morning refresh
bool     g_zRetired[]; // choppy: crossed Inp_RetireCrossings times -> no signals / alerts / app chart until the next set
string   g_zSet[];     // setAt the counts belong to

int ZIdx(const string k)
{
   for(int i=0;i<ArraySize(g_zk);i++) if(g_zk[i]==k) return i;
   int n=ArraySize(g_zk);
   ArrayResize(g_zk,n+1); ArrayResize(g_zst,n+1); ArrayResize(g_zside,n+1); ArrayResize(g_zev,n+1);
   ArrayResize(g_zevAt,n+1); ArrayResize(g_zApprAt,n+1); ArrayResize(g_zEntAt,n+1);
   ArrayResize(g_zArmA,n+1); ArrayResize(g_zArmE,n+1); ArrayResize(g_zSweepAt,n+1); ArrayResize(g_zStructAt,n+1);
   ArrayResize(g_zCross,n+1); ArrayResize(g_zRetired,n+1); ArrayResize(g_zSet,n+1);
   g_zk[n]=k; g_zst[n]=""; g_zside[n]=0; g_zev[n]=""; g_zevAt[n]=0; g_zApprAt[n]=0; g_zEntAt[n]=0;
   g_zArmA[n]=false; g_zArmE[n]=false; g_zSweepAt[n]=0; g_zStructAt[n]=0;
   g_zCross[n]=0; g_zRetired[n]=false; g_zSet[n]="";
   return n;
}

//========================= choppy-zone retirement ===================
// A zone price keeps closing through is noise (alternating BUY/SELL signals, repeat
// alerts). Once it has been crossed Inp_RetireCrossings times since the morning
// refresh it is retired: no signals, no alerts, not a target, off the app chart.
// The EA can't touch TradingView drawings, so it asks the zone-refresh watcher to
// replace the zone (one line in MT5's shared Common\Files folder). Backtest, 14 days:
// retiring after 2 crossings halved the signals (2927 -> 1546) and lifted PF 0.99 -> 1.03.

// Counts belong to the zone set published by the morning refresh ("setAt"); the next
// morning's set starts every zone at 0 again. Same-day replacements keep setAt, so
// the zones that stay keep their counts.
void SyncZoneSet(const int zi, const string setAt)
{
   if(g_zSet[zi] == setAt) return;
   g_zSet[zi] = setAt; g_zCross[zi] = 0; g_zRetired[zi] = false;
}

// Drop today's retired zones from a parsed zone list (setups, CHoCH and targets ignore them).
int ActiveZones(const int si, const string sym, const int dg, double &zh[], double &zl[])
{
   int n = ArraySize(zh), k = 0;
   for(int z = 0; z < n; z++)
   {
      int zi = ZIdx(ZKey(sym, zh[z], zl[z], dg));
      SyncZoneSet(zi, g_setAt[si]);
      if(g_zRetired[zi]) continue;
      zh[k] = zh[z]; zl[k] = zl[z]; k++;
   }
   ArrayResize(zh, k); ArrayResize(zl, k);
   return k;
}

#define ZR_FILE "zone_requests.txt"
void RequestZoneRefresh(const string sym, const double H, const double L, const int dg, const int crossings)
{
   int h = FileOpen(ZR_FILE, FILE_READ|FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_COMMON|FILE_SHARE_READ|FILE_SHARE_WRITE);
   if(h == INVALID_HANDLE) { Print("Zones: could not write the zone refresh request (err ", GetLastError(), ")"); return; }
   FileSeek(h, 0, SEEK_END);
   FileWriteString(h, g_sl_accountId + "|" + sym + "|" + DoubleToString(H, dg) + "|" + DoubleToString(L, dg) + "|" +
                      IntegerToString((long)TimeGMT()) + "|" + IntegerToString(crossings) + "\r\n");
   FileClose(h);
}

//========================= zone touches (freshness) =================
// Visits to each zone since the EA first saw it (first touch is the strongest in
// supply/demand teaching; each retest uses up resting orders). A new touch counts
// only after price has left the zone by Inp_TouchLeaveATR. Persisted so restarts
// keep the counts. Signals are labelled with it; grading waits for our own data.
#define ZT_FILE "zone_touches.csv"
string g_tk[]; int g_tN[]; bool g_tArm[]; string g_tSaved = "";

int TIdx(const string k, const bool insideNow)
{
   for(int i=0;i<ArraySize(g_tk);i++) if(g_tk[i]==k) return i;
   int n = ArraySize(g_tk);
   ArrayResize(g_tk,n+1); ArrayResize(g_tN,n+1); ArrayResize(g_tArm,n+1);
   g_tk[n] = k; g_tN[n] = insideNow ? 1 : 0; g_tArm[n] = !insideNow;   // first seen inside = 1st touch in progress
   return n;
}
void SaveTouchesIfChanged()
{
   string s = "";
   for(int i=0;i<ArraySize(g_tk);i++) s += g_tk[i] + ";" + IntegerToString(g_tN[i]) + ";" + (g_tArm[i] ? "1" : "0") + "\n";
   if(s == g_tSaved) return;
   int h = FileOpen(ZT_FILE, FILE_WRITE|FILE_BIN);
   if(h == INVALID_HANDLE) return;
   uchar buf[]; int len = StringToCharArray(s, buf, 0, StringLen(s), CP_UTF8);
   if(len > 0) FileWriteArray(h, buf, 0, len);
   FileClose(h);
   g_tSaved = s;
}
void LoadTouches()
{
   int h = FileOpen(ZT_FILE, FILE_READ|FILE_BIN);
   if(h == INVALID_HANDLE) return;
   int sz = (int)FileSize(h); uchar buf[];
   if(sz > 0){ ArrayResize(buf, sz); FileReadArray(h, buf, 0, sz); }
   FileClose(h);
   if(sz <= 0) return;
   string lines[]; int n = StringSplit(CharArrayToString(buf, 0, sz, CP_UTF8), '\n', lines);
   for(int i=0;i<n;i++)
   {
      string f[]; if(StringSplit(lines[i], ';', f) < 3) continue;
      int k = TIdx(f[0], false);
      g_tN[k] = (int)StringToInteger(f[1]); g_tArm[k] = (f[2] == "1");
   }
   SaveTouchesIfChanged();   // sets g_tSaved
   Print("Zones: touch counts restored for ", ArraySize(g_tk), " zone(s)");
}
string TouchLabel(const int t){ return t <= 1 ? "1st touch" : (t == 2 ? "2nd touch" : "3rd+ touch"); }

//========================= trend + grade ============================
// H1 trend on CLOSED bars: +1 = close above a rising EMA, -1 = below a falling one, 0 = flat.
int TrendDir(const string sym)
{
   MqlRates r[]; ArraySetAsSeries(r, false);
   int n = CopyRates(sym, Inp_TrendTF, 1, Inp_TrendEMA * 3, r);
   if(n < Inp_TrendEMA + 6) return 0;
   double a = 2.0 / (Inp_TrendEMA + 1.0), e = r[0].close, e5 = r[0].close;
   for(int i = 1; i < n; i++)
   {
      e = a * r[i].close + (1.0 - a) * e;
      if(i == n - 6) e5 = e;
   }
   if(r[n-1].close > e && e > e5) return 1;
   if(r[n-1].close < e && e < e5) return -1;
   return 0;
}

// Grades (the user's choice, 2026-10-05, after a walk-forward test on the 265 zones they
// approved Oct 1-5, first signal per move): structure turning inside the zone is A
// (M3 CHoCH PF 1.36, n=56; BOS too few to judge yet); engulfing and sweep are B (PF 1.73
// and 1.26); an engulfing whose candle broke through the zone's far edge is C. The M5
// rejection lost there (PF 0.75, n=208) and is off by default (C if switched back on).
// The H1 trend is NOT in the grade by default; Inp_TrendInGrade = true demotes
// counter-trend signals one grade. align: +1 with the H1 trend, -1 against, 0 flat.
void GradeSetup(const string setup, const bool pierced, const int align, string &grade, int &conf)
{
   if(setup == "choch" || setup == "bos") grade = "A";
   else if(setup == "sweep")             grade = "B";
   else if(setup == "engulf")            grade = pierced ? "C" : "B";
   else                                  grade = "C";         // reject
   if(Inp_TrendInGrade && align < 0) grade = (grade == "A") ? "B" : "C";
   conf = (grade == "A") ? 75 : (grade == "B" ? 62 : 48);
}

// How a setup reads in the push / log.
string SetupWord(const string setup)
{
   if(setup == "choch")  return "M3 CHoCH";
   if(setup == "bos")    return "M3 BOS";
   if(setup == "engulf") return "engulfing";
   if(setup == "reject") return "rejection";
   return setup;
}
int GradeRank(const string g){ return g == "A" ? 0 : (g == "B" ? 1 : 2); }

// App setting prefs/signals/zonesMinGrade: push only A, A+B, or every grade (default).
bool GradePushAllowed(const string grade)
{
   SignalLib_LoadPrefs();
   string mg = SignalLib_ExtractJson(g_sl_prefs, "zonesMinGrade");
   if(mg == "A") return grade == "A";
   if(mg == "B") return grade != "C";
   return true;
}
string TrendWord(const int align){ return align > 0 ? "with" : (align < 0 ? "against" : "flat"); }
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
   // Root multi-path PATCH ("symbols/<account>": list) = a PUT of that node through a short URL
   // (symbols/<long account id>.json?auth=<token> is over MQL's ~1020-char WebRequest limit).
   string url="https://"+g_sl_projectId+"-default-rtdb.firebaseio.com/.json?auth="+g_sl_idToken;
   string body="{\"symbols/"+g_sl_accountId+"\":"+arr+"}";
   char pd[]; StringToCharArray(body, pd, 0, StringLen(body), CP_UTF8); char res[]; string hdr;
   int r=WebRequest("PATCH", url, "Content-Type: application/json\r\n", 8000, pd, res, hdr);
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
   int need = MathMax(Inp_ATRPeriod + 3, Inp_SweepLookback + 3);
   if(CopyRates(sym, Inp_ConfirmTF, 1, need, rt) < need) return;   // shift1..needed closed bars, chronological
   int L = ArraySize(rt)-1;                                    // last closed bar (shift 1)
   double o=rt[L].open, h=rt[L].high, l=rt[L].low, c=rt[L].close;
   double po=rt[L-1].open, pc=rt[L-1].close, ph=rt[L-1].high, pl=rt[L-1].low;   // prior bar
   double atr = CalcATR(rt, ArraySize(rt), Inp_ATRPeriod); if(atr<=0) return;

   double bid=SymbolInfoDouble(sym,SYMBOL_BID), ask=SymbolInfoDouble(sym,SYMBOL_ASK);
   if(bid<=0||ask<=0) return;
   double px=(bid+ask)/2.0;
   int digits=(int)SymbolInfoInteger(sym,SYMBOL_DIGITS);
   nz = ActiveZones(si, sym, digits, zh, zl);                  // today's retired (choppy) zones are out
   if(nz == 0) return;
   int trend = 99;                                             // H1 trend, fetched only if a setup fires

   // best candidate across zones: better grade first, then higher confidence
   int b_dir=0, b_conf=-1, b_zone=-1, b_zi=-1, b_align=0; double b_entry=0, b_sl=0;
   string b_setup="", b_grade=""; datetime b_sweepT=0;
   for(int z=0; z<nz; z++)
   {
      double Zh=zh[z], Zl=zl[z], mid=(Zh+Zl)/2.0;
      bool demand = (px >= mid);                               // AUTO from price position
      int dir = demand ? 1 : -1;
      int zi = ZIdx(ZKey(sym, Zh, Zl, digits));
      bool reject=false, engulf=false, sweep=false; double sweepExt=0; datetime sweepT=0;
      if(demand)
      {
         bool interact = (l <= Zh);                            // bar reached into/under the zone
         reject = Inp_RejectSetup && interact && c > Zh;       // tagged the zone, closed back above it
         // REAL bullish engulfing at the zone: prior candle bearish, this body covers its whole body
         engulf = Inp_UseEngulf && pc < po && c > o && o <= pc && c >= po && (interact || pl <= Zh);
         // Liquidity sweep: a candle in the lookback ran the stops under the zone (low < far edge),
         // price never closed below that low since (no acceptance), and NOW a strong bull candle
         // closes back above the zone AND above every high made since the sweep (structure break).
         if(Inp_UseSweep)
         {
            int ks = -1;
            for(int k = L; k >= MathMax(1, L - Inp_SweepLookback + 1); k--)
               if(rt[k].low < Zl && (ks < 0 || rt[k].low < rt[ks].low)) ks = k;
            if(ks >= 0 && rt[ks].time != g_zSweepAt[zi])
            {
               bool held = true;
               for(int k = ks + 1; k <= L; k++) if(rt[k].close < rt[ks].low) { held = false; break; }
               double swing = (ks < L) ? rt[ks].high : ph;     // highs since the sweep (or the prior candle)
               for(int k = ks + 1; k < L; k++) swing = MathMax(swing, rt[k].high);
               sweep = held && c > o && (c - o) >= Inp_DisplaceATR * atr && c > Zh && c > swing;
               if(sweep) { sweepExt = rt[ks].low; sweepT = rt[ks].time; }
            }
         }
      }
      else
      {
         bool interact = (h >= Zl);
         reject = Inp_RejectSetup && interact && c < Zl;
         engulf = Inp_UseEngulf && pc > po && c < o && o >= pc && c <= po && (interact || ph >= Zl);
         if(Inp_UseSweep)
         {
            int ks = -1;
            for(int k = L; k >= MathMax(1, L - Inp_SweepLookback + 1); k--)
               if(rt[k].high > Zh && (ks < 0 || rt[k].high > rt[ks].high)) ks = k;
            if(ks >= 0 && rt[ks].time != g_zSweepAt[zi])
            {
               bool held = true;
               for(int k = ks + 1; k <= L; k++) if(rt[k].close > rt[ks].high) { held = false; break; }
               double swing = (ks < L) ? rt[ks].low : pl;
               for(int k = ks + 1; k < L; k++) swing = MathMin(swing, rt[k].low);
               sweep = held && c < o && (o - c) >= Inp_DisplaceATR * atr && c < Zl && c < swing;
               if(sweep) { sweepExt = rt[ks].high; sweepT = rt[ks].time; }
            }
         }
      }
      if(!reject && !engulf && !sweep) continue;

      if(trend == 99) trend = TrendDir(sym);
      int align = trend * dir;                                 // +1 with the H1 trend, -1 against, 0 flat
      bool pierced = demand ? (l < Zl) : (h > Zh);            // candle breached the zone's far edge
      // Graded by the candle's most specific pattern. A candle that is BOTH an engulfing
      // and a rejection counts as an engulfing (B): in the simulation those did no better
      // than plain rejections (PF 0.53 vs 1.58 first signal per move), so no confluence bonus.
      string setup = sweep ? "sweep" : (engulf ? "engulf" : "reject");
      string grade; int conf;
      GradeSetup(setup, pierced, align, grade, conf);

      double entry = (dir>0)? ask : bid;
      double buf   = atr*Inp_SLBufferATR;
      double sl    = sweep ? ((dir>0) ? sweepExt - buf : sweepExt + buf)          // beyond the stop run
                           : ((dir>0) ? MathMin(Zl,l) - buf : MathMax(Zh,h) + buf);
      if((dir>0 && sl>=entry) || (dir<0 && sl<=entry)) continue;
      if(b_dir==0 || GradeRank(grade) < GradeRank(b_grade) || (GradeRank(grade) == GradeRank(b_grade) && conf > b_conf))
      { b_dir=dir; b_conf=conf; b_zone=z; b_zi=zi; b_align=align; b_entry=entry; b_sl=sl; b_setup=setup; b_grade=grade; b_sweepT=sweepT; }
   }
   if(b_dir==0) return;

   double tp = ZoneTarget(zh, zl, nz, b_dir, b_entry, b_sl);
   double rr = MathAbs(tp-b_entry) / MathMax(MathAbs(b_entry-b_sl), 1e-12);
   if(rr < 0.5) return;                                         // reject terrible targets

   if(b_setup == "sweep") g_zSweepAt[b_zi] = b_sweepT;         // one signal per sweep
   PublishZoneSignal(sym, "Zones", b_setup, b_dir, b_entry, b_sl, tp, b_grade, b_conf, b_align,
                     ZKey(sym, zh[b_zone], zl[b_zone], digits), digits, rr);
}

// TP = nearest zone edge in the trade direction; else fallback R:R.
double ZoneTarget(const double &zh[], const double &zl[], const int nz, const int dir, const double entry, const double sl)
{
   double risk = MathAbs(entry - sl);
   if(dir > 0)
   {
      double best = DBL_MAX;
      for(int z=0;z<nz;z++) if(zl[z] > entry && zl[z] < best) best = zl[z];
      return (best < DBL_MAX) ? best : entry + risk*Inp_MinRR;
   }
   double best = -DBL_MAX;
   for(int z=0;z<nz;z++) if(zh[z] < entry && zh[z] > best) best = zh[z];
   return (best > -DBL_MAX) ? best : entry - risk*Inp_MinRR;
}

// Publish with grade / setup / H1 trend / touch number (to the app card, the push and
// the outcome log for the scorecard); push only if the grade passes the app setting.
// While this source's last signal on the symbol is still open, a repeat trigger is
// skipped instead of silently changing that card's levels: the scorecard then logs
// each signal to TP/SL/expiry, and in the simulation letting later (even higher-grade)
// triggers replace the open one broke the grade order (A fell from PF 1.58 to 1.13).
void PublishZoneSignal(const string sym, const string source, const string setup, const int dir,
                       const double entry, const double sl, const double tp, const string grade,
                       const int conf, const int align, const string zkey, const int digits, const double rr)
{
   int ti = TIdx(zkey, true);
   if(g_tArm[ti]) { g_tN[ti]++; g_tArm[ti] = false; }         // a visit the 5-s monitor didn't catch
   int touch = MathMax(1, g_tN[ti]);
   string action = (dir > 0) ? "BUY" : "SELL";
   if(SignalLib_IsLive(source, sym))
   {
      Print("Zones: ", sym, " ", action, " ", setup, " (grade ", grade, ") skipped - the ", source, " signal on it is still open");
      return;
   }
   string extra = "\"grade\":\"" + grade + "\",\"setup\":\"" + setup + "\",\"trend\":\"" + TrendWord(align) +
                  "\",\"touch\":" + IntegerToString(touch);
   string note  = "Grade " + grade + " - " + SetupWord(setup) + " - " + TouchLabel(touch) + " - " +
                  (align > 0 ? "with H1 trend" : (align < 0 ? "against H1 trend" : "flat H1"));
   bool push = GradePushAllowed(grade);
   Print("Zones: ", sym, " ", action, " [", note, "] entry=", DoubleToString(entry,digits), " sl=", DoubleToString(sl,digits),
         " tp=", DoubleToString(tp,digits), " rr=", DoubleToString(rr,1), " conf=", conf, (push ? "" : " (no push: below grade setting)"));
   ZoneEvent(ZIdx(zkey), "signal");
   PublishSignal(sym, action, entry, sl, tp, Inp_Lots, source, conf, Inp_ExpiryMin*60, setup, extra, push, note);
}

//========================= structure: CHoCH / BOS on M3 =================
// Structure turning INSIDE a zone: demand - price makes its low in the zone, then the
// first M3 candle that CLOSES above the last M3 swing high before that low -> buy, stop
// just under that low (tighter than the zone stop). Labelled by how price came in:
//   CHoCH - that swing high was lower than the one before it (lower highs into the zone:
//           the character changes), BOS - it was higher (a pullback in an up-move: the
//           structure breaks onward). Supply is the mirror image. Same "Zones" stream as
//           the M5 setups, so the first confirmation of a zone move wins.
void EvaluateStructure(const int si)
{
   if(!Inp_UseStructure || !g_active[si]) return;
   if(g_expire[si] > 0 && (long)TimeGMT() > g_expire[si]) return;
   string sym = ResolveSymbol(g_sym[si]);
   if(sym == "") return;
   datetime forming = (datetime)SeriesInfoInteger(sym, Inp_StructTF, SERIES_LASTBAR_DATE);
   if(forming == 0 || g_lastLtf[si] == forming) return;
   bool first = (g_lastLtf[si] == 0);
   g_lastLtf[si] = forming;
   if(first) return;

   double zh[], zl[]; int nz = ParseZones(g_zones[si], zh, zl);
   if(nz == 0) return;
   MqlRates r[]; ArraySetAsSeries(r, false);
   int n = CopyRates(sym, Inp_StructTF, 1, Inp_StructLookback, r);        // closed M3 bars
   if(n < 12) return;
   MqlRates r5[]; ArraySetAsSeries(r5, false);
   if(CopyRates(sym, Inp_ConfirmTF, 1, Inp_ATRPeriod + 3, r5) < Inp_ATRPeriod + 3) return;
   double atr = CalcATR(r5, ArraySize(r5), Inp_ATRPeriod); if(atr <= 0) return;
   double bid=SymbolInfoDouble(sym,SYMBOL_BID), ask=SymbolInfoDouble(sym,SYMBOL_ASK);
   if(bid<=0 || ask<=0) return;
   double px=(bid+ask)/2.0;
   int digits=(int)SymbolInfoInteger(sym,SYMBOL_DIGITS);
   nz = ActiveZones(si, sym, digits, zh, zl);                  // today's retired (choppy) zones are out
   if(nz == 0) return;
   int last = n - 1; double c = r[last].close;
   int trend = 99;

   int b_dir=0, b_zone=-1, b_zi=-1, b_align=0, b_conf=-1; double b_entry=0, b_sl=0;
   string b_grade="", b_setup=""; datetime b_extT=0;
   for(int z=0; z<nz; z++)
   {
      double Zh=zh[z], Zl=zl[z], mid=(Zh+Zl)/2.0;
      bool demand = (px >= mid);
      int dir = demand ? 1 : -1;
      int zi = ZIdx(ZKey(sym, Zh, Zl, digits));
      int kx = 0;                                              // extreme of the move into the zone
      for(int k = 1; k < last; k++) if(demand ? r[k].low < r[kx].low : r[k].high > r[kx].high) kx = k;
      double ext = demand ? r[kx].low : r[kx].high;
      if(demand ? (ext > Zh || ext < Zl - atr) : (ext < Zl || ext > Zh + atr)) continue;   // not in the zone / blew through
      if(last - kx > 20 || kx < 4 || r[kx].time == g_zStructAt[zi]) continue;              // stale / no room / done
      int ksw = -1, ksw0 = -1;                                 // last two swings (fractals) before the extreme
      for(int k = kx - 2; k >= 2; k--)
      {
         bool frac = demand ? (r[k].high > r[k-1].high && r[k].high > r[k-2].high && r[k].high >= r[k+1].high && r[k].high >= r[k+2].high)
                            : (r[k].low  < r[k-1].low  && r[k].low  < r[k-2].low  && r[k].low  <= r[k+1].low  && r[k].low  <= r[k+2].low);
         if(!frac) continue;
         if(ksw < 0) ksw = k;
         else { ksw0 = k; break; }
      }
      if(ksw < 0) continue;
      double lvl = demand ? r[ksw].high : r[ksw].low;
      bool brokeBefore = false;                                // the FIRST close beyond that swing
      for(int k = kx + 1; k < last; k++) if(demand ? r[k].close > lvl : r[k].close < lvl) { brokeBefore = true; break; }
      if(brokeBefore || !(demand ? c > lvl : c < lvl)) continue;
      // came in as a pullback (that swing beyond the one before it) = BOS, else CHoCH
      bool bos = (ksw0 >= 0) && (demand ? r[ksw].high > r[ksw0].high : r[ksw].low < r[ksw0].low);
      string setup = bos ? "bos" : "choch";

      double entry = demand ? ask : bid;
      double sl = demand ? ext - Inp_StructSLBufferATR * atr : ext + Inp_StructSLBufferATR * atr;
      if((demand && sl >= entry) || (!demand && sl <= entry)) continue;
      if(trend == 99) trend = TrendDir(sym);
      int align = trend * dir; string grade; int conf;
      GradeSetup(setup, false, align, grade, conf);
      if(b_dir==0 || GradeRank(grade) < GradeRank(b_grade) || (GradeRank(grade) == GradeRank(b_grade) && conf > b_conf))
      { b_dir=dir; b_zone=z; b_zi=zi; b_align=align; b_conf=conf; b_entry=entry; b_sl=sl; b_grade=grade; b_setup=setup; b_extT=r[kx].time; }
   }
   if(b_dir == 0) return;
   double tp = ZoneTarget(zh, zl, nz, b_dir, b_entry, b_sl);
   double rr = MathAbs(tp-b_entry) / MathMax(MathAbs(b_entry-b_sl), 1e-12);
   if(rr < 0.5) return;
   g_zStructAt[b_zi] = b_extT;                                  // one structure signal per low/high
   PublishZoneSignal(sym, "Zones", b_setup, b_dir, b_entry, b_sl, tp, b_grade, b_conf, b_align,
                     ZKey(sym, zh[b_zone], zl[b_zone], digits), digits, rr);
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

   // No early return when there are no zones: the chart feed still goes out
   // (empty zones list) so the app can show zone drafts on live candles.
   double zh[], zl[]; int nz = ParseZones(g_zones[si], zh, zl);

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
      SyncZoneSet(zi, g_setAt[si]);
      if(g_zRetired[zi]) continue;                               // retired today: no alerts, off the app chart
      bool first = (g_zst[zi] == "");

      // freshness: a new touch when price enters the zone after having left it
      int ti = TIdx(ZKey(sym,H,L,dg), dist == 0.0);
      if(dist > atr * Inp_TouchLeaveATR) g_tArm[ti] = true;
      else if(dist == 0.0 && g_tArm[ti]) { g_tN[ti]++; g_tArm[ti] = false; }
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
            g_zCross[zi]++;
            if(Inp_RetireCrossings > 0 && g_zCross[zi] >= Inp_RetireCrossings)
            {
               g_zRetired[zi] = true; g_zside[zi] = side; ZoneEvent(zi, "retired");
               RequestZoneRefresh(sym, H, L, dg, g_zCross[zi]);
               Print("Zones: ", sym, " zone ", band, " retired - price closed through it ", g_zCross[zi],
                     "x since the morning refresh; replacement requested");
               if(Inp_AlertCross)
                  ZoneAlert(sym, sym + ": choppy zone retired",
                            band + " - price closed through it " + IntegerToString(g_zCross[zi]) + " times today; a replacement zone is being drawn");
               continue;                                          // off the app chart from now on
            }
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
   LoadTouches();
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
   for(int i=0;i<ArraySize(g_sym);i++) MonitorSymbol(i);   // proximity alerts + live chart feed + touches
   FlushZoneStatus();
   SignalLib_Prune();   // resolve hit/expired signals first, so a new setup isn't blocked by one that just closed
   for(int i=0;i<ArraySize(g_sym);i++) EvaluateSymbol(i);  // M5 setups (once per new M5 bar)
   for(int i=0;i<ArraySize(g_sym);i++) EvaluateStructure(i); // M3 CHoCH / BOS (once per new M3 bar), same stream
   SaveTouchesIfChanged();
}
void OnDeinit(const int reason){ EventKillTimer(); }
void OnTick(){}
//+------------------------------------------------------------------+
