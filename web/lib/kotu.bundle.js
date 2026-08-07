// ../kotu/packages/ko2-webmidi/src/WebMidiTransport.ts
var NoWebMidiError = class extends Error {
  constructor() {
    super("This browser has no WebMIDI SysEx support. Use Chrome or Edge.");
    this.name = "NoWebMidiError";
  }
};
var NoDeviceError = class extends Error {
  constructor() {
    super("No EP device found. Connect an EP-133 / EP-40 (or sibling) over USB-C and reload.");
    this.name = "NoDeviceError";
  }
};
var MidiPermissionDeniedError = class extends Error {
  constructor(options) {
    super(
      `MIDI access was denied. Click "Allow" on Chrome's MIDI permission prompt and reload the page.`,
      options
    );
    this.name = "MidiPermissionDeniedError";
  }
};
var AmbiguousDeviceError = class extends Error {
  constructor(kind, count) {
    super(`Found ${count} EP ${kind} ports; expected exactly 1. Disconnect the extra device or stale virtual port.`);
    this.name = "AmbiguousDeviceError";
  }
};
var EP_DEVICE_PORT_RE = /EP-(133|40|1320|136)\b/;
var WebMidiTransport = class {
  constructor(input, output) {
    this.input = input;
    this.output = output;
    if (input.onmidimessage != null) {
      throw new Error(
        "A WebMidiTransport is already attached to this MIDIInput. Close it before opening another."
      );
    }
    input.onmidimessage = this.midiMessageListener;
  }
  input;
  output;
  handler = () => {
  };
  // Stored so close() can verify it's still the installed listener before
  // nulling it out — a second transport attaching to the same port replaces
  // this, and this instance's close() must not clobber that replacement.
  midiMessageListener = (e) => {
    if (e.data) this.handler(e.data);
  };
  send(bytes) {
    this.output.send(bytes);
  }
  onMessage(handler) {
    this.handler = handler;
  }
  close() {
    if (this.input.onmidimessage === this.midiMessageListener) {
      this.input.onmidimessage = null;
    }
  }
};
async function openEp133() {
  const nav = globalThis.navigator;
  if (typeof nav?.requestMIDIAccess !== "function") throw new NoWebMidiError();
  let midi;
  try {
    midi = await nav.requestMIDIAccess({ sysex: true });
  } catch (err) {
    throw new MidiPermissionDeniedError({ cause: err });
  }
  const inputs = [];
  const outputs = [];
  midi.inputs.forEach((p) => {
    if (EP_DEVICE_PORT_RE.test(p.name ?? "")) inputs.push(p);
  });
  midi.outputs.forEach((p) => {
    if (EP_DEVICE_PORT_RE.test(p.name ?? "")) outputs.push(p);
  });
  if (inputs.length > 1) throw new AmbiguousDeviceError("input", inputs.length);
  if (outputs.length > 1) throw new AmbiguousDeviceError("output", outputs.length);
  const input = inputs[0];
  const output = outputs[0];
  if (!input || !output) throw new NoDeviceError();
  return new WebMidiTransport(input, output);
}

// ../kotu/packages/ko2-protocol/src/types.ts
var SYSEX_START = 240;
var SYSEX_END = 247;
var TE_MFG = [0, 32, 118];
var MIDI_SYSEX_TE = 64;
var CMD_FILE = 5;
var SOUNDS_NODE = 1e3;
var UPLOAD_CHUNK = 433;
function isSynthMeta(meta) {
  return !!meta && typeof meta === "object" && meta.type === "synth";
}
function isSlotMeta(meta) {
  return !!meta && typeof meta === "object" && typeof meta.channels === "number";
}
var FILE_EVENT = {
  METADATA_UPDATED: 3,
  FILE_ADDED: 8,
  FILE_UPDATED: 9,
  FILE_DELETED: 10,
  FILE_MOVED: 13
};

// ../kotu/packages/ko2-protocol/src/packed7.ts
function pack7(data) {
  const groups = Math.ceil(data.length / 7);
  const out = new Uint8Array(groups + data.length);
  let o = 0;
  for (let i = 0; i < data.length; i += 7) {
    const end = Math.min(i + 7, data.length);
    const flagsAt = o++;
    let flags = 0;
    for (let j = i; j < end; j++) {
      const b = data[j];
      if (b & 128) flags |= 1 << j - i;
      out[o++] = b & 127;
    }
    out[flagsAt] = flags;
  }
  return out;
}
function unpack7(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const flags = data[i++];
    for (let bit = 0; bit < 7 && i < data.length; bit++, i++) {
      out.push(data[i] & 127 | (flags >> bit & 1) << 7);
    }
  }
  return Uint8Array.from(out);
}

// ../kotu/packages/ko2-protocol/src/wire.ts
var be16 = (v) => [v >> 8 & 255, v & 255];
var be32 = (v) => [
  v >>> 24 & 255,
  v >>> 16 & 255,
  v >>> 8 & 255,
  v & 255
];
var u14le = (v) => [v & 127, v >> 7 & 127];
var readBe16 = (d, at) => d[at] << 8 | d[at + 1];
var readBe32 = (d, at) => (d[at] << 24 >>> 0) + (d[at + 1] << 16) + (d[at + 2] << 8) + d[at + 3];
var readU14le = (d, at) => d[at] | d[at + 1] << 7;

