/**
 * /api/matchmaker/profile
 *
 * GET    - Current profile (draft, approved, basics) + photos
 * PUT    - { action: "approve", text? } | { action: "pause" } | { action: "resume" }
 *          | { action: "basics", basics } | { action: "photos", photos }
 * DELETE - Leave (removes profile, photos, and any pending match)
 */

import { z } from "zod";
import { apiHandler } from "../_utils/api-handler.js";
import * as RateLimit from "../_utils/_rate-limit.js";
import { filterProfanityPreservingUrls } from "../_utils/_validation.js";
import {
  extractTags,
  getPhotos,
  getProfile,
  isValidPhoto,
  leaveMatchmaker,
  MAX_PROFILE_CHARS,
  MIN_PROFILE_CHARS,
  saveBasics,
  saveDraft,
  savePhotos,
  saveProfile,
} from "./_lib.js";
import {
  datingBasicsSchema,
  isAdult,
  MAX_PHOTOS,
  missingBasics,
} from "../../src/shared/dating.js";

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    text: z.string().max(MAX_PROFILE_CHARS).optional(),
  }),
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("basics"), basics: datingBasicsSchema }),
  z.object({ action: z.literal("photos"), photos: z.array(z.string()).max(MAX_PHOTOS) }),
]);

export default apiHandler(
  { methods: ["GET", "PUT", "DELETE"], auth: "required", parseJsonBody: true },
  async ({ req, res, redis, user, logger }) => {
    const username = user!.username;
    const method = (req.method || "GET").toUpperCase();

    const respond = async () => {
      const [profile, photos] = await Promise.all([
        getProfile(redis, username),
        getPhotos(redis, username),
      ]);
      res.status(200).json({ profile, photos });
    };

    if (method === "GET") {
      await respond();
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

    if (body.action === "approve") {
      // Each approve runs an LLM call (tag extraction).
      const rl = await RateLimit.checkBurstAndDailyLimits({
        namespace: "matchmaker-approve",
        identifierParts: ["user", username],
        burst: { windowSeconds: 60, limit: 5 },
        daily: { windowSeconds: 60 * 60 * 24, limit: 30 },
      });
      if (!rl.ok) {
        res.status(429).json({ error: "rate_limit_exceeded", scope: rl.scope });
        return;
      }
    }

    if (body.action === "basics") {
      const b = body.basics;
      if (b.birthdate && !isAdult(b.birthdate)) {
        res.status(400).json({ error: "under_18" });
        return;
      }
      const merged = { ...profile.basics, ...b };
      if (merged.ageMin && merged.ageMax && merged.ageMin > merged.ageMax) {
        res.status(400).json({ error: "bad_age_range" });
        return;
      }
      await saveBasics(redis, username, b);
      await respond();
      return;
    }

    if (body.action === "photos") {
      if (!body.photos.every(isValidPhoto)) {
        res.status(400).json({ error: "bad_photo" });
        return;
      }
      await savePhotos(redis, username, body.photos);
      await respond();
      return;
    }

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
      // Nobody joins the pool without complete basics, 18+, and a photo.
      if (missingBasics(profile.basics).length > 0) {
        res.status(400).json({ error: "missing_basics", missing: missingBasics(profile.basics) });
        return;
      }
      if (!isAdult(profile.basics.birthdate!)) {
        res.status(400).json({ error: "under_18" });
        return;
      }
      if ((await getPhotos(redis, username)).length === 0) {
        res.status(400).json({ error: "need_photo" });
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
      // Re-read after the slow LLM call so a pause made meanwhile isn't lost,
      // and keep a paused user paused (editing ≠ opting back in).
      const latest = await getProfile(redis, username);
      await saveDraft(redis, username, text);
      await saveProfile(redis, username, {
        ...latest,
        approved: text,
        tags,
        status: latest.status === "paused" ? "paused" : "active",
      });
    }

    await respond();
  }
);
