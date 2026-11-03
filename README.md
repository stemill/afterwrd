# afterwrd

Your Facebook archive as a private website that only people you invite can see: your posts, photos and
videos (and, if you choose, comments, likes and friends), with search. The people you invite can comment on
your posts and photos, and those comments become part of your archive. It runs in your own free Cloudflare
account, so no one else holds your data, and setting it up needs no terminal, no GitHub account and no card.

afterwrd isn't affiliated with or endorsed by Meta. It only reads the "Download your information" file Facebook
gives you; it never signs in to Facebook or fetches anything from it.

## Install your own

**Easiest: follow the install page, <https://afterwrd.app/>,** which has a button that copies the
installer for you. The same steps in full:

You need your Facebook download and a free Cloudflare account. It takes about 15 minutes, most of it waiting
for Facebook.

1. **Get your Facebook download.** On Facebook: Settings → *Download your information* → choose your
   profile, *All available information*, format **JSON**, media quality *High*. Facebook emails you when it's
   ready (from minutes to a day); download the zip file(s).
2. **Make a Cloudflare account** at <https://dash.cloudflare.com/sign-up>. An email address is all it asks
   for; don't add a card.
3. **Create a Worker.** In the Cloudflare dashboard's left-hand menu: *Compute* → *Workers & Pages* →
   *Create application* (top right) → *Start with Hello World*. Replace the made-up *Worker name* (something
   like `blue-mud-43e4`) with `afterwrd`, or whatever you like: it becomes your address,
   `afterwrd.<your-name>.workers.dev`. Leave *Protect with Cloudflare Access* off (afterwrd has its own
   sign-in) and press *Deploy*. The first time, Cloudflare asks you to choose `<your-name>`.
