import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const iconDirectory = dirname(fileURLToPath(import.meta.url));
const documentationIconDirectory = resolve(iconDirectory, '../../docs/assets/readme');
const source = readFileSync(join(iconDirectory, 'tray-source.svg'), 'utf8');
const artwork = source.slice(source.indexOf('  <defs>'), source.lastIndexOf('</svg>')).trim();
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'jungle-bell-tray-icons-'));

const palettes = {
  light: {
    normal: '#24313B',
    offline: '#536170',
    warning: '#A94D00',
    alert: '#B4232C',
    complete: '#24313B',
  },
  dark: {
    normal: '#EEF2F3',
    offline: '#9DA9B8',
    warning: '#F29A38',
    alert: '#F05D65',
    complete: '#EEF2F3',
  },
};

const targets = [
  {size: 36, suffix: ''},
  {size: 48, suffix: '-windows'},
];

const documentationTitles = {
  normal: '정상 상태 트레이 아이콘',
  offline: '오프라인 상태 트레이 아이콘',
  warning: '로그인 필요 상태 트레이 아이콘',
  alert: '출석 필요 상태 트레이 아이콘',
  complete: '출석 완료 상태 트레이 아이콘',
};

mkdirSync(documentationIconDirectory, {recursive: true});

try {
  for (const [theme, colors] of Object.entries(palettes)) {
    for (const [status, color] of Object.entries(colors)) {
      const themedSource = source
        .replace('#24313B', color)
        .replace('Jungle Bell tray icon', `Jungle Bell ${status} ${theme} tray icon`);
      const temporarySvg = join(temporaryDirectory, `${status}-${theme}.svg`);
      writeFileSync(temporarySvg, themedSource);

      for (const {size, suffix} of targets) {
        execFileSync('rsvg-convert', [
          '--width',
          String(size),
          '--height',
          String(size),
          '--output',
          join(iconDirectory, `tray-${status}-${theme}${suffix}.png`),
          temporarySvg,
        ]);
      }
    }
  }

  for (const [status, color] of Object.entries(palettes.light)) {
    const indentedArtwork = artwork
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n');
    const documentationSvg = `<svg width="52" height="44" viewBox="0 0 52 44" color="${color}" xmlns="http://www.w3.org/2000/svg">
  <title>${documentationTitles[status]}</title>
  <rect width="52" height="44" rx="8" fill="#F5F5F5"/>
  <g transform="translate(4 0)">
${indentedArtwork}
  </g>
</svg>
`;
    writeFileSync(join(documentationIconDirectory, `readme-status-${status}.svg`), documentationSvg);
  }
} finally {
  rmSync(temporaryDirectory, {recursive: true, force: true});
}
