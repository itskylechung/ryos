/**
 * Matchmaker — weekly friend / collaborator intros (Ditto-style, not dating).
 *
 * Flow: intake agent drafts a profile (api/matchmaker/chat.ts) → user approves
 * it (profile.ts) and joins the pool → weekly cron (api/cron/matchmaker-drop.ts)
 * shortlists by tag overlap, LLM-judges each pair, greedily pairs the best →
 * both accept (drop.ts) → Ryo opens a private room and posts the intro.
 *
 * Privacy boundary: matching only ever reads the APPROVED profile text + tags,
 * never memories.
 */

import { generateText, Output } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import type { Redis } from "../_utils/redis.js";
import { redisKeys } from "../../src/shared/redisKeys.js";
import { MATCHMAKER_JUDGE_INSTRUCTIONS } from "../_utils/_aiPrompts.js";
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

export const MAX_PROFILE_CHARS = 600;
export const MIN_PROFILE_CHARS = 20;
export const SHORTLIST_SIZE = 5;
export const MIN_MATCH_SCORE = 60;
/** A drop newer than this blocks a user from being re-paired (idempotent reruns). */
const DROP_COOLDOWN_MS = 6 * 24 * 60 * 60 * 1000;
const DROP_TTL_SECONDS = 14 * 24 * 60 * 60;
const JUDGE_CONCURRENCY = 8;
/** One small OpenAI model for the whole Matchmaker (interview, tags, judge). */
export const MATCHMAKER_MODEL_ID = "gpt-6-luna";
const matchModel = () => openai(MATCHMAKER_MODEL_ID);

export type MatchStatus = "none" | "active" | "paused";
export type MatchResponse = "pending" | "accepted" | "declined";

export interface MatchProfile {
  draft: string | null;
  approved: string | null;
  tags: string[];
  status: MatchStatus;
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
  return { draft: null, approved: null, tags: [], status: "none", updatedAt: 0 };
}

export async function getProfile(
  redis: Redis,
  username: string
): Promise<MatchProfile> {
  const raw = await redis.get(redisKeys.agent.matchProfile(username));
  return parseStored<MatchProfile>(raw) ?? emptyProfile();
}

export async function saveProfile(
  redis: Redis,
  username: string,
  profile: MatchProfile
): Promise<void> {
  await redis.set(
    redisKeys.agent.matchProfile(username),
    JSON.stringify({ ...profile, updatedAt: Date.now() })
  );
  if (profile.status === "active" && profile.approved) {
    await redis.sadd(redisKeys.agent.matchPool(), username);
  } else {
    await redis.srem(redisKeys.agent.matchPool(), username);
  }
}

