import { useState, useEffect, useMemo, useRef, useCallback } from "react";

/* ------------------------------------------------------------------ *
 *  Euan — GRADE 7 PLANNER  ·  2026–2027
 *  Visual system borrowed from the report card itself: heavy black
 *  rules, condensed caps, the rotated LANGUAGE ARTS bracket.
 * ------------------------------------------------------------------ */

const SUBJECTS = [
  { id: "religion", name: "Religion",               code: "REL",   color: "#6D4AA6", teacher: "" },
  { id: "math",     name: "Mathematics",            code: "MATH",  color: "#C4442C", teacher: "Hill" },
  { id: "lit",      name: "Literature/Reading",     code: "LIT",   color: "#1B6E4F", teacher: "Kensic",    group: "LA" },
  { id: "english",  name: "English",                code: "ENG",   color: "#2A5CA8", teacher: "DeBrunner", group: "LA" },
  { id: "spelling", name: "Spelling/Vocabulary",    code: "SPELL", color: "#B0761A", teacher: "Kennedy",   group: "LA" },
  { id: "science",  name: "Science/Health",         code: "SCI",   color: "#0F7B84", teacher: "Murphy" },
  { id: "history",  name: "History/Social Science", code: "HIST",  color: "#8C3A5E", teacher: "Kennedy" },
];

const teacherOf = (s) => (s.teacher ? ` (${s.teacher})` : "");
const codeWithTeacher = (s) => `${s.code}${teacherOf(s)}`;

const TYPES = [
  { id: "assignment", label: "Assignment", mark: "\u25A0" },
  { id: "quiz",       label: "Quiz",       mark: "\u25B2" },
  { id: "test",       label: "Test",       mark: "\u2605" },
  { id: "project",    label: "Project",    mark: "\u25C6" },
];

const PEOPLE = ["Euan", "Mom", "Dad"];

const SUBJ = Object.fromEntries(SUBJECTS.map((s) => [s.id, s]));
const TYPE = Object.fromEntries(TYPES.map((t) => [t.id, t]));

/* Key left unchanged from the first version so nothing already
   entered is lost. It is internal and never shown. */
const STORAGE_KEY = "planner:arhand:g7:v1";

/* ------------------------- where data is saved ---------------------- *
 * Leave url blank  -> saves to the built-in shared storage (works here).
 * Set url          -> saves to planner.json on your own server.
 *                     See server.js and README-server.md.
 * -------------------------------------------------------------------- */
const REMOTE = {
  url: "auto",  // "auto" = /api/planner once deployed; built-in storage inside Claude
  token: "",    // leave blank and the app will ask for the passphrase if the server wants one
};

/* On Vercel the app and the API share an origin, so a relative path is
   all that's needed. Inside Claude there is no API, so fall back to the
   built-in shared storage. */
function remoteUrl() {
  if (REMOTE.url && REMOTE.url !== "auto") return REMOTE.url;
  if (typeof window === "undefined") return "";
  if (window.storage) return "";
  return "/api/planner";
}
const usingRemote = () => Boolean(remoteUrl());

let SESSION_KEY = REMOTE.token;                 // set by the passphrase prompt
const setSessionKey = (v) => { SESSION_KEY = v; };
const authHeaders = () => (SESSION_KEY ? { "X-Planner-Key": SESSION_KEY } : {});

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function describe(r) {
  try {
    const d = await r.json();
    if (d && d.error) return d.error;
  } catch (e) { /* not json */ }
  return `server returned ${r.status}`;
}

/* Everything is one document: the entries, plus a record of which days
   have been logged. Older saves were a bare array of items. */
const EMPTY_DOC = { items: [], logs: {} };

function normalise(v) {
  if (Array.isArray(v)) return { items: v, logs: {} };
  if (v && typeof v === "object") {
    return {
      items: Array.isArray(v.items) ? v.items : [],
      logs: v.logs && typeof v.logs === "object" ? v.logs : {},
    };
  }
  return { ...EMPTY_DOC };
}

async function remoteLoad() {
  const r = await fetch(remoteUrl(), { headers: authHeaders(), cache: "no-store" });
  if (!r.ok) throw httpError(r.status, await describe(r));
  const d = await r.json();
  return { rev: d.rev || 0, ...normalise(d) };
}

async function remoteSave(rev, doc) {
  const r = await fetch(remoteUrl(), {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ rev, items: doc.items, logs: doc.logs }),
  });
  if (r.status === 409) return { conflict: true };          // someone saved first
  if (!r.ok) throw httpError(r.status, await describe(r));
  const d = await r.json();
  return { rev: d.rev, conflict: false };
}

async function localLoad() {
  if (!window.storage) return null;
  try {
    const r = await window.storage.get(STORAGE_KEY, true);
    return normalise(r && r.value ? JSON.parse(r.value) : null);
  } catch (e) {
    return { ...EMPTY_DOC };
  }
}

async function localSave(doc) {
  await window.storage.set(STORAGE_KEY, JSON.stringify(doc), true);
}

/* ------------------------------ daily log --------------------------- *
 * A day is logged once every subject has been accounted for: either
 * explicitly marked "nothing announced", or carrying at least one entry
 * announced that day.
 * -------------------------------------------------------------------- */

const isSchoolDay = (k) => {
  const d = dowNum(k);
  if (d === 0 || d === 6) return false;
  if (!inSchoolYear(k)) return false;
  return !NO_SCHOOL[k];
};

const blankLog = () => ({ none: [], noSchool: false, by: "", updatedAt: "" });

function addressedOn(date, logs, items) {
  const set = new Set((logs[date] && logs[date].none) || []);
  for (const it of items) if (it.announced === date) set.add(it.subject);
  return set;
}

/* complete | partial | missing | noschool | none (nothing to show) */
function logStatus(date, logs, items, today) {
  const log = logs[date];
  if (NO_SCHOOL[date]) return "holiday";
  if (log && log.noSchool) return "noschool";
  const n = addressedOn(date, logs, items).size;
  if (n >= SUBJECTS.length) return "complete";
  if (n > 0) return "partial";
  if (date > today || !isSchoolDay(date)) return "none";
  return "missing";
}

/* Deliberately no check marks here. A tick means "homework finished"
   and nothing else in this app; the log uses a filled-in box instead. */
const LOG_MARK = { complete: "", partial: "\u00B7", missing: "!", noschool: "\u2013", holiday: "\u2013" };

const SYNC_TEXT = {
  loading: "Loading",
  saving: "Saving…",
  saved: "Saved",
  error: "Not saved",
  memory: "Not saving",
};

/* ---------------------------- date utils --------------------------- */

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["January","February","March","April","May","June","July",
  "August","September","October","November","December"];

const pad = (n) => String(n).padStart(2, "0");
const key = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const parseKey = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m: m - 1, d };
};
const todayKey = () => {
  const t = new Date();
  return key(t.getFullYear(), t.getMonth(), t.getDate());
};
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
const firstDow = (y, m) => new Date(y, m, 1).getDay();
const dowNum = (s) => {
  const { y, m, d } = parseKey(s);
  return new Date(y, m, d).getDay();
};
const addDays = (s, n) => {
  const { y, m, d } = parseKey(s);
  const t = new Date(y, m, d + n);
  return key(t.getFullYear(), t.getMonth(), t.getDate());
};
const weekStart = (s) => addDays(s, -dowNum(s));           // Sunday
const nextDow = (s, target) => {
  let n = 1;
  while (dowNum(addDays(s, n)) !== target) n++;
  return addDays(s, n);
};
const longDate = (s) => {
  const { y, m, d } = parseKey(s);
  return `${DOW[new Date(y, m, d).getDay()]}, ${MONTH_NAMES[m].slice(0, 3)} ${d}`;
};
const shortDate = (s) => {
  const { m, d } = parseKey(s);
  return `${MONTH_NAMES[m].slice(0, 3)} ${d}`;
};
/* Two different clocks. "Given" is how long the teacher allowed, fixed
   the moment it was announced. "Left" is how long is actually still
   there, counting down from today. */
function runway(it) {
  if (!it.announced || !it.due) return null;
  const n = daysBetween(it.announced, it.due);
  if (n < 0) return null;                       // due date moved earlier; nothing useful to say
  return {
    days: n,
    text: n === 0 ? "same day" : n === 1 ? "1 day given" : `${n} days given`,
    tight: n <= 1,
  };
}

function remaining(it, today) {
  if (!it.due || it.done) return null;          // finished work has no clock
  const n = daysBetween(today, it.due);
  if (n < 0) return { days: n, text: `${Math.abs(n)} ${Math.abs(n) === 1 ? "day" : "days"} overdue`, level: "late" };
  if (n === 0) return { days: 0, text: "due today", level: "late" };
  if (n === 1) return { days: 1, text: "due tomorrow", level: "soon" };
  return { days: n, text: `${n} days left`, level: "ok" };
}

const daysBetween = (a, b) => {
  const A = parseKey(a), B = parseKey(b);
  return Math.round((Date.UTC(B.y, B.m, B.d) - Date.UTC(A.y, A.m, A.d)) / 86400000);
};

