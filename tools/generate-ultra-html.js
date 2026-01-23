require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const { createOpenRouterClient } = require('./utils/ai-client');
const { ROLES, resolveParamsForRole, resolveModelForRole } = require('./v7/ai-config');
const { sliceImageIfLarge } = require('./utils/image-utils');

async function generateUltraFidelityHtml() {
    const packPath = path.join(__dirname, '../workspace/capture_pack.v6.json');
    const pack = await fs.readJson(packPath);

    const relevantSections = pack.sections
        .filter(s => {
            const t = (s.tag || '').toLowerCase();
            return t !== 'header' && t !== 'footer' && !s.domPath.includes('__header') && !s.domPath.includes('__footer');
        })
        .sort((a, b) => a.order - b.order);

    const sectionsToRender = relevantSections.filter(s => s.order >= 3);

    if (sectionsToRender.length === 0) {
        console.error('No sections found to render');
        return;
    }

    console.log(`Processing ${sectionsToRender.length} sections for Ultra Fidelity...`);

    const ai = createOpenRouterClient();
    const model = resolveModelForRole(ROLES.BUILDER);

    const imgContents = [];
    for (const sec of sectionsToRender) {
        if (!sec.cropPath) continue;
        const chunks = await sliceImageIfLarge(sec.cropPath);
        for (const chunkPath of chunks) {
            try {
                const dataUrl = await ai.fileToDataUrl(chunkPath, 'image/png');
                imgContents.push({
                    type: 'image_url',
                    image_url: { url: dataUrl }
                });
            } catch (e) {
                console.warn(`Failed to read ${chunkPath}`);
            }
        }
    }

    const msg = {
        role: 'user',
        content: [
            {
                type: 'text',
                text:
                    'You are a World-Class Frontend Developer. \n' +
                    'I am providing you with a sequence of screenshots representing the "Body" of a high-converting landing page.\n' +
                    'Your task is to Write ONE SINGLE HTML FILE that recreates this ENTIRE sequence pixel-perfectly.\n' +
                    'Refactor duplicated CSS. Use a consistent design system (colors, fonts) derived from the images.\n' +
                    '\n' +
                    'IMPORTANT RULES:\n' +
                    '1. **Output Format**: Return the code inside a markdown code block: ```html ... ```.\n' +
                    '2. **Content**: Transcribe ALL text from the images exactly.\n' +
                    '3. **Styling**: Include <style> tags with Scoped CSS (prefix classes with .ultra-).\n' +
                    '4. **Images**: Use placeholders but prefer valid URLs if possible.\n' +
                    '5. **Structure**: One contiguous flow. No separate files.\n'
            },
            ...imgContents.map(i => ({ type: 'image_url', image_url: i.image_url }))
        ],
    };

    console.log('Sending request to AI (Non-JSON Mode)...');

    try {
        const { content: text } = await ai.chatCompletions({
            model,
            messages: [{ role: 'system', content: 'You are a coding engine. Output HTML.' }, msg],
            temperature: 0.2,
            max_tokens: 8192,
        });

        console.log('[DEBUG] Raw length:', (text || '').length);

        let html = '';
        const match = text.match(/```html([\s\S]*?)```/);
        if (match) {
            html = match[1];
        } else {
            const matchGeneric = text.match(/```([\s\S]*?)```/);
            if (matchGeneric) html = matchGeneric[1];
            else if (text.trim().startsWith('<')) html = text;
        }

        if (!html || html.length < 100) {
            console.error('Failed to extract HTML from response');
            console.log('Raw output preview:', text.slice(0, 500));
            return;
        }

        const finalHtml = `<div class="ultra-landing-page-wrapper">${html}</div>`;

        const outPath = path.join(__dirname, '../workspace/ultra_fidelity.html');
        await fs.writeFile(outPath, finalHtml);
        console.log(`✅ Ultra Fidelity HTML saved to ${outPath}`);

    } catch (err) {
        console.error('AI Generation Failed:', err);
    }
}

generateUltraFidelityHtml().catch(console.error);
