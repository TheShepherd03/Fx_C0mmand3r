//+------------------------------------------------------------------+
//|                                                       SignalLib.mqh|
//|         Shared Firebase signal publisher for FX Commander         |
//|  Include this in any "signal-only" EA. It handles anonymous auth  |
//|  and exposes PublishSignal(...) to append a signal (with SL/TP)   |
//|  to the app's Market Signals feed. These EAs never place trades:  |
//|  new setups are handed to the Bridge EA, which auto-trades them   |
//|  only for sources the user switched on (SignalLib_HandOff).       |
//+------------------------------------------------------------------+
#ifndef __FXC_SIGNALLIB_MQH__
#define __FXC_SIGNALLIB_MQH__

#include "JAson.mqh"

// --- Config + auth state (set by SignalLib_Init) ---
string   g_sl_projectId      = "";
string   g_sl_apiKey         = "";
string   g_sl_email          = "";
string   g_sl_password       = "";
string   g_sl_idToken        = "";
string   g_sl_refreshToken   = "";
datetime g_sl_tokenExpiry    = 0;
datetime g_sl_lastAuthAttempt= 0;
int      g_sl_authBackoff    = 30;   // seconds between real sign-in attempts; grows on rate-limit
string   g_sl_accountId      = "";

// Shared token cache: all EAs on this account reuse ONE Firebase token via a
// local file, so ~20 EAs don't each sign in (which trips TOO_MANY_ATTEMPTS).
#define FXC_TOKEN_FILE "fxcommander_token.txt"

// Temporary bypass: if this flag file exists in MQL5/Files, EAs skip Firebase
// auth entirely and publish unauthenticated (requires open rules on signals/).
// Reversible with no recompile: delete the file + re-lock rules + restart.
#define FXC_NOAUTH_FILE "fxcommander_noauth.txt"
bool     g_sl_noAuth         = false;

// --- Live signals this EA has published (for SL/TP-hit + expiry pruning) ---
struct SL_Tracked
{
   string   key;        // Firebase push key
   string   symbol;
   string   action;     // BUY / SELL
   double   entry;      // published entry price (for winning/pending status)
   double   sl;
   double   tp;
   datetime expiresAt;
   string   status;     // last status pushed to Firebase (pending / winning)
   datetime lastLivePush; // throttle for currentPrice pushes
   string   source;     // publishing strategy (for the outcome log / scorecard)
   string   tag;        // optional sub-type, e.g. Zones confirmation "sweep"
   string   extra;      // extra JSON fields ("grade":"A","touch":1,...) copied to the outcome log
   int      confidence;
   datetime openedAt;   // UTC; when this setup first appeared
};
SL_Tracked g_sl_tracked[];

// --- Notification preferences (prefs/signals), cached --------------------
string   g_sl_prefs     = "";   // raw JSON of prefs/signals ("" = none / defaults)
datetime g_sl_prefsAt   = 0;

// When this EA instance started (UTC): tells a fresh setup from one a restarted EA announces again.
datetime g_sl_startedAt = 0;

//+------------------------------------------------------------------+
//| Extract a value for `key` from raw JSON (quoted or bare).         |
//+------------------------------------------------------------------+
string SignalLib_ExtractJson(string json, string key)
{
   string pat = "\"" + key + "\"";
   int p = StringFind(json, pat);
   if(p < 0) return "";
   p = StringFind(json, ":", p + StringLen(pat));
   if(p < 0) return "";
   p++;
   int len = StringLen(json);
   while(p < len)
   {
      ushort c = StringGetCharacter(json, p);
      if(c==' '||c=='\t'||c=='\r'||c=='\n') p++; else break;
   }
   if(p >= len) return "";
   if(StringGetCharacter(json, p) == '"')
   {
      p++;
      int end = StringFind(json, "\"", p);
      if(end < 0) return "";
      return StringSubstr(json, p, end - p);
   }
   int start = p;
   while(p < len)
   {
      ushort c = StringGetCharacter(json, p);
      if(c==','||c=='}'||c==']'||c==' '||c=='\r'||c=='\n'||c=='\t') break;
      p++;
   }
   return StringSubstr(json, start, p - start);
}

//+------------------------------------------------------------------+
//| Unique account id: Company_Server_AccountNumber                   |
//+------------------------------------------------------------------+
string SignalLib_AccountID()
{
   string id = AccountInfoString(ACCOUNT_COMPANY) + "_" + AccountInfoString(ACCOUNT_SERVER)
             + "_" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));
   StringReplace(id," ","_"); StringReplace(id,"-","_"); StringReplace(id,".","_");
   StringReplace(id,"(","_"); StringReplace(id,")","_");
   return id;
}

//+------------------------------------------------------------------+
//| Email/password sign-in                                            |
//+------------------------------------------------------------------+
bool SignalLib_SignIn()
{
   string url = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + g_sl_apiKey;
   string body = "{\"email\":\"" + g_sl_email + "\",\"password\":\"" + g_sl_password + "\",\"returnSecureToken\":true}";
   char post[]; StringToCharArray(body, post, 0, StringLen(body));
   char res[]; string hdr;
   int r = WebRequest("POST", url, "Content-Type: application/json\r\n", 5000, post, res, hdr);
   if(r != 200) { Print("SignalLib sign-in FAILED HTTP ", r, " ", CharArrayToString(res)); return false; }
   string resp = CharArrayToString(res);
   g_sl_idToken      = SignalLib_ExtractJson(resp, "idToken");
   g_sl_refreshToken = SignalLib_ExtractJson(resp, "refreshToken");
   int expSec = (int)StringToInteger(SignalLib_ExtractJson(resp, "expiresIn"));
   if(expSec <= 0) expSec = 3600;
   g_sl_tokenExpiry = TimeGMT() + expSec - 300;
   if(g_sl_idToken == "") return false;
   return true;
}

