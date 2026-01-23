const fs = require('fs-extra');
const path = require('path');

function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch (_) {
    // Best-effort: avoid crashing logger on circular structures
    return JSON.stringify({ _logger_error: 'unserializable_data' });
  }
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Creates a structured JSONL logger for a single run.
 *
 * Each event is one line in `run.log.jsonl`:
 * { ts, level, runId, step, msg, data }
 */
function createRunLogger({ runDir, runId, echoToConsole = true } = {}) {
  if (!runDir) throw new Error('createRunLogger: runDir is required');
  if (!runId) throw new Error('createRunLogger: runId is required');

  const logPath = path.join(runDir, 'run.log.jsonl');
  fs.ensureDirSync(runDir);
  // Always start a fresh log file for the current run (avoid mixing runs).
  fs.writeFileSync(logPath, '', 'utf8');

  const writeLineSync = (line) => {
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
  };

  const log = (level, msg, data = null, step = null) => {
    const evt = {
      ts: nowIso(),
      level,
      runId,
      step: step || null,
      msg: String(msg || ''),
      data: data == null ? null : data,
    };

    writeLineSync(safeJsonStringify(evt));

    if (echoToConsole) {
      const prefix = `[${level.toUpperCase()}] ${evt.ts}${step ? ` [${step}]` : ''} - ${evt.msg}`;
      if (level === 'error') console.error(prefix);
      else if (level === 'warn') console.warn(prefix);
      else console.log(prefix);
    }
  };

  const child = (step) => ({
    info: (msg, data) => log('info', msg, data, step),
    warn: (msg, data) => log('warn', msg, data, step),
    error: (msg, data) => log('error', msg, data, step),
    success: (msg, data) => log('success', msg, data, step),
    debug: (msg, data) => log('debug', msg, data, step),
  });

  return {
    logPath,
    info: (msg, data, step) => log('info', msg, data, step),
    warn: (msg, data, step) => log('warn', msg, data, step),
    error: (msg, data, step) => log('error', msg, data, step),
    success: (msg, data, step) => log('success', msg, data, step),
    debug: (msg, data, step) => log('debug', msg, data, step),
    child,
  };
}

module.exports = { createRunLogger };

