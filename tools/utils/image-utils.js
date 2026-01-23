const fs = require('fs-extra');
const path = require('path');
const puppeteer = require('puppeteer');

/**
 * Checks if an image is "large" (e.g. height > 1800px).
 * If so, slices it into overlapping chunks.
 * Returns an array of file paths (including the original if no split needed, or new chunk paths).
 * 
 * @param {string} imagePath - Absolute path to the source image
 * @param {object} options 
 * @returns {Promise<string[]>} - Array of absolute paths to the chunks
 */
async function sliceImageIfLarge(imagePath, { maxH = 1800, overlap = 200 } = {}) {
    if (!imagePath || !(await fs.pathExists(imagePath))) return [];

    // Launch a lightweight instance just for checking dim / cropping
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();

    try {
        // file:// protocol for local access
        const fileUrl = `file://${imagePath.replace(/\\/g, '/')}`;
        await page.goto(fileUrl);

        // Get dimensions
        const dims = await page.evaluate(() => {
            const img = document.querySelector('img');
            return { w: img.naturalWidth, h: img.naturalHeight };
        });

        if (dims.h <= maxH) {
            // No slicing needed
            await browser.close();
            return [imagePath];
        }

        // Need slicing
        const chunks = [];
        const chunksDir = path.join(path.dirname(imagePath), 'chunks');
        await fs.ensureDir(chunksDir);
        const baseName = path.basename(imagePath, path.extname(imagePath));

        let y = 0;
        let index = 1;

        // Set viewport to match image width to avoid scaling issues? 
        // Actually, screenshot 'clip' works in px coordinates. 
        // We just need to make sure the viewport is big enough or just ignore it if clip is absolute.
        await page.setViewport({ width: Math.max(800, dims.w), height: Math.max(800, dims.h) });

        while (y < dims.h) {
            // Height for this chunk
            const chunkH = Math.min(maxH, dims.h - y);
            const outPath = path.join(chunksDir, `${baseName}_part${index}.png`);

            await page.screenshot({
                path: outPath,
                clip: {
                    x: 0,
                    y: y,
                    width: dims.w,
                    height: chunkH
                }
            });

            chunks.push(outPath);

            // Stop if we just finished the last part
            if (y + chunkH >= dims.h) break;

            // Move Y forward, but minus overlap
            y += (maxH - overlap);
            index++;
        }

        await browser.close();
        return chunks;

    } catch (err) {
        console.error('Snapshot error:', err);
        await browser.close();
        // Fallback: return original
        return [imagePath];
    }
}

module.exports = { sliceImageIfLarge };
