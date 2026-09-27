//+------------------------------------------------------------------+
//| CalendarDump — one-shot script: exports the broker's economic     |
//| calendar history (actual/forecast/previous + time + impact) to a  |
//| CSV so we can backtest the news-surprise model in Python.         |
//| Drag onto ANY chart; writes  MQL5\Files\calendar_dump.csv .       |
//+------------------------------------------------------------------+
#property strict
#property script_show_inputs

input int Inp_DaysBack = 900;      // how far back to export

void OnStart()
{
   datetime to   = TimeGMT();
   datetime from = to - (datetime)Inp_DaysBack*86400;

   MqlCalendarValue values[];
   int n = CalendarValueHistory(values, from, to);   // all countries/currencies
   if(n <= 0){ Print("CalendarDump: CalendarValueHistory returned ", n, " (calendar empty / not available on this broker)"); return; }

   int fh = FileOpen("calendar_dump.csv", FILE_WRITE|FILE_CSV|FILE_ANSI, ',');
   if(fh == INVALID_HANDLE){ Print("CalendarDump: FileOpen failed ", GetLastError()); return; }
   FileWrite(fh, "utc","currency","impact","event","actual","forecast","previous");

   int written=0, withActual=0, withBoth=0;
   for(int i=0;i<n;i++)
   {
      MqlCalendarEvent ev;
      if(!CalendarEventById(values[i].event_id, ev)) continue;
      MqlCalendarCountry ct;
      string cur = "";
      if(CalendarCountryById(ev.country_id, ct)) cur = ct.currency;

      string imp = "None";
      if(ev.importance==CALENDAR_IMPORTANCE_HIGH)     imp="High";
      else if(ev.importance==CALENDAR_IMPORTANCE_MODERATE) imp="Medium";
      else if(ev.importance==CALENDAR_IMPORTANCE_LOW) imp="Low";

      // stored as long fixed-point (x1e6); LONG_MIN = not set
      string a = (values[i].actual_value   ==LONG_MIN)? "" : DoubleToString(values[i].actual_value  /1000000.0, 6);
      string f = (values[i].forecast_value ==LONG_MIN)? "" : DoubleToString(values[i].forecast_value/1000000.0, 6);
      string p = (values[i].prev_value     ==LONG_MIN)? "" : DoubleToString(values[i].prev_value    /1000000.0, 6);

      FileWrite(fh, (long)values[i].time, cur, imp, ev.name, a, f, p);
      written++;
      if(a!="") withActual++;
      if(a!="" && f!="") withBoth++;
   }
   FileClose(fh);
   PrintFormat("CalendarDump: wrote %d rows (%d with actual, %d with actual+forecast) to MQL5\\Files\\calendar_dump.csv", written, withActual, withBoth);
   Alert("CalendarDump done: ", written, " rows, ", withBoth, " with actual+forecast. See MQL5\\Files\\calendar_dump.csv");
}
