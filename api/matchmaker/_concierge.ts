/**
 * Date concierge: Ryo inside a matched pair's private room. When either person
 * @-mentions Ryo, it can find times both are free (availability + both
 * Calendars), suggest hand-picked venues, check the weather, propose one plan,
 * and — only once BOTH say yes — put the date on both Calendars.
 * See docs/proposals/dating-flow.md ("After the match", scenario 1).
 */

import { generateText, isStepCount, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import type { Redis } from "../_utils/redis.js";
import { redisKeys } from "../../src/shared/redisKeys.js";
import type { DatingBasics, DateStyle } from "../../src/shared/dating.js";
import { applyCalendarToolAction } from "../../src/shared/tools/calendar.js";
import {
  readCalendarToolState,
  writeCalendarToolState,
} from "../sync/v2/_tool-state.js";
import { executeGetWeather } from "../chat/tools/weather-executor.js";
import { DATE_CONCIERGE_INSTRUCTIONS } from "../_utils/_aiPrompts.js";
import { getProfile, MATCHMAKER_MODEL_ID } from "./_lib.js";
import { TAIPEI_VENUES, type Venue } from "./_venues.js";

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DATE_LENGTH_MINUTES = 120;
const SLOT_START = { morning: "10:00", afternoon: "14:00", evening: "19:00" } as const;
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export interface BusyEvent {
  date: string;
  startTime?: string;
  endTime?: string;
}

export interface FreeTime {
  date: string; // YYYY-MM-DD (Taipei)
  day: string; // mon…sun
  part: keyof typeof SLOT_START;
  startTime: string; // HH:MM (Taipei)
}

export interface DateProposal {
  date: string;
  startTime: string;
  venueId: string;
  proposedBy: string;
  confirmed: string[];
  status: "proposed" | "locked";
  createdAt: number;
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const toHHMM = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * Slots in the next 7 days (Taipei time) that both people marked as usually
 * free and neither has a timed Calendar event overlapping. All-day events
 * don't block (birthdays, holidays).
 */
export function findFreeTimes(
  a: DatingBasics,
  b: DatingBasics,
  busy: BusyEvent[],
  now = Date.now(),
  limit = 6
): FreeTime[] {
  const shared = (a.availability ?? []).filter((s) => (b.availability ?? []).includes(s));
  const local = new Date(now + TAIPEI_OFFSET_MS);
  const nowMinutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const out: FreeTime[] = [];
  for (let offset = 0; offset < 7 && out.length < limit; offset++) {
    const day = new Date(local.getTime() + offset * 86_400_000);
    const date = day.toISOString().slice(0, 10);
    const dayKey = DAY_KEYS[day.getUTCDay()];
    for (const part of ["morning", "afternoon", "evening"] as const) {
      if (!shared.includes(`${dayKey}-${part}` as never)) continue;
      const start = toMinutes(SLOT_START[part]);
      if (offset === 0 && start <= nowMinutes + 60) continue; // need at least an hour's notice
      const end = start + DATE_LENGTH_MINUTES;
      const clash = busy.some((e) => {
        if (e.date !== date || !e.startTime) return false;
        const s = toMinutes(e.startTime);
        const f = e.endTime ? toMinutes(e.endTime) : s + 60;
        return s < end && f > start;
      });
      if (!clash) out.push({ date, day: dayKey, part, startTime: SLOT_START[part] });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * Venues both would enjoy (shared date styles, falling back to either's),
 * in either person's district first. Rain → indoor only.
 */
export function pickVenues(
  a: DatingBasics,
  b: DatingBasics,
  { indoorOnly = false, style }: { indoorOnly?: boolean; style?: DateStyle } = {},
  limit = 4
): Venue[] {
  const as = a.dateStyles ?? [];
  const bs = b.dateStyles ?? [];
  const both = as.filter((s) => bs.includes(s));
  const wanted = style ? [style] : both.length ? both : [...new Set([...as, ...bs])];
  const homes = [a.district, b.district];
  return TAIPEI_VENUES.filter(
    (v) => (!indoorOnly || v.indoor) && v.styles.some((s) => wanted.includes(s))
  )
    .sort((x, y) => Number(homes.includes(y.district)) - Number(homes.includes(x.district)))
    .slice(0, limit);
}

export const mapsLink = (v: Venue) =>
  `https://maps.apple.com/?q=${encodeURIComponent(`${v.name}, Taipei`)}`;

export async function getProposal(redis: Redis, roomId: string): Promise<DateProposal | null> {
  const raw = await redis.get(redisKeys.agent.matchProposal(roomId));
  if (!raw) return null;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as DateProposal;
}

async function saveProposal(redis: Redis, roomId: string, p: DateProposal) {
  await redis.set(redisKeys.agent.matchProposal(roomId), JSON.stringify(p));
}

/** Adds a timed event to one person's synced Calendar (works before they've ever opened Calendar). */
export async function addDateToCalendar(
  redis: Redis,
  username: string,
  event: { title: string; date: string; startTime: string; endTime: string; location: string; notes: string }
): Promise<void> {
  const state = (await readCalendarToolState(redis, username)) ?? {
    events: [],
    calendars: [],
    todos: [],
  };
  const result = applyCalendarToolAction(
    state as unknown as Parameters<typeof applyCalendarToolAction>[0],
    { action: "create", ...event },
    {
      generateId: () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      now: () => Date.now(),
      deletedAt: () => new Date().toISOString(),
    }
  );
  if (!result.ok) throw new Error(`calendar_${"error" in result ? result.error : "failed"}`);
  await writeCalendarToolState(redis, username, {
    events: result.state.events as unknown as Array<Record<string, unknown>>,
    calendars: result.state.calendars as unknown as Array<Record<string, unknown>>,
    todos: result.state.todos as unknown as Array<Record<string, unknown>>,
  });
}

/**
 * Record one person's yes. Returns "locked" exactly once — when the second
 * member confirms — after writing the date to both Calendars.
 */
export async function confirmProposal(
  redis: Redis,
  roomId: string,
  username: string,
  members: string[],
  names: Record<string, string>,
  addToCalendar = addDateToCalendar
): Promise<{ status: "none" | "waiting" | "locked" | "already_locked"; proposal?: DateProposal }> {
  const proposal = await getProposal(redis, roomId);
  if (!proposal) return { status: "none" };
  if (proposal.status === "locked") return { status: "already_locked", proposal };
  if (!proposal.confirmed.includes(username)) proposal.confirmed.push(username);
  if (!members.every((m) => proposal.confirmed.includes(m))) {
    await saveProposal(redis, roomId, proposal);
    return { status: "waiting", proposal };
  }
  // ponytail: read-modify-write; two simultaneous last "yes" messages could
  // both lock. Add an NX lock (like respondToDrop) if that shows up.
  proposal.status = "locked";
  await saveProposal(redis, roomId, proposal);
  const venue = TAIPEI_VENUES.find((v) => v.id === proposal.venueId)!;
  const endTime = toHHMM(toMinutes(proposal.startTime) + DATE_LENGTH_MINUTES);
  await Promise.all(
    members.map((m) => {
      const other = members.find((x) => x !== m)!;
      return addToCalendar(redis, m, {
        title: `Date with ${names[other] ?? other}`,
        date: proposal.date,
        startTime: proposal.startTime,
        endTime,
        location: venue.name,
        notes: `${venue.blurb}\n${mapsLink(venue)}\nPlanned by Ryo in Nee Hao Fine Shyt`,
      });
    })
  );
  return { status: "locked", proposal };
}

/** Run Ryo as date concierge for one @ryo message in a date room. Returns Ryo's reply text. */
export async function runDateConcierge({
  redis,
  roomId,
  members,
  requester,
  prompt,
  recentMessages,
  log,
  logError,
}: {
  redis: Redis;
  roomId: string;
  members: string[];
  requester: string;
  prompt: string;
  recentMessages: string;
  log: (...args: unknown[]) => void;
  logError: (...args: unknown[]) => void;
}): Promise<string> {
  const [a, b] = members;
  const [pa, pb] = await Promise.all([getProfile(redis, a), getProfile(redis, b)]);
  const names = { [a]: pa.basics.name ?? a, [b]: pb.basics.name ?? b };

  const tools = {
    findFreeTimes: tool({
      description: "Times in the next 7 days when both are usually free and neither Calendar is busy.",
      inputSchema: z.object({}),
      execute: async () => {
        const [ca, cb] = await Promise.all([
          readCalendarToolState(redis, a),
          readCalendarToolState(redis, b),
        ]);
        const busy = [...(ca?.events ?? []), ...(cb?.events ?? [])] as unknown as BusyEvent[];
        return { times: findFreeTimes(pa.basics, pb.basics, busy) };
      },
    }),
    suggestVenues: tool({
      description: "Hand-picked Taipei venues that fit both. Only ever propose venues from this list.",
      inputSchema: z.object({
        indoorOnly: z.boolean().optional().describe("true when rain is forecast"),
        style: z.enum(["coffee", "drinks", "food", "walk", "activity"]).optional(),
      }),
      execute: async (input) => ({
        venues: pickVenues(pa.basics, pb.basics, input).map((v) => ({ ...v, maps: mapsLink(v) })),
      }),
    }),
    checkWeather: tool({
      description: "5-day Taipei forecast, to avoid outdoor plans in the rain.",
      inputSchema: z.object({}),
      execute: async () => {
        const w = await executeGetWeather({ location: "Taipei" } as never, {
          log,
          logError,
          env: {},
          username: requester,
          redis,
        });
        return { forecast: w.forecast ?? [], message: w.message };
      },
    }),
    proposeDate: tool({
      description: "Propose ONE concrete plan. Replaces any earlier unlocked proposal; both must then say yes.",
      inputSchema: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        venueId: z.string(),
      }),
      execute: async ({ date, startTime, venueId }) => {
        const venue = TAIPEI_VENUES.find((v) => v.id === venueId);
        if (!venue) return { ok: false, error: "unknown venueId; use suggestVenues" };
        const existing = await getProposal(redis, roomId);
        if (existing?.status === "locked") return { ok: false, error: "a date is already locked" };
        await saveProposal(redis, roomId, {
          date,
          startTime,
          venueId,
          proposedBy: requester,
          confirmed: [],
          status: "proposed",
          createdAt: Date.now(),
        });
        return { ok: true, venue: venue.name, maps: mapsLink(venue), askBothToReply: "@ryo yes" };
      },
    }),
    confirmDate: tool({
      description: `Record that ${names[requester] ?? requester} (the person talking to you now) says yes to the current proposal.`,
      inputSchema: z.object({}),
      execute: async () => {
        const result = await confirmProposal(redis, roomId, requester, members, names);
        const waitingOn = result.proposal
          ? members.filter((m) => !result.proposal!.confirmed.includes(m)).map((m) => names[m])
          : [];
        return { status: result.status, waitingOn };
      },
    }),
  };

  const proposal = await getProposal(redis, roomId);
  const today = new Date(Date.now() + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
  const describe = (u: string, b: DatingBasics) =>
    `@${u} = ${names[u]} (district ${b.district}, likes ${b.dateStyles?.join("/")})`;

  const { text } = await generateText({
    model: openai(MATCHMAKER_MODEL_ID),
    instructions: DATE_CONCIERGE_INSTRUCTIONS,
    tools,
    stopWhen: isStepCount(6),
    prompt:
      `TODAY (Taipei): ${today}\n` +
      `PEOPLE: ${describe(a, pa.basics)}; ${describe(b, pb.basics)}\n` +
      `TALKING TO YOU NOW: @${requester} (${names[requester]})\n` +
      `CURRENT PROPOSAL: ${proposal ? JSON.stringify(proposal) : "(none)"}\n\n` +
      `RECENT CHAT:\n${recentMessages || "(none)"}\n\n` +
      `MESSAGE TO YOU:\n${prompt}`,
  });
  return text;
}
