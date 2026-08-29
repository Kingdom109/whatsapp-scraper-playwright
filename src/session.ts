import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
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
import { promisify } from "node:util";
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
const DEFAULT_HEARTBEAT_INTERVAL_MS = 500;
const execFileAsync = promisify(execFile);

interface LockOwner {
  pid: number;
  token: string;
  incarnation?: string;
}

type ProcessIdentity =
  | { status: "found"; identity: string }
  | { status: "missing" }
  | { status: "unavailable" };

export interface ProfileLock {
  release(): Promise<void>;
}

export interface WhatsAppSession {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

export class ProfileInUseError extends Error {
  constructor(pid?: number) {
    super(pid === undefined ? "WhatsApp browser profile is already in use" : `already running as process ${pid}`);
    this.name = "ProfileInUseError";
  }
}

interface SessionDependencies {
  acquireLock?: typeof acquireProfileLock;
  launchPersistentContext?: BrowserType<ChromiumBrowser>["launchPersistentContext"];
}

interface LockDependencies {
  beforePublish?: (path: string) => Promise<void>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  processIsAlive?: (pid: number) => boolean;
  processIdentity?: (pid: number) => Promise<ProcessIdentity>;
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
      return typeof value.incarnation === "string" && value.incarnation.length > 0
        ? { pid: value.pid!, token: value.token, incarnation: value.incarnation }
        : { pid: value.pid!, token: value.token };
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

let currentProcessIdentity: Promise<ProcessIdentity> | undefined;

async function lookupProcessIdentity(pid: number): Promise<ProcessIdentity> {
  if (process.platform === "win32") {
    try {
      const command = `$p = Get-Process -Id ${pid} -ErrorAction Stop; ` +
        "[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)";
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { encoding: "utf8", windowsHide: true },
      );
      const identity = stdout.trim();
      return identity === ""
        ? { status: "unavailable" }
        : { status: "found", identity: `windows:${identity}` };
    } catch {
      return processIsAlive(pid)
        ? { status: "unavailable" }
        : { status: "missing" };
    }
  }

  if (process.platform === "linux") {
    try {
      const contents = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = contents.slice(contents.lastIndexOf(")") + 2).split(" ");
      const startTime = fields[19];
      return startTime === undefined
        ? { status: "unavailable" }
        : { status: "found", identity: `linux:${startTime}` };
    } catch (error) {
      return errorCode(error) === "ENOENT"
        ? { status: "missing" }
        : { status: "unavailable" };
    }
  }

  return processIsAlive(pid)
    ? { status: "unavailable" }
    : { status: "missing" };
}

function processIdentity(pid: number): Promise<ProcessIdentity> {
  if (pid !== process.pid) return lookupProcessIdentity(pid);
  currentProcessIdentity ??= lookupProcessIdentity(pid);
  return currentProcessIdentity;
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
  snapshot: LockSnapshot,
  dependencies: LockDependencies,
): Promise<boolean> {
  const owner = snapshot.owner;
  if (owner === undefined) return false;
  const identity = await (dependencies.processIdentity ?? processIdentity)(owner.pid);
  if (identity.status === "missing") return false;
  if (identity.status === "found" && owner.incarnation !== undefined) {
    return identity.identity === owner.incarnation;
  }

  // Legacy locks lack an incarnation. If their PID is still present, or an
  // identity lookup is denied, retain ownership conservatively.
  const isAlive = dependencies.processIsAlive ?? processIsAlive;
  return isAlive(owner.pid);
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
    if (!(await ownerIsActive(snapshot, dependencies))) {
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
  incarnation: string,
): Promise<void> {
  const recoveryOwner = { pid: process.pid, token: randomUUID(), incarnation };
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
    if (current !== undefined && await ownerIsActive(current, dependencies)) {
      throw new ProfileInUseError(current.owner!.pid);
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
  const ownIdentity = await (dependencies.processIdentity ?? processIdentity)(process.pid);
  if (ownIdentity.status !== "found") {
    throw new Error("cannot establish the current process incarnation");
  }
  const owner = {
    pid: process.pid,
    token: randomUUID(),
    incarnation: ownIdentity.identity,
  };

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
    if (current !== undefined && await ownerIsActive(current, dependencies)) {
      throw new ProfileInUseError(current.owner!.pid);
    }
    await reclaimStaleLock(
      lockPath,
      recoveryPath,
      dependencies,
      ownIdentity.identity,
    );
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
