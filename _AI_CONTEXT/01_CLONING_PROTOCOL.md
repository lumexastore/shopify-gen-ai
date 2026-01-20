# Cloning Protocol

## Goal
Map "Hard Facts" from `donor_passport.json` to Shopify Dawn Theme settings.

## Algorithm
1.  **Read** `donor_passport.json`.
2.  **Analyze** Color Palette:
    *   Map `Brand DNA > Primary Button` to Dawn `colors_solid_button_labels`.
    *   Map `Brand DNA > Background` to Dawn `colors_background_1`.
3.  **Analyze** Typography:
    *   Find closest Google Font match for `Brand DNA > Font Family`.
4.  **Structure**:
    *   If `Structure > Container` width > 1200px -> Use `page_width` 1600.
5.  **Apply** changes via Shopify Asset API to `config/settings_data.json`.
