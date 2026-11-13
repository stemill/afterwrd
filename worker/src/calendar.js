// Events in groups: what an event is, read from a form or from another site, shown in words, and as a calendar file.
// An event is a group post with an event attached (groups.js): its title, when it starts (and perhaps ends), whether
// it's all day, the time zone it was made in, and where. Times are kept as moments (seconds) and shown in the event's
// own time zone, so "7pm" means 7pm where it's happening, whoever reads it. Used by both kinds of site: what a site
// sends is checked here by the other, as untrusted.
import { iso, seconds } from "../public/static/activity.js";

export const MAX_EVENT_TITLE = 200;
export const MAX_PLACE = 300;
const MAX_DAYS = 31;
const EARLIEST = Date.UTC(2000, 0, 1) / 1000;
const LATEST = Date.UTC(2100, 0, 1) / 1000;
const ZONE_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const ANSWERS = ["going", "maybe", "no"];

/** A time zone name the runtime knows (as it names it), or null. */
export function validZone(zone) {
  if (typeof zone !== "string" || zone.length > 64 || !ZONE_RE.test(zone)) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

const formatters = new Map();
/** The wall-clock date and time at moment `t` (seconds) in `zone`. */
export function wallClock(t, zone) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", hourCycle: "h23" });
    formatters.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t * 1000)).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  return { year: p.year, month: p.month, day: p.day, hour: p.hour % 24, minute: p.minute,
    weekday: new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() };
}

/** The moment (seconds) a wall-clock date and time in `zone` names. */
export function zonedMoment({ year, month, day, hour = 0, minute = 0 }, zone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute) / 1000;
  let t = wall;
  for (let i = 0; i < 2; i++) { // twice, for a moment either side of a clock change
    const w = wallClock(t, zone);
    t = wall - (Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) / 1000 - t);
  }
  return t;
}

/**
 * The first moment of a day in `zone`. Usually midnight; where the clocks go forward at midnight there's no such
 * moment, and the day starts at 01:00 (or so), so it's found by stepping on until the date is right.
 */
export function dayStart(date, zone) {
  let t = zonedMoment(date, zone);
  for (let i = 0; i < 4 && wallClock(t, zone).day !== date.day; i++) t += 3600;
  return t;
}

function readDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? { year, month, day } : null;
}

