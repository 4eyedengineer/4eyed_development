import Anthropic from '@anthropic-ai/sdk';
import logger from './logger.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

let sharedClient = null;

function getClient() {
  if (!sharedClient) {
    if (!ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }
    sharedClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
  return sharedClient;
}

/**
 * Run a ReAct tool-use loop.
 *
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} opts.systemPrompt - Will be sent with cache_control: 'ephemeral'
 * @param {string} opts.initialUserMessage
 * @param {Array<{name, description, input_schema, execute: (input) => Promise<string|{content, is_error}>}>} opts.tools
 * @param {number} [opts.maxIterations=20]
 * @param {number} [opts.maxTokens=16000]
 * @param {(event: object) => void} [opts.onEvent] - Optional event hook for streaming
 * @returns {Promise<{
 *   finalMessage: object,
 *   messages: Array,
 *   usage: {input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens},
 *   iterations: number,
 *   stopReason: string,
 *   budgetExceeded: boolean
 * }>}
 */
export async function runAgent({
  model,
  systemPrompt,
  initialUserMessage,
  tools,
  maxIterations = 20,
  maxTokens = 16000,
  onEvent,
}) {
  if (!model) throw new Error('runAgent: model is required');
  if (!systemPrompt) throw new Error('runAgent: systemPrompt is required');
  if (!Array.isArray(tools)) throw new Error('runAgent: tools must be an array');

  const client = getClient();

  // Tool registry by name
  const toolByName = new Map(tools.map(t => [t.name, t]));

  // Tool definitions sent to the API (strip the execute fn).
  // Cache the tool definitions block too — together with the system prompt
  // these are the stable prefix across iterations and across runs.
  const toolDefs = tools.map(({ name, description, input_schema }) => ({
    name,
    description,
    input_schema,
  }));
  if (toolDefs.length > 0) {
    toolDefs[toolDefs.length - 1].cache_control = { type: 'ephemeral' };
  }

  const systemBlocks = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
  ];

  const messages = [{ role: 'user', content: initialUserMessage }];

  const totalUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };

  let iterations = 0;
  let lastResponse = null;
  let budgetExceeded = false;

  while (iterations < maxIterations) {
    iterations += 1;

    let response;
    try {
      response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemBlocks,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        messages,
      });
    } catch (err) {
      // Surface SDK typed errors verbatim so callers can branch on them.
      logger.error({ err: err.message, model, iteration: iterations }, 'agentRunner: API call failed');
      throw err;
    }

    lastResponse = response;

    // Accumulate usage
    if (response.usage) {
      totalUsage.input_tokens += response.usage.input_tokens || 0;
      totalUsage.output_tokens += response.usage.output_tokens || 0;
      totalUsage.cache_read_input_tokens += response.usage.cache_read_input_tokens || 0;
      totalUsage.cache_creation_input_tokens += response.usage.cache_creation_input_tokens || 0;
    }

    // Optional streaming hook — emit each content block
    if (onEvent && Array.isArray(response.content)) {
      for (const block of response.content) {
        try {
          onEvent({ type: 'block', iteration: iterations, block });
        } catch (e) {
          // Never let user hook crash the loop
          logger.warn({ err: e.message }, 'agentRunner: onEvent hook threw');
        }
      }
    }

    // Append assistant response to messages — preserve content array verbatim.
    messages.push({ role: 'assistant', content: response.content });

    const stopReason = response.stop_reason;

    if (stopReason === 'end_turn') {
      return {
        finalMessage: response,
        messages,
        usage: totalUsage,
        iterations,
        stopReason,
        budgetExceeded: false,
      };
    }

    if (stopReason === 'max_tokens') {
      logger.warn({ iterations }, 'agentRunner: hit max_tokens before end_turn');
      budgetExceeded = true;
      return {
        finalMessage: response,
        messages,
        usage: totalUsage,
        iterations,
        stopReason,
        budgetExceeded,
      };
    }

    if (stopReason === 'pause_turn') {
      // Server-side pause — re-send to continue. Assistant content is already appended.
      continue;
    }

    if (stopReason === 'tool_use') {
      const toolUseBlocks = (response.content || []).filter(b => b.type === 'tool_use');

      if (toolUseBlocks.length === 0) {
        logger.warn({ iterations }, 'agentRunner: stop_reason=tool_use but no tool_use blocks');
        return {
          finalMessage: response,
          messages,
          usage: totalUsage,
          iterations,
          stopReason,
          budgetExceeded: false,
        };
      }

      // Execute each tool_use in order. Build matching tool_result blocks.
      const toolResults = [];
      for (const toolUse of toolUseBlocks) {
        const tool = toolByName.get(toolUse.name);

        if (onEvent) {
          try {
            onEvent({ type: 'tool_use', iteration: iterations, name: toolUse.name, input: toolUse.input, id: toolUse.id });
          } catch (e) { /* swallow */ }
        }

        let resultBlock;
        if (!tool) {
          resultBlock = {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Error: unknown tool "${toolUse.name}"`,
            is_error: true,
          };
        } else {
          try {
            const raw = await tool.execute(toolUse.input || {});
            if (typeof raw === 'string') {
              resultBlock = { type: 'tool_result', tool_use_id: toolUse.id, content: raw };
            } else if (raw && typeof raw === 'object' && 'content' in raw) {
              resultBlock = {
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: String(raw.content),
                ...(raw.is_error ? { is_error: true } : {}),
              };
            } else {
              resultBlock = {
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: typeof raw === 'undefined' ? '(no output)' : JSON.stringify(raw),
              };
            }
          } catch (err) {
            // Never crash the loop on tool errors — feed them back to the model.
            logger.warn({ tool: toolUse.name, err: err.message }, 'agentRunner: tool execute threw');
            resultBlock = {
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `Error: ${err.message}`,
              is_error: true,
            };
          }
        }

        if (onEvent) {
          try {
            onEvent({
              type: 'tool_result',
              iteration: iterations,
              tool_use_id: toolUse.id,
              content: resultBlock.content,
              is_error: !!resultBlock.is_error,
            });
          } catch (e) { /* swallow */ }
        }

        toolResults.push(resultBlock);
      }

      // All tool_results in a single user message — exactly one per tool_use_id.
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Unknown stop_reason — bail out gracefully.
    logger.warn({ stopReason, iterations }, 'agentRunner: unexpected stop_reason');
    return {
      finalMessage: response,
      messages,
      usage: totalUsage,
      iterations,
      stopReason,
      budgetExceeded: false,
    };
  }

  // Hit iteration cap.
  logger.warn({ iterations, maxIterations }, 'agentRunner: max iterations reached');
  return {
    finalMessage: lastResponse,
    messages,
    usage: totalUsage,
    iterations,
    stopReason: lastResponse?.stop_reason || 'iteration_limit',
    budgetExceeded: true,
  };
}
