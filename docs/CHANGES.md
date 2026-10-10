# ReelScribe repair build

## Removed

- `public/Tarclips-dashboard.html` (duplicate clip dashboard)
- `public/clips-dashboard.htmlaha` (duplicate/accidental dashboard copy)
- `public/1sitemap.xml` (duplicate sitemap)
- `public/build.sh` (duplicate build script)
- `public/readme.txt`, `public/DEPLOY.txt`, `public/README-REFERRAL.txt` (documentation moved to `docs/`)
- nested `reelscribe-updated.zip`

## Added

- `public/blog/repurpose-youtube-into-reels.html`
- `public/blog/top-10-viral-hooks.html`
- `public/assets/og-cover.png`
- `docs/CHANGES.md`
- page-specific cached CSS/JS under `public/assets/css/` and `public/assets/js/`

## Backend fixes

- Admin credit endpoint now supports add, deduct, exact-set and reset.
- Admin user control now supports suspend, unsuspend and account deletion.
- Added admin user detail endpoint.
- Added server-side user filters and accurate effective-plan handling.
- Added referral review queue APIs with approve/reject actions.
- Preserved `lastPaidPlan` for win-back/churn analytics.
- Payment verification is authenticated, account-bound and idempotent.
- Payment signatures use a timing-safe comparison.
- Payment receipts use a collision-resistant suffix.
- Added secure handling when admin/internal secrets are missing.
- Suspended users are blocked by authenticated APIs.
- `lastActiveAt` is maintained for authenticated activity.
- Clip status is authenticated and owner-scoped.
- Backend YouTube/Instagram URL validation is stricter.
- Removed public debug/test endpoints and the unused unauthenticated proxy upload route.
- Guest preview counters use hashed IPs and an atomic limit check.
- Added basic security response headers and a minimal `/health` endpoint.

## Content/UX fixes

- Removed unsupported TikTok/X/Facebook claims from the transcript page.
- Corrected guest preview wording from 5 full transcripts to 3 previews.
- Removed unsupported competitor-price, rating and fabricated testimonial claims.
- Corrected direct-upload limit messaging to 25 MB.
- Added real blog pages for links that previously returned 404.
- Added private-page exclusions to `robots.txt` and updated the sitemap.
- Optimized the favicon and demo video for a smaller public payload.

## Mascot

- Added `public/assets/js/mascot.js`: animated green mascot (bottom-right) with a speech bubble. Plays all 23 animations from `cloudee_avatar.json`; the data is inlined in the file, no extra requests.
- Loaded on: index, transcript, clips-dashboard, dashboard, history, pricing, login, referral.
- It reacts to the existing page flow without changing page scripts: Generate hover/tap, link pasted, clip processing steps, done/error, transcript status, login messages, alerts, referral copy.
- Visitors can drag it anywhere (mouse, touch or arrow keys). The spot is saved per browser (`localStorage` key `rsmPos`) and kept on every page. Double-click it to send it back to the bottom-right corner.
- Visitors can hide it with the small x button (saved in `localStorage` as `rsmOff`). Respects `prefers-reduced-motion`.
- To remove it: delete the `<script src="/assets/js/mascot.js">` line from the page.
- Hiding the mascot now leaves a small green "show mascot" button in the corner, so it can always be brought back.
- Eyes follow the cursor/finger, and follow the typing position in the link box.
- Greets logged-in users by name (taken from the email, like the dashboard) and reminds them when 1 or 0 clips are left today (uses `/me` and `/user-plan`, once per session).
- Tab title shows progress while clips/transcripts are processing and "ready" when done, so users can work in another tab.
- Bell button on the mascot turns on sound, vibration and browser notifications for "ready" (off by default, saved as `rsmAlerts`).


---

## v2 — advanced features + fixes

### New features
1. **AI hook / virality score / hashtags** on every clip (auto at generation, regenerate via `POST /ai/clips/:id/meta`)
2. **Clip editor** — trim, re-frame (aspect + focus point), brand logo; creates a *new* clip (`POST /clips/:id/:idx/edit`)
3. **Upload your own video for clips** — browser → S3 presigned upload (`POST /upload-url`, then `/cut-clips {sourceKey}`)
4. **Manual re-framing** (focus point). Face-tracking needs an ML service, see `docs/EC2-UPGRADE.md`
5. **SRT / VTT / TXT export**, translation (24 languages incl. Hinglish), summary, chapters
6. **Repurpose AI** — blog, LinkedIn, X thread, newsletter, Shorts script, YouTube description
7. **Post scheduler** (reminder email with caption + download link; adapter hook for auto-publish)
8. **Brand kit + Team workspace** (Agency) — `studio.html`
9. **Public API + API keys + signed webhooks** (Agency) — `docs-api.html`

### Bugs fixed
* Stored XSS in `history.js` (file names / URLs were injected unescaped)
* Open redirect in Google login (`next=//evil.com`)
* Usage limits were a racy read-modify-write → now atomic reserve/refund (parallel requests could bypass limits); failed jobs refund
* "Daily" limits reset at 5:30 AM IST (UTC server clock) → now midnight IST
* Clip jobs lived in an in-memory Map and vanished on every deploy → persisted in MongoDB with heartbeat recovery + automatic refund
* Sessions lived in memory (everyone logged out on deploy) → `connect-mongo` store
* Razorpay: paying then closing the tab never activated the plan → webhook now handles `order.paid`; renewing the same plan extends instead of discarding remaining days
* Async route errors could hang requests / crash the process → central async-safe routing + `unhandledRejection` guard
* Mongoose indexes in `Clip.js`, `Reel.js`, `Subscription.js` were declared after the model was compiled (never created)
* Audio uploads allowed by the UI were rejected by the server (mp3/wav/m4a…)
* Instagram downloads: no redirect/status handling, no size cap → fixed
* YouTube captions contained HTML entities (`&#39;`) → decoded
* Guest "log in for the full transcript" banner never showed (`isPreview` never stored)
* Suspended users could still transcribe through the optional-auth routes
* Admin / internal secrets compared with `!==` → constant-time comparison
* Caption settings from the browser were forwarded to the render service unvalidated → whitelisted
* `/history` was unbounded → limited, lighter payload
* `form-data` was required but undeclared/unused → removed

### Tests
`npm test` (unit + route tests + real ffmpeg editor test), `npm run smoke` (boots server.js with stubbed deps).