function readTime(value) {
  const m = /^(\d{2}):(\d{2})$/.exec(value ?? "");
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

const clean = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Checks an event's times and length; returns an error message, or null. */
function trouble({ starts_at, ends_at, all_day }) {
  if (!Number.isSafeInteger(starts_at) || starts_at < EARLIEST || starts_at > LATEST) return "Pick a date between 2000 and 2100.";
  if (ends_at === null) return null;
  if (!Number.isSafeInteger(ends_at) || (all_day ? ends_at < starts_at : ends_at <= starts_at)) return "The event has to end after it starts.";
  if (ends_at - starts_at > MAX_DAYS * 86400) return `Events can last up to ${MAX_DAYS} days.`;
  return null;
}

/**
 * An event from the form that adds or edits one: title, start date and (unless it's all day) time, an end if
 * wanted, a place, the time zone the times are in, and (`repeats`: in a group) how it repeats. Returns { event } or
 * { error }.
 */
export function readEventForm(form, fallbackZone = "Europe/London", { repeats = false } = {}) {
  const get = (name) => String(form.get(name) ?? "").trim();
  const title = clean(get("title"), MAX_EVENT_TITLE);
  if (!title) return { error: "Give the event a name." };
  const zone = validZone(get("zone")) ?? validZone(fallbackZone) ?? "UTC";
  const startDate = readDate(get("start_date"));
  if (!startDate) return { error: "Pick the day it's on." };
  const startTime = get("start_time") ? readTime(get("start_time")) : null;
  if (get("start_time") && !startTime) return { error: "That start time doesn't look right." };
  const all_day = startTime ? 0 : 1;
  let ends_at = null;
  const endDate = get("end_date") ? readDate(get("end_date")) : null;
  if (get("end_date") && !endDate) return { error: "That end date doesn't look right." };
  if (all_day) {
    if (endDate) ends_at = dayStart(endDate, zone);
  } else if (get("end_time")) {
    const endTime = readTime(get("end_time"));
    if (!endTime) return { error: "That end time doesn't look right." };
    ends_at = zonedMoment({ ...(endDate ?? startDate), ...endTime }, zone);
  }
  const event = { title, starts_at: startTime ? zonedMoment({ ...startDate, ...startTime }, zone) : dayStart(startDate, zone), ends_at, all_day, time_zone: zone,
    place: clean(get("place"), MAX_PLACE) || null };
  if (all_day && event.ends_at === event.starts_at) event.ends_at = null; // the same day
  const error = trouble(event);
  if (error) return { error };
  const repeat = repeats ? readRepeat(get("repeat"), get("repeat_until"), event) : { rrule: null };
  return repeat.error ? { error: repeat.error } : { event: { ...event, rrule: repeat.rrule } };
}

/** What a form needs to show an event again, in its own time zone. */
export function eventFormValues(e) {
  const pad = (n) => String(n).padStart(2, "0");
  const date = (w) => `${w.year}-${pad(w.month)}-${pad(w.day)}`;
  const s = wallClock(e.starts_at, e.time_zone);
  const end = e.ends_at === null ? null : wallClock(e.ends_at, e.time_zone);
  return {
    title: e.title, place: e.place ?? "", zone: e.time_zone, start_date: date(s), start_time: e.all_day ? "" : `${pad(s.hour)}:${pad(s.minute)}`,
    end_date: end && (e.all_day || date(end) !== date(s)) ? date(end) : "", end_time: end && !e.all_day ? `${pad(end.hour)}:${pad(end.minute)}` : "",
    ...repeatFormValues(e.rrule),
  };
}

/** An event as it's sent between sites (inside a group post's Note). */
export function eventObject(e) {
  return {
    type: "Event", name: e.title, startTime: iso(e.starts_at), endTime: e.ends_at === null ? undefined : iso(e.ends_at),
    "afterwrd:allDay": Boolean(e.all_day), "afterwrd:timeZone": e.time_zone,
    location: e.place ? { type: "Place", name: e.place } : undefined,
    "afterwrd:cancelled": e.cancelled_at ? iso(e.cancelled_at) : undefined,
    // A repeating event (in a group): its rule, and the dates called off one at a time.
    "afterwrd:rrule": e.rrule ?? undefined,
    "afterwrd:cancelledDates": e.rrule && e.skipped?.length ? e.skipped : undefined,
  };
}

/** An event sent by another site, checked; null if it isn't one. */
export function parseEvent(o) {
  if (o?.type !== "Event") return null;
  const title = clean(o.name, MAX_EVENT_TITLE);
  const zone = validZone(o["afterwrd:timeZone"]);
  const starts_at = seconds(o.startTime);
  const ends_at = o.endTime === undefined || o.endTime === null ? null : seconds(o.endTime);
  if (!title || !zone || starts_at === null || (o.endTime != null && ends_at === null)) return null;
  const cancelled = o["afterwrd:cancelled"] == null ? null : seconds(o["afterwrd:cancelled"]);
  const event = { title, starts_at, ends_at, all_day: o["afterwrd:allDay"] === true ? 1 : 0, time_zone: zone,
    place: clean(o.location?.name, MAX_PLACE) || null, cancelled_at: cancelled, rrule: null, skipped: [] };
  if (trouble(event)) return null;
  // A rule that isn't exactly one afterwrd makes, or doesn't fit the event, isn't one: the event doesn't repeat.
  const rule = o["afterwrd:rrule"] === undefined ? null : parseRule(o["afterwrd:rrule"]);
  if (rule && ruleFits(rule, event)) {
    event.rrule = o["afterwrd:rrule"];
    const dates = new Set(ruleDates(event));
    event.skipped =(Array.isArray(o["afterwrd:cancelledDates"]) ? o["afterwrd:cancelledDates"].slice(0, MAX_DATES) : [])
      .filter((d) => typeof d === "string" && dates.has(d));
  }
  return event;
}

/** Whether two events differ in anything someone going would want to hear about (not the words about it). */
export const eventChanged = (a, b) => ["title", "starts_at", "ends_at", "all_day", "time_zone", "place", "rrule"].some((k) => (a[k] ?? null) !== (b[k] ?? null));

/**
 * When an event has finished: its end, the end of its last day, or a few hours after a start with no end; for one that
 * repeats, when its last date finishes.
 */
export function finishedAt(e) {
  if (e.rrule) return finishedAt({ ...e, rrule: null, ...occurrence(e, ruleDates(e).at(-1)) });
  if (e.all_day) return (e.ends_at ?? e.starts_at) + 86400;
  return e.ends_at ?? e.starts_at + 3 * 3600;
}

/** The same, in SQL, for a row of events or events_elsewhere called `e` (one-off events, or one date of one). */
export const FINISHED_SQL = "(CASE WHEN e.all_day THEN COALESCE(e.ends_at, e.starts_at) + 86400 ELSE COALESCE(e.ends_at, e.starts_at + 10800) END)";
/** The same for a row of group_events called `e`, which may repeat: last_ends_at is when its last date finishes. */
export const GROUP_FINISHED_SQL = `COALESCE(e.last_ends_at, ${FINISHED_SQL})`;

/** "London time", for a time zone shown to someone who may be elsewhere. */
const zoneName = (zone) => (zone.includes("/") ? `${zone.split("/").pop().replace(/_/g, " ")} time` : zone);

/**
 * When an event is, in words, in its own time zone: "Sat 14 Nov 2026, 19:00–22:00", "Sat 14 Nov – Mon 16 Nov 2026".
 * The time zone is named when it isn't the reader's (`readerZone`).
 */
export function eventWhen(e, readerZone = "Europe/London") {
  const s = wallClock(e.starts_at, e.time_zone);
  const end = e.ends_at === null ? null : wallClock(e.ends_at, e.time_zone);
  const pad = (n) => String(n).padStart(2, "0");
  const day = (w) => `${WEEKDAYS[w.weekday]} ${w.day} ${MONTHS[w.month - 1]}`;
  const time = (w) => `${pad(w.hour)}:${pad(w.minute)}`;
  const sameDay = end && end.year === s.year && end.month === s.month && end.day === s.day;
  let words;
  if (e.all_day) {
    words = !end || sameDay ? `${day(s)} ${s.year}` : `${day(s)}${end.year === s.year ? "" : ` ${s.year}`} – ${day(end)} ${end.year}`;
  } else if (!end) {
    words = `${day(s)} ${s.year}, ${time(s)}`;
  } else if (sameDay) {
    words = `${day(s)} ${s.year}, ${time(s)}–${time(end)}`;
  } else {
    words = `${day(s)}${end.year === s.year ? "" : ` ${s.year}`}, ${time(s)} – ${day(end)} ${end.year}, ${time(end)}`;
  }
  return !e.all_day && e.time_zone !== readerZone ? `${words} (${zoneName(e.time_zone)})` : words;
}

/** The month and day an event starts on, in its own time zone: for its date tile. */
export function eventDay(e) {
  const s = wallClock(e.starts_at, e.time_zone);
  return { month: MONTHS[s.month - 1], day: s.day, weekday: WEEKDAYS[s.weekday], year: s.year, monthKey: `${s.year}-${s.month}`,
    monthName: `${FULL_MONTHS[s.month - 1]} ${s.year}` };
}

// --- a calendar file (RFC 5545), to open in a phone's or computer's own calendar ---------------------------------------

/** Text for a calendar file: only printable characters, with its special ones escaped, so nothing can add lines. */
const icsText = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g, "")
  .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

