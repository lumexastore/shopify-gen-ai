require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Load settings.json
const settingsPath = path.join(__dirname, 'settings.json');
let settings = {};
try {
    const rawSettings = fs.readFileSync(settingsPath, 'utf-8');
    settings = JSON.parse(rawSettings);
} catch (error) {
    console.error('ERROR: Could not load src/config/settings.json', error);
}

const config = {
    // Secrets from .env
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecret: process.env.SHOPIFY_API_SECRET,
    host: process.env.HOST || 'http://localhost:4000',
    port: process.env.PORT || 4000,

    // Mutable settings from settings.json
    shop: settings.shop,
    scopes: settings.scopes
};

if (!config.apiKey || !config.apiSecret) {
    console.error('CRITICAL: SHOPIFY_API_KEY or SHOPIFY_API_SECRET is missing from .env');
}

if (!config.shop || !config.scopes) {
    console.error('CRITICAL: shop or scopes missing from src/config/settings.json');
}

module.exports = config;
