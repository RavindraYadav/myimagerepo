# Autoposter — operator app

A static page that runs the Instagram pipeline from a phone or a laptop.
No server. It talks to the GitHub API directly.

Live at **https://ravindrayadav.github.io/myimagerepo/** once Pages is on.

## What it does

| Tab | |
| --- | --- |
| **Queue** | every post with its card, caption, time and status. Approve, post now, reject, edit a caption, reschedule, repair a stuck one. |
| **New post** | upload an image, write a caption, schedule it or post immediately. |
| **Runs** | recent workflow runs, and which step failed. |
| **Settings** | repos and tokens. |

## One-time setup

### 1. Turn on Pages

`myimagerepo` → Settings → Pages → Source: **Deploy from a branch**,
Branch **main**, folder **/docs** → Save. Give it a minute.

### 2. Two tokens

github.com/settings/personal-access-tokens → **Generate new token**
(fine-grained). Expiry 90 days — not "no expiration".

**Token A — the code repo.** Only select repositories → `Social`.

| Permission | Level |
| --- | --- |
| Metadata | Read-only |
| Contents | **Read-only** |
| Actions | Read and write |

Contents stays read-only on purpose. With write, this token could rewrite a
workflow, dispatch it, and read `IG_ACCESS_TOKEN` out of the runner. Read-only
means the app physically cannot edit the queue — every change it makes runs
through the Python guards instead. Do not grant Workflows either.

**Token B — this repo.** Only select repositories → `myimagerepo`.

| Permission | Level |
| --- | --- |
| Metadata | Read-only |
| Contents | Read and write |

Only needed for uploading images. Write here is cheap: the repo is public, holds
no secrets, and nothing in it is ever executed by a workflow.

Two tokens because a fine-grained token has one permission set across all its
repos — "read there, write here" cannot be expressed in one.

### 3. Open the app and fill in Settings

GitHub user, `Social`, `RavindraYadav/myimagerepo`, both tokens, and the expiry
date you chose (the browser cannot read it from GitHub, so it is the only way
the app can warn you).

### 4. Install it on the phone

Open the URL in Chrome → menu → **Add to home screen**.

## How a change takes effect

The app never edits `posts/queue.yaml`. It dispatches a workflow, that workflow
runs the same CLI the issue labels use, and the queue updates — about 30
seconds. The card shows "Sending…" meanwhile, and only clears when the run
succeeded **and** the queue actually changed. A green run alone is not proof.

Actions are sent one at a time. Every repo-writing workflow shares a concurrency
group and GitHub cancels earlier pending runs in a group, so firing four
approvals at once would silently drop two.

## Notes

- **Uploads are re-encoded** before leaving your device: always JPEG, and EXIF
  is dropped — including the GPS coordinates phone photos carry, which would
  otherwise be committed to this public repo.
- **A 3:4 phone photo is outside Instagram's 4:5–1.91:1 range** and would be
  rejected, so the app crops before uploading.
- **Tokens are stored encrypted** in this browser only, under a key that cannot
  be exported. That stops a storage dump, not live script injection — so the
  page loads no third-party code at all.
- **"Forget everything on this device" does not revoke a token.** Revoke at
  github.com/settings/personal-access-tokens.
- Losing an unlocked phone is the real risk here, not anything clever. Keep a
  screen lock on.

## Development

```bash
python3 -m http.server 8777 --directory docs
node docs/selftest.js
```

`selftest.js` covers the parts with rules in them: filenames, aspect ratios,
caption limits, the two-gate clear and the dispatch serializer. Open
`selftest.html` for the same checks in a browser.
