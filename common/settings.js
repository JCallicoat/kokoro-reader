/* Shared settings and helpers (port of AppSettings and the helper functions in
 * kokoro_clip_reader.py). Loaded as a classic script by the background page,
 * the options page and the player window, so everything here is a global. */

"use strict";

/* Chromium browsers before Chrome 148 expose the promise-based APIs only as
 * `chrome`; Firefox (and newer Chrome) also provide `browser`. */
if (typeof globalThis.browser === "undefined" && typeof globalThis.chrome !== "undefined") {
  globalThis.browser = globalThis.chrome;
}

/** Models offered in Settings. Kokoro-FastAPI accepts all three; OpenAI's API
 * accepts the tts-1 models. */
const MODEL_OPTIONS = Object.freeze(["kokoro", "tts-1", "tts-1-hd"]);

/** Placeholder API key: Kokoro-FastAPI ignores the Authorization header. */
const DEFAULT_API_KEY = "change-this-only-if-using-openai-server";

/** OpenAI has no voice-list endpoint; these are the voices tts-1/tts-1-hd support. */
const OPENAI_TTS1_VOICES = Object.freeze([
  "alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer",
]);

const DEFAULT_SETTINGS = Object.freeze({
  baseUrl: "http://localhost:8880",
  model: "kokoro",
  apiKey: DEFAULT_API_KEY,
  voices: ["", "", ""],
  speed: 1.0,
  volumeMultiplier: 1.0,
  keepPlayerOpen: false,
  sampleRate: 24000,
  prebufferMs: 400,
  scrubStepS: 5,
  deselectOnPlay: false,
  loopPlayback: false,
  customPlayerColors: false,
  playerBackground: "#1c1b22",
  playerForeground: "#fbfbfe",
});

/** Fixed player window title, for window-manager matching rules (KWin etc.). */
const PLAYER_WINDOW_TITLE = "Kokoro Reader Player";

/** Keyboard shortcut command name (see "commands" in manifest.json). */
const READ_COMMAND = "read-selection";

/** Inactivity timeout for the speech request (no bytes received for this long). */
const REQUEST_INACTIVITY_TIMEOUT_MS = 120000;

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function loadSettings() {
  const stored = await browser.storage.local.get(DEFAULT_SETTINGS);
  const d = DEFAULT_SETTINGS;
  const voices = Array.isArray(stored.voices) ? stored.voices.slice(0, 3) : [];
  while (voices.length < 3) voices.push("");
  return {
    baseUrl: String(stored.baseUrl || d.baseUrl),
    model: MODEL_OPTIONS.includes(stored.model) ? stored.model : d.model,
    apiKey: typeof stored.apiKey === "string" ? stored.apiKey.trim() : d.apiKey,
    voices: voices.map((v) => (typeof v === "string" ? v : "")),
    speed: clampNumber(stored.speed, 0.25, 4.0, d.speed),
    volumeMultiplier: clampNumber(stored.volumeMultiplier, 0.1, 20.0, d.volumeMultiplier),
    keepPlayerOpen: Boolean(stored.keepPlayerOpen),
    loopPlayback: Boolean(stored.loopPlayback),
    sampleRate: Math.round(clampNumber(stored.sampleRate, 8000, 96000, d.sampleRate)),
    prebufferMs: Math.round(clampNumber(stored.prebufferMs, 0, 5000, d.prebufferMs)),
    scrubStepS: Math.round(clampNumber(stored.scrubStepS, 1, 120, d.scrubStepS)),
    deselectOnPlay: Boolean(stored.deselectOnPlay),
    customPlayerColors: Boolean(stored.customPlayerColors),
    playerBackground: normalizeHexColor(stored.playerBackground, d.playerBackground),
    playerForeground: normalizeHexColor(stored.playerForeground, d.playerForeground),
  };
}

