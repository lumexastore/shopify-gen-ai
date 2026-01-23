require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const { createOpenRouterClient } = require('./utils/ai-client');
const { ROLES, resolveParamsForRole } = require('./v7/ai-config');
const { sliceImageIfLarge } = require('./utils/image-utils');
const { pickTopNodes } = require('./v7/plan-from-capture-pack');

async function buildSectionHtml(ai, model, section, packSections) {
    console.log(`\n🔨 Building HTML for section: ${section.label} (Source: ${section.sourceSectionId})...`);

    const sourceSec = packSections.get(section.sourceSectionId);
    if (!sourceSec || !sourceSec.cropPath) {
        console.warn(`  ⚠️ Missing source/crop for ${section.label}`);
        return '';
    }

    const imgContents = [];
    const chunks = await sliceImageIfLarge(sourceSec.cropPath);
    for (const chunkPath of chunks) {
        try {
            const dataUrl = await ai.fileToDataUrl(chunkPath, 'image/png');
            imgContents.push({ type: 'image_url', image_url: { url: dataUrl } });
        } catch { }
    }

    const nodesPreview = pickTopNodes(sourceSec.nodes || [], 120);

    const msg = {
        role: 'user',
        content: [
            {
                type: 'text',
                text:
                    `You are a Frontend Expert. Recreate this specific section "${section.label}" of the landing page.\n` +
                    'Output HTML and CSS.\n' +
                    'Rules:\n' +
                    '1. **Output Format**: standard HTML string with <style> blocks. \n' +
                    '2. **Scope**: Wrap everything in <section class="ultra-section-' + section.label + '">.\n' +
                    '3. **Classes**: Prefix all inner classes with "u-' + section.label + '-" to avoid conflicts.\n' +
                    '4. **Styling**: Use "Poppins", sans-serif for ALL text. Use #6d388b for primary purple. Use #121212 for black text. Be pixel-perfect with margins/padding.\n' +
                    '5. **Images**: Use these EXACT URLs found in the DOM if they match the visual:\n' +
                    `   ${JSON.stringify(nodesPreview.filter(n => n.src).map(n => n.src)).slice(0, 2000)}\n` +
                    '   If no URL matches, use a placeholder.\n' +
                    '6. **Content**: Transcribe text exactly.\n' +
                    '7. **No JSON**: Just return the HTML string inside ```html``` fence.\n'
            },
            ...imgContents
        ]
    };

    try {
        const { content } = await ai.chatCompletions({
            model,
            messages: [{ role: 'system', content: 'Output HTML code block.' }, msg],
            temperature: 0.2,
            max_tokens: 4000
        });

        const match = content.match(/```html([\s\S]*?)```/);
        const html = match ? match[1] : (content.match(/```([\s\S]*?)```/)?.[1] || content);

        console.log(`  ✅ Generated ${html.length} chars.`);
        return html;

    } catch (e) {
        console.error(`  ❌ Failed to generate ${section.label}:`, e.message);
        return '';
    }
}

async function rebuildUltraGranular() {
    const ai = createOpenRouterClient();
    const model = 'anthropic/claude-3.5-sonnet';

    const planPath = path.join(__dirname, '../workspace/dawn_layout_plan.v7.json');
    const packPath = path.join(__dirname, '../workspace/capture_pack.v6.json');

    if (!fs.existsSync(planPath)) { throw new Error('Plan not found'); }
    const plan = await fs.readJson(planPath);
    const pack = await fs.readJson(packPath);
    const packSections = new Map(pack.sections.map(s => [s.id, s]));

    const bodySections = plan.sections.filter(s => {
        if (s.label === 'header' || s.label === 'footer') return false;
        if (s.order <= 2) return false;
        return true;
    });

    console.log(`Rebuilding ${bodySections.length} sections granularly...`);

    let fullHtml = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap" rel="stylesheet">
<div class="ultra-master-wrapper" style="max-width: 1440px; margin: 0 auto; font-family: 'Poppins', sans-serif; --ultra-primary: #6d388b; --ultra-text: #121212; color: #121212;">
`;

    for (const sec of bodySections) {
        const sectionHtml = await buildSectionHtml(ai, model, sec, packSections);
        fullHtml += sectionHtml + '\n\n';
    }

    fullHtml += '</div>';

    const outPath = path.join(__dirname, '../workspace/ultra_fidelity.html');
    await fs.writeFile(outPath, fullHtml);
    console.log(`\n🎉 Granular Rebuild Complete. Saved to ${outPath}`);
}

rebuildUltraGranular().catch(console.error);
