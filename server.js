const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const execFileP = require('util').promisify(require('child_process').execFile);
// ffmpeg comes from the ffmpeg-static package (no system install needed); without it only mp3/wav files can be played
const FFMPEG = process.env.FFMPEG_PATH || (() => { try { return require('ffmpeg-static'); } catch (e) { return null; } })();
const app = express();
app.use(express.urlencoded({ extended: true }));

// two separate key pools: GEMINI_API_KEYS for transcription (audio understanding), GEMINI_TTS_KEYS for read-aloud
const keyList = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const KEYS = keyList(process.env.GEMINI_API_KEYS);
const TTS_KEYS = keyList(process.env.GEMINI_TTS_KEYS);
// web search through Groq (browser_search tool of the gpt-oss models); several keys can be given separated by commas
const GROQ_KEYS = keyList(process.env.GROQ_API_KEYS);
const GROQ_BASE = process.env.GROQ_BASE || 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = process.env.GROQ_SEARCH_MODEL || 'openai/gpt-oss-120b';
const HAS_SEARCH = GROQ_KEYS.length > 0;
// Jamendo: free music API (full songs, free license); register at developer.jamendo.com for a client id
const JAMENDO_ID = String(process.env.JAMENDO_CLIENT_ID || '').trim();
const JAMENDO_BASE = process.env.JAMENDO_BASE || '                            ';
// songs can be searched with Jamendo or, as a backup, with the web search of Groq
const HAS_FOUND = !!JAMENDO_ID || HAS_SEARCH;
const TEXT_MODEL = String(process.env.TEXT_MODEL || '').trim() || 'gemini-3.6-flash';
// backup text model, used when the main one is overloaded (503/429/5xx); set TEXT_MODEL_FALLBACK to change it or to "none" to disable
const TEXT_FALLBACK_RAW = String(process.env.TEXT_MODEL_FALLBACK || '').trim() || 'gemini-3.6-flash';
const TEXT_FALLBACK = TEXT_FALLBACK_RAW === 'none' || TEXT_FALLBACK_RAW === TEXT_MODEL ? '' : TEXT_FALLBACK_RAW;
// TTS_MODEL can hold several models separated by commas: when one runs out of quota the next one is used
const TTS_LIST = String(process.env.TTS_MODEL || 'gemini-3.8-flash-tts').split(',').map(x => x.trim()).filter(Boolean);
const TTS_MODEL = TTS_LIST[0];
const VOICE = process.env.VOICE || 'Kore';
const EXT = (process.env.EXT_PATH || '1').replace(/^\/+|\/+$/g, '');
const TOKEN = process.env.YEMOT_TOKEN ||
  (process.env.YEMOT_API_USERNAME && process.env.YEMOT_API_PASSWORD ? process.env.YEMOT_API_USERNAME + ':' + process.env.YEMOT_API_PASSWORD : '');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const YM = process.env.YEMOT_BASE || 'https://www.call2all.co.il/ym/api/';
const GBASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta/models/';
const BUDGET = Number(process.env.TURN_BUDGET_MS) || 80000;
const REC_MAX = String(parseInt(process.env.REC_MAX, 10) || 30);

