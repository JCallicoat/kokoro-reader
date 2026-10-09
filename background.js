/* Background event page: context menu, selection capture, player window management.
 * Audio is handled entirely by the player window; this script only hands it text. */

"use strict";

/* Chrome runs this file as a service worker (manifest "service_worker"), where the
 * shared helpers must be imported; Firefox loads them via "scripts" instead. */
if (typeof importScripts === "function") {
  importScripts("common/settings.js");
}

const MENU_ID = "kokoro-read-selection";
const PLAYER_URL = browser.runtime.getURL("player/player.html");
const PLAYER_WIDTH = 420;
const PLAYER_HEIGHT = 200; // the player resizes itself to fit after loading

// -- context menu ---------------------------------------------------------- //
async function createMenu() {
  await browser.contextMenus.removeAll();
  browser.contextMenus.create({
    id: MENU_ID,
    title: "Read selection aloud",
    contexts: ["selection"],
  });
}

browser.runtime.onInstalled.addListener(createMenu);
browser.runtime.onStartup.addListener(createMenu);
browser.contextMenus.onClicked.addListener(onMenuClicked);
browser.windows.onRemoved.addListener(onWindowRemoved);
browser.commands.onCommand.addListener(onCommand);

// Clicking the toolbar button or the entry in the Extensions menu opens Settings.
browser.action.onClicked.addListener(() => browser.runtime.openOptionsPage());

// -- selection capture ----------------------------------------------------- //
/* Runs inside the page. Reads the full selection, including selections inside
 * <textarea>/<input>, which window.getSelection() does not report. Text boxes
 * inside web components (shadow DOM) are found through each shadow root's
 * activeElement. (Injected functions must be self-contained, so the lookup is
 * repeated in clearSelectionInPage.) */
function readSelectionInPage() {
  let text = "";
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
    try {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      if (typeof start === "number" && typeof end === "number" && end > start) {
        text = el.value.slice(start, end);
      }
    } catch (_) {
      /* input types without selection support throw; fall through */
    }
  }
  if (!text) {
    const selection = window.getSelection();
    text = selection ? selection.toString() : "";
  }
  return { text, focused: document.hasFocus() };
}

/* Runs inside the page. Clears the selection: collapses a selection inside a
 * focused <textarea>/<input> (keeping the caret where the selection ended) and
 * removes the page's selection ranges. Text boxes keep their own selection, which
 * removeAllRanges() doesn't touch in Firefox, so they're handled explicitly. */
function clearSelectionInPage() {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
    try {
      const end = el.selectionEnd;
      if (typeof end === "number" && el.selectionStart !== end) {
        el.setSelectionRange(end, end);
        return; // removeAllRanges() would also move the field's caret to the start
      }
    } catch (_) {
      /* input types without selection support throw */
    }
  }
  const selection = window.getSelection();
  if (selection) selection.removeAllRanges();
}

/* Read the selection from one frame (menu click) or from every frame (keyboard
 * shortcut, where the frame isn't known), preferring the frame that has focus.
 * Returns the text and the frame it came from. */
async function readSelectionFromTab(tabId, frameId) {
  const target = frameId === undefined ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] };
  const results = await browser.scripting.executeScript({ target, func: readSelectionInPage });
  const found = (results || []).filter(
    (r) => r && r.result && typeof r.result.text === "string" && r.result.text.trim()
  );
  const best = found.find((r) => r.result.focused) || found[0];
  if (!best) return { text: "", frameId: null };
  const sourceFrame = typeof best.frameId === "number" ? best.frameId : frameId === undefined ? null : frameId;
  return { text: best.result.text, frameId: sourceFrame };
}

/* Returns { text, tabId, frameId } describing where the text came from, for
 * "Deselect text when playback starts". When the page script finds nothing but the
 * browser supplied the selection (menu clicks), the page is still scriptable, so
 * the tab and frame are kept and the selection can still be cleared. tabId is null
 * only when the page can't be scripted at all. */
