import { describe, expect, test } from "bun:test";
import { isValidPhoto, shortlist, tagOverlap } from "../../../api/matchmaker/_lib";
import { redisKeys } from "../../../src/shared/redisKeys";

describe("matchmaker pairing", () => {
  test("tagOverlap is Jaccard", () => {
    expect(tagOverlap(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(tagOverlap([], ["a"])).toBe(0);
  });

  test("shortlist ranks by overlap, skips self and excluded, keeps zero-overlap fillers", () => {
    const pool = [
      { username: "me", tags: ["synth", "react"] },
      { username: "best", tags: ["synth", "react"] },
      { username: "some", tags: ["synth", "go"] },
      { username: "blocked", tags: ["synth", "react"] },
      { username: "none", tags: ["knitting"] },
    ];
    expect(shortlist("me", ["synth", "react"], pool, new Set(["blocked"]), 3)).toEqual([
      "best",
      "some",
      "none",
    ]);
  });

  test("photos must be small image data URLs", () => {
    expect(isValidPhoto("data:image/jpeg;base64,/9j/4AAQSkZJRg==")).toBe(true);
    expect(isValidPhoto("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
    expect(isValidPhoto("https://example.com/me.jpg")).toBe(false);
    expect(isValidPhoto(`data:image/jpeg;base64,${"A".repeat(200_001)}`)).toBe(false);
  });

  test("pair keys are order-independent so both sides share one response hash", () => {
    expect(redisKeys.agent.matchPair("bob", "alice", 1)).toBe(redisKeys.agent.matchPair("alice", "bob", 1));
    expect(redisKeys.agent.matchPair("alice", "bob", 1)).toBe("agent:matchmaker:pair:alice:bob:1");
  });
});
