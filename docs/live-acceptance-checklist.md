# Live read-only acceptance checklist

These checks require a user-authorized WhatsApp account and a low-sensitivity chat. Keep every item unchecked until it has direct live evidence. Do not paste chat contents into logs, commits, or reports.

## Automated checks first

- [ ] `npm.cmd test` passes.
- [ ] `npm.cmd run check` passes.
- [ ] `npm.cmd run build` passes.
- [ ] `git diff --check` reports no whitespace errors.

## Live login and persistence

- [ ] Initial QR pairing reaches the chat list.
- [ ] Full browser close and relaunch reaches the chat list without another QR scan.

## Authorized extraction

- [ ] Exact named chat opens and its header is verified.
- [ ] A small `--messages` export matches visible sender, order, text, and timestamps.
- [ ] A `--days 1` export includes today's messages and excludes yesterday's.
- [ ] Export has no duplicate identifiers or obvious duplicate messages.
- [ ] Image/document/voice-note examples show the correct media type and visible metadata.
- [ ] JSON output parses with `Get-Content -Raw <file> | ConvertFrom-Json`.
- [ ] A nonexistent chat exits nonzero without opening another chat.
- [ ] No message, reaction, edit, delete, or media download occurs.

## Privacy boundary

- [ ] `git status --short` shows no profile, export, or diagnostic artifacts.

## Suggested operator commands

From the project directory, after setup and with the user's approval:

```powershell
node dist/cli.js login
node dist/cli.js "<authorized chat>" --messages 20
node dist/cli.js "<authorized chat>" --days 1 --format json
Get-Content -Raw <file> | ConvertFrom-Json
git status --short
git check-ignore -v -- .whatsapp-profile/ exports/ diagnostics/ .runtime/
```

Do not copy `.whatsapp-profile`. Inspect exports and diagnostics locally, and mark only the checklist claims supported by observation.
