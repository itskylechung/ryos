/**
 * Nee Hao Fine Shyt — dating built to get people on real dates
 * (docs/proposals/dating-flow.md).
 *
 * Flow: intake agent fills dating basics + drafts the profile text
 * (api/matchmaker/chat.ts) → user adds photos and approves (profile.ts) and
 * joins the pool → [step 2: on-demand date plans] → both accept (drop.ts) →
 * Ryo opens a private room.
 *
 * Privacy boundary: matching only ever reads the APPROVED profile (text, tags,
 * basics), never memories.
 */

import { generateText, Output } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import type { Redis } from "../_utils/redis.js";
import { redisKeys } from "../../src/shared/redisKeys.js";
import { MATCHMAKER_JUDGE_INSTRUCTIONS } from "../_utils/_aiPrompts.js";
import type { InternalModelId } from "../_utils/_aiModels.js";
import { escapeHTML } from "../_utils/_validation.js";
import {
  addMessage,
  generateId,
  getCurrentTimestamp,
  registerRoom,
  setRoom,
} from "../rooms/_helpers/_redis.js";
import { setRoomPresence } from "../rooms/_helpers/_presence.js";
import {
  broadcastNewMessage,
  broadcastRoomCreated,
} from "../rooms/_helpers/_pusher.js";
import type { Message, Room } from "../rooms/_helpers/_types.js";
import { MAX_PHOTOS, type DatingBasics } from "../../src/shared/dating.js";

export const MAX_PROFILE_CHARS = 600;
export const MIN_PROFILE_CHARS = 20;
export const SHORTLIST_SIZE = 5;
const DROP_TTL_SECONDS = 14 * 24 * 60 * 60;
/** ~150 KB per photo; the client compresses to fit. */
export const MAX_PHOTO_CHARS = 200_000;
const PHOTO_DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
/** One small OpenAI model for the whole Matchmaker (interview, tags, judge). */
export const MATCHMAKER_MODEL_ID = "gpt-6-luna" satisfies InternalModelId;
const matchModel = () => openai(MATCHMAKER_MODEL_ID);

export type MatchStatus = "none" | "active" | "paused";
export type MatchResponse = "pending" | "accepted" | "declined";

export interface MatchProfile {
  draft: string | null;
  approved: string | null;
  tags: string[];
  status: MatchStatus;
  /** Structured dating fields; filled in piece by piece during the interview. */
  basics: DatingBasics;
  updatedAt: number;
}

/** One user's view of a weekly match. Each side stores its own (immutable) copy. */
export interface StoredMatchDrop {
  partner: string;
  partnerProfile: string;
  score: number;
  why: string;
  opener: string;
  createdAt: number;
}

/** Drop merged with live responses from the shared pair hash. */
export interface MatchDrop extends StoredMatchDrop {
  myResponse: MatchResponse;
  partnerResponse: MatchResponse;
  roomId: string | null;
}

export interface ScoredPair {
  a: string;
  b: string;
  score: number;
  why: string;
  /** Icebreaker in A's voice (shown on A's card), and vice versa. */
  openerFromA: string;
  openerFromB: string;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function parseStored<T>(raw: unknown): T | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return raw as T;
}

export function emptyProfile(): MatchProfile {
  return { draft: null, approved: null, tags: [], status: "none", basics: {}, updatedAt: 0 };
}

export async function getProfile(
  redis: Redis,
  username: string
): Promise<MatchProfile> {
  const [raw, draft] = await redis.mget<unknown>(
    redisKeys.agent.matchProfile(username),
    redisKeys.agent.matchDraft(username)
  );
  const profile = { ...emptyProfile(), ...parseStored<MatchProfile>(raw) };
  return { ...profile, draft: typeof draft === "string" ? draft : profile.draft };
}

