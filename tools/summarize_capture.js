const fs = require('fs-extra');
const path = require('path');

const packPath = path.join(__dirname, '../workspace/capture_pack.v6.json');
const pack = fs.readJsonSync(packPath);

console.log('Capture Pack Check:');
console.log(`- Sections: ${pack.sections.length}`);
console.log(`- FullPage Screenshot: ${!!pack.fullPageScreenshot}`);
console.log(`- Diagnostics:`, JSON.stringify(pack.diagnostics, null, 2));

console.log('\nSections Summary:');
pack.sections.forEach(s => {
    console.log(`- [${s.order}] ${s.id} | Tag: ${s.tag} | TextSample: ${(s.textSample || '').substring(0, 50)}...`);
    console.log(`  Crop: ${s.cropPath}`);
});
