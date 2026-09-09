-- T47 AI talk persistence extension.
-- 001_init.sql is immutable; all AI-specific schema additions live here.

CREATE TABLE ai_sessions (
  id TEXT PRIMARY KEY,
  entrypoint TEXT NOT NULL,
  pet_pack_id TEXT NOT NULL,
  active_conversation_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_sessions_updated ON ai_sessions(updated_at DESC);

ALTER TABLE ai_conversations ADD COLUMN session_id TEXT;
ALTER TABLE ai_conversations ADD COLUMN public_id TEXT;
ALTER TABLE ai_conversations ADD COLUMN entrypoint TEXT;
ALTER TABLE ai_conversations ADD COLUMN pet_pack_id TEXT;
ALTER TABLE ai_conversations ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE ai_conversations ADD COLUMN persona_hash TEXT;
CREATE INDEX idx_ai_conversations_session ON ai_conversations(session_id, updated_at DESC);
CREATE UNIQUE INDEX idx_ai_conversations_public ON ai_conversations(session_id, public_id);
CREATE INDEX idx_ai_conversations_pack ON ai_conversations(pet_pack_id, updated_at DESC);

ALTER TABLE ai_messages ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
CREATE INDEX idx_ai_messages_order ON ai_messages(conversation_id, created_at, id);

ALTER TABLE ai_memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'global';
ALTER TABLE ai_memories ADD COLUMN pet_pack_id TEXT;
ALTER TABLE ai_memories ADD COLUMN source_conversation_id TEXT;
ALTER TABLE ai_memories ADD COLUMN source_message_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ai_memories ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ai_memories ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5;
ALTER TABLE ai_memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.5;
ALTER TABLE ai_memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE ai_memories ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_memories ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_memories ADD COLUMN last_used_at INTEGER;
ALTER TABLE ai_memories ADD COLUMN last_evidence_at INTEGER;
ALTER TABLE ai_memories ADD COLUMN reason TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_ai_memories_scope ON ai_memories(scope, pet_pack_id, status, updated_at DESC);

CREATE TABLE ai_persona_overrides (
  pet_pack_id TEXT PRIMARY KEY,
  persona_json TEXT NOT NULL,
  persona_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE ai_pet_utterances (
  id TEXT PRIMARY KEY,
  pet_pack_id TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  ttl_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_pet_utterances_pack ON ai_pet_utterances(pet_pack_id, created_at DESC);

CREATE TABLE ai_memory_jobs (
  id TEXT PRIMARY KEY,
  pet_pack_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  error_code TEXT NOT NULL DEFAULT '',
  applied_count INTEGER NOT NULL DEFAULT 0,
  filtered_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_memory_jobs_status ON ai_memory_jobs(status, updated_at DESC);

ALTER TABLE traces ADD COLUMN session_id TEXT;
ALTER TABLE traces ADD COLUMN entrypoint TEXT;
ALTER TABLE traces ADD COLUMN pet_pack_id TEXT;
ALTER TABLE traces ADD COLUMN conversation_id TEXT;
ALTER TABLE traces ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
CREATE INDEX idx_traces_conversation ON traces(conversation_id, at DESC);
CREATE INDEX idx_traces_pack ON traces(pet_pack_id, at DESC);

-- Preserve legacy record fields independently of searchable projections.
ALTER TABLE ai_sessions ADD COLUMN entity_json TEXT;
ALTER TABLE ai_conversations ADD COLUMN entity_json TEXT;
ALTER TABLE ai_messages ADD COLUMN entity_json TEXT;
ALTER TABLE ai_messages ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_memories ADD COLUMN entity_json TEXT;
ALTER TABLE ai_persona_overrides ADD COLUMN entity_json TEXT;
ALTER TABLE ai_pet_utterances ADD COLUMN entity_json TEXT;
ALTER TABLE ai_pet_utterances ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_memory_jobs ADD COLUMN entity_json TEXT;
ALTER TABLE traces ADD COLUMN entity_json TEXT;
ALTER TABLE traces ADD COLUMN owner TEXT;
ALTER TABLE traces ADD COLUMN state_key TEXT;
CREATE INDEX idx_ai_message_ordinal ON ai_messages(conversation_id, ordinal);
CREATE TABLE ai_store_meta (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
