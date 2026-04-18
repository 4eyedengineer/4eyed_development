/**
 * Thin module that exposes the model id + availability check.
 *
 * The legacy one-shot `generateDockerfile` helper that used to live here was
 * removed when dockerfileGenerator.js was rewritten to use the ReAct
 * tool-use loop in agentRunner.js. The Anthropic client itself now lives
 * inside agentRunner.js and is constructed lazily there.
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

export const DEFAULT_MODEL = 'claude-haiku-4-5';

/**
 * Check if LLM generation is available (API key configured).
 */
export function isLLMAvailable() {
  return !!ANTHROPIC_API_KEY;
}
