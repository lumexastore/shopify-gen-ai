require('dotenv').config();

const fs = require('fs-extra');
const path = require('path');

const { initRun } = require('../utils/run-context');
const { createOpenRouterClient } = require('../utils/ai-client');
const { ROLES, resolveModelForRole, resolveParamsForRole } = require('./ai-config');
const { screenshotPage } = require('./screenshot-page');

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

async function fetchThemeAsset(themeId, key) {
  const res = await shopifyClient.get(`/themes/${themeId}/assets.json`, { 'asset[key]': key });
  return res?.asset?.value || null;
}

async function putThemeAsset(themeId, key, value) {
  return await shopifyClient.put(`/themes/${themeId}/assets.json`, { asset: { key, value } });
}

async function resolveMainThemeId() {
  await shopifyClient.init(config.shop);
  const themes = await shopifyClient.get('/themes.json');
  const mainTheme = themes?.themes?.find((t) => t.role === 'main') || null;
  if (!mainTheme?.id) throw new Error('Main theme not found');
  return { themeId: mainTheme.id, themeName: mainTheme.name || null };
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch (_) {
    return null;
  }
}

async function applyCssPatchToTemplate({
  themeId,
  templateKey,
  sectionType = 'ai-super-canvas',
  cssPatch,
  logger,
} = {}) {
  if (!themeId) throw new Error('applyCssPatchToTemplate: themeId is required');
  if (!templateKey) throw new Error('applyCssPatchToTemplate: templateKey is required');
  if (!cssPatch || !String(cssPatch).trim()) return { ok: false, reason: 'empty_css_patch' };

  const templateStr = await fetchThemeAsset(themeId, templateKey);
  const json = safeJsonParse(templateStr);
  if (!json) throw new Error(`Template is not valid JSON: ${templateKey}`);

  const sections = json.sections || {};
  const keys = Object.keys(sections);
  const matches = keys.filter((k) => sections[k]?.type === sectionType);

  if (matches.length === 0) {
    return { ok: false, reason: `no_sections_of_type:${sectionType}` };
  }

  for (const k of matches) {
    const sec = sections[k];
    sec.settings = sec.settings || {};
    const prev = sec.settings.custom_css || '';
    sec.settings.custom_css = `${prev}\n\n/* QA PATCH */\n${cssPatch}\n`;
    logger?.info?.('patched section css', { sectionKey: k });
  }

  await putThemeAsset(themeId, templateKey, JSON.stringify(json, null, 2));
  return { ok: true, patchedSections: matches.length };
}

async function visualQaOnce({
  ai,
  criticModel,
  donorPngPath,
  resultPngPath,
  logger,
} = {}) {
  const donorDataUrl = await ai.fileToDataUrl(donorPngPath, 'image/png');
  const resultDataUrl = await ai.fileToDataUrl(resultPngPath, 'image/png');

  const prompt = {
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          'Compare Image A (Donor) vs Image B (Result). ' +
          'Important: ignore the global header/footer and any differences in the standard Shopify product gallery/add-to-cart area. ' +
          'Focus on the long landing sections below (features, comparisons, FAQ, trust badges, grids). ' +
          'Return ONLY valid JSON with keys: ' +
          '{ "overall": "pass|partial|fail", "topDiscrepancies": [{"issue": "...", "severity": 1-10, "hint": "..."}], "cssPatch": "..." }. ' +
          'If pass, cssPatch should be empty string.',
      },
      { type: 'image_url', image_url: { url: donorDataUrl } },
      { type: 'image_url', image_url: { url: resultDataUrl } },
    ],
  };

  const { temperature, max_tokens } = resolveParamsForRole(ROLES.CRITIC);
  const resp = await ai.chatJson({
    model: criticModel,
    messages: [{ role: 'system', content: 'You are a strict visual QA critic for UI cloning.' }, prompt],
    temperature,
    max_tokens,
    enforceJson: true,
  });

  if (!resp.json) {
    logger?.warn?.('critic returned non-json', { textPreview: String(resp.text || '').slice(0, 300) });
  }
  return resp;
}

