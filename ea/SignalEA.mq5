//+------------------------------------------------------------------+
//|                                                      SignalEA.mq5 |
//|                                  Copyright 2026, TradeCommand EA |
//|         Multi-timeframe EMA-vs-Wilder signal engine (FX Commander)|
//+------------------------------------------------------------------+
#property copyright "TradeCommand SignalEA"
#property version   "1.00"
#property description "Computes multi-timeframe EMA/Wilder trend consensus and pushes signals to FX Commander"

#include "JAson.mqh"

//+------------------------------------------------------------------+
//| Inputs                                                            |
//+------------------------------------------------------------------+
input group "=== Firebase Configuration ==="
input string Inp_ProjectID = "c0mmand3r";                            // Firebase Project ID
input string Inp_ApiKey    = "AIzaSyCA3LUdogLeo7wdHEfxfPQtG4EG2SqEFtg"; // Firebase Web API Key
input string Inp_Email     = "";                                     // Firebase account email
input string Inp_Password  = "";                                     // Firebase account password

input group "=== Signal EMAs (period + timeframe per market cycle) ==="
input int              Inp_P1  = 78;             // EMA 1 period (~1-Day)
input ENUM_TIMEFRAMES  Inp_TF1 = PERIOD_M5;      // EMA 1 timeframe
input int              Inp_P2  = 137;            // EMA 2 period (~1-Week)
input ENUM_TIMEFRAMES  Inp_TF2 = PERIOD_M15;     // EMA 2 timeframe
input int              Inp_P3  = 195;            // EMA 3 period (~1-Month)
input ENUM_TIMEFRAMES  Inp_TF3 = PERIOD_H1;      // EMA 3 timeframe
input int              Inp_P4  = 63;             // EMA 4 period (1-Quarter)
input ENUM_TIMEFRAMES  Inp_TF4 = PERIOD_D1;      // EMA 4 timeframe
input int              Inp_P5  = 52;             // EMA 5 period (1-Year)
input ENUM_TIMEFRAMES  Inp_TF5 = PERIOD_W1;      // EMA 5 timeframe

input group "=== Signal Settings ==="
input int    Inp_PushInterval  = 5;      // Signal update interval (seconds) - continuous
input double Inp_ChopPct       = 0.02;   // EMA/Wilder gap under this % of price = flat/chop
input double Inp_SignalLots    = 0.05;   // Suggested lot size attached to a signal
input bool   Inp_Verbose       = true;   // Print detailed logs

input group "=== SL/TP (ATR-based) ==="
input int    Inp_ATRPeriod     = 14;     // ATR period (chart timeframe)
input double Inp_SLAtrMult     = 1.5;    // SL distance = this x ATR
input double Inp_RR            = 2.0;     // TP distance = SL distance x this

//+------------------------------------------------------------------+
//| Globals                                                           |
//+------------------------------------------------------------------+
#define NUM_CYCLES 5

int    g_periods[NUM_CYCLES];
ENUM_TIMEFRAMES g_tfs[NUM_CYCLES];
int    g_emaHandle[NUM_CYCLES];
int    g_wilderHandle[NUM_CYCLES];
int    g_atr = INVALID_HANDLE;

string g_idToken = "";
string g_refreshToken = "";
datetime g_tokenExpiry = 0;
datetime g_lastAuthAttempt = 0;
int    g_authBackoff = 30;   // seconds between real sign-in attempts; grows on rate-limit
string g_AccountID = "";
string g_authEmail = "";
string g_authPassword = "";

// Shared token cache: all FX Commander EAs on this account reuse ONE Firebase
// token via this local file, so ~20 EAs don't each sign in (TOO_MANY_ATTEMPTS).
#define FXC_TOKEN_FILE "fxcommander_token.txt"

// Temporary bypass: if this flag file exists, skip Firebase auth and publish
// unauthenticated (needs open rules on signals/). Delete file + re-lock to undo.
#define FXC_NOAUTH_FILE "fxcommander_noauth.txt"
bool   g_noAuth = false;

