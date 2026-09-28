//+------------------------------------------------------------------+
//| NewsFeed_EA — fetches the Forex Factory weekly economic calendar  |
//| (JSON) and publishes it to Firebase /calendar ({events, updatedAt,|
//| by}) for the Command0r app (News screen) and any news-filter EAs. |
//| Runs 24/7 so the calendar stays fresh even when the app is closed.|
//|                                                                   |
//| Safe to run on BOTH terminals: every few minutes each instance    |
//| checks /calendar/updatedAt and only re-fetches when it is older   |
//| than Inp_RefreshMinutes, so one terminal publishes and the other  |
//| takes over if it goes down. (FF only offers THIS week's feed; the |
//| new week appears when FF rolls it over on Sunday.)                |
//|                                                                   |
//| REQUIRES: whitelist  https://nfs.faireconomy.media  in            |
//| Tools > Options > Expert Advisors > "Allow WebRequest for URL".   |
//| (Firebase hosts are already whitelisted for the other EAs.)       |
//+------------------------------------------------------------------+
#property strict
#include "SignalLib.mqh"   // shared Firebase auth (SignalLib_Init / EnsureAuth / g_sl_idToken / g_sl_projectId)

input string Inp_ProjectID      = "c0mmand3r";
input string Inp_ApiKey         = "AIzaSyCA3LUdogLeo7wdHEfxfPQtG4EG2SqEFtg";
input string Inp_Email          = "";     // blank = shared cred file
input string Inp_Password       = "";     // blank = shared cred file
input string Inp_FeedURL        = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
input int    Inp_RefreshMinutes = 60;     // re-fetch when the published calendar is older than this
input int    Inp_CheckMinutes   = 5;      // how often to check (also the retry delay after a failure)

//--- read one string field  "name":"value"  out of a JSON object slice
string JStr(const string src, const string name)
{
   int p = StringFind(src, "\""+name+"\":");
   if(p < 0) return "";
   p += StringLen(name) + 3;                 // past  "name":
   // skip spaces
   while(p < StringLen(src) && StringGetCharacter(src,p)==' ') p++;
   if(p >= StringLen(src)) return "";
   if(StringGetCharacter(src,p) != '"')      // not a quoted string (null/number) -> read raw token
   {
      int e=p;
      while(e < StringLen(src))
      {
         ushort c=StringGetCharacter(src,e);
         if(c==',' || c=='}') break;
         e++;
      }
      string raw=StringSubstr(src,p,e-p);
      StringTrimLeft(raw); StringTrimRight(raw);
      if(raw=="null") return "";
      return raw;
   }
   p++;                                       // past opening quote
   int q=p;
   while(q < StringLen(src))
   {
      ushort c=StringGetCharacter(src,q);
      if(c=='"' && StringGetCharacter(src,q-1)!='\\') break;
      q++;
   }
   // Undo JSON escaping: FF writes "m\/m" for "m/m" (it was shown with the backslash).
   string v = StringSubstr(src, p, q-p);
   StringReplace(v, "\\/", "/");
   StringReplace(v, "\\\"", "\"");
   StringReplace(v, "\\\\", "\\");
   return v;
}

//--- "2026-09-22T08:30:00-04:00"  ->  UTC unix seconds  (0 if unparseable)
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
   long off = 0;                              // timezone offset after the seconds, e.g. -04:00 or Z
   string tail = StringSubstr(iso, 19);
   int sp = -1; int sign = 1;
   for(int i=0;i<StringLen(tail);i++){ ushort c=StringGetCharacter(tail,i); if(c=='+'){sp=i;sign=1;break;} if(c=='-'){sp=i;sign=-1;break;} }
   if(sp >= 0)
   {
      int oh = (int)StringToInteger(StringSubstr(tail, sp+1, 2));
      int om = (int)StringToInteger(StringSubstr(tail, sp+4, 2));
      off = sign * (oh*3600 + om*60);
   }
   return local - off;                        // UTC = localTimeInFeedTZ - offset
}

