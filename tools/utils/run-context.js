const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');

const { cleanupWorkspace } = require('../cleanup-workspace');
const { createRunLogger } = require('./run-logger');

const WORKSPACE_DIR = path.resolve(__dirname, '../../workspace');
const RUNS_DIR = path.join(WORKSPACE_DIR, 'runs');
const LATEST_DIR = path.join(RUNS_DIR, 'latest');

function newRunId() {
  const rand = crypto.randomBytes(2).toString('hex');
  return `run_${Date.now()}_${rand}`;
}

function nowIso() {
  return new Date().toISOString();
}

async function writeJsonAtomic(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  await fs.writeJson(tmp, obj, { spaces: 2 });
  await fs.move(tmp, filePath, { overwrite: true });
}

/**
 * Initializes a fresh run directory under `workspace/runs/latest/`.
 * Moves previous `runs/latest` to trash via cleanup-workspace (mode=pre_run).
 */
async function initRun({
  mode = null,
  url = null,
  targetId = null,
  suffix = null,
  keepDays = 7,
  purgeTrash = true,
  dryRun = false,
  echoToConsole = true,
} = {}) {
  await fs.ensureDir(WORKSPACE_DIR);
  await fs.ensureDir(RUNS_DIR);

  // Move previous latest run to trash (and do other safe cleanup).
  await cleanupWorkspace({ mode: 'pre_run', keepDays, purgeTrash, dryRun });

  // Create latest run dir and subdirs
  await fs.ensureDir(LATEST_DIR);
  const artifactsDir = path.join(LATEST_DIR, 'artifacts');
  await fs.ensureDir(artifactsDir);

  const runId = newRunId();
  const logger = createRunLogger({ runDir: LATEST_DIR, runId, echoToConsole });

  const summaryPath = path.join(LATEST_DIR, 'run_summary.json');
  const metricsPath = path.join(LATEST_DIR, 'step_metrics.json');

  const summary = {
    runId,
    startedAt: nowIso(),
    endedAt: null,
    ok: null,
    mode,
    url,
    targetId,
    suffix,
    nodeVersion: process.version,
    models: {},
    outputs: {},
    qa: null,
    errors: [],
  };

  const metrics = {
    runId,
    startedAt: summary.startedAt,
    steps: {},
    counters: {},
  };

  await writeJsonAtomic(summaryPath, summary);
  await writeJsonAtomic(metricsPath, metrics);

  const persist = async () => {
    await writeJsonAtomic(summaryPath, summary);
    await writeJsonAtomic(metricsPath, metrics);
  };

  const inc = (name, by = 1) => {
    metrics.counters[name] = (metrics.counters[name] || 0) + by;
  };

  const setModelUsed = (role, modelId) => {
    if (!role) return;
    summary.models[role] = modelId || null;
  };

  const setOutput = (key, value) => {
    summary.outputs[key] = value;
  };

  const step = async (name, fn) => {
    const t0 = Date.now();
    logger.info('step.start', { name }, name);
    metrics.steps[name] = metrics.steps[name] || {};
    metrics.steps[name].startedAt = nowIso();
    metrics.steps[name].durationMs = null;
    metrics.steps[name].ok = null;

    try {
      const result = await fn({ logger: logger.child(name), summary, metrics, inc, setModelUsed, setOutput, artifactsDir });
      const dt = Date.now() - t0;
      metrics.steps[name].durationMs = dt;
      metrics.steps[name].endedAt = nowIso();
      metrics.steps[name].ok = true;
      logger.success('step.end', { name, durationMs: dt }, name);
      await persist();
      return result;
    } catch (err) {
      const dt = Date.now() - t0;
      metrics.steps[name].durationMs = dt;
      metrics.steps[name].endedAt = nowIso();
      metrics.steps[name].ok = false;
      const msg = err?.message || String(err);
      summary.errors.push({ step: name, message: msg });
      logger.error('step.error', { name, durationMs: dt, message: msg }, name);
      await persist();
      throw err;
    }
  };

  const finalize = async ({ ok, qa = null, outputs = null } = {}) => {
    summary.endedAt = nowIso();
    summary.ok = ok;
    if (qa != null) summary.qa = qa;
    if (outputs != null) summary.outputs = { ...summary.outputs, ...outputs };
    await persist();
    logger.info('run.finalize', { ok, qa }, 'finalize');
  };

  logger.info('run.start', { mode, url, targetId, suffix });

  return {
    runId,
    runDir: LATEST_DIR,
    artifactsDir,
    paths: { summaryPath, metricsPath, logPath: logger.logPath },
    summary,
    metrics,
    logger,
    inc,
    setModelUsed,
    setOutput,
    step,
    finalize,
  };
}

module.exports = { initRun, WORKSPACE_DIR, RUNS_DIR, LATEST_DIR };

