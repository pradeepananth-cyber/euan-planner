/* ------------------------------------------------------------------ *
 *  /api/planner  —  Vercel serverless function
 *
 *  Vercel has no writable disk, so the data lives in Upstash Redis
 *  (free tier, no card). Two keys:
 *      planner:rev    integer, bumped on every save
 *      planner:items  the JSON array of entries
 *
 *  Needs these environment variables in the Vercel dashboard:
 *      KV_REST_API_URL      (or UPSTASH_REDIS_REST_URL)
 *      KV_REST_API_TOKEN    (or UPSTASH_REDIS_REST_TOKEN)
 *      PLANNER_KEY          optional passphrase
 *
 *  No npm dependencies — talks to Upstash over plain fetch.
 * ------------------------------------------------------------------ */

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const KEY = process.env.PLANNER_KEY || "";

/* Two deployments can share one Upstash database safely by setting
   PLANNER_NAMESPACE differently on each (e.g. "planner" and "test").
   Leave it unset and the keys stay exactly as they were. */
const NS = (process.env.PLANNER_NAMESPACE || "planner").replace(/[^A-Za-z0-9_-]/g, "") || "planner";

const REV_KEY = `${NS}:rev`;
const ITEMS_KEY = `${NS}:items`;
const LOGS_KEY = `${NS}:logs`;

/* --------------------------- redis over REST ----------------------- */

async function redis(command) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error || `Redis returned ${r.status}`);
  return d.result;
}

async function redisPipeline(commands) {
  const r = await fetch(`${REDIS_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`Redis returned ${r.status}`);
  return d.map((x) => x.result);
}

/* Bump the revision and write the items in one atomic step. Returns the
   new revision, or a negative number encoding the revision the caller
   should have started from. */
const CAS_SCRIPT = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if tonumber(ARGV[1]) ~= cur then
  return -cur - 1
end
local nxt = cur + 1
redis.call('SET', KEYS[1], nxt)
redis.call('SET', KEYS[2], ARGV[2])
redis.call('SET', KEYS[3], ARGV[3])
return nxt
`;

/* ---------------------------- validation --------------------------- */

const FIELDS = ["id", "subject", "type", "title", "due", "details", "addedBy", "done", "createdAt", "announced"];
const SUBJECT_IDS = new Set(["religion", "math", "lit", "english", "spelling", "science", "history"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function clean(items) {
  if (!Array.isArray(items)) throw new Error("items must be a list");
  if (items.length > 5000) throw new Error("too many items");
  return items.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("bad item");
    const it = {};
    for (const k of FIELDS) if (raw[k] !== undefined) it[k] = raw[k];
    if (!it.id || !it.title || !it.due) throw new Error("an item is missing id, title or due date");
    if (typeof it.title !== "string" || it.title.length > 300) throw new Error("bad title");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(it.due)) throw new Error("bad due date");
    if (it.details !== undefined) it.details = String(it.details).slice(0, 4000);
    if (it.announced !== undefined && !DATE_RE.test(it.announced)) delete it.announced;
    it.done = Boolean(it.done);
    return it;
  });
}

/* One record per day: which subjects were explicitly marked as having
   nothing announced, and whether there was school at all. */
function cleanLogs(logs) {
  if (!logs || typeof logs !== "object" || Array.isArray(logs)) return {};
  const out = {};
  for (const date of Object.keys(logs).slice(0, 500)) {
    if (!DATE_RE.test(date)) continue;
    const v = logs[date] || {};
    out[date] = {
      none: Array.isArray(v.none) ? [...new Set(v.none.filter((x) => SUBJECT_IDS.has(x)))] : [],
      noSchool: Boolean(v.noSchool),
      by: typeof v.by === "string" ? v.by.slice(0, 50) : "",
      updatedAt: typeof v.updatedAt === "string" ? v.updatedAt.slice(0, 40) : "",
    };
  }
  return out;
}

/* ------------------------------ handler ---------------------------- */

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(503).json({
      error:
        "No database connected. In this Vercel project: Storage \u2192 connect an Upstash Redis " +
        "database, then redeploy. (Storage and environment variables belong to the project, " +
        "so a copied project starts without them.) Needs the REST URL, not the rediss:// one.",
    });
  }

  if (KEY && req.headers["x-planner-key"] !== KEY) {
    return res.status(401).json({ error: "Wrong or missing planner passphrase." });
  }

  try {
    if (req.method === "GET") {
      const [rev, itemsRaw, logsRaw] = await redisPipeline([
        ["GET", REV_KEY],
        ["GET", ITEMS_KEY],
        ["GET", LOGS_KEY],
      ]);
      let items = [];
      if (itemsRaw) {
        try { const p = JSON.parse(itemsRaw); if (Array.isArray(p)) items = p; } catch (e) { items = []; }
      }
      let logs = {};
      if (logsRaw) {
        try { const p = JSON.parse(logsRaw); if (p && typeof p === "object") logs = p; } catch (e) { logs = {}; }
      }
      return res.status(200).json({ rev: Number(rev) || 0, items, logs });
    }

    if (req.method === "PUT") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      if (!body || !Array.isArray(body.items)) {
        return res.status(400).json({ error: "Could not read that request." });
      }

      let items, logs;
      try {
        items = clean(body.items);
        logs = cleanLogs(body.logs);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }

      const result = await redis([
        "EVAL", CAS_SCRIPT, "3", REV_KEY, ITEMS_KEY, LOGS_KEY,
        String(Number(body.rev) || 0), JSON.stringify(items), JSON.stringify(logs),
      ]);

      const n = Number(result);
      if (n < 0) {
        return res.status(409).json({ error: "Someone else saved first.", rev: -n - 1 });
      }
      return res.status(200).json({ rev: n, count: items.length, logs: Object.keys(logs).length });
    }

    return res.status(405).json({ error: "Use GET or PUT." });
  } catch (e) {
    console.error("planner api:", e);
    return res.status(500).json({ error: `Storage error: ${e.message}` });
  }
}
