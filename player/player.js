/* Player (side panel or popup window): owns the speech request, the PCM buffer (in
 * an AudioWorklet) and the playback controls. One player, reused for every new
 * selection; side panels in other browser windows stop when a new one starts. */

"use strict";

const PLAYER_INNER_WIDTH = 400;
const RESUME_WAIT_MS = 500;

const ui = {
  main: document.getElementById("player"),
  playPause: document.getElementById("playPause"),
  playLabel: document.getElementById("playLabel"),
  stop: document.getElementById("stop"),
  save: document.getElementById("save"),
  seek: document.getElementById("seek"),
  state: document.getElementById("state"),
  time: document.getElementById("time"),
  error: document.getElementById("error"),
};

let settings = { ...DEFAULT_SETTINGS };
let ctx = null; // AudioContext, reused across sessions while the sample rate matches
let ctxPromise = null;
let ctxRate = 0;
let needsGesture = false; // AudioContext is suspended until the user clicks Play
let session = null;
let dragging = false;
let widthFitted = false;
let saving = false; // Save in progress: playback is held and new selections are ignored

/* Where this player is shown. A side panel belongs to a normal browser window; the
 * popup is a window of its own. */
const placement = browser.windows.getCurrent().then(
  (win) => ({ panel: win.type !== "popup", windowId: win.id }),
  () => ({ panel: false, windowId: null })
);

// -- audio context ----------------------------------------------------------- //
function ensureContext(rate) {
  if (ctxPromise && ctxRate === rate) return ctxPromise;
  const previous = ctxPromise;
  ctxRate = rate;
  ctxPromise = (async () => {
    if (previous) {
      try {
        await (await previous).close();
      } catch (_) {
        /* already closed or never opened */
      }
    }
    const context = new AudioContext({ sampleRate: rate, latencyHint: "playback" });
    context.onstatechange = () => {
      if (context === ctx && context.state === "running" && needsGesture) {
        needsGesture = false;
        render();
      }
    };
    await context.audioWorklet.addModule("pcm-worklet.js");
    return context;
  })();
  ctxPromise.catch(() => {
    ctxPromise = null;
    ctxRate = 0;
  });
  return ctxPromise;
}

async function tryResume() {
  if (!ctx) return;
  if (ctx.state !== "running") {
    // resume() can stay pending until a user gesture, so don't wait on it forever.
    const timeout = new Promise((resolve) => setTimeout(resolve, RESUME_WAIT_MS));
    try {
      await Promise.race([ctx.resume(), timeout]);
    } catch (_) {
      /* reported through ctx.state below */
    }
  }
  needsGesture = ctx.state !== "running";
}

// -- sessions ---------------------------------------------------------------- //
function teardown() {
  const s = session;
  if (!s) return;
  session = null;
  clearTimeout(s.closeTimer);
  s.controller.abort();
  if (s.node) {
    s.node.port.onmessage = null;
    s.node.port.postMessage({ type: "dispose" });
    s.node.disconnect();
  }
}

async function startSession({ id, text }) {
  if (session && session.id === id) return;
  teardown();
  const s = {
    id,
    node: null,
    controller: new AbortController(),
    state: null, // last report from the worklet
    received: 0, // frames sent to the worklet
    rate: 0, // PCM sample rate
    pcm: [], // received PCM (Uint8Array chunks, whole samples), kept for saving
    carry: null, // odd trailing byte of a network chunk
    complete: false,
    warning: "",
    error: "",
    finishHandled: false,
    closeTimer: null,
  };
  session = s; // set synchronously so duplicate start requests are ignored
  dragging = false;
  showError("");
  render();

  try {
    settings = await loadSettings();
    applyPlayerColors(document.documentElement, settings);
    if (session !== s) return;
    s.rate = settings.sampleRate;
    ctx = await ensureContext(s.rate);
    if (session !== s) return;
    const prebufferFrames = Math.round((ctx.sampleRate * settings.prebufferMs) / 1000);
    s.node = new AudioWorkletNode(ctx, "pcm-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { prebufferFrames, loop: loopEnabled() },
    });
  } catch (err) {
    if (session === s) fail(s, "Could not open audio output: " + (err && err.message ? err.message : err));
    return;
  }
  s.node.port.onmessage = (event) => {
    if (session === s && event.data && event.data.type === "state") {
      s.state = event.data;
      onWorkletState(s);
    }
  };
  s.node.connect(ctx.destination);

  await tryResume();
  if (session !== s) return;
  render();
  streamSpeech(s, text);
}