//+------------------------------------------------------------------+
//| Refresh the ID token                                              |
//+------------------------------------------------------------------+
bool SignalLib_Refresh()
{
   if(g_sl_refreshToken == "") return SignalLib_SignIn();
   string url = "https://securetoken.googleapis.com/v1/token?key=" + g_sl_apiKey;
   string body = "grant_type=refresh_token&refresh_token=" + g_sl_refreshToken;
   char post[]; StringToCharArray(body, post, 0, StringLen(body));
   char res[]; string hdr;
   int r = WebRequest("POST", url, "Content-Type: application/x-www-form-urlencoded\r\n", 5000, post, res, hdr);
   if(r != 200) return SignalLib_SignIn();
   string resp = CharArrayToString(res);
   g_sl_idToken = SignalLib_ExtractJson(resp, "id_token");
   string rt = SignalLib_ExtractJson(resp, "refresh_token");
   if(rt != "") g_sl_refreshToken = rt;
   int expSec = (int)StringToInteger(SignalLib_ExtractJson(resp, "expires_in"));
   if(expSec <= 0) expSec = 3600;
   g_sl_tokenExpiry = TimeGMT() + expSec - 300;
   if(g_sl_idToken == "") return SignalLib_SignIn();
   return true;
}

//+------------------------------------------------------------------+
//| Shared token cache (file): read a still-valid token written by any |
//| EA on this account, so we can skip signing in ourselves.           |
//+------------------------------------------------------------------+
bool SignalLib_ReadSharedToken()
{
   int h = FileOpen(FXC_TOKEN_FILE, FILE_READ|FILE_BIN|FILE_SHARE_READ|FILE_SHARE_WRITE);
   if(h == INVALID_HANDLE) return false;
   int sz = (int)FileSize(h);
   uchar buf[];
   if(sz > 0) { ArrayResize(buf, sz); FileReadArray(h, buf, 0, sz); }
   FileClose(h);
   if(sz <= 0) return false;
   string content = CharArrayToString(buf, 0, sz, CP_UTF8);
   string parts[];
   int n = StringSplit(content, '\n', parts);
   string good[]; int gc = 0;
   for(int i = 0; i < n; i++)
   {
      string ln = parts[i];
      StringReplace(ln, "\r", "");
      StringTrimLeft(ln); StringTrimRight(ln);
      if(StringLen(ln) > 0) { ArrayResize(good, gc + 1); good[gc] = ln; gc++; }
   }
   if(gc < 3) return false;
   datetime exp = (datetime)StringToInteger(good[2]);
   if(TimeGMT() >= exp - 60) return false;   // stale / about to expire
   g_sl_idToken      = good[0];
   g_sl_refreshToken = good[1];
   g_sl_tokenExpiry  = exp;
   return (g_sl_idToken != "");
}

void SignalLib_WriteSharedToken()
{
   int h = FileOpen(FXC_TOKEN_FILE, FILE_WRITE|FILE_BIN|FILE_SHARE_READ|FILE_SHARE_WRITE);
   if(h == INVALID_HANDLE) return;
   string content = g_sl_idToken + "\n" + g_sl_refreshToken + "\n" + IntegerToString((long)g_sl_tokenExpiry) + "\n";
   uchar buf[];
   int len = StringToCharArray(content, buf, 0, StringLen(content), CP_UTF8);
   if(len > 0) FileWriteArray(h, buf, 0, len);
   FileClose(h);
}

//+------------------------------------------------------------------+
//| Ensure a valid token: reuse in-memory, else the shared file, else |
//| sign in / refresh (throttled with backoff so 20 EAs don't storm). |
//+------------------------------------------------------------------+
bool SignalLib_EnsureAuth()
{
   if(g_sl_noAuth) return true;   // bypass: publish unauthenticated (open rules)
   datetime now = TimeGMT();
   if(g_sl_idToken != "" && now < g_sl_tokenExpiry) return true;
   // Another EA may already have a fresh token cached in the shared file.
   if(SignalLib_ReadSharedToken()) return true;
   // We must hit the network — throttle with backoff (grows on rate-limit).
   if(now - g_sl_lastAuthAttempt < g_sl_authBackoff) return false;
   g_sl_lastAuthAttempt = now;
   bool ok = (g_sl_idToken == "") ? SignalLib_SignIn() : SignalLib_Refresh();
   if(ok)
   {
      g_sl_authBackoff = 30;
      SignalLib_WriteSharedToken();
   }
   else
   {
      g_sl_authBackoff = (g_sl_authBackoff * 2 > 600) ? 600 : g_sl_authBackoff * 2;  // up to 10 min
   }
   return ok;
}

