require('dotenv').config();

const fs = require('fs-extra');
const path = require('path');

const shopifyClient = require('../../src/services/shopifyClient');
const config = require('../../src/config');
const { initRun } = require('../utils/run-context');

async function resolveMainThemeId() {
  await shopifyClient.init(config.shop);
  const themes = await shopifyClient.get('/themes.json');
  const mainTheme = themes?.themes?.find((t) => t.role === 'main') || null;
  if (!mainTheme?.id) throw new Error('Main theme not found');
  return { themeId: mainTheme.id, themeName: mainTheme.name || null };
}

async function putThemeAsset(themeId, key, value) {
  return await shopifyClient.put(`/themes/${themeId}/assets.json`, {
    asset: { key, value },
  });
}

async function themeUnlock({ themeId = null } = {}) {
  const run = await initRun({
    mode: 'theme_unlock',
    url: null,
    targetId: themeId ? String(themeId) : null,
    suffix: null,
    keepDays: 7,
    purgeTrash: false,
    echoToConsole: true,
  });

  await run.step('theme.unlock', async ({ logger, setOutput }) => {
    const resolved = themeId ? { themeId, themeName: null } : await resolveMainThemeId();
    const tId = resolved.themeId;
    logger.info('using theme', { themeId: tId, themeName: resolved.themeName });

    const baseDir = path.resolve(__dirname, 'theme', 'sections');
    const files = [
      { src: path.join(baseDir, 'ai-super-canvas.liquid'), key: 'sections/ai-super-canvas.liquid' },
      { src: path.join(baseDir, 'smart-grid.liquid'), key: 'sections/smart-grid.liquid' },
    ];

    for (const f of files) {
      const liquid = await fs.readFile(f.src, 'utf8');
      await putThemeAsset(tId, f.key, liquid);
      logger.success('uploaded asset', { key: f.key, source: f.src });
    }

    setOutput('themeId', tId);
    setOutput('uploadedSections', files.map((x) => x.key));
  });

  await run.finalize({ ok: true });
}

if (require.main === module) {
  const argThemeId = process.argv.includes('--themeId')
    ? Number(process.argv[process.argv.indexOf('--themeId') + 1])
    : null;

  themeUnlock({ themeId: Number.isFinite(argThemeId) ? argThemeId : null }).catch((err) => {
    console.error('❌ theme-unlock failed:', err?.message || err);
    process.exit(1);
  });
}

module.exports = { themeUnlock };