datetime g_lastPush = 0;
string   g_lastAction = "";       // last pushed action for this symbol
double   g_signalStartPrice = 0;  // price when the current action began (for winning/pending)

//+------------------------------------------------------------------+
//| Extract a value for `key` from raw JSON (quoted or bare).         |
//+------------------------------------------------------------------+
string ExtractJsonValue(string json, string key)
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
      if(c == ' ' || c == '\t' || c == '\r' || c == '\n') p++; else break;
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
      if(c == ',' || c == '}' || c == ']' || c == ' ' || c == '\r' || c == '\n' || c == '\t') break;
      p++;
   }
   return StringSubstr(json, start, p - start);
}

//+------------------------------------------------------------------+
//| Firebase anonymous sign-in                                        |
//+------------------------------------------------------------------+
bool FirebaseSignIn()
{
   string url = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + Inp_ApiKey;
   string body = "{\"email\":\"" + g_authEmail + "\",\"password\":\"" + g_authPassword + "\",\"returnSecureToken\":true}";
   char postData[]; StringToCharArray(body, postData, 0, StringLen(body));
   char resultData[]; string resultHeaders;
   int res = WebRequest("POST", url, "Content-Type: application/json\r\n", 5000, postData, resultData, resultHeaders);
   if(res != 200)
   {
      Print("SignalEA Firebase sign-in FAILED. HTTP ", res, " ", CharArrayToString(resultData));
      return false;
   }
   string response = CharArrayToString(resultData);
   g_idToken      = ExtractJsonValue(response, "idToken");
   g_refreshToken = ExtractJsonValue(response, "refreshToken");
   int expSec     = (int)StringToInteger(ExtractJsonValue(response, "expiresIn"));
   if(expSec <= 0) expSec = 3600;
   g_tokenExpiry  = TimeCurrent() + expSec - 300;
   if(g_idToken == "") { Print("SignalEA: no idToken in response"); return false; }
   Print("SignalEA Firebase sign-in OK.");
   return true;
}

//+------------------------------------------------------------------+
//| Refresh the ID token                                              |
//+------------------------------------------------------------------+
bool FirebaseRefreshToken()
{
   if(g_refreshToken == "") return FirebaseSignIn();
   string url = "https://securetoken.googleapis.com/v1/token?key=" + Inp_ApiKey;
   string body = "grant_type=refresh_token&refresh_token=" + g_refreshToken;
   char postData[]; StringToCharArray(body, postData, 0, StringLen(body));
   char resultData[]; string resultHeaders;
   int res = WebRequest("POST", url, "Content-Type: application/x-www-form-urlencoded\r\n", 5000, postData, resultData, resultHeaders);
   if(res != 200) return FirebaseSignIn();
   string response = CharArrayToString(resultData);
   g_idToken = ExtractJsonValue(response, "id_token");
   string rt = ExtractJsonValue(response, "refresh_token");
   if(rt != "") g_refreshToken = rt;
   int expSec = (int)StringToInteger(ExtractJsonValue(response, "expires_in"));
   if(expSec <= 0) expSec = 3600;
   g_tokenExpiry = TimeCurrent() + expSec - 300;
   if(g_idToken == "") return FirebaseSignIn();
   return true;
}

//+------------------------------------------------------------------+
//| Shared token cache (file), shared with every FX Commander EA.     |
//+------------------------------------------------------------------+
bool ReadSharedToken()
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
   if(TimeCurrent() >= exp - 60) return false;
   g_idToken      = good[0];
   g_refreshToken = good[1];
   g_tokenExpiry  = exp;
   return (g_idToken != "");
}

