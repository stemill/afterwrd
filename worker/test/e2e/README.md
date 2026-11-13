# End-to-end tests

These run real local copies of afterwrd (`wrangler dev`) and drive them with Chrome, using a virtual passkey
authenticator, so they test what people actually do: setting up, inviting, importing, posting, commenting,
connecting sites, downloading everything and updating. Everything in `fixtures/` is made up: a tiny Facebook
download for "Test Person", a friends list, and plain test photos.

```sh
cd worker
npm run test:e2e                      # everything (about 15 minutes)
npm run test:e2e -- feed              # one or more suites: core fresh albums update feed groups forged
npm run test:e2e -- upgrade v0.17.0   # an older release's site (0.17.0 or later), upgraded in place to this code
```

The tests drive their own copy of Chrome, the version this Puppeteer is made for, downloaded the first time into
`test/e2e/chrome/` (about 200 MB; `chrome.mjs`). Chrome on the computer updates itself, and once it's ahead of
Puppeteer the tests lose track of a page now and then ("detached Frame"); set `CHROME` to use another anyway. You need `zip`, and ports 8787–8790 free, so
stop `npm run dev` first. The update tests read the latest release from GitHub, so they need the internet. Your
own local database (`.wrangler/state`) is set aside while the tests run and put back afterwards. Logs, screenshots
and downloads go to `out/`, which git ignores.

| Suite | What it covers |
|---|---|
| core: `security.mjs` | setup links, cookies and headers (pages may only call their own site), passkeys must check it's you, sign-in redirects, CSRF, device links, signing out everywhere, the import's checks |
| core: `comments.mjs` | the owner's comments, escaping, deleting, rate limits (even sent all at once), surviving re-import |
| core: `posts.mjs` | the composer, photos resized and stripped of hidden details, deleting posts and their files |
| core: `admin.mjs` | Your devices: adding a device, removing a passkey, signing out everywhere, only one owner; Home's notices for a new device (not hideable from that device) and for an update that fixes a security problem |
| `notifications.mjs` | two sites and a stand-in push service that decrypts what it's sent: turning notifications on from Events (only from the owner's own pages, only to a push service), Home's notice and Your devices; a notification for an invitation, a change and calling off, encrypted and signed, with or without the details on the lock screen, all the same size; none for posts, comments, an event said no to, one taken back, or a forged invitation; a push service asked again after "try later"; a device that's gone forgotten; a device's new address; turning off from Your devices, by signing out, or from the device; Download leaving out keys and devices; Add to home screen (the Home note, the menu, each device's steps, the manifest); and the messages that used to be here gone (`404`, no menu, no tables). Also `test/webpush.mjs`: the encryption checked against RFC 8291's worked example |
| `fresh.mjs` | a brand-new site with nothing imported, then imports with only Photos or only Posts ticked |
| `albums.mjs` | albums, adding and deleting photos, profile picture and cover |
| `update-ui.mjs` | the Update page with an update waiting (Connect Cloudflare end to end, against a stand-in for Cloudflare's token endpoint and the relay page: the state and PKCE cookie, the code posted back, the hour's token in a cookie, and the update running with it; the pasted-token fallback), a token an old version remembered (Forget it), and up to date; no downgrades |
| `feed.mjs` | three sites: connecting and approving (or declining) requests, inviting a Facebook friend, Feed, friend pages, comments across sites, signed photo links, the Friends list, Download everything matching up, disconnecting, and attempts to impersonate a site |
| `groups.mjs` | three sites and a group's own Worker (group mode, on 8790): claiming the group, invite links and letting people in, admins, reading and posting from members' own sites (photos copied to the group's Worker), comments reaching only those who wrote or commented on the post, live updates, events (adding one tells no one; answering; changing the words tells no one, changing the time tells only those going or who might; calling off; calendar files; only the writer can change one; the group unable to reword one or send notes about events a member isn't going to), the group unable to speak for a member, keys that open nothing else, a group Worker serving nothing else, moderating, renaming, leaving, removing, and deleting the group. (Making the Worker in Cloudflare can't run locally: the test starts one and claims it.) |
| `events.mjs` | three sites and a group's Worker: making a personal event and inviting a friend; a friend who isn't invited getting nothing about it by any route (feed, posts and counts, its address, comments, answers, polls, notes); invitations in Notifications and on Events; answering from Events and the event's page, in place; who's going and who might shown to everyone invited, who can't only to the host; inviting more; changes told to everyone who hasn't said no, at most one every few minutes, words alone telling no one; a phone with notifications on hearing of each invitation and change (friends' and a group's), and nothing else; forged notes and answers; taking an invitation back quietly; the month calendar (own, friends' and groups' events; a chosen day; dots on a phone, no sideways scroll); Week and List views; repeating events in a group (the form's choices, the rule kept, answers per date, refused answers without a date or to a date it lacks, a calendar file with RRULE and EXDATE, calling off one date and telling only those going to it, changing the time moving each date of a member's copies); calling off, deleting, Download everything, and removing a friend |
| `screenshots.mjs` | not a test: three made-up people, friends with each other, with painted photos, posts, comments and a group with events, photographed for the README into `docs/screenshots/` (`npm run test:e2e -- screenshots`; not part of the default run) |
| `checks.mjs` | checking a friend's site: the check link, the friend's page, Connect with read-only access (PKCE checked), a genuine site, tampered code, a change afterwrd doesn't make (escaped), the wrong account, the Friends list, refusals; against stand-ins for Cloudflare and GitHub on 8799 |
| `central.mjs` | the installer at install.afterwrd.app (central/, on 8791): Connect straight to Cloudflare with PKCE, a brand-new account choosing a workers.dev name (a taken one turned down), what's deployed (bindings, setup code, workers.dev switched on), a leftover database stopping it first, choosing between two accounts, refusals; against stand-ins for Cloudflare, GitHub and the new site |
| `forged.mjs` | the code that reads friends' sites, fed what a hostile site might send |
| `upgrade.mjs` | posts, photos and comments made on an older release survive the upgrade |

Each suite starts on a new site.
