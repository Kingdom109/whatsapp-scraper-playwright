# WhatsApp Chat Scraper Design

## 2026-08-29 live-test addendum

The authorized live test showed that event posters frequently arrive as images with no usable caption or filename. Media type alone cannot support event discovery. The scraper therefore captures each rendered image, GIF, sticker, or video preview from an explicitly selected chat as a local PNG and includes its absolute path in the Markdown/JSON record. It does not fetch original-quality attachments or download audio, voice-note, or document bodies.

For multi-chat work, Chromium remains open for the full batch: login once, process exact chat names sequentially, capture any rendered poster before leaving the chat, and close only after the batch finishes. Loading is polled while the selected conversation visibly reports loading or synchronization. WhatsApp's explicit “See more chat history on the app” state is treated as unavailable web history rather than an endless load.

Relevant-chat discovery uses a title-only inventory. It traverses the virtualized active list and archived list independently until both scroll position and discovered-title set stabilize. Inventory never extracts messages; message extraction remains limited to the exact chats subsequently selected by the user or Codex.

Date: 2026-08-04
Status: Approved

## Purpose

Build a local, read-only WhatsApp Web extraction tool for the user's own linked WhatsApp account. The user or Codex can name one chat and request either the most recent number of messages or messages from the most recent number of days. The tool exports an AI-friendly Markdown file by default and can export structured JSON on request.

The first version records visible media metadata but does not download or analyze media files.

## Goals

- Extract one explicitly named individual or group chat per run.
- Support a time limit such as `--days 3` or a count limit such as `--messages 200`.
- Preserve sender, timestamp, direction, message text, and visible media metadata.
- Produce compact Markdown suitable for direct use with Codex or another language model.
- Offer JSON containing the same normalized records for downstream processing.
- Reuse a dedicated WhatsApp Web login across runs.
- Work both as a standalone command and as a command Codex can invoke.
- Fail safely without sending or changing anything in WhatsApp.

## Non-goals for Version 1

- Bulk extraction of every chat.
- Continuous monitoring of new messages.
- Sending messages, reactions, edits, deletions, or other chat mutations.
- Downloading images, video, audio, stickers, or documents.
- OCR, audio transcription, image understanding, or document text extraction.
- Guaranteed capture of replies or reactions when WhatsApp does not expose them consistently.
- Circumventing authentication, access controls, rate limits, or platform protections.

## User Experience

The project exposes one command-line program. Both the user and Codex use the same interface, so Codex operation adds no separate automation layer.

Examples:

```text
whatsapp-scrape login
whatsapp-scrape "Family Group" --days 3
whatsapp-scrape "David Cohen" --messages 200
whatsapp-scrape "Work Group" --days 1 --format json
```

Markdown is the default format. `--format json` selects JSON. Exactly one of `--days` and `--messages` is required for a scrape command. Invalid combinations fail before opening WhatsApp.

## Technical Approach

Use Node.js, TypeScript, and Playwright. Playwright launches Chromium with a dedicated persistent user-data directory owned by this project. The program remains CLI-first and does not require a graphical application.

The system is divided into small components:

1. **CLI parser** validates the chat name, limit, output format, and optional diagnostic flags.
2. **Session manager** owns the persistent Playwright profile, login detection, QR recovery, single-instance protection, and graceful shutdown.
3. **Chat navigator** searches for the requested chat, requires an exact match, handles ambiguity, opens it, and verifies its header.
4. **History loader** scrolls upward in measured steps and detects new content, loading stalls, the oldest available message, and the requested stopping condition.
5. **Message parser** converts currently rendered WhatsApp message elements into normalized records.
6. **Collector** deduplicates records across scrolling cycles and applies the final date or count boundary.
7. **Exporters** write Markdown or JSON without overwriting an existing export.
8. **Diagnostics** capture a screenshot and structured failure context when the live interface no longer matches supported extraction behavior.

UI selectors and parsing rules are isolated from navigation, collection, and export logic because WhatsApp Web's markup can change independently of the rest of the application.

## Authentication and Persistent Login

The scraper uses the same WhatsApp account as the user's phone but appears as its own linked WhatsApp Web session.

