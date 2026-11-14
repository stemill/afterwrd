// Home, Memories and Add to home screen. Views only draw: they read nothing and change nothing.
import { fmtDate, summary, thumbUrl } from "./format.js";

import { icon } from "./nav.js";
import { host } from "../peers.js";
import { html, raw } from "./html.js";
import { askedBecause, friendFace, introductionCard, remoteCard } from "./friends.js";
import { MEMORIES, page } from "./layout.js";
import { composer, postCard } from "./parts.js";

// --- Home and Memories ----------------------------------------------------------------------------------------------

/** Posts from this day in past years, from the Facebook download (and anything posted here a year or more ago). */
function onThisDayCard(ctx, memories) {
  if (!memories.length) return "";
  return html`<section class="card onthisday">
  <h2>On this day</h2>
  ${memories.map((p) => {
    const photo = p.media?.find((m) => m.hash && m.kind === "photo");
    const href = photo ? `/photos/${photo.id}` : `/posts/${p.key}`;
    const words = p.text ? p.text.slice(0, 140) + (p.text.length > 140 ? "…" : "") : summary(p.title, ctx.me.name);
    return html`<a class="memory" href="${href}">
      ${photo && html`<img src="${thumbUrl(photo)}" alt="" loading="lazy">`}
      <span class="year">${new Date(p.created_at * 1000).getUTCFullYear()}</span>
      <span>${words}</span>
    </a>`;
  })}
</section>`;
}

const SIDE_FRIENDS = 12; // on Home; the rest are on Friends

/** "a", "a and b", "a, b and c". */
const listed = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/**
 * The owner's Home: write something, then your posts and your friends' together, newest first.
 * @param {any} ctx
 * @param {Record<string, any> & { auto?: AutoState, checkGrant?: CheckGrant }} data
 */
