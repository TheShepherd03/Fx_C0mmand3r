// Command0r Zones — TradingView -> Firebase bridge (popup logic)
const API_KEY = "AIzaSyCA3LUdogLeo7wdHEfxfPQtG4EG2SqEFtg";
const RTDB = "https://c0mmand3r-default-rtdb.firebaseio.com";

const $ = (id) => document.getElementById(id);
const store = {
  get: (keys) => new Promise(r => chrome.storage.local.get(keys, r)),
  set: (obj) => new Promise(r => chrome.storage.local.set(obj, r)),
};
const sanitizeKey = (s) => s.replace(/[ .$#\[\]/]/g, "_");
let LAST = null;      // last read {symbol, rects}
let SYMBOLS = [];     // MT5 symbols for selected account

// ---------- Firebase auth ----------
async function signIn(email, password) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || "sign-in failed");
  await store.set({ idToken: j.idToken, refreshToken: j.refreshToken, tokenExp: Date.now() + (j.expiresIn * 1000) - 60000, email, password });
  return j.idToken;
}
async function refresh(refreshToken) {
  const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || "refresh failed");
  await store.set({ idToken: j.id_token, refreshToken: j.refresh_token, tokenExp: Date.now() + (j.expires_in * 1000) - 60000 });
  return j.id_token;
}
async function getToken() {
  const s = await store.get(["idToken", "refreshToken", "tokenExp", "email", "password"]);
  if (s.idToken && s.tokenExp && Date.now() < s.tokenExp) return s.idToken;
  if (s.refreshToken) { try { return await refresh(s.refreshToken); } catch (e) {} }
  if (s.email && s.password) return await signIn(s.email, s.password);
  throw new Error("not signed in");
}
async function fbGet(path) {
  const t = await getToken();
  const r = await fetch(`${RTDB}/${path}.json?auth=${t}`);
  if (!r.ok) throw new Error(`GET ${path} HTTP ${r.status}`);
  return r.json();
}
async function fbPatch(path, obj) {
  const t = await getToken();
  const r = await fetch(`${RTDB}/${path}.json?auth=${t}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj)
  });
  if (!r.ok) throw new Error(`PATCH ${path} HTTP ${r.status} ${await r.text()}`);
  return true;
}

// ---------- read rectangles from the active TradingView tab (MAIN world) ----------
async function readChart() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/tradingview\.com/.test(tab.url || "")) throw new Error("Open a TradingView chart tab first");
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id }, world: "MAIN",
    func: async () => {
      try {
        const api = window.TradingViewApi;
        if (!api || !api.activeChart) return { ok: false, error: "TradingView chart API not found on this page" };
        const chart = api.activeChart();
        const symbol = chart.symbol();
        let symExt = null; try { symExt = chart.symbolExt(); } catch (e) {}
        const shapes = chart.getAllShapes() || [];
        const rects = [];
        for (const s of shapes) {
          if (!/rect/i.test(s.name)) continue;
          const src = chart.getShapeById(s.id);
          let pts = src.getPoints(); if (pts && typeof pts.then === "function") pts = await pts;
          const prices = (pts || []).map(p => p.price).filter(x => typeof x === "number" && isFinite(x));
          if (prices.length >= 2) rects.push({ high: Math.max(...prices), low: Math.min(...prices) });
        }
        return { ok: true, symbol, symExt, rects };
      } catch (e) { return { ok: false, error: String(e) }; }
    }
  });
  const out = res?.result;
  if (!out || !out.ok) throw new Error(out?.error || "could not read chart");
  return out;
}

// ---------- UI ----------
function renderZones() {
  const list = $("zoneList");
  list.innerHTML = "";
  if (!LAST || !LAST.rects.length) { list.innerHTML = `<div class="muted" style="margin-top:6px;">No rectangles found on the chart.</div>`; return; }
  LAST.rects.forEach(z => {
    const d = document.createElement("div");
    d.className = "zone";
    d.innerHTML = `<span>High <b>${z.high}</b></span><span>Low <b>${z.low}</b></span>`;
    list.appendChild(d);
  });
}
function refreshSendState() {
  $("sendBtn").disabled = !(LAST && LAST.rects.length && $("account").value && $("mt5symbol").value.trim());
}
async function loadAccounts() {
  try {
    const accts = await fbGet("accounts");
    const sel = $("account"); sel.innerHTML = "";
    Object.keys(accts || {}).forEach(a => {
      const o = document.createElement("option"); o.value = a; o.textContent = a; sel.appendChild(o);
    });
    const saved = (await store.get(["lastAccount"])).lastAccount;
    if (saved && accts[saved]) sel.value = saved;
    await loadSymbols();
  } catch (e) { setStatus("sendStatus", "Load accounts: " + e.message, true); }
}
async function loadSymbols() {
  const acct = $("account").value; if (!acct) return;
  try {
    const arr = await fbGet(`symbols/${acct}`);
    SYMBOLS = Array.isArray(arr) ? arr : (arr ? Object.values(arr) : []);
    const dl = $("symlist"); dl.innerHTML = "";
    SYMBOLS.forEach(s => { const o = document.createElement("option"); o.value = s; dl.appendChild(o); });
  } catch (e) { SYMBOLS = []; }
}
function setStatus(id, msg, err) { const el = $(id); el.textContent = msg; el.className = "status " + (err ? "err" : "ok"); }

// ---------- auto-match TradingView symbol -> MT5 symbol ----------
const stripExch = (s) => (s || "").replace(/^[A-Za-z0-9_]+:/, "").trim(); // "PEPPERSTONE:XAUUSD" -> "XAUUSD"
const noSep = (s) => (s || "").toLowerCase().replace(/[\s._\-]/g, "");
function autoMatchSymbol(tvSymbol, symExt) {
  // candidate TV names, most specific first
  const forms = [];
  if (symExt && symExt.symbol) forms.push(symExt.symbol);
  forms.push(stripExch(tvSymbol), tvSymbol);
  if (symExt && symExt.description) forms.push(symExt.description);
  let best = "", bestScore = 0;
  for (const m of SYMBOLS) {
    const mns = noSep(m);
    for (const f of forms) {
      const fs = noSep(f);
      if (!fs || !mns) continue;
      let score = 0;
      if (mns === fs) score = 100;                                              // exact
      else if (mns.startsWith(fs) && mns.length - fs.length <= 4) score = 85;   // XAUUSD -> XAUUSDb(.Z)
      else if (fs.startsWith(mns) && fs.length - mns.length <= 4) score = 70;   // MT5 core inside TV name
      if (score > bestScore) { bestScore = score; best = m; }
    }
  }
  return bestScore >= 70 ? best : "";
}

async function applyRememberedMapping() {
  if (!LAST) return;
  const maps = (await store.get(["symMap"])).symMap || {};
  const m = maps[LAST.symbol];
  if (m) {
    if (m.account && [...$("account").options].some(o => o.value === m.account)) { $("account").value = m.account; await loadSymbols(); }
    if (m.mt5) $("mt5symbol").value = m.mt5;
  }
  refreshSendState();
}

// ---------- init ----------
async function init() {
  const s = await store.get(["email", "password"]);
  if (s.email && s.password) { showMain(); await loadAccounts(); }
  else { $("loginCard").classList.remove("hidden"); $("mainCard").classList.add("hidden"); }
}
function showMain() { $("loginCard").classList.add("hidden"); $("mainCard").classList.remove("hidden"); }

$("saveLogin").onclick = async () => {
  const email = $("email").value.trim(), password = $("password").value;
  if (!email || !password) return setStatus("loginStatus", "Enter email and password", true);
  setStatus("loginStatus", "Signing in…", false);
  try { await signIn(email, password); setStatus("loginStatus", "Signed in ✓", false); showMain(); await loadAccounts(); }
  catch (e) { setStatus("loginStatus", "Failed: " + e.message, true); }
};
$("signout").onclick = async () => { await store.set({ idToken: null, refreshToken: null, email: null, password: null }); location.reload(); };
$("readBtn").onclick = async () => {
  setStatus("sendStatus", "Reading chart…", false);
  try {
    LAST = await readChart();
    $("tvInfo").textContent = `TradingView: ${LAST.symbol}${LAST.symExt?.description ? " (" + LAST.symExt.description + ")" : ""} — ${LAST.rects.length} zone(s)`;
    renderZones(); await applyRememberedMapping();
    // if no remembered pick, auto-match the TV symbol to the MT5 list
    if (!$("mt5symbol").value.trim()) {
      const m = autoMatchSymbol(LAST.symbol, LAST.symExt);
      if (m) $("mt5symbol").value = m;
    }
    refreshSendState();
    const picked = $("mt5symbol").value.trim();
    setStatus("sendStatus",
      !LAST.rects.length ? "No rectangles found." : (picked ? `Matched → ${picked}` : "Pick the MT5 symbol below."),
      !LAST.rects.length);
  } catch (e) { setStatus("sendStatus", e.message, true); }
};
$("account").onchange = async () => { await loadSymbols(); refreshSendState(); };
$("mt5symbol").oninput = refreshSendState;
$("sendBtn").onclick = async () => {
  if (!LAST || !LAST.rects.length) return;
  const acct = $("account").value, mt5 = $("mt5symbol").value.trim();
  if (!acct || !mt5) return;
  const zones = LAST.rects.map(z => `${z.high}:${z.low}`).join("|");
  const node = {}; node[sanitizeKey(mt5)] = { symbol: mt5, zones, active: true, expiresAt: 0 };
  setStatus("sendStatus", "Sending…", false);
  try {
    await fbPatch(`zones/${acct}`, node);
    const maps = (await store.get(["symMap"])).symMap || {};
    maps[LAST.symbol] = { account: acct, mt5 };
    await store.set({ symMap: maps, lastAccount: acct });
    setStatus("sendStatus", `Sent ${LAST.rects.length} zone(s) to ${mt5} ✓`, false);
  } catch (e) { setStatus("sendStatus", "Send failed: " + e.message, true); }
};

init();
