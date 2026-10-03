/* Options page (port of SettingsDialog). */

"use strict";

const $ = (id) => document.getElementById(id);
const voiceBoxes = [$("voice1"), $("voice2"), $("voice3")];
const VOICE_FETCH_TIMEOUT_MS = 10000;

let fetchController = null;
let fetchGeneration = 0;

// -- status helpers ---------------------------------------------------------- //
function setStatus(el, text, kind = "") {
  el.textContent = text;
  el.className = "hint" + (kind ? " " + kind : "");
}

// -- host permission --------------------------------------------------------- //
/* Must be called synchronously from a click/submit handler (before any await),
 * because Firefox only shows permission prompts in response to user input. */
function requestServerAccess(baseUrl) {
  let pattern;
  try {
    pattern = hostPermissionPattern(baseUrl);
  } catch (_) {
    return Promise.resolve(false);
  }
  return browser.permissions.request({ origins: [pattern] }).catch(() => false);
}

async function hasServerAccess(baseUrl) {
  try {
    return await browser.permissions.contains({ origins: [hostPermissionPattern(baseUrl)] });
  } catch (_) {
    return false;
  }
}

/* Show a notice with an "Allow access" button when the server in the URL field
 * is not covered by a granted host permission. localhost and 127.0.0.1 are
 * granted by the manifest, so the default setup normally needs no prompt. */
async function updateAccessNotice() {
  const baseUrl = $("baseUrl").value.trim();
  let host = "";
  try {
    host = new URL(normalizeBaseUrl(baseUrl)).host;
  } catch (_) {
    /* invalid URL: nothing to grant */
  }
  const missing = Boolean(host) && !(await hasServerAccess(baseUrl));
  $("accessHost").textContent = host;
  $("accessNotice").hidden = !missing;
}

function onGrantClicked() {
  requestServerAccess($("baseUrl").value).then((granted) => {
    updateAccessNotice();
    if (granted) fetchVoices();
  });
}

// -- voices ------------------------------------------------------------------ //
function currentSelection() {
  return voiceBoxes.map((box) => box.value || "");
}

function setVoiceChoices(voices, selected, keepMissing) {
  voiceBoxes.forEach((box, index) => {
    box.replaceChildren();
    if (index > 0) box.add(new Option("(none)", ""));
    const names = [...voices];
    const wanted = selected[index] || "";
    if (wanted && !names.includes(wanted) && keepMissing) names.push(wanted);
    for (const name of names) box.add(new Option(name, name));
    box.value = names.includes(wanted) ? wanted : index > 0 ? "" : names[0] || "";
  });
  updateVoiceString();
}

function updateVoiceString() {
  $("voiceString").value = effectiveVoice({ model: $("model").value, voices: currentSelection() });
  $("voice1").classList.toggle("invalid", false);
}

/* Voice mixing and the volume multiplier only apply to the kokoro model. */
function updateModelDependent() {
  const kokoro = $("model").value === "kokoro";
  $("voice2").disabled = !kokoro;
  $("voice3").disabled = !kokoro;
  $("volumeMultiplier").disabled = !kokoro;
  updateVoiceString();
}

async function fetchVoices() {
  if (fetchController) fetchController.abort();
  const controller = new AbortController();
  fetchController = controller;
  const generation = ++fetchGeneration;
  const timer = setTimeout(() => controller.abort(), VOICE_FETCH_TIMEOUT_MS);
  const status = $("voiceStatus");
  setStatus(status, "Loading voices…");

  try {
    const response = await fetch(apiUrl($("baseUrl").value, "/v1/audio/voices"), {
      headers: apiHeaders({ apiKey: $("apiKey").value.trim() }),
      signal: controller.signal,
    });
    if (generation !== fetchGeneration) return;
    if (response.status === 404) {
      // OpenAI's API has no voice-list endpoint (Kokoro-FastAPI always does).
      setVoiceChoices(OPENAI_TTS1_VOICES, currentSelection(), false);
      setStatus(status, "This server has no voice list; showing the standard OpenAI voices.", "ok");
      return;
    }
    if (response.status === 401 || response.status === 403) {
      setStatus(status, "Could not load voices: the server rejected the API key.", "error");
      return;
    }
    if (!response.ok) {
      setStatus(status, "Could not load voices: " + describeHttpError(response.status, await response.text()), "error");
      return;
    }
    let voices;
    try {
      voices = extractVoiceNames(await response.json());
    } catch (_) {
      setStatus(status, "Could not parse the voices response.", "error");
      return;
    }
    if (generation !== fetchGeneration) return;
    setVoiceChoices(voices, currentSelection(), false);
    setStatus(status, `${voices.length} voices loaded.`, "ok");
  } catch (err) {
    if (generation !== fetchGeneration) return;
    const timedOut = err && err.name === "AbortError";
    const access = await hasServerAccess($("baseUrl").value);
    let message = timedOut ? "Could not load voices: the server did not respond." : "Could not load voices: server unreachable.";
    if (!access) message += " Click “Reload voices” to allow access to the server.";
    setStatus(status, message, "error");
  } finally {
    clearTimeout(timer);
    if (fetchController === controller) fetchController = null;
  }
}

