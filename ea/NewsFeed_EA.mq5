//+------------------------------------------------------------------+
//| NewsFeed_EA — fetches the Forex Factory weekly economic calendar  |
//| (JSON) and publishes it to Firebase /calendar/events for the      |
//| Command0r app (News screen) and any news-filter EAs. Runs 24/7    |
//| so the calendar stays fresh even when the app is closed.          |
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
input int    Inp_RefreshMinutes = 60;     // how often to re-fetch

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
   return StringSubstr(src, p, q-p);
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

void FetchAndPublish()
{
   if(!SignalLib_EnsureAuth()){ Print("NewsFeed: no auth, skip"); return; }

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
   }
   out += "}";

   // PUT replaces the whole node with the fresh week (no stale accumulation)
   string url = "https://" + g_sl_projectId + "-default-rtdb.firebaseio.com/calendar/events.json?auth=" + g_sl_idToken;
   char pd[]; StringToCharArray(out, pd, 0, StringLen(out), CP_UTF8);
   char rr[]; string rh;
   int pr = WebRequest("PUT", url, "Content-Type: application/json\r\n", 15000, pd, rr, rh);
   if(pr == 200) Print("NewsFeed: published ", count, " calendar events to Firebase");
   else          Print("NewsFeed: publish failed HTTP ", pr, " ", CharArrayToString(rr,0,WHOLE_ARRAY,CP_UTF8));
}

int OnInit()
{
   SignalLib_Init(Inp_ProjectID, Inp_ApiKey, Inp_Email, Inp_Password);
   EventSetTimer(MathMax(5, Inp_RefreshMinutes*60));
   FetchAndPublish();   // publish once on attach
   return INIT_SUCCEEDED;
}
void OnTimer(){ FetchAndPublish(); }
void OnDeinit(const int reason){ EventKillTimer(); }
void OnTick(){}