void WriteSharedToken()
{
   int h = FileOpen(FXC_TOKEN_FILE, FILE_WRITE|FILE_BIN|FILE_SHARE_READ|FILE_SHARE_WRITE);
   if(h == INVALID_HANDLE) return;
   string content = g_idToken + "\n" + g_refreshToken + "\n" + IntegerToString((long)g_tokenExpiry) + "\n";
   uchar buf[];
   int len = StringToCharArray(content, buf, 0, StringLen(content), CP_UTF8);
   if(len > 0) FileWriteArray(h, buf, 0, len);
   FileClose(h);
}

//+------------------------------------------------------------------+
//| Ensure a valid token: in-memory -> shared file -> sign-in/refresh |
//| (throttled with backoff so many EAs don't storm Firebase auth).   |
//+------------------------------------------------------------------+
bool EnsureValidToken()
{
   if(g_noAuth) return true;   // bypass: publish unauthenticated (open rules)
   datetime now = TimeCurrent();
   if(g_idToken != "" && now < g_tokenExpiry) return true;
   if(ReadSharedToken()) return true;
   if(now - g_lastAuthAttempt < g_authBackoff) return false;
   g_lastAuthAttempt = now;
   bool ok = (g_idToken == "") ? FirebaseSignIn() : FirebaseRefreshToken();
   if(ok) { g_authBackoff = 30; WriteSharedToken(); }
   else   { g_authBackoff = (g_authBackoff * 2 > 600) ? 600 : g_authBackoff * 2; }
   return ok;
}

//+------------------------------------------------------------------+
//| Unique account id: Company_Server_AccountNumber                   |
//+------------------------------------------------------------------+
string GenerateAccountID()
{
   long accountNumber = AccountInfoInteger(ACCOUNT_LOGIN);
   string serverName  = AccountInfoString(ACCOUNT_SERVER);
   string companyName = AccountInfoString(ACCOUNT_COMPANY);
   string id = companyName + "_" + serverName + "_" + IntegerToString(accountNumber);
   StringReplace(id, " ", "_"); StringReplace(id, "-", "_"); StringReplace(id, ".", "_");
   StringReplace(id, "(", "_"); StringReplace(id, ")", "_");
   return id;
}

