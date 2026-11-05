# afterwrd protocol

Status: Draft, protocol version 1 (afterwrd 0.20.x). Describes what afterwrd sites send and accept; the code is authoritative where they differ.

afterwrd is a personal social network in which each person runs their own site, with one owner per site. Sites talk to each other over HTTPS with JSON. This document describes that wire contract: what one site may ask of another, what it gets back, and what a receiving site will accept. It is written for anyone who wants to understand the protocol or build a compatible site in another language. It does not describe how afterwrd stores things internally, except where that changes what goes over the wire.

Source references are given as `file:line` under `worker/`, so a reviewer can check each section against them. They match the working tree on 5 November 2026: afterwrd 0.20.2 plus the uncommitted changes then in progress. They will drift as the code changes.

## 1. Goals and non-goals

Goals:

- **Private by default.** A site answers other sites only when they hold a key it issued. Nothing is public apart from the pairing and invite links, which share almost nothing.
- **Pull, not push.** Friends' sites read each other's posts when their owner opens a page. Notes (the only push) are short hints, not copies of content.
- **A key for each relationship.** Each pair of sites, and each member of a group, has its own bearer keys: one for each direction. A key opens one relationship and nothing else.
- **The owner holds their threads.** Comments on a post are stored on the site of the person who posted it. The commenter's site keeps its own copy of what its owner said.
- **Minimal push.** Notes go only to sites whose owners are already part of that thread, or (for events) who said they're going. A new post reaches friends as a single hint.
- **Groups can't speak for their members.** A group is its own small site. Members' sites keep their own record of what they sent and show that, not the group's version.

Non-goals: public discovery, global search, follower counts, public profiles, and federation with ActivityPub servers. afterwrd uses ActivityStreams 2.0 *shapes* (section 6), but it is not ActivityPub: it has no inbox or outbox actors, WebFinger, HTTP Signatures or dereferenceable public objects.

## 2. Conventions

### 2.1 Transport

- HTTPS only. A site address is an **origin**: scheme, host and optional port, with no path, no user info and no trailing dot on the host. `http://localhost` and `http://127.0.0.1` are accepted only when a site runs with `ALLOW_LOCAL_SITES=1`, for local testing.
- Callers do not follow redirects. Any 3xx answer counts as a failure (`<host> answered 302.`).
- Requests:
  - `GET` requests have no body and no `Content-Type`.
  - `POST` requests have a JSON body and `Content-Type: application/json`. Where an endpoint takes no input, callers send `{}`.
  - Receivers do not check the request `Content-Type`. A body that fails to parse is treated as `{}`.
- Responses are JSON with `Content-Type: application/json`, except for the HTML link pages and signed files.
- Every response from an afterwrd site also carries these headers: `Content-Security-Policy: frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`, `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff`, `X-Robots-Tag: noindex, nofollow`.

Source: `src/peers.js:32-40` (siteOrigin), `src/peers.js:50-73` (callSite), `src/index.js:27-45`, `src/util.js:5-7`.

### 2.2 Authentication

Once two sites are paired (or a site has joined a group), every call carries exactly this header:

```
Authorization: Bearer <key>
```

- `<key>` is the key that the *called* site issued to the caller. afterwrd generates 32 random bytes, base64url-encoded with no padding, which gives 43 characters.
- Receivers accept any key matching `^[\w-]{40,100}$`. Anything else is treated as no key.
- The issuer stores only the SHA-256 (lowercase hex) of the key, and looks the caller up by that hash.

The caller is identified *only* by its key. A receiver never trusts an origin, name or `attributedTo` in the body to say who is calling.

Source: `src/peers.js:26`, `src/peers.js:57`, `src/peers.js:94-98`, `src/util.js:20-27`, `src/groups.js:576-580`, `src/membership.js:590-592`.

### 2.3 Timeouts and size limits (enforced by the caller)

| What | Limit |
|---|---|
| Ordinary site-to-site call | 8 s timeout |
| `POST /_connect/<token>/accept`, `POST /_join/<token>/accept`, `POST /_group/claim` | 25 s (the other site calls back before it answers) |
| Notes sent from the outbox | 5 s |
| `GET /_group/ping` | 5 s |
| A group copying a member's photo file | 20 s per file |
| Any JSON reply read | 2,000,000 bytes |

A reply body that is not a JSON object (for example `null`, an array or a number) counts as `{}`.

> Note: when a reply is larger than 2,000,000 bytes, the "Reply too big." error is caught along with JSON parse errors (`src/peers.js:64-66`). A `2xx` reply that is too big therefore becomes `{}` rather than an error. This may not be intended.

Source: `src/peers.js:22-23`, `src/peers.js:50-88`, `src/outbox.js:11`, `src/groupsites.js:61`, `src/groups.js:69`.

### 2.4 Errors

- Errors are a JSON object `{"error": "<message>"}` with a 4xx status.
- Messages are plain English meant to be shown to the other site's owner. The caller shows up to 300 characters of `error`. If there is none, it shows `<host> answered <status>.`
- There are a few exceptions. An unknown path under `/_connect/` or `/_join/` gets a plain-text `Not found` (404). An expired link opened in a browser (with no `/info` or `/accept`) gets an HTML page (404).

Status codes used:

| Code | Meaning |
|---|---|
| 200 | Done. Many actions answer `{"ok": true}`. |
| 202 | A note was accepted. It may have been kept or quietly ignored; the sender can't tell which. |
| 400 | Malformed or unacceptable input, or a check against another site failed. |
| 401 | No key, an unknown key, or a key used outside its purpose (for example, hello after pairing). |
| 403 | The key is known but not yet approved, the caller isn't allowed (not an admin, wrong setup key), or a signed file link is bad or expired. |
| 404 | No such path, or the thing asked about isn't there any more. |
| 409 | Already connected, already a member, or already claimed. |
| 429 | Over a rate limit or a size limit. |

Source: `src/peers.js:66-72`, `src/util.js:5-7`, `src/connect.js:36-46`, `src/groups.js:531-544`.

### 2.5 Notes: delivery, retries and idempotency

Notes (sections 8 and 9.6) are queued by the sender and delivered by a background job:

- Each note is sent as `POST` with the JSON note as its body, to one recipient at a time, with a 5 s timeout.
- **Delivered** means any `2xx`.
- The sender **retries** only when the recipient can't be reached, times out, or answers `5xx` or `429`. Retries come after 1 min, 5 min, 30 min, 2 h and 6 h, and then the note is dropped (6 attempts in all).
- Any other answer (for example `400`, `401`, `403` or `404`) drops the note at once.
- The recipient's key is looked up when the note is sent, not when it is queued. A disconnect, or a member leaving, stops notes still waiting.
- A sender works through at most 40 notes per run, across both kinds of note, with at least 1 s between runs.

Notes carry no idempotency key. A receiver keeps at most one new-post note per post and per sending site, but it does not deduplicate comment or event notes.

> Note: a retry after a timeout can therefore record the same comment or event note twice.

Source: `src/outbox.js:1-7`, `src/outbox.js:10-12`, `src/outbox.js:53-89`.

### 2.6 Protocol version

`GET /_peer/hello`, `GET /_member/hello` and `GET /_group/ping` include `"protocol": 1` in their JSON answers. See section 11.

Source: `src/peers.js:27-29`, `src/peers.js:111`, `src/membership.js:601`, `src/groups.js:585`.

## 3. Identity

- **A site is its origin**, for example `https://ann.example`. Two sites are the same site exactly when their origins are equal as strings, after the normalisation in 2.1.
- **The owner, as an actor**, has the id `<origin>/` (with a trailing slash).
- **The owner's name** is the display name they gave when they set up their site. If there is none, it is `Someone`. It is sent in the following places:
  - the hello answers (`{"name": …}`);
  - the connect `/info` and `/accept` answers;
  - as `attributedTo.name` on the feed and posts collections.
- **Receiving a name:** a receiver trims it and cuts it to 100 characters, falling back to `A friend`. Where it is read from `attributedTo` on the feed, a name longer than 100 characters is ignored. A receiver updates its stored name for a friend whenever the friend's feed gives a different one.
- **The owner's picture and cover** go as `icon` and `image` on the owner's `Person` (6.1). They are the picture and cover the owner chose on afterwrd or, failing that, the profile and cover photos from their imported Facebook download. Both go as signed file links lasting 6–7 days, so a friend's site can keep showing them.

Source: `src/peers.js:44-47`, `src/share.js:57-65`, `src/photos.js:24-35`, `src/connect.js:25`, `src/friends.js:70-76`, `src/feed.js:73-81`, `public/static/activity.js:33`.

## 4. Pairing (connecting two sites)

Pairing is mutual: once it is done, each site holds a key for calling the other, and each owner can read the other's posts and photos and comment on them.

The site that makes the link (A, Ann) has to **approve** the request. Until she does, A answers B's calls only with `403`, except for disconnecting. The site that uses the link (B, Bob) counts as approved on its own side straight away, because its owner chose to connect.

