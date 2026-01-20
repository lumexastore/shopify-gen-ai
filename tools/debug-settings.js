const { initSession } = require('./session-init');
const { shopifyApi } = require('@shopify/shopify-api');
const fs = require('fs-extra');
const path = require('path');

async function dumpSettings() {
    const { shopify, session } = await initSession();
    const restClient = new shopify.clients.Rest({ session });

    // Find Main Theme
    const themesResponse = await restClient.request({ method: 'GET', path: 'themes' });
    const mainTheme = themesResponse.body.themes.find(t => t.role === 'main');

    // Fetch Settings
    const assetResponse = await restClient.request({
        method: 'GET',
        path: `themes/${mainTheme.id}/assets`,
        query: { "asset[key]": "config/settings_data.json" }
    });

    const settings = JSON.parse(assetResponse.body.asset.value);

    // Save to workspace
    const outputPath = path.resolve(__dirname, '../workspace/current_theme_settings.json');
    await fs.writeJson(outputPath, settings, { spaces: 2 });
    console.log(`💾 Settings dumped to ${outputPath}`);
}

dumpSettings();
