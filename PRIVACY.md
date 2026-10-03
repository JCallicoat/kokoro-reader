# Kokoro Reader Privacy Policy

_Effective date: October 3, 2026_

Kokoro Reader is a browser extension for Firefox and Chromium-based browsers that
reads selected web page text aloud using a text-to-speech (TTS) server that you
configure. This policy explains what data the extension handles, where that data
goes, and what is stored.

## Summary

- The developer of Kokoro Reader does not collect, receive, store, sell or share
  any of your data. The extension has no analytics, tracking, telemetry or ads, and
  it does not contact any server operated by the developer.
- When you ask it to read text, the extension sends that text to **the TTS server
  you entered in its settings**, and to no one else.
- Your settings, including an optional API key, are stored only in your browser.

## Data the extension handles

### Selected text

When you choose **Read selection aloud** from the context menu, or press the
extension's keyboard shortcut, the extension reads the text you have selected in
the current tab. It does not read pages at any other time, and it reads only the
selection, not the rest of the page.

The selected text is:

- held briefly in the browser's session storage so the player window can pick it
  up, and removed when the player window closes (session storage is also cleared
  when the browser exits);
- sent once to the TTS server configured in the extension's settings, in an HTTP
  request to that server's `/v1/audio/speech` endpoint, to be converted to speech.

### Generated audio

The audio returned by the TTS server is kept in memory in the player window so you
can pause and seek. It is discarded when the player window closes or a new
selection is read. It is never saved to disk or sent anywhere.

### Settings and API key

Your settings (server URL, model, voices, speed, volume, playback and appearance
options) and the optional API key are stored in the browser's local extension
storage on your device. They are not synced to other devices by the extension and
are removed when you uninstall it.

If you enter an API key, it is sent to the configured TTS server as an
`Authorization: Bearer` header with each request to that server (the speech request
and the voice-list request). It is not sent anywhere else. The key is stored
unencrypted in the browser's extension storage, like the other settings.

## Where your data goes

The only destination for selected text and the API key is the TTS server address
you enter in the extension's settings. By default this is a server on your own
computer (`http://localhost:8880`, as used by Kokoro-FastAPI), in which case the text
never leaves your device.

If you configure a third-party service instead, such as OpenAI's text-to-speech
API, the text you choose to read and your API key are sent to that service, and its
own privacy policy and terms govern how it handles them. The developer of Kokoro
Reader has no relationship with, and no access to data held by, any such service.

## Permissions

The extension requests these browser permissions, used only as described:

- **Context menus:** to add the "Read selection aloud" menu item.
- **Active tab and scripting:** to read the selected text from the current tab when
  you use the menu item or keyboard shortcut.
- **Storage:** to keep your settings and to pass the selected text to the player
  window.
- **Host access to `localhost` and `127.0.0.1`:** to reach a TTS server running on
  your own computer.
- **Optional access to other hosts:** requested only when you enter a server address
  elsewhere, and only for that server.

## Children

Kokoro Reader is a general-purpose tool. It is not directed at children and does
not knowingly collect information from anyone.

## Changes to this policy

If the way the extension handles data changes, this policy will be updated and the
effective date above changed. The history of this file is available in the project's
repository.

## Contact

Questions about this policy or the extension can be raised as an issue at
<https://github.com/JCallicoat/kokoro-reader/issues>.
