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
 * wanted, a place, and the time zone the times are in. Returns { event } or { error }.
 */
export function readEventForm(form, fallbackZone = "Europe/London") {
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
    if (endDate) ends_at = zonedMoment(endDate, zone);
  } else if (get("end_time")) {
    const endTime = readTime(get("end_time"));
    if (!endTime) return { error: "That end time doesn't look right." };
    ends_at = zonedMoment({ ...(endDate ?? startDate), ...endTime }, zone);
  }
  const event = { title, starts_at: zonedMoment({ ...startDate, ...(startTime ?? {}) }, zone), ends_at, all_day, time_zone: zone,
    place: clean(get("place"), MAX_PLACE) || null };
  if (all_day && event.ends_at === event.starts_at) event.ends_at = null; // the same day
  const error = trouble(event);
  return error ? { error } : { event };
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
  };
}

/** An event as it's sent between sites (inside a group post's Note). */
export function eventObject(e) {
  return {
    type: "Event", name: e.title, startTime: iso(e.starts_at), endTime: e.ends_at === null ? undefined : iso(e.ends_at),
    "afterwrd:allDay": Boolean(e.all_day), "afterwrd:timeZone": e.time_zone,
    location: e.place ? { type: "Place", name: e.place } : undefined,
    "afterwrd:cancelled": e.cancelled_at ? iso(e.cancelled_at) : undefined,
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
    place: clean(o.location?.name, MAX_PLACE) || null, cancelled_at: cancelled };
  return trouble(event) ? null : event;
}

/** Whether two events differ in anything someone going would want to hear about (not the words about it). */
export const eventChanged = (a, b) => ["title", "starts_at", "ends_at", "all_day", "time_zone", "place"].some((k) => (a[k] ?? null) !== (b[k] ?? null));

/** When an event has finished: its end, the end of its last day, or a few hours after a start with no end. */
export function finishedAt(e) {
  if (e.all_day) return (e.ends_at ?? e.starts_at) + 86400;
  return e.ends_at ?? e.starts_at + 3 * 3600;
}

/** The same, in SQL, for a row of group_events (or group_plans) called `e`. */
export const FINISHED_SQL = "(CASE WHEN e.all_day THEN COALESCE(e.ends_at, e.starts_at) + 86400 ELSE COALESCE(e.ends_at, e.starts_at + 10800) END)";

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

/** A calendar file for one event. `uid` names it for good (so opening it again updates it), `url` is its page. */
export function icsFile(e, { uid, url, about = "" }) {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//afterwrd//groups//EN", "METHOD:PUBLISH", "BEGIN:VEVENT",
    `UID:${icsText(uid)}`, `DTSTAMP:${utcStamp(Math.floor(Date.now() / 1000))}`,
    ...(e.all_day
      ? [`DTSTART;VALUE=DATE:${dateStamp(e.starts_at, e.time_zone)}`, `DTEND;VALUE=DATE:${dateStamp(e.ends_at ?? e.starts_at, e.time_zone, 1)}`]
      : [`DTSTART:${utcStamp(e.starts_at)}`, ...(e.ends_at === null ? [] : [`DTEND:${utcStamp(e.ends_at)}`])]),
    `SUMMARY:${icsText(e.title)}`,
    ...(e.place ? [`LOCATION:${icsText(e.place)}`] : []),
    ...(about ? [`DESCRIPTION:${icsText(about)}`] : []),
    `URL:${icsText(url)}`,
    `STATUS:${e.cancelled_at ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
