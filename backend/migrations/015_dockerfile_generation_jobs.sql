-- Async Dockerfile generation jobs.
--
-- Each row is one validated-generation run: user kicks it off, agent runs in
-- the background, events stream via WebSocket, result lands here when done.
-- The frontend can also poll this row as a fallback if it misses WS events
-- or reconnects mid-job.

CREATE TABLE IF NOT EXISTS dockerfile_generation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL,
  workdir TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  -- Result on success: {dockerfile, dockerignore, detectedPort, framework, validatedBy, ...}
  -- Result on failure: {message, suggestedUserActions, buildOutput, stage}
  result JSONB,
  -- Append-only log of agent tool calls (run_command, write_file, etc.).
  -- Useful for fallback polling — clients that miss WS events can replay.
  tool_events JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dockerfile_gen_jobs_user
  ON dockerfile_generation_jobs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dockerfile_gen_jobs_status
  ON dockerfile_generation_jobs(status) WHERE status IN ('pending', 'running');
