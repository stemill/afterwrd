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

`heybert-export` renders the site to static files in `data/site/`. `worker/` is a Cloudflare Worker that
serves them only to people who've signed in with a passkey. Cloudflare's free plan covers it with no card
needed: Workers, static assets and D1 only, no R2 or Zero Trust.

**One-off setup.** Every command below runs in `worker/`.

1. Create a free Cloudflare account at <https://dash.cloudflare.com/sign-up>. It needs only an email address.
2. Install the Worker's tools and sign in:
   ```sh
   cd worker
   npm install
   npx wrangler login                       # opens the browser
   ```
3. Publish. The first time, wrangler asks you to pick a workers.dev subdomain and creates the database:
   ```sh
   npm run publish                          # posts and photos; add -- --sections all for everything
   ```
4. Invite yourself as the owner. Use the address the publish step printed:
   ```sh
   npm run invite -- add "Your Name" --owner --url https://heybert.<subdomain>.workers.dev
   ```
   Open the link and create a passkey.

**Afterwards.** No terminal is needed for access. The **People** page (in the menu, owner only) does it:

- invite someone, then copy or share their one-time link;
- send a fresh link (new phone, lost passkey);
- revoke access, which signs the person out at once and deletes their passkeys.

After re-importing your archive, run `npm run publish` again. It exports the site, updates the database
tables, then deploys. `npm run invite` still has `list`, `again` and `revoke` for use from the terminal.

**What's published.** Only pages reachable from the chosen sections, and the media they show. Search and
filter boxes are left out, because a static site can't answer them. Files over 25 MB (Cloudflare's limit)
are skipped with a warning. Friends, likes and comments aren't published by default, because they're
mostly about other people.

**Testing locally:** `npm run dev` in `worker/`, then `npm run invite -- add "Test" --owner --local`.
Passkeys work on `http://localhost:8787` but not on `127.0.0.1`.

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