/** Writes status/approved/tags. The draft lives in its own key (saveDraft). */
export async function saveProfile(
  redis: Redis,
  username: string,
  profile: MatchProfile
): Promise<void> {
  const { draft: _draft, ...record } = profile;
  await redis.set(
    redisKeys.agent.matchProfile(username),
    JSON.stringify({ ...record, draft: null, updatedAt: Date.now() })
  );
  if (profile.status === "active" && profile.approved) {
    await redis.sadd(redisKeys.agent.matchPool(), username);
  } else {
    await redis.srem(redisKeys.agent.matchPool(), username);
  }
}

/** Single-key write: can't clobber a concurrent approve/pause. */
export async function saveDraft(
  redis: Redis,
  username: string,
  draft: string
): Promise<void> {
  await redis.set(
    redisKeys.agent.matchDraft(username),
    draft.trim().slice(0, MAX_PROFILE_CHARS)
  );
}

/**
 * Merge interview answers into basics. Re-reads right before writing so a
 * concurrent approve/pause isn't lost (ponytail: read-merge-write, not atomic;
 * one user editing their own profile won't race in practice).
 */
export async function saveBasics(
  redis: Redis,
  username: string,
  patch: DatingBasics
): Promise<MatchProfile> {
  const profile = await getProfile(redis, username);
  const next = { ...profile, basics: { ...profile.basics, ...patch } };
  await saveProfile(redis, username, next);
  return next;
}

export function isValidPhoto(photo: string): boolean {
  return photo.length <= MAX_PHOTO_CHARS && PHOTO_DATA_URL.test(photo);
}

/** Photos live in their own key so pool scans don't load ~600 KB per user. */
export async function getPhotos(redis: Redis, username: string): Promise<string[]> {
  return parseStored<string[]>(await redis.get(redisKeys.agent.matchPhotos(username))) ?? [];
}

export async function savePhotos(
  redis: Redis,
  username: string,
  photos: string[]
): Promise<void> {
  // ponytail: photos as data URLs in Redis, fine for a pilot-sized pool; move
  // to S3 (api/_utils/storage.ts) before it grows past a few hundred users.
  await redis.set(
    redisKeys.agent.matchPhotos(username),
    JSON.stringify(photos.slice(0, MAX_PHOTOS))
  );
}

async function getStoredDrop(
  redis: Redis,
  username: string
): Promise<StoredMatchDrop | null> {
  return parseStored<StoredMatchDrop>(
    await redis.get(redisKeys.agent.matchDrop(username))
  );
}

export async function getDrop(
  redis: Redis,
  username: string
): Promise<MatchDrop | null> {
  const drop = await getStoredDrop(redis, username);
  if (!drop) return null;
  const pair =
    (await redis.hgetall<Record<string, string>>(
      redisKeys.agent.matchPair(username, drop.partner, drop.createdAt)
    )) ?? {};
  return {
    ...drop,
    myResponse: (pair[username] as MatchResponse) ?? "pending",
    partnerResponse: (pair[drop.partner] as MatchResponse) ?? "pending",
    roomId: pair.roomId ?? null,
  };
}

async function saveDrop(
  redis: Redis,
  username: string,
  drop: StoredMatchDrop
): Promise<void> {
  await redis.set(redisKeys.agent.matchDrop(username), JSON.stringify(drop), {
    ex: DROP_TTL_SECONDS,
  });
}

/**
 * Remove the user's current match from BOTH sides: the partner's card holds a
 * copy of this user's approved profile, and can never complete without them.
 */
async function dissolveCurrentMatch(redis: Redis, username: string) {
  const mine = await getStoredDrop(redis, username);
  if (!mine) return;
  const theirs = await getStoredDrop(redis, mine.partner);
  const keys = [
    redisKeys.agent.matchDrop(username),
    redisKeys.agent.matchPair(username, mine.partner, mine.createdAt),
  ];
  if (theirs?.partner === username && theirs.createdAt === mine.createdAt) {
    keys.push(redisKeys.agent.matchDrop(mine.partner));
  }
  await redis.del(...keys);
}