/** Lines longer than 75 bytes are folded, never inside a character. */
function fold(line) {
  const encoder = new TextEncoder();
  const out = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (bytes + size > (out.length ? 74 : 75)) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n ");
}

const utcStamp = (t) => new Date(t * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
function dateStamp(t, zone, plusDays = 0) {
  const w = wallClock(t, zone);
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day + plusDays));
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * A repeating event's dates, for a calendar file. An all-day one keeps its rule (its dates are plain days, as here).
 * One at a time of day lists each date's moment (RDATE): a rule with a start in UTC would be repeated in UTC by
 * calendars, an hour out after the clocks change and on the wrong day across midnight. Dates called off are left out.
 */
function repeatLines(e) {
  if (!e.rrule || !parseRule(e.rrule)) return [];
  const skipped = e.skipped ?? [];
  if (e.all_day) {
    return [`RRULE:${e.rrule}`, ...(skipped.length ? [`EXDATE;VALUE=DATE:${skipped.map((d) => d.replace(/-/g, "")).join(",")}`] : [])];
  }
  const dates = occurrences(e);
  const later = dates.slice(1).filter((d) => !d.cancelled);
  return [...(later.length ? [`RDATE:${later.map((d) => utcStamp(d.starts_at)).join(",")}`] : []),
    ...(dates[0].cancelled ? [`EXDATE:${utcStamp(dates[0].starts_at)}`] : [])];
}

