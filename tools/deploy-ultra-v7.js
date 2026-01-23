require('dotenv').config();
const shopifyClient = require('../src/services/shopifyClient');
const config = require('../src/config');
const fs = require('fs-extra');
const path = require('path');

async function deployUltraV7() {
    await shopifyClient.init(config.shop);

    const htmlPath = path.join(__dirname, '../workspace/ultra_fidelity.html');
    if (!fs.existsSync(htmlPath)) {
        throw new Error('ultra_fidelity.html not found. Run generator first.');
    }
    let ultraHtml = await fs.readFile(htmlPath, 'utf8');

    // Escape JSON string requirements if we put it into a JSON value
    // Actually, we don't need to double escape if we construct the object in JS and then JSON.stringify.

    // 1. Fetch Request to get Base Template
    // We'll trust the main theme has a product.json
    const themes = await shopifyClient.get('/themes.json');
    const themeId = themes.themes.find(t => t.role === 'main').id;

    // 2. Build the V7 Template
    // We want: Main Product Section + Custom Liquid Section (Ultra Body)
    console.log('Building V7 Ultra Template...');

    // Minimal Dawn structure for custom-liquid section
    // If the theme doesn't have a 'custom-liquid.liquid' section file, this might fail.
    // Standard Dawn has 'custom-liquid' section.

    const v7Template = {
        name: "Ultra Fidelity Clone V7",
        sections: {
            main: {
                type: "main-product",
                blocks: {
                    vendor: { type: "text", settings: { text: "{{ product.vendor }}", text_style: "uppercase" } },
                    title: { type: "title" },
                    price: { type: "price" },
                    quantity_selector: { type: "quantity_selector" },
                    buy_buttons: { type: "buy_buttons" },
                    description: { type: "description" }
                },
                block_order: ["vendor", "title", "price", "description", "quantity_selector", "buy_buttons"],
                settings: {}
            },
            ultra_body: {
                type: "custom-liquid",
                settings: {
                    custom_liquid: ultraHtml
                }
            }
        },
        order: ["main", "ultra_body"]
    };

    const templateKey = 'templates/product.haphoriz-cloned-v7.json';
    console.log(`Uploading ${templateKey} to theme ${themeId}...`);

    await shopifyClient.put(`/themes/${themeId}/assets.json`, {
        asset: {
            key: templateKey,
            value: JSON.stringify(v7Template, null, 2)
        }
    });

    // 3. Bind Product
    const productId = '7791429713962';
    const suffix = 'haphoriz-cloned-v7';
    console.log(`Binding product ${productId} to template suffix ${suffix}...`);

    await shopifyClient.put(`/products/${productId}.json`, {
        product: {
            id: productId,
            template_suffix: suffix
        }
    });

    console.log('🎉 V7 Deployment Complete!');
}

deployUltraV7().catch(console.error);