// -- form -------------------------------------------------------------------- //
function fillForm(s) {
  $("baseUrl").value = s.baseUrl;
  $("model").value = s.model;
  $("apiKey").value = s.apiKey;
  $("speed").value = s.speed;
  $("volumeMultiplier").value = s.volumeMultiplier;
  $("keepPlayerOpen").checked = s.keepPlayerOpen;
  $("loopPlayback").checked = s.loopPlayback;
  updateLoopEnabled();
  $("sampleRate").value = s.sampleRate;
  $("prebufferMs").value = s.prebufferMs;
  $("scrubStepS").value = s.scrubStepS;
  $("customPlayerColors").checked = s.customPlayerColors;
  $("playerBackground").value = s.playerBackground;
  $("playerForeground").value = s.playerForeground;
  updateColorPreview();
  // Start with the saved selection so the mix stays valid even if the server is down.
  setVoiceChoices([], s.voices, true);
}

function readNumber(id, fallback) {
  const el = $(id);
  const min = Number(el.min);
  const max = Number(el.max);
  const value = clampNumber(el.value, min, max, fallback);
  el.value = value;
  return value;
}

function readForm() {
  const d = DEFAULT_SETTINGS;
  return {
    baseUrl: $("baseUrl").value.trim(),
    model: MODEL_OPTIONS.includes($("model").value) ? $("model").value : d.model,
    apiKey: $("apiKey").value.trim(),
    voices: currentSelection(),
    speed: readNumber("speed", d.speed),
    volumeMultiplier: readNumber("volumeMultiplier", d.volumeMultiplier),
    keepPlayerOpen: $("keepPlayerOpen").checked,
    loopPlayback: $("loopPlayback").checked,
    sampleRate: Math.round(readNumber("sampleRate", d.sampleRate)),
    prebufferMs: Math.round(readNumber("prebufferMs", d.prebufferMs)),
    scrubStepS: Math.round(readNumber("scrubStepS", d.scrubStepS)),
    ...readColors(),
  };
}

/* "Loop playback after end" only applies while the player stays open. */
function updateLoopEnabled() {
  $("loopPlayback").disabled = !$("keepPlayerOpen").checked;
}

// -- appearance -------------------------------------------------------------- //
function readColors() {
  const d = DEFAULT_SETTINGS;
  return {
    customPlayerColors: $("customPlayerColors").checked,
    playerBackground: normalizeHexColor($("playerBackground").value, d.playerBackground),
    playerForeground: normalizeHexColor($("playerForeground").value, d.playerForeground),
  };
}

