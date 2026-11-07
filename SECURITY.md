# Security

afterwrd holds people's private photos, posts and Facebook history, so security problems matter a great deal.

## Reporting a problem

Please **don't open a public issue** for anything security-related. Report it privately instead:
**[report a vulnerability](https://github.com/stemill/afterwrd/security/advisories/new)** (GitHub's private
reporting; only the maintainer sees it).

It helps to include what you found, which version of afterwrd (shown on its Update page), and how to reproduce it.
You'll get a reply as soon as possible. Once a fix is released, and sites have had a chance to update, the problem
can be published with credit to you, if you'd like.

## What's in scope

- A person's afterwrd site, and a group's site (the code in `worker/`).
- The installer and the pages at afterwrd.app (`worker/installer/`).
- How sites talk to each other ([PROTOCOL.md](PROTOCOL.md)).

Problems in Cloudflare itself, or in someone's Cloudflare account settings, are outside it, though if afterwrd could
do something to protect people better, that's worth hearing.

## Versions

Only the latest release is supported. Every site can update itself from its Update page, so fixes go out as new
releases. When a release fixes a security problem, each older site says so to its owner on Home.

To hear about every release, *Watch* this repository on GitHub (*Watch* → *Custom* → *Releases*) or follow the
[releases feed](https://github.com/stemill/afterwrd/releases.atom). Each release's notes are what its sites show on
their Update page.

## What the Cloudflare permission covers

Installing and updating ask Cloudflare for permission through its own sign-in for apps: you press *Allow*, and the
installer or your site gets a token that lasts **one hour**. Nothing is kept afterwards. It allows:

- making, changing and deleting **Workers** (Cloudflare calls this *Workers Admin*),
- making, changing and deleting **D1 databases**,
- reading the account's basic settings (its workers.dev name).

That's every Worker and database **in the account**, not just afterwrd's. So if you use Cloudflare for other things,
make a separate Cloudflare account just for afterwrd. It doesn't cover your domains, DNS, other Cloudflare
services, billing, your login, or making longer-lived tokens. You can see and revoke what you've allowed under *My
Profile* → *Connected Applications*.

## Check it yourself

You don't have to take the published files on trust. Two independent checks:

**Rebuild it.** Releases are reproducible: building a tag yourself gives byte-for-byte the same files. You need
`git` and Node.js 22.

```sh
git clone https://github.com/stemill/afterwrd && cd afterwrd/worker
git checkout v0.23.0        # the release you want to check
npm ci --ignore-scripts
npm run release -- --base https://github.com/stemill/afterwrd/releases/download/v0.23.0
shasum -a 256 release/0.23.0/manifest.json release/0.23.0/installer.js
```

Both fingerprints should match the files of the same name attached to [that
release](https://github.com/stemill/afterwrd/releases); the start of the manifest's is also shown at the foot of
[afterwrd.app](https://afterwrd.app/). The manifest lists the SHA-256 of every code and site file, and the installer
and Update page refuse any file that doesn't match it, so a matching manifest covers all of those. The installer
itself isn't in the manifest (it carries the manifest's fingerprint instead), which is why it's checked too.

**Check its build record** (from 0.23.0 on). GitHub signs a record of every release saying that its files were built
by this repository's release workflow, from the tagged commit. The record is kept in Sigstore's public transparency
log, so it can't be quietly changed later. With the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify manifest.json --repo stemill/afterwrd
```

**Check what your site is running.** With a read-only API token (*Workers Scripts: Read*), download the code your
site is running from Cloudflare and compare it, file by file, with a release or with your own rebuild:

```sh
read -rs CF_TOKEN && export CF_TOKEN       # paste the token; nothing shows
node worker/scripts/check-site.mjs afterwrd --manifest worker/release/0.23.0/manifest.json
```

The code carries the SHA-256 of every static file the site serves (scripts, stylesheet, fonts) and refuses to send
any that doesn't match. What the code can't cover is how the Worker is set up in Cloudflare (what it's connected to,
where its logs go, whether Cloudflare hands out its files directly): the script checks only the code, while a check
by a friend's site checks those too. [Check your install](https://afterwrd.app/check/)
explains what else to look at in your Cloudflare dashboard after installing.

## How it's checked

See [How afterwrd is made](README.md#how-afterwrd-is-made) in the README: the code is public, it's covered by
automated end-to-end tests including hostile input, and it has had security reviews by AI agents at each major step.
It hasn't yet had a review by a human security expert; one would be very welcome.
