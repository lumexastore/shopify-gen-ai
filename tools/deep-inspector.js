const puppeteer = require('puppeteer');
const fs = require('fs-extra');
const path = require('path');

// Paths
const WORKSPACE_DIR = path.resolve(__dirname, '../workspace');
const SCREENSHOTS_DIR = path.join(WORKSPACE_DIR, 'screenshots');
const OUTPUT_FILE = path.join(WORKSPACE_DIR, 'donor_passport.json');

// Ensure directories
fs.ensureDirSync(SCREENSHOTS_DIR);

async function deepInspector(url) {
    if (!url) {
        console.error("Please provide a URL as an argument.");
        process.exit(1);
    }

    console.log(`🕵️ Deep Inspector launching for: ${url}`);
    const browser = await puppeteer.launch({
        headless: "new",
        defaultViewport: { width: 1920, height: 1080 }
    });

    const page = await browser.newPage();

    // Improved navigation
    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    } catch (e) {
        console.warn(`Initial load warning: ${e.message}. Continuing...`);
    }

    // Screenshot
    const screenshotPath = path.join(SCREENSHOTS_DIR, `full_page_${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`📸 Screenshot saved to: ${screenshotPath}`);

    // Extract Data
    const analysis = await page.evaluate(() => {
        // --- Helper: Get Computed Style ---
        const getStyle = (el, prop) => window.getComputedStyle(el).getPropertyValue(prop);

        // --- Brand DNA ---
        // Basic heuristic for primary button: look for button or a tags with explicit background colors
        let primaryButton = null;
        const buttons = Array.from(document.querySelectorAll('button, a.btn, a.button, input[type="submit"]'));
        // Find the 'most colorful' button or simply the first prominent one? 
        // Let's filter for buttons with non-white/transparent backgrounds
        const viableButtons = buttons.filter(b => {
            const bg = window.getComputedStyle(b).backgroundColor;
            return bg !== 'rgba(0, 0, 0, 0)' && bg !== 'rgb(255, 255, 255)' && bg !== 'transparent';
        });
        if (viableButtons.length > 0) {
            primaryButton = window.getComputedStyle(viableButtons[0]).backgroundColor;
        }

        const bodyBg = getStyle(document.body, 'background-color');

        // Fonts
        const h1 = document.querySelector('h1');
        const h2 = document.querySelector('h2');
        const bodyFont = getStyle(document.body, 'font-family');
        const h1Font = h1 ? getStyle(h1, 'font-family') : null;
        const h2Font = h2 ? getStyle(h2, 'font-family') : null;

        // --- Structure ---
        // Sample a few main containers
        const containers = [];
        const possibleContainers = Array.from(document.querySelectorAll('main, section, div[class*="container"], div[class*="wrapper"]'));

        // Take top 5 largest by height
        possibleContainers.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);

        possibleContainers.slice(0, 5).forEach(el => {
            const style = window.getComputedStyle(el);
            containers.push({
                tag: el.tagName,
                className: el.className,
                width: style.width,
                padding: style.padding,
                margin: style.margin,
                display: style.display,
                isGridOrFlex: style.display.includes('flex') || style.display.includes('grid')
            });
        });

        // --- Assets ---
        // Images > 200px
        const images = [];
        document.querySelectorAll('img').forEach(img => {
            if (img.naturalWidth > 200 || img.width > 200) {
                images.push({
                    src: img.src,
                    alt: img.alt,
                    width: img.naturalWidth || img.width,
                    height: img.naturalHeight || img.height
                });
            }
        });

        return {
            brandDNA: {
                primaryButtonColor: primaryButton,
                backgroundColor: bodyBg,
                typography: {
                    body: bodyFont,
                    h1: h1Font,
                    h2: h2Font
                }
            },
            structure: {
                mainContainers: containers
            },
            assets: {
                detectedImages: images
            },
            productInfo: {
                title: (() => {
                    const h1 = document.querySelector('h1');
                    return h1 ? h1.innerText.trim() : (document.querySelector('meta[property="og:title"]')?.content || 'Unknown Product');
                })(),
                price: (() => {
                    // Try common price selectors
                    const priceEls = ['.price', '.product-price', '.product__price', 'span.money', '[data-product-price]'];
                    for (const sel of priceEls) {
                        const el = document.querySelector(sel);
                        if (el && el.innerText.match(/\d/)) return el.innerText.trim();
                    }
                    return document.querySelector('meta[property="product:price:amount"]')?.content || '0.00';
                })(),
                description: (() => {
                    const descEls = ['.product-description', '.product__description', '.rte', '#description'];
                    for (const sel of descEls) {
                        const el = document.querySelector(sel);
                        if (el && el.innerText.length > 20) return el.innerHTML; // Keep HTML for description
                    }
                    return document.querySelector('meta[name="description"]')?.content || '';
                })()
            }
        };
    });

    await browser.close();

    // Save Output
    const passport = {
        url: url,
        scannedAt: new Date(),
        screenshot: screenshotPath,
        data: analysis
    };

    fs.writeJsonSync(OUTPUT_FILE, passport, { spaces: 2 });
    console.log(`💾 Donor Passport saved to: ${OUTPUT_FILE}`);
}

// Run if called directly
if (require.main === module) {
    const targetUrl = process.argv[2];
    deepInspector(targetUrl);
}

module.exports = { deepInspector };
