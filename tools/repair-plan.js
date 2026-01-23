require('dotenv').config();
const fs = require('fs-extra');
const path = require('path');
const { createOpenRouterClient } = require('./utils/ai-client');
const { ROLES, resolveModelForRole } = require('./v7/ai-config');
// access the exported functions
const { buildCustomHtml, pickTopNodes } = require('./v7/plan-from-capture-pack');

async function repairPlan() {
    const planPath = path.join(__dirname, '../workspace/dawn_layout_plan.v7.json');
    const capturePackPath = path.join(__dirname, '../workspace/capture_pack.v6.json');

    if (!fs.existsSync(planPath) || !fs.existsSync(capturePackPath)) {
        console.error('Missing plan or capture pack');
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
                    // Attempt generation
                    const built = await buildCustomHtml({
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
                        console.warn('FAILED: Generation returned empty or short content');
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
