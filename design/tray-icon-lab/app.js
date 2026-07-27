const sizes = [16, 18, 20, 22, 24, 32, 44];
const rasterSizes = new Set([16, 18, 20, 22, 24, 32, 36, 40, 44, 48, 64, 88]);

const statuses = {
  normal: { label: "정상 / 조작 없음", short: "정상" },
  offline: { label: "오프라인 / 확인 중", short: "오프라인" },
  warning: { label: "로그인 필요", short: "로그인" },
  alert: { label: "출석 필요 / 지각", short: "출석" },
  complete: { label: "출석 완료", short: "완료" },
};

const families = {
  solid: {
    index: "01",
    name: "채운 원",
    description: "상태색 면적이 가장 크고 작은 크기에서도 읽기 쉽습니다.",
  },
  halo: {
    index: "02",
    name: "대비 테두리",
    description: "반대 명도의 이중 테두리로 유사한 배경에서도 외곽을 분리합니다.",
  },
  ring: {
    index: "03",
    name: "상태 링",
    description: "중앙은 중립색으로 유지하고 굵은 외곽 링에 상태색을 사용합니다.",
  },
  badge: {
    index: "04",
    name: "상태 배지",
    description: "나침반 본체를 일정하게 유지하고 우하단 배지로 상태를 구분합니다.",
  },
  split: {
    index: "05",
    name: "투톤 원",
    description: "넓은 상태색 면에 명암을 더해 밝고 어두운 배경 모두에서 덩어리감을 줍니다.",
  },
  tile: {
    index: "06",
    name: "둥근 사각형",
    description:
      "나침반의 확대 비율과 선 굵기는 유지하고 바깥 타일을 조금 더 줄여 심볼 비중을 높였습니다. 조작이 없으면 라이트는 흰색, 다크는 검은색 컷아웃으로 배경에 동화됩니다.",
    recommended: true,
  },
};