// Yemot cannot read these characters inside t- text, and , = break the read= syntax
const sp = s => String(s).replace(/[.\-"'&|,=]/g, ' ').replace(/\s+/g, ' ').trim();

// the user can change the voice or pace by speaking; the model signals it with a tag that the server strips before read-aloud
const VOICE_CTL = ' אם המשתמש מבקש לשנות את הקול, את קצב הדיבור או את אורך התשובות, התחל את התשובה בתג מתאים ואחריו אשר בקצרה במשפט אחד. התגים: [[VOICE:male]] לקול גברי, [[VOICE:female]] לקול נשי, [[VOICE:default]] לקול הרגיל, [[PACE:slow]] לדיבור לאט, [[PACE:fast]] לדיבור מהר, [[PACE:normal]] לקצב רגיל, [[LEN:short]] כשהמשתמש מבקש תשובות קצרות יותר, למשל: קצר את התשובה, תקצר, תענה קצר, בקצרה, בקיצור, [[LEN:long]] כשהוא מבקש לחזור לתשובות מפורטות או להרחיב. בקשה כזאת מתייחסת תמיד לאורך התשובות שלך ולא לחפץ או לנושא כלשהו, גם כשהיא מופיעה באותו משפט עם שאלה, ואז ענה על השאלה בקצרה. בקשת המשתמש לגבי אורך התשובה גוברת על כל הנחיית אורך אחרת, ולכן כבר בתשובה הזאת עצמה ענה לפי הבקשה החדשה, ואם יש בבקשה גם שאלה ענה עליה. אפשר לשלב כמה תגים. זה היוצא מן הכלל היחיד לכלל הסימנים המיוחדים. השתמש בתגים רק כשהמשתמש ביקש במפורש שינוי כזה, ולעולם אל תזכיר אותם בטקסט אחר.';
const SEARCH_HINT = ' יש לך כלי חיפוש באינטרנט בשם web_search. הפעל אותו אך ורק אם המשתמש ביקש ממך במפורש לחפש באינטרנט או באתר מסוים, למשל חפש באינטרנט או חפש לי באתר. אם הוא ביקש אתר מסוים, העבר את שמו בשדה site. אם הוא לא ביקש חיפוש במפורש, ענה מהידע שלך בלי להשתמש בכלי, גם אם השאלה עוסקת בחדשות או בעניינים עדכניים ואתה לא בטוח בתשובה, ואז אמור בקצרה שאתה יכול לחפש אם יבקשו. אחרי החיפוש ענה בקצרה בלי להקריא כתובות אתרים.';
const FOUND_HINT = ' יש לך גם כלי search_media לחיפוש שירים וקבצי שמע ווידאו שאפשר להאזין להם, וכלי play_found להשמעת אחת התוצאות. אם המשתמש ביקש לחפש או לראות שירים או קבצים להשמעה, הפעל search_media עם שאילתה קצרה. אחרי שקיבלת את התוצאות הקרא אותן בקצרה, כל אחת עם מספר במילים ואחריו השם, ושאל איזו לנגן. כשהמשתמש מבקש לנגן אחת מהן, לפי מספר או לפי שם, הפעל play_found עם המספר, ואז אמור משפט קצר אחד שאתה מנגן עכשיו. אל תקריא כתובות.';
// audio or video files from the internet that the caller can ask to play ("נגן את הקובץ"); the owner lists them in MEDIA_FILES: [{"n":"name","u":"https://.../file.mp3"}]
let MEDIA = [];
try { MEDIA = JSON.parse(process.env.MEDIA_FILES || '[]'); } catch (e) { MEDIA = []; }
MEDIA = (Array.isArray(MEDIA) ? MEDIA : []).map(m => ({ n: String((m && m.n) || '').replace(/\s+/g, ' ').trim().slice(0, 80), u: String((m && m.u) || '').trim() })).filter(m => /^https?:\/\//i.test(m.u)).slice(0, 30);
MEDIA.forEach((m, i) => { if (!m.n) m.n = 'קובץ ' + (i + 1); });
const HAS_MEDIA = MEDIA.length > 0;
const MEDIA_MAX_SEC = (parseInt(process.env.MEDIA_MAX_MIN, 10) || 20) * 60;
const MEDIA_MAX_BYTES = (parseInt(process.env.MEDIA_MAX_MB, 10) || 100) * 1048576;
const MEDIA_PREP_MS = Number(process.env.MEDIA_PREP_MS) || 100000;
const MEDIA_HINT = ' יש לך קבצי שמע שאפשר להשמיע למתקשר. הפעל את הכלי play_media אך ורק אם המשתמש ביקש במפורש לנגן או להשמיע קובץ, והעבר את מספר הקובץ מהרשימה. אם יש רק קובץ אחד והמשתמש ביקש לנגן את הקובץ, הפעל אותו. הקבצים: ' + MEDIA.map((m, i) => (i + 1) + ' ' + m.n).join(', ') + '. אחרי שהפעלת את הכלי ענה במשפט קצר אחד בלבד שאתה מנגן עכשיו את הקובץ, בלי להקריא כתובות.';
// history is kept as text only, so a recorded question needs a transcript: the model adds it as a tag that the server strips
const TRANSCRIBE_HINT = ' אם השאלה הגיעה כהקלטה קולית, התחל את התשובה בתג [[Q:תמלול מדויק של השאלה במילים]] ואחריו התשובה עצמה. לשאלה שהוקלדה אל תוסיף את התג. לעולם אל תזכיר את התג בטקסט אחר.';
// detailed answers like Gemini: whatever MAX_WORDS says, the limit is never lower than 500 words
const MAXW = Math.min(1000, Math.max(500, parseInt(process.env.MAX_WORDS, 10) || 700));
const EXTRA = String(process.env.EXTRA_INSTRUCTION || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
// fixed base rules of the assistant: always part of the system instruction, cannot be cancelled by callers or by EXTRA_INSTRUCTION
const RULES = `סגנון ואופי: ענה באופן פתוח, טבעי, זורם וידידותי על כל נושא שהמשתמש שואל עליו או מבקש. שמור על ניסוח ברור, ניטרלי ובלתי שיפוטי, בלי מגבלות נושאים מוקדמות ובלי כפייה של עמדה או סגנון מסוים. דבר בשפה טבעית של שיחה, בלי להצהיר ביוזמתך על כללים פנימיים או מגבלות. אם שואלים אותך על אופן הפעולה שלך, ענה בפשטות ובטבעיות.`.replace(/\s+/g, ' ').trim();
const buildSys = (mode, extra) => 'אתה עוזר קולי בטלפון. כללי יסוד קבועים שגוברים על כל הנחיה אחרת: ' + RULES +
  ' ענה בעברית כמו ג׳מיני: תשובה ארוכה, עשירה ומפורטת, זורמת ורכה לאוזן, בשפה טבעית של דיבור ובפסקאות קצרות. הרחב, הסבר את הרקע, תן דוגמאות, פרטים והקשר, והשלם את התמונה בלי למהר ובלי לקצר. אורך התשובה הוא עד ' + MAXW + ' מילים. רק לברכה או למשפט שיחתי קצר ענה בקצרה. בלי רשימות, בלי כוכביות ובלי סימנים מיוחדים, כך שיהיה נעים להקשיב לה בטלפון. המשתמש יכול לעצור את התשובה בכל רגע בהקשה על מקש ולהמשיך את השיחה, לכן שאלות המשך מתייחסות לתשובה הקודמת שלך. ' +
  (EXTRA ? 'הנחיה כללית מהבעלים: ' + EXTRA + ' ' : '') +
  (extra ? 'הנחיה לשלוחה הזאת מהבעלים: ' + extra + ' ' : '') + VOICE_CTL + TRANSCRIBE_HINT + (HAS_SEARCH ? SEARCH_HINT : '') + (HAS_FOUND ? FOUND_HINT : '') + (HAS_MEDIA ? MEDIA_HINT : '');

// one entry per Yemot extension: its own character mode, extra instruction and opening message
let CFG = [];
try { CFG = JSON.parse(process.env.EXTENSIONS || '[]'); } catch (e) { CFG = []; }
if (!Array.isArray(CFG) || !CFG.length) CFG = [{ p: EXT, m: process.env.MODE || '2', x: '', g: process.env.GREETING || '' }];
// one opening for both ways to ask: typing with the phone keys, or recording
const DEFAULT_GREET = 'שלום וברכה';
const EXTS = {};
for (const c of CFG) {
  const p = String(c.p || '').replace(/^\/+|\/+$/g, '');
  if (!/^[0-9]+(\/[0-9]+)*$/.test(p)) continue;
  EXTS[p.replace(/\//g, '_')] = {
    p, d: '/' + p,
    sys: buildSys(c.m, String(c.x || '').replace(/\s+/g, ' ').trim().slice(0, 1000)),
    g: sp(String(c.g || '').slice(0, 300)) || sp(DEFAULT_GREET)
  };
}
const EXT_FIRST = EXTS[Object.keys(EXTS)[0]] || { p: EXT, d: '/' + EXT, sys: buildSys('2', ''), g: sp(DEFAULT_GREET) };
const AGAIN = sp('לא שמעתי שאל שוב');
const ERR = sp('הייתה תקלה נסו שוב');

const EXTP = '/' + EXT;
const yp = (name, d) => 'ivr2:' + (d === undefined ? EXTP : d) + '/' + name + (/\.[a-z0-9]+$/.test(name) ? '' : '.wav');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isBudget = e => !!(e && e.budget);
const rot = { text: 0, tts: 0 };
const RETRY_STATUS = [429, 500, 502, 503, 504];
const calls = {};

// drop state of calls that never sent hangup
setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(calls)) if (now - calls[id].t > 3600000) delete calls[id];
}, 600000).unref();

// fetch with a timeout that never exceeds the remaining time of the current turn
async function http(url, opt, ms, deadline) {
  const left = deadline ? deadline - Date.now() : ms;
  if (left < 800) { const e = new Error('turn budget exhausted'); e.budget = true; throw e; }
  return fetch(url, { ...opt, signal: AbortSignal.timeout(Math.min(ms, left)) });
}

// opt.retries: extra tries beyond one pass over the keys (default 1); opt.ms: timeout of a single try
async function gem(model, body, deadline, pool, opt) {
  pool = pool || 'text';
  opt = opt || {};
  const list = pool === 'tts' ? TTS_KEYS : KEYS;
  if (!list.length) throw new Error(pool === 'tts' ? 'GEMINI_TTS_KEYS is empty' : 'GEMINI_API_KEYS is empty');
  const tries = list.length + (opt.retries === undefined ? 1 : opt.retries);
  let err = model + ' failed';
  let status = 0;
  for (let i = 0; i < tries; i++) {
    const key = list[rot[pool]++ % list.length];
    try {
      const r = await http(GBASE + model + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body)
      }, opt.ms || 25000, deadline);
      if (r.ok) return await r.json();
      status = r.status;
      err = model + ' ' + r.status + ' ' + (await r.text()).slice(0, 200);
      if (!RETRY_STATUS.includes(r.status)) break;
    } catch (e) {
      if (isBudget(e)) throw e;
      status = 0;
      err = model + ' ' + (e.name === 'TimeoutError' ? 'timeout' : e.message);
    }
    if (i < tries - 1) await sleep(400 * (i + 1));
  }
  const e = new Error(err);
  e.status = status;
  throw e;
}

