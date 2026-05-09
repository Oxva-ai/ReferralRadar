-- referral-discovery: PostgreSQL schema
-- Target: Supabase (PostgreSQL 15+)

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;

-- Core referrals
CREATE TABLE IF NOT EXISTS referrals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_url        TEXT,
  domain            TEXT GENERATED ALWAYS AS (
                      CASE WHEN source_url IS NOT NULL THEN
                        lower(split_part(replace(replace(source_url, 'https://', ''), 'http://', ''), '/', 1))
                      ELSE NULL END
                    ) STORED,
  candidate_domain  TEXT,
  referral_link     TEXT,
  company_name      TEXT,
  offer_text        TEXT,
  reward            TEXT,
  reward_numeric    NUMERIC(10,2),
  currency          VARCHAR(3) DEFAULT 'GBP',
  friend_reward     TEXT,
  friend_reward_numeric NUMERIC(10,2),
  reward_type       VARCHAR(20) CHECK (reward_type IN ('per_referral','dual','capped','free_product','free_share','switching_bonus','percentage','signup_credit','image_text','unknown')),
  qualifying_spend  TEXT,
  max_referrals     INTEGER,
  content_hash      TEXT,
  change_type       VARCHAR(20) DEFAULT 'new' CHECK (change_type IN ('new','updated')),
  previous_offer    TEXT,
  previous_offer_numeric NUMERIC(10,2),
  score             NUMERIC(4,3),
  engagement_score  NUMERIC(4,3) DEFAULT 0,
  clicks_last_7_days INTEGER DEFAULT 0,
  impressions_last_7_days INTEGER DEFAULT 0,
  sources           TEXT[] DEFAULT '{}',
  source_count      INTEGER DEFAULT 1,
  uk_signal_strength VARCHAR(10) DEFAULT 'unknown' CHECK (uk_signal_strength IN ('strong','moderate','pound_only','weak','unknown')),
  reddit_post_id    TEXT,
  reddit_score      INTEGER,
  reddit_comments   INTEGER,
  discovered_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at  TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  is_active         BOOLEAN DEFAULT TRUE,
  is_aggregator     BOOLEAN DEFAULT FALSE,
  category          TEXT,
  verification_failures INTEGER DEFAULT 0,
  notes             TEXT,
  referee_reward    TEXT,
  referrer_reward   TEXT,
  offer_summary     TEXT,
  referral_code     TEXT,
  terms_url         TEXT,
  is_instant        BOOLEAN DEFAULT FALSE,
  is_no_id          BOOLEAN DEFAULT FALSE,
  is_gambling       BOOLEAN DEFAULT FALSE,
  requires_spending BOOLEAN DEFAULT FALSE,
  confidence        NUMERIC(4,3),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Monitored pages (for page monitor worker, Phase 3)
CREATE TABLE IF NOT EXISTS monitored_pages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url               TEXT NOT NULL UNIQUE,
  company_name      TEXT,
  last_content_hash TEXT,
  last_checked_at   TIMESTAMPTZ,
  next_check_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  check_interval    INTERVAL DEFAULT '4 hours',
  change_count      INTEGER DEFAULT 0,
  consecutive_failures INTEGER DEFAULT 0,
  is_active         BOOLEAN DEFAULT TRUE,
  submitted_by      TEXT DEFAULT 'system',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Offer change history
CREATE TABLE IF NOT EXISTS offer_history (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  monitored_page_id   UUID REFERENCES monitored_pages(id) ON DELETE CASCADE,
  referral_id         UUID REFERENCES referrals(id) ON DELETE SET NULL,
  old_offer_text      TEXT,
  new_offer_text      TEXT,
  old_reward          TEXT,
  new_reward          TEXT,
  old_reward_numeric  NUMERIC(10,2),
  new_reward_numeric  NUMERIC(10,2),
  detected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- API usage tracking
CREATE TABLE IF NOT EXISTS api_usage (
  api_name        VARCHAR(50) NOT NULL,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  queries_used    INTEGER DEFAULT 0,
  PRIMARY KEY (api_name, date)
);

-- User submissions
CREATE TABLE IF NOT EXISTS submissions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url                 TEXT NOT NULL,
  submitted_by        TEXT,
  status              VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','processing','processed','rejected')),
  rejection_reason    TEXT,
  result_referral_id  UUID REFERENCES referrals(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at        TIMESTAMPTZ
);

-- Worker run log (compact, retained for 1000 most recent)
CREATE TABLE IF NOT EXISTS worker_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_name     VARCHAR(50) NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  items_processed INTEGER DEFAULT 0,
  items_discovered INTEGER DEFAULT 0,
  status          VARCHAR(20) DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  error_message   TEXT
);