function normalizeHexColor(value, fallback) {
  const text = String(value || "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : fallback;
}

/** Relative luminance (WCAG) of a #rrggbb color, 0 (black) to 1 (white). */
function colorLuminance(hex) {
  const channel = (i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

const PLAYER_COLOR_VARS = ["--bg", "--fg", "--muted", "--border", "--button", "--accent", "--error", "--warn"];

/* Apply the player colors to an element (the player's <html>, or the preview in
 * Settings). With custom colors off, the stylesheet's light/dark theme is used.
 * Secondary colors are mixed from the chosen pair so the window stays consistent,
 * and accent/error/warning colors follow whether the background is dark or light. */
function applyPlayerColors(element, settings) {
  const style = element.style;
  if (!settings.customPlayerColors) {
    for (const name of PLAYER_COLOR_VARS) style.removeProperty(name);
    style.removeProperty("color-scheme");
    return;
  }
  const bg = settings.playerBackground;
  const fg = settings.playerForeground;
  const dark = colorLuminance(bg) < 0.25;
  style.setProperty("--bg", bg);
  style.setProperty("--fg", fg);
  style.setProperty("--muted", `color-mix(in srgb, ${fg} 65%, ${bg})`);
  style.setProperty("--border", `color-mix(in srgb, ${fg} 25%, ${bg})`);
  style.setProperty("--button", `color-mix(in srgb, ${fg} 8%, ${bg})`);
  style.setProperty("--accent", dark ? "#7b93f5" : "#3b5bdb");
  style.setProperty("--error", dark ? "#ff8787" : "#c92a2a");
  style.setProperty("--warn", dark ? "#ffc078" : "#b35c00");
  style.setProperty("color-scheme", dark ? "dark" : "light"); // native controls (slider) follow
}

async function saveSettings(settings) {
  await browser.storage.local.set(settings);
}

/** Headers for every API request; OpenAI expects "Authorization: Bearer <key>". */
function apiHeaders(settings, extra = {}) {
  const headers = { ...extra };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  return headers;
}

/* Body for POST /v1/audio/speech. The OpenAI fields are always sent; the
 * Kokoro-FastAPI extensions (voice mixing, volume_multiplier, stream) only with
 * the kokoro model, so requests to OpenAI's API contain only what it documents.
 * PCM is 24 kHz signed 16-bit little-endian mono on both servers. */
function buildSpeechPayload(settings, text) {
  const payload = {
    model: settings.model,
    input: text,
    voice: effectiveVoice(settings),
    response_format: "pcm",
    speed: settings.speed,
  };
  if (settings.model === "kokoro") {
    payload.volume_multiplier = settings.volumeMultiplier;
    payload.stream = true;
  }
  return payload;
}

/** Voice mixing ("a+b") is a Kokoro-FastAPI feature; other models get Voice 1 only. */
function effectiveVoice(settings) {
  return settings.model === "kokoro" ? voiceString(settings.voices) : settings.voices[0] || "";
}

function voiceString(voices) {
  return voices.filter((v) => v).join("+");
}

function normalizeBaseUrl(baseUrl) {
  let base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base.includes("://")) base = "http://" + base;
  return base;
}

function apiUrl(baseUrl, path) {
  return normalizeBaseUrl(baseUrl) + path;
}

/** Match pattern covering the server origin (match patterns ignore the port). */
function hostPermissionPattern(baseUrl) {
  const url = new URL(normalizeBaseUrl(baseUrl));
  return `${url.protocol}//${url.hostname}/*`;
}

function fmtTime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

/** Accept {"voices": [...]} or a bare list; items may be strings or objects. */
function extractVoiceNames(payload) {
  const items =
    payload && !Array.isArray(payload) && typeof payload === "object"
      ? payload.voices || []
      : payload;
  if (!Array.isArray(items)) throw new TypeError("Unexpected voices payload");
  const names = new Set();
  for (const item of items) {
    if (typeof item === "string") {
      names.add(item);
    } else if (item && typeof item === "object") {
      const name = item.id || item.name || item.voice_id;
      if (name) names.add(String(name));
    }
  }
  return [...names].sort();
}

function describeHttpError(status, bodyText) {
  let detail = String(bodyText || "").trim();
  try {
    const data = JSON.parse(detail);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const inner = data.detail ?? data.error ?? data;
      // OpenAI wraps errors as {"error": {"message": ...}}.
      const message = inner && typeof inner === "object" && typeof inner.message === "string" ? inner.message : null;
      detail = typeof inner === "string" ? inner : message || JSON.stringify(inner);
    }
  } catch (_) {
    /* not JSON; keep the raw text */
  }
  return detail ? `HTTP ${status}: ${detail.slice(0, 500)}` : `HTTP ${status}`;
}