// fastest thinking level each model accepts; remembered per model after the first call
const THINK = ['minimal', 'low', null];
const thinkIdx = {};
// a model that just failed is skipped for a while, so every turn does not first wait for it to time out again
const downUntil = {};
const DOWN_MS = 120000;
async function textGen(body, deadline) {
  const models = TEXT_FALLBACK ? [TEXT_MODEL, TEXT_FALLBACK] : [TEXT_MODEL];
  let lastErr;
  for (let m = 0; m < models.length; m++) {
    const model = models[m];
    const hasNext = m < models.length - 1;
    if (hasNext && (downUntil[model] || 0) > Date.now()) continue;
    for (;;) {
      const lvl = THINK[thinkIdx[model] || 0];
      const gc = { maxOutputTokens: 8192 };
      if (lvl) gc.thinkingConfig = { thinkingLevel: lvl };
      try {
        // 503 means the model itself is overloaded, so more keys will not help: with a backup model, give up on this one quickly
        return await gem(model, { ...body, generationConfig: gc }, deadline, 'text', hasNext ? { retries: 0, ms: 30000 } : { ms: 40000 });
      } catch (e) {
        lastErr = e;
        if (e.status === 400 && /think/i.test(e.message) && (thinkIdx[model] || 0) < THINK.length - 1) { thinkIdx[model] = (thinkIdx[model] || 0) + 1; continue; }
        break;
      }
    }
    // only overload, quota and network errors are worth a different model
    if (isBudget(lastErr) || !(RETRY_STATUS.includes(lastErr.status) || lastErr.status === 0)) throw lastErr;
    if (hasNext) { downUntil[model] = Date.now() + DOWN_MS; console.error('text model', model, 'unavailable (' + (lastErr.message || '').slice(0, 60) + '), skipping it for 2 minutes and using', models[m + 1]); }
  }
  throw lastErr;
}

