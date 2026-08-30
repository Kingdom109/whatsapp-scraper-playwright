import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inventoryChats, traverseCurrentChatList } from "../src/whatsapp/chat-list.js";

let browser: Browser;
let page: Page;

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser.close(); });
beforeEach(async () => { page = await browser.newPage({ viewport: { width: 800, height: 600 } }); });
afterEach(async () => { await page.close(); });

describe("inventoryChats", () => {
  it("traverses virtualized active and archived lists to their stable bottoms", async () => {
    await page.setContent(`
      <div id="side" style="width:320px;height:550px">
        <button id="archived">Archived</button>
        <div id="heading">Chats</div>
        <div id="list" style="height:450px;overflow-y:auto;position:relative"></div>
      </div>
      <div id="main" style="position:absolute;left:350px;top:0;width:400px;height:550px;overflow-y:auto">
        <div style="height:5000px"><span title="Not a chat title">Conversation content</span></div>
      </div>
      <script>
        const active = Array.from({length: 24}, (_, i) => 'Active ' + (i + 1));
        const archived = Array.from({length: 17}, (_, i) => 'Archived ' + (i + 1));
        let current = active;
        const list = document.querySelector('#list');
        function render() {
          const start = Math.floor(list.scrollTop / 50);
          list.innerHTML = '<div style="height:' + (current.length * 50) + 'px;position:relative">' +
            current.slice(start, start + 10).map((title, offset) =>
              '<div data-testid="cell-frame-title" style="position:absolute;top:' + ((start + offset) * 50) + 'px;height:50px"><span title="' + title + '">' + title + '</span></div>'
            ).join('') + '</div>';
        }
        list.addEventListener('scroll', render);
        document.querySelector('#archived').addEventListener('click', () => {
          current = archived;
          list.scrollTop = 0;
          document.querySelector('#heading').textContent = 'Archived';
          render();
        });
        render();
      </script>
    `);

    const inventory = await inventoryChats(page, { settleMs: 10 });

    expect(inventory.active).toEqual(Array.from({ length: 24 }, (_, i) => `Active ${i + 1}`));
    expect(inventory.archived).toEqual(Array.from({ length: 17 }, (_, i) => `Archived ${i + 1}`));
  });

  it("inventories a non-scrolling list with plain titled spans", async () => {
    await page.setContent(`
      <div id="side"><div id="list" style="height:300px;overflow-y:auto">
        <span title="Only chat">Only chat</span>
      </div></div>
    `);

    await expect(traverseCurrentChatList(page, { settleMs: 1 })).resolves.toEqual(["Only chat"]);
  });

  it("waits for WhatsApp to mount the chat-list scroller after login is ready", async () => {
    await page.setContent('<div id="side"></div>');
    await page.evaluate(() => setTimeout(() => {
      document.querySelector("#side")!.innerHTML = `
        <div style="height:300px;overflow-y:auto"><span title="Late chat">Late chat</span></div>
      `;
    }, 50));

    await expect(traverseCurrentChatList(page, { settleMs: 1 })).resolves.toEqual(["Late chat"]);
  });

  it("can traverse WhatsApp's archived side pane when it is mounted outside #side", async () => {
    await page.setContent(`
      <div id="side"></div>
      <div id="archived-pane" style="height:300px;overflow-y:auto">
        <span title="Archived chat">Archived chat</span>
      </div>
      <div id="main" style="height:500px;overflow-y:auto">
        <div style="height:2000px"><span title="Message content">Message content</span></div>
      </div>
    `);

    await expect(traverseCurrentChatList(page, { settleMs: 1 })).resolves.toEqual(["Archived chat"]);
  });

  it("keeps the active inventory when the Archived control is unavailable", async () => {
    await page.setContent(`
      <div id="side"><div id="list" style="height:300px;overflow-y:auto">
        <div data-testid="cell-frame-title"><span title="Only active chat">Only active chat</span></div>
      </div></div>
    `);

    await expect(inventoryChats(page, { settleMs: 1 })).resolves.toEqual({
      active: ["Only active chat"],
      archived: [],
    });
  });

  it("uses overlapping scroll steps for a small virtualized viewport", async () => {
    await page.setContent(`
      <div id="side"><div id="list" style="width:300px;height:200px;overflow-y:auto;position:relative"></div></div>
      <script>
        const chats = Array.from({length: 25}, (_, i) => 'Chat ' + (i + 1));
        const list = document.querySelector('#list');
        function render() {
          const start = Math.floor(list.scrollTop / 50);
          list.innerHTML = '<div style="height:' + (chats.length * 50) + 'px;position:relative">' +
            chats.slice(start, start + 5).map((title, offset) =>
              '<div data-testid="cell-frame-title" style="position:absolute;top:' + ((start + offset) * 50) + 'px;height:50px"><span title="' + title + '">' + title + '</span></div>'
            ).join('') + '</div>';
        }
        list.addEventListener('scroll', render);
        render();
      </script>
    `);

    await expect(traverseCurrentChatList(page, { settleMs: 10 })).resolves.toEqual(
      Array.from({ length: 25 }, (_, index) => `Chat ${index + 1}`),
    );
  });
});