const themes = {
  light: {
    label: "라이트용",
    longLabel: "밝은 배경용",
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
    label: "다크용",
    longLabel: "어두운 배경용",
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

const backgrounds = [
  { id: "mac-light", short: "mac L", name: "macOS Light", value: "#F5F5F5" },
  { id: "mac-dark", short: "mac D", name: "macOS Dark", value: "#242424" },
  { id: "win-light", short: "Win L", name: "Windows Light", value: "#F3F3F3" },
  { id: "win-dark", short: "Win D", name: "Windows Dark", value: "#202020" },
  { id: "white", short: "White", name: "순백", value: "#FFFFFF" },
  { id: "black", short: "Black", name: "순흑", value: "#000000" },
  { id: "blue", short: "Blue", name: "Windows Accent", value: "#005FB8" },
  { id: "jungle", short: "Green", name: "Jungle Green", value: "#00A873" },
];

const matrixBackgrounds = backgrounds.slice(0, 6);

const state = {
  palette: "auto",
  background: "#F5F5F5",
  backgroundId: "mac-light",
  size: 18,
  platform: "mac",
  status: "normal",
  family: "tile",
};

const els = {
  backgroundName: document.querySelector("#backgroundName"),
  backgroundPresets: document.querySelector("#backgroundPresets"),
  colorPicker: document.querySelector("#colorPicker"),
  comparisonMatrix: document.querySelector("#comparisonMatrix"),
  contrastPairs: document.querySelector("#contrastPairs"),
  downloadPng: document.querySelector("#downloadPng"),
  downloadSvg: document.querySelector("#downloadSvg"),
  familyGrid: document.querySelector("#familyGrid"),
  hexInput: document.querySelector("#hexInput"),
  paletteControl: document.querySelector("#paletteControl"),
  platformControl: document.querySelector("#platformControl"),
  resetButton: document.querySelector("#resetButton"),
  resolvedPalette: document.querySelector("#resolvedPalette"),
  rgbControls: document.querySelector("#rgbControls"),
  selectedDescription: document.querySelector("#selectedDescription"),
  selectedTitle: document.querySelector("#selectedTitle"),
  sizeControl: document.querySelector("#sizeControl"),
  sizeOutput: document.querySelector("#sizeOutput"),
  stage: document.querySelector("#stage"),
  stageBackgroundChip: document.querySelector("#stageBackgroundChip"),
  stagePaletteChip: document.querySelector("#stagePaletteChip"),
  statusSelect: document.querySelector("#statusSelect"),
  systemBar: document.querySelector("#systemBar"),
  systemBarClock: document.querySelector("#systemBarClock"),
  systemBarIcons: document.querySelector("#systemBarIcons"),
  systemBarLeft: document.querySelector("#systemBarLeft"),
};

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(normalized, 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b]
    .map((value) => Math.max(0, Math.min(255, Number(value))).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

function normalizeHex(value) {
  const trimmed = value.trim();
  const full = /^#?([0-9a-f]{6})$/i.exec(trimmed);
  if (full) return `#${full[1].toUpperCase()}`;
  const short = /^#?([0-9a-f]{3})$/i.exec(trimmed);
  if (!short) return null;
  return `#${short[1]
    .split("")
    .map((character) => `${character}${character}`)
    .join("")
    .toUpperCase()}`;
}

function channelLuminance(value) {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

function contrast(first, second) {
  const light = Math.max(luminance(first), luminance(second));
  const dark = Math.min(luminance(first), luminance(second));
  return (light + 0.05) / (dark + 0.05);
}

function foregroundFor(background) {
  return luminance(background) > 0.34 ? "#111A17" : "#F6F8F7";
}

function resolvedTheme(background = state.background) {
  if (state.palette !== "auto") return state.palette;
  return luminance(background) > 0.34 ? "light" : "dark";
}

function iconPath(theme, family, status, size = state.size, extension = "png") {
  const suffix = extension === "png" ? `-${size}` : "";
  return `./icons/${theme}/${family}/${status}${suffix}.${extension}`;
}

function contrastValues(family, themeName, statusName, background) {
  const theme = themes[themeName];
  const color = theme.colors[statusName];

  if (family === "tile" && (statusName === "normal" || statusName === "complete")) {
    const quietFill = theme.colors.complete.fill;
    return {
      surface: contrast(quietFill, background),
      glyph: contrast(background, quietFill),
    };
  }

  if (family === "ring") {
    return {
      surface: contrast(color.fill, background),
      glyph: contrast(theme.ringGlyph, theme.ringPlate),
    };
  }

  if (family === "badge") {
    return {
      surface: contrast(color.fill, background),
      glyph: contrast(theme.neutralGlyph, theme.neutral),
    };
  }

  return {
    surface: contrast(color.fill, background),
    glyph: contrast(color.glyph, color.fill),
  };
}

function makeIcon(theme, family, status, size = state.size, className = "tray-icon") {
  const image = document.createElement("img");
  image.className = className;
  image.src = iconPath(theme, family, status, size);
  const retinaSize = size * 2;
  if (rasterSizes.has(retinaSize)) {
    image.srcset = `${iconPath(theme, family, status, retinaSize)} 2x`;
  }
  image.alt = `${families[family].name} · ${statuses[status].label} · ${themes[theme].longLabel}`;
  image.width = size;
  image.height = size;
  image.style.setProperty("--icon-size", `${size}px`);
  image.draggable = false;
  return image;
}

function initControls() {
  backgrounds.forEach((background) => {
    const button = document.createElement("button");
    button.className = "preset-button";
    button.type = "button";
    button.dataset.backgroundId = background.id;
    button.setAttribute("aria-pressed", String(background.id === state.backgroundId));
    button.title = `${background.name} ${background.value}`;
    button.innerHTML = `
      <span class="preset-button__swatch" style="background:${background.value}"></span>
      <span class="preset-button__label">${background.short}</span>
    `;
    button.addEventListener("click", () => setBackground(background.value, background.id));
    els.backgroundPresets.append(button);
  });

  ["r", "g", "b"].forEach((channel) => {
    const row = document.createElement("div");
    row.className = "rgb-row";
    row.innerHTML = `
      <label for="${channel}Range">${channel.toUpperCase()}</label>
      <input id="${channel}Range" data-channel="${channel}" data-kind="range" type="range" min="0" max="255" />
      <input data-channel="${channel}" data-kind="number" type="number" min="0" max="255" aria-label="${channel.toUpperCase()} 숫자 값" />
    `;
    row.querySelectorAll("input").forEach((input) => {
      input.addEventListener("input", onRgbInput);
    });
    els.rgbControls.append(row);
  });

  sizes.forEach((size) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.size = String(size);
    button.textContent = size;
    button.setAttribute("aria-pressed", String(size === state.size));
    button.addEventListener("click", () => {
      state.size = size;
      render();
    });
    els.sizeControl.append(button);
  });

  Object.entries(statuses).forEach(([key, value]) => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = value.label;
    els.statusSelect.append(option);
  });
  els.statusSelect.value = state.status;

  els.paletteControl.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-palette]");
    if (!button) return;
    state.palette = button.dataset.palette;
    render();
  });

  els.platformControl.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-platform]");
    if (!button) return;
    state.platform = button.dataset.platform;
    state.size = state.platform === "mac" ? 18 : 16;
    render();
  });

  els.statusSelect.addEventListener("change", () => {
    state.status = els.statusSelect.value;
    render();
  });

  els.colorPicker.addEventListener("input", () => setBackground(els.colorPicker.value, "custom"));
  els.hexInput.addEventListener("input", () => {
    const full = /^#?([0-9a-f]{6})$/i.exec(els.hexInput.value.trim());
    if (full) setBackground(`#${full[1]}`, "custom");
  });
  els.hexInput.addEventListener("change", () => {
    const normalized = normalizeHex(els.hexInput.value);
    if (!normalized) {
      els.hexInput.value = state.background;
      return;
    }
    setBackground(normalized, "custom");
  });

  els.hexInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      els.hexInput.blur();
    }
  });

  els.resetButton.addEventListener("click", () => {
    Object.assign(state, {
      palette: "auto",
      background: "#F5F5F5",
      backgroundId: "mac-light",
      size: 18,
      platform: "mac",
      status: "normal",
      family: "tile",
    });
    els.statusSelect.value = state.status;
    render();
  });
}

