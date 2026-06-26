-- Supabase SQL migration: user_memories table
-- Run this in your Supabase SQL Editor (https://supabase.com/dashboard/project/_/sql/new)

CREATE TABLE IF NOT EXISTS user_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_memories_user_id ON user_memories (user_id);

-- Row level security: allow access via anon key (the bot uses anon key)
ALTER TABLE user_memories ENABLE ROW LEVEL SECURITY;

-- Allow all operations for the service role (anon key with public access)
-- For production, restrict to service_role key instead
CREATE POLICY "Allow all on user_memories" ON user_memories
  FOR ALL
  USING (true)
  WITH CHECK (true);