- `whatsapp-scrape login` launches a visible browser using a dedicated persistent profile.
- On the first run, the user scans WhatsApp's QR code.
- Later runs reuse cookies, local storage, and other browser state from that profile.
- The scraper never points Playwright at the user's normal Chrome profile.
- The profile is never cleared or recreated during routine upgrades or runs.
- A single-instance lock prevents concurrent processes from opening the same browser profile.
- Every run checks login state before opening a chat.
- If WhatsApp expires or revokes the linked session, the browser opens visibly and the tool asks the user to relink rather than returning an unexplained selector error.
- Normal and interrupted runs attempt a graceful browser-context close to reduce the risk of profile corruption.

The acceptance test must prove persistence by pairing once, fully closing the browser, relaunching the program, and reaching the WhatsApp chat list without another QR scan. WhatsApp may still revoke a linked device; relinking is the supported recovery path.

## Chat Selection

The user supplies the displayed chat name. The navigator searches the sidebar and opens only an exact match after normalizing harmless whitespace.

- It verifies the opened chat's header before extraction.
- It does not silently choose a partial match.
- If multiple exact matches cannot be distinguished reliably, it stops and presents the visible candidates.
- It does not enumerate or scrape unrelated chats.

These rules favor privacy and correctness over convenience.

## History Loading and Stopping Rules

WhatsApp Web loads chat history incrementally and may virtualize the message list. Therefore, the program must not depend on a final full-page HTML snapshot or a fixed number of scrolls.

Each collection cycle:

1. Parses every currently rendered message element.
2. Normalizes and adds previously unseen records to the in-memory collection.
3. Scrolls the message container upward by a measured amount.
4. Waits for either newly rendered messages or a bounded timeout.
5. Repeats until the requested boundary or a safety condition is reached.

For `--days N`, the collector uses inclusive local calendar days: `--days 1` means messages since local midnight today, while `--days 3` means today and the two preceding local calendar days. It continues until it has observed messages older than that cutoff, then filters the final collection precisely.

For `--messages N`, the collector continues until it has at least `N` unique messages, then retains the newest `N` in chronological order.

The loader stops safely when it detects the beginning of available history, repeated cycles with no older messages, loss of the selected chat, a parsing failure, or a configurable maximum number of cycles. A stalled run writes verified partial output when at least one record was collected and includes a warning explaining that the requested boundary was not reached.

## Message Model

Each normalized message record contains:

- `id`: WhatsApp's stable message identifier when exposed; otherwise a deterministic fallback fingerprint.
- `timestamp`: an ISO 8601 local timestamp when a complete date and time can be determined.
- `sender`: the displayed sender name, or `Me` for outgoing messages.
- `direction`: `incoming`, `outgoing`, or `system`.
- `text`: message text or `null`.
- `media`: `null` or an object containing the visible media type and any visible caption, filename, duration, or size.
- `kind`: `message`, `system`, `call`, `deleted`, or `unsupported`.
- `reply`: optional visible reply context when it can be extracted reliably.
- `reactions`: optional visible reaction summaries when they can be extracted reliably.
- `warnings`: record-level parsing qualifications, if any.

Media types include image, video, audio, voice note, document, GIF, and sticker. Version 1 describes the media from visible WhatsApp metadata but does not fetch the underlying file.

Deleted messages, call notices, encryption notices, group membership changes, and unsupported message cards are represented explicitly instead of silently discarded.

## Deduplication and Ordering

The preferred deduplication key is WhatsApp's stable message identifier when the page exposes one. The fallback is a deterministic fingerprint derived from the chat, sender, timestamp, direction, kind, text, and visible media metadata.

The collector stores records in a map keyed by this identifier, then sorts the final result chronologically. If two different messages cannot be distinguished by the fallback data, the tool keeps one and records an export warning rather than emitting obvious duplicates.

## Markdown Export

Exports go beneath `exports/` using a sanitized chat name and timestamp. Existing files are never overwritten.

Markdown begins with extraction metadata:

```markdown
# Family Group

- Extracted: 2026-08-04 18:30 +03:00
- Requested range: Last 3 days
- Messages: 142
- Complete: Yes
```

Messages are grouped by local date and remain chronological:

```markdown
## 2026-08-03

**09:14 - David:** Are we meeting today?

**09:20 - David:** [Image - caption: "New entrance"]
```

