const puppeteer = require('puppeteer');
const fs = require('fs-extra');
const path = require('path');

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

async function screenshotPage({
  url,
  outPath,
  viewport = { width: 1440, height: 900, deviceScaleFactor: 1 },
  scrollBudget = 14,
  waitUntil = 'networkidle2',
  timeoutMs = 60000,
  storefrontPassword = null,
} = {}) {
  if (!url) throw new Error('screenshotPage: url is required');
  if (!outPath) throw new Error('screenshotPage: outPath is required');

  await fs.ensureDir(path.dirname(outPath));

  const browser = await puppeteer.launch({
    headless: 'new',
    defaultViewport: viewport,
  });

  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil, timeout: timeoutMs });
  } catch (e) {
    // Best-effort: continue even if network never idles
  }

  // Shopify storefront password page support (dev stores / password-protected storefronts)
  if (storefrontPassword) {
    try {
      const isPasswordGate = await page.evaluate(() => {
        const title = (document.title || '').toLowerCase();
        const hasPasswordInput =
          !!document.querySelector('input[type="password"]') ||
          !!document.querySelector('input[name="password"]') ||
          !!document.querySelector('form[action*="password"] input');
        const looksLikeGate =
          title.includes('password') ||
          !!document.querySelector('form[action*="/password"]') ||
          !!document.querySelector('form[action*="password"]');
        return hasPasswordInput && looksLikeGate;
      });

      if (isPasswordGate) {
        await page.type('input[type="password"], input[name="password"], form input[type="password"]', String(storefrontPassword), {
          delay: 12,
        });
        // Try submit
        const submitted = await page.evaluate(() => {
          const form =
            document.querySelector('form[action*="/password"]') ||
            document.querySelector('form[action*="password"]') ||
            document.querySelector('form');
          if (form) {
            form.submit();
            return true;
          }
          return false;
        });
        if (submitted) {
          try {
            await page.waitForNavigation({ waitUntil, timeout: timeoutMs });
          } catch (e) {
            // ignore
          }
        }

        // Important: Shopify password flow often redirects to "/" after unlock.
        // Re-navigate to the original requested URL (cookie is now set).
        try {
          await page.goto(url, { waitUntil, timeout: timeoutMs });
        } catch (e) {
          // ignore
        }
      }
    } catch (e) {
      // ignore password handling errors; proceed with best-effort screenshot
    }
  }

  await autoScroll(page, scrollBudget);
  await page.screenshot({ path: outPath, fullPage: true });

  await browser.close();
  return outPath;
}

module.exports = { screenshotPage };