/* ------------------- St. Gabriel School, SF 2026-27 ----------------- *
 * Taken from the printed school calendar. Days students don't attend,
 * and days that dismiss early. Edit these two tables if the school
 * changes anything mid-year — nothing else needs to change.
 * -------------------------------------------------------------------- */

const SCHOOL_FIRST_DAY = "2026-08-17";
const SCHOOL_LAST_DAY = "2027-06-04";

const NO_SCHOOL_SPANS = [
  ["2026-09-07", null,         "Labor Day"],
  ["2026-10-02", null,         "Teacher vacation day"],
  ["2026-10-12", null,         "Indigenous Peoples' Day"],
  ["2026-11-09", null,         "Veterans Day observed"],
  ["2026-11-23", "2026-11-27", "Thanksgiving"],
  ["2026-12-21", "2026-12-31", "Christmas holidays"],
  ["2027-01-01", "2027-01-03", "New Year's holiday"],
  ["2027-01-18", null,         "Martin Luther King Jr. Day"],
  ["2027-02-15", null,         "Presidents' Day"],
  ["2027-03-26", null,         "Good Friday"],
  ["2027-03-29", "2027-04-02", "Easter break"],
  ["2027-04-30", null,         "Pastor's Holiday"],
  ["2027-05-31", null,         "Memorial Day"],
];

/* Early dismissal — worth seeing when planning pickup. */
const SHORT_DAYS = {
  "2026-08-17": "First day · 12pm",
  "2026-08-18": "Minimum day · 12pm",
  "2026-09-14": "Educators PD Day · 12pm",
  "2026-09-28": "Minimum day · 12pm",
  "2026-10-06": "P-T conferences · 12pm",
  "2026-10-07": "P-T conferences · 12pm",
  "2026-10-08": "P-T conferences · 12pm",
  "2026-10-09": "Minimum day · 12pm",
  "2026-10-26": "Minimum day · 12pm",
  "2026-10-30": "Halloween · 12pm",
  "2026-11-20": "Minimum day · 12pm",
  "2026-12-18": "Minimum day · 12pm",
  "2027-01-25": "Educators PD Day · 12pm",
  "2027-02-22": "Minimum day · 12pm",
  "2027-02-25": "Spring P-T conferences · 12pm",
  "2027-02-26": "Spring P-T conferences · 12pm",
  "2027-03-15": "Educators PD Day · 12pm",
  "2027-03-25": "Holy Thursday · 12pm",
  "2027-04-26": "Minimum day · 12pm",
  "2027-05-24": "Minimum day · 12pm",
  "2027-06-02": "Minimum day · 12pm",
  "2027-06-03": "Minimum day · 12pm",
  "2027-06-04": "Last day · 10am",
};

/* School year window: August 2026 through the first week of June 2027 */
const SCHOOL_MONTHS = [
  [2026, 7], [2026, 8], [2026, 9], [2026, 10], [2026, 11],
  [2027, 0], [2027, 1], [2027, 2], [2027, 3], [2027, 4], [2027, 5],
];
const YEAR_START = "2026-08-01";
const YEAR_END = "2027-06-30";

const NO_SCHOOL = (() => {
  const map = {};
  for (const [from, to, label] of NO_SCHOOL_SPANS) {
    let k = from;
    const last = to || from;
    while (k <= last) { map[k] = label; k = addDays(k, 1); }
  }
  return map;
})();

const inSchoolYear = (k) => k >= SCHOOL_FIRST_DAY && k <= SCHOOL_LAST_DAY;

/* ------------------------------ ranges ----------------------------- */

const RANGE_IDS = ["tomorrow", "week", "four", "all"];

function rangeFor(id, today) {
  if (id === "tomorrow") {
    const t = addDays(today, 1);
    return { from: t, to: t, tab: "Tomorrow", title: "Due tomorrow", sub: longDate(t), empty: "Nothing due tomorrow." };
  }
  if (id === "week") {
    const s = weekStart(today), e = addDays(s, 6);
    return { from: s, to: e, tab: "This week", title: "This week", sub: `${longDate(s)} – ${longDate(e)}`, empty: "Nothing due the rest of this week." };
  }
  if (id === "four") {
    const e = addDays(today, 27);
    return { from: today, to: e, tab: "Next 4 weeks", title: "Next 4 weeks", sub: `${shortDate(today)} – ${shortDate(e)}`, empty: "Nothing due in the next four weeks." };
  }
  if (id === "overdue") {
    return { from: YEAR_START, to: addDays(today, -1), openOnly: true, tab: "Past due", title: "Past due", sub: "Not checked off yet", empty: "Nothing past due. All caught up." };
  }
  return { from: YEAR_START, to: YEAR_END, tab: "All", title: "All due dates", sub: "August 2026 – June 2027", empty: "Nothing on the calendar yet." };
}

const inRange = (it, r) => it.due >= r.from && it.due <= r.to && (!r.openOnly || !it.done);

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/* ------------------------------ styles ----------------------------- */

