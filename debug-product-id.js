require('dotenv').config();
const shopifyClient = require('./src/services/shopifyClient');
const config = require('./src/config');

async function checkById() {
    await shopifyClient.init(config.shop);
    const id = '7791430533162';
    console.log(`Checking product ID: ${id}...`);

    const res = await shopifyClient.get(`/products/${id}.json`);
    if (!res.product) {
        console.error('Product not found!');
        return;
    }

    const p = res.product;
    console.log('Handle:', p.handle);
    console.log('Template Suffix:', p.template_suffix);
}

checkById().catch(console.error);
