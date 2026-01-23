require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const { createOpenRouterClient } = require('./tools/utils/ai-client');
const { ROLES, resolveParamsForRole, resolveModelForRole } = require('./tools/v7/ai-config');
const { sliceImageIfLarge } = require('./tools/utils/image-utils');
const { pickTopNodes } = require('./tools/v7/plan-from-capture-pack');

// Local version with LOGGING
async function buildCustomHtmlWithLogs({ ai, model, cropPath, nodesPreview }) {
    const chunks = await sliceImageIfLarge(cropPath);
    const imgContents = [];
    for (const chunkPath of chunks) {
        const dataUrl = await ai.fileToDataUrl(chunkPath, 'image/png');
        imgContents.push({ type: 'image_url', image_url: { url: dataUrl } });
    }

    const msg = {
        role: 'user',
        content: [
            {
                type: 'text',
                text:
                    'You are a Liquid/HTML/CSS expert. Recreate this section visually.\n' +
                    'Output ONLY valid, standard JSON: { "html": "...", "custom_css": "..." }.\n' +
                    'Information about the section:\n' +
                    `- cropPath: ${cropPath}\n` +
                    'Rules:\n' +
                    '- STRICTLY use valid JSON with double quotes. Escape all newlines (\\n) and double quotes (\\").\n' +
                    '- Do NOT use backticks (`) for strings anywhere in the response.\n' +
                    '- Do NOT use Tailwind.\n' +
                    '- Use responsive CSS.\n' +
                    '- Use only inline-safe HTML (no script).\n' +
                    '- If you reference images, use the URLs you can infer from node hints.\n',
            },
            { type: 'text', text: `nodesPreview: ${JSON.stringify(nodesPreview).slice(0, 7000)}` },
            ...imgContents,
        ],
    };

    const { temperature, max_tokens } = resolveParamsForRole(ROLES.BUILDER);
    console.log(`[DEBUG] sending chatJson request for ${path.basename(cropPath || 'unknown')}...`);

    try {
        const resp = await ai.chatJson({
            model,
            messages: [{ role: 'system', content: 'Output ONLY valid JSON. No backticks.' }, msg],
            temperature,
            max_tokens,
            enforceJson: true,
        });

        console.log('[DEBUG] Raw response object keys:', Object.keys(resp));
        if (resp.json) {
            console.log('[DEBUG] Raw response content (slice):', JSON.stringify(resp.json).slice(0, 100));
        } else {
            console.log('[DEBUG] Response JSON is null/undefined');
            // console.log('[DEBUG] Full response:', JSON.stringify(resp, null, 2)); 
        }

        return resp.json;
    } catch (err) {
        console.error('[DEBUG] ChatJson Error:', err);
        throw err;
    }
}

async function repairPlan() {
    const planPath = path.join(__dirname, 'workspace/dawn_layout_plan.v7.json');
    const capturePackPath = path.join(__dirname, 'workspace/capture_pack.v6.json');

    if (!fs.existsSync(planPath) || !fs.existsSync(capturePackPath)) {
        console.error('Missing plan or capture pack');
        console.error('Plan:', planPath);
        console.error('Pack:', capturePackPath);
        return;
    }

    const plan = await fs.readJson(planPath);
    const capturePack = await fs.readJson(capturePackPath);
    const packSections = new Map(capturePack.sections.map(s => [s.id, s]));

    const ai = createOpenRouterClient();
    const builderModel = resolveModelForRole(ROLES.BUILDER);

    let updated = false;

    for (const section of plan.sections) {
        if (section.dawnType === 'ai-super-canvas') {
            const currentHtml = section.intent?.html || '';
            // If HTML is empty or extremely short (< 50 chars), assume failure and regenerate
            if (currentHtml.length < 50) {
                console.log(`\nReparing section ${section.sourceSectionId} (${section.label})...`);

                const sourceSec = packSections.get(section.sourceSectionId);
                if (!sourceSec) {
                    console.warn(`Source section ${section.sourceSectionId} not found in pack`);
                    continue;
                }

                const nodesPreview = pickTopNodes(sourceSec.nodes || [], 140);

                try {
                    const built = await buildCustomHtmlWithLogs({
                        ai,
                        model: builderModel,
                        cropPath: sourceSec.cropPath,
                        nodesPreview
                    });

                    if (built && built.html && built.html.length > 50) {
                        section.intent.html = built.html;
                        section.intent.custom_css = built.custom_css || '';
                        console.log(`SUCCESS: Generated ${built.html.length} chars of HTML`);
                        updated = true;
                    } else {
                        console.warn('FAILED: Generation returned empty or short content post-check');
                    }
                } catch (err) {
                    console.error(`ERROR processing section ${section.sourceSectionId}:`, err.message);
                }
            } else {
                console.log(`Section ${section.sourceSectionId} seems OK (${currentHtml.length} chars)`);
            }
        }
    }

    if (updated) {
        await fs.writeJson(planPath, plan, { spaces: 2 });
        console.log('\nPlan updated successfully!');
    } else {
        console.log('\nNo updates made to the plan.');
    }
}

repairPlan().catch(console.error);