export function homePage(ctx, { own, feed, onThisDay, friends, newDevices = { devices: [], canConfirm: false }, newNotifying = [], securityFix = null, asking = [], introductions = [], unchecked = false, checkRequests = [], auto = { on: false }, checkFailure = null, friendChecks = [], checkGrant = {} }) {
  const stream = [
    ...own.map((p) => ({ at: p.created_at, card: postCard(ctx, p) })),
    ...feed.posts.map((p) => ({ at: p.created_at, card: remoteCard(ctx, p.connection, p) })),
  ].sort((a, b) => b.at - a.at);
  return page(ctx, "Home", html`
<div class="home">
  <section class="stream" aria-label="Posts">
    <h1 class="hidden">Home</h1>
    ${securityFix && html`<p class="notice alert">afterwrd ${securityFix} fixes a security problem, and this site is older.
      <a href="/_admin/update">Update now</a>.</p>`}
    ${(auto.problem || auto.on && (auto.last?.result && auto.last.result !== "done" || auto.waiting?.needsHand)) && html`<p class="notice alert">
      ${auto.waiting?.needsHand ? html`afterwrd ${auto.waiting.version} has to be installed by hand.`
        : auto.problem ? html`An automatic update couldn't run.`
        : auto.last.result === "kept" ? html`afterwrd ${auto.last.version} failed its checks after updating your site's database, so it was kept.`
        : html`afterwrd ${auto.last.version} didn't work on this site, so it was put back as it was.`}
      <a href="/_admin/update#auto">See what happened</a>.</p>`}
    ${!auto.on && !auto.later && !auto.problem && html`<form class="notice" method="post" action="/_admin/update/auto-later" data-region="" data-inplace="remove">
      afterwrd can keep itself up to date, so you never have to update it, and let your friends' afterwrd sites check it
      now and then, so you'd hear if anything were ever wrong with it. Cloudflare asks you to allow each.
      <a href="/_cloudflare/auto-start?then=checks" id="auto-offer">Turn them on</a>
      <button class="link">Not now</button></form>`}
    ${checkFailure && html`<p class="notice alert" id="check-failure"><strong>${checkFailure.name}'s site checked yours</strong> on
      ${fmtDate(checkFailure.checked_at)} and found something that needs a look: ${checkFailure.problems[0]}
      <a href="/_admin/update#check">See what it found</a>.</p>`}
    ${friendChecks.map((f) => html`<form class="notice alert friend-check" method="post" action="/_admin/checks/found/${f.id}/seen" data-region="" data-inplace="remove">
      ${f.verdict === "needs a look"
        ? html`<span>Your site checked <strong>${f.name}'s site</strong> and found something that needs a look. It's told their
          site too, but it's worth telling ${f.name}.</span>`
        : html`<span><strong>${f.name}'s site</strong> hasn't let yours check it the last ${f.refusals} times it tried. It may just
          be switched off, but it's worth asking ${f.name}.</span>`}
      <a href="/_admin/update#checking">See what it found</a> <button class="link">Put it away</button></form>`)}
    ${checkGrant.problem && html`<p class="notice alert">Your friends' sites can't check yours by themselves any more:
      ${checkGrant.problem} <a href="/_admin/update#check">Let them again</a>.</p>`}
    ${auto.on && !checkGrant.on && !checkGrant.later && !checkGrant.problem && html`<form class="notice" id="checks-offer" method="post" action="/_admin/checks/let-later" data-region="" data-inplace="remove">
      Let your friends' afterwrd sites check yours by themselves now and then, so you'd hear if anything were ever wrong with it.
      <a href="/_admin/update#check">Let them</a> <button class="link">Not now</button></form>`}
    ${newDevices.devices.length > 0 && html`<form class="notice alert" method="post" action="/_admin/devices/seen" data-region="" data-inplace="remove">
      ${newDevices.devices.length === 1
        ? html`A new device was added to your site on ${fmtDate(newDevices.devices[0].created_at)}.`
        : html`${newDevices.devices.length} new devices were added to your site, on ${listed([...new Set(newDevices.devices.map((d) => fmtDate(d.created_at)))])}.`}
      Not you? <a href="/_admin">Remove ${newDevices.devices.length === 1 ? "it" : "them"} in Your devices</a>.
      ${newDevices.canConfirm
        ? html`<button class="link">${newDevices.devices.length === 1 ? "That was me" : "They were all me"}</button>`
        : html`If it was you, say so from one of your older devices.`}</form>`}
    ${newNotifying.length > 0 && html`<form class="notice alert" method="post" action="/_admin/notifications/seen" data-region="" data-inplace="remove">
      Notifications about events and mentions were turned on for ${newNotifying.length === 1
        ? html`a new device (${newNotifying[0].name}) on ${fmtDate(newNotifying[0].created_at)}`
        : html`${newNotifying.length} new devices, on ${listed([...new Set(newNotifying.map((d) => fmtDate(d.created_at)))])}`}.
      Not you? <a href="/_admin">Turn ${newNotifying.length === 1 ? "it" : "them"} off in Your devices</a>.
      <button class="link">That was me</button></form>`}
    ${asking.map((r) => html`<form class="notice asking" method="post">
      <strong>${host(r.origin)}</strong>, who says they're ${r.name}, is asking to be friends. ${r.via_kind && askedBecause(r)}
      ${r.invited_as && r.invited_as.toLowerCase() !== r.name.toLowerCase() && html`<strong class="warn">That's not the name you invited (${r.invited_as}).</strong>`}
      <span class="row"><button class="chip primary" formaction="/_admin/connections/${r.id}/approve?back=home">Approve</button>
        <button class="chip" formaction="/_admin/connections/${r.id}/decline?back=home" data-confirm="Decline? Their site will be told no." data-confirm-ok="Decline">Decline</button></span>
    </form>`)}
    ${introductions.map((i) => introductionCard(i, "/", "div"))}
    <div class="notice install-note" id="install-note" hidden>
      <span><strong>Put afterwrd on your home screen.</strong> It opens like an app, in one tap, and can tell you when a
        friend invites you to an event.</span>
      <span class="row actions-row"><button class="chip primary" data-install hidden>Install</button>
        <a class="chip primary" href="/app" data-install-how>Show me how</a>
        <button class="chip" data-install-later>Not now</button></span>
    </div>
    ${checkRequests.map((r) => html`<div class="notice check-request" data-region="">
      <span><strong>${r.name}</strong> asks you to check their afterwrd site. Make a link, and send it to them by message.</span>
      <span class="row actions-row"><button class="chip primary" data-check-request="${r.id}">Make a check link</button>
        <form method="post" action="/_admin/checks/requests/${r.id}/dismiss" class="inline" data-inplace="remove"><button class="chip">Not now</button></form></span>
      <span class="check-share row actions-row" hidden><button class="chip primary" data-share>Send it to ${r.name}…</button>
        <button class="chip" data-copy>Copy the link</button></span>
      <span class="error" role="alert"></span>
    </div>`)}
    ${checkRequests.length > 0 && html`<script>
      // A friend asked for a check: make the link here, then hand it to the phone's share sheet (or copy it).
      document.addEventListener("click", async (e) => {
        const card = e.target.closest(".check-request");
        if (!card) return;
        const make = e.target.closest("button[data-check-request]");
        const error = card.querySelector(".error");
        const send = () => navigator.share({ text: card.dataset.message }).catch(() => {});
        if (make) {
          make.disabled = true;
          error.textContent = "";
          try {
            const res = await fetch("/_admin/checks/new", { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ connection: Number(make.dataset.checkRequest) }) });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Something went wrong.");
            card.dataset.message = data.message;
            make.parentElement.hidden = true;
            card.querySelector(".check-share").hidden = false;
            card.querySelector("[data-share]").hidden = !navigator.share;
            if (navigator.share) send();
          } catch (err) {
            error.textContent = err.message;
            make.disabled = false;
          }
        }
        if (e.target.closest("[data-share]")) send();
        const copy = e.target.closest("[data-copy]");
        if (copy) {
          await navigator.clipboard.writeText(card.dataset.message);
          copy.textContent = "Copied: paste it into a message";
        }
      });
    </script>`}
    ${unchecked && html`<form class="notice checked-notice" method="post" action="/_admin/checks/myself">Your site hasn't been checked yet.
      Before you share much, it's worth checking it's exactly the published afterwrd:
      <a href="/_admin/update#check">ask a friend with afterwrd to check it</a>, or
      <a href="https://afterwrd.app/check/">check it yourself</a>. This goes once a friend's site has checked it, or
      <button class="link">you've checked it yourself</button>.</form>`}
    ${composer()}
    ${feed.unreachable.length > 2
      ? html`<p class="notice">Couldn't reach ${feed.unreachable.length} friends' sites just now, so their newest posts may be missing.</p>`
      : feed.unreachable.map((u) => html`<p class="notice">Couldn't load ${u.connection.name}'s posts: ${u.error}</p>`)}
    ${stream.length ? stream.map((s) => s.card) : html`<div class="empty"><p>Nothing here yet. Write your first post above.</p></div>`}
  </section>
  <aside class="side">
    ${onThisDayCard(ctx, onThisDay)}
    <section class="card">
      <h2>Friends</h2>
      ${friends.length ? html`<ul class="mini-friends">
        ${friends.slice(0, SIDE_FRIENDS).map((c) => html`<li><a href="/friend/${c.id}/posts">${friendFace(ctx, c)}${c.name}</a></li>`)}
      </ul>
      ${friends.length > SIDE_FRIENDS && html`<p><a href="/friend">All ${friends.length} friends</a></p>`}`
        : html`<p class="meta">Add friends to see their posts here. Anyone can join: your friend link shows them how.</p>`}
      <p><a class="chip" href="/_admin/connections">${raw(icon("connections"))}<span>Add a friend</span></a></p>
    </section>
  </aside>