string San(string s)   // Firebase key sanitize
{
   StringReplace(s,".","_"); StringReplace(s,"$","_"); StringReplace(s,"#","_");
   StringReplace(s,"[","_"); StringReplace(s,"]","_"); StringReplace(s,"/","_");
   StringReplace(s," ","_"); StringReplace(s,"\"","'"); StringReplace(s,"\\","_");
   if(StringLen(s) > 40) s = StringSubstr(s,0,40);
   return s;
}
string Esc(string s){ StringReplace(s,"\\","\\\\"); StringReplace(s,"\"","\\\""); return s; }

//--- the last fetched FF week (enriched every check with actuals + price reactions)
string g_evKey[], g_evTitle[], g_evCur[];
long   g_evTs[];
int    g_evN = 0;
string g_extraPublished = "";

string FbUrl(const string path){ return "https://" + g_sl_projectId + "-default-rtdb.firebaseio.com/" + path + ".json?auth=" + g_sl_idToken; }

// Which terminal published the current calendar (only that one enriches it).
string CalendarBy()
{
   char post[], res[]; string hdr;
   if(WebRequest("GET", FbUrl("calendar/by"), NULL, 8000, post, res, hdr) != 200) return "";
   string v = CharArrayToString(res, 0, WHOLE_ARRAY, CP_UTF8);
   StringReplace(v, "\"", ""); StringTrimLeft(v); StringTrimRight(v);
   return v;
}

// broker server time = UTC + this (calendar + price history are in server time)
long ServerOffset(){ return (long)MathRound(((long)TimeTradeServer() - (long)TimeGMT()) / 900.0) * 900; }

//--- instruments per currency: must match the app's News screen (CURRENCY_INSTRUMENTS)
string InstrumentsFor(const string cur)
{
   if(cur == "USD") return "XAUUSD,USA30,USA100,EURUSD";
   if(cur == "EUR") return "EURUSD,GER40,FRA40";
   if(cur == "GBP") return "GBPUSD,UK100";
   if(cur == "JPY") return "USDJPY,JPN225";
   if(cur == "AUD") return "AUDUSD";
   if(cur == "CAD") return "USDCAD";
   if(cur == "CHF") return "USDCHF";
   if(cur == "NZD") return "NZDUSD";
   return "";
}

// generic name -> this broker's symbol (EURUSD -> EURUSDb.Z, XAUUSD -> XAUUSDb); cached
string g_rsBase[], g_rsSym[];
string ResolveSym(const string base)
{
   for(int i = 0; i < ArraySize(g_rsBase); i++) if(g_rsBase[i] == base) return g_rsSym[i];
   string best = "";
   for(int pass = 0; pass < 2 && best == ""; pass++)          // Market Watch first, then all symbols
   {
      int total = SymbolsTotal(pass == 0);
      for(int i = 0; i < total; i++)
      {
         string s = SymbolName(i, pass == 0);
         if(StringFind(s, base) != 0) continue;
         if(pass == 0 && SymbolInfoDouble(s, SYMBOL_BID) <= 0) continue;
         if(best == "" || StringLen(s) < StringLen(best)) best = s;
      }
   }
   int n = ArraySize(g_rsBase); ArrayResize(g_rsBase, n + 1); ArrayResize(g_rsSym, n + 1);
   g_rsBase[n] = base; g_rsSym[n] = best;
   if(best != "") SymbolSelect(best, true);
   Print("NewsFeed: instrument ", base, " -> ", (best == "" ? "(not on this broker)" : best));
   return best;
}

bool IsFxPair(const string s)   // EURUSD yes; USA100 / XAUUSD no
{
   if(StringLen(s) != 6 || StringFind(s, "XAU") == 0 || StringFind(s, "XAG") == 0) return false;
   for(int i = 0; i < 6; i++){ ushort c = StringGetCharacter(s, i); if(c < 'A' || c > 'Z') return false; }
   return true;
}

