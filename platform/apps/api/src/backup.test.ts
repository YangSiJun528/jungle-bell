import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  backupSqliteDatabase,
  DEFAULT_BACKUP_RETENTION_DAYS,
  MAX_BACKUP_RETENTION_DAYS,
  parseBackupRetentionDays,
} from "./backup.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("SQLite online backup", () => {
  it("creates an integrity and foreign-key checked snapshot from a WAL database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jungle-bell-backup-"));
    directories.push(directory);
    const sourcePath = join(directory, "source.sqlite");
    const source = new Database(sourcePath);
    source.pragma("journal_mode = WAL");
    source.pragma("foreign_keys = ON");
    source.exec(`
      CREATE TABLE parent_table (
        id INTEGER PRIMARY KEY
      ) STRICT;
      CREATE TABLE values_table (
        value TEXT NOT NULL,
        parent_id INTEGER NOT NULL REFERENCES parent_table(id)
      ) STRICT;
      INSERT INTO parent_table (id) VALUES (1);
    `);
    source
      .prepare(
        "INSERT INTO values_table (value, parent_id) VALUES (?, ?)",
      )
      .run("preserved", 1);

    const destination = await backupSqliteDatabase({
      sourcePath,
      backupDirectory: join(directory, "backups"),
      now: new Date("2030-01-02T03:04:05.000Z"),
    });
    source.close();

    const backup = new Database(destination, {
      fileMustExist: true,
      readonly: true,
    });
    expect(
      backup
        .prepare(
          "SELECT value FROM values_table WHERE parent_id = 1",
        )
        .pluck()
        .get(),
    ).toBe("preserved");
    expect(
      backup.pragma("foreign_key_check"),
    ).toEqual([]);
    expect(
      backup.pragma("journal_mode", { simple: true }),
    ).toBe("delete");
    backup.close();
    expect(await readdir(join(directory, "backups"))).toEqual([
      "jungle-bell-20300102T030405Z.sqlite",
    ]);
    expect((await lstat(destination)).nlink).toBe(1);
  });

  it("rejects a snapshot containing foreign-key violations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jungle-bell-backup-"));
    directories.push(directory);
    const sourcePath = join(directory, "source.sqlite");
    const source = new Database(sourcePath);
    source.pragma("foreign_keys = OFF");
    source.exec(`
      CREATE TABLE parent_table (
        id INTEGER PRIMARY KEY
      ) STRICT;
      CREATE TABLE child_table (
        parent_id INTEGER NOT NULL REFERENCES parent_table(id)
      ) STRICT;
      INSERT INTO child_table (parent_id) VALUES (404);
    `);
    source.close();

    await expect(
      backupSqliteDatabase({
        sourcePath,
        backupDirectory: join(directory, "backups"),
        now: new Date("2030-01-02T03:04:05.000Z"),
      }),
    ).rejects.toThrow("SQLITE_BACKUP_FOREIGN_KEY_FAILED");
    expect(await readdir(join(directory, "backups"))).toEqual([]);
  });

  it("prunes only expired regular Jungle Bell backups", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jungle-bell-backup-"));
    directories.push(directory);
    const sourcePath = join(directory, "source.sqlite");
    const source = new Database(sourcePath);
    source.exec("CREATE TABLE values_table (value TEXT NOT NULL) STRICT");
    source
      .prepare("INSERT INTO values_table (value) VALUES (?)")
      .run("preserved");
    source.close();

    const backupDirectory = join(directory, "backups");
    await mkdir(backupDirectory);
    const expiredBackup =
      "jungle-bell-20291101T000000Z.sqlite";
    const retainedBackup =
      "jungle-bell-20291215T030405Z.sqlite";
    const unrelatedFile = "operator-notes.sqlite";
    const malformedBackup =
      "jungle-bell-20291101T000000Z.sqlite.partial";
    const invalidDateBackup =
      "jungle-bell-20291301T000000Z.sqlite";
    const backupNamedDirectory =
      "jungle-bell-20290801T000000Z.sqlite";
    for (const backupName of [expiredBackup, retainedBackup]) {
      const previousBackup = new Database(
        join(backupDirectory, backupName),
      );
      previousBackup.exec(
        "CREATE TABLE values_table (value TEXT NOT NULL) STRICT",
      );
      previousBackup.close();
    }
    await writeFile(join(backupDirectory, unrelatedFile), "unrelated");
    await writeFile(join(backupDirectory, malformedBackup), "partial");
    await writeFile(join(backupDirectory, invalidDateBackup), "invalid");
    await mkdir(join(backupDirectory, backupNamedDirectory));

    const symlinkTarget = join(directory, "outside-backup.txt");
    const expiredSymlink =
      "jungle-bell-20291001T000000Z.sqlite";
    await writeFile(symlinkTarget, "do not remove");
    await symlink(
      symlinkTarget,
      join(backupDirectory, expiredSymlink),
    );

    const sourceHardLink =
      "jungle-bell-20290901T000000Z.sqlite";
    await link(sourcePath, join(backupDirectory, sourceHardLink));

    const destination = await backupSqliteDatabase({
      sourcePath,
      backupDirectory,
      retentionDays: 30,
      now: new Date("2030-01-02T03:04:05.000Z"),
    });

    const names = await readdir(backupDirectory);
    expect(names).not.toContain(expiredBackup);
    expect(names).toEqual(
      expect.arrayContaining([
        retainedBackup,
        unrelatedFile,
        malformedBackup,
        invalidDateBackup,
        backupNamedDirectory,
        expiredSymlink,
        sourceHardLink,
        "jungle-bell-20300102T030405Z.sqlite",
      ]),
    );
    expect(destination).toBe(
      join(
        backupDirectory,
        "jungle-bell-20300102T030405Z.sqlite",
      ),
    );
    expect(
      (await lstat(join(backupDirectory, expiredSymlink)))
        .isSymbolicLink(),
    ).toBe(true);
    expect(await readFile(symlinkTarget, "utf8")).toBe(
      "do not remove",
    );

    const sourceAfterBackup = new Database(sourcePath, {
      fileMustExist: true,
      readonly: true,
    });
    expect(
      sourceAfterBackup
        .prepare("SELECT value FROM values_table")
        .pluck()
        .get(),
    ).toBe("preserved");
    sourceAfterBackup.close();
  });

  it("does not follow a backup-directory symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jungle-bell-backup-"));
    directories.push(directory);
    const sourcePath = join(directory, "source.sqlite");
    const source = new Database(sourcePath);
    source.exec("CREATE TABLE values_table (value TEXT NOT NULL) STRICT");
    source.close();

    const targetDirectory = join(directory, "target");
    const backupDirectory = join(directory, "backups");
    await mkdir(targetDirectory);
    await symlink(targetDirectory, backupDirectory);

    await expect(
      backupSqliteDatabase({
        sourcePath,
        backupDirectory,
        now: new Date("2030-01-02T03:04:05.000Z"),
      }),
    ).rejects.toThrow("SQLITE_BACKUP_DIRECTORY_UNSAFE");
    expect(await readdir(targetDirectory)).toEqual([]);
  });

  it("does not overwrite an existing file or symlink at the destination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jungle-bell-backup-"));
    directories.push(directory);
    const sourcePath = join(directory, "source.sqlite");
    const source = new Database(sourcePath);
    source.exec("CREATE TABLE values_table (value TEXT NOT NULL) STRICT");
    source.close();

    const backupDirectory = join(directory, "backups");
    const targetPath = join(directory, "outside-backup.txt");
    await mkdir(backupDirectory);
    await writeFile(targetPath, "untouched");
    const existingDestination = join(
      backupDirectory,
      "jungle-bell-20300102T030405Z.sqlite",
    );
    await writeFile(existingDestination, "operator data");

    await expect(
      backupSqliteDatabase({
        sourcePath,
        backupDirectory,
        now: new Date("2030-01-02T03:04:05.000Z"),
      }),
    ).rejects.toThrow("SQLITE_BACKUP_DESTINATION_EXISTS");
    expect(await readFile(existingDestination, "utf8")).toBe(
      "operator data",
    );

    const symlinkDestination = join(
      backupDirectory,
      "jungle-bell-20300102T030406Z.sqlite",
    );
    await symlink(
      targetPath,
      symlinkDestination,
    );

    await expect(
      backupSqliteDatabase({
        sourcePath,
        backupDirectory,
        now: new Date("2030-01-02T03:04:06.000Z"),
      }),
    ).rejects.toThrow("SQLITE_BACKUP_DESTINATION_EXISTS");
    expect(await readFile(targetPath, "utf8")).toBe("untouched");
    expect(
      (await lstat(symlinkDestination)).isSymbolicLink(),
    ).toBe(true);

    const hardLinkTarget = join(directory, "outside-hardlink.sqlite");
    await writeFile(hardLinkTarget, "hard link target");
    const hardLinkDestination = join(
      backupDirectory,
      "jungle-bell-20300102T030407Z.sqlite",
    );
    await link(hardLinkTarget, hardLinkDestination);

    await expect(
      backupSqliteDatabase({
        sourcePath,
        backupDirectory,
        now: new Date("2030-01-02T03:04:07.000Z"),
      }),
    ).rejects.toThrow("SQLITE_BACKUP_DESTINATION_EXISTS");
    expect(await readFile(hardLinkTarget, "utf8")).toBe(
      "hard link target",
    );
    expect(await readFile(hardLinkDestination, "utf8")).toBe(
      "hard link target",
    );
    expect(
      (await lstat(hardLinkDestination)).nlink,
    ).toBe(2);
    expect(
      (await readdir(backupDirectory)).filter((name) =>
        name.startsWith(".jungle-bell-backup-"),
      ),
    ).toEqual([]);
  });

  it("uses a bounded retention setting and fails before creating a backup for invalid values", async () => {
    expect(parseBackupRetentionDays(undefined)).toBe(
      DEFAULT_BACKUP_RETENTION_DAYS,
    );
    expect(parseBackupRetentionDays("1")).toBe(1);
    expect(
      parseBackupRetentionDays(String(MAX_BACKUP_RETENTION_DAYS)),
    ).toBe(MAX_BACKUP_RETENTION_DAYS);
    for (const invalid of [
      "",
      "0",
      "-1",
      "1.5",
      " 30",
      "30 ",
      "days",
      String(MAX_BACKUP_RETENTION_DAYS + 1),
    ]) {
      expect(() => parseBackupRetentionDays(invalid)).toThrow(
        "JB_BACKUP_RETENTION_DAYS_INVALID",
      );
    }

    const directory = await mkdtemp(join(tmpdir(), "jungle-bell-backup-"));
    directories.push(directory);
    const sourcePath = join(directory, "source.sqlite");
    const source = new Database(sourcePath);
    source.exec("CREATE TABLE values_table (value TEXT NOT NULL) STRICT");
    source.close();
    const backupDirectory = join(directory, "backups");

    await expect(
      backupSqliteDatabase({
        sourcePath,
        backupDirectory,
        retentionDays: 0,
      }),
    ).rejects.toThrow("JB_BACKUP_RETENTION_DAYS_INVALID");
    await expect(access(backupDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
