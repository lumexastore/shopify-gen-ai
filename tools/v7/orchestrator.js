require('dotenv').config();

const fs = require('fs-extra');
const path = require('path');

const { initRun, WORKSPACE_DIR } = require('../utils/run-context');
const { themeUnlock } = require('./theme-unlock');
const { generateThemeCapabilities } = require('./theme-capabilities');
const { generateKnowledgeCapsule } = require('./knowledge-capsule');
const { createOpenRouterClient } = require('../utils/ai-client');
const { ROLES, resolveModelForRole } = require('./ai-config');
const shopifyClient = require('../../src/services/shopifyClient');
const config = require('../../src/config');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (!a.startsWith('--')) out._.push(a);
    else {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[k] = v;
    }
  }
  return out;
}

function usage() {
  return `
V7 Orchestrator

Commands:
  unlock-theme [--themeId <id>]
  capsule --mode <product|page> --url <donorUrl> --targetId <id> --suffix <suffix>
  clone --mode <product|page> --url <donorUrl> --suffix <suffix> [--productId <id> | --pageId <id>] [--themeId <id>]
       [--qaIterations 2] [--skipQa]
       [--createProduct] [--createPage]
       [--minSections 1]
       [--storefrontPassword <pw>]
  qa --donorUrl <url> --resultUrl <url> [--applyTemplateKey <templates/...json>]
  openrouter-smoke

Examples:
  node tools/v7/orchestrator.js unlock-theme
  node tools/v7/orchestrator.js capsule --mode product --url "https://example.com" --targetId 123 --suffix cloned-v7
  node tools/v7/orchestrator.js clone --mode product --url "https://example.com" --productId 123 --suffix cloned-v7
  node tools/v7/orchestrator.js qa --donorUrl "https://example.com" --resultUrl "https://yourstore.com/products/handle"
  node tools/v7/orchestrator.js openrouter-smoke
`.trim();
}

async function cmdUnlockTheme(args) {
  const themeId = args.themeId ? Number(args.themeId) : null;
  await themeUnlock({ themeId: Number.isFinite(themeId) ? themeId : null });
}