export async function saveDraft(
  redis: Redis,
  username: string,
  draft: string
): Promise<void> {
  const profile = await getProfile(redis, username);
  await saveProfile(redis, username, {
    ...profile,
    draft: draft.trim().slice(0, MAX_PROFILE_CHARS),
  });
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

/** Leave Matchmaker: drop profile + pending match, keep seen/blocked so blocks stick. */
export async function leaveMatchmaker(redis: Redis, username: string) {
  await redis.srem(redisKeys.agent.matchPool(), username);
  await redis.del(
    redisKeys.agent.matchProfile(username),
    redisKeys.agent.matchDrop(username)
  );
}

/** Account deletion: remove everything. */
export async function deleteAllMatchmakerData(
  redis: Redis,
  username: string
): Promise<number> {
  await redis.srem(redisKeys.agent.matchPool(), username);
  return redis.del(
    redisKeys.agent.matchProfile(username),
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

/** Greedy max-score pairing: best pairs first, each user matched at most once. */
export function pairUp(pairs: ScoredPair[], minScore = MIN_MATCH_SCORE): ScoredPair[] {
  const taken = new Set<string>();
  const result: ScoredPair[] = [];
  for (const pair of [...pairs].sort((x, y) => y.score - x.score)) {
    if (pair.score < minScore) break;
    if (taken.has(pair.a) || taken.has(pair.b)) continue;
    taken.add(pair.a);
    taken.add(pair.b);
    result.push(pair);
  }
  return result;
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
  why: z.string().max(300),
  openerFromA: z.string().max(200),
  openerFromB: z.string().max(200),
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
// Weekly drop
// ---------------------------------------------------------------------------

export interface WeeklyDropStats {
  poolSize: number;
  eligible: number;
  judged: number;
  matched: number;
  judgeErrors: number;
}

export async function runWeeklyDrop(
  redis: Redis,
  { maxJudgeCalls = 300, now = Date.now(), judge = judgePair } = {}
): Promise<WeeklyDropStats> {
  const pool = await redis.smembers<string[]>(redisKeys.agent.matchPool());
  const users: Array<{ username: string; profile: string; tags: string[] }> = [];
  const excludedBy = new Map<string, Set<string>>();

  for (const username of pool) {
    const [profile, drop, seen, blocked] = await Promise.all([
      getProfile(redis, username),
      getDrop(redis, username),
      redis.smembers<string[]>(redisKeys.agent.matchSeen(username)),
      redis.smembers<string[]>(redisKeys.agent.matchBlocked(username)),
    ]);
    if (profile.status !== "active" || !profile.approved) continue;
    if (drop && now - drop.createdAt < DROP_COOLDOWN_MS) continue;
    users.push({ username, profile: profile.approved, tags: profile.tags });
    excludedBy.set(username, new Set([...(seen ?? []), ...(blocked ?? [])]));
  }

  // Exclusions are symmetric: if either side blocked/met the other, skip.
  const isExcluded = (a: string, b: string) =>
    excludedBy.get(a)?.has(b) || excludedBy.get(b)?.has(a);

  const pairKeys = new Set<string>();
  const candidatePairs: Array<[string, string]> = [];
  for (const user of users) {
    const excluded = new Set(
      users.map((u) => u.username).filter((u) => isExcluded(user.username, u))
    );
    for (const other of shortlist(user.username, user.tags, users, excluded)) {
      const key = [user.username, other].sort().join("\n");
      if (pairKeys.has(key)) continue;
      pairKeys.add(key);
      candidatePairs.push([user.username, other]);
    }
  }

  // ponytail: hard cap on judge calls per run; O(pool × shortlist). Batch by
  // region/interest buckets if the pool outgrows it.
  const toJudge = candidatePairs.slice(0, maxJudgeCalls);
  const byName = new Map(users.map((u) => [u.username, u]));
  const scored: ScoredPair[] = [];
  let judgeErrors = 0;
  for (let i = 0; i < toJudge.length; i += JUDGE_CONCURRENCY) {
    const batch = toJudge.slice(i, i + JUDGE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(([a, b]) => judge(byName.get(a)!, byName.get(b)!))
    );
    for (const r of results) {
      if (r.status === "fulfilled") scored.push(r.value);
      else judgeErrors++;
    }
  }

  const matches = pairUp(scored);
  for (const m of matches) {
    const base = { score: m.score, why: m.why, createdAt: now };
    await Promise.all([
      saveDrop(redis, m.a, {
        ...base,
        partner: m.b,
        partnerProfile: byName.get(m.b)!.profile,
        opener: m.openerFromA,
      }),
      saveDrop(redis, m.b, {
        ...base,
        partner: m.a,
        partnerProfile: byName.get(m.a)!.profile,
        opener: m.openerFromB,
      }),
      redis.sadd(redisKeys.agent.matchSeen(m.a), m.b),
      redis.sadd(redisKeys.agent.matchSeen(m.b), m.a),
    ]);
  }

  return {
    poolSize: pool.length,
    eligible: users.length,
    judged: scored.length,
    matched: matches.length,
    judgeErrors,
  };
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
    const won = await redis.set(
      redisKeys.agent.matchRoomLock(username, partner, createdAt),
      "1",
      { nx: true, ex: DROP_TTL_SECONDS }
    );
    if (won) {
      const roomId = await openRoom(redis, [username, partner], drop);
      await redis.hset(pairKey, { roomId });
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
  await Promise.all(sorted.map((m) => setRoomPresence(roomId, m, redis)));
  await broadcastRoomCreated(room);

  const message: Message = {
    id: generateId(),
    roomId,
    username: "ryo",
    content: escapeHTML(
      `matched you two this week 🤝 ${drop.why}`
    ),
    timestamp: getCurrentTimestamp(),
  };
  await addMessage(roomId, message, redis);
  await broadcastNewMessage(roomId, message, room);
  return roomId;
}