/** A calendar file for one event. `uid` names it for good (so opening it again updates it), `url` is its page. */
export function icsFile(e, { uid, url, about = "" }) {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//afterwrd//groups//EN", "METHOD:PUBLISH", "BEGIN:VEVENT",
    `UID:${icsText(uid)}`, `DTSTAMP:${utcStamp(Math.floor(Date.now() / 1000))}`,
    ...(e.all_day
      ? [`DTSTART;VALUE=DATE:${dateStamp(e.starts_at, e.time_zone)}`, `DTEND;VALUE=DATE:${dateStamp(e.ends_at ?? e.starts_at, e.time_zone, 1)}`]
      : [`DTSTART:${utcStamp(e.starts_at)}`, ...(e.ends_at === null ? [] : [`DTEND:${utcStamp(e.ends_at)}`])]),
    ...repeatLines(e),
    `SUMMARY:${icsText(e.title)}`,
    ...(e.place ? [`LOCATION:${icsText(e.place)}`] : []),
    ...(about ? [`DESCRIPTION:${icsText(about)}`] : []),
    `URL:${icsText(url)}`,
    `STATUS:${e.cancelled_at ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

// --- a month on a calendar ---------------------------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, "0");
/** A plain date (no time, no zone) as YYYY-MM-DD. */
export const dateKey = ({ year, month, day }) => `${year}-${pad2(month)}-${pad2(day)}`;
const addDays = ({ year, month, day }, n) => {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
};

/** Today's date where the reader is. */
export const today = (zone, t = Math.floor(Date.now() / 1000)) => {
  const w = wallClock(t, validZone(zone) ?? "UTC");
  return { year: w.year, month: w.month, day: w.day };
};

/** The month a page asks for (?month=YYYY-MM), or the reader's current one. { year, month }. */
export function readMonth(value, zone) {
  const m = /^(\d{4})-(\d{2})$/.exec(value ?? "");
  if (m && Number(m[1]) >= 2000 && Number(m[1]) < 2100 && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { year: Number(m[1]), month: Number(m[2]) };
  const t = today(zone);
  return { year: t.year, month: t.month };
}

/** A day a page asks for (?day=YYYY-MM-DD), if it's a real date in `month`; else null. */
export function readDay(value, month) {
  const d = readDate(value);
  return d && d.year === month.year && d.month === month.month ? d : null;
}

/** The months either side, as YYYY-MM, and this one's name. */
export function monthAround({ year, month }) {
  const shift = (n) => { const d = new Date(Date.UTC(year, month - 1 + n, 1)); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`; };
  return { prev: shift(-1), next: shift(1), key: `${year}-${pad2(month)}`, name: `${FULL_MONTHS[month - 1]} ${year}` };
}

/**
 * The weeks a month's page shows, Monday to Sunday, from the week its first day is in to the week of its last: each
 * day as { year, month, day, key, inMonth }.
 */
export function monthWeeks({ year, month }) {
  const back = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7; // days since Monday
  const last = dateKey({ year, month, day: new Date(Date.UTC(year, month, 0)).getUTCDate() });
  const weeks = [];
  for (let start = addDays({ year, month, day: 1 }, -back); dateKey(start) <= last; start = addDays(start, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => {
      const d = addDays(start, i);
      return { ...d, key: dateKey(d), inMonth: d.month === month && d.year === year };
    }));
  }
  return weeks;
}