// ../kotu/packages/ko2-protocol/src/frame.ts
var DEFAULT_DEVICE_ID = 51;
function encodeFileFrame(cmd, seq, payload, deviceId = DEFAULT_DEVICE_ID) {
  const packed = pack7(Uint8Array.from(payload));
  const out = new Uint8Array(9 + packed.length + 1);
  out[0] = SYSEX_START;
  out.set(TE_MFG, 1);
  out[4] = deviceId;
  out[5] = MIDI_SYSEX_TE;
  out[6] = cmd;
  out[7] = seq;
  out[8] = CMD_FILE;
  out.set(packed, 9);
  out[out.length - 1] = SYSEX_END;
  return out;
}
function encodeRawFrame(cmd, seq, payload, deviceId = DEFAULT_DEVICE_ID) {
  if (cmd > 127) throw new Error(`encodeRawFrame: cmd 0x${cmd.toString(16)} has the high bit set (must be <= 0x7f)`);
  if (seq > 127) throw new Error(`encodeRawFrame: seq 0x${seq.toString(16)} has the high bit set (must be <= 0x7f)`);
  if (deviceId > 127) throw new Error(`encodeRawFrame: deviceId 0x${deviceId.toString(16)} has the high bit set (must be <= 0x7f)`);
  for (const b of payload) {
    if (b > 127) throw new Error(`encodeRawFrame: payload byte 0x${b.toString(16)} has the high bit set (must be <= 0x7f)`);
  }
  return Uint8Array.from([SYSEX_START, ...TE_MFG, deviceId, MIDI_SYSEX_TE, cmd, seq, ...payload, SYSEX_END]);
}
function isTeFrame(raw) {
  return raw.length >= 8 && raw[0] === SYSEX_START && raw[1] === TE_MFG[0] && raw[2] === TE_MFG[1] && raw[3] === TE_MFG[2] && raw[5] === MIDI_SYSEX_TE;
}
function parseIdentityDeviceId(raw) {
  if (raw.length >= 8 && raw[0] === SYSEX_START && raw[1] === 126 && raw[3] === 6 && raw[4] === 2 && raw[5] === TE_MFG[0] && raw[6] === TE_MFG[1] && raw[7] === TE_MFG[2]) {
    return raw[2];
  }
  return null;
}
var PUSH_CMD = 64;
function isUnsolicitedPush(raw) {
  return isTeFrame(raw) && raw[6] === PUSH_CMD;
}
function decodeResponse(raw) {
  if (!isTeFrame(raw) || raw.at(-1) !== SYSEX_END) return null;
  if (isUnsolicitedPush(raw)) return null;
  if (raw[8] !== CMD_FILE) return null;
  if (raw.length < 11) return null;
  return {
    cmd: raw[6],
    seq: raw[7],
    status: raw[9],
    payload: unpack7(raw.subarray(10, raw.length - 1))
  };
}
function parseDeviceInfo(raw) {
  const text = new TextDecoder().decode(unpack7(raw.subarray(10, raw.length - 1)));
  const get = (k) => new RegExp(`(?:^|;)${k}:([^;]*)`).exec(text)?.[1] ?? "";
  return { product: get("product"), osVersion: get("os_version"), serial: get("serial"), sku: get("sku") };
}