//+------------------------------------------------------------------+
//| Init                                                              |
//+------------------------------------------------------------------+
int OnInit()
{
   g_periods[0]=Inp_P1; g_tfs[0]=Inp_TF1;
   g_periods[1]=Inp_P2; g_tfs[1]=Inp_TF2;
   g_periods[2]=Inp_P3; g_tfs[2]=Inp_TF3;
   g_periods[3]=Inp_P4; g_tfs[3]=Inp_TF4;
   g_periods[4]=Inp_P5; g_tfs[4]=Inp_TF5;

   for(int i=0;i<NUM_CYCLES;i++)
   {
      g_emaHandle[i]    = iMA(_Symbol, g_tfs[i], g_periods[i], 0, MODE_EMA,  PRICE_CLOSE);
      g_wilderHandle[i] = iMA(_Symbol, g_tfs[i], g_periods[i], 0, MODE_SMMA, PRICE_CLOSE); // Wilder = SMMA
      if(g_emaHandle[i]==INVALID_HANDLE || g_wilderHandle[i]==INVALID_HANDLE)
      {
         Print("SignalEA: failed to create MA handle for cycle ", i);
         return INIT_FAILED;
      }
   }

   g_atr = iATR(_Symbol, PERIOD_CURRENT, Inp_ATRPeriod);

   g_AccountID = GenerateAccountID();

   // Temporary unauthenticated bypass (flag file present) — skip all auth.
   if(FileIsExist(FXC_NOAUTH_FILE))
   {
      g_noAuth = true;
      EventSetTimer(Inp_PushInterval < 1 ? 1 : Inp_PushInterval);
      Print("SignalEA NO-AUTH bypass on ", _Symbol, " | publishing unauthenticated | Account ", g_AccountID);
      return INIT_SUCCEEDED;
   }

   // Resolve credentials: inputs first, else local fxcommander_auth.txt.
   // Read raw bytes and split manually so FileReadString's line-ending quirks
   // (LF-only / mixed) can't swallow both lines into the email field.
   g_authEmail    = Inp_Email;
   g_authPassword = Inp_Password;
   if(g_authEmail == "" || g_authPassword == "")
   {
      int hCred = FileOpen("fxcommander_auth.txt", FILE_READ|FILE_BIN);
      if(hCred != INVALID_HANDLE)
      {
         int sz = (int)FileSize(hCred);
         uchar buf[];
         if(sz > 0) { ArrayResize(buf, sz); FileReadArray(hCred, buf, 0, sz); }
         FileClose(hCred);
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
         if(gc >= 1 && g_authEmail == "")    g_authEmail    = good[0];
         if(gc >= 2 && g_authPassword == "") g_authPassword = good[1];
         Print("SignalEA creds loaded: lines=", gc, " emailLen=", StringLen(g_authEmail), " pwLen=", StringLen(g_authPassword));
      }
      else Print("SignalEA: cred file open failed, err=", GetLastError());
   }

   // Don't sign in inline (that makes ~20 EAs storm Firebase on load). Reuse a
   // token cached in the shared file if present, else stagger the first real
   // sign-in by a random 0-120s so instances don't all hit the network at once.
   if(ReadSharedToken())
      Print("SignalEA auth: reused shared token on ", _Symbol);
   else
   {
      MathSrand((int)(GetMicrosecondCount() + TimeLocal()));
      g_lastAuthAttempt = TimeCurrent() + (MathRand() % 120);
      Print("SignalEA auth: deferred/staggered on ", _Symbol);
   }

   EventSetTimer(Inp_PushInterval < 1 ? 1 : Inp_PushInterval);
   Print("SignalEA initialized on ", _Symbol, " | Account ", g_AccountID);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   for(int i=0;i<NUM_CYCLES;i++)
   {
      if(g_emaHandle[i]!=INVALID_HANDLE)    IndicatorRelease(g_emaHandle[i]);
      if(g_wilderHandle[i]!=INVALID_HANDLE) IndicatorRelease(g_wilderHandle[i]);
   }
   if(g_atr!=INVALID_HANDLE) IndicatorRelease(g_atr);
   Print("SignalEA stopped on ", _Symbol);
}

//+------------------------------------------------------------------+
//| Read the latest value of an indicator buffer                      |
//+------------------------------------------------------------------+
bool LatestValue(int handle, double &value)
{
   double buf[];
   if(CopyBuffer(handle, 0, 0, 1, buf) <= 0) return false;
   value = buf[0];
   return true;
}

