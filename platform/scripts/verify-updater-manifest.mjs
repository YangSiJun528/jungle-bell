import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

export const REQUIRED_UPDATER_PLATFORMS = Object.freeze([
  "darwin-aarch64",
  "darwin-x86_64",
  "windows-x86_64",
]);

const PLAN_SCHEMA_VERSION = 1;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ASSETS = 512;
const MAX_PLATFORMS = 32;
const MAX_ASSET_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_PLAN_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_ASSET_NAME_BYTES = 240;
const MAX_BASE64_BYTES = 16 * 1024;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/u;
const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SAFE_FILE_NAME_PATTERN =
  /^(?!.*[ .]$)[A-Za-z0-9][A-Za-z0-9._+ -]*$/u;
const WINDOWS_DEVICE_NAME_PATTERN =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export async function prepareUpdaterManifest({
  manifestPath,
  assetsPath,
  tauriConfigPath,
  version,
  repository,
  tag,
  outputPath,
}) {
  validateCliValue(version, SEMVER_PATTERN, "UPDATER_VERSION_INVALID");
  validateCliValue(
    repository,
    REPOSITORY_PATTERN,
    "UPDATER_REPOSITORY_INVALID",
  );
  validateCliValue(tag, TAG_PATTERN, "UPDATER_TAG_INVALID");

  const resolvedOutputPath = resolveOutputPath(outputPath);
  const [manifest, assets, tauriConfig] = await Promise.all([
    readBoundedJson(manifestPath, "UPDATER_MANIFEST_INVALID"),
    readBoundedJson(assetsPath, "UPDATER_ASSETS_INVALID"),
    readBoundedJson(tauriConfigPath, "UPDATER_TAURI_CONFIG_INVALID"),
  ]);

  const publicKey = validateTauriConfig(tauriConfig, version);
  const entries = validateManifest({
    manifest,
    assets,
    version,
    repository,
    tag,
    publicKey,
  });
  const plan = buildPlan(resolvedOutputPath, version, entries);
  const serializedPlan = `${JSON.stringify(plan, null, 2)}\n`;
  if (Buffer.byteLength(serializedPlan, "utf8") > MAX_PLAN_BYTES) {
    throw new Error("UPDATER_PLAN_TOO_LARGE");
  }

  await writePlanFiles({
    outputPath: resolvedOutputPath,
    publicKey,
    entries,
    serializedPlan,
  });
  return plan;
}

export function parseUpdaterManifestArguments(argv) {
  const names = new Map([
    ["--manifest", "manifestPath"],
    ["--assets", "assetsPath"],
    ["--tauri-config", "tauriConfigPath"],
    ["--version", "version"],
    ["--repository", "repository"],
    ["--tag", "tag"],
    ["--output", "outputPath"],
  ]);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const property = names.get(flag);
    if (
      property === undefined ||
      typeof value !== "string" ||
      value.length === 0 ||
      Object.hasOwn(result, property)
    ) {
      throw new Error("UPDATER_ARGUMENTS_INVALID");
    }
    result[property] = value;
  }
  if (Object.keys(result).length !== names.size) {
    throw new Error("UPDATER_ARGUMENTS_INVALID");
  }
  return result;
}

function validateTauriConfig(config, expectedVersion) {
  if (
    !isRecord(config) ||
    config.version !== expectedVersion ||
    !isRecord(config.plugins) ||
    !isRecord(config.plugins.updater)
  ) {
    throw new Error("UPDATER_TAURI_CONFIG_INVALID");
  }
  const publicKey = decodeCanonicalBase64(
    config.plugins.updater.pubkey,
    "UPDATER_PUBLIC_KEY_INVALID",
  );
  validateMinisignPublicKey(publicKey);
  return publicKey;
}

