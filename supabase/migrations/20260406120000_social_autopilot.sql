-- Social Autopilot module (Zernio integration)
-- Tables: social_accounts, social_posts, social_autopilot_config

-- ============================================================
-- social_accounts: connected social profiles via Zernio
-- ============================================================
CREATE TABLE IF NOT EXISTS public.social_accounts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN (
    'youtube', 'tiktok', 'instagram', 'facebook', 'threads',
    'linkedin', 'twitter', 'bluesky', 'pinterest', 'reddit',
    'telegram', 'whatsapp', 'snapchat', 'google_business'
  )),
  zernio_account_id TEXT NOT NULL,
  zernio_profile_id TEXT NOT NULL,
  account_name TEXT,
  account_username TEXT,
  is_active BOOLEAN DEFAULT true,
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb,
  UNIQUE(user_id, platform)
);

ALTER TABLE public.social_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own social_accounts" ON public.social_accounts;
CREATE POLICY "Users see own social_accounts" ON public.social_accounts
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_social_accounts_user ON public.social_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_social_accounts_platform ON public.social_accounts(platform);

-- ============================================================
-- social_posts: published / scheduled posts
-- ============================================================
CREATE TABLE IF NOT EXISTS public.social_posts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  content_text TEXT,
  content_media_urls TEXT[] DEFAULT '{}',
  content_type TEXT DEFAULT 'text' CHECK (content_type IN ('text', 'image', 'video', 'carousel', 'reel')),
  agent_name TEXT,
  target_platforms TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'scheduled', 'publishing', 'published', 'partial', 'failed'
  )),
  scheduled_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  zernio_post_id TEXT,
  zernio_response JSONB DEFAULT '{}'::jsonb,
  platform_results JSONB DEFAULT '{}'::jsonb,
  ai_generated BOOLEAN DEFAULT false,
  ai_caption TEXT,
  ai_hashtags TEXT[] DEFAULT '{}',
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.social_posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own social_posts" ON public.social_posts;
CREATE POLICY "Users see own social_posts" ON public.social_posts
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_social_posts_user ON public.social_posts(user_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_status ON public.social_posts(status);
CREATE INDEX IF NOT EXISTS idx_social_posts_created ON public.social_posts(created_at DESC);

-- ============================================================
-- social_autopilot_config: per-user autopilot settings
-- ============================================================
CREATE TABLE IF NOT EXISTS public.social_autopilot_config (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE NOT NULL,
  autopilot_enabled BOOLEAN DEFAULT false,
  auto_caption BOOLEAN DEFAULT true,
  auto_hashtags BOOLEAN DEFAULT true,
  default_platforms TEXT[] DEFAULT ARRAY['youtube','tiktok','instagram','facebook','threads','linkedin','twitter']::TEXT[],
  timezone TEXT DEFAULT 'Europe/Paris',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.social_autopilot_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own autopilot_config" ON public.social_autopilot_config;
CREATE POLICY "Users manage own autopilot_config" ON public.social_autopilot_config
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- Triggers: updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_social_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_social_posts_updated_at ON public.social_posts;
CREATE TRIGGER trg_social_posts_updated_at
  BEFORE UPDATE ON public.social_posts
  FOR EACH ROW EXECUTE FUNCTION public.set_social_updated_at();

DROP TRIGGER IF EXISTS trg_social_autopilot_config_updated_at ON public.social_autopilot_config;
CREATE TRIGGER trg_social_autopilot_config_updated_at
  BEFORE UPDATE ON public.social_autopilot_config
  FOR EACH ROW EXECUTE FUNCTION public.set_social_updated_at();
