const puppeteer = require('puppeteer');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const WORKSPACE_DIR = path.resolve(__dirname, '../workspace');
const SCREENSHOTS_DIR = path.join(WORKSPACE_DIR, 'screenshots');
const LATEST_DIR = path.join(SCREENSHOTS_DIR, 'latest');
const SECTIONS_DIR = path.join(LATEST_DIR, 'sections');
const OUTPUT_FILE = path.join(WORKSPACE_DIR, 'capture_pack.v6.json');

fs.ensureDirSync(SCREENSHOTS_DIR);
fs.ensureDirSync(LATEST_DIR);
fs.ensureDirSync(SECTIONS_DIR);

function sha1(x) {
  return crypto.createHash('sha1').update(String(x)).digest('hex');
}

async function autoScroll(page, maxScrolls = 14) {
  await page.evaluate(async (max) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let i = 0;
    let lastY = -1;
    while (i < max) {
      window.scrollBy(0, Math.max(350, Math.floor(window.innerHeight * 0.85)));
      await sleep(380);
      const y = window.scrollY;
      if (y === lastY) break;
      lastY = y;
      i++;
    }
    window.scrollTo(0, 0);
  }, maxScrolls);
}

function clampBBox(b, pageW, pageH) {
  const x = Math.max(0, Math.min(pageW - 1, b.x));
  const y = Math.max(0, Math.min(pageH - 1, b.y));
  const w = Math.max(1, Math.min(pageW - x, b.w));
  const h = Math.max(1, Math.min(pageH - y, b.h));
  return { x, y, w, h };
}