//+------------------------------------------------------------------+
//| Timer: compute consensus and push signal                          |
//+------------------------------------------------------------------+
void OnTimer()
{
   if(!EnsureValidToken()) return;

   double price = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(price <= 0) return;
   double chopBand = price * Inp_ChopPct / 100.0;

   int upCount = 0, downCount = 0, flatCount = 0, available = 0;
   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);

   CJSONArray *cyclesArr = new CJSONArray();

   for(int i=0;i<NUM_CYCLES;i++)
   {
      double ema=0, wilder=0;
      bool have = LatestValue(g_emaHandle[i], ema) && LatestValue(g_wilderHandle[i], wilder);

      CJSONObject *c = new CJSONObject();
      c.Add("period", g_periods[i]);
      c.Add("timeframe", EnumToString(g_tfs[i]));

      if(have)
      {
         int trend = 0; // 0 flat, 1 up, -1 down
         if(MathAbs(ema - wilder) <= chopBand) trend = 0;
         else if(ema > wilder) trend = 1;
         else trend = -1;

         if(trend == 1) upCount++; else if(trend == -1) downCount++; else flatCount++;
         available++;

         c.Add("ema", NormalizeDouble(ema, digits));
         c.Add("wilder", NormalizeDouble(wilder, digits));
         c.Add("trend", trend);
         c.Add("available", true);
      }
      else
      {
         c.Add("available", false); // this timeframe's history not loaded yet
      }
      cyclesArr.Add(c);
   }

   // Only skip if NO timeframe has data yet
   if(available == 0)
   {
      delete cyclesArr;
      if(Inp_Verbose) Print("SignalEA: no MA data available yet on ", _Symbol);
      return;
   }

   // Consensus across the timeframes that ARE available
   string action = "RANGE";
   if(upCount > 0 && downCount == 0)      action = "BUY";
   else if(downCount > 0 && upCount == 0) action = "SELL";

   int aligned = MathMax(upCount, downCount);
   int confidence = (int)MathRound((double)aligned / available * 100.0);

   // Winning / pending: track price since the action began
   if(action != g_lastAction)
   {
      g_lastAction = action;
      g_signalStartPrice = price;
   }
   string status = "pending";
   if(action == "BUY")  status = (price > g_signalStartPrice) ? "winning" : "pending";
   if(action == "SELL") status = (price < g_signalStartPrice) ? "winning" : "pending";
   if(action == "RANGE") status = "range";

   // Build payload
   CJSONObject *root = new CJSONObject();
   root.Add("symbol", _Symbol);
   root.Add("action", action);
   root.Add("price", NormalizeDouble(price, digits));
   // ATR-based SL/TP so EMA signals aren't stop-less when executed
   double atrVal = 0; { double _ab[]; if(CopyBuffer(g_atr, 0, 1, 1, _ab) > 0) atrVal = _ab[0]; }
   double slv = 0, tpv = 0;
   if(atrVal > 0 && (action == "BUY" || action == "SELL"))
   {
      double dd = atrVal * Inp_SLAtrMult;
      if(action == "BUY") { slv = price - dd; tpv = price + dd * Inp_RR; }
      else                { slv = price + dd; tpv = price - dd * Inp_RR; }
   }
   root.Add("sl", (slv > 0) ? NormalizeDouble(slv, digits) : 0);
   root.Add("tp", (tpv > 0) ? NormalizeDouble(tpv, digits) : 0);
   root.Add("lots", Inp_SignalLots);
   root.Add("tickValue", SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE));
   root.Add("tickSize",  SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE));
   root.Add("source", "EMA Engine");
   root.Add("confidence", confidence);
   root.Add("alignedCount", aligned);
   root.Add("availableCount", available);
   root.Add("upCount", upCount);
   root.Add("downCount", downCount);
   root.Add("status", status);
   root.Add("timestamp", (int)TimeCurrent());
   root.Add("cycles", cyclesArr);

   string jsonBody = root.ToString();
   delete root; // frees cyclesArr too

   // PUT to signals/{account}/{symbolKey} so multiple charts consolidate & self-update.
   // Firebase keys can't contain . $ # [ ] / so sanitize the symbol for the key only
   // (the real name is preserved in the "symbol" field for display).
   string symbolKey = _Symbol;
   StringReplace(symbolKey, ".", "_"); StringReplace(symbolKey, "$", "_");
   StringReplace(symbolKey, "#", "_"); StringReplace(symbolKey, "[", "_");
   StringReplace(symbolKey, "]", "_"); StringReplace(symbolKey, "/", "_");
   string url = "https://" + Inp_ProjectID + "-default-rtdb.firebaseio.com/signals/" + g_AccountID + "/" + symbolKey + ".json?auth=" + g_idToken;
   char postData[]; StringToCharArray(jsonBody, postData, 0, StringLen(jsonBody));
   char resultData[]; string resultHeaders;
   int res = WebRequest("PUT", url, "Content-Type: application/json\r\n", 5000, postData, resultData, resultHeaders);

   if(Inp_Verbose)
   {
      if(res == 200) Print("SignalEA ", _Symbol, " -> ", action, " (", confidence, "%, up=", upCount, " down=", downCount, ")");
      else Print("SignalEA push failed: ", res, " ", CharArrayToString(resultData));
   }
}
//+------------------------------------------------------------------+