function onRgbInput(event) {
  const input = event.currentTarget;
  const value = Math.max(0, Math.min(255, Number(input.value) || 0));
  const rgb = hexToRgb(state.background);
  rgb[input.dataset.channel] = value;
  setBackground(rgbToHex(rgb), "custom");
}

function setBackground(value, id = "custom") {
  state.background = normalizeHex(value) ?? state.background;
  state.backgroundId = id;
  render();
}

function updateControls() {
  const rgb = hexToRgb(state.background);

  els.paletteControl.querySelectorAll("button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.palette === state.palette));
  });

  els.platformControl.querySelectorAll("button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.platform === state.platform));
  });

  els.sizeControl.querySelectorAll("button").forEach((button) => {
    button.setAttribute("aria-pressed", String(Number(button.dataset.size) === state.size));
  });

  els.backgroundPresets.querySelectorAll("button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.backgroundId === state.backgroundId));
  });

  els.rgbControls.querySelectorAll("input").forEach((input) => {
    input.value = String(rgb[input.dataset.channel]);
  });

  els.colorPicker.value = state.background;
  els.hexInput.value = state.background;
  els.sizeOutput.textContent = `${state.size}px`;

  const themeName = resolvedTheme();
  els.resolvedPalette.textContent =
    state.palette === "auto" ? `자동 → ${themes[themeName].longLabel}` : themes[themeName].longLabel;

  const selectedBackground = backgrounds.find((background) => background.id === state.backgroundId);
  els.backgroundName.textContent = selectedBackground?.name ?? "사용자 지정";
}

