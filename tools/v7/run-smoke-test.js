const path = require('path');
const fs = require('fs-extra');

const { initRun } = require('../utils/run-context');

async function main() {
  const run = await initRun({
    mode: 'smoke',
    url: 'about:blank',
    targetId: 'smoke',
    suffix: 'smoke',
    keepDays: 7,
    purgeTrash: false,
    echoToConsole: true,
  });

  await run.step('smoke.step', async ({ logger, inc, setOutput, artifactsDir }) => {
    logger.info('writing artifacts');
    inc('smoke_events', 1);
    setOutput('artifactDir', artifactsDir);

    const p = path.join(artifactsDir, 'smoke_artifact.json');
    await fs.writeJson(p, { ok: true, ts: new Date().toISOString() }, { spaces: 2 });
    logger.success('artifact written', { path: p });
  });

  await run.finalize({ ok: true, qa: { status: 'not_applicable' } });

  console.log('RUN PATHS:', run.paths);
}

main().catch((err) => {
  console.error('❌ run-smoke-test failed:', err?.message || err);
  process.exit(1);
});