//+------------------------------------------------------------------+
//| Initialise: store config, build account id, sign in.              |
//+------------------------------------------------------------------+
// Fall back to a local credentials file when the EA inputs are blank, so many
// EAs can share one credential without per-EA setup. File: MQL5/Files/
// fxcommander_auth.txt  (line 1 = email, line 2 = password). Kept local, never
// committed to the repo.
void SignalLib_LoadCredsIfBlank()
{
   if(g_sl_email != "" && g_sl_password != "") return;
   // Read the whole file as raw bytes and split manually, so we never depend on
   // FileReadString's line-ending semantics (which silently mishandle LF-only /
   // mixed endings and can swallow both lines into one field).
   // FILE_SHARE_* so ~20 EAs opening this at once on startup don't collide
   // (exclusive open -> err 5004 -> empty email -> INVALID_EMAIL).
   int h = FileOpen("fxcommander_auth.txt", FILE_READ|FILE_BIN|FILE_SHARE_READ|FILE_SHARE_WRITE);
   if(h == INVALID_HANDLE) { Print("SignalLib: cred file open failed, err=", GetLastError()); return; }
   int sz = (int)FileSize(h);
   uchar buf[];
   if(sz > 0) { ArrayResize(buf, sz); FileReadArray(h, buf, 0, sz); }
   FileClose(h);
   string content = (sz > 0) ? CharArrayToString(buf, 0, sz, CP_UTF8) : "";
   string parts[];
   int n = StringSplit(content, '\n', parts);
   string good[]; int gc = 0;
   for(int i = 0; i < n; i++)
   {
      string ln = parts[i];
      StringReplace(ln, "\r", "");
      StringTrimLeft(ln); StringTrimRight(ln);
      if(StringLen(ln) > 0) { ArrayResize(good, gc + 1); good[gc] = ln; gc++; }
   }
   if(gc >= 1 && g_sl_email == "")    g_sl_email    = good[0];
   if(gc >= 2 && g_sl_password == "") g_sl_password = good[1];
   Print("SignalLib creds loaded: lines=", gc, " emailLen=", StringLen(g_sl_email), " pwLen=", StringLen(g_sl_password));
}

//+------------------------------------------------------------------+
//| An account in a currency other than USD (ZAR at HFM / Swyft) gets  |
//| trade values through the account-currency pairs (USDZAR, EURZAR...).|
//| Brokers keep those out of Market Watch; while they aren't loaded,  |
//| OrderCalcProfit fails and the tick value is 0, so the app can't    |
//| size the risk ("risk not available"). Load them at start.          |
//+------------------------------------------------------------------+
void SignalLib_SelectConversionSymbols()
{
   string acc = AccountInfoString(ACCOUNT_CURRENCY);
   if(acc == "" || acc == "USD") return;
   int total = SymbolsTotal(false);
   for(int i = 0; i < total; i++)
   {
      string s = SymbolName(i, false);
      if(StringFind(s, acc) >= 0) SymbolSelect(s, true);
   }
}

bool SignalLib_Init(string projectId, string apiKey, string email, string password)
{
   SignalLib_SelectConversionSymbols();
   g_sl_projectId = projectId;
   g_sl_apiKey    = apiKey;
   g_sl_email     = email;
   g_sl_password  = password;
   g_sl_accountId = SignalLib_AccountID();
   g_sl_startedAt = TimeGMT();
   // Temporary unauthenticated bypass (flag file present) — skip all auth.
   if(FileIsExist(FXC_NOAUTH_FILE))
   {
      g_sl_noAuth = true;
      Print("SignalLib init for account ", g_sl_accountId, " (NO-AUTH bypass: publishing unauthenticated)");
      return true;
   }
   SignalLib_LoadCredsIfBlank();
   // Don't sign in inline (that makes ~20 EAs storm Firebase on load). Prefer a
   // token already cached in the shared file; otherwise stagger the first real
   // sign-in by a random 0-120s so instances don't all hit the network at once.
   bool ok;
   if(SignalLib_ReadSharedToken())
   {
      ok = true;
      Print("SignalLib init for account ", g_sl_accountId, " (reused shared token)");
   }
   else
   {
      MathSrand((int)(GetMicrosecondCount() + TimeLocal()));       // unique per EA instance
      g_sl_lastAuthAttempt = TimeGMT() + (MathRand() % 120);   // future => EnsureAuth waits, staggered
      ok = false;
      Print("SignalLib init for account ", g_sl_accountId, " (auth deferred, staggered)");
   }
   return ok;
}

//+------------------------------------------------------------------+
//| Send one Expo push message to a device token.                     |
//| Requires https://exp.host whitelisted in Tools>Options>Experts.   |
//+------------------------------------------------------------------+
string SignalLib_JsonEsc(string s)
{
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   return s;
}

// Firebase key form of a symbol (matches the app: [ .$#[]/] -> "_").
string SignalLib_SymbolKey(string s)
{
   StringReplace(s, " ", "_"); StringReplace(s, ".", "_"); StringReplace(s, "$", "_");
   StringReplace(s, "#", "_"); StringReplace(s, "[", "_"); StringReplace(s, "]", "_");
   StringReplace(s, "/", "_");
   return s;
}

