const { initSession } = require('./session-init');
const fs = require('fs-extra');
const path = require('path');

const PASSPORT_PATH = path.resolve(__dirname, '../workspace/donor_passport.json');

async function applyThemeSettings() {
    // 1. Read Passport
    if (!fs.existsSync(PASSPORT_PATH)) {
        console.error("❌ No donor passport found in workspace/");
        process.exit(1);
    }
    const passport = await fs.readJson(PASSPORT_PATH);
    const brandDNA = passport.data.brandDNA;

    console.log("🎨 Applying Brand DNA:", brandDNA);

    // 2. Init Session
    const { shopify, session } = await initSession();
    const restClient = new shopify.clients.Rest({ session });

    // 3. Find Main Theme
    console.log("🔍 Finding Main Theme...");
    const themesResponse = await restClient.request({
        method: 'GET',
        path: 'themes',
    });

    // REST response body for themes is { themes: [...] }
    const themes = themesResponse.body.themes;
    const mainTheme = themes.find(t => t.role === 'main');

    if (!mainTheme) {
        console.error("❌ No main theme found!");
        process.exit(1);
    }
    console.log(`✅ Found Main Theme: ${mainTheme.name} (ID: ${mainTheme.id})`);

    // 4. Read Settings Asset
    console.log("📥 Fetching settings_data.json...");
    const assetResponse = await restClient.request({
        method: 'GET',
        path: `themes/${mainTheme.id}/assets`,
        query: {
            "asset[key]": "config/settings_data.json"
        }
    });

    const asset = assetResponse.body.asset;
    const currentSettings = JSON.parse(asset.value);

    // 5. Modify Settings (Mapping Protocol)
    // Deep clone to avoid side effects (simple JSON clone)
    const newSettings = JSON.parse(JSON.stringify(currentSettings));

    // Ensure structure exists
    // Fix: If 'current' is a string (preset name), resolve it to an object
    if (typeof newSettings.current === 'string') {
        const presetName = newSettings.current;
        console.log(`ℹ️ 'current' is a preset name ("${presetName}"). Resolving from presets...`);
        if (newSettings.presets && newSettings.presets[presetName]) {
            newSettings.current = JSON.parse(JSON.stringify(newSettings.presets[presetName]));
        } else {
            console.warn(`⚠️ Preset "${presetName}" not found in presets! initializing empty object.`);
            newSettings.current = {};
        }
    } else if (!newSettings.current) {
        newSettings.current = {};
    }

    // --- COLOR MAPPING ---
    // Dawn uses specific keys. We'll update the 'current' block.
    // Note: Dawn's schema might vary, but standard keys are:

    // Helper to convert rgb() to hex (Shopify prefers hex usually, but CSS works too? check theme)
    // Actually settings_data usually requires Hex.
    function rgbToHex(rgbStr) {
        if (!rgbStr) return null;
        const result = rgbStr.match(/\d+/g);
        if (!result) return null;
        return "#" + result.map(x => {
            const hex = parseInt(x).toString(16);
            return hex.length === 1 ? "0" + hex : hex;
        }).join("");
    }

    const primaryColorHex = rgbToHex(brandDNA.primaryButtonColor);
    const bgColorHex = rgbToHex(brandDNA.backgroundColor);

    if (primaryColorHex) {
        console.log(`🎨 Updating Primary Colors to ${primaryColorHex}`);
        // Update common Dawn color settings
        newSettings.current.colors_solid_button_labels = primaryColorHex;
        newSettings.current.colors_accent_1 = primaryColorHex; // Usually buttons/links
        newSettings.current.colors_outline_button_labels = primaryColorHex;
    }

    if (bgColorHex) {
        console.log(`🎨 Updating Background to ${bgColorHex}`);
        newSettings.current.colors_background_1 = bgColorHex;
    }

    // --- FONT MAPPING (Placeholder) ---
    // Fonts are complex objects in Shopify. We will skip for now to avoid breaking the theme.
    console.log("⚠️ Font mapping skipped (Requires advanced schema matching).");

    // 6. Push Update
    console.log("📤 Uploading updated settings...");
    await restClient.request({
        method: 'PUT',
        path: `themes/${mainTheme.id}/assets`,
        data: {
            asset: {
                key: "config/settings_data.json",
                value: JSON.stringify(newSettings)
            }
        }
    });

    console.log("✅ Theme Settings Updated Successfully!");
}

applyThemeSettings().catch(err => {
    console.error("❌ Application Failed:", err);
    // Log detailed graphql errors if any (though we are using REST now)
    if (err.response && err.response.body && err.response.body.errors) {
        console.error("Shopify Errors:", JSON.stringify(err.response.body.errors, null, 2));
    }
});
