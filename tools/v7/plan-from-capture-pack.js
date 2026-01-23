require('dotenv').config();

const fs = require('fs-extra');
const path = require('path');

const { createOpenRouterClient } = require('../utils/ai-client');
const { ROLES, resolveModelForRole, resolveParamsForRole } = require('./ai-config');
const { normalizeUrl } = require('../../src/schema/donorPassportV5');
const { sliceImageIfLarge } = require('../utils/image-utils');

function safeJsonParse(x) {
  try {
    return JSON.parse(x);
  } catch (_) {
    return null;
  }
}

function buildAssetIndex(passport) {
  const byNorm = new Map();
  const bySource = new Map();
  const items = passport?.assets?.items || {};
  for (const [assetId, item] of Object.entries(items)) {
    if (item?.normalizedUrl) byNorm.set(item.normalizedUrl, assetId);
    if (item?.sourceUrl) bySource.set(item.sourceUrl, assetId);
  }
  return {
    resolveAssetId: (url) => {
      if (!url) return null;
      const n = normalizeUrl(url);
      if (n && byNorm.has(n)) return byNorm.get(n);
      if (bySource.has(url)) return bySource.get(url);
      if (n && bySource.has(n)) return bySource.get(n);
      return null;
    },
  };
}

function pickTopNodes(nodes, limit = 140) {
  if (!Array.isArray(nodes)) return [];
  return nodes.slice(0, limit).map((n) => ({
    tag: n.tag,
    text: n.text ? String(n.text).slice(0, 180) : null,
    href: n.href || null,
    src: n.src || null,
    bgUrl: n.bgUrl || null,
    bbox: n.bbox ? { x: n.bbox.x, y: n.bbox.y, w: n.bbox.w, h: n.bbox.h } : null,
  }));
}

function extractCandidateImageUrls(nodes) {
  const urls = [];
  for (const n of nodes || []) {
    if (n?.src) urls.push(n.src);
    if (n?.bgUrl) urls.push(n.bgUrl);
  }
  // unique, preserve order
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    const k = String(u);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out.slice(0, 18);
}

function shouldSkipCaptureSection(sec) {
  if (!sec) return true;
  const tag = String(sec.tag || '').toLowerCase();
  const dom = String(sec.domPath || '');

  const text = String(sec.textSample || '')
    .toLowerCase()
    // normalize weird whitespace (NBSP etc) so substring checks are reliable
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();

  // Global chrome: handled by the theme (header/footer groups)
  if (tag === 'header' || tag === 'footer') return { skip: true, reason: `tag:${tag}` };
  if (dom.includes('__header') || dom.includes('__footer')) return { skip: true, reason: 'dom:header_or_footer' };

  // Shopify product "main" section container is not safely reproducible as static HTML (needs dynamic product form)
  // On Shopify product pages, this is usually `...__main...` (not custom liquid).
  if (dom.includes('__main') && !dom.includes('__custom') && !dom.toLowerCase().includes('custom_liquid')) {
    return { skip: true, reason: 'dom:main_section' };
  }

  // Extra safeguard: some pages use unusual whitespace in text; keep this as a secondary signal.
  const looksLikeMainProduct =
    dom.includes('__main') &&
    (text.includes('add to cart') ||
      text.includes('bundle') ||
      text.includes('regular price') ||
      text.includes('sale price') ||
      text.includes('quantity') ||
      text.includes('pickup availability'));

  if (looksLikeMainProduct) return { skip: true, reason: 'dom:text:main_product_like' };

  return { skip: false, reason: null };
}

async function labelSection({ ai, model, cropPath, textSample, nodesPreview }) {
  const chunks = await sliceImageIfLarge(cropPath);
  const imgContents = [];
  for (const chunkPath of chunks) {
    const dataUrl = await ai.fileToDataUrl(chunkPath, 'image/png');
    imgContents.push({ type: 'image_url', image_url: { url: dataUrl } });
  }

  const msg = {
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          'Analyze this UI section screenshot (split into parts if large) and the provided DOM node hints. ' +
          'Return ONLY valid JSON: { "label": "hero|features_grid|image_text_split|gallery|testimonials|faq|comparison|steps|cta|unknown", "confidence": 0-1, "reasons": ["short"] }.',
      },
      { type: 'text', text: `textSample: ${textSample || ''}` },
      { type: 'text', text: `nodesPreview: ${JSON.stringify(nodesPreview).slice(0, 6000)}` },
      ...imgContents,
    ],
  };

  const { temperature, max_tokens } = resolveParamsForRole(ROLES.VISION_PRO);
  const resp = await ai.chatJson({
    model,
    messages: [{ role: 'system', content: 'You are a strict UI section classifier.' }, msg],
    temperature,
    max_tokens,
    enforceJson: true,
  });
  return resp.json;
}

