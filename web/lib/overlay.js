/**
 * Full-page busy overlay + post-flash device watch.
 *
 * Failure modes from live lab chat only (not research docs — those drift):
 * - RDY / mode:bootloader after foreign KEYHASH (Medieval) — DFU still works
 * - err sound 44 … — e.g. 2.0.5 vs newer FS; DFU/FILE deaf until SHIFT+ERASE
 * - err sound 24 … — Riddim/Supertone projects on EP-133 OS; same format fix
 * - ERR SYSTEM_MODEL … — user FS unhappy (often full NOR / bad restore); SHIFT+ERASE or free space
 * - mode:normal — healthy reboot
 */

/**
 * @typedef {{
 *   kind: 'ok' | 'bootloader_rdy' | 'err_sound' | 'system_model' | 'timeout' | 'waiting' | 'error',
 *   title: string,
 *   detail: string,
 *   steps?: string[],
 *   report?: { label: string, href: string },
 * }} DeviceDiagnosis
 */

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * @param {object} opts
 * @param {string} [opts.mode]
 * @param {string[]} [opts.debugTexts]
 * @param {string} [opts.greetSku]
 * @param {string} [opts.product]
 * @param {string} [opts.os]
 * @param {string} [opts.serial]
 * @param {boolean} [opts.medievalImage]
 * @param {boolean} [opts.timedOut]
 */
export function diagnoseDeviceState(opts = {}) {
  const debugTexts = opts.debugTexts || []
  const errLine = debugTexts.find((t) => /err\s+sound/i.test(t))
  if (errLine) {
    const is24 = /err\s+sound\s+24/i.test(errLine)
    const is44 = /err\s+sound\s+44/i.test(errLine)
    const steps = [
      'Power off. Hold SHIFT+ERASE, power on (formats the sound store).',
      'When Connect works again and the debug spam is gone, restore from your .pak backup if you still need the projects/samples.',
    ]
    if (is24) {
      steps.push(
        'err sound 24 on EP-133: Riddim/Supertone projects left on NOR — format clears them; strip Supertone before the next KO flash if you keep Riddim projects.',
      )
    }
    if (is44) {
      steps.push(
        'err sound 44 showed up after a 2.0.5 downgrade against a newer sound store — format, then flash the OS you want (stock 2.5.1 worked in the lab).',
      )
    }
    return {
      kind: 'err_sound',
      title: 'err sound loop',
      detail:
        `Device is spamming firmware debug SysEx (~1/s):\n“${errLine.trim()}”\n\n` +
        `Identity / FILE / DFU usually will not answer until the sound store is formatted.\n` +
        `Power-cycle alone often fails if the same projects reload.`,
      steps,
    }
  }

  const sysLine = debugTexts.find((t) => /SYSTEM[_\s-]?Mo?DEL/i.test(t))
  if (sysLine) {
    return {
      kind: 'system_model',
      title: 'ERR SYSTEM_MODEL',
      detail:
        `Device reported “${sysLine.trim()}”.\n\n` +
        `Same family of user-FS unhappiness as err sound loops — often a full NOR or a restore that overfilled the partition.`,
      steps: [
        'If MIDI still answers: delete samples / restore a smaller selection that fits free space.',
        'If it is looping or deaf: power off, hold SHIFT+ERASE, power on, then Connect and restore carefully.',
      ],
    }
  }

  const mode = (opts.mode || '').toLowerCase()
  if (mode === 'bootloader') {
    const medievalHint = opts.medievalImage
      ? ' A Medieval image on EP-133/40 is the usual cause (different KEYHASH) — wire DFU looks fine, then RDY forever.'
      : ' Often a foreign KEYHASH image (Medieval) or other reject after PERFORM.'
    return {
      kind: 'bootloader_rdy',
      title: 'bootloader · RDY',
      detail:
        `GREET reports mode:bootloader` +
        (opts.greetSku ? ` · ${opts.greetSku}` : '') +
        `.\nScreen is usually stuck on RDY.` +
        medievalHint +
        `\n\nMIDI/DFU still work; sample FILE does not.`,
      steps: [
        'Download a stock same-family .tfw for this hardware from TE (link in the recovery banner — we only list URLs).',
        'Drop that .tfw below, check the risks, and flash. That is how we left RDY before.',
        'You bring the file — this tool does not fetch TE binaries.',
      ],
    }
  }

  if (mode === 'normal') {
    return {
      kind: 'ok',
      title: 'back online · normal mode',
      detail:
        [
          opts.product || 'EP',
          opts.greetSku || '',
          opts.os ? `os ${opts.os}` : '',
          opts.serial ? `serial ${opts.serial}` : '',
        ]
          .filter(Boolean)
          .join(' · ') + '. MIDI answered GREET.',
      steps: [],
    }
  }

  if (opts.timedOut) {
    return {
      kind: 'timeout',
      title: 'still waiting',
      detail:
        'No clean GREET after the flash window. Port may still be rebooting, or the unit is in a state we only see as silence / debug spam.',
      steps: [
        'Watch the device screen: RDY → use the bootloader recovery banner (download stock .tfw → drop → flash).',
        'ERR SOUND … → SHIFT+ERASE on power-on, then Connect again.',
        'If the port never returns, try another USB-C cable/port, then Connect.',
      ],
    }
  }

  return {
    kind: 'waiting',
    title: 'Waiting for device…',
    detail: 'Listening for MIDI / GREET / debug frames…',
    steps: [],
  }
}