function validateManifest({
  manifest,
  assets,
  version,
  repository,
  tag,
  publicKey,
}) {
  if (
    !isRecord(manifest) ||
    manifest.version !== version ||
    !SEMVER_PATTERN.test(manifest.version ?? "")
  ) {
    throw new Error("UPDATER_MANIFEST_VERSION_INVALID");
  }
  if (!isRfc3339(manifest.pub_date)) {
    throw new Error("UPDATER_MANIFEST_PUB_DATE_INVALID");
  }
  if (!isRecord(manifest.platforms)) {
    throw new Error("UPDATER_PLATFORMS_INVALID");
  }
  const platformNames = Object.keys(manifest.platforms);
  if (
    platformNames.length < REQUIRED_UPDATER_PLATFORMS.length ||
    platformNames.length > MAX_PLATFORMS
  ) {
    throw new Error("UPDATER_PLATFORMS_INVALID");
  }

  const { assetsByName, assetsByUrl } = indexAssets(
    assets,
    repository,
    tag,
  );
  const entries = [];
  for (const platform of REQUIRED_UPDATER_PLATFORMS) {
    const value = manifest.platforms[platform];
    if (!isRecord(value)) {
      throw new Error("UPDATER_REQUIRED_PLATFORM_MISSING");
    }
    const artifactName = validateReleaseUrl(value.url, assetsByUrl);
    const encodedSignature = value.signature;
    const signature = decodeCanonicalBase64(
      encodedSignature,
      "UPDATER_SIGNATURE_INVALID",
    );
    validateMinisignSignature(signature, publicKey);

    const artifact = requireUniqueAsset(assetsByName, artifactName);
    const signatureAsset = requireUniqueAsset(
      assetsByName,
      `${artifactName}.sig`,
    );
    entries.push({
      platform,
      artifact,
      signatureAsset,
      encodedSignature,
      decodedSignature: signature,
    });
  }
  return entries;
}

function indexAssets(value, repository, tag) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ASSETS) {
    throw new Error("UPDATER_ASSETS_INVALID");
  }
  const byName = new Map();
  const byUrl = new Map();
  const ids = new Set();
  for (const asset of value) {
    if (!isRecord(asset)) {
      throw new Error("UPDATER_ASSET_METADATA_INVALID");
    }
    const name = validateSafeAssetName(asset.name);
    const id = validateAssetId(asset.id);
    const apiUrl = `https://api.github.com/repos/${repository}/releases/assets/${id}`;
    const browserDownloadUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
    if (
      !Number.isSafeInteger(asset.size) ||
      asset.size < 1 ||
      asset.size > MAX_ASSET_BYTES ||
      asset.state !== "uploaded" ||
      typeof asset.digest !== "string" ||
      !SHA256_DIGEST_PATTERN.test(asset.digest) ||
      asset.url !== apiUrl ||
      asset.browser_download_url !== browserDownloadUrl ||
      ids.has(id)
    ) {
      throw new Error("UPDATER_ASSET_METADATA_INVALID");
    }
    ids.add(id);
    const indexedAsset = {
      id,
      name,
      size: asset.size,
      digest: asset.digest,
    };
    const matches = byName.get(name) ?? [];
    matches.push(indexedAsset);
    byName.set(name, matches);
    for (const url of [apiUrl, browserDownloadUrl]) {
      const urlMatches = byUrl.get(url) ?? [];
      urlMatches.push(indexedAsset);
      byUrl.set(url, urlMatches);
    }
  }
  return { assetsByName: byName, assetsByUrl: byUrl };
}

function requireUniqueAsset(assetsByName, name) {
  const matches = assetsByName.get(name);
  if (matches === undefined) {
    throw new Error("UPDATER_ASSET_MISSING");
  }
  if (matches.length !== 1) {
    throw new Error("UPDATER_ASSET_AMBIGUOUS");
  }
  return matches[0];
}

function validateReleaseUrl(value, assetsByUrl) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > 2048
  ) {
    throw new Error("UPDATER_URL_INVALID");
  }
  const matches = assetsByUrl.get(value);
  if (matches === undefined || matches.length !== 1) {
    throw new Error("UPDATER_URL_INVALID");
  }
  return matches[0].name;
}

function validateSafeAssetName(value) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_ASSET_NAME_BYTES ||
    !SAFE_FILE_NAME_PATTERN.test(value) ||
    WINDOWS_DEVICE_NAME_PATTERN.test(value)
  ) {
    throw new Error("UPDATER_ASSET_NAME_INVALID");
  }
  return value;
}

function validateAssetId(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("UPDATER_ASSET_METADATA_INVALID");
  }
  return value;
}

function decodeCanonicalBase64(value, errorCode) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "ascii") > MAX_BASE64_BYTES ||
    !BASE64_PATTERN.test(value)
  ) {
    throw new Error(errorCode);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    throw new Error(errorCode);
  }
  return decoded;
}

