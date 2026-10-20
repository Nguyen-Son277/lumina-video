# Lumina Studio identity

The mark combines an **L** with a **Play** triangle. Lavender, warm white and ink match the application's existing dark palette.

## Assets

- `lumina-mark.svg`: canonical 64 × 64 vector mark, used by the application.
- `lumina-logo.svg`: 296 × 80 horizontal logo with custom vector lettering (no font dependency).
- `lumina-logo.png`: 1184 × 320 transparent export; light lettering is intended for dark backgrounds.
- `lumina-preview.png`: presentation sheet with small-size and light-background examples.
- `../favicon.svg`: copy of the canonical mark.
- `../favicon.ico`: 16, 32 and 48 px, 32-bit bitmap frames with transparency masks.
- `../apple-touch-icon.png`: 180 × 180 opaque icon.

## Regenerate

Run from the repository root:

```sh
node scripts/generateBrand.mjs
```

Edit the source mark in `public/brand/lumina-mark.svg`; lettering geometry and export settings live in the generator. Generated assets are committed directly, so the normal application build needs no additional step or runtime dependencies.

Keep the square mark's aspect ratio and use it without lettering at favicon sizes. The mark has its own dark backing and lavender outline so it remains visible on light or dark surfaces. Use the horizontal logo on dark backgrounds; do not place the cream lettering directly on white.
