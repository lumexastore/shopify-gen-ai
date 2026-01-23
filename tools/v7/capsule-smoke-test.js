const { initRun, WORKSPACE_DIR } = require('../utils/run-context');
const { generateThemeCapabilities } = require('./theme-capabilities');
const { generateKnowledgeCapsule } = require('./knowledge-capsule');

async function main() {
  const run = await initRun({
    mode: 'capsule_smoke',
    url: 'about:blank',
    targetId: 'smoke',
    suffix: 'smoke',
    keepDays: 7,
    purgeTrash: false,
    echoToConsole: true,
  });

  let themeCaps = null;

  await run.step('theme.capabilities', async ({ logger }) => {
    const res = await generateThemeCapabilities({ runDir: run.runDir, logger });
    themeCaps = res.data;
  });

  await run.step('knowledge.capsule', async ({ logger }) => {
    await generateKnowledgeCapsule({
      runDir: run.runDir,
      logger,
      runMeta: { ...run.summary, runId: run.runId },
      themeCapabilities: themeCaps,
      workspaceDir: WORKSPACE_DIR,
    });
  });

  await run.finalize({ ok: true });
}

main().catch((err) => {
  console.error('❌ capsule-smoke-test failed:', err?.message || err);
  process.exit(1);
});