function validateMinisignPublicKey(value) {
  const lines = minisignLines(value, "UPDATER_PUBLIC_KEY_INVALID");
  if (
    lines.length !== 2 ||
    !isMinisignComment(lines[0], "untrusted comment: ")
  ) {
    throw new Error("UPDATER_PUBLIC_KEY_INVALID");
  }
  const packet = decodeCanonicalBase64(
    lines[1],
    "UPDATER_PUBLIC_KEY_INVALID",
  );
  if (
    packet.length !== 42 ||
    packet[0] !== 0x45 ||
    ![0x44, 0x64].includes(packet[1])
  ) {
    throw new Error("UPDATER_PUBLIC_KEY_INVALID");
  }
}

function validateMinisignSignature(value, publicKey) {
  const lines = minisignLines(value, "UPDATER_SIGNATURE_INVALID");
  if (
    lines.length !== 4 ||
    !isMinisignComment(lines[0], "untrusted comment: ") ||
    !isMinisignComment(lines[2], "trusted comment: ")
  ) {
    throw new Error("UPDATER_SIGNATURE_INVALID");
  }
  const signaturePacket = decodeCanonicalBase64(
    lines[1],
    "UPDATER_SIGNATURE_INVALID",
  );
  const globalSignature = decodeCanonicalBase64(
    lines[3],
    "UPDATER_SIGNATURE_INVALID",
  );
  if (
    signaturePacket.length !== 74 ||
    signaturePacket[0] !== 0x45 ||
    ![0x44, 0x64].includes(signaturePacket[1]) ||
    globalSignature.length !== 64
  ) {
    throw new Error("UPDATER_SIGNATURE_INVALID");
  }

  const publicKeyPacket = decodeCanonicalBase64(
    minisignLines(publicKey, "UPDATER_PUBLIC_KEY_INVALID")[1],
    "UPDATER_PUBLIC_KEY_INVALID",
  );
  if (!signaturePacket.subarray(2, 10).equals(publicKeyPacket.subarray(2, 10))) {
    throw new Error("UPDATER_SIGNATURE_KEY_MISMATCH");
  }
}

function minisignLines(value, errorCode) {
  let text;
  try {
    text = utf8Decoder.decode(value);
  } catch {
    throw new Error(errorCode);
  }
  if (
    text.includes("\r") ||
    text.includes("\0") ||
    Buffer.byteLength(text, "utf8") > MAX_BASE64_BYTES
  ) {
    throw new Error(errorCode);
  }
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (normalized.length === 0 || normalized.endsWith("\n")) {
    throw new Error(errorCode);
  }
  return normalized.split("\n");
}

function isMinisignComment(value, prefix) {
  return (
    typeof value === "string" &&
    value.startsWith(prefix) &&
    value.length > prefix.length &&
    value.length <= 256 &&
    /^[\t\u0020-\u007e]+$/u.test(value)
  );
}

function isRfc3339(value) {
  if (typeof value !== "string") {
    return false;
  }
  const match = RFC3339_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const [, year, month, day, hour, minute, second, , zone] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const [yearNumber, monthNumber, dayNumber, hourNumber, minuteNumber, secondNumber] =
    parts;
  const date = new Date(
    Date.UTC(
      yearNumber,
      monthNumber - 1,
      dayNumber,
      hourNumber,
      minuteNumber,
      secondNumber,
    ),
  );
  if (
    date.getUTCFullYear() !== yearNumber ||
    date.getUTCMonth() + 1 !== monthNumber ||
    date.getUTCDate() !== dayNumber ||
    hourNumber > 23 ||
    minuteNumber > 59 ||
    secondNumber > 59
  ) {
    return false;
  }
  if (zone !== "Z") {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 23 || zoneMinute > 59) {
      return false;
    }
  }
  return Number.isFinite(Date.parse(value));
}

