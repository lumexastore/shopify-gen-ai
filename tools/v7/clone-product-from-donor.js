require('dotenv').config();

const axios = require('axios');

const shopifyClient = require('../../src/services/shopifyClient');
const config = require('../../src/config');

function centsToPriceString(cents) {
  if (cents == null) return null;
  const n = Number(cents);
  if (!Number.isFinite(n)) return null;
  return (n / 100).toFixed(2);
}

function parseShopifyProductHandleFromUrl(productUrl) {
  const u = new URL(productUrl);
  const parts = u.pathname.split('/').filter(Boolean);
  const idx = parts.indexOf('products');
  if (idx < 0 || !parts[idx + 1]) throw new Error(`Not a Shopify product URL: ${productUrl}`);
  return { origin: u.origin, handle: parts[idx + 1] };
}

function normalizeImageUrl(src, origin) {
  if (!src) return null;
  const s = String(src).trim();
  if (!s) return null;
  if (s.startsWith('data:')) return null;
  if (s.startsWith('//')) return `https:${s}`;
  if (s.startsWith('/')) return `${origin}${s}`;
  try {
    // validates absolute URL
    // eslint-disable-next-line no-new
    new URL(s);
    return s;
  } catch (_) {
    return null;
  }
}

async function fetchDonorProductJs({ donorProductUrl }) {
  const { origin, handle } = parseShopifyProductHandleFromUrl(donorProductUrl);
  const jsUrl = `${origin}/products/${handle}.js`;
  const res = await axios.get(jsUrl, {
    timeout: 60000,
    headers: {
      'User-Agent': 'v7-cloner/1.0',
      Accept: 'application/json,text/plain,*/*',
    },
  });
  return { handle, jsUrl, data: res.data };
}

/**
 * Clone Shopify product content (title/description/images/variants) from a donor Shopify product URL
 * into the configured target Shopify admin store.
 *
 * Note: this clones data, not theme/landing.
 */
async function cloneProductFromDonor({ donorProductUrl, logger } = {}) {
  if (!donorProductUrl) throw new Error('cloneProductFromDonor: donorProductUrl is required');

  const { origin, handle: donorHandle } = parseShopifyProductHandleFromUrl(donorProductUrl);
  const { jsUrl, data } = await fetchDonorProductJs({ donorProductUrl });
  logger?.info?.('donor product fetched', { jsUrl, donorHandle });

  // Build Shopify Admin product payload
  const images = Array.isArray(data?.images) ? data.images : [];
  const variants = Array.isArray(data?.variants) ? data.variants : [];
  const options = Array.isArray(data?.options) ? data.options : [];

  const optionNames = options
    .map((o) => (o && typeof o === 'object' ? o.name : o))
    .filter(Boolean)
    .slice(0, 3);

  const normalizedImages = images
    .map((src) => normalizeImageUrl(src, origin))
    .filter(Boolean)
    .slice(0, 40);

  const product = {
    title: data?.title || `Cloned ${donorHandle}`,
    body_html: data?.description || '',
    vendor: data?.vendor || null,
    product_type: data?.type || null,
    tags: Array.isArray(data?.tags) ? data.tags.join(', ') : (data?.tags || null),
    handle: donorHandle ? `${donorHandle}-clone` : null,
    status: 'active',
    images: normalizedImages.map((src) => ({ src })),
    // Needed for Shopify REST validation when creating multiple variants.
    options: optionNames.length ? optionNames.map((name) => ({ name })) : [{ name: 'Title' }],
    variants: (variants.length ? variants : [null]).slice(0, 50).map((v, idx) => ({
      option1: v?.option1 || v?.title || (idx === 0 ? 'Default Title' : `Variant ${idx + 1}`),
      option2: v?.option2 || null,
      option3: v?.option3 || null,
      price: centsToPriceString(v?.price) || '0.00',
      compare_at_price: centsToPriceString(v?.compare_at_price),
      sku: v?.sku || null,
      inventory_management: null,
      requires_shipping: v?.requires_shipping ?? true,
    })),
  };

  // Clean null keys to reduce API validation noise
  for (const k of Object.keys(product)) if (product[k] == null) delete product[k];
  // Remove null option2/option3 keys from variants
  if (Array.isArray(product.variants)) {
    product.variants = product.variants.map((vv) => {
      const x = { ...vv };
      if (x.option2 == null) delete x.option2;
      if (x.option3 == null) delete x.option3;
      if (x.sku == null) delete x.sku;
      return x;
    });
  }

  await shopifyClient.init(config.shop);
  const created = await shopifyClient.post('/products.json', { product });
  const createdId = created?.product?.id ? String(created.product.id) : null;
  const createdHandle = created?.product?.handle || null;
  if (!createdId) throw new Error('cloneProductFromDonor: Shopify did not return product.id');

  logger?.success?.('product cloned', { productId: createdId, handle: createdHandle, images: images.length, variants: variants.length });
  return { productId: createdId, handle: createdHandle, donorHandle };
}

module.exports = { cloneProductFromDonor, fetchDonorProductJs };