/** The moments a month's page covers (its first Monday to after its last Sunday), as the reader's days: [from, to). */
export function monthSpan(month, zone) {
  const weeks = monthWeeks(month);
  const z = validZone(zone) ?? "UTC";
  return [dayStart(weeks[0][0], z) - 86400, dayStart(addDays(weeks.at(-1)[6], 1), z) + 86400]; // a day spare either side
}

/**
 * The days an event is on, in its own time zone (as its date tile shows it), as YYYY-MM-DD: from the day it starts to
 * the day it ends (an end at midnight belongs to the day before). At most 32.
 */
export function eventDays(e) {
  const start = wallClock(e.starts_at, e.time_zone);
  let last = start;
  if (e.ends_at !== null && e.ends_at !== undefined) {
    const end = wallClock(e.all_day ? e.ends_at : e.ends_at - 1, e.time_zone);
    if (e.ends_at > e.starts_at || e.all_day) last = end;
  }
  const days = [];
  for (let d = { year: start.year, month: start.month, day: start.day }; days.length < 32; d = addDays(d, 1)) {
    days.push(dateKey(d));
    if (d.year === last.year && d.month === last.month && d.day === last.day) break;
  }
  return days;
}

/** "19:00", when a timed event starts, in its own time zone; "" for an all-day one. */
export function eventTime(e) {
  if (e.all_day) return "";
  const s = wallClock(e.starts_at, e.time_zone);
  return `${pad2(s.hour)}:${pad2(s.minute)}`;
}

// --- a week, and a list from today ---------------------------------------------------------------------------------------

/** The Monday of the week a page asks for (?week=YYYY-MM-DD, any day in it), or of the reader's current week. */
export function readWeek(value, zone) {
  const d = readDate(value);
  const day = d && d.year >= 2000 && d.year < 2100 ? d : today(zone);
  return addDays(day, -((new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay() + 6) % 7));
}

/** A week's seven days from its Monday, the weeks either side (their Mondays, YYYY-MM-DD), and its name: "9–15 Nov 2026". */
export function weekAround(monday) {
  const days = Array.from({ length: 7 }, (_, i) => { const d = addDays(monday, i); return { ...d, key: dateKey(d) }; });
  const [first, last] = [days[0], days[6]];
  const name = first.month === last.month
    ? `${first.day}–${last.day} ${MONTHS[last.month - 1]} ${last.year}`
    : `${first.day} ${MONTHS[first.month - 1]}${first.year === last.year ? "" : ` ${first.year}`} – ${last.day} ${MONTHS[last.month - 1]} ${last.year}`;
  return { days, key: dateKey(monday), prev: dateKey(addDays(monday, -7)), next: dateKey(addDays(monday, 7)), name };
}

/** The moments a week's page covers, as the reader's days, a day spare either side: [from, to). */
export function weekSpan(monday, zone) {
  const z = validZone(zone) ?? "UTC";
  return [dayStart(monday, z) - 86400, dayStart(addDays(monday, 7), z) + 86400];
}

