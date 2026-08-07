<!--
SUPERSEDED — DO NOT REBUILD OVER THE GHOST DRAFT.

The live draft at linecross.ing/ghost (slug: ko-ii-boots-as-a-riddim) has been
edited directly in Ghost and is the source of truth. It also has Part 2 folded
into it. This file is the pre-edit version, kept for the figure markup only.

To change the post, edit it in Ghost. To recover the current text into markdown,
pull it back down first — running tools/build_post.py + stage_ghost_post.sh
against this file would overwrite the Ghost edits.
-->

<!--
EDITING SURFACE for docs/blog/four-bytes.html.

Prose here is yours to shred. The <figure> blocks are lifted verbatim from the
current HTML and are the highest signal-per-pixel thing in the post — cut prose,
keep figures. Nine figures + one <ol class="seq"> is what tools/build_ghost_post.py
asserts on, so if you delete one, update the assertion.

Working title options at the bottom.
-->

# My k.o. II boots as a riddim now. It took four bytes.

**Dek.** Teenage Engineering sells the EP-133 and the EP-40 as two products. On my unit, the wall between them turned out to be a four-byte field in a firmware file, compared by a web page, in my own browser.

**Meta line.** One legacy 64&nbsp;MiB EP-133. Not affiliated with teenage engineering.

> **Unsupported.** TE's EP-series team asked that anyone writing about this say it plainly: cross-flashing is unsupported, field units ship different NOR flash types and densities, and you are risking incompatibility, data loss, a brick, and your warranty. Everything below happened on one legacy 64&nbsp;MiB EP-133. It is not a green light for your hardware.

## The question

The EP-133 (*k.o. II*) and the EP-40 (*riddim*) look like siblings. Same body, same screen, same pads. Riddim ships toys mine doesn't — looping, multisample, Supertone.

I own a k.o. II. I wondered if it could just run the other firmware.

I wrote down where every answer came from, because "I wondered" is how you end up with a brick and no idea which step did it.

## Get the files before you touch anything

