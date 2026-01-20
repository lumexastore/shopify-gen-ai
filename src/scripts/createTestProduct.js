const shopifyClient = require('../services/shopifyClient');
const logger = require('../utils/logger');
const config = require('../config');

// Random suffix to avoid duplications
const RUN_ID = Math.floor(Math.random() * 1000);

const testProduct = {
    title: `AI Test Product #${RUN_ID}`,
    body_html: "<strong>This product was automatically created by the Automation Hub.</strong><br>It includes a test image.",
    vendor: "AI Lab",
    product_type: "Test Item",
    status: "draft", // Start as draft
    variants: [
        {
            price: "42.00",
            sku: `AI-TEST-${RUN_ID}`,
            inventory_management: "shopify",
            inventory_policy: "continue"
        }
    ],
    images: [
        {
            // Simple Base64 Green Dot to verify upload works regardless of external URL issues
            attachment: "iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg=="
        }
    ]
};

const run = async () => {
    try {
        logger.info(`Initializing client for ${config.shop}...`);
        await shopifyClient.init(config.shop);

        logger.info('Creating test product with Base64 Image...');

        const response = await shopifyClient.post('/products.json', { product: testProduct });

        logger.success('------------------------------------------------');
        logger.success('PRODUCT CREATED SUCCESSFULLY!');
        logger.success(`ID: ${response.product.id}`);
        logger.success(`Title: ${response.product.title}`);

        // Log Image Status
        if (response.product.images && response.product.images.length > 0) {
            logger.success(`Image Count: ${response.product.images.length}`);
            logger.success(`First Image ID: ${response.product.images[0].id}`);
        } else {
            logger.error('WARNING: Product created but NO IMAGES returned in response!');
        }

        logger.success(`Admin URL: https://admin.shopify.com/store/${config.shop.replace('.myshopify.com', '')}/products/${response.product.id}`);
        logger.success('------------------------------------------------');

    } catch (error) {
        logger.error('Failed to create product:', error.message);
        if (error.response) {
            logger.error('API Details:', JSON.stringify(error.response.data, null, 2));
        }
    }
};

run();
