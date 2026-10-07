import { describe, expect, test } from "bun:test";
import {
  getDrop,
  respondToDrop,
  runWeeklyDrop,
  saveProfile,
  type ScoredPair,
} from "../../../api/matchmaker/_lib";
import type { Redis } from "../../../api/_utils/redis";

/** Just enough Redis for the matchmaker store. */
function fakeRedis(): Redis {
  const kv = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Record<string, string>>();
  const set = (k: string) => sets.get(k) ?? sets.set(k, new Set()).get(k)!;
  return {
    get: async (k: string) => kv.get(k) ?? null,
    set: async (k: string, v: unknown, o?: { nx?: boolean }) => {
      if (o?.nx && kv.has(k)) return null;
      kv.set(k, v);
      return "OK";
    },
    del: async (...ks: string[]) => ks.filter((k) => kv.delete(k) || sets.delete(k)).length,
    expire: async () => 1,
    sadd: async (k: string, ...m: string[]) => (m.forEach((x) => set(k).add(x)), m.length),
    srem: async (k: string, ...m: string[]) => (m.forEach((x) => set(k).delete(x)), m.length),
    smembers: async (k: string) => [...set(k)],
    hset: async (k: string, f: Record<string, string>) => (hashes.set(k, { ...hashes.get(k), ...f }), 1),
    hgetall: async (k: string) => hashes.get(k) ?? null,
  } as unknown as Redis;
}

const join = (redis: Redis, username: string, tags: string[], status: "active" | "paused" = "active") =>
  saveProfile(redis, username, { draft: null, approved: `i am ${username}`, tags, status, updatedAt: 0 });

// Deterministic judge: likes pairs that share the first tag.
const judge = async (a: { username: string }, b: { username: string }): Promise<ScoredPair> => ({
  a: a.username,
  b: b.username,
  score: a.username[0] === b.username[0] ? 90 : 30,
  why: "you both build things",
  openerFromA: `hi from ${a.username}`,
  openerFromB: `hi from ${b.username}`,
});

describe("matchmaker weekly flow", () => {
  test("drop → both accept → exactly one room, even when accepts race", async () => {
    const redis = fakeRedis();
    await join(redis, "ann", ["synth"]);
    await join(redis, "amy", ["synth"]);
    await join(redis, "bob", ["knit"]);
    await join(redis, "pat", ["synth"], "paused");

    const stats = await runWeeklyDrop(redis, { judge });
    expect(stats).toMatchObject({ eligible: 3, matched: 1 });
    expect((await getDrop(redis, "ann"))?.partner).toBe("amy");
    // Each side gets the icebreaker written in their own voice.
    const pairOpeners = [(await getDrop(redis, "ann"))?.opener, (await getDrop(redis, "amy"))?.opener];
    expect(pairOpeners.sort()).toEqual(["hi from amy", "hi from ann"]);
    expect((await getDrop(redis, "ann"))?.opener).toMatch(/ann/);
    expect(await getDrop(redis, "bob")).toBeNull(); // weak match → no drop
    expect(await getDrop(redis, "pat")).toBeNull(); // paused → not paired

    const rooms: string[][] = [];
    const openRoom = async (_r: Redis, members: string[]) => (rooms.push(members), "room-1");
    const [annView] = await Promise.all([
      respondToDrop(redis, "ann", "accept", openRoom),
      respondToDrop(redis, "amy", "accept", openRoom),
    ]);
    expect(rooms).toHaveLength(1);
    expect(annView?.myResponse).toBe("accepted");
    expect((await getDrop(redis, "amy"))?.roomId).toBe("room-1");

    // Rerun within the week is a no-op; next week they are never re-paired.
    expect((await runWeeklyDrop(redis, { judge })).matched).toBe(0);
    const later = Date.now() + 8 * 24 * 60 * 60 * 1000;
    expect((await runWeeklyDrop(redis, { judge, now: later })).matched).toBe(0);
  });

  test("decline never opens a room; block stops future pairing", async () => {
    const redis = fakeRedis();
    await join(redis, "ann", ["synth"]);
    await join(redis, "amy", ["synth"]);
    await runWeeklyDrop(redis, { judge });

    let opened = false;
    const openRoom = async () => ((opened = true), "x");
    await respondToDrop(redis, "ann", "block", openRoom);
    const amy = await respondToDrop(redis, "amy", "accept", openRoom);
    expect(opened).toBe(false);
    expect(amy?.partnerResponse).toBe("declined");
  });
});
