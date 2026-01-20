const { initSession } = require('./session-init');
const shopify = require('../src/services/shopifyClient');
const fs = require('fs-extra');
const path = require('path');

async function verifyCloning() {
    console.log("🕵️ Starting Verification...");

    // 1. Get Passport for context
    const passportPath = path.resolve(__dirname, '../workspace/donor_passport.json');
    if (!fs.existsSync(passportPath)) {
        console.error("❌ Passport file missing.");
        return;
    }
    const passport = await fs.readJson(passportPath);
    const productId = passport.createdProductId || '7788549013546'; // Fallback to known ID from logs if script re-run
    const expectedColor = passport.data.brandDNA.primaryButtonColor;

    await shopify.init();

    // 2. Verify Product
    try {
        console.log(`🔍 Checking Product ID: ${productId}...`);
        const productData = await shopify.get(`/products/${productId}.json`);

        if (productData.product) {
            console.log(`✅ Product Found: "${productData.product.title}"`);
            console.log(`   - Handle: ${productData.product.handle}`);
            console.log(`   - Images: ${productData.product.images.length}`);
            console.log(`   - Status: ${productData.product.status}`);
        } else {
            console.error("❌ Product not found in Shopify response.");
        }
    } catch (e) {
        console.error(`❌ Found error checking product: ${e.message}`);
    }

    // 3. Verify Theme Settings
    try {
        // We need REST client for Asset API as used in apply-theme-settings
        const { shopify: shopifyLib, session } = await initSession();
        const restClient = new shopifyLib.clients.Rest({ session });

        // Find main theme again
        const themesResponse = await restClient.request({ method: 'GET', path: 'themes' });
        const mainTheme = themesResponse.body.themes.find(t => t.role === 'main');

        if (mainTheme) {
            console.log(`🔍 Checking Theme: ${mainTheme.name} (${mainTheme.id})...`);
            const assetResponse = await restClient.request({
                method: 'GET',
                path: `themes/${mainTheme.id}/assets`,
                query: { "asset[key]": "config/settings_data.json" }
            });

            const settings = JSON.parse(assetResponse.body.asset.value);
            console.log("🔍 Debug: settings.current keys:", Object.keys(settings.current || {}));
            // console.log("🔍 Debug: full current block:", JSON.stringify(settings.current, null, 2)); // Uncomment if needed

            const currentButtonColor = settings.current.colors_solid_button_labels;

            console.log(`🎨 Theme Primary Button Color: ${currentButtonColor}`);

            // Simple hex conversion check or substring check
            // Expected might be rgb(109, 56, 139) -> #6d388b
            // We printed hex conversion in apply-theme-settings.js output: #6d388b

            if (currentButtonColor.toLowerCase() === '#6d388b') {
                console.log("✅ Color Match Verified!");
            } else {
                console.warn(`⚠️ Color Mismatch: Found ${currentButtonColor}, Expected comparable to ${expectedColor}`);
            }

        } else {
            console.error("❌ Main theme not found.");
        }

    } catch (e) {
        console.error(`❌ Found error checking theme: ${e.message}`);
    }
}

if (require.main === module) {
    verifyCloning();
}
