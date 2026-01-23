const puppeteer = require('puppeteer');
const fs = require('fs-extra');
const path = require('path');

const {
  PASSPORT_VERSION,
  SECTION_TYPES,
  ASSET_ROLES,
  ASSET_KINDS,
  normalizeUrl,
  stableAssetId,
  stableSectionId,
  validatePassportV5,
} = require('../src/schema/donorPassportV5');

// Paths
const WORKSPACE_DIR = path.resolve(__dirname, '../workspace');
const SCREENSHOTS_DIR = path.join(WORKSPACE_DIR, 'screenshots');
const LATEST_DIR = path.join(SCREENSHOTS_DIR, 'latest');
const OUTPUT_FILE_V5 = path.join(WORKSPACE_DIR, 'donor_passport.v5.json');

fs.ensureDirSync(SCREENSHOTS_DIR);
fs.ensureDirSync(LATEST_DIR);

async function autoScroll(page, maxScrolls = 12) {
  await page.evaluate(async (max) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let i = 0;
    let lastY = -1;
    while (i < max) {
      window.scrollBy(0, Math.max(300, Math.floor(window.innerHeight * 0.8)));
      await sleep(350);
      const y = window.scrollY;
      if (y === lastY) break;
      lastY = y;
      i++;
    }
    window.scrollTo(0, 0);
  }, maxScrolls);
}

async function ensureHashHelpers(page) {
  await page.evaluate(() => {
    if (window.__aiCloneHashV5) return;
    window.__aiCloneHashV5 = (pngBase64) => {
      const dataUrl = `data:image/png;base64,${pngBase64}`;
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          // --- dhash64 (9x8) ---
          const w = 9, h = 8;
          const c1 = document.createElement('canvas');
          c1.width = w; c1.height = h;
          const ctx1 = c1.getContext('2d', { willReadFrequently: true });
          ctx1.drawImage(img, 0, 0, w, h);
          const d1 = ctx1.getImageData(0, 0, w, h).data;

          const gray = [];
          for (let y = 0; y < h; y++) {
            const row = [];
            for (let x = 0; x < w; x++) {
              const i = (y * w + x) * 4;
              const r = d1[i], g = d1[i + 1], b = d1[i + 2];
              row.push((r * 0.299 + g * 0.587 + b * 0.114) | 0);
            }
            gray.push(row);
          }

          let bits = '';
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w - 1; x++) {
              bits += gray[y][x] > gray[y][x + 1] ? '1' : '0';
            }
          }
          // bits length = 64
          let dhashHex = '';
          for (let i = 0; i < 64; i += 4) {
            dhashHex += parseInt(bits.slice(i, i + 4), 2).toString(16);
          }

          // --- dominantColor + edgeDensity (64x64 sample) ---
          const sw = 64, sh = 64;
          const c2 = document.createElement('canvas');
          c2.width = sw; c2.height = sh;
          const ctx2 = c2.getContext('2d', { willReadFrequently: true });
          ctx2.drawImage(img, 0, 0, sw, sh);
          const d2 = ctx2.getImageData(0, 0, sw, sh).data;

          let sumR = 0, sumG = 0, sumB = 0;
          let edgeSum = 0;
          for (let y = 0; y < sh; y++) {
            for (let x = 0; x < sw; x++) {
              const i = (y * sw + x) * 4;
              const r = d2[i], g = d2[i + 1], b = d2[i + 2];
              sumR += r; sumG += g; sumB += b;
              if (x > 0) {
                const j = (y * sw + (x - 1)) * 4;
                edgeSum += Math.abs(r - d2[j]) + Math.abs(g - d2[j + 1]) + Math.abs(b - d2[j + 2]);
              }
              if (y > 0) {
                const k = ((y - 1) * sw + x) * 4;
                edgeSum += Math.abs(r - d2[k]) + Math.abs(g - d2[k + 1]) + Math.abs(b - d2[k + 2]);
              }
            }
          }

          const px = sw * sh;
          const avgR = Math.round(sumR / px);
          const avgG = Math.round(sumG / px);
          const avgB = Math.round(sumB / px);
          const toHex = (n) => n.toString(16).padStart(2, '0');
          const dominantColor = `#${toHex(avgR)}${toHex(avgG)}${toHex(avgB)}`;

          // Normalize roughly to 0..1
          const edgeDensity = Math.min(1, edgeSum / (px * 255 * 6));

          resolve({ dhash64: dhashHex, dominantColor, edgeDensity });
        };
        img.onerror = () => resolve({ dhash64: null, dominantColor: null, edgeDensity: null });
        img.src = dataUrl;
      });
    };
  });
}

