const express = require('express');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

const DB_PATH = path.join(__dirname, '../../db.json');

const startAuthServer = async (shop) => {
    // Dynamic import for 'open' (ESM package)
    const open = (await import('open')).default;

    return new Promise((resolve, reject) => {
        const app = express();

        // 1. Install Route - Redirects to Shopify
        app.get('/install', (req, res) => {
            // Robustly clean the shop URL
            const shopClean = shop.replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/, '').replace(/\/$/, '');
            const shopUrl = `${shopClean}.myshopify.com`;
            const redirectUri = `${config.host}/callback`;
            const installUrl = `https://${shopUrl}/admin/oauth/authorize?client_id=${config.apiKey}&scope=${config.scopes}&redirect_uri=${redirectUri}&access_mode=value`; // access_mode=value for offline token (deprecated name but often works, or 'offline')
            // Modern Shopify uses 'grant_options[]=value' for offline access explicitly if needed, but 'access_mode' is the legacy query param.
            // Official docs say: https://{shop}.myshopify.com/admin/oauth/authorize?client_id={api_key}&scope={scopes}&redirect_uri={redirect_uri}&state={nonce}&grant_options[]={access_mode}
            // We'll use grant_options[]=value (which means offline access/per-user=false).

            const authUrl = `https://${shopUrl}/admin/oauth/authorize?` +
                `client_id=${config.apiKey}` +
                `&scope=${config.scopes}` +
                `&redirect_uri=${redirectUri}` +
                `&grant_options[]=value`; // Requesting offline access

            logger.info(`DEBUG: shop value = '${shop}'`);
            logger.info(`DEBUG: shopUrl value = '${shopUrl}'`);
            logger.info(`Redirecting to: ${authUrl}`);
            res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.redirect(authUrl);
        });

        // 2. Callback Route - Exchanges Code for Token
        app.get('/callback', async (req, res) => {
            const { code, shop: returnShop } = req.query;

            if (!code) {
                return res.status(400).send('Missing authorization code');
            }

            try {
                logger.info(`Received code for shop: ${returnShop}, exchanging for token...`);

                const tokenResponse = await axios.post(`https://${returnShop}/admin/oauth/access_token`, {
                    client_id: config.apiKey,
                    client_secret: config.apiSecret,
                    code: code
                });

                const accessToken = tokenResponse.data.access_token;

                // Save to db.json
                const db = await fs.readJson(DB_PATH).catch(() => ({}));
                db[returnShop] = {
                    accessToken: accessToken,
                    updatedAt: new Date().toISOString()
                };

                // If we want a 'current' shop context
                db.currentShop = returnShop;

                await fs.writeJson(DB_PATH, db, { spaces: 2 });

                logger.success(`Token acquired and saved for ${returnShop}`);
                res.send('<h1>Authorization Successful!</h1><p>You can close this tab and return to the terminal.</p>');

                // Close server and resolve
                server.close(() => {
                    logger.info('Auth server closed.');
                    resolve(accessToken);
                });

            } catch (error) {
                logger.error('Error exchanging token:', error.response ? error.response.data : error.message);
                res.status(500).send('Error during authentication.');
                reject(error);
            }
        });

        const server = app.listen(config.port, async () => {
            // Keep process alive
            const keepAlive = setInterval(() => { }, 1000 * 60 * 60);

            // Auto open browser
            logger.info(`Opening browser to install app on ${shop}...`);
            try {
                await open(`http://localhost:${config.port}/install`);
                logger.info('Browser open command executed.');
            } catch (err) {
                logger.error('Failed to open browser:', err);
                logger.info(`PLEASE OPEN THIS URL MANUALLY: http://localhost:${config.port}/install`);
            }
        });
    });
};

module.exports = { startAuthServer };