// ../kotu/packages/ko2-protocol/src/events.ts
function decodeEvent(raw) {
  if (!isTeFrame(raw) || !isUnsolicitedPush(raw)) return null;
  if (raw[8] !== CMD_FILE) return null;
  const payload = unpack7(raw.subarray(9, raw.length - 1));
  if (payload.length < 1) return null;
  const kind = payload[0];
  const body = payload.subarray(1);
  const nodeId = body.length >= 2 ? readBe16(body, 0) : -1;
  switch (kind) {
    case FILE_EVENT.FILE_ADDED:
    case FILE_EVENT.FILE_UPDATED: {
      let end = 8;
      while (end < body.length && body[end] !== 0) end++;
      return {
        type: kind === FILE_EVENT.FILE_ADDED ? "file-added" : "file-updated",
        nodeId,
        fileSize: body.length >= 8 ? readBe32(body, 4) : 0,
        name: new TextDecoder().decode(body.subarray(8, end))
      };
    }
    case FILE_EVENT.FILE_DELETED:
      return { type: "file-deleted", nodeId };
    case FILE_EVENT.FILE_MOVED:
      return { type: "file-moved", nodeId };
    case FILE_EVENT.METADATA_UPDATED: {
      let end = 2;
      while (end < body.length && body[end] !== 0) end++;
      const text = new TextDecoder().decode(body.subarray(2, end));
      try {
        return { type: "metadata-updated", nodeId, metadata: JSON.parse(text) };
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

// ../kotu/packages/ko2-protocol/src/session.ts
var Ep133Error = class extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = "Ep133Error";
  }
  status;
};
var Ep133Session = class {
  constructor(transport) {
    this.transport = transport;
    transport.onMessage((b) => this.dispatch(b));
  }
  transport;
  #state = "disconnected";
  seq = 0;
  waiters = [];
  eventListeners = [];
  /** TE SysEx identity_code: 0x33 (EP-133) or 0x3c (EP-40 firmware). */
  deviceId = DEFAULT_DEVICE_ID;
  get state() {
    return this.#state;
  }
  get identityCode() {
    return this.deviceId;
  }
  dispatch(b) {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      if (w.match(b)) {
        this.waiters.splice(i, 1);
        w.resolve(b);
        return;
      }
    }
    if (this.eventListeners.length > 0) {
      const event = decodeEvent(b);
      if (event) for (const cb of this.eventListeners) cb(event);
    }
  }
  nextSeq() {
    const s = this.seq;
    this.seq = this.seq + 1 & 127;
    return s;
  }
  /**
   * `respCmd`, when provided, marks this wait as owned by a real device request
   * for the single-outstanding-per-cmd invariant (assertNoOutstanding). It plays
   * no role in matching a reply — that's entirely the caller-supplied `match`
   * predicate now, keyed on (cmd, seq). The handshake's identity/init waits omit
   * it since they're not subject to that invariant.
   */
  await_(match, timeoutMs, label, respCmd) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Ep133Error(`timeout waiting for ${label}`));
        }
      }, timeoutMs);
      const w = {
        match,
        respCmd,
        resolve: (b) => {
          clearTimeout(timer);
          resolve(b);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        }
      };
      this.waiters.push(w);
    });
  }
  async connect() {
    if (this.#state !== "disconnected") {
      throw new Ep133Error(`connect() requires state=disconnected (state=${this.#state}); use reinit() instead`);
    }
    const info = await this.handshake();
    this.#state = "ready";
    return info;
  }
  /** Mandatory after any completed get()/put(). The device otherwise drops the next command. */
  async reinit() {
    await this.handshake();
    this.#state = "ready";
  }
  async handshake() {
    const identity = this.await_((b) => b[0] === 240 && b[1] === 126, 2e3, "identity");
    this.transport.send(Uint8Array.of(240, 126, 127, 6, 1, 247));
    const idFrame = await identity.catch(() => void 0);
    if (idFrame) {
      const id = parseIdentityDeviceId(idFrame);
      if (id !== null) this.deviceId = id;
    }
    const init1 = this.await_((b) => isTeFrame(b) && b[6] === 33, 2e3, "init1");
    this.transport.send(encodeRawFrame(97, 23, [1], this.deviceId));
    const r1 = await init1;
    const init2 = this.await_((b) => isTeFrame(b) && b[6] === 33, 2e3, "init2");
    this.transport.send(encodeRawFrame(97, 24, [5, 0, 1, 1, 0, 64, 0, 0], this.deviceId));
    await init2;
    return parseDeviceInfo(r1);
  }
  enterTransfer() {
    if (this.#state !== "ready") throw new Ep133Error(`enterTransfer() requires state=ready (state=${this.#state})`);
    this.#state = "transferring";
  }
  assertNoOutstanding(respCmd) {
    if (this.waiters.some((w) => w.respCmd === respCmd)) {
      throw new Ep133Error(`two concurrent requests await cmd 0x${respCmd.toString(16)}`);
    }
  }
  /**
   * Computes the seq about to be sent, registers a waiter matching (respCmd,
   * seq) TOGETHER, and only then sends. The register-before-send ordering is
   * load-bearing (see 'a reply delivered synchronously inside send()' test) —
   * do not reorder this.
   */
  async awaitReply(cmd, payload, respCmd, timeoutMs, checkStatus) {
    const seq = this.nextSeq();
    const p = this.await_(
      (b) => isTeFrame(b) && b[6] === respCmd && b[7] === seq,
      timeoutMs,
      `cmd 0x${respCmd.toString(16)} seq 0x${seq.toString(16)}`,
      respCmd
    );
    this.transport.send(encodeFileFrame(cmd, seq, payload, this.deviceId));
    const raw = await p;
    const res = decodeResponse(raw);
    if (!res) throw new Ep133Error("undecodable response");
    if (checkStatus && res.status !== 0) throw new Ep133Error(`device returned status=0x${res.status.toString(16)}`, res.status);
    return res;
  }
  /**
   * Correlates on (respCmd, seq) — see the class doc. Not declared `async` on
   * purpose: the state check must surface as a promise rejection (callers await
   * it like any other failure), while the concurrent-request check is a
   * caller-misuse bug and must throw synchronously, before a second waiter for
   * the same respCmd is ever registered.
   */
  request(cmd, payload, respCmd, timeoutMs = 2e3, opts = {}) {
    if (this.#state !== "ready") return Promise.reject(new Ep133Error(`session not ready (state=${this.#state})`));
    this.assertNoOutstanding(respCmd);
    return this.awaitReply(cmd, payload, respCmd, timeoutMs, opts.checkStatus ?? true);
  }
  /** Pipelined chunk sends. No correlation, no await. */
  fireAndForget(cmd, payload) {
    this.transport.send(encodeFileFrame(cmd, this.nextSeq(), payload, this.deviceId));
  }
  /**
   * Same as request() but permitted while transferring. Used for chunk-loop
   * internals. `checkStatus` defaults to true, matching request(); download chunk
   * pages will opt out later by passing `{ checkStatus: false }` because the
   * device reports a non-fatal non-zero status mid-download that the chunk loop
   * itself must interpret, not treat as a hard failure.
   */
  requestDuringTransfer(cmd, payload, respCmd, timeoutMs = 2500, opts = {}) {
    this.assertNoOutstanding(respCmd);
    return this.awaitReply(cmd, payload, respCmd, timeoutMs, opts.checkStatus ?? true);
  }
  /**
   * Listen for unsolicited device events. The handshake's FILE_INIT sets flags=SUBSCRIBE,
   * so the device announces every file add, delete, move and metadata change — including
   * ones the user makes on the front panel.
   */
  onEvent(cb) {
    this.eventListeners.push(cb);
    return () => {
      this.eventListeners = this.eventListeners.filter((f) => f !== cb);
    };
  }
  close() {
    this.transport.close();
    for (const w of this.waiters) w.reject(new Ep133Error("session closed"));
    this.waiters = [];
    this.#state = "disconnected";
  }
};

// ../kotu/packages/ko2-protocol/src/crc32.ts
var POLY = 3988292384;
var table;
function buildTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? POLY ^ c >>> 1 : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
}
function crc32(data) {
  const t = table ??= buildTable();
  let crc = 4294967295;
  for (let i = 0; i < data.length; i++) {
    crc = t[(crc ^ data[i]) & 255] ^ crc >>> 8;
  }
  return (crc ^ 4294967295) >>> 0;
}