function classifySection(raw) {
  const f = raw.features || {};

  const hasH1 = (f.h1Count || 0) > 0;
  const hasCta = (f.buttonCount || 0) > 0 || (f.ctaLikeLinkCount || 0) > 0;
  const imgBigCount = (f.bigImageCount || 0);
  const imgTotal = (f.imgCount || 0);
  const svgCount = (f.svgCount || 0);
  const detailsCount = (f.detailsCount || 0);
  const repeatedCards = (f.repeatedCardCount || 0);
  const hasCarousel = !!f.hasCarousel;
  const textLen = f.textLen || 0;

  const scores = new Map();
  scores.set(SECTION_TYPES.HEADER, raw.tag === 'HEADER' ? 5 : 0);
  scores.set(SECTION_TYPES.FOOTER, raw.tag === 'FOOTER' ? 5 : 0);

  let heroScore = 0;
  heroScore += hasH1 ? 3 : 0;
  heroScore += hasCta ? 2 : 0;
  heroScore += imgBigCount >= 1 ? 3 : 0;
  heroScore += raw.bbox && raw.bbox.h >= 420 ? 1 : 0;
  scores.set(SECTION_TYPES.HERO_BANNER, heroScore);

  let featuresScore = 0;
  featuresScore += repeatedCards >= 3 ? 3 : 0;
  featuresScore += (svgCount + (f.smallImageCount || 0)) >= 3 ? 2 : 0;
  featuresScore += (f.headingLikeCount || 0) >= 3 ? 1 : 0;
  scores.set(SECTION_TYPES.FEATURES_GRID, featuresScore);

  let faqScore = 0;
  faqScore += detailsCount >= 2 ? 4 : 0;
  faqScore += (f.ariaExpandedCount || 0) >= 2 ? 2 : 0;
  scores.set(SECTION_TYPES.FAQ, faqScore);

  let slideshowScore = 0;
  slideshowScore += hasCarousel ? 4 : 0;
  slideshowScore += imgTotal >= 3 ? 1 : 0;
  scores.set(SECTION_TYPES.SLIDESHOW, slideshowScore);

  let galleryScore = 0;
  galleryScore += imgTotal >= 6 ? 3 : 0;
  galleryScore += repeatedCards >= 4 ? 1 : 0;
  scores.set(SECTION_TYPES.GALLERY, galleryScore);

  let reviewsScore = 0;
  reviewsScore += repeatedCards >= 3 && (f.starLikeCount || 0) >= 3 ? 4 : 0;
  reviewsScore += (f.avatarLikeCount || 0) >= 2 ? 2 : 0;
  scores.set(SECTION_TYPES.REVIEWS, reviewsScore);

  let richTextScore = 0;
  richTextScore += textLen >= 200 ? 2 : 0;
  richTextScore += imgTotal === 0 ? 1 : 0;
  scores.set(SECTION_TYPES.RICH_TEXT, richTextScore);

  // pick max
  let bestType = SECTION_TYPES.UNKNOWN;
  let best = -1;
  for (const [t, s] of scores.entries()) {
    if (s > best) { best = s; bestType = t; }
  }

  // confidence: soft normalization
  const confidence = Math.max(0.3, Math.min(0.99, best / 6));
  return { type: bestType, confidence };
}

function roleForAsset({ sectionType, asset, inHeader }) {
  if (inHeader) return ASSET_ROLES.LOGO;

  const kind = asset.kind;
  const w = asset.width || asset.bbox?.w || 0;
  const h = asset.height || asset.bbox?.h || 0;
  const smallish = w > 0 && h > 0 && Math.max(w, h) <= 140;

  if (sectionType === SECTION_TYPES.HERO_BANNER) return ASSET_ROLES.HERO_BG;
  if (sectionType === SECTION_TYPES.FEATURES_GRID && (kind === ASSET_KINDS.SVG || smallish)) return ASSET_ROLES.ICON;
  if (sectionType === SECTION_TYPES.GALLERY || sectionType === SECTION_TYPES.SLIDESHOW) return ASSET_ROLES.GALLERY;
  if (smallish && kind === ASSET_KINDS.SVG) return ASSET_ROLES.ICON;
  return ASSET_ROLES.ILLUSTRATION;
}