function buildPlan(outputPath, version, entries) {
  const root = path.dirname(outputPath);
  const publicKeyPath = safeChild(root, "updater.pub");
  if (publicKeyPath === outputPath) {
    throw new Error("UPDATER_OUTPUT_PATH_INVALID");
  }
  const artifactDirectory = safeChild(root, "artifacts");
  const releaseSignatureDirectory = safeChild(root, "release-signatures");
  const manifestSignatureDirectory = safeChild(root, "manifest-signatures");
  const decodedSignatureDirectory = safeChild(root, "decoded-signatures");
  const paths = new Set([outputPath, publicKeyPath]);
  const platforms = entries.map((entry) => {
    const artifactOutputPath = safeChild(
      artifactDirectory,
      entry.artifact.name,
    );
    const releaseSignatureOutputPath = safeChild(
      releaseSignatureDirectory,
      entry.signatureAsset.name,
    );
    const manifestSignaturePath = safeChild(
      manifestSignatureDirectory,
      entry.signatureAsset.name,
    );
    const decodedSignaturePath = safeChild(
      decodedSignatureDirectory,
      entry.signatureAsset.name,
    );
    for (const candidate of [
      artifactOutputPath,
      releaseSignatureOutputPath,
      manifestSignaturePath,
      decodedSignaturePath,
    ]) {
      if (paths.has(candidate)) {
        throw new Error("UPDATER_OUTPUT_PATH_COLLISION");
      }
      paths.add(candidate);
    }
    return {
      platform: entry.platform,
      artifact: {
        assetId: entry.artifact.id,
        name: entry.artifact.name,
        size: entry.artifact.size,
        digest: entry.artifact.digest,
        outputPath: artifactOutputPath,
      },
      releaseSignature: {
        assetId: entry.signatureAsset.id,
        name: entry.signatureAsset.name,
        size: entry.signatureAsset.size,
        digest: entry.signatureAsset.digest,
        outputPath: releaseSignatureOutputPath,
      },
      manifestSignaturePath,
      decodedSignaturePath,
    };
  });
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    version,
    publicKeyPath,
    platforms,
  };
}

async function writePlanFiles({
  outputPath,
  publicKey,
  entries,
  serializedPlan,
}) {
  const root = path.dirname(outputPath);
  const publicKeyPath = safeChild(root, "updater.pub");
  const manifestSignatureDirectory = safeChild(root, "manifest-signatures");
  const decodedSignatureDirectory = safeChild(root, "decoded-signatures");
  await Promise.all([
    mkdir(root, { recursive: true, mode: 0o700 }),
    mkdir(safeChild(root, "artifacts"), { recursive: true, mode: 0o700 }),
    mkdir(safeChild(root, "release-signatures"), {
      recursive: true,
      mode: 0o700,
    }),
    mkdir(manifestSignatureDirectory, { recursive: true, mode: 0o700 }),
    mkdir(decodedSignatureDirectory, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(publicKeyPath, publicKey, { flag: "wx", mode: 0o600 });
  for (const entry of entries) {
    await writeFile(
      safeChild(manifestSignatureDirectory, entry.signatureAsset.name),
      entry.encodedSignature,
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      safeChild(decodedSignatureDirectory, entry.signatureAsset.name),
      entry.decodedSignature,
      { flag: "wx", mode: 0o600 },
    );
  }
  await writeFile(outputPath, serializedPlan, { flag: "wx", mode: 0o600 });
}

function safeChild(directory, name) {
  const resolvedDirectory = path.resolve(directory);
  const candidate = path.resolve(resolvedDirectory, name);
  if (
    path.dirname(candidate) !== resolvedDirectory ||
    Buffer.byteLength(candidate, "utf8") > MAX_PATH_BYTES
  ) {
    throw new Error("UPDATER_OUTPUT_PATH_INVALID");
  }
  return candidate;
}

function resolveOutputPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES
  ) {
    throw new Error("UPDATER_OUTPUT_PATH_INVALID");
  }
  const resolved = path.resolve(value);
  if (path.basename(resolved) === "updater.pub") {
    throw new Error("UPDATER_OUTPUT_PATH_INVALID");
  }
  return resolved;
}

function validateCliValue(value, pattern, errorCode) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 256 ||
    !pattern.test(value)
  ) {
    throw new Error(errorCode);
  }
}

async function readBoundedJson(filePath, errorCode) {
  if (
    typeof filePath !== "string" ||
    filePath.length === 0 ||
    Buffer.byteLength(filePath, "utf8") > MAX_PATH_BYTES
  ) {
    throw new Error(errorCode);
  }
  let handle;
  try {
    handle = await open(filePath, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_JSON_BYTES) {
      throw new Error(errorCode);
    }
    const value = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(value, "utf8") > MAX_JSON_BYTES) {
      throw new Error(errorCode);
    }
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof Error && error.message === errorCode) {
      throw error;
    }
    throw new Error(errorCode);
  } finally {
    await handle?.close();
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function main() {
  const options = parseUpdaterManifestArguments(process.argv.slice(2));
  const plan = await prepareUpdaterManifest(options);
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    const message =
      error instanceof Error ? error.message : "UPDATER_MANIFEST_FAILED";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
