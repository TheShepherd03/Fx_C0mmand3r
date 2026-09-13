//+------------------------------------------------------------------+
//|                                                       SignalLib.mqh|
//|         Shared Firebase signal publisher for FX Commander         |
//|  Include this in any "signal-only" EA. It handles anonymous auth  |
//|  and exposes PublishSignal(...) to append a signal (with SL/TP)   |
//|  to the app's Market Signals feed. These EAs never place trades.  |
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

// --- Live signals this EA has published (for SL/TP-hit + expiry pruning) ---
struct SL_Tracked
{
   string   key;        // Firebase push key
   string   symbol;
   string   action;     // BUY / SELL
   double   sl;
   double   tp;
   datetime expiresAt;
};
SL_Tracked g_sl_tracked[];

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
   g_sl_tokenExpiry = TimeCurrent() + expSec - 300;
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
   g_sl_tokenExpiry = TimeCurrent() + expSec - 300;
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
   if(TimeCurrent() >= exp - 60) return false;   // stale / about to expire
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
   datetime now = TimeCurrent();
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
   int h = FileOpen("fxcommander_auth.txt", FILE_READ|FILE_BIN);
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

bool SignalLib_Init(string projectId, string apiKey, string email, string password)
{
   g_sl_projectId = projectId;
   g_sl_apiKey    = apiKey;
   g_sl_email     = email;
   g_sl_password  = password;
   SignalLib_LoadCredsIfBlank();
   g_sl_accountId = SignalLib_AccountID();
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
      g_sl_lastAuthAttempt = TimeCurrent() + (MathRand() % 120);   // future => EnsureAuth waits, staggered
      ok = false;
      Print("SignalLib init for account ", g_sl_accountId, " (auth deferred, staggered)");
   }
   return ok;
}

//+------------------------------------------------------------------+
//| Publish a discrete signal (appends via POST). true on HTTP 200.   |
//|  action: "BUY" or "SELL"; expirySeconds: how long it stays live.  |
//+------------------------------------------------------------------+
bool PublishSignal(string symbol, string action, double entry, double sl, double tp,
                   double lots, string source, int confidence, int expirySeconds)
{
   if(!SignalLib_EnsureAuth()) { Print("SignalLib: no auth, skipping signal"); return false; }

   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   CJSONObject *o = new CJSONObject();
   o.Add("symbol",     symbol);
   o.Add("action",     action);
   o.Add("price",      NormalizeDouble(entry, digits));
   o.Add("sl",         NormalizeDouble(sl, digits));
   o.Add("tp",         NormalizeDouble(tp, digits));
   o.Add("lots",       lots);
   o.Add("tickValue",  SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE));
   o.Add("tickSize",   SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE));
   o.Add("source",     source);
   o.Add("confidence", confidence);
   o.Add("status",     "pending");
   o.Add("timestamp",  (int)TimeCurrent());
   o.Add("expiresAt",  (int)(TimeCurrent() + expirySeconds));
   string body = o.ToString();
   delete o;

   // POST appends a uniquely-keyed child so multiple discrete signals accumulate
   string url = "https://" + g_sl_projectId + "-default-rtdb.firebaseio.com/signals/" + g_sl_accountId + ".json?auth=" + g_sl_idToken;
   char post[]; StringToCharArray(body, post, 0, StringLen(body));
   char res[]; string hdr;
   int r = WebRequest("POST", url, "Content-Type: application/json\r\n", 5000, post, res, hdr);
   if(r == 200)
   {
      // Track the signal so we can delete it when SL/TP is hit or it expires.
      // Firebase POST returns {"name":"-Nxxxx"} - that child key is the id.
      string key = SignalLib_ExtractJson(CharArrayToString(res), "name");
      if(key != "")
      {
         int n = ArraySize(g_sl_tracked);
         ArrayResize(g_sl_tracked, n + 1);
         g_sl_tracked[n].key       = key;
         g_sl_tracked[n].symbol    = symbol;
         g_sl_tracked[n].action    = action;
         g_sl_tracked[n].sl        = sl;
         g_sl_tracked[n].tp        = tp;
         g_sl_tracked[n].expiresAt = (datetime)(TimeCurrent() + expirySeconds);
      }
      Print("Signal published: ", source, " ", symbol, " ", action, " @", entry);
   }
   else Print("Signal publish FAILED HTTP ", r, " ", CharArrayToString(res));
   return (r == 200);
}

//+------------------------------------------------------------------+
//| Delete a signal node by key                                       |
//+------------------------------------------------------------------+
void SignalLib_Delete(string key)
{
   string url = "https://" + g_sl_projectId + "-default-rtdb.firebaseio.com/signals/" + g_sl_accountId + "/" + key + ".json?auth=" + g_sl_idToken;
   char post[]; char res[]; string hdr;
   WebRequest("DELETE", url, "", 5000, post, res, hdr);
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

   datetime now = TimeCurrent();
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
         SignalLib_Delete(g_sl_tracked[i].key);
         for(int j = i; j < ArraySize(g_sl_tracked) - 1; j++) g_sl_tracked[j] = g_sl_tracked[j+1];
         ArrayResize(g_sl_tracked, ArraySize(g_sl_tracked) - 1);
      }
   }
}

#endif // __FXC_SIGNALLIB_MQH__