async function deepInspector(url) {
    if (!url) {
    console.error('Please provide a URL as an argument.');
        process.exit(1);
    }

  console.log(`🕵️ V5 Deep Inspector launching for: ${url}`);
    const browser = await puppeteer.launch({
    headless: 'new',
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    });

    const page = await browser.newPage();
  await ensureHashHelpers(page);

    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    } catch (e) {
        console.warn(`Initial load warning: ${e.message}. Continuing...`);
    }

  // Best-effort: load lazy sections/images
  await autoScroll(page);

  // Write into screenshots/latest (overwrite), so workspace doesn't grow over time
  const screenshotPath = path.join(LATEST_DIR, 'donor_full_v5.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`📸 Full-page screenshot saved to: ${screenshotPath}`);

  const raw = await page.evaluate(() => {
        const getStyle = (el, prop) => window.getComputedStyle(el).getPropertyValue(prop);

    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return false;
      return true;
    };

    const bbox = (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + window.scrollX), y: Math.round(r.y + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) };
    };

    const cssPath = (el) => {
      const parts = [];
      let cur = el;
      let depth = 0;
      while (cur && cur.nodeType === 1 && depth < 6) {
        let part = cur.tagName.toLowerCase();
        if (cur.id) part += `#${cur.id}`;
        const cls = (cur.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) part += `.${cls.join('.')}`;
        parts.unshift(part);
        cur = cur.parentElement;
        depth++;
      }
      return parts.join('>');
    };

    // --- design tokens (basic) ---
        let primaryButton = null;
    const buttons = Array.from(document.querySelectorAll('button, a.btn, a.button, input[type="submit"], a[role="button"]'));
    const viableButtons = buttons.filter((b) => {
            const bg = window.getComputedStyle(b).backgroundColor;
            return bg !== 'rgba(0, 0, 0, 0)' && bg !== 'rgb(255, 255, 255)' && bg !== 'transparent';
        });
    if (viableButtons.length > 0) primaryButton = window.getComputedStyle(viableButtons[0]).backgroundColor;

        const bodyBg = getStyle(document.body, 'background-color');
    const bodyColor = getStyle(document.body, 'color');
    const bodyFont = getStyle(document.body, 'font-family');
        const h1 = document.querySelector('h1');
        const h2 = document.querySelector('h2');
        const h1Font = h1 ? getStyle(h1, 'font-family') : null;
        const h2Font = h2 ? getStyle(h2, 'font-family') : null;

    const domSnapshot = {
      title: document.title || null,
      lang: document.documentElement.getAttribute('lang') || null,
    };

    // --- page/product info (best-effort, works for product pages and many landings) ---
    const pageInfo = {
      title: (() => {
        const h1 = document.querySelector('h1');
        if (h1 && (h1.innerText || '').trim().length > 0) return h1.innerText.trim();
        const og = document.querySelector('meta[property="og:title"]')?.content;
        if (og) return og.trim();
        return document.title || 'Unknown';
      })(),
      priceText: (() => {
        const selectors = [
          '.price',
          '.product-price',
          '.product__price',
          'span.money',
          '[data-product-price]',
          '[class*="price" i]',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.innerText && el.innerText.match(/\d/)) return el.innerText.trim();
        }
        const metaAmount = document.querySelector('meta[property="product:price:amount"]')?.content;
        return metaAmount ? metaAmount.trim() : null;
      })(),
      descriptionHtml: (() => {
        const selectors = [
          '.product-description',
          '.product__description',
          '.rte',
          '#description',
          'main article',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && (el.innerText || '').trim().length > 40) return el.innerHTML;
        }
        const metaDesc = document.querySelector('meta[name="description"]')?.content;
        return metaDesc ? `<p>${metaDesc}</p>` : null;
      })(),
    };

    // --- choose main root and unwrap wrappers ---
    const main = document.querySelector('main');
    const root0 = main || document.body;
    let root = root0;
    let guard = 0;
    while (guard < 5) {
      const kids = Array.from(root.children).filter((x) => x && x.tagName);
      if (kids.length === 1) {
        const rRoot = root.getBoundingClientRect();
        const rKid = kids[0].getBoundingClientRect();
        const covers = rKid.height >= rRoot.height * 0.85 && rKid.width >= rRoot.width * 0.85;
        if (covers) {
          root = kids[0];
          guard++;
          continue;
        }
      }
      break;
    }

    // candidates: direct children of root, plus header/footer if separate
    const candidates = [];

    const pushCandidate = (el, forcedTag = null) => {
      if (!el || !isVisible(el)) return;
      const b = bbox(el);
      if (b.h < 120 || b.w < Math.floor(window.innerWidth * 0.4)) return;
      const id = `sec_${Math.random().toString(16).slice(2)}_${candidates.length}`;
      el.setAttribute('data-ai-section-id', id);

      // simple feature extraction for classification
      const within = (sel) => Array.from(el.querySelectorAll(sel));
      const imgs = within('img').filter(isVisible);
      const svgs = within('svg').filter(isVisible);
      const details = within('details');
      const ariaExpanded = within('[aria-expanded="true"],[aria-expanded="false"]');
      const headings = within('h1,h2,h3');
      const paras = within('p,li');
      const btns = within('button,input[type="submit"]');
      const links = within('a');

      const bigImages = imgs.filter((img) => (img.naturalWidth || img.width || 0) >= 600 || (img.getBoundingClientRect().width || 0) >= 600);
      const smallImages = imgs.filter((img) => (img.naturalWidth || img.width || 0) <= 160 && (img.getBoundingClientRect().width || 0) <= 160);

      const text = (el.innerText || '').trim();

      // repeated cards heuristic: find a container with 3-6 similar direct children
      let repeatedCardCount = 0;
      for (const child of Array.from(el.querySelectorAll(':scope > div, :scope > section, :scope > ul')).slice(0, 8)) {
        const style = window.getComputedStyle(child);
        const isGridFlex = style.display.includes('grid') || style.display.includes('flex');
        const cardKids = Array.from(child.children).filter((k) => k && k.tagName && isVisible(k));
        if (isGridFlex && cardKids.length >= 3 && cardKids.length <= 8) {
          repeatedCardCount = Math.max(repeatedCardCount, cardKids.length);
        }
      }

      const hasCarousel = !!(el.querySelector('.swiper,.slick-slider,[data-flickity],[aria-roledescription="carousel"],[data-carousel]'));

      // star-like / reviews heuristics
      const starLikeCount = (text.match(/★/g) || []).length + within('[aria-label*="star" i], [class*="star" i]').length;
      const avatarLikeCount = imgs.filter((img) => {
        const r = img.getBoundingClientRect();
        return r.width > 24 && r.width < 120 && Math.abs(r.width - r.height) < 10;
      }).length;

      // CTA-like links
      const ctaLikeLinkCount = links.filter((a) => {
        const t = (a.innerText || '').trim().toLowerCase();
        return t.length > 0 && t.length <= 30 && /(buy|shop|add|order|get|start|claim|learn)/.test(t);
      }).length;

      // assets within section (img + background-image urls)
      const assets = [];
      let assetUsageIdx = 0;

      const addAsset = (kind, payload, hostEl) => {
        const usageId = `au_${id}_${assetUsageIdx++}`;
        if (hostEl) hostEl.setAttribute('data-ai-asset-usage-id', usageId);
        assets.push({
          usageId,
          kind,
          ...payload,
          bbox: hostEl ? bbox(hostEl) : null,
          domPath: hostEl ? cssPath(hostEl) : null,
        });
      };

      imgs.forEach((img) => {
        const src = img.currentSrc || img.src || null;
        if (!src) return;
        addAsset('image', {
          src,
          alt: img.alt || null,
          width: img.naturalWidth || img.width || null,
          height: img.naturalHeight || img.height || null,
        }, img);
      });

      // background images
      const bgEls = within('*').slice(0, 250);
      bgEls.forEach((node) => {
        const bg = window.getComputedStyle(node).backgroundImage;
        if (!bg || bg === 'none') return;
        const m = bg.match(/url\\([\"']?(.*?)[\"']?\\)/i);
        if (!m || !m[1]) return;
        const src = m[1];
        addAsset('image', { src, alt: null, width: null, height: null, isBackground: true }, node);
      });

      // inline SVG (capture markup hash later in Node if needed)
      svgs.slice(0, 40).forEach((svg) => {
        addAsset('svg', { svgOuterHTML: svg.outerHTML.slice(0, 50000) }, svg);
      });

      candidates.push({
        sectionDomId: id,
        tag: forcedTag || el.tagName,
        className: (el.className || '').toString().slice(0, 400),
        bbox: b,
        domPath: cssPath(el),
        features: {
          h1Count: within('h1').length,
          h2Count: within('h2').length,
          headingLikeCount: headings.length,
          pCount: within('p').length,
          liCount: within('li').length,
          buttonCount: btns.length,
          linkCount: links.length,
          ctaLikeLinkCount,
          imgCount: imgs.length,
          bigImageCount: bigImages.length,
          smallImageCount: smallImages.length,
          svgCount: svgs.length,
          detailsCount: details.length,
          ariaExpandedCount: ariaExpanded.length,
          repeatedCardCount,
          hasCarousel,
          starLikeCount,
          avatarLikeCount,
          textLen: text.length,
        },
        headline: (el.querySelector('h1,h2')?.innerText || '').trim().slice(0, 200) || null,
        textSample: text.slice(0, 280) || null,
        assets,
      });
    };

    const header = document.querySelector('header');
    if (header) pushCandidate(header, 'HEADER');
    const footer = document.querySelector('footer');
    if (footer) pushCandidate(footer, 'FOOTER');

    Array.from(root.children).forEach((el) => pushCandidate(el));

    // Sort by vertical position
    candidates.sort((a, b) => (a.bbox?.y || 0) - (b.bbox?.y || 0));

        return {
      domSnapshot,
      viewport: { width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio || 1 },
      designTokens: {
        colors: {
          background: bodyBg,
          text: bodyColor,
                primaryButtonColor: primaryButton,
        },
        typography: { body: bodyFont, h1: h1Font, h2: h2Font },
      },
      pageInfo,
      rawSections: candidates,
    };
  });

  // --- Post-process into V5 passport ---
  const assets = { items: {}, usages: [] };
  const sections = [];

  // capture section visual metrics (hybrid CV) for first N sections
  const sectionVisualById = new Map();
  const maxSectionVisual = 24;
  for (const rs of raw.rawSections.slice(0, maxSectionVisual)) {
    try {
      const handle = await page.$(`[data-ai-section-id="${rs.sectionDomId}"]`);
      if (!handle) continue;
      const buf = await handle.screenshot({ type: 'png' });
      const metrics = await page.evaluate((b64) => window.__aiCloneHashV5(b64), buf.toString('base64'));
      sectionVisualById.set(rs.sectionDomId, metrics);
    } catch (_) {
      // ignore
    }
  }

  // asset visual metrics for "important" ones (hero_bg/icons/gallery cap)
  const assetVisualByUsageId = new Map();
  const maxAssetVisual = 40;
  let assetVisualCount = 0;

  for (const rs of raw.rawSections) {
    const { type, confidence } = classifySection(rs);
    const sectionId = stableSectionId(`${url}|${rs.domPath}|${rs.bbox?.y}|${rs.bbox?.h}`);

    const policy = {};
    if (type === SECTION_TYPES.HEADER || type === SECTION_TYPES.FOOTER) {
      policy.includeInClone = false;
      policy.reason = 'navigation/header/footer';
    } else {
      policy.includeInClone = true;
    }

    const visual = sectionVisualById.get(rs.sectionDomId) || null;

    // content (minimal, can be expanded later)
    const content = {};
    if (type === SECTION_TYPES.HERO_BANNER) {
      content.heading = rs.headline || null;
      content.text = rs.textSample || null;
    } else if (type === SECTION_TYPES.RICH_TEXT) {
      content.text = rs.textSample || null;
    }

    const sectionNode = {
      id: sectionId,
      type,
      confidence,
      bbox: rs.bbox,
      domPath: rs.domPath,
      policy,
      visual,
      content,
      assets: [],
      styleHints: {},
    };

    // map assets inside section
    const inHeader = type === SECTION_TYPES.HEADER;
    for (const a of (rs.assets || [])) {
      let kind = a.kind === 'svg' ? ASSET_KINDS.SVG : ASSET_KINDS.IMAGE;

      // resolve key for registry
      let registryKey = null;
      let sourceUrl = null;
      let normalized = null;

      if (kind === ASSET_KINDS.SVG && a.svgOuterHTML) {
        registryKey = `inline_svg:${a.svgOuterHTML.length}:${a.domPath || ''}`;
      } else {
        sourceUrl = a.src || null;
        normalized = normalizeUrl(sourceUrl);
        if (!normalized) continue;
        registryKey = normalized;
      }

      const assetId = stableAssetId(kind, registryKey);
      const role = roleForAsset({ sectionType: type, asset: a, inHeader });

      if (!assets.items[assetId]) {
        assets.items[assetId] = {
          sourceUrl: sourceUrl || null,
          normalizedUrl: normalized || null,
          kind,
          mime: null,
          width: a.width || null,
          height: a.height || null,
          hash: {},
          dominantColor: null,
        };
        if (kind === ASSET_KINDS.SVG && a.svgOuterHTML) {
          // store a bounded svg hash for later upload decisions
          const crypto = require('crypto');
          assets.items[assetId].hash.sha1 = crypto.createHash('sha1').update(a.svgOuterHTML).digest('hex');
        }
      }

      assets.usages.push({
        assetId,
        sectionId,
        role,
        bbox: a.bbox || null,
        domPath: a.domPath || null,
        usageId: a.usageId || null,
        isBackground: !!a.isBackground,
      });

      sectionNode.assets.push({ assetId, role });

      // hybrid CV for selected assets (best-effort)
      const shouldHash =
        assetVisualCount < maxAssetVisual &&
        (role === ASSET_ROLES.HERO_BG || role === ASSET_ROLES.ICON || role === ASSET_ROLES.GALLERY);

      if (shouldHash && a.usageId && !assetVisualByUsageId.has(a.usageId)) {
        try {
          const h = await page.$(`[data-ai-asset-usage-id="${a.usageId}"]`);
          if (h) {
            const buf = await h.screenshot({ type: 'png' });
            const metrics = await page.evaluate((b64) => window.__aiCloneHashV5(b64), buf.toString('base64'));
            assetVisualByUsageId.set(a.usageId, metrics);
            assetVisualCount++;

            if (metrics?.dhash64) assets.items[assetId].hash.dhash64 = metrics.dhash64;
            if (metrics?.dominantColor) assets.items[assetId].dominantColor = metrics.dominantColor;
          }
        } catch (_) {
          // ignore
        }
      }
    }

    sections.push(sectionNode);
  }

    const passport = {
    passportVersion: PASSPORT_VERSION,
    url,
    scannedAt: new Date().toISOString(),
    capture: {
      viewport: raw.viewport,
      fullPageScreenshot: screenshotPath,
      domSnapshot: raw.domSnapshot,
    },
    designTokens: raw.designTokens,
    pageInfo: raw.pageInfo,
    assets,
    sectionTree: {
      id: 's_root',
      type: SECTION_TYPES.PAGE,
      children: sections,
    },
    extractionDiagnostics: {
      unknownSections: sections.filter((s) => s.type === SECTION_TYPES.UNKNOWN).length,
      lowConfidenceSectionIds: sections.filter((s) => (s.confidence || 0) < 0.6).map((s) => s.id),
      notes: ['Header/footer excluded by policy when detected.'],
    },
  };

  const validation = validatePassportV5(passport);
  if (!validation.ok) {
    console.warn('⚠️ Passport V5 validation warnings:', validation.errors);
  }

  await browser.close();

  fs.writeJsonSync(OUTPUT_FILE_V5, passport, { spaces: 2 });
  console.log(`💾 Donor Passport V5 saved to: ${OUTPUT_FILE_V5}`);
}

if (require.main === module) {
    const targetUrl = process.argv[2];
    deepInspector(targetUrl);
}

module.exports = { deepInspector };