// ../kotu/packages/ko2-protocol/src/ops/list.ts
var MAX_LIST_PAGES = 128;
function parseListPage(payload) {
  const out = [];
  let i = 2;
  while (i + 7 <= payload.length) {
    const node = readBe16(payload, i);
    i += 2;
    const flags = payload[i];
    i += 1;
    const sizeBytes = readBe32(payload, i);
    i += 4;
    let end = i;
    while (end < payload.length && payload[end] !== 0) end++;
    if (end >= payload.length) {
      throw new Ep133Error(`parseListPage: name terminator not found before end of payload (byte offset ${i})`);
    }
    const name = new TextDecoder().decode(payload.subarray(i, end));
    i = end + 1;
    out.push({ slot: node, name, sizeBytes, isDir: !!(flags & 2) });
  }
  return out;
}
async function listSlots(session) {
  const all = [];
  let terminated = false;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const res = await session.request(106, [4, ...be16(page), ...be16(SOUNDS_NODE)], 42);
    const entries = parseListPage(res.payload);
    if (entries.length === 0) {
      terminated = true;
      break;
    }
    all.push(...entries);
  }
  if (!terminated) {
    throw new Ep133Error(
      `listSlots: LIST did not terminate within ${MAX_LIST_PAGES} pages; result would be truncated`
    );
  }
  const out = [];
  for (const e of all) {
    if (e.isDir || e.slot === SOUNDS_NODE) continue;
    if (e.slot < 1 || e.slot > 999) {
      throw new Ep133Error(`listSlots: entry with node id ${e.slot} outside the 1..999 slot range`);
    }
    out.push(e);
  }
  return out;
}

// ../kotu/packages/ko2-protocol/src/ops/metadata.ts
var MAX_METADATA_PAGES = 64;
function stripTrailingNul(text) {
  return text.replace(/\0+$/, "");
}
function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
function parseTolerantJson(text) {
  const clean = stripTrailingNul(text);
  const whole = tryParseJson(clean);
  if (whole !== void 0) return whole;
  const closed = tryParseJson(clean + "}");
  if (closed !== void 0) return closed;
  const cut = clean.lastIndexOf(",");
  if (cut > 0) {
    const trimmed = tryParseJson(clean.slice(0, cut) + "}");
    if (trimmed !== void 0) return trimmed;
  }
  throw new Ep133Error(`unparseable metadata JSON: ${clean.slice(0, 80)}`);
}
async function getNodeMetadata(session, nodeId) {
  let text = "";
  let terminated = false;
  for (let page = 0; page < MAX_METADATA_PAGES; page++) {
    const res = page === 0 ? await session.request(106, [7, 2, ...be16(nodeId), ...be16(page)], 42, 2e3, { checkStatus: false }) : await session.request(106, [7, 2, ...be16(nodeId), ...be16(page)], 42);
    if (page === 0 && res.status !== 0) {
      const reason = new TextDecoder().decode(res.payload).replace(/\0+$/, "");
      throw new Ep133Error(`node ${nodeId} has no metadata: ${reason}`, res.status);
    }
    const echo = readBe16(res.payload, 0);
    if (echo !== page) {
      throw new Ep133Error(`metadata page echo mismatch for node ${nodeId}: requested ${page}, device returned ${echo}`);
    }
    const chunk = res.payload.subarray(2);
    if (chunk.length === 0) {
      terminated = true;
      break;
    }
    text += new TextDecoder().decode(chunk);
    const parsed = tryParseJson(stripTrailingNul(text));
    if (parsed !== void 0) return parsed;
  }
  if (!terminated) {
    throw new Ep133Error(
      `getNodeMetadata: node ${nodeId} metadata did not terminate within ${MAX_METADATA_PAGES} pages; result would be truncated`
    );
  }
  return parseTolerantJson(text);
}
async function setNodeMetadata(session, nodeId, patch) {
  const json = [...new TextEncoder().encode(JSON.stringify(patch))];
  if (json.length > 320) {
    throw new Ep133Error(`setNodeMetadata: patch is ${json.length} bytes, exceeds the 320-byte device page limit`);
  }
  await session.request(106, [7, 1, ...be16(nodeId), ...json], 42);
}

// ../kotu/packages/ko2-protocol/src/ops/download.ts
var MAX_SIZE = 512 * 1024 * 1024;
var MAX_DOWNLOAD_PAGES = 16384;
function extractDownloadSize(payload) {
  if (payload.length < 7) {
    throw new Ep133Error(`download-init payload too short to contain a size: ${payload.length} bytes (need at least 7)`);
  }
  const size = readBe32(payload, 3);
  if (!Number.isSafeInteger(size)) {
    throw new Ep133Error(`download-init size is not a safe integer: ${size}`);
  }
  if (size <= 0 || size >= MAX_SIZE) throw new Ep133Error(`implausible download size ${size}`);
  return size;
}
async function downloadSlot(session, slot, onProgress) {
  const init = await session.request(125, [3, 0, ...be16(slot), 0, 0, 0, 0, 0], 61, 5e3);
  let pending;
  try {
    const total = extractDownloadSize(init.payload);
    session.enterTransfer();
    const pcm = new Uint8Array(total);
    let got = 0;
    let page = 0;
    let consecutiveEmptyChunks = 0;
    for (let iterations = 0; got < total; iterations++) {
      if (iterations >= MAX_DOWNLOAD_PAGES) {
        throw new Ep133Error(
          `downloadSlot: slot ${slot} did not terminate within ${MAX_DOWNLOAD_PAGES} chunk requests; result would be truncated (${got}/${total} bytes)`
        );
      }
      if (page > 16383) {
        throw new Ep133Error(
          `downloadSlot: slot ${slot} exceeds the addressable 14-bit page space (0x3FFF); ${got}/${total} bytes downloaded so far`
        );
      }
      const res = await session.requestDuringTransfer(125, [3, 1, ...u14le(page)], 61, 2500, {
        checkStatus: false
      });
      const echo = readU14le(res.payload, 0);
      if (echo !== page) {
        throw new Ep133Error(
          `downloadSlot: page echo mismatch for slot ${slot} at byte offset ${got}: requested page ${page}, device echoed ${echo}`
        );
      }
      const data = res.payload.subarray(2);
      if (data.length === 0) {
        consecutiveEmptyChunks++;
        if (consecutiveEmptyChunks >= 2) {
          throw new Ep133Error(
            `downloadSlot: slot ${slot} returned two consecutive empty chunks at page ${page} (${got}/${total} bytes); device is not making progress`
          );
        }
      } else {
        consecutiveEmptyChunks = 0;
      }
      if (data.length > total - got) {
        throw new Ep133Error(
          `downloadSlot: slot ${slot} over-served at page ${page}: chunk had ${data.length} bytes but only ${total - got} remained`
        );
      }
      pcm.set(data, got);
      got += data.length;
      page = page + 1;
      onProgress?.(got, total);
    }
    return pcm;
  } catch (err) {
    pending = err;
    throw err;
  } finally {
    try {
      await session.reinit();
    } catch (reinitErr) {
      if (pending === void 0) throw reinitErr;
    }
  }
}

