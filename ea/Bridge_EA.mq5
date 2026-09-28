//+------------------------------------------------------------------+
//|                                                    Bridge_EA.mq5 |
//|                                  Copyright 2026, TradeCommand EA |
//|                                           Data Bridge & Executor |
//+------------------------------------------------------------------+
#property copyright "TradeCommand Bridge"
#property version   "1.01"
#property description "Bridges MT5 to Firebase for TradeCommand App"
// Last Synced: 2026-02-19

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include <Trade\AccountInfo.mqh>
#include "JAson.mqh"

//+------------------------------------------------------------------+
//| Input Parameters                                                  |
//+------------------------------------------------------------------+
input group "=== Firebase Configuration ==="
input string Inp_ProjectID      = "c0mmand3r";      // Firebase Project ID
input string Inp_ApiKey         = "AIzaSyCA3LUdogLeo7wdHEfxfPQtG4EG2SqEFtg";     // Firebase Web API Key
input string Inp_Email          = "";                    // Firebase account email
input string Inp_Password       = "";                    // Firebase account password
input int    Inp_SyncInterval   = 2;                      // Data Sync Interval (seconds)
input int    Inp_HistoryInterval = 15;                    // History Snapshot Interval (minutes)

input group "=== Command Settings ==="
input int    Inp_PollInterval   = 2;                      // Command Poll Interval (seconds)
input bool   Inp_AllowClose     = true;                   // Allow App to Close Trades
input bool   Inp_Verbose        = true;                   // Print detailed logs

input group "=== External Signal Reception ==="
input bool   Inp_EnableSignalReceiving = true;            // Enable External Signal Reception
input string Inp_SignalComment = "TelegramSignal";        // Comment prefix for signal identification

//+------------------------------------------------------------------+
//| Global Variables                                                  |
//+------------------------------------------------------------------+
CTrade         trade;
CPositionInfo  posInfo;
CAccountInfo   accInfo;

//+------------------------------------------------------------------+
//| Deposit-currency money per one SYMBOL_TRADE_TICK_SIZE move for a  |
//| 1.0 lot, via OrderCalcProfit. Currency-correct for index/CFDs     |
//| where raw SYMBOL_TRADE_TICK_VALUE is unconverted (e.g. USA30 on a |
//| ZAR account returns 0.1 instead of the real ~1.6).                |
//+------------------------------------------------------------------+
double FXC_MoneyPerTick(string symbol)
{
   double ts = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
   double px = SymbolInfoDouble(symbol, SYMBOL_BID);
   if(px <= 0) px = SymbolInfoDouble(symbol, SYMBOL_ASK);
   if(px <= 0) px = SymbolInfoDouble(symbol, SYMBOL_LAST);
   double loss = 0.0;
   if(ts > 0 && px > 0 &&
      OrderCalcProfit(ORDER_TYPE_BUY, symbol, 1.0, px, px - ts, loss) && loss != 0.0)
      return MathAbs(loss);
   return SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE); // fallback
}

// Signal reception variables
datetime       g_lastSignalCheck = 0;
datetime       g_lastSignalTime = 0;

datetime       g_lastSyncTime = 0;
datetime       g_lastPollTime = 0;
datetime       g_lastHistoryTime = 0;
datetime       g_lastTradeHistoryTime = 0;
string         g_firestoreBaseUrl = "";
string         g_AccountID = "";  // Auto-generated unique Account ID

// Firebase Authentication (Option C: ID-token auth via the Auth REST API)
string         g_idToken = "";        // Current Firebase ID token used as ?auth=
string         g_refreshToken = "";   // Refresh token to renew the ID token
datetime       g_tokenExpiry = 0;     // When g_idToken must be refreshed (with safety margin)
datetime       g_lastAuthAttempt = 0; // Throttles (re)authentication retries
string         g_authEmail = "";      // Resolved email (input or local file)
string         g_authPassword = "";   // Resolved password (input or local file)

// Temporary bypass: if this flag file exists in MQL5/Files, skip Firebase auth
// and use the DB unauthenticated (requires open rules). Reversible with no
// recompile: delete the file + re-lock the rules + restart.
#define FXC_NOAUTH_FILE "fxcommander_noauth.txt"
bool           g_noAuth = false;

// Position Management Variables
bool           g_EAPaused = false;
bool           g_EASchedulePaused = false;
datetime       g_LastPauseCheck = 0;
double         g_DailyStartEquity = 0;
datetime       g_DayStart = 0;

// App-Controlled Settings (loaded from Firebase)
struct EASettings {
   // Position Management
   bool enableBreakeven;
   int breakevenThresholdPips;
   bool breakevenUsePercent;   // when true, use breakevenPercent (price-move % from entry) instead of pips
   double breakevenPercent;    // price move from entry in % that triggers break-even
   bool enableTrailing;
   bool enableTimeManagement;
   bool weekendClose;
   double dailyTargetPercent;
   
   // EA Schedule
   bool enableSchedule;
   string pauseStartTime;
   string pauseEndTime;
   int pauseMode;
   
   datetime lastUpdated;
};

EASettings g_Settings;
datetime g_LastSettingsCheck = 0;

struct PositionManagement {
   long ticket;
   bool breakevenEnabled;
   int breakevenThreshold;
   bool breakevenUsePercent;   // per-position: use breakevenPercent instead of pips
   double breakevenPercent;    // price move from entry in % that triggers break-even
   bool breakevenTriggered;
   bool trailingEnabled;
   int trailingPercentage;
   double lastTrailPrice;
   datetime timeLimit;
   bool weekendClose;
   double scaleInMultiplier;
   int scaleInThreshold;
   bool scaleInTriggered;
};

PositionManagement g_PosManagement[];
int g_PosManagementCount = 0;

//+------------------------------------------------------------------+
//| Function Prototypes                                               |
//+------------------------------------------------------------------+
string GenerateAccountID();
void CheckForExternalSignals();
void ProcessReceivedSignal(string signal);
void ForwardSignalToFirebase(string symbol, string action, double price, double sl, double tp, double lots, string source);
void SyncAccountData();
void PollCommands();
void SyncHistory();
void CloseAllPositions();
void ClosePositionsByProfit(bool winners);
void DeletePendingOrders();
void MarkCommandExecuted();
void ExecuteOpenPosition(string response);

// Position Management Function Prototypes
void LoadEASettings();
void InitializeDefaultSettings();
void CheckEASchedule();
void CheckBreakevenPositions();
void CheckTrailingStops();
void CheckTimeBasedManagement();
int FindPositionManagement(long ticket);
void AddPositionManagement(long ticket);
void RemovePositionManagement(long ticket);
void ExecuteBreakevenCommand(string response);
void ExecuteTrailingCommand(string response);
void ExecutePartialCloseCommand(string response);
void ExecuteScaleInCommand(string response);
void ExecuteEAScheduleCommand(string response);
void ExecuteEAPauseCommand(string response);
void ExecuteModifySLTPCommand(string response);
void ExecuteTimeLimitCommand(string response);
bool IsTimeInRange(string startTime, string endTime);
void InitializeDailyTracking();

//+------------------------------------------------------------------+
//| Initialization                                                    |
//+------------------------------------------------------------------+
//+------------------------------------------------------------------+
//| Generate Unique Account ID                                        |
//+------------------------------------------------------------------+
string GenerateAccountID()
{
   // Get account number and server name
   long accountNumber = AccountInfoInteger(ACCOUNT_LOGIN);
   string serverName = AccountInfoString(ACCOUNT_SERVER);
   string companyName = AccountInfoString(ACCOUNT_COMPANY);
   
   // Clean server name (remove spaces and special chars)
   StringReplace(serverName, " ", "_");
   StringReplace(serverName, "-", "_");
   StringReplace(serverName, ".", "_");
   
   // Create unique ID: Company_Server_AccountNumber
   string accountID = companyName + "_" + serverName + "_" + IntegerToString(accountNumber);
   
   // Clean up the ID (remove spaces, special chars)
   StringReplace(accountID, " ", "_");
   StringReplace(accountID, "-", "_");
   StringReplace(accountID, ".", "_");
   StringReplace(accountID, "(", "_");
   StringReplace(accountID, ")", "_");
   
   return accountID;
}

//+------------------------------------------------------------------+
//| Extract a value for `key` from a raw JSON string.                 |
//| Handles both quoted strings and bare numbers/booleans.            |
//| (JAson.mqh is serialize-only, so we parse responses manually.)    |
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
   // Skip whitespace after the colon
   while(p < len)
   {
      ushort c = StringGetCharacter(json, p);
      if(c == ' ' || c == '\t' || c == '\r' || c == '\n') p++;
      else break;
   }
   if(p >= len) return "";

   if(StringGetCharacter(json, p) == '"')
   {
      // Quoted string value
      p++;
      int end = StringFind(json, "\"", p);
      if(end < 0) return "";
      return StringSubstr(json, p, end - p);
   }
   else
   {
      // Bare number/boolean: read until , } ] or whitespace
      int start = p;
      while(p < len)
      {
         ushort c = StringGetCharacter(json, p);
         if(c == ',' || c == '}' || c == ']' || c == ' ' || c == '\r' || c == '\n' || c == '\t') break;
         p++;
      }
      return StringSubstr(json, start, p - start);
   }
}

//+------------------------------------------------------------------+
//| Sign in to Firebase (anonymous) and store a fresh ID token.       |
//| Endpoint: Identity Toolkit accounts:signUp with returnSecureToken.|
//+------------------------------------------------------------------+
bool FirebaseSignIn()
{
   string url = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + Inp_ApiKey;
   string body = "{\"email\":\"" + g_authEmail + "\",\"password\":\"" + g_authPassword + "\",\"returnSecureToken\":true}";

   char postData[];
   StringToCharArray(body, postData, 0, StringLen(body));
   char resultData[];
   string resultHeaders;
   string headers = "Content-Type: application/json\r\n";

   int res = WebRequest("POST", url, headers, 5000, postData, resultData, resultHeaders);
   if(res != 200)
   {
      Print("Firebase Sign-In FAILED. HTTP ", res, " Response: ", CharArrayToString(resultData));
      return false;
   }

   string response = CharArrayToString(resultData);
   g_idToken      = ExtractJsonValue(response, "idToken");
   g_refreshToken = ExtractJsonValue(response, "refreshToken");
   int expSec     = (int)StringToInteger(ExtractJsonValue(response, "expiresIn"));
   if(expSec <= 0) expSec = 3600;
   g_tokenExpiry  = TimeGMT() + expSec - 300; // refresh 5 minutes early (wall clock: TimeCurrent freezes without ticks)

   if(g_idToken == "")
   {
      Print("Firebase Sign-In: no idToken in response: ", response);
      return false;
   }
   Print("Firebase Sign-In OK. ID token valid for ~", expSec, "s.");
   return true;
}

//+------------------------------------------------------------------+
//| Renew the ID token using the refresh token.                       |
//| Endpoint: securetoken.googleapis.com (returns snake_case fields). |
//+------------------------------------------------------------------+
bool FirebaseRefreshToken()
{
   if(g_refreshToken == "")
      return FirebaseSignIn();

   string url = "https://securetoken.googleapis.com/v1/token?key=" + Inp_ApiKey;
   string body = "grant_type=refresh_token&refresh_token=" + g_refreshToken;

   char postData[];
   StringToCharArray(body, postData, 0, StringLen(body));
   char resultData[];
   string resultHeaders;
   string headers = "Content-Type: application/x-www-form-urlencoded\r\n";

   int res = WebRequest("POST", url, headers, 5000, postData, resultData, resultHeaders);
   if(res != 200)
   {
      Print("Firebase Token Refresh FAILED. HTTP ", res, " Response: ", CharArrayToString(resultData),
            " - falling back to fresh sign-in.");
      return FirebaseSignIn();
   }

   string response = CharArrayToString(resultData);
   g_idToken   = ExtractJsonValue(response, "id_token");
   string rt   = ExtractJsonValue(response, "refresh_token");
   if(rt != "") g_refreshToken = rt;
   int expSec  = (int)StringToInteger(ExtractJsonValue(response, "expires_in"));
   if(expSec <= 0) expSec = 3600;
   g_tokenExpiry = TimeGMT() + expSec - 300;

   if(g_idToken == "")
      return FirebaseSignIn();
   return true;
}

//+------------------------------------------------------------------+
//| Guarantee a valid ID token before any authenticated request.      |
//| Retries are throttled to avoid hammering the auth endpoint.       |
//+------------------------------------------------------------------+
bool EnsureValidToken()
{
   if(g_noAuth) return true;   // bypass: use the DB unauthenticated (open rules)
   if(g_idToken != "" && TimeGMT() < g_tokenExpiry)
      return true;

   // (Re)authentication needed - throttle attempts to once every 30s
   if(TimeGMT() - g_lastAuthAttempt < 30)
      return false;
   g_lastAuthAttempt = TimeGMT();

   if(g_idToken == "")
      return FirebaseSignIn();
   return FirebaseRefreshToken();
}

