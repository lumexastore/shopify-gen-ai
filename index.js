const config = require('./src/config');
const { startAuthServer } = require('./src/services/auth');
const shopifyClient = require('./src/services/shopifyClient');
const logger = require('./src/utils/logger');

process.on('uncaughtException', (err) => {
    logger.error('CRITICAL: Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});

// Ensure we have a Target Shop to work with
// We can get it from ENV or args.
const targetShop = process.argv[2] || config.shop;

logger.info('--- STARTING SHOPIFY HUB v3 (Fix: Regex Cleaning) ---');

const main = async () => {
    if (!targetShop) {
        logger.error('Target shop not defined. Set SHOP in .env or pass as argument: node index.js <shop-name>');
        process.exit(1);
    }

    logger.info(`Starting Shopify Automation Hub for: ${targetShop}`);

    try {
        // 1. Try to Initialize Client (Checks for Token)
        await shopifyClient.init(targetShop);
        logger.success('Valid token found!');

    } catch (error) {
        if (error.message.includes('NO_TOKEN')) {
            logger.warn('Token not found. Initiating Auth Flow...');

            try {
                // 2. Start Auth Server & Wait for Token
                const newToken = await startAuthServer(targetShop);
                logger.success('Auth completed! Token obtained.');

                // 3. Re-init Client
                await shopifyClient.init(targetShop);

            } catch (authError) {
                logger.error('Authentication failed:', authError);
                process.exit(1);
            }
        } else {
            logger.error('Failed to initialize client:', error);
            process.exit(1);
        }
    }

    // 4. Test API Call
    try {
        logger.info('Verifying access with /shop.json ...');
        const shopData = await shopifyClient.get('/shop.json');

        logger.success('------------------------------------------------');
        logger.success(`CONNECTED TO: ${shopData.shop.name}`);
        logger.success(`EMAIL: ${shopData.shop.email}`);
        logger.success(`CURRENCY: ${shopData.shop.currency}`);
        logger.success(`DOMAIN: ${shopData.shop.domain}`);
        logger.success('------------------------------------------------');
        logger.info('God Mode access confirmed.');

    } catch (apiError) {
        logger.error('API Verification Failed:', apiError);
    }
};

main();
