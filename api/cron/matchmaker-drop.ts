import type { ApiRequest, ApiResponse } from "../_utils/api-types.js";
import { initLogger } from "../_utils/_logging.js";
import createRedis from "../_utils/redis.js";
import { getHeader } from "../_utils/request-helpers.js";
import { runWeeklyDrop } from "../matchmaker/_lib.js";

/**
 * Weekly Matchmaker drop (trigger via an external scheduler, e.g. a Coolify
 * scheduled task, once a week). Idempotent within ~6 days: users who already
 * got a drop are skipped, so a retried run only fills in the rest.
 *
 * Auth matches the other crons: `Authorization: Bearer ${CRON_SECRET}`.
 */
export default async function handler(
  req: ApiRequest,
  res: ApiResponse
): Promise<void> {
  const { logger } = initLogger();
  const startTime = Date.now();
  res.setHeader("Content-Type", "application/json");
  logger.request(req.method || "GET", req.url || "/api/cron/matchmaker-drop");

  if ((req.method || "GET").toUpperCase() !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    res.status(503).json({ error: "CRON_SECRET is not configured" });
    return;
  }
  if (getHeader(req, "authorization") !== `Bearer ${cronSecret}`) {
    logger.response(401, Date.now() - startTime);
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const stats = await runWeeklyDrop(createRedis());
    logger.info("Matchmaker drop completed", { ...stats });
    logger.response(200, Date.now() - startTime);
    res.status(200).json({ success: true, ...stats });
  } catch (error) {
    logger.error("Matchmaker drop failed", error);
    logger.response(500, Date.now() - startTime);
    res.status(500).json({ error: "Matchmaker drop failed" });
  }
}