//--- FF title <-> MT5 calendar event name similarity (share of the FF title's words found)
int NameTokens(string s, string &out[])
{
   StringToLower(s);
   StringReplace(s, "m/m", " mom "); StringReplace(s, "y/y", " yoy "); StringReplace(s, "q/q", " qoq ");
   string punct = "()[],.-'/:%&";
   for(int i = 0; i < StringLen(punct); i++) StringReplace(s, StringSubstr(punct, i, 1), " ");
   string parts[]; int n = StringSplit(s, ' ', parts), c = 0;
   ArrayResize(out, 0);
   for(int i = 0; i < n; i++)
   {
      string t = parts[i];
      if(t == "" || t == "the" || t == "of" || t == "and" || t == "s" || t == "a" || t == "in") continue;
      ArrayResize(out, c + 1); out[c++] = t;
   }
   return c;
}
bool HasTok(const string &t[], const string w){ for(int i = 0; i < ArraySize(t); i++) if(t[i] == w) return true; return false; }
double NameScore(const string ff, const string mt)
{
   string a[], b[];
   int na = NameTokens(ff, a); NameTokens(mt, b);
   if(na == 0) return 0;
   int hit = 0;
   for(int i = 0; i < na; i++) if(HasTok(b, a[i])) hit++;
   double sc = (double)hit / na;
   string per[] = {"mom", "yoy", "qoq"};                     // CPI m/m and y/y release together
   for(int p = 0; p < 3; p++)
      if(HasTok(a, per[p]) && !HasTok(b, per[p]) && (HasTok(b, "mom") || HasTok(b, "yoy") || HasTok(b, "qoq"))) sc *= 0.3;
   return sc;
}

string FormatCal(const double v, const MqlCalendarEvent &ev)
{
   string s = DoubleToString(v, (int)ev.digits);
   if(ev.multiplier == CALENDAR_MULTIPLIER_THOUSANDS) s += "K";
   else if(ev.multiplier == CALENDAR_MULTIPLIER_MILLIONS) s += "M";
   else if(ev.multiplier == CALENDAR_MULTIPLIER_BILLIONS) s += "B";
   else if(ev.multiplier == CALENDAR_MULTIPLIER_TRILLIONS) s += "T";
   if(ev.unit == CALENDAR_UNIT_PERCENT) s += "%";
   return s;
}

// Actual value for FF event i from MT5's economic calendar (same currency, same minute,
// best-matching name). impact = what the number meant for the currency.
string g_loggedMatch = "|";
bool LookupActual(const int i, const long srvTime, string &act, string &impact, int &hib)
{
   MqlCalendarValue vals[];
   int n = CalendarValueHistory(vals, (datetime)(srvTime - 120), (datetime)(srvTime + 120), NULL, g_evCur[i]);
   if(n <= 0) return false;
   int best = -1; double bestSc = -1; MqlCalendarEvent bestEv;
   for(int k = 0; k < n; k++)
   {
      MqlCalendarEvent ev;
      if(!CalendarEventById(vals[k].event_id, ev)) continue;
      double sc = NameScore(g_evTitle[i], ev.name);
      if(sc > bestSc){ bestSc = sc; best = k; bestEv = ev; }
   }
   if(best < 0 || bestSc < (n > 1 ? 0.5 : 0.25)) return false;
   if(!vals[best].HasActualValue()) return false;
   act = FormatCal(vals[best].GetActualValue(), bestEv);
   impact = (vals[best].impact_type == CALENDAR_IMPACT_POSITIVE) ? "positive"
          : (vals[best].impact_type == CALENDAR_IMPACT_NEGATIVE) ? "negative" : "";
   // MT5 judges against ITS OWN forecast, but the app shows Forex Factory's. Derive the
   // indicator's direction instead (does a higher number help the currency?) so the app
   // can colour the actual against the forecast it actually displays.
   hib = 0;
   if(impact != "" && vals[best].HasForecastValue())
   {
      double a = vals[best].GetActualValue(), f = vals[best].GetForecastValue();
      if(a != f) hib = ((a > f) == (impact == "positive")) ? 1 : -1;
   }
   if(StringFind(g_loggedMatch, "|" + g_evKey[i] + "|") < 0)
   {
      g_loggedMatch += g_evKey[i] + "|";
      Print("NewsFeed: actual ", g_evCur[i], " '", g_evTitle[i], "' <- MT5 '", bestEv.name, "' score ", DoubleToString(bestSc, 2),
            " = ", act, (vals[best].HasForecastValue() ? " (MT5 forecast " + FormatCal(vals[best].GetForecastValue(), bestEv) + ")" : ""), " ", impact);
   }
   return true;
}

