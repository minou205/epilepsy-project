-- ── 1. Extend profiles table ─────────────────────────────────────────────────

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS username TEXT UNIQUE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS birthday DATE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT '';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'patient'
  CHECK (role IN ('patient', 'helper', 'doctor', 'supporter'));
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS background_url TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS doctor_verified BOOLEAN DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS consent_to_train BOOLEAN DEFAULT true;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS show_name_in_posts BOOLEAN DEFAULT true;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS data_usage_consent BOOLEAN DEFAULT true;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS normal_alarm_time TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_normal_collection DATE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS general_model_config TEXT DEFAULT 'both'
  CHECK (general_model_config IN ('both', 'prediction_only', 'detection_only', 'none'));
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS tracker_notifications_enabled BOOLEAN DEFAULT true;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS alarm_sound_enabled BOOLEAN DEFAULT true;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS expo_push_token TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS train_next_version BOOLEAN DEFAULT true;

-- Migrate existing data: copy patient_name to full_name if not set
UPDATE profiles SET full_name = patient_name WHERE full_name IS NULL;

-- ── 2. Helper-Patient associations ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS helper_patients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  helper_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  patient_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(helper_id, patient_id)
);

-- ── 3. Community: Posts ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ── 4. Community: Comments ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES posts(id) ON DELETE CASCADE NOT NULL,
  author_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── 5. Community: Likes ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS likes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES posts(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(post_id, user_id)
);

-- ── 6. Community: Shares ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES posts(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── 7. Chat: Conversations ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── 8. Chat: Conversation members ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY(conversation_id, user_id)
);

-- ── 9. Chat: Messages ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE NOT NULL,
  sender_id UUID REFERENCES profiles(id) NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ── 10. Indexes ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id);
CREATE INDEX IF NOT EXISTS idx_shares_post ON shares(post_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_helper_patients_helper ON helper_patients(helper_id);
CREATE INDEX IF NOT EXISTS idx_helper_patients_patient ON helper_patients(patient_id);

-- ── 11. Enable Row Level Security ────────────────────────────────────────────

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE helper_patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- ── 12. RLS Policies ────────────────────────────────────────────────────────

-- Drop old policies from initial setup (if they exist)
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
DROP POLICY IF EXISTS "Users can view own profile" ON profiles;

-- Profiles: anyone authenticated can read; only own profile can be updated
DROP POLICY IF EXISTS "profiles_select" ON profiles;
CREATE POLICY "profiles_select" ON profiles
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "profiles_update" ON profiles;
CREATE POLICY "profiles_update" ON profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id);
DROP POLICY IF EXISTS "profiles_insert" ON profiles;
CREATE POLICY "profiles_insert" ON profiles
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);

-- Posts: anyone authenticated can read; only author can insert/update/delete
DROP POLICY IF EXISTS "posts_select" ON posts;
CREATE POLICY "posts_select" ON posts
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "posts_insert" ON posts;
CREATE POLICY "posts_insert" ON posts
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = author_id);
DROP POLICY IF EXISTS "posts_update" ON posts;
CREATE POLICY "posts_update" ON posts
  FOR UPDATE TO authenticated USING (auth.uid() = author_id);
DROP POLICY IF EXISTS "posts_delete" ON posts;
CREATE POLICY "posts_delete" ON posts
  FOR DELETE TO authenticated USING (auth.uid() = author_id);

-- Comments: anyone authenticated can read; only author can insert/delete
DROP POLICY IF EXISTS "comments_select" ON comments;
CREATE POLICY "comments_select" ON comments
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "comments_insert" ON comments;
CREATE POLICY "comments_insert" ON comments
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = author_id);
DROP POLICY IF EXISTS "comments_delete" ON comments;
CREATE POLICY "comments_delete" ON comments
  FOR DELETE TO authenticated USING (auth.uid() = author_id);

-- Likes: anyone can read; only own can insert/delete
DROP POLICY IF EXISTS "likes_select" ON likes;
CREATE POLICY "likes_select" ON likes
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "likes_insert" ON likes;
CREATE POLICY "likes_insert" ON likes
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "likes_delete" ON likes;
CREATE POLICY "likes_delete" ON likes
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Shares: anyone can read; only own can insert
DROP POLICY IF EXISTS "shares_select" ON shares;
CREATE POLICY "shares_select" ON shares
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "shares_insert" ON shares;
CREATE POLICY "shares_insert" ON shares
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- Helper-patients: helpers read own; patients manage own
DROP POLICY IF EXISTS "hp_select" ON helper_patients;
CREATE POLICY "hp_select" ON helper_patients
  FOR SELECT TO authenticated USING (
    auth.uid() = helper_id OR auth.uid() = patient_id
  );
