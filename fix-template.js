require('dotenv').config();
const shopifyClient = require('./src/services/shopifyClient');
const config = require('./src/config');

async function fixProduct() {
    await shopifyClient.init(config.shop);
    // Target: The old product the user is looking at
    const productId = '7791429713962';
    const newTemplate = 'haphoriz-cloned-v5';

    console.log(`Updating product ${productId} to use template ${newTemplate}...`);

    const res = await shopifyClient.put(`/products/${productId}.json`, {
        product: {
            id: productId,
            template_suffix: newTemplate
        }
    });

    console.log('Update success!', res.product.template_suffix);
}

fixProduct().catch(console.error);