### 4.1 The link

A's owner makes a Connect link (an owner-only action):

```
https://ann.example/_connect/<token>
```

- `<token>` matches `[\w-]{40,100}`. afterwrd makes 43 characters.
- A link can be used once. It lasts 7 days, or 30 days for an "Invite to afterwrd" link made for one person in the owner's Facebook download.
- A stores only the SHA-256 of the token.

### 4.2 Steps

1. **The link page.** `GET /_connect/<token>` on A, with no key, returns an HTML page. It asks where the visitor's own site is, then sends the browser to `<B>/_admin/connections/new?link=<the link, URL-encoded>`. That is an owner-only page on B. A compatible site needs to answer at that path, behind its own sign-in, for the hand-off to work.

2. **B asks who made the link.** B calls `GET /_connect/<token>/info` on A, with no key.
   - `200 {"name": "Ann Example"}`.
   - `404 {"error": "This Connect link has expired or has already been used. Ask your friend for a new one."}`.

3. **B's owner confirms.** B makes a new key, `keyB`, for A to call B with. B stores its hash as a pending connection for A's origin; a pending connection is given up after 600 s. B then calls A:

   ```
   POST https://ann.example/_connect/<token>/accept
   Content-Type: application/json

   {"origin": "https://bob.example", "key": "<keyB>"}
   ```

   B waits up to 25 s.

4. **A checks that the key is B's.** Before answering, A calls B with that key:

   ```
   GET https://bob.example/_peer/hello?from=https%3A%2F%2Fann.example
   Authorization: Bearer <keyB>
   ```

   B answers `200 {"name": "Bob Example", "protocol": 1}` only if all of these are true:
   - the key belongs to a connection that is still pending (not yet connected);
   - `from` is a valid origin (2.1);
   - `from` is exactly the origin that the pending connection is for.

   Otherwise B answers `401 {"error": "Not connected."}`. This stops a site that holds one of B's keys from showing it to a third site to pass itself off as B.

5. **A records the request.** A spends the token, makes `keyA` for B to call A with, and stores B's origin, B's name (from hello), `keyB` and the hash of `keyA`. The connection is now connected but **not approved**. A answers:

   ```
   200 {"name": "Ann Example", "key": "<keyA>"}
   ```

   Errors from `accept`:

   | Status | When | Message |
   |---|---|---|
   | 400 | `origin` invalid or equal to A's own, or `key` doesn't match the key pattern | `That doesn't look like an afterwrd site.` |
   | 400 | The hello check failed | `Couldn't confirm your site: <reason>` |
   | 409 | A already has a connected row for that origin | `Your sites are already connected.` |
   | 404 | The link has expired or is spent | |

6. **B finishes.** B checks that `key` matches the key pattern, stores `keyA`, and marks the connection connected and approved on its side. If anything fails, B deletes its pending row.

7. **A's owner approves or declines** on their own site (owner-only).
   - **Approve:** A shares from then on.
   - **Decline:** A calls `POST /_peer/disconnect` on B (best effort) and forgets B.

```
 B's browser            B (bob.example)                         A (ann.example)
     |  GET /_connect/<token>  ------------------------------------>  |  HTML page
     |  -> B/_admin/connections/new?link=…                            |
     |----------------------->|                                        |
     |                        |  GET /_connect/<token>/info  -------->  |
     |                        |  <------------------- 200 {name}        |
     |  owner confirms ------>|                                        |
     |                        |  keep hash(keyB), pending               |
     |                        |  POST /_connect/<token>/accept         |
     |                        |       {origin: B, key: keyB}  ------->  |
     |                        |  <---- GET /_peer/hello?from=A          |
     |                        |        Authorization: Bearer keyB       |
     |                        |  200 {name, protocol: 1} ------------>  |
     |                        |                                        |  spend token; keep keyB,
     |                        |                                        |  hash(keyA); not approved
     |                        |  <------------- 200 {name, key: keyA}   |
     |                        |  keep keyA; approved here               |
     |                        |                                        |  A's owner approves
     |                        |  GET /_peer/feed (Bearer keyA) ------>  |  403 until approved
```

> Note: if A's `200` answer to `accept` is lost (for example, B times out first), A keeps an unapproved connection whose `keyB` B has already deleted. If A's owner approves it, A's calls to B fail with `401` until one side disconnects.

Source: `src/connect.js:1-14`, `src/connect.js:20-25`, `src/connect.js:34-77`, `src/connect.js:129-144`, `src/connect.js:182-222`, `src/peers.js:108-117`, `src/pages.js:164-187`, `test/e2e/feed.mjs:83-107`, `test/e2e/feed.mjs:202-214`.

### 4.3 Disconnecting

Either site disconnects by calling the other:

```
POST /_peer/disconnect
Authorization: Bearer <key the other site issued>

{}
```

- The answer is `200 {"ok": true}`, and the receiver forgets the connection, keys included.
- The caller forgets the connection whether or not the call succeeds.
- This call is allowed even for a connection that hasn't been approved, so a requester can withdraw.
- Comments already made stay on the site where they were made, and each owner keeps their own copies of what they said.

Source: `src/peers.js:115-117`, `src/peers.js:128-135`, `src/connect.js:165-178`.

## 5. Friend API

All the endpoints in this section are on the site being read (the "owner's site"). They are called by a connected friend's site with `Authorization: Bearer <key the owner's site issued>`.

How the receiver handles the key:

- No key, or an unknown one: `401 {"error": "Not connected."}`.
- A key for a connection that isn't approved yet: `403 {"error": "Waiting for <owner> to approve the connection."}`, except for `POST /_peer/disconnect`.
- An unknown path, once the key has passed: `404 {"error": "Not found."}`.

Where an endpoint takes `page`, it is an integer clamped to between 1 and 10,000. Anything else counts as 1.

Source: `src/peers.js:1-16`, `src/peers.js:100-170`.

### 5.1 `GET /_peer/hello?from=<origin>`

Used only during pairing (step 4 in 4.2). Answers `200 {"name": string, "protocol": 1}` or `401`.

### 5.2 `GET /_peer/feed`

Returns the owner's newest posts **written on afterwrd** (never imported ones). There are at most 30, newest first, each with its photos and **all** its comments. A friend's site uses this for its Home page.

```json
{
  "@context": ["https://www.w3.org/ns/activitystreams", {"afterwrd": "https://afterwrd.app/ns#"}],
  "type": "OrderedCollection",
  "attributedTo": {"type": "Person", "id": "https://ann.example/", "name": "Ann Example",
                   "icon": { …Image, see 6.3… }, "image": { …Image… }},
  "totalItems": 1,
  "orderedItems": [ { …Note, see 6.2… } ]
}
```

- `totalItems` is the number of items in this answer, not the owner's total.
- Fields whose value would be undefined are left out.

What the receiver accepts (`cleanFeed`):

- It reads the owner's name, `icon` and `image` from `attributedTo`.
- It reads at most the first 50 `orderedItems`, each parsed as in 6.2. Malformed items are dropped.
- Home on the receiving site asks at most 40 friends' sites each time it opens. It favours friends whose recent new-post notes say they've posted, and takes the rest in turn.

> Note: `totalItems` here counts the items returned, whereas in `/_peer/posts` it is the owner's total.

Source: `src/peers.js:119`, `src/peers.js:172-182`, `src/peers.js:21`, `src/friends.js:79-83`, `src/feed.js:15-19`, `src/feed.js:48-55`.

### 5.3 `GET /_peer/posts?page=<n>`

Returns the owner's posts, newest first, 30 to a page, each with photos and all comments. A friend's site uses this for the friend's page.

```json
{
  "type": "OrderedCollectionPage",
  "attributedTo": { …Person… },
  "totalItems": 412,
  "afterwrd:page": 1,
  "afterwrd:hasNext": true,
  "orderedItems": [ { …Note… } ]
}
```

The receiver reads up to 100 items. It reads `afterwrd:hasNext` only if it is literally `true`.

Which posts are included:

- Posts written on afterwrd are always included.
- Posts imported from the owner's Facebook download are included **only if** the owner published the "posts" section of that download.

Source: `src/share.js:119-131`, `src/friends.js:87-96`, `test/e2e/feed.mjs:222`.

### 5.4 `GET /_peer/albums`

Returns the albums the friend may see. Each album is a `Collection` summary:

```json
{
  "type": "Collection",
  "totalItems": 2,
  "items": [
    {"type": "Collection", "name": "Posted on afterwrd", "totalItems": 12, "afterwrd:key": "1000000001",
     "published": "2026-10-01T09:00:00Z", "updated": "2026-11-03T10:00:00Z", "icon": { …Image… }}
  ]
}
```

- `afterwrd:key` is a decimal album number, or `other` (photos with no album) or `videos`.
- If the owner published the "photos" section of their download, all albums are listed, plus `other` and `videos`. Otherwise only albums made on afterwrd are listed.
- Empty sets are left out.
- `icon` is the album's cover.

The receiver reads up to 2000 items. It keeps only those whose key matches `^(\d+|other|videos)$` and is 20 characters or fewer. A missing name becomes `Album`.

Source: `src/share.js:134-162`, `src/friends.js:98-108`.

### 5.5 `GET /_peer/albums/<key>?page=<n>`

`<key>` matches `\d+|other|videos`. The answer is one album's photos and videos, oldest first, 150 to a page:

```json
{
  "type": "OrderedCollectionPage", "name": "Posted on afterwrd", "summary": "optional description",
  "totalItems": 12, "published": "…", "updated": "…",
  "afterwrd:key": "1000000001", "afterwrd:page": 1, "afterwrd:hasNext": false,
  "orderedItems": [ { …Image or Video… } ]
}
```

- If the album isn't one the friend may see (5.4), the answer is `404 {"error": "That isn't there any more."}`.
- The receiver reads up to 500 items. It cuts `name` to 300 characters and `summary` to 5000.

Source: `src/peers.js:123-127`, `src/share.js:164-175`, `src/friends.js:110-119`.

### 5.6 `GET /_peer/photos/<sha256>`

`<sha256>` is 64 lowercase hex characters. The answer is one photo or video (6.3) with these extra fields:

| Field | Meaning |
|---|---|
| `afterwrd:album` | `{key, name, totalItems, index}`: its set, and its 1-based position in it. Only present if the friend may see that set. |
| `afterwrd:prev`, `afterwrd:next` | The hashes of its neighbours in that set. |
| `afterwrd:postedWith` | The post it came with, as a Note without `replies`. Only present if the friend may see that post. |
| `replies` | A `Collection` of its comments. |

A friend may see a photo or video only if it's in a set they're shown (5.4), or it came with a post they're shown (5.3). Anything else answers exactly as if it didn't exist, so knowing a hash gets a friend nothing: `404 {"error": "That isn't there any more."}`.

The receiver refuses the whole answer if the media object doesn't parse (6.3) or its hash isn't the one asked for. It drops neighbours that aren't hashes, and drops `afterwrd:album` unless its key matches `^(\d+|other|videos)$`.

Source: `src/peers.js:123-127`, `src/share.js:177-206`, `src/friends.js:121-137`.

### 5.7 `POST /_peer/comments`

The calling site's owner comments on a post or photo on this site:

```json
{
  "@context": "https://www.w3.org/ns/activitystreams",
  "type": "Note",
  "mediaType": "text/plain",
  "content": "Looks great, Bob!",
  "attributedTo": {"type": "Person", "id": "https://ann.example/", "name": "Ann Example"},
  "inReplyTo": "https://bob.example/posts/post-1762164000-0b918c1b"
}
```

Receiver rules:

- `type` must be `Note`.
- `content` must be a string. It is normalised (`\r\n` and `\r` become `\n`, then trimmed) and must then be 1 to 2000 characters. Otherwise: `400 {"error": "Comments need 1 to 2000 characters."}`.
- `inReplyTo` must be `<this site>/posts/<post key>` or `<this site>/photos/sha256/<hash>`, and that post or photo must exist here and be one the friend is shown (5.3, 5.6). Otherwise: `404 {"error": "That isn't there any more."}`, the same answer either way.
- `attributedTo` in the body is **ignored**. The comment is credited to the name and origin this site stores for the connection.
- Rate limits per calling origin: 30 comments per 600 s and 300 per day. Over either: `429`. Both limits are checked in the same statement as the insert.
- On success: `200 {"id": "<inReplyTo>#c<n>"}`.

The commenting site checks that `id` is exactly `<the target's address>#c<n>`, and then keeps its own copy of the text with `n` (see 6.4).