function renderStage() {
  const themeName = resolvedTheme();
  const foreground = foregroundFor(state.background);
  const selectedFamily = families[state.family];
  const selectedStatus = statuses[state.status];

  els.stage.style.backgroundColor = state.background;
  els.stage.style.color = foreground;
  els.stage.dataset.platform = state.platform;
  els.systemBar.style.backgroundColor = state.background;
  els.systemBar.style.color = foreground;
  els.systemBar.style.borderColor = `${foreground}26`;

  els.systemBarLeft.innerHTML =
    state.platform === "mac"
      ? `<span class="brand-mark">J</span><span>Jungle Bell</span>`
      : `<span class="brand-mark">⊞</span><span>검색</span>`;
  els.systemBarClock.textContent = state.platform === "mac" ? "오후 9:41" : "오후 9:41";
  els.systemBarIcons.replaceChildren();

  if (state.platform === "mac") {
    const wifi = document.createElement("span");
    wifi.className = "system-placeholder system-placeholder--wifi";
    els.systemBarIcons.append(wifi);
  } else {
    ["●", "◆"].forEach((symbol) => {
      const placeholder = document.createElement("span");
      placeholder.className = "system-placeholder";
      placeholder.textContent = symbol;
      els.systemBarIcons.append(placeholder);
    });
  }

  Object.keys(statuses).forEach((statusName) => {
    const button = document.createElement("button");
    button.className = "stage-icon-button";
    button.type = "button";
    button.title = statuses[statusName].label;
    button.setAttribute("aria-label", `${statuses[statusName].label} 아이콘 보기`);
    if (statusName === state.status) {
      button.style.background = `${foreground}14`;
    }
    button.append(makeIcon(themeName, state.family, statusName));
    button.addEventListener("click", () => {
      state.status = statusName;
      els.statusSelect.value = statusName;
      render();
    });
    els.systemBarIcons.append(button);
  });

  els.stageBackgroundChip.textContent = `BG ${state.background}`;
  els.stagePaletteChip.textContent = `${themes[themeName].longLabel} · ${state.size}px`;
  els.selectedTitle.textContent = `${selectedFamily.index} ${selectedFamily.name} · ${selectedStatus.short}`;
  els.selectedDescription.textContent = selectedFamily.description;

  const values = contrastValues(state.family, themeName, state.status, state.background);
  els.contrastPairs.innerHTML = `
    <div class="contrast-chip" data-pass="${values.surface >= 3}">
      <span>색 / 배경</span>
      <strong>${values.surface.toFixed(2)}:1</strong>
    </div>
    <div class="contrast-chip" data-pass="${values.glyph >= 3}">
      <span>문양 / 면</span>
      <strong>${values.glyph.toFixed(2)}:1</strong>
    </div>
  `;

  els.downloadSvg.href = iconPath(themeName, state.family, state.status, state.size, "svg");
  els.downloadSvg.download = `jungle-bell-${themeName}-${state.family}-${state.status}.svg`;
  els.downloadPng.href = iconPath(themeName, state.family, state.status, state.size, "png");
  els.downloadPng.download = `jungle-bell-${themeName}-${state.family}-${state.status}-${state.size}.png`;
}