// `data` is a raw JSON object string for the app's deep link, e.g.
// {"screen":"zones","symbol":"...","account":"<id>"} (app switches to that account), or "".
void SignalLib_SendExpoPush(string token, string title, string body, string data = "")
{
   string url = "https://exp.host/--/api/v2/push/send";
   string payload = "{\"to\":\"" + token + "\",\"title\":\"" + SignalLib_JsonEsc(title) +
                    "\",\"body\":\"" + SignalLib_JsonEsc(body) +
                    "\",\"sound\":\"default\",\"channelId\":\"signals\",\"priority\":\"high\"" +
                    (data != "" ? ",\"data\":" + data : "") + "}";
   char post[]; StringToCharArray(payload, post, 0, StringLen(payload), CP_UTF8);
   char res[]; string hdr;
   WebRequest("POST", url, "Content-Type: application/json\r\n", 5000, post, res, hdr);
}

//+------------------------------------------------------------------+
//| Notification preferences (prefs/signals, written by the app):     |
//|  sources.<Src>.notify=false, mutedSymbols.<symKey>=true, and      |
//|  quiet {enabled,start,end (minutes of the user's local day),      |
//|  tzOffsetMin}. Reloaded at most once a minute.                    |
//+------------------------------------------------------------------+
void SignalLib_LoadPrefs()
{
   if(g_sl_prefsAt > 0 && TimeGMT() - g_sl_prefsAt < 60) return;
   g_sl_prefsAt = TimeGMT();
   if(!SignalLib_EnsureAuth()) return;
   string url = "https://" + g_sl_projectId + "-default-rtdb.firebaseio.com/prefs/signals.json?auth=" + g_sl_idToken;
   char post[]; char res[]; string hdr;
   if(WebRequest("GET", url, NULL, 3000, post, res, hdr) == 200)
   {
      string s = CharArrayToString(res, 0, WHOLE_ARRAY, CP_UTF8);
      g_sl_prefs = (s == "null") ? "" : s;
   }
}

// The JSON object that is the value of "key" (first occurrence), or "".
string SignalLib_ObjectFor(string json, string key)
{
   int p = StringFind(json, "\"" + key + "\":{");
   if(p < 0) return "";
   int s = StringFind(json, "{", p);
   int depth = 0;
   for(int i = s; i < StringLen(json); i++)
   {
      ushort c = StringGetCharacter(json, i);
      if(c == '{') depth++;
      else if(c == '}') { depth--; if(depth == 0) return StringSubstr(json, s, i - s + 1); }
   }
   return "";
}

bool SignalLib_NotifyAllowed(string source, string symbol)
{
   SignalLib_LoadPrefs();
   if(g_sl_prefs == "") return true;
   if(source != "")
   {
      // keyed like symbols: "Supply/Demand" is stored as "Supply_Demand"
      string so = SignalLib_ObjectFor(SignalLib_ObjectFor(g_sl_prefs, "sources"), SignalLib_SymbolKey(source));
      if(so != "" && StringFind(so, "\"notify\":false") >= 0) return false;
   }
   if(symbol != "")
   {
      string muted = SignalLib_ObjectFor(g_sl_prefs, "mutedSymbols");
      if(muted != "" && StringFind(muted, "\"" + SignalLib_SymbolKey(symbol) + "\":true") >= 0) return false;
   }
   string q = SignalLib_ObjectFor(g_sl_prefs, "quiet");
   if(q != "" && StringFind(q, "\"enabled\":true") >= 0)
   {
      int st  = (int)StringToInteger(SignalLib_ExtractJson(q, "start"));
      int en  = (int)StringToInteger(SignalLib_ExtractJson(q, "end"));
      int off = (int)StringToInteger(SignalLib_ExtractJson(q, "tzOffsetMin"));
      long local = (long)TimeGMT() + (long)off * 60;
      int mins = (int)(((local % 86400) + 86400) % 86400 / 60);
      bool quiet = (st <= en) ? (mins >= st && mins < en) : (mins >= st || mins < en); // wraps midnight
      if(quiet) return false;
   }
   return true;
}

//+------------------------------------------------------------------+
//| Push an alert to every registered device, unless the user's prefs |
//| mute this source/symbol or it's quiet hours. Reads the parent     |
//| pushTokens node: the per-account URL hits MQL's ~1024-char        |
//| WebRequest limit with long account ids (HFM) and failed silently. |
//+------------------------------------------------------------------+
void SignalLib_NotifyFor(string source, string symbol, string title, string body, string data = "")
{
   if(!SignalLib_NotifyAllowed(source, symbol)) return;
   if(!SignalLib_EnsureAuth()) return;
   string url = "https://" + g_sl_projectId + "-default-rtdb.firebaseio.com/pushTokens.json?auth=" + g_sl_idToken;
   char post[]; char res[]; string hdr;
   int r = WebRequest("GET", url, NULL, 3000, post, res, hdr);
   if(r != 200) return;
   string resp = CharArrayToString(res);
   if(resp == "null" || StringLen(resp) < 12) return;   // no tokens registered
   // Every "ExponentPushToken[...]" once (the same phone is registered per account).
   string sent = "|";
   int pos = 0;
   while(true)
   {
      int s = StringFind(resp, "ExponentPushToken[", pos);
      if(s < 0) break;
      int e = StringFind(resp, "]", s);
      if(e < 0) break;
      string token = StringSubstr(resp, s, e - s + 1);
      if(StringFind(sent, "|" + token + "|") < 0)
      {
         SignalLib_SendExpoPush(token, title, body, data);
         sent += token + "|";
      }
      pos = e + 1;
   }
}

void SignalLib_Notify(string title, string body)
{
   SignalLib_NotifyFor("", "", title, body, "");
}

