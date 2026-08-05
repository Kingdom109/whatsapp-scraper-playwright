import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  stat,
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
const DEFAULT_LEASE_TIMEOUT_MS = 2_000;
const DEFAULT_LEASE_GRACE_MS = 50;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 500;

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
  now?: () => number;
  leaseTimeoutMs?: number;
  leaseGraceMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  processIsAlive?: (pid: number) => boolean;
  scheduleHeartbeat?: (
    callback: () => Promise<void>,
    intervalMs: number,
  ) => () => void;
  unlink?: (path: string) => Promise<void>;
}

interface LockSnapshot {
  owner: LockOwner | undefined;
  modifiedAt: number;
}

interface Publication {
  leftoverTemporaryPath?: string;
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

async function bestEffortUnlink(
  path: string,
  dependencies: LockDependencies = {},
): Promise<unknown> {
  try {
    await (dependencies.unlink ?? unlink)(path);
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
): Promise<Publication> {
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
    const cleanupError = await bestEffortUnlink(temporaryPath, dependencies);
    throwWithSecondary(error, [closeError, cleanupError]);
  }
  const cleanupError = await bestEffortUnlink(temporaryPath, dependencies);
  return cleanupError === undefined
    ? {}
    : { leftoverTemporaryPath: temporaryPath };
}

async function readOwner(path: string): Promise<LockOwner | undefined> {
  try {
    return parseOwner(await readFile(path, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function readLockSnapshot(path: string): Promise<LockSnapshot | undefined> {
  try {
    const [contents, details] = await Promise.all([
      readFile(path, "utf8"),
      stat(path),
    ]);
    return { owner: parseOwner(contents), modifiedAt: details.mtimeMs };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function scheduleHeartbeat(
  callback: () => Promise<void>,
  intervalMs: number,
): () => void {
  const timer = setInterval(() => void callback(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

async function ownerIsActive(
  path: string,
  snapshot: LockSnapshot,
  dependencies: LockDependencies,
): Promise<boolean> {
  const owner = snapshot.owner;
  if (owner === undefined) return false;
  const now = dependencies.now ?? Date.now;
  const leaseTimeoutMs = dependencies.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS;
  const isAlive = dependencies.processIsAlive ?? processIsAlive;
  if (!isAlive(owner.pid)) return false;
  if (now() - snapshot.modifiedAt <= leaseTimeoutMs) return true;

  await (dependencies.sleep ?? sleep)(
    dependencies.leaseGraceMs ?? DEFAULT_LEASE_GRACE_MS,
  );
  const refreshed = await readLockSnapshot(path);
  return refreshed?.owner?.token === owner.token &&
    now() - refreshed.modifiedAt <= leaseTimeoutMs;
}

async function waitForRecovery(
  recoveryPath: string,
  dependencies: LockDependencies,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await readLockSnapshot(recoveryPath);
    if (snapshot === undefined) return;
    if (snapshot.owner === undefined) {
      const cleanupError = await bestEffortUnlink(recoveryPath, dependencies);
      if (cleanupError !== undefined) throw cleanupError;
      continue;
    }
    if (!(await ownerIsActive(recoveryPath, snapshot, dependencies))) {
      const cleanupError = await bestEffortUnlink(recoveryPath, dependencies);
      if (cleanupError !== undefined) throw cleanupError;
      continue;
    }
    await (dependencies.sleep ?? sleep)(5);
  }
  throw new Error("profile lock recovery is already in progress");
}

async function reclaimStaleLock(
  lockPath: string,
  recoveryPath: string,
  dependencies: LockDependencies,
): Promise<void> {
  const recoveryOwner = { pid: process.pid, token: randomUUID() };
  let publication: Publication;
  try {
    publication = await createOwnedFile(recoveryPath, recoveryOwner, dependencies);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      await waitForRecovery(recoveryPath, dependencies);
      return;
    }
    throw error;
  }

  let primaryError: unknown;
  try {
    const current = await readLockSnapshot(lockPath);
    if (current !== undefined && await ownerIsActive(lockPath, current, dependencies)) {
      throw new Error(`already running as process ${current.owner!.pid}`);
    }
    const cleanupError = await bestEffortUnlink(lockPath, dependencies);
    if (cleanupError !== undefined) throw cleanupError;
  } catch (error) {
    primaryError = error;
  }

  let recoveryCleanupError: unknown;
  try {
    const owner = await readOwner(recoveryPath);
    if (owner?.token === recoveryOwner.token) {
      recoveryCleanupError = await bestEffortUnlink(recoveryPath, dependencies);
    }
  } catch (error) {
    recoveryCleanupError = error;
  }
  if (publication.leftoverTemporaryPath !== undefined) {
    const temporaryCleanupError = await bestEffortUnlink(
      publication.leftoverTemporaryPath,
      dependencies,
    );
    recoveryCleanupError ??= temporaryCleanupError;
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

  let publication: Publication;
  for (;;) {
    await waitForRecovery(recoveryPath, dependencies);
    try {
      publication = await createOwnedFile(lockPath, owner, dependencies);
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }

    const current = await readLockSnapshot(lockPath);
    if (current !== undefined && await ownerIsActive(lockPath, current, dependencies)) {
      throw new Error(`already running as process ${current.owner!.pid}`);
    }
    await reclaimStaleLock(lockPath, recoveryPath, dependencies);
  }

  let leaseHandle: FileHandle;
  try {
    leaseHandle = await open(lockPath, "r+");
    if ((await readOwner(lockPath))?.token !== owner.token) {
      await leaseHandle.close();
      throw new Error("profile lock ownership changed during acquisition");
    }
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if ((await readOwner(lockPath))?.token === owner.token) {
      cleanupErrors.push(await bestEffortUnlink(lockPath, dependencies));
    }
    if (publication.leftoverTemporaryPath !== undefined) {
      cleanupErrors.push(
        await bestEffortUnlink(publication.leftoverTemporaryPath, dependencies),
      );
    }
    throwWithSecondary(error, cleanupErrors);
  }

  let stopped = false;
  const heartbeat = async (): Promise<void> => {
    if (stopped) return;
    try {
      const [current, held, visible] = await Promise.all([
        readOwner(lockPath),
        leaseHandle.stat(),
        stat(lockPath),
      ]);
      if (
        current?.token !== owner.token ||
        held.dev !== visible.dev ||
        held.ino !== visible.ino
      ) {
        stopped = true;
        return;
      }
      const heartbeatTime = new Date((dependencies.now ?? Date.now)());
      await leaseHandle.utimes(heartbeatTime, heartbeatTime);
    } catch {
      stopped = true;
    }
  };
  const stopHeartbeat = (dependencies.scheduleHeartbeat ?? scheduleHeartbeat)(
    heartbeat,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
  );

  let releasePromise: Promise<void> | undefined;
  return {
    release(): Promise<void> {
      releasePromise ??= (async () => {
        stopped = true;
        stopHeartbeat();
        let closeError: unknown;
        try {
          await leaseHandle.close();
        } catch (error) {
          closeError = error;
        }
        const currentOwner = await readOwner(lockPath);
        const cleanupErrors: unknown[] = [];
        if (currentOwner?.token === owner.token) {
          cleanupErrors.push(await bestEffortUnlink(lockPath, dependencies));
        }
        if (publication.leftoverTemporaryPath !== undefined) {
          cleanupErrors.push(
            await bestEffortUnlink(publication.leftoverTemporaryPath, dependencies),
          );
        }
        const failures = [closeError, ...cleanupErrors].filter(
          (error) => error !== undefined,
        );
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "lock release failed");
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
  // Profile exclusion is deliberately keyed only by the canonical profile
  // location. runtimeDir remains a non-authoritative compatibility option.
  void options.runtimeDir;
  const lockRuntimeDir = join(profileDir, ".runtime");
  const acquireLock = dependencies.acquireLock ?? acquireProfileLock;
  const launchPersistentContext =
    dependencies.launchPersistentContext ?? chromium.launchPersistentContext.bind(chromium);
  const lock = await acquireLock(lockRuntimeDir);
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
    let closed = false;
    let lockReleased = false;
    return {
      context,
      page,
      close(): Promise<void> {
        if (closed) return Promise.resolve();
        closePromise ??= (async () => {
          const outcome = await closeContextSafely(context!);
          if (outcome.closed && !lockReleased) {
            try {
              await lock.release();
              lockReleased = true;
            } catch (releaseError) {
              if (outcome.errors.length > 0) {
                throwWithSecondary(outcome.errors[0], [
                  ...outcome.errors.slice(1),
                  releaseError,
                ]);
              }
              throw releaseError;
            }
          }
          if (outcome.errors.length > 0) {
            throwWithSecondary(outcome.errors[0], outcome.errors.slice(1));
          }
          closed = true;
        })().catch((error) => {
          closePromise = undefined;
          throw error;
        });
        return closePromise;
      },
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    let safeToUnlock = context === undefined;
    if (context !== undefined) {
      const outcome = await closeContextSafely(context);
      safeToUnlock = outcome.closed;
      cleanupErrors.push(...outcome.errors);
    }
    if (safeToUnlock) {
      try {
        await lock.release();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    throwWithSecondary(error, cleanupErrors);
  }
}

async function closeContextSafely(
  context: BrowserContext,
): Promise<{ closed: boolean; errors: unknown[] }> {
  try {
    await context.close();
    return { closed: true, errors: [] };
  } catch (contextError) {
    const errors: unknown[] = [contextError];
    let browser;
    try {
      browser = context.browser();
    } catch (browserLookupError) {
      errors.push(browserLookupError);
      return { closed: false, errors };
    }

    if (browser?.isConnected()) {
      try {
        await browser.close();
      } catch (browserCloseError) {
        errors.push(browserCloseError);
      }
    }
    return { closed: browser !== null && !browser.isConnected(), errors };
  }
}

export function openWhatsAppSession(
  options?: { profileDir?: string; runtimeDir?: string; headed?: boolean },
): Promise<WhatsAppSession> {
  return __openWhatsAppSession(options);
}
