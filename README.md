# Kokoro Reader (Firefox and Chromium extension)

Right-click selected text and choose **Read selection aloud**. The text is sent to a
Kokoro-FastAPI server, or another server with the OpenAI text-to-speech API
(`POST /v1/audio/speech`, raw PCM, streamed), buffered in memory and played in a
small player window with Play/Pause, Stop and a seek slider.

Source, issues and releases: <https://github.com/JCallicoat/kokoro-reader>

One package works in both browser families:

- **Firefox** 140 or later (desktop)
- **Chrome** 121 or later, and Chromium-based browsers such as Edge, Brave, Vivaldi
  and Opera

## Install

### Firefox

- **Signed build:** about:addons → gear menu → **Install Add-on From File…** and pick
  the signed `.xpi` (see `SIGNING.md`).
- **For testing:** open `about:debugging#/runtime/this-firefox`, click
  **Load Temporary Add-on…** and pick `manifest.json` in this folder (or the zip).
  Temporary add-ons are removed when Firefox restarts.

### Chrome and other Chromium browsers

- **From the Chrome Web Store**, once published (see `SIGNING.md`).
- **For testing:** unzip the package, open `chrome://extensions`, turn on
  **Developer mode**, click **Load unpacked** and pick the folder containing
  `manifest.json`. Unpacked extensions stay installed across restarts. An unpacked
  copy has a different extension ID from the store version, so its settings don't
  carry over.

### First run

Click the Kokoro Reader icon (toolbar, Firefox's Extensions menu or Chrome's puzzle
menu) to open Settings. Set the server URL and model, click **Reload voices**, pick at
least Voice 1 and click **Save**. Access to `localhost` and `127.0.0.1` is granted by
default. For any other server, Settings shows an **Allow access** notice; allow it,
or requests will fail.

Settings are kept for as long as the extension stays installed under the same ID
(`kokoro-reader@jcallicoat` in Firefox; the store-assigned ID in Chrome).

## Servers, models and API key

The extension talks to any server with the OpenAI text-to-speech API
(`POST /v1/audio/speech`). It was built for
[Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI), and also works with
OpenAI's own API.

| Setting | Kokoro-FastAPI | OpenAI |
| --- | --- | --- |
| Server URL | e.g. `http://localhost:8880` | `https://api.openai.com` |
| Model | `kokoro` (recommended) | `tts-1` or `tts-1-hd` |
| API key | Leave the placeholder; it's ignored | Your OpenAI API key |
| Voices | Loaded from the server | Standard OpenAI voices (alloy, ash, coral, echo, fable, nova, onyx, sage, shimmer) |

- **API key.** Sent as `Authorization: Bearer <key>`, the way OpenAI's API expects
  it. The default `change-this-only-if-using-openai-server` is a placeholder that
  Kokoro-FastAPI ignores. Clearing the field sends no header. The key is stored
  unencrypted in the extension's local storage, like the other settings.
- **Model.** With `kokoro`, requests include the Kokoro-FastAPI extras: voice mixing
  (Voice 2 and 3), `volume_multiplier` and `stream`. With `tts-1` or `tts-1-hd`, only
  the parameters OpenAI documents are sent (model, input, voice, response format,
  speed), so Voice 2/3 and the volume multiplier are disabled in Settings and only
  Voice 1 is used.
- **Voices.** OpenAI has no voice-list endpoint, so when **Reload voices** gets a
  404 from the server, Settings offers the standard OpenAI voices instead.
- **Audio format.** Both servers return PCM as 24 kHz, 16-bit signed little-endian
  mono, which matches the default sample rate under Advanced settings.
- **Access.** For a server other than localhost, such as `api.openai.com`, click
  **Allow access** in Settings when asked.
- **Limits.** OpenAI rejects input longer than 4096 characters; the player shows the
  server's error message.

## Keyboard shortcut

**Alt+Shift+R** reads the current selection, the same as the context-menu item. It
works in any tab while a browser window is focused. If nothing is selected, the
toolbar icon briefly shows a "?" badge.

