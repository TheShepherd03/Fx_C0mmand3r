// Cloud watchdog for the MT5 terminals. Runs on a GitHub Actions schedule, so it
// still alerts when the PC itself is off or offline. Reads each account's
// heartbeat (accounts/{id}/lastUpdated, UTC seconds, written by Bridge_EA every
// few seconds) and pushes to every registered phone when a terminal goes quiet,
// then again when it recovers. State lives in watchdog/{id} so each outage is
// announced once. Honors prefs/signals: sources.Watchdog.notify=false mutes it;
// during quiet hours the offline alert waits until they end (if still offline).
//
// Env: FIREBASE_EMAIL, FIREBASE_PASSWORD (repo secrets), FIREBASE_API_KEY, FIREBASE_DB_URL.
// Local testing: FIREBASE_ID_TOKEN (skip sign-in), WATCHDOG_DRY_RUN=1 (log pushes,
// write nothing), WATCHDOG_NOW_OFFSET=<sec> (pretend it is later).

const DB = process.env.FIREBASE_DB_URL || 'https://c0mmand3r-default-rtdb.firebaseio.com';
const API_KEY = process.env.FIREBASE_API_KEY;
const EMAIL = process.env.FIREBASE_EMAIL;
const PASSWORD = process.env.FIREBASE_PASSWORD;
const DRY_RUN = process.env.WATCHDOG_DRY_RUN === '1';

const LIVE_SEC = 90;             // same thresholds as the app's status badges
const OFFLINE_SEC = 600;
const IGNORE_SEC = 2 * 86400;    // retired / long-dead accounts never alert

async function signIn() {
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
    },
  );
  if (!r.ok) throw new Error(`Firebase sign-in failed: HTTP ${r.status}`);
  return (await r.json()).idToken;
}

async function db(method, path, token, { query = '', body } = {}) {
  const r = await fetch(`${DB}/${path}.json?auth=${token}${query}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status}`);
  return r.json();
}

// "HF_Markets_SA__Pty__Ltd_HFMarketsSA_Live2_55029630" -> "HFM · 55029630"
function label(id) {
  const num = (id.match(/_(\d+)$/) || [])[1] || id;
  const broker = /^HF_?Markets/i.test(id) ? 'HFM' : /^Deriv/i.test(id) ? 'Deriv' : id.split('_')[0];
  return `${broker} · ${num}`;
}

function duration(sec) {
  const m = Math.max(1, Math.round(sec / 60));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)} days`;
}

function notifyAllowed(prefs, now) {
  if (!prefs) return true;
  if (prefs.sources?.Watchdog?.notify === false) return false;
  const q = prefs.quiet;
  if (q?.enabled) {
    const local = now + (Number(q.tzOffsetMin) || 0) * 60;
    const mins = Math.floor((((local % 86400) + 86400) % 86400) / 60);
    const start = Number(q.start) || 0;
    const end = Number(q.end) || 0;
    const quiet = start <= end ? mins >= start && mins < end : mins >= start || mins < end;
    if (quiet) return false;
  }
  return true;
}

async function push(tokens, title, body, account) {
  if (DRY_RUN) return console.log(`[dry run] would push to ${tokens.length} device(s): ${title} | ${body}`);
  if (!tokens.length) return console.log(`(no push tokens) ${title}`);
  // Tapping opens the dashboard switched to the affected account.
  const messages = tokens.map((to) => ({
    to, title, body, sound: 'default', channelId: 'signals', priority: 'high', data: { screen: 'home', account },
  }));
  const r = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(messages),
  });
  console.log(`push "${title}" to ${tokens.length} device(s): HTTP ${r.status}`);
}

async function main() {
  const presetToken = process.env.FIREBASE_ID_TOKEN;
  if (!presetToken && (!EMAIL || !PASSWORD || !API_KEY)) {
    console.log('::warning::Watchdog idle: add the FIREBASE_EMAIL and FIREBASE_PASSWORD repository secrets.');
    return;
  }
  const token = presetToken || (await signIn());
  const now = Math.floor(Date.now() / 1000) + (Number(process.env.WATCHDOG_NOW_OFFSET) || 0);

  const ids = Object.keys((await db('GET', 'accounts', token, { query: '&shallow=true' })) || {});
  const state = (await db('GET', 'watchdog', token)) || {};
  const prefs = await db('GET', 'prefs/signals', token);
  const tokenBlob = JSON.stringify((await db('GET', 'pushTokens', token)) || {});
  const tokens = [...new Set(tokenBlob.match(/ExponentPushToken\[[^\]]+\]/g) || [])];
  const allowed = notifyAllowed(prefs, now);

  const updates = {};
  for (const id of ids) {
    const lastUpdated = await db('GET', `accounts/${id}/lastUpdated`, token);
    if (typeof lastUpdated !== 'number') continue;
    const age = now - lastUpdated;
    const prev = state[id] || { status: 'live' };
    console.log(`${label(id)}: heartbeat ${age}s ago (was ${prev.status})`);

    if (age >= IGNORE_SEC) {
      if (state[id]) updates[id] = null;
      continue;
    }
    if (age >= OFFLINE_SEC) {
      const next = prev.status === 'offline' ? { ...prev } : { status: 'offline', since: lastUpdated, notified: false };
      if (!next.notified && allowed) {
        await push(tokens, `⚠️ ${label(id)} terminal offline`,
          `No heartbeat for ${duration(now - next.since)}. Check the PC / MT5 terminal.`, id);
        next.notified = true;
      }
      if (JSON.stringify(next) !== JSON.stringify(prev)) updates[id] = next;
    } else if (age < LIVE_SEC && prev.status === 'offline') {
      if (prev.notified && allowed) {
        await push(tokens, `✅ ${label(id)} back online`, `Heartbeat restored after ${duration(now - prev.since)}.`, id);
      }
      updates[id] = { status: 'live', since: lastUpdated };
    }
  }
  if (!Object.keys(updates).length) return;
  if (DRY_RUN) return console.log('[dry run] would write watchdog state:', JSON.stringify(updates));
  await db('PATCH', 'watchdog', token, { body: updates });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
