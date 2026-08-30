export const whatsappSelectors = {
  appReady: ["#main", "#side"],
  qrCode: ['#app canvas[aria-label*="QR"]', '#app [data-testid="qrcode"]'],
  searchBox: [
    '#side [contenteditable="true"][data-tab="3"]',
    '#side [role="textbox"][contenteditable="true"]',
    '#side input[role="textbox"][data-tab="3"]',
  ],
  chatTitles: [
    '#side [data-testid="cell-frame-title"] span[title]',
    '#side span[title]',
    '#side [data-testid="cell-frame-title"]',
    '#side [title][role="gridcell"]',
  ],
  chatHeaderTitle: [
    '#main [data-testid="conversation-info-header-chat-title"]',
    '#main header [title]',
  ],
  messageRows: [
    '#main [data-testid="msg-container"]',
    "#main .legacy-message",
    '#main [data-id][class*="message-"]',
  ],
  messageText: [
    '[data-testid="selectable-text"]',
    '.selectable-text.copyable-text span[dir="ltr"]',
    '.selectable-text.copyable-text span[dir="rtl"]',
  ],
  metadata: [
    '[data-testid="msg-meta"][data-pre-plain-text]',
    "[data-pre-plain-text]",
  ],
  scrollContainer: [
    '#main [data-testid="conversation-panel-messages"]',
    '#main .copyable-area [tabindex="-1"]',
  ],
  historyStart: [
    '#main [data-testid="conversation-history-start"]',
    '#main [data-testid="history-start"]',
  ],
  deleted: ['[data-testid="deleted-message"]', '[aria-label="This message was deleted"]'],
  system: ['[data-testid="system-message"]', ".system-message"],
  call: ['[data-testid="call-message"]', '[data-testid="call-log-message"]'],
  reply: ['[data-testid="quoted-message"]', '[data-testid="quoted-message-container"]'],
  reactions: ['[data-testid="reactions"]', '[data-testid="reaction-list"]'],
  mediaCaption: ['[data-testid="media-caption"]', ".media-caption"],
  mediaFilename: [
    '[data-testid="document-filename"]',
    '[data-testid="document-title"]',
    ".document-filename",
  ],
  mediaDuration: [
    '[data-testid="media-duration"]',
    '[data-testid="media-playback-time"]',
    ".media-duration",
  ],
  mediaSize: ['[data-testid="document-size"]', ".document-size"],
  quotedSender: ['[data-testid="quoted-sender"]', '[data-testid="quoted-author"]'],
  quotedText: [
    '[data-testid="quoted-text"]',
    '[data-testid="quoted-text-fallback"]',
    '[data-testid="selectable-text"]',
  ],
  reactionItems: ['[data-testid="reaction"]', '[data-testid="reaction-chip"]'],
  reactionCountText: [
    '[data-testid="reaction-count"]',
    '[data-testid="reaction-count-fallback"]',
  ],
  reactionCountAttribute: [
    "[data-count]",
  ],
  reactionEmojiText: [
    '[data-testid="reaction-emoji"]',
    '[data-testid="reaction-emoji-fallback"]',
    '[data-testid="selectable-text"]',
  ],
  reactionEmojiAttribute: [
    "[data-emoji]",
  ],
  reactionEmojiAccessible: ["[aria-label]"],
  media: {
    image: ['[data-testid="image-message"]', 'img[src^="blob:"]'],
    video: ['[data-testid="video-message"]', "video"],
    audio: ['[data-testid="audio-message"]', 'audio:not([data-testid="voice-note"])'],
    voiceNote: ['[data-testid="voice-note"]', '[data-icon="ptt"]'],
    document: ['[data-testid="document-message"]', '[data-icon="document"]'],
    gif: ['[data-testid="gif-message"]', '[data-testid="media-gif"]'],
    sticker: ['[data-testid="sticker-message"]', '[data-testid="sticker"]'],
  },
} as const;

export type WhatsAppSelectors = typeof whatsappSelectors;