async function planNativeIntent({ ai, model, cropPath, label, nodesPreview, candidateImageUrls }) {
  const chunks = await sliceImageIfLarge(cropPath);
  const imgContents = [];
  for (const chunkPath of chunks) {
    const dataUrl = await ai.fileToDataUrl(chunkPath, 'image/png');
    imgContents.push({ type: 'image_url', image_url: { url: dataUrl } });
  }

  const content = [
    {
      type: 'text',
      text:
        'You are a Shopify Dawn architect. Using the screenshot (split into parts if large) and node hints, produce ONLY JSON:\n' +
        '{\n' +
        '  "dawnType": "image-banner|multicolumn|collapsible-content|slideshow|rich-text|smart-grid|ai-super-canvas",\n' +
        '  "intent": { "kind": "...", ... },\n' +
        '  "confidence": 0-1,\n' +
        '  "usedImageUrls": ["..."],\n' +
        '  "notes": []\n' +
        '}\n' +
        'Schema Requirements for intent:\n' +
        '- collapsible-content (FAQ): { kind: "faq", title: "Heading", items: [{ q: "Question", a: "Answer" }] }\n' +
        '- columns/multicolumn: { kind: "features", title: "Heading", items: [{ title: "Title", text: "Description", iconAssetId: "..." }] }\n' +
        '- smart-grid: { kind: "smart_grid", heading: "Title", items: [{ title: "...", text: "...", imageAssetId: "..." }] }\n' +
        '- slideshow: { kind: "slideshow", slides: [{ heading: "...", text: "...", imageAssetId: "..." }] }\n' +
        'Rules:\n' +
        '- **CRITICAL**: The user demands High Fidelity. If the screenshot has complex layout, overlapping elements, specific background styling, or unique grids, YOU MUST USE `ai-super-canvas`.\n' +
        '- Do NOT use `multicolumn` or `smart-grid` unless the layout is extremely simple (just text + icon in a standard row).\n' +
        '- For `comparison` tables, `image_text_split` with badges, or feature grids with images -> USE `ai-super-canvas`.\n' +
        '- For testimonials with specific design -> USE `ai-super-canvas`.\n' +
        '- ONLY use `collapsible-content` for standard text FAQs.\n' +
        `Label: ${label}`,
    },
    { type: 'text', text: `candidateImageUrls: ${JSON.stringify(candidateImageUrls)}` },
    { type: 'text', text: `nodesPreview: ${JSON.stringify(nodesPreview).slice(0, 7000)}` },
    ...imgContents,
  ];

  const msg = { role: 'user', content };

  const { temperature, max_tokens } = resolveParamsForRole(ROLES.ARCHITECT);
  const resp = await ai.chatJson({
    model,
    messages: [{ role: 'system', content: 'Be strict. Output ONLY JSON.' }, msg],
    temperature,
    max_tokens,
    enforceJson: true,
  });
  return resp.json;
}

async function buildCustomHtml({ ai, model, cropPath, nodesPreview }) {
  const chunks = await sliceImageIfLarge(cropPath);
  const imgContents = [];
  for (const chunkPath of chunks) {
    const dataUrl = await ai.fileToDataUrl(chunkPath, 'image/png');
    imgContents.push({ type: 'image_url', image_url: { url: dataUrl } });
  }

  const msg = {
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          'You are a Liquid/HTML/CSS expert. Recreate this section visually.\n' +
          'Output ONLY valid, standard JSON: { "html": "...", "custom_css": "..." }.\n' +
          'Rules:\n' +
          '- STRICTLY use valid JSON with double quotes. Escape all newlines (\\n) and double quotes (\\").\n' +
          '- Do NOT use backticks (`) for strings anywhere in the response.\n' +
          '- Do NOT use Tailwind.\n' +
          '- Use responsive CSS.\n' +
          '- Use only inline-safe HTML (no script).\n' +
          '- If you reference images, use the URLs you can infer from node hints.\n',
      },
      { type: 'text', text: `nodesPreview: ${JSON.stringify(nodesPreview).slice(0, 7000)}` },
      ...imgContents,
    ],
  };

  const { temperature, max_tokens } = resolveParamsForRole(ROLES.BUILDER);
  const resp = await ai.chatJson({
    model,
    messages: [{ role: 'system', content: 'Output ONLY JSON.' }, msg],
    temperature,
    max_tokens,
    enforceJson: true,
  });
  return resp.json;
}