</div>`, "wide");
}

/** Memories: the sections of the Facebook download that were published, and what happened on this day. */
export function memoriesPage(ctx, { onThisDay }) {
  const available = MEMORIES.filter(([s]) => ctx.chosen.includes(s));
  return page(ctx, "Memories", html`
<h1>Memories</h1>
<p class="meta">From your Facebook download.</p>
${available.length ? html`<ul class="memory-tiles">
  ${available.map(([s, label, about]) => html`<li><a href="/${s}">${raw(icon(s))}<strong>${label}</strong><span class="meta">${about}</span></a></li>`)}
</ul>` : html`<p class="empty">Nothing from Facebook has been published here.</p>`}
${onThisDayCard(ctx, onThisDay)}`);
}

/**
 * Add to home screen: the browser's own Install where it has one (ui.js), and how to do it on each kind of device.
 * ui.js shows only the steps for the device it's looking at (data-device), with the rest a tap away; without
 * scripts, all of them show.
 */
export function appPage(ctx) {
  return page(ctx, "Add to home screen", html`
<h1>Add afterwrd to your home screen</h1>
<p>Then it opens like an app: full screen, in one tap, and you don't need to remember your site's address. It can
also tell you when a friend invites you to an event, or one you're going to changes: turn that on in
<a href="/events#notify">Events</a>.</p>
<p><button class="chip primary" data-install hidden>Install afterwrd</button></p>
<section class="card" data-device="iphone-elsewhere" hidden>
  <h2>iPhone or iPad: open this page in Safari first</h2>
  <p>On an iPhone or iPad, afterwrd goes on the home screen from <strong>Safari</strong>, and this page is open
    somewhere else: another browser, or inside another app such as WhatsApp or an email app.</p>
  <ol>
    <li><button class="chip" data-copy-address>Copy this page's address</button></li>
    <li>Open <strong>Safari</strong>, tap the address bar, paste it, and go.</li>
    <li>Then follow the steps for Safari.</li>
  </ol>
