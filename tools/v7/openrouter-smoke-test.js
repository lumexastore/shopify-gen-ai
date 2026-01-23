const { initRun } = require('../utils/run-context');
const { createOpenRouterClient } = require('../utils/ai-client');
const { ROLES, resolveModelForRole, resolveParamsForRole } = require('./ai-config');

async function main() {
  const run = await initRun({
    mode: 'openrouter_smoke',
    url: 'about:blank',
    targetId: 'smoke',
    suffix: 'smoke',
    keepDays: 7,
    purgeTrash: false,
    echoToConsole: true,
  });

  await run.step('openrouter.models', async ({ logger, setModelUsed }) => {
    const ai = createOpenRouterClient();
    const models = await ai.listModels();
    logger.info('models.count', { count: models?.data?.length || models?.length || null });

    const role = ROLES.ARCHITECT;
    const model = resolveModelForRole(role);
    setModelUsed(role, model);
  });

  await run.finalize({ ok: true });
}

main().catch((err) => {
  console.error('❌ openrouter-smoke-test failed:', err?.message || err);
  process.exit(1);
});

