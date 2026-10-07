import { describe, expect, test } from "bun:test";
import { pairUp, rankedCandidatePairs, shortlist, tagOverlap } from "../../../api/matchmaker/_lib";
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

  test("pairUp is greedy by score, one match per user, drops weak pairs", () => {
    const p = (a: string, b: string, score: number) => ({ a, b, score, why: "", openerFromA: "", openerFromB: "" });
    const result = pairUp([p("a", "b", 70), p("a", "c", 90), p("b", "d", 65), p("c", "d", 80), p("e", "f", 40)]);
    expect(result.map((r) => [r.a, r.b])).toEqual([["a", "c"], ["b", "d"]]);
  });

  test("pair keys are order-independent so both sides share one response hash", () => {
    expect(redisKeys.agent.matchPair("bob", "alice", 1)).toBe(redisKeys.agent.matchPair("alice", "bob", 1));
    expect(redisKeys.agent.matchPair("alice", "bob", 1)).toBe("agent:matchmaker:pair:alice:bob:1");
  });

  test("candidate pairs are round-robin by rank so a judge cap is fair", () => {
    const pairs = rankedCandidatePairs([
      { username: "a", candidates: ["b", "c", "d"] },
      { username: "x", candidates: ["y", "z"] },
      { username: "b", candidates: ["a", "c"] },
    ]);
    // Everyone's #1 comes before anyone's #2; a↔b is deduped.
    expect(pairs.slice(0, 2)).toEqual([["a", "b"], ["x", "y"]]);
    expect(pairs.slice(0, 2).flat()).toContain("x");
    expect(pairs).toHaveLength(6); // a-b x-y | a-c x-z b-c | a-d
  });
});
