const shopifyClient = require('../services/shopifyClient');
const logger = require('../utils/logger');
const config = require('../config');

// The product ID provided by the user
const TARGET_PRODUCT_ID = '7788124373034';
const TEMPLATE_NAME = 'gemini-custom';
const TEMPLATE_FILE = `templates/product.${TEMPLATE_NAME}.liquid`;

// A unique, high-contrast design
const CUSTOM_TEMPLATE_CONTENT = `
{% layout none %}
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{ product.title }} - Special Edition</title>
    <style>
        body {
            background-color: #0f172a;
            color: #e2e8f0;
            font-family: 'Courier New', Courier, monospace;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            text-align: center;
        }
        .container {
            border: 2px solid #22d3ee;
            padding: 40px;
            border-radius: 12px;
            box-shadow: 0 0 20px rgba(34, 211, 238, 0.3);
            max-width: 600px;
        }
        h1 {
            color: #22d3ee;
            font-size: 2.5rem;
            margin-bottom: 20px;
            text-transform: uppercase;
            letter-spacing: 2px;
        }
        .price {
            font-size: 2rem;
            color: #4ade80;
            margin: 20px 0;
        }
        .buy-btn {
            background-color: #22d3ee;
            color: #0f172a;
            border: none;
            padding: 15px 30px;
            font-size: 1.2rem;
            font-weight: bold;
            cursor: pointer;
            text-decoration: none;
            display: inline-block;
            transition: transform 0.2s;
        }
        .buy-btn:hover {
            transform: scale(1.05);
            background-color: #67e8f9;
        }
        .image-container img {
            max-width: 100%;
            border-radius: 8px;
            margin-bottom: 20px;
            border: 1px solid #334155;
        }
        .footer {
            margin-top: 30px;
            font-size: 0.8rem;
            color: #64748b;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>{{ product.title }}</h1>
        <p><em>DESIGNED BY GEN AI AUTOMATION HUB</em></p>
        
        <div class="image-container">
            <img src="{{ product.featured_image | img_url: '600x600' }}" alt="{{ product.title }}">
        </div>

        <div class="description">
            {{ product.description }}
        </div>

        <div class="price">
            {{ product.price | money }}
        </div>

        <a href="/cart/add?id={{ product.variants.first.id }}" class="buy-btn">
            BUY NOW (AI SPECIAL)
        </a>
    </div>

    <div class="footer">
        Powered by Shopify Automation Hub
    </div>
</body>
</html>
`;

const run = async () => {
    try {
        logger.info(`Initializing client for ${config.shop}...`);
        await shopifyClient.init(config.shop);

        // 1. Find the Main (Published) Theme
        logger.info('Finding main theme...');
        const themes = await shopifyClient.get('/themes.json');
        const mainTheme = themes.themes.find(t => t.role === 'main');

        if (!mainTheme) {
            throw new Error('No main theme found!');
        }

        logger.success(`Found main theme: ${mainTheme.name} (ID: ${mainTheme.id})`);

        // 2. Upload Custom Template
        logger.info(`Uploading custom template: ${TEMPLATE_FILE}...`);
        await shopifyClient.put(`/themes/${mainTheme.id}/assets.json`, {
            asset: {
                key: TEMPLATE_FILE,
                value: CUSTOM_TEMPLATE_CONTENT
            }
        });
        logger.success('Template uploaded successfully!');

        // 3. Assign Template to Product
        logger.info(`Assigning template '${TEMPLATE_NAME}' to product ${TARGET_PRODUCT_ID}...`);
        const updateResponse = await shopifyClient.put(`/products/${TARGET_PRODUCT_ID}.json`, {
            product: {
                id: TARGET_PRODUCT_ID,
                template_suffix: TEMPLATE_NAME
            }
        });

        logger.success('------------------------------------------------');
        logger.success('DESIGN APPLIED SUCCESSFULLY!');
        logger.success(`Product: ${updateResponse.product.title}`);
        logger.success(`New Template Suffix: ${updateResponse.product.template_suffix}`);
        logger.success(`Check it out: https://${config.shop}/products/${updateResponse.product.handle}`);
        logger.success('------------------------------------------------');

    } catch (error) {
        logger.error('Failed to apply design:', error.message);
        if (error.response) {
            logger.error('API Details:', JSON.stringify(error.response.data, null, 2));
        }
    }
};

run();
