# V6 Agent Prompt Chain (High-Fidelity, Works With Mid Models)

Цель: добиться максимально похожего клона, даже если модель не топовая, за счёт:
1) **жёстких артефактов** (кропы секций + DOM-digest),
2) **строгих JSON-контрактов** на каждом шаге,
3) **запрета на “угадывание”** и плейсхолдеры,
4) **цикла QA → фиксы → QA**.

## Какие артефакты должны существовать
- `workspace/capture_pack.v6.json` (генерит `tools/capture-pack.js`)
- `workspace/screenshots/donor_full_v6_*.png`
- `workspace/screenshots/sections/*.png` (кропы секций)
- `workspace/donor_passport.v5.json` (опционально, для ассетов/brand tokens)

## Нулевая политика (обязательно как System)
Ты НЕ имеешь права:
- вставлять “тестовый текст”, “lorem ipsum”, повторяющиеся заглушки;
- выдумывать структуру, если она не подтверждена кропом или DOM-nodes;
- использовать неизвестные settings/blocks (только по schema секции);
- смешивать ассеты: `logo/icon` не идут в product images и не становятся hero bg.

Если данных не хватает — верни `needs_rerun_capture_pack: true` и перечисли, чего не хватает.

---

## Общие форматы данных (контракт)

### 1) SectionLabel
```json
{
  "label": "hero|features_grid|image_text_split|gallery|testimonials|faq|comparison|steps|cta|unknown",
  "confidence": 0.0,
  "reasons": ["short strings, no chain-of-thought"]
}
```

### 2) SectionSpec (главный продукт понимания)
```json
{
  "sectionId": "sec_xxx",
  "label": "hero",
  "layout": {
    "pattern": "full_width|boxed|two_column|grid_3|grid_4|stacked",
    "textAlign": "left|center|right",
    "imagePlacement": "background|left|right|top|none",
    "spacing": { "paddingTop": 0, "paddingBottom": 0 }
  },
  "content": {
    "heading": "string|null",
    "subheading": "string|null",
    "body": "string|null",
    "bullets": ["string"],
    "ctas": [
      { "label": "string", "href": "string|null", "style": "primary|secondary" }
    ]
  },
  "assets": [
    {
      "domPath": "string|null",
      "src": "string|null",
      "bgUrl": "string|null",
      "role": "hero_bg|icon|photo|logo|decor",
      "purpose": "background|product|benefit|trust|avatar|unknown"
    }
  ],
  "constraints": {
    "mustKeep": ["heading", "cta_primary"],
    "mobileRules": ["stack_columns", "keep_cta_visible"]
  },
  "problems": []
}
```

### 3) ThemeBuildPlan (что строим в Shopify)
```json
{
  "templateSuffix": "cloned-v2",
  "sections": [
    {
      "sectionId": "sec_xxx",
      "target": {
        "type": "image-banner|multicolumn|rich-text|slideshow|collapsible-content|custom:<name>",
        "settings": {},
        "blocks": [],
        "blockOrder": []
      },
      "assetUploads": [
        { "src": "https://...", "usage": "image_picker", "note": "..." }
      ],
      "qaExpectations": [
        "heading font-size approx 42px on desktop",
        "image left 50%, text right 50%"
      ]
    }
  ],
  "diagnostics": { "customSectionsNeeded": [] }
}
```

---

## PROMPT 0 — Controller (единственный “руководитель”)
Роль: orchestrator. Ты не делаешь дизайн сам — ты запускаешь шаги и проверяешь контракты.

**Вход**: URL донора + доступ к repo.
**Выход**: серия артефактов в `workspace/` и итоговый продукт в Shopify.

Стратегия: работай по шагам 1→9 ниже. Если любой шаг вернул `ok=false`, остановись и почини причину (перезапуск/исправление).

---

## PROMPT 1 — CapturePack Gate (проверка фактов)
Input: `workspace/capture_pack.v6.json`

Задание:
1) Проверь что `sections.length >= 10`, есть `fullPageScreenshot`, у каждой секции есть `cropPath` и `nodes`.
2) Оцени качество: много ли пустых `text`? есть ли `img/src` и `bgUrl`?
3) Если плохо — потребуй rerun `tools/capture-pack.js` с другими параметрами (viewport/scroll).

Output JSON:
```json
{
  "ok": true,
  "needs_rerun_capture_pack": false,
  "issues": [],
  "next": "label_sections"
}
```

---

## PROMPT 2 — LabelSections (по одной секции, быстрый лейблинг)
Input: одна секция из `capture_pack.v6.json`:
- `sectionId`, `cropPath`, `textSample`, первые ~120 `nodes`.