async function cmdCapsule(args) {
  const mode = args.mode || null;
  const url = args.url || null;
  const targetId = args.targetId || null;
  const suffix = args.suffix || null;

  const run = await initRun({
    mode: mode ? `capsule_${mode}` : 'capsule',
    url,
    targetId,
    suffix,
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

async function cmdOpenRouterSmoke() {
  const run = await initRun({
    mode: 'openrouter_smoke',
    url: null,
    targetId: null,
    suffix: null,
    keepDays: 7,
    purgeTrash: false,
    echoToConsole: true,
  });

  await run.step('openrouter.models', async ({ logger, setModelUsed }) => {
    const ai = createOpenRouterClient();
    const models = await ai.listModels();
    logger.info('models.response', { hasData: !!models });

    const role = ROLES.ARCHITECT;
    const model = resolveModelForRole(role);
    setModelUsed(role, model);
  });

  await run.finalize({ ok: true });
}

async function cmdQa(args) {
  const { qaRepair } = require('./qa-repair');
  return await qaRepair({
    donorUrl: args.donorUrl || null,
    resultUrl: args.resultUrl || null,
    donorPng: args.donorPng || null,
    resultPng: args.resultPng || null,
    storefrontPassword: args.storefrontPassword || args.password || null,
    applyTemplateKey: args.applyTemplateKey || null,
    sectionType: args.sectionType || 'ai-super-canvas',
    maxIterations: args.maxIterations ? Number(args.maxIterations) : 2,
  });
}

async function cmdClone(args) {
  const mode = (args.mode || '').toLowerCase();
  const url = args.url || null;
  const suffix = args.suffix || 'cloned-v7';
  const themeId = args.themeId ? Number(args.themeId) : null;
  let productId = args.productId || null;
  let pageId = args.pageId || null;
  const qaIterations = args.qaIterations ? Number(args.qaIterations) : 2;
  const skipQa = !!args.skipQa;
  const createProduct = !!args.createProduct;
  const createPage = !!args.createPage;
  const minSections = args.minSections != null ? Number(args.minSections) : 1;
  const storefrontPassword = args.storefrontPassword || args.password || null;

  if (!Number.isFinite(minSections) || minSections < 0) {
    throw new Error('Invalid --minSections (must be a number >= 0)');
  }

  if (!url) throw new Error('Missing --url');
  if (!['product', 'page'].includes(mode)) throw new Error('Use --mode product|page');
  if (mode === 'product' && !productId && !createProduct) {
    throw new Error('Missing --productId for product mode (or pass --createProduct)');
  }
  if (mode === 'page' && !pageId && !createPage) {
    throw new Error('Missing --pageId for page mode (or pass --createPage)');
  }

  const run = await initRun({
    mode: `clone_${mode}`,
    url,
    targetId: mode === 'page' ? pageId : productId,
    suffix,
    keepDays: 7,
    purgeTrash: false,
    echoToConsole: true,
  });

  const capturePackPath = `${WORKSPACE_DIR}\\capture_pack.v6.json`;
  const passportV5Path = `${WORKSPACE_DIR}\\donor_passport.v5.json`;
  const v7PlanPath = `${WORKSPACE_DIR}\\dawn_layout_plan.v7.json`;

  // 1) Capture pack
  await run.step('capture-pack', async ({ logger }) => {
    const { capturePack } = require('../capture-pack');
    await capturePack(url);

    // Snapshot inputs into the run folder for reproducibility/debugging.
    const pack = await fs.readJson(capturePackPath).catch(() => null);
    const sectionCount = Array.isArray(pack?.sections) ? pack.sections.length : 0;
    const emitted = pack?.diagnostics?.emittedSections ?? sectionCount;

    logger.success('capture-pack complete', {
      path: capturePackPath,
      emittedSections: emitted,
      sections: sectionCount,
      packUrl: pack?.url || pack?.doc?.url || null,
    });

    run.setOutput?.('capturePackPath', capturePackPath);
    if (pack?.url || pack?.doc?.url) run.setOutput?.('capturedUrl', pack.url || pack.doc.url);

    const artifactPackPath = path.join(run.artifactsDir, 'capture_pack.v6.json');
    await fs.copy(capturePackPath, artifactPackPath, { overwrite: true });

    const donorFull = pack?.fullPageScreenshot || `${WORKSPACE_DIR}\\screenshots\\latest\\donor_full_v6.png`;
    if (donorFull && (await fs.pathExists(donorFull))) {
      await fs.copy(donorFull, path.join(run.artifactsDir, 'donor_full_v6.png'), { overwrite: true });
    }

    const donorSectionsDir = `${WORKSPACE_DIR}\\screenshots\\latest\\sections`;
    if (await fs.pathExists(donorSectionsDir)) {
      await fs.copy(donorSectionsDir, path.join(run.artifactsDir, 'donor_sections'), { overwrite: true });
    }

    if (sectionCount < minSections) {
      throw new Error(
        `capture-pack emitted too few sections (${sectionCount}, minSections=${minSections}). ` +
          `Usually this means the page didn't render fully (cookie banner/redirect), or our heuristics missed blocks.`
      );
    }
  });

  // 2) Passport (for assets + tokens)
  await run.step('deep-inspector', async ({ logger }) => {
    const { deepInspector } = require('../deep-inspector');
    await deepInspector(url);
    logger.success('passport v5 complete', { path: passportV5Path });

    run.setOutput?.('passportV5Path', passportV5Path);
    await fs.copy(passportV5Path, path.join(run.artifactsDir, 'donor_passport.v5.json'), { overwrite: true });
  });

  // 2.5) Optional: auto-create product/page target
  if (mode === 'product' && !productId && createProduct) {
    await run.step('create-product', async ({ logger }) => {
      // Prefer cloning product content from Shopify donor (products/<handle>.js) when possible.
      try {
        const { cloneProductFromDonor } = require('./clone-product-from-donor');
        const cloned = await cloneProductFromDonor({ donorProductUrl: url, logger });
        productId = cloned.productId;
        logger.success('created product from donor', { productId, handle: cloned.handle, donorHandle: cloned.donorHandle });
      } catch (e) {
        logger.warn('cloneProductFromDonor failed; falling back to blank product', { error: e?.message || String(e) });
        const { createProduct } = require('../create-product');
        await createProduct();
        // Reload legacy passport (create-product currently persists createdProductId there reliably)
        const legacyPassportPath = `${WORKSPACE_DIR}\\donor_passport.json`;
        if (require('fs').existsSync(legacyPassportPath)) {
          const legacy = await require('fs-extra').readJson(legacyPassportPath);
          productId = legacy.createdProductId ? String(legacy.createdProductId) : null;
        }
        if (!productId) throw new Error('create-product did not produce createdProductId');
        logger.success('created blank product', { productId });
      }
    });
  }

  if (mode === 'page' && !pageId && createPage) {
    await run.step('create-page', async ({ logger }) => {
      await shopifyClient.init(config.shop);
      const title = `Cloned Page ${new Date().toISOString()}`;
      const res = await shopifyClient.post('/pages.json', { page: { title, body_html: '' } });
      pageId = res?.page?.id ? String(res.page.id) : null;
      if (!pageId) throw new Error('create-page failed to return page.id');
      logger.success('created page', { pageId });
    });
  }

  // 3) Theme caps + capsule
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

  // 4) Create V7 plan from capture pack (requires OpenRouter)
  await run.step('plan.v7', async ({ logger, setModelUsed }) => {
    // Record models used by the planning pipeline.
    setModelUsed?.(ROLES.VISION_PRO, resolveModelForRole(ROLES.VISION_PRO));
    setModelUsed?.(ROLES.ARCHITECT, resolveModelForRole(ROLES.ARCHITECT));
    setModelUsed?.(ROLES.BUILDER, resolveModelForRole(ROLES.BUILDER));

    const { planFromCapturePack } = require('./plan-from-capture-pack');
    const res = await planFromCapturePack({
      capturePackPath,
      passportV5Path,
      outPlanPath: v7PlanPath,
      logger,
      runId: run.runId,
    });

    const n = Array.isArray(res?.plan?.sections) ? res.plan.sections.length : null;
    logger.success('v7 plan written', { path: res.outPlanPath, sections: n });

    run.setOutput?.('v7PlanPath', res.outPlanPath);
    await fs.copy(res.outPlanPath, path.join(run.artifactsDir, 'dawn_layout_plan.v7.json'), { overwrite: true });

    if (!n || n <= 0) {
      throw new Error('plan.v7 produced 0 sections (nothing to build). See run artifacts for capture_pack + plan.');
    }
  });

  // 5) Build + apply template (reuses existing template-builder)
  await run.step('template-builder', async ({ logger }) => {
    const { templateBuilder } = require('../template-builder');
    const argv = [
      'node',
      'tools/template-builder.js',
      '--mode',
      mode,
      '--suffix',
      suffix,
      '--planPath',
      v7PlanPath,
      '--passportPath',
      passportV5Path,
    ];
    if (themeId && Number.isFinite(themeId)) argv.push('--themeId', String(themeId));
    if (mode === 'product') argv.push('--productId', String(productId));
    else argv.push('--pageId', String(pageId));
    await templateBuilder({ argv });
    logger.success('template applied', { suffix, mode });
  });

  // 6) Visual QA + repair loop (optional)
  let qaResult = null;
  if (!skipQa) {
    await run.step('qa.setup', async ({ logger }) => {
      logger.info('qa enabled', { qaIterations });
    });

    // Determine result URL + template key for patching
    const shopDomain = String(config.shop || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const storeUrl = shopDomain ? `https://${shopDomain}` : null;
    const templateKey = mode === 'page'
      ? `templates/page.${suffix}.json`
      : `templates/product.${suffix}.json`;

    await shopifyClient.init(config.shop);
    let handle = null;
    if (mode === 'product') {
      const pd = await shopifyClient.get(`/products/${productId}.json`);
      handle = pd?.product?.handle || null;
    } else {
      const pg = await shopifyClient.get(`/pages/${pageId}.json`);
      handle = pg?.page?.handle || null;
    }

    const resultUrl = storeUrl && handle
      ? (mode === 'page' ? `${storeUrl}/pages/${handle}` : `${storeUrl}/products/${handle}`)
      : null;

    const donorPng = `${WORKSPACE_DIR}\\screenshots\\latest\\donor_full_v6.png`;

    if (resultUrl) {
      const { qaRepairInRun } = require('./qa-repair');
      qaResult = await qaRepairInRun({
        run,
        donorUrl: null,
        donorPng,
        resultUrl,
        resultPng: null,
        storefrontPassword,
        applyTemplateKey: templateKey,
        sectionType: 'ai-super-canvas',
        maxIterations: Number.isFinite(qaIterations) ? qaIterations : 2,
      });
    } else {
      run.logger.warn('QA skipped (missing resultUrl)', { storeUrl, handle, mode });
    }
  }

  await run.finalize({ ok: true, qa: qaResult || null });
}

async function main() {
  const args = parseArgs(process.argv);
  const cmd = args._[0];

  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(usage());
    return;
  }

  if (cmd === 'unlock-theme') return await cmdUnlockTheme(args);
  if (cmd === 'capsule') return await cmdCapsule(args);
  if (cmd === 'qa') return await cmdQa(args);
  if (cmd === 'clone') return await cmdClone(args);
  if (cmd === 'openrouter-smoke') return await cmdOpenRouterSmoke(args);

  console.error(`Unknown command: ${cmd}\n\n${usage()}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('❌ V7 orchestrator failed:', err?.message || err);
  process.exit(1);
});

