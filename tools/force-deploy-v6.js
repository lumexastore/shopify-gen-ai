require('dotenv').config();
const { templateBuilder } = require('./template-builder');
const shopifyClient = require('../src/services/shopifyClient');
const config = require('../src/config');

async function forceDeploy() {
    // 1. Run Template Builder to create 'templates/product.haphoriz-cloned-v6.json'
    console.log('🚀 Starting Builder for V6...');

    // We mock argv for the builder function
    // It expects: node tools/template-builder.js --mode product --productId <id> --suffix <suffix>
    const argv = [
        'node',
        'tools/template-builder.js',
        '--mode', 'product',
        '--productId', '7791429713962',
        '--suffix', 'haphoriz-cloned-v6' // NEW SUFFIX
    ];

    await templateBuilder({ argv });

    console.log('✅ Builder finished.');

    // 2. Explicitly bind just to be double sure
    await shopifyClient.init(config.shop);
    const productId = '7791429713962';
    const newTemplate = 'haphoriz-cloned-v6';

    console.log(`🔗 Binding product ${productId} to template ${newTemplate}...`);

    const res = await shopifyClient.put(`/products/${productId}.json`, {
        product: {
            id: productId,
            template_suffix: newTemplate
        }
    });

    console.log('🎉 Bind success! Current suffix:', res.product.template_suffix);
}

forceDeploy().catch(err => {
    console.error('❌ Deploy failed:', err);
    process.exit(1);
});
