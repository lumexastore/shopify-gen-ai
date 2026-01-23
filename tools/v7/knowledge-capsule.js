const fs = require('fs-extra');
const path = require('path');

const { SECTION_TYPES, ASSET_ROLES } = require('../../src/schema/donorPassportV5');

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch (_) {
    return false;
  }
}

/**
 * Produce a minimal, structured knowledge capsule for LLM grounding.
 * This is NOT a generic RAG; it is a deterministic, per-run snapshot.
 */
async function generateKnowledgeCapsule({
  runDir,
  logger,
  runMeta = {},
  themeCapabilities = null,
  workspaceDir,
} = {}) {
  if (!runDir) throw new Error('generateKnowledgeCapsule: runDir is required');
  if (!workspaceDir) throw new Error('generateKnowledgeCapsule: workspaceDir is required');

  const outPath = path.join(runDir, 'knowledge_capsule.json');

  const capturePackPath = path.join(workspaceDir, 'capture_pack.v6.json');
  const passportV5Path = path.join(workspaceDir, 'donor_passport.v5.json');
  const donorFullV6Path = path.join(workspaceDir, 'screenshots', 'latest', 'donor_full_v6.png');
  const donorFullV5Path = path.join(workspaceDir, 'screenshots', 'latest', 'donor_full_v5.png');

  const capsule = {
    generatedAt: new Date().toISOString(),
    run: {
      mode: runMeta.mode || null,
      url: runMeta.url || null,
      targetId: runMeta.targetId || null,
      suffix: runMeta.suffix || null,
      runId: runMeta.runId || null,
    },

    inputs: {
      capturePackV6: { path: capturePackPath, exists: exists(capturePackPath) },
      passportV5: { path: passportV5Path, exists: exists(passportV5Path) },
      donorScreenshotV6: { path: donorFullV6Path, exists: exists(donorFullV6Path) },
      donorScreenshotV5: { path: donorFullV5Path, exists: exists(donorFullV5Path) },
    },

    constraints: {
      shopify: {
        // Conservative guardrails; validated further against section schema.
        maxSectionsPerTemplate: 25,
        maxBlocksPerSection: 50,
      },
      policies: {
        noPlaceholders: true,
        nullOverGuess: true,
        schemaAwareOnly: true,
        noMixedAssets: true,
      },
    },

    enums: {
      sectionTypesV5: SECTION_TYPES,
      assetRolesV5: ASSET_ROLES,
      // V6 labels (from your prompt chain)
      sectionLabelsV6: [
        'hero',
        'features_grid',
        'image_text_split',
        'gallery',
        'testimonials',
        'faq',
        'comparison',
        'steps',
        'cta',
        'unknown',
      ],
    },

    mappings: {
      donorToDawnDefaults: {
        [SECTION_TYPES.HERO_BANNER]: 'image-banner',
        [SECTION_TYPES.FEATURES_GRID]: 'multicolumn',
        [SECTION_TYPES.RICH_TEXT]: 'rich-text',
        [SECTION_TYPES.FAQ]: 'collapsible-content',
        [SECTION_TYPES.SLIDESHOW]: 'slideshow',
        [SECTION_TYPES.GALLERY]: 'slideshow',
      },
      jokerSections: {
        aiSuperCanvas: 'ai-super-canvas',
        smartGrid: 'smart-grid',
        note: 'Joker sections accept custom HTML+CSS; do not assume Tailwind runtime in Shopify.',
      },
    },

    themeCapabilities: themeCapabilities || null,

    outputContracts: {
      // NOTE: Actual JSON schemas will be added in validators task.
      mustReturnOnlyJson: true,
      mustIncludeOkOrNeedsRerun: true,
      mustProvideEvidenceForKeyFindings: true,
    },
  };

  await fs.writeJson(outPath, capsule, { spaces: 2 });
  logger?.success?.('knowledge_capsule.json written', { path: outPath });
  return { outPath, data: capsule };
}

module.exports = { generateKnowledgeCapsule };