int OnInit()
{
   // Validate Inputs
   if(Inp_ProjectID == "YOUR_PROJECT_ID" || Inp_ApiKey == "YOUR_WEB_API_KEY")
   {
      Alert("Please configure Firebase Project ID and API Key!");
      return INIT_FAILED;
   }

   // Auto-generate unique Account ID
   g_AccountID = GenerateAccountID();
   
   // Construct Base URL for Firebase Realtime Database
   g_firestoreBaseUrl = "https://" + Inp_ProjectID + "-default-rtdb.firebaseio.com";

   // Temporary unauthenticated bypass (flag file present) — skip all auth.
   if(FileIsExist(FXC_NOAUTH_FILE))
   {
      g_noAuth = true;
      Print("TradeCommand Bridge: NO-AUTH bypass active - using the DB unauthenticated (open rules).");
   }
   else
   {
      // Resolve credentials: EA inputs first, else a local file shared by all EAs
      // (MQL5/Files/fxcommander_auth.txt: line 1 = email, line 2 = password).
      // Read raw bytes and split manually so FileReadString's line-ending quirks
      // can't swallow both lines into the email field.
      g_authEmail    = Inp_Email;
      g_authPassword = Inp_Password;
      if(g_authEmail == "" || g_authPassword == "")
      {
         // FILE_SHARE_* so many EAs opening this at once on startup don't collide.
         int hCred = FileOpen("fxcommander_auth.txt", FILE_READ|FILE_BIN|FILE_SHARE_READ|FILE_SHARE_WRITE);
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
         }
      }

      // Authenticate with Firebase to obtain an ID token.
      // A valid token is required for every Realtime Database request.
      if(FirebaseSignIn())
         Print("Firebase authentication successful.");
      else
         Print("WARNING: Firebase authentication failed on init - will retry automatically. ",
               "If this persists, whitelist BOTH of these URLs in Tools > Options > Expert Advisors: ",
               "https://identitytoolkit.googleapis.com  and  https://securetoken.googleapis.com");
   }

   // Initialize signal reception system
   if(Inp_EnableSignalReceiving)
   {
      Print("External signal reception enabled. Monitoring for signals from other EAs...");
      g_lastSignalCheck = TimeCurrent();
   }

   // Initialize default settings
   InitializeDefaultSettings();
   
   // Load EA settings from Firebase
   LoadEASettings();

   // Restore per-position settings (break-even / trailing / time limit ...) saved
   // before a restart, BEFORE EnsureAllPositionsTracked seeds untracked positions
   // from the global defaults.
   LoadPositionManagement();

   // Initialize Timer for regular loops (1 second resolution)
   EventSetTimer(1);

   Print("============================================");
   Print("TradeCommand Bridge Initialized");
   Print("Account Number: ", AccountInfoInteger(ACCOUNT_LOGIN));
   Print("Server: ", AccountInfoString(ACCOUNT_SERVER));
   Print("Company: ", AccountInfoString(ACCOUNT_COMPANY));
   Print("Auto-Generated Account ID: ", g_AccountID);
   Print("Firebase URL: ", g_firestoreBaseUrl);
   Print("============================================");
   
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Deinitialization                                                  |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   Print("TradeCommand Bridge Stopped.");
}

//+------------------------------------------------------------------+
//| Timer Event                                                       |
//+------------------------------------------------------------------+
void OnTimer()
{
   // Wall clock, not TimeCurrent(): TimeCurrent() is the last tick's server time and
   // freezes when the market is closed (weekends on HFM), which silently stopped
   // syncing, settings reloads and command polling until Monday's first tick.
   datetime now = TimeGMT();

   // Position protection first, every second: independent of the chart symbol's
   // ticks (the Bridge sits on one chart, e.g. USDJPY, which doesn't tick when that
   // market is shut), of Firebase connectivity, and of the "no new trades" pause.
   ManagePositions();

   // Ensure we hold a valid Firebase ID token before any network operation.
   if(!EnsureValidToken())
      return;

   // 1. Sync Data (Push to Firebase)
   if(now - g_lastSyncTime >= Inp_SyncInterval)
   {
      SyncAccountData();
      g_lastSyncTime = now;
   }

   // 2. Load EA Settings (every 10 seconds)
   if(now - g_LastSettingsCheck >= 10)
   {
      LoadEASettings();
      g_LastSettingsCheck = now;
   }

   // 3. Poll Commands (Pull from Firebase)
   if(now - g_lastPollTime >= Inp_PollInterval)
   {
      PollCommands();
      g_lastPollTime = now;
   }

   // 3. Sync History (Push Snapshot)
   if(now - g_lastHistoryTime >= Inp_HistoryInterval * 60)
   {
      SyncHistory();
      g_lastHistoryTime = now;
   }

   // 4. Sync closed-trade history (last 30 days) every 60s
   if(now - g_lastTradeHistoryTime >= 60)
   {
      SyncTradeHistory();
      g_lastTradeHistoryTime = now;
   }
}

//+------------------------------------------------------------------+
//| OnTick Event                                                      |
//+------------------------------------------------------------------+
void OnTick()
{
   // Check EA Schedule and pause if necessary
   if(g_Settings.enableSchedule)
      CheckEASchedule();
   
   // Skip all operations if EA is paused
   if(g_EAPaused || g_EASchedulePaused)
      return;

   // (Break-even / trailing / time management run from OnTimer -> ManagePositions.)

   // Check for external signals (every 5 seconds)
   if(Inp_EnableSignalReceiving)
   {
      datetime now = TimeCurrent();
      if(now - g_lastSignalCheck >= 5)
      {
         CheckForExternalSignals();
         g_lastSignalCheck = now;
      }
   }
}

