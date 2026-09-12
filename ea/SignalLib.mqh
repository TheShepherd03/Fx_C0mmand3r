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
string   g_sl_idToken        = "";
string   g_sl_refreshToken   = "";
datetime g_sl_tokenExpiry    = 0;
datetime g_sl_lastAuthAttempt= 0;
string   g_sl_accountId      = "";

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
//| Anonymous sign-in                                                 |
//+------------------------------------------------------------------+
bool SignalLib_SignIn()
{
   string url = "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=" + g_sl_apiKey;
   string body = "{\"returnSecureToken\":true}";
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
//| Ensure a valid token (throttled)                                  |
//+------------------------------------------------------------------+
bool SignalLib_EnsureAuth()
{
   if(g_sl_idToken != "" && TimeCurrent() < g_sl_tokenExpiry) return true;
   if(TimeCurrent() - g_sl_lastAuthAttempt < 30) return false;
   g_sl_lastAuthAttempt = TimeCurrent();
   if(g_sl_idToken == "") return SignalLib_SignIn();
   return SignalLib_Refresh();
}

//+------------------------------------------------------------------+
//| Initialise: store config, build account id, sign in.              |
//+------------------------------------------------------------------+
bool SignalLib_Init(string projectId, string apiKey)
{
   g_sl_projectId = projectId;
   g_sl_apiKey    = apiKey;
   g_sl_accountId = SignalLib_AccountID();
   bool ok = SignalLib_SignIn();
   Print("SignalLib init for account ", g_sl_accountId, ok ? " (auth OK)" : " (auth pending)");
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
   if(r == 200) Print("Signal published: ", source, " ", symbol, " ", action, " @", entry);
   else         Print("Signal publish FAILED HTTP ", r, " ", CharArrayToString(res));
   return (r == 200);
}

#endif // __FXC_SIGNALLIB_MQH__