export function createBusyOverlay() {
  const root = document.getElementById('busy-overlay')
  const titleEl = document.getElementById('busy-title')
  const detailEl = document.getElementById('busy-detail')
  const barEl = document.getElementById('busy-bar')
  const pctEl = document.getElementById('busy-pct')
  const stepsEl = document.getElementById('busy-steps')
  const dismissBtn = document.getElementById('busy-dismiss')
  const cancelBtn = document.getElementById('busy-cancel')
  const barWrap = document.getElementById('busy-bar-wrap')

  const card = root?.querySelector('.busy-card')
  const page = document.querySelector('.page')

  let blocking = false
  /** @type {Element | null} */
  let returnFocusTo = null

  /**
   * The overlay claimed aria-modal="true" while only pointer-events were blocked,
   * so Tab still walked into the risk checkboxes and hex toggles underneath —
   * telling screen readers the background was inert while it very much wasn't.
   * `inert` makes the claim true: no focus, no pointer, hidden from AT.
   */
  /** Screen readers get nothing from a styled div; announce the real number. */
  function setBarValue(pct) {
    if (!barWrap) return
    if (pct == null) barWrap.removeAttribute('aria-valuenow')
    else barWrap.setAttribute('aria-valuenow', String(Math.round(Math.max(0, Math.min(100, pct)))))
  }

  function lockBackground(locked) {
    document.body.classList.toggle('busy-locked', locked)
    if (page) page.inert = locked
  }

  function onKeydown(e) {
    if (e.key !== 'Tab' || !root || root.hidden) return
    const focusable = [...root.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.hidden && !el.disabled)
    if (!focusable.length) {
      // Nothing to move to during a transfer — keep focus pinned to the card.
      e.preventDefault()
      card?.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  document.addEventListener('keydown', onKeydown, true)

  function show({ title, detail = '', pct = null, indeterminate = false, onCancel = null } = {}) {
    if (!root) return
    blocking = true
    if (root.hidden) returnFocusTo = document.activeElement
    root.hidden = false
    lockBackground(true)
    card?.focus()
    if (titleEl) titleEl.textContent = title || 'Working…'
    if (detailEl) detailEl.textContent = detail
    if (stepsEl) {
      stepsEl.hidden = true
      stepsEl.replaceChildren()
    }
    if (dismissBtn) dismissBtn.hidden = true
    if (cancelBtn) {
      cancelBtn.hidden = !onCancel
      cancelBtn.disabled = false
      cancelBtn.onclick = onCancel
        ? () => {
            cancelBtn.disabled = true
            cancelBtn.textContent = 'cancelling…'
            onCancel()
          }
        : null
      cancelBtn.textContent = 'cancel'
    }
    if (barWrap) barWrap.hidden = false
    if (barEl) {
      barEl.classList.toggle('indeterminate', !!indeterminate && pct == null)
      if (pct != null) {
        barEl.style.width = `${Math.max(0, Math.min(100, pct))}%`
        barEl.classList.remove('indeterminate')
      } else if (indeterminate) {
        barEl.style.width = '30%'
      }
    }
    if (pctEl) {
      pctEl.textContent = pct != null ? `${Math.round(pct)}%` : ''
    }
    setBarValue(pct)
  }

  function update({ title, detail, pct, indeterminate } = {}) {
    if (!root || root.hidden) return
    if (title != null && titleEl) titleEl.textContent = title
    if (detail != null && detailEl) detailEl.textContent = detail
    if (pct != null && barEl) {
      barEl.classList.remove('indeterminate')
      barEl.style.width = `${Math.max(0, Math.min(100, pct))}%`
      if (pctEl) pctEl.textContent = `${Math.round(pct)}%`
      setBarValue(pct)
    } else if (indeterminate && barEl) {
      barEl.classList.add('indeterminate')
      if (pctEl) pctEl.textContent = ''
      setBarValue(null)
    }
  }

  /** @param {DeviceDiagnosis} diagnosis */
  function finish(diagnosis) {
    if (!root) return
    blocking = diagnosis.kind === 'waiting'
    if (titleEl) titleEl.textContent = diagnosis.title
    if (detailEl) detailEl.textContent = diagnosis.detail
    if (barWrap) barWrap.hidden = true
    if (pctEl) pctEl.textContent = ''
    if (stepsEl) {
      stepsEl.replaceChildren()
      const steps = diagnosis.steps || []
      const report = diagnosis.report
      if (steps.length || report) {
        stepsEl.hidden = false
        for (const s of steps) {
          const li = document.createElement('li')
          li.textContent = s
          stepsEl.append(li)
        }
        // Outcome reports are the project's whole evidence base, so ask for one
        // on every result — a flash that worked is as useful as one that didn't.
        if (report) {
          const li = document.createElement('li')
          const a = document.createElement('a')
          a.href = report.href
          a.textContent = report.label
          a.target = '_blank'
          a.rel = 'noopener noreferrer'
          li.append(a)
          stepsEl.append(li)
        }
      } else {
        stepsEl.hidden = true
      }
    }
    if (cancelBtn) {
      cancelBtn.hidden = true
      cancelBtn.onclick = null
    }
    if (dismissBtn) {
      dismissBtn.hidden = false
      dismissBtn.textContent = diagnosis.kind === 'ok' ? 'continue' : 'dismiss'
      dismissBtn.focus()
    }
    if (
      diagnosis.kind === 'ok' ||
      diagnosis.kind === 'bootloader_rdy' ||
      diagnosis.kind === 'err_sound' ||
      diagnosis.kind === 'system_model' ||
      diagnosis.kind === 'timeout' ||
      diagnosis.kind === 'error'
    ) {
      blocking = false
      // Keep overlay until dismiss so they read the help; page stays locked under it.
      lockBackground(true)
    }
  }

  /**
   * Passive watch after flash: wait for port drop/return, collect debug spam, GREET when possible.
   * @param {object} opts
   * @param {MIDIAccess} opts.access
   * @param {(access: MIDIAccess) => Promise<{mode?:string,sku?:string,product?:string,os?:string,serial?:string}|null>} opts.tryConnect
   * @param {(data: Uint8Array) => {text:string}|null} opts.parseDebug
   * @param {(ports: {inputs:number,outputs:number}) => void} [opts.onTick]
   * @param {boolean} [opts.medievalImage]
   * @param {number} [opts.timeoutMs]
   * @returns {Promise<DeviceDiagnosis>}
   */
  async function watchAfterFlash(opts) {
    const {
      access,
      tryConnect,
      parseDebug,
      onTick,
      medievalImage = false,
      timeoutMs = 90000,
    } = opts
    const debugTexts = []
    const seenDebug = new Set()
    const start = Date.now()
    let sawEmpty = false
    let attached = new WeakSet()

    const onMidi = (e) => {
      const data = new Uint8Array(e.data)
      const dbg = parseDebug(data)
      if (!dbg?.text) return
      const key = dbg.text.trim()
      if (!key || seenDebug.has(key)) return
      seenDebug.add(key)
      debugTexts.push(key)
    }

    const attachAll = () => {
      access.inputs.forEach((input) => {
        if (attached.has(input)) return
        attached.add(input)
        input.addEventListener('midimessage', onMidi)
      })
    }
    attachAll()
    const onState = () => attachAll()
    access.addEventListener('statechange', onState)

    try {
      while (Date.now() - start < timeoutMs) {
        const inputs = [...access.inputs.values()].filter((p) => /EP-133|EP-40|EP-1320/i.test(p.name || ''))
        const outputs = [...access.outputs.values()].filter((p) => /EP-133|EP-40|EP-1320/i.test(p.name || ''))
        onTick?.({ inputs: inputs.length, outputs: outputs.length })

        if (!inputs.length || !outputs.length) {
          sawEmpty = true
          if (debugTexts.length) {
            const early = diagnoseDeviceState({ debugTexts, medievalImage })
            if (early.kind === 'err_sound' || early.kind === 'system_model') return early
          }
          await sleep(400)
          continue
        }

        // Prefer waiting until we've seen the port disappear once (true reboot).
        if (!sawEmpty && Date.now() - start < 4000) {
          await sleep(300)
          continue
        }

        if (debugTexts.length) {
          const fromDebug = diagnoseDeviceState({ debugTexts, medievalImage })
          if (fromDebug.kind === 'err_sound' || fromDebug.kind === 'system_model') return fromDebug
        }

        const device = await tryConnect(access).catch(() => null)
        if (device) {
          return diagnoseDeviceState({
            mode: device.mode,
            greetSku: device.sku,
            product: device.product,
            os: device.os,
            serial: device.serial,
            debugTexts,
            medievalImage,
          })
        }

        await sleep(800)
      }

      return diagnoseDeviceState({
        debugTexts,
        medievalImage,
        timedOut: true,
      })
    } finally {
      access.removeEventListener('statechange', onState)
      access.inputs.forEach((input) => {
        input.removeEventListener('midimessage', onMidi)
      })
    }
  }

  function hide() {
    if (!root) return
    blocking = false
    root.hidden = true
    lockBackground(false)
    if (stepsEl) {
      stepsEl.hidden = true
      stepsEl.replaceChildren()
    }
    if (dismissBtn) dismissBtn.hidden = true
    if (cancelBtn) {
      cancelBtn.hidden = true
      cancelBtn.onclick = null
    }
    if (returnFocusTo instanceof HTMLElement && document.contains(returnFocusTo)) {
      returnFocusTo.focus()
    }
    returnFocusTo = null
  }

  dismissBtn?.addEventListener('click', () => hide())

  return {
    show,
    update,
    finish,
    hide,
    watchAfterFlash,
    get blocking() {
      return blocking || (!!root && !root.hidden && dismissBtn?.hidden)
    },
    get visible() {
      return !!root && !root.hidden
    },
  }
}
