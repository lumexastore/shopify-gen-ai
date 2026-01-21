const fs = require('fs-extra');
const path = require('path');

const {
  SECTION_TYPES,
  ASSET_ROLES,
} = require('../src/schema/donorPassportV5');

const WORKSPACE_DIR = path.resolve(__dirname, '../workspace');
const PASSPORT_V5_PATH = path.join(WORKSPACE_DIR, 'donor_passport.v5.json');
const OUTPUT_PLAN_PATH = path.join(WORKSPACE_DIR, 'dawn_layout_plan.json');

// Dawn section types we target (must exist in theme)
const DONOR_TO_DAWN = Object.freeze({
  [SECTION_TYPES.HERO_BANNER]: 'image-banner',
  [SECTION_TYPES.FEATURES_GRID]: 'multicolumn',
  [SECTION_TYPES.RICH_TEXT]: 'rich-text',
  [SECTION_TYPES.FAQ]: 'collapsible-content',
  [SECTION_TYPES.SLIDESHOW]: 'slideshow',
  [SECTION_TYPES.GALLERY]: 'slideshow',
  [SECTION_TYPES.REVIEWS]: 'rich-text', // fallback (native-only requirement)
  [SECTION_TYPES.UNKNOWN]: 'rich-text', // fallback
});

function safeString(x) {
  if (!x) return '';
  return String(x).trim();
}

function buildIntentForSection(section, passport) {
  const type = section.type;

  // Collect assets for this section by role
  const assetRefs = (section.assets || []).map((a) => ({
    assetId: a.assetId,
    role: a.role,
  }));

  if (type === SECTION_TYPES.HERO_BANNER) {
    const heroBg = assetRefs.find((a) => a.role === ASSET_ROLES.HERO_BG) || null;
    return {
      kind: 'hero',
      heading: safeString(section.content?.heading) || safeString(passport.pageInfo?.title),
      text: safeString(section.content?.text),
      cta: null,
      heroBgAssetId: heroBg?.assetId || null,
    };
  }

  if (type === SECTION_TYPES.FEATURES_GRID) {
    // V5 inspector currently does not extract per-item titles/texts reliably.
    // For now: use a placeholder title + only icons in order they appear.
    const icons = assetRefs.filter((a) => a.role === ASSET_ROLES.ICON).slice(0, 6);
    return {
      kind: 'features',
      title: safeString(section.content?.heading) || '',
      columns: Math.min(4, Math.max(3, icons.length || 3)),
      items: icons.map((i, idx) => ({
        iconAssetId: i.assetId,
        title: '',
        text: '',
        order: idx + 1,
      })),
    };
  }

  if (type === SECTION_TYPES.FAQ) {
    return {
      kind: 'faq',
      title: safeString(section.content?.heading) || 'FAQ',
      items: [], // will be enriched by agent later; builder supports empty
    };
  }

  if (type === SECTION_TYPES.SLIDESHOW || type === SECTION_TYPES.GALLERY) {
    const slides = assetRefs
      .filter((a) => a.role === ASSET_ROLES.GALLERY || a.role === ASSET_ROLES.ILLUSTRATION)
      .slice(0, 8);
    return {
      kind: 'slideshow',
      title: safeString(section.content?.heading) || '',
      slides: slides.map((s, idx) => ({
        imageAssetId: s.assetId,
        heading: '',
        text: '',
        order: idx + 1,
      })),
    };
  }

  if (type === SECTION_TYPES.REVIEWS) {
    return {
      kind: 'rich_text',
      heading: safeString(section.content?.heading) || 'Reviews',
      html: `<p>${safeString(section.textSample || section.content?.text || '').slice(0, 260)}</p>`,
    };
  }

  // default rich-text: best-effort using pageInfo description for first rich-text-like block
  if (type === SECTION_TYPES.RICH_TEXT || type === SECTION_TYPES.UNKNOWN) {
    const html = passport.pageInfo?.descriptionHtml || '';
    return {
      kind: 'rich_text',
      heading: safeString(section.content?.heading) || '',
      html: html || `<p>${safeString(section.content?.text || '').slice(0, 400)}</p>`,
    };
  }

  return { kind: 'unknown' };
}

function mapSectionsToPlan(passport) {
  const children = passport.sectionTree?.children || [];

  const mapped = [];
  for (const sec of children) {
    const include = sec.policy?.includeInClone !== false;
    if (!include) continue;

    const dawnType = DONOR_TO_DAWN[sec.type] || 'rich-text';

    mapped.push({
      sourceSectionId: sec.id,
      sourceType: sec.type,
      confidence: sec.confidence,
      dawnType,
      intent: buildIntentForSection(sec, passport),
      assets: (sec.assets || []).map((a) => ({ assetId: a.assetId, role: a.role })),
    });
  }

  return mapped;
}

async function structureMapper() {
  if (!fs.existsSync(PASSPORT_V5_PATH)) {
    console.error(`❌ Missing passport: ${PASSPORT_V5_PATH}`);
    process.exit(1);
  }
  const passport = await fs.readJson(PASSPORT_V5_PATH);

  const sections = mapSectionsToPlan(passport);

  const plan = {
    planVersion: '1.0',
    generatedAt: new Date().toISOString(),
    source: {
      url: passport.url,
      passportVersion: passport.passportVersion,
    },
    designTokens: passport.designTokens || null,
    pageInfo: passport.pageInfo || null,
    sections,
    diagnostics: {
      includedSections: sections.length,
      notes: [
        'This is an intent-level plan. template-builder will adapt intents to the actual Dawn schemas in the current main theme.',
      ],
    },
  };

  await fs.writeJson(OUTPUT_PLAN_PATH, plan, { spaces: 2 });
  console.log(`✅ Dawn layout plan saved: ${OUTPUT_PLAN_PATH}`);
}

if (require.main === module) {
  structureMapper();
}

module.exports = { structureMapper };

