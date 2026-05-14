-- Add 'cancelled' to the dockerfile_generation_jobs status check.
-- Existing rows are unaffected (their values remain valid).

ALTER TABLE dockerfile_generation_jobs
  DROP CONSTRAINT IF EXISTS dockerfile_generation_jobs_status_check;

ALTER TABLE dockerfile_generation_jobs
  ADD CONSTRAINT dockerfile_generation_jobs_status_check
  CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled'));
