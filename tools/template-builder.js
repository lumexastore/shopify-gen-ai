const fs = require('fs-extra');
const path = require('path');

const shopifyClient = require('../src/services/shopifyClient');
const config = require('../src/config');
const { initSession } = require('./session-init');
const { cleanupWorkspace } = require('./cleanup-workspace');

const WORKSPACE_DIR = path.resolve(__dirname, '../workspace');
const PLAN_PATH = path.join(WORKSPACE_DIR, 'dawn_layout_plan.json');
const PASSPORT_V5_PATH = path.join(WORKSPACE_DIR, 'donor_passport.v5.json');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') out.mode = argv[++i];
    else if (a === '--productId') out.productId = argv[++i];
    else if (a === '--pageId') out.pageId = argv[++i];
    else if (a === '--themeId') out.themeId = argv[++i];
    else if (a === '--suffix') out.suffix = argv[++i];
    else if (a === '--planPath') out.planPath = argv[++i];
    else if (a === '--passportPath') out.passportPath = argv[++i];
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
      // Find matching setting
      let hit = bsSettings.find((s) => s.id === k);
      if (!hit) {
        // loose match heuristics
        if (k === 'text') hit = bsSettings.find((s) => ['text', 'richtext', 'inline_richtext', 'textarea'].includes(s.type) && (s.id === 'text' || s.id === 'content' || s.id === 'description' || s.id === 'answer'));
        else if (k === 'heading') hit = bsSettings.find((s) => ['text', 'inline_richtext'].includes(s.type) && (s.id === 'heading' || s.id === 'title' || s.id === 'question'));
      }

      if (hit) {
        let val = v;
        const needsWrapping = hit.type === 'richtext' && val && !val.trim().startsWith('<');
        if (needsWrapping) {
          console.log(`[DEBUG] Wrapping richtext for ${blockType}.${hit.id}: ${val.slice(0, 20)}...`);
          val = `<p>${val}</p>`;
        } else if (hit.type === 'richtext') {
          console.log(`[DEBUG] Skipped wrapping for ${blockType}.${hit.id} (already wrapped or empty):`, val);
        }
        realSettings[hit.id] = val;
      } else {
        console.log(`[DEBUG] No schema hit for ${blockType} setting: ${k}`);
      }
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
  } else if (type === 'ai-super-canvas' && intent.kind === 'custom_html') {
    // Our joker section has simple schema: html + custom_css
    const htmlSettingId = (schema?.settings || []).find((s) => s.id === 'html')?.id || pickTextSettingId(schema?.settings || [], ['html']);
    const cssSettingId = (schema?.settings || []).find((s) => s.id === 'custom_css')?.id || null;

    if (htmlSettingId) settings[htmlSettingId] = intent.html || '';
    if (cssSettingId) settings[cssSettingId] = intent.custom_css || '';

  } else if (type === 'smart-grid' && (intent.kind === 'smart_grid' || intent.kind === 'features')) {
    // V7 custom grid: schema-driven settings + blocks
    const sSettings = schema?.settings || [];
    const setIf = (id, v) => {
      if (v === undefined || v === null) return;
      const has = sSettings.find((s) => s.id === id);
      if (has) settings[id] = v;
    };

    setIf('heading', intent.heading || intent.title || '');
    setIf('heading_size', intent.heading_size || 'h1');
    setIf('columns_desktop', intent.columns_desktop || intent.columns || 3);
    setIf('columns_mobile', intent.columns_mobile || 1);
    setIf('gap', intent.gap || 16);
    setIf('padding_y', intent.padding_y || 24);
    setIf('custom_css', intent.custom_css || '');

    const itemType = blockTypes.has('item') ? 'item' : (Array.from(blockTypes)[0] || null);
    if (itemType) {
      const bs = blockSchemaByType[itemType];
      const bsSettings = bs?.settings || [];
      const imgId = bsSettings.find((s) => s.type === 'image_picker')?.id || 'image';
      const titleId = pickTextSettingId(bsSettings, ['title']) || 'title';
      const textId = pickTextSettingId(bsSettings, ['text']) || 'text';
      const linkLabelId = pickTextSettingId(bsSettings, ['link_label']) || 'link_label';
      const linkUrlId = (bsSettings || []).find((s) => s.type === 'url')?.id || 'link_url';

      for (const it of (intent.items || []).slice(0, Math.min(24, maxBlocks))) {
        const bid = `${itemType}_${block_order.length + 1}`;
        const bSettings = {};
        const imgRef = assetRefMap[it.imageAssetId || it.iconAssetId];
        if (imgId && imgRef) bSettings[imgId] = imgRef;
        if (titleId && it.title) bSettings[titleId] = it.title;
        if (textId && it.text) bSettings[textId] = it.text;
        if (linkLabelId && it.link_label) bSettings[linkLabelId] = it.link_label;
        if (linkUrlId && it.link_url) bSettings[linkUrlId] = it.link_url;
        blocks[bid] = { type: itemType, settings: bSettings };
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

    // Post-process blocks to sanitize richtext (fix for 422)
    for (const [bid, block] of Object.entries(blocks)) {
      const bs = blockSchemaByType[block.type];
      const bsSettings = bs?.settings || [];
      const realSettings = block.settings || {};
      for (const [k, v] of Object.entries(realSettings)) {
        if (!v || typeof v !== 'string') continue;
        const sDef = bsSettings.find((s) => s.id === k);
        if (sDef && sDef.type === 'richtext') {
          if (!v.trim().startsWith('<')) {
            realSettings[k] = `<p>${v}</p>`;
          }
        }
      }
    }
  }
  return out;
}

async function templateBuilder({ argv = null } = {}) {
  const args = parseArgs(argv || process.argv);
  const mode = (args.mode || (args.pageId ? 'page' : 'product')).toLowerCase();
  const suffix = args.suffix || 'cloned-v1';

  const planPath = args.planPath || PLAN_PATH;
  const passportPath = args.passportPath || PASSPORT_V5_PATH;

  if (!fs.existsSync(planPath) || !fs.existsSync(passportPath)) {
    console.error('❌ Missing inputs. Ensure you ran: deep-inspector (V5) and structure-mapper.');
    console.error(`- ${passportPath}`);
    console.error(`- ${planPath}`);
    process.exit(1);
  }

  const plan = await fs.readJson(planPath);
  const passport = await fs.readJson(passportPath);

  if (!['product', 'page'].includes(mode)) {
    console.error('❌ Invalid mode. Use --mode product|page');
    process.exit(1);
  }

  let productId = null;
  let pageId = null;

  if (mode === 'product') {
    // Determine productId (CLI -> legacy passport fallback)
    productId = args.productId;
    if (!productId) {
      const legacyPath = path.join(WORKSPACE_DIR, 'donor_passport.json');
      if (fs.existsSync(legacyPath)) {
        const legacy = await fs.readJson(legacyPath);
        productId = legacy.createdProductId;
      }
    }
    if (!productId) {
      console.error('❌ Missing productId. Provide: node tools/template-builder.js --mode product --productId <id>');
      process.exit(1);
    }
  } else {
    pageId = args.pageId;
    if (!pageId) {
      console.error('❌ Missing pageId. Provide: node tools/template-builder.js --mode page --pageId <id>');
      process.exit(1);
    }
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

  // Load base template json (if missing, create minimal)
  const baseTemplateKey = mode === 'page' ? 'templates/page.json' : 'templates/product.json';
  const baseTemplateStr = await fetchThemeAsset(themeId, baseTemplateKey);
  const baseTemplate = safeJsonParse(baseTemplateStr) || { sections: {}, order: [] };

  // Gather assetIds we need to upload (from intents)
  const neededAssetIds = [];
  for (const s of (plan.sections || [])) {
    const intent = s.intent || {};
    if (intent.heroBgAssetId) neededAssetIds.push(intent.heroBgAssetId);
    if (Array.isArray(intent.items)) intent.items.forEach((it) => it.iconAssetId && neededAssetIds.push(it.iconAssetId));
    if (Array.isArray(intent.items)) intent.items.forEach((it) => it.imageAssetId && neededAssetIds.push(it.imageAssetId));
    if (Array.isArray(intent.slides)) intent.slides.forEach((sl) => sl.imageAssetId && neededAssetIds.push(sl.imageAssetId));
  }

  console.log(`📦 Uploading ${new Set(neededAssetIds).size} assets to Shopify Files (best-effort)...`);
  const assetRefMap = await uploadFilesAndGetRefs({ assetIds: neededAssetIds, passport, shopifyRefPrefix });

  // Compile sections using real schema from current theme
  const newSections = {};
  const newOrder = [];

  // 1. Retain ONLY the 'main' product section from the base template (essential for Add to Cart)
  //    Discard 'related-products', 'recommendations', and other noise.
  if (baseTemplate.sections) {
    for (const [key, val] of Object.entries(baseTemplate.sections)) {
      if (val.type === 'main-product' || key === 'main') {
        newSections[key] = val;
        // Ensure it's in the order
        if (baseTemplate.order && baseTemplate.order.includes(key)) {
          newOrder.push(key);
        } else if (!newOrder.includes(key)) {
          newOrder.push(key);
        }
      }
    }
  }

  // 2. Append AI-generated sections
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

  const templateKey = mode === 'page'
    ? `templates/page.${suffix}.json`
    : `templates/product.${suffix}.json`;
  console.log(`📤 Uploading template: ${templateKey} ...`);
  await shopifyClient.put(`/themes/${themeId}/assets.json`, {
    asset: {
      key: templateKey,
      value: JSON.stringify(newTemplate, null, 2),
    },
  });

  if (mode === 'page') {
    console.log(`🧩 Assigning template_suffix="${suffix}" to page ${pageId} ...`);
    await shopifyClient.put(`/pages/${pageId}.json`, {
      page: {
        id: pageId,
        template_suffix: suffix,
      },
    });
  } else {
    console.log(`🧩 Assigning template_suffix="${suffix}" to product ${productId} ...`);
    await shopifyClient.put(`/products/${productId}.json`, {
      product: {
        id: productId,
        template_suffix: suffix,
      },
    });
  }

  console.log('✅ Template applied successfully.');
  console.log(`   - themeId: ${themeId}`);
  console.log(`   - mode: ${mode}`);
  if (mode === 'page') console.log(`   - pageId: ${pageId}`);
  else console.log(`   - productId: ${productId}`);
  console.log(`   - suffix: ${suffix}`);

  // Post-run cleanup (safe): move old generated screenshots/legacy dirs into workspace/_trash
  try {
    const res = await cleanupWorkspace({ mode: 'post_run', keepDays: 7, purgeTrash: true });
    console.log('🧹 Workspace cleanup:', JSON.stringify(res.movedSummary));
  } catch (e) {
    console.warn('⚠️ cleanup-workspace warning:', e?.message || e);
  }
}

if (require.main === module) {
  templateBuilder({ argv: process.argv }).catch((err) => {
    console.error('❌ template-builder failed:', err?.message || err);
    if (err?.response?.data) console.error('API Response:', JSON.stringify(err.response.data, null, 2));
    process.exit(1);
  });
}

module.exports = { templateBuilder };