/** Leave Matchmaker: drop profile + current match, keep seen/blocked so blocks stick. */
export async function leaveMatchmaker(redis: Redis, username: string) {
  await redis.srem(redisKeys.agent.matchPool(), username);
  await dissolveCurrentMatch(redis, username);
  await redis.del(
    redisKeys.agent.matchProfile(username),
    redisKeys.agent.matchDraft(username),
    redisKeys.agent.matchPhotos(username)
  );
}

/** Account deletion: remove everything. */
export async function deleteAllMatchmakerData(
  redis: Redis,
  username: string
): Promise<number> {
  await redis.srem(redisKeys.agent.matchPool(), username);
  await dissolveCurrentMatch(redis, username);
  return redis.del(
    redisKeys.agent.matchProfile(username),
    redisKeys.agent.matchDraft(username),
    redisKeys.agent.matchPhotos(username),
    redisKeys.agent.matchDrop(username),
    redisKeys.agent.matchSeen(username),
    redisKeys.agent.matchBlocked(username)
  );
}

// ---------------------------------------------------------------------------
// Matching (pure)
// ---------------------------------------------------------------------------

export function tagOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const shared = a.filter((t) => setB.has(t)).length;
  return shared / (a.length + b.length - shared);
}

/**
 * Cheap pre-filter: top-K candidates by tag Jaccard. Zero-overlap candidates
 * still qualify — small pools need them, and the judge catches non-obvious fits
 * that tags miss.
 */
export function shortlist(
  me: string,
  myTags: string[],
  candidates: Array<{ username: string; tags: string[] }>,
  excluded: Set<string>,
  size = SHORTLIST_SIZE
): string[] {
  return candidates
    .filter((c) => c.username !== me && !excluded.has(c.username))
    .map((c) => ({ username: c.username, overlap: tagOverlap(myTags, c.tags) }))
    .sort((x, y) => y.overlap - x.overlap || x.username.localeCompare(y.username))
    .slice(0, size)
    .map((c) => c.username);
}

// ---------------------------------------------------------------------------
// LLM steps
// ---------------------------------------------------------------------------

export async function extractTags(profile: string): Promise<string[]> {
  const { output } = await generateText({
    model: matchModel(),
    output: Output.object({
      schema: z.object({
        tags: z
          .array(z.string().min(1).max(30))
          .max(12)
          .describe(
            "3-12 short lowercase english tags: interests, skills, what they build, what they seek (e.g. 'synths', 'react', 'wants-cofounder', 'taipei')"
          ),
      }),
    }),
    prompt: `Extract matching tags from this profile:\n\n${profile}`,
    reasoning: "low",
  });
  return [...new Set(output.tags.map((t) => t.trim().toLowerCase()))];
}

const judgeSchema = z.object({
  score: z.number().int().min(0).max(100),
  // Length guidance lives in the prompt; these caps are only a safety net.
  // OpenAI structured outputs enforce maxLength during decoding, so a tight
  // cap truncates mid-word instead of producing a shorter sentence.
  why: z.string().max(800),
  openerFromA: z.string().max(500),
  openerFromB: z.string().max(500),
});

// ponytail: single judge call per pair. Upgrade path (Ditto-style): simulate a
// short 2-agent chat for the top 1-2 candidates and judge the transcript.
export async function judgePair(
  a: { username: string; profile: string },
  b: { username: string; profile: string }
): Promise<ScoredPair> {
  const { output } = await generateText({
    model: matchModel(),
    output: Output.object({ schema: judgeSchema }),
    instructions: MATCHMAKER_JUDGE_INSTRUCTIONS,
    prompt: `A = @${a.username}:\n${a.profile}\n\nB = @${b.username}:\n${b.profile}`,
    reasoning: "low",
  });
  return { a: a.username, b: b.username, ...output };
}

// ---------------------------------------------------------------------------
// Creating a match
// ---------------------------------------------------------------------------

