/**
 * /api/matchmaker/profile
 *
 * GET    - Current match profile (draft + approved)
 * PUT    - { action: "approve", text? } | { action: "pause" } | { action: "resume" }
 * DELETE - Leave Matchmaker (removes profile + pending match)
 */

import { z } from "zod";
import { apiHandler } from "../_utils/api-handler.js";
import { filterProfanityPreservingUrls } from "../_utils/_validation.js";
import {
  extractTags,
  getProfile,
  leaveMatchmaker,
  MAX_PROFILE_CHARS,
  MIN_PROFILE_CHARS,
  saveProfile,
} from "./_lib.js";

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    text: z.string().max(MAX_PROFILE_CHARS).optional(),
  }),
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
]);

export default apiHandler(
  { methods: ["GET", "PUT", "DELETE"], auth: "required", parseJsonBody: true },
  async ({ req, res, redis, user, logger }) => {
    const username = user!.username;
    const method = (req.method || "GET").toUpperCase();

    if (method === "GET") {
      res.status(200).json({ profile: await getProfile(redis, username) });
      return;
    }

    if (method === "DELETE") {
      await leaveMatchmaker(redis, username);
      res.status(200).json({ success: true });
      return;
    }

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "validation_error" });
      return;
    }
    const body = parsed.data;
    const profile = await getProfile(redis, username);

    if (body.action === "pause") {
      await saveProfile(redis, username, { ...profile, status: "paused" });
    } else if (body.action === "resume") {
      if (!profile.approved) {
        res.status(400).json({ error: "No approved profile" });
        return;
      }
      await saveProfile(redis, username, { ...profile, status: "active" });
    } else {
      const text = filterProfanityPreservingUrls(
        (body.text ?? profile.draft ?? "").trim()
      );
      if (text.length < MIN_PROFILE_CHARS) {
        res.status(400).json({ error: "Profile is too short" });
        return;
      }
      let tags: string[];
      try {
        tags = await extractTags(text);
      } catch (error) {
        logger.error("Matchmaker tag extraction failed", error);
        res.status(502).json({ error: "Could not process profile, try again" });
        return;
      }
      await saveProfile(redis, username, {
        ...profile,
        draft: text,
        approved: text,
        tags,
        status: "active",
      });
    }

    res.status(200).json({ profile: await getProfile(redis, username) });
  }
);
