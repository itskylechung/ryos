import { describe, expect, test } from "bun:test";
import {
  ageOn,
  datingBasicsSchema,
  isAdult,
  isCompatible,
  missingBasics,
  type DatingBasics,
} from "../../../src/shared/dating";

const NOW = Date.parse("2026-11-07T12:00:00Z");

const person = (over: Partial<DatingBasics> = {}): DatingBasics => ({
  name: "Ann",
  birthdate: "1996-05-01", // 30
  gender: "woman",
  interestedIn: ["man"],
  ageMin: 25,
  ageMax: 35,
  district: "xinyi",
  availability: ["fri-evening", "sat-afternoon"],
  dateStyles: ["coffee"],
  ...over,
});

describe("dating basics", () => {
  test("age counts whole years and respects the birthday", () => {
    expect(ageOn("2008-11-07", NOW)).toBe(18);
    expect(ageOn("2008-11-08", NOW)).toBe(17);
    expect(isAdult("2008-11-07", NOW)).toBe(true);
    expect(isAdult("2008-11-08", NOW)).toBe(false);
  });

  test("missing lists required fields and treats empty lists as missing", () => {
    expect(missingBasics(person())).toEqual([]);
    expect(missingBasics({ name: "Ann", availability: [] })).toEqual([
      "birthdate", "gender", "interestedIn", "ageMin", "ageMax", "district", "availability", "dateStyles",
    ]);
  });

  test("schema rejects under-18 age ranges, unknown districts, and bad dates", () => {
    expect(datingBasicsSchema.safeParse({ ageMin: 17 }).success).toBe(false);
    expect(datingBasicsSchema.safeParse({ district: "taichung" }).success).toBe(false);
    expect(datingBasicsSchema.safeParse({ birthdate: "1996-13-40" }).success).toBe(false);
    expect(datingBasicsSchema.safeParse({ availability: ["fri-evening"] }).success).toBe(true);
  });

  test("compatible needs mutual interest, mutual age range, and a shared free slot", () => {
    const ann = person();
    const ben = person({ name: "Ben", gender: "man", interestedIn: ["woman"], birthdate: "1994-01-01" }); // 32
    expect(isCompatible(ann, ben, NOW)).toBe(true);
    expect(isCompatible(ben, ann, NOW)).toBe(true);

    expect(isCompatible(ann, { ...ben, interestedIn: ["man"] }, NOW)).toBe(false); // he isn't into women
    expect(isCompatible(ann, { ...ben, birthdate: "1980-01-01" }, NOW)).toBe(false); // 46: outside her range
    expect(isCompatible(ann, { ...ben, ageMin: 31 }, NOW)).toBe(false); // she's 30: outside his range
    expect(isCompatible(ann, { ...ben, availability: ["mon-morning"] }, NOW)).toBe(false); // never free together
    expect(isCompatible(ann, { ...ben, birthdate: "2009-01-01" }, NOW)).toBe(false); // under 18
    expect(isCompatible(ann, { ...ben, district: undefined }, NOW)).toBe(false); // incomplete
  });
});
