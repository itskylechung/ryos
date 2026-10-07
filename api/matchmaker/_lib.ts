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

export const MAX_PROFILE_CHARS = 600;
export const MIN_PROFILE_CHARS = 20;
export const SHORTLIST_SIZE = 5;
export const MIN_MATCH_SCORE = 60;
/** A drop newer than this blocks a user from being re-paired (idempotent reruns). */
const DROP_COOLDOWN_MS = 6 * 24 * 60 * 60 * 1000;
const DROP_TTL_SECONDS = 14 * 24 * 60 * 60;
const JUDGE_CONCURRENCY = 8;
/** Longer than any realistic run; only matters if a run crashes mid-way. */
const DROP_LOCK_TTL_SECONDS = 60 * 60;
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
  const [raw, draft] = await redis.mget<unknown>(
    redisKeys.agent.matchProfile(username),
    redisKeys.agent.matchDraft(username)
  );
  const profile = parseStored<MatchProfile>(raw) ?? emptyProfile();
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
    redisKeys.agent.matchDraft(username)
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
// Weekly drop
// ---------------------------------------------------------------------------

export interface WeeklyDropStats {
  poolSize: number;
  eligible: number;
  judged: number;
  /** Candidate pairs dropped by the judge-call cap (0 = everyone judged). */
  unjudged: number;
  matched: number;
  judgeErrors: number;
}

/**
 * Candidate pairs in round-robin rank order: everyone's #1 candidate, then
 * everyone's #2, ... so a judge-call cap trims everyone's long tail evenly
 * instead of starving whoever comes last in pool order.
 */
export function rankedCandidatePairs(
  shortlists: Array<{ username: string; candidates: string[] }>
): Array<[string, string]> {
  const seen = new Set<string>();
  const pairs: Array<[string, string]> = [];
  const depth = Math.max(0, ...shortlists.map((s) => s.candidates.length));
  for (let rank = 0; rank < depth; rank++) {
    for (const { username, candidates } of shortlists) {
      const other = candidates[rank];
      if (!other) continue;
      const key = [username, other].sort().join("\n");
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([username, other]);
    }
  }
  return pairs;
}

export async function runWeeklyDrop(
  redis: Redis,
  { maxJudgeCalls = 300, now = Date.now(), judge = judgePair } = {}
): Promise<WeeklyDropStats | { skipped: "already-running" }> {
  // One run at a time: a retried/overlapping run would compute its own
  // pairings and overwrite drops, leaving mismatched halves.
  const lockKey = redisKeys.agent.matchDropLock();
  const locked = await redis.set(lockKey, String(now), {
    nx: true,
    ex: DROP_LOCK_TTL_SECONDS,
  });
  if (!locked) return { skipped: "already-running" };
  try {
    return await runWeeklyDropLocked(redis, { maxJudgeCalls, now, judge });
  } finally {
    await redis.del(lockKey);
  }
}

async function runWeeklyDropLocked(
  redis: Redis,
  {
    maxJudgeCalls,
    now,
    judge,
  }: { maxJudgeCalls: number; now: number; judge: typeof judgePair }
): Promise<WeeklyDropStats> {
  const pool = await redis.smembers<string[]>(redisKeys.agent.matchPool());
  if (pool.length === 0) {
    return { poolSize: 0, eligible: 0, judged: 0, unjudged: 0, matched: 0, judgeErrors: 0 };
  }

  // Batched reads: profiles + drops in two round trips.
  const [profiles, drops] = await Promise.all([
    redis.mget<unknown>(...pool.map((u) => redisKeys.agent.matchProfile(u))),
    redis.mget<unknown>(...pool.map((u) => redisKeys.agent.matchDrop(u))),
  ]);
  const users: Array<{ username: string; profile: string; tags: string[] }> = [];
  pool.forEach((username, i) => {
    const profile = parseStored<MatchProfile>(profiles[i]);
    const drop = parseStored<StoredMatchDrop>(drops[i]);
    if (profile?.status !== "active" || !profile.approved) return;
    if (drop && now - drop.createdAt < DROP_COOLDOWN_MS) return;
    users.push({ username, profile: profile.approved, tags: profile.tags });
  });

  // ponytail: one parallel burst of 2 SMEMBERS per eligible user; chunk it if
  // pools reach the thousands.
  const exclusions = await Promise.all(
    users.map(({ username }) =>
      Promise.all([
        redis.smembers<string[]>(redisKeys.agent.matchSeen(username)),
        redis.smembers<string[]>(redisKeys.agent.matchBlocked(username)),
      ])
    )
  );
  const excludedBy = new Map(
    users.map((u, i) => [u.username, new Set(exclusions[i].flat())])
  );

  // Exclusions are symmetric: if either side blocked/met the other, skip.
  const isExcluded = (a: string, b: string) =>
    excludedBy.get(a)?.has(b) || excludedBy.get(b)?.has(a);

  const candidatePairs = rankedCandidatePairs(
    users.map((user) => ({
      username: user.username,
      candidates: shortlist(
        user.username,
        user.tags,
        users,
        new Set(users.map((u) => u.username).filter((u) => isExcluded(user.username, u)))
      ),
    }))
  );

  // ponytail: hard cap on judge calls per run; round-robin order keeps it
  // fair. Batch by region/interest buckets if `unjudged` stays > 0.
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
    unjudged: candidatePairs.length - toJudge.length,
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
