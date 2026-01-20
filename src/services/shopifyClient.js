const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');
const config = require('../config');

const DB_PATH = path.join(__dirname, '../../db.json');

class ShopifyClient {
    constructor() {
        this.client = null;
        this.shop = null;
    }

    async init(shopName) {
        this.shop = shopName || config.shop;

        if (!this.shop) {
            throw new Error('Shop name is required to initialize client.');
        }

        const db = await fs.readJson(DB_PATH).catch(() => ({}));
        const tokenData = db[this.shop];

        if (!tokenData || !tokenData.accessToken) {
            throw new Error(`NO_TOKEN: No access token found for shop ${this.shop}`);
        }

        const shopClean = this.shop.replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/, '').replace(/\/$/, '');
        const shopUrl = `${shopClean}.myshopify.com`;

        this.client = axios.create({
            baseURL: `https://${shopUrl}/admin/api/2024-01`, // Using a recent API version
            headers: {
                'X-Shopify-Access-Token': tokenData.accessToken,
                'Content-Type': 'application/json'
            }
        });

        // Interceptor for Rate Limits (429)
        this.client.interceptors.response.use(
            response => response,
            async error => {
                const { config, response } = error;
                if (response && response.status === 429) {
                    const retryAfter = response.headers['retry-after']
                        ? parseFloat(response.headers['retry-after']) * 1000
                        : 2000;

                    logger.warn(`Rate limited! Waiting ${retryAfter}ms before retrying...`);

                    await new Promise(resolve => setTimeout(resolve, retryAfter));

                    return this.client(config);
                }
                return Promise.reject(error);
            }
        );

        logger.info(`Shopify Client initialized for ${this.shop}`);
    }

    async get(url, params = {}) {
        this._checkInit();
        try {
            const res = await this.client.get(url, { params });
            return res.data;
        } catch (err) {
            this._handleError(err, url);
        }
    }

    async post(url, data) {
        this._checkInit();
        try {
            const res = await this.client.post(url, data);
            return res.data;
        } catch (err) {
            this._handleError(err, url);
        }
    }

    async put(url, data) {
        this._checkInit();
        try {
            const res = await this.client.put(url, data);
            return res.data;
        } catch (err) {
            this._handleError(err, url);
        }
    }

    async delete(url) {
        this._checkInit();
        try {
            const res = await this.client.delete(url);
            return res.data;
        } catch (err) {
            this._handleError(err, url);
        }
    }

    _checkInit() {
        if (!this.client) {
            throw new Error('Shopify Client not initialized. Call init() first.');
        }
    }

    _handleError(err, url) {
        if (err.response) {
            logger.error(`API Error [${url}]: ${err.response.status} - ${JSON.stringify(err.response.data)}`);
            throw new Error(`Shopify API Error: ${err.response.statusText}`);
        }
        logger.error(`Network/Client Error [${url}]: ${err.message}`);
        throw err;
    }
}

module.exports = new ShopifyClient();
