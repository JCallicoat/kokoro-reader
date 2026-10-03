/* Turns a keydown event into a Firefox "commands" shortcut string.
 *
 * Firefox's rules (manifest.json "commands", commands.update):
 *  - Modifier+Key or Modifier+SecondaryModifier+Key, where the modifier is
 *    Ctrl, Alt, Command or MacCtrl and the secondary may also be Shift;
 *  - keys: A-Z, 0-9, F1-F19, Comma, Period, Home, End, PageUp, PageDown, Space,
 *    Insert, Delete, Up, Down, Left, Right;
 *  - function keys may be used without a modifier;
 *  - media keys are used on their own. */

"use strict";

const MEDIA_KEYS = {
  MediaPlayPause: "MediaPlayPause",
  MediaTrackNext: "MediaNextTrack",
  MediaTrackPrevious: "MediaPrevTrack",
  MediaStop: "MediaStop",
};

const NAMED_KEYS = {
  Comma: "Comma",
  Period: "Period",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Space: "Space",
  Insert: "Insert",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

const MODIFIER_CODES = new Set([
  "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight",
  "AltLeft", "AltRight", "MetaLeft", "MetaRight", "OSLeft", "OSRight", "AltGraph",
]);

function shortcutKeyName(code) {
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return { name: m[1], kind: "plain" };
  m = /^Digit([0-9])$/.exec(code);
  if (m) return { name: m[1], kind: "plain" };
  m = /^F([1-9]|1[0-9])$/.exec(code);
  if (m) return { name: code, kind: "function" };
  if (NAMED_KEYS[code]) return { name: NAMED_KEYS[code], kind: "plain" };
  if (MEDIA_KEYS[code]) return { name: MEDIA_KEYS[code], kind: "media" };
  return null;
}

/**
 * @param {{code: string, ctrlKey: boolean, altKey: boolean, shiftKey: boolean, metaKey: boolean}} e
 * @param {boolean} isMac  On macOS Ctrl is "MacCtrl" and Cmd is "Command".
 * @returns {{shortcut?: string, partial?: string, error?: string}}
 *   shortcut: a complete valid combination; partial: modifiers held so far;
 *   error: why the combination can't be used.
 */
function shortcutFromEvent(e, isMac) {
  const primary = [];
  if (e.ctrlKey) primary.push(isMac ? "MacCtrl" : "Ctrl");
  if (e.altKey) primary.push("Alt");
  if (e.metaKey) {
    if (!isMac) return { error: "The Super/Meta key can't be used in Firefox shortcuts." };
    primary.push("Command");
  }
  const modifiers = e.shiftKey ? [...primary, "Shift"] : primary;

  if (MODIFIER_CODES.has(e.code)) {
    return { partial: modifiers.length ? modifiers.join("+") + "+…" : "" };
  }

  const key = shortcutKeyName(e.code);
  if (!key) return { error: "That key can't be used in a Firefox shortcut." };

  if (key.kind === "media") {
    if (modifiers.length) return { error: "Media keys must be used without modifiers." };
    return { shortcut: key.name };
  }
  if (modifiers.length > 2) return { error: "Use at most two modifier keys." };
  if (key.kind !== "function" && primary.length === 0) {
    return { error: "Include Ctrl or Alt" + (isMac ? " or Cmd" : "") + " (Shift alone isn't enough)." };
  }
  return { shortcut: [...modifiers, key.name].join("+") };
}

if (typeof module !== "undefined") module.exports = { shortcutFromEvent };
