require('dotenv').config();
const { shopifyApi, LATEST_API_VERSION, Session } = require('@shopify/shopify-api');
require('@shopify/shopify-api/adapters/node');
const fs = require('fs-extra');
const path = require('path');

// Paths
const DB_PATH = path.resolve(__dirname, '../db.json');
const SETTINGS_PATH = path.resolve(__dirname, '../config/settings.json');
const ACTIVE_SCOPES_PATH = path.resolve(__dirname, '../config/active_scopes.json');

async function initSession() {
    // 1. Read Current Shop Config
    const settings = await fs.readJson(SETTINGS_PATH);
    const targetShop = settings.shop;

    if (!targetShop) {
        throw new Error("Target shop not defined in config/settings.json");
    }

    // 2. Read Active Scopes
    const scopes = await fs.readJson(ACTIVE_SCOPES_PATH);

    // 3. Read Database for Token
    if (!fs.existsSync(DB_PATH)) {
        throw new Error("db.json not found. Please initialize the database.");
    }
    const db = await fs.readJson(DB_PATH);
    const shopData = db[targetShop];

    if (!shopData || !shopData.accessToken) {
        throw new Error(`No access token found for shop ${targetShop} in db.json. Please run the auth flow first.`);
    }

    console.log(`Initializing session for ${targetShop}...`);

    // 4. Initialize Shopify API Library
    const shopify = shopifyApi({
        apiKey: process.env.SHOPIFY_API_KEY,      // From .env
        apiSecretKey: process.env.SHOPIFY_API_SECRET, // From .env
        scopes: scopes,
        hostName: 'localhost', // Not used for custom store app calls but required param
        apiVersion: LATEST_API_VERSION,
        isCustomStoreApp: true, // IMPORTANT: For using Admin API token directly
        adminApiAccessToken: shopData.accessToken,
        isEmbeddedApp: false,
    });

    // 5. Create Session Object
    const session = new Session({
        id: `offline_${targetShop}`,
        shop: targetShop,
        state: 'state',
        isOnline: false,
        accessToken: shopData.accessToken,
        scope: scopes.join(','),
    });

    // 6. Create Client
    const client = new shopify.clients.Graphql({ session });

    return { shopify, session, client, targetShop };
}

// Self-test if run directly
if (require.main === module) {
    initSession()
        .then(async ({ client, targetShop }) => {
            console.log(`✅ Successfully initialized client for ${targetShop}`);
            // Test query
            try {
                const response = await client.query({
                    data: `{ shop { name url } }`,
                });
                console.log("Connected to Shop:", response.body.data.shop.name);
            } catch (error) {
                console.error("Test Query Failed:", error.message);
            }
        })
        .catch(err => {
            console.error("❌ Initialization Failed:", err.message);
            process.exit(1);
        });
}

module.exports = { initSession };