async function qaRepairInRun({
  run,
  donorUrl = null,
  resultUrl = null,
  donorPng = null,
  resultPng = null,
  storefrontPassword = null,
  applyTemplateKey = null,
  sectionType = 'ai-super-canvas',
  maxIterations = 2,
} = {}) {
  if (!run) throw new Error('qaRepairInRun: run is required');

  const qaReportPath = path.join(run.runDir, 'qa_report.json');

  // Capture donor/result screenshots if URLs provided
  const donorPath = donorPng || (donorUrl ? path.join(run.artifactsDir, 'donor.png') : null);
  const resultBasePath = resultPng || (resultUrl ? path.join(run.artifactsDir, 'result.png') : null);

  if (donorUrl && donorPath && !donorPng) {
    await run.step('qa.capture.donor', async ({ logger }) => {
      await screenshotPage({ url: donorUrl, outPath: donorPath });
      logger.success('captured donor', { path: donorPath });
    });
  }
  if (resultUrl && resultBasePath && !resultPng) {
    await run.step('qa.capture.result', async ({ logger }) => {
      await screenshotPage({ url: resultUrl, outPath: resultBasePath, storefrontPassword });
      logger.success('captured result', { path: resultBasePath });
    });
  }

  if (!donorPath || !resultBasePath) {
    const msg = 'Provide donor/result via URL or PNG paths';
    await fs.writeJson(qaReportPath, { ok: false, error: msg }, { spaces: 2 });
    run.logger.warn('qa skipped', { error: msg });
    return { ok: false, reportPath: qaReportPath, error: msg };
  }

  let ai = null;
  try {
    ai = createOpenRouterClient();
  } catch (e) {
    const msg = e?.message || String(e);
    await fs.writeJson(qaReportPath, { ok: false, error: msg }, { spaces: 2 });
    run.logger.warn('OpenRouter not configured; skipping critic', { error: msg });
    return { ok: false, reportPath: qaReportPath, error: msg };
  }

  const criticModel = resolveModelForRole(ROLES.CRITIC);
  run.setModelUsed?.(ROLES.CRITIC, criticModel);

  const { themeId } = await resolveMainThemeId().catch(() => ({ themeId: null }));

  let last = null;
  let lastReport = null;

  for (let i = 1; i <= maxIterations; i++) {
    const iterResultPath = i === 1 ? resultBasePath : path.join(run.artifactsDir, `result_iter_${i}.png`);

    if (i > 1 && resultUrl) {
      await run.step(`qa.capture.result_iter_${i}`, async ({ logger }) => {
        await screenshotPage({ url: resultUrl, outPath: iterResultPath, storefrontPassword });
        logger.success('captured result', { path: iterResultPath });
      });
    }

    last = await run.step(`qa.critic.iter_${i}`, async ({ logger }) => {
      const resp = await visualQaOnce({
        ai,
        criticModel,
        donorPngPath: donorPath,
        resultPngPath: iterResultPath,
        logger,
      });
      return resp;
    });

    const qaJson = last.json || null;
    lastReport = qaJson;

    await fs.writeJson(
      qaReportPath,
      { ok: !!qaJson, iteration: i, criticModel, report: qaJson, rawText: last.text },
      { spaces: 2 }
    );

    const overall = qaJson?.overall;
    const cssPatch = String(qaJson?.cssPatch || '').trim();

    if (overall === 'pass' || !cssPatch) break;

    if (applyTemplateKey && themeId) {
      const patchRes = await run.step(`qa.apply_patch.iter_${i}`, async ({ logger }) => {
        const r = await applyCssPatchToTemplate({
          themeId,
          templateKey: applyTemplateKey,
          sectionType,
          cssPatch,
          logger,
        });
        logger.info('applyPatch.result', r);
        return r;
      });

      if (!patchRes?.ok) {
        // Not fatal: template might have no joker sections; stop iterating.
        run.logger.warn('patch not applied; stopping QA loop', { reason: patchRes?.reason || 'unknown' });
        break;
      }
      // continue loop
    } else {
      // no place to apply patch, stop after report
      break;
    }
  }

  return { ok: true, reportPath: qaReportPath, report: lastReport };
}

async function qaRepair({
  donorUrl = null,
  resultUrl = null,
  donorPng = null,
  resultPng = null,
  storefrontPassword = null,
  applyTemplateKey = null,
  sectionType = 'ai-super-canvas',
  maxIterations = 2,
} = {}) {
  const run = await initRun({
    mode: 'qa_repair',
    url: donorUrl || null,
    targetId: resultUrl || null,
    suffix: null,
    keepDays: 7,
    purgeTrash: false,
    echoToConsole: true,
  });

  const res = await qaRepairInRun({
    run,
    donorUrl,
    resultUrl,
    donorPng,
    resultPng,
    storefrontPassword,
    applyTemplateKey,
    sectionType,
    maxIterations,
  });

  await run.finalize({ ok: !!res.ok, qa: { reportPath: res.reportPath } });
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  qaRepair({
    donorUrl: args.donorUrl || null,
    resultUrl: args.resultUrl || null,
    donorPng: args.donorPng || null,
    resultPng: args.resultPng || null,
    storefrontPassword: args.storefrontPassword || args.password || null,
    applyTemplateKey: args.applyTemplateKey || null,
    sectionType: args.sectionType || 'ai-super-canvas',
    maxIterations: args.maxIterations ? Number(args.maxIterations) : 2,
  }).catch((err) => {
    console.error('❌ qa-repair failed:', err?.message || err);
    process.exit(1);
  });
}

module.exports = { qaRepair, qaRepairInRun };