// ../kotu/packages/ko2-protocol/src/ops/upload.ts
var MAX_METADATA_BYTES = 320;
var MAX_CHUNKS = 65535;
function* chunkOffsets(total) {
  for (let off = 0; off < total; off += UPLOAD_CHUNK) yield off;
}
function buildUploadMetadata(opts) {
  const meta = {
    "sound.playmode": "oneshot",
    "sound.rootnote": 60,
    "sound.pitch": 0,
    "sound.pan": 0,
    "sound.amplitude": 100,
    "envelope.attack": 0,
    "envelope.release": 255,
    "time.mode": "off",
    channels: opts.channels,
    samplerate: opts.samplerate
  };
  if (opts.trimmed && opts.frames > 0) {
    meta["sound.loopstart"] = 0;
    meta["sound.loopend"] = opts.frames - 1;
  }
  return meta;
}
async function uploadSlot(session, slot, pcm, name, meta, onProgress) {
  if (pcm.length === 0) {
    throw new Ep133Error(`uploadSlot: pcm is empty, nothing to upload for slot ${slot}`);
  }
  const chunkCount = Math.ceil(pcm.length / UPLOAD_CHUNK);
  if (chunkCount > MAX_CHUNKS) {
    throw new Ep133Error(
      `uploadSlot: slot ${slot} needs ${chunkCount} chunks of ${UPLOAD_CHUNK} bytes, exceeding the BE16 chunk-index limit of ${MAX_CHUNKS} (${pcm.length} bytes total; the largest legal sample, 40s mono, is 3.75 MB)`
    );
  }
  const nameBytes = [...new TextEncoder().encode(name.slice(0, 20))];
  const jsonBytes = [...new TextEncoder().encode(JSON.stringify(meta))];
  if (jsonBytes.length > MAX_METADATA_BYTES) {
    throw new Ep133Error(
      `uploadSlot: metadata is ${jsonBytes.length} bytes, exceeds the ${MAX_METADATA_BYTES}-byte device page limit`
    );
  }
  await session.requestDuringTransfer(
    126,
    [2, 0, 5, ...be16(slot), ...be16(SOUNDS_NODE), ...be32(pcm.length), ...nameBytes, 0, ...jsonBytes],
    62,
    5e3,
    { checkStatus: false }
  );
  session.enterTransfer();
  let pending;
  try {
    let idx = 0;
    for (const off of chunkOffsets(pcm.length)) {
      const slice = pcm.subarray(off, Math.min(off + UPLOAD_CHUNK, pcm.length));
      session.fireAndForget(126, [2, 1, ...be16(idx), ...slice]);
      idx++;
      onProgress?.(Math.min(off + UPLOAD_CHUNK, pcm.length), pcm.length, "queuing");
    }
    session.fireAndForget(126, [2, 1, ...be16(idx)]);
    session.fireAndForget(126, [11, ...be16(slot)]);
    await session.requestDuringTransfer(
      106,
      [7, 1, ...be16(slot), ...new TextEncoder().encode(JSON.stringify(meta))],
      42,
      18e4
    );
    onProgress?.(pcm.length, pcm.length, "committed");
  } catch (err) {
    pending = err;
    throw err;
  } finally {
    try {
      await session.reinit();
    } catch (reinitErr) {
      if (pending === void 0) throw reinitErr;
    }
  }
  const after = await getNodeMetadata(session, slot);
  const expectedCrc = crc32(pcm);
  if (after.crc !== expectedCrc) {
    throw new Ep133Error(
      `upload verification failed for slot ${slot}: device reports crc=${after.crc}, expected crc=${expectedCrc} (crc32 of ${pcm.length} PCM bytes)`
    );
  }
  if (after.channels !== meta["channels"] || after.samplerate !== meta["samplerate"]) {
    throw new Ep133Error(
      `upload verification failed for slot ${slot}: device reports ${after.channels}ch @ ${after.samplerate}Hz, expected ${meta["channels"]}ch @ ${meta["samplerate"]}Hz`
    );
  }
}

// ../kotu/packages/ko2-protocol/src/wav.ts
function encodeWav(pcm, opts) {
  const { channels, sampleRate } = opts;
  const byteRate = sampleRate * channels * 2;
  const out = new Uint8Array(44 + pcm.length);
  const dv = new DataView(out.buffer);
  const ascii = (s, at) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  ascii("RIFF", 0);
  dv.setUint32(4, 36 + pcm.length, true);
  ascii("WAVE", 8);
  ascii("fmt ", 12);
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, channels * 2, true);
  dv.setUint16(34, 16, true);
  ascii("data", 36);
  dv.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}