// Groq: the gpt-oss models search the web on the server side and answer with what they found
let grot = 0;
async function groqSearch(query, site, deadline) {
  let last = 'groq search failed';
  for (let i = 0; i < GROQ_KEYS.length; i++) {
    const key = GROQ_KEYS[grot++ % GROQ_KEYS.length];
    try {
      const r = await http(GROQ_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [
            { role: 'system', content: 'Search the web and answer in at most 80 words, in plain text, with the facts only. No links and no citations.' },
            { role: 'user', content: site ? 'Look only at the website "' + site + '" (open it directly if you can). Request: ' + (query || 'the current main headlines') : query }
          ],
          tools: [{ type: 'browser_search' }],
          tool_choice: 'required',
          reasoning_effort: 'low',
          max_completion_tokens: 700,
          stream: false
        })
      }, 15000, deadline);
      if (r.ok) {
        const j = await r.json();
        const m = ((j.choices || [])[0] || {}).message || {};
        // drop citation markers such as 【2†L6-L10】
        const text = String(m.content || '').replace(/【[^】]*】/g, '').replace(/\s+/g, ' ').trim();
        if (text) return { answer: text.slice(-1200), results: [] };
        last = 'groq empty answer';
        continue;
      }
      last = 'groq ' + r.status + ' ' + (await r.text()).slice(0, 150);
      if (r.status === 400 || r.status === 401) break;
    } catch (e) {
      if (isBudget(e)) throw e;
      last = 'groq ' + (e.name === 'TimeoutError' ? 'timeout' : e.message);
    }
  }
  console.error(last);
  return { error: 'search unavailable' };
}