TE hosts a public updater at [teenage.engineering/apps/update](https://teenage.engineering/apps/update). It runs entirely in the browser and talks to the device over USB. Which means I can watch every single thing it does with DevTools.

I opened it with nothing plugged in, switched to Network, and reloaded. One request stood out: a `GET` for `releases.json`. That's the catalog — products by SKU, each with an `fw_url` ending in `.tfw`.

<!-- FIG 1 -->
<figure>
  <div class="devtools" aria-label="Stylized DevTools Network panel showing releases.json">
    <div class="chrome">
      <span class="tab">Elements</span>
      <span class="tab on">Network</span>
      <span class="tab">Sources</span>
      <span class="tab">Console</span>
      <span class="url">https://teenage.engineering/apps/update</span>
    </div>
    <div class="rows">
      <div class="row">
        <span class="method">GET</span>
        <span>apps/update/assets/index-&hellip;.js</span>
        <span class="status">200</span>
        <span>js</span>
      </div>
      <div class="row sel">
        <span class="method">GET</span>
        <span>/_software/releases.json</span>
        <span class="status">200</span>
        <span>json</span>
      </div>
    </div>
    <div class="pane">
<pre>{
  <span class="key">"devices"</span>: [
    {
      <span class="key">"sku"</span>: <span class="str">"TE032AS001"</span>,        <span class="key">// EP-133 k.o. II</span>
      <span class="key">"version"</span>: <span class="str">"2.5.1"</span>,
      <span class="key">"fw_url"</span>: <span class="str">"/_software/ep-133/ep-133_firmware_2_5_1.tfw"</span>
    },
    {
      <span class="key">"sku"</span>: <span class="str">"TE032AS006"</span>,        <span class="key">// EP-40 riddim</span>
      <span class="key">"version"</span>: <span class="str">"2.5.1"</span>,
      <span class="key">"fw_url"</span>: <span class="str">"/_software/ep-40/ep-40_firmware_2_5_1.tfw"</span>
    }
  ]
}</pre>
    </div>
  </div>
  <figcaption>
    Fig. 1 &middot; Direct download:
    <a href="https://teenage.engineering/_software/releases.json"><code>https://teenage.engineering/_software/releases.json</code></a>.
    Maps each SKU to a <code>fw_url</code>. The two I used:
    <a href="https://teenage.engineering/_software/ep-133/ep-133_firmware_2_5_1.tfw"><code>&hellip;/ep-133_firmware_2_5_1.tfw</code></a>
    (<code>TE032AS001</code>) and
    <a href="https://teenage.engineering/_software/ep-40/ep-40_firmware_2_5_1.tfw"><code>&hellip;/ep-40_firmware_2_5_1.tfw</code></a>
    (<code>TE032AS006</code>), both 2.5.1.
  </figcaption>
</figure>

Two files, both 2.5.1, both a `curl` away. No account, no device, no login.

## The Update button doesn't take requests

I plugged the unit in, opened the page, allowed WebMIDI with sysex. It found the device and showed the normal card: serial, OS, SKU, "up to date." One action: **Update**.

Update doesn't ask you for a file. Watching Network made the flow obvious — the page already fetched `releases.json` on load, and when you hit Update it downloads whichever package matches the SKU of the thing you plugged in. On an EP-133, that's the EP-133 file. Always.

There is no "install this EP-40 package I already have on disk."

So I read the code the page had already sent me.

## Reading the page's own JavaScript

Same Network panel, the app's main script: `index-CFniztty.js`, about 625 KB. I downloaded it and ran `rg` over it. (The filename is content-hashed and will change. Grab whatever `index-*.js` is in Network today and run the same searches.)

<!-- FIG 2 -->
<figure>
  <div class="terminal">
    <div class="bar"><span class="dot"></span><span>rg -n 'releases.json|fw_url|not compatible' index-CFniztty.js</span></div>
<pre><span class="dim"># file: teenage.engineering/apps/update/assets/index-CFniztty.js</span>
<span class="ok">fetch("/_software/releases.json")</span>                    <span class="dim"># ~byte 620406</span>
<span class="ok">const s=t||this.props.fw.fw_url</span>                   <span class="dim"># ~byte 598408</span>
<span class="ok">firmware not compatible with this device</span>         <span class="dim"># ~byte 599860</span></pre>
  </div>
  <figcaption>
    Fig. 2 &middot; Three searches, three answers, all in
    <a href="https://teenage.engineering/apps/update/assets/index-CFniztty.js"><code>index-CFniztty.js</code></a>.
  </figcaption>
</figure>

The Update path is the short one. `upgradeDevice` hands their DFU `perform` either a dropped file or, normally, `this.props.fw.fw_url` straight from the catalog:

<!-- FIG 3 -->
<figure>
  <pre class="snippet"><span class="cmt">// Source: /apps/update/assets/index-CFniztty.js  (search: "upgradeDevice")</span>
<span class="cmt">// Minified; line breaks added only for reading.</span>
async upgradeDevice(t=!1){
  const r=t?this.state.dropFW.version:this.props.fw.version;
  &hellip;
  const s=t||this.props.fw.fw_url;
  &hellip;
  await src_default.perform(this.props.device.serial,s,this.onProgress);
}</pre>
  <figcaption>
    Fig. 3 &middot; Stock Update sends whatever <code>fw_url</code> the catalog gave for the connected SKU.
  </figcaption>
</figure>

There *is* a drop path, though. Search `dropHandler`. It parses a dropped `.tfw`, pulls a SKU out of the file, compares it to the connected device's SKU, and on mismatch does this:

<!-- FIG 4 -->
<figure>
  <pre class="snippet"><span class="cmt">// Source: /apps/update/assets/index-CFniztty.js  (search: "firmware not compatible")</span>
<span class="cmt">// Minified; line breaks added only for reading.</span>
o===this.props.device.metadata.sku||h
  ? this.setState({dropFW:{file:s,sku:o,version:a}})
  : (
      captureMessage(
        `firmware ${s.name} for sku ${o} not compatible with device sku=${this.props.device.metadata.sku} version=${a}`
      ),
      this.setState({
        fileError:<span class="str">"firmware not compatible with this device"</span>,
        dropFW:null
      }),
      setTimeout(()=&gt;{this.setState({fileError:null})}, this.errorTimer)
    )</pre>
  <figcaption>
    Fig. 4 &middot; The SKU gate, ~byte 599860. Search <code>firmware not compatible with this device</code>.
  </figcaption>
</figure>

That's the gate. `o===this.props.device.metadata.sku`. A string comparison, running in my browser, on my laptop.

Which reframed the problem. Fighting that UI into accepting a mismatched file is the wrong fight. The real question is smaller: what *is* that SKU field inside the `.tfw`, and will the device take a package whose header says one thing and whose body came from the other product?

## babecafe

Same file, search `not a valid firmware file`:

<!-- FIG 5 -->
<figure>
  <pre class="snippet"><span class="cmt">// Source: /apps/update/assets/index-CFniztty.js  (search: "not a valid firmware file")</span>
<span class="cmt">// Also: this.sku=[e[15],e[16],e[17],e[18]]  ~byte 485248</span>
if (e[0]!=186||e[1]!=190||e[2]!=202||e[3]!=254)
  throw new Error(<span class="str">"not a valid firmware file"</span>);
this.firmware_type=e[4];
this.checksum=[e[5],e[6]];
this.version=[e[7],e[8],e[9],e[10],e[11],e[12],e[13],e[14]];
this.sku=[e[15],e[16],e[17],e[18]];</pre>
  <figcaption>
    Fig. 5 &middot; Header parse. Magic check, then version, then SKU at offsets 15&ndash;18.
  </figcaption>
</figure>

Those first four bytes — `186, 190, 202, 254` — are a magic number: a fixed marker at the top of a file so a program can tell instantly what it's looking at. PDFs start with `%PDF`. ZIPs start with `PK`. In hex, TE's is `ba be ca fe`, which people say out loud the same way programmers have always said Java's `cafebabe`. There's a second marker further in that people call beefcafe. That's all those words are.

I wasn't the first person to stare at this header. There's a long-running OP Forums thread about custom OP-1 firmware where people comparing `.tfw` files across TE products already had most of it mapped:

> "It looks similar (if not the same) format as the OP-1 field firmware. Bytes 8-13 are the firmware version number (in hex). There is some other metadata in the babecafe header that I haven't quite figured out, but I'm assuming there is some kind of product code in there as well."
>
> — [OP Forums · Custom Firmware on the OP-1 · page 44](https://op-forums.com/t/custom-firmware-on-the-op-1/4283?page=44)

There is. It's at 15.

## Two files, one difference that counts

Now — and only now — I opened both in `xxd`.

<!-- FIG 6 -->
<figure>
  <div class="pair cols-2">
    <div class="terminal">
      <div class="bar"><span class="dot"></span><span>xxd -l 64 ep-133_firmware_2_5_1.tfw</span></div>
<pre><span class="dim">00000000:</span> babe cafe 00<span class="hi2">87 82</span>00 0200 0500 0100 00<span class="hi">00</span>
<span class="dim">00000010:</span> <span class="hi">0800 01</span>00 0000 0000 0000 0000 0000 0000
<span class="dim">00000020:</span> 0000 0000 0000 0000 0000 0000 0000 0000
<span class="dim">00000030:</span> 0000 0000 0000 0000 0000 0000 0000 0000</pre>
    </div>
    <div class="terminal">
      <div class="bar"><span class="dot"></span><span>xxd -l 64 ep-40_firmware_2_5_1.tfw</span></div>
<pre><span class="dim">00000000:</span> babe cafe 00<span class="hi2">32 34</span>00 0200 0500 0100 00<span class="hi">00</span>
<span class="dim">00000010:</span> <span class="hi">0800 06</span>00 0000 0000 0000 0000 0000 0000
<span class="dim">00000020:</span> 0000 0000 0000 0000 0000 0000 0000 0000
<span class="dim">00000030:</span> 0000 0000 0000 0000 0000 0000 0000 0000</pre>
    </div>
  </div>
  <figcaption>
    Fig. 6 &middot; First 64 bytes of both official CDN images. Same signature, same version region. Two things
    differ: a checksum-like field around bytes 5&ndash;6 (blue-gray) and the SKU at 15&ndash;18 (orange).
  </figcaption>
</figure>

Two things differ. A checksum-ish field around bytes 5–6, and four bytes at 15–18: `00 08 00 01` versus `00 08 00 06`.

It would have been easy to grab the wrong one. I knew which mattered because I'd already read the parser — the page reads 15–18 as the SKU and compares *that*. The bytes near offset 5 are file integrity, a different job.

And the mapping to names TE already prints in public is not subtle:

<!-- FIG 7 -->
<figure>
  <div class="terminal">
    <div class="bar"><span class="dot"></span><span>the mapping, spelled out</span></div>
<pre><span class="dim"># the four SKU bytes (offsets 15-18)   -&gt;   the published product code</span>
ep-133   <span class="ok">00 08 00 01</span>   -&gt;   <span class="ok">TE032AS001</span>
ep-40    <span class="ok">00 08 00 06</span>   -&gt;   <span class="ok">TE032AS006</span>

<span class="dim"># same codes listed in releases.json and on the download pages</span></pre>
  </div>
  <figcaption>
    Fig. 7 &middot; Decoded with <code>getSkuString()</code> in <code>index-CFniztty.js</code> (~byte 485790).
  </figcaption>
</figure>

I didn't have to eyeball it either. The bundle ships `getSkuString()`, which turns those four bytes into the exact `TE032AS00x` string the UI and `releases.json` already use.

## Which meant I had to do the flashing myself

Stock Update follows the catalog URL. The drop path checks the SKU. Neither helps me, even knowing exactly which bytes to change. So I had to drive the same DFU sequence the page already implements.

It runs over USB MIDI SysEx — a labeled binary side-channel on the MIDI cable — via WebMIDI, which the page requests as `navigator.requestMIDIAccess({sysex:!0})`. The command numbers are sitting in the bundle as an object literal:

<!-- FIG 8 -->
<figure>
  <div class="terminal">
    <div class="bar"><span class="dot"></span><span>rg -n 'TE_SYSEX_DFU=\{' index-CFniztty.js</span></div>
<pre><span class="dim"># ~byte 486591 in index-CFniztty.js</span>
<span class="ok">TE_SYSEX_DFU=&#123;DFU:3,DFU_ENTER:1,DFU_ENTER_MIDI:1,DFU_BEGIN:2,DFU_BEGIN_APP:176,DFU_CHUNK:3,DFU_PERFORM:4,DFU_EXIT:5,BAD_REQUEST:127,DFU_ENTER_RESPONSE_READY:64&#125;</span></pre>
  </div>
  <figcaption>
    Fig. 8 &middot; "DFU" just means device firmware update. A few dozen bytes earlier,
    <code>packToBuffer</code> / <code>unpackInPlace</code> (~bytes 463508&ndash;463698) do the 7-bit MIDI packing.
  </figcaption>
</figure>

The sequence, implemented in `perform` (search `async perform(e,t,r)`), reads as a timeline:

<ol class="seq">
  <li><strong>DFU_ENTER.</strong> Ask the device to enter update mode and wait for it to say it's ready.</li>
  <li><strong>DFU_BEGIN.</strong> Announce the incoming image: version, the four SKU bytes, total size, firmware type. This is where the SKU is stated on the wire.</li>
  <li><strong>DFU_CHUNK, repeated.</strong> Send the body in pieces from byte 64 onward, waiting for an ack each time.</li>
  <li><strong>DFU_PERFORM.</strong> Commit.</li>
  <li><strong>DFU_EXIT.</strong> Leave update mode. The device reboots into the new firmware.</li>
</ol>

One practical wrinkle: SysEx data bytes are only 7-bit clean, so 8-bit firmware bytes get repacked. Same Packed7 scheme the community sample tools already document.

If you want to watch it happen rather than take my word for it, wmealing has published [bring-up capture notes](https://wmealing.github.io/KO2-EP-133-midi-sysex-messages.html) and [KO2-SYSEX](https://github.com/wmealing/KO2-SYSEX) doing exactly this with a MIDI monitor, and it lines up with what the page's own code describes.

## Four bytes

I copied the official EP-40 2.5.1 package and changed four bytes at offsets 15–18. `00 08 00 06` → `00 08 00 01`. Nothing else. No decryption, no patching the body.

Then I sent it with the begin / chunk / perform / exit sequence above.

It rebooted as an EP-40.

<!-- FIG 9 -->
<figure>
  <div class="terminal">
    <div class="bar"><span class="dot"></span><span>mido: ports + identity after EP-40 flash</span></div>
<pre><span class="ok">inputs:</span>  ['EP-40']
<span class="ok">outputs:</span> ['EP-40']
<span class="dim"># identity reply (mido strips F0/F7):</span>
<span class="ok">7e 3c 06 02 00 20 76 20 00 06 00 00 00 00 00</span>
<span class="dim">#              ^^^^^ TE mfg     ^^^^^ &rarr; TE032AS006</span></pre>
  </div>
  <figcaption>
    Fig. 9 &middot; Host and MIDI identity both present the unit as EP-40 / <code>TE032AS006</code>.
    Decode with TE's own <code>format_te_sku</code> / <code>parseMidiIdentityResponse</code>, or with
    <a href="https://mido.readthedocs.io/">mido</a>.
  </figcaption>
</figure>

USB MIDI enumerated as `EP-40`. Universal identity came back `TE032AS006`. GREET still reported the same serial it always had — the serial is the hardware anchor and it doesn't move. Loop, multisample and Supertone all behaved like Riddim.

Four bytes. In a file on my own hard drive. That TE hands out to anyone.

## Where it actually stops

That's a host story, and it's worth being precise about how far it goes.

Offline, both 2.5.1 files parse as a babecafe wrapper around an MCUboot image with `IMAGE_F_ENCRYPTED_AES128`. The payload is ciphertext. The session AES key is wrapped with `ENC_EC256` (ECIES-P256). EP-133 and EP-40 share a `KEYHASH` — `d349a2d4…` — one device encryption public key for the family. Each image still carries its own wrapped session key, so you can't decrypt one blob using the other file.

The updater never decrypts anything on the host. It streams from offset 64. There's no read-back. `PERFORM` returning 0 means the bytes arrived, not that the bootloader liked them.

You can watch that distinction bite. EP-1320 Medieval 1.5.0 uses the same packaging and a **different** KEYHASH (`40e5051c…`). I tried it twice — once with the SKU rewritten to EP-40, once to my actual hardware SKU. Both times DFU looked perfectly happy on the wire. Both times the screen sat on **RDY** and GREET reported `mode:bootloader`.

Soft reject, not a brick; flashing a stock same-family `.tfw` from bootloader brings it back. But that's the real boundary. The SKU byte is a host-side *label*. The KEYHASH is device crypto. Rewriting the label gets you across products that share a key and nowhere at all across families that don't.

## What this does and doesn't mean

Narrow claim: on this update path, with TE032-family 2.5.1 packages that share a KEYHASH, changing the host-visible SKU was enough for one EP-133 to accept and boot an EP-40 body. Medieval shows where that stops. TE's NOR warning is the right default for your hardware, because all of this happened on mine.

Nobody got owned here. No server, no account, nobody else's data. My device, a file from a public CDN, and four bytes.

Product boundaries are real. On this path they just lived somewhere specific — a few header bytes and a string comparison in a web page, in front of a decrypt the host never sees.

## ep-unity

The companion tool is `ep-unity`. It rewrites the babecafe SKU to match whatever's connected, flashes over WebMIDI DFU, backs up and restores projects and samples, thins factory `.pak`s so you don't fill a 64&nbsp;MiB part, and watches for bootloader / `err sound` states after a transfer. It links TE firmware URLs from `releases.json`; it doesn't host TE's updater or any `.tfw` / `.pak` binaries.

Decrypting the app to actually reverse Supertone's DSP still needs a physical dump or the device ECIES private key. Project-format work can describe how Riddim *addresses* Supertone without opening the ciphertext — enough to author or strip projects, not enough to port the engines.

Two-thirds of the interesting failures showed up after this post's story ended: the OS downgrade that made the unit spam `ERR SoUnD` once a second, the 86 MB factory bank versus 64 MiB of NOR, `ERR SYSTEM_MODEL 58`. Those are in **[Part 2: everything that went wrong after I didn't stop](#)**.

## Disclosure

Responsible disclosure of the client-side SKU gate went to Teenage Engineering before any of this was public. Their EP-series team's response was the NOR density warning at the top, and it belongs there rather than as a footnote.

## Sources

TE's update page; `/apps/update/assets/index-CFniztty.js`; `/_software/releases.json`; the [OP Forums TE firmware header discussion](https://op-forums.com/t/custom-firmware-on-the-op-1/4283?page=44); wmealing's [KO2-EP-133 SysEx notes](https://wmealing.github.io/KO2-EP-133-midi-sysex-messages.html) and [KO2-SYSEX](https://github.com/wmealing/KO2-SYSEX); [ep133-krate](https://github.com/icherniukh/ep133-krate) and [ep133-ppak](https://github.com/ZacharySBrown/ep133-ppak) for Packed7 and protocol documentation; [ep133-export-to-daw](https://github.com/phones24/ep133-export-to-daw). Firmware files and TE's updater app are not redistributed here.

---

<!--
TITLE OPTIONS — pick one, kill the rest

1. My k.o. II boots as a riddim now. It took four bytes.        (outcome + tiny input; closest to the FIFA shape)
2. Four bytes decide which Teenage Engineering you bought.       (thesis as title; punchier, less "I")
3. Four bytes and a product line                                 (current; accurate, a little stiff)
4. I asked my sampler to be a different sampler and it said yes  (funniest, least searchable)

CUT LIST — things removed from the long version, in case you want any back
- Two opening callouts collapsed to one. The "how to read this" box goes away
  because the split makes it unnecessary.
- The methodology-defense paragraph ("So more than one thing differs...") went
  from 5 sentences to 2. You'd already earned the reader's trust by then.
- "Community references" section (4 bulleted repos) collapsed into one inline
  link where it's relevant + the Sources footer. Each entry was making the same
  point: protocol kinship, not an updater.
- Everything from "Downgrade, err sound" through "Crashes and MIDI" moved to Part 2.
- "Why write this down" merged into "What this does and doesn't mean" +
  the Disclosure section. It was saying the thing twice.
-->