// Close price at server time t (close of the last M1 bar that started before t).
double PriceAt(const MqlRates &r[], const int n, const long t)
{
   for(int j = n - 1; j >= 0; j--) if((long)r[j].time < t) return r[j].close;
   return 0;
}

// How each affected instrument moved 15 and 60 minutes after the release:
// {"EURUSD":{"m15":0.12,"m60":0.25,"p15":13.5,"p60":28.0}, ...} (m = %, p = pips for FX)
string Reactions(const string cur, const long ts, const long off, const long now)
{
   if(now - ts < 15 * 60) return "";
   string list[]; int ni = StringSplit(InstrumentsFor(cur), ',', list);
   string out = ""; long t0 = ts + off;
   for(int q = 0; q < ni; q++)
   {
      string sym = ResolveSym(list[q]);
      if(sym == "") continue;
      MqlRates r[]; ArraySetAsSeries(r, false);
      int n = CopyRates(sym, PERIOD_M1, (datetime)(t0 - 60), (datetime)(t0 + 61 * 60), r);
      if(n <= 0) continue;
      int k0 = -1;
      for(int j = 0; j < n; j++) if((long)r[j].time >= t0){ k0 = j; break; }
      if(k0 < 0 || (long)r[k0].time - t0 > 300) continue;       // market wasn't trading at the release
      double p0 = r[k0].open, p15 = PriceAt(r, n, t0 + 15 * 60);
      double p60 = (now - ts >= 3600) ? PriceAt(r, n, t0 + 60 * 60) : 0;
      if(p0 <= 0 || p15 <= 0) continue;
      int dg = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      double pt = SymbolInfoDouble(sym, SYMBOL_POINT);
      bool fx = IsFxPair(list[q]);
      double pip = (dg == 3 || dg == 5) ? pt * 10 : pt;
      string o = "\"m15\":" + DoubleToString((p15 / p0 - 1) * 100, 3);
      if(p60 > 0) o += ",\"m60\":" + DoubleToString((p60 / p0 - 1) * 100, 3);
      if(fx && pip > 0)
      {
         o += ",\"p15\":" + DoubleToString((p15 - p0) / pip, 1);
         if(p60 > 0) o += ",\"p60\":" + DoubleToString((p60 - p0) / pip, 1);
      }
      if(out != "") out += ",";
      out += "\"" + list[q] + "\":{" + o + "}";
   }
   return out == "" ? "" : "{" + out + "}";
}

