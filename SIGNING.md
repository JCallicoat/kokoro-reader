# Signing and publishing Kokoro Reader

The same zip (with `manifest.json` at the top level) is submitted to both stores.
Build it from the repository with:

```sh
./build.sh    # writes web-ext-artifacts/kokoro-reader-<version>.zip
```

The script leaves out repository-only files (`store-assets/`, `build.sh`,
`SIGNING.md`, the source SVG and dotfiles) and keeps `LICENSE`, `README.md` and
`PRIVACY.md` alongside the extension code.
Each store needs a higher `version` in `manifest.json` for every new upload
(`1.0.0`, `1.0.1`, …); neither accepts a version it has already seen.

- [Firefox: addons.mozilla.org (AMO)](#firefox-addonsmozillaorg-amo)
- [Chrome Web Store](#chrome-web-store)

---

## Firefox: addons.mozilla.org (AMO)

Signing as **unlisted** gets you a Mozilla-signed `.xpi` that installs permanently in
release Firefox, without a public listing. Unlisted versions are signed
automatically; Mozilla says this can take up to 24 hours, or longer if the submission
is picked for manual review. Listed (public) versions use the same add-on and ID.

### Before submitting

1. **Extension ID.** `browser_specific_settings.gecko.id` is
   `kokoro-reader@jcallicoat`. Once a version is signed under an ID it can't change
   without creating a new add-on (and losing settings stored under the old ID).
2. **Version.** Higher than any version already uploaded for that ID.
3. **Data collection declaration.** The manifest declares
   `data_collection_permissions.required: ["websiteContent"]`, because selected page
   text is sent to the TTS server, and Mozilla's definition of transmission covers any
   data handled outside the browser, including servers you run yourself. Firefox shows
   this in the install prompt.
4. **Expected lint warning.** `web-ext lint` reports that `background.service_worker`
   is ignored by Firefox. That key is for Chrome; Firefox uses `background.scripts`.
   The warning doesn't block signing.

### Option A: web-ext (command line)

1. Sign in at <https://addons.mozilla.org> with a Firefox account and accept the
   developer agreement (Developer Hub → Submit a New Add-on, the first time).
2. Create API credentials at
   <https://addons.mozilla.org/developers/addon/api/key/>. You get a **JWT issuer**
   (the API key, like `user:12345:67`) and a **JWT secret**. Keep the secret private.
3. From the extension folder (the one containing `manifest.json`):

   ```sh
   export WEB_EXT_API_KEY='user:12345:67'
   export WEB_EXT_API_SECRET='your-jwt-secret'
   npx web-ext lint
   npx web-ext sign --channel=unlisted \
     --ignore-files 'store-assets/**' build.sh SIGNING.md icons/icon.svg
   ```

   `web-ext sign` uploads the extension, waits for signing (up to 15 minutes by
   default; raise it with `--approval-timeout`), and saves the signed `.xpi` in
   `./web-ext-artifacts/`. If it times out, signing still completes on AMO; download
   the file from the Developer Hub later.

### Option B: Developer Hub (browser)

1. Upload the zip built by `./build.sh` at
   <https://addons.mozilla.org/developers/addon/submit/distribution>, choosing
   **On your own** (unlisted) or **On this site** (listed).
2. Wait for the automatic validation and answer the remaining questions. No source
   code upload is needed: the code isn't minified, bundled or generated.
3. Once signed, download the `.xpi` from the version's page in the Developer Hub.

For a later version, open the existing add-on in the Developer Hub and use
**Upload New Version** (or run `web-ext sign` again).

### Installing the signed file

about:addons → gear menu → **Install Add-on From File…** → pick the `.xpi`, or drag
the file onto a Firefox window. Settings carry over between versions as long as the
extension ID stays the same.

### Listing the extension publicly on AMO

   ```sh
   export WEB_EXT_API_KEY='user:12345:67'
   export WEB_EXT_API_SECRET='your-jwt-secret'
   npx web-ext lint
   npx web-ext sign --channel=listed --amo-metadata store-assets/amo-metadata.json \
     --ignore-files 'store-assets/**' build.sh SIGNING.md icons/icon.svg
   ```

---

## Chrome Web Store

The Chrome Web Store reviews every item, including unlisted ones, and the store
assigns the extension ID on the first upload. The same listing installs in Chrome,
Brave and Vivaldi (and in Opera through its "Install Chrome Extensions" add-on). Microsoft Edge has its own store (Edge Add-ons, at
<https://partner.microsoft.com/dashboard/microsoftedge/>), which takes the same zip.

### 1. Upload

1. Open the Developer Dashboard at
   <https://chrome.google.com/webstore/devconsole> and click **Add new item**.
2. Upload the zip built by `./build.sh`. The dashboard may show warnings about the Firefox-only
   `browser_specific_settings` key; Chrome ignores it.

### 2. Store listing tab

- **Description** and **category** (Accessibility or Productivity fit).
- **Homepage URL** and **Support URL:** <https://github.com/JCallicoat/kokoro-reader>
  and <https://github.com/JCallicoat/kokoro-reader/issues>. (The manifest's
  `homepage_url` already points to the repository; AMO uses it as the add-on's
  homepage link.)
- **Store icon:** 128×128 PNG with the artwork at 96×96 and 16 px of transparent
  padding on each side. `store-assets/store-icon-128.png` follows that layout; the
  in-extension icons fill the whole square.
- **At least one screenshot**, 1280×800 or 640×400 (up to 5). The player window and
  the Settings page are good subjects.
- **Small promo tile**, 440×280. Listings without one are ranked after listings
  that have one. A 1400×560 marquee image is optional.

### 3. Privacy tab

The dashboard asks for each of these:

- **Single purpose.** For example: "Reads selected web page text aloud using a
  text-to-speech server the user configures (Kokoro-FastAPI or another
  OpenAI-compatible server)."
- **Permission justifications**, one per permission:
  - `contextMenus`: adds the "Read selection aloud" item for selected text.
  - `activeTab`: reads the selected text from the current tab when the menu item or
    keyboard shortcut is used.
  - `scripting`: runs a short script in that tab to get the full selection,
    including text selected in input fields and frames.
  - `storage`: saves the user's settings and hands the selected text to the player
    window.
  - Host permissions (`localhost`, `127.0.0.1`, and optional access to other hosts):
    send the text to the TTS server the user configures; other hosts are requested
    only when the user enters such a server.
- **Remote code:** No. All code is in the package; the server only returns audio.
- **Data usage:** tick **Website content** (selected text is sent to the configured
  server). Because an API key can be entered and is sent to the configured server,
  also consider **Authentication information**. Then confirm the certifications
  (no sale of data, no unrelated use, no creditworthiness use).
- **Privacy policy URL:**
  <https://github.com/JCallicoat/kokoro-reader/blob/main/PRIVACY.md>
  (`PRIVACY.md` in the repository; adjust `main` if your default branch has another
  name). Google's user-data policy expects one for extensions that handle website
  content.

### 4. Distribution tab

- **Visibility:** *Public* (searchable), *Unlisted* (installable only with the link),
  or *Private* (limited to listed testers or a Google Workspace domain).
- **Regions:** all regions unless you have a reason to limit them.

### 5. Submit

Click **Submit for review**. Review time depends on the item; you can choose
deferred publishing, which gives you up to 30 days after approval to publish
manually. Turn on email notifications in the dashboard's Account page to hear about
the result.

### Updates

Bump `version` in `manifest.json`, zip, then in the dashboard open the item, upload
the new zip from its **Package** page and submit for review again. Installed copies
update automatically once the new version is published.
