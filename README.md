# heybert

A local web app for browsing a Facebook "Download your information" export:
friends, posts, photos, comments and likes. Ads, messages, logins and the rest
of the export are ignored.

## Usage

Request the export from Facebook in **JSON** format, unzip it, then:

```sh
uv run heybert-ingest ~/Downloads/facebook-<you>-<date>-<id>   # one-off import
uv run heybert                                                  # http://127.0.0.1:8000
```

The import writes `data/heybert.db` (SQLite) and copies the referenced photos
and videos to `data/media/`, so the original export can be archived. Re-running
it rebuilds the database from scratch. `data/` is git-ignored: it's personal.
Set `HEYBERT_DATA` to keep it somewhere else.

## Publishing to people you invite

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
   npm run invite -- add "Your Name" --owner --url https://heybert.<subdomain>.workers.dev
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

`npm run deploy` is only for new versions of heybert's code; it never touches your archive.
`npm run invite` still has `list`, `again` and `revoke` for use from the terminal.

**What's published.** Only what the chosen sections show; the rest never leaves your computer. With the
default (posts and photos):
- comments are published only when a photo is attached to them;
- likes and your friends list stay on your computer;
- people appear by name only where a post or photo mentions them, without friendship dates.

Files over 95 MB (the most Cloudflare accepts in one upload) are left out with a note. The free plan allows
5 GB of photos and videos in all.

**Testing.** `npm run test:ingest -- <export folder>` checks the browser importer against
`uv run heybert-ingest` row by row. To try the site locally: `npx wrangler d1 migrations apply heybert --local`,
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