//+------------------------------------------------------------------+
//| Publish a discrete signal (appends via POST). true on HTTP 200.   |
//|  action: "BUY" or "SELL"; expirySeconds: how long it stays live.  |
//+------------------------------------------------------------------+
//+------------------------------------------------------------------+
//| Deposit-currency money per one SYMBOL_TRADE_TICK_SIZE move for a  |
//| 1.0 lot, via OrderCalcProfit. Currency-correct for index/CFDs     |
//| where raw SYMBOL_TRADE_TICK_VALUE is unconverted (e.g. USA30 on a |
//| ZAR account returns 0.1 instead of the real ~1.6). Falls back to  |
//| the raw tick value only if OrderCalcProfit can't run.             |
//+------------------------------------------------------------------+
double SignalLib_MoneyPerTick(string symbol)
{
   double ts = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
   double px = SymbolInfoDouble(symbol, SYMBOL_BID);
   if(px <= 0) px = SymbolInfoDouble(symbol, SYMBOL_ASK);
   if(px <= 0) px = SymbolInfoDouble(symbol, SYMBOL_LAST);
   double loss = 0.0;
   if(ts > 0 && px > 0 &&
      OrderCalcProfit(ORDER_TYPE_BUY, symbol, 1.0, px, px - ts, loss) && loss != 0.0)
      return MathAbs(loss);
   double tv = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE); // fallback
   if(tv <= 0) Print("SignalLib: no tick value for ", symbol, " (", AccountInfoString(ACCOUNT_CURRENCY),
                     " conversion pair not loaded?) - the app can't size this signal's risk");
   return tv;
}

// Deterministic Firebase key per (source, symbol): a restart overwrites the SAME node
// instead of orphaning it, and there's at most one live signal per symbol per source.
string SignalLib_SignalKey(string source, string symbol)
{
   string key = source + "_" + symbol;
   StringReplace(key, ".", "_"); StringReplace(key, "$", "_"); StringReplace(key, "#", "_");
   StringReplace(key, "[", "_"); StringReplace(key, "]", "_"); StringReplace(key, "/", "_");
   StringReplace(key, " ", "_");
   return key;
}

// true while this EA's last signal for (source, symbol) is still open (not yet hit
// SL/TP or expired, as of the last SignalLib_Prune). Lets an EA keep that signal
// instead of silently replacing its levels with a repeat trigger.
bool SignalLib_IsLive(string source, string symbol)
{
   string key = SignalLib_SignalKey(source, symbol);
   for(int t = 0; t < ArraySize(g_sl_tracked); t++) if(g_sl_tracked[t].key == key) return true;
   return false;
}

//+------------------------------------------------------------------+
//| Last publish per signal key, kept in MQL5\Files across restarts:  |
//|   fxc_pub_<key>.txt = "action|expiresAt|publishedAt"  (UTC; a     |
//|   closed signal - SL/TP hit or expired - has expiresAt 0).        |
//| EAs lose their state on a restart and announce what they see on   |
//| their first bar again (DriftRegime re-sends its current regime).  |
//| The first publish after a start, in the same direction as one    |
//| published before the start that is still open or under 6 h old,  |
//| is that same setup announced again: it refreshes the feed but is  |
//| never handed to the Bridge for auto trade.                        |
//+------------------------------------------------------------------+
#define FXC_REANNOUNCE_SEC (6 * 3600)

string SignalLib_PubFile(string key) { return "fxc_pub_" + key + ".txt"; }

void SignalLib_SavePub(string key, string action, long expiresAt, long publishedAt)
{
   int h = FileOpen(SignalLib_PubFile(key), FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_SHARE_READ | FILE_SHARE_WRITE);
   if(h == INVALID_HANDLE) return;
   FileWriteString(h, action + "|" + IntegerToString(expiresAt) + "|" + IntegerToString(publishedAt) + "\n");
   FileClose(h);
}

bool SignalLib_IsReannounce(string key, string action)
{
   int h = FileOpen(SignalLib_PubFile(key), FILE_READ | FILE_TXT | FILE_ANSI | FILE_SHARE_READ | FILE_SHARE_WRITE);
   if(h == INVALID_HANDLE) return false;
   string ln = FileReadString(h);
   FileClose(h);
   string p[];
   if(StringSplit(ln, '|', p) < 3 || p[0] != action) return false;
   long expiresAt = StringToInteger(p[1]), publishedAt = StringToInteger(p[2]), now = (long)TimeGMT();
   if(publishedAt >= (long)g_sl_startedAt) return false;            // published by this run: normal rules
   return expiresAt > now || now - publishedAt < FXC_REANNOUNCE_SEC;
}

