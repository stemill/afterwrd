// How a friend's check of a site is shown (checks.js does the checking): the result, everything from Cloudflare
// escaped, and when the site was last checked.
import { HOUR, recent, when } from "../checks.js";
import { escape } from "../util.js";

/** What a check found, as HTML (everything from Cloudflare escaped). `whose`: "yours" for the person checked, else "theirs". */
export function resultHtml(r, whose = "theirs", by = null) {
  const site = escape(r.site ? new URL(r.site).host : "");
  const your = whose === "yours" ? "your" : "their";
  const Your = whose === "yours" ? "Your" : "Their";
  // Which site was checked, and by whom, first: with one person playing both parts it's easy to lose track.
  const lines = [`<p class="check-who">Site checked: <b>${site}</b>${r.account ? ` <span class="meta">(Worker ${escape(r.script ?? "")}, Cloudflare account ending ${escape(r.account)})</span>` : ""}`
    + (by ? `<br>Checked by: <b>${escape(by.name)}'s site</b> <span class="meta">(${escape(by.host)})</span>` : "") + "</p>"];
  const say = (good, words) => lines.push(`<p class="check-${good ? "good" : "bad"}">${good ? "✓" : "✗"} ${words}</p>`);
  if (r.problem === "missing") say(false, `No Worker called <b>${escape(r.script)}</b> in the Cloudflare account that was allowed. Was it the account ${site} is in?`);
  else if (r.problem === "several") say(false, `More than one account that was allowed has a Worker called <b>${escape(r.script)}</b>. Check again, allowing only the account ${site} is in.`);
  else if (r.problem === "unreadable") say(false, `Cloudflare wouldn't hand over the code of <b>${escape(r.script)}</b>.`);
  else {
    if (r.code === "matches") say(true, `${Your} site is running exactly <b>afterwrd ${escape(r.version)}</b>, every file the same as the published release.`);
    else if (r.code === "different") {
      say(false, `${Your} site's code is <b>not</b> the published afterwrd ${escape(r.version)}. Don't use it yet: see <a href="https://afterwrd.app/check/#wrong">what to do</a>.`);
      lines.push(`<ul class="check-files">${(r.files ?? []).map((f) => `<li>${escape(f.name)}: ${escape(f.why)}</li>`).join("")}</ul>`);
    } else if (r.code === "no-release") say(false, `It says it's afterwrd ${escape(r.version)}, but there's no such release.`);
    else if (r.code === "release-unavailable") say(false, `Couldn't download afterwrd ${escape(r.version)} from GitHub to compare with. Check again later.`);
    else say(false, "This Worker doesn't look like afterwrd: its version couldn't be read.");
    for (const p of r.problems ?? []) say(false, escape(p));
    if (!(r.problems ?? []).length && r.code === "matches") say(true, "It's connected to exactly what afterwrd uses, and hands out its files only through its code.");
    const v = r.versions;
    if (v && !v.none) {
      const since = v.from ? ` since ${escape(when(v.from))}` : "";
      if ((v.unknown ?? []).length) {
        say(false, `${v.unknown.length === 1 ? "One version" : `${v.unknown.length} versions`} of ${your} site's code uploaded or made live${since} ${v.unknown.length === 1 ? "wasn't" : "weren't"}
          a signed afterwrd release (${v.unknown.map((u) => `version ${escape(String(u.number ?? "?"))}, ${escape(when(u.at))}`).join("; ")}). Something
          other than afterwrd changed ${your} site's code, even if only for a while.`);
      } else if (v.more) say(false, `There were more uploads to ${your} site's code${since} than one check looks at.`);
      else say(true, `Every version of ${your} site's code uploaded or made live${since} was a signed afterwrd release (${v.checked} ${v.checked === 1 ? "version" : "versions"}).`);
    }
    if (r.newer) lines.push(`<p class="meta">afterwrd ${escape(r.newer)} is out: worth updating.</p>`);
    if (recent(r) && !r.automatic) {
      lines.push(`<p class="check-bad">⏳ ${Your} site was installed or updated less than an hour before this check. Access given to an
        installer or an update lasts an hour and can't be cut short, so ask for another check after <b>${escape(when(r.modified + HOUR))}</b>.</p>`);
    }
    const a = r.audit;
    if (a) {
      const odd = a.unexpected ?? [];
      if (a.error) say(false, `Couldn't read all of ${your} account's audit log: ${escape(a.error)}`);
      else if (!a.complete) say(false, a.stopped ? `${Your} account's audit log was too long to read all of, so it isn't checked.` : `Still reading ${your} account's audit log…`);
      if (!odd.length && a.complete) say(true, `Since it was installed, apps and API tokens did only what installing, updating and groups do (${a.count} ${a.count === 1 ? "change" : "changes"}).`);
      if (odd.length) {
        say(false, `${odd.length === 1 ? "One change" : `${odd.length} changes`} to ${your} site or ${your} Cloudflare account, made through an app or API token, isn't something afterwrd does. Check ${whose === "yours" ? "you" : "they"} recognise ${odd.length === 1 ? "it" : "them"}:`);
        lines.push(changeList(odd, r));
        lines.push(`<p class="meta">“App” is something given access through Cloudflare's sign-in, such as wrangler; “API token” is a token
          made in the Cloudflare profile.${odd.some((e) => r.database && e.resource === r.database) ? ` Changes to the site's database
          matter even when the code is genuine: they could, say, add someone else's passkey.` : ""}</p>`);
      }
      const other = a.other ?? [];
      if (other.length) {
        lines.push(`<details class="check-other"><summary class="meta">${other.length === 1 ? "One change" : `${other.length} changes`} to other things in ${your}
          account (not ${your} site, so they don't count against it)</summary>${changeList(other, r)}</details>`);
      }
    }
  }
  lines.push(r.automatic
    ? `<p class="meta">Checked by itself ${escape(when(r.checkedAt))}, read-only, with a one-hour pass ${your} site handed over. Its
      account's log of changes isn't read by these checks.</p>`
    : `<p class="meta">Checked ${escape(when(r.checkedAt))}, read-only. The access Cloudflare gave was used for this check and not kept.</p>`);
  return lines.join("\n");
}

/** Changes, the same ones together ("Upload Version · afterwrd-install × 6"), newest first. */
function changeList(changes, r) {
  const groups = new Map();
  for (const e of changes) {
    const key = `${e.description || `${e.type} ${e.what}`}|${e.resource}|${e.context}`;
    const group = groups.get(key);
    if (group) { group.n++; if (e.time < group.first) group.first = e.time; } else groups.set(key, { ...e, n: 1, first: e.time });
  }
  const day = (t) => escape(t.replace("T", " ").slice(0, 16));
  return `<ul class="check-files">${[...groups.values()].map((g) => `<li>${g.n > 1 ? `${day(g.first)} to ${day(g.time)}` : day(g.time)} · `
    + `${escape(g.description || `${g.type} ${g.what}`)}${g.resource ? ` · ${escape(g.resource)}${g.resource === r.database ? " (its database)" : ""}` : ""}`
    + ` (${g.context === "api" ? "API token" : "app"})${g.n > 1 ? ` × ${g.n}` : ""}</li>`).join("")}</ul>`;
}

/** "Last checked by Sam Taylor's site on 9 Nov 2026 (afterwrd 0.34.0)." or "You last checked it yourself on …". */
export function checkedWords(last) {
  const day = new Date(last.checked_at * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });
  return last.name === null
    ? `You last checked it yourself, on ${day}.`
    : `Last checked by ${last.name}'s site on ${day}${last.version ? ` (afterwrd ${last.version})` : ""}.`;
}