/** "Loop playback after end" only applies while the player stays open. */
function loopEnabled() {
  return Boolean(settings.keepPlayerOpen && settings.loopPlayback);
}

function fail(s, message) {
  s.error = message;
  s.controller.abort();
  clearTimeout(s.closeTimer);
  if (s.node) s.node.port.postMessage({ type: "pause", paused: true });
  showError(message);
  render();
}

function onWorkletState(s) {
  const st = s.state;
  if (st.finished && !s.finishHandled) {
    s.finishHandled = true;
    if (st.len === 0) {
      fail(s, "The server returned no audio.");
      return;
    }
    if (!settings.keepPlayerOpen && !saving) {
      // Give the output device time to play the last block before closing.
      const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
      s.closeTimer = setTimeout(closeWindow, Math.round(latency * 1000) + 200);
    }
  } else if (!st.finished) {
    s.finishHandled = false;
  }
  render();
}

// -- network ----------------------------------------------------------------- //
function feed(s, chunk) {
  let bytes = chunk;
  if (s.carry !== null) {
    bytes = new Uint8Array(chunk.length + 1);
    bytes[0] = s.carry;
    bytes.set(chunk, 1);
    s.carry = null;
  }
  const usable = bytes.length - (bytes.length % 2);
  if (usable < bytes.length) s.carry = bytes[bytes.length - 1];
  if (usable === 0) return;
  s.pcm.push(bytes.subarray(0, usable));

  // Signed 16-bit little-endian mono -> Float32 in [-1, 1).
  const frames = usable / 2;
  const samples = new Float32Array(frames);
  const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
  for (let i = 0; i < frames; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  s.received += frames;
  s.node.port.postMessage({ type: "feed", samples }, [samples.buffer]);
}

async function streamSpeech(s, text) {
  const payload = buildSpeechPayload(settings, text);

  let timer = null;
  let timedOut = false;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      s.controller.abort();
    }, REQUEST_INACTIVITY_TIMEOUT_MS);
  };

  arm();
  try {
    const response = await fetch(apiUrl(settings.baseUrl, "/v1/audio/speech"), {
      method: "POST",
      headers: apiHeaders(settings, { "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
      signal: s.controller.signal,
    });
    if (session !== s) return;
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (session === s) fail(s, describeHttpError(response.status, body));
      return;
    }
    if (!response.body) {
      fail(s, "The server response has no body.");
      return;
    }
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (session !== s) return;
      if (done) break;
      arm();
      if (value && value.length) feed(s, value);
      if (!s.state) render(); // the worklet doesn't report while the context is suspended
    }
  } catch (err) {
    if (session !== s) return; // aborted because a new session started or the window closed
    if (s.received === 0) {
      fail(s, timedOut ? `The server sent nothing for ${REQUEST_INACTIVITY_TIMEOUT_MS / 1000} s.` : unreachableMessage(err));
      return;
    }
    s.warning = timedOut ? "Server stalled; playing what was received" : "Connection lost; playing what was received";
  } finally {
    clearTimeout(timer);
  }

  if (session !== s || s.error) return;
  s.complete = true;
  s.node.port.postMessage({ type: "complete" });
  render();
}

function unreachableMessage(err) {
  const detail = err && err.message ? ` (${err.message})` : "";
  return (
    `Could not reach the server at ${normalizeBaseUrl(settings.baseUrl)}${detail}. ` +
    "Check that it is running, that the URL in Settings is right, and that Kokoro Reader " +
    "is allowed to access it (save Settings again to grant access)."
  );
}

