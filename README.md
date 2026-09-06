# myimagerepo

Public image host for the Instagram autoposter.

## Why this repo is public

Instagram's Content Publishing API fetches post images by **public URL** — it
cannot accept a file upload. Rendered post images are therefore mirrored here,
where `raw.githubusercontent.com` can serve them to Meta.

The pipeline itself lives in a separate **private** repository. Only rendered
JPEGs are public; no code, credentials, or unpublished captions are here.

## Layout

    posts/media/<YYYY-MM-DD>-<topic>.jpg

Written by the autoposter's `generate` workflow. Do not rename or delete files
referenced by a post that has not published yet — the URL is resolved at
publish time, and a missing file fails the publish.

## Orphaned images

Images are mirrored here when they are **generated**, which is before a human
approves the post. A post that is later rejected or re-rendered leaves its
original JPEG here, unreferenced. Those are safe to delete at any time.

## This file

Do not delete `README.md`. The autoposter's `cli check` fetches it to confirm
this repo is public and reachable, and the mirror step clones the `main`
branch, which needs at least one commit on it.
