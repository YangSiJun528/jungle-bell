import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  REQUIRED_UPDATER_PLATFORMS,
  parseUpdaterManifestArguments,
  prepareUpdaterManifest,
} from "./verify-updater-manifest.mjs";

describe("verify-updater-manifest", () => {
  it("prepares a bounded verification plan and decoded minisign files", async () => {
    await withFixture({}, async ({ paths, values, signatureText, keyText }) => {
      const plan = await prepareUpdaterManifest(paths);
      const serialized = await readFile(paths.outputPath, "utf8");

      assert.equal(plan.schemaVersion, 1);
      assert.equal(plan.version, values.version);
      assert.deepEqual(
        plan.platforms.map(({ platform }) => platform),
        REQUIRED_UPDATER_PLATFORMS,
      );
      assert.equal(await readFile(plan.publicKeyPath, "utf8"), keyText);
      for (const entry of plan.platforms) {
        assert.ok(Number.isSafeInteger(entry.artifact.assetId));
        assert.ok(Number.isSafeInteger(entry.artifact.size));
        assert.match(entry.artifact.digest, /^sha256:[0-9a-f]{64}$/u);
        assert.ok(Number.isSafeInteger(entry.releaseSignature.assetId));
        assert.ok(Number.isSafeInteger(entry.releaseSignature.size));
        assert.match(
          entry.releaseSignature.digest,
          /^sha256:[0-9a-f]{64}$/u,
        );
        assert.equal(
          await readFile(entry.manifestSignaturePath, "utf8"),
          values.signature,
        );
        assert.equal(
          await readFile(entry.decodedSignaturePath, "utf8"),
          signatureText,
        );
        assert.equal(
          path.dirname(entry.artifact.outputPath),
          path.join(path.dirname(paths.outputPath), "artifacts"),
        );
        assert.equal(
          path.dirname(entry.releaseSignature.outputPath),
          path.join(path.dirname(paths.outputPath), "release-signatures"),
        );
      }
      assert.ok(Buffer.byteLength(serialized, "utf8") < 64 * 1024);
      assert.doesNotMatch(serialized, /untrusted comment:/u);
      assert.equal(serialized.includes(values.publicKey), false);
      assert.equal(serialized.includes(values.signature), false);
      assert.equal(serialized.includes("https://github.com"), false);
    });
  });

  it("rejects a missing required platform", async () => {
    await withFixture(
      {
        mutate(values) {
          delete values.manifest.platforms["darwin-x86_64"];
        },
      },
      async ({ paths }) => {
        await assert.rejects(
          prepareUpdaterManifest(paths),
          /UPDATER_PLATFORMS_INVALID|UPDATER_REQUIRED_PLATFORM_MISSING/u,
        );
      },
    );
  });

  it("rejects a manifest version other than the full expected SemVer", async () => {
    await withFixture(
      {
        mutate(values) {
          values.manifest.version = "0.5";
        },
      },
      async ({ paths }) => {
        await assert.rejects(
          prepareUpdaterManifest(paths),
          /UPDATER_MANIFEST_VERSION_INVALID/u,
        );
      },
    );
  });

  it("rejects host, repository, and tag-confused artifact URLs", async (context) => {
    await context.test("wrong host", async () => {
      await withFixture(
        {
          mutate(values) {
            const entry = values.manifest.platforms["darwin-aarch64"];
            entry.url = entry.url.replace("github.com", "github.example");
          },
        },
        async ({ paths }) => {
          await assert.rejects(
            prepareUpdaterManifest(paths),
            /UPDATER_URL_INVALID/u,
          );
        },
      );
    });

    await context.test("wrong repository", async () => {
      await withFixture(
        {
          mutate(values) {
            const entry = values.manifest.platforms["darwin-aarch64"];
            entry.url = entry.url.replace(
              "/YangSiJun528/jungle-bell/",
              "/YangSiJun528/another-repository/",
            );
          },
        },
        async ({ paths }) => {
          await assert.rejects(
            prepareUpdaterManifest(paths),
            /UPDATER_URL_INVALID/u,
          );
        },
      );
    });

    await context.test("wrong tag", async () => {
      await withFixture(
        {
          mutate(values) {
            const entry = values.manifest.platforms["darwin-aarch64"];
            entry.url = entry.url.replace(
              "/platform-v0.5.0/",
              "/platform-v0.5.1/",
            );
          },
        },
        async ({ paths }) => {
          await assert.rejects(
            prepareUpdaterManifest(paths),
            /UPDATER_URL_INVALID/u,
          );
        },
      );
    });
  });

  it("accepts the exact GitHub API asset URLs emitted by tauri-action", async () => {
    await withFixture(
      {
        mutate(values) {
          for (const [index, platform] of REQUIRED_UPDATER_PLATFORMS.entries()) {
            const asset = values.assets.find(
              ({ name }) => name === values.artifactNames[index],
            );
            values.manifest.platforms[platform].url = asset.url;
          }
        },
      },
      async ({ paths }) => {
        const plan = await prepareUpdaterManifest(paths);
        assert.equal(plan.platforms.length, 3);
      },
    );
  });

  it("rejects a GitHub API URL not bound to the release asset metadata", async () => {
    await withFixture(
      {
        mutate(values) {
          values.manifest.platforms["darwin-aarch64"].url =
            `https://api.github.com/repos/${values.repository}/releases/assets/999999`;
        },
      },
      async ({ paths }) => {
        await assert.rejects(
          prepareUpdaterManifest(paths),
          /UPDATER_URL_INVALID/u,
        );
      },
    );
  });

  it("rejects missing and empty release assets", async (context) => {
    await context.test("missing artifact", async () => {
      await withFixture(
        {
          mutate(values) {
            values.assets = values.assets.filter(
              ({ name }) => name !== values.artifactNames[0],
            );
          },
        },
        async ({ paths }) => {
          await assert.rejects(
            prepareUpdaterManifest(paths),
            /UPDATER_ASSET_MISSING|UPDATER_URL_INVALID/u,
          );
        },
      );
    });

    await context.test("empty detached signature", async () => {
      await withFixture(
        {
          mutate(values) {
            const signatureAsset = values.assets.find(({ name }) =>
              name.endsWith(".sig"),
            );
            signatureAsset.size = 0;
          },
        },
        async ({ paths }) => {
          await assert.rejects(
            prepareUpdaterManifest(paths),
            /UPDATER_ASSET_METADATA_INVALID/u,
          );
        },
      );
    });
  });

  it("rejects malformed manifest signatures and updater public keys", async (context) => {
    await context.test("malformed signature", async () => {
      await withFixture(
        {
          mutate(values) {
            values.manifest.platforms["windows-x86_64"].signature =
              Buffer.from("not a minisign file\n", "utf8").toString("base64");
          },
        },
        async ({ paths }) => {
          await assert.rejects(
            prepareUpdaterManifest(paths),
            /UPDATER_SIGNATURE_INVALID/u,
          );
        },
      );
    });

    await context.test("non-canonical outer signature base64", async () => {
      await withFixture(
        {
          mutate(values) {
            values.manifest.platforms["windows-x86_64"].signature += "\n";
          },
        },
        async ({ paths }) => {
          await assert.rejects(
            prepareUpdaterManifest(paths),
            /UPDATER_SIGNATURE_INVALID/u,
          );
        },
      );
    });

    await context.test("malformed public key", async () => {
      await withFixture(
        {
          mutate(values) {
            values.tauriConfig.plugins.updater.pubkey = Buffer.from(
              "not a minisign key\n",
              "utf8",
            ).toString("base64");
          },
        },
        async ({ paths }) => {
          await assert.rejects(
            prepareUpdaterManifest(paths),
            /UPDATER_PUBLIC_KEY_INVALID/u,
          );
        },
      );
    });
  });

  it("accepts a complete prerelease SemVer and tag", async () => {
    const version = "0.6.0-rc.1";
    await withFixture(
      { version, tag: `platform-v${version}` },
      async ({ paths }) => {
        const plan = await prepareUpdaterManifest(paths);
        assert.equal(plan.version, version);
      },
    );
  });

  it("requires every named CLI argument exactly once", () => {
    const parsed = parseUpdaterManifestArguments([
      "--manifest",
      "latest.json",
      "--assets",
      "assets.json",
      "--tauri-config",
      "tauri.conf.json",
      "--version",
      "0.5.0",
      "--repository",
      "owner/repository",
      "--tag",
      "platform-v0.5.0",
      "--output",
      "plan.json",
    ]);
    assert.equal(parsed.manifestPath, "latest.json");
    assert.equal(parsed.outputPath, "plan.json");
    assert.throws(
      () =>
        parseUpdaterManifestArguments([
          "--manifest",
          "one.json",
          "--manifest",
          "two.json",
        ]),
      /UPDATER_ARGUMENTS_INVALID/u,
    );
  });
});

