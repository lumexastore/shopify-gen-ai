require('dotenv').config();
const shopifyClient = require('./src/services/shopifyClient');
const config = require('./src/config');

async function checkProduct() {
    await shopifyClient.init(config.shop);
    // Using the handle from the previous run: necksupportw-clone
    const handle = 'necksupportw-clone';
    console.log(`Checking product: ${handle}...`);

    const products = await shopifyClient.get(`/products.json?handle=${handle}`);
    if (!products.products.length) {
        console.error('Product not found!');
        return;
    }

    const p = products.products[0];
    console.log('Product ID:', p.id);
    console.log('Template Suffix:', p.template_suffix);
    console.log('Title:', p.title);
}

checkProduct().catch(console.error);
