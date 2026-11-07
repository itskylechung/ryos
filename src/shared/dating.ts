/**
 * Dating basics for Nee Hao Fine Shyt (api/matchmaker): the structured half of
 * a profile, shared by the interview agent, the Profile form, and matching.
 * See docs/proposals/dating-flow.md.
 */

import { z } from "zod";

export const MIN_AGE = 18;
export const MAX_PHOTOS = 4;

export const GENDERS = ["woman", "man", "nonbinary"] as const;
/** Taipei City only for the pilot. */
export const TAIPEI_DISTRICTS = [
  "zhongzheng",
  "datong",
  "zhongshan",
  "songshan",
  "daan",
  "wanhua",
  "xinyi",
  "shilin",
  "beitou",
  "neihu",
  "nangang",
  "wenshan",
] as const;
export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const DAY_PARTS = ["morning", "afternoon", "evening"] as const;
export const AVAILABILITY_SLOTS = DAYS.flatMap((d) =>
  DAY_PARTS.map((p) => `${d}-${p}` as const)
);
export const DATE_STYLES = ["coffee", "drinks", "food", "walk", "activity"] as const;

export type Gender = (typeof GENDERS)[number];
export type TaipeiDistrict = (typeof TAIPEI_DISTRICTS)[number];
export type AvailabilitySlot = (typeof AVAILABILITY_SLOTS)[number];
export type DateStyle = (typeof DATE_STYLES)[number];

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "invalid date");

/** Every field optional: the interview fills basics in one answer at a time. */
export const datingBasicsSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  birthdate: isoDate.optional(),
  gender: z.enum(GENDERS).optional(),
  interestedIn: z.array(z.enum(GENDERS)).max(GENDERS.length).optional(),
  ageMin: z.number().int().min(MIN_AGE).max(99).optional(),
  ageMax: z.number().int().min(MIN_AGE).max(99).optional(),
  district: z.enum(TAIPEI_DISTRICTS).optional(),
  availability: z.array(z.enum(AVAILABILITY_SLOTS)).max(AVAILABILITY_SLOTS.length).optional(),
  dateStyles: z.array(z.enum(DATE_STYLES)).max(DATE_STYLES.length).optional(),
  dealbreakers: z.string().trim().max(200).optional(),
});

export type DatingBasics = z.infer<typeof datingBasicsSchema>;

const REQUIRED = [
  "name",
  "birthdate",
  "gender",
  "interestedIn",
  "ageMin",
  "ageMax",
  "district",
  "availability",
  "dateStyles",
] as const satisfies ReadonlyArray<keyof DatingBasics>;

/** Required fields still empty (arrays count as empty when they have no items). */
export function missingBasics(b: DatingBasics): Array<(typeof REQUIRED)[number]> {
  return REQUIRED.filter((k) => {
    const v = b[k];
    return v === undefined || (Array.isArray(v) && v.length === 0);
  });
}

/** Whole years old on `now` (UTC). */
export function ageOn(birthdate: string, now = Date.now()): number {
  const birth = new Date(`${birthdate}T00:00:00Z`);
  const today = new Date(now);
  let age = today.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday =
    today.getUTCMonth() < birth.getUTCMonth() ||
    (today.getUTCMonth() === birth.getUTCMonth() && today.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) age--;
  return age;
}

export const isAdult = (birthdate: string, now = Date.now()) =>
  ageOn(birthdate, now) >= MIN_AGE;

/**
 * Hard filters before any AI scoring: both complete and 18+, each wants the
 * other's gender and age, and they share at least one free slot.
 */
export function isCompatible(a: DatingBasics, b: DatingBasics, now = Date.now()): boolean {
  if (missingBasics(a).length || missingBasics(b).length) return false;
  const ageA = ageOn(a.birthdate!, now);
  const ageB = ageOn(b.birthdate!, now);
  if (ageA < MIN_AGE || ageB < MIN_AGE) return false;
  const wants = (x: DatingBasics, gender: Gender, age: number) =>
    x.interestedIn!.includes(gender) && age >= x.ageMin! && age <= x.ageMax!;
  if (!wants(a, b.gender!, ageB) || !wants(b, a.gender!, ageA)) return false;
  return a.availability!.some((slot) => b.availability!.includes(slot));
}
