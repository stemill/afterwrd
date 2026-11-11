// Messages (src/messages.js): the list of chats, and a chat. A chat's page works without its script
// (forms post and come back here); public/static/messages.js sends without leaving the page and adds new messages as
// they arrive while it's open. It builds each message the same way as bubble() here, so the two must match.
import { iso } from "../../public/static/activity.js";
import { page } from "./archive.js";
import { fmtDatetime } from "./format.js";
import { html, raw } from "./html.js";
import { asset } from "./nav.js";

// Why a message wasn't delivered (messages.problem), finishing "Not delivered: …". The same words are in messages.js.
const PROBLEMS = {
  unreachable: "their site couldn't be reached",
  "no-messages": "their site doesn't take messages yet",
  "not-friends": "you're not friends on their site any more",
  refused: "their site wouldn't take it",
};
// The same, in a group chat (where messages go to the group's site).
const GROUP_PROBLEMS = {
  unreachable: "the group's site couldn't be reached",
  "no-messages": "the group's site doesn't have a chat yet (its owner can update it)",
  "not-friends": "you're not in the group any more",
  refused: "the group wouldn't take it",
};
const STATES = { sending: "Sending…", delivered: "Delivered" };
const stateWords = (m, kind) => (m.state === "failed"
  ? `Not delivered: ${(kind === "group" ? GROUP_PROBLEMS : PROBLEMS)[m.problem] ?? "it didn't go"}` : STATES[m.state] ?? "");

const STYLE = `
  .chats { list-style: none; margin: 0 0 1.5rem; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .chat-row { display: grid; grid-template-columns: 1fr auto; gap: 0.15rem 1rem; color: inherit; text-decoration: none; }
  .chat-row .last { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chat-row time { grid-column: 2; grid-row: 1; }
  .chat-row.unread strong { color: var(--accent-strong); }
  .chat-row .dot { display: inline-block; width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--accent); margin-left: 0.4rem; vertical-align: middle; }
  .row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .row form { display: inline; }
  .chat { list-style: none; margin: 1rem 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .msg { max-width: min(85%, 34rem); padding: 0.55rem 0.85rem; border-radius: 18px; background: var(--surface); align-self: flex-start; }
  .msg.mine { align-self: flex-end; background: var(--accent-soft); }
  .msg .said { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  /* not .who: that's the round pictures, and made this a big coloured oval */
  .msg .sender { margin: 0 0 0.15rem; font-size: 0.8rem; font-weight: 700; color: var(--accent-strong); }
  .msg .sender .site { font-weight: 400; color: var(--muted); }
  .msg .under { display: flex; flex-wrap: wrap; gap: 0.2rem 0.6rem; align-items: baseline; font-size: 0.8rem; color: var(--muted); margin-top: 0.25rem; }
  .msg .under form { display: inline; }
  .msg .under button.link { font-size: 0.8rem; color: var(--muted); }
  .msg[data-state="failed"] .state { color: var(--danger); }
  .say { position: sticky; bottom: 0; display: flex; gap: 0.5rem; align-items: flex-end; padding: 0.75rem 0; background: var(--bg); }
  .say textarea { flex: 1; font: inherit; padding: 0.6rem 0.9rem; border: 1px solid var(--border); border-radius: 18px; background: var(--sunken); color: var(--text); resize: vertical; min-height: 2.75rem; }
  #say-error, #notify-error { color: var(--danger); font-weight: 700; margin: 0; }
  #say-error:empty, #notify-error:empty { display: none; }
  #notify h2 { margin-top: 0; }
  #notify [hidden] { display: none; }
  #notify label { display: flex; gap: 0.5rem; align-items: flex-start; margin: 0.5rem 0; }
`;

export function messagesPage(ctx, { chats, friends, pushKey }) {
  return page(ctx, "Messages", html`
<style>${raw(STYLE)}</style>
<div class="feed-head"><h1>Messages</h1></div>
<p class="meta">Each chat is between your site and your friend's. Not end-to-end encrypted yet: messages are kept on both sites.</p>
${chats.length > 0 ? html`<ul class="chats">${chats.map((c) => html`<li><a class="card chat-row${c.unread ? " unread" : ""}" href="/messages/${c.id}">
  <span><strong>${c.name}</strong> <span class="meta">${c.host}</span>${c.unread && raw('<span class="dot" aria-label="unread"></span>')}${c.muted && html`<span class="meta"> · muted</span>`}${c.kind === "group" && html`<span class="meta"> · group</span>`}${!c.friend && html`<span class="meta"> · ${c.kind === "group" ? "no longer a member" : "no longer friends"}</span>`}</span>
  <span class="last meta">${c.last ? html`${c.last.mine ? "You: " : ""}${c.last.text}` : "No messages yet"}</span>
  ${c.last_at && html`<time class="meta" datetime="${iso(c.last_at)}">${fmtDatetime(c.last_at)}</time>`}
</a></li>`)}</ul>` : html`<p>No messages yet.</p>`}
${friends.length > 0 && html`<h2>Start a chat</h2><div class="row">${friends.map((f) => html`<a class="chip" href="/friend/${f.id}/message">${f.name}</a>`)}</div>`}
${chats.length === 0 && friends.length === 0 && html`<p>Add a friend to message them: <a href="/friend">Friends</a>.</p>`}
<section class="card" id="notify" data-key="${pushKey}">
  <h2>Notifications on this device</h2>
  <p class="meta">Only for messages from friends: never posts, comments or anything else. Muted chats never notify, and
  neither does a chat you've got open.</p>
  <p id="notify-status">Checking this device…</p>
  <div class="row">
    <button class="chip primary" data-do="on" hidden>Turn on notifications</button>
    <button class="chip" data-do="off" hidden>Turn them off</button>
  </div>
  <label id="notify-preview" hidden><input type="checkbox"> Show the message on the lock screen (otherwise just who it's from)</label>
  <p class="meta" id="notify-android" hidden>If they only turn up when you unlock your phone, Android is saving battery: set
  Chrome's battery use to <strong>Unrestricted</strong> (Settings → Apps → Chrome → Battery). afterwrd's notifications
  come through Chrome.</p>
  <p id="notify-error" role="alert"></p>
</section>
<script src="${asset("/static/messages.js")}" type="module"></script>`);
}

