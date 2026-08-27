import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";

export type DiagnosticStage = "chat-navigation" | "history-loading";

interface DiagnosticOptions {
  rootDirectory?: string;
  now?: () => Date;
}

const MAX_SCREENSHOT_WIDTH = 1440;
const MAX_SCREENSHOT_HEIGHT = 1000;
const MAX_DOM_BYTES = 5_000_000;

export async function captureDiagnostic(
  page: Page,
  stage: DiagnosticStage,
  includeDom: boolean,
  options: DiagnosticOptions = {},
): Promise<string[]> {
  const now = options.now?.() ?? new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const directory = join(options.rootDirectory ?? "diagnostics", stamp);
  await mkdir(directory, { recursive: true });

  const metadataPath = join(directory, "failure.json");
  const screenshotPath = join(directory, "screen.png");
  await writeFile(metadataPath, `${JSON.stringify({
    stage,
    timestamp: now.toISOString(),
    category: "unexpected-ui-failure",
    privacy: "private-sensitive",
  }, null, 2)}\n`, "utf8");

  const viewport = page.viewportSize();
  const width = Math.min(viewport?.width ?? MAX_SCREENSHOT_WIDTH, MAX_SCREENSHOT_WIDTH);
  const height = Math.min(viewport?.height ?? MAX_SCREENSHOT_HEIGHT, MAX_SCREENSHOT_HEIGHT);
  await page.screenshot({
    path: screenshotPath,
    fullPage: false,
    timeout: 5_000,
    clip: { x: 0, y: 0, width, height },
  });

  const files = [metadataPath, screenshotPath];
  if (includeDom) {
    const domPath = join(directory, "page.html");
    const dom = Buffer.from(await page.content(), "utf8");
    await writeFile(domPath, dom.subarray(0, MAX_DOM_BYTES));
    files.push(domPath);
  }

  process.stderr.write(
    `Private sensitive diagnostic artifacts were written beneath ${directory}. Review before sharing.\n`,
  );
  return files;
}
