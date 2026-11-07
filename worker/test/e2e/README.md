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

You need Google Chrome (set `CHROME` to its path if it isn't in /Applications), `zip`, and ports 8787–8790 free, so
stop `npm run dev` first. The update tests read the latest release from GitHub, so they need the internet. Your
own local database (`.wrangler/state`) is set aside while the tests run and put back afterwards. Logs, screenshots
and downloads go to `out/`, which git ignores.

| Suite | What it covers |
|---|---|
| core: `security.mjs` | setup links, cookies and headers (pages may only call their own site), passkeys must check it's you, sign-in redirects, CSRF, device links, signing out everywhere, the import's checks |
| core: `comments.mjs` | the owner's comments, escaping, deleting, rate limits (even sent all at once), surviving re-import |
| core: `posts.mjs` | the composer, photos resized and stripped of hidden details, deleting posts and their files |
| core: `admin.mjs` | Your devices: adding a device, removing a passkey, signing out everywhere, only one owner; Home's notices for a new device (not hideable from that device) and for an update that fixes a security problem |
| `fresh.mjs` | a brand-new site with nothing imported, then imports with only Photos or only Posts ticked |
| `albums.mjs` | albums, adding and deleting photos, profile picture and cover |
| `update-ui.mjs` | the Update page with an update waiting (Connect Cloudflare end to end, against a stand-in for Cloudflare's token endpoint and the relay page: the state and PKCE cookie, the code posted back, the hour's token in a cookie, and the update running with it; the pasted-token fallback), a token an old version remembered (Forget it), and up to date; no downgrades |
| `feed.mjs` | three sites: connecting and approving (or declining) requests, inviting a Facebook friend, Feed, friend pages, comments across sites, signed photo links, the Friends list, Download everything matching up, disconnecting, and attempts to impersonate a site |
| `groups.mjs` | three sites and a group's own Worker (group mode, on 8790): claiming the group, invite links and letting people in, admins, reading and posting from members' own sites (photos copied to the group's Worker), comments reaching only those who wrote or commented on the post, live updates, events (adding one tells no one; answering; changing the words tells no one, changing the time tells only those going or who might; calling off; calendar files; only the writer can change one; the group unable to reword one or send notes about events a member isn't going to), the group unable to speak for a member, keys that open nothing else, a group Worker serving nothing else, moderating, renaming, leaving, removing, and deleting the group. (Making the Worker in Cloudflare can't run locally: the test starts one and claims it.) |
| `screenshots.mjs` | not a test: three made-up people, friends with each other, with painted photos, posts, comments and a group with events, photographed for the README into `docs/screenshots/` (`npm run test:e2e -- screenshots`; not part of the default run) |
| `forged.mjs` | the code that reads friends' sites, fed what a hostile site might send |
| `upgrade.mjs` | posts, photos and comments made on an older release survive the upgrade |

Each suite starts on a new site.