function contrastRatio(a, b) {
  const [hi, lo] = [colorLuminance(a), colorLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function updateColorPreview() {
  const colors = readColors();
  $("playerBackground").disabled = !colors.customPlayerColors;
  $("playerForeground").disabled = !colors.customPlayerColors;
  applyPlayerColors($("colorPreview"), colors);
  const ratio = contrastRatio(colors.playerBackground, colors.playerForeground);
  if (colors.customPlayerColors && ratio < 4.5) {
    setStatus($("contrastHint"), `Low contrast (${ratio.toFixed(1)}:1); text may be hard to read.`, "error");
  } else {
    setStatus($("contrastHint"), "");
  }
}

async function onSubmit(event) {
  event.preventDefault();
  const saveStatus = $("saveStatus");
  const baseUrl = $("baseUrl").value.trim();

  $("baseUrl").classList.toggle("invalid", !baseUrl);
  if (!baseUrl) {
    setStatus(saveStatus, "Enter the server URL.", "error");
    return;
  }
  if (!$("voice1").value) {
    $("voice1").classList.add("invalid");
    setStatus(saveStatus, "Choose at least Voice 1. Use “Reload voices” if the list is empty.", "error");
    return;
  }

  const accessRequest = requestServerAccess(baseUrl); // synchronous with the click
  const settings = readForm();
  await saveSettings(settings);
  const granted = await accessRequest;
  updateAccessNotice();
  const shortcutError = await applyShortcut();
  if (shortcutError) {
    setStatus(saveStatus, "Saved, but " + shortcutError.charAt(0).toLowerCase() + shortcutError.slice(1), "error");
  } else if (granted) {
    setStatus(saveStatus, "Saved.", "ok");
  } else {
    setStatus(saveStatus, "Saved, but access to the server was not granted; playback may fail.", "error");
  }
}

// -- keyboard shortcut ------------------------------------------------------- //
/* The shortcut lives in Firefox's command registry, not in storage, so it stays in
 * sync with about:addons → Manage Extension Shortcuts. Edits apply on Save. */
/* Firefox lets extensions change their shortcuts (commands.update); Chromium
 * browsers only allow it on their own shortcuts page. */
const canEditShortcut = typeof browser.commands.update === "function";
let isMac = false;
let appliedShortcut = "";
let pendingShortcut = "";

function defaultShortcut() {
  const command = (browser.runtime.getManifest().commands || {})[READ_COMMAND];
  return (command && command.suggested_key && command.suggested_key.default) || "";
}

function showShortcut(value) {
  pendingShortcut = value;
  const input = $("shortcut");
  input.value = value;
  input.classList.remove("recording");
}

async function loadShortcut() {
  const commands = await browser.commands.getAll();
  const command = commands.find((c) => c.name === READ_COMMAND);
  appliedShortcut = (command && command.shortcut) || "";
  showShortcut(appliedShortcut);
}

function onShortcutKeyDown(event) {
  const noModifiers = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
  if (event.key === "Tab" && noModifiers) return; // keep keyboard navigation working
  event.preventDefault();
  event.stopPropagation();
  const input = $("shortcut");
  if (event.key === "Escape" && noModifiers) {
    showShortcut(pendingShortcut);
    input.blur();
    return;
  }
  if (event.key === "Backspace" && noModifiers) {
    showShortcut("");
    setStatus($("saveStatus"), "Shortcut cleared. Click Save to apply.");
    return;
  }
  const result = shortcutFromEvent(event, isMac);
  if (result.shortcut) {
    showShortcut(result.shortcut);
    setStatus($("saveStatus"), "Click Save to apply the new shortcut.");
  } else if (result.error) {
    input.value = pendingShortcut;
    input.classList.remove("recording");
    setStatus($("saveStatus"), result.error, "error");
  } else {
    input.value = result.partial || "";
    input.classList.add("recording");
  }
}

function onShortcutKeyUp() {
  // Releasing modifiers without completing a combination restores the last value.
  const input = $("shortcut");
  if (input.classList.contains("recording")) showShortcut(pendingShortcut);
}

/** Apply the edited shortcut; returns an error message or "". */
async function applyShortcut() {
  if (!canEditShortcut || pendingShortcut === appliedShortcut) return "";
  try {
    await browser.commands.update({ name: READ_COMMAND, shortcut: pendingShortcut });
    appliedShortcut = pendingShortcut;
    return "";
  } catch (err) {
    return "Shortcut not applied: " + (err && err.message ? err.message : err);
  }
}

function onReloadClicked() {
  const accessRequest = requestServerAccess($("baseUrl").value); // synchronous with the click
  accessRequest.then(fetchVoices);
}

async function init() {
  fillForm(await loadSettings());
  voiceBoxes.forEach((box) => box.addEventListener("change", updateVoiceString));
  updateModelDependent();
  $("model").addEventListener("change", updateModelDependent);
  $("apiKeyToggle").addEventListener("click", () => {
    const input = $("apiKey");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("apiKeyToggle").textContent = show ? "Hide" : "Show";
  });
  $("reloadVoices").addEventListener("click", onReloadClicked);
  $("form").addEventListener("submit", onSubmit);
  $("baseUrl").addEventListener("input", () => {
    setStatus($("saveStatus"), "");
    updateAccessNotice();
  });
  $("grantAccess").addEventListener("click", onGrantClicked);
  browser.permissions.onAdded.addListener(updateAccessNotice);
  browser.permissions.onRemoved.addListener(updateAccessNotice);
  updateAccessNotice();

  isMac = (await browser.runtime.getPlatformInfo()).os === "mac";
  const shortcutInput = $("shortcut");
  if (canEditShortcut) {
    shortcutInput.addEventListener("keydown", onShortcutKeyDown);
    shortcutInput.addEventListener("keyup", onShortcutKeyUp);
    shortcutInput.addEventListener("blur", onShortcutKeyUp);
  } else {
    $("shortcutEditButtons").hidden = true;
    $("shortcutBrowserButtons").hidden = false;
    shortcutInput.tabIndex = -1;
    shortcutInput.style.cursor = "default";
    $("shortcutHint").textContent =
      "This browser only lets you change extension shortcuts on its own shortcuts page. " +
      "Works in any tab while a browser window is focused.";
    $("shortcutOpenSettings").addEventListener("click", () => {
      // Chromium-based browsers redirect chrome:// to their own scheme (edge://, brave://…).
      browser.tabs.create({ url: "chrome://extensions/shortcuts" });
    });
    // Show the new shortcut when the user comes back from the browser's page.
    window.addEventListener("focus", () => loadShortcut());
  }
  $("keepPlayerOpen").addEventListener("change", updateLoopEnabled);
  $("shortcutClear").addEventListener("click", () => {
    showShortcut("");
    setStatus($("saveStatus"), "Shortcut cleared. Click Save to apply.");
  });
  $("shortcutReset").addEventListener("click", () => {
    showShortcut(defaultShortcut());
    setStatus($("saveStatus"), "Click Save to apply the default shortcut.");
  });
  await loadShortcut();

  for (const id of ["customPlayerColors", "playerBackground", "playerForeground"]) {
    $(id).addEventListener("input", updateColorPreview);
    $(id).addEventListener("change", updateColorPreview);
  }
  $("colorsReset").addEventListener("click", () => {
    $("playerBackground").value = DEFAULT_SETTINGS.playerBackground;
    $("playerForeground").value = DEFAULT_SETTINGS.playerForeground;
    updateColorPreview();
  });

  fetchVoices();
}

init();
