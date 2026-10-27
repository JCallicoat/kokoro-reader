/* Saving the received audio. WAV is the server's PCM behind a RIFF header; Opus is
 * encoded with WebCodecs' AudioEncoder (built into the browser, so no bundled
 * encoder) and wrapped in an Ogg container here. Loaded as a classic script by the
 * player window, so everything here is a global.
 *
 * Audio arrives as a list of Uint8Array chunks of signed 16-bit little-endian mono
 * PCM, each an even number of bytes. */

"use strict";

const OPUS_RATE = 48000; // Ogg Opus granule positions always count 48 kHz samples
const OPUS_NATIVE_RATES = Object.freeze([8000, 12000, 16000, 24000, 48000]);
const OPUS_BITRATE = 48000; // mono speech is transparent well below this
/* libopus's encoder lookahead (6.5 ms) in 48 kHz samples, whatever the input rate.
 * Not taken from the encoder's decoder description: Chrome reports it there in
 * input-rate samples (156 at 24 kHz), but OpusHead needs 48 kHz ones. */
const OPUS_PRE_SKIP = 312;
const OPUS_VENDOR = "Kokoro Reader";
const OGG_PAGE_SAMPLES = OPUS_RATE; // start a new page after about a second of audio
const ENCODE_BLOCK_SECONDS = 1;
const ENCODE_MAX_QUEUE = 8;

/** Returns { blob, extension } in the requested format, or WAV when this browser
 * can't encode Opus. */
async function encodeAudio(chunks, rate, format) {
  if (format === "opus") {
    const blob = await encodeOpus(chunks, rate);
    if (blob) return { blob, extension: "opus" };
  }
  return { blob: encodeWav(chunks, rate), extension: "wav" };
}

function pcmFrames(chunks) {
  return chunks.reduce((n, chunk) => n + chunk.length / 2, 0);
}

function writeAscii(bytes, offset, text) {
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
}

// -- WAV --------------------------------------------------------------------- //
function encodeWav(chunks, rate) {
  const dataBytes = chunks.reduce((n, chunk) => n + chunk.length, 0);
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  writeAscii(header, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(header, 8, "WAVE");
  writeAscii(header, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // integer PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(header, 36, "data");
  view.setUint32(40, dataBytes, true);
  return new Blob([header, ...chunks], { type: "audio/wav" });
}

// -- Opus -------------------------------------------------------------------- //
/* Other rates are resampled to 48 kHz here: encoders may reject them, and Chrome's
 * own resampling delays the audio by more than the pre-skip accounts for. null when
 * the browser has no Opus encoder at all (no WebCodecs on Firefox for Android, for
 * example). */
async function opusEncoderConfig(rate) {
  if (typeof AudioEncoder === "undefined") return null;
  const rates = OPUS_NATIVE_RATES.includes(rate) && rate !== OPUS_RATE ? [rate, OPUS_RATE] : [OPUS_RATE];
  for (const sampleRate of rates) {
    const config = { codec: "opus", sampleRate, numberOfChannels: 1, bitrate: OPUS_BITRATE };
    try {
      if ((await AudioEncoder.isConfigSupported(config)).supported) return config;
    } catch (_) {
      /* rejected as invalid: try the next rate */
    }
  }
  return null;
}

function pcmToFloat32(chunks) {
  const out = new Float32Array(pcmFrames(chunks));
  let offset = 0;
  for (const chunk of chunks) {
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.length);
    for (let i = 0; i < chunk.length; i += 2) out[offset++] = view.getInt16(i, true) / 32768;
  }
  return out;
}

async function resample(samples, fromRate, toRate) {
  const length = Math.ceil((samples.length * toRate) / fromRate);
  const offline = new OfflineAudioContext(1, length, toRate);
  const buffer = offline.createBuffer(1, samples.length, fromRate);
  buffer.copyToChannel(samples, 0);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  return (await offline.startRendering()).getChannelData(0);
}

/** Ogg Opus Blob, or null when this browser can't encode Opus. */
async function encodeOpus(chunks, rate) {
  const config = await opusEncoderConfig(rate);
  if (!config) return null;
  let samples = pcmToFloat32(chunks);
  const totalSamples = Math.round((samples.length * OPUS_RATE) / rate);
  if (config.sampleRate !== rate) samples = await resample(samples, rate, config.sampleRate);

  const packets = [];
  const encoder = new AudioEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      packets.push(data);
    },
    error: () => {
      /* also rejects flush(), which reports it */
    },
  });
  try {
    encoder.configure(config);
    const block = config.sampleRate * ENCODE_BLOCK_SECONDS;
    for (let start = 0; start < samples.length; start += block) {
      if (encoder.encodeQueueSize > ENCODE_MAX_QUEUE) {
        await new Promise((resolve) => encoder.addEventListener("dequeue", resolve, { once: true }));
      }
      const data = samples.subarray(start, start + block);
      const audio = new AudioData({
        format: "f32",
        sampleRate: config.sampleRate,
        numberOfFrames: data.length,
        numberOfChannels: 1,
        timestamp: Math.round((start * 1e6) / config.sampleRate),
        data,
      });
      encoder.encode(audio);
      audio.close();
    }
    await encoder.flush();
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
  return muxOggOpus(packets, { preSkip: OPUS_PRE_SKIP, inputRate: rate, totalSamples });
}

