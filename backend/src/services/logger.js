/**
 * Simple logger for services that don't have access to fastify
 * Matches pino log format for consistency
 */

const LOG_LEVELS = {
  debug: 20,
  info: 30,
  warn: 40,
  error: 50
};

const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] || LOG_LEVELS.info;

// Accepts BOTH conventions:
//   logger.info('message', { extra })          — legacy wrapper order
//   logger.info({ extra }, 'message')          — Pino order (preferred)
//   logger.info('message')
//   logger.info({ extra })
function normalize(a, b) {
  if (typeof a === 'string') return { msg: a, extra: (b && typeof b === 'object') ? b : {} };
  if (typeof a === 'object' && a !== null) {
    return { msg: typeof b === 'string' ? b : '', extra: a };
  }
  return { msg: String(a), extra: {} };
}

function formatLog(level, a, b) {
  const { msg, extra } = normalize(a, b);
  return JSON.stringify({
    level: LOG_LEVELS[level],
    time: Date.now(),
    msg,
    ...extra,
  });
}

export const logger = {
  debug(a, b) { if (CURRENT_LEVEL <= LOG_LEVELS.debug) console.log(formatLog('debug', a, b)); },
  info(a, b)  { if (CURRENT_LEVEL <= LOG_LEVELS.info)  console.log(formatLog('info', a, b)); },
  warn(a, b)  { if (CURRENT_LEVEL <= LOG_LEVELS.warn)  console.warn(formatLog('warn', a, b)); },
  error(a, b) { if (CURRENT_LEVEL <= LOG_LEVELS.error) console.error(formatLog('error', a, b)); },
};

export default logger;