-- Configurable app settings
CREATE TABLE IF NOT EXISTS app_config (
  key             VARCHAR(50) PRIMARY KEY,
  value           TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Click tracking (append-only)
CREATE TABLE IF NOT EXISTS click_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id     UUID NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
  clicked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Impression tracking (append-only)
CREATE TABLE IF NOT EXISTS impression_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id     UUID NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
  impressed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Search effectiveness tracking
CREATE TABLE IF NOT EXISTS search_queries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_name     VARCHAR(50) NOT NULL,
  query           TEXT NOT NULL,
  source_api      VARCHAR(20) NOT NULL,
  results_count   INTEGER DEFAULT 0,
  discoveries_count INTEGER DEFAULT 0,
  executed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Dead letter queue
CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url             TEXT NOT NULL,
  source          VARCHAR(50) NOT NULL,
  error_message   TEXT,
  retry_count     INTEGER DEFAULT 0,
  failed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS queue_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url             TEXT NOT NULL,
  source          VARCHAR(50) NOT NULL,
  priority        VARCHAR(10) NOT NULL DEFAULT 'low' CHECK (priority IN ('high', 'low')),
  status          VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  uk_signal       VARCHAR(10) DEFAULT 'unknown',
  attempts        INTEGER DEFAULT 0,
  max_attempts    INTEGER DEFAULT 3,
  reddit_post_id  TEXT,
  reddit_score    INTEGER,
  reddit_comments INTEGER,
  submission_id   UUID,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);

