-- AI assistant, in each hospital's own database (schema "assistant"). docs/AI-AGENTS.md §8.1.
-- Patient records are never put here: only the chat itself (encrypted) and the hospital's own non-medical knowledge.

-- Conversations: one per patient chat session
CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  agent text NOT NULL DEFAULT 'CONCIERGE' CHECK (agent IN ('CONCIERGE')),
  user_id uuid NOT NULL,                               -- the signed-in person (account holder)
  channel text NOT NULL DEFAULT 'WEB' CHECK (channel IN ('WEB')),
  language text NOT NULL DEFAULT 'en',
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','HANDED_OFF','CLOSED')),
  prompt_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON conversations (user_id, last_activity_at DESC);

-- Messages: text encrypted with the hospital's data key (AAD = hospital + table + message id)
CREATE TABLE messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  seq int NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  -- ANSWER: from the model; EMERGENCY: the fixed emergency reply (no model call); BLOCKED: the model's answer broke the
  -- output policy and was replaced; FALLBACK: model unavailable/refused; HANDOFF: handed to a person; LIMIT: quota
  kind text NOT NULL DEFAULT 'TEXT' CHECK (kind IN ('TEXT','ANSWER','EMERGENCY','BLOCKED','FALLBACK','HANDOFF','LIMIT')),
  content_enc bytea NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]',                 -- knowledge articles the answer used [{id,title}]
  safety jsonb,                                        -- {emergency: category} or {blocked: [rule ids]} (never the text)
  model text, finish_reason text,
  input_tokens int, output_tokens int, cached_tokens int, latency_ms int,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);

-- Thumbs up/down on an answer
CREATE TABLE feedback (
  message_id uuid PRIMARY KEY REFERENCES messages(id),
  user_id uuid NOT NULL,
  rating smallint NOT NULL CHECK (rating IN (-1, 1)),
  reason text CHECK (reason IN ('WRONG','UNHELPFUL','UNSAFE','OTHER')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Human handoff: the front desk calls the patient back
CREATE TABLE handoffs (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  user_id uuid NOT NULL,
  name text NOT NULL,
  phone text,
  reason text NOT NULL CHECK (reason IN ('ASKED','NO_ANSWER','EMERGENCY','LIMIT','FALLBACK')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DONE')),
  closed_by uuid, closed_at timestamptz, note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX handoffs_one_open ON handoffs (conversation_id) WHERE status = 'OPEN';
CREATE INDEX ON handoffs (status, created_at);

-- Knowledge base: the hospital's own non-medical information. FAQ/POLICY/EMERGENCY are written by the hospital
-- (defaults seeded at provisioning); TEST_PREP is copied from the lab catalog (read-only here).
CREATE TABLE kb_articles (
  id uuid PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('FAQ','POLICY','EMERGENCY','TEST_PREP')),
  source_ref text,                                      -- seed key or lab test/package code
  title text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  body text NOT NULL CHECK (length(body) BETWEEN 2 AND 8000),
  language text NOT NULL DEFAULT 'en',
  active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX kb_articles_ref ON kb_articles (source, source_ref) WHERE source_ref IS NOT NULL;

-- Chunks with embeddings (cosine). embed_model says which model made the vector: a model change re-embeds.
CREATE TABLE kb_chunks (
  id uuid PRIMARY KEY,
  article_id uuid NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  seq int NOT NULL,
  text text NOT NULL,
  embedding public.vector(768) NOT NULL,
  embed_model text NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  UNIQUE (article_id, seq)
);
CREATE INDEX ON kb_chunks USING hnsw (embedding public.vector_cosine_ops);
CREATE INDEX ON kb_chunks USING gin (tsv);
