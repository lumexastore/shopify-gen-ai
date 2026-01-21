# Cloning Protocol (V6 Recommended, V5 Supported)

## Goal
Сделать **контекстно-зависимое структурное клонирование** с качеством “как верстальщик”:
- V6 (рекомендуется): **section crops + DOM-digest → LLM SectionSpec → Dawn/custom**
- V5 (поддерживается): эвристическое дерево секций → Dawn (быстрее, но качество ниже)

## Canonical Inputs / Outputs
- **Input URL**: ссылка на донорский лендинг/страницу.
- **V6 Capture Pack**: `workspace/capture_pack.v6.json` (кропы секций + DOM-digest) — основной вход для LLM.
- **V5 Passport**: `workspace/donor_passport.v5.json` (опционально: токены/ассеты/brand hints).
- **Theme Build Plan**: `workspace/theme_build_plan.v6.json` (план сборки секций).
- **Final Template**: `templates/product.<suffix>.json`.

## Pipeline (Do Not Guess)
### V6 (Recommended for quality)
1. **Capture**:
   - `node tools/capture-pack.js <url>`
   - Артефакт: `workspace/capture_pack.v6.json` + кропы в `workspace/screenshots/sections/`
2. **LLM Orchestration**:
   - Следуй `_AI_CONTEXT/05_V6_AGENT_PROMPTS.md`
   - Артефакты: `section_labels.v6.json`, `theme_build_plan.v6.json`, `fix_plan.v6.json` (по итерациям)
3. **Create Product**:
   - `node tools/create-product.js`
4. **Build + Apply Template**:
   - `node tools/template-builder.js --productId <id> --suffix cloned-v1`

### V5 (Supported fallback)
1. `node tools/deep-inspector.js <url>` → `workspace/donor_passport.v5.json`
2. `node tools/structure-mapper.js` → `workspace/dawn_layout_plan.json`
3. `node tools/create-product.js`
4. `node tools/template-builder.js --productId <id> --suffix cloned-v1`

## Hard Rules (Quality Guardrails)
- **Никаких “сваленных” ассетов**: `logo` и `icon` никогда не идут в product images.
- **Header/Footer исключаем**: `policy.includeInClone=false` по умолчанию.
- **Native-first**: используем секции Dawn (`image-banner`, `multicolumn`, `rich-text`, `slideshow`, `collapsible-content`).
- **Schema-aware**: настройки/blocks должны соответствовать schema секции из текущей темы (читаем `sections/<type>.liquid` и парсим `{% schema %}`).
