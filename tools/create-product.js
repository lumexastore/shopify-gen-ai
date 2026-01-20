const fs = require('fs-extra');
const path = require('path');
const shopify = require('../src/services/shopifyClient');
const logger = require('../src/utils/logger') || console;

const PASSPORT_FILE = path.join(__dirname, '../workspace/donor_passport.json');

async function createProduct() {
    try {
        console.log("🚀 Starting Product Creation...");

        // 1. Read Passport
        if (!fs.existsSync(PASSPORT_FILE)) {
            throw new Error(`Passport file not found at ${PASSPORT_FILE}`);
        }
        const passport = await fs.readJson(PASSPORT_FILE);
        const { productInfo, assets } = passport.data;

        // 2. Prepare Data
        // Price Parsing
        let price = '0.00';
        let compareAtPrice = null;

        const priceText = productInfo.price || '';
        const priceMatches = priceText.match(/\$(\d+\.\d{2})/g);

        if (priceMatches && priceMatches.length > 0) {
            price = priceMatches[0].replace('$', ''); // First price found
            if (priceMatches.length > 1) {
                // Heuristic: If multiple prices, usually the higher one is compare_at (original), lower is price (sale)
                // Or depending on order. In scraped text "Regular price $32.99 Sale price $99.00" (weird order in scrap?)
                // Actually standard Shopify liquid scraping often puts current price first.
                // Let's sort them. Lower is price, Higher is compare_at.
                const prices = priceMatches.map(p => parseFloat(p.replace('$', ''))).sort((a, b) => a - b);
                price = prices[0].toFixed(2);
                compareAtPrice = prices[prices.length - 1].toFixed(2);
            }
        }

        // Image Filtering
        // distinct URLs, width > 500
        const seenUrls = new Set();
        const images = (assets.detectedImages || [])
            .filter(img => {
                if (img.width < 500) return false;
                // Normalize URL to avoid query param creates duplicates
                const url = img.src.split('?')[0];
                if (seenUrls.has(url)) return false;
                seenUrls.add(url);
                return true;
            })
            .map(img => ({ src: img.src }));

        console.log(`📦 Prepared Data: 
        - Title: ${productInfo.title}
        - Price: ${price} (Compare: ${compareAtPrice})
        - Images: ${images.length} found`);

        if (images.length === 0) {
            console.warn("⚠️ No high-quality images found!");
        }

        // 3. Init Client
        await shopify.init();

        // 4. Create Product
        const payload = {
            product: {
                title: productInfo.title,
                body_html: productInfo.description,
                vendor: 'AiStore Automation',
                product_type: 'Cloned Product',
                images: images,
                variants: [
                    {
                        price: price,
                        compare_at_price: compareAtPrice,
                        inventory_management: null // Don't track inventory for now or "shopify"
                    }
                ]
            }
        };

        const result = await shopify.post('/products.json', payload);

        if (result && result.product) {
            console.log(`✅ Product Created Successfully!`);
            console.log(`🆔 ID: ${result.product.id}`);
            console.log(`🔗 Handle: ${result.product.handle}`);

            // Save Product ID to passport for next steps?
            passport.createdProductId = result.product.id;
            passport.createdProductHandle = result.product.handle;
            await fs.writeJson(PASSPORT_FILE, passport, { spaces: 2 });
        } else {
            console.error("❌ Failed to create product", result);
        }

    } catch (error) {
        console.error("❌ Error creating product:", error.message);
        if (error.response) {
            console.error("API Response:", JSON.stringify(error.response.data, null, 2));
        }
    }
}

// Run
if (require.main === module) {
    createProduct();
}

module.exports = { createProduct };