const CSS = `
.pl * { box-sizing: border-box; }
.pl {
  --paper:#E7E9EF; --card:#FFFFFF; --ink:#15151C; --muted:#6A6E7C;
  --rule:#15151C; --faint:#C9CDD8; --soft:#F4F5F8;
  font-family: Archivo, "Helvetica Neue", Arial, sans-serif;
  color: var(--ink); background: var(--paper);
  min-height: 100vh; -webkit-font-smoothing: antialiased;
}
.pl button { font: inherit; color: inherit; cursor: pointer; }
.pl :focus-visible { outline: 3px solid #2A5CA8; outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { .pl * { transition: none !important; } }

.serif { font-family: "Source Serif 4", Georgia, serif; }
.eyebrow { font-size: 10px; font-weight: 700; letter-spacing: .13em; text-transform: uppercase; color: var(--muted); }

/* ---- masthead ---- */
.mast {
  border-bottom: 3px solid var(--rule); background: var(--card);
  padding: 12px 18px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
}
.mast h1 { margin: 0; font-size: 20px; font-weight: 800; letter-spacing: -.02em; text-transform: uppercase; }
.mast .yr {
  font-size: 11px; font-weight: 700; letter-spacing: .1em; padding: 3px 8px;
  border: 2px solid var(--rule); text-transform: uppercase;
}
.mast .spacer { flex: 1 1 auto; }
.tally { display: flex; gap: 14px; align-items: flex-start; }
.tally button, .tally div { background: none; border: 0; padding: 0; text-align: left; }
.tally b { font-size: 19px; font-weight: 800; font-variant-numeric: tabular-nums; display: block; line-height: 1.1; }
.tally b em { font-style: normal; font-size: 14px; font-weight: 700; color: var(--muted); }
.tally span { display: block; }
.tally button:hover .eyebrow { color: var(--ink); text-decoration: underline; }
.sync { display: inline-flex; align-items: center; gap: 6px; font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.sync i { width: 8px; height: 8px; background: #1B6E4F; display: block; }
.sync[data-s="saving"] i { background: #B0761A; }
.sync[data-s="loading"] i { background: var(--faint); }
.sync[data-s="error"] i, .sync[data-s="memory"] i { background: #C4442C; }
.sync[data-s="error"], .sync[data-s="memory"] { color: #C4442C; }
/* ---- daily log ---- */
.pl .addbtn2 {
  background: var(--card); color: var(--ink); border: 2px solid var(--rule); padding: 8px 13px;
  font-weight: 700; font-size: 12px; letter-spacing: .06em; text-transform: uppercase;
}
.pl .addbtn2:hover { background: var(--soft); }
/* Green means one thing in this app: homework that is finished.
   A written log is not "done work", so it stays in plain ink. */
.pl .addbtn[data-done="true"] { background: var(--card); color: var(--ink); border: 2px solid var(--rule); }
.pl .addbtn[data-done="true"]:hover { background: var(--soft); }
.pl .addbtn[data-off="true"] { background: var(--card); color: var(--muted); border: 2px solid var(--faint); }
.pl .addbtn[data-off="true"]:hover { background: var(--soft); }

.lg {
  position: absolute; top: 3px; right: 3px; width: 15px; height: 15px;
  font-size: 9px; font-weight: 800; line-height: 1; display: grid; place-items: center;
  border: 1.5px solid var(--rule); background: var(--card); color: var(--ink);
}
.lg[data-st="complete"] { background: var(--ink); color: #fff; }
.lg[data-st="complete"]::after { content: ""; width: 5px; height: 5px; background: #fff; }
.lg[data-st="partial"] { border-style: dashed; }
.lg[data-st="missing"] { border-color: #C4442C; color: #C4442C; }
.lg[data-st="noschool"] { border-color: var(--faint); color: var(--faint); }
.cell .lg:hover { box-shadow: 0 0 0 2px var(--faint); }

.legend { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 10px 2px 0; font-size: 11px; color: var(--muted); font-weight: 600; }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.legend .lg { position: static; }
.legend .sw { width: 15px; height: 15px; display: block; border: 1.5px solid var(--faint); background: #D4D8E2; }
.legend .sb { width: 15px; height: 4px; display: block; background: #B0761A; }

.progress { flex: none; display: flex; align-items: center; gap: 9px; padding: 11px 14px; border-bottom: 2px solid var(--faint); flex-wrap: wrap; }
.bar { flex: 1 1 120px; height: 12px; border: 2px solid var(--rule); background: var(--card); min-width: 90px; }
.bar i { display: block; height: 100%; background: var(--ink); transition: width .2s ease; }
.bar[data-full="true"] i { background: var(--ink); }
.ptext { font-size: 11.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.logbody { border-top: 2px solid var(--faint); }
.logrow { border-bottom: 2px solid var(--rule); padding: 9px 12px 11px; position: relative; }
.logrow:last-child { border-bottom: 0; }
.logrow[data-state="open"] { background: #FCFBF4; }
.logrow[data-state="open"]::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: #B0761A; }
.logrow[data-state="none"] { opacity: .62; }
.logrow[data-state="items"]::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--c); }
.lhead { display: flex; align-items: center; gap: 7px; margin-bottom: 3px; }
.lname { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: -.01em; flex: 1 1 auto; line-height: 1.15; }
.lstate { font-size: 10px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); margin-bottom: 2px; }
.logrow[data-state="open"] .lstate { color: #8a5c10; }
.lacts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 7px; }
.lacts .opt { font-size: 11px; }
.pl .lacts .opt:disabled { opacity: .35; cursor: default; }
.logrow .row { padding: 6px 0; border-bottom: 0; }

.pl .addbtn {
  background: var(--ink); color: #fff; border: 0; padding: 10px 16px;
  font-weight: 700; font-size: 13px; letter-spacing: .06em; text-transform: uppercase;
}
.pl .addbtn:hover { background: #34343f; }

/* ---- shell ---- */
.shell { display: grid; grid-template-columns: 236px minmax(0,1fr) 340px; align-items: start; }
@media (max-width: 1140px) { .shell { grid-template-columns: minmax(0,1fr); } }

/* ---- report-card spine ---- */
.spine { border-right: 3px solid var(--rule); padding: 16px 14px 28px; }
@media (max-width: 1140px) { .spine { display: none; } }
.spine-hd { margin-bottom: 10px; }
.cardgrid { border: 2px solid var(--rule); background: var(--card); }
.subjrow { display: flex; align-items: stretch; background: var(--card); border-bottom: 2px solid var(--rule); position: relative; }
.cardgrid > .subjrow:last-child, .lagroup:last-child .subjrow:last-child { border-bottom: 0; }
.subjrow:hover { background: var(--soft); }
.subjrow[data-on="true"] { background: var(--soft); }
.subjrow[data-on="true"]::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 5px; background: var(--c); }
.subjmain { flex: 1 1 auto; min-width: 0; background: none; border: 0; text-align: left; padding: 7px 6px 8px 9px; }
.pl .subjadd { flex: none; width: 30px; background: none; border: 0; border-left: 1px solid var(--faint); font-size: 15px; font-weight: 800; color: var(--muted); line-height: 1; }
.pl .subjadd:hover { background: var(--ink); color: #fff; }
.subjrow .nm { font-size: 12.5px; font-weight: 700; text-transform: uppercase; letter-spacing: -.01em; line-height: 1.15; }
.nm em, .lname em { font-style: normal; font-weight: 600; color: var(--muted); text-transform: none; letter-spacing: 0; }
.subjrow .ct { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
.dotc { width: 8px; height: 8px; background: var(--c); flex: none; }
.subjrow .ct em { font-style: normal; font-size: 10.5px; font-weight: 600; letter-spacing: .06em; color: var(--muted); text-transform: uppercase; }

.lagroup { position: relative; }
.labracket {
  position: absolute; left: -32px; top: -2px; bottom: -2px; width: 32px;
  border: 3px solid var(--rule); border-right: 0; background: var(--card);
  display: grid; place-items: center;
}
.labracket span {
  writing-mode: vertical-rl; transform: rotate(180deg); text-align: center;
  font-size: 10.5px; font-weight: 800; letter-spacing: .16em; white-space: nowrap;
}
.spine-inset { padding-left: 32px; }

/* ---- mobile subject strip ---- */
.strip { display: none; gap: 6px; padding: 10px 12px; overflow-x: auto; border-bottom: 2px solid var(--rule); background: var(--card); }
@media (max-width: 1140px) { .strip { display: flex; } }
.pill {
  border: 2px solid var(--rule); background: var(--card); padding: 5px 9px; white-space: nowrap;
  font-size: 11px; font-weight: 700; letter-spacing: .06em; display: flex; align-items: center; gap: 6px;
}
.pill[data-on="true"] { background: var(--ink); color: #fff; }

/* ---- main ---- */
.main { padding: 16px 18px 40px; min-width: 0; }
.navbar { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
.pl .navbtn { border: 2px solid var(--rule); background: var(--card); width: 34px; height: 34px; font-weight: 800; line-height: 1; }
.navbtn:disabled { opacity: .28; cursor: default; }
.mtitle { font-size: 22px; font-weight: 800; text-transform: uppercase; letter-spacing: -.02em; }
.mtitle i { font-style: normal; font-weight: 400; color: var(--muted); }
.msub { font-size: 12px; font-weight: 600; color: var(--muted); margin: 0 0 12px; letter-spacing: .02em; }
.seg { display: flex; border: 2px solid var(--rule); max-width: 100%; overflow-x: auto; }
.seg button { background: var(--card); border: 0; padding: 6px 11px; font-size: 11px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; white-space: nowrap; display: flex; align-items: center; gap: 5px; }
.seg button + button { border-left: 2px solid var(--rule); }
.seg button[data-on="true"] { background: var(--ink); color: #fff; }
.seg b { font-variant-numeric: tabular-nums; font-weight: 800; opacity: .5; }
.seg button[data-on="true"] b { opacity: 1; }
.pl .ghost { border: 2px solid var(--rule); background: var(--card); padding: 6px 10px; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.ghost[data-on="true"] { background: var(--ink); color: #fff; }

/* ---- calendar ---- */
.cal { border: 3px solid var(--rule); background: var(--rule); display: grid; grid-template-columns: repeat(7, minmax(0,1fr)); gap: 2px; }
.dow { background: var(--ink); color: #fff; text-align: center; padding: 5px 0; font-size: 10px; font-weight: 700; letter-spacing: .12em; }
.cell { background: var(--card); min-height: 88px; border: 0; text-align: left; padding: 4px 4px 6px; display: flex; flex-direction: column; gap: 3px; position: relative; }
.cell[data-blank="true"] { background: #DDE0E8; cursor: default; }

/* Days already gone: the square recedes, but unfinished work must not.
   A past day still owing homework shows its count in red instead. */
.cell[data-past="true"] { background: #F0F1F5; }
.cell[data-past="true"] .dnum { color: #9C9FAA; }
.cell[data-past="true"] .cnt[data-kind="log"] b { color: #8A8D99; }
.cell[data-past="true"] .cnt[data-kind="due"]:not([data-clear="true"]) b,
.cell[data-past="true"] .cnt[data-kind="due"]:not([data-clear="true"]) { color: #C4442C; }

.cell[data-hol="true"] { background: #D4D8E2; }
.cell[data-hol="true"] .dnum { color: #7E828F; }
.cell[data-off="true"] { background: #E0E3EA; }
.cell[data-off="true"] .dnum { color: #9498A4; }
.holname {
  font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .02em;
  color: #5C6070; line-height: 1.15; padding: 1px 3px; overflow-wrap: anywhere;
}
.cell[data-short="true"]::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: #B0761A;
}
.shortnote {
  display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: .05em;
  text-transform: uppercase; color: #8a5c10; border-bottom: 2px solid #B0761A; padding-bottom: 1px;
}
.holnote {
  display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .05em;
  text-transform: uppercase; color: var(--muted);
}
/* Today: the one warm square on a cool page. */
.cell[data-today="true"] { background: #FFF2CE; box-shadow: inset 0 0 0 2px var(--ink); }

.cell:hover:not([data-blank="true"]) { box-shadow: inset 0 0 0 3px var(--faint); }
.cell[data-today="true"]:hover { box-shadow: inset 0 0 0 3px var(--ink); }
.cell[data-sel="true"] { box-shadow: inset 0 0 0 3px var(--ink); }

.cell .dnum { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; padding: 2px 2px 0; }
.cell[data-weekend="true"] .dnum { color: var(--muted); }
.cell[data-today="true"] .dnum {
  background: var(--ink); color: #fff; padding: 4px 7px; font-size: 19px; font-weight: 800;
  align-self: flex-start; letter-spacing: -.02em;
}
.counts { display: flex; flex-direction: column; gap: 3px; padding: 4px 4px 0; min-width: 0; }
.cnt {
  display: flex; align-items: baseline; gap: 5px; min-width: 0;
  font-size: 9px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--muted);
}
.cnt b {
  font-size: 17px; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums;
  color: var(--ink); min-width: 11px;
}
.cnt[data-kind="log"] b { font-size: 13px; color: var(--muted); }
.cnt[data-kind="due"][data-clear="true"] b { color: #1B6E4F; }
.cnt[data-kind="due"][data-clear="true"] { color: #1B6E4F; }

@media (max-width: 720px) {
  .cell { min-height: 66px; }
  .cell .dnum { font-size: 13px; }
  .cell[data-today="true"] .dnum { font-size: 15px; padding: 3px 5px; }
  .counts { gap: 1px; padding: 2px 3px 0; }
  .cnt { font-size: 0; gap: 2px; }
  .cnt::after { font-size: 8px; letter-spacing: .04em; }
  .cnt[data-kind="due"]::after { content: "DUE"; }
  .cnt[data-kind="log"]::after { content: "LOG"; }
  .cnt b { font-size: 13px; }
  .cnt[data-kind="log"] b { font-size: 11px; }
  .mtitle { font-size: 17px; }
}

/* ---- list ---- */
.listwrap { border: 3px solid var(--rule); background: var(--card); }
.daygroup { border-bottom: 2px solid var(--rule); }
.daygroup:last-child { border-bottom: 0; }
.daygroup > h4 {
  margin: 0; padding: 6px 12px; background: var(--soft); border-bottom: 1px solid var(--faint);
  font-size: 11px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase;
  display: flex; justify-content: space-between; gap: 10px;
}
.daygroup > h4 u { text-decoration: none; font-weight: 600; color: var(--muted); }
.daygroup > h4[data-late="true"] { background: #FBE9E6; }
.blank { padding: 26px 16px; margin: 0; color: var(--muted); font-size: 14px; line-height: 1.5; }

/* ---- item row ---- */
.row { display: flex; gap: 9px; align-items: flex-start; padding: 9px 12px; border-bottom: 1px solid var(--faint); }
.row:last-child { border-bottom: 0; }
.row[data-done="true"] .ttl { text-decoration: line-through; color: var(--muted); }
.check { width: 19px; height: 19px; flex: none; border: 2px solid var(--rule); background: var(--card); margin-top: 2px; font-size: 12px; line-height: 1; font-weight: 800; display: grid; place-items: center; }
.check[data-on="true"] { background: #1B6E4F; border-color: #1B6E4F; color: #fff; }
.row .body { flex: 1 1 auto; min-width: 0; }
.row .ttl { font-size: 14.5px; font-weight: 600; line-height: 1.3; word-break: break-word; }
.tags { display: flex; align-items: center; gap: 7px; margin-top: 3px; flex-wrap: wrap; }
.stag { font-size: 9.5px; font-weight: 800; letter-spacing: .08em; padding: 2px 5px; color: #fff; background: var(--c); }
.ttag { font-size: 9.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.note { font-size: 13px; line-height: 1.5; margin-top: 5px; color: #33333d; white-space: pre-wrap; word-break: break-word; }
.pl .mkbox { width: 19px; height: 19px; flex: none; margin-top: 2px; display: grid; place-items: center; font-size: 10px; color: var(--c); }
.donetag { color: #1B6E4F; font-weight: 800; }
.logtag, .runtag, .lefttag { white-space: nowrap; }
.runtag[data-tight="true"] { color: #C4442C; font-weight: 800; }
.lefttag[data-level="late"] { color: #C4442C; font-weight: 800; }
.lefttag[data-level="soon"] { color: #8a5c10; font-weight: 800; }
.explain {
  margin: 0; padding: 9px 14px; border-bottom: 2px solid var(--faint); background: #F7F8FB;
  font-size: 11.5px; line-height: 1.5; color: #44485A;
}
.explain b { font-weight: 800; }
.railsub { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 9px 12px 4px; flex-wrap: wrap; }
.railsub .hint { font-size: 10.5px; color: var(--muted); font-weight: 600; }
.mini { border: 0; background: none; padding: 2px 4px; font-size: 10px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); }
.pl .mini:hover { color: var(--ink); text-decoration: underline; }

/* ---- day rail ---- */
.rail {
  border-left: 3px solid var(--rule); background: var(--card);
  height: calc(100vh - 60px); position: sticky; top: 0;
  display: flex; flex-direction: column; overflow: hidden;
}
.railhd { padding: 14px 14px 12px; border-bottom: 2px solid var(--rule); position: relative; flex: none; }
.raildays { display: flex; gap: 5px; margin-top: 9px; }
.raildays .navbtn { width: 28px; height: 26px; font-size: 12px; }

.railtabs { display: flex; flex: none; border-bottom: 3px solid var(--rule); }
.railtabs button {
  flex: 1 1 50%; background: var(--soft); border: 0; padding: 9px 6px;
  font-size: 11.5px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase;
  display: flex; align-items: center; justify-content: center; gap: 6px; color: var(--muted);
  border-bottom: 3px solid transparent; margin-bottom: -3px;
}
.railtabs button + button { border-left: 2px solid var(--rule); }
.railtabs button[data-on="true"] { background: var(--card); color: var(--ink); border-bottom-color: var(--card); }
.railtabs button:hover { color: var(--ink); }
.railtabs b { font-variant-numeric: tabular-nums; font-weight: 800; font-size: 12px; opacity: .6; }
.railtabs button[data-on="true"] b { opacity: 1; }

.railpane { flex: 1 1 auto; overflow-y: auto; padding-bottom: 26px; }
.railby { padding: 12px 14px 0; }
.futurenote { margin: 10px 14px 0; font-size: 11.5px; line-height: 1.5; color: var(--muted); }
.railby .opts { margin-top: 6px; }
.pl .railprimary { background: var(--ink); color: #fff; border-style: solid; }
.pl .railprimary:hover { background: #34343f; }
.railhd h3 { margin: 2px 0 0; font-size: 19px; font-weight: 800; text-transform: uppercase; letter-spacing: -.02em; }
.railclose { display: none; }
.rail .empty { padding: 22px 14px; color: var(--muted); font-size: 13.5px; line-height: 1.5; margin: 0; }
.pl .railadd { margin: 12px 14px 0; width: calc(100% - 28px); border: 2px dashed var(--rule); background: var(--card); padding: 9px; font-size: 11.5px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
.railadd:hover { background: var(--soft); }
@media (max-width: 1140px) {
  .rail {
    position: fixed; left: 0; right: 0; bottom: 0; top: auto; z-index: 40;
    height: auto; max-height: 82vh; overflow: hidden; border-left: 0; border-top: 3px solid var(--rule);
    transform: translateY(102%); transition: transform .22s ease; box-shadow: 0 -8px 26px rgba(0,0,0,.18);
  }
  .railpane { max-height: 56vh; }
  .rail[data-open="true"] { transform: none; }
  .railclose { display: block; position: absolute; right: 10px; top: 12px; border: 2px solid var(--rule); background: var(--card); width: 30px; height: 30px; font-weight: 800; }
}

/* ---- modal ---- */
.scrim { position: fixed; inset: 0; background: rgba(15,15,22,.55); z-index: 60; display: grid; place-items: center; padding: 16px; overflow-y: auto; }
.modal { background: var(--card); border: 3px solid var(--rule); width: 100%; max-width: 470px; box-shadow: 10px 10px 0 rgba(21,21,28,.22); }
.modal header { border-bottom: 3px solid var(--rule); padding: 12px 14px; display: flex; justify-content: space-between; align-items: center; }
.modal header h3 { margin: 0; font-size: 15px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; }
.modal .bd { padding: 14px; display: flex; flex-direction: column; gap: 13px; }
.step { display: flex; align-items: baseline; gap: 7px; margin-bottom: 5px; }
.step u { text-decoration: none; font-size: 9px; font-weight: 800; letter-spacing: .08em; background: var(--ink); color: #fff; padding: 2px 5px; }
.pl input[type="text"], .pl input[type="date"], .pl textarea {
  width: 100%; border: 2px solid var(--rule); background: var(--card); padding: 8px 9px;
  font-family: inherit; font-size: 14px; color: var(--ink); border-radius: 0;
}
.pl textarea { font-family: "Source Serif 4", Georgia, serif; resize: vertical; min-height: 70px; line-height: 1.5; }
.opts { display: flex; flex-wrap: wrap; gap: 6px; }
.opt { border: 2px solid var(--rule); background: var(--card); padding: 6px 9px; font-size: 11.5px; font-weight: 700; letter-spacing: .04em; display: flex; align-items: center; gap: 5px; }
.opt[data-on="true"] { background: var(--ink); color: #fff; }
.opt[data-on="true"] .dotc { box-shadow: 0 0 0 1.5px #fff; }
.quick { display: flex; gap: 6px; margin-top: 7px; flex-wrap: wrap; }
.pl .quick button { border: 2px dashed var(--rule); background: var(--card); padding: 5px 8px; font-size: 11px; font-weight: 700; letter-spacing: .04em; }
.quick button:hover { background: var(--soft); }
.modal footer { border-top: 3px solid var(--rule); padding: 11px 14px; display: flex; gap: 9px; align-items: center; }
.pl .save { flex: 1 1 auto; background: var(--ink); color: #fff; border: 0; padding: 11px; font-weight: 800; font-size: 12.5px; letter-spacing: .08em; text-transform: uppercase; }
.pl .cancel { border: 2px solid var(--rule); background: var(--card); padding: 10px 13px; font-weight: 700; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; }
.pl .del { border: 2px solid #C4442C; color: #C4442C; background: var(--card); padding: 10px 12px; font-weight: 700; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; }
.err { color: #C4442C; font-size: 12px; font-weight: 700; }

.foot { padding: 18px; font-size: 11.5px; color: var(--muted); line-height: 1.6; border-top: 2px solid var(--faint); display: flex; gap: 14px; flex-wrap: wrap; align-items: center; }
.keybar { display: flex; gap: 9px; align-items: center; flex-wrap: wrap; }
.pl .keybar input[type="password"] {
  width: auto; flex: 0 1 200px; border: 2px solid var(--rule); background: var(--card);
  padding: 6px 8px; font-family: inherit; font-size: 13px; border-radius: 0; color: var(--ink);
}
.banner { background: #FBE9E6; border-bottom: 2px solid var(--rule); padding: 8px 16px; font-size: 12px; font-weight: 600; }
`;

