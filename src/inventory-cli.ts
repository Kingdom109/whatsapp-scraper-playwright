#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openWhatsAppSession, type WhatsAppSession } from "./session.js";
import { inventoryChats, type ChatInventory } from "./whatsapp/chat-list.js";
import { ensureLoggedIn } from "./whatsapp/navigator.js";

type SignalName = "SIGINT" | "SIGTERM";
type SignalRegistrar = (signal: SignalName, handler: () => void) => () => void;

export interface InventoryFileSystem {
  mkdir: typeof mkdir;
  writeFile: typeof writeFile;
  rename: typeof rename;
  unlink: typeof unlink;
  randomUUID(): string;
}

export interface InventoryDependencies {
  openSession: typeof openWhatsAppSession;
  ensureLogin: typeof ensureLoggedIn;
  inventory: typeof inventoryChats;
  writeInventory: typeof writeInventoryFile;
  registerSignal: SignalRegistrar;
  now(): Date;
}

export type InventoryDocument = ChatInventory & { extractedAt?: string };

const fileSystem: InventoryFileSystem = { mkdir, writeFile, rename, unlink, randomUUID };

function registerProcessSignal(signal: SignalName, handler: () => void): () => void {
  process.once(signal, handler);
  return () => process.off(signal, handler);
}

export async function writeInventoryFile(
  path: string,
  inventory: InventoryDocument,
  overrides: Partial<InventoryFileSystem> = {},
): Promise<void> {
  const fs = { ...fileSystem, ...overrides };
  const temporaryPath = `${path}.${fs.randomUUID()}.tmp`;
  let published = false;
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(temporaryPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, path);
    published = true;
  } finally {
    if (!published) await fs.unlink(temporaryPath).catch(() => {});
  }
}

const defaults: InventoryDependencies = {
  openSession: openWhatsAppSession,
  ensureLogin: ensureLoggedIn,
  inventory: inventoryChats,
  writeInventory: writeInventoryFile,
  registerSignal: registerProcessSignal,
  now: () => new Date(),
};

export async function inventoryMain(
  overrides: Partial<InventoryDependencies> = {},
): Promise<number> {
  const dependencies: InventoryDependencies = { ...defaults, ...overrides };
  let session: WhatsAppSession | undefined;
  let interrupted: SignalName | undefined;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise === undefined && session !== undefined) closePromise = session.close();
    return closePromise ?? Promise.resolve();
  };
  let resolveInterruption!: (signal: SignalName) => void;
  const interruption = new Promise<SignalName>((resolve) => { resolveInterruption = resolve; });
  const waitFor = async <T>(operation: Promise<T>): Promise<T> => {
    void operation.then(() => undefined, () => undefined);
    const result = await Promise.race([
      operation.then(
        (value) => ({ kind: "value" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      interruption.then((signal) => ({ kind: "interrupted" as const, signal })),
    ]);
    if (result.kind === "value") return result.value;
    if (result.kind === "error") throw result.error;
    throw new Error(`Interrupted by ${result.signal}`);
  };
  const removers: Array<() => void> = [];
  let exitCode = 1;
  try {
    session = await dependencies.openSession({ headed: true });
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      removers.push(dependencies.registerSignal(signal, () => {
        if (interrupted !== undefined) return;
        interrupted = signal;
        resolveInterruption(signal);
        void close().catch(() => undefined);
      }));
    }
    await waitFor(dependencies.ensureLogin(session.page));
    const inventory = await waitFor(dependencies.inventory(session.page));
    const now = dependencies.now();
    const path = join("exports", `chat-inventory-${now.toISOString().replace(/[:]/g, "-")}.json`);
    await waitFor(dependencies.writeInventory(path, { extractedAt: now.toISOString(), ...inventory }));
    process.stdout.write(`Chat inventory written to ${path}\n`);
    exitCode = 0;
  } catch {
    if (interrupted === undefined) {
      process.stderr.write("WhatsApp chat inventory could not be completed. Review the visible browser and retry.\n");
    }
  } finally {
    for (const remove of removers) remove();
    try {
      await close();
    } catch {
      process.stderr.write("WhatsApp chat inventory browser could not be closed cleanly.\n");
      exitCode = 1;
    }
  }
  if (interrupted !== undefined) return interrupted === "SIGTERM" ? 143 : 130;
  return exitCode;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined
  && realpathSync(resolve(invokedPath)) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await inventoryMain();
}