// -- controls ---------------------------------------------------------------- //
async function onPlayPause() {
  const s = session;
  if (!s || !s.node || s.error || !ctx || saving) return;

  if (ctx.state !== "running") {
    try {
      await ctx.resume(); // this click is the user gesture autoplay was waiting for
    } catch (_) {
      /* reported below */
    }
    const wasWaiting = needsGesture;
    needsGesture = ctx.state !== "running";
    if (needsGesture || session !== s) {
      render();
      return;
    }
    if (wasWaiting && !(s.state && (s.state.paused || s.state.finished))) {
      render(); // playback starts now; nothing to toggle
      return;
    }
  }

  const st = s.state;
  const shouldPlay = !st || st.paused || st.finished;
  s.node.port.postMessage(shouldPlay ? { type: "play" } : { type: "pause", paused: true });
  if (st) st.paused = !shouldPlay; // optimistic until the next report
  render();
}

function scrub(direction) {
  const s = session;
  if (s && s.node && !s.error && !saving) {
    s.node.port.postMessage({ type: "seekBy", seconds: direction * settings.scrubStepS });
  }
}

/* windows.remove is reliable for extension-created popups; window.close() is the fallback.
 * In a side panel the current window is the user's browser window, which must be left
 * alone; window.close() closes the panel instead. */
function closeWindow() {
  browser.windows
    .getCurrent()
    .then((win) => (win.type === "popup" ? browser.windows.remove(win.id) : window.close()))
    .catch(() => window.close());
}

function stop() {
  teardown();
  closeWindow();
}

// -- saving ------------------------------------------------------------------ //
function canSave(s) {
  return Boolean(s && s.node && !s.error && s.complete && s.pcm.length);
}

/* Playback pauses while the save dialog is open and resumes afterwards if it was
 * playing. The format comes from Settings; the download dialog only picks where. */
async function onSave() {
  const s = session;
  if (!canSave(s) || saving) return;
  // Synchronous with the click: Firefox only shows permission prompts in response
  // to user input. Resolves at once without a prompt when already granted.
  const access = browser.permissions.request({ permissions: ["downloads"] }).catch(() => false);

  const st = s.state;
  const wasPlaying = Boolean(st && !st.paused && !st.finished && !needsGesture);
  if (wasPlaying) {
    s.node.port.postMessage({ type: "pause", paused: true });
    st.paused = true; // optimistic until the next report
  }
  saving = true;
  clearTimeout(s.closeTimer);
  showError("");
  render();

  let done = false; // saved, or the user cancelled
  try {
    if (!(await access)) throw new Error("Kokoro Reader needs permission to download files. Click Save again and allow it.");
    if (s.warning && !window.confirm(`${s.warning.split(";")[0]}, so the audio is incomplete. Save what was received?`)) {
      done = true;
      return;
    }
    const { blob, extension } = await encodeAudio(s.pcm, s.rate, settings.saveFormat);
    if (session !== s) return;
    await downloadBlob(blob, `${saveFileStem()}.${extension}`);
    done = true;
  } catch (err) {
    if (session === s) showError("Could not save the audio: " + (err && err.message ? err.message : err));
  } finally {
    saving = false;
    if (session === s) {
      if (wasPlaying) {
        s.node.port.postMessage({ type: "play" });
        if (s.state) s.state.paused = false;
      } else if (done && s.state && s.state.finished && !settings.keepPlayerOpen) {
        closeWindow(); // playback had ended, so the window would have closed already
      }
      render();
    }
  }
}

