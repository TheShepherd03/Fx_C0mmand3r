//+------------------------------------------------------------------+
//|                                                        JAson.mqh |
//|                                          JSON Parser & Serializer|
//|                                                      Lightweight |
//+------------------------------------------------------------------+
#property copyright "Public Domain"
#property strict

//------------------------------------------------------------------
// Enum for JSON types
//------------------------------------------------------------------
enum ENUM_JSON_TYPE
{
   JSON_NULL,
   JSON_OBJECT,
   JSON_ARRAY,
   JSON_STRING,
   JSON_NUMBER,
   JSON_BOOL
};

//------------------------------------------------------------------
// CJSONValue Base Class
//------------------------------------------------------------------
class CJSONValue
{
public:
   virtual ENUM_JSON_TYPE GetType() { return JSON_NULL; }
   virtual string ToString() { return "null"; }
   virtual ~CJSONValue() {}
};

//------------------------------------------------------------------
// CJSONObject
//------------------------------------------------------------------
class CJSONObject : public CJSONValue
{
private:
   string m_keys[];
   CJSONValue *m_values[];
   int m_size;

public:
   CJSONObject() { m_size = 0; }
   ~CJSONObject()
   {
      for(int i=0; i<m_size; i++)
      {
         if(CheckPointer(m_values[i]) == POINTER_DYNAMIC)
            delete m_values[i];
      }
      ArrayResize(m_keys, 0);
      ArrayResize(m_values, 0);
   }

   ENUM_JSON_TYPE GetType() override { return JSON_OBJECT; }

   void Add(string key, CJSONValue *value)
   {
      // Check if key exists, if so replace
      for(int i=0; i<m_size; i++)
      {
         if(m_keys[i] == key)
         {
            if(CheckPointer(m_values[i]) == POINTER_DYNAMIC) delete m_values[i];
            m_values[i] = value;
            return;
         }
      }
      
      m_size++;
      ArrayResize(m_keys, m_size);
      ArrayResize(m_values, m_size);
      m_keys[m_size-1] = key;
      m_values[m_size-1] = value;
   }
   
   void Add(string key, string value);
   void Add(string key, double value);
   void Add(string key, int value);
   void Add(string key, long value);
   void Add(string key, bool value);

   string ToString() override
   {
      string s = "{";
      for(int i=0; i<m_size; i++)
      {
         s += "\"" + m_keys[i] + "\":" + m_values[i].ToString();
         if(i < m_size-1) s += ",";
      }
      s += "}";
      return s;
   }
};

//------------------------------------------------------------------
// CJSONArray
//------------------------------------------------------------------
class CJSONArray : public CJSONValue
{
private:
   CJSONValue *m_values[];
   int m_size;

public:
   CJSONArray() { m_size = 0; }
   ~CJSONArray()
   {
      for(int i=0; i<m_size; i++)
      {
         if(CheckPointer(m_values[i]) == POINTER_DYNAMIC)
            delete m_values[i];
      }
      ArrayResize(m_values, 0);
   }

   ENUM_JSON_TYPE GetType() override { return JSON_ARRAY; }

   void Add(CJSONValue *value)
   {
      m_size++;
      ArrayResize(m_values, m_size);
      m_values[m_size-1] = value;
   }
   
   void Add(string value); // Defined below
   void Add(double value);
   void Add(int value);
   
   string ToString() override
   {
      string s = "[";
      for(int i=0; i<m_size; i++)
      {
         s += m_values[i].ToString();
         if(i < m_size-1) s += ",";
      }
      s += "]";
      return s;
   }
};

//------------------------------------------------------------------
// Primitives
//------------------------------------------------------------------
class CJSONString : public CJSONValue
{
   string m_val;
public:
   CJSONString(string val) { m_val = val; }
   ENUM_JSON_TYPE GetType() override { return JSON_STRING; }
   string ToString() override 
   { 
      string s = m_val;
      StringReplace(s, "\\", "\\\\");
      StringReplace(s, "\"", "\\\"");
      StringReplace(s, "\n", "\\n");
      StringReplace(s, "\r", "\\r");
      StringReplace(s, "\t", "\\t");
      return "\"" + s + "\""; 
   }
};

class CJSONNumber : public CJSONValue
{
   double m_val;
   int m_digits;
public:
   CJSONNumber(double val, int digits=8) { m_val = val; m_digits = digits; }
   ENUM_JSON_TYPE GetType() override { return JSON_NUMBER; }
   string ToString() override 
   { 
       // Handle integer vs double formatting
       if(MathFloor(m_val) == m_val) return IntegerToString((long)m_val);
       return DoubleToString(m_val, m_digits); 
   }
};

class CJSONBool : public CJSONValue
{
   bool m_val;
public:
   CJSONBool(bool val) { m_val = val; }
   ENUM_JSON_TYPE GetType() override { return JSON_BOOL; }
   string ToString() override { return m_val ? "true" : "false"; }
};

//------------------------------------------------------------------
// Implementation of convenience methods
//------------------------------------------------------------------
void CJSONObject::Add(string key, string value) { Add(key, new CJSONString(value)); }
void CJSONObject::Add(string key, double value) { Add(key, new CJSONNumber(value, 8)); }
void CJSONObject::Add(string key, int value)    { Add(key, new CJSONNumber((double)value, 0)); }
void CJSONObject::Add(string key, long value)   { Add(key, new CJSONNumber((double)value, 0)); }
void CJSONObject::Add(string key, bool value)   { Add(key, new CJSONBool(value)); }

void CJSONArray::Add(string value) { Add(new CJSONString(value)); }
void CJSONArray::Add(double value) { Add(new CJSONNumber(value, 8)); }
void CJSONArray::Add(int value)    { Add(new CJSONNumber((double)value, 0)); }