DROP POLICY IF EXISTS "hp_insert" ON helper_patients;
CREATE POLICY "hp_insert" ON helper_patients
  FOR INSERT TO authenticated WITH CHECK (
    auth.uid() = helper_id OR auth.uid() = patient_id
  );
DROP POLICY IF EXISTS "hp_delete" ON helper_patients;
CREATE POLICY "hp_delete" ON helper_patients
  FOR DELETE TO authenticated USING (
    auth.uid() = helper_id OR auth.uid() = patient_id
  );

-- Conversations: only members can see
DROP POLICY IF EXISTS "conversations_select" ON conversations;
CREATE POLICY "conversations_select" ON conversations
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM conversation_members
      WHERE conversation_members.conversation_id = conversations.id
      AND conversation_members.user_id = auth.uid()
    )
  );
DROP POLICY IF EXISTS "conversations_insert" ON conversations;
CREATE POLICY "conversations_insert" ON conversations
  FOR INSERT TO authenticated WITH CHECK (true);

-- Conversation members: only members can see; anyone can add themselves
DROP POLICY IF EXISTS "cm_select" ON conversation_members;
CREATE POLICY "cm_select" ON conversation_members
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM conversation_members cm2
      WHERE cm2.conversation_id = conversation_members.conversation_id
      AND cm2.user_id = auth.uid()
    )
  );
DROP POLICY IF EXISTS "cm_insert" ON conversation_members;
CREATE POLICY "cm_insert" ON conversation_members
  FOR INSERT TO authenticated WITH CHECK (true);

-- Messages: only conversation members can read/insert
DROP POLICY IF EXISTS "messages_select" ON messages;
CREATE POLICY "messages_select" ON messages
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM conversation_members
      WHERE conversation_members.conversation_id = messages.conversation_id
      AND conversation_members.user_id = auth.uid()
    )
  );
DROP POLICY IF EXISTS "messages_insert" ON messages;
CREATE POLICY "messages_insert" ON messages
  FOR INSERT TO authenticated WITH CHECK (
    auth.uid() = sender_id AND
    EXISTS (
      SELECT 1 FROM conversation_members
      WHERE conversation_members.conversation_id = messages.conversation_id
      AND conversation_members.user_id = auth.uid()
    )
  );

-- ── 13. Enable Realtime for chat messages ────────────────────────────────────

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE messages;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

-- =============================================================================
-- Migration 002: Create Storage Buckets for image uploads
-- Run this in Supabase Dashboard > SQL Editor
-- =============================================================================

-- Create public buckets for avatars, backgrounds, and post images
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('backgrounds', 'backgrounds', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('posts', 'posts', true)
ON CONFLICT (id) DO NOTHING;

-- ── Storage RLS Policies ─────────────────────────────────────────────────────

-- Avatars: anyone can view, authenticated users can upload/update their own
DROP POLICY IF EXISTS "avatars_select" ON storage.objects;
CREATE POLICY "avatars_select" ON storage.objects
  FOR SELECT TO public USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS "avatars_insert" ON storage.objects;
CREATE POLICY "avatars_insert" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'avatars');

DROP POLICY IF EXISTS "avatars_update" ON storage.objects;
CREATE POLICY "avatars_update" ON storage.objects
  FOR UPDATE TO authenticated USING (bucket_id = 'avatars');

-- Backgrounds: anyone can view, authenticated users can upload/update their own
DROP POLICY IF EXISTS "backgrounds_select" ON storage.objects;
CREATE POLICY "backgrounds_select" ON storage.objects
  FOR SELECT TO public USING (bucket_id = 'backgrounds');

DROP POLICY IF EXISTS "backgrounds_insert" ON storage.objects;
CREATE POLICY "backgrounds_insert" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'backgrounds');

DROP POLICY IF EXISTS "backgrounds_update" ON storage.objects;
CREATE POLICY "backgrounds_update" ON storage.objects
  FOR UPDATE TO authenticated USING (bucket_id = 'backgrounds');

-- Posts images: anyone can view, authenticated users can upload
DROP POLICY IF EXISTS "posts_images_select" ON storage.objects;
CREATE POLICY "posts_images_select" ON storage.objects
  FOR SELECT TO public USING (bucket_id = 'posts');

DROP POLICY IF EXISTS "posts_images_insert" ON storage.objects;
CREATE POLICY "posts_images_insert" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'posts');

DROP POLICY IF EXISTS "posts_images_update" ON storage.objects;
CREATE POLICY "posts_images_update" ON storage.objects
  FOR UPDATE TO authenticated USING (bucket_id = 'posts');