/** kokoro-YYYY-MM-DD-HHMMSS in local time. */
function saveFileStem() {
  const now = new Date();
  const two = (n) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  return `kokoro-${date}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

/* Download a Blob through the browser's "Save as" dialog. Resolves once the dialog
 * has closed, whether a file was chosen or not. */
async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const options = { url, filename, saveAs: true };
  // Firefox for Android has no "Save as" dialog; it saves to the download folder.
  if ((await browser.runtime.getPlatformInfo()).os === "android") delete options.saveAs;
  let id;
  try {
    id = await browser.downloads.download(options);
  } catch (err) {
    URL.revokeObjectURL(url);
    if (/cancel/i.test(String(err && err.message))) return; // dialog dismissed (Firefox)
    throw err;
  }
  await watchDownload(id, url);
}

/* Firefox resolves downloads.download() after the dialog closes; Chrome resolves
 * straight away and asks for the file name afterwards, so wait until the download
 * has a file name (chosen) or is interrupted (cancelled). The object URL is released
 * once the browser is done reading it. */
function watchDownload(id, url) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const cleanup = () => {
      browser.downloads.onChanged.removeListener(onChanged);
      browser.downloads.onErased.removeListener(onErased);
      URL.revokeObjectURL(url);
      settle();
    };
    const check = (items) => {
      const item = items && items[0];
      if (!item) return;
      if (item.filename || item.state !== "in_progress") settle();
      if (item.state !== "in_progress") cleanup();
    };
    const onChanged = (delta) => {
      if (delta.id === id) browser.downloads.search({ id }).then(check, cleanup);
    };
    const onErased = (erasedId) => {
      if (erasedId === id) cleanup();
    };
    browser.downloads.onChanged.addListener(onChanged);
    browser.downloads.onErased.addListener(onErased);
    browser.downloads.search({ id }).then(check, cleanup);
  });
}

ui.playPause.addEventListener("click", onPlayPause);
ui.stop.addEventListener("click", stop);
ui.save.addEventListener("click", onSave);

ui.seek.addEventListener("pointerdown", () => {
  dragging = true;
});
const endDrag = () => {
  dragging = false;
};
ui.seek.addEventListener("pointerup", endDrag);
ui.seek.addEventListener("pointercancel", endDrag);
ui.seek.addEventListener("input", render); // show the time under the handle while dragging
ui.seek.addEventListener("change", () => {
  dragging = false;
  const s = session;
  if (s && s.node && !s.error) {
    s.node.port.postMessage({ type: "seek", seconds: Number(ui.seek.value) / 1000 });
  }
});

document.addEventListener(
  "keydown",
  (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        stop();
        break;
      case "ArrowLeft":
      case "ArrowRight":
        event.preventDefault();
        scrub(event.key === "ArrowLeft" ? -1 : 1);
        break;
      case " ":
        if (event.target instanceof HTMLButtonElement) return; // the button handles Space itself
        event.preventDefault();
        onPlayPause();
        break;
      default:
        break;
    }
  },
  true
);

// -- rendering --------------------------------------------------------------- //
function showError(message) {
  const visible = Boolean(message);
  const changed = ui.error.hidden === visible;
  ui.error.textContent = message;
  ui.error.hidden = !visible;
  if (changed) fitWindow();
}

function render() {
  const s = session;
  const rate = ctx ? ctx.sampleRate : settings.sampleRate;
  let stateText;
  let stateClass = "";
  let pos = 0;
  let len = 0;
  let playing = false;
  let label = "Play";

  if (!s) {
    stateText = "Nothing to read.";
  } else if (s.error) {
    stateText = "Request failed.";
    stateClass = "error";
  } else {
    const st = s.state;
    pos = st ? st.pos : 0;
    len = st ? st.len : s.received;
    if (needsGesture) {
      stateText = "Click Play to start";
    } else if (st && st.finished) {
      stateText = "Finished";
    } else if (st && st.paused) {
      stateText = "Paused";
      label = "Resume";
    } else if (len === 0 && !s.complete) {
      stateText = "Waiting for server…";
      playing = true;
    } else if (!st || !st.primed) {
      stateText = "Buffering…";
      playing = true;
    } else {
      stateText = "Playing";
      playing = true;
    }
    if (playing) label = "Pause";
    if (saving) stateText = "Saving…";
    if (!s.complete) stateText += " (receiving)";
    if (s.warning) {
      stateText += " · ⚠ " + s.warning;
      stateClass = "warn";
    }
  }

  const ready = Boolean(s && s.node && !s.error);
  ui.playPause.disabled = !ready || saving;
  ui.playPause.classList.toggle("playing", playing && ready);
  ui.playLabel.textContent = label;
  ui.seek.disabled = !ready || len === 0 || saving;
  ui.save.disabled = !canSave(s) || saving;

  const totalMs = Math.round((len / rate) * 1000);
  if (!dragging) {
    ui.seek.max = String(totalMs);
    ui.seek.value = String(Math.round((pos / rate) * 1000));
  }
  const shownPos = dragging ? Number(ui.seek.value) / 1000 : pos / rate;

  ui.state.textContent = stateText;
  ui.state.title = stateText;
  ui.state.className = "state" + (stateClass ? " " + stateClass : "");
  ui.time.textContent = `${fmtTime(shownPos)} / ${fmtTime(len / rate)}`;
}

/* Popup sizes passed to windows.create include the window frame and Firefox's
 * minimal toolbar, which vary by platform, so measure and correct once loaded. */
async function fitWindow() {
  try {
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    if (!window.outerHeight || !window.innerHeight) return;
    const win = await browser.windows.getCurrent();
    if (win.type !== "popup") return; // side panel: the browser window isn't ours to resize
    if (win.state !== "normal") return; // leave maximized/fullscreen windows (or WM rules) alone
    const chromeHeight = window.outerHeight - window.innerHeight;
    const chromeWidth = window.outerWidth - window.innerWidth;
    const update = {};
    const height = Math.ceil(ui.main.getBoundingClientRect().height) + chromeHeight;
    if (Math.abs(height - window.outerHeight) > 2) update.height = height;
    if (!widthFitted) {
      widthFitted = true;
      const width = PLAYER_INNER_WIDTH + chromeWidth;
      if (Math.abs(width - window.outerWidth) > 2) update.width = width;
    }
    if (Object.keys(update).length) await browser.windows.update(win.id, update);
  } catch (err) {
    console.debug("Kokoro Reader: could not resize the player window:", err);
  }
}

// -- startup ----------------------------------------------------------------- //
/* Sessions read in panel mode name the browser window whose panel plays them; window
 * mode sessions name none. A player the session isn't meant for stops, so only one
 * plays at a time. A session without text means the menu or shortcut found nothing to
 * read: the panel it opened closes again unless it is already playing something. */
async function onSession(next) {
  // A selection read while the save dialog is open is dropped rather than queued.
  if (!next || !next.id || saving || (session && session.id === next.id)) return;
  const here = await placement;
  const target = typeof next.windowId === "number" ? next.windowId : null;
  const mine = here.panel ? target === here.windowId : target === null;
  if (!mine) {
    if (next.text && session) {
      teardown();
      render();
      if (!settings.keepPlayerOpen) closeWindow();
    }
    return;
  }
  // The player has taken the session, so a panel opened later doesn't replay it.
  browser.storage.session.get("currentSession").then(({ currentSession }) => {
    if (currentSession && currentSession.id === next.id) browser.storage.session.remove("currentSession");
  });
  if (!next.text) {
    if (!session && Date.now() - (next.at || 0) < PANEL_DISMISS_MAX_AGE_MS) closeWindow();
    return;
  }
  // Chrome focuses a panel it opens. Firefox leaves focus in the page and currently
  // ignores focus() from the sidebar, element.focus() included; this is kept in case
  // that changes. Until then the panel needs a click for its keys.
  if (here.panel) window.focus();
  startSession(next);
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.currentSession) onSession(changes.currentSession.newValue);
});

// Settings saved while the player is open apply straight away where they can.
browser.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  const fresh = await loadSettings();
  applyPlayerColors(document.documentElement, fresh);
  // Playback behaviour, the save format and colors update live; server and voice settings are
  // read again when the next selection starts.
  settings = {
    ...settings,
    keepPlayerOpen: fresh.keepPlayerOpen,
    loopPlayback: fresh.loopPlayback,
    scrubStepS: fresh.scrubStepS,
    saveFormat: fresh.saveFormat,
    customPlayerColors: fresh.customPlayerColors,
    playerBackground: fresh.playerBackground,
    playerForeground: fresh.playerForeground,
  };
  if (session && session.node) session.node.port.postMessage({ type: "loop", enabled: loopEnabled() });
});

window.addEventListener("pagehide", teardown);

(async () => {
  // The page starts hidden (class "loading") so it doesn't flash the default theme
  // before the custom colors are applied.
  try {
    settings = await loadSettings();
    applyPlayerColors(document.documentElement, settings);
  } catch (_) {
    /* fall back to the stylesheet's theme */
  }
  document.documentElement.classList.remove("loading");
  render();
  fitWindow();
  const { currentSession } = await browser.storage.session.get("currentSession");
  await onSession(currentSession);
})();