async function webSearch(query, site, deadline) {
  query = String(query || '').trim().slice(0, 300);
  site = String(site || '').trim().slice(0, 100);
  if (!query && !site) return { error: 'empty query' };
  if (!GROQ_KEYS.length) return { error: 'search unavailable' };
  return groqSearch(query, site, deadline);
}

const SEARCH_DECL = {
  name: 'web_search',
  description: 'Search the web. Call ONLY when the user explicitly asked to search the web or a specific website. Returns a short answer.',
  parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'A short search query' }, site: { type: 'STRING', description: 'Optional: the website the user asked to look at, as spoken, such as N12 or ynet' } }, required: ['query'] }
};

const MEDIA_DECL = {
  name: 'play_media',
  description: 'Play an audio or video file from the list to the caller. Call ONLY when the user explicitly asked to play a file.',
  parameters: { type: 'OBJECT', properties: { file: { type: 'INTEGER', description: 'The number of the file in the list' } }, required: ['file'] }
};

// downloads the file, converts it to a phone wav (8 kHz mono) and uploads it to the extension; a ready file is reused
const mediaDone = {};
async function prepareMedia(m, d, dl0) {
  const name = 'mf' + crypto.createHash('sha1').update(m.u).digest('hex').slice(0, 12);
  const key = d + '/' + name;
  if (mediaDone[key]) return { name };
  const dl = dl0 || Date.now() + MEDIA_PREP_MS;
  const tmp = path.join(os.tmpdir(), name + '-' + crypto.randomBytes(3).toString('hex'));
  try {
    const r = await http(m.u, { redirect: 'follow' }, 60000, dl);
    if (!r.ok) throw new Error('media download ' + r.status);
    if (Number(r.headers.get('content-length') || 0) > MEDIA_MAX_BYTES) throw new Error('media file too large');
    const out = fs.createWriteStream(tmp + '.in');
    const reader = r.body.getReader();
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (got > MEDIA_MAX_BYTES) { reader.cancel().catch(() => {}); throw new Error('media file too large'); }
      if (!out.write(value)) await new Promise(res => out.once('drain', res));
    }
    await new Promise((res, rej) => out.end(e => (e ? rej(e) : res())));
    let buf;
    if (FFMPEG) {
      await execFileP(FFMPEG, ['-y', '-v', 'error', '-i', tmp + '.in', '-vn', '-t', String(MEDIA_MAX_SEC), '-ar', '8000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', tmp + '.wav'], { timeout: Math.max(5000, dl - Date.now()) });
      buf = fs.readFileSync(tmp + '.wav');
    } else {
      buf = fs.readFileSync(tmp + '.in'); // no ffmpeg: Yemot converts the upload itself (works for mp3 and wav)
    }
    await upload(name, buf, dl, d, 60000);
    mediaDone[key] = true;
    return { name };
  } finally {
    for (const x of ['.in', '.wav']) fs.rm(tmp + x, { force: true }, () => {});
  }
}
// ---------- songs and files found on the web: "search for new songs", then "play number 2" ----------
const FOUND_SEARCH_DECL = {
  name: 'search_media',
  description: 'Search the web for songs, audio or video files the user can listen to. Call ONLY when the user asked to find songs or files to listen to. Returns a numbered list of titles.',
  parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'A short search query in English, empty for just the newest or most popular' }, sort: { type: 'STRING', description: 'new for the newest songs, popular for the most listened to this week, or relevance (default)' } } }
};
const FOUND_PLAY_DECL = {
  name: 'play_found',
  description: 'Play one of the results of the last search_media to the caller. Call ONLY when the user asked to play one of them.',
  parameters: { type: 'OBJECT', properties: { number: { type: 'INTEGER', description: 'The number of the result in the list' } }, required: ['number'] }
};
async function groqText(system, user, deadline, ms) {
  let last = 'groq failed';
  for (let i = 0; i < GROQ_KEYS.length; i++) {
    const key = GROQ_KEYS[grot++ % GROQ_KEYS.length];
    try {
      const r = await http(GROQ_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          tools: [{ type: 'browser_search' }],
          tool_choice: 'required',
          reasoning_effort: 'low',
          max_completion_tokens: 1500,
          stream: false
        })
      }, ms || 30000, deadline);
      if (r.ok) {
        const j = await r.json();
        const m = ((j.choices || [])[0] || {}).message || {};
        const text = String(m.content || '').replace(/【[^】]*】/g, '').trim();
        if (text) return text;
        last = 'groq empty answer';
        continue;
      }
      last = 'groq ' + r.status + ' ' + (await r.text()).slice(0, 150);
      if (r.status === 400 || r.status === 401) break;
    } catch (e) {
      if (isBudget(e)) throw e;
      last = 'groq ' + (e.name === 'TimeoutError' ? 'timeout' : e.message);
    }
  }
  throw new Error(last);
}
const parseList = t => {
  const m = /\[[\s\S]*\]/.exec(String(t || ''));
  if (!m) return [];
  try { const a = JSON.parse(m[0]); return Array.isArray(a) ? a : []; } catch (e) { return []; }
};
const MEDIA_JSON_SYS = 'Search the web. Reply with ONLY a JSON array and no other text. Each item is an object {"title": string, "url": string}. ';
// the list the caller hears: titles only (a direct file link is kept when the search found one)
async function jamendoSearch(s, query, sort, deadline) {
  const u = new URL(JAMENDO_BASE + '/tracks/');
  u.searchParams.set('client_id', JAMENDO_ID);
  u.searchParams.set('format', 'json');
  u.searchParams.set('limit', '6');
  u.searchParams.set('audioformat', 'mp32');
  if (query) u.searchParams.set('search', query);
  const so = String(sort || '').toLowerCase();
  if (so === 'new') u.searchParams.set('order', 'releasedate_desc');
  else if (so === 'popular') u.searchParams.set('order', 'popularity_week');
  const r = await http(u.toString(), {}, 15000, deadline);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.headers || j.headers.status !== 'success') throw new Error('jamendo ' + r.status + ' ' + JSON.stringify(j.headers || {}).slice(0, 120));
  return (j.results || []).filter(x => x && x.audio).map(x => ({ title: (String(x.name || '') + (x.artist_name ? ' - ' + x.artist_name : '')).replace(/\s+/g, ' ').trim().slice(0, 100), url: String(x.audio), src: 'jamendo' })).filter(x => x.title);
}
async function searchMedia(s, query, deadline, sort) {
  query = String(query || '').trim().slice(0, 200);
  if (JAMENDO_ID) {
    try {
      s.found = await jamendoSearch(s, query, sort, deadline);
      if (s.found.length) return { results: s.found.map((x, i) => ({ number: i + 1, title: x.title })) };
      if (!GROQ_KEYS.length) return { error: 'nothing found' };
    } catch (e) {
      if (isBudget(e)) throw e;
      console.error('jamendo search failed:', String(e.message).slice(0, 150));
      if (!GROQ_KEYS.length) return { error: 'search unavailable' };
    }
  }
  if (!query || !GROQ_KEYS.length) return { error: 'search unavailable' };
  try {
    const t = await groqText(MEDIA_JSON_SYS + 'Return up to 6 results for the request. title = the song or file name (with the artist when known), in its original language. url = a direct link to an audio or video file (mp3, m4a, mp4, wav) when you found one, otherwise an empty string.', query, deadline, 35000);
    const items = parseList(t).map(x => ({ title: String((x && x.title) || '').replace(/\s+/g, ' ').trim().slice(0, 100), url: /^https?:\/\//i.test(String((x && x.url) || '')) ? String(x.url).trim() : '' })).filter(x => x.title);
    const seen = new Set();
    s.found = items.filter(x => !seen.has(x.title) && seen.add(x.title)).slice(0, 6);
    if (!s.found.length) return { error: 'nothing found' };
    return { results: s.found.map((x, i) => ({ number: i + 1, title: x.title })) };
  } catch (e) {
    if (isBudget(e)) throw e;
    console.error('media search failed:', String(e.message).slice(0, 150));
    return { error: 'search unavailable' };
  }
}
// direct file links for one title (second search, done only when the caller asked to play it)
async function findMediaUrls(title, deadline) {
  const t = await groqText(MEDIA_JSON_SYS + 'Find direct links to an audio or video file (mp3, m4a, mp4, wav) of the requested item. Return up to 4 items, title = the file name, url = the direct link to the file itself and not to a web page.', title, deadline, 35000);
  return parseList(t).map(x => String((x && x.url) || '').trim()).filter(u => /^https?:\/\//i.test(u)).slice(0, 4);
}
async function prepareFound(item, d) {
  const dl = Date.now() + MEDIA_PREP_MS + 40000;
  const tried = new Set();
  const attempt = async url => { tried.add(url); return prepareMedia({ n: item.title, u: url }, d, dl); };
  if (item.url) { try { return await attempt(item.url); } catch (e) { if (isBudget(e)) throw e; console.error('found file failed:', String(e.message).slice(0, 120)); } }
  if (item.src === 'jamendo' || !GROQ_KEYS.length) throw new Error('no playable file found');
  for (const u of await findMediaUrls(item.title, dl)) {
    if (tried.has(u)) continue;
    try { return await attempt(u); } catch (e) { if (isBudget(e)) throw e; console.error('found file failed:', String(e.message).slice(0, 120)); }
  }
  throw new Error('no playable file found');
}
function startFound(s, n) {
  const item = ((s && s.found) || [])[Number(n) - 1];
  if (!item) return { error: 'no such result' };
  s.mediaP = prepareFound(item, s.d).catch(e => { console.error('media failed:', String(e.message).slice(0, 150)); return { error: e.message }; });
  return { status: 'the file will be played right after your reply', title: item.title };
}

// the model asked to play a file: preparation starts at once and runs while the model writes its short reply
function startMedia(s, idx) {
  const m = MEDIA[Number(idx) - 1];
  if (!m || !s) return { error: 'no such file' };
  s.mediaP = prepareMedia(m, s.d).catch(e => { console.error('media failed:', String(e.message).slice(0, 150)); return { error: e.message }; });
  return { status: 'the file will be played right after your reply', file: m.n };
}
// message chain for the prepared file, or a spoken apology
async function takeMedia(s) {
  if (!s.mediaP) return '';
  const r = await s.mediaP;
  s.mediaP = null;
  return r && r.name ? 'f-' + s.d + '/' + r.name : 't-' + sp('לא הצלחתי להכין את הקובץ');
}

// asks the model; when it calls a tool (web_search or play_media) the tool is run and the result is sent back, up to 3 rounds
async function askModel(sys, contents, deadline, s) {
  const base = { systemInstruction: { parts: [{ text: sys }] } };
  const decls = [];
  if (HAS_SEARCH) decls.push(SEARCH_DECL);
  if (HAS_FOUND) decls.push(FOUND_SEARCH_DECL, FOUND_PLAY_DECL);
  if (HAS_MEDIA) decls.push(MEDIA_DECL);
  if (!decls.length) return textGen({ ...base, contents }, deadline);
  const tools = [{ functionDeclarations: decls }];
  for (let i = 0; i < 3; i++) {
    const a = await textGen({ ...base, contents, tools }, deadline);
    const cand = (a.candidates || [])[0] || {};
    const fcalls = ((cand.content || {}).parts || []).filter(p => p.functionCall);
    if (!fcalls.length) return a;
    const resp = [];
    for (const c of fcalls) {
      const args = c.functionCall.args || {};
      let out;
      if (c.functionCall.name === 'play_media') {
        console.log('media:', String(args.file));
        out = startMedia(s, args.file);
      } else if (c.functionCall.name === 'search_media') {
        console.log('media search:', String(args.query || '').slice(0, 80));
        out = await searchMedia(s, args.query, deadline, args.sort);
      } else if (c.functionCall.name === 'play_found') {
        console.log('play found:', String(args.number));
        out = startFound(s, args.number);
      } else {
        console.log('search:', String(args.query || '').slice(0, 80));
        if (s) { s.searching = true; if (s.onSearch) s.onSearch(); }
        out = await webSearch(args.query, args.site, deadline);
      }
      resp.push({ functionResponse: { name: c.functionCall.name, response: out } });
    }
    // the model turn is sent back unchanged, so its thought signatures stay attached
    contents = [...contents, cand.content, { role: 'user', parts: resp }];
  }
  return textGen({ ...base, contents }, deadline);
}

function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Gemini 3.8 TTS uses voiceConfig.voice; older TTS models use prebuiltVoiceConfig.voiceName
const isNewTts = m => /^gemini-(3\.[8-9]|[4-9])/.test(m);
const voicesFor = (model, name) => isNewTts(model)
  ? [{ voice: name }, { prebuiltVoiceConfig: { voiceName: name } }]
  : [{ prebuiltVoiceConfig: { voiceName: name } }, { voice: name }];
const vIdx = {};
const ttsDown = {};

// voices that the caller can switch between (override with VOICE_MALE / VOICE_FEMALE)
const VOICE_BY = { male: process.env.VOICE_MALE || 'Charon', female: process.env.VOICE_FEMALE || process.env.VOICE || 'Kore' };
// when the caller asked for short answers this is added at the end of the system instruction, so it wins over the length rules
const SHORT_NOTE = ' הנחיה מהמשתמש שגוברת על כל הנחיית אורך אחרת: ענה בקצרה, בשניים עד ארבעה משפטים ועד חמישים מילים, בלי הרחבות, עד שהמשתמש יבקש לחזור לתשובות מפורטות.';
const PACE_PREFIX = { slow: 'Say slowly and calmly: ', fast: 'Say quickly: ' };

// a typed question that starts with a clear length request: the server applies it and removes it from the question
const SHORT_RE = /^\s*(?:ת?קצר(?:י)? את התשוב(?:ה|ות)|תענה(?: יותר)? קצר|תענה בקצרה|בקצרה|בקיצור)\s*/;
const LONG_RE = /^\s*(?:תפרט|תרחיב|תאריך את התשוב(?:ה|ות)|תענה(?: יותר)? בהרחבה)\s*/;
// pulls [[VOICE:x]] / [[PACE:x]] / [[Q:transcript]] tags out of the model answer
function parseCtl(text) {
  const ctl = {};
  let q = '';
  const noQ = text.replace(/\[\[\s*Q\s*:([^\]]*)\]\]/gi, (m, v) => { if (!q) q = v.replace(/\s+/g, ' ').trim(); return ' '; });
  const clean = noQ.replace(/\[\[\s*(VOICE|PACE|LEN)\s*:\s*([a-z]+)\s*\]\]/gi, (m, k, v) => { ctl[k.toLowerCase()] = v.toLowerCase(); return ' '; });
  return { text: clean.replace(/\s+/g, ' ').trim(), ctl, q: q.slice(0, 500) };
}

// long answers are read in pieces, in parallel, and joined into one 8 kHz file
const TTS_CHUNK = 900;
function splitText(text) {
  const out = [];
  let cur = '';
  for (let sn of text.split(/(?<=[.!?:;])\s+/)) {
    while (sn.length > TTS_CHUNK) {
      let k = sn.lastIndexOf(' ', TTS_CHUNK);
      if (k < 200) k = TTS_CHUNK;
      if (cur) { out.push(cur); cur = ''; }
      out.push(sn.slice(0, k).trim());
      sn = sn.slice(k).trim();
    }
    if (!sn) continue;
    if (cur && cur.length + sn.length + 1 > TTS_CHUNK) { out.push(cur); cur = sn; }
    else cur = cur ? cur + ' ' + sn : sn;
  }
  if (cur) out.push(cur);
  return out.filter(Boolean);
}
function pcmOf(buf) {
  let p = 12, rate = 24000;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4), sz = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') rate = buf.readUInt32LE(p + 12);
    if (id === 'data') return { rate, pcm: buf.subarray(p + 8, Math.min(buf.length, p + 8 + sz)) };
    p += 8 + sz + (sz & 1);
  }
  return { rate, pcm: buf.subarray(44) };
}
function to8k(x) {
  const f = x.rate / 8000;
  if (f === 1 || !Number.isInteger(f)) return x;
  const n = Math.floor(x.pcm.length / 2 / f), out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < f; k++) sum += x.pcm.readInt16LE((i * f + k) * 2);
    out.writeInt16LE(Math.round(sum / f), i * 2);
  }
  return { rate: 8000, pcm: out };
}
async function tts(text, deadline, o) {
  const parts = splitText(String(text).slice(0, 7000));
  if (parts.length <= 1) return ttsOne(text, deadline, o);
  const bufs = await Promise.all(parts.map(x => ttsOne(x, deadline, o)));
  const gap = Buffer.alloc(3200); // 0.2 s of silence between the pieces
  const pcms = [];
  bufs.forEach((b, i) => { if (i) pcms.push(gap); pcms.push(to8k(pcmOf(b)).pcm); });
  return wav(Buffer.concat(pcms), 8000);
}

async function ttsOne(text, deadline, o) {
  o = o || {};
  const pre = PACE_PREFIX[o.pace] || '';
  let last = new Error('no audio from tts');
