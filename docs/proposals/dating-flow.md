# Dating flow: as many real dates as possible

Status: **proposal, decisions agreed (2026-11-07), not built**

This replaces the weekly friend/collaborator Matchmaker (shipped as Nee Hao Fine Shyt, see `docs/2.30-matchmaker.md`) with on-demand dating whose single goal is **dates that actually happen**.

## The problem

On today's dating apps, a match leads to an open-ended chat with no plan, no deadline, and nobody helping. Most matches die there: people get ghosted before they ever meet.

**The fix:** every match arrives as a **date plan** (who, when, where), not an invitation to start texting. Ryo then takes care of the date until it happens.

## Decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | Who picks? | Ryo offers **3 date plans**; the user picks one |
| 2 | Online activities in ryOS | **Not dates.** They're pre-date warm-ups: conversation topics and light compatibility checks |
| 3 | Flakes | **Reliability score** with real consequences |
| 4 | Photos | **Yes, in v1** |
| 5 | Launch area | **Taipei only** |

## North-star metric

**Dates that happen per week.** Both people confirm afterwards that it happened.

The funnel: plans shown → plan sent → both said yes (locked) → confirmed on the day → **happened** → second date.

Health metrics:
- **Ghost rate:** plans that expired unanswered ÷ plans sent
- **Flake rate:** late cancels and no-shows ÷ locked dates
- **Time to date:** from "I'm free" to the date itself

## User flow

### 1. Onboarding: voice call with Ryo

The existing **Call Ryo** interview, extended. Ryo collects:

