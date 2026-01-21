const fs = require('fs-extra');
const path = require('path');

const shopifyClient = require('../src/services/shopifyClient');
const config = require('../src/config');
const { initSession } = require('./session-init');

const WORKSPACE_DIR = path.resolve(__dirname, '../workspace');
const PLAN_PATH = path.join(WORKSPACE_DIR, 'dawn_layout_plan.json');
const PASSPORT_V5_PATH = path.join(WORKSPACE_DIR, 'donor_passport.v5.json');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--productId') out.productId = argv[++i];
    else if (a === '--themeId') out.themeId = argv[++i];
    else if (a === '--suffix') out.suffix = argv[++i];
  }
  return out;
}

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch (_) { return null; }
}

function extractSchemaFromLiquid(liquid) {
  if (!liquid) return null;
  const m = liquid.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/i);
  if (!m) return null;
  const json = (m[1] || '').trim();
  return safeJsonParse(json);
}

function pickImagePickerSettingId(schema) {
  const settings = schema?.settings || [];
  const img = settings.find((s) => s.type === 'image_picker') || null;
  return img?.id || null;
}

function pickTextSettingId(settings, preferIds = []) {
  if (!Array.isArray(settings)) return null;
  for (const id of preferIds) {
    const hit = settings.find((s) => s.id === id);
    if (hit) return hit.id;
  }
  const hit = settings.find((s) => ['text', 'inline_richtext', 'richtext', 'textarea', 'html'].includes(s.type));
  return hit?.id || null;
}

function createBlock(blockType, settingsObj, blockId) {
  return {
    type: blockType,
    settings: settingsObj || {},
    ...(blockId ? { id: blockId } : {}),
  };
}