//+------------------------------------------------------------------+
//| Hand a NEW setup to the Bridge EA running in this same terminal,  |
//| which auto-trades it if the user switched auto trade on for this  |
//| source in the app. Local file in MQL5\Files - no network, no      |
//| polling of the feed. One file per setup, written under a temp     |
//| name and renamed so the Bridge never reads a half-written line:   |
//|   v1|key|source|symbol|action|entry|sl|tp|grade|utcSeconds        |
//+------------------------------------------------------------------+
void SignalLib_HandOff(string key, string source, string symbol, string action,
                       double entry, double sl, double tp, string extraJson)
{
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   string grade = (extraJson != "") ? SignalLib_ExtractJson("{" + extraJson + "}", "grade") : "";
   string utc = IntegerToString((long)TimeGMT());
   string line = "v1|" + key + "|" + source + "|" + symbol + "|" + action + "|" +
                 DoubleToString(entry, digits) + "|" + DoubleToString(sl, digits) + "|" +
                 DoubleToString(tp, digits) + "|" + grade + "|" + utc;
   string tmp = "fxc_tmp_" + utc + "_" + key + ".txt";
   int h = FileOpen(tmp, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_SHARE_READ | FILE_SHARE_WRITE);
   if(h == INVALID_HANDLE) { Print("SignalLib: hand-off file failed (", GetLastError(), ")"); return; }
   FileWriteString(h, line + "\n");
   FileClose(h);
   if(!FileMove(tmp, 0, "fxc_at_" + utc + "_" + key + ".txt", FILE_REWRITE))
   {
      Print("SignalLib: hand-off rename failed (", GetLastError(), ")");
      FileDelete(tmp);
   }
}

bool PublishSignal(string symbol, string action, double entry, double sl, double tp,
                   double lots, string source, int confidence, int expirySeconds,
                   string tag = "",        // optional sub-type, e.g. Zones confirmation "sweep"
                   string extraJson = "",  // extra fields for the app + outcome log, e.g. "grade":"A","touch":1
                   bool   notify = true,   // false = publish to the feed without a push
                   string pushNote = "")   // replaces "(tag)" in the push body, e.g. "Grade A - reject" (ASCII)
{
   if(!SignalLib_EnsureAuth()) { Print("SignalLib: no auth, skipping signal"); return false; }

   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   CJSONObject *o = new CJSONObject();
   o.Add("symbol",     symbol);
   o.Add("action",     action);
   o.Add("price",      NormalizeDouble(entry, digits));
   o.Add("currentPrice", NormalizeDouble(entry, digits)); // seeded at entry; prune loop keeps it live
   o.Add("sl",         NormalizeDouble(sl, digits));
   o.Add("tp",         NormalizeDouble(tp, digits));
   o.Add("lots",       lots);
   o.Add("tickValue",  SignalLib_MoneyPerTick(symbol));   // deposit-currency, index-CFD safe
   o.Add("tickSize",   SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE));
   o.Add("source",     source);
   o.Add("confidence", confidence);
   if(tag != "") o.Add("tag", tag);
   o.Add("status",     "pending");
   o.Add("timestamp",  (int)TimeGMT());                   // UTC so the app's "X ago" is correct
   o.Add("expiresAt",  (int)(TimeGMT() + expirySeconds)); // (TimeCurrent = broker time, ahead of UTC on HFM)
   string body = o.ToString();
   delete o;
   if(extraJson != "")                      // splice the extra fields into the object
   {
      int rb = StringLen(body) - 1;
      while(rb > 0 && StringGetCharacter(body, rb) != '}') rb--;
      if(rb > 0) body = StringSubstr(body, 0, rb) + "," + extraJson + "}";
   }

   // One node per (source, symbol), no unbounded accumulation. Replacing the whole
   // node also clears the app's dismissed/snoozedUntil flags, so a NEW setup always shows again.
   string key = SignalLib_SignalKey(source, symbol);

   // Root-level multi-path PATCH ("account/key": node): with the ~905-char token even
   // signals/{account}.json sits right at MQL's ~1024-char URL limit on HFM's long id.
   string url = "https://" + g_sl_projectId + "-default-rtdb.firebaseio.com/signals.json?auth=" + g_sl_idToken;
   string patchBody = "{\"" + g_sl_accountId + "/" + key + "\":" + body + "}";
   char post[]; StringToCharArray(patchBody, post, 0, StringLen(patchBody));
   char res[]; string hdr;
   int r = WebRequest("PATCH", url, "Content-Type: application/json\r\n", 5000, post, res, hdr);
   if(r == 200)
   {
      // Track by key (upsert): update in place if we already track this key.
      int idx = -1;
      for(int t = 0; t < ArraySize(g_sl_tracked); t++)
         if(g_sl_tracked[t].key == key) { idx = t; break; }
      bool isNew = (idx < 0);   // first time we see this (source, symbol) setup
      if(idx < 0) { idx = ArraySize(g_sl_tracked); ArrayResize(g_sl_tracked, idx + 1); }
      // A re-publish of the same levels keeps its open time; new levels = a new setup.
      double pt = SymbolInfoDouble(symbol, SYMBOL_POINT);
      bool freshSetup = isNew || g_sl_tracked[idx].action != action ||
                        MathAbs(g_sl_tracked[idx].sl - sl) > pt * 0.5 ||
                        MathAbs(g_sl_tracked[idx].tp - tp) > pt * 0.5;
      g_sl_tracked[idx].source     = source;
      g_sl_tracked[idx].tag        = tag;
      g_sl_tracked[idx].extra      = extraJson;
      g_sl_tracked[idx].confidence = confidence;
      if(freshSetup) g_sl_tracked[idx].openedAt = TimeGMT();
      g_sl_tracked[idx].key       = key;
      g_sl_tracked[idx].symbol    = symbol;
      g_sl_tracked[idx].action    = action;
      g_sl_tracked[idx].entry     = entry;
      g_sl_tracked[idx].sl        = sl;
      g_sl_tracked[idx].tp        = tp;
      g_sl_tracked[idx].expiresAt = (datetime)(TimeGMT() + expirySeconds);
      g_sl_tracked[idx].status    = "pending";
      g_sl_tracked[idx].lastLivePush = 0;   // 0 => first prune pushes live price immediately
      Print("Signal published: ", source, " ", symbol, " ", action, " @", entry);
      // A new setup goes to the Bridge for auto trade - not a re-publish of the same levels,
      // and not a setup this EA already announced before it (re)started.
      // (A re-announcement leaves the record as it was, so a duplicate copy of this EA on the
      // same chart sees the same pre-start publish and holds back too.)
      bool reannounce = SignalLib_IsReannounce(key, action);
      if(!reannounce) SignalLib_SavePub(key, action, (long)TimeGMT() + expirySeconds, (long)TimeGMT());
      if(freshSetup && !reannounce)
         SignalLib_HandOff(key, source, symbol, action, entry, sl, tp, extraJson);
      else if(freshSetup)
         Print("SignalLib: ", source, " ", action, " ", symbol, " was already announced before this EA started - not handed to auto trade");
      // Push-notify only the first time this setup appears (not on re-publishes).
      if(isNew && notify)
         SignalLib_NotifyFor(source, symbol, action + " " + symbol,
                             source + (pushNote != "" ? " - " + pushNote : (tag != "" ? " (" + tag + ")" : "")) +
                             "  @ " + DoubleToString(entry, digits) +
                             "  SL " + DoubleToString(sl, digits) + "  TP " + DoubleToString(tp, digits),
                             "{\"screen\":\"signals\",\"account\":\"" + g_sl_accountId + "\"}");
   }
   else Print("Signal publish FAILED HTTP ", r, " ", CharArrayToString(res));
   return (r == 200);
}