| Field | Notes |
|-------|-------|
| Birthdate | **18+ only**; self-declared, blocks onboarding if under 18 |
| Name, gender, interested in, age range | Multi-select for gender and interest |
| Area | Taipei district (e.g. Xinyi, Da'an). No exact address |
| Availability | Recurring windows, e.g. "weeknights after 7, Sunday afternoons" |
| Date style | Coffee, drinks, walk, activity; dealbreakers |
| About me | The existing 2–5 sentence profile, written by Ryo and edited by you |
| Photos | 1–4, uploaded in the Profile tab; checked by image moderation before anyone sees them |

Nothing is visible to anyone until you approve your profile, as today.

### 2. Ask for a date anytime

Press **Find a date**, or tell Ryo ("I'm free Friday night", "something this weekend"). Within seconds Ryo shows **3 date plans**:

> **Theo**, 29 · photo
> **Fri 7:30pm · coffee at Fika Fika** (between Xinyi and Da'an)
> Why: you both… · [**Ask Theo**]

You pick one. If nobody fits, Ryo says so and pings you as soon as someone who fits joins or frees up.

### 3. The other person has 24 hours

Theo gets the plan (in-app, plus email or Telegram) with your photo, the reason, the time, and the place: [**I'm in**] [**Other time**] [**Pass**].

- **I'm in:** the date is locked.
- **Other time:** Theo picks from 2 other slots where you're both free; you confirm.
- **Pass, or no answer within 24 hours:** the plan expires, you're told kindly, and Ryo shows you new plans right away. Nobody waits on someone who went quiet.

**Limits:**
- You can have up to **3 plans out** at once, never at overlapping times.
- Each person receives a capped number of plans a day.

### 4. Locked date

- It goes on **both Calendars**.
- A **date chat** opens. Ryo posts the plan and a few **topics to talk about**, drawn from both profiles.
- **Warm-ups in ryOS** (optional, not dates): each adds 3 songs to a shared iPod playlist, a quick "this or that", or a karaoke duet. They give you something to talk about and a feel for each other.
- **Safety:** a **Share plan** link for a friend (who, when, where), plus **Report** and **Block** in the chat.

### 5. Making sure it happens

| When | Ryo does |
|------|----------|
| Day before | Reminder to both |
| Morning of | "Still on?" Both tap **Confirm** by 3 hours before |
| Someone cancels | They must give a reason. The other person is told kindly and gets **3 new plans immediately** |
| 15 min before | "Here's the place" with a map link |

### 6. After the date

Next morning, Ryo asks each person privately:
- **Did it happen?** Both yes → it counts as a date.
- **See them again?** Both yes → Ryo **proposes date #2**. One no → it ends quietly; the other person only hears "not a match this time."
- **Anything to tell Ryo?** That feedback improves the next matches.

## After the match: Ryo as date concierge

Once two people match, their private chat has Ryo in it as a **date concierge**. Typing `@ryo` gives Ryo the same ryOS tools it has in Chats, applied to both people. Ryo only writes to anyone's apps after **both** say yes.

| # | Scenario | ryOS apps | Status |
|---|----------|-----------|--------|
| 1 | **"Plan it for us":** Ryo finds a time both are free (availability + both Calendars), checks the weather, picks a venue from the hand-picked list, and proposes one plan. Both reply "@ryo yes" → it goes on both Calendars | Calendar, weather, venue list, Maps link | **Built (v1)** |
| 2 | **Shared playlist:** Ryo opens a listening session; each adds 3 songs in iPod; they listen together and Ryo points out overlaps | iPod, Listen sessions | Next |
| 3 | **This or that:** Ryo generates a tiny game applet (night market or hot pot?) and posts what they agree on, turning it into a date idea | Applets | Later |
| 4 | **Karaoke duet / TV watch-along:** low-pressure vibe check using Karaoke host/join or an AI TV channel built from both interests | Karaoke, TV | Later |
| 5 | **Day of:** morning "still on?" check, YouBike directions and weather before leaving, "running late" relay | Maps, weather, notifications | Next |
| 6 | **After the date:** private check-in (text or Call Ryo); both want more → Ryo suggests date #2 from what it learned | Call Ryo, Calendar, memory | Later |
| 7 | **Private notes:** Ryo keeps a private sticky per match ("Ivy: hates cilantro"); after date #2 both can choose to add each other in Contacts | Stickies, Contacts | Later |

**How v1 works (scenario 1):**
- Rooms opened for a match are recorded; `@ryo` in them runs the concierge (`api/matchmaker/_concierge.ts`) instead of plain chat.
- **Ryo's tools:** `findFreeTimes`, `suggestVenues`, `checkWeather`, `proposeDate`, `confirmDate`.
- Confirming is typing "@ryo yes". Buttons in the chat come later.
- When the second person says yes, the date is written to **both** Calendars as "Date with <name>", 2 hours long, with the venue and a Maps link.
- First dates use only the hand-picked list (`api/matchmaker/_venues.ts`, a draft to verify).

This replaces the "3 date plans" picker in step 2: planning happens in the chat with Ryo, after both said hi.



Everyone starts at 100. It's visible to you only ("Reliability: Great").

| Event | Change |
|-------|-------:|
| Date happened | +5 (max 100) |
| Plan offer expired unanswered | −2 |
| Cancel with more than 24h notice | 0 |
| Cancel within 24h | −10 |
| No-show (the other person reports it, and you don't confirm the date) | −30 |

**Effects:**
- Higher scores are shown first.
- **Below 60:** 1 plan out at a time.
- **Below 30:** paused until you talk it through with Ryo.

## Matching

1. **Hard filters first:**
   - mutual gender, interest, and age range
   - both 18+, both in Taipei
   - overlapping free time
   - not blocked, passed, or already dated
   - reliability above 30, and under the daily cap
2. **Shortlist** by tag overlap, as today.
3. **AI score** for romantic compatibility. The judge prompt changes from "friends, never dating" to dating.
4. **Plan:**
   - **Time:** the earliest overlap of both people's availability (or the requested window) in the next 7 days.
   - **Place:** a venue from the **hand-picked Taipei list**, of a type both like, near the midpoint of their districts.

## Reusing what ryOS already has

| Need | Existing piece |
|------|----------------|
| Voice onboarding | Call Ryo (`MatchmakerAppComponent.tsx`, `api/matchmaker/chat.ts`) |
| Shortlist + AI score | `shortlist`, `judgePair` in `api/matchmaker/_lib.ts` |
| Venue map card and directions | `executeMapsSearchPlaces` in `api/chat/tools/maps-executor.ts` (venues themselves come from the hand-picked list) |
| Events on both Calendars | `executeCalendarControl` in `api/chat/tools/app-state-executors.ts` |
| Date chat | Private rooms (`openMatchRoom`) |
| Photo uploads | `api/_utils/storage.ts` (S3-compatible) |
| Email | `sendEmail` in `api/_utils/email.ts` (Resend) |
| Report, block, audit | Admin app + block lists |

**New:**
- the hand-picked Taipei venue list
- the date-plan record and its states
- a frequent background job (expiry, reminders, check-ins), replacing the weekly drop
- photo moderation
- the reliability score

## Data

| Record | Holds |
|--------|-------|
| Profile | Today's fields + birthdate, gender, interested in, age range, district, availability, date style, photos, reliability |
| Date request | "I'm free…" window, with expiry |
| Date plan | Both people, time, place, status, `expiresAt`, history |

**Plan statuses:** `offered → sent → locked → confirmed → happened`, ending early as `expired`, `passed`, or `cancelled`.

The background job runs every ~15 minutes and moves plans along: expiry, reminders, day-of checks, post-date check-ins.

## Build order

Safety goes in from the start, not at the end.

1. **Dating profile:**
   - the interview collects the new fields; Profile adds photos
   - 18+ gate, Taipei districts
   - dating prompts, hard filters
2. **Date plans:**
   - Find a date → 3 plans (time + venue) → pick → 24h answer → locked
   - both Calendars, date chat, Share plan, Report and Block
3. **Making it happen:** the background job, email notifications, reminders, day-of confirm, cancellations with replacement plans.
4. **After the date:** check-ins, reliability score, second dates.
5. **Warm-ups:** topics, shared playlist, this-or-that, karaoke duet.

## Needed to run it

| What | Why |
|------|-----|
| `OPENAI_API_KEY` with **Moderation** access | Photo checks (`omni-moderation`), plus everything it does today |
| `RESEND_API_KEY` + `RECOVERY_EMAIL_FROM` | Plan offers, reminders, and check-ins by email (needs a verified sending domain) |
| `TELEGRAM_BOT_TOKEN` (optional) | The same notifications on Telegram |
| `MAPKIT_*` (optional) | The map card for the venue; venue search works without it |

## Also decided (2026-11-07)

- **Name:** keep "Nee Hao Fine Shyt".
- **Photo verification** (selfie match): later, not v1.
- **Venues:** a **hand-picked list** of Taipei first-date spots, not open Maps search. Maps is only used for the map card and directions.
- **Weekly friend matching:** retired. The weekly drop, its cron job, and the friends/collaborators prompts go away.