Задание:
- Дай `SectionLabel` (hero/features/faq/…).
- Не делай глубокого парсинга. Только тип + уверенность.

Output JSON: `SectionLabel`

Примечание: повторить для всех секций и собрать `workspace/section_labels.v6.json` (контроллер делает агрегацию).

---

## PROMPT 3 — UnderstandSection (глубокий разбор секции)
Input (одна секция):
- section crop (из `cropPath`)
- `nodes` (все) + `textSample`

Задание (строго):
1) Определи **layout pattern** (two_column/grid/stacked).
2) Извлеки текст:
   - ВАЖНО: используй **Vision** (картинку crop), если в DOM nodes текст не найден или разбит.
   - heading: ближайший `h1/h2` по nodes и по визуалу (читай с картинки!).
   - subheading/body/bullets: из `p/li` (или с картинки).
3) Найди CTA:
   - кнопки/ссылки с текстом (buy/order/add/get).
4) Ассеты:
   - background/hero image: большая картинка или bgUrl покрывающая секцию.
   - icons: маленькие svg/img рядом с коротким текстом.
   - content images: любые другие `img` из nodes. Включай их в items.
   - avatars: квадраты/круги рядом с именем (для testimonials).
5) Верни `SectionSpec`.

Правило: старайся извлечь максимум контента. Если текст есть на картинке — перепиши его. Если секция чисто визуальная (галерея) — собери все картинки. Ставь `null` только если контента действительно нет.

Output JSON: `SectionSpec`

---

## PROMPT 4 — MapSectionToTheme (выбор Dawn или Custom)
Input:
- `SectionSpec`
- “ThemeCapabilities” (краткая выжимка, которую контроллер даст):
  - доступные секции Dawn
  - их `max_blocks`
  - какие block types есть
  - какие settings types есть (`image_picker`, `text`, `richtext`, etc.)

Задание:
1) Выбери target:
   - hero → `image-banner` (если bg + text)
   - features grid → `multicolumn`
   - faq → `collapsible-content`
   - testimonials → если есть custom template `custom:testimonials-grid`, иначе `rich-text` (fallback)
   - comparison → `custom:comparison-table`
2) Определи какие ассеты надо загрузить в Files (`assetUploads`).
3) Подготовь `qaExpectations` (2–5 буллетов, по которым QA проверит схожесть).

Output JSON: часть `ThemeBuildPlan.sections[]` для одной секции.

---

## PROMPT 5 — AssembleThemeBuildPlan (глобальная сборка)
Input:
- все `SectionSpec[]`
- все “mapped section plans” из Prompt 4

Задание:
- Сформируй полный `ThemeBuildPlan`:
  - `templateSuffix`
  - порядок секций (как в `capture_pack` order, исключая header/footer)
  - список custom секций (если нужны)

Output JSON: `ThemeBuildPlan` (сохранить как `workspace/theme_build_plan.v6.json`)

---

## PROMPT 6 — Build (инструментальный шаг)
Контроллер выполняет:
- загрузку ассетов в Files
- генерацию/обновление `templates/product.<suffix>.json`
- (если custom) создание `sections/custom-*.liquid`

Модель НЕ пишет код сама на этом шаге, если нет custom секций.

Output: краткий отчёт (json) что создано/изменено.

---

## PROMPT 7 — VisualQA (по секциям)
Input:
- donor full screenshot + cloned full screenshot
- пары кропов: donor section crop vs cloned section crop (по порядку)

Задание:
- Для каждой секции:
  - статус: pass/partial/fail
  - причины (конкретно: “grid columns mismatch”, “padding too large”, “bg image missing”)
  - fix action: поменять target секцию / поправить settings / поправить блоки / нужен custom

Output JSON:
```json
{
  "overall": "partial",
  "sectionFindings": [
    { "sectionId": "sec_xxx", "status": "fail", "reasons": [], "fixActions": [] }
  ]
}
```

---

## PROMPT 8 — FixPlan (детерминированные правки)
Input: QA findings + текущий `ThemeBuildPlan`

Задание:
- Сгенерируй “patch plan”:
  - какие секции заменить
  - какие settings поменять
  - какие блоки добавить/удалить
- Запрет: не добавляй больше 1 новой custom секции за итерацию.

Output JSON: `workspace/fix_plan.v6.json`

---

## PROMPT 9 — Loop Controller
Повторяй: 3→4→5→6→7→8 до:
- `overall=pass` или
- лимита итераций (обычно 3–5)

В конце всегда верни:
- список секций, которые остались custom/неидеальными,
- что нужно руками (если требуется).