function decodeWav(wav) {
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (at) => String.fromCharCode(wav[at], wav[at + 1], wav[at + 2], wav[at + 3]);
  if (wav.length < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");
  let channels = 1, sampleRate = 46875;
  let i = 12;
  while (i + 8 <= wav.length) {
    const id = tag(i);
    const size = dv.getUint32(i + 4, true);
    if (id === "fmt ") {
      channels = dv.getUint16(i + 10, true);
      sampleRate = dv.getUint32(i + 12, true);
    }
    if (id === "data") return { pcm: wav.subarray(i + 8, i + 8 + size), channels, sampleRate };
    i += 8 + size + (size & 1);
  }
  throw new Error("no data chunk");
}

// ../kotu/packages/ko2-protocol/src/ops/storage.ts
async function getStorage(session) {
  const meta = await getNodeMetadata(session, SOUNDS_NODE);
  return {
    maxCapacity: meta.max_capacity,
    freeSpace: meta.free_space_in_bytes,
    formats: meta.formats
  };
}

// ../kotu/packages/ko2-formats/src/errors.ts
var ZipFormatError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ZipFormatError";
  }
};
var TarFormatError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "TarFormatError";
  }
};
var PakFormatError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PakFormatError";
  }
};

// ../kotu/packages/ko2-formats/src/bytes.ts
var encoder = new TextEncoder();
var decoder = new TextDecoder();
function utf8Encode(value) {
  return encoder.encode(value);
}
function utf8Decode(bytes) {
  return decoder.decode(bytes);
}
function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

// ../kotu/packages/ko2-formats/src/zip.ts
var LOCAL_FILE_SIGNATURE = 67324752;
var CENTRAL_DIR_SIGNATURE = 33639248;
var END_OF_CENTRAL_DIR_SIGNATURE = 101010256;
var METHOD_STORED = 0;
var METHOD_DEFLATE = 8;
var VERSION = 20;
var EOCD_SIZE = 22;
var EOCD_MAX_SCAN = 65557;
var CRC32_POLY = 3988292384;
var crc32Table;
function buildCrc32Table() {
  const table2 = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? CRC32_POLY ^ c >>> 1 : c >>> 1;
    }
    table2[n] = c >>> 0;
  }
  return table2;
}
function crc322(data) {
  const table2 = crc32Table ??= buildCrc32Table();
  let crc = 4294967295;
  for (let i = 0; i < data.byteLength; i++) {
    crc = table2[(crc ^ data[i]) & 255] ^ crc >>> 8;
  }
  return (crc ^ 4294967295) >>> 0;
}
async function deflateRaw(data) {
  const stream = new Blob([toArrayBuffer(data)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function inflateRaw(data) {
  const stream = new Blob([toArrayBuffer(data)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
var DOS_TIME = 0;
var DOS_DATE = 33;
async function buildZipEntry(entry, offset) {
  const nameBytes = utf8Encode(entry.path);
  const checksum = crc322(entry.data);
  const compressed = await deflateRaw(entry.data);
  const local = new Uint8Array(30 + nameBytes.byteLength);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, LOCAL_FILE_SIGNATURE, true);
  localView.setUint16(4, VERSION, true);
  localView.setUint16(6, 0, true);
  localView.setUint16(8, METHOD_DEFLATE, true);
  localView.setUint16(10, DOS_TIME, true);
  localView.setUint16(12, DOS_DATE, true);
  localView.setUint32(14, checksum, true);
  localView.setUint32(18, compressed.byteLength, true);
  localView.setUint32(22, entry.data.byteLength, true);
  localView.setUint16(26, nameBytes.byteLength, true);
  localView.setUint16(28, 0, true);
  local.set(nameBytes, 30);
  const central = new Uint8Array(46 + nameBytes.byteLength);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, CENTRAL_DIR_SIGNATURE, true);
  centralView.setUint16(4, VERSION, true);
  centralView.setUint16(6, VERSION, true);
  centralView.setUint16(8, 0, true);
  centralView.setUint16(10, METHOD_DEFLATE, true);
  centralView.setUint16(12, DOS_TIME, true);
  centralView.setUint16(14, DOS_DATE, true);
  centralView.setUint32(16, checksum, true);
  centralView.setUint32(20, compressed.byteLength, true);
  centralView.setUint32(24, entry.data.byteLength, true);
  centralView.setUint16(28, nameBytes.byteLength, true);
  centralView.setUint16(30, 0, true);
  centralView.setUint16(32, 0, true);
  centralView.setUint16(34, 0, true);
  centralView.setUint16(36, 0, true);
  centralView.setUint32(38, 0, true);
  centralView.setUint32(42, offset, true);
  central.set(nameBytes, 46);
  return { local: concatBytes([local, compressed]), central };
}
async function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const built = await buildZipEntry(entry, offset);
    locals.push(built.local);
    centrals.push(built.central);
    offset += built.local.byteLength;
  }
  const centralStart = offset;
  const centralSize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const eocd = new Uint8Array(EOCD_SIZE);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, END_OF_CENTRAL_DIR_SIGNATURE, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, centralStart, true);
  eocdView.setUint16(20, 0, true);
  return concatBytes([...locals, ...centrals, eocd]);
}
function findEndOfCentralDir(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const scanStart = Math.max(0, bytes.byteLength - EOCD_MAX_SCAN);
  for (let offset = bytes.byteLength - EOCD_SIZE; offset >= scanStart; offset--) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIR_SIGNATURE) return offset;
  }
  throw new ZipFormatError("End of central directory record not found");
}
async function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDir(bytes);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  let offset = view.getUint32(eocdOffset + 16, true);
  const records = /* @__PURE__ */ new Map();
  const order = [];
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== CENTRAL_DIR_SIGNATURE) {
      throw new ZipFormatError("Invalid central directory record");
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = utf8Decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    records.set(name, { method, compressedSize, localOffset });
    order.push(name);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  const entries = /* @__PURE__ */ new Map();
  for (const name of order) {
    const record = records.get(name);
    if (record.localOffset + 30 > bytes.byteLength) throw new ZipFormatError(`Truncated zip entry: ${name}`);
    const localNameLength = view.getUint16(record.localOffset + 26, true);
    const localExtraLength = view.getUint16(record.localOffset + 28, true);
    const dataStart = record.localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + record.compressedSize;
    if (dataEnd > bytes.byteLength) throw new ZipFormatError(`Truncated zip entry data: ${name}`);
    const compressed = bytes.slice(dataStart, dataEnd);
    if (record.method === METHOD_STORED) {
      entries.set(name, compressed);
    } else if (record.method === METHOD_DEFLATE) {
      entries.set(name, await inflateRaw(compressed));
    } else {
      throw new ZipFormatError(`Unsupported zip compression method ${record.method} for ${name}`);
    }
  }
  return entries;
}