The receiver then sends comment notes (8.2) to the other friends who have commented on the same thing, leaving out the comment's own site.

Source: `src/peers.js:136-155`, `src/archive/comments.js:12`, `src/feed.js:107-123`.

### 5.8 `POST /_peer/comments/<n>/delete`

Deletes comment `n` if, and only if, it came from the calling site's origin. Always answers `200 {"ok": true}`, whether or not anything was deleted.

Source: `src/peers.js:162-166`, `test/e2e/feed.mjs:194-196`.

### 5.9 `POST /_peer/notify`

Receives a note. See section 8.

### 5.10 `POST /_peer/disconnect`

See 4.3.

## 6. Objects

All objects use ActivityStreams 2.0 vocabulary. afterwrd's own terms use the prefix `afterwrd:` and the IRI `https://afterwrd.app/ns#`:

```json
"@context": ["https://www.w3.org/ns/activitystreams", {"afterwrd": "https://afterwrd.app/ns#"}]
```

General rules:

- Text is plain text (`mediaType: "text/plain"`), never HTML.
- Times are ISO 8601 in UTC with whole seconds, for example `2026-11-03T10:00:00Z`. Receivers accept anything `Date.parse` understands that is after 1970.
- Fields with no value are left out rather than sent as `null`.
- Receivers ignore unknown fields.

> Note: `@context` is sent on `/_peer/feed`, on notes and on all group responses. It is not sent on `/_peer/posts`, `/_peer/albums`, `/_peer/albums/<key>` or `/_peer/photos/<hash>`. Receivers don't read it either way. The namespace IRI isn't something this protocol relies on resolving.

Source: `public/static/activity.js:1-41`, `public/static/activity.js:84-91`.

### 6.1 Identifiers

Every object has a permanent address on the site it belongs to. These addresses are identifiers. On a person's site, requesting them needs the owner's session. A group's site doesn't serve them at all. Other sites get content only through the APIs in this document.

| Object | id |
|---|---|
| Site owner (`Person`) | `<site>/` |
| Post (`Note`) | `<site>/posts/<post key>` |
| Photo or video (`Image` / `Video`) | `<site>/photos/sha256/<sha256 of the file>` |
| The file itself | `<site>/files/<sha256>` (needs a session or a signed link, see section 7) |
| Comment (`Note`) | `<post or photo id>#c<n>`, where `n` is a decimal of up to 15 digits |
| Group (`Group`) | `<group site>/groups/<n>`. A group's own site always holds group `1`. |
| Post in a group | `<group site>/groups/<n>/posts/<m>` |
| Comment in a group | `<group post id>#c<k>` |

The **post key** matches `^post-\d+-[0-9a-f]{8}$`. It is made of:

- the post's Unix time;
- an FNV-1a 32-bit fingerprint, computed over the UTF-16 code units of `kind`, `title`, `text`, `link_url` and `group_name`, joined with NUL characters.

The fingerprint only tells apart posts made in the same second, and it keeps the key stable when the archive is re-imported. Other sites should treat the key as opaque. They must accept any value matching the pattern.

Source: `public/static/activity.js:14-41`, `src/archive/routes.js:51`, `src/archive/routes.js:58`, `src/groups.js:515`.

### 6.2 Person (the owner)

```json
{"type": "Person", "id": "https://ann.example/", "name": "Ann Example",
 "icon": { …Image: profile picture… }, "image": { …Image: cover… }}
```

`icon` and `image` are optional. Their signed links last 6–7 days (section 7).

Source: `src/share.js:57-65`.

### 6.3 Note (a post)

```json
{
  "type": "Note",
  "id": "https://bob.example/posts/post-1762164000-0b918c1b",
  "attributedTo": "https://bob.example/",
  "published": "2025-11-03T10:00:00Z",
  "summary": "optional title",
  "mediaType": "text/plain",
  "content": "Hello from the hills",
  "attachment": [ { …Image or Video… }, {"type": "Link", "href": "https://example.org/"} ],
  "tag": [ {"type": "Mention", "name": "Cat Example"} ],
  "location": {"type": "Place", "name": "Ben Nevis"},
  "context": {"type": "Group", "name": "A Facebook group"},
  "afterwrd:kind": "photo",
  "replies": {"type": "Collection", "totalItems": 1, "items": [ { …comment Note, 6.5… } ]}
}
```

| Field | Notes |
|---|---|
| `summary` | The post's title, if any. |
| `attachment` | Media (6.4), plus at most one `Link`. |
| `tag` | Names of people tagged (from an imported post). Names only, no ids. |
| `location` | A place **name** only. |
| `context` | On a friend's post, the name of the Facebook group an imported post was made in. |
| `afterwrd:kind` | One of `status`, `photo`, `video`, `link`, `checkin`, `shared` or `review`. Receivers default to `status`. |
| `replies` | Left out in `afterwrd:postedWith`. |

What a receiver accepts (`parseNote`). It drops the Note unless all of these hold:

- `type` is `Note`;
- `id` starts with `<that site>/posts/` and the rest matches the post-key pattern;
- `published` parses as a time.

It then keeps fields within these limits:

