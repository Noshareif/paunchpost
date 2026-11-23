# PaunchPost

Darkhorse Tech's email platform, replacing Mailchimp. Next.js on Vercel, Postgres (Neon), Amazon SES.

## What's built so far: the engine

- **Database** (`db/schema.sql`): senders, audiences, contacts, tags, segments, the suppression list, templates, campaigns, per-recipient sends, links, clicks and SES events.
- **Mailchimp history**: `npm run import:mailchimp` loads all 307 campaigns (with their stats) and 4 templates from `data/mailchimp.json`.
- **Sending** (`lib/server/send.ts`):
  - Recipients are locked in when you hit Send. Only subscribed contacts get it; anyone on the suppression list is skipped.
  - It sends in batches at 12 a second, under SES's limit of 14.
  - Merge tags like `{{first_name}}` and `{{first_name|there}}` (the part after `|` is used when the field is blank).
  - Every email gets the footer, address and unsubscribe link, a hidden preview line, and the Gmail/Yahoo one-click unsubscribe headers.
- **Tracking**:
  - `/o/<token>` open pixel.
  - `/r/<token>/<link>` click redirect. It only redirects to links in that campaign.
  - `/u/<token>` unsubscribe, with a confirm button so security scanners can't trigger it.
  - `/v/<token>` view in browser.
- **Bounces and complaints**: `/api/ses/events` takes Amazon's notifications (signature-checked). Hard bounces and spam complaints are suppressed straight away.
- **Scheduling**: `/api/cron` starts scheduled campaigns and keeps big sends moving.

The interface comes next: the screens from the prototype, wired to these pieces.

## Setup

1. **Database:** Vercel → Storage → Create Database → Neon → connect it to this project.
2. **Variables:** add the ones in `.env.example` under Settings → Environment Variables.
3. **Tables and Mailchimp history:** on your computer, put `DATABASE_URL` in `.env.local`, then:
   ```bash
   npm install
   node --env-file=.env.local scripts/migrate.mjs
   node --env-file=.env.local scripts/import-mailchimp.mjs
   ```
4. **Scheduled sends:** Vercel's free plan only runs cron jobs once a day. Use a free scheduler such as cron-job.org to call `https://paunchpost.vercel.app/api/cron` every 5 minutes, with the header `Authorization: Bearer <CRON_SECRET>`.
5. **Amazon SES** (in US East (Ohio)):
   - Configuration set `paunchpost` with an SNS event destination for Bounce, Complaint and Delivery.
   - Subscribe `https://paunchpost.vercel.app/api/ses/events?key=<SES_WEBHOOK_KEY>` to that SNS topic (HTTPS).
   - A send-only IAM user (`ses:SendEmail` for the darkhorsetech.com identity and that configuration set). Its keys go into Vercel.

## Images

Images are hosted in Webflow. Upload them there and paste the image link into the email.
