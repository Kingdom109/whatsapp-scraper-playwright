import { spawn, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink as removeFile,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __acquireProfileLock,
  __openWhatsAppSession,
  acquireProfileLock,
  openWhatsAppSession,
} from "../src/session.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "whatsapp-session-test-"));
  temporaryRoots.push(root);
  return root;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function visibleContents(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("acquireProfileLock", () => {
  it("reclaims an alive PID whose lease remains stale after the grace recheck", async () => {
    const runtimeDir = await temporaryRoot();
    const lockPath = join(runtimeDir, "profile.lock");
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, token: "reused-pid" }),
      "utf8",
    );
    await utimes(lockPath, new Date(1_000), new Date(1_000));

    const lock = await __acquireProfileLock(runtimeDir, {
      now: () => 10_000,
      leaseTimeoutMs: 1_000,
      sleep: vi.fn().mockResolvedValue(undefined),
      processIsAlive: () => true,
    });

    await lock.release();
  });

  it("keeps an EPERM owner with a fresh lease active", async () => {
    const runtimeDir = await temporaryRoot();
    const lockPath = join(runtimeDir, "profile.lock");
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 987_654_321, token: "protected" }),
      "utf8",
    );
    const modified = (await stat(lockPath)).mtimeMs;

    await expect(
      __acquireProfileLock(runtimeDir, {
        now: () => modified,
        leaseTimeoutMs: 1_000,
        processIsAlive: () => true,
      }),
    ).rejects.toThrow("already running as process 987654321");
  });

  it("renews the lease through an inode-bound heartbeat", async () => {
    const runtimeDir = await temporaryRoot();
    let now = Date.now();
    let heartbeat: (() => Promise<void>) | undefined;
    const lock = await __acquireProfileLock(runtimeDir, {
      now: () => now,
      scheduleHeartbeat: (callback) => {
        heartbeat = callback;
        return () => undefined;
      },
    });
    const before = (await stat(join(runtimeDir, "profile.lock"))).mtimeMs;

    now += 5_000;
    await heartbeat!();
    const after = (await stat(join(runtimeDir, "profile.lock"))).mtimeMs;

    expect(after).toBeGreaterThan(before);
    await lock.release();
  });

  it.each([1, 2, 3, 4])(
    "never exposes an incomplete profile lock during publication run %s",
    async () => {
      const runtimeDir = await temporaryRoot();
      const entered = deferred();
      const release = deferred();
      let paused = false;
      const first = __acquireProfileLock(runtimeDir, {
        beforePublish: async (path) => {
          if (!paused && path.endsWith("profile.lock")) {
            paused = true;
            entered.resolve();
            await release.promise;
          }
        },
      });

      await entered.promise;
      const observed = await visibleContents(join(runtimeDir, "profile.lock"));
      const second = acquireProfileLock(runtimeDir);
      release.resolve();
      const results = await Promise.allSettled([first, second]);
      const owners = results.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireProfileLock>>> =>
          result.status === "fulfilled",
      );
      const finalContents = await readFile(join(runtimeDir, "profile.lock"), "utf8");

      expect(observed).toBeUndefined();
      expect(owners).toHaveLength(1);
      expect(() => JSON.parse(finalContents)).not.toThrow();
      await owners[0]!.value.release();
    },
  );

  it.each([1, 2, 3, 4])(
    "never exposes an incomplete recovery lock during publication run %s",
    async () => {
      const runtimeDir = await temporaryRoot();
      await writeFile(
        join(runtimeDir, "profile.lock"),
        JSON.stringify({ pid: 2_147_483_647, token: "stale" }),
        "utf8",
      );
      const entered = deferred();
      const release = deferred();
      let paused = false;
      const first = __acquireProfileLock(runtimeDir, {
        beforePublish: async (path) => {
          if (!paused && path.endsWith("profile.lock.recovery")) {
            paused = true;
            entered.resolve();
            await release.promise;
          }
        },
      });

      await entered.promise;
      const observed = await visibleContents(
        join(runtimeDir, "profile.lock.recovery"),
      );
      const second = acquireProfileLock(runtimeDir);
      release.resolve();
      const results = await Promise.allSettled([first, second]);
      const owners = results.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireProfileLock>>> =>
          result.status === "fulfilled",
      );
      const finalContents = await readFile(join(runtimeDir, "profile.lock"), "utf8");

      expect(observed).toBeUndefined();
      expect(owners.length).toBeLessThanOrEqual(1);
      expect(() => JSON.parse(finalContents)).not.toThrow();
      await Promise.all(owners.map(({ value }) => value.release()));
    },
  );

  it("rejects a second active owner and permits reacquisition after release", async () => {
    const runtimeDir = await temporaryRoot();
    const first = await acquireProfileLock(runtimeDir);

    await expect(acquireProfileLock(runtimeDir)).rejects.toThrow(
      `already running as process ${process.pid}`,
    );
    expect(await readdir(runtimeDir)).toEqual(["profile.lock"]);

    await first.release();
    const second = await acquireProfileLock(runtimeDir);
    await second.release();
  });

  it("allows release to be called twice", async () => {
    const runtimeDir = await temporaryRoot();
    const lock = await acquireProfileLock(runtimeDir);

    await lock.release();
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("surfaces failure to unlink a dead recovery lock", async () => {
    const runtimeDir = await temporaryRoot();
    const recoveryPath = join(runtimeDir, "profile.lock.recovery");
    await writeFile(recoveryPath, "malformed", "utf8");
    const unlinkFailure = Object.assign(new Error("recovery unlink failed"), {
      code: "EACCES",
    });

    await expect(
      __acquireProfileLock(runtimeDir, {
        unlink: async (path) => {
          if (path === recoveryPath) throw unlinkFailure;
          await removeFile(path);
        },
      }),
    ).rejects.toThrow("recovery unlink failed");
  });

  it("retries cleanup of its exact publication temp path on release", async () => {
    const runtimeDir = await temporaryRoot();
    let failedTemporaryPath: string | undefined;
    const lock = await __acquireProfileLock(runtimeDir, {
      unlink: async (path) => {
        if (path.endsWith(".tmp") && failedTemporaryPath === undefined) {
          failedTemporaryPath = path;
          throw Object.assign(new Error("temporary unlink failed"), { code: "EBUSY" });
        }
        await removeFile(path);
      },
    });

    expect(failedTemporaryPath).toBeDefined();
    expect(await readdir(runtimeDir)).toContain(
      failedTemporaryPath!.slice(runtimeDir.length + 1),
    );
    await lock.release();
    expect(await readdir(runtimeDir)).toEqual([]);
  });

  it.each([
    ["stale", JSON.stringify({ pid: 2_147_483_647, token: "old" })],
    ["malformed", "not json"],
  ])("recovers a %s lock", async (_kind, contents) => {
    const runtimeDir = await temporaryRoot();
    await writeFile(join(runtimeDir, "profile.lock"), contents, "utf8");

    const lock = await acquireProfileLock(runtimeDir);
    const owner = JSON.parse(
      await readFile(join(runtimeDir, "profile.lock"), "utf8"),
    ) as { pid: number; token: string };

    expect(owner.pid).toBe(process.pid);
    expect(owner.token).not.toBe("old");
    await lock.release();
  });

  it("does not let an old owner release a replacement lock", async () => {
    const runtimeDir = await temporaryRoot();
    const oldOwner = await acquireProfileLock(runtimeDir);
    const replacement = JSON.stringify({ pid: process.pid, token: "replacement" });
    await writeFile(join(runtimeDir, "profile.lock"), replacement, "utf8");

    await oldOwner.release();

    expect(await readFile(join(runtimeDir, "profile.lock"), "utf8")).toBe(
      replacement,
    );
  });

  it("grants ownership to only one concurrent contender", async () => {
    const runtimeDir = await temporaryRoot();
    await writeFile(
      join(runtimeDir, "profile.lock"),
      JSON.stringify({ pid: 2_147_483_647, token: "stale" }),
      "utf8",
    );

    const results = await Promise.allSettled([
      acquireProfileLock(runtimeDir),
      acquireProfileLock(runtimeDir),
    ]);
    const owners = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireProfileLock>>> =>
        result.status === "fulfilled",
    );

    expect(owners).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await owners[0]!.value.release();
  });

  it("enforces ownership across spawned Windows processes", async () => {
    const runtimeDir = await temporaryRoot();
    const sessionUrl = new URL("../src/session.ts", import.meta.url).href;
    const holderCode = `
      import { acquireProfileLock } from ${JSON.stringify(sessionUrl)};
      const lock = await acquireProfileLock(process.argv[1]);
      process.stdout.write("acquired\\n");
      process.stdin.once("data", async () => {
        await lock.release();
        process.exit(0);
      });
    `;
    const holder = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", holderCode, runtimeDir],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    await new Promise<void>((resolveReady, rejectReady) => {
      holder.stdout.once("data", (chunk) => {
        if (String(chunk).includes("acquired")) resolveReady();
        else rejectReady(new Error(`unexpected child output: ${String(chunk)}`));
      });
      holder.once("error", rejectReady);
    });

    const contenderCode = `
      import { acquireProfileLock } from ${JSON.stringify(sessionUrl)};
      try {
        const lock = await acquireProfileLock(process.argv[1]);
        await lock.release();
        process.exit(0);
      } catch (error) {
        process.stderr.write(String(error.message));
        process.exit(2);
      }
    `;
    const contender = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", contenderCode, runtimeDir],
      { encoding: "utf8", timeout: 10_000 },
    );

    expect(contender.status).toBe(2);
    expect(contender.stderr).toMatch(/already running as process/);
    holder.stdin.write("release\n");
    await new Promise<void>((resolveExit, rejectExit) => {
      holder.once("exit", (code) => code === 0
        ? resolveExit()
        : rejectExit(new Error(`holder exited ${code}`)));
    });
    const lock = await acquireProfileLock(runtimeDir);
    await lock.release();
  }, 20_000);
});