-- =============================================================================
-- Migration 003: Fix infinite recursion in chat RLS policies
-- Run this in Supabase Dashboard > SQL Editor
-- =============================================================================

-- A SECURITY DEFINER function bypasses RLS, breaking the recursion cycle.
CREATE OR REPLACE FUNCTION public.is_conversation_member(conv_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversation_members
    WHERE conversation_id = conv_id
    AND user_id = auth.uid()
  );
$$;

-- Fix conversation_members: use the function instead of self-referencing subquery
DROP POLICY IF EXISTS "cm_select" ON conversation_members;
CREATE POLICY "cm_select" ON conversation_members
  FOR SELECT TO authenticated USING (
    public.is_conversation_member(conversation_id)
  );

-- Fix conversations: use the function
DROP POLICY IF EXISTS "conversations_select" ON conversations;
CREATE POLICY "conversations_select" ON conversations
  FOR SELECT TO authenticated USING (
    public.is_conversation_member(id)
  );

-- Fix messages SELECT: use the function
DROP POLICY IF EXISTS "messages_select" ON messages;
CREATE POLICY "messages_select" ON messages
  FOR SELECT TO authenticated USING (
    public.is_conversation_member(conversation_id)
  );

-- Fix messages INSERT: use the function
DROP POLICY IF EXISTS "messages_insert" ON messages;
CREATE POLICY "messages_insert" ON messages
  FOR INSERT TO authenticated WITH CHECK (
    auth.uid() = sender_id
    AND public.is_conversation_member(conversation_id)
  );

-- Run this in Supabase Dashboard > SQL Editor

create table if not exists system_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table system_config enable row level security;

DROP POLICY IF EXISTS "Allow authenticated users to read system config" ON public.system_config;
create policy "Allow authenticated users to read system config"
  on public.system_config
  for select using (auth.role() = 'authenticated');

-- The backend uses a Supabase service_role key to write this table and bypass RLS.
-- You can optionally insert the initial backend_url row after deployment.

-- =============================================================================
-- Migration 004: Doctor verifications + helper association requests
-- =============================================================================

CREATE TABLE IF NOT EXISTS doctor_verifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id    UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  document_url TEXT NOT NULL,
  submitted_at TIMESTAMPTZ DEFAULT now(),
  status       TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_at  TIMESTAMPTZ,
  reviewed_by  UUID REFERENCES profiles(id),
  notes        TEXT
);

CREATE INDEX IF NOT EXISTS idx_dv_doctor ON doctor_verifications(doctor_id);

ALTER TABLE doctor_verifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dv_select_own" ON doctor_verifications;
CREATE POLICY "dv_select_own" ON doctor_verifications
  FOR SELECT TO authenticated USING (auth.uid() = doctor_id);

DROP POLICY IF EXISTS "dv_insert_own" ON doctor_verifications;
CREATE POLICY "dv_insert_own" ON doctor_verifications
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = doctor_id);

INSERT INTO storage.buckets (id, name, public)
VALUES ('doctor-docs', 'doctor-docs', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "doctor_docs_insert_own" ON storage.objects;
CREATE POLICY "doctor_docs_insert_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'doctor-docs' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "doctor_docs_select_own" ON storage.objects;
CREATE POLICY "doctor_docs_select_own" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'doctor-docs' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE TABLE IF NOT EXISTS helper_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id   UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  helper_id    UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  initiated_by TEXT NOT NULL CHECK (initiated_by IN ('patient','helper')),
  status       TEXT DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  created_at   TIMESTAMPTZ DEFAULT now(),
  responded_at TIMESTAMPTZ,
  UNIQUE(patient_id, helper_id)
);

CREATE INDEX IF NOT EXISTS idx_hr_patient ON helper_requests(patient_id);
CREATE INDEX IF NOT EXISTS idx_hr_helper  ON helper_requests(helper_id);

ALTER TABLE helper_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hr_select_involved" ON helper_requests;
CREATE POLICY "hr_select_involved" ON helper_requests
  FOR SELECT TO authenticated USING (auth.uid() IN (patient_id, helper_id));

DROP POLICY IF EXISTS "hr_insert_self" ON helper_requests;
CREATE POLICY "hr_insert_self" ON helper_requests
  FOR INSERT TO authenticated WITH CHECK (
    (initiated_by = 'patient' AND auth.uid() = patient_id) OR
    (initiated_by = 'helper'  AND auth.uid() = helper_id)
  );

DROP POLICY IF EXISTS "hr_update_other" ON helper_requests;
CREATE POLICY "hr_update_other" ON helper_requests
  FOR UPDATE TO authenticated USING (
    (initiated_by = 'patient' AND auth.uid() = helper_id) OR
    (initiated_by = 'helper'  AND auth.uid() = patient_id)
  );