// Publish calendar/extra = {eventKey: {actual, actualImpact, reactions}} for released
// events; only the terminal that published the calendar does it, only when changed.
void EnrichAndPublish()
{
   if(g_evN == 0) return;
   long now = (long)TimeGMT(), off = ServerOffset();
   string extra = ""; int nAct = 0, nReact = 0;
   for(int i = 0; i < g_evN; i++)
   {
      long ts = g_evTs[i];
      if(ts > now) continue;                                   // not released yet
      string act = "", impact = ""; int hib = 0;
      bool hasAct = LookupActual(i, ts + off, act, impact, hib);
      string reac = Reactions(g_evCur[i], ts, off, now);
      if(!hasAct && reac == "") continue;
      string e = "";
      if(hasAct)
      {
         e = "\"actual\":\"" + Esc(act) + "\"";
         if(impact != "") e += ",\"actualImpact\":\"" + impact + "\"";
         if(hib != 0) e += ",\"higherIsBetter\":" + (hib > 0 ? "true" : "false");
         nAct++;
      }
      if(reac != ""){ e += (e != "" ? "," : "") + "\"reactions\":" + reac; nReact++; }
      if(extra != "") extra += ",";
      extra += "\"" + g_evKey[i] + "\":{" + e + "}";
   }
   extra = "{" + extra + "}";
   if(extra == g_extraPublished) return;
   char pd[]; StringToCharArray(extra, pd, 0, StringLen(extra), CP_UTF8);
   char rr[]; string rh;
   int pr = WebRequest("PUT", FbUrl("calendar/extra"), "Content-Type: application/json\r\n", 15000, pd, rr, rh);
   if(pr == 200){ g_extraPublished = extra; Print("NewsFeed: published ", nAct, " actual value(s) and ", nReact, " price reaction(s)"); }
   else Print("NewsFeed: extra publish failed HTTP ", pr);
}

// Seconds since the calendar was last published (by any terminal); -1 = can't tell.
long CalendarAge()
{
   string url = "https://" + g_sl_projectId + "-default-rtdb.firebaseio.com/calendar/updatedAt.json?auth=" + g_sl_idToken;
   char post[], res[]; string hdr;
   int r = WebRequest("GET", url, NULL, 8000, post, res, hdr);
   if(r != 200) return -1;
   string v = CharArrayToString(res, 0, WHOLE_ARRAY, CP_UTF8);
   StringTrimLeft(v); StringTrimRight(v);
   if(v == "null" || v == "") return LONG_MAX;               // never stamped (older EA build)
   return (long)TimeGMT() - StringToInteger(v);
}

