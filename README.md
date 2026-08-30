# WhatsApp Chat Scraper

Local, read-only extraction from explicitly named chats in a user-authorized WhatsApp Web account. The tool produces AI-friendly Markdown by default and can produce JSON on request. Rendered image, GIF, sticker, and video previews are saved locally so an AI can inspect event posters.

## Requirements and setup

On Windows, install Node.js 22.12 or newer, then from this project directory run:

```powershell
npm.cmd install
npm.cmd exec playwright install chromium
npm.cmd run build
```

The build writes the executable to `dist/cli.js`.

## Link the dedicated browser profile

Run:

```powershell
node dist/cli.js login
```

This opens a visible Chromium window using `.whatsapp-profile`, a dedicated persistent browser profile. It is a separate linked WhatsApp Web instance of the same WhatsApp account on your phone; it is not your normal Chrome profile. On the first run, scan the QR code with the phone that owns the account. Later runs reuse the saved linked-device session.

If WhatsApp expires or revokes the linked session, the browser will show a QR code again. Scan it to relink; this is the supported recovery path. Do not delete or copy the profile as part of routine operation. Only one scraper process may use it at a time.

## Scrape one chat

The chat name must be the displayed name and must match exactly (apart from harmless whitespace). The command refuses partial or ambiguous matches and verifies the opened chat header.

```powershell
node dist/cli.js "Family Group" --days 3
node dist/cli.js "David Cohen" --messages 200 --format json
```

Exactly one of `--days` or `--messages` is required, and each value must be a positive integer. `--format md` is the default; `--format json` selects JSON. Files are written beneath `exports/` without overwriting an existing export.

## Inventory and scrape several chats in one browser session

Create complete active and archived chat-title inventories by traversing both virtualized lists to a stable bottom:

```powershell
node dist/inventory-cli.js
```

The inventory is written beneath `exports/`. It contains chat titles only. Review it locally and select the authorized chats you want to scrape.

Scrape several exact chat names without closing or reopening Chromium between them:

```powershell
node dist/batch-cli.js "Community Events" "Local Announcements" --days 7 --format json
```

The batch logs in once, keeps the same Playwright session open, captures each chat sequentially, and closes only after the batch finishes. A failure in one chat does not discard successful exports from the others.

`--days N` uses inclusive local calendar days: `--days 1` means since local midnight today; `--days 3` includes today and the two preceding local calendar days. `--messages N` retains the newest N unique messages in chronological order.

If history stops loading, the boundary cannot be reached, or another safe stopping condition occurs, the tool writes the records it has when possible and marks the result incomplete. The export includes a warning, and the CLI reports the export path plus an incomplete status. Incomplete scrapes exit with status `2`; they must not be treated as a complete range. Terminal warnings are fixed, content-free summaries—review the local export for details.

## What is captured

Records include sender, local ISO timestamp when determinable, direction, text, message kind, and visible reply/reaction information when reliable. For media, the export includes the visible type (image, video, audio, voice note, document, GIF, or sticker) plus visible caption, filename, duration, or size. When WhatsApp renders an image, GIF, sticker, or video preview, the scraper saves that rendered element as a local PNG beneath `exports/media/` and includes its exact absolute `localPath` in Markdown and JSON. This is a local visual capture, not an original-quality attachment download; audio, voice notes, and document bodies are not downloaded.

## Diagnostics and sensitive data

Chat-navigation or history-loading errors that escape normal partial-result handling attempt to create private diagnostic artifacts beneath `diagnostics/`: failure metadata and a bounded screenshot. Recoverable history-loading problems instead produce an incomplete export with warnings. A failed diagnostic capture can leave only some artifacts. The page DOM is attempted only when a scrape is run with `--diagnostics`:

```powershell
node dist/cli.js "Family Group" --messages 20 --diagnostics
```

Screenshots and DOM snapshots may contain private visible chat content. The `.whatsapp-profile` directory contains authentication state, and `exports/` contains extracted chat data. Treat `.whatsapp-profile/`, `exports/`, and `diagnostics/` as sensitive local data; review artifacts before sharing them. Runtime data is ignored by Git. Normal logs do not print message bodies or authentication state.

## Safety boundaries

This program is read-only. It does not send messages, add reactions, edit or delete messages. Single and batch scraping open only exact chat names supplied on the command line. The inventory command enumerates active and archived chat titles but does not extract their messages. Rendered media previews are captured locally only while processing an explicitly selected chat. Use it only for chats you are authorized to access.

## Troubleshooting

- **QR code or login timeout:** keep the visible browser open, scan the current QR code from the phone, and retry `node dist/cli.js login`. If the linked device was revoked, relinking is required.
- **Profile already in use:** close another scraper run using this project profile, then retry. Do not run concurrent instances against `.whatsapp-profile`.
- **Chat not found or ambiguous:** copy the displayed chat name exactly, including punctuation, and do not rely on a partial name.
- **History stalled or result is incomplete:** check the warning in the export. Retry with a smaller boundary; the tool will not claim the requested range was reached when it was not.
- **Unexpected WhatsApp interface error:** retry first. If it persists, add `--diagnostics` to a scrape and review the private artifacts locally before sharing.
- **Browser executable missing:** rerun `npm.cmd exec playwright install chromium`, then `npm.cmd run build`.

During an active run, `Ctrl+C` or a termination signal closes the persistent browser session once before the tool exits. `SIGINT` exits with status `130`; `SIGTERM` exits with status `143`. If shutdown cannot be confirmed, the tool exits with status `1`; close the visible browser before retrying.

## Automated checks

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run build
git diff --check
```

The live read-only acceptance procedure is [docs/live-acceptance-checklist.md](docs/live-acceptance-checklist.md). It remains unchecked until each item has direct evidence from an authorized live account.