/** A date's name in full: "Tuesday 14 November 2026". */
export function dayName({ year, month, day }) {
  const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday} ${day} ${FULL_MONTHS[month - 1]} ${year}`;
}

// --- repeating events (groups only: docs/events-plan.md) -----------------------------------------------------------------
//
// A repeating event keeps its rule as iCalendar's RRULE, a strict subset: every week or every two weeks, on the day it
// starts; every month on the same date, or the same weekday (the second Tuesday, the last Friday); always with an end
// date (UNTIL, a date where it's held), at most a year after it starts. Its dates are worked out where it's held, so
// 19:00 stays 19:00 through clock changes; a month without the date (the 31st, a fifth Tuesday) is skipped. Each date
// is named by its day there, YYYY-MM-DD (as iCalendar's RECURRENCE-ID would be); a one-off event's only date is ''.

export const REPEATS = ["weekly", "fortnightly", "monthly-date", "monthly-day", "monthly-last"];
const MAX_DATES = 60;
const MAX_REPEAT_DAYS = 366;
const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const ORDINALS = ["first", "second", "third", "fourth"];
const RULE_RE = /^FREQ=(?:WEEKLY(;INTERVAL=2)?|MONTHLY;(?:BYMONTHDAY=([1-9]|[12]\d|3[01])|BYDAY=(-1|[1-4])(SU|MO|TU|WE|TH|FR|SA)));UNTIL=(\d{8})$/;

const weekdayOf = (d) => new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
const daysIn = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const compactDate = (d) => dateKey(d).replace(/-/g, "");
const fromCompact = (s) => readDate(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
/** The day an event starts on, where it's held. */
const startDay = (e) => { const w = wallClock(e.starts_at, e.time_zone); return { year: w.year, month: w.month, day: w.day }; };

/** A rule, read strictly: { weeks: 1 | 2 } or { monthDay } or { nth, weekday }, with `until` (a date); else null. */
export function parseRule(text) {
  const m = typeof text === "string" && text.length <= 80 ? RULE_RE.exec(text) : null;
  const until = m && fromCompact(m[5]);
  if (!until) return null;
  if (text.startsWith("FREQ=WEEKLY")) return { weeks: m[1] ? 2 : 1, until };
  if (m[2]) return { monthDay: Number(m[2]), until };
  return { nth: Number(m[3]), weekday: BYDAY.indexOf(m[4]), until };
}

/** The nth (1–4, or -1 for the last) `weekday` of a month, or null if there isn't one. */
function nthWeekday(year, month, nth, weekday) {
  if (nth === -1) {
    const last = daysIn(year, month);
    return { year, month, day: last - ((weekdayOf({ year, month, day: last }) - weekday + 7) % 7) };
  }
  const day = 1 + ((weekday - weekdayOf({ year, month, day: 1 }) + 7) % 7) + (nth - 1) * 7;
  return day <= daysIn(year, month) ? { year, month, day } : null;
}

/** The days a rule gives from `first` (a date) to its end, at most MAX_DATES. */
function ruleDays(rule, first) {
  const days = [];
  const last = dateKey(rule.until);
  if (rule.weeks) {
    for (let d = first; dateKey(d) <= last && days.length < MAX_DATES; d = addDays(d, 7 * rule.weeks)) days.push(d);
    return days;
  }
  for (let i = 0; days.length < MAX_DATES && i < 13; i++) {
    const at = new Date(Date.UTC(first.year, first.month - 1 + i, 1));
    const [year, month] = [at.getUTCFullYear(), at.getUTCMonth() + 1];
    const d = rule.monthDay ? (rule.monthDay <= daysIn(year, month) ? { year, month, day: rule.monthDay } : null)
      : nthWeekday(year, month, rule.nth, rule.weekday);
    if (!d || dateKey(d) < dateKey(first)) continue;
    if (dateKey(d) > last) break;
    days.push(d);
  }
  return days;
}

/** The fewest days between a rule's dates: an event lasting this long or more would run into its next date. */
const ruleGap = (rule) => (rule.weeks ? 7 * rule.weeks : 28);

/**
 * Whether a rule fits the event it's on: its first date is the day the event starts, it ends within a year, and each
 * date ends before the next begins (as the form insists: a site sending its own rule is held to the same).
 */
function ruleFits(rule, e) {
  const first = startDay(e);
  const days = ruleDays(rule, first);
  return days.length > 0 && dateKey(days[0]) === dateKey(first) && dateKey(rule.until) >= dateKey(first)
    && dateKey(rule.until) <= dateKey(addDays(first, MAX_REPEAT_DAYS))
    && (e.ends_at === null || e.ends_at === undefined || e.ends_at - e.starts_at < ruleGap(rule) * 86400);
}

// Working out a date's moment where an event is held takes the time-zone rules (Intl), which costs CPU, so the dates
// themselves (cheap: plain calendar arithmetic) are used wherever moments aren't needed, and moments are worked out
// only for the dates asked for.

/** An event's dates, as days where it's held (YYYY-MM-DD): a one-off's only date is ''. Cheap. */
export function ruleDates(e) {
  const rule = e.rrule ? parseRule(e.rrule) : null;
  return rule ? ruleDays(rule, startDay(e)).map(dateKey) : [""];
}

const startDayOf = (t, zone) => { const w = wallClock(t, zone); return { year: w.year, month: w.month, day: w.day }; };
const utcDays = (d) => Date.UTC(d.year, d.month - 1, d.day) / 86_400_000;

/** One date of an event: { date, starts_at, ends_at, cancelled }, its times where it's held, lasting as the first. */
function occurrence(e, d) {
  if (!d) return { date: "", starts_at: e.starts_at, ends_at: e.ends_at ?? null, cancelled: Boolean(e.cancelled_at) };
  const day = readDate(d);
  let starts;
  let ends = null;
  if (e.all_day) {
    starts = dayStart(day, e.time_zone);
    // An all-day one's end is the start of its last day: as many days on as the first's.
    if (e.ends_at !== null && e.ends_at !== undefined) {
      const span = Math.round(utcDays(startDayOf(e.ends_at, e.time_zone)) - utcDays(startDay(e)));
      ends = span ? dayStart(addDays(day, span), e.time_zone) : null;
    }
  } else {
    const s = wallClock(e.starts_at, e.time_zone);
    starts = zonedMoment({ ...day, hour: s.hour, minute: s.minute }, e.time_zone);
    if (e.ends_at !== null && e.ends_at !== undefined) ends = starts + (e.ends_at - e.starts_at);
  }
  return { date: d, starts_at: starts, ends_at: ends, cancelled: Boolean(e.cancelled_at) || (e.skipped ?? []).includes(d) };
}

/**
 * An event's dates with their times: [{ date, starts_at, ends_at, cancelled }]. A one-off event's only date is ''.
 * Dates called off one at a time (`e.skipped`) are marked, not left out. With `from` and/or `to` (moments), only the
 * dates that could fall around them are worked out.
 */
export function occurrences(e, { from = null, to = null } = {}) {
  let dates = ruleDates(e);
  if (e.rrule && (from !== null || to !== null)) {
    // A date that starts before `from` can still be on then, for as many days as the event lasts.
    const lasts = e.ends_at === null || e.ends_at === undefined ? 1 : Math.ceil((e.ends_at - e.starts_at) / 86400) + 1;
    const lo = from === null ? "" : dateKey(addDays(startDayOf(from, e.time_zone), -lasts));
    const hi = to === null ? "9999" : dateKey(addDays(startDayOf(to, e.time_zone), 1));
    dates = dates.filter((d) => d >= lo && d <= hi);
  }
  return dates.map((d) => occurrence(e, d));
}

/** Whether an event has this date (YYYY-MM-DD, or '' for a one-off). Cheap. */
export const hasDate = (e, date) => ruleDates(e).includes(date);

/** One date of an event with its times ({ date, starts_at, ends_at, cancelled }), or null if it hasn't that date. */
export const occurrenceOn = (e, date) => (hasDate(e, date) ? occurrence(e, date) : null);

/** One date of an event as an event of its own (its times, and whether it's off), for the calendar; null if it isn't one. */
export function onDate(e, date) {
  if (!hasDate(e, date)) return null;
  const o = occurrence(e, date);
  return { ...e, starts_at: o.starts_at, ends_at: o.ends_at, cancelled_at: o.cancelled ? (e.cancelled_at ?? 1) : null, date: o.date };
}

/**
 * The repeat a form asks for (`repeat`: one of REPEATS, or nothing; `repeat_until`: YYYY-MM-DD, or nothing for a year)
 * for an event starting as `event` does, as a rule (RRULE); null for none. Returns { rrule } or { error }.
 */
export function readRepeat(choice, untilText, event) {
  if (!choice) return { rrule: null };
  if (!REPEATS.includes(choice)) return { error: "Choose how it repeats." };
  const first = startDay(event);
  const until = untilText ? readDate(untilText) : addDays(first, MAX_REPEAT_DAYS - 1);
  if (!until) return { error: "That end date doesn't look right." };
  if (dateKey(until) < dateKey(first)) return { error: "It has to stop repeating after it starts." };
  if (dateKey(until) > dateKey(addDays(first, MAX_REPEAT_DAYS))) return { error: "Events can repeat for up to a year." };
  const weekday = BYDAY[weekdayOf(first)];
  const nth = Math.ceil(first.day / 7);
  const rule = {
    weekly: "FREQ=WEEKLY", fortnightly: "FREQ=WEEKLY;INTERVAL=2", "monthly-date": `FREQ=MONTHLY;BYMONTHDAY=${first.day}`,
    "monthly-day": nth <= 4 ? `FREQ=MONTHLY;BYDAY=${nth}${weekday}` : null,
    "monthly-last": first.day + 7 > daysIn(first.year, first.month) ? `FREQ=MONTHLY;BYDAY=-1${weekday}` : null,
  }[choice];
  if (!rule) return { error: "That day doesn't repeat that way: pick another." };
  const rrule = `${rule};UNTIL=${compactDate(until)}`;
  if (event.ends_at !== null && event.ends_at - event.starts_at >= ruleGap(parseRule(rrule)) * 86400) {
    return { error: "An event that repeats has to end before its next date." };
  }
  return { rrule };
}

/** The repeat choice and end a form shows for a rule (the reverse of readRepeat). */
export function repeatFormValues(rrule) {
  const r = parseRule(rrule);
  if (!r) return { repeat: "", repeat_until: "" };
  const choice = r.weeks ? (r.weeks === 2 ? "fortnightly" : "weekly") : r.monthDay ? "monthly-date" : r.nth === -1 ? "monthly-last" : "monthly-day";
  return { repeat: choice, repeat_until: dateKey(r.until) };
}

/** A rule in words: "Every week on Tuesday, until 30 Jun 2027". */
export function repeatWords(e) {
  const r = parseRule(e.rrule);
  if (!r) return "";
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const first = startDay(e);
  const how = r.weeks === 1 ? `Every week on ${days[weekdayOf(first)]}` : r.weeks === 2 ? `Every two weeks on ${days[weekdayOf(first)]}`
    : r.monthDay ? `Every month on the ${ordinalDay(r.monthDay)}`
    : `Every month on the ${r.nth === -1 ? "last" : ORDINALS[r.nth - 1]} ${days[r.weekday]}`;
  return `${how}, until ${r.until.day} ${MONTHS[r.until.month - 1]} ${r.until.year}`;
}
const ordinalDay = (n) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** The ways an event starting on `date` (YYYY-MM-DD) can repeat, for the form: [[value, words]…]. */
export function repeatChoices(dateText) {
  const d = readDate(dateText);
  if (!d) return [["weekly", "Every week"], ["fortnightly", "Every two weeks"], ["monthly-date", "Every month, same date"], ["monthly-day", "Every month, same weekday"]];
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const nth = Math.ceil(d.day / 7);
  return [
    ["weekly", `Every week on ${days[weekdayOf(d)]}`], ["fortnightly", `Every two weeks on ${days[weekdayOf(d)]}`],
    ["monthly-date", `Every month on the ${ordinalDay(d.day)}`],
    ...(nth <= 4 ? [["monthly-day", `Every month on the ${ORDINALS[nth - 1]} ${days[weekdayOf(d)]}`]] : []),
    ...(d.day + 7 > daysIn(d.year, d.month) ? [["monthly-last", `Every month on the last ${days[weekdayOf(d)]}`]] : []),
  ];
}

/**
 * An event's dates, each as an event of its own (calendar.js onDate: its times, whether it's off, `date`), with who's
 * coming to it and the reader's answer (from `e.dates`, for a repeating one; the event's own, for a one-off).
 */
export function datesOf(e, window = {}) {
  if (!e.rrule) return [{ ...e, date: "" }];
  const lists = new Map((e.dates ?? []).map((d) => [d.date, d]));
  return occurrences(e, window).map((o) => ({ ...e, starts_at: o.starts_at, ends_at: o.ends_at, cancelled_at: o.cancelled ? (e.cancelled_at ?? 1) : null,
    date: o.date, rrule: null, going: [], maybe: [], cantGo: [], answer: null, ...(lists.get(o.date) ?? {}) }));
}