//+------------------------------------------------------------------+
//| Delete a signal node by key. Uses PATCH-null on the PARENT node    |
//| (short URL) instead of DELETE on the per-key URL: with the ~905-   |
//| char auth token in the query, the per-key URL exceeds MQL5's       |
//| ~1024-char WebRequest limit and silently fails, so hit/expired     |
//| signals would never actually be removed from the feed.             |
//+------------------------------------------------------------------+
void SignalLib_Delete(string key)
{
   string url = "https://" + g_sl_projectId + "-default-rtdb.firebaseio.com/signals.json?auth=" + g_sl_idToken;
   string body = "{\"" + g_sl_accountId + "/" + key + "\":null}";
   char post[]; StringToCharArray(body, post, 0, StringLen(body));
   char res[]; string hdr;
   WebRequest("PATCH", url, "Content-Type: application/json\r\n", 5000, post, res, hdr);
}

//+------------------------------------------------------------------+
//| Update just the status field of a published signal (winning /     |
//| pending), via a multi-path PATCH on the parent (short URL).        |
//+------------------------------------------------------------------+
void SignalLib_SetStatus(string key, string status, double currentPrice, int digits)
{
   string url = "https://" + g_sl_projectId + "-default-rtdb.firebaseio.com/signals.json?auth=" + g_sl_idToken;
   // multi-path PATCH: update this signal's status AND live price so the app can
   // draw a "where is price now" progress bar between entry/SL/TP. Short URL.
   string p = g_sl_accountId + "/" + key;
   string body = "{\"" + p + "/status\":\"" + status + "\",\"" + p + "/currentPrice\":" + DoubleToString(currentPrice, digits) + "}";
   char post[]; StringToCharArray(body, post, 0, StringLen(body));
   char res[]; string hdr;
   WebRequest("PATCH", url, "Content-Type: application/json\r\n", 5000, post, res, hdr);
}

//+------------------------------------------------------------------+
//| Record how a signal resolved (for the app's Scorecard):            |
//|  signalLog/{account}/{openedMinute_key} = {source, symbol, action, |
//|  entry, sl, tp, tag, confidence, openedAt, closedAt, outcome       |
//|  ("tp"|"sl"|"expired"), exitPrice, r}. Paper result from the       |
//|  signal's own entry, whether or not it was traded. Written as a    |
//|  multi-path PATCH on the root node so the URL stays short.         |
//+------------------------------------------------------------------+
void SignalLib_LogOutcome(int i, string outcome, double exitPrice)
{
   double e = g_sl_tracked[i].entry, sl = g_sl_tracked[i].sl, tp = g_sl_tracked[i].tp;
   double risk = MathAbs(e - sl);
   if(e <= 0 || sl <= 0 || risk <= 0) return;                // no defined risk -> no R
   double r = (g_sl_tracked[i].action == "BUY") ? (exitPrice - e) / risk : (e - exitPrice) / risk;
   int dg = (int)SymbolInfoInteger(g_sl_tracked[i].symbol, SYMBOL_DIGITS);
   long closedAt = (long)TimeGMT();
   string rec = "{\"key\":\"" + SignalLib_JsonEsc(g_sl_tracked[i].key) + "\"," +
                "\"source\":\"" + SignalLib_JsonEsc(g_sl_tracked[i].source) + "\"," +
                "\"symbol\":\"" + SignalLib_JsonEsc(g_sl_tracked[i].symbol) + "\"," +
                "\"action\":\"" + g_sl_tracked[i].action + "\"," +
                "\"entry\":" + DoubleToString(e, dg) + "," +
                "\"sl\":" + DoubleToString(sl, dg) + "," +
                "\"tp\":" + DoubleToString(tp, dg) + "," +
                "\"tag\":\"" + SignalLib_JsonEsc(g_sl_tracked[i].tag) + "\"," +
                "\"confidence\":" + IntegerToString(g_sl_tracked[i].confidence) + "," +
                "\"openedAt\":" + IntegerToString((long)g_sl_tracked[i].openedAt) + "," +
                "\"closedAt\":" + IntegerToString(closedAt) + "," +
                "\"outcome\":\"" + outcome + "\"," +
                "\"exitPrice\":" + DoubleToString(exitPrice, dg) + "," +
                "\"r\":" + DoubleToString(r, 3) +
                (g_sl_tracked[i].extra != "" ? "," + g_sl_tracked[i].extra : "") + "}";
   // Keyed by the minute the setup opened: duplicate EA instances on one symbol
   // (same source, same setup) overwrite one record instead of double-counting.
   long openedMin = ((long)g_sl_tracked[i].openedAt > 0 ? (long)g_sl_tracked[i].openedAt : closedAt) / 60 * 60;
   string path = g_sl_accountId + "/" + IntegerToString(openedMin) + "_" + g_sl_tracked[i].key;
   string url  = "https://" + g_sl_projectId + "-default-rtdb.firebaseio.com/signalLog.json?auth=" + g_sl_idToken;
   string body = "{\"" + path + "\":" + rec + "}";
   char post[]; StringToCharArray(body, post, 0, StringLen(body), CP_UTF8);
   char res[]; string hdr;
   int code = WebRequest("PATCH", url, "Content-Type: application/json\r\n", 5000, post, res, hdr);
   Print("SignalLib: outcome ", g_sl_tracked[i].source, " ", g_sl_tracked[i].symbol, " ", outcome,
         " R=", DoubleToString(r, 2), " (HTTP ", code, ")");
}