| Field | Limit |
|---|---|
| `content` | ≤ 60,000 characters |
| `summary` | ≤ 1000 characters |
| `afterwrd:kind` | ≤ 30 characters |
| `location.name` | ≤ 300 characters |
| `context.name` | ≤ 300 characters |
| `tag` | first 50, each `name` ≤ 100 characters |
| `attachment` | first 100. The first `Link` whose `href` starts with `http://` or `https://` (≤ 2000 characters) is kept. Media are parsed as in 6.4. |

A string over its limit is dropped, not cut.

Source: `src/share.js:85-117`, `src/friends.js:48-67`.

### 6.4 Image and Video

```json
{
  "type": "Image",
  "id": "https://bob.example/photos/sha256/<hash>",
  "url": "https://bob.example/files/<hash>",
  "mediaType": "image/jpeg",
  "width": 1200, "height": 800,
  "preview": {"type": "Image", "url": "https://bob.example/files/<thumb hash>", "mediaType": "image/jpeg",
              "afterwrd:fetch": "https://bob.example/files/<thumb hash>?exp=…&sig=…"},
  "name": "optional description",
  "published": "…",
  "afterwrd:takenAt": "… (only when it differs from published)",
  "afterwrd:fetch": "https://bob.example/files/<hash>?exp=1762182000&sig=<43 chars>"
}
```

`location` (latitude and longitude) is **never** sent. The sender removes it.

What a receiver accepts (`parseMedia`). It drops the object unless all of these hold:

- `type` is `Image` or `Video`;
- `url` is exactly `<that site>/files/<64 lowercase hex>`;
- `afterwrd:fetch` is exactly that `url` followed by `?exp=<1–12 digits>&sig=<43 characters of [A-Za-z0-9_-]>`, with nothing before, after or in between.

It also reads:

- `preview` likewise, falling back to the main link if `preview` doesn't pass;
- `width` and `height` only if they are positive safe integers;
- `name` up to 5000 characters.

These checks matter because the link ends up in pages, including inside `style="…"` attributes.

Source: `public/static/activity.js:44-59`, `src/share.js:72-77`, `src/friends.js:17-32`, `test/e2e/forged.mjs:12-15`.

### 6.5 Comment

```json
{
  "type": "Note",
  "id": "https://bob.example/posts/post-1762164000-0b918c1b#c7",
  "attributedTo": {"type": "Person", "id": "https://ann.example/", "name": "Ann Example"},
  "inReplyTo": "https://bob.example/posts/post-1762164000-0b918c1b",
  "published": "…",
  "mediaType": "text/plain",
  "content": "Looks great, Bob!"
}
```

What `attributedTo` holds depends on who wrote the comment:

- the site's own owner: the string `<site>/`;
- a connected friend: a `Person` with `id` = `<friend's origin>/`;
- anyone else: a `Person` with only a `name`.

What a receiver accepts (`parseThread`):

- It reads the first 500 items.
- It drops a comment unless:
  - `type` is `Note`;
  - `id` is exactly `<the post or photo id>#c<n>`;
  - it has a name: the owner's, if `attributedTo` is `<site>/`, or `attributedTo.name` of 100 characters or fewer;
  - `content` is 2000 characters or fewer;
  - `published` parses.
- It treats `attributedTo.id`, with its trailing slash removed, as the author's site only if it is a valid origin.

**Own comments rule (a receiver expectation).** When a site shows a friend's thread, it uses its own records for its owner's comments: the comment ids, and the text the friend's site returned when each comment was made.

- A comment with a recorded id is shown with the stored text, whatever the friend's site now says.
- A comment that claims to be from the viewing site (`from` = its own origin) but has no recorded id is **dropped**.

So a friend's site can't put words in another owner's mouth.

Source: `public/static/activity.js:65-82`, `src/friends.js:35-46`, `src/feed.js:34-45`, `test/e2e/forged.mjs:17-31`.

### 6.6 What is never sent

- Photo location coordinates.
- Keys. Each key goes only to the site it was made for, once, in the handshake answer. Exports leave keys out too.
- Anything from the owner's Facebook download apart from posts (with tags and place names) and photos and videos, and those only in `/_peer/posts` and `/_peer/albums` and only when the owner published those sections. Imported posts never appear in `/_peer/feed` or in notes.
- Who is going to an event, in notes (event notes carry only the event).
- Anything at all from a site that hasn't approved the connection.

Source: `src/share.js:75`, `src/share.js:119-138`, `src/notify.js:39-46`, `test/e2e/feed.mjs:113`, `test/e2e/feed.mjs:355`.

## 7. Media: signed file links

Files are never embedded in JSON. Each media object carries `afterwrd:fetch`, a link signed by the site that holds the file, of this form:

```
<site>/files/<sha256>?exp=<unix seconds>&sig=<43 chars base64url>
```

To other sites the signature is **opaque**: only the issuer can check it. The link's *shape* is fixed, because receivers refuse any other (6.4).

Expiry:

| Link | Lasts | `exp` |
|---|---|---|
| Ordinary | 1–2 hours | Rounded up to the next hour boundary after one hour |
| Profile picture and cover | 6–7 days | At a UTC midnight |

A receiver may cache a link until its `exp`. afterwrd caches a friend's profile picture link this way.

When the issuer is asked for `GET` or `HEAD /files/<sha256>?exp=…&sig=…`, with no session, it checks that `exp` is a safe integer later than now, and that `sig` is a valid signature for `<sha256>.<exp>`. Then:

- **Valid:** it serves the file with `Cache-Control: private, max-age=<seconds left>`. It honours `Range` and `If-None-Match`.
- **Invalid or expired:** `403` with the text `This link has expired`.
- **No `sig` at all:** the file needs the owner's session.

afterwrd's signature is HMAC-SHA-256 with a per-site secret, base64url-encoded. That is an implementation choice, not part of the contract.

Who fetches:

- **Friends' photos:** the friend's **browser** loads the signed link straight from the owner's site. The friend's site never relays the file.
- **Group photos:** the group's site fetches each signed link from the member's site **server-side**, once, to copy the file into the group (9.4). After that, members' browsers load the group's own signed links from the group's site.

Source: `src/share.js:7-8`, `src/share.js:33-52`, `src/index.js:83-90`, `src/index.js:111-120`, `src/feed.js:25-32`, `src/groups.js:254-272`, `test/e2e/feed.mjs:245-248`.

## 8. Notes (push between friends)

A note tells a friend's site that something happened, so that site doesn't have to poll. Notes are sent to `POST /_peer/notify` with the key the recipient issued. Delivery and retries are as in 2.5.

### 8.1 New post

This note goes to **every approved connection** when the owner posts on afterwrd. Imported posts never trigger it.

```json
{
  "@context": ["https://www.w3.org/ns/activitystreams", {"afterwrd": "https://afterwrd.app/ns#"}],
  "type": "Create",
  "object": {"type": "Note", "id": "https://ann.example/posts/post-1762164000-0b918c1b",
             "content": "first 200 characters, whitespace collapsed"}
}
```

`content` is the start of the post's text, or of its title if it has no text.

### 8.2 New comment

When anyone comments on a post or photo, this note goes to the approved connections whose sites have themselves commented on that same post or photo. It does not go to the site the new comment came from.

```json
{
  "@context": [ … ],
  "type": "Create",
  "object": {"type": "Note", "inReplyTo": "https://ann.example/posts/post-1762164000-0b918c1b",
             "content": "first 200 characters", "attributedTo": {"type": "Person", "name": "Bob Example"}}
}
```

