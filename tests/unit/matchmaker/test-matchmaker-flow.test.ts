import { describe, expect, test } from "bun:test";
import {
  createMatch,
  getDrop,
  getPhotos,
  getProfile,
  leaveMatchmaker,
  respondToDrop,
  saveBasics,
  saveDraft,
  savePhotos,
  saveProfile,
  type ScoredPair,
} from "../../../api/matchmaker/_lib";
import { redisKeys } from "../../../src/shared/redisKeys";
import type { Redis } from "../../../api/_utils/redis";

/** Just enough Redis for the matchmaker store. */
function fakeRedis(): Redis {
  const kv = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Record<string, string>>();
  const set = (k: string) => sets.get(k) ?? sets.set(k, new Set()).get(k)!;
  return {
    get: async (k: string) => kv.get(k) ?? null,
    mget: async (...ks: string[]) => ks.map((k) => kv.get(k) ?? null),
    set: async (k: string, v: unknown, o?: { nx?: boolean }) => {
      if (o?.nx && kv.has(k)) return null;
      kv.set(k, v);
      return "OK";
    },
    del: async (...ks: string[]) =>
      ks.filter((k) => kv.delete(k) || sets.delete(k) || hashes.delete(k)).length,
    expire: async () => 1,
    sadd: async (k: string, ...m: string[]) => (m.forEach((x) => set(k).add(x)), m.length),
    srem: async (k: string, ...m: string[]) => (m.forEach((x) => set(k).delete(x)), m.length),
    smembers: async (k: string) => [...set(k)],
    hset: async (k: string, f: Record<string, string>) => (hashes.set(k, { ...hashes.get(k), ...f }), 1),
    hgetall: async (k: string) => hashes.get(k) ?? null,
  } as unknown as Redis;
}

const join = (redis: Redis, username: string, tags: string[], status: "active" | "paused" = "active") =>
  saveProfile(redis, username, { draft: null, approved: `i am ${username}`, tags, status, basics: {}, updatedAt: 0 });

const pair = (a: string, b: string): ScoredPair => ({
  a,
  b,
  score: 90,
  why: "you both build things",
  openerFromA: `hi from ${a}`,
  openerFromB: `hi from ${b}`,
});

/** Match two pool members the way the date-plan flow will. */
const match = (redis: Redis, a: string, b: string) =>
  createMatch(redis, pair(a, b), { a: `i am ${a}`, b: `i am ${b}` });

describe("matchmaker match flow", () => {
  test("match → both accept → exactly one room, even when accepts race", async () => {
    const redis = fakeRedis();
    await join(redis, "ann", ["synth"]);
    await join(redis, "amy", ["synth"]);
    await match(redis, "ann", "amy");

    expect((await getDrop(redis, "ann"))?.partner).toBe("amy");
    expect((await getDrop(redis, "amy"))?.partnerProfile).toBe("i am ann");
    // Each side gets the icebreaker written in their own voice.
    expect((await getDrop(redis, "ann"))?.opener).toBe("hi from ann");
    expect((await getDrop(redis, "amy"))?.opener).toBe("hi from amy");
    expect(await redis.smembers(redisKeys.agent.matchSeen("ann"))).toContain("amy");

    const rooms: string[][] = [];
    const openRoom = async (_r: Redis, members: string[]) => (rooms.push(members), "room-1");
    const [annView] = await Promise.all([
      respondToDrop(redis, "ann", "accept", openRoom),
      respondToDrop(redis, "amy", "accept", openRoom),
    ]);
    expect(rooms).toHaveLength(1);
    expect(annView?.myResponse).toBe("accepted");
    expect((await getDrop(redis, "amy"))?.roomId).toBe("room-1");
  });

  test("decline never opens a room; block is recorded", async () => {
    const redis = fakeRedis();
    await join(redis, "ann", ["synth"]);
    await join(redis, "amy", ["synth"]);
    await match(redis, "ann", "amy");

    let opened = false;
    const openRoom = async () => ((opened = true), "x");
    await respondToDrop(redis, "ann", "block", openRoom);
    const amy = await respondToDrop(redis, "amy", "accept", openRoom);
    expect(opened).toBe(false);
    expect(amy?.partnerResponse).toBe("declined");
    expect(await redis.smembers(redisKeys.agent.matchBlocked("ann"))).toContain("amy");
  });

  test("basics merge piece by piece without touching approval", async () => {
    const redis = fakeRedis();
    await join(redis, "ann", ["synth"]);
    await saveBasics(redis, "ann", { name: "Ann", district: "xinyi" });
    await saveBasics(redis, "ann", { availability: ["fri-evening"] });
    const profile = await getProfile(redis, "ann");
    expect(profile.basics).toEqual({ name: "Ann", district: "xinyi", availability: ["fri-evening"] });
    expect(profile).toMatchObject({ status: "active", approved: "i am ann" });
  });

  test("agent draft saves never clobber an approval made meanwhile", async () => {
    const redis = fakeRedis();
    await join(redis, "ann", ["synth"]);
    await saveDraft(redis, "ann", "new draft text from the agent");
    const profile = await getProfile(redis, "ann");
    expect(profile).toMatchObject({ status: "active", approved: "i am ann", draft: "new draft text from the agent" });
    expect(await redis.smembers(redisKeys.agent.matchPool())).toContain("ann");
  });

  test("leaving removes your photos and the partner's copy of your profile", async () => {
    const redis = fakeRedis();
    await join(redis, "ann", ["synth"]);
    await join(redis, "amy", ["synth"]);
    await savePhotos(redis, "ann", ["data:image/jpeg;base64,AAAA"]);
    await match(redis, "ann", "amy");
    expect((await getDrop(redis, "amy"))?.partnerProfile).toBe("i am ann");
    await leaveMatchmaker(redis, "ann");
    expect(await getDrop(redis, "amy")).toBeNull();
    expect(await getDrop(redis, "ann")).toBeNull();
    expect(await getPhotos(redis, "ann")).toEqual([]);
  });

  test("a failed room creation releases the lock so a retry can succeed", async () => {
    const redis = fakeRedis();
    await join(redis, "ann", ["synth"]);
    await join(redis, "amy", ["synth"]);
    await match(redis, "ann", "amy");
    await respondToDrop(redis, "ann", "accept");
    const boom = async (): Promise<string> => {
      throw new Error("redis blip");
    };
    await expect(respondToDrop(redis, "amy", "accept", boom)).rejects.toThrow("redis blip");
    const healed = await respondToDrop(redis, "amy", "accept", async () => "room-2");
    expect(healed?.roomId).toBe("room-2");
  });
});