/**
 * Give both people their side of a match: the other's approved profile, the
 * shared "why", and an icebreaker in their own voice. Records the pairing so
 * it never repeats.
 */
export async function createMatch(
  redis: Redis,
  pair: ScoredPair,
  profiles: { a: string; b: string },
  now = Date.now()
): Promise<void> {
  const base = { score: pair.score, why: pair.why, createdAt: now };
  await Promise.all([
    saveDrop(redis, pair.a, {
      ...base,
      partner: pair.b,
      partnerProfile: profiles.b,
      opener: pair.openerFromA,
    }),
    saveDrop(redis, pair.b, {
      ...base,
      partner: pair.a,
      partnerProfile: profiles.a,
      opener: pair.openerFromB,
    }),
    redis.sadd(redisKeys.agent.matchSeen(pair.a), pair.b),
    redis.sadd(redisKeys.agent.matchSeen(pair.b), pair.a),
  ]);
}

// ---------------------------------------------------------------------------
// Responding to a drop
// ---------------------------------------------------------------------------

export async function respondToDrop(
  redis: Redis,
  username: string,
  action: "accept" | "decline" | "block",
  openRoom = openMatchRoom
): Promise<MatchDrop | null> {
  const drop = await getStoredDrop(redis, username);
  if (!drop) return null;
  const { partner, createdAt } = drop;

  if (action === "block") {
    await redis.sadd(redisKeys.agent.matchBlocked(username), partner);
  }

  // Responses share one hash per pair: write mine, then read both. Redis is
  // linearizable, so whichever side writes second always sees both answers.
  const pairKey = redisKeys.agent.matchPair(username, partner, createdAt);
  await redis.hset(pairKey, {
    [username]: action === "accept" ? "accepted" : "declined",
  });
  await redis.expire(pairKey, DROP_TTL_SECONDS);

  const pair = (await redis.hgetall<Record<string, string>>(pairKey)) ?? {};
  if (
    pair[username] === "accepted" &&
    pair[partner] === "accepted" &&
    !pair.roomId
  ) {
    // NX lock so a simultaneous double-accept opens exactly one room.
    const lockKey = redisKeys.agent.matchRoomLock(username, partner, createdAt);
    const won = await redis.set(lockKey, "1", { nx: true, ex: DROP_TTL_SECONDS });
    if (won) {
      try {
        const roomId = await openRoom(redis, [username, partner], drop);
        await redis.hset(pairKey, { roomId });
      } catch (error) {
        // Release so the next accept/refresh can retry instead of waiting
        // out the TTL. ponytail: a half-created room may be left behind;
        // add cleanup if this ever fires in practice.
        await redis.del(lockKey).catch(() => {});
        throw error;
      }
    }
  }
  return getDrop(redis, username);
}

async function openMatchRoom(
  redis: Redis,
  members: string[],
  drop: Pick<MatchDrop, "why">
): Promise<string> {
  const sorted = [...members].sort();
  const roomId = generateId();
  const room: Room = {
    id: roomId,
    name: sorted.map((m) => `@${m}`).join(", "),
    type: "private",
    createdAt: getCurrentTimestamp(),
    userCount: sorted.length,
    members: sorted,
  };
  await setRoom(roomId, room, redis);
  await registerRoom(roomId, redis);
  await redis.sadd(redisKeys.agent.matchRooms(), roomId);
  await Promise.all(sorted.map((m) => setRoomPresence(roomId, m, redis)));
  await broadcastRoomCreated(room);

  const message: Message = {
    id: generateId(),
    roomId,
    username: "ryo",
    content: escapeHTML(
      `matched you two 🤝 ${drop.why}\n\nwhen you want to meet, say "@ryo plan our date" and i’ll find a time and place that works for you both.`
    ),
    timestamp: getCurrentTimestamp(),
  };
  await addMessage(roomId, message, redis);
  await broadcastNewMessage(roomId, message, room);
  return roomId;
}