4. **Paste in the installer.** Press *Copy installer* on the [install page](https://afterwrd.app/)
   (or download `installer.js` from the [latest release](https://github.com/stemill/afterwrd/releases/latest) and
   copy all of it), then in the Worker press *Edit code*, select everything there, paste over it and press *Deploy*.
5. **Run it.** Open your Worker's address. Press **Create a token**: Cloudflare's token page opens with the
   permissions filled in; scroll down, press *Continue to summary*, *Create Token*, and copy the token. Paste it
   into the installer and press **Install afterwrd**.
6. **Make yourself the owner.** The installer hands over to afterwrd: give your name and create a passkey
   (your face, fingerprint or device PIN; there's no password).
7. **Import.** Choose *Import* in the menu, pick your Facebook zip file(s), tick what to publish and press
   *Import and publish*. Your browser reads the download; only what you tick is uploaded.
8. **Invite people** from *People* in the menu: each gets a one-time link to make their own passkey.

Afterwards you can delete the token (Cloudflare: *My Profile* → *API Tokens*); it's only used while
installing. The installer checks every file it downloads against the fingerprint built into it, so what's
installed is exactly the published release. Cloudflare's free plan allows 5 GB of photos and videos.

### Keeping it safe

- **Turn on two-factor authentication for your Cloudflare account** (My Profile → Authentication). Anyone who gets
  into that account can see your whole archive.
- **Delete the installer's token afterwards.** afterwrd doesn't keep it, but while it exists it can change your Workers.
- **Send invite links somewhere only that person will see them**: whoever opens a link first gets in. Under
  *People → Devices & links* you can cancel unused links, delete a passkey or sign someone out everywhere. Links for
  your own account (to add a device) give owner access, so they last only an hour.
- **Photo locations are left out** unless you tick *Photo locations* when importing; they can show where you live.
- **Keep it up to date.** The owner's *Update* page installs a newer release, keeping everyone's access and your
  archive. (Pasting a newer `installer.js` over your afterwrd Worker does the same.)

## Browsing an export locally

Request the export from Facebook in **JSON** format, unzip it, then:

```sh
uv run afterwrd-ingest ~/Downloads/facebook-<you>-<date>-<id>   # one-off import
uv run afterwrd                                                  # http://127.0.0.1:8000
```

The import writes `data/afterwrd.db` (SQLite) and copies the referenced photos
and videos to `data/media/`, so the original export can be archived. Re-running
it rebuilds the database from scratch. `data/` is git-ignored: it's personal.
Set `AFTERWRD_DATA` to keep it somewhere else.

## Running and developing the Worker

`worker/` is a Cloudflare Worker that shows your archive only to people who've signed in with a passkey.
You import from a page on the site itself: your browser reads the Facebook download and uploads only the
sections you choose. Posts, people and the rest go into D1, photos and videos into Durable Objects, and the
Worker builds pages from them, so search and filters work as they do locally. Cloudflare's free plan covers
it with no card needed: Workers, D1 and SQLite-backed Durable Objects only, no R2 or Zero Trust.

**One-off setup.** Every command below runs in `worker/`.

1. Create a free Cloudflare account at <https://dash.cloudflare.com/sign-up>. It needs only an email address.
2. Install the Worker's tools, sign in and deploy. The first time, wrangler asks you to pick a workers.dev
   subdomain and creates the database:
   ```sh
   cd worker
   npm install
   npx wrangler login                       # opens the browser
   npm run deploy
   ```
3. Invite yourself as the owner. Use the address the deploy printed:
   ```sh
   npm run invite -- add "Your Name" --owner --url https://afterwrd.<subdomain>.workers.dev
   ```
   Open the link and create a passkey.
4. Go to **Import** in the menu, choose the zip file(s) from Facebook (or the unzipped folder), tick what to
   publish and press **Import and publish**.

**Afterwards.** Nothing needs the terminal:

- **Import** again whenever you have a newer download, or to change what's published. Files already on the
  site aren't uploaded again, and files the new import doesn't use are deleted. Visitors see the old version
  until the new one is complete.
- **People** invites someone (copy or share their one-time link), sends a fresh link for a new phone or lost
  passkey, and revokes access, which signs the person out at once and deletes their passkeys.
- **New posts.** The owner can write posts on the site, with up to 20 photos, from the box at the top of
  *Posts*. Photos are resized to at most 2560px in the browser before uploading, which also removes the
  details phones hide in them (such as where a photo was taken), and they're collected in a *Posted on
  afterwrd* album. Importing again keeps them; deleting a post deletes its photos and comments.
- **Update** (marked when a new version is out) shows what's new and installs it. It needs a Cloudflare API
  token; tick *Remember* and it's kept as an encrypted secret of the site (unreadable, even by you), so later
  updates are one click. *Forget it* removes it. A remembered token can change any Worker in that Cloudflare
  account, so only remember it if the account is just for afterwrd.
- **Download everything** (the download icon) saves the whole site as one zip: posts, photos and videos,
  albums, comments (those written here, and yours on friends' sites), likes, friends and connections, as
  [ActivityStreams](https://www.w3.org/TR/activitystreams-core/) JSON, the open format the fediverse uses, with
  every photo and video. Everything has a permanent address (`https://<site>/posts/<key>`,
  `…/photos/sha256/<fingerprint>`, `…#c<n>` for a comment), so two friends' downloads agree on which comment
  replied to which post. The README inside explains the files. Keys and sign-in details are never included.
- **Feed and connections.** Connect with friends who have their own afterwrd site: make a one-time Connect
  link under *Feed → Connections* and send it to them; they open it, say where their site is, and confirm there.
  Connections are mutual, and make you friends: *Feed* (only the owner sees it) shows the newest posts written on
  each connected site, comments you make there are stored on your friend's site with a copy kept on yours, and
  either of you can look round the other's whole site (everything published, as an invited person would) by
  coming in through your own: *Visit* in Feed or Connections, or "Connected friend?" on their sign-in page.
  No invite or passkey is needed, and disconnecting ends it at once. Invites stay for people without a site. Sites exchange posts
  and comments as ActivityStreams too. Only posts written on
  afterwrd are shared, never an imported archive. Either side can disconnect. Two sites in the same Cloudflare
  account can connect too.
- **Comments.** Anyone who can see the site can comment under a post or photo; comments show straight away.
  People can delete their own, and the owner can delete any. *Activity* lists the latest, with a count in the
  menu of those that are new to you. Comments are kept when you import again, and stay (under the person's
  name) if you revoke someone, until you delete them.

`npm run deploy` is only for new versions of afterwrd's code; it never touches your archive.
`npm run invite` still has `list`, `again` and `revoke` for use from the terminal.

**What's published.** Only what the chosen sections show; the rest never leaves your computer. With the
default (posts and photos):
- comments are published only when a photo is attached to them;
- likes and your friends list stay on your computer;
- people appear by name only where a post or photo mentions them, without friendship dates.

Files over 95 MB (the most Cloudflare accepts in one upload) are left out with a note. The free plan allows
5 GB of photos and videos in all.

**Releasing.** Bump `version` in `worker/package.json`, commit, then tag and push:
```sh
git tag -a v<version> -m "afterwrd <version>" && git push origin v<version>
```
A GitHub Action (`.github/workflows/release.yml`) builds the release from the tagged code and publishes it with
every file attached, including `installer.js`. To build one locally instead:
`npm run release -- --base https://github.com/stemill/afterwrd/releases/download/v<version>` in `worker/`.

**Testing.** `npm run test:ingest -- <export folder>` checks the browser importer against
`uv run afterwrd-ingest` row by row. To try the site locally: `npx wrangler d1 migrations apply afterwrd --local`,
`npm run dev`, then `npm run invite -- add "Test" --owner --local` and import at
`http://localhost:8787/_admin/import`. Passkeys work on `localhost` but not on `127.0.0.1`.

## What the import does

- Fixes Facebook's text encoding (`JÃ¡nos` → `János`, broken emoji).
- Parses summary lines such as *"Ste Millington commented on Jo Bloggs's photo."*
  into an owner and a kind (post, photo, comment, reel…), so comments and likes
  can be grouped by person even when the post itself isn't in your export.
- Merges Facebook's two like/reaction formats (a newer one with URLs, an older
  one with only summary lines) by timestamp.
- Folds in group posts and group comments, which live in a separate folder.
- Links each photo or video to its album, post or comment.
- Records each photo's dimensions and writes a thumbnail (max 900×600) to
  `data/thumbs/`, used by the grids; the full image is only loaded in the viewer.
- Picks your current profile picture from the profile update history, and your
  cover photo as the newest upload in the "Cover photos" album (Facebook
  doesn't record cover changes).

## Data model

| Table           | What                                                              |
|-----------------|-------------------------------------------------------------------|
| `people`        | Everyone named anywhere; `friend_since` set for current friends   |
| `posts`         | Your posts, wall posts on friends' profiles, group posts          |
| `post_tags`     | People tagged in your posts                                       |
| `comments`      | Your comments and replies, with whose thing they were on          |
| `reactions`     | Your likes and reactions                                          |
| `media`         | Photos and videos, linked to an album, post or comment            |
| `albums`        | Your photo albums                                                 |
| `tagged_photos` | Other people's photos you're tagged in (links only, no images)    |

### Linking with friends' exports (next step)

Your export doesn't say which post a comment was on, only "X's photo" plus the
comment's timestamp. A friend's export contains their posts *and* the comments
on them, including yours with the same author name and timestamp, so
`(author, timestamp)` on a comment is the join key. `comments.target_owner_id`
and `target_kind` narrow the search.

## Known limitations

- Facebook identifies people only by name, so two friends with the same name
  are merged into one person.
- 74 comments have no text in the export, just the summary line; they're shown
  with a note.
- Photos you're tagged in are links back to Facebook, not images.