// ../kotu/packages/ko2-formats/src/tar.ts
var HEADER_SIZE = 512;
var TERMINATOR_SIZE = 1024;
var NAME_FIELD_LEN = 100;
var SIZE_FIELD_OFFSET = 124;
var SIZE_FIELD_LEN = 12;
var CHECKSUM_FIELD_OFFSET = 148;
var CHECKSUM_FIELD_LEN = 8;
var TYPEFLAG_OFFSET = 156;
var TYPEFLAG_FILE = 48;
var TYPEFLAG_DIRECTORY = 53;
function computeChecksum(header) {
  let sum = 0;
  for (let i = 0; i < HEADER_SIZE; i++) {
    sum += i >= CHECKSUM_FIELD_OFFSET && i < CHECKSUM_FIELD_OFFSET + CHECKSUM_FIELD_LEN ? 32 : header[i];
  }
  return sum;
}
function writeName(header, path) {
  const bytes = utf8Encode(path);
  if (bytes.byteLength > NAME_FIELD_LEN) {
    throw new TarFormatError(`tar entry name exceeds ${NAME_FIELD_LEN} bytes: ${path}`);
  }
  header.set(bytes, 0);
}
function writeOctalField(header, offset, length, value) {
  if (value === 0) return;
  const digits = value.toString(8);
  if (digits.length > length) {
    throw new TarFormatError(`tar numeric field overflow at offset ${offset}: ${value}`);
  }
  header.set(utf8Encode(digits), offset);
}
function writeChecksumField(header) {
  const value = computeChecksum(header);
  const digits = value.toString(8);
  if (digits.length + 1 > CHECKSUM_FIELD_LEN) {
    throw new TarFormatError(`tar checksum overflow: ${value}`);
  }
  header.set(utf8Encode(digits), CHECKSUM_FIELD_OFFSET);
  header[CHECKSUM_FIELD_OFFSET + digits.length] = 0;
  header.fill(32, CHECKSUM_FIELD_OFFSET + digits.length + 1, CHECKSUM_FIELD_OFFSET + CHECKSUM_FIELD_LEN);
}
function buildHeader(entry) {
  const header = new Uint8Array(HEADER_SIZE);
  writeName(header, entry.path);
  writeOctalField(header, SIZE_FIELD_OFFSET, SIZE_FIELD_LEN, entry.type === "directory" ? 0 : entry.data.byteLength);
  header[TYPEFLAG_OFFSET] = entry.type === "directory" ? TYPEFLAG_DIRECTORY : TYPEFLAG_FILE;
  writeChecksumField(header);
  return header;
}
function writeTar(entries) {
  const parts = [];
  for (const entry of entries) {
    if (entry.type === "directory" && entry.data.byteLength !== 0) {
      throw new TarFormatError(`directory entry must carry no data: ${entry.path}`);
    }
    parts.push(buildHeader(entry));
    if (entry.type === "file") {
      parts.push(entry.data);
      const padLength = (HEADER_SIZE - entry.data.byteLength % HEADER_SIZE) % HEADER_SIZE;
      if (padLength > 0) parts.push(new Uint8Array(padLength));
    }
  }
  parts.push(new Uint8Array(TERMINATOR_SIZE));
  return concatBytes(parts);
}
function readOctalField(header, offset, length) {
  const text = utf8Decode(header.subarray(offset, offset + length)).replace(/\0.*$/, "").trim();
  return text ? parseInt(text, 8) : 0;
}
function readTar(bytes) {
  const entries = [];
  let offset = 0;
  while (offset + HEADER_SIZE <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + HEADER_SIZE);
    if (header.every((byte) => byte === 0)) break;
    const path = utf8Decode(header.subarray(0, NAME_FIELD_LEN)).replace(/\0.*$/, "");
    const size = readOctalField(header, SIZE_FIELD_OFFSET, SIZE_FIELD_LEN);
    const type = header[TYPEFLAG_OFFSET] === TYPEFLAG_DIRECTORY ? "directory" : "file";
    const dataStart = offset + HEADER_SIZE;
    const dataLength = type === "directory" ? 0 : size;
    const dataEnd = dataStart + dataLength;
    if (dataEnd > bytes.byteLength) throw new TarFormatError(`Truncated tar entry: ${path}`);
    entries.push({ path, type, data: bytes.slice(dataStart, dataEnd) });
    const padLength = dataLength === 0 ? 0 : (HEADER_SIZE - dataLength % HEADER_SIZE) % HEADER_SIZE;
    offset = dataEnd + padLength;
  }
  return entries;
}

