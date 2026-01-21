# Dawn Theme Blueprint

## Available Sections
*   `image-banner`
*   `featured-collection`
*   `rich-text`
*   `multicolumn`
*   `video`
*   `slideshow`
*   `collapsible-content`

## Schema Reference
Do not hardcode settings keys.

### Source of Truth
- Section schema lives inside: `sections/<section-type>.liquid` in the **current main theme**.
- Parse JSON inside `{% schema %} ... {% endschema %}`.

### Practical Rules
- **Max blocks**: respect `schema.max_blocks` (e.g. slideshow часто max 5).
- **image_picker refs**: values in templates are usually strings like `shopify://shop_images/<filename>` (derive prefix from existing theme templates).
- **Block types are strict**: only use `schema.blocks[].type` allowed for that section.
