require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const cheerio = require('cheerio');
const { createOpenRouterClient } = require('./utils/ai-client');

async function portFromSource() {
    const sourcePath = path.join(__dirname, '../workspace/source_page.html');
    if (!fs.existsSync(sourcePath)) {
        throw new Error('source_page.html not found!');
    }

    const html = await fs.readFile(sourcePath, 'utf8');
    const $ = cheerio.load(html);

    // Strategy:
    // 1. Find the main container.
    // 2. Locate the "Product Section" and skip it (since we use native).
    // 3. Extract everything else in the main content area.

    // Based on inspection:
    // #MainContent > section (order 1..N)
    // Usually the first section is the product form.

    const sections = $('#MainContent > section').toArray();
    console.log(`Found ${sections.length} top-level sections in #MainContent`);

    // We assume the first section is the Main Product (skip or keep structural elements?).
    // User wants "Exact Clone".
    // If we skip the first section, we assume native Shopify renders it.
    // Let's iterate and just check IDs or Classes.

    let contentHtml = '';

    for (let i = 0; i < sections.length; i++) {
        const sec = $(sections[i]);
        const id = sec.attr('id') || '';

        // Heuristic: If it contains 'main-product' or 'template--' and is early, it's the product form.
        // In source: section#shopify-section-template--...__main
        if (id.includes('__main') || i === 0) {
            console.log(`Skipping Section [${i}] (likely Main Product): ${id}`);
            continue;
        }

        console.log(`Including Section [${i}]: ${id}`);
        contentHtml += $.html(sec) + '\n\n';
    }

    if (!contentHtml) {
        // Fallback: maybe sections are divs with class 'shopify-section'?
        const divs = $('#MainContent > div.shopify-section').toArray();
        console.log(`Fallback: Found ${divs.length} div.shopify-section in #MainContent`);
        for (let i = 0; i < divs.length; i++) {
            const sec = $(divs[i]);
            const id = sec.attr('id') || '';
            if (id.includes('__main') || i === 0) { // Usually product is first
                console.log(`Skipping Div [${i}] (likely Main Product): ${id}`);
                continue;
            }
            console.log(`Including Div [${i}]: ${id}`);
            contentHtml += $.html(sec) + '\n\n';
        }
    }

    if (contentHtml.length < 500) {
        throw new Error('Failed to extract meaningful content from source HTML.');
    }

    console.log(`Extracted ${contentHtml.length} chars of raw HTML. Cleaning with AI...`);

    // Now ask AI to clean it.
    // We chunk it if too big, but usually landing page body without header/footer fits in 128k context.
    // Models like claude-3.5-sonnet have 200k context.

    const ai = createOpenRouterClient();
    const model = 'anthropic/claude-3.5-sonnet';

    const msg = {
        role: 'user',
        content: `
You are a Refactoring Expert.
I have extracted raw HTML from a Shopify site. It is full of "liquid" garbage, theme-specific classes (like 'shrine-theme', 'animate-section'), and convoluted CSS dependency classes.

Your Task:
REFACTOR this HTML into CLEAN, STANDALONE HTML + CSS.
1. **Preserve Layout**: The visual appearance must remain Identical.
2. **Remove Dependencies**: Replace theme utility classes with actual inline styles or a local <style> block.
3. **Consolidate Styles**: Use a single <style> block at the top with scoped classes (prefix .ported-).
4. **Images**: Keep the original <img> src URLs (they are typically valid CDN links).
5. **Javascript**: Remove all <script> tags and weird data attributes data-defer, etc.
6. **Output**: Return ONLY the cleaned HTML code inside a markdown block.

RAW HTML:
${contentHtml.slice(0, 50000)} 
    ` // Cap at 50k chars to be safe-ish, though Sonnet can handle more.
    };

    const { content } = await ai.chatCompletions({
        model,
        messages: [{ role: 'system', content: 'Output cleaned HTML.' }, msg],
        temperature: 0.1,
        max_tokens: 8192
    });

    const match = content.match(/```html([\s\S]*?)```/);
    const finalHtml = match ? match[1] : (content.match(/```([\s\S]*?)```/)?.[1] || content);

    const outPath = path.join(__dirname, '../workspace/ported_source.html');
    // Wrap in our Poppins font wrapper for safety
    const wrapped = `
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
<div class="ported-wrapper" style="font-family: 'Poppins', sans-serif;">
${finalHtml}
</div>`;

    await fs.writeFile(outPath, wrapped);
    console.log(`✅ Ported HTML saved to ${outPath}`);
}

portFromSource().catch(console.error);