void FetchAndPublish()
{
   char post[], res[]; string hdr;
   ResetLastError();
   int r = WebRequest("GET", Inp_FeedURL, NULL, 15000, post, res, hdr);
   if(r == -1){ Print("NewsFeed: WebRequest failed err=", GetLastError(), " (whitelist ", Inp_FeedURL, "?)"); return; }
   if(r != 200){ Print("NewsFeed: HTTP ", r); return; }
   string body = CharArrayToString(res, 0, WHOLE_ARRAY, CP_UTF8);

   // split the top-level array into element slices on  },{
   string b = body;
   int lb = StringFind(b,"["); int rb = StringFind(b,"]");
   if(lb >= 0 && rb > lb) b = StringSubstr(b, lb+1, rb-lb-1);
   // split on "},{"  (element boundaries)
   string elems[]; int ec=0; ArrayResize(elems,0);
   int start=0;
   for(int i=0;i+2 < StringLen(b); i++)
   {
      if(StringGetCharacter(b,i)=='}' && StringGetCharacter(b,i+1)==',' && StringGetCharacter(b,i+2)=='{')
      {
         ArrayResize(elems, ec+1); elems[ec++] = StringSubstr(b, start, i-start+1);
         start = i+2;
      }
   }
   ArrayResize(elems, ec+1); elems[ec++] = StringSubstr(b, start);  // last one

   string out = "{";
   int count=0;
   ArrayResize(g_evKey, 0); ArrayResize(g_evTitle, 0); ArrayResize(g_evCur, 0); ArrayResize(g_evTs, 0); g_evN = 0;
   for(int i=0;i<ec;i++)
   {
      string e = elems[i];
      if(StringFind(e,"\"title\"") < 0) continue;
      string title = JStr(e,"title");
      string cur   = JStr(e,"country");     // FF uses "country" for the currency code
      string imp   = JStr(e,"impact");
      string date  = JStr(e,"date");
      string fc    = JStr(e,"forecast");
      string pv    = JStr(e,"previous");
      string act   = JStr(e,"actual");
      long   ts    = IsoToUtc(date);
      if(ts <= 0 || cur=="") continue;

      string key = IntegerToString((int)ts) + "_" + San(cur) + "_" + San(title);
      if(count>0) out += ",";
      out += "\"" + key + "\":{"
           + "\"title\":\""    + Esc(title) + "\","
           + "\"currency\":\"" + Esc(cur)   + "\","
           + "\"impact\":\""   + Esc(imp)   + "\","
           + "\"timestamp\":"  + IntegerToString((int)ts) + ","
           + "\"forecast\":\"" + Esc(fc)    + "\","
           + "\"previous\":\"" + Esc(pv)    + "\","
           + "\"actual\":\""   + Esc(act)   + "\"}";
      count++;
      ArrayResize(g_evKey, g_evN + 1); ArrayResize(g_evTitle, g_evN + 1); ArrayResize(g_evCur, g_evN + 1); ArrayResize(g_evTs, g_evN + 1);
      g_evKey[g_evN] = key; g_evTitle[g_evN] = title; g_evCur[g_evN] = cur; g_evTs[g_evN] = ts; g_evN++;
   }
   out += "}";

   if(count == 0){ Print("NewsFeed: feed parsed to 0 events - not publishing"); return; }

   // PATCH: "events" is replaced wholesale with the fresh week (no stale accumulation)
   // while calendar/extra (actuals + reactions) is kept. The app reads calendar/events
   // and shows "updated X ago" from updatedAt.
   string doc = "{\"events\":" + out + ",\"updatedAt\":" + IntegerToString((long)TimeGMT()) +
                ",\"by\":\"" + g_sl_accountId + "\"}";
   string url = "https://" + g_sl_projectId + "-default-rtdb.firebaseio.com/calendar.json?auth=" + g_sl_idToken;
   char pd[]; StringToCharArray(doc, pd, 0, StringLen(doc), CP_UTF8);
   char rr[]; string rh;
   int pr = WebRequest("PATCH", url, "Content-Type: application/json\r\n", 15000, pd, rr, rh);
   if(pr == 200) Print("NewsFeed: published ", count, " calendar events to Firebase");
   else          Print("NewsFeed: publish failed HTTP ", pr, " ", CharArrayToString(rr,0,WHOLE_ARRAY,CP_UTF8));
}

// Every Inp_CheckMinutes: publish only when the calendar is stale, so two
// terminals don't both hit Forex Factory, and a failed attempt retries soon
// instead of an hour later.
void CheckAndPublish()
{
   if(!SignalLib_EnsureAuth()){ Print("NewsFeed: no auth yet, retry in ", Inp_CheckMinutes, " min"); return; }
   long age = CalendarAge();
   bool fresh = (age >= 0 && age < Inp_RefreshMinutes * 60);  // possibly from the other terminal
   string by = fresh ? CalendarBy() : "";
   // Re-fetch when stale, or when this terminal is the publisher but lost its copy (restart).
   if(!fresh || (g_evN == 0 && by == g_sl_accountId)) { FetchAndPublish(); by = g_sl_accountId; }
   if(by == g_sl_accountId) EnrichAndPublish();              // standby terminal stays quiet
}

int OnInit()
{
   SignalLib_Init(Inp_ProjectID, Inp_ApiKey, Inp_Email, Inp_Password);
   EventSetTimer(MathMax(1, Inp_CheckMinutes) * 60);
   CheckAndPublish();
   return INIT_SUCCEEDED;
}
void OnTimer(){ CheckAndPublish(); }
void OnDeinit(const int reason){ EventKillTimer(); }
void OnTick(){}
