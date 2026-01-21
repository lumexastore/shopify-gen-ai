/**
 * Donor Passport V5.0 schema contract.
 *
 * Goal: a stable, shared vocabulary between:
 * - Eyes: DOM + CV inspector (tools/deep-inspector.js)
 * - Brain: structure mapper (tools/structure-mapper.js)
 * - Hands: Dawn template builder (tools/template-builder.js)
 *
 * This file intentionally contains:
 * - enums (section types, asset roles)
 * - small helpers (id/normalization)
 * - light validation (guardrails for agent + tools)
 */

const crypto = require('crypto');

const PASSPORT_VERSION = '5.0';

// --- Section types we can map to Dawn (or keep as unknown) ---
const SECTION_TYPES = Object.freeze({
  PAGE: 'page',
  HEADER: 'header',
  FOOTER: 'footer',
  HERO_BANNER: 'hero_banner',
  FEATURES_GRID: 'features_grid',
  GALLERY: 'gallery',
  SLIDESHOW: 'slideshow',
  REVIEWS: 'reviews',
  FAQ: 'faq',
  RICH_TEXT: 'rich_text',
  UNKNOWN: 'unknown',
});

// --- Asset roles: critical to avoid mixing logo/icons/gallery etc. ---
const ASSET_ROLES = Object.freeze({
  HERO_BG: 'hero_bg',
  ICON: 'icon',
  GALLERY: 'gallery',
  LOGO: 'logo',
  BACKGROUND: 'background',
  ILLUSTRATION: 'illustration',
});

const ASSET_KINDS = Object.freeze({
  IMAGE: 'image', // raster images (png/jpg/webp/gif)
  SVG: 'svg', // inline or external svg
  VIDEO: 'video',
});

const POLICY = Object.freeze({
  INCLUDE: true,
  EXCLUDE: false,
});

function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  // Remove typical tracking + resizing query params while keeping origin/path.
  // This intentionally keeps the "base" URL for dedupe; original URL is stored separately.
  try {
    const u = new URL(trimmed, 'http://example.local');
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      u.hash = '';
      u.search = '';
      return u.toString();
    }
  } catch (_) {
    // If URL constructor fails (relative paths, data: URLs), fallback to naive.
  }
  return trimmed.split('#')[0].split('?')[0];
}

function sha1(input) {
  return crypto.createHash('sha1').update(String(input)).digest('hex');
}

function stableAssetId(kind, key) {
  // Example: a_image_3f2a1c...
  return `a_${kind}_${sha1(key).slice(0, 16)}`;
}

function stableSectionId(key) {
  return `s_${sha1(key).slice(0, 12)}`;
}

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function validatePassportV5(passport) {
  const errors = [];
  if (!isObject(passport)) return { ok: false, errors: ['passport is not an object'] };
  if (passport.passportVersion !== PASSPORT_VERSION) {
    errors.push(`passportVersion must be "${PASSPORT_VERSION}"`);
  }
  if (!passport.url) errors.push('url is required');
  if (!passport.sectionTree || !isObject(passport.sectionTree)) errors.push('sectionTree is required');
  if (!passport.assets || !isObject(passport.assets)) errors.push('assets is required');
  if (!passport.assets.items || !isObject(passport.assets.items)) errors.push('assets.items is required');
  if (!Array.isArray(passport.assets.usages)) errors.push('assets.usages must be an array');
  return { ok: errors.length === 0, errors };
}

module.exports = {
  PASSPORT_VERSION,
  SECTION_TYPES,
  ASSET_ROLES,
  ASSET_KINDS,
  POLICY,
  normalizeUrl,
  stableAssetId,
  stableSectionId,
  validatePassportV5,
};

