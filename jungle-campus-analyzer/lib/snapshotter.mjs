import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** "YYYY-MM-DDTHH-MM-SS.json" 형식 타임스탬프 파일명 생성 */
export function timestampedFilename() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `${date}T${time}.json`;
}

/** logs/ 에서 가장 최근 스냅샷 파일을 읽어 반환 (없으면 null) */
export async function loadLatestSnapshot(logsDir) {
  try {
    const files = (await readdir(logsDir))
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    const content = await readFile(join(logsDir, files[0]), 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** report 전체를 logs/{timestamp}.json 에 저장 */
export async function saveSnapshot(report, logsDir) {
  const filename = timestampedFilename();
  const filePath = join(logsDir, filename);
  await writeFile(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

/** diffResult를 changes/{timestamp}.json 에 저장 (변경 있을 때만 호출) */
export async function saveChanges(diffResult, changesDir) {
  const filename = timestampedFilename();
  const filePath = join(changesDir, filename);
  const payload = {
    timestamp: new Date().toISOString(),
    changeCount: diffResult.changes.length,
    firstRun: diffResult.firstRun ?? false,
    changes: diffResult.changes,
  };
  await writeFile(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}