- **Firefox:** change or clear it under **Keyboard shortcut** in Settings (click the
  box, press the keys, then Save), or in about:addons → gear menu → Manage Extension
  Shortcuts; both edit the same setting.
- **Chrome and other Chromium browsers:** extensions can't change their own
  shortcuts there, so Settings shows the current shortcut and a
  **Change in browser settings…** button that opens `chrome://extensions/shortcuts`.

## Player

- **Play/Pause** (Space), **Stop** (Esc) — Stop always closes the window.
- **Seek slider** — click or drag within the audio received so far.
- **Left/Right arrow** — scrub by the step set in Advanced settings.
- Choosing *Read selection aloud* while the player is open replaces the current audio
  in the same window.
- When playback finishes the window closes, unless **Keep player open after playback**
  is ticked; then Play replays from the start.
- **Loop playback after end** (only available with *Keep player open* ticked, off by
  default) starts the audio again from the beginning each time it reaches the end.
- **Deselect text when playback starts** (under Advanced settings, off by default)
  clears the highlighted selection on the page once its text has been handed to the
  player, whether you used the menu item or the keyboard shortcut. In a text box, the
  caret stays where the selection ended. It can't clear selections on pages where
  extensions can't run scripts (`about:` and `chrome://` pages, the add-on stores).
- Playback options, the scrub step and colors take effect in an open player as soon
  as you Save; server and voice settings apply to the next selection.
- If the browser blocks audio from starting on its own, the status shows
  *Click Play to start*.

## Appearance

Under **Appearance** in Settings, tick **Use custom player colors** and pick a
background and a font color. The preview shows the result, and a warning appears if
the two colors are hard to read together. Borders, buttons and the status text are
mixed from the two colors. With the box unticked, the player follows the system
light/dark theme.

## Window-manager rules (KWin)

The player page title is always `Kokoro Reader Player`. The browser may add its own
text around it (for example `Kokoro Reader Player — Mozilla Firefox`), so match on a
substring rather than the whole title.

In System Settings → Window Management → Window Rules, add a rule with
**Window title: Substring match `Kokoro Reader Player`**. Leave the window class
unset, or set it to the browser's class: `firefox` for Firefox, and typically
`google-chrome`, `chromium`, `brave-browser` or similar for Chromium browsers. All of a
browser's windows share its class, so the title is what identifies the player. Use
**Detect Window Properties** with the player open to see the exact title and class.
The player resizes itself once to fit its controls; a KWin rule set to *Force* a size
or position takes precedence over that.

## Notes

- The full selection is read from the page with a short script. On pages where
  extensions can't run scripts (`about:` and `chrome://` pages, the browsers' add-on
  stores and similar), the context menu falls back to the browser's own copy of the
  selection, which may be shortened for very long selections. The keyboard shortcut
  can't read anything on those pages.
- Selected page text is sent to the configured TTS server. The Firefox manifest
  declares this as `websiteContent` data collection; the Chrome Web Store asks for the
  same information on its Privacy tab. See `SIGNING.md`.

## Cross-browser details

- `manifest.json` lists the background code twice: Firefox runs `background.scripts`,
  Chrome runs `background.service_worker` (each browser ignores the other key, from
  Firefox 121 and Chrome 121).
- The code uses the `browser.*` namespace. On Chromium browsers that only provide
  `chrome.*`, `common/settings.js` maps one to the other.
- Firefox-only manifest keys (`browser_specific_settings`) and Chrome-only ones
  (`minimum_chrome_version`) produce harmless warnings in the other browser.

## Building

`./build.sh` writes the store package to `web-ext-artifacts/kokoro-reader-<version>.zip`.
The same zip is submitted to addons.mozilla.org and the Chrome Web Store; `SIGNING.md`
has the steps for both. `store-assets/` holds images for the store listings and isn't
part of the package.

## Privacy

Kokoro Reader collects nothing for its developer. Selected text and the optional API
key go only to the TTS server you configure. See [PRIVACY.md](PRIVACY.md).

## License

MIT; see [LICENSE](LICENSE).