async function getSelectedText(tab, frameId, fallbackText = "") {
  if (tab && typeof tab.id === "number" && tab.id >= 0) {
    try {
      const found = await readSelectionFromTab(tab.id, frameId);
      if (found.text.trim()) return { text: found.text, tabId: tab.id, frameId: found.frameId };
      return { text: fallbackText, tabId: tab.id, frameId: frameId === undefined ? null : frameId };
    } catch (err) {
      // Restricted pages (about:, addons.mozilla.org, some viewers) refuse scripting.
      console.debug("Kokoro Reader: could not read the selection from the page:", err);
    }
  }
  return { text: fallbackText, tabId: null, frameId: null };
}

/* "Deselect text when playback starts": clear the selection in the frame the text
 * was read from (or every frame, if that isn't known). */
async function clearSelection(source) {
  if (!source || typeof source.tabId !== "number") return;
  const target =
    typeof source.frameId === "number"
      ? { tabId: source.tabId, frameIds: [source.frameId] }
      : { tabId: source.tabId, allFrames: true };
  try {
    await browser.scripting.executeScript({ target, func: clearSelectionInPage });
  } catch (err) {
    console.debug("Kokoro Reader: could not clear the selection:", err);
  }
}

/* Brief badge on the toolbar button when the shortcut finds nothing to read. */
let badgeTimer = null;
function flashNothingSelected() {
  browser.action.setBadgeText({ text: "?" });
  browser.action.setTitle({ title: "Kokoro Reader: no text selected" });
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    browser.action.setBadgeText({ text: "" });
    browser.action.setTitle({ title: browser.runtime.getManifest().action.default_title });
  }, 2000);
}

// -- player window --------------------------------------------------------- //
async function getPlayerWindow() {
  const { playerWindowId } = await browser.storage.session.get("playerWindowId");
  if (typeof playerWindowId !== "number") return null;
  try {
    const win = await browser.windows.get(playerWindowId, { populate: true });
    if (win.type !== "popup") return null;
    // Chrome hides tab URLs without the "tabs" permission, so only reject the window
    // when a URL is visible and isn't the player (window IDs can be reused).
    const urls = (win.tabs || []).map((t) => t.url).filter(Boolean);
    return urls.length === 0 || urls.some((u) => u.startsWith(PLAYER_URL)) ? win : null;
  } catch (_) {
    return null; // window no longer exists
  }
}

async function showPlayer() {
  const existing = await getPlayerWindow();
  if (existing) {
    // The player picks up the new session from storage.onChanged; just bring it forward.
    const update = { focused: true };
    if (existing.state === "minimized") update.state = "normal";
    await browser.windows.update(existing.id, update);
    return;
  }
  const win = await browser.windows.create({
    url: PLAYER_URL,
    type: "popup",
    width: PLAYER_WIDTH,
    height: PLAYER_HEIGHT,
  });
  await browser.storage.session.set({ playerWindowId: win.id });
}

async function onWindowRemoved(windowId) {
  const { playerWindowId } = await browser.storage.session.get("playerWindowId");
  if (windowId === playerWindowId) {
    await browser.storage.session.remove(["playerWindowId", "currentSession"]);
  }
}

// -- triggers -------------------------------------------------------------- //
/* source: where the text was read from ({ tabId, frameId }), used to deselect it. */
async function readAloud(text, source = null) {
  const settings = await loadSettings();
  if (!voiceString(settings.voices)) {
    await browser.runtime.openOptionsPage();
    return;
  }
  // Publish the session before showing the window: a new window reads it on load,
  // an existing one receives it through storage.onChanged.
  const session = { id: crypto.randomUUID(), text };
  await browser.storage.session.set({ currentSession: session });
  // The text has been handed over, so the selection can go now. Clear it before the
  // player window opens: once the page's window has lost focus, Firefox can restore
  // a text box's old selection when the window is activated again.
  if (settings.deselectOnPlay) await clearSelection(source);
  await showPlayer();
}

async function onMenuClicked(info, tab) {
  if (info.menuItemId !== MENU_ID) return;
  const found = await getSelectedText(tab, info.frameId || 0, info.selectionText || "");
  const text = found.text.trim();
  if (text) await readAloud(text, found);
}

async function onCommand(command, tab) {
  if (command !== READ_COMMAND) return;
  if (!tab) {
    // Older Firefox versions don't pass the tab to onCommand.
    [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  }
  const found = await getSelectedText(tab);
  const text = found.text.trim();
  if (text) {
    await readAloud(text, found);
  } else {
    flashNothingSelected();
  }
}