type FakePage = {
  goto: ReturnType<typeof vi.fn>;
};

function fakeBrowser(existingPages: FakePage[] = []) {
  const createdPage: FakePage = { goto: vi.fn().mockResolvedValue(undefined) };
  const context = {
    pages: vi.fn(() => existingPages),
    newPage: vi.fn().mockResolvedValue(createdPage),
    close: vi.fn().mockResolvedValue(undefined),
    browser: vi.fn(),
  };
  let connected = true;
  const browser = {
    isConnected: vi.fn(() => connected),
    close: vi.fn(async () => {
      connected = false;
    }),
  };
  context.browser.mockReturnValue(browser);
  const launchPersistentContext = vi.fn().mockResolvedValue(context);

  return { browser, context, createdPage, launchPersistentContext };
}

describe("openWhatsAppSession", () => {
  it("uses one canonical lock for the same profile despite different runtime dirs", async () => {
    const root = await temporaryRoot();
    const profileDir = join(root, "profile", "..");
    const firstFake = fakeBrowser();
    const first = await __openWhatsAppSession(
      { profileDir, runtimeDir: join(root, "runtime-a") },
      { launchPersistentContext: firstFake.launchPersistentContext },
    );

    await expect(
      __openWhatsAppSession(
        { profileDir: resolve(profileDir), runtimeDir: join(root, "runtime-b") },
        { launchPersistentContext: fakeBrowser().launchPersistentContext },
      ),
    ).rejects.toThrow(/already running as process/);
    await first.close();
  });

  it("allows different canonical profiles to run concurrently", async () => {
    const root = await temporaryRoot();
    const first = await __openWhatsAppSession(
      { profileDir: join(root, "profile-a"), runtimeDir: join(root, "runtime") },
      { launchPersistentContext: fakeBrowser().launchPersistentContext },
    );
    const second = await __openWhatsAppSession(
      { profileDir: join(root, "profile-b"), runtimeDir: join(root, "runtime") },
      { launchPersistentContext: fakeBrowser().launchPersistentContext },
    );

    await first.close();
    await second.close();
  });

  it("treats a Windows junction alias as the same canonical profile", async () => {
    const root = await temporaryRoot();
    const profileDir = join(root, "profile");
    const aliasDir = join(root, "profile-alias");
    await mkdir(profileDir, { recursive: true });
    await symlink(profileDir, aliasDir, "junction");
    const first = await __openWhatsAppSession(
      { profileDir, runtimeDir: join(root, "runtime-a") },
      { launchPersistentContext: fakeBrowser().launchPersistentContext },
    );

    await expect(
      __openWhatsAppSession(
        { profileDir: aliasDir, runtimeDir: join(root, "runtime-b") },
        { launchPersistentContext: fakeBrowser().launchPersistentContext },
      ),
    ).rejects.toThrow(/already running as process/);
    await first.close();
  });

  it("launches the dedicated persistent profile visibly and reuses an existing page", async () => {
    const root = await temporaryRoot();
    const profileDir = join(root, "profile");
    const runtimeDir = join(root, "runtime");
    const existingPage: FakePage = { goto: vi.fn().mockResolvedValue(undefined) };
    const fake = fakeBrowser([existingPage]);

    const session = await __openWhatsAppSession(
      { profileDir, runtimeDir },
      { launchPersistentContext: fake.launchPersistentContext },
    );

    expect(fake.launchPersistentContext).toHaveBeenCalledWith(resolve(profileDir), {
      headless: false,
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: false,
    });
    expect(fake.context.newPage).not.toHaveBeenCalled();
    expect(existingPage.goto).toHaveBeenCalledWith("https://web.whatsapp.com/", {
      waitUntil: "domcontentloaded",
    });
    expect(session.page).toBe(existingPage);
    await session.close();
  });

  it("creates a page when the persistent context has none", async () => {
    const root = await temporaryRoot();
    const fake = fakeBrowser();

    const session = await __openWhatsAppSession(
      { profileDir: join(root, "profile"), runtimeDir: join(root, "runtime") },
      { launchPersistentContext: fake.launchPersistentContext },
    );

    expect(fake.context.newPage).toHaveBeenCalledOnce();
    expect(fake.createdPage.goto).toHaveBeenCalledOnce();
    await session.close();
  });

  it.each([
    [undefined, false],
    [true, false],
    [false, true],
  ])("maps headed %s to headless %s", async (headed, expectedHeadless) => {
    const root = await temporaryRoot();
    const fake = fakeBrowser();
    const options = {
      profileDir: join(root, "profile"),
      runtimeDir: join(root, "runtime"),
      ...(headed === undefined ? {} : { headed }),
    };

    const session = await __openWhatsAppSession(options, {
      launchPersistentContext: fake.launchPersistentContext,
    });

    expect(fake.launchPersistentContext.mock.calls[0]?.[1]).toMatchObject({
      headless: expectedHeadless,
    });
    await session.close();
  });

  it("uses project-local profile and runtime defaults", async () => {
    const fake = fakeBrowser();
    const lock = { release: vi.fn().mockResolvedValue(undefined) };
    const acquireLock = vi.fn().mockResolvedValue(lock);

    const session = await __openWhatsAppSession(
      {},
      {
        launchPersistentContext: fake.launchPersistentContext,
        acquireLock,
      },
    );

    expect(acquireLock).toHaveBeenCalledWith(
      join(resolve(".whatsapp-profile"), ".runtime"),
    );
    expect(fake.launchPersistentContext.mock.calls[0]?.[0]).toBe(
      resolve(".whatsapp-profile"),
    );
    expect(lock.release).not.toHaveBeenCalled();
    await session.close();
    expect(lock.release).toHaveBeenCalledOnce();
  });

  it("releases the lock when browser launch fails", async () => {
    const lock = { release: vi.fn().mockResolvedValue(undefined) };

    await expect(
      __openWhatsAppSession(
        {},
        {
          acquireLock: vi.fn().mockResolvedValue(lock),
          launchPersistentContext: vi.fn().mockRejectedValue(new Error("launch failed")),
        },
      ),
    ).rejects.toThrow("launch failed");
    expect(lock.release).toHaveBeenCalledOnce();
  });

  it("closes the context and releases the lock when navigation fails", async () => {
    const lock = { release: vi.fn().mockResolvedValue(undefined) };
    const page: FakePage = { goto: vi.fn().mockRejectedValue(new Error("goto failed")) };
    const fake = fakeBrowser([page]);

    await expect(
      __openWhatsAppSession(
        {},
        {
          acquireLock: vi.fn().mockResolvedValue(lock),
          launchPersistentContext: fake.launchPersistentContext,
        },
      ),
    ).rejects.toThrow("goto failed");
    expect(fake.context.close).toHaveBeenCalledOnce();
    expect(lock.release).toHaveBeenCalledOnce();
  });

  it("closes the context and releases the lock when creating a page fails", async () => {
    const lock = { release: vi.fn().mockResolvedValue(undefined) };
    const fake = fakeBrowser();
    fake.context.newPage.mockRejectedValue(new Error("page failed"));

    await expect(
      __openWhatsAppSession(
        {},
        {
          acquireLock: vi.fn().mockResolvedValue(lock),
          launchPersistentContext: fake.launchPersistentContext,
        },
      ),
    ).rejects.toThrow("page failed");
    expect(fake.context.close).toHaveBeenCalledOnce();
    expect(lock.release).toHaveBeenCalledOnce();
  });

  it("releases the lock even when cleanup context close fails", async () => {
    const lock = { release: vi.fn().mockResolvedValue(undefined) };
    const page: FakePage = { goto: vi.fn().mockRejectedValue(new Error("goto failed")) };
    const fake = fakeBrowser([page]);
    fake.context.close.mockRejectedValue(new Error("close failed"));

    await expect(
      __openWhatsAppSession(
        {},
        {
          acquireLock: vi.fn().mockResolvedValue(lock),
          launchPersistentContext: fake.launchPersistentContext,
        },
      ),
    ).rejects.toThrow("goto failed");
    expect(lock.release).toHaveBeenCalledOnce();
  });

  it("retains the startup lock while a failed cleanup leaves the browser connected", async () => {
    const lock = { release: vi.fn().mockResolvedValue(undefined) };
    const page: FakePage = { goto: vi.fn().mockRejectedValue(new Error("goto failed")) };
    const fake = fakeBrowser([page]);
    fake.context.close.mockRejectedValue(new Error("context close failed"));
    fake.browser.close.mockRejectedValue(new Error("browser close failed"));

    await expect(
      __openWhatsAppSession(
        {},
        {
          acquireLock: vi.fn().mockResolvedValue(lock),
          launchPersistentContext: fake.launchPersistentContext,
        },
      ),
    ).rejects.toThrow("goto failed");
    expect(fake.browser.isConnected()).toBe(true);
    expect(lock.release).not.toHaveBeenCalled();
  });

  it("closes once and releases the lock when session close is repeated", async () => {
    const lock = { release: vi.fn().mockResolvedValue(undefined) };
    const fake = fakeBrowser();
    const session = await __openWhatsAppSession(
      {},
      {
        acquireLock: vi.fn().mockResolvedValue(lock),
        launchPersistentContext: fake.launchPersistentContext,
      },
    );

    await session.close();
    await session.close();

    expect(fake.context.close).toHaveBeenCalledOnce();
    expect(lock.release).toHaveBeenCalledOnce();
  });

  it("releases the lock when session context close fails", async () => {
    const lock = { release: vi.fn().mockResolvedValue(undefined) };
    const fake = fakeBrowser();
    fake.context.close.mockRejectedValue(new Error("close failed"));
    const session = await __openWhatsAppSession(
      {},
      {
        acquireLock: vi.fn().mockResolvedValue(lock),
        launchPersistentContext: fake.launchPersistentContext,
      },
    );

    await expect(session.close()).rejects.toThrow("close failed");
    expect(lock.release).toHaveBeenCalledOnce();
    await expect(session.close()).rejects.toThrow("close failed");
    expect(fake.context.close).toHaveBeenCalledTimes(2);
    expect(lock.release).toHaveBeenCalledOnce();
  });

  it("retains the lock and permits close retry while the browser remains connected", async () => {
    const root = await temporaryRoot();
    const profileDir = join(root, "profile");
    const fake = fakeBrowser();
    fake.context.close
      .mockRejectedValueOnce(new Error("close failed"))
      .mockResolvedValueOnce(undefined);
    fake.browser.close.mockRejectedValue(new Error("browser close failed"));
    const session = await __openWhatsAppSession(
      { profileDir, runtimeDir: join(root, "runtime-a") },
      { launchPersistentContext: fake.launchPersistentContext },
    );

    await expect(session.close()).rejects.toThrow("close failed");
    await expect(
      __openWhatsAppSession(
        { profileDir, runtimeDir: join(root, "runtime-b") },
        { launchPersistentContext: fakeBrowser().launchPersistentContext },
      ),
    ).rejects.toThrow(/already running as process/);

    await expect(session.close()).resolves.toBeUndefined();
    const replacement = await __openWhatsAppSession(
      { profileDir, runtimeDir: join(root, "runtime-c") },
      { launchPersistentContext: fakeBrowser().launchPersistentContext },
    );
    await replacement.close();
  });

  it("releases the lock after close fails when the browser is disconnected", async () => {
    const root = await temporaryRoot();
    const profileDir = join(root, "profile");
    const fake = fakeBrowser();
    fake.context.close.mockRejectedValue(new Error("close failed"));
    fake.browser.isConnected.mockReturnValue(false);
    const session = await __openWhatsAppSession(
      { profileDir, runtimeDir: join(root, "runtime-a") },
      { launchPersistentContext: fake.launchPersistentContext },
    );

    await expect(session.close()).rejects.toThrow("close failed");
    const replacement = await __openWhatsAppSession(
      { profileDir, runtimeDir: join(root, "runtime-b") },
      { launchPersistentContext: fakeBrowser().launchPersistentContext },
    );
    await replacement.close();
  });

  it("retains the documented normal API", () => {
    expect(openWhatsAppSession).toBeTypeOf("function");
  });
});