function renderMatrix() {
  els.comparisonMatrix.replaceChildren();

  const corner = document.createElement("div");
  corner.className = "matrix-corner";
  corner.innerHTML = `형태 × 배경<br /><strong>${statuses[state.status].label}</strong>`;
  els.comparisonMatrix.append(corner);

  matrixBackgrounds.forEach((background) => {
    const header = document.createElement("div");
    header.className = "matrix-header";
    header.innerHTML = `${background.name}<span>${background.value}</span>`;
    els.comparisonMatrix.append(header);
  });

  Object.entries(families).forEach(([familyName, family]) => {
    const label = document.createElement("div");
    label.className = "matrix-label";
    label.innerHTML = `
      <span class="matrix-label__index">${family.index}</span>
      <span class="matrix-label__name">${family.name}</span>
    `;
    els.comparisonMatrix.append(label);

    matrixBackgrounds.forEach((background) => {
      const themeName = luminance(background.value) > 0.34 ? "light" : "dark";
      const ratio = contrastValues(familyName, themeName, state.status, background.value).surface;
      const cell = document.createElement("button");
      cell.className = "matrix-cell";
      cell.type = "button";
      cell.style.background = background.value;
      cell.style.color = foregroundFor(background.value);
      cell.dataset.ratio = `${ratio.toFixed(1)}:1`;
      cell.dataset.selected = String(familyName === state.family);
      cell.title = `${family.name} · ${background.name} · 색/배경 ${ratio.toFixed(2)}:1`;
      cell.append(makeIcon(themeName, familyName, state.status, state.size));
      cell.addEventListener("click", () => {
        state.family = familyName;
        render();
        document.querySelector(".stage-card").scrollIntoView({ behavior: "smooth", block: "start" });
      });
      els.comparisonMatrix.append(cell);
    });
  });
}

function renderFamilyGrid() {
  els.familyGrid.replaceChildren();
  Object.entries(families).forEach(([familyName, family]) => {
    const card = document.createElement("article");
    card.className = "family-card";
    card.dataset.selected = String(familyName === state.family);
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-pressed", String(familyName === state.family));

    const top = document.createElement("div");
    top.className = "family-card__top";
    top.innerHTML = `
      <div>
        <p class="family-card__index">${family.index}</p>
        <h3>${family.name}</h3>
        <p class="family-card__description">${family.description}</p>
      </div>
      ${family.recommended ? `<span class="recommendation">우선 검토</span>` : ""}
    `;
    card.append(top);

    ["light", "dark"].forEach((themeName) => {
      const row = document.createElement("div");
      row.className = "palette-row";
      const label = document.createElement("span");
      label.className = "palette-row__label";
      label.textContent = themes[themeName].label;
      const surface = document.createElement("div");
      surface.className = "palette-row__surface";
      surface.style.background = state.background;

      Object.keys(statuses).forEach((statusName) => {
        const wrapper = document.createElement("div");
        wrapper.className = "palette-row__icon";
        wrapper.append(makeIcon(themeName, familyName, statusName, state.size));
        const statusLabel = document.createElement("span");
        statusLabel.textContent = statuses[statusName].short;
        wrapper.append(statusLabel);
        surface.append(wrapper);
      });

      row.append(label, surface);
      card.append(row);
    });

    const footer = document.createElement("div");
    footer.className = "family-card__footer";
    const swatches = document.createElement("div");
    swatches.className = "status-swatches";
    const activeTheme = themes[resolvedTheme()];
    Object.keys(statuses).forEach((statusName) => {
      const swatch = document.createElement("span");
      swatch.className = "status-swatch";
      swatch.style.background = activeTheme.colors[statusName].fill;
      swatch.title = `${statuses[statusName].label} ${activeTheme.colors[statusName].fill}`;
      swatches.append(swatch);
    });
    footer.append(swatches);
    footer.insertAdjacentHTML("beforeend", `<span class="family-card__hint">선택하여 확대 · SVG/PNG 제공</span>`);
    card.append(footer);

    const select = () => {
      state.family = familyName;
      render();
    };
    card.addEventListener("click", select);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select();
      }
    });

    els.familyGrid.append(card);
  });
}

function render() {
  updateControls();
  renderStage();
  renderMatrix();
  renderFamilyGrid();
}

initControls();
render();
