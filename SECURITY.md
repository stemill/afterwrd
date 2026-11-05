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
releases.

## How it's checked

See [How afterwrd is made](README.md#how-afterwrd-is-made) in the README: the code is public, it's covered by
automated end-to-end tests including hostile input, and it has had security reviews by AI agents at each major step.
It hasn't yet had a review by a human security expert; one would be very welcome.
