-- MemoryVault Supabase Setup
-- Run this SQL in your Supabase project's SQL Editor

-- Memories table (stores encrypted data)
CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  local_id TEXT,
  type TEXT NOT NULL CHECK(type IN ('identity','preference','project','episode','rule')),
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  project TEXT,
  confidence REAL NOT NULL DEFAULT 0.8,
  confirmation_count INTEGER NOT NULL DEFAULT 0,
  source_tool TEXT,
  source_excerpt TEXT,
  source_conversation_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','pending_review')),
  is_encrypted BOOLEAN NOT NULL DEFAULT true,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_memories_user_updated ON memories(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_memories_local_id ON memories(user_id, local_id);

-- Row Level Security: users can only access their own data
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;

-- Policy: full access to own data
CREATE POLICY "users_own_data" ON memories
  FOR ALL USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Auto-update updated_at on changes
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memories_updated_at
  BEFORE UPDATE ON memories
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