//+------------------------------------------------------------------+
//| Prune published signals whose SL/TP has been hit or that expired. |
//| Call every tick from the strategy EA. Keeps the feed showing only |
//| still-valid signals.                                              |
//+------------------------------------------------------------------+
void SignalLib_Prune()
{
   int total = ArraySize(g_sl_tracked);
   if(total == 0) return;
   if(!SignalLib_EnsureAuth()) return;

   datetime now = TimeGMT();
   for(int i = total - 1; i >= 0; i--)
   {
      string sym = g_sl_tracked[i].symbol;
      double bid = SymbolInfoDouble(sym, SYMBOL_BID);
      double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
      if(bid <= 0 || ask <= 0) continue;

      double sl = g_sl_tracked[i].sl;
      double tp = g_sl_tracked[i].tp;
      bool invalid = false;

      if(g_sl_tracked[i].expiresAt > 0 && now >= g_sl_tracked[i].expiresAt) invalid = true;

      if(g_sl_tracked[i].action == "BUY")
      {
         if(sl > 0 && bid <= sl) invalid = true; // stop hit
         if(tp > 0 && bid >= tp) invalid = true; // target hit
      }
      else // SELL
      {
         if(sl > 0 && ask >= sl) invalid = true;
         if(tp > 0 && ask <= tp) invalid = true;
      }

      if(invalid)
      {
         // Classify for the scorecard (SL checked first: conservative on gaps).
         string outcome = "expired";
         double exitPx  = (g_sl_tracked[i].action == "BUY") ? bid : ask;
         if(g_sl_tracked[i].action == "BUY")
         {
            if(sl > 0 && bid <= sl)      { outcome = "sl"; exitPx = sl; }
            else if(tp > 0 && bid >= tp) { outcome = "tp"; exitPx = tp; }
         }
         else
         {
            if(sl > 0 && ask >= sl)      { outcome = "sl"; exitPx = sl; }
            else if(tp > 0 && ask <= tp) { outcome = "tp"; exitPx = tp; }
         }
         SignalLib_LogOutcome(i, outcome, exitPx);
         SignalLib_Delete(g_sl_tracked[i].key);
         SignalLib_SavePub(g_sl_tracked[i].key, g_sl_tracked[i].action, 0, (long)g_sl_tracked[i].openedAt);   // closed
         for(int j = i; j < ArraySize(g_sl_tracked) - 1; j++) g_sl_tracked[j] = g_sl_tracked[j+1];
         ArrayResize(g_sl_tracked, ArraySize(g_sl_tracked) - 1);
         continue;
      }

      // Still valid: keep the live status accurate. "winning" once price has
      // moved in the signal's favour from entry, else "pending".
      double px = (g_sl_tracked[i].action == "BUY") ? bid : ask;
      double e  = g_sl_tracked[i].entry;
      string want = "pending";
      if(e > 0)
      {
         if(g_sl_tracked[i].action == "BUY"  && px > e) want = "winning";
         if(g_sl_tracked[i].action == "SELL" && px < e) want = "winning";
      }
      // Push status + live price when status flips, or every ~4s to keep the
      // app's price-progress bar fresh without flooding WebRequest.
      bool statusChanged = (want != g_sl_tracked[i].status);
      if(statusChanged || (now - g_sl_tracked[i].lastLivePush) >= 4)
      {
         int sdig = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
         SignalLib_SetStatus(g_sl_tracked[i].key, want, px, sdig);
         g_sl_tracked[i].status = want;
         g_sl_tracked[i].lastLivePush = now;
      }
   }
}

#endif // __FXC_SIGNALLIB_MQH__