// -- Ogg container (RFC 3533, RFC 7845) --------------------------------------- //
const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  }
  return crc;
}

const OGG_BOS = 0x02;
const OGG_EOS = 0x04;

function oggSegmentCount(packet) {
  return Math.floor(packet.length / 255) + 1;
}

function oggPage(packets, { granule, serial, sequence, flags }) {
  const lacing = [];
  for (const packet of packets) {
    let n = packet.length;
    for (; n >= 255; n -= 255) lacing.push(255);
    lacing.push(n); // a packet ending exactly on 255 gets a 0 segment
  }
  const bodyLength = packets.reduce((n, packet) => n + packet.length, 0);
  const page = new Uint8Array(27 + lacing.length + bodyLength);
  const view = new DataView(page.buffer);
  writeAscii(page, 0, "OggS");
  page[4] = 0; // version
  page[5] = flags;
  view.setBigUint64(6, BigInt(granule), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  // The checksum (bytes 22-25) is computed with the field zeroed.
  page[26] = lacing.length;
  page.set(lacing, 27);
  let offset = 27 + lacing.length;
  for (const packet of packets) {
    page.set(packet, offset);
    offset += packet.length;
  }
  view.setUint32(22, oggCrc(page), true);
  return page;
}

function opusHead(preSkip, inputRate) {
  const head = new Uint8Array(19);
  const view = new DataView(head.buffer);
  writeAscii(head, 0, "OpusHead");
  head[8] = 1; // version
  head[9] = 1; // channels
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputRate, true); // informational only
  view.setInt16(16, 0, true); // output gain
  head[18] = 0; // channel mapping family: mono/stereo
  return head;
}

function opusTags() {
  const vendor = new TextEncoder().encode(OPUS_VENDOR);
  const tags = new Uint8Array(16 + vendor.length);
  const view = new DataView(tags.buffer);
  writeAscii(tags, 0, "OpusTags");
  view.setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  view.setUint32(12 + vendor.length, 0, true); // no user comments
  return tags;
}

/** Samples (at 48 kHz) in an Opus packet, from its TOC byte (RFC 6716 section 3.1). */
function opusPacketSamples(packet) {
  if (!packet.length) return 0;
  const toc = packet[0];
  const config = toc >> 3;
  let frameSize;
  if (config < 12) frameSize = [480, 960, 1920, 2880][config & 3]; // SILK: 10/20/40/60 ms
  else if (config < 16) frameSize = config & 1 ? 960 : 480; // hybrid: 10/20 ms
  else frameSize = [120, 240, 480, 960][config & 3]; // CELT: 2.5/5/10/20 ms
  const code = toc & 3;
  const frames = code === 0 ? 1 : code === 3 ? (packet.length > 1 ? packet[1] & 0x3f : 0) : 2;
  return frames * frameSize;
}

/* The ID and comment headers get a page each; audio packets are grouped into pages
 * of about a second. The last page's granule position marks where the audio really
 * ends, so players drop the padding of the final packet. */
function muxOggOpus(packets, { preSkip, inputRate, totalSamples }) {
  const serial = crypto.getRandomValues(new Uint32Array(1))[0];
  let sequence = 0;
  const pages = [];
  const write = (group, granule, flags) => {
    pages.push(oggPage(group, { granule, serial, sequence: sequence++, flags }));
  };
  write([opusHead(preSkip, inputRate)], 0, OGG_BOS);
  write([opusTags()], 0, 0);

  const end = preSkip + totalSamples;
  let granule = 0;
  let group = [];
  let segments = 0;
  let groupSamples = 0;
  for (const packet of packets) {
    const needed = oggSegmentCount(packet);
    if (group.length && (segments + needed > 255 || groupSamples >= OGG_PAGE_SAMPLES)) {
      write(group, Math.min(granule, end), 0);
      group = [];
      segments = 0;
      groupSamples = 0;
    }
    const samples = opusPacketSamples(packet);
    group.push(packet);
    segments += needed;
    groupSamples += samples;
    granule += samples;
  }
  write(group, Math.min(granule, end), OGG_EOS);
  return new Blob(pages, { type: "audio/ogg" });
}