async function capturePack(url) {
  if (!url) {
    console.error('Please provide a URL: node tools/capture-pack.js <url>');
    process.exit(1);
  }

  console.log(`📦 V6 Capture Pack: ${url}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  } catch (e) {
    console.warn(`Initial load warning: ${e.message}. Continuing...`);
  }

  await autoScroll(page);

  // Full page screenshot
  // Write into screenshots/latest (overwrite), so workspace doesn't grow over time
  const fullPath = path.join(LATEST_DIR, 'donor_full_v6.png');
  await page.screenshot({ path: fullPath, fullPage: true });

  const raw = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      // ignore offscreen far below? no, we scrolled
      return true;
    };

    const bboxAbs = (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + window.scrollX), y: Math.round(r.y + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) };
    };

    const cssPath = (el) => {
      const parts = [];
      let cur = el;
      let depth = 0;
      while (cur && cur.nodeType === 1 && depth < 7) {
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

    const pickText = (el) => (el?.innerText || '').replace(/\s+/g, ' ').trim();

    const getStyle = (el) => {
      const s = window.getComputedStyle(el);
      return {
        display: s.display,
        position: s.position,
        fontFamily: s.fontFamily,
        fontSize: s.fontSize,
        fontWeight: s.fontWeight,
        lineHeight: s.lineHeight,
        color: s.color,
        backgroundColor: s.backgroundColor,
        textAlign: s.textAlign,
        gap: s.gap,
        justifyContent: s.justifyContent,
        alignItems: s.alignItems,
      };
    };

    const doc = {
      title: document.title || null,
      lang: document.documentElement.getAttribute('lang') || null,
      url: location.href,
    };

    const viewport = { width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio || 1 };

    // DOM digest: visible, content-bearing nodes
    const digest = [];
    const maxNodes = 4500;

    const candidates = Array.from(document.querySelectorAll('h1,h2,h3,p,li,a,button,img,svg,section,header,footer,main,article,div'));
    for (const el of candidates) {
      if (digest.length >= maxNodes) break;
      if (!isVisible(el)) continue;

      const tag = el.tagName.toLowerCase();
      const b = bboxAbs(el);
      const text = (tag === 'img' || tag === 'svg') ? '' : pickText(el);
      const href = tag === 'a' ? (el.getAttribute('href') || null) : null;
      const src = tag === 'img' ? (el.currentSrc || el.src || null) : null;
      const alt = tag === 'img' ? (el.alt || null) : null;
      const ariaLabel = el.getAttribute('aria-label') || null;

      // background-image
      const bg = window.getComputedStyle(el).backgroundImage;
      let bgUrl = null;
      if (bg && bg !== 'none') {
        const m = bg.match(/url\(["']?(.*?)["']?\)/i);
        if (m && m[1]) bgUrl = m[1];
      }

      const isTextLike = text && text.length >= 2;
      const isAssetLike = !!src || !!bgUrl || tag === 'svg';
      const isCtaLike = tag === 'button' || (tag === 'a' && text.length > 0);

      // Reduce noise: keep nodes that carry meaning or assets or structural sectioning
      const keep =
        isTextLike ||
        isAssetLike ||
        isCtaLike ||
        tag === 'section' || tag === 'header' || tag === 'footer' || tag === 'main' || tag === 'article';

      if (!keep) continue;

      digest.push({
        tag,
        bbox: b,
        domPath: cssPath(el),
        text: text ? text.slice(0, 600) : null,
        href,
        src,
        alt,
        ariaLabel,
        bgUrl,
        style: getStyle(el),
      });
    }

    // Section candidates: large block-level regions in reading order
    const sectionEls = [];
    const root = document.querySelector('main') || document.body;
    const topKids = Array.from(root.children);
    for (const el of topKids) {
      if (!isVisible(el)) continue;
      const b = bboxAbs(el);
      if (b.h < 160 || b.w < Math.floor(window.innerWidth * 0.55)) continue;
      sectionEls.push({
        tag: el.tagName.toLowerCase(),
        domPath: cssPath(el),
        bbox: b,
        textSample: pickText(el).slice(0, 300) || null,
      });
    }
    // include header/footer if exist
    const header = document.querySelector('header');
    if (header && isVisible(header)) sectionEls.unshift({ tag: 'header', domPath: cssPath(header), bbox: bboxAbs(header), textSample: pickText(header).slice(0, 200) || null });
    const footer = document.querySelector('footer');
    if (footer && isVisible(footer)) sectionEls.push({ tag: 'footer', domPath: cssPath(footer), bbox: bboxAbs(footer), textSample: pickText(footer).slice(0, 200) || null });

    sectionEls.sort((a, b) => (a.bbox?.y || 0) - (b.bbox?.y || 0));

    return { doc, viewport, digest, sectionCandidates: sectionEls };
  });

  // Prepare crops and per-section node subsets
  const pageW = raw.viewport.width;
  const pageH = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));

  const sections = [];
  const maxSections = 22; // keep cost bounded; QA loop can request rerun with higher cap
  // Clear previous crops in screenshots/latest/sections to prevent accumulation
  fs.emptyDirSync(SECTIONS_DIR);
  for (let i = 0; i < Math.min(maxSections, raw.sectionCandidates.length); i++) {
    const s = raw.sectionCandidates[i];
    const id = `sec_${sha1(`${url}|${s.domPath}|${s.bbox.x}|${s.bbox.y}|${s.bbox.w}|${s.bbox.h}`).slice(0, 10)}`;

    const bbox = clampBBox(s.bbox, pageW, pageH);
    const cropPath = path.join(SECTIONS_DIR, `${String(i + 1).padStart(2, '0')}_${id}.png`);

    // Clip screenshot (must be within viewport coordinate system of full-page screenshot; Puppeteer accepts clip in page coords)
    try {
      await page.screenshot({
        path: cropPath,
        clip: { x: bbox.x, y: bbox.y, width: bbox.w, height: bbox.h },
      });
    } catch (e) {
      console.warn(`⚠️ Crop failed for section ${id}: ${e.message}`);
    }

    // Nodes that overlap this bbox
    const nodes = raw.digest
      .filter((n) => {
        const b = n.bbox;
        if (!b) return false;
        const xOverlap = Math.max(0, Math.min(bbox.x + bbox.w, b.x + b.w) - Math.max(bbox.x, b.x));
        const yOverlap = Math.max(0, Math.min(bbox.y + bbox.h, b.y + b.h) - Math.max(bbox.y, b.y));
        const area = xOverlap * yOverlap;
        return area >= 25; // at least some overlap
      })
      .slice(0, 900); // cap per section

    sections.push({
      id,
      order: i + 1,
      tag: s.tag,
      domPath: s.domPath,
      bbox,
      cropPath,
      textSample: s.textSample,
      nodes,
    });
  }

  const pack = {
    capturePackVersion: '6.0',
    generatedAt: new Date().toISOString(),
    url,
    doc: raw.doc,
    viewport: raw.viewport,
    fullPageScreenshot: fullPath,
    sections,
    diagnostics: {
      totalDigestNodes: raw.digest.length,
      totalSectionCandidates: raw.sectionCandidates.length,
      emittedSections: sections.length,
      notes: [
        'Use sections[i].cropPath + sections[i].nodes as primary inputs to the LLM for SectionSpec generation.',
        'If content is missing (lazy load), rerun capture-pack with bigger scroll budget or different viewport.',
      ],
    },
  };

  await browser.close();
  await fs.writeJson(OUTPUT_FILE, pack, { spaces: 2 });
  console.log(`✅ Capture pack saved: ${OUTPUT_FILE}`);
  console.log(`✅ Section crops saved under: ${SECTIONS_DIR}`);
}

if (require.main === module) {
  const url = process.argv[2];
  capturePack(url).catch((err) => {
    console.error('❌ capture-pack failed:', err?.message || err);
    process.exit(1);
  });
}

module.exports = { capturePack };