async function planFromCapturePack({
  capturePackPath,
  passportV5Path,
  outPlanPath,
  logger,
  runId,
} = {}) {
  if (!capturePackPath) throw new Error('capturePackPath is required');
  if (!passportV5Path) throw new Error('passportV5Path is required');
  if (!outPlanPath) throw new Error('outPlanPath is required');

  const pack = await fs.readJson(capturePackPath);
  const passport = await fs.readJson(passportV5Path);
  const { resolveAssetId } = buildAssetIndex(passport);

  const ai = createOpenRouterClient();
  const visionModel = resolveModelForRole(ROLES.VISION_PRO);
  const architectModel = resolveModelForRole(ROLES.ARCHITECT);
  const builderModel = resolveModelForRole(ROLES.BUILDER);

  const sectionsOut = [];

  for (const sec of pack.sections || []) {
    const gate = shouldSkipCaptureSection(sec);
    if (gate.skip) {
      logger?.info?.('skipping capture section', { sectionId: sec?.id, order: sec?.order, reason: gate.reason });
      continue;
    }

    const nodesPreview = pickTopNodes(sec.nodes || [], 140);
    const candidateImageUrls = extractCandidateImageUrls(nodesPreview);

    logger?.info?.('planning section', { sectionId: sec.id, order: sec.order });

    let labelJson;
    try {
      labelJson = await labelSection({
        ai,
        model: visionModel,
        cropPath: sec.cropPath,
        textSample: sec.textSample,
        nodesPreview,
      });
    } catch (e) {
      logger?.warn?.(`Vision label failed for ${sec.id} (likely image size), retrying text-only`, { error: e.message });
      // Fallback: minimal text-only label
      labelJson = { label: 'unknown', confidence: 0.1 };
    }
    const label = labelJson?.label || 'unknown';

    let mapped;
    try {
      mapped = await planNativeIntent({
        ai,
        model: architectModel,
        cropPath: sec.cropPath,
        label,
        nodesPreview,
        candidateImageUrls,
      });
    } catch (e) {
      logger?.warn?.(`Vision plan failed for ${sec.id}, retrying text-only`, { error: e.message });
      // Fallback: retry without image
      mapped = await planNativeIntent({
        ai,
        model: architectModel,
        cropPath: null, // signal to skip image
        label,
        nodesPreview,
        candidateImageUrls,
      });
    }

    let dawnType = mapped?.dawnType || 'ai-super-canvas';
    let intent = mapped?.intent || { kind: 'custom_html', html: null, custom_css: null };

    // Normalize to template-builder supported intents/types
    if (dawnType === 'smart-grid') {
      // ensure schema-friendly kind
      intent = { kind: 'smart_grid', ...intent };
      // Map image URLs to assetIds when possible
      if (Array.isArray(intent.items)) {
        intent.items = intent.items.map((it) => ({
          ...it,
          imageAssetId: it.imageAssetId || resolveAssetId(it.imageUrl) || null,
          iconAssetId: it.iconAssetId || resolveAssetId(it.iconUrl) || null,
        }));
      }
    }

    if (dawnType === 'image-banner' && intent?.heroBgUrl && !intent.heroBgAssetId) {
      intent.heroBgAssetId = resolveAssetId(intent.heroBgUrl);
    }

    if (dawnType === 'ai-super-canvas') {
      let built;
      try {
        built = await buildCustomHtml({
          ai,
          model: builderModel,
          cropPath: sec.cropPath,
          nodesPreview,
        });
      } catch (e) {
        logger?.warn?.(`Vision build failed for ${sec.id}, retrying text-only`, { error: e.message });
        built = await buildCustomHtml({
          ai,
          model: builderModel,
          cropPath: null,
          nodesPreview,
        });
      }
      intent = { kind: 'custom_html', html: built?.html || '', custom_css: built?.custom_css || '' };
    }

    // Fill common cases missing asset IDs from node URLs
    if (dawnType === 'image-banner' && intent?.heroBgAssetId == null) {
      // fallback: pick first candidate image
      const candidate = candidateImageUrls[0] || null;
      if (candidate) intent.heroBgAssetId = resolveAssetId(candidate);
    }

    sectionsOut.push({
      sourceSectionId: sec.id,
      order: sec.order,
      label,
      confidence: mapped?.confidence || labelJson?.confidence || 0.5,
      dawnType,
      intent,
      assets: [],
    });
  }

  const plan = {
    planVersion: 'v7.0',
    generatedAt: new Date().toISOString(),
    runId: runId || null,
    source: { url: pack.url || pack?.doc?.url || null },
    sections: sectionsOut,
    diagnostics: {
      notes: [
        'This plan was generated from V6 capture_pack and OpenRouter models.',
        'It is compatible with tools/template-builder.js (schema-aware compile).',
      ],
    },
  };

  await fs.writeJson(outPlanPath, plan, { spaces: 2 });
  return { outPlanPath, plan };
}

module.exports = {
  planFromCapturePack,
  buildCustomHtml,
  safeJsonParse,
  buildAssetIndex,
  pickTopNodes,
  extractCandidateImageUrls
};

