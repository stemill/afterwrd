// Formatting helpers, ported from the template filters in afterwrd/app.py so pages read the same.
import { escape } from "../util.js";
import { raw } from "./html.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONDON = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "numeric",
  day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
const URL_RE = /https?:\/\/[^\s<>"]+/g;

export const EMOJI = { Like: "👍", Love: "❤️", Haha: "😆", Wow: "😮", Sad: "😢", Angry: "😠", Care: "🤗" };

/** @returns {{ year: number, month: number, day: number, hour: number, minute: number, weekday: number }} */
function local(ts) {
  const p = Object.fromEntries(LONDON.formatToParts(new Date(ts * 1000)).map(({ type, value }) => [type, Number(value)]));
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, weekday: new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() };
}

const pad = (n) => String(n).padStart(2, "0");

export function fmtDatetime(ts) {
  if (!ts) return "";
  const t = local(ts);
  return `${WEEKDAYS[t.weekday]} ${t.day} ${MONTHS[t.month - 1]} ${t.year}, ${pad(t.hour)}:${pad(t.minute)}`;
}

/** 'just now', '5 min ago', '3 hr ago', then the date: for comments, which are mostly read soon after. */
export function fmtAgo(ts) {
  const seconds = Math.floor(Date.now() / 1000) - ts;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  return fmtDate(ts);
}

export function fmtDate(ts) {
  if (!ts) return "";
  const t = local(ts);
  return `${t.day} ${MONTHS[t.month - 1]} ${t.year}`;
}

export function fmtMonth(ts) {
  if (!ts) return "";
  const t = local(ts);
  return `${FULL_MONTHS[t.month - 1]} ${t.year}`;
}

/** '3 – 9 Aug 2015', '28 Jul – 9 Aug 2015' or '2014 – 2016'. */
export function dateRange(start, end) {
  if (!start) return "";
  const a = local(start);
  const b = local(end || start);
  const dm = (t) => `${t.day} ${MONTHS[t.month - 1]}`;
  if (a.year === b.year && a.month === b.month && a.day === b.day) return fmtDate(start);
  if (a.year !== b.year) {
    return ((end || start) - start) / 86400 > 90 ? `${a.year} – ${b.year}` : `${dm(a)} ${a.year} – ${dm(b)} ${b.year}`;
  }
  if (a.month !== b.month) return `${dm(a)} – ${dm(b)} ${b.year}`;
  return `${a.day} – ${dm(b)} ${b.year}`;
}

export function linkify(text) {
  if (!text) return "";
  let out = "";
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    out += escape(text.slice(last, m.index));
    out += `<a href="${escape(m[0])}" target="_blank" rel="noopener noreferrer">${escape(m[0])}</a>`;
    last = m.index + m[0].length;
  }
  return raw(out + escape(text.slice(last)));
}

export function safeUrl(url) {
  return url && (url.startsWith("http://") || url.startsWith("https://")) ? url : null;
}

/** 'Ste Millington shared a link.' -> 'Shared a link.' */
export function summary(title, myName) {
  if (!title) return "";
  if (title.startsWith(`${myName} `)) title = title.slice(myName.length + 1);
  return title.slice(0, 1).toUpperCase() + title.slice(1);
}

/** A photo or video, from the media store. */
export const mediaUrl = (m) => `/files/${m.hash}`;

/** Small version of a photo for grids; videos and unreadable photos fall back to the original. */
export function thumbUrl(m) {
  return m.thumb_hash ? `/files/${m.thumb_hash}` : mediaUrl(m);
}

/** Width / height, clamped so panoramas and very tall shots don't wreck a grid row. */
export function aspect(m) {
  if (m.width && m.height) return Math.round(Math.min(Math.max(m.width / m.height, 0.5), 2.5) * 1000) / 1000;
  return m.kind === "photo" ? 1.5 : Math.round((16 / 9) * 1000) / 1000;
}

export const number = (n) => Number(n).toLocaleString("en-GB");
