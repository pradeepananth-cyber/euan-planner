/* ------------------------------------------------------------------ *
 *  /api/health  —  open this in a browser to see what this deployment
 *  actually has. Reports variable NAMES and whether they are set.
 *  Never returns a value, so it is safe to look at.
 * ------------------------------------------------------------------ */

/* Vercel lets you give an Upstash database a custom environment-variable
   prefix (e.g. EUAN_PLANNER_KV_REST_API_URL). Rather than demand exact
   names, find whichever pair exists and use it. The read-only token is
   deliberately ignored: this function has to write. */
function resolveRedis() {
  const SUFFIXES = ["KV_REST_API", "UPSTASH_REDIS_REST"];

  for (const suffix of SUFFIXES) {
    // exact, unprefixed names win
    const url = process.env[`${suffix}_URL`];
    const token = process.env[`${suffix}_TOKEN`];
    if (url && token) return { url, token, via: `${suffix}_URL` };
  }

  for (const suffix of SUFFIXES) {
    const urlKey = Object.keys(process.env).find(
      (k) => k.endsWith(`${suffix}_URL`) && String(process.env[k] || "").startsWith("https://")
    );
    if (!urlKey) continue;
    const prefix = urlKey.slice(0, urlKey.length - `${suffix}_URL`.length);
    const tokenKey = `${prefix}${suffix}_TOKEN`;      // never the _READ_ONLY_TOKEN
    const token = process.env[tokenKey];
    if (token) return { url: process.env[urlKey], token, via: urlKey };
  }

  return { url: "", token: "", via: null };
}

const REDIS = resolveRedis();
const REDIS_URL = REDIS.url;
const REDIS_TOKEN = REDIS.token;

const REST_URL = REDIS_URL;
const REST_TOKEN = REDIS_TOKEN;

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  // Which storage-ish variables exist in this runtime, names only.
  const seen = Object.keys(process.env)
    .filter((k) => /KV|REDIS|UPSTASH|PLANNER/i.test(k))
    .sort();

  const usable = Boolean(REST_URL && REST_TOKEN);

  let diagnosis;
  if (usable) {
    diagnosis = "Looks right. If the app still complains, redeploy so it picks this up.";
  } else if (seen.length === 0) {
    diagnosis =
      "No storage variables at all in this deployment. Either the database is connected " +
      "to a different Vercel project, or this build predates the connection. Connect it " +
      "to THIS project, then redeploy.";
  } else if (!REST_URL && seen.some((k) => /^(KV_URL|REDIS_URL)$/.test(k))) {
    diagnosis =
      "Only the rediss:// connection string is present. This function needs the HTTP REST " +
      "endpoint. Add KV_REST_API_URL and KV_REST_API_TOKEN from the Upstash database page.";
  } else if (REST_URL && !REST_TOKEN) {
    diagnosis = "URL is set but the token is missing.";
  } else if (!REST_URL && REST_TOKEN) {
    diagnosis = "Token is set but the REST URL is missing.";
  } else {
    diagnosis = "Storage variables exist but not the two this function reads.";
  }

  res.status(200).json({
    ok: true,
    functionsWorking: true,
    redisConnected: usable,
    diagnosis,

    // what this build can see
    storageVarsPresent: seen,
    restUrlSet: Boolean(REST_URL),
    restTokenSet: Boolean(REST_TOKEN),
    restUrlLooksValid: /^https:\/\//.test(REST_URL),
    restUrlHost: REST_URL ? (REST_URL.split("/")[2] || null) : null,
    foundVia: REDIS.via,

    // which deployment is answering
    vercelEnv: process.env.VERCEL_ENV || "not on Vercel",
    project: process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "unknown",
    commit: (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7) || "unknown",
    deployedAt: process.env.VERCEL_DEPLOYMENT_ID || "unknown",

    namespace: process.env.PLANNER_NAMESPACE || "planner",
    passphraseRequired: Boolean(process.env.PLANNER_KEY),
    node: process.version,
    time: new Date().toISOString(),
  });
}