export function chatPage(ctx, { chat, friend, group, canSend, keepDays, messages, earlier, paged, max }) {
  const isGroup = chat.kind === "group";
  return page(ctx, chat.name, html`
<style>${raw(STYLE)}</style>
<p class="crumbs"><a href="/messages">Messages</a> /</p>
<div class="feed-head">
  <h1>${chat.name}</h1>
  <div class="row">
    ${friend && html`<a class="chip" href="/friend/${friend.id}/posts">Their posts</a>`}
    ${group && html`<a class="chip" href="/groups/${group.id}">The group</a>`}
    ${isGroup && html`<form method="post" action="/_messages/${chat.id}/notify"><input type="hidden" name="notify" value="${chat.notify ? "0" : "1"}"><button class="chip">${chat.notify ? "Stop notifications" : "Notify me"}</button></form>`}
    <form method="post" action="/_messages/${chat.id}/mute"><input type="hidden" name="muted" value="${chat.muted ? "0" : "1"}"><button class="chip">${chat.muted ? "Unmute" : "Mute"}</button></form>
    <form method="post" action="/_messages/${chat.id}/delete" data-confirm="Delete this whole chat? It's only deleted here: ${chat.name} keeps their copy." data-confirm-ok="Delete"><button class="chip danger">Delete chat</button></form>
  </div>
</div>
${isGroup
  ? html`<p class="meta">Everyone in the group sees these. Messages here disappear after ${keepDays} days: for anything worth
    keeping, make a post. Not end-to-end encrypted: kept on the group's site and each member's.
    <span id="notify-words">${chat.notify ? "This chat notifies you." : "This chat doesn't notify you."}</span></p>`
  : html`<p class="meta">${chat.host} · not end-to-end encrypted: kept on your site and theirs.</p>`}
<p class="meta" id="muted-note" ${!chat.muted && raw("hidden")}><strong>Muted.</strong> New messages here still show, but don't add to the Messages count, and won't notify you.</p>
${earlier && html`<p><a href="/messages/${chat.id}?before=${earlier}">Earlier messages</a></p>`}
<ol class="chat" id="chat" data-chat="${chat.id}" data-kind="${chat.kind}" data-after="${messages.at(-1)?.id ?? 0}" ${paged && raw("data-paged")}>
  ${messages.map((m) => bubble(chat, m))}
</ol>
${paged && html`<p><a href="/messages/${chat.id}">Newest messages</a></p>`}
${canSend ? html`<form class="say" id="say" method="post" action="/_messages/${chat.id}/send">
  <textarea name="text" rows="2" maxlength="${max}" required placeholder="Message ${chat.name}" aria-label="Message ${chat.name}"></textarea>
  <button class="chip primary">Send</button>
</form>
<p id="say-error" role="alert"></p>` : html`<p class="meta">${isGroup ? `You're not in ${chat.name} any more, so you can't send messages to it.`
  : `You're not friends with ${chat.name} any more, so you can't send them messages.`}</p>`}
<script src="${asset("/static/messages.js")}" type="module"></script>`);
}

function bubble(chat, m) {
  const base = `/_messages/${chat.id}/${m.id}`;
  return html`<li class="msg ${m.mine ? "mine" : "theirs"}" data-id="${m.id}" data-state="${m.state ?? ""}">
  ${m.author && html`<p class="sender">${m.author}${m.authorSite && html` <span class="site">${m.authorSite}</span>`}</p>`}<p class="said">${m.text}</p>
  <div class="under"><time datetime="${iso(m.sent_at)}">${fmtDatetime(m.sent_at)}</time>${m.mine && html`<span class="state">${stateWords(m, chat.kind)}</span>`}${
    m.state === "failed" && html`<form method="post" action="${base}/retry"><button class="link">Try again</button></form>`}<form method="post" action="${base}/delete" data-confirm="Delete this message? It's only deleted here." data-confirm-ok="Delete"><button class="link">Delete</button></form>${
    m.everywhere && html`<form method="post" action="${base}/delete" data-confirm="Delete this message for everyone in the group?" data-confirm-ok="Delete"><input type="hidden" name="everywhere" value="1"><button class="link">Delete for everyone</button></form>`}</div>
</li>`;
}
