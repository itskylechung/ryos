/**
 * /api/matchmaker/drop
 *
 * GET  - This week's match (or null) + past partners
 * POST - { action: "accept" | "decline" | "block" }
 *        Both accept → Ryo opens a private room with the intro.
 */

import { z } from "zod";
import { apiHandler } from "../_utils/api-handler.js";
import { redisKeys } from "../../src/shared/redisKeys.js";
import { getDrop, respondToDrop } from "./_lib.js";

const bodySchema = z.object({ action: z.enum(["accept", "decline", "block"]) });

export default apiHandler(
  { methods: ["GET", "POST"], auth: "required", parseJsonBody: true },
  async ({ req, res, redis, user }) => {
    const username = user!.username;

    if ((req.method || "GET").toUpperCase() === "GET") {
      const [drop, past] = await Promise.all([
        getDrop(redis, username),
        redis.smembers<string[]>(redisKeys.agent.matchSeen(username)),
      ]);
      res.status(200).json({ drop, past: past ?? [] });
      return;
    }

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "validation_error" });
      return;
    }
    const drop = await respondToDrop(redis, username, parsed.data.action);
    if (!drop) {
      res.status(404).json({ error: "No match this week" });
      return;
    }
    res.status(200).json({ drop });
  }
);
