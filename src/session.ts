import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  chromium,
  type BrowserContext,
  type BrowserType,
  type ChromiumBrowser,
  type Page,
} from "playwright";

const LOCK_FILENAME = "profile.lock";
const RECOVERY_FILENAME = "profile.lock.recovery";
const WHATSAPP_URL = "https://web.whatsapp.com/";

interface LockOwner {
  pid: number;
  token: string;
}

export interface ProfileLock {
  release(): Promise<void>;
}

export interface WhatsAppSession {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

interface SessionDependencies {
  acquireLock?: typeof acquireProfileLock;
  launchPersistentContext?: BrowserType<ChromiumBrowser>["launchPersistentContext"];
}

interface LockDependencies {
  beforePublish?: (path: string) => Promise<void>;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function parseOwner(contents: string): LockOwner | undefined {
  try {
    const value = JSON.parse(contents) as Partial<LockOwner>;
    if (
      Number.isSafeInteger(value.pid) &&
      (value.pid ?? 0) > 0 &&
      typeof value.token === "string" &&
      value.token.length > 0
    ) {
      return { pid: value.pid!, token: value.token };
    }
  } catch {
    // Malformed lock files are stale.
  }
  return undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") {
      return false;
    }
    // EPERM is expected for protected Windows processes. Unknown failures are
    // also treated conservatively so a possibly active profile is not stolen.
    return true;
  }
}

async function closeHandle(handle: FileHandle | undefined): Promise<unknown> {
  if (handle === undefined) return undefined;
  try {
    await handle.close();
    return undefined;
  } catch (error) {
    return error;
  }
}

async function bestEffortUnlink(path: string): Promise<unknown> {
  try {
    await unlink(path);
    return undefined;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    return error;
  }
}

function throwWithSecondary(primary: unknown, secondary: unknown[]): never {
  const failures = [primary, ...secondary.filter((error) => error !== undefined)];
  if (failures.length === 1) throw primary;
  const message = primary instanceof Error ? primary.message : "operation failed";
  throw new AggregateError(failures, message);
}

async function createOwnedFile(
  path: string,
  owner: LockOwner,
  dependencies: LockDependencies = {},
): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, "wx");
    await handle.writeFile(JSON.stringify(owner), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await dependencies.beforePublish?.(path);
    await link(temporaryPath, path);
  } catch (error) {
    const closeError = await closeHandle(handle);
    const cleanupError = await bestEffortUnlink(temporaryPath);
    throwWithSecondary(error, [closeError, cleanupError]);
  }
  await bestEffortUnlink(temporaryPath);
}

async function readOwner(path: string): Promise<LockOwner | undefined> {
  try {
    return parseOwner(await readFile(path, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function waitForRecovery(recoveryPath: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let contents: string;
    try {
      contents = await readFile(recoveryPath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    const owner = parseOwner(contents);
    if (owner === undefined) {
      const cleanupError = await bestEffortUnlink(recoveryPath);
      if (cleanupError !== undefined) throw cleanupError;
      continue;
    }
    if (!processIsAlive(owner.pid)) {
      await bestEffortUnlink(recoveryPath);
      continue;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error("profile lock recovery is already in progress");
}

async function reclaimStaleLock(
  lockPath: string,
  recoveryPath: string,
  dependencies: LockDependencies,
): Promise<void> {
  const recoveryOwner = { pid: process.pid, token: randomUUID() };
  try {
    await createOwnedFile(recoveryPath, recoveryOwner, dependencies);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      await waitForRecovery(recoveryPath);
      return;
    }
    throw error;
  }

  let primaryError: unknown;
  try {
    const currentOwner = await readOwner(lockPath);
    if (currentOwner !== undefined && processIsAlive(currentOwner.pid)) {
      throw new Error(`already running as process ${currentOwner.pid}`);
    }
    const cleanupError = await bestEffortUnlink(lockPath);
    if (cleanupError !== undefined) throw cleanupError;
  } catch (error) {
    primaryError = error;
  }

  let recoveryCleanupError: unknown;
  try {
    const owner = await readOwner(recoveryPath);
    if (owner?.token === recoveryOwner.token) {
      recoveryCleanupError = await bestEffortUnlink(recoveryPath);
    }
  } catch (error) {
    recoveryCleanupError = error;
  }

  if (primaryError !== undefined) {
    throwWithSecondary(primaryError, [recoveryCleanupError]);
  }
  if (recoveryCleanupError !== undefined) throw recoveryCleanupError;
}

export async function acquireProfileLock(runtimeDir: string): Promise<ProfileLock> {
  return __acquireProfileLock(runtimeDir);
}

export async function __acquireProfileLock(
  runtimeDir: string,
  dependencies: LockDependencies = {},
): Promise<ProfileLock> {
  const resolvedRuntimeDir = resolve(runtimeDir);
  const lockPath = join(resolvedRuntimeDir, LOCK_FILENAME);
  const recoveryPath = join(resolvedRuntimeDir, RECOVERY_FILENAME);
  const owner = { pid: process.pid, token: randomUUID() };

  await mkdir(resolvedRuntimeDir, { recursive: true });

  for (;;) {
    await waitForRecovery(recoveryPath);
    try {
      await createOwnedFile(lockPath, owner, dependencies);
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }

    const currentOwner = await readOwner(lockPath);
    if (currentOwner !== undefined && processIsAlive(currentOwner.pid)) {
      throw new Error(`already running as process ${currentOwner.pid}`);
    }
    await reclaimStaleLock(lockPath, recoveryPath, dependencies);
  }

  let releasePromise: Promise<void> | undefined;
  return {
    release(): Promise<void> {
      releasePromise ??= (async () => {
        const currentOwner = await readOwner(lockPath);
        if (currentOwner?.token === owner.token) {
          const cleanupError = await bestEffortUnlink(lockPath);
          if (cleanupError !== undefined) throw cleanupError;
        }
      })();
      return releasePromise;
    },
  };
}

export async function __openWhatsAppSession(
  options: { profileDir?: string; runtimeDir?: string; headed?: boolean } = {},
  dependencies: SessionDependencies = {},
): Promise<WhatsAppSession> {
  const profileDir = resolve(options.profileDir ?? ".whatsapp-profile");
  const runtimeDir = resolve(options.runtimeDir ?? ".runtime");
  const acquireLock = dependencies.acquireLock ?? acquireProfileLock;
  const launchPersistentContext =
    dependencies.launchPersistentContext ?? chromium.launchPersistentContext.bind(chromium);
  const lock = await acquireLock(runtimeDir);
  let context: BrowserContext | undefined;

  try {
    context = await launchPersistentContext(profileDir, {
      headless: options.headed === false,
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: false,
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(WHATSAPP_URL, { waitUntil: "domcontentloaded" });

    let closePromise: Promise<void> | undefined;
    return {
      context,
      page,
      close(): Promise<void> {
        closePromise ??= (async () => {
          let contextError: unknown;
          try {
            await context!.close();
          } catch (error) {
            contextError = error;
          }

          try {
            await lock.release();
          } catch (releaseError) {
            if (contextError !== undefined) {
              throwWithSecondary(contextError, [releaseError]);
            }
            throw releaseError;
          }
          if (contextError !== undefined) throw contextError;
        })();
        return closePromise;
      },
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (context !== undefined) {
      try {
        await context.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await lock.release();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    throwWithSecondary(error, cleanupErrors);
  }
}

export function openWhatsAppSession(
  options?: { profileDir?: string; runtimeDir?: string; headed?: boolean },
): Promise<WhatsAppSession> {
  return __openWhatsAppSession(options);
}
