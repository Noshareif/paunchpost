-- PaunchPost database. Safe to run more than once (everything is IF NOT EXISTS).
-- Run with: npm run db:migrate

CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS senders (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  email      text NOT NULL UNIQUE,
  reply_to   text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- "Audiences" in the app (Mailchimp's word). One contact can be in many.
CREATE TABLE IF NOT EXISTS lists (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  description text,
  sender_id   int REFERENCES senders(id) ON DELETE SET NULL,
  reminder    text,               -- "how you signed up" line for the footer
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL,
  first_name text NOT NULL DEFAULT '',
  last_name  text NOT NULL DEFAULT '',
  practice   text NOT NULL DEFAULT '',
  title      text NOT NULL DEFAULT '',
  phone      text NOT NULL DEFAULT '',
  notes      text NOT NULL DEFAULT '',
  custom     jsonb NOT NULL DEFAULT '{}',
  status     text NOT NULL DEFAULT 'subscribed' CHECK (status IN ('subscribed','unsubscribed','cleaned')),
  source     text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_email_lower ON contacts (lower(email));

CREATE TABLE IF NOT EXISTS list_members (
  list_id    int    NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  contact_id bigint NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, contact_id)
);
CREATE INDEX IF NOT EXISTS list_members_contact ON list_members (contact_id);

CREATE TABLE IF NOT EXISTS contact_tags (
  contact_id bigint NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag        text   NOT NULL,
  PRIMARY KEY (contact_id, tag)
);
CREATE INDEX IF NOT EXISTS contact_tags_tag ON contact_tags (tag);

-- Never emailed again, whatever audience they show up in. Survives contact/audience deletion.
CREATE TABLE IF NOT EXISTS suppressions (
  email      text PRIMARY KEY,      -- stored lower-case
  reason     text NOT NULL,         -- unsubscribed | hard_bounce | complaint | manual
  source     text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS segments (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  match      text NOT NULL DEFAULT 'all' CHECK (match IN ('all','any')),
  conditions jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS templates (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  html       text NOT NULL,
  mc_id      text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaigns (
  id              serial PRIMARY KEY,
  name            text NOT NULL,
  subject         text NOT NULL DEFAULT '',
  preview         text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','canceled')),
  sender_id       int REFERENCES senders(id) ON DELETE SET NULL,
  -- { listIds:[], tags:[], segmentIds:[], exclude:{listIds,tags,segmentIds}, nonOpenersOf: id|null }
  audience        jsonb NOT NULL DEFAULT '{}',
  html            text NOT NULL DEFAULT '',
  plain           text,               -- null = generate from html
  template_id     int REFERENCES templates(id) ON DELETE SET NULL,
  track_opens     boolean NOT NULL DEFAULT true,
  track_clicks    boolean NOT NULL DEFAULT true,
  send_at         timestamptz,        -- scheduled time, or when it was sent
  started_at      timestamptz,
  finished_at     timestamptz,
  -- History brought over from Mailchimp (no per-recipient rows exist for these)
  imported        boolean NOT NULL DEFAULT false,
  imported_stats  jsonb,
  imported_audience text,
  mc_id           text UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaigns_status_send ON campaigns (status, send_at);

-- One row per person per campaign. The token is the secret in their tracking/unsubscribe links.
CREATE TABLE IF NOT EXISTS sends (
  id              bigserial PRIMARY KEY,
  campaign_id     int    NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id      bigint REFERENCES contacts(id) ON DELETE SET NULL,
  email           text   NOT NULL,
  token           text   NOT NULL UNIQUE,
  status          text   NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','bounced','complained','skipped')),
  ses_message_id  text,
  error           text,
  claimed_at      timestamptz,       -- when a worker picked it up (stuck rows get retried)
  sent_at         timestamptz,
  delivered_at    timestamptz,
  opened_at       timestamptz,
  open_count      int NOT NULL DEFAULT 0,
  clicked_at      timestamptz,
  click_count     int NOT NULL DEFAULT 0,
  unsubscribed_at timestamptz,
  UNIQUE (campaign_id, email)
);
CREATE INDEX IF NOT EXISTS sends_queue ON sends (campaign_id, status);
CREATE INDEX IF NOT EXISTS sends_message ON sends (ses_message_id);
CREATE INDEX IF NOT EXISTS sends_contact ON sends (contact_id);

CREATE TABLE IF NOT EXISTS links (
  id          serial PRIMARY KEY,
  campaign_id int  NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  url         text NOT NULL,
  UNIQUE (campaign_id, url)
);

CREATE TABLE IF NOT EXISTS clicks (
  id      bigserial PRIMARY KEY,
  send_id bigint NOT NULL REFERENCES sends(id) ON DELETE CASCADE,
  link_id int    NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clicks_link ON clicks (link_id);

-- Raw delivery events from Amazon SES (bounces, complaints, deliveries) for troubleshooting.
CREATE TABLE IF NOT EXISTS events (
  id      bigserial PRIMARY KEY,
  type    text NOT NULL,
  send_id bigint REFERENCES sends(id) ON DELETE SET NULL,
  email   text,
  payload jsonb,
  at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS imports (
  id       serial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  method   text NOT NULL,
  file     text,
  list_id  int REFERENCES lists(id) ON DELETE SET NULL,
  list_name text,
  added    int NOT NULL DEFAULT 0,
  updated  int NOT NULL DEFAULT 0,
  skipped  int NOT NULL DEFAULT 0
);

-- Saved image links (images are hosted in Webflow and pasted in).
CREATE TABLE IF NOT EXISTS images (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  url        text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO senders (name, email, reply_to, is_default) VALUES
  ('Darkhorse Tech', 'admin@darkhorsetech.com', 'admin@darkhorsetech.com', true),
  ('Darkhorse Tech', 'sales@darkhorsetech.com', 'sales@darkhorsetech.com', false)
ON CONFLICT (email) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('company',  '"Darkhorse Tech"'),
  ('footer_address', '"3300 Vickery Rd, Syracuse, NY 13212"'),
  ('default_reminder', '"You’re receiving this email because you opted in to receiving our emails."')
ON CONFLICT (key) DO NOTHING;