// ../kotu/packages/ko2-formats/src/padOrder.ts
var PAD_NUM_TO_TAR_NAME = [
  "p10",
  "p11",
  "p12",
  "p07",
  "p08",
  "p09",
  "p04",
  "p05",
  "p06",
  "p01",
  "p02",
  "p03"
];
var TAR_NAME_TO_PAD_NUM = new Map(
  PAD_NUM_TO_TAR_NAME.map((name, index) => [name, index + 1])
);

// ../kotu/packages/ko2-formats/src/pak.ts
var PROJECT_PATH_PATTERN = /^\/?projects\/([^/]+)\.tar$/;
var SOUND_PATH_PATTERN = /^\/?sounds\/(.+)$/;
var META_PATH_PATTERN = /^\/?meta\.json$/;
var SLOT_META_PATH = "kotu/slot-metadata.json";
var SLOT_META_PATTERN = /^\/?kotu\/slot-metadata\.json$/;
var SOUND_SLOT_PATTERN = /^(\d+)\s/;
function archivePath(path) {
  return path.startsWith("/") ? path : `/${path}`;
}
function assertNoSettingsEntry(projectName, project) {
  const hasSettings = project.some((entry) => entry.path === "settings" || entry.path === "/settings");
  if (hasSettings) {
    throw new PakFormatError(
      `Project "${projectName}" has a "settings" entry \u2014 writing it would raise ERROR CLOCK 43 on the device, which survives a power cycle and requires a flash format to clear.`
    );
  }
}
function parseMeta(bytes) {
  return JSON.parse(utf8Decode(bytes));
}
function encodeMeta(meta) {
  return utf8Encode(`${JSON.stringify(meta, null, 2)}
`);
}
function soundSlot(basename) {
  const match = basename.match(SOUND_SLOT_PATTERN);
  return match ? Number(match[1]) : null;
}
function classifyEntries(zipEntries) {
  let meta;
  let slotMeta;
  const projects = /* @__PURE__ */ new Map();
  const sounds = /* @__PURE__ */ new Map();
  for (const [path, data] of zipEntries) {
    if (META_PATH_PATTERN.test(path)) {
      meta = parseMeta(data);
      continue;
    }
    if (SLOT_META_PATTERN.test(path)) {
      slotMeta = parseSlotMeta(data);
      continue;
    }
    const projectMatch = path.match(PROJECT_PATH_PATTERN);
    if (projectMatch) {
      projects.set(projectMatch[1], readTar(data));
      continue;
    }
    const soundMatch = path.match(SOUND_PATH_PATTERN);
    if (soundMatch) {
      const name = soundMatch[1];
      const slot = soundSlot(name);
      if (slot !== null) sounds.set(slot, { name, wav: data });
    }
  }
  return { meta, projects, sounds, slotMeta };
}
function parseSlotMeta(data) {
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data));
  } catch (err) {
    throw new PakFormatError(`${SLOT_META_PATH} is not valid JSON: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PakFormatError(`${SLOT_META_PATH} must be an object keyed by slot number`);
  }
  const out = /* @__PURE__ */ new Map();
  for (const [key, value] of Object.entries(parsed)) {
    const slot = Number(key);
    if (!Number.isInteger(slot)) throw new PakFormatError(`${SLOT_META_PATH} has a non-numeric slot key: ${key}`);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new PakFormatError(`${SLOT_META_PATH} entry for slot ${slot} is not an object`);
    }
    out.set(slot, value);
  }
  return out;
}
function encodeSlotMeta(slotMeta) {
  const obj = {};
  for (const [slot, meta] of [...slotMeta].sort((a, b) => a[0] - b[0])) obj[String(slot)] = meta;
  return new TextEncoder().encode(JSON.stringify(obj, null, 2));
}
async function readPak(bytes) {
  const zipEntries = await readZip(bytes);
  const { meta, projects, sounds, slotMeta } = classifyEntries(zipEntries);
  if (!meta) throw new PakFormatError("pak archive is missing meta.json");
  return { meta, projects, sounds, ...slotMeta ? { slotMeta } : {} };
}
async function writePak(pak) {
  const entries = [];
  for (const [name, project] of pak.projects) {
    assertNoSettingsEntry(name, project);
    entries.push({ path: `/projects/${name}.tar`, data: writeTar(project) });
  }
  for (const sound of pak.sounds.values()) {
    entries.push({ path: archivePath(`sounds/${sound.name}`), data: sound.wav });
  }
  if (pak.slotMeta?.size) {
    entries.push({ path: archivePath(SLOT_META_PATH), data: encodeSlotMeta(pak.slotMeta) });
  }
  entries.push({ path: "/meta.json", data: encodeMeta(pak.meta) });
  return writeZip(entries);
}
export {
  EP_DEVICE_PORT_RE,
  Ep133Error,
  Ep133Session,
  MAX_LIST_PAGES,
  SOUNDS_NODE,
  WebMidiTransport,
  be16,
  be32,
  buildUploadMetadata,
  decodeWav,
  downloadSlot,
  encodeWav,
  getNodeMetadata,
  getStorage,
  isSlotMeta,
  isSynthMeta,
  listSlots,
  openEp133,
  parseListPage,
  readBe16,
  readBe32,
  readPak,
  readTar,
  readU14le,
  readZip,
  setNodeMetadata,
  u14le,
  uploadSlot,
  writePak,
  writeTar,
  writeZip
};
//# sourceMappingURL=kotu.bundle.js.map
