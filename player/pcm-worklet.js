/* AudioWorklet port of PCMPlayer from kokoro_clip_reader.py.
 *
 * Holds the whole stream in memory (Float32, mono) and plays it from a movable
 * position. The main thread posts decoded chunks ("feed") and control messages;
 * the processor reports its state back a few times per second.
 *
 * Positions and lengths are in frames at the AudioContext's sample rate, which the
 * player sets to the PCM sample rate, so no resampling happens here. */

"use strict";

const REPORTS_PER_SECOND = 10;

class PCMPlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.prebuffer = Math.max(0, opts.prebufferFrames | 0);
    this.loop = Boolean(opts.loop); // restart from the beginning instead of finishing

    this.buf = new Float32Array(sampleRate * 30);
    this.len = 0;
    this.pos = 0;
    this.paused = false;
    this.primed = false; // enough audio buffered to (re)start
    this.complete = false; // server finished sending
    this.finished = false; // playback reached the end
    this.alive = true;

    this.reportInterval = Math.round(sampleRate / REPORTS_PER_SECOND);
    this.sinceReport = 0;

    this.port.onmessage = (event) => this.onMessage(event.data);
  }

  // -- main-thread side ------------------------------------------------------ //
  onMessage(msg) {
    switch (msg && msg.type) {
      case "feed":
        this.append(msg.samples);
        break;
      case "complete":
        this.complete = true;
        break;
      case "loop":
        this.loop = Boolean(msg.enabled);
        break;
      case "pause":
        this.paused = Boolean(msg.paused);
        break;
      case "play":
        // Play after the end restarts from the beginning.
        if (this.finished || this.pos >= this.len) {
          if (this.complete) this.pos = 0;
          this.finished = false;
        }
        this.paused = false;
        break;
      case "seek":
        this.setPosition(Math.round(msg.seconds * sampleRate));
        break;
      case "seekBy":
        this.setPosition(this.pos + Math.round(msg.seconds * sampleRate));
        break;
      case "dispose":
        this.alive = false;
        this.buf = new Float32Array(0);
        this.len = 0;
        this.pos = 0;
        return;
      default:
        return;
    }
    this.report();
  }

  append(samples) {
    if (!samples || !samples.length) return;
    const needed = this.len + samples.length;
    if (needed > this.buf.length) {
      let size = this.buf.length || sampleRate;
      while (size < needed) size *= 2;
      const grown = new Float32Array(size);
      grown.set(this.buf.subarray(0, this.len));
      this.buf = grown;
    }
    this.buf.set(samples, this.len);
    this.len = needed;
  }

  setPosition(target) {
    this.pos = Math.max(0, Math.min(target, this.len));
    // Seeking back from the end makes the stream playable again; stay paused
    // so dragging the slider after playback ends doesn't start it by itself.
    if (this.finished && this.pos < this.len) this.finished = false;
  }

  finish() {
    this.finished = true;
    this.paused = true;
    this.primed = false;
  }

  report() {
    this.sinceReport = 0;
    this.port.postMessage({
      type: "state",
      pos: this.pos,
      len: this.len,
      paused: this.paused,
      primed: this.primed,
      complete: this.complete,
      finished: this.finished,
    });
  }

  // -- audio thread ---------------------------------------------------------- //
  process(inputs, outputs) {
    if (!this.alive) return false;
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;

    const need = out.length;
    let written = 0;
    let finishedNow = false;

    if (!this.paused && !this.finished) {
      const avail = this.len - this.pos;
      if (!this.primed && (avail >= this.prebuffer || (this.complete && avail > 0))) {
        this.primed = true;
      }
      if (this.primed) {
        if (avail >= need) {
          out.set(this.buf.subarray(this.pos, this.pos + need));
          this.pos += need;
          written = need;
        } else if (this.complete) {
          // Tail of the stream (possibly nothing): play it, then loop or finish.
          out.set(this.buf.subarray(this.pos, this.len));
          written = avail;
          if (this.loop && this.len > 0) {
            this.pos = 0;
          } else {
            this.pos = this.len;
            this.finish();
            finishedNow = true;
          }
        } else {
          // Underrun: output silence and wait until the buffer refills.
          this.primed = false;
        }
      } else if (this.complete) {
        // Complete, never primed, nothing left to play.
        this.finish();
        finishedNow = true;
      }
    }
    if (written < need) out.fill(0, written);

    this.sinceReport += need;
    if (finishedNow || this.sinceReport >= this.reportInterval) this.report();
    return true;
  }
}

registerProcessor("pcm-player", PCMPlayerProcessor);
