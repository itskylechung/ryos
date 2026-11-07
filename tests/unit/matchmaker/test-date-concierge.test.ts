import { describe, expect, test } from "bun:test";
import {
  confirmProposal,
  findFreeTimes,
  getProposal,
  pickVenues,
} from "../../../api/matchmaker/_concierge";
import { redisKeys } from "../../../src/shared/redisKeys";
import type { Redis } from "../../../api/_utils/redis";
import type { DatingBasics } from "../../../src/shared/dating";

// Saturday 2026-11-07 09:00 in Taipei (01:00 UTC).
const NOW = Date.parse("2026-11-07T01:00:00Z");

const mei: DatingBasics = {
  district: "daan",
  availability: ["sat-afternoon", "sat-evening", "mon-evening", "fri-evening"],
  dateStyles: ["coffee", "walk"],
};
const ivy: DatingBasics = {
  district: "zhongshan",
  availability: ["sat-evening", "mon-evening", "fri-evening", "sun-morning"],
  dateStyles: ["coffee", "activity"],
};

function fakeRedis(): Redis {
  const kv = new Map<string, unknown>();
  return {
    get: async (k: string) => kv.get(k) ?? null,
    set: async (k: string, v: unknown) => (kv.set(k, v), "OK"),
  } as unknown as Redis;
}

describe("date concierge", () => {
  test("free times are shared slots, soonest first, skipping calendar clashes", () => {
    const times = findFreeTimes(mei, ivy, [], NOW);
    expect(times.map((t) => `${t.date} ${t.startTime}`)).toEqual([
      "2026-11-07 19:00", // Sat evening (shared)
      "2026-11-09 19:00", // Mon
      "2026-11-13 19:00", // Fri (today + 6 is the last day looked at)
    ]);
    // Ivy has dinner booked Saturday 18:30–20:00 → Saturday drops out.
    const busy = [{ date: "2026-11-07", startTime: "18:30", endTime: "20:00" }];
    expect(findFreeTimes(mei, ivy, busy, NOW)[0].date).toBe("2026-11-09");
    // All-day events don't block.
    expect(findFreeTimes(mei, ivy, [{ date: "2026-11-07" }], NOW)[0].date).toBe("2026-11-07");
  });

  test("today's slot needs an hour's notice", () => {
    const at1830 = Date.parse("2026-11-07T10:30:00Z"); // 18:30 Taipei
    expect(findFreeTimes(mei, ivy, [], at1830)[0].date).toBe("2026-11-09");
  });

  test("venues match shared styles, prefer their districts, and go indoor in rain", () => {
    const venues = pickVenues(mei, ivy);
    expect(venues.every((v) => v.styles.includes("coffee"))).toBe(true); // only shared style
    expect(["daan", "zhongshan"]).toContain(venues[0].district);
    expect(pickVenues(mei, ivy, { indoorOnly: true }).every((v) => v.indoor)).toBe(true);
  });

  test("a date locks only when both say yes, then lands on both calendars once", async () => {
    const redis = fakeRedis();
    const room = "room-1";
    await redis.set(
      redisKeys.agent.matchProposal(room),
      JSON.stringify({ date: "2026-11-09", startTime: "19:00", venueId: "fika-fika", proposedBy: "mei", confirmed: [], status: "proposed", createdAt: 0 })
    );
    const writes: Array<{ user: string; title: string; endTime: string }> = [];
    const add = async (_r: Redis, user: string, e: { title: string; endTime: string }) => {
      writes.push({ user, title: e.title, endTime: e.endTime });
    };
    const names = { mei: "Mei", ivy: "Ivy" };

    expect((await confirmProposal(redis, room, "mei", ["mei", "ivy"], names, add)).status).toBe("waiting");
    expect((await confirmProposal(redis, room, "mei", ["mei", "ivy"], names, add)).status).toBe("waiting");
    expect(writes).toHaveLength(0);
    expect((await confirmProposal(redis, room, "ivy", ["mei", "ivy"], names, add)).status).toBe("locked");
    expect(writes).toEqual([
      { user: "mei", title: "Date with Ivy", endTime: "21:00" },
      { user: "ivy", title: "Date with Mei", endTime: "21:00" },
    ]);
    expect((await confirmProposal(redis, room, "ivy", ["mei", "ivy"], names, add)).status).toBe("already_locked");
    expect(writes).toHaveLength(2);
    expect((await getProposal(redis, room))?.status).toBe("locked");
  });

  test("confirming with no proposal does nothing", async () => {
    const out = await confirmProposal(fakeRedis(), "room-x", "mei", ["mei", "ivy"], {}, async () => {
      throw new Error("should not write");
    });
    expect(out.status).toBe("none");
  });
});
