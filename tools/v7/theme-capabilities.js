const fs = require('fs-extra');
const path = require('path');

const shopifyClient = require('../../src/services/shopifyClient');
const config = require('../../src/config');

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch (_) {
    return null;
  }
}

function extractSchemaFromLiquid(liquid) {
  if (!liquid) return null;
  const m = liquid.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/i);
  if (!m) return null;
  const json = (m[1] || '').trim();
  return safeJsonParse(json);
}

function slimSchema(schema) {
  if (!schema) return null;
  const settings = Array.isArray(schema.settings)
    ? schema.settings.map((s) => ({ id: s.id, type: s.type, label: s.label || null }))
    : [];
  const blocks = Array.isArray(schema.blocks)
    ? schema.blocks.map((b) => ({
        type: b.type,
        name: b.name || null,
        settings: Array.isArray(b.settings)
          ? b.settings.map((s) => ({ id: s.id, type: s.type, label: s.label || null }))
          : [],
      }))
    : [];
  return {
    name: schema.name || null,
    tag: schema.tag || null,
    class: schema.class || null,
    settings,
    blocks,
    max_blocks: Number.isFinite(schema.max_blocks) ? schema.max_blocks : null,
    presets: Array.isArray(schema.presets) ? schema.presets.map((p) => ({ name: p.name || null })) : [],
  };
}

async function fetchThemeAsset(themeId, key) {
  const res = await shopifyClient.get(`/themes/${themeId}/assets.json`, { 'asset[key]': key });
  return res?.asset?.value || null;
}

async function resolveMainThemeId() {
  await shopifyClient.init(config.shop);
  const themes = await shopifyClient.get('/themes.json');
  const mainTheme = themes?.themes?.find((t) => t.role === 'main') || null;
  if (!mainTheme?.id) throw new Error('Main theme not found');
  return { themeId: mainTheme.id, themeName: mainTheme.name || null };
}

/**
 * Generate a minimal but strict ThemeCapabilities snapshot for the current main theme.
 *
 * Output is designed for LLM consumption (no giant liquid blobs).
 */
async function generateThemeCapabilities({
  runDir,
  logger,
  sectionTypes = ['image-banner', 'multicolumn', 'rich-text', 'slideshow', 'collapsible-content', 'ai-super-canvas', 'smart-grid'],
} = {}) {
  if (!runDir) throw new Error('generateThemeCapabilities: runDir is required');

  const outPath = path.join(runDir, 'theme_capabilities.json');
  const result = {
    generatedAt: new Date().toISOString(),
    ok: true,
    shop: config.shop || null,
    theme: { id: null, name: null },
    sections: {},
    errors: [],
    notes: [
      'This is a slim snapshot of section schemas for validation and LLM grounding.',
      'If a section is missing, it will be listed with ok=false and an error message.',
    ],
  };

  try {
    const { themeId, themeName } = await resolveMainThemeId();
    result.theme.id = themeId;
    result.theme.name = themeName;

    for (const type of sectionTypes) {
      const key = `sections/${type}.liquid`;
      try {
        logger?.info?.('fetching section schema', { type, key });
        const liquid = await fetchThemeAsset(themeId, key);
        const schema = extractSchemaFromLiquid(liquid);
        const slim = slimSchema(schema);
        result.sections[type] = {
          ok: !!slim,
          key,
          schema: slim,
          error: slim ? null : 'schema_not_found_or_unparseable',
        };
      } catch (e) {
        const msg = e?.message || String(e);
        result.sections[type] = { ok: false, key, schema: null, error: msg };
        result.errors.push({ sectionType: type, message: msg });
      }
    }
  } catch (e) {
    const msg = e?.message || String(e);
    result.ok = false;
    result.errors.push({ stage: 'resolveMainThemeId', message: msg });
    logger?.error?.('theme capabilities failed', { message: msg });
  }

  await fs.writeJson(outPath, result, { spaces: 2 });
  logger?.success?.('theme_capabilities.json written', { path: outPath, ok: result.ok });
  return { outPath, data: result };
}

module.exports = { generateThemeCapabilities };

