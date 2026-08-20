/* ------------------------------------------------------------------ *
 *  /api/health  —  open this in a browser to see what Vercel deployed.
 *
 *  If this 404s too, functions aren't being picked up at all: the api
 *  folder is in the wrong place, or wasn't committed, or the project's
 *  Root Directory setting points somewhere that doesn't contain it.
 *
 *  If this answers but /api/planner 404s, only that one file is missing.
 *  No passphrase needed, and no secrets are returned.
 * ------------------------------------------------------------------ */

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true,
    functionsWorking: true,
    redisConnected: Boolean(
      (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
      (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN)
    ),
    passphraseRequired: Boolean(process.env.PLANNER_KEY),
    namespace: (process.env.PLANNER_NAMESPACE || "planner"),
    restUrlLooksValid: /^https:\/\//.test(
      process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || ""
    ),
    node: process.version,
    region: process.env.VERCEL_REGION || "unknown",
    time: new Date().toISOString(),
  });
}
