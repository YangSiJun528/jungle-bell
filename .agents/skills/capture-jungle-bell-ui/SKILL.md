---
name: capture-jungle-bell-ui
description: Capture and visually QA the entire Jungle Bell Tauri UI as directly viewable image files using current server data. Use only for final release verification or after major feature development when a comprehensive review of the whole UI is required. Do not use for routine feature development or ordinary UI changes.
---

# Capture Jungle Bell UI

## Workflow

1. Inspect the repository, requested screens, external data sources, and Tauri window sizes.
2. Read the current timestamp and short Git commit hash. Create `/tmp/jungle-bell/<YYYYMMDD-HHMMSS>-<short-sha>/` and keep all output outside the repository.
3. Fetch current public-server responses before rendering. Use simulated data only for states that cannot be obtained from the live server, and identify those states clearly.
4. Add temporary preview wiring only when necessary. Preserve existing user changes.
5. Render each requested screen at its actual Tauri logical window size and save each state as a separate PNG or JPEG.
6. Capture scrollable screens through their full content. Stitch multiple viewport captures when needed so neither width nor the bottom is clipped.
7. Open and inspect every image. Check dimensions, right and bottom edges, text, remote images, and state accuracy; recapture any failure.
8. Remove temporary preview code, stop temporary servers, and confirm no capture-only repository changes remain.
9. Return direct image links or embedded images and the output folder path. Do not create HTML galleries unless the user explicitly requests one.