function deriveShopifyRefPrefixFromThemeTemplates(templatesJsonStrings) {
  const all = templatesJsonStrings.join('\n');
  const m = all.match(/shopify:\/\/(shop_images|files)\//);
  if (m && m[0]) return `shopify://${m[1]}/`;
  // Most OS2 themes store image_picker refs under shop_images
  return 'shopify://shop_images/';
}

function extractFilenameFromCdnUrl(url) {
  if (!url) return null;
  // Typical: https://cdn.shopify.com/s/files/.../files/FILENAME.png?v=...
  const m = String(url).match(/\/files\/([^/?#]+)(?:[?#]|$)/i);
  if (m && m[1]) return decodeURIComponent(m[1]);
  // fallback: last path segment
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    return seg ? decodeURIComponent(seg) : null;
  } catch (_) {
    return null;
  }
}

async function fetchThemeAsset(themeId, key) {
  const res = await shopifyClient.get(`/themes/${themeId}/assets.json`, { 'asset[key]': key });
  return res?.asset?.value || null;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForFileReady({ client, fileId, tries = 12, delayMs = 1000 }) {
  const query = `
    query node($id: ID!) {
      node(id: $id) {
        __typename
        ... on MediaImage {
          id
          fileStatus
          image { url }
        }
        ... on GenericFile {
          id
          fileStatus
          url
        }
      }
    }
  `;

  for (let i = 0; i < tries; i++) {
    const resp = await client.request(query, { variables: { id: fileId } });
    const n = resp?.data?.node;
    const status = n?.fileStatus;
    const url = n?.__typename === 'MediaImage' ? n?.image?.url : n?.url;
    if (status === 'READY' && url) return { status, url };
    if (status === 'FAILED') return { status, url: null };
    await sleep(delayMs);
  }
  return { status: 'TIMEOUT', url: null };
}

async function uploadFilesAndGetRefs({ assetIds, passport, shopifyRefPrefix }) {
  const { client } = await initSession();

  const refs = {}; // assetId -> shopify://... ref string

  const uniqueAssetIds = Array.from(new Set(assetIds)).filter(Boolean);
  for (const assetId of uniqueAssetIds) {
    const item = passport.assets?.items?.[assetId];
    const sourceUrl = item?.sourceUrl;
    if (!sourceUrl || sourceUrl.startsWith('data:')) continue; // skip data urls for now

    const mutation = `
      mutation fileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            __typename
            ... on MediaImage {
              id
              fileStatus
              image { url }
            }
            ... on GenericFile {
              id
              url
            }
          }
          userErrors { field message }
        }
      }
    `;

    const variables = {
      files: [
        {
          originalSource: sourceUrl,
          contentType: 'IMAGE',
          alt: assetId,
        },
      ],
    };

    const resp = await client.request(mutation, { variables });
    const payload = resp?.data?.fileCreate;
    const errs = payload?.userErrors || [];
    if (errs.length) {
      console.warn(`⚠️ fileCreate userErrors for ${assetId}:`, errs.map((e) => e.message).join('; '));
      continue;
    }

    const f = (payload?.files || [])[0];
    const fileId = f?.id;
    let cdnUrl = f?.__typename === 'MediaImage' ? f?.image?.url : f?.url;

    // When fileStatus is PROCESSING/UPLOADED, url can be null. Poll until READY.
    if (!cdnUrl && fileId) {
      const waited = await waitForFileReady({ client, fileId });
      cdnUrl = waited.url;
    }

    const filename = extractFilenameFromCdnUrl(cdnUrl);
    if (!filename) {
      console.warn(`⚠️ Could not derive filename from CDN url for ${assetId}. url=${cdnUrl}`);
      continue;
    }

    refs[assetId] = `${shopifyRefPrefix}${filename}`;
  }

  return refs;
}

async function loadSectionSchema(themeId, sectionType) {
  const key = `sections/${sectionType}.liquid`;
  const liquid = await fetchThemeAsset(themeId, key);
  const schema = extractSchemaFromLiquid(liquid);
  if (!schema) {
    console.warn(`⚠️ Could not parse schema for ${sectionType} (${key})`);
  }
  return schema;
}

function compileSectionFromIntent({ sectionPlan, schema, assetRefMap }) {
  const type = sectionPlan.dawnType;
  const intent = sectionPlan.intent || {};

  const settings = {};
  const blocks = {};
  const block_order = [];

  const maxBlocks = Number.isFinite(schema?.max_blocks) ? schema.max_blocks : Infinity;

  // Helper to set first image_picker setting
  const imageSettingId = pickImagePickerSettingId(schema);
  const setImageIfPossible = (assetId) => {
    if (!imageSettingId) return;
    const ref = assetRefMap[assetId];
    if (!ref) return;
    settings[imageSettingId] = ref;
  };

  // Blocks capability map
  const schemaBlocks = schema?.blocks || [];
  const blockTypes = new Set(schemaBlocks.map((b) => b.type));
  const blockSchemaByType = Object.fromEntries(schemaBlocks.map((b) => [b.type, b]));

  const addBlock = (blockType, desiredSettings) => {
    if (block_order.length >= maxBlocks) return null;
    if (!blockTypes.has(blockType)) return null;
    const bs = blockSchemaByType[blockType];
    const realSettings = {};
    const bsSettings = bs?.settings || [];
    for (const [k, v] of Object.entries(desiredSettings || {})) {
      const id = pickTextSettingId(bsSettings, [k]);
      if (id) realSettings[id] = v;
    }
    const id = `${blockType}_${block_order.length + 1}`;
    blocks[id] = { type: blockType, settings: realSettings };
    block_order.push(id);
    return id;
  };

  // Per section type intent compile
  if (type === 'image-banner' && intent.kind === 'hero') {
    setImageIfPossible(intent.heroBgAssetId);
    if (blockTypes.has('heading')) addBlock('heading', { heading: intent.heading || '' });
    if (blockTypes.has('text')) addBlock('text', { text: intent.text || '' });
    if (blockTypes.has('buttons') && intent.cta?.label) {
      addBlock('buttons', { button_label_1: intent.cta.label, button_link_1: intent.cta.href || '' });
    }
  } else if (type === 'multicolumn' && intent.kind === 'features') {
    // title often exists in section settings
    const titleSettingId = pickTextSettingId(schema?.settings || [], ['title', 'heading']);
    if (titleSettingId && intent.title) settings[titleSettingId] = intent.title;

    // blocks usually are type "column"
    const columnType = blockTypes.has('column') ? 'column' : (Array.from(blockTypes)[0] || null);
    if (columnType) {
      const bs = blockSchemaByType[columnType];
      const imgId = (bs?.settings || []).find((s) => s.type === 'image_picker')?.id || null;
      const titleId = pickTextSettingId(bs?.settings || [], ['title', 'heading']);
      const textId = pickTextSettingId(bs?.settings || [], ['text', 'description']);

      for (const it of (intent.items || []).slice(0, Math.min(6, maxBlocks))) {
        const bid = `${columnType}_${block_order.length + 1}`;
        const bSettings = {};
        const imgRef = assetRefMap[it.iconAssetId];
        if (imgId && imgRef) bSettings[imgId] = imgRef;
        if (titleId && it.title) bSettings[titleId] = it.title;
        if (textId && it.text) bSettings[textId] = it.text;
        blocks[bid] = { type: columnType, settings: bSettings };
        block_order.push(bid);
      }
    }
  } else if (type === 'rich-text' && intent.kind === 'rich_text') {
    if (blockTypes.has('heading') && intent.heading) addBlock('heading', { heading: intent.heading });
    if (blockTypes.has('text') && intent.html) addBlock('text', { text: intent.html });
  } else if (type === 'collapsible-content' && intent.kind === 'faq') {
    const titleSettingId = pickTextSettingId(schema?.settings || [], ['heading', 'title']);
    if (titleSettingId && intent.title) settings[titleSettingId] = intent.title;

    const rowType =
      blockTypes.has('collapsible_row') ? 'collapsible_row' :
      blockTypes.has('collapsible-row') ? 'collapsible-row' :
      (Array.from(blockTypes)[0] || null);

    if (rowType) {
      const bs = blockSchemaByType[rowType];
      const qId = pickTextSettingId(bs?.settings || [], ['heading', 'question', 'title']);
      const aId = pickTextSettingId(bs?.settings || [], ['content', 'answer', 'text']);
      const rows = (intent.items || []).length ? intent.items : [{ q: 'Shipping', a: 'Fast worldwide shipping.' }];
      for (const row of rows.slice(0, Math.min(8, maxBlocks))) {
        const bid = `${rowType}_${block_order.length + 1}`;
        const bSettings = {};
        if (qId) bSettings[qId] = row.q || '';
        if (aId) bSettings[aId] = row.a || '';
        blocks[bid] = { type: rowType, settings: bSettings };
        block_order.push(bid);
      }
    }
  } else if (type === 'slideshow' && intent.kind === 'slideshow') {
    const slideType =
      blockTypes.has('slide') ? 'slide' :
      blockTypes.has('slideshow_slide') ? 'slideshow_slide' :
      (Array.from(blockTypes)[0] || null);

    if (slideType) {
      const bs = blockSchemaByType[slideType];
      const imgId = (bs?.settings || []).find((s) => s.type === 'image_picker')?.id || null;
      const headingId = pickTextSettingId(bs?.settings || [], ['heading', 'title']);
      const textId = pickTextSettingId(bs?.settings || [], ['text', 'subheading', 'description']);

      for (const slide of (intent.slides || []).slice(0, Math.min(5, maxBlocks))) {
        const bid = `${slideType}_${block_order.length + 1}`;
        const bSettings = {};
        const imgRef = assetRefMap[slide.imageAssetId];
        if (imgId && imgRef) bSettings[imgId] = imgRef;
        if (headingId && slide.heading) bSettings[headingId] = slide.heading;
        if (textId && slide.text) bSettings[textId] = slide.text;
        blocks[bid] = { type: slideType, settings: bSettings };
        block_order.push(bid);
      }
    }
  } else {
    // fallback: empty section (keeps template valid) or could switch to rich-text
  }

  const out = { type, settings };
  if (block_order.length) {
    out.blocks = blocks;
    out.block_order = block_order;
  }
  return out;
}

async function templateBuilder() {
  const args = parseArgs(process.argv);
  const suffix = args.suffix || 'cloned-v1';

  if (!fs.existsSync(PLAN_PATH) || !fs.existsSync(PASSPORT_V5_PATH)) {
    console.error('❌ Missing inputs. Ensure you ran: deep-inspector (V5) and structure-mapper.');
    console.error(`- ${PASSPORT_V5_PATH}`);
    console.error(`- ${PLAN_PATH}`);
    process.exit(1);
  }

  const plan = await fs.readJson(PLAN_PATH);
  const passport = await fs.readJson(PASSPORT_V5_PATH);

  // Determine productId (CLI -> legacy passport fallback)
  let productId = args.productId;
  if (!productId) {
    const legacyPath = path.join(WORKSPACE_DIR, 'donor_passport.json');
    if (fs.existsSync(legacyPath)) {
      const legacy = await fs.readJson(legacyPath);
      productId = legacy.createdProductId;
    }
  }
  if (!productId) {
    console.error('❌ Missing productId. Provide: node tools/template-builder.js --productId <id>');
    process.exit(1);
  }

  // Init REST client for theme assets + product update
  await shopifyClient.init(config.shop);

  const themes = await shopifyClient.get('/themes.json');
  const mainTheme = themes.themes.find((t) => t.role === 'main');
  const themeId = args.themeId || mainTheme?.id;
  if (!themeId) {
    console.error('❌ Main theme not found.');
    process.exit(1);
  }

  // Determine shopify:// ref prefix by sampling templates that often include image pickers
  const templateKeysToSample = ['templates/index.json', 'templates/page.json', 'templates/product.json'];
  const templateVals = [];
  for (const k of templateKeysToSample) {
    try {
      const v = await fetchThemeAsset(themeId, k);
      if (v) templateVals.push(v);
    } catch (_) {
      // ignore missing
    }
  }
  const shopifyRefPrefix = deriveShopifyRefPrefixFromThemeTemplates(templateVals);

  // Load base product template json (if missing, create minimal)
  const baseTemplateStr = await fetchThemeAsset(themeId, 'templates/product.json');
  const baseTemplate = safeJsonParse(baseTemplateStr) || { sections: {}, order: [] };

  // Gather assetIds we need to upload (from intents)
  const neededAssetIds = [];
  for (const s of (plan.sections || [])) {
    const intent = s.intent || {};
    if (intent.heroBgAssetId) neededAssetIds.push(intent.heroBgAssetId);
    if (Array.isArray(intent.items)) intent.items.forEach((it) => it.iconAssetId && neededAssetIds.push(it.iconAssetId));
    if (Array.isArray(intent.slides)) intent.slides.forEach((sl) => sl.imageAssetId && neededAssetIds.push(sl.imageAssetId));
  }

  console.log(`📦 Uploading ${new Set(neededAssetIds).size} assets to Shopify Files (best-effort)...`);
  const assetRefMap = await uploadFilesAndGetRefs({ assetIds: neededAssetIds, passport, shopifyRefPrefix });

  // Compile sections using real schema from current theme
  const newSections = { ...(baseTemplate.sections || {}) };
  const newOrder = Array.isArray(baseTemplate.order) ? [...baseTemplate.order] : [];

  let idx = 0;
  for (const sectionPlan of (plan.sections || [])) {
    idx += 1;
    const dawnType = sectionPlan.dawnType;
    const schema = await loadSectionSchema(themeId, dawnType);
    const compiled = compileSectionFromIntent({ sectionPlan, schema, assetRefMap });

    // Fallback: if compiled section has no settings and no blocks, skip (avoids empty noise)
    const hasContent = Object.keys(compiled.settings || {}).length > 0 || Object.keys(compiled.blocks || {}).length > 0;
    if (!hasContent) continue;

    const key = `cloned_v5_${idx}_${dawnType.replace(/[^a-z0-9_-]/gi, '_')}`;
    newSections[key] = compiled;
    newOrder.push(key);
  }

  const newTemplate = {
    ...baseTemplate,
    sections: newSections,
    order: newOrder,
  };

  const templateKey = `templates/product.${suffix}.json`;
  console.log(`📤 Uploading template: ${templateKey} ...`);
  await shopifyClient.put(`/themes/${themeId}/assets.json`, {
    asset: {
      key: templateKey,
      value: JSON.stringify(newTemplate, null, 2),
    },
  });

  console.log(`🧩 Assigning template_suffix="${suffix}" to product ${productId} ...`);
  await shopifyClient.put(`/products/${productId}.json`, {
    product: {
      id: productId,
      template_suffix: suffix,
    },
  });

  console.log('✅ Template applied successfully.');
  console.log(`   - themeId: ${themeId}`);
  console.log(`   - productId: ${productId}`);
  console.log(`   - suffix: ${suffix}`);
}

if (require.main === module) {
  templateBuilder().catch((err) => {
    console.error('❌ template-builder failed:', err?.message || err);
    if (err?.response?.data) console.error('API Response:', JSON.stringify(err.response.data, null, 2));
    process.exit(1);
  });
}

module.exports = { templateBuilder };

