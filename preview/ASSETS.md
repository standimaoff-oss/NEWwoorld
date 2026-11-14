# China preview assets

- Photographic PBR maps: ambientCG, CC0 1.0. Downloaded through the GitHub API from `petroulacl/fps-buildings-env-kit` (the repository labels these assets CC0). IDs: Grass004, Concrete012, Bricks066, Asphalt021, Road001, Metal063. Maps were resized (color 768px, normal 512px, roughness 256px) and color maps slightly desaturated. Original ambientCG asset pages should be checked again before a commercial release.
- Font: Noto Sans SC from `google/fonts`, SIL OFL 1.1 (`assets/FONT_OFL.txt`). Subset and instantiated at weight 500 for the preview.
- three.js 0.180.0, MIT.
- Scene geometry, sign artwork and GLSL effects: authored for this preview.
- User-provided Sketchfab/Shadertoy links are references only. No model or shader was downloaded from those hosts in this environment, and the user's API credential is not embedded or used by the HTML.

## Packaging assets

- `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`: drawn for this preview from the
  Noto Sans SC subset (glyph 京), no third-party artwork. Used by the PWA manifest and
  the Android launcher icon.
- `pwa-src/manifest.webmanifest`, `pwa-src/sw.js`: authored here; `build.mjs` copies them
  plus the icons next to `China_Preview.html` and into the served directory.
- `build.mjs` also writes byte-identical copies of the standalone HTML into
  `android/app/src/main/assets/index.html` and `desktop/app/index.html` so the CI-built
  APK/EXE always match the reviewed HTML.
