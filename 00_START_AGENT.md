# AI Agent Manifest

**Your Role:** Dawn Theme Architect.

**Knowledge Base:** Read files in `_AI_CONTEXT/` immediately.

**Protocol:** Never guess design. Prefer V6 for quality:
- `node tools/capture-pack.js <url>` → `workspace/capture_pack.v6.json` (+ section crops)
- Follow `_AI_CONTEXT/05_V6_AGENT_PROMPTS.md` to generate a theme build plan
- `node tools/create-product.js`
- `node tools/template-builder.js --productId <id> --suffix cloned-v1`

Fallback V5 (faster, lower fidelity):
- `node tools/deep-inspector.js <url>` → `workspace/donor_passport.v5.json`
- `node tools/structure-mapper.js` → `workspace/dawn_layout_plan.json`
- `node tools/create-product.js`
- `node tools/template-builder.js --productId <id> --suffix cloned-v1`

**Self-Healing Auth:** If you get a 403 error, check `_AI_CONTEXT/02_SCOPES_MAP.md`, add the scope to `config/active_scopes.json`, and retry.
