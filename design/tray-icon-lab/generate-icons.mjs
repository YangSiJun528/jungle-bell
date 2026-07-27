import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const iconRoot = join(root, "icons");
const sizes = [16, 18, 20, 22, 24, 32, 36, 40, 44, 48, 64, 88];
const tile = {
  x: 2,
  y: 2,
  size: 40,
  radius: 8.5,
};
const tileCompass = {
  scale: 1.5,
  x: 22,
  y: 22,
  // Counter-scale the stroke so enlarging the mark does not make the ring heavier.
  strokeWidth: 1.62,
  // Keep the same roughly 20% radial gap between the needle and ring as app-icon*.svg.
  needleScale: 0.78,
};

const statuses = {
  normal: { label: "정상", mark: "check" },
  offline: { label: "오프라인", mark: "minus" },
  warning: { label: "로그인 필요", mark: "bang" },
  alert: { label: "출석 필요", mark: "bang" },
  complete: { label: "출석 완료", mark: "check" },
};

const themes = {
  light: {
    label: "밝은 배경용",
    edge: "#17212B",
    halo: "#FFFFFF",
    neutral: "#24313B",
    neutralGlyph: "#FFFFFF",
    ringPlate: "#FFFFFF",
    ringGlyph: "#202B33",
    colors: {
      normal: { fill: "#087F5B", glyph: "#FFFFFF" },
      offline: { fill: "#536170", glyph: "#FFFFFF" },
      warning: { fill: "#A94D00", glyph: "#FFFFFF" },
      alert: { fill: "#B4232C", glyph: "#FFFFFF" },
      complete: { fill: "#FFFFFF", glyph: "#111111" },
    },
  },
  dark: {
    label: "어두운 배경용",
    edge: "#F4F7F8",
    halo: "#11181D",
    neutral: "#EEF2F3",
    neutralGlyph: "#172129",
    ringPlate: "#171D22",
    ringGlyph: "#F7FAFB",
    colors: {
      normal: { fill: "#22B98A", glyph: "#071C15" },
      offline: { fill: "#9DA9B8", glyph: "#151B21" },
      warning: { fill: "#F29A38", glyph: "#23170A" },
      alert: { fill: "#F05D65", glyph: "#260B0E" },
      complete: { fill: "#000000", glyph: "#F7F7F7" },
    },
  },
};

const families = {
  solid: {
    label: "01 채운 원",
    shortLabel: "채운 원",
    description: "상태색 면적이 가장 크고 작은 크기에서도 읽기 쉽습니다.",
  },
  halo: {
    label: "02 대비 테두리",
    shortLabel: "대비 테두리",
    description: "반대 명도의 이중 테두리로 유사한 배경에서도 외곽을 분리합니다.",
  },
  ring: {
    label: "03 상태 링",
    shortLabel: "상태 링",
    description: "중앙은 중립색으로 유지하고 굵은 외곽 링에 상태색을 사용합니다.",
  },
  badge: {
    label: "04 상태 배지",
    shortLabel: "상태 배지",
    description: "나침반 본체를 일정하게 유지하고 우하단 배지로 상태를 구분합니다.",
  },
  split: {
    label: "05 투톤 원",
    shortLabel: "투톤 원",
    description: "넓은 상태색 면에 명암을 더해 밝고 어두운 배경 모두에서 덩어리감을 줍니다.",
  },
  tile: {
    label: "06 둥근 사각형",
    shortLabel: "둥근 사각형",
    description: "작은 나침반과 테마에 동화되는 무채색 기본 상태로 필요한 변화만 강조합니다.",
  },
};

function compassNeedle(glyph, scale = 1) {
  const needle = `<path d="M28.45 15.55c-1.48 3.45-3.02 6.12-4.64 7.76-1.65 1.64-4.3 3.2-7.78 4.68-.64.28-1.28-.36-1-.99 1.49-3.47 3.04-6.12 4.67-7.76 1.64-1.63 4.3-3.19 7.77-4.68.63-.27 1.26.36.98.99Z" fill="${glyph}"/>`;
  if (scale === 1) return needle;

  return `
      <g transform="translate(22 22) scale(${scale}) translate(-22 -22)">
        ${needle}
      </g>`;
}

function compass(glyph, scale = 1, x = 22, y = 22, strokeWidth = 2.45, needleScale = 1) {
  return `
    <g transform="translate(${x} ${y}) scale(${scale}) translate(-22 -22)">
      <circle cx="22" cy="22" r="9.8" fill="none" stroke="${glyph}" stroke-width="${strokeWidth}"/>
      ${compassNeedle(glyph, needleScale)}
    </g>`;
}

function compassCutout(
  maskId,
  scale = tileCompass.scale,
  x = tileCompass.x,
  y = tileCompass.y,
  strokeWidth = tileCompass.strokeWidth,
  needleScale = tileCompass.needleScale,
) {
  return `
    <defs>
      <mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="44" height="44">
        <rect width="44" height="44" fill="#FFFFFF"/>
        ${compass("#000000", scale, x, y, strokeWidth, needleScale)}
      </mask>
    </defs>`;
}