async function withFixture(options, assertion) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jb-updater-"));
  try {
    const values = buildFixture(options);
    options.mutate?.(values);
    const manifestPath = path.join(directory, "latest.json");
    const assetsPath = path.join(directory, "assets.json");
    const tauriConfigPath = path.join(directory, "tauri.conf.json");
    const outputPath = path.join(directory, "verification", "plan.json");
    await Promise.all([
      writeFile(manifestPath, JSON.stringify(values.manifest), "utf8"),
      writeFile(assetsPath, JSON.stringify(values.assets), "utf8"),
      writeFile(tauriConfigPath, JSON.stringify(values.tauriConfig), "utf8"),
    ]);
    await assertion({
      paths: {
        manifestPath,
        assetsPath,
        tauriConfigPath,
        version: values.version,
        repository: values.repository,
        tag: values.tag,
        outputPath,
      },
      values,
      keyText: values.keyText,
      signatureText: values.signatureText,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function buildFixture({
  version = "0.5.0",
  tag = `platform-v${version}`,
} = {}) {
  const repository = "YangSiJun528/jungle-bell";
  const keyId = Buffer.from("0102030405060708", "hex");
  const publicKeyPacket = Buffer.concat([
    Buffer.from("Ed", "ascii"),
    keyId,
    Buffer.alloc(32, 0x11),
  ]);
  const signaturePacket = Buffer.concat([
    Buffer.from("ED", "ascii"),
    keyId,
    Buffer.alloc(64, 0x22),
  ]);
  const keyText = [
    "untrusted comment: minisign public key: 0807060504030201",
    publicKeyPacket.toString("base64"),
    "",
  ].join("\n");
  const signatureText = [
    "untrusted comment: signature from minisign secret key",
    signaturePacket.toString("base64"),
    "trusted comment: timestamp:1785715200\tfile:Jungle Bell.app.tar.gz",
    Buffer.alloc(64, 0x33).toString("base64"),
    "",
  ].join("\n");
  const publicKey = Buffer.from(keyText, "utf8").toString("base64");
  const signature = Buffer.from(signatureText, "utf8").toString("base64");
  const artifactNames = [
    `Jungle-Bell_${version}_aarch64.app.tar.gz`,
    `Jungle-Bell_${version}_x64.app.tar.gz`,
    `Jungle-Bell_${version}_x64-setup.nsis.zip`,
  ];
  const platforms = Object.fromEntries(
    REQUIRED_UPDATER_PLATFORMS.map((platform, index) => [
      platform,
      {
        signature,
        url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(artifactNames[index])}`,
      },
    ]),
  );
  const asset = (id, name, size) => ({
    id,
    name,
    size,
    state: "uploaded",
    digest: `sha256:${id.toString(16).padStart(64, "0")}`,
    url: `https://api.github.com/repos/${repository}/releases/assets/${id}`,
    browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(name)}`,
  });
  const assets = artifactNames.flatMap((name, index) => [
    asset(1000 + index * 2, name, 1024 + index),
    asset(1001 + index * 2, `${name}.sig`, 256),
  ]);
  return {
    version,
    repository,
    tag,
    keyText,
    signatureText,
    publicKey,
    signature,
    artifactNames,
    manifest: {
      version,
      notes: "Release notes are not copied to the verification plan.",
      pub_date: "2026-08-03T00:00:00Z",
      platforms,
    },
    assets,
    tauriConfig: {
      version,
      plugins: { updater: { pubkey: publicKey } },
    },
  };
}