The exporter preserves multiline text, Unicode, emoji, and Hebrew/RTL text without transliteration. Warnings appear in a short section at the end. The format favors readable, token-efficient AI input rather than reproducing WhatsApp's visual layout.

## JSON Export

JSON contains top-level extraction metadata, the request boundary, completion status, warnings, and an array of the same normalized message records used by Markdown. It is encoded as UTF-8 and validated before the temporary output is atomically renamed to its final filename.

## Local Data and Privacy

- The browser profile, exports, screenshots, traces, and diagnostic snapshots remain local.
- Runtime data and extracted chat content are excluded from Git.
- No chat content is uploaded by the scraper.
- Logs avoid message bodies and authentication state unless an explicit diagnostic option is enabled.
- Diagnostic artifacts may contain private visible chat content and are labeled accordingly.
- The user should run the tool only for chats they are authorized to access and handle exports as sensitive personal data.

## Error Handling

Expected errors receive targeted messages and nonzero exit codes:

- Node.js, Playwright, or browser runtime missing.
- Browser profile locked by another scraper process.
- WhatsApp login required or relinking timed out.
- Chat not found or chat name ambiguous.
- Requested date/count boundary unavailable.
- History stopped loading before the boundary.
- WhatsApp interface or selectors changed.
- Output directory unavailable or export write failed.

When the interface appears to have changed, diagnostics identify the failed stage and save a screenshot. A full DOM snapshot is optional diagnostic evidence, not the extraction mechanism.

The program avoids claiming success when output is partial. Completion state and warnings appear in both console output and the export.

## Testing Strategy

### Automated tests

- CLI validation for required and mutually exclusive options.
- Parser fixtures covering individual and group messages, incoming and outgoing messages, multiline text, emoji, Hebrew/RTL text, media placeholders, captions, documents, voice notes, deleted messages, system notices, calls, replies, reactions, and unsupported cards.
- Deduplication across overlapping virtualized message windows.
- Day-boundary and message-count filtering.
- Loading-stall and partial-result behavior.
- Markdown escaping, Unicode preservation, stable ordering, and snapshot output.
- JSON schema, encoding, and atomic output behavior.
- Session-lock acquisition and cleanup.

Parser fixtures contain synthetic data and no real chat content.

### Live acceptance tests

Using a user-authorized chat:

1. Pair the dedicated profile and verify persistence after a full browser restart.
2. Extract a small fixed message count and compare representative records with the visible chat.
3. Extract a short day range and verify both sides of the cutoff.
4. Confirm chronological ordering and absence of duplicates.
5. Confirm visible media types and captions/filenames are represented.
6. Export JSON and validate it parses.
7. Trigger a safe chat-not-found case and verify no other chat is opened or scraped.
8. Confirm the tool never sends, reacts, edits, deletes, or downloads content.

## Risks and Mitigations

- **WhatsApp markup changes:** isolate selectors and parser rules; capture bounded diagnostics; keep fixture coverage.
- **Virtualized history omits passed messages:** parse every scroll window incrementally and deduplicate in memory.
- **Session expires:** detect login state and provide an explicit QR relinking flow.
- **Profile corruption or contention:** use a dedicated profile, single-instance locking, and graceful closure.
- **Wrong chat selected:** require exact search results and verify the chat header.
- **Incomplete timestamps:** preserve the record with a warning and do not use an uncertain timestamp to claim the requested cutoff was satisfied.
- **Large requests consume excessive time or memory:** enforce a configurable maximum number of loading cycles and clearly mark partial results.
- **Private data leaks into source control:** ignore all runtime profiles, exports, and diagnostics by default.

## Success Criteria

Version 1 is complete when:

- The dedicated WhatsApp login survives a complete browser restart.
- A user or Codex can run the same command against an explicitly named chat.
- Both day-limited and count-limited extraction work on authorized live chats.
- Markdown is generated by default and is concise enough for direct AI use.
- Optional JSON represents the same normalized records.
- Visible media types and available metadata are preserved without downloads.
- Records are chronological, deduplicated, and honest about partial results.
- Automated tests pass and the live acceptance checklist succeeds.
- Runtime profiles and extracted content are not tracked by Git.