function badgeMark(mark, glyph) {
  if (mark === "check") {
    return `<path d="m29.7 33 2.05 2.05 4.05-4.45" fill="none" stroke="${glyph}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  if (mark === "minus") {
    return `<path d="M29.7 33h6.4" fill="none" stroke="${glyph}" stroke-width="2.1" stroke-linecap="round"/>`;
  }
  return `<path d="M32.9 29.55v4.15m0 2.35v.08" fill="none" stroke="${glyph}" stroke-width="2.15" stroke-linecap="round"/>`;
}

function artwork(family, themeName, statusName) {
  const theme = themes[themeName];
  const status = statuses[statusName];
  const { fill, glyph } = theme.colors[statusName];

  if (family === "solid") {
    return `
      <circle cx="22" cy="22" r="18" fill="${fill}"/>
      <circle cx="22" cy="22" r="17.45" fill="none" stroke="${theme.edge}" stroke-opacity=".18" stroke-width="1.1"/>
      ${compass(glyph)}`;
  }

  if (family === "halo") {
    return `
      <circle cx="22" cy="22" r="19" fill="none" stroke="${theme.edge}" stroke-opacity=".55" stroke-width="1.15"/>
      <circle cx="22" cy="22" r="17.85" fill="${fill}" stroke="${theme.halo}" stroke-width="1.7"/>
      ${compass(glyph, 0.96)}`;
  }

  if (family === "ring") {
    return `
      <circle cx="22" cy="22" r="15.8" fill="${theme.ringPlate}" stroke="${fill}" stroke-width="6"/>
      <circle cx="22" cy="22" r="18.65" fill="none" stroke="${theme.edge}" stroke-opacity=".2" stroke-width=".8"/>
      ${compass(theme.ringGlyph, 0.82)}`;
  }

  if (family === "badge") {
    return `
      <circle cx="21" cy="21" r="16.9" fill="${theme.neutral}"/>
      <circle cx="21" cy="21" r="16.35" fill="none" stroke="${theme.edge}" stroke-opacity=".18" stroke-width="1.1"/>
      ${compass(theme.neutralGlyph, 0.9, 21, 21)}
      <circle cx="33" cy="33" r="7.25" fill="${theme.halo}" stroke="${theme.edge}" stroke-opacity=".28" stroke-width=".8"/>
      <circle cx="33" cy="33" r="6.15" fill="${fill}"/>
      ${badgeMark(status.mark, glyph)}`;
  }

  if (family === "split") {
    return `
      <defs>
        <clipPath id="disc"><circle cx="22" cy="22" r="18"/></clipPath>
      </defs>
      <circle cx="22" cy="22" r="18" fill="${fill}"/>
      <path d="M2 31 31 2h17v46H2Z" fill="#000000" opacity=".18" clip-path="url(#disc)"/>
      <path d="M4 13C12 6 25 3 38 9" fill="none" stroke="#FFFFFF" stroke-opacity=".16" stroke-width="3" clip-path="url(#disc)"/>
      <circle cx="22" cy="22" r="17.55" fill="none" stroke="${theme.edge}" stroke-opacity=".16" stroke-width=".9"/>
      ${compass(glyph)}`;
  }

  if (statusName === "normal" || statusName === "complete") {
    const quietFill = theme.colors.complete.fill;
    return `
      ${compassCutout("quiet-cutout")}
      <rect x="${tile.x}" y="${tile.y}" width="${tile.size}" height="${tile.size}" rx="${tile.radius}" fill="${quietFill}" mask="url(#quiet-cutout)"/>`;
  }

  return `
    <rect x="${tile.x}" y="${tile.y}" width="${tile.size}" height="${tile.size}" rx="${tile.radius}" fill="${fill}"/>
    ${compass(
      glyph,
      tileCompass.scale,
      tileCompass.x,
      tileCompass.y,
      tileCompass.strokeWidth,
      tileCompass.needleScale,
    )}`;
}

function svgDocument(family, themeName, statusName) {
  const title = `${families[family].shortLabel} · ${themes[themeName].label} · ${statuses[statusName].label}`;
  return `<svg width="44" height="44" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg">
  <title>${title}</title>
  ${artwork(family, themeName, statusName)}
</svg>
`.replace(/[ \t]+$/gm, "");
}

const manifest = {
  generatedAt: new Date().toISOString(),
  sizes,
  statuses,
  themes,
  families,
};

mkdirSync(iconRoot, { recursive: true });

for (const themeName of Object.keys(themes)) {
  for (const family of Object.keys(families)) {
    for (const statusName of Object.keys(statuses)) {
      const targetDir = join(iconRoot, themeName, family);
      mkdirSync(targetDir, { recursive: true });
      const svgPath = join(targetDir, `${statusName}.svg`);
      writeFileSync(svgPath, svgDocument(family, themeName, statusName));

      for (const size of sizes) {
        const pngPath = join(targetDir, `${statusName}-${size}.png`);
        execFileSync("rsvg-convert", [
          "--width",
          String(size),
          "--height",
          String(size),
          "--output",
          pngPath,
          svgPath,
        ]);
      }
    }
  }
}

writeFileSync(join(iconRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `Generated ${Object.keys(themes).length * Object.keys(families).length * Object.keys(statuses).length} SVGs and ${
    Object.keys(themes).length * Object.keys(families).length * Object.keys(statuses).length * sizes.length
  } PNGs in ${iconRoot}`,
);
