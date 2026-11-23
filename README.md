# PaunchPost

Darkhorse Tech's email platform. This first piece is the **Content library**: upload images in PaunchPost and they're stored in Amazon S3 in DHT's AWS account, then served from a public link (like `https://images.darkhorsetech.com/email/2026/11/k3f9x2a1-holiday-banner.jpg`) that works in every inbox.

## How an upload works

1. You drop an image on the Content library page.
2. Your browser shrinks it to 1200px wide if it's bigger. Photos become JPG, logos with transparency stay PNG, WebP is converted because some Outlook versions can't show it, and GIFs are left as they are.
3. PaunchPost asks S3 for a one-time upload pass that's good for 2 minutes and only allows that one image type, up to 10 MB.
4. The browser sends the image straight to S3. AWS keys never reach the browser.
5. CloudFront serves the image from `images.darkhorsetech.com` with long caching, so emails load fast.

## One-time AWS setup (about 30 minutes)

Everything is in US East (Ohio) `us-east-2` except the certificate, which CloudFront requires in US East (N. Virginia) `us-east-1`. If the bucket name `paunchpost-images` is taken (names are global), pick another and use it everywhere below.

1. **Create the bucket.** S3 → Create bucket → name `paunchpost-images`, region US East (Ohio). Leave **Block all public access ON**: only CloudFront will read from it.
2. **Allow uploads from the site.** Bucket → Permissions → Cross-origin resource sharing (CORS) → Edit → paste `aws/bucket-cors.json`, with your real Vercel address in place of `YOUR-PROJECT.vercel.app`.
3. **Get a certificate for images.darkhorsetech.com.** Switch the region to US East (N. Virginia) → Certificate Manager → Request a public certificate → `images.darkhorsetech.com` → DNS validation. Add the CNAME it shows in GoDaddy, then wait for "Issued".
4. **Create the CloudFront distribution.** Origin = the `paunchpost-images` bucket, with **Origin access control** (create a new one). Viewer protocol: redirect HTTP to HTTPS. Alternate domain name `images.darkhorsetech.com` with the certificate from step 3. Cache policy: CachingOptimized. After it's created, CloudFront offers a bucket policy to copy. Paste it into the bucket's Permissions → Bucket policy. It should look like `aws/bucket-policy-cloudfront.json`.
5. **Point the address at CloudFront.** GoDaddy DNS → add CNAME `images` → the distribution's `xxxx.cloudfront.net` address.
6. **Create the upload-only user for the app.** IAM → Users → Create user `paunchpost-app`, with no console access. Add permissions → Create inline policy → JSON → paste `aws/iam-policy-upload-user.json`. This user can only add, list and delete files in the bucket's `email/` folder. Then Security credentials → Create access key → "Application running outside AWS". **Paste the two keys straight into Vercel. Never into chat or email.**

## Deploy on Vercel

Import the GitHub repo in Vercel, then add the variables from `.env.example` under Settings → Environment Variables:

| Variable | Value |
|---|---|
| `APP_USER`, `APP_PASSWORD` | The sign-in for PaunchPost (temporary, until Microsoft 365 login is added) |
| `AWS_REGION` | `us-east-2` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | From step 6 |
| `S3_BUCKET` | `paunchpost-images` |
| `IMAGES_BASE_URL` | `https://images.darkhorsetech.com`. Until DNS is ready, the `https://xxxx.cloudfront.net` address works too. |

## Moving the Mailchimp images over

Your 307 imported Mailchimp campaigns and 4 templates reference 225 images still hosted by Mailchimp. Copy them **before cancelling Mailchimp**:

```bash
npm install
# with the same AWS_* / S3_BUCKET / IMAGES_BASE_URL variables set in your terminal
node scripts/migrate-mailchimp-images.mjs data/mailchimp.json
```

This writes `data/mailchimp.migrated.json` with every image link pointing at `images.darkhorsetech.com`, plus `image-map.csv` listing old → new. Running it twice is safe: the same image always gets the same name.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in values
npm run dev                  # http://localhost:3000
```

## Not in this piece yet

Campaigns, audiences, sending through SES, reports and Microsoft 365 sign-in. Those follow the clickable prototype.