/* ---------------------------- component ---------------------------- */

export default function Planner() {
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [problem, setProblem] = useState("");
  const [view, setView] = useState("month");       // "month" | a range id
  const [monthIx, setMonthIx] = useState(() => {
    const t = new Date();
    const ix = SCHOOL_MONTHS.findIndex(([y, m]) => y === t.getFullYear() && m === t.getMonth());
    return ix < 0 ? 0 : ix;
  });
  const [selected, setSelected] = useState(() => todayKey());
  const [railOpen, setRailOpen] = useState(false);
  const [filter, setFilter] = useState([]);
  const [hideDone, setHideDone] = useState(false);
  const [editing, setEditing] = useState(null);
  const [rev, setRev] = useState(0);
  const [sync, setSync] = useState("loading");
  const [needKey, setNeedKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [logs, setLogs] = useState({});
  const [railTab, setRailTab] = useState("due");  // "due" | "log"
  const [logBy, setLogBy] = useState(PEOPLE[0]);
  const itemsRef = useRef([]);
  itemsRef.current = items;
  const logsRef = useRef({});
  logsRef.current = logs;
  const revRef = useRef(0);
  revRef.current = rev;
  const fileRef = useRef(null);

  const today = todayKey();

  useEffect(() => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap";
    document.head.appendChild(l);
    return () => { try { document.head.removeChild(l); } catch (e) {} };
  }, []);

  /* ---- saving: your server if configured, shared storage otherwise ---- */
  const refresh = useCallback(async () => {
    if (usingRemote()) {
      try {
        const d = await remoteLoad();
        setItems(d.items); setLogs(d.logs); setRev(d.rev); setSync("saved"); setProblem("");
      } catch (e) {
        setSync("error");
        if (e.status === 401) { setNeedKey(true); setProblem(""); }
        else if (e.status === 404) setProblem(`No planner API at ${remoteUrl()}. The serverless function isn't deployed — open /api/health to check. Nothing is being saved until it responds.`);
        else if (e.status === 503) setProblem(`${e.message} Nothing is being saved until then.`);
        else setProblem(`Can't reach the planner server (${e.message}). Nothing you type will be saved until it responds.`);
      }
    } else {
      const v = await localLoad();
      if (v) { setItems(v.items); setLogs(v.logs); setSync("saved"); }
      else { setSync("memory"); setProblem("Nothing is being saved here — entries disappear when this page closes."); }
    }
    setLoaded(true);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // With a server, pick up what the others entered without a reload.
  useEffect(() => {
    if (!usingRemote()) return;
    const t = setInterval(async () => {
      if (document.hidden) return;
      try {
        const d = await remoteLoad();
        if (d.rev !== revRef.current) { setItems(d.items); setLogs(d.logs); setRev(d.rev); }
      } catch (e) { /* keep showing what we have */ }
    }, 20000);
    return () => clearInterval(t);
  }, []);

  const commit = useCallback(async (mutate) => {
    setProblem(""); setSync("saving");

    if (usingRemote()) {
      try {
        let base = await remoteLoad();
        let next = mutate(base);
        let res = await remoteSave(base.rev, next);
        if (res.conflict) {                    // someone saved between our read and write
          base = await remoteLoad();
          next = mutate(base);
          res = await remoteSave(base.rev, next);
        }
        if (res.conflict) throw new Error("two people saved at once");
        setItems(next.items); setLogs(next.logs); setRev(res.rev); setSync("saved");
      } catch (e) {
        setSync("error");
        if (e.status === 401) { setNeedKey(true); setProblem(""); }
        else setProblem(`That change was not saved (${e.message}). Try again.`);
      }
      return;
    }

    const latest = (await localLoad()) || { items: itemsRef.current, logs: logsRef.current };
    const next = mutate(latest);
    setItems(next.items); setLogs(next.logs);
    if (!window.storage) {
      setSync("memory");
      setProblem("Nothing is being saved here — entries disappear when this page closes.");
      return;
    }
    try { await localSave(next); setSync("saved"); }
    catch (e) { setSync("error"); setProblem("That change was not saved. Check your connection and try again."); }
  }, []);

  const unlock = () => {
    if (!keyInput.trim()) return;
    setSessionKey(keyInput.trim());
    setKeyInput("");
    setNeedKey(false);
    setSync("loading");
    refresh();
  };

  /* ---- backup file in and out ---- */
  const exportBackup = () => {
    const blob = new Blob([JSON.stringify({ rev, items, logs }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Euan-planner-${todayKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const importBackup = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const raw = JSON.parse(await f.text());
      const incoming = Array.isArray(raw) ? raw : raw.items;
      if (!Array.isArray(incoming)) throw new Error("no items in that file");
      const incomingLogs = (raw && raw.logs && typeof raw.logs === "object") ? raw.logs : {};
      let added = 0;
      await commit((doc) => {
        const have = new Set(doc.items.map((i) => i.id));
        const fresh = incoming.filter((i) => i && i.id && i.title && i.due && !have.has(i.id));
        added = fresh.length;
        return {
          items: [...doc.items, ...fresh],
          logs: { ...incomingLogs, ...doc.logs },   // what is already here wins
        };
      });
      setProblem(added ? `Added ${added} item${added === 1 ? "" : "s"} from the backup.` : "Everything in that file was already here.");
    } catch (err) {
      setProblem(`That file could not be read (${err.message}).`);
    }
  };

  /* ---- derived ---- */
  // Subject filter only. Counting uses this, so hiding finished work
  // never changes the denominators.
  const inScope = useMemo(
    () => items.filter((i) => filter.length === 0 || filter.includes(i.subject)),
    [items, filter]
  );

  const visible = useMemo(
    () => (hideDone ? inScope.filter((i) => !i.done) : inScope),
    [inScope, hideDone]
  );

  const byDate = useMemo(() => {
    const m = {};
    for (const i of visible) (m[i.due] = m[i.due] || []).push(i);
    for (const k of Object.keys(m)) {
      m[k].sort((a, b) => SUBJECTS.findIndex((s) => s.id === a.subject) - SUBJECTS.findIndex((s) => s.id === b.subject));
    }
    return m;
  }, [visible]);

  // How many entries were written down on each day (as opposed to due).
  const loggedByDate = useMemo(() => {
    const m = {};
    for (const i of visible) if (i.announced) m[i.announced] = (m[i.announced] || 0) + 1;
    return m;
  }, [visible]);

  const openCounts = useMemo(() => {
    const c = {};
    for (const i of items) if (!i.done && i.due >= today) c[i.subject] = (c[i.subject] || 0) + 1;
    return c;
  }, [items, today]);

  // finished / total, so a completed assignment still shows up.
  const rangeCounts = useMemo(() => {
    const c = {};
    for (const id of RANGE_IDS) {
      const r = rangeFor(id, today);
      const inR = inScope.filter((i) => inRange(i, r));
      c[id] = { done: inR.filter((i) => i.done).length, total: inR.length };
    }
    return c;
  }, [inScope, today]);

  const ratio = (id) => rangeCounts[id] || { done: 0, total: 0 };

  const todayDone = useMemo(() => addressedOn(today, logs, items).size, [logs, items, today]);
  const todayStatus = useMemo(() => logStatus(today, logs, items, today), [logs, items, today]);

  // School days in the last month that were never logged.
  const missedDays = useMemo(() => {
    const out = [];
    for (let n = 1; n <= 30; n++) {
      const k = addDays(today, -n);
      if (k < YEAR_START) break;
      if (!isSchoolDay(k)) continue;
      if (logStatus(k, logs, items, today) === "missing") out.push(k);
    }
    return out.reverse();
  }, [logs, items, today]);

  const overdue = useMemo(() => inScope.filter((i) => !i.done && i.due < today).length, [inScope, today]);

  /* ---- actions ---- */
  const openNew = (subject, due, announced, by) =>
    setEditing({
      id: null, subject: subject || SUBJECTS[0].id, type: "assignment",
      title: "", due: due || "", details: "",
      addedBy: by || PEOPLE[0], done: false,
      announced: announced || today,
    });

  const openEdit = (it) => setEditing({ ...it });

  const saveDraft = (draft) => {
    // Something was announced, so that subject can't also be "nothing".
    const unmarkNone = (lg) => {
      const cur = lg[draft.announced];
      if (!cur || !cur.none || !cur.none.includes(draft.subject)) return lg;
      return { ...lg, [draft.announced]: { ...cur, none: cur.none.filter((x) => x !== draft.subject) } };
    };
    if (draft.id) {
      commit((doc) => ({ items: doc.items.map((i) => (i.id === draft.id ? { ...i, ...draft } : i)), logs: unmarkNone(doc.logs) }));
    } else {
      commit((doc) => ({
        items: [...doc.items, { ...draft, id: uid(), createdAt: new Date().toISOString() }],
        logs: unmarkNone(doc.logs),
      }));
    }
    setSelected(draft.due);
    const { m, y } = parseKey(draft.due);
    const ix = SCHOOL_MONTHS.findIndex(([yy, mm]) => yy === y && mm === m);
    if (ix >= 0) setMonthIx(ix);
    setEditing(null);
  };
  const removeItem = (id) => {
    commit((doc) => ({ ...doc, items: doc.items.filter((i) => i.id !== id) }));
    setEditing(null);
  };
  const toggleDone = (it) =>
    commit((doc) => ({ ...doc, items: doc.items.map((i) => (i.id === it.id ? { ...i, done: !i.done } : i)) }));

  /* ---- daily log actions ---- */
  const writeLog = (date, fn) => {
    if (date > today) return;          // a day cannot be logged before it happens
    return commit((doc) => {
      const cur = { ...blankLog(), ...(doc.logs[date] || {}) };
      const next = { ...fn(cur), updatedAt: new Date().toISOString(), by: logBy };
      return { ...doc, logs: { ...doc.logs, [date]: next } };
    });
  };

  const setNothing = (date, subjectId, on) =>
    writeLog(date, (lg) => ({
      ...lg,
      none: on ? [...new Set([...lg.none, subjectId])] : lg.none.filter((x) => x !== subjectId),
    }));

  const setNoSchool = (date, on) => writeLog(date, (lg) => ({ ...lg, noSchool: on }));

  const markRestNothing = (date) => {
    const done = addressedOn(date, logsRef.current, itemsRef.current);
    const rest = SUBJECTS.filter((s) => !done.has(s.id)).map((s) => s.id);
    if (!rest.length) return;
    writeLog(date, (lg) => ({ ...lg, none: [...new Set([...lg.none, ...rest])] }));
  };

  const pickDay = (k) => { setSelected(k); setRailOpen(true); };
  const openLog = (k) => {
    setSelected(k);
    setRailTab(k > today ? "due" : "log");
    setRailOpen(true);
  };
  const toggleSubject = (id) => setFilter((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));

  const [y, m] = SCHOOL_MONTHS[monthIx];
  const range = view === "month" ? null : rangeFor(view, today);
  const rangeItems = range ? visible.filter((i) => inRange(i, range)) : [];

  return (
    <div className="pl">
      <style>{CSS}</style>

      <div className="mast">
        <h1>Euan &middot; Grade 7 Planner</h1>
        <span className="yr">2026&ndash;2027</span>
        <span className="sync" data-s={sync} title={usingRemote() ? remoteUrl() : "Shared planner storage"}>
          <i /> {SYNC_TEXT[sync]}
        </span>
        <div className="spacer" />
        <div className="tally">
          <button onClick={() => setView("tomorrow")}
            title={`${ratio("tomorrow").done} of ${ratio("tomorrow").total} finished`}>
            <b>{ratio("tomorrow").done}<em>/{ratio("tomorrow").total}</em></b>
            <span className="eyebrow">Tomorrow</span>
          </button>
          <button onClick={() => setView("week")}
            title={`${ratio("week").done} of ${ratio("week").total} finished`}>
            <b>{ratio("week").done}<em>/{ratio("week").total}</em></b>
            <span className="eyebrow">This week</span>
          </button>
          <button onClick={() => setView("four")}
            title={`${ratio("four").done} of ${ratio("four").total} finished`}>
            <b>{ratio("four").done}<em>/{ratio("four").total}</em></b>
            <span className="eyebrow">4 weeks</span>
          </button>
          <button onClick={() => setView("overdue")}>
            <b style={{ color: overdue ? "#C4442C" : undefined }}>{overdue}</b>
            <span className="eyebrow">Past due</span>
          </button>
          <button onClick={() => missedDays.length && openLog(missedDays[0])}
            title={missedDays.length ? `Oldest: ${longDate(missedDays[0])}` : "Every school day written up"}>
            <b style={{ color: missedDays.length ? "#C4442C" : undefined }}>{missedDays.length}</b>
            <span className="eyebrow">Logs to write</span>
          </button>
        </div>
        <button className="addbtn" onClick={() => openLog(today)}
          data-done={todayStatus === "complete"} data-off={todayStatus === "holiday" || todayStatus === "noschool"}>
          {todayStatus === "holiday"
            ? `No school \u00B7 ${NO_SCHOOL[today]}`
            : todayStatus === "complete"
              ? "Today's log is written"
              : todayStatus === "noschool"
                ? "No school today"
                : `Write today's log \u00B7 ${todayDone}/${SUBJECTS.length}`}
        </button>
        <button className="addbtn2" onClick={() => openNew()}>+ Add item</button>
      </div>

      {needKey && (
        <div className="banner keybar">
          <span>This planner is locked. Enter the passphrase to load it.</span>
          <input type="password" value={keyInput} placeholder="Passphrase"
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") unlock(); }} />
          <button className="cancel" onClick={unlock}>Unlock</button>
        </div>
      )}

      {problem && <div className="banner">{problem}</div>}

      <div className="strip">
        <button className="pill" data-on={filter.length === 0} onClick={() => setFilter([])}>All subjects</button>
        {SUBJECTS.map((s) => (
          <button key={s.id} className="pill" data-on={filter.includes(s.id)} onClick={() => toggleSubject(s.id)}>
            <i className="dotc" style={{ "--c": s.color }} />{codeWithTeacher(s)}
          </button>
        ))}
      </div>

      <div className="shell">
        <Spine
          subjects={SUBJECTS} counts={openCounts} filter={filter}
          onToggle={toggleSubject} onClear={() => setFilter([])} onAdd={(id) => openNew(id)}
        />

        <div className="main">
          <div className="navbar">
            {view === "month" && (
              <>
                <button className="navbtn" onClick={() => setMonthIx((i) => i - 1)} disabled={monthIx === 0} aria-label="Previous month">&larr;</button>
                <button className="navbtn" onClick={() => setMonthIx((i) => i + 1)} disabled={monthIx === SCHOOL_MONTHS.length - 1} aria-label="Next month">&rarr;</button>
              </>
            )}
            <div className="mtitle">
              {view === "month" ? <>{MONTH_NAMES[m]} <i>{y}</i></> : range.title}
            </div>
            <div style={{ flex: "1 1 auto" }} />
            <button className="ghost" data-on={hideDone} aria-pressed={hideDone}
              onClick={() => setHideDone((v) => !v)}>
              {hideDone ? "Show finished" : "Hide finished"}
            </button>
          </div>

          <div className="navbar">
            <div className="seg">
              <button data-on={view === "month"} onClick={() => setView("month")}>Month</button>
              {RANGE_IDS.map((id) => (
                <button key={id} data-on={view === id} onClick={() => setView(id)}
                  title={`${ratio(id).done} of ${ratio(id).total} finished`}>
                  {rangeFor(id, today).tab}<b>{ratio(id).done}/{ratio(id).total}</b>
                </button>
              ))}
            </div>
          </div>

          <p className="msub">
            {view === "month"
              ? `Click any day to see what's due. Tick a box when homework is finished.`
              : view === "overdue"
                ? range.sub
                : `${range.sub} \u00B7 ${ratio(view).done} of ${ratio(view).total} finished`}
          </p>

          {!loaded ? (
            <div className="listwrap"><p className="blank">Opening the planner&hellip;</p></div>
          ) : view === "month" ? (
            <MonthGrid y={y} m={m} byDate={byDate} today={today} selected={selected}
              onPick={pickDay} logs={logs} allItems={items} onOpenLog={openLog}
              loggedByDate={loggedByDate} />
          ) : (
            <RangeList
              items={rangeItems} today={today} empty={range.empty}
              onToggle={toggleDone} onEdit={openEdit} onAdd={() => openNew()}
            />
          )}

          {view === "month" && (
            <div className="legend">
              <span className="eyebrow">Daily log</span>
              <span><i className="lg" data-st="complete">{LOG_MARK.complete}</i> written</span>
              <span><i className="lg" data-st="partial">{LOG_MARK.partial}</i> half written</span>
              <span><i className="lg" data-st="missing">{LOG_MARK.missing}</i> not written</span>
              <span><i className="lg" data-st="noschool">{LOG_MARK.noschool}</i> marked no school</span>
              <span><i className="sw" /> school holiday</span>
              <span><i className="sb" /> early dismissal</span>
            </div>
          )}

          <div className="foot">
            <span>
              {usingRemote()
                ? "Saved to your server. Everyone who opens this planner sees and edits the same list."
                : "Saved in shared planner storage. Everyone who opens this planner sees and edits the same list."}
            </span>
            <button className="mini" onClick={refresh}>Refresh</button>
            <button className="mini" onClick={exportBackup}>Export backup</button>
            <button className="mini" onClick={() => fileRef.current && fileRef.current.click()}>Import backup</button>
            <input ref={fileRef} type="file" accept="application/json,.json"
              style={{ display: "none" }} onChange={importBackup} />
          </div>
        </div>

        <DayRail
          open={railOpen} date={selected} dueItems={selected ? byDate[selected] || [] : []}
          logs={logs} allItems={items} today={today}
          tab={railTab} setTab={setRailTab} by={logBy} setBy={setLogBy}
          onClose={() => setRailOpen(false)}
          onGo={(d) => setSelected(d)}
          onToggle={toggleDone} onEdit={openEdit}
          onAddDue={() => openNew(null, selected)}
          onAddLog={(subjectId) => openNew(subjectId, "", selected, logBy)}
          onNothing={setNothing} onNoSchool={setNoSchool} onRest={markRestNothing}
        />
      </div>

      {editing && (
        <EntryForm
          draft={editing} onChange={setEditing}
          onSave={saveDraft} onCancel={() => setEditing(null)} onDelete={removeItem}
        />
      )}
    </div>
  );
}

/* --------------------------- report-card spine --------------------- */

function Spine({ subjects, counts, filter, onToggle, onClear, onAdd }) {
  const row = (s) => {
    const n = counts[s.id] || 0;
    return (
      <div key={s.id} className="subjrow" style={{ "--c": s.color }} data-on={filter.includes(s.id)}>
        <button className="subjmain" onClick={() => onToggle(s.id)} aria-pressed={filter.includes(s.id)}>
          <div className="nm">{s.name}{s.teacher && <em> ({s.teacher})</em>}</div>
          <div className="ct">
            <i className="dotc" />
            <em>{n === 0 ? "Nothing due" : n === 1 ? "1 coming up" : `${n} coming up`}</em>
          </div>
        </button>
        <button className="subjadd" onClick={() => onAdd(s.id)} title={`Add ${s.name} item`} aria-label={`Add ${s.name} item`}>+</button>
      </div>
    );
  };

  const laStart = subjects.findIndex((x) => x.group === "LA");
  const before = subjects.filter((s, i) => !s.group && i < laStart);
  const la = subjects.filter((s) => s.group === "LA");
  const after = subjects.filter((s, i) => !s.group && i > laStart);

  return (
    <aside className="spine">
      <div className="spine-hd" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="eyebrow">Subjects &mdash; click + to add</span>
        {filter.length > 0 && <button className="mini" onClick={onClear}>Show all</button>}
      </div>

      <div className="spine-inset">
        <div className="cardgrid">
          {before.map(row)}
          <div className="lagroup">
            <div className="labracket" aria-hidden="true"><span>Language Arts</span></div>
            {la.map(row)}
          </div>
          {after.map(row)}
        </div>
      </div>
    </aside>
  );
}

/* ------------------------------ calendar --------------------------- */

function MonthGrid({ y, m, byDate, today, selected, onPick, logs, allItems, onOpenLog, loggedByDate }) {
  const lead = firstDow(y, m);
  const total = daysInMonth(y, m);
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= total; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="cal">
      {DOW.map((d) => <div className="dow" key={d}>{d}</div>)}
      {cells.map((d, ix) => {
        if (d === null) return <div className="cell" data-blank="true" key={`b${ix}`} />;
        const k = key(y, m, d);
        const list = byDate[k] || [];
        const wd = new Date(y, m, d).getDay();
        const st = logStatus(k, logs, allItems, today);
        const hol = NO_SCHOOL[k];
        const off = !hol && !inSchoolYear(k);
        const short = SHORT_DAYS[k];
        const fin = list.filter((i) => i.done).length;
        const logged = loggedByDate[k] || 0;
        const tip = [
          hol || short || null,
          list.length ? `${list.length} due (${fin} finished)` : null,
          logged ? `${logged} written down this day` : null,
        ].filter(Boolean).join(" \u00B7 ") || undefined;
        return (
          <button
            key={k} className="cell" onClick={() => onPick(k)}
            data-today={k === today} data-sel={k === selected} data-weekend={wd === 0 || wd === 6}
            data-hol={Boolean(hol)} data-off={off} data-short={Boolean(short)} data-past={k < today}
            title={tip}
            aria-label={`${longDate(k)}${hol ? `, ${hol}` : ""}, ${list.length} due, ${logged} written down`}
          >
            <span className="dnum">{d}</span>
            {hol && <span className="holname">{hol}</span>}
            {st !== "none" && !hol && (
              <span className="lg" data-st={st}
                title={{ complete: "Logged", partial: "Log started", missing: "Not logged", noschool: "No school" }[st]}
                onClick={(e) => { e.stopPropagation(); onOpenLog(k); }}>
                {LOG_MARK[st]}
              </span>
            )}
            <div className="counts">
              {list.length > 0 && (
                <span className="cnt" data-kind="due" data-clear={fin === list.length}>
                  <b>{list.length}</b>due
                </span>
              )}
              {logged > 0 && (
                <span className="cnt" data-kind="log">
                  <b>{logged}</b>logged
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------ range list ------------------------- */

function RangeList({ items, today, empty, onToggle, onEdit, onAdd }) {
  const groups = useMemo(() => {
    const m = {};
    for (const i of items) (m[i.due] = m[i.due] || []).push(i);
    return Object.keys(m).sort().map((k) => [k, m[k]]);
  }, [items]);

  if (groups.length === 0)
    return (
      <div className="listwrap">
        <p className="blank">{empty} <button className="mini" onClick={onAdd}>Add an item</button></p>
      </div>
    );

  return (
    <div className="listwrap">
      {groups.map(([k, list]) => {
        const late = k < today;
        const diff = daysBetween(today, k);
        const rel = k === today ? "Today" : diff === 1 ? "Tomorrow" : late ? `${Math.abs(diff)}d ago` : `in ${diff}d`;
        return (
          <section className="daygroup" key={k}>
            <h4 data-late={late}><span>{longDate(k)}</span><u>{rel}</u></h4>
            {list.map((it) => <ItemRow key={it.id} it={it} onToggle={onToggle} onEdit={onEdit} />)}
          </section>
        );
      })}
    </div>
  );
}

/* ------------------------------ item row --------------------------- */

function ItemRow({ it, onToggle, onEdit, showDue, readOnly }) {
  const s = SUBJ[it.subject];
  const run = runway(it);
  const left = remaining(it, todayKey());
  return (
    <div className="row" data-done={readOnly ? false : !!it.done}>
      {readOnly ? (
        <span className="mkbox" style={{ "--c": s.color }} aria-hidden="true">{TYPE[it.type].mark}</span>
      ) : (
        <button className="check" data-on={!!it.done} onClick={() => onToggle(it)}
          aria-label={it.done ? "Not finished after all" : "Mark this homework finished"}>{it.done ? "\u2713" : ""}</button>
      )}
      <div className="body">
        <div className="ttl serif">{it.title}</div>
        <div className="tags">
          <span className="stag" style={{ "--c": s.color }}>{s.code}</span>
          {s.teacher && <span className="ttag">{s.teacher}</span>}
          <span className="ttag">{TYPE[it.type].mark} {TYPE[it.type].label}</span>
          {showDue && <span className="ttag">&middot; due {longDate(it.due)}</span>}
          {!readOnly && it.announced && (
            <span className="ttag logtag" title={`Written into the log on ${longDate(it.announced)}`}>
              &middot; logged {it.announced === todayKey() ? "today" : shortDate(it.announced)}
            </span>
          )}
          {run && (
            <span className="ttag runtag" data-tight={run.tight}
              title={`Announced ${longDate(it.announced)}, due ${longDate(it.due)}`}>
              &middot; {run.text}
            </span>
          )}
          {left && (
            <span className="ttag lefttag" data-level={left.level}
              title={`Due ${longDate(it.due)}`}>
              &middot; {left.text}
            </span>
          )}
          {readOnly && it.done && <span className="ttag donetag">&middot; finished</span>}
          {it.addedBy && <span className="ttag">&middot; added by {it.addedBy}</span>}
          <button className="mini" onClick={() => onEdit(it)}>Edit</button>
        </div>
        {it.details && <div className="note serif">{it.details}</div>}
      </div>
    </div>
  );
}

/* ------------------------------ day rail --------------------------- *
 * One panel per day, two tabs: what is DUE that day (work you tick off)
 * and the LOG for that day (what teachers announced). Keeping them side
 * by side but never on screen at once is what stops the two "done"
 * ideas from blurring together.
 * -------------------------------------------------------------------- */

function DayRail({
  open, date, dueItems, logs, allItems, today, tab, setTab, by, setBy,
  onClose, onGo, onToggle, onEdit, onAddDue, onNothing, onNoSchool, onRest, onAddLog,
}) {
  if (!date) {
    return (
      <aside className="rail" data-open={open}>
        <div className="railhd">
          <span className="eyebrow">Pick a day</span>
          <h3>No day selected</h3>
          <button className="railclose" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <p className="empty">Tap any date on the calendar to see what&rsquo;s due and write that day&rsquo;s log.</p>
      </aside>
    );
  }

  const future = date > today;
  const view = future ? "due" : tab;          // no logging ahead of time
  const holiday = NO_SCHOOL[date];
  const log = { ...blankLog(), ...(logs[date] || {}) };
  const closed = Boolean(holiday) || log.noSchool;
  const written = addressedOn(date, logs, allItems);
  const remaining = SUBJECTS.filter((s) => !written.has(s.id));
  const pct = Math.round((written.size / SUBJECTS.length) * 100);
  const allWritten = written.size >= SUBJECTS.length;
  const finishedCount = dueItems.filter((i) => i.done).length;

  const prev = addDays(date, -1);
  const next = addDays(date, 1);
  const announcedFor = (id) => allItems.filter((i) => i.announced === date && i.subject === id);

  return (
    <aside className="rail" data-open={open}>
      <div className="railhd">
        <span className="eyebrow">
          {date === today ? "Today" : date < today ? "Past" : `In ${daysBetween(today, date)} days`}
        </span>
        <h3>{longDate(date)}</h3>
        {holiday && <div className="holnote" style={{ marginTop: 5 }}>{holiday} &middot; no school</div>}
        {!holiday && SHORT_DAYS[date] && <div className="shortnote" style={{ marginTop: 5 }}>{SHORT_DAYS[date]}</div>}
        <div className="raildays">
          <button className="navbtn" onClick={() => onGo(prev)} disabled={prev < YEAR_START} aria-label="Previous day">&larr;</button>
          <button className="navbtn" onClick={() => onGo(next)} disabled={next > YEAR_END} aria-label="Next day">&rarr;</button>
        </div>
        <button className="railclose" onClick={onClose} aria-label="Close">&times;</button>
      </div>

      {!future && (
        <div className="railtabs" role="tablist">
          <button role="tab" aria-selected={view === "due"} data-on={view === "due"} onClick={() => setTab("due")}>
            Due <b>{finishedCount}/{dueItems.length}</b>
          </button>
          <button role="tab" aria-selected={view === "log"} data-on={view === "log"} onClick={() => setTab("log")}>
            Log <b>{closed ? "\u2013" : `${written.size}/${SUBJECTS.length}`}</b>
          </button>
        </div>
      )}

      {view === "due" ? (
        <div className="railpane">
          {dueItems.length === 0 ? (
            <p className="empty">Nothing due this day.</p>
          ) : (
            <>
              <div className="railsub">
                <span className="eyebrow">Homework due this day</span>
                <span className="hint">Tick the box when you finish it</span>
              </div>
              {dueItems.map((it) => <ItemRow key={it.id} it={it} onToggle={onToggle} onEdit={onEdit} />)}
            </>
          )}
          <button className="railadd" onClick={onAddDue}>+ Add item due {shortDate(date)}</button>
          {future && (
            <p className="futurenote">
              {holiday
                ? `${holiday} — no school this day.`
                : `The daily log for this day opens on ${shortDate(date)}. You can still add anything already known to be due.`}
            </p>
          )}
        </div>
      ) : (
        <div className="railpane">
          <div className="progress">
            {!closed && <div className="bar" data-full={allWritten}><i style={{ width: `${pct}%` }} /></div>}
            <span className="ptext">
              {holiday ? `${holiday} \u00B7 no school`
                : log.noSchool ? "Marked as no school"
                : allWritten ? `All ${SUBJECTS.length} written down`
                : `${written.size} of ${SUBJECTS.length} written down`}
            </span>
            {!holiday && (
              <button className="ghost" data-on={log.noSchool} onClick={() => onNoSchool(date, !log.noSchool)}>
                {log.noSchool ? "There was school" : "No school"}
              </button>
            )}
          </div>

          {closed ? (
            <p className="blank">
              {holiday ? `${holiday} — school is closed, so there is nothing to write down.` : "Nothing to write down for this day."}
            </p>
          ) : (
            <>
              <p className="explain">
                Write down what each teacher <b>announced</b>. Ticking off homework
                you have <b>finished</b> happens in the Due tab.
              </p>

              <div className="logbody">
                {SUBJECTS.map((s) => {
                  const mine = announcedFor(s.id);
                  const isNone = log.none.includes(s.id);
                  const state = mine.length ? "items" : isNone ? "none" : "open";
                  return (
                    <div className="logrow" key={s.id} data-state={state} style={{ "--c": s.color }}>
                      <div className="lhead">
                        <span className="stag">{s.code}</span>
                        <span className="lname">{s.name}{s.teacher && <em> ({s.teacher})</em>}</span>
                      </div>
                      <div className="lstate">
                        {state === "items" ? `${mine.length} written down` : state === "none" ? "Nothing announced" : "Not asked yet"}
                      </div>

                      {mine.map((it) => <ItemRow key={it.id} it={it} onEdit={onEdit} showDue readOnly />)}

                      <div className="lacts">
                        <button className="opt" data-on={isNone} disabled={mine.length > 0}
                          title={mine.length ? "Something was announced for this subject" : ""}
                          onClick={() => onNothing(date, s.id, !isNone)}>
                          Nothing
                        </button>
                        <button className="opt" onClick={() => onAddLog(s.id)}>+ Assigned</button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {remaining.length > 0 && (
                <button className="railadd railprimary" onClick={() => onRest(date)}>
                  Nothing else announced ({remaining.length} left)
                </button>
              )}

              <div className="railby">
                <span className="eyebrow">Written by</span>
                <div className="opts">
                  {PEOPLE.map((pn) => (
                    <button key={pn} className="opt" data-on={by === pn} onClick={() => setBy(pn)}>{pn}</button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </aside>
  );
}

/* ------------------------------ entry form ------------------------- */

function EntryForm({ draft, onChange, onSave, onCancel, onDelete }) {
  const [err, setErr] = useState("");
  const titleRef = useRef(null);
  const today = todayKey();

  useEffect(() => { if (titleRef.current) titleRef.current.focus(); }, []);
  useEffect(() => {
    const esc = (e) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onCancel]);

  const set = (patch) => onChange({ ...draft, ...patch });

  const quick = [
    ["Tomorrow", addDays(today, 1)],
    ["Friday", nextDow(today, 5)],
    ["Next Monday", nextDow(today, 1)],
  ].filter(([, v], i, a) => a.findIndex(([, w]) => w === v) === i);

  const submit = () => {
    if (!draft.title.trim()) return setErr("Give it a name, like \u201CChapter 4 problems\u201D.");
    if (!draft.due) return setErr("Pick the day it's due.");
    if (draft.due < YEAR_START || draft.due > YEAR_END) return setErr("Pick a date inside the 2026\u20132027 school year.");
    onSave({ ...draft, title: draft.title.trim(), details: draft.details.trim() });
  };

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Planner item">
        <header>
          <h3>
            {draft.id ? "Edit item" : "New item"}
            {draft.announced && <em style={{ fontStyle: "normal", fontWeight: 600, color: "var(--muted)", marginLeft: 8, letterSpacing: 0, textTransform: "none" }}>
              announced {longDate(draft.announced)}
            </em>}
          </h3>
          <button className="cancel" style={{ padding: "4px 8px" }} onClick={onCancel}>Close</button>
        </header>

        <div className="bd">
          <div>
            <div className="step"><u>1</u><span className="eyebrow">Subject</span></div>
            <div className="opts">
              {SUBJECTS.map((s) => (
                <button key={s.id} className="opt" data-on={draft.subject === s.id}
                  style={{ "--c": s.color }} onClick={() => set({ subject: s.id })}>
                  <i className="dotc" />{codeWithTeacher(s)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="step"><u>2</u><span className="eyebrow">What is it?</span></div>
            <input ref={titleRef} type="text" value={draft.title} placeholder="Chapter 4 problems 1–20"
              onChange={(e) => set({ title: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
            <div className="opts" style={{ marginTop: 7 }}>
              {TYPES.map((t) => (
                <button key={t.id} className="opt" data-on={draft.type === t.id} onClick={() => set({ type: t.id })}>
                  {t.mark} {t.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="step"><u>3</u><span className="eyebrow">When is it due?</span></div>
            <input type="date" value={draft.due} min={YEAR_START} max={YEAR_END}
              onChange={(e) => set({ due: e.target.value })} />
            <div className="quick">
              {quick.map(([lbl, val]) => (
                <button key={lbl} onClick={() => set({ due: val })}>{lbl} &middot; {shortDate(val)}</button>
              ))}
            </div>
            {draft.due && (
              <div style={{ marginTop: 7, fontSize: 12.5, color: "var(--muted)", fontWeight: 700 }}>
                Due {longDate(draft.due)}
              </div>
            )}
          </div>

          <div>
            <div className="step"><u>4</u><span className="eyebrow">Details (optional)</span></div>
            <textarea value={draft.details} placeholder="Chapters covered, what to bring, how it's graded…"
              onChange={(e) => set({ details: e.target.value })} />
            <div className="opts" style={{ marginTop: 9 }}>
              <span className="ttag" style={{ alignSelf: "center" }}>Added by</span>
              {PEOPLE.map((p) => (
                <button key={p} className="opt" data-on={draft.addedBy === p} onClick={() => set({ addedBy: p })}>{p}</button>
              ))}
            </div>
          </div>

          {err && <div className="err">{err}</div>}
        </div>

        <footer>
          <button className="save" onClick={submit}>{draft.id ? "Save changes" : "Add to planner"}</button>
          {draft.id && <button className="del" onClick={() => onDelete(draft.id)}>Delete</button>}
        </footer>
      </div>
    </div>
  );
}
