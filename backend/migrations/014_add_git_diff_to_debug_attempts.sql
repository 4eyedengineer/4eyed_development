-- Add git_diff column to debug_attempts so the UI can surface a real unified
-- patch of what the ReAct debug agent changed in the sandbox.
ALTER TABLE debug_attempts ADD COLUMN IF NOT EXISTS git_diff TEXT;
