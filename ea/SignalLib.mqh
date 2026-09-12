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
string   g_sl_accountId      = "";

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
bool SignalLib_Init(string projectId, string apiKey, string email, string password)
{
   g_sl_projectId = projectId;
   g_sl_apiKey    = apiKey;
   g_sl_email     = email;
   g_sl_password  = password;
   g_sl_accountId = SignalLib_AccountID();
   bool ok = SignalLib_SignIn();
   Print("SignalLib init for account ", g_sl_accountId, ok ? " (auth OK)" : " (auth FAILED - check email/password)");
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