-- Brands directory (admin-managed, replaces static brands.ts data)
CREATE TABLE IF NOT EXISTS brands (
  name              TEXT NOT NULL,
  domain            TEXT PRIMARY KEY,
  category          TEXT NOT NULL DEFAULT 'other',
  likely_referral_page TEXT,
  is_active         BOOLEAN DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Webhook registrations
CREATE TABLE IF NOT EXISTS webhooks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url             TEXT NOT NULL,
  events          TEXT[] NOT NULL DEFAULT '{}',
  secret          TEXT,
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Webhook delivery log
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id      UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event           VARCHAR(50) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  response_code   INTEGER,
  response_body   TEXT,
  attempted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reddit processed posts dedup
CREATE TABLE IF NOT EXISTS reddit_processed_posts (
  post_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Blocked domains (admin-managed blocklist)
CREATE TABLE IF NOT EXISTS blocked_domains (
  domain TEXT PRIMARY KEY,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default config
INSERT INTO app_config (key, value) VALUES
  ('score_weight_freshness',   '0.25'),
  ('score_weight_novelty',     '0.20'),
  ('score_weight_value',       '0.20'),
  ('score_weight_uk_signal',   '0.10'),
  ('score_weight_engagement',  '0.25'),
  ('score_min_threshold',      '0.30'),
  ('serper_daily_limit',       '83'),
  ('brave_daily_limit',        '66'),
  ('brand_search_index',       '0'),
  ('search_query_index',       '0'),
  ('logo_dev_token',           'pk_Rz_wcJe5S7qjtTJ_lxODDQ')
   ('score_weight_source_rarity',  '0.15')
ON CONFLICT (key) DO NOTHING;

-- Score materialisation function
CREATE OR REPLACE FUNCTION compute_score(
  p_reward_numeric NUMERIC,
  p_discovered_at TIMESTAMPTZ,
  p_source_count INTEGER,
  p_uk_signal VARCHAR,
  p_engagement NUMERIC DEFAULT 0,
  p_sources TEXT[] DEFAULT '{}',
  p_w_fresh NUMERIC DEFAULT 0.20,
  p_w_novel NUMERIC DEFAULT 0.15,
  p_w_val NUMERIC DEFAULT 0.20,
  p_w_uk NUMERIC DEFAULT 0.10,
  p_w_engage NUMERIC DEFAULT 0.20,
  p_w_rarity NUMERIC DEFAULT 0.15
) RETURNS NUMERIC AS $$
DECLARE
  freshness NUMERIC; novelty NUMERIC; val NUMERIC; uk NUMERIC; engagement NUMERIC; rarity NUMERIC;
  total_weight NUMERIC;
  effective_fresh NUMERIC; effective_novel NUMERIC;
BEGIN
  total_weight := p_w_fresh + p_w_novel + p_w_val + p_w_uk + p_w_engage + p_w_rarity;

  freshness := GREATEST(0, 1 - (EXTRACT(EPOCH FROM (NOW() - p_discovered_at)) / 3600) / 720);
  novelty := CASE
    WHEN p_source_count <= 1 THEN 1.0
    WHEN p_source_count = 2 THEN 0.7
    WHEN p_source_count = 3 THEN 0.5
    WHEN p_source_count = 4 THEN 0.3
    WHEN p_source_count = 5 THEN 0.1
    ELSE 0.0
  END;
  val := LEAST(COALESCE(p_reward_numeric, 0) / 100, 1.0);
  uk := CASE p_uk_signal
    WHEN 'strong'     THEN 1.0
    WHEN 'moderate'   THEN 0.8
    WHEN 'pound_only' THEN 0.6
    WHEN 'weak'       THEN 0.3
    ELSE 0.0
  END;
  rarity := CASE
    WHEN 'brand_search' = ANY(p_sources) OR 'url-guesser' = ANY(p_sources) THEN 1.0
    WHEN EXISTS (SELECT 1 FROM unnest(p_sources) s WHERE s LIKE 'competitor_%') THEN 0.8
    WHEN EXISTS (SELECT 1 FROM unnest(p_sources) s WHERE s LIKE 'rss_%') THEN 0.7
    WHEN 'reddit' = ANY(p_sources) THEN 0.5
    WHEN 'user_submission' = ANY(p_sources) THEN 0.4
    WHEN 'serper' = ANY(p_sources) OR 'brave' = ANY(p_sources) THEN 0.3
    ELSE 0.5
  END;

  IF p_engagement IS NULL OR p_engagement <= 0 THEN
    engagement := 0;
    effective_fresh := (p_w_fresh + p_w_engage * 0.40) / total_weight;
    effective_novel := (p_w_novel + p_w_engage * 0.60) / total_weight;
  ELSE
    engagement := LEAST(p_engagement, 1.0);
    effective_fresh := p_w_fresh / total_weight;
    effective_novel := p_w_novel / total_weight;
  END IF;

  RETURN LEAST(1, GREATEST(0,
    (freshness * effective_fresh)
    + (novelty * effective_novel)
    + (val * p_w_val / total_weight)
    + (uk * p_w_uk / total_weight)
    + (engagement * p_w_engage / total_weight)
    + (rarity * p_w_rarity / total_weight)
  ));
END;
$$ LANGUAGE plpgsql;

-- Worker runs trim function (keep newest 1000 rows)
CREATE OR REPLACE FUNCTION trim_worker_runs()
RETURNS void AS $$
BEGIN
  DELETE FROM worker_runs
  WHERE id IN (
    SELECT id FROM worker_runs
    ORDER BY started_at DESC
    OFFSET 1000
  );
END;
$$ LANGUAGE plpgsql;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_referrals_score        ON referrals(score DESC) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_referrals_discovered   ON referrals(discovered_at DESC) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_referrals_domain       ON referrals(domain);
CREATE INDEX IF NOT EXISTS idx_referrals_candidate    ON referrals(candidate_domain) WHERE source_url IS NULL;
CREATE INDEX IF NOT EXISTS idx_referrals_company      ON referrals(company_name);
CREATE INDEX IF NOT EXISTS idx_referrals_type         ON referrals(reward_type) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_referrals_content_hash ON referrals(content_hash);
CREATE INDEX IF NOT EXISTS idx_referrals_verification ON referrals(last_verified_at) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_referrals_sources      ON referrals USING GIN(sources);
CREATE INDEX IF NOT EXISTS idx_referrals_offer_trgm   ON referrals USING GIN(offer_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_referrals_referral_link ON referrals(referral_link) WHERE referral_link IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_monitored_next_check   ON monitored_pages(next_check_at) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_submissions_status     ON submissions(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_worker_runs_recent     ON worker_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_click_events_referral  ON click_events(referral_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_offer_history_monitored_page ON offer_history(monitored_page_id);
CREATE INDEX IF NOT EXISTS idx_offer_history_referral  ON offer_history(referral_id);
CREATE INDEX IF NOT EXISTS idx_submissions_url         ON submissions(url);
CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_reddit_post ON referrals(reddit_post_id) WHERE reddit_post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_click_events_clicked_at  ON click_events(clicked_at);
CREATE INDEX IF NOT EXISTS idx_referrals_verification_stale ON referrals(last_verified_at ASC NULLS FIRST, verification_failures ASC) WHERE is_active = true AND source_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_submissions_pending_stuck ON submissions(created_at ASC) WHERE status = 'pending';

-- Row Level Security
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitored_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE offer_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE click_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE impression_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE dead_letter_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE reddit_processed_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocked_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