</section>
<section class="card" data-device="iphone">
  <h2>iPhone or iPad (Safari)</h2>
  <ol>
    <li>Tap <strong>Share</strong>: a square with an arrow pointing up. Where it is depends on how Safari is set out:
      <ul>
        <li>With a row of buttons along the bottom of the screen, it's the one in the middle.</li>
        <li>Otherwise, tap <strong>⋯</strong> (three dots) next to the address, then <strong>Share</strong>.</li>
      </ul></li>
    <li>Under the row of apps, scroll down the list and tap <strong>Add to Home Screen</strong>.</li>
    <li>If you see <strong>Open as Web App</strong>, leave it switched on. Tap <strong>Add</strong>.</li>
    <li>Open afterwrd from its new icon on your home screen, and sign in once more: the app keeps its own sign-in,
      separate from Safari's.</li>
  </ol>
  <p class="meta">If a link to afterwrd opened inside another app (WhatsApp, or an email app), there's no
    <strong>Add to Home Screen</strong> there: open the page in Safari first.</p>
  <p class="meta">On an iPhone or iPad, notifications only work in the app on the home screen.</p>
</section>
<section class="card" data-device="android">
  <h2>Android (Chrome)</h2>
  <ol>
    <li>Tap <strong>⋮</strong>, at the top right.</li>
    <li>Tap <strong>Install app</strong> (on some phones, <strong>Add to Home screen</strong>).</li>
    <li>Open afterwrd from its new icon.</li>
  </ol>
  <p class="meta">If notifications only turn up when you unlock your phone, Android is saving battery:
  set Chrome's battery use to <strong>Unrestricted</strong> (Settings → Apps → Chrome → Battery). afterwrd's
  notifications come through Chrome.</p>
</section>
<section class="card" data-device="computer">
  <h2>A computer (Chrome or Edge)</h2>
  <p>Look for <strong>Install</strong> at the right-hand end of the address bar, or in the browser's menu.</p>
</section>
<p data-device-others hidden><button class="chip" data-show-devices>Steps for another phone or computer</button></p>`);
}