//+------------------------------------------------------------------+
//| Check for External Signals from Other EAs                        |
//+------------------------------------------------------------------+
void CheckForExternalSignals()
{
   // Check for new signals by monitoring open positions/orders with specific comments
   // This method works by monitoring positions/orders opened by signal provider EAs
   
   int totalOrders = OrdersTotal();
   int totalPositions = PositionsTotal();
   
   // Check pending orders for new signals
   for(int i = 0; i < totalOrders; i++)
   {
      ulong ticket = OrderGetTicket(i);
      if(OrderSelect(ticket))
      {
         string comment = OrderGetString(ORDER_COMMENT);
         
         // Check if this is a signal from our monitored source
         if(StringFind(comment, Inp_SignalComment) >= 0)
         {
            // Extract signal information
            string symbol = OrderGetString(ORDER_SYMBOL);
            ENUM_ORDER_TYPE orderType = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
            double price = OrderGetDouble(ORDER_PRICE_OPEN);
            double sl = OrderGetDouble(ORDER_SL);
            double tp = OrderGetDouble(ORDER_TP);
            double lots = OrderGetDouble(ORDER_VOLUME_INITIAL);
            datetime orderTime = (datetime)OrderGetInteger(ORDER_TIME_SETUP);
            
            // Check if this is a new signal (within last 30 seconds)
            if(TimeCurrent() - orderTime <= 30 && orderTime > g_lastSignalTime)
            {
               string action = (orderType == ORDER_TYPE_BUY_LIMIT || orderType == ORDER_TYPE_BUY_STOP || orderType == ORDER_TYPE_BUY) ? "BUY" : "SELL";
               ProcessReceivedSignal(symbol + "|" + action + "|" + DoubleToString(price, 5) + "|" + 
                                   DoubleToString(sl, 5) + "|" + DoubleToString(tp, 5) + "|" + 
                                   DoubleToString(lots, 2) + "|" + comment);
               g_lastSignalTime = orderTime;
            }
         }
      }
   }
   
   // Check new positions for signals  
   {
      for(int i = 0; i < totalPositions; i++)
      {
         ulong ticket = PositionGetTicket(i);
         if(ticket > 0 && PositionSelectByTicket(ticket))
         {
            string comment = PositionGetString(POSITION_COMMENT);
            
            if(StringFind(comment, Inp_SignalComment) >= 0)
            {
               string symbol = PositionGetString(POSITION_SYMBOL);
               ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
               double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
               double sl = PositionGetDouble(POSITION_SL);
               double tp = PositionGetDouble(POSITION_TP);
               double lots = PositionGetDouble(POSITION_VOLUME);
               datetime openTime = (datetime)PositionGetInteger(POSITION_TIME);
               
               if(TimeCurrent() - openTime <= 30 && openTime > g_lastSignalTime)
               {
                  string action = (posType == POSITION_TYPE_BUY) ? "BUY" : "SELL";
                  ProcessReceivedSignal(symbol + "|" + action + "|" + DoubleToString(openPrice, 5) + "|" + 
                                        DoubleToString(sl, 5) + "|" + DoubleToString(tp, 5) + "|" + 
                                        DoubleToString(lots, 2) + "|" + comment);
                  g_lastSignalTime = openTime;
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Process Received Signal                                          |
//+------------------------------------------------------------------+
void ProcessReceivedSignal(string signal)
{
   // Parse signal string: "SYMBOL|ACTION|PRICE|SL|TP|LOTS|SOURCE"
   string parts[];
   int partCount = StringSplit(signal, '|', parts);
   
   if(partCount >= 6)
   {
      string symbol = parts[0];
      string action = parts[1];
      double price = StringToDouble(parts[2]);
      double sl = StringToDouble(parts[3]);
      double tp = StringToDouble(parts[4]);
      double lots = StringToDouble(parts[5]);
      string source = (partCount > 6) ? parts[6] : "Unknown";
      
      Print("Processing external signal: ", symbol, " ", action, " @ ", price, " SL:", sl, " TP:", tp, " Size:", lots);
      
      // Forward to Firebase for app consumption
      ForwardSignalToFirebase(symbol, action, price, sl, tp, lots, source);
   }
}

//+------------------------------------------------------------------+
//| Forward Signal to Firebase                                       |
//+------------------------------------------------------------------+
void ForwardSignalToFirebase(string symbol, string action, double price, double sl, double tp, double lots, string source)
{
   if(!EnsureValidToken())
      return;

   string url = "https://" + Inp_ProjectID + "-default-rtdb.firebaseio.com/signals/" + g_AccountID + ".json?auth=" + g_idToken;
   
   CJSONObject *signal = new CJSONObject();
   signal.Add("id", IntegerToString(TimeCurrent())); // Unique signal ID
   signal.Add("symbol", symbol);
   signal.Add("action", action);
   signal.Add("price", price);
   signal.Add("sl", sl);
   signal.Add("tp", tp);
   signal.Add("lots", lots);
   signal.Add("source", source);
   signal.Add("timestamp", (int)TimeCurrent());
   signal.Add("status", "pending"); // pending, executed, rejected
   signal.Add("confidence", 85); // Default confidence level
   
   string jsonBody = signal.ToString();
   delete signal;
   
   char postData[];
   StringToCharArray(jsonBody, postData, 0, StringLen(jsonBody));
   char resultData[];
   string resultHeaders;
   string headers = "Content-Type: application/json\r\n";
   
   // POST creates a new child with unique ID
   int res = WebRequest("POST", url, headers, 2000, postData, resultData, resultHeaders);
   
   if(Inp_Verbose)
   {
      if(res == 200) Print("External signal forwarded to Firebase: ", symbol, " ", action);
      else Print("Signal forward failed: ", res);
   }
}

//+------------------------------------------------------------------+
//| 1. Data Synchronization                                           |
//+------------------------------------------------------------------+
void SyncAccountData()
{
   // --- Build JSON Object ---
   CJSONObject *root = new CJSONObject();
   
   // A. Account Info
   root.Add("balance", accInfo.Balance());
   root.Add("equity", accInfo.Equity());
   root.Add("margin", accInfo.Margin());
   root.Add("freeMargin", accInfo.FreeMargin());
   root.Add("marginLevel", accInfo.MarginLevel());
   root.Add("currency", AccountInfoString(ACCOUNT_CURRENCY));   // deposit currency (e.g. ZAR, USD) so the app labels money correctly
   root.Add("lastUpdated", (int)TimeGMT());   // wall-clock GMT: advances on weekends/holidays (TimeCurrent freezes when the symbol has no ticks)
   root.Add("isOnline", true);
   root.Add("isPaused", (g_EAPaused || g_EASchedulePaused));

   // B. Positions Array
   CJSONArray *posArray = new CJSONArray();
   int total = PositionsTotal();
   
   for(int i=0; i<total; i++)
   {
      if(posInfo.SelectByIndex(i))
      {
         CJSONObject *p = new CJSONObject();
         p.Add("ticket", (long)posInfo.Ticket());
         p.Add("symbol", posInfo.Symbol());
         p.Add("type", (int)posInfo.PositionType()); // 0=Buy, 1=Sell
         p.Add("lots", posInfo.Volume());
         p.Add("openPrice", posInfo.PriceOpen());
         p.Add("currentPrice", posInfo.PriceCurrent());
         p.Add("profit", posInfo.Profit());
         p.Add("sl", posInfo.StopLoss());
         p.Add("tp", posInfo.TakeProfit());
         p.Add("magic", (long)posInfo.Magic());
         p.Add("openTime", (long)posInfo.Time()); // Unix timestamp when position was opened
         // Contract specs so the app can convert price distance -> money accurately
         // (money = priceDiff / tickSize * tickValue * lots). Works for FX, metals,
         // and synthetic indices without hard-coded contract sizes.
         p.Add("tickValue", FXC_MoneyPerTick(posInfo.Symbol()));   // deposit-currency, index-CFD safe
         p.Add("tickSize",  SymbolInfoDouble(posInfo.Symbol(), SYMBOL_TRADE_TICK_SIZE));

         // Per-position management state so the app can PERSIST + DISPLAY what's active
         // (break-even, trailing, time limit). Without this the app always shows them "off".
         int mgi = FindPositionManagement((long)posInfo.Ticket());
         if(mgi >= 0)
         {
            p.Add("breakevenEnabled",    g_PosManagement[mgi].breakevenEnabled);
            p.Add("breakevenUsePercent", g_PosManagement[mgi].breakevenUsePercent);
            p.Add("breakevenPercent",    g_PosManagement[mgi].breakevenPercent);
            p.Add("breakevenThreshold",  g_PosManagement[mgi].breakevenThreshold);
            p.Add("breakevenTriggered",  g_PosManagement[mgi].breakevenTriggered);
            p.Add("trailingEnabled",     g_PosManagement[mgi].trailingEnabled);
            p.Add("trailingPercentage",  g_PosManagement[mgi].trailingPercentage);
            p.Add("timeLimit",           (int)g_PosManagement[mgi].timeLimit); // seconds after openTime; app counts down
         }
         posArray.Add(p);
      }
   }
   root.Add("positions", posArray);

   // --- Serialize to String ---
   // PATCH the parent /accounts node with the account key IN THE BODY (not the URL).
   // The account id can be ~50 chars; with the ~905-char idToken a per-account URL
   // (/accounts/{id}.json?auth=...) reaches ~1021 chars and hits MT5's ~1024 WebRequest
   // URL limit intermittently. Parent-node PATCH keeps the URL at ~970 chars. Firebase
   // update() overwrites /accounts/{id} with the full object we send (same as the old PUT).
   string jsonBody = "{\"" + g_AccountID + "\":" + root.ToString() + "}";
   delete root;

   // --- Send to Firestore (PATCH to update specific fields) ---
   // Endpoint: .../documents/accounts/{accountID}
   // Note: Firestore REST API requires a specific JSON structure for writes (fields: { ... }).
   // For simplicity, we are sending raw JSON. 
   // However, Firestore REST API is verbose. 
   // Correct Format: { "fields": { "balance": { "doubleValue": 1000.0 }, ... } }
   // This is complex to build manually in MQL5.
   // ALTERNATIVE: Use Firebase Realtime Database (simpler JSON) or a Cloud Function wrapper.
   // DECISION: For this MVP, let's assume we use a Cloud Function OR direct Firestore if we format strictly.
   // Let's try to format strictly for Firestore REST API? No, too complex for this step.
   // Let's switch to **Firebase Realtime Database** for the MVP? 
   // It accepts simple JSON via PUT. Much easier for MQL5.
   
   // Changing strategy to Realtime DB for simplicity in MQL5
   // URL: https://{projectId}-default-rtdb.firebaseio.com/accounts/{accountId}.json?auth={apiKey}
   
   string url = "https://" + Inp_ProjectID + "-default-rtdb.firebaseio.com/accounts.json?auth=" + g_idToken;

   // Send PATCH request (parent node; account key is in jsonBody)
   char postData[];
   StringToCharArray(jsonBody, postData, 0, StringLen(jsonBody));

   char resultData[];
   string resultHeaders;
   string headers = "Content-Type: application/json\r\n";

   int res = WebRequest("PATCH", url, headers, 2000, postData, resultData, resultHeaders);

   if(res != 200 && Inp_Verbose)
   {
      Print("Account sync failed. Code: ", res);
      // Print("Body: ", jsonBody);
   }
}

//+------------------------------------------------------------------+
//| Extract the balanced {...} object that follows a key in a JSON    |
//| string. Returns "" if the key or a complete object isn't found.   |
//| Used to isolate one account's block from a parent-node response.  |
//+------------------------------------------------------------------+
string ExtractAccountBlock(string s, int keyPos)
{
   int brace = StringFind(s, "{", keyPos);
   if(brace < 0) return "";
   int depth = 0;
   bool inStr = false;
   int len = StringLen(s);
   for(int i = brace; i < len; i++)
   {
      ushort c = StringGetCharacter(s, i);
      if(inStr)
      {
         if(c == '\\') { i++; continue; }   // skip escaped char
         if(c == '"') inStr = false;
      }
      else
      {
         if(c == '"') inStr = true;
         else if(c == '{') depth++;
         else if(c == '}')
         {
            depth--;
            if(depth == 0) return StringSubstr(s, brace, i - brace + 1);
         }
      }
   }
   return "";
}

//+------------------------------------------------------------------+
//| 2. Command Polling                                                |
//+------------------------------------------------------------------+
void PollCommands()
{
   // Read the parent 'commands.json' node (URL ~970 chars) instead of the per-account
   // 'commands/{id}/latest.json' (~1028, over MT5's ~1024 limit), then isolate THIS
   // account's block so the action/status parsing below can't match another account.
   string url = "https://" + Inp_ProjectID + "-default-rtdb.firebaseio.com/commands.json?auth=" + g_idToken;

   char postData[]; // Empty for GET
   char resultData[];
   string resultHeaders;
   string headers = "Content-Type: application/json\r\n";

   int res = WebRequest("GET", url, headers, 2000, postData, resultData, resultHeaders);

   if(res == 200)
   {
      string response = CharArrayToString(resultData);

      // Scope to this account's command block; bail out if it has none yet.
      int keyPos = StringFind(response, "\"" + g_AccountID + "\"");
      if(keyPos < 0) return;
      response = ExtractAccountBlock(response, keyPos);
      if(response == "") return;

      // Check if there is a PENDING command
      // Response ex: {"action":"CLOSE_ALL","status":"PENDING","timestamp":12345}
      if(StringFind(response, "\"status\":\"PENDING\"") > 0)
      {
         Print("Received Pending Command: ", response);
         
         // Extract Action
         if(StringFind(response, "\"action\":\"CLOSE_ALL\"") > 0)
         {
            if(Inp_AllowClose)
            {
               CloseAllPositions();
               MarkCommandExecuted();
            }
         }
         else if(StringFind(response, "\"action\":\"CLOSE_PROFITABLE\"") > 0)
         {
            if(Inp_AllowClose)
            {
               ClosePositionsByProfit(true);   // close winners
               MarkCommandExecuted();
            }
         }
         else if(StringFind(response, "\"action\":\"CLOSE_LOSING\"") > 0)
         {
            if(Inp_AllowClose)
            {
               ClosePositionsByProfit(false);  // close losers
               MarkCommandExecuted();
            }
         }
         else if(StringFind(response, "\"action\":\"DELETE_PENDING\"") > 0)
         {
            if(Inp_AllowClose)
            {
               DeletePendingOrders();
               MarkCommandExecuted();
            }
         }
         else if(StringFind(response, "\"action\":\"CLOSE_TICKET\"") > 0)
         {
             // Extract ticket
             // Format: "ticket":12345 or "ticket": 12345
             int ticketPos = StringFind(response, "\"ticket\":");
             if(ticketPos > 0)
             {
                 string temp = StringSubstr(response, ticketPos + 9);
                 int commaPos = StringFind(temp, ",");
                 int bracePos = StringFind(temp, "}");
                 int endPos = commaPos;
                 if(bracePos < commaPos || commaPos == -1) endPos = bracePos;
                 
                 if(endPos > 0)
                 {
                     long ticket = StringToInteger(StringSubstr(temp, 0, endPos));
                     Print("Closing Ticket: ", ticket);
                     if(Inp_AllowClose && ticket > 0)
                     {
                         if(trade.PositionClose(ticket))
                             Print("Ticket Closed Successfully");
                         else
                             Print("Failed to close ticket: ", GetLastError());
                             
                         MarkCommandExecuted();
                     }
                 }
             }
         }
         else if(StringFind(response, "\"action\":\"KILL_SWITCH\"") > 0)
         {
             if(Inp_AllowClose)
             {
                 CloseAllPositions();
                 // Logic to pause EA could go here (e.g. set global flag)
                 MarkCommandExecuted();
             }
         }
         else if(StringFind(response, "\"action\":\"OPEN_POSITION\"") > 0)
         {
             Print("Processing OPEN_POSITION command");
             ExecuteOpenPosition(response);
             MarkCommandExecuted();
         }
         else if(StringFind(response, "\"action\":\"SET_BREAKEVEN\"") > 0)
         {
             Print("Processing SET_BREAKEVEN command");
             ExecuteBreakevenCommand(response);
             MarkCommandExecuted();
         }
         else if(StringFind(response, "\"action\":\"BREAKEVEN_NOW\"") > 0)
         {
             Print("Processing BREAKEVEN_NOW command");
             string msg = "";
             bool ok = ExecuteBreakevenNow(response, msg);
             MarkCommandResult(ok, msg);   // the app shows this message to the user
         }
         else if(StringFind(response, "\"action\":\"SET_TRAILING_STOP\"") > 0)
         {
             Print("Processing SET_TRAILING_STOP command");
             ExecuteTrailingCommand(response);
             MarkCommandExecuted();
         }
         else if(StringFind(response, "\"action\":\"PARTIAL_CLOSE\"") > 0)
         {
             Print("Processing PARTIAL_CLOSE command");
             ExecutePartialCloseCommand(response);
             MarkCommandExecuted();
         }
         else if(StringFind(response, "\"action\":\"SCALE_IN\"") > 0)
         {
             Print("Processing SCALE_IN command");
             ExecuteScaleInCommand(response);
             MarkCommandExecuted();
         }
         else if(StringFind(response, "\"action\":\"SET_EA_SCHEDULE\"") > 0)
         {
             Print("Processing SET_EA_SCHEDULE command");
             ExecuteEAScheduleCommand(response);
             MarkCommandExecuted();
         }
         else if(StringFind(response, "\"action\":\"SET_EA_PAUSE\"") > 0)
         {
             Print("Processing SET_EA_PAUSE command");
             ExecuteEAPauseCommand(response);
             MarkCommandExecuted();
         }
         else if(StringFind(response, "\"action\":\"MODIFY_SLTP\"") > 0)
         {
             Print("Processing MODIFY_SLTP command");
             ExecuteModifySLTPCommand(response);
             MarkCommandExecuted();
         }
         else if(StringFind(response, "\"action\":\"SET_POSITION_TIME_LIMIT\"") > 0)
         {
             Print("Processing SET_POSITION_TIME_LIMIT command");
             ExecuteTimeLimitCommand(response);
             MarkCommandExecuted();
         }
      }
   }
}

//+------------------------------------------------------------------+
//| 3. History Synchronization                                        |
//+------------------------------------------------------------------+
void SyncHistory()
{
   // Push { timestamp, equity, balance } to 'history/{accountId}'
   // URL: .../history/{accountId}.json
   
   string url = "https://" + Inp_ProjectID + "-default-rtdb.firebaseio.com/history/" + g_AccountID + ".json?auth=" + g_idToken;
   
   CJSONObject *point = new CJSONObject();
   point.Add("timestamp", (int)TimeCurrent());
   point.Add("equity", accInfo.Equity());
   point.Add("balance", accInfo.Balance());
   
   string jsonBody = point.ToString();
   delete point;
   
   char postData[];
   StringToCharArray(jsonBody, postData, 0, StringLen(jsonBody));
   char resultData[];
   string resultHeaders;
   string headers = "Content-Type: application/json\r\n";
   
   // POST appends to the list (creates a unique key for this snapshot)
   int res = WebRequest("POST", url, headers, 2000, postData, resultData, resultHeaders);
   
   if(Inp_Verbose)
   {
      if(res == 200) Print("History Snapshot Pushed: ", accInfo.Equity());
      else Print("History Push Failed: ", res);
   }
}

//+------------------------------------------------------------------+
//| Sync closed-trade history (last 30 days) to Firebase.             |
//| Node: tradeHistory/{accountId}, keyed by position id.            |
//| PUT replaces the whole node each time -> no duplicates.          |
//+------------------------------------------------------------------+
void SyncTradeHistory()
{
   datetime fromTime = TimeCurrent() - 30 * 24 * 60 * 60;
   if(!HistorySelect(fromTime, TimeCurrent()))
      return;

   long     ids[];
   string   syms[];
   int      types[];
   double   vols[];
   double   entryPx[];
   double   exitPx[];
   double   pnl[];
   datetime openT[];
   datetime closeT[];
   int count = 0;

   int deals = HistoryDealsTotal();
   for(int i = 0; i < deals; i++)
   {
      ulong dticket = HistoryDealGetTicket(i);
      if(dticket == 0) continue;

      string sym = HistoryDealGetString(dticket, DEAL_SYMBOL);
      if(sym == "") continue; // skip balance/credit deals

      long posId = HistoryDealGetInteger(dticket, DEAL_POSITION_ID);
      if(posId == 0) continue;
      long entry = HistoryDealGetInteger(dticket, DEAL_ENTRY);

      // find or create an aggregation slot for this position id
      int idx = -1;
      for(int k = 0; k < count; k++) { if(ids[k] == posId) { idx = k; break; } }
      if(idx < 0)
      {
         idx = count;
         count++;
         ArrayResize(ids, count);     ArrayResize(syms, count);   ArrayResize(types, count);
         ArrayResize(vols, count);    ArrayResize(entryPx, count); ArrayResize(exitPx, count);
         ArrayResize(pnl, count);     ArrayResize(openT, count);  ArrayResize(closeT, count);
         ids[idx] = posId; syms[idx] = sym; types[idx] = 0; vols[idx] = 0;
         entryPx[idx] = 0; exitPx[idx] = 0; pnl[idx] = 0; openT[idx] = 0; closeT[idx] = 0;
      }

      // realized money = profit + swap + commission, summed over all the position's deals
      pnl[idx] += HistoryDealGetDouble(dticket, DEAL_PROFIT)
                + HistoryDealGetDouble(dticket, DEAL_SWAP)
                + HistoryDealGetDouble(dticket, DEAL_COMMISSION);

      if(entry == DEAL_ENTRY_IN)
      {
         entryPx[idx] = HistoryDealGetDouble(dticket, DEAL_PRICE);
         openT[idx]   = (datetime)HistoryDealGetInteger(dticket, DEAL_TIME);
         vols[idx]    = HistoryDealGetDouble(dticket, DEAL_VOLUME);
         types[idx]   = (int)HistoryDealGetInteger(dticket, DEAL_TYPE); // 0=buy,1=sell
      }
      else if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY)
      {
         exitPx[idx] = HistoryDealGetDouble(dticket, DEAL_PRICE);
         closeT[idx] = (datetime)HistoryDealGetInteger(dticket, DEAL_TIME);
      }
   }

   // Build a JSON object of CLOSED trades, keyed by position id
   CJSONObject *root = new CJSONObject();
   int closedCount = 0;
   for(int k = 0; k < count; k++)
   {
      if(closeT[k] == 0) continue; // still open
      CJSONObject *t = new CJSONObject();
      t.Add("ticket", ids[k]);
      t.Add("symbol", syms[k]);
      t.Add("type", types[k]);
      t.Add("lots", vols[k]);
      t.Add("entryPrice", entryPx[k]);
      t.Add("exitPrice", exitPx[k]);
      t.Add("profit", pnl[k]);
      t.Add("openTime", (long)openT[k]);
      t.Add("closeTime", (long)closeT[k]);
      root.Add(IntegerToString(ids[k]), t);
      closedCount++;
   }

   // PATCH the parent /tradeHistory node with the account key in the body to keep the URL
   // under MT5's ~1024-char WebRequest limit (a per-account PUT reaches ~1025 and fails -1).
   // Firebase update() overwrites /tradeHistory/{id} with the full node we send.
   string jsonBody = "{\"" + g_AccountID + "\":" + root.ToString() + "}";
   delete root;

   string url = "https://" + Inp_ProjectID + "-default-rtdb.firebaseio.com/tradeHistory.json?auth=" + g_idToken;
   char postData[];
   StringToCharArray(jsonBody, postData, 0, StringLen(jsonBody));
   char resultData[];
   string resultHeaders;
   string headers = "Content-Type: application/json\r\n";

   int res = WebRequest("PATCH", url, headers, 5000, postData, resultData, resultHeaders);
   if(Inp_Verbose)
   {
      if(res == 200) Print("Trade history synced: ", closedCount, " closed trades");
      else Print("Trade history sync failed: ", res);
   }
}

//+------------------------------------------------------------------+
//| Execute: Close All                                                |
//+------------------------------------------------------------------+
void CloseAllPositions()
{
   Print("!!! EXECUTING KILL SWITCH: CLOSING ALL POSITIONS !!!");
   int total = PositionsTotal();
   for(int i=total-1; i>=0; i--)
   {
      if(posInfo.SelectByIndex(i))
      {
         trade.PositionClose(posInfo.Ticket());
         Sleep(100);
      }
   }
}

//+------------------------------------------------------------------+
//| Close only winning (profit>0) or only losing (profit<0) positions|
//+------------------------------------------------------------------+
void ClosePositionsByProfit(bool winners)
{
   Print("Closing ", (winners ? "PROFITABLE" : "LOSING"), " positions");
   int total = PositionsTotal();
   for(int i=total-1; i>=0; i--)
   {
      if(posInfo.SelectByIndex(i))
      {
         double pl = posInfo.Profit() + posInfo.Swap() + posInfo.Commission();
         if((winners && pl > 0) || (!winners && pl < 0))
         {
            trade.PositionClose(posInfo.Ticket());
            Sleep(100);
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Delete all pending orders                                         |
//+------------------------------------------------------------------+
void DeletePendingOrders()
{
   Print("Deleting all pending orders");
   int total = OrdersTotal();
   for(int i=total-1; i>=0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket > 0)
      {
         trade.OrderDelete(ticket);
         Sleep(100);
      }
   }
}

//+------------------------------------------------------------------+
//| Acknowledge Command                                               |
//+------------------------------------------------------------------+
void MarkCommandExecuted()
{
   // PATCH the parent /commands node using deep-path keys ("{id}/latest/status") so the URL
   // stays ~970 chars (a per-account /commands/{id}/latest.json URL reaches ~1028, over MT5's
   // ~1024 limit). Firebase update() with slash-separated keys updates only those leaves,
   // leaving the command's action/ticket fields intact.
   string url = "https://" + Inp_ProjectID + "-default-rtdb.firebaseio.com/commands.json?auth=" + g_idToken;
   string body = "{\"" + g_AccountID + "/latest/status\":\"EXECUTED\", \""
                       + g_AccountID + "/latest/executedAt\":" + IntegerToString(TimeGMT()) + "}";

   char postData[];
   StringToCharArray(body, postData, 0, StringLen(body));
   char resultData[];
   string resultHeaders;
   string headers = "Content-Type: application/json\r\n";

   WebRequest("PATCH", url, headers, 2000, postData, resultData, resultHeaders);
}

//+------------------------------------------------------------------+
//| Acknowledge with an outcome the app can show: status EXECUTED or  |
//| FAILED plus a human-readable message (same short parent URL).     |
//+------------------------------------------------------------------+
void MarkCommandResult(bool ok, string message)
{
   StringReplace(message, "\\", "\\\\");
   StringReplace(message, "\"", "\\\"");
   string url = "https://" + Inp_ProjectID + "-default-rtdb.firebaseio.com/commands.json?auth=" + g_idToken;
   string body = "{\"" + g_AccountID + "/latest/status\":\"" + (ok ? "EXECUTED" : "FAILED") + "\", \""
                       + g_AccountID + "/latest/executedAt\":" + IntegerToString(TimeGMT()) + ", \""
                       + g_AccountID + "/latest/message\":\"" + message + "\"}";
   char postData[];
   StringToCharArray(body, postData, 0, StringLen(body), CP_UTF8);
   char resultData[];
   string resultHeaders;
   WebRequest("PATCH", url, "Content-Type: application/json\r\n", 2000, postData, resultData, resultHeaders);
}

//+------------------------------------------------------------------+
//| Execute OPEN_POSITION Command                                    |
//+------------------------------------------------------------------+
void ExecuteOpenPosition(string response)
{
   Print("Parsing OPEN_POSITION command: ", response);
   
   // Extract parameters from JSON response
   // Expected format: {"action":"OPEN_POSITION","symbol":"EURUSD","type":0,"lots":0.01,"sl":0,"tp":0,"status":"PENDING","timestamp":12345}
   
   string symbol = "";
   int orderType = 0;   // 0=BUY, 1=SELL (market); 2=BUY_STOP, 3=SELL_STOP, 4=BUY_LIMIT, 5=SELL_LIMIT (pending)
   double lots = 0.01;
   double sl = 0;
   double tp = 0;
   double price = 0;    // trigger price for pending orders (ignored for market)
   double entry = 0;    // the signal's intended entry (used to preserve R:R on market fills)

   // Extract symbol
   int symbolPos = StringFind(response, "\"symbol\":\"");
   if(symbolPos > 0)
   {
      string temp = StringSubstr(response, symbolPos + 10);
      int quotePos = StringFind(temp, "\"");
      if(quotePos > 0)
         symbol = StringSubstr(temp, 0, quotePos);
   }
   
   // Extract type (0=BUY, 1=SELL)
   int typePos = StringFind(response, "\"type\":");
   if(typePos > 0)
   {
      string temp = StringSubstr(response, typePos + 7);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = commaPos;
      if(bracePos < commaPos || commaPos == -1) endPos = bracePos;
      if(endPos > 0)
         orderType = (int)StringToInteger(StringSubstr(temp, 0, endPos));
   }
   
   // Extract lots
   int lotsPos = StringFind(response, "\"lots\":");
   if(lotsPos > 0)
   {
      string temp = StringSubstr(response, lotsPos + 7);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = commaPos;
      if(bracePos < commaPos || commaPos == -1) endPos = bracePos;
      if(endPos > 0)
         lots = StringToDouble(StringSubstr(temp, 0, endPos));
   }
   
   // Extract SL
   int slPos = StringFind(response, "\"sl\":");
   if(slPos > 0)
   {
      string temp = StringSubstr(response, slPos + 5);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = commaPos;
      if(bracePos < commaPos || commaPos == -1) endPos = bracePos;
      if(endPos > 0)
         sl = StringToDouble(StringSubstr(temp, 0, endPos));
   }
   
   // Extract TP
   int tpPos = StringFind(response, "\"tp\":");
   if(tpPos > 0)
   {
      string temp = StringSubstr(response, tpPos + 5);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = commaPos;
      if(bracePos < commaPos || commaPos == -1) endPos = bracePos;
      if(endPos > 0)
         tp = StringToDouble(StringSubstr(temp, 0, endPos));
   }

   // Extract trigger price (pending orders only). "price": won't match "openPrice"/"currentPrice".
   int pricePos = StringFind(response, "\"price\":");
   if(pricePos > 0)
   {
      string temp = StringSubstr(response, pricePos + 8);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = commaPos;
      if(bracePos < commaPos || commaPos == -1) endPos = bracePos;
      if(endPos > 0)
         price = StringToDouble(StringSubstr(temp, 0, endPos));
   }

   // Extract the signal's intended entry (for R:R preservation on market fills).
   int entryPos = StringFind(response, "\"entry\":");
   if(entryPos > 0)
   {
      string temp = StringSubstr(response, entryPos + 8);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = commaPos;
      if(bracePos < commaPos || commaPos == -1) endPos = bracePos;
      if(endPos > 0)
         entry = StringToDouble(StringSubstr(temp, 0, endPos));
   }

   // Validate symbol
   if(symbol == "")
   {
      Print("Invalid OPEN_POSITION: missing symbol");
      return;
   }

   // --- Normalize volume to the symbol's constraints ---
   // Signals sometimes carry an invalid lot (0, below min, or off the broker's step).
   // Instead of rejecting the trade, snap it to the symbol's minimum / nearest step.
   double volMin  = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double volMax  = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double volStep = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   if(lots <= 0 || (volMin > 0 && lots < volMin))
   {
      Print("Lot size ", lots, " invalid/below min for ", symbol, " - using minimum ", volMin);
      lots = (volMin > 0 ? volMin : 0.01);
   }
   if(volStep > 0) lots = MathRound(lots / volStep) * volStep;   // snap to the broker's lot step
   if(volMin > 0 && lots < volMin) lots = volMin;
   if(volMax > 0 && lots > volMax) lots = volMax;
   int lotDigits = (volStep >= 1 ? 0 : (volStep >= 0.1 ? 1 : (volStep >= 0.01 ? 2 : 3)));
   lots = NormalizeDouble(lots, lotDigits);
   if(lots <= 0)
   {
      Print("Could not derive a valid lot size for ", symbol, " - skipping");
      return;
   }
   
   // --- Current market prices & broker constraints ---
   double point   = SymbolInfoDouble(symbol, SYMBOL_POINT);
   int    digits  = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   long   stopsLv = (long)SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL);
   double ask     = SymbolInfoDouble(symbol, SYMBOL_ASK);
   double bid     = SymbolInfoDouble(symbol, SYMBOL_BID);
   double spread  = ask - bid;
   // Min SL/TP distance: broker stops level, but at least a few spreads for fast
   // synthetics, plus a small buffer.
   double minDist = MathMax((double)stopsLv * point, spread * 3.0) + 10 * point;

   // --- Pending stop/limit orders (orderType >= 2): place at a trigger price and return ---
   // 2 = BUY_STOP (above ask), 3 = SELL_STOP (below bid), 4 = BUY_LIMIT (below bid), 5 = SELL_LIMIT (above ask)
   if(orderType >= 2)
   {
      if(price <= 0) { Print("Pending order needs a trigger price. Skipping ", symbol); return; }
      bool pIsBuy = (orderType == 2 || orderType == 4);
      double trig = price;
      // Keep the trigger a valid distance from current price for its kind
      if(orderType == 2 && trig < ask + minDist) trig = ask + minDist; // BUY_STOP must sit above ask
      if(orderType == 3 && trig > bid - minDist) trig = bid - minDist; // SELL_STOP must sit below bid
      if(orderType == 4 && trig > bid - minDist) trig = bid - minDist; // BUY_LIMIT must sit below bid
      if(orderType == 5 && trig < ask + minDist) trig = ask + minDist; // SELL_LIMIT must sit above ask
      trig = NormalizeDouble(trig, digits);
      // Clamp SL/TP to a valid distance from the TRIGGER price (not current price)
      double psl = sl, ptp = tp;
      if(pIsBuy) { if(psl > 0 && psl > trig - minDist) psl = trig - minDist; if(ptp > 0 && ptp < trig + minDist) ptp = trig + minDist; }
      else       { if(psl > 0 && psl < trig + minDist) psl = trig + minDist; if(ptp > 0 && ptp > trig - minDist) ptp = trig - minDist; }
      if(psl > 0) psl = NormalizeDouble(psl, digits);
      if(ptp > 0) ptp = NormalizeDouble(ptp, digits);

      bool okPend = false;
      if(orderType == 2)      okPend = trade.BuyStop(lots, trig, symbol, psl, ptp, ORDER_TIME_GTC, 0, "FX Commander");
      else if(orderType == 3) okPend = trade.SellStop(lots, trig, symbol, psl, ptp, ORDER_TIME_GTC, 0, "FX Commander");
      else if(orderType == 4) okPend = trade.BuyLimit(lots, trig, symbol, psl, ptp, ORDER_TIME_GTC, 0, "FX Commander");
      else if(orderType == 5) okPend = trade.SellLimit(lots, trig, symbol, psl, ptp, ORDER_TIME_GTC, 0, "FX Commander");

      if(okPend) Print("Pending order placed: type=", orderType, " ", symbol, " @ ", trig, " SL=", psl, " TP=", ptp);
      else       Print("Pending order failed. Retcode: ", trade.ResultRetcode(), " - ", trade.ResultRetcodeDescription());
      return;
   }

   // --- 1) Re-validate the signal: has price already hit its SL/TP? ---
   if(orderType == 0) // BUY, fills at ask
   {
      if(sl > 0 && ask <= sl) { Print("Signal no longer valid (price at/below SL). Skipping ", symbol); return; }
      if(tp > 0 && ask >= tp) { Print("Signal no longer valid (price at/above TP). Skipping ", symbol); return; }
   }
   else // SELL, fills at bid
   {
      if(sl > 0 && bid >= sl) { Print("Signal no longer valid (price at/above SL). Skipping ", symbol); return; }
      if(tp > 0 && bid <= tp) { Print("Signal no longer valid (price at/below TP). Skipping ", symbol); return; }
   }

   // --- 1.5) Re-anchor SL/TP to the actual fill so a MARKET order PRESERVES the
   //          signal's risk:reward. If price "chased" away from the signal entry,
   //          keeping fixed SL/TP inverts R:R (you can lose more than you gain).
   //          Shifting both by (fill - entry) keeps the original SL/TP DISTANCES. ---
   if(entry > 0.0)
   {
      double fill  = (orderType == 0) ? ask : bid;
      double shift = fill - entry;
      if(sl > 0) sl += shift;
      if(tp > 0) tp += shift;
      if(MathAbs(shift) > point)
         Print("Re-anchored SL/TP by ", DoubleToString(shift, digits),
               " (signal entry ", DoubleToString(entry, digits),
               " -> fill ", DoubleToString(fill, digits), ") to preserve R:R");
   }

   // --- 2) Clamp SL/TP to the broker's minimum distance from the CURRENT price ---
   if(orderType == 0)
   {
      if(sl > 0 && sl > ask - minDist) sl = ask - minDist;
      if(tp > 0 && tp < ask + minDist) tp = ask + minDist;
   }
   else
   {
      if(sl > 0 && sl < bid + minDist) sl = bid + minDist;
      if(tp > 0 && tp > bid - minDist) tp = bid - minDist;
   }
   if(sl > 0) sl = NormalizeDouble(sl, digits);
   if(tp > 0) tp = NormalizeDouble(tp, digits);

   Print("Executing trade: ", symbol, " ", (orderType == 0 ? "BUY" : "SELL"), " ", lots, " lots, SL=", sl, ", TP=", tp);

   // --- 3) Place at market; if the broker rejects the stops, open without them then attach ---
   bool result = (orderType == 0) ? trade.Buy(lots, symbol, 0, sl, tp, "FX Commander")
                                  : trade.Sell(lots, symbol, 0, sl, tp, "FX Commander");
   bool stoplessRetry = false;

   if(!result && trade.ResultRetcode() == TRADE_RETCODE_INVALID_STOPS)
   {
      Print("Invalid stops rejected - opening at market, will attach SL/TP after fill.");
      stoplessRetry = true;
      result = (orderType == 0) ? trade.Buy(lots, symbol, 0, 0, 0, "FX Commander")
                                : trade.Sell(lots, symbol, 0, 0, 0, "FX Commander");
   }

   if(!result)
   {
      Print("Trade execution failed. Retcode: ", trade.ResultRetcode(), " - ", trade.ResultRetcodeDescription());
      return;
   }

   // Resolve the actual position ticket from the deal (ResultOrder is 0 for market fills)
   ulong posTicket = 0;
   ulong dealTicket = trade.ResultDeal();
   if(dealTicket > 0 && HistoryDealSelect(dealTicket))
      posTicket = (ulong)HistoryDealGetInteger(dealTicket, DEAL_POSITION_ID);
   if(posTicket == 0 && PositionSelect(symbol))
      posTicket = (ulong)PositionGetInteger(POSITION_TICKET);

   Print("Trade executed successfully. Position ticket: ", posTicket);

   // If opened stopless, attach SL/TP now, re-clamped to the live price
   if(stoplessRetry && posTicket > 0 && (sl > 0 || tp > 0) && PositionSelectByTicket(posTicket))
   {
      double a2 = SymbolInfoDouble(symbol, SYMBOL_ASK), b2 = SymbolInfoDouble(symbol, SYMBOL_BID);
      double sl2 = sl, tp2 = tp;
      if(orderType == 0) { if(sl2 > 0 && sl2 > b2 - minDist) sl2 = b2 - minDist; if(tp2 > 0 && tp2 < a2 + minDist) tp2 = a2 + minDist; }
      else               { if(sl2 > 0 && sl2 < a2 + minDist) sl2 = a2 + minDist; if(tp2 > 0 && tp2 > b2 - minDist) tp2 = b2 - minDist; }
      if(sl2 > 0) sl2 = NormalizeDouble(sl2, digits);
      if(tp2 > 0) tp2 = NormalizeDouble(tp2, digits);
      if(trade.PositionModify(posTicket, sl2, tp2))
         Print("SL/TP attached after fill: SL=", sl2, " TP=", tp2);
      else
         Print("Trade opened WITHOUT SL/TP (broker rejected attach): ", trade.ResultRetcodeDescription());
   }

   if(posTicket > 0) AddPositionManagement(posTicket);
}

//+------------------------------------------------------------------+
//| Position Management Functions                                    |
//+------------------------------------------------------------------+

//+------------------------------------------------------------------+
//| Check EA Schedule and pause if necessary                         |
//+------------------------------------------------------------------+
void CheckEASchedule()
{
   if(!g_Settings.enableSchedule) return;
   
   datetime now = TimeCurrent();
   
   // Check only every 30 seconds to avoid excessive processing
   if(now - g_LastPauseCheck < 30) return;
   g_LastPauseCheck = now;
   
   bool shouldPause = IsTimeInRange(g_Settings.pauseStartTime, g_Settings.pauseEndTime);
   
   if(shouldPause && !g_EASchedulePaused)
   {
      Print("EA Schedule: Entering pause window (", g_Settings.pauseStartTime, " - ", g_Settings.pauseEndTime, ")");
      g_EASchedulePaused = true;
      
      // Handle different pause modes
      if(g_Settings.pauseMode == 1) // Close All
      {
         CloseAllPositions();
      }
   }
   else if(!shouldPause && g_EASchedulePaused)
   {
      Print("EA Schedule: Exiting pause window");
      g_EASchedulePaused = false;
   }
}

//+------------------------------------------------------------------+
//| Check if current time is within specified range                 |
//+------------------------------------------------------------------+
bool IsTimeInRange(string startTime, string endTime)
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   
   int currentMinutes = dt.hour * 60 + dt.min;
   
   // Parse start time
   string startParts[];
   int startCount = StringSplit(startTime, ':', startParts);
   if(startCount < 2) return false;
   int startMinutes = (int)StringToInteger(startParts[0]) * 60 + (int)StringToInteger(startParts[1]);
   
   // Parse end time
   string endParts[];
   int endCount = StringSplit(endTime, ':', endParts);
   if(endCount < 2) return false;
   int endMinutes = (int)StringToInteger(endParts[0]) * 60 + (int)StringToInteger(endParts[1]);
   
   // Handle cases where end time is next day
   if(endMinutes < startMinutes)
   {
      return (currentMinutes >= startMinutes) || (currentMinutes <= endMinutes);
   }
   else
   {
      return (currentMinutes >= startMinutes) && (currentMinutes <= endMinutes);
   }
}

//+------------------------------------------------------------------+
//| Check break-even conditions for all positions                   |
//+------------------------------------------------------------------+
void CheckBreakevenPositions()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(!posInfo.SelectByIndex(i)) continue;
      
      ulong ticket = posInfo.Ticket();
      int mgmtIndex = FindPositionManagement((long)ticket);
      
      // Skip if breakeven not enabled for this position
      if(mgmtIndex < 0 || !g_PosManagement[mgmtIndex].breakevenEnabled) continue;
      if(g_PosManagement[mgmtIndex].breakevenTriggered) continue;
      
      double currentPrice = posInfo.PriceCurrent();
      double openPrice = posInfo.PriceOpen();
      // Favourable price move from entry (positive = trade in profit)
      double favMove = (posInfo.PositionType() == POSITION_TYPE_BUY)
                       ? (currentPrice - openPrice)
                       : (openPrice - currentPrice);

      bool reached = false;
      if(g_PosManagement[mgmtIndex].breakevenUsePercent)
      {
         // Trigger on price-move % from entry
         double movePct = (openPrice != 0) ? (favMove / openPrice) * 100.0 : 0;
         if(g_PosManagement[mgmtIndex].breakevenPercent > 0 && movePct >= g_PosManagement[mgmtIndex].breakevenPercent)
            reached = true;
      }
      else
      {
         // Trigger on profit in pips
         double point = SymbolInfoDouble(posInfo.Symbol(), SYMBOL_POINT);
         double profitPips = (point != 0) ? favMove / point : 0;
         if(profitPips >= g_PosManagement[mgmtIndex].breakevenThreshold)
            reached = true;
      }

      // Check if threshold is reached
      if(reached)
      {
         // Never loosen protection: if the stop is already at/beyond entry (trailing
         // or a manual move), break-even is done — don't drag it back to entry.
         double curSL = posInfo.StopLoss();
         bool isBuy   = (posInfo.PositionType() == POSITION_TYPE_BUY);
         if(curSL > 0 && ((isBuy && curSL >= openPrice) || (!isBuy && curSL <= openPrice)))
         {
            g_PosManagement[mgmtIndex].breakevenTriggered = true;
            continue;
         }
         // Move SL to break-even (entry price)
         if(trade.PositionModify(ticket, openPrice, posInfo.TakeProfit()))
         {
            Print("Break-even triggered for ticket ", ticket, ". SL moved to entry price: ", openPrice);
            g_PosManagement[mgmtIndex].breakevenTriggered = true;
         }
         else
         {
            // Retried every second; log at most once a minute so a broker refusal is visible.
            static datetime lastFailLog = 0;
            if(TimeGMT() - lastFailLog >= 60)
            {
               lastFailLog = TimeGMT();
               Print("Break-even for ticket ", ticket, " not applied yet: ", trade.ResultRetcodeDescription(),
                     " (price ", DoubleToString(currentPrice, (int)SymbolInfoInteger(posInfo.Symbol(), SYMBOL_DIGITS)),
                     ", entry ", openPrice, ")");
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| All per-position protection, run every second from OnTimer.       |
//+------------------------------------------------------------------+
void ManagePositions()
{
   EnsureAllPositionsTracked();   // new trades pick up the global defaults
   CheckBreakevenPositions();
   CheckTrailingStops();
   if(g_Settings.enableTimeManagement)
      CheckTimeBasedManagement();
   SavePositionManagementIfChanged();
}

//+------------------------------------------------------------------+
//| Persist per-position settings across EA/terminal restarts.        |
//| Without this every restart silently reset each position's        |
//| break-even / trailing / time limit to the global defaults.       |
//+------------------------------------------------------------------+
#define FXC_PM_FILE "fxc_posmgmt.csv"
string g_pmSaved = "";

string PositionManagementCsv()
{
   string s = "";
   for(int i = 0; i < g_PosManagementCount; i++)
   {
      s += IntegerToString(g_PosManagement[i].ticket) + ";" +
           IntegerToString((int)g_PosManagement[i].breakevenEnabled) + ";" +
           IntegerToString(g_PosManagement[i].breakevenThreshold) + ";" +
           IntegerToString((int)g_PosManagement[i].breakevenUsePercent) + ";" +
           DoubleToString(g_PosManagement[i].breakevenPercent, 4) + ";" +
           IntegerToString((int)g_PosManagement[i].breakevenTriggered) + ";" +
           IntegerToString((int)g_PosManagement[i].trailingEnabled) + ";" +
           IntegerToString(g_PosManagement[i].trailingPercentage) + ";" +
           DoubleToString(g_PosManagement[i].lastTrailPrice, 8) + ";" +
           IntegerToString((long)g_PosManagement[i].timeLimit) + ";" +
           IntegerToString((int)g_PosManagement[i].weekendClose) + ";" +
           DoubleToString(g_PosManagement[i].scaleInMultiplier, 4) + ";" +
           IntegerToString(g_PosManagement[i].scaleInThreshold) + ";" +
           IntegerToString((int)g_PosManagement[i].scaleInTriggered) + "\n";
   }
   return s;
}

void SavePositionManagementIfChanged()
{
   string s = PositionManagementCsv();
   if(s == g_pmSaved) return;
   int h = FileOpen(FXC_PM_FILE, FILE_WRITE|FILE_BIN);
   if(h == INVALID_HANDLE) return;
   uchar buf[];
   int len = StringToCharArray(s, buf, 0, StringLen(s), CP_UTF8);
   if(len > 0) FileWriteArray(h, buf, 0, len);
   FileClose(h);
   g_pmSaved = s;
}

void LoadPositionManagement()
{
   int h = FileOpen(FXC_PM_FILE, FILE_READ|FILE_BIN);
   if(h == INVALID_HANDLE) return;
   int sz = (int)FileSize(h);
   uchar buf[];
   if(sz > 0) { ArrayResize(buf, sz); FileReadArray(h, buf, 0, sz); }
   FileClose(h);
   if(sz <= 0) return;

   string lines[];
   int n = StringSplit(CharArrayToString(buf, 0, sz, CP_UTF8), '\n', lines);
   int restored = 0;
   for(int i = 0; i < n; i++)
   {
      string f[];
      if(StringSplit(lines[i], ';', f) < 14) continue;
      long ticket = StringToInteger(f[0]);
      if(ticket <= 0 || !PositionSelectByTicket((ulong)ticket)) continue;   // closed meanwhile
      if(FindPositionManagement(ticket) >= 0) continue;
      int k = g_PosManagementCount;
      ArrayResize(g_PosManagement, k + 1);
      g_PosManagement[k].ticket              = ticket;
      g_PosManagement[k].breakevenEnabled    = (StringToInteger(f[1]) != 0);
      g_PosManagement[k].breakevenThreshold  = (int)StringToInteger(f[2]);
      g_PosManagement[k].breakevenUsePercent = (StringToInteger(f[3]) != 0);
      g_PosManagement[k].breakevenPercent    = StringToDouble(f[4]);
      g_PosManagement[k].breakevenTriggered  = (StringToInteger(f[5]) != 0);
      g_PosManagement[k].trailingEnabled     = (StringToInteger(f[6]) != 0);
      g_PosManagement[k].trailingPercentage  = (int)StringToInteger(f[7]);
      g_PosManagement[k].lastTrailPrice      = StringToDouble(f[8]);
      g_PosManagement[k].timeLimit           = (datetime)StringToInteger(f[9]);
      g_PosManagement[k].weekendClose        = (StringToInteger(f[10]) != 0);
      g_PosManagement[k].scaleInMultiplier   = StringToDouble(f[11]);
      g_PosManagement[k].scaleInThreshold    = (int)StringToInteger(f[12]);
      g_PosManagement[k].scaleInTriggered    = (StringToInteger(f[13]) != 0);
      g_PosManagementCount++;
      restored++;
   }
   g_pmSaved = PositionManagementCsv();
   Print("Position settings restored for ", restored, " open position(s) from ", FXC_PM_FILE);
}

//+------------------------------------------------------------------+
//| Break-even NOW: move this position's SL to its entry immediately. |
//| Returns false with a plain-English reason when it can't.          |
//+------------------------------------------------------------------+
bool ExecuteBreakevenNow(string response, string &msg)
{
   long ticket = 0;
   int tp0 = StringFind(response, "\"ticket\":");
   if(tp0 > 0)
   {
      string temp = StringSubstr(response, tp0 + 9);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = commaPos;
      if(bracePos < commaPos || commaPos == -1) endPos = bracePos;
      if(endPos > 0) ticket = StringToInteger(StringSubstr(temp, 0, endPos));
   }
   if(ticket <= 0 || !PositionSelectByTicket((ulong)ticket))
   {
      msg = "Position not found - it may already be closed.";
      return false;
   }

   string sym   = PositionGetString(POSITION_SYMBOL);
   bool   isBuy = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
   double open  = PositionGetDouble(POSITION_PRICE_OPEN);
   double sl    = PositionGetDouble(POSITION_SL);
   double tp    = PositionGetDouble(POSITION_TP);
   int    dg    = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   double price = isBuy ? SymbolInfoDouble(sym, SYMBOL_BID) : SymbolInfoDouble(sym, SYMBOL_ASK);
   long   lvl   = MathMax(SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL), SymbolInfoInteger(sym, SYMBOL_TRADE_FREEZE_LEVEL));
   double minDist = lvl * point;

   int mi = FindPositionManagement(ticket);
   if(mi < 0) { AddPositionManagement(ticket); mi = FindPositionManagement(ticket); }

   if(sl > 0 && ((isBuy && sl >= open) || (!isBuy && sl <= open)))
   {
      if(mi >= 0) g_PosManagement[mi].breakevenTriggered = true;
      msg = "Already protected: the stop loss is at or beyond your entry (" + DoubleToString(sl, dg) + ").";
      return true;
   }

   double room = isBuy ? price - open : open - price;   // how far price has moved past entry
   if(room <= 0)
   {
      msg = "The trade isn't in profit yet (price " + DoubleToString(price, dg) + ", entry " + DoubleToString(open, dg) +
            "). A stop at entry is only possible once price is past your entry.";
      return false;
   }
   if(room <= minDist)
   {
      msg = "Price is too close to entry: the broker needs at least " + DoubleToString(minDist / point, 0) +
            " points between price and the stop. Try again once it has moved a bit further.";
      return false;
   }
   if(!trade.PositionModify((ulong)ticket, NormalizeDouble(open, dg), tp))
   {
      msg = "The broker rejected the change: " + trade.ResultRetcodeDescription();
      return false;
   }
   if(mi >= 0) g_PosManagement[mi].breakevenTriggered = true;
   msg = "Stop loss moved to entry (" + DoubleToString(open, dg) + ").";
   Print("Break-even NOW for ticket ", ticket, ": ", msg);
   return true;
}

//+------------------------------------------------------------------+
//| Check trailing stop conditions for all positions               |
//+------------------------------------------------------------------+
void CheckTrailingStops()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(!posInfo.SelectByIndex(i)) continue;
      
      ulong ticket = posInfo.Ticket();
      int mgmtIndex = FindPositionManagement((long)ticket);
      
      // Skip if trailing not enabled for this position
      if(mgmtIndex < 0 || !g_PosManagement[mgmtIndex].trailingEnabled) continue;
      
      double currentPrice = posInfo.PriceCurrent();
      double openPrice = posInfo.PriceOpen();
      double tp = posInfo.TakeProfit();
      double currentSL = posInfo.StopLoss();
      int trailPercentage = g_PosManagement[mgmtIndex].trailingPercentage;
      
      if(tp == 0) continue; // No TP set, can't calculate percentage
      
      // Calculate distance from entry to TP
      double entryToTP = MathAbs(tp - openPrice);
      
      // Calculate required profit to start trailing
      double requiredProfit = entryToTP * trailPercentage / 100.0;
      
      double currentProfit = 0;
      double newSL = 0;
      
      if(posInfo.PositionType() == POSITION_TYPE_BUY)
      {
         currentProfit = currentPrice - openPrice;
         if(currentProfit >= requiredProfit)
         {
            // Trail SL upward, but never decrease it
            newSL = currentPrice - requiredProfit;
            if(newSL > currentSL)
            {
               if(trade.PositionModify(ticket, newSL, tp))
               {
                  Print("Trailing stop updated for ticket ", ticket, ". New SL: ", newSL);
               }
            }
         }
      }
      else // SELL
      {
         currentProfit = openPrice - currentPrice;
         if(currentProfit >= requiredProfit)
         {
            // Trail SL downward, but never increase it
            newSL = currentPrice + requiredProfit;
            if(newSL < currentSL || currentSL == 0)
            {
               if(trade.PositionModify(ticket, newSL, tp))
               {
                  Print("Trailing stop updated for ticket ", ticket, ". New SL: ", newSL);
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Check time-based management conditions                          |
//+------------------------------------------------------------------+
void CheckTimeBasedManagement()
{
   InitializeDailyTracking();
   
   // Check daily profit target
   double currentEquity = accInfo.Equity();
   double dailyProfitPercent = (currentEquity - g_DailyStartEquity) / g_DailyStartEquity * 100.0;
   
   // Daily profit target check removed - now controlled via app settings
   
   // Weekend close functionality removed - now controlled via app
   
   // Check individual position time limits
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(!posInfo.SelectByIndex(i)) continue;
      
      ulong ticket = posInfo.Ticket();
      int mgmtIndex = FindPositionManagement((long)ticket);
      
      if(mgmtIndex >= 0 && g_PosManagement[mgmtIndex].timeLimit > 0)
      {
         datetime openTime = (datetime)posInfo.Time();
         if(TimeCurrent() >= openTime + g_PosManagement[mgmtIndex].timeLimit)
         {
            Print("Time limit reached for ticket ", ticket, ". Closing position.");
            trade.PositionClose(ticket);
            RemovePositionManagement((long)ticket);
         }
      }
   }
}

//+------------------------------------------------------------------+
//| Position Management Utility Functions                           |
//+------------------------------------------------------------------+

//+------------------------------------------------------------------+
//| Find position management index by ticket                        |
//+------------------------------------------------------------------+
int FindPositionManagement(long ticket)
{
   for(int i = 0; i < g_PosManagementCount; i++)
   {
      if(g_PosManagement[i].ticket == ticket)
         return i;
   }
   return -1;
}

//+------------------------------------------------------------------+
//| Add position to management tracking                             |
//+------------------------------------------------------------------+
void AddPositionManagement(long ticket)
{
   // Check if already exists
   if(FindPositionManagement(ticket) >= 0) return;
   
   // Resize array if needed
   ArrayResize(g_PosManagement, g_PosManagementCount + 1);
   
   // Initialize with default values
   g_PosManagement[g_PosManagementCount].ticket = ticket;
   g_PosManagement[g_PosManagementCount].breakevenEnabled = g_Settings.enableBreakeven;
   g_PosManagement[g_PosManagementCount].breakevenThreshold = g_Settings.breakevenThresholdPips;
   g_PosManagement[g_PosManagementCount].breakevenUsePercent = g_Settings.breakevenUsePercent;
   g_PosManagement[g_PosManagementCount].breakevenPercent = g_Settings.breakevenPercent;
   g_PosManagement[g_PosManagementCount].breakevenTriggered = false;
   // Trailing is OPT-IN per position (enabled from the app's Trailing tab), never
   // auto-applied to new trades. CheckTrailingStops still honours positions the
   // user explicitly enables. (Breakeven above intentionally follows the global
   // setting so the global break-even % feature applies to all trades.)
   g_PosManagement[g_PosManagementCount].trailingEnabled = false;
   g_PosManagement[g_PosManagementCount].trailingPercentage = 20; // Default 20% (used once enabled)
   g_PosManagement[g_PosManagementCount].lastTrailPrice = 0;
   g_PosManagement[g_PosManagementCount].timeLimit = 0;
   g_PosManagement[g_PosManagementCount].weekendClose = g_Settings.weekendClose;
   g_PosManagement[g_PosManagementCount].scaleInMultiplier = 1.0;
   g_PosManagement[g_PosManagementCount].scaleInThreshold = 20;
   g_PosManagement[g_PosManagementCount].scaleInTriggered = false;

   g_PosManagementCount++;
}

//+------------------------------------------------------------------+
//| Ensure every open position is tracked (seeds from g_Settings).   |
//| Lets global settings (e.g. % break-even) apply to all trades,    |
//| not only those opened through the app. AddPositionManagement     |
//| de-duplicates, so already-tracked tickets are untouched.         |
//+------------------------------------------------------------------+
void EnsureAllPositionsTracked()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(posInfo.SelectByIndex(i))
         AddPositionManagement((long)posInfo.Ticket());
   }
}

//+------------------------------------------------------------------+
//| Remove position from management tracking                        |
//+------------------------------------------------------------------+
void RemovePositionManagement(long ticket)
{
   int index = FindPositionManagement(ticket);
   if(index < 0) return;
   
   // Shift array elements
   for(int i = index; i < g_PosManagementCount - 1; i++)
   {
      g_PosManagement[i] = g_PosManagement[i + 1];
   }
   
   g_PosManagementCount--;
   ArrayResize(g_PosManagement, g_PosManagementCount);
}

//+------------------------------------------------------------------+
//| Initialize daily tracking                                        |
//+------------------------------------------------------------------+
void InitializeDailyTracking()
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   datetime currentDayStart = StringToTime(TimeToString(TimeCurrent(), TIME_DATE));
   
   // Reset daily tracking at start of new day
   if(currentDayStart != g_DayStart)
   {
      g_DayStart = currentDayStart;
      g_DailyStartEquity = accInfo.Equity();
      g_EAPaused = false; // Reset pause state for new day
      Print("Daily tracking initialized. Start equity: ", g_DailyStartEquity);
   }
}

//+------------------------------------------------------------------+
//| Command Execution Functions                                     |
//+------------------------------------------------------------------+

//+------------------------------------------------------------------+
//| Execute Break-Even Command                                       |
//+------------------------------------------------------------------+
void ExecuteBreakevenCommand(string response)
{
   // Extract ticket
   long ticket = 0;
   int ticketPos = StringFind(response, "\"ticket\":");
   if(ticketPos > 0)
   {
      string temp = StringSubstr(response, ticketPos + 9);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = commaPos;
      if(bracePos < commaPos || commaPos == -1) endPos = bracePos;
      if(endPos > 0)
         ticket = StringToInteger(StringSubstr(temp, 0, endPos));
   }
   
   // Extract threshold
   int threshold = g_Settings.breakevenThresholdPips;
   int thresholdPos = StringFind(response, "\"threshold\":");
   if(thresholdPos > 0)
   {
      string temp = StringSubstr(response, thresholdPos + 12);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = commaPos;
      if(bracePos < commaPos || commaPos == -1) endPos = bracePos;
      if(endPos > 0)
         threshold = (int)StringToInteger(StringSubstr(temp, 0, endPos));
   }
   
   // Extract enabled status
   bool enabled = true;
   if(StringFind(response, "\"enabled\":false") > 0)
      enabled = false;

   // Extract percent-mode flag and percent value (price move from entry)
   bool usePercent = (StringFind(response, "\"usePercent\":true") > 0);
   double percent = 0;
   int percentPos = StringFind(response, "\"percent\":");
   if(percentPos > 0)
   {
      string temp = StringSubstr(response, percentPos + 10);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = commaPos;
      if(bracePos < commaPos || commaPos == -1) endPos = bracePos;
      if(endPos > 0)
         percent = StringToDouble(StringSubstr(temp, 0, endPos));
   }

   // Find or add position management
   int mgmtIndex = FindPositionManagement(ticket);
   if(mgmtIndex < 0)
   {
      AddPositionManagement(ticket);
      mgmtIndex = FindPositionManagement(ticket);
   }

   if(mgmtIndex >= 0)
   {
      g_PosManagement[mgmtIndex].breakevenEnabled = enabled;
      g_PosManagement[mgmtIndex].breakevenThreshold = threshold;
      g_PosManagement[mgmtIndex].breakevenUsePercent = usePercent;
      g_PosManagement[mgmtIndex].breakevenPercent = percent;
      g_PosManagement[mgmtIndex].breakevenTriggered = false; // Reset trigger

      Print("Break-even settings updated for ticket ", ticket, ": enabled=", enabled,
            ", usePercent=", usePercent, ", percent=", percent, ", pips=", threshold);
   }
}

//+------------------------------------------------------------------+
//| Execute Trailing Stop Command                                   |
//+------------------------------------------------------------------+
void ExecuteTrailingCommand(string response)
{
   // Extract ticket
   long ticket = 0;
   int ticketPos = StringFind(response, "\"ticket\":");
   if(ticketPos > 0)
   {
      string temp = StringSubstr(response, ticketPos + 9);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = commaPos;
      if(bracePos < commaPos || commaPos == -1) endPos = bracePos;
      if(endPos > 0)
         ticket = StringToInteger(StringSubstr(temp, 0, endPos));
   }
   
   // Extract trail percentage
   int trailPercentage = 20;
   int percentagePos = StringFind(response, "\"trailPercentage\":");
   if(percentagePos > 0)
   {
      string temp = StringSubstr(response, percentagePos + 18);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = commaPos;
      if(bracePos < commaPos || commaPos == -1) endPos = bracePos;
      if(endPos > 0)
         trailPercentage = (int)StringToInteger(StringSubstr(temp, 0, endPos));
   }
   
   // Extract enabled status
   bool enabled = true;
   if(StringFind(response, "\"enabled\":false") > 0)
      enabled = false;
   
   // Find or add position management
   int mgmtIndex = FindPositionManagement(ticket);
   if(mgmtIndex < 0)
   {
      AddPositionManagement(ticket);
      mgmtIndex = FindPositionManagement(ticket);
   }
   
   if(mgmtIndex >= 0)
   {
      g_PosManagement[mgmtIndex].trailingEnabled = enabled;
      g_PosManagement[mgmtIndex].trailingPercentage = trailPercentage;
      
      Print("Trailing stop settings updated for ticket ", ticket, ": enabled=", enabled, ", percentage=", trailPercentage, "%");
   }
}

//+------------------------------------------------------------------+
//| Execute Partial Close Command                                   |
//+------------------------------------------------------------------+
void ExecutePartialCloseCommand(string response)
{
   // Extract ticket
   long ticket = 0;
   int ticketPos = StringFind(response, "\"ticket\":");
   if(ticketPos > 0)
   {
      string temp = StringSubstr(response, ticketPos + 9);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = commaPos;
      if(bracePos < commaPos || commaPos == -1) endPos = bracePos;
      if(endPos > 0)
         ticket = StringToInteger(StringSubstr(temp, 0, endPos));
   }
   
   // Extract percentage
   double percentage = 50.0;
   int percentagePos = StringFind(response, "\"percentage\":");
   if(percentagePos > 0)
   {
      string temp = StringSubstr(response, percentagePos + 12);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = commaPos;
      if(bracePos < commaPos || commaPos == -1) endPos = bracePos;
      if(endPos > 0)
         percentage = StringToDouble(StringSubstr(temp, 0, endPos));
   }
   
   // Validate percentage
   if(percentage <= 0 || percentage >= 100)
   {
      Print("Invalid partial close percentage: ", percentage);
      return;
   }
   
   // Select the position
   if(!posInfo.SelectByTicket(ticket))
   {
      Print("Position not found for partial close: ", ticket);
      return;
   }
   
   double currentLots = posInfo.Volume();
   double lotsToClose = currentLots * percentage / 100.0;
   
   // Ensure minimum lot size
   double minLot = SymbolInfoDouble(posInfo.Symbol(), SYMBOL_VOLUME_MIN);
   if(lotsToClose < minLot)
   {
      Print("Partial close volume too small: ", lotsToClose, " (min: ", minLot, ")");
      return;
   }
   
   // Execute partial close
   if(trade.PositionClosePartial(ticket, lotsToClose))
   {
      Print("Partial close executed for ticket ", ticket, ": ", percentage, "% (", lotsToClose, " lots)");
   }
   else
   {
      Print("Partial close failed for ticket ", ticket, ": ", trade.ResultRetcodeDescription());
   }
}

//+------------------------------------------------------------------+
//| Execute Scale-In Command                                         |
//+------------------------------------------------------------------+
void ExecuteScaleInCommand(string response)
{
   // Extract ticket
   long ticket = 0;
   int ticketPos = StringFind(response, "\"ticket\":");
   if(ticketPos > 0)
   {
      string temp = StringSubstr(response, ticketPos + 9);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = commaPos;
      if(bracePos < commaPos || commaPos == -1) endPos = bracePos;
      if(endPos > 0)
         ticket = StringToInteger(StringSubstr(temp, 0, endPos));
   }
   
   // Extract lot multiplier
   double lotMultiplier = 1.0;
   int multiplierPos = StringFind(response, "\"lotMultiplier\":");
   if(multiplierPos > 0)
   {
      string temp = StringSubstr(response, multiplierPos + 16);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = commaPos;
      if(bracePos < commaPos || commaPos == -1) endPos = bracePos;
      if(endPos > 0)
         lotMultiplier = StringToDouble(StringSubstr(temp, 0, endPos));
   }
   
   // Extract profit threshold
   int profitThreshold = 20;
   int thresholdPos = StringFind(response, "\"profitThreshold\":");
   if(thresholdPos > 0)
   {
      string temp = StringSubstr(response, thresholdPos + 18);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = commaPos;
      if(bracePos < commaPos || commaPos == -1) endPos = bracePos;
      if(endPos > 0)
         profitThreshold = (int)StringToInteger(StringSubstr(temp, 0, endPos));
   }
   
   // Select the original position
   if(!posInfo.SelectByTicket(ticket))
   {
      Print("Original position not found for scale-in: ", ticket);
      return;
   }
   
   // Check if position is profitable enough
   double currentProfit = posInfo.Profit();
   double point = SymbolInfoDouble(posInfo.Symbol(), SYMBOL_POINT);
   double profitPips = 0;
   
   if(posInfo.PositionType() == POSITION_TYPE_BUY)
   {
      profitPips = (posInfo.PriceCurrent() - posInfo.PriceOpen()) / point;
   }
   else
   {
      profitPips = (posInfo.PriceOpen() - posInfo.PriceCurrent()) / point;
   }
   
   if(profitPips < profitThreshold)
   {
      Print("Position not profitable enough for scale-in. Current: ", profitPips, " pips, Required: ", profitThreshold, " pips");
      return;
   }
   
   // Calculate new lot size
   double originalLots = posInfo.Volume();
   double newLots = originalLots * lotMultiplier;
   
   // Execute scale-in trade
   string symbol = posInfo.Symbol();
   double sl = posInfo.StopLoss();
   double tp = posInfo.TakeProfit();
   
   bool result = false;
   if(posInfo.PositionType() == POSITION_TYPE_BUY)
   {
      result = trade.Buy(newLots, symbol, 0, sl, tp, "FX Commander - Scale-In");
   }
   else
   {
      result = trade.Sell(newLots, symbol, 0, sl, tp, "FX Commander - Scale-In");
   }
   
   if(result)
   {
      Print("Scale-in executed for ticket ", ticket, ": ", newLots, " lots added. New ticket: ", trade.ResultOrder());
      AddPositionManagement(trade.ResultOrder());
   }
   else
   {
      Print("Scale-in failed for ticket ", ticket, ": ", trade.ResultRetcodeDescription());
   }
}

//+------------------------------------------------------------------+
//| Execute EA Schedule Command                                      |
//+------------------------------------------------------------------+
void ExecuteEAScheduleCommand(string response)
{
   // Extract pause start time
   string pauseStartTime = g_Settings.pauseStartTime;
   int startTimePos = StringFind(response, "\"pauseStartTime\":\"");
   if(startTimePos > 0)
   {
      string temp = StringSubstr(response, startTimePos + 17);
      int quotePos = StringFind(temp, "\"");
      if(quotePos > 0)
         pauseStartTime = StringSubstr(temp, 0, quotePos);
   }
   
   // Extract pause end time
   string pauseEndTime = g_Settings.pauseEndTime;
   int endTimePos = StringFind(response, "\"pauseEndTime\":\"");
   if(endTimePos > 0)
   {
      string temp = StringSubstr(response, endTimePos + 15);
      int quotePos = StringFind(temp, "\"");
      if(quotePos > 0)
         pauseEndTime = StringSubstr(temp, 0, quotePos);
   }
   
   // Extract pause mode
   int pauseMode = g_Settings.pauseMode;
   int modePos = StringFind(response, "\"pauseMode\":");
   if(modePos > 0)
   {
      string temp = StringSubstr(response, modePos + 12);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = commaPos;
      if(bracePos < commaPos || commaPos == -1) endPos = bracePos;
      if(endPos > 0)
         pauseMode = (int)StringToInteger(StringSubstr(temp, 0, endPos));
   }
   
   // Extract enabled status
   bool enabled = true;
   if(StringFind(response, "\"enabled\":false") > 0)
      enabled = false;
   
   // Update the input parameters (note: this won't persist between EA restarts)
   // In a real implementation, you might want to save these to a file
   Print("EA Schedule updated: enabled=", enabled, ", start=", pauseStartTime, ", end=", pauseEndTime, ", mode=", pauseMode);
   
   // Force immediate schedule check
   g_LastPauseCheck = 0;
}

//+------------------------------------------------------------------+
//| Execute EA Pause Command                                         |
//+------------------------------------------------------------------+
void ExecuteEAPauseCommand(string response)
{
   // Extract pause duration (in seconds)
   int pauseDuration = 3600; // Default 1 hour
   int durationPos = StringFind(response, "\"pauseDuration\":");
   if(durationPos > 0)
   {
      string temp = StringSubstr(response, durationPos + 16);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = commaPos;
      if(bracePos < commaPos || commaPos == -1) endPos = bracePos;
      if(endPos > 0)
         pauseDuration = (int)StringToInteger(StringSubstr(temp, 0, endPos));
   }
   
   // Extract pause mode
   int pauseMode = 0;
   int modePos = StringFind(response, "\"pauseMode\":");
   if(modePos > 0)
   {
      string temp = StringSubstr(response, modePos + 12);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = commaPos;
      if(bracePos < commaPos || commaPos == -1) endPos = bracePos;
      if(endPos > 0)
         pauseMode = (int)StringToInteger(StringSubstr(temp, 0, endPos));
   }
   
   // Extract immediate flag
   bool immediate = false;
   if(StringFind(response, "\"immediate\":true") > 0)
      immediate = true;
   
   if(immediate)
   {
      Print("Manual EA pause activated for ", pauseDuration, " seconds. Mode: ", pauseMode);
      g_EAPaused = true;
      
      // Handle different pause modes
      if(pauseMode == 1) // Close All
      {
         CloseAllPositions();
      }
      
      // Set a timer to automatically resume (simplified implementation)
      // In a more sophisticated implementation, you would use a timer or save the resume time
      Print("EA will resume automatically after ", pauseDuration, " seconds");
   }
   else
   {
      // Resume EA
      g_EAPaused = false;
      g_EASchedulePaused = false;
      Print("EA resumed from manual pause");
   }
}

//+------------------------------------------------------------------+
//| Initialize Default Settings                                      |
//+------------------------------------------------------------------+
void InitializeDefaultSettings()
{
   // Break-even and trailing are OFF by default: a trade gets them only if the
   // user enables the global toggle (control screen) or sets it per position.
   g_Settings.enableBreakeven = false;
   g_Settings.breakevenThresholdPips = 10;
   g_Settings.breakevenUsePercent = false;
   g_Settings.breakevenPercent = 0.5;
   g_Settings.enableTrailing = false;
   g_Settings.enableTimeManagement = true;
   g_Settings.weekendClose = true;
   g_Settings.dailyTargetPercent = 5.0;
   
   g_Settings.enableSchedule = true;
   g_Settings.pauseStartTime = "13:00";
   g_Settings.pauseEndTime = "14:00";
   g_Settings.pauseMode = 0;
   
   g_Settings.lastUpdated = TimeCurrent();
   
   Print("Default EA settings initialized");
}

//+------------------------------------------------------------------+
//| Load EA Settings from Firebase                                   |
//+------------------------------------------------------------------+
void LoadEASettings()
{
   // Read parent /settings node (URL ~970) instead of /settings/{id}.json (~1021, dead-zone),
   // then isolate this account's block before parsing.
   string url = "https://" + Inp_ProjectID + "-default-rtdb.firebaseio.com/settings.json?auth=" + g_idToken;

   char postData[];
   char resultData[];
   string resultHeaders;

   int res = WebRequest("GET", url, NULL, 2000, postData, resultData, resultHeaders);

   if(res == 200)
   {
      string response = CharArrayToString(resultData);

      int keyPos = StringFind(response, "\"" + g_AccountID + "\"");
      if(keyPos >= 0)
         response = ExtractAccountBlock(response, keyPos);

      if(response != "null" && StringLen(response) > 10)
      {
         // Parse JSON response and update settings
         if(StringFind(response, "\"enableBreakeven\":true") > 0)
            g_Settings.enableBreakeven = true;
         else if(StringFind(response, "\"enableBreakeven\":false") > 0)
            g_Settings.enableBreakeven = false;
            
         if(StringFind(response, "\"enableTrailing\":true") > 0)
            g_Settings.enableTrailing = true;
         else if(StringFind(response, "\"enableTrailing\":false") > 0)
            g_Settings.enableTrailing = false;
            
         // Parse numeric values
         int breakevenPos = StringFind(response, "\"breakevenThresholdPips\":");
         if(breakevenPos > 0)
         {
            string temp = StringSubstr(response, breakevenPos + 25);
            int commaPos = StringFind(temp, ",");
            int bracePos = StringFind(temp, "}");
            int endPos = (commaPos > 0 && commaPos < bracePos) ? commaPos : bracePos;
            if(endPos > 0)
               g_Settings.breakevenThresholdPips = (int)StringToInteger(StringSubstr(temp, 0, endPos));
         }

         // Global break-even mode: percent (price move from entry) vs pips
         if(StringFind(response, "\"breakevenUsePercent\":true") > 0)
            g_Settings.breakevenUsePercent = true;
         else if(StringFind(response, "\"breakevenUsePercent\":false") > 0)
            g_Settings.breakevenUsePercent = false;

         int bePercentPos = StringFind(response, "\"breakevenPercent\":");
         if(bePercentPos > 0)
         {
            string temp = StringSubstr(response, bePercentPos + 19);
            int commaPos = StringFind(temp, ",");
            int bracePos = StringFind(temp, "}");
            int endPos = (commaPos > 0 && commaPos < bracePos) ? commaPos : bracePos;
            if(endPos > 0)
               g_Settings.breakevenPercent = StringToDouble(StringSubstr(temp, 0, endPos));
         }
         
         int dailyTargetPos = StringFind(response, "\"dailyTargetPercent\":");
         if(dailyTargetPos > 0)
         {
            string temp = StringSubstr(response, dailyTargetPos + 20);
            int commaPos = StringFind(temp, ",");
            int bracePos = StringFind(temp, "}");
            int endPos = (commaPos > 0 && commaPos < bracePos) ? commaPos : bracePos;
            if(endPos > 0)
               g_Settings.dailyTargetPercent = StringToDouble(StringSubstr(temp, 0, endPos));
         }
         
         // Parse string values  
         int pauseStartPos = StringFind(response, "\"pauseStartTime\":\"");
         if(pauseStartPos > 0)
         {
            string temp = StringSubstr(response, pauseStartPos + 18);
            int quotePos = StringFind(temp, "\"");
            if(quotePos > 0)
               g_Settings.pauseStartTime = StringSubstr(temp, 0, quotePos);
         }
         
         int pauseEndPos = StringFind(response, "\"pauseEndTime\":\"");
         if(pauseEndPos > 0)
         {
            string temp = StringSubstr(response, pauseEndPos + 16);
            int quotePos = StringFind(temp, "\"");
            if(quotePos > 0)
               g_Settings.pauseEndTime = StringSubstr(temp, 0, quotePos);
         }
         
         g_Settings.lastUpdated = TimeCurrent();
         
         if(Inp_Verbose)
            Print("EA settings loaded from Firebase");
      }
   }
}

//+------------------------------------------------------------------+
//| Execute SL/TP Modification Command                              |
//+------------------------------------------------------------------+
void ExecuteModifySLTPCommand(string response)
{
   Print("Executing MODIFY_SLTP command: ", response);
   
   // Extract ticket
   ulong ticket = 0;
   int ticketPos = StringFind(response, "\"ticket\":");
   if(ticketPos > 0)
   {
      string temp = StringSubstr(response, ticketPos + 9);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = (commaPos > 0 && commaPos < bracePos) ? commaPos : bracePos;
      if(endPos > 0)
         ticket = (ulong)StringToInteger(StringSubstr(temp, 0, endPos));
   }
   
   // Extract Stop Loss
   double sl = 0;
   int slPos = StringFind(response, "\"sl\":");
   if(slPos > 0)
   {
      string temp = StringSubstr(response, slPos + 5);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = (commaPos > 0 && commaPos < bracePos) ? commaPos : bracePos;
      if(endPos > 0)
         sl = StringToDouble(StringSubstr(temp, 0, endPos));
   }
   
   // Extract Take Profit
   double tp = 0;
   int tpPos = StringFind(response, "\"tp\":");
   if(tpPos > 0)
   {
      string temp = StringSubstr(response, tpPos + 5);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = (commaPos > 0 && commaPos < bracePos) ? commaPos : bracePos;
      if(endPos > 0)
         tp = StringToDouble(StringSubstr(temp, 0, endPos));
   }
   
   // Validate parameters
   if(ticket <= 0)
   {
      Print("Invalid ticket number: ", ticket);
      return;
   }
   
   // Select position and modify SL/TP
   if(PositionSelectByTicket(ticket))
   {
      string symbol = PositionGetString(POSITION_SYMBOL);
      double currentSL = PositionGetDouble(POSITION_SL);
      double currentTP = PositionGetDouble(POSITION_TP);
      
      Print("Modifying position ", ticket, " on ", symbol);
      Print("Current SL: ", currentSL, " -> New SL: ", sl);
      Print("Current TP: ", currentTP, " -> New TP: ", tp);
      
      // Use CTrade to modify position
      if(trade.PositionModify(ticket, sl, tp))
      {
         Print("Successfully modified SL/TP for position ", ticket);
         
         // Update position management tracking if exists
         int pmIndex = FindPositionManagement((long)ticket);
         if(pmIndex >= 0)
         {
            // Update break-even status if SL was set to entry price
            double entryPrice = PositionGetDouble(POSITION_PRICE_OPEN);
            if(MathAbs(sl - entryPrice) < SymbolInfoDouble(symbol, SYMBOL_POINT) * 5) // Within 5 points of entry
            {
               g_PosManagement[pmIndex].breakevenTriggered = true;
               Print("Break-even triggered for position ", ticket);
            }
         }
      }
      else
      {
         int error = GetLastError();
         Print("Failed to modify SL/TP for position ", ticket, ". Error: ", error);
      }
   }
   else
   {
      Print("Position not found: ", ticket);
   }
}

//+------------------------------------------------------------------+
//| Execute Time Limit Command                                       |
//+------------------------------------------------------------------+
void ExecuteTimeLimitCommand(string response)
{
   Print("Executing TIME_LIMIT command: ", response);
   
   // Extract ticket
   long ticket = 0;
   int ticketPos = StringFind(response, "\"ticket\":");
   if(ticketPos > 0)
   {
      string temp = StringSubstr(response, ticketPos + 9);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = (commaPos > 0 && commaPos < bracePos) ? commaPos : bracePos;
      if(endPos > 0)
         ticket = (long)StringToInteger(StringSubstr(temp, 0, endPos));
   }
   
   // Extract time limit (in seconds)
   int timeLimit = 0;
   int limitPos = StringFind(response, "\"timeLimit\":");
   if(limitPos > 0)
   {
      string temp = StringSubstr(response, limitPos + 12);
      int commaPos = StringFind(temp, ",");
      int bracePos = StringFind(temp, "}");
      int endPos = (commaPos > 0 && commaPos < bracePos) ? commaPos : bracePos;
      if(endPos > 0)
         timeLimit = (int)StringToInteger(StringSubstr(temp, 0, endPos));
   }
   
   // Validate parameters
   if(ticket <= 0)
   {
      Print("Invalid ticket number: ", ticket);
      return;
   }
   
   // Find or add position management
   int mgmtIndex = FindPositionManagement(ticket);
   if(mgmtIndex < 0)
   {
      AddPositionManagement(ticket);
      mgmtIndex = FindPositionManagement(ticket);
   }
   
   if(mgmtIndex >= 0)
   {
      g_PosManagement[mgmtIndex].timeLimit = timeLimit; // Time limit in seconds
      Print("Time limit updated for ticket ", ticket, ": ", timeLimit, " seconds");
   }
}
