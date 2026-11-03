# End-to-end tests

These run real local copies of afterwrd (`wrangler dev`) and drive them with Chrome, using a virtual passkey
authenticator, so they test what people actually do: setting up, inviting, importing, posting, commenting,
connecting sites, downloading everything and updating. Everything in `fixtures/` is made up: a tiny Facebook
download for "Test Person", a friends list, and plain test photos.

```sh
cd worker
npm run test:e2e                      # everything (about 15 minutes)
npm run test:e2e -- feed              # one or more suites: core fresh albums update feed forged
npm run test:e2e -- upgrade v0.12.0   # an older release's site, upgraded in place to this code
```

You need Google Chrome (set `CHROME` to its path if it isn't in /Applications), `zip`, and ports 8787–8789 free, so
stop `npm run dev` first. The update tests read the latest release from GitHub, so they need the internet. Your
own local database (`.wrangler/state`) is set aside while the tests run and put back afterwards. Logs, screenshots
and downloads go to `out/`, which git ignores.

| Suite | What it covers |
|---|---|
| core: `security.mjs` | setup links, cookies and headers, sign-in redirects, CSRF, invites, revoking, the import's checks |
| core: `comments.mjs` | the owner's comments, escaping, deleting, rate limits (even sent all at once), surviving re-import |
| core: `posts.mjs` | the composer, photos resized and stripped of hidden details, deleting posts and their files |
| core: `admin.mjs` | Your devices: adding a device, removing a passkey, signing out everywhere, no inviting anyone else |
| `fresh.mjs` | a brand-new site with nothing imported, then imports with only Photos or only Posts ticked |
| `albums.mjs` | albums, adding and deleting photos, profile picture and cover |
| `update-ui.mjs` | the Update page with an update waiting, a remembered token, and up to date; no downgrades |
| `feed.mjs` | three sites: connecting and approving (or declining) requests, inviting a Facebook friend, Feed, friend pages, comments across sites, signed photo links, the Friends list, Download everything matching up, disconnecting, and attempts to impersonate a site |
| `forged.mjs` | the code that reads friends' sites, fed what a hostile site might send |
| `upgrade.mjs` | posts, photos and comments made on an older release survive the upgrade |

The `core` suites share one database and must run in that order.
