const fs = require('fs-extra');
const path = require('path');
const shopify = require('../src/services/shopifyClient');

// ID from previous step
const PRODUCT_ID = '7790779793450';
const CAPTURE_FILE = path.join(__dirname, '../workspace/capture_pack.v6.json');

async function run() {
    await shopify.init();

    // Read capture pack to find title/images
    const pack = await fs.readJson(CAPTURE_FILE);

    // Simple heuristic: Title is usually H1 in the first few sections
    let title = "Neck Support Pillow";
    let body_html = "<p>Product description from clone.</p>";

    // Find H1
    for (const section of pack.sections) {
        const createProductNode = section.nodes.find(n => n.tag === 'h1');
        if (createProductNode) {
            title = createProductNode.text;
            break;
        }
    }

    // If no H1, try H2 in first 2 sections
    if (title === "Neck Support Pillow") {
        for (let i = 0; i < Math.min(3, pack.sections.length); i++) {
            const h2 = pack.sections[i].nodes.find(n => n.tag === 'h2');
            if (h2) {
                title = h2.text;
                break;
            }
        }
    }

    // Find Images (first 5 large images)
    const images = [];
    const seen = new Set();

    // Collect images from digest
    // We can't access digest directly because capture_pack 'sections' only has a subset of nodes. 
    // But section nodes have 'src'.
    for (const section of pack.sections) {
        for (const n of section.nodes) {
            if (n.tag === 'img' && n.src && n.bbox.w > 200 && n.bbox.h > 200) {
                // Clean URL
                const url = n.src.split('?')[0];
                if (!seen.has(url)) {
                    seen.add(url);
                    images.push({ src: n.src });
                }
            }
        }
        if (images.length > 5) break;
    }

    console.log(`Updating Product ${PRODUCT_ID}`);
    console.log(`New Title: ${title}`);
    console.log(`Found ${images.length} images`);

    try {
        const payload = {
            product: {
                id: PRODUCT_ID,
                title: title,
                images: images.length > 0 ? images : undefined
                // Note: Updating images might append or replace depending on API, usually replaces if IDS not provided.
            }
        };

        await shopify.put(`/products/${PRODUCT_ID}.json`, payload);
        console.log("✅ Product updated.");
    } catch (e) {
        console.error("❌ Failed to update:", e.message);
        if (e.response) console.error(JSON.stringify(e.response.data));
    }
}

run();
