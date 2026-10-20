# Open Gym Cloudflare Sync Starter (personal use)

This is a **custom compatibility Worker**, not an official Open Gym server port. It supports mobile-app pairing, user/session checks, workout-state reads/writes, revision-conflict protection, and Open Gym's server-side stamping helper copied by importing `../../api/sync-stamps.js` from the parent repo.

Not supported in this first starter: exercise photos/videos and their media endpoints, browser-based passkey signup, AI Coach, web push reminders, admin dashboard, multiple separate profiles. It creates one owner profile and allows you to pair both personal phones to that same profile. Keep the Worker and its `ADMIN_SETUP_TOKEN` private.

## Assumptions

- Extracted into the existing Open Gym repository's `cloudflare-worker` (or `couldflare-worker`) subfolder, so `../../api/sync-stamps.js` resolves to the official project's helper.
- Cloudflare D1 database `opengym-db` exists with ID `f4c9c008-38be-4abb-94d3-9ebbf75d6967`.
- Wrangler is installed locally.

## Commands (from this folder)

1. Apply the schema remotely:

   `npx wrangler d1 migrations apply opengym-db --remote`

2. Create a long random admin token locally:

   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

   Keep the output private. Copy it into the prompt for:

   `npx wrangler secret put ADMIN_SETUP_TOKEN`

3. Test a local Worker after schema is applied:

   `npx wrangler dev`

4. In a separate Command Prompt, deploy only after local tests:

   `npx wrangler deploy`

5. Open the deployed `workers.dev` URL in a browser. Enter your private admin token and profile name, then generate a fresh one-time code for each phone. In each Open Gym Android app choose **Connect to my server**, enter the deployed URL and the current code.

## Important

- Do not commit a real admin token into Git or place it in `wrangler.jsonc`.
- Do not share the admin token or pairing codes with anyone.
- This starter caps one JSON state document at 1.5 MB and returns `media: false`; photos/videos are not synced in this version.
- Keep Open Gym's built-in JSON backups enabled and export backups from both phones before pairing. Test with a disposable workout first and confirm it appears on the other phone before relying on it.