> Note: a friend comment note has no `object.id` (the comment's id), but a group comment note (9.6) has one.

### 8.3 What the receiver does

1. It checks the note:
   - `type` must be `Create` and `object.type` must be `Note`.
   - The note must be about the **sender's own** post or photo:
     - a comment note has `object.inReplyTo`;
     - a post note has `object.id`;
     - either must be `<sender's origin>/posts/<post key>` or, for comments only, `<sender's origin>/photos/sha256/<hash>`.

   Otherwise: `400 {"error": "That isn't about something on your site."}`.
2. It ignores a comment note unless its own owner has commented on that post or photo, by a comment it sent and recorded (6.5). It answers `202 {"ok": true}` either way.
3. It keeps what's left, as text only:
   - for a post: the post, and `content` cut to 200 characters;
   - for a comment: also `attributedTo.name`, cut to 100 characters (default `Someone`).

   It keeps at most one post note per post per sender.
4. Rate limits per sender: 60 notes per 600 s and 500 per day.
   - A comment note over the limit gets `429`, so the sender retries later.
   - A post note over the limit, or a duplicate, is dropped silently with `202`.
5. Kept notes are deleted after 60 days, or as soon as the sender is disconnected.

Notes only prompt the receiver. Content is always read with the pull APIs.

Source: `src/notify.js:1-17`, `src/notify.js:24-29`, `src/notify.js:34-92`, `test/e2e/feed.mjs:159-165`, `test/e2e/feed.mjs:183-190`.

## 9. Groups

A group is **its own site**, an afterwrd Worker in "group mode". It holds exactly one group, with no owner sign-in and no pages apart from the invite page. Everyone, including the person who started the group, uses it from their own site, with a key the group issued to that site.

Members' sites read the group when its page opens. Nothing is pushed to members when someone posts.

On a group's site:

- `/_join/…`, `/_group/…` and signed `/files/…` links are answered.
- Everything else gets an HTML `404` that says it's a group.
- Person sites don't answer `/_group/…` without a session.

Two directions, each with its own key:

- **group → member:** the member's site issued the key. The group uses it for `/_member/hello`, `/_member/notify` and `/_member/removed`.
- **member → group:** the group issued the key. The member's site uses it for `/_group/*`.

Group roles are `owner` (whoever started it), `admin` and `member`.

Source: `src/groups.js:1-40`, `src/index.js:50`, `src/index.js:92-101`, `test/e2e/groups.mjs:96-99`.

### 9.1 Limits

| Limit | Value |
|---|---|
| Members | 40 besides the owner |
| Requests waiting to join | 10. Unanswered requests are dropped after 7 days. |
| Invite link | 14 days and 100 requests. Making a new one cancels the old one. |
| Group name | ≤ 100 characters. "About" ≤ 1000 characters. |
| Post text | ≤ 5000 characters |
| Photos per post | ≤ 8. Each ≤ 8,000,000 bytes, thumbnail ≤ 1,000,000 bytes, sides 1–20,000 px. |
| All the group's photos together | ≤ 1,000,000,000 bytes |
| Posts per member | 10 per 600 s, 50 per day, 40 photos per day |
| Comments per member | 1–2000 characters each. 30 per 600 s, 300 per day. |
| A page of posts | 20 posts, each with its newest 20 comments. A single post comes with up to 300 comments. |
| Events | 100 upcoming. 30 past. |

Source: `src/groups.js:54-76`, `src/archive/comments.js:12`.

### 9.2 Starting a group: ping and claim

The owner's site creates the group's Worker with a secret, `GROUP_KEY` (a random token, the "setup" key), and then:

1. **Waits until the Worker is up.** It polls the group with no key and a 5 s timeout:

   ```
   GET /_group/ping
   → 200 {"afterwrd": "group", "version": "0.20.2", "protocol": 1}
   ```

   The owner's site also uses `version` to offer updates.

2. **Claims the group.** It makes `keyM` for the group to call it with, and sends:

   ```
   POST /_group/claim
   {"origin": "https://ann.example", "key": "<keyM>", "setup": "<GROUP_KEY>", "name": "Book club", "about": "One book a month"}
   ```

   The owner's site waits up to 25 s. The group then:
   - compares `setup` with its secret by SHA-256. If they differ: `403 {"error": "Not this group's key."}`.
   - refuses a second claim, or a claim after closing: `409 {"error": "This group is already set up."}`.
   - checks `origin` (a valid origin that isn't the group's own), `key` (the key pattern) and `name` (non-empty after trimming, cut to 100). If any fails: `400`.
   - proves the key with `GET <origin>/_member/hello?from=<group origin>&group=1` (9.3). If that fails: `400`.
   - creates group `1` with the caller as `owner`, and answers:

   ```
   200 {"key": "<keyG>", "id": 1, "name": "Book club", "about": "One book a month", "owner": "Ann Example"}
   ```

3. The owner's site checks that `key` matches the key pattern and that `id` is the group number it expected (always `1`).

Source: `src/groups.js:487-522`, `src/groups.js:585-586`, `src/groupsites.js:56-65`, `src/groupsites.js:97-100`, `src/groupsites.js:111-117`, `src/membership.js:337-351`, `src/update.js:84-89`, `test/e2e/groups.mjs:107-111`.

### 9.3 Joining with an invite link

An admin makes an invite link with `POST /_group/admin/link` (9.5): `https://<group>/_join/<token>`, where the token matches `[\w-]{40,100}`. Anyone it is sent to can use it, but each use is only a request.

1. **The link page.** `GET /_join/<token>` (HTML) asks where the visitor's site is, then sends the browser to `<their site>/groups/join?link=<the link, URL-encoded>`. That is an owner-only page; as in 4.2, a compatible site needs to answer there.

2. **The joiner's site asks about the group.** It calls `GET /_join/<token>/info` with no key:

   ```
   200 {"id": 1, "name": "Book club", "about": "One book a month", "owner": "Ann Example"}
   ```

   or `404 {"error": "This invite link has expired. Ask whoever sent it for a new one."}`.

   The joiner's site requires `id` to be a positive integer. It cuts `name` to 100 characters (default `A group`) and `about` to 2000.

3. **The joiner's site asks to join.** It makes `keyM`, keeps a pending row (given up after 600 s), and sends:

   ```
   POST /_join/<token>/accept
   {"origin": "https://bob.example", "key": "<keyM>"}
   ```

   It waits up to 25 s. The group then:
   - checks `origin` and `key`: `400` if either is invalid.
   - counts this request against the link: `429` once the link has had 100.
   - proves the key with `GET <origin>/_member/hello?from=<group origin>&group=<id>`: `400 "Couldn't confirm your site: …"` if that fails.
   - refuses a site that is already an approved member: `409`.
   - replaces any earlier waiting request from the same origin, and refuses when 10 are already waiting: `429`.
   - answers:

   ```
   200 {"key": "<keyG>", "id": 1, "name": "Book club", "about": "…", "owner": "Ann Example"}
   ```

4. The joiner's site checks `key` and `id`, as in 9.2, and stores `keyG`.

5. **Until an admin approves**, the group answers every member call with `403 {"error": "Waiting for <owner name> to let you in."}`, except `POST /_group/leave`.

**`GET /_member/hello?from=<origin>&group=<n>`** is on the member's site. It answers `200 {"name": "<owner name>", "protocol": 1}` only if all of these are true:

- the key belongs to a group row that is still being joined or claimed;
- `from` is that group's origin;
- `group` is that group's number.

Otherwise it answers `401 {"error": "Not joining."}`. As with `/_peer/hello`, this stops a group from passing a member's key on to a third site.

Source: `src/groups.js:13-18`, `src/groups.js:524-572`, `src/membership.js:7-16`, `src/membership.js:274-335`, `src/membership.js:594-602`, `src/pages.js:189-212`, `test/e2e/groups.mjs:118-147`, `test/e2e/groups.mjs:251`.

### 9.4 The member API (on the group's site)

Every call carries `Authorization: Bearer <keyG>`. How the group handles the key:

- No key, or an unknown one: `401 {"error": "Not a member of this group."}`.
- Not yet approved: `403`, except `POST /_group/leave`.
- Unknown path: `404 {"error": "Not found."}`.

#### `GET /_group/posts?page=<n>`

Returns 20 posts per page, newest first:

```json
{
  "@context": [ … ],
  "type": "OrderedCollectionPage",
  "context": {
    "type": "Group", "id": "https://g.example/groups/1", "name": "Book club", "summary": "One book a month",
    "published": "…", "attributedTo": {"type": "Person", "id": "https://ann.example/", "name": "Ann Example"},
    "afterwrd:members": 3, "afterwrd:role": "member", "afterwrd:waiting": 0
  },
  "totalItems": 7, "afterwrd:page": 1, "afterwrd:hasNext": false,
  "orderedItems": [ { …group Note… } ]
}
```

- In the Group object, `afterwrd:role` is the caller's role, and `afterwrd:members` counts approved members.
- `afterwrd:waiting` (the number of requests to join) is sent only to admins.

A **group Note**:

```json
{
  "type": "Note", "id": "https://g.example/groups/1/posts/4",
  "attributedTo": {"type": "Person", "id": "https://bob.example/", "name": "Bob Example"},
  "context": "https://g.example/groups/1",
  "published": "…", "mediaType": "text/plain", "content": "…",
  "afterwrd:event": { …Event, 9.7… },
  "attachment": [ {"type": "Image", "url": "https://g.example/files/<hash>", "mediaType": "image/jpeg",
                   "width": 2560, "height": 1920, "afterwrd:fetch": "…signed…",
                   "preview": {"type": "Image", "url": "https://g.example/files/<thumb>", "mediaType": "image/jpeg",
                               "afterwrd:fetch": "…signed…"}} ],
  "replies": {"type": "Collection", "totalItems": 26,
              "items": [ {"type": "Note", "id": "https://g.example/groups/1/posts/4#c9",
                          "attributedTo": {"type": "Person", "id": "https://cat.example/", "name": "Cat Example"},
                          "inReplyTo": "https://g.example/groups/1/posts/4", "published": "…",
                          "mediaType": "text/plain", "content": "…"} ]}
}
```

- `replies.totalItems` is the full count of comments. `items` holds only the newest ones (20 on a page of posts, oldest first).
- Photos are always JPEG and have no `id`.
- Everyone is named with their own site: `attributedTo.id` is `<their origin>/`.

What a member's site accepts:

- **Page** (`parseGroupPage`). `context` must be a `Group` whose `id` is exactly the group it asked for; otherwise the whole answer is refused. The site reads:
  - `name`, up to 300 characters (default `A group`);
  - `about` (falling back to `summary`), up to 2000 characters;
  - `afterwrd:role`, if it is one of `owner`, `admin` or `member`;
  - `afterwrd:members` and `afterwrd:waiting`, if they are non-negative integers.
- **Posts.** It reads up to 100. A post is dropped unless:
  - `type` is `Note`;
  - `id` is `<group site>/groups/<n>/posts/<m>`, with `m` 1–15 digits;
  - `attributedTo.name` is 1–100 characters;
  - `published` parses.

  Within a kept post:
  - `content` is kept if it is 10,000 characters or fewer;
  - up to 20 attachments are read, using the media rules in 6.4 against the **group's** origin;
  - up to 500 comments are read, each with an `id` of exactly `<post id>#c<k>`;
  - `afterwrd:event` is read as in 9.7.

> Note: `context` is the Group's id (a string) on each Note in a page, but a full Group object at the top of single-post and event answers.

#### `GET /_group/posts/<m>`

Returns one group Note, with up to 300 comments, plus `@context`. Its `context` is the Group object. If the post is gone: `404 {"error": "That post isn't there any more."}`.

#### `GET /_group/members`

```json
{"@context": [ … ], "type": "Collection", "context": { …Group… }, "totalItems": 3,
 "items": [ {"type": "Person", "id": "https://ann.example/", "name": "Ann Example",
             "afterwrd:role": "owner", "afterwrd:joinedAt": "…"} ]}
```

Only approved members are listed. A member's site reads up to 200.

#### `GET /_group/events` and `GET /_group/events?when=past`

Returns an `OrderedCollection` with the Group as `context`. Each item is a group Note carrying `afterwrd:event`, with `replies.items` empty but `totalItems` kept.

- Upcoming: events that haven't finished, soonest first, at most 100.
- `when=past`: events that have finished, latest first, at most 30.

A member's site reads up to 200 items. An older group without events answers `404 "Not found."`, which member sites take to mean "outdated".

#### `POST /_group/posts`

The body is a Note:

```json
{"@context": [ … ], "type": "Note", "mediaType": "text/plain", "content": "…",
 "attachment": [ {"type": "Image", "url": "https://bob.example/files/<hash>", "mediaType": "image/jpeg",
                  "width": 2560, "height": 1920, "afterwrd:size": 812345,
                  "afterwrd:fetch": "https://bob.example/files/<hash>?exp=…&sig=…",
                  "preview": {"type": "Image", "url": "https://bob.example/files/<thumb>", "mediaType": "image/jpeg",
                              "afterwrd:fetch": "https://bob.example/files/<thumb>?exp=…&sig=…"}} ],
 "afterwrd:event": { …optional Event… }}
```

Rules:

- `type` must be `Note`: otherwise `400 "Expected a Note."`.
- `attachment` is optional. If present, it must be an array of at most 8 items, each meeting all of these:
  - `type: "Image"`;
  - `url` and `preview.url` on the **member's own origin** (the one that holds the key), under `/files/<64 hex>`;
  - both `afterwrd:fetch` links in the exact signed form (6.4);
  - `width` and `height` integers from 1 to 20,000;
  - `afterwrd:size` a positive integer of at most 8,000,000.

  Otherwise: `400` (`Unexpected photo details.` or `That photo is too big for a group.`).
- `content` is normalised as for comments and must be 5000 characters or fewer. A post needs text, a photo or an event.
- `afterwrd:event`, if present, must parse (9.7), must not be cancelled, and must not have finished already. Otherwise: `400`.
- The rate and size limits in 9.1 are checked before anything is fetched: `429` if over.
- The group then **fetches each file and thumbnail from the member's signed links**, server-side:
  - redirects are not followed;
  - each fetch has a 20 s timeout;
  - a file must be within its byte limit;
  - it is stored only if its bytes hash to the given SHA-256.

  If any file fails, the post is removed again and the answer is `400`.
- On success: `200 {"id": "https://g.example/groups/1/posts/<m>"}`. The member's site checks that the id is under that group.

#### `POST /_group/posts/<m>/delete` and `POST /_group/comments/<k>/delete`

These answer `200 {"ok": true}`, or `404 {"error": "That isn't yours, or it's already gone."}`. Who may delete:

- whoever wrote the post or comment;
- an admin, anything except what the owner wrote;
- the owner, anything.

Deleting a post deletes its comments, photos, answers and event. If the event was still to come, an event-cancelled note goes out first (9.6).

#### `POST /_group/comments`

```json
{"@context": [ … ], "type": "Note", "mediaType": "text/plain", "content": "…",
 "inReplyTo": "https://g.example/groups/1/posts/4"}
```

- `inReplyTo` must be a post in this group. Otherwise, or if `type` isn't `Note`: `404 {"error": "That isn't a post in this group."}`.
- `content` must be 1–2000 characters after normalising: otherwise `400`.
- Over the rate limit: `429`.
- On success: `200 {"id": "https://g.example/groups/1/posts/4#c<k>"}`. The member's site checks that the id is exactly `<post id>#c<k>`.

The group then sends comment notes (9.6).

#### `POST /_group/events/<m>/answer`

Body: `{"answer": "going" | "maybe" | "no"}`.

It answers `400` if the answer isn't one of those, or if the event is gone, called off or over.

#### `POST /_group/events/<m>/edit`

Body: `{"content": "…", "afterwrd:event": { …Event… }}`.

- Only the member who added the event may edit it. Anyone else gets `400`.
- It refuses, with `400`, an event that is off, one that is over, or a change that would leave it already over.
- If the title, time, end, all-day flag, time zone or place changes, the group sends an event-changed note (9.6). Such changes are allowed at most once every 300 s, checked and recorded in one statement: `400 "You've just changed this event. Try again in a few minutes."`. Changing only `content` sends nothing and isn't limited.

#### `POST /_group/events/<m>/cancel`

Body: `{}`.

- Who may cancel is the same as for deleting. Anyone else gets `400`.
- Calling off an event that is already off does nothing.
- Calling off an event that is over gets `400 "That event is over."`.
- Otherwise an event-cancelled note goes out. Only the first of several requests sent together sends it.

All three event actions answer `200` with the event's post, as `GET /_group/posts/<m>` would return it but with no comments, so that the member's site can update its copy.

#### `POST /_group/leave`

Answers `200 {"ok": true}` and forgets the member, along with their answers to events, so rejoining starts afresh. Their posts stay.

The owner can't leave: `400 {"error": "You own this group: delete it instead."}`.

Source: `src/groups.js:86-206`, `src/groups.js:208-439`, `src/groups.js:582-648`, `src/membership.js:49-131`, `src/membership.js:222-245`, `src/membership.js:355-466`, `test/e2e/groups.mjs:228-252`, `test/e2e/groups.mjs:332-342`.

### 9.5 Admin actions (on the group's site)

These need an approved member whose role is `owner` or `admin`. Anyone else gets `403 {"error": "Only the group's admins can do that."}`.

| Request | Effect |
|---|---|
| `GET /_group/admin/members` | As `/_group/members`, but also lists requests to join. Each item adds `afterwrd:member` (the member's number here) and `afterwrd:waiting` (`true` for a request). |
| `POST /_group/admin/members/<id>/approve` | Lets them in. Fails with `400` when the group is full or the request has expired. |
| `POST /_group/admin/members/<id>/decline` | Turns down a request (see below). |
| `POST /_group/admin/members/<id>/remove` | Removes a member (see below). |
| `POST /_group/admin/members/<id>/admin` | **Owner only.** Makes the member an admin. |
| `POST /_group/admin/members/<id>/member` | **Owner only.** Makes an admin an ordinary member again. |
| `POST /_group/admin/link` | `200 {"link": "https://g.example/_join/<token>"}`. Cancels the previous link. |
| `POST /_group/admin/about` | Body `{"name", "about"}`. `name` must be non-empty after trimming (cut to 100). `about` is normalised and cut to 1000. |
| `POST /_group/admin/close` | **Owner only** (`403` otherwise). See below. |

More on these actions:

- Nobody can act on themselves or on the owner, and only the owner can act on an admin. Breaking either rule gives `400`.
- `decline` and `remove` first call `POST /_member/removed` on that site (best effort), then forget it and its answers to events. What they posted stays.
- `close` empties the group, including its files, and marks it closed so it can never be claimed again. It then calls `POST /_member/removed` on up to 50 members' sites. The owner's site deletes the Worker afterwards; that step is outside this protocol.

Answers are `200 {"ok": true}`, or `400 {"error": …}`.

Source: `src/groups.js:33-40`, `src/groups.js:441-485`, `src/groups.js:650-681`, `src/groupsites.js:121-157`.

### 9.6 Notes from a group (to members' sites)

Notes go to `POST /_member/notify` on members' sites, with the key each member's site issued. Delivery is as in 2.5. A group sends only two kinds of note. New posts, new events and answers are never pushed.

**A comment** goes to approved members who wrote that post or have commented on it, apart from the comment's writer:

```json
{"@context": [ … ], "type": "Create",
 "object": {"type": "Note", "id": "https://g.example/groups/1/posts/4#c9",
            "inReplyTo": "https://g.example/groups/1/posts/4",
            "content": "first 200 characters", "attributedTo": {"type": "Person", "name": "Cat Example"}}}
```

**An event changed or called off** goes to approved members who answered `going` or `maybe`, apart from whoever made the change:

```json
{"@context": [ … ], "type": "Update", "afterwrd:change": "changed",
 "actor": {"type": "Person", "name": "Ann Example"},
 "object": {"type": "Note", "id": "https://g.example/groups/1/posts/12", "afterwrd:event": { …Event, 9.7… }}}
```

`afterwrd:change` is `changed` or `cancelled`. A cancelled event carries `afterwrd:cancelled`.

What a member's site does:

- **Comment notes.**
  - `object.inReplyTo` must be a post in that group: `400 {"error": "That isn't about a post in this group."}`.
  - The note is kept only if this site's owner wrote that post or commented on it, according to its own records. Otherwise it is ignored with `202`.
- **Update notes.**
  - `object.id` must be a post in that group, `afterwrd:event` must parse, and `afterwrd:change` must be `changed` or `cancelled`. Otherwise: `400 {"error": "That isn't about an event in this group."}`.
  - If this site's owner added the event themselves, a `changed` note is ignored (`202`). A `cancelled` note is accepted, but the owner's own record of the event's title, times, zone and place is kept: the group can only say the event is off.
  - If the owner has plans for that event, the site updates its copy of the event; for `cancelled`, it records the time the note arrived if the event carries none. It then keeps the note. If the owner has no plans for it, the note is ignored with `202`.
- **Both kinds.**
  - Text is cut to 200 or 400 characters, and names to 100.
  - Rate limits per group, counted separately for each kind:
    - comment notes: 60 per 600 s and 500 per day;
    - event notes: 10 per 600 s and 30 per day.

    Over a limit: `429`.
  - Kept notes are pruned after 60 days.

**`POST /_member/removed`** (body `{}`) answers `200 {"ok": true}`. The member's site forgets the group. The exception is a site that created that group: it keeps the group until its owner deletes it, so the Worker is never lost track of.

The group's key opens only `/_member/notify` and `/_member/removed`, plus `/_member/hello` while joining. It can't read anything on the member's site: `/_peer/*` answers `401`.

Source: `src/notify.js:12-17`, `src/notify.js:94-181`, `src/membership.js:587-614`, `test/e2e/groups.mjs:181-193`, `test/e2e/groups.mjs:246-251`, `test/e2e/groups.mjs:313-323`, `test/e2e/groups.mjs:349-354`.

### 9.7 Events

An event is a group post with an `afterwrd:event` object:

```json
{
  "type": "Event",
  "name": "Book swap",
  "startTime": "2027-06-12T18:00:00Z",
  "endTime": "2027-06-12T20:00:00Z",
  "afterwrd:allDay": false,
  "afterwrd:timeZone": "Europe/London",
  "location": {"type": "Place", "name": "Ann's house"},
  "afterwrd:cancelled": "2027-06-01T09:00:00Z"
}
```

Fields:

- `startTime` and `endTime` are moments in time. They are shown in `afterwrd:timeZone`, so "7pm" means 7pm where the event is.
- An all-day event starts at local midnight on its first day. Its `endTime`, if present, is local midnight at the start of its **last** day.
- `endTime`, `location` and `afterwrd:cancelled` are optional.

In group reads, the event also carries:

- `afterwrd:going`, `afterwrd:maybe` and `afterwrd:cantGo`: lists of `{"type": "Person", "id": "<origin>/", "name"}`;
- `afterwrd:answer`: the caller's own answer (`going`, `maybe` or `no`), if they have given one.

A receiver (`parseEvent`) refuses the event unless all of these hold:

- `type` is `Event`;
- `name`, with whitespace collapsed and cut to 200 characters, is non-empty;
- `afterwrd:timeZone` is a string of 64 characters or fewer, matching `^[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+){0,2}$`, that names a time zone the runtime knows;
- `startTime` parses, and falls from 2000-01-01 to 2100-01-01 (UTC);
- `endTime`, if present and not null, parses, and is after `startTime` (or equal to it, for an all-day event), and no more than 31 days later.

It then reads:

- `afterwrd:allDay` as true only if it is literally `true`;
- `location.name`, cut to 300 characters;
- `afterwrd:cancelled`, if present, as a time.

It reads up to 200 names in each of the going, maybe and can't-go lists.

**When an event has finished:**

- all-day: (`endTime` or `startTime`) + 24 h;
- otherwise: `endTime`, or `startTime` + 3 h if there is no end.

**Changes that send a note:** a change to the title, start, end, all-day flag, time zone or place. A change to the post's text alone sends nothing.

Source: `src/calendar.js:1-28`, `src/calendar.js:80-87`, `src/calendar.js:132-166`, `src/membership.js:72-79`, `src/groups.js:112-120`, `test/e2e/forged.mjs:71-82`.

### 9.8 The member keeps its own copy (receiver expectation)

A member's site records everything its owner sends to a group: each post's id, text, photo hashes, event fields and time, and each comment's id, post and text.

When it shows what the group returns (`markMine`):

- A post or comment the site sent is shown with **its own recorded** text and time. Only the photos it sent are shown, and its event's title, times, zone and place come from its own record. Who's going, and whether the event is off, are taken from the group.
- A post the site sent without an event is shown without one, whatever the group now attaches.
- A comment is shown as the owner's only under the post it was sent to.
- Anything else claiming to be by this site's owner (`attributedTo.id` = its own origin) is **dropped**.
- The site keeps a copy of an event (its owner's "plans") only when its owner answers `going` or `maybe` from that site, and drops it when they answer `no`. The group's `afterwrd:answer` never creates or drops a copy; it only updates copies already kept. A site keeps at most 200 such copies per group.

A compatible member site should do the same. A group must not be able to put words in a member's mouth, add photos to their post, or move their comment.

Source: `src/membership.js:1-5`, `src/membership.js:133-163`, `src/membership.js:355-466`, `test/e2e/forged.mjs:33-67`, `test/e2e/groups.mjs:209-218`, `test/e2e/groups.mjs:343-346`.

## 10. Security considerations

A **caller** must:

- Accept only `https` origins (2.1) and never follow redirects.
- Bound every call with a timeout and a size limit (2.3).
- Treat every answer as untrusted. That means:
  - parse it field by field;
  - check types and lengths;
  - drop what doesn't fit, rather than failing open.
- Require every id in an answer to sit under the origin it called: posts, comments, media `url`s, signed links, group and group-post ids. A friend's answer may not refer to files on another site.
- Accept only signed links of the exact shape in 6.4, because they end up in HTML attributes.
- Check that a handshake answer has a key of the key pattern and, for groups, the expected group number.
- Show its owner's own comments and group posts from its own records (6.5, 9.8), never from the other site.

A **receiver** must:

- Identify the caller only by the bearer key, looked up by its hash. It must never take identity from the body.
- Answer `/_peer/hello` and `/_member/hello` only for a relationship that is still pending, and only to the exact origin (and group) it was made for.
- Give an unapproved connection or member nothing except the chance to withdraw or leave.
- Check limits in the same step as the write, so that requests sent all at once can't slip past.
- Accept notes only about its *own* posts or photos from a friend, or its *own* group's posts from a group. It keeps them only if its owner is part of that thread.
- Serve files without a session only for an unexpired, valid signature, for that one file.
- When copying files from another site (groups), check the size before and while reading, and check that the bytes match the hash.

**Keys:**

- Keys are random, 43 characters or more, and specific to one relationship and one direction.
- Issuers store only SHA-256 hashes of the keys they issue. They store the keys they hold for calling others in plain text, because they must send them.
- Keys never appear in exports.
- Disconnecting, leaving, removal or closing deletes the relevant keys on both sides where the other side can be reached.
- The group's setup key (`GROUP_KEY`) is used once, to claim the group, and the group compares it by hash.

**Not covered:** these cover authorisation, not confidentiality beyond TLS. A friend's site sees everything its owner may see, and nothing stops a friend's owner from copying it.

Source: `src/peers.js:32-40`, `src/peers.js:94-117`, `src/friends.js:1-19`, `src/membership.js:594-603`, `src/groups.js:237-272`, `src/groups.js:500`, `test/e2e/forged.mjs`, `test/e2e/feed.mjs:178-214`, `test/e2e/feed.mjs:355`, `test/e2e/groups.mjs:228-254`.

## 11. Versioning

- The protocol version is an integer. This document describes **version 1**.
- It is sent as `"protocol": 1` in the answers to `GET /_peer/hello` and `GET /_member/hello`, which each side sees once, during pairing or joining. It is also sent in the answer to `GET /_group/ping`, which needs no key.
- Receivers must ignore fields they don't know. Adding a field, an endpoint or an optional value does **not** change the version.
- A change that a site speaking an older version would misread or refuse, such as a renamed field, a changed id format, a tighter rule or a removed endpoint, **does** change it.
- A site that sees a `protocol` it doesn't support should say so to its owner rather than guess.

Sites released before the field was added (up to and including afterwrd 0.20.2) send no `protocol` field. A receiver should treat a missing field as version 1: their wire format is what this document describes, apart from features they predate. For example, groups older than events answer `404` on `/_group/events`.

> Note: at the time of writing, no code reads the `protocol` field. It is announced but not yet checked.

Source: `src/peers.js:27-29`, `src/peers.js:111`, `src/membership.js:601`, `src/groups.js:585`, `src/membership.js:226-234`.

## 12. Prior art, and how afterwrd differs

afterwrd borrows ActivityStreams' vocabulary but isn't ActivityPub, and most of its ideas have relatives elsewhere. As
far as we know (November 2026; corrections welcome):

- **Private Webmention** (IndieWeb): a site sends a short-lived code, the receiver swaps it at the sender's token
  endpoint and fetches the private post with a bearer token. This is the nearest ancestor of afterwrd's pairing and
  fetching (4, 5). <https://indieweb.org/Private-Webmention>
- **Hubzilla, Streams and Forte** (the Friendica lineage; Zot, Nomad, then ActivityPub with FEPs): the same aim of a
  private, permissions-first, Facebook-shaped network. They push signed copies to permitted servers and make identity
  portable across servers. afterwrd pulls, keeps no copies, and is one origin per person.
- **OpenWebAuth** (FEP-61cf): a visitor's browser is recognised on another site, so private pages are shown where they
  live. The same "check at the source" principle as afterwrd, done through the browser rather than server to server.
  It leaves media access out; afterwrd's short-lived signed links (7) are one answer to that.
- **Conversation Containers** (FEP-171b) and context ownership (FEP-11dd, FEP-8c13): the post's owner holds the thread,
  as in afterwrd (5.7). They then push the thread out as copies; afterwrd's viewers fetch it.
- **Authentication for non-public groups** (FEP-db0e, Smithereen): short-lived tokens proving membership, kin to
  afterwrd's per-member keys (9) and signed links. **Smithereen** is the most Facebook-shaped ActivityPub server
  (friends, walls, groups, events, albums).
- **Group federation** (FEP-1b12, FINAL) and the SWICG Groups task force: groups re-share members' activities; whether a
  group could alter them depends on signatures. In afterwrd each member's site keeps its own copy of what they said
  (9.8), so a group can't put words in their mouth by design. Private group access isn't yet covered there.
- **Events**: afterwrd's going, maybe and no correspond to `Accept`, `TentativeAccept` and `Reject` on an `Event`, as
  Friendica and Hubzilla use them; FEP-8a8e proposes common `Event` properties. Telling only attendees about changes
  (9.7) isn't covered by either.
- **AT Protocol "spaces"** (alpha, August 2026): each member keeps their own records for a space on their own server,
  apps pull them with short-lived credentials, and commits aren't signed so they can't be used as proof. Structurally
  the closest thing to afterwrd's groups, though apps may sync and cache where afterwrd sites fetch on demand.
- **Portable identity** (FEP-ef61, Forte, Mitra; Bluesky's DIDs): deliberately not done here. A site is its address.

What we think is unusual in afterwrd's combination: no copies at all (friends' sites fetch when their owner looks,
so deleting deletes); a secret key per friendship rather than public keys and discovery; notes that say only that
something is new, to those involved; and one person per free, serverless site.

## Appendix: endpoint table

Notes on the "Auth" column:

- "issued key" means `Authorization: Bearer <key>`, where the answering site issued the key to the caller.
- A **person's site** is an ordinary afterwrd site. A **group's site** is a group Worker.

### On a person's site

| Method | Path | Caller | Auth | Purpose |
|---|---|---|---|---|
| GET | `/_connect/<token>` | A browser | none (link) | HTML page that hands off to the visitor's own site |
| GET | `/_connect/<token>/info` | The joining site | none (link) | `{name}` of whoever made the link |
| POST | `/_connect/<token>/accept` | The joining site | none (link) + hello proof | Pair: `{origin, key}` → `{name, key}` |
| GET | `/_peer/hello?from=` | The site being paired with | issued key (pending only) | Proves the key → `{name, protocol}` |
| GET | `/_peer/feed` | A friend's site | issued key (approved) | Newest 30 afterwrd posts with comments |
| GET | `/_peer/posts?page=` | A friend's site | issued key (approved) | Posts, 30 per page |
| GET | `/_peer/albums` | A friend's site | issued key (approved) | Albums the friend may see |
| GET | `/_peer/albums/<key>?page=` | A friend's site | issued key (approved) | An album's media, 150 per page |
| GET | `/_peer/photos/<sha256>` | A friend's site | issued key (approved) | One photo or video, with comments and neighbours |
| POST | `/_peer/comments` | A friend's site | issued key (approved) | Comment on a post or photo → `{id}` |
| POST | `/_peer/comments/<n>/delete` | A friend's site | issued key (approved) | Delete its own comment |
| POST | `/_peer/notify` | A friend's site | issued key (approved) | A note (section 8) |
| POST | `/_peer/disconnect` | A friend's site | issued key (pending or approved) | Ends the connection |
| GET | `/_member/hello?from=&group=` | A group's site | issued key (joining only) | Proves the key → `{name, protocol}` |
| POST | `/_member/notify` | A group's site | issued key | A group note (9.6) |
| POST | `/_member/removed` | A group's site | issued key | Removed, declined, or the group closed |
| GET, HEAD | `/files/<sha256>?exp=&sig=` | A browser or a group's site | signed link | One file, until `exp` |

### On a group's site

| Method | Path | Caller | Auth | Purpose |
|---|---|---|---|---|
| GET | `/_group/ping` | The owner's site | none | `{afterwrd: "group", version, protocol}` |
| POST | `/_group/claim` | The owner's site | `setup` key in the body + hello proof | Claim once → `{key, id, name, about, owner}` |
| GET | `/_join/<token>` | A browser | none (link) | HTML page that hands off to the visitor's own site |
| GET | `/_join/<token>/info` | The joining site | none (link) | `{id, name, about, owner}` |
| POST | `/_join/<token>/accept` | The joining site | none (link) + hello proof | Ask to join → `{key, id, name, about, owner}` |
| GET | `/_group/posts?page=` | A member's site | issued key (approved) | 20 posts per page, with the newest 20 comments each |
| GET | `/_group/posts/<m>` | A member's site | issued key (approved) | One post, with up to 300 comments |
| GET | `/_group/members` | A member's site | issued key (approved) | Approved members |
| GET | `/_group/events[?when=past]` | A member's site | issued key (approved) | Upcoming (or past) events |
| POST | `/_group/posts` | A member's site | issued key (approved) | New post or event → `{id}` |
| POST | `/_group/posts/<m>/delete` | A member's site | issued key (approved) | Delete a post (own, or as an admin or the owner) |
| POST | `/_group/comments` | A member's site | issued key (approved) | Comment → `{id}` |
| POST | `/_group/comments/<k>/delete` | A member's site | issued key (approved) | Delete a comment |
| POST | `/_group/events/<m>/answer` | A member's site | issued key (approved) | `{answer}` → the event's post |
| POST | `/_group/events/<m>/edit` | A member's site | issued key (approved, writer) | Change an event → the event's post |
| POST | `/_group/events/<m>/cancel` | A member's site | issued key (approved, writer, admin or owner) | Call an event off → the event's post |
| POST | `/_group/leave` | A member's site | issued key (any, not the owner) | Leave, or withdraw a request |
| GET | `/_group/admin/members` | An admin's site | issued key (admin) | Members and requests |
| POST | `/_group/admin/members/<id>/(approve\|decline\|remove)` | An admin's site | issued key (admin) | Decide on someone |
| POST | `/_group/admin/members/<id>/(admin\|member)` | The owner's site | issued key (owner) | Change someone's role |
| POST | `/_group/admin/link` | An admin's site | issued key (admin) | New invite link → `{link}` |
| POST | `/_group/admin/about` | An admin's site | issued key (admin) | `{name, about}` |
| POST | `/_group/admin/close` | The owner's site | issued key (owner) | Empty the group and tell its members |
| GET, HEAD | `/files/<sha256>?exp=&sig=` | A browser | signed link | A group photo, until `exp` |

### Not part of the protocol

Every other path on a person's site needs the owner's passkey session and is not part of this protocol. That includes `/_auth/…`, `/_admin/…`, `/_comments`, `/_feed/…`, `/_groups/…`, `/_cloudflare/…`, `/_live` and the archive pages.

Two of those owner pages do act as browser hand-off targets for links:

- `/_admin/connections/new?link=` (from a Connect link page);
- `/groups/join?link=` (from a group invite page).
