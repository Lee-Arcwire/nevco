/* ====================================================================
   Nevco 4770 Hockey Scoreboard Emulator — MPCW-7 controller logic.

   Control model (matches the real MPCW-7):
     - SET key toggles SET mode. In SET mode pressing a field key
       (TIME / PERIOD / HOME SCORE / GUEST SCORE / GOAL SHOTS / GOAL SAVES)
       arms a numeric entry. Type digits, then ENTER to apply, CANCEL
       to abort.
     - Outside SET mode the same field keys directly increment.
     - TIME ON / TIME OFF start / stop the game clock (separate keys).
     - NEW MINOR / NEW MAJOR arms a manual penalty entry for that team:
       type 2-digit player # (leading zero if a single digit), then
       4-digit penalty time MMSS (leading zero if < 10 minutes), then
       ENTER to commit. The minor / major label is recorded but no
       longer auto-fills the time.
     - INSERT PENALTY waits for a team key (column 2 = HOME, column 3
       = GUEST), then the same 2-digit player # / 4-digit MMSS / ENTER
       sequence.
     - CLEAR PENALTY waits for team key, then 1 or 2 to clear that slot.
     - PENALTY ON / OFF pauses / resumes penalty countdown.
     - HORN is press-and-hold (manual horn). Auto-horn fires at clock 0.
     - HOME SCORE / GUEST SCORE +1 also lights the GOAL light briefly;
       GOAL LIGHT RESET clears it immediately.
     - OPTIONS / SCROLL PROFILES / TIME OF DAY / BLANK are stub
       indicators that flash on the LED.

   Clock display: MM:SS when >= 1:00, SS.T (with tenths) when < 1:00.
   Penalty countdowns: only the first two of each team's queue count
   down while the clock is running and not paused.

   Keyboard:
     - Space      emulates the toggle switch: start / stop the clock
     - H          horn (press and hold)
     - 0-9        numeric entry
     - Enter / Esc commit / cancel a SET-armed entry
     - Backspace  delete a digit from the entry buffer
   ==================================================================== */

(() => {
  'use strict';

  // ---------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------

  const PERIOD_DEFAULT_MS = 20 * 60 * 1000;
  const MAX_SCORE = 99;
  const MAX_PERIOD = 9;
  const MAX_SHOTS = 99;
  const MAX_SAVES = 99;
  const MAX_TOL = 9;
  const MAX_PENALTY_QUEUE = 6;
  const FLASH_MS = 1200;
  const GOAL_LIGHT_MS = 4000;
  const AUTO_HORN_MS = 3000;

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------

  const state = {
    home:  { score: 0, shots: 0, saves: 0, tol: 1, penalties: [] },
    guest: { score: 0, shots: 0, saves: 0, tol: 1, penalties: [] },
    period: 1,
    timeMs: PERIOD_DEFAULT_MS,
    clockRunning: false,
    hornOn: false,
    hornManual: false,
    autoHornUntil: 0,
    setMode: false,         // true when SET has been pressed (awaits a field)
    entry: null,            // current numeric-entry context
    buffer: '',             // digits typed (game entry OR menu edit)
    penaltyPaused: false,
    blanked: false,
    goalLightUntil: 0,
    flash: null,            // transient LED message
    flashUntil: 0,
    // Persisted OPTIONS menu values. Saved to localStorage on change.
    // See MPC7_Hockey_135-0222.PDF for the menu structure these mirror.
    options: {
      penaltyButtonEnabled: true,    // Penalties > Enable Button
      minorPenaltyMs:       2 * 60 * 1000,
      majorPenaltyMs:       5 * 60 * 1000,
      countDown:            true,    // Main Time > Direction (true = down)
      autoHorn:             true,    // Main Time > Auto Horn
      disableTenths:        false,   // Main Time > Disable .1
      brightness:           'High',  // Brightness ('High' | 'Low')
      // Segment Timer: up to 20 settable segments, plus a "current" pointer
      // that the per-slot menu leaves read / write. Live segment-running
      // behaviour is not yet wired - the menu just persists the values.
      segmentEnabled:       false,
      segmentDispOnBoard:   false,
      currentSegIdx:        0,
      segments: Array.from({ length: 20 }, () => ({
        timeMs:      60 * 1000,
        autoHorn:    false,
        autoAdvance: false,
      })),
      // Time Out Timer: 5 individually settable timers, each with its own
      // warning time. As above, the live countdown isn't wired yet.
      timeOutDispOnBoard:   false,
      currentTimeOutIdx:    0,
      timeOuts: Array.from({ length: 5 }, () => ({
        timeMs:    60 * 1000,
        warningMs:  5 * 1000,
      })),
      // Stubbed menu values - persisted but no live behavior yet.
      // (See the MPC7 hockey manual for the intended semantics; this just
      // mirrors the menu structure so every option has a place to live.)
      intervalHornEnabled:  false,
      intervalHornMs:       60 * 1000,
      displayShotSave:      true,
      shotBlankUnderMain:   false,
      scs1TimeMs:           30 * 1000,
      scs2TimeMs:           15 * 1000,
      hhsFunction:          'Goal Light',  // | 'Shot Clock'
      homeName:             'HOME',
      guestName:            'GUESTS',
      defaultProfileLock:   true,
      auxTimeMs:            0,
      auxCountDown:         true,
      auxTimeSwitch:        false,
      auxStopTimeMs:        0,
      auxStyle:             'MM:SS',       // | 'HH:MM'
      auxDisplay:           'Main',        // | 'Aux' | 'TOD'
      hornVolume:           5,
      hornEopTone:          1,
      hornKeyTone:          1,
      hornAuxTone:          1,
      hornTimeOutTone:      1,
      hornSegmentTone:      1,
    },
    // OPTIONS menu navigation state. null when no menu is open.
    menu: null,
  };

  // Entry contexts:
  //   { kind: 'clock' }
  //   { kind: 'period' }
  //   { kind: 'score',  team }
  //   { kind: 'shots',  team }
  //   { kind: 'saves',  team }
  //   { kind: 'tol',    team }
  //   { kind: 'penalty', team, phase: 'player'|'time', player, duration }
  //   { kind: 'await-team',  then: 'insert-penalty' | 'clear-penalty' | 'edit-penalty' | 'view-penalty' }
  //   { kind: 'clear-slot',  team }

  // ---------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------

  const $ = (id) => document.getElementById(id);

  const els = {
    homeScore:  $('home-score'),
    guestScore: $('guest-score'),
    homeShots:  $('home-shots'),
    guestShots: $('guest-shots'),
    period:     $('period'),
    time:       $('time'),
    timeBg:     $('time-bg'),
    led:        $('led-text'),
    setBtn:     $('set-button'),
    hornButton: $('horn-button'),
    homePen: [
      { player: $('home-pen1-player'),  time: $('home-pen1-time')  },
      { player: $('home-pen2-player'),  time: $('home-pen2-time')  },
    ],
    guestPen: [
      { player: $('guest-pen1-player'), time: $('guest-pen1-time') },
      { player: $('guest-pen2-player'), time: $('guest-pen2-time') },
    ],
  };

  // ---------------------------------------------------------------
  // Audio (horn)
  // ---------------------------------------------------------------

  let audioCtx = null;
  let hornNodes = null;

  function ensureAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }

  function startHorn() {
    ensureAudio();
    if (!audioCtx || hornNodes) return;
    const now = audioCtx.currentTime;
    const osc1 = audioCtx.createOscillator();
    const osc2 = audioCtx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = 220;
    osc2.type = 'square';
    osc2.frequency.value = 145;
    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    gain.gain.linearRampToValueAtTime(0.18, now + 0.04);
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(audioCtx.destination);
    osc1.start();
    osc2.start();
    hornNodes = { osc1, osc2, gain };
  }

  function stopHorn() {
    if (!hornNodes || !audioCtx) return;
    const { osc1, osc2, gain } = hornNodes;
    const now = audioCtx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + 0.06);
    osc1.stop(now + 0.08);
    osc2.stop(now + 0.08);
    hornNodes = null;
  }

  // ---------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------

  function pad2(n) { return String(n).padStart(2, '0'); }

  function formatClock(ms) {
    if (ms < 0) ms = 0;
    // OPTIONS > Main Time > Disable .1: forces MM:SS regardless of remaining.
    if (state.options.disableTenths || ms >= 60 * 1000) {
      const total = Math.ceil(ms / 1000);
      const m = Math.floor(total / 60);
      const s = total % 60;
      return `${pad2(m)}:${pad2(s)}`;
    }
    const total = Math.floor(ms / 100); // tenths
    const s = Math.floor(total / 10);
    const t = total % 10;
    return `${pad2(s)}.${t}`;
  }

  function formatPenaltyTime(ms) {
    // Nevco 4760 shows penalty time as M:SS (no leading zero on minutes).
    if (ms <= 0) return '0:00';
    const total = Math.ceil(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${pad2(s)}`;
  }

  function parseTimeDigits(digits) {
    if (!digits) return null;
    const n = parseInt(digits, 10);
    if (Number.isNaN(n)) return null;
    let mins, secs;
    if (digits.length <= 2) {
      mins = 0;
      secs = n;
    } else {
      mins = Math.floor(n / 100);
      secs = n % 100;
    }
    if (secs > 59) return null;
    return (mins * 60 + secs) * 1000;
  }

  function previewTime(digits) {
    if (!digits) return '--:--';
    const ms = parseTimeDigits(digits);
    if (ms == null) return '??:??';
    return formatPenaltyTime(ms);
  }

  // 5-digit MM:SS.s parser, used by Segment Timer and Time Out Timer
  // entries (per the manual: "Enter the minutes, seconds, and 10th of
  // seconds").
  function parseTimeDigits5(digits) {
    if (!digits || digits.length !== 5) return null;
    const m = parseInt(digits.slice(0, 2), 10);
    const s = parseInt(digits.slice(2, 4), 10);
    const t = parseInt(digits.slice(4, 5), 10);
    if (Number.isNaN(m) || Number.isNaN(s) || Number.isNaN(t)) return null;
    if (s > 59 || t > 9) return null;
    return m * 60000 + s * 1000 + t * 100;
  }

  function formatTime5(ms) {
    if (ms <= 0) return '0:00.0';
    const total = Math.max(0, Math.floor(ms / 100)); // tenths
    const m = Math.floor(total / 600);
    const s = Math.floor((total % 600) / 10);
    const t = total % 10;
    return `${m}:${pad2(s)}.${t}`;
  }

  function previewTime5(digits) {
    if (!digits) return '--:--.-';
    const ms = parseTimeDigits5(digits.padEnd(5, '0'));
    if (ms == null) return '??:??.?';
    return formatTime5(ms);
  }

  function formatWallClock() {
    const d = new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}.${pad2(d.getSeconds())}`;
  }

  // ---------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------

  function renderScoreboard() {
    // The 4760 face does not show T.O.L. or horn/goal indicator lights, so
    // those state fields exist but are not rendered.
    if (state.blanked) {
      els.homeScore.textContent  = '';
      els.guestScore.textContent = '';
      els.homeShots.textContent  = '';
      els.guestShots.textContent = '';
      els.period.textContent     = '';
      els.time.textContent       = '';
      els.homePen.forEach(p => { p.player.textContent = ''; p.time.textContent = ''; });
      els.guestPen.forEach(p => { p.player.textContent = ''; p.time.textContent = ''; });
    } else {
      els.homeScore.textContent  = pad2(state.home.score);
      els.guestScore.textContent = pad2(state.guest.score);
      els.homeShots.textContent  = pad2(state.home.shots);
      els.guestShots.textContent = pad2(state.guest.shots);
      els.period.textContent     = String(state.period);
      els.time.textContent       = formatClock(state.timeMs);
      els.timeBg.textContent     = state.timeMs < 60 * 1000 ? '88.8' : '88:88';
      renderPenaltySlots(els.homePen,  state.home.penalties);
      renderPenaltySlots(els.guestPen, state.guest.penalties);
    }
  }

  function renderPenaltySlots(slots, penalties) {
    for (let i = 0; i < slots.length; i++) {
      const p = penalties[i];
      if (p) {
        slots[i].player.textContent = pad2(p.player);
        slots[i].time.textContent   = formatPenaltyTime(p.remainingMs);
      } else {
        slots[i].player.textContent = '--';
        slots[i].time.textContent   = '0:00';
      }
    }
  }

  function renderController() {
    // Light up the SET hotspot when armed
    if (els.setBtn) {
      els.setBtn.classList.toggle('armed', state.setMode && !state.entry);
    }

    // OPTIONS > Brightness toggles dim variants of the LED colours.
    document.body.classList.toggle('brightness-low', state.options.brightness === 'Low');

    // LED text
    els.led.textContent = ledText();

    // Highlight armed dedicated hotspot
    document.querySelectorAll('.hot.armed').forEach(k => {
      if (k !== els.setBtn) k.classList.remove('armed');
    });
    if (state.entry) {
      const sel = entryToKey(state.entry);
      if (sel) {
        const el = document.querySelector(sel);
        if (el) el.classList.add('armed');
      }
    }
  }

  function entryToKey(entry) {
    switch (entry.kind) {
      case 'clock':    return '[data-action="time-field"]';
      case 'period':   return '[data-action="period"]';
      case 'score':    return `[data-action="score"][data-team="${entry.team}"]`;
      case 'shots':    return `[data-action="goal-shots"][data-team="${entry.team}"]`;
      case 'saves':    return `[data-action="goal-saves"][data-team="${entry.team}"]`;
      case 'penalty':
        if (entry.kindType === 'minor') return `[data-action="new-minor"][data-team="${entry.team}"]`;
        if (entry.kindType === 'major') return `[data-action="new-major"][data-team="${entry.team}"]`;
        return '[data-action="insert-penalty"]';
      case 'await-team':  return `[data-action="${entry.then}"]`;
      case 'clear-slot':  return '[data-action="clear-penalty"]';
      default: return null;
    }
  }

  function ledText() {
    if (state.flash && Date.now() < state.flashUntil) return state.flash;
    if (state.blanked) return 'BLANK';
    if (state.menu) return menuLedText();
    if (!state.entry) {
      if (state.setMode) return 'SET';
      if (state.clockRunning) return formatClock(state.timeMs);
      return formatClock(state.timeMs);
    }
    const e = state.entry;
    const buf = state.buffer || '';
    switch (e.kind) {
      case 'clock':   return `CLK ${buf ? previewTime(buf) : '--:--'}`;
      case 'period':  return `PER ${buf || '-'}`;
      case 'score':   return `${e.team === 'home' ? 'HSC' : 'GSC'} ${buf.padStart(2, '-')}`;
      case 'shots':   return `${e.team === 'home' ? 'HSH' : 'GSH'} ${buf.padStart(2, '-')}`;
      case 'saves':   return `${e.team === 'home' ? 'HSV' : 'GSV'} ${buf.padStart(2, '-')}`;
      case 'tol':     return `${e.team === 'home' ? 'HTO' : 'GTO'} ${buf || '-'}`;
      case 'penalty':
        if (e.phase === 'player') {
          return `${e.team === 'home' ? 'HPN' : 'GPN'} P ${buf.padStart(2, '-')}`;
        }
        return `${e.team === 'home' ? 'HPN' : 'GPN'} ${pad2(e.player)} ${previewTime(buf)}`;
      case 'await-team':
        return 'SEL TEAM';
      case 'clear-slot':
        return `CLR ${e.team === 'home' ? 'H' : 'G'} ${buf || '?'}`;
    }
    return 'READY';
  }

  function menuLedText() {
    const m = state.menu;
    const top = OPTIONS_MENU[m.topIdx];
    // Sub-menu suffix on labels with items - matches the manual's "Penalties >>"
    const arrow = (it) => it.items ? ` >>` : '';

    if (m.subIdx == null) {
      if (top.type === 'cycle') return `${itemLabel(top)}: ${top.get()}`;
      return `${itemLabel(top)}${arrow(top)}`;
    }

    const item = top.items[m.subIdx];
    const lbl = itemLabel(item);
    const buf = state.buffer || '';
    if (m.editing === 'time4')   return `${lbl} ${previewTime(buf)}◄`;
    if (m.editing === 'time5')   return `${lbl} ${previewTime5(buf)}◄`;
    if (m.editing === 'digit')   return `${lbl}: ${buf || '_'}◄`;
    if (m.editing === 'numeric') return `${lbl} ${buf || '_'}◄`;

    if (item.type === 'toggle')  return item.get() ? `${lbl}*` : lbl;
    if (item.type === 'arrow')   return `${lbl}: ${item.get() ? '▼' : '▲'}`;
    if (item.type === 'time4')   return `${lbl} ${formatPenaltyTime(item.get())}`;
    if (item.type === 'time5')   return `${lbl} ${formatTime5(item.get())}`;
    if (item.type === 'digit')   return `${lbl}: ${item.get()}`;
    if (item.type === 'numeric') return `${lbl} ${item.get()}`;
    return lbl;
  }

  // ---------------------------------------------------------------
  // Tick loop
  // ---------------------------------------------------------------

  let lastTick = performance.now();

  function tick(now) {
    const dt = now - lastTick;
    lastTick = now;

    if (state.clockRunning) {
      // Segment Timer overrides Main Time > Direction: segments always
      // count down per the manual. The Direction option only applies to
      // the regular game clock.
      const countingDown = state.options.segmentEnabled || state.options.countDown;
      if (countingDown) {
        state.timeMs -= dt;
        if (state.timeMs <= 0) {
          state.timeMs = 0;
          if (state.options.segmentEnabled) {
            handleSegmentEnd();
          } else {
            state.clockRunning = false;
            if (state.options.autoHorn) state.autoHornUntil = Date.now() + AUTO_HORN_MS;
          }
        }
      } else {
        state.timeMs += dt;
      }
      if (!state.penaltyPaused) {
        tickPenalties(state.home.penalties,  dt);
        tickPenalties(state.guest.penalties, dt);
      }
    }

    const autoActive = Date.now() < state.autoHornUntil;
    const desired = state.hornManual || autoActive;
    if (desired && !state.hornOn) {
      state.hornOn = true;
      startHorn();
    } else if (!desired && state.hornOn) {
      state.hornOn = false;
      stopHorn();
    }

    renderScoreboard();
    renderController();
    requestAnimationFrame(tick);
  }

  function tickPenalties(arr, dt) {
    if (!arr.length) return;
    const active = Math.min(2, arr.length);
    for (let i = 0; i < active; i++) arr[i].remainingMs -= dt;
    while (arr.length && arr[0].remainingMs <= 0) arr.shift();
  }

  // ---------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------

  function cancelEntry() {
    state.entry = null;
    state.buffer = '';
  }

  function arm(entry) {
    state.entry = entry;
    state.buffer = '';
  }

  function bump(team, field, delta, max) {
    const obj = state[team];
    obj[field] = Math.max(0, Math.min(max, obj[field] + delta));
  }

  function flashLed(msg, ms = FLASH_MS) {
    state.flash = msg;
    state.flashUntil = Date.now() + ms;
  }

  function pressSet() {
    if (state.entry) {
      cancelEntry();
    }
    state.setMode = !state.setMode;
  }

  // Segment Timer: load the current segment's time into state.timeMs.
  // 0:00 slots are treated as "unused" per the manual and skipped over.
  // Returns true if a non-zero segment was loaded.
  function loadActiveSegment() {
    const segs = state.options.segments;
    for (let i = 0; i < segs.length; i++) {
      const j = (state.options.currentSegIdx + i) % segs.length;
      if (segs[j].timeMs > 0) {
        if (j !== state.options.currentSegIdx) {
          state.options.currentSegIdx = j;
          persistOptions();
        }
        state.timeMs = segs[j].timeMs;
        return true;
      }
    }
    return false;
  }

  // Called when the segment clock reaches 0:00. Fires Auto Horn for that
  // segment if enabled, then advances to the next non-zero segment if
  // Auto Advance is enabled (otherwise pauses the clock at 0).
  function handleSegmentEnd() {
    const seg = state.options.segments[state.options.currentSegIdx];
    if (seg.autoHorn) state.autoHornUntil = Date.now() + AUTO_HORN_MS;
    if (!seg.autoAdvance) {
      state.clockRunning = false;
      return;
    }
    const segs = state.options.segments;
    for (let i = 1; i <= segs.length; i++) {
      const idx = (state.options.currentSegIdx + i) % segs.length;
      if (segs[idx].timeMs > 0) {
        state.options.currentSegIdx = idx;
        state.timeMs = segs[idx].timeMs;
        persistOptions();
        return;
      }
    }
    // No other non-zero segment in the project - hold at 0.
    state.clockRunning = false;
  }

  function pressTimeOn() {
    cancelEntry();
    state.setMode = false;
    // Segment Timer: a fresh start (timeMs at 0) loads the active segment.
    if (state.options.segmentEnabled && state.timeMs <= 0) {
      if (!loadActiveSegment()) { flashLed('NO SEG'); return; }
    }
    if (state.timeMs <= 0) {
      flashLed('NO TIME');
      return;
    }
    state.clockRunning = true;
  }

  function pressTimeOff() {
    cancelEntry();
    state.setMode = false;
    state.clockRunning = false;
  }

  function pressTimeField() {
    // Only acts as "edit clock time" in SET mode (matches the photo's note).
    if (!state.setMode) {
      flashLed('PRESS SET');
      return;
    }
    if (state.clockRunning) {
      flashLed('STOP CLK');
      return;
    }
    arm({ kind: 'clock' });
  }

  function pressPeriod() {
    if (state.setMode) {
      arm({ kind: 'period' });
    } else {
      cancelEntry();
      state.period = Math.min(MAX_PERIOD, state.period + 1);
      state.timeMs = PERIOD_DEFAULT_MS;
      state.clockRunning = false;
      flashLed(`PER ${state.period}`);
    }
  }

  function pressScore(team) {
    if (state.setMode) {
      arm({ kind: 'score', team });
    } else {
      cancelEntry();
      bump(team, 'score', +1, MAX_SCORE);
      state.goalLightUntil = Date.now() + GOAL_LIGHT_MS;
      flashLed(`${team === 'home' ? 'H' : 'G'}-GOAL`);
    }
  }

  function pressShots(team) {
    if (state.setMode) {
      arm({ kind: 'shots', team });
    } else {
      cancelEntry();
      bump(team, 'shots', +1, MAX_SHOTS);
    }
  }

  function pressSaves(team) {
    if (state.setMode) {
      arm({ kind: 'saves', team });
    } else {
      cancelEntry();
      bump(team, 'saves', +1, MAX_SAVES);
      flashLed(`${team === 'home' ? 'H' : 'G'}-SV ${pad2(state[team].saves)}`);
    }
  }

  function pressNewPenalty(team, kind /* 'minor' | 'major' */) {
    if (state[team].penalties.length >= MAX_PENALTY_QUEUE) {
      flashLed('PEN FULL');
      return;
    }
    // Operator types the penalty in order:
    //   (1) 2-digit player # (leading zero required for single-digit #)
    //   (2) 4-digit penalty time MMSS (leading zero required for < 10 min)
    //   (3) ENTER to commit
    // After the second digit the entry auto-advances from the player phase
    // to the time phase. The minor/major distinction is recorded but no
    // longer auto-fills the time.
    arm({
      kind: 'penalty',
      team,
      phase: 'player',
      kindType: kind,
      player: null,
    });
  }

  function pressInsertPenalty() {
    arm({ kind: 'await-team', then: 'insert-penalty' });
  }

  function pressClearPenalty() {
    arm({ kind: 'await-team', then: 'clear-penalty' });
  }

  function pressViewPenalty() {
    // Briefly summarise penalty queue on the LED
    const h = state.home.penalties;
    const g = state.guest.penalties;
    if (!h.length && !g.length) {
      flashLed('NO PEN', 1500);
      return;
    }
    const fmt = (p, tag) => `${tag}${pad2(p.player)}-${formatPenaltyTime(p.remainingMs)}`;
    if (h.length) flashLed(fmt(h[0], 'H'), 1500);
    else flashLed(fmt(g[0], 'G'), 1500);
  }

  function pressEditPenalty() {
    arm({ kind: 'await-team', then: 'edit-penalty' });
  }

  function pressPenaltyOnOff() {
    // OPTIONS > Penalties > Enable Button gates this key. When disabled
    // the controller ignores it (per the manual: used in little-league
    // games where the operator never wants to pause penalty countdowns).
    if (!state.options.penaltyButtonEnabled) {
      flashLed('PEN BTN OFF');
      return;
    }
    state.penaltyPaused = !state.penaltyPaused;
    flashLed(state.penaltyPaused ? 'PEN OFF' : 'PEN ON');
  }

  function pressTeam(team) {
    const e = state.entry;
    if (!e || e.kind !== 'await-team') {
      // Outside of a team-pending action, HOME / GUESTS keys flash the team name
      flashLed(team === 'home' ? 'HOME' : 'GUESTS');
      return;
    }
    switch (e.then) {
      case 'insert-penalty':
        arm({ kind: 'penalty', team, phase: 'player', player: null });
        break;
      case 'clear-penalty':
        arm({ kind: 'clear-slot', team });
        break;
      case 'edit-penalty':
        // Edit: replace slot 1's duration for that team via new MMSS entry.
        // (Real device walks through full edit flow; this is a simplification.)
        if (!state[team].penalties.length) {
          flashLed('NO PEN');
          cancelEntry();
          return;
        }
        arm({ kind: 'penalty', team, phase: 'time', player: state[team].penalties[0].player, edit: true });
        break;
      default:
        cancelEntry();
    }
  }

  function pressNum(d) {
    if (pressMenuNum(d)) return;
    const e = state.entry;
    if (!e) return;
    if (e.kind === 'await-team') return;
    if (e.kind === 'clear-slot') {
      const slot = parseInt(d, 10);
      if (slot === 1 || slot === 2) {
        const arr = state[e.team].penalties;
        if (arr[slot - 1]) {
          arr.splice(slot - 1, 1);
          flashLed(`CLR ${e.team === 'home' ? 'H' : 'G'}${slot}`);
        } else {
          flashLed('NO PEN');
        }
        cancelEntry();
      }
      return;
    }
    // Penalty entry uses fixed-width fields and auto-advances from the
    // 2-digit player phase to the 4-digit time phase.
    if (e.kind === 'penalty') {
      if (e.phase === 'player') {
        if (state.buffer.length < 2) state.buffer += d;
        if (state.buffer.length === 2) {
          e.player = parseInt(state.buffer, 10);
          state.buffer = '';
          e.phase = 'time';
        }
        return;
      }
      // phase === 'time'
      if (state.buffer.length < 4) state.buffer += d;
      return;
    }
    const max = numericMaxLen(e);
    if (state.buffer.length < max) state.buffer += d;
  }

  function numericMaxLen(e) {
    switch (e.kind) {
      case 'clock':   return 4;
      case 'period':  return 1;
      case 'score':   return 2;
      case 'shots':   return 2;
      case 'saves':   return 2;
      case 'tol':     return 1;
      case 'penalty': return e.phase === 'player' ? 2 : 4;
    }
    return 2;
  }

  function pressCancel() {
    if (pressMenuCancel()) return;
    if (state.entry) {
      cancelEntry();
    } else if (state.setMode) {
      state.setMode = false;
    }
  }

  function pressEnter() {
    if (pressMenuYes()) return;
    const e = state.entry;
    if (!e) return;
    const buf = state.buffer;
    switch (e.kind) {
      case 'clock': {
        const ms = parseTimeDigits(buf);
        if (ms != null) state.timeMs = ms;
        else flashLed('BAD TIME');
        cancelEntry();
        state.setMode = false;
        return;
      }
      case 'period': {
        const n = parseInt(buf, 10);
        if (!Number.isNaN(n) && n >= 1 && n <= MAX_PERIOD) state.period = n;
        cancelEntry();
        state.setMode = false;
        return;
      }
      case 'score': {
        const n = parseInt(buf, 10);
        if (!Number.isNaN(n) && n >= 0 && n <= MAX_SCORE) state[e.team].score = n;
        cancelEntry();
        state.setMode = false;
        return;
      }
      case 'shots': {
        const n = parseInt(buf, 10);
        if (!Number.isNaN(n) && n >= 0 && n <= MAX_SHOTS) state[e.team].shots = n;
        cancelEntry();
        state.setMode = false;
        return;
      }
      case 'saves': {
        const n = parseInt(buf, 10);
        if (!Number.isNaN(n) && n >= 0 && n <= MAX_SAVES) state[e.team].saves = n;
        cancelEntry();
        state.setMode = false;
        return;
      }
      case 'penalty': {
        if (e.phase === 'player') {
          // pressNum auto-advances from 'player' to 'time' once two digits
          // have been entered. Hitting ENTER while still in 'player' means
          // the operator pressed ENTER before completing the player number.
          flashLed('NEED PLR');
          return;
        }
        // phase === 'time' - require all four MMSS digits.
        if (buf.length !== 4) {
          flashLed('NEED MMSS');
          return;
        }
        const ms = parseTimeDigits(buf);
        if (ms == null || ms <= 0) {
          flashLed('BAD TIME');
          return;
        }
        if (e.edit) {
          const arr = state[e.team].penalties;
          if (arr.length) arr[0].remainingMs = ms;
        } else {
          state[e.team].penalties.push({ player: e.player, remainingMs: ms });
        }
        cancelEntry();
        return;
      }
    }
  }

  function pressYes() {
    flashLed('YES');
  }

  function pressNo() {
    flashLed('NO');
  }

  function pressTimeoutTimer() {
    flashLed('TO TIMER');
  }

  function pressGoalLightReset() {
    state.goalLightUntil = 0;
    flashLed('GL RST');
  }

  // ---------------------------------------------------------------
  // OPTIONS menu
  // ---------------------------------------------------------------
  // Structure follows the MPC7 hockey manual (MPC7_Hockey_135-0222.PDF):
  //   - Each top-level entry is either a leaf (with `type`) or a sub-menu
  //     (with `items`).
  //   - Navigation: OPTIONS = enter / next, YES = drill / toggle / start
  //     edit / confirm, NO/CANCEL = exit edit / back up / close menu.
  //   - Persisted via localStorage (key 'nevco-options').

  const OPTIONS_MENU = [
    {
      label: 'Penalties',
      items: [
        { label: 'Enable Button', type: 'toggle',
          get: () => state.options.penaltyButtonEnabled,
          set: (v) => state.options.penaltyButtonEnabled = v },
        { label: 'Minor Pen',     type: 'time4',
          get: () => state.options.minorPenaltyMs,
          set: (ms) => state.options.minorPenaltyMs = ms },
        { label: 'Major Pen',     type: 'time4',
          get: () => state.options.majorPenaltyMs,
          set: (ms) => state.options.majorPenaltyMs = ms },
      ],
    },
    {
      // Hockey option: Interval Horn. Stub only - the values persist but no
      // live interval-horn loop is running yet.
      label: 'Interval Horn',
      items: [
        { label: 'Enable',   type: 'toggle',
          get: () => state.options.intervalHornEnabled,
          set: (v) => state.options.intervalHornEnabled = v },
        { label: 'Int Time', type: 'time5',
          get: () => state.options.intervalHornMs,
          set: (ms) => state.options.intervalHornMs = ms },
      ],
    },
    {
      // Hockey option: show shots / saves digit pair on the scoreboard.
      // Stub only - the 4760 layout already renders the digit cells.
      label: 'Disp Shot/Save', type: 'toggle',
      get: () => state.options.displayShotSave,
      set: (v) => state.options.displayShotSave = v,
    },
    {
      // Shot Clocks: stubbed; the 4760 has no shot clock.
      label: 'Shot Clocks',
      items: [
        { label: 'Edit Shot Clk', type: 'action',
          do: () => flashLed('STUB: edit shot') },
        { label: 'ST > MT Blank', type: 'toggle',
          get: () => state.options.shotBlankUnderMain,
          set: (v) => state.options.shotBlankUnderMain = v },
        { label: 'SCS1 Time', type: 'time5',
          get: () => state.options.scs1TimeMs,
          set: (ms) => state.options.scs1TimeMs = ms },
        { label: 'SCS2 Time', type: 'time5',
          get: () => state.options.scs2TimeMs,
          set: (ms) => state.options.scs2TimeMs = ms },
      ],
    },
    {
      // HHS Function: which function the RCS-7 wireless handheld switch
      // performs (Goal Light or Shot Clock). Stub.
      label: 'HHS Function', type: 'cycle', values: ['Goal Light', 'Shot Clock'],
      get: () => state.options.hhsFunction,
      set: (v) => state.options.hhsFunction = v,
    },
    {
      label: 'Main Time',
      items: [
        { label: 'Direction',     type: 'arrow',
          get: () => state.options.countDown,
          set: (v) => state.options.countDown = v },
        { label: 'Auto Horn',     type: 'toggle',
          get: () => state.options.autoHorn,
          set: (v) => state.options.autoHorn = v },
        { label: 'Disable .1',    type: 'toggle',
          get: () => state.options.disableTenths,
          set: (v) => state.options.disableTenths = v },
      ],
    },
    {
      // Aux Time: stubbed; the 4760 doesn't display an aux timer.
      label: 'Aux Time',
      items: [
        { label: 'Set Aux',     type: 'time5',
          get: () => state.options.auxTimeMs,
          set: (ms) => state.options.auxTimeMs = ms },
        { label: 'Direction',   type: 'arrow',
          get: () => state.options.auxCountDown,
          set: (v) => state.options.auxCountDown = v },
        { label: 'Time Switch', type: 'toggle',
          get: () => state.options.auxTimeSwitch,
          set: (v) => state.options.auxTimeSwitch = v },
        { label: 'Stop Time',   type: 'time4',
          get: () => state.options.auxStopTimeMs,
          set: (ms) => state.options.auxStopTimeMs = ms },
        { label: 'Style',       type: 'cycle', values: ['MM:SS', 'HH:MM'],
          get: () => state.options.auxStyle,
          set: (v) => state.options.auxStyle = v },
      ],
    },
    {
      // Segment Timer: per the manual, up to 20 segments. The manual nests
      // per-segment fields under an "Edit Segment" sub-sub-menu - flattened
      // here so the existing 2-deep navigation still works. "Next Seg"
      // cycles which slot the per-slot fields read / write.
      label: 'Segment Timer',
      items: [
        { label: 'Enable', type: 'toggle',
          get: () => state.options.segmentEnabled,
          set: (v) => {
            state.options.segmentEnabled = v;
            if (v) {
              // Reset the clock so the next TIME ON loads a fresh segment
              // instead of resuming whatever game time was left over.
              state.timeMs = 0;
              state.clockRunning = false;
            }
          } },
        { label: 'Disp On Board', type: 'toggle',
          get: () => state.options.segmentDispOnBoard,
          set: (v) => state.options.segmentDispOnBoard = v },
        { labelFn: () => `Seg ${state.options.currentSegIdx + 1} Time`, type: 'time5',
          get: () => state.options.segments[state.options.currentSegIdx].timeMs,
          set: (ms) => state.options.segments[state.options.currentSegIdx].timeMs = ms },
        { label: 'Auto Horn', type: 'toggle',
          get: () => state.options.segments[state.options.currentSegIdx].autoHorn,
          set: (v) => state.options.segments[state.options.currentSegIdx].autoHorn = v },
        { label: 'Auto Adv',  type: 'toggle',
          get: () => state.options.segments[state.options.currentSegIdx].autoAdvance,
          set: (v) => state.options.segments[state.options.currentSegIdx].autoAdvance = v },
        { label: 'Next Seg',  type: 'action',
          do: () => {
            state.options.currentSegIdx = (state.options.currentSegIdx + 1) % state.options.segments.length;
            persistOptions();
            flashLed(`SEG ${state.options.currentSegIdx + 1}`, 800);
          } },
      ],
    },
    {
      // Time Out Timer: 5 individually settable timers, each with its own
      // warning time. "Next TO" cycles which slot is currently edited.
      label: 'TimeOut Timer',
      items: [
        { label: 'Disp On Board', type: 'toggle',
          get: () => state.options.timeOutDispOnBoard,
          set: (v) => state.options.timeOutDispOnBoard = v },
        { labelFn: () => `Time ${state.options.currentTimeOutIdx + 1}`, type: 'time5',
          get: () => state.options.timeOuts[state.options.currentTimeOutIdx].timeMs,
          set: (ms) => state.options.timeOuts[state.options.currentTimeOutIdx].timeMs = ms },
        { labelFn: () => `Warn ${state.options.currentTimeOutIdx + 1}`, type: 'time5',
          get: () => state.options.timeOuts[state.options.currentTimeOutIdx].warningMs,
          set: (ms) => state.options.timeOuts[state.options.currentTimeOutIdx].warningMs = ms },
        { label: 'Next TO', type: 'action',
          do: () => {
            state.options.currentTimeOutIdx = (state.options.currentTimeOutIdx + 1) % state.options.timeOuts.length;
            persistOptions();
            flashLed(`TO ${state.options.currentTimeOutIdx + 1}`, 800);
          } },
      ],
    },
    {
      label: 'Brightness', type: 'cycle', values: ['High', 'Low'],
      get: () => state.options.brightness,
      set: (v) => state.options.brightness = v,
    },
    {
      label: 'Swap H&G', type: 'action',
      do: () => { swapHomeAndGuest(); flashLed('SWAPPED'); },
    },
    {
      // Team Names: stubbed. Real device uses an alphanumeric keypad mode
      // to type team names; not implemented yet.
      label: 'Team Names',
      items: [
        { label: 'Guest Name', type: 'action',
          do: () => flashLed('STUB: enter guest', 1500) },
        { label: 'Home Name',  type: 'action',
          do: () => flashLed('STUB: enter home', 1500) },
      ],
    },
    {
      // Profiles: load / save / default-lock. Stubbed - profile system is
      // a separate feature (100 slots, sport-specific defaults).
      label: 'Profiles',
      items: [
        { label: 'Load Profile', type: 'action',
          do: () => flashLed('STUB: load prof', 1500) },
        { label: 'Save Profile', type: 'action',
          do: () => flashLed('STUB: save prof', 1500) },
        { label: 'Default Lock', type: 'toggle',
          get: () => state.options.defaultProfileLock,
          set: (v) => state.options.defaultProfileLock = v },
      ],
    },
    {
      // Aux Display: which source the auxiliary scoreboard timer follows.
      label: 'Aux Display', type: 'cycle', values: ['Main', 'Aux', 'TOD'],
      get: () => state.options.auxDisplay,
      set: (v) => state.options.auxDisplay = v,
    },
    {
      // Horn Settings: tone selection (0-9) for each event horn and overall
      // volume. Stubbed - the emulator's web-audio horn doesn't yet pick
      // tones; values persist for future use.
      label: 'Horn Settings',
      items: [
        { label: 'Volume',   type: 'digit',
          get: () => state.options.hornVolume,
          set: (n) => state.options.hornVolume = n },
        { label: 'EOP Tone', type: 'digit',
          get: () => state.options.hornEopTone,
          set: (n) => state.options.hornEopTone = n },
        { label: 'Key Tone', type: 'digit',
          get: () => state.options.hornKeyTone,
          set: (n) => state.options.hornKeyTone = n },
        { label: 'Aux Tone', type: 'digit',
          get: () => state.options.hornAuxTone,
          set: (n) => state.options.hornAuxTone = n },
        { label: 'TO Tone',  type: 'digit',
          get: () => state.options.hornTimeOutTone,
          set: (n) => state.options.hornTimeOutTone = n },
        { label: 'Seg Tone', type: 'digit',
          get: () => state.options.hornSegmentTone,
          set: (n) => state.options.hornSegmentTone = n },
      ],
    },
    {
      // Wireless: link / add / delete receivers. Hardware feature, stubbed.
      label: 'Wireless',
      items: [
        { label: 'Link Recv', type: 'action',
          do: () => flashLed('STUB: link recv', 1500) },
        { label: 'Add Recv',  type: 'action',
          do: () => flashLed('STUB: add recv', 1500) },
        { label: 'Del Recv',  type: 'action',
          do: () => flashLed('STUB: del recv', 1500) },
      ],
    },
    {
      // Scoreboard Model: hardware feature, stubbed.
      label: 'Scoreboard Model', type: 'action',
      do: () => flashLed('STUB: model', 1500),
    },
    {
      label: 'Time of Day', type: 'action',
      do: () => flashLed(formatWallClock(), 3000),
    },
  ];

  // Pull the visible label off a menu node (label OR labelFn).
  function itemLabel(item) {
    return typeof item.labelFn === 'function' ? item.labelFn() : item.label;
  }

  function loadOptions() {
    try {
      const raw = localStorage.getItem('nevco-options');
      if (raw) Object.assign(state.options, JSON.parse(raw));
    } catch (_) { /* ignore: incognito / blocked storage */ }
    // Guard array shape: if older saves omit these (or saved a malformed
    // value), restore the factory defaults so per-slot menu leaves don't
    // dereference undefined.
    const segs = state.options.segments;
    if (!Array.isArray(segs) || segs.length !== 20) {
      state.options.segments = Array.from({ length: 20 }, () => ({
        timeMs: 60 * 1000, autoHorn: false, autoAdvance: false,
      }));
    }
    const tos = state.options.timeOuts;
    if (!Array.isArray(tos) || tos.length !== 5) {
      state.options.timeOuts = Array.from({ length: 5 }, () => ({
        timeMs: 60 * 1000, warningMs: 5 * 1000,
      }));
    }
    // If segment timer was persisted as enabled, start fresh on load - the
    // leftover game clock from a previous session would otherwise tick down
    // as if it were a segment.
    if (state.options.segmentEnabled) {
      state.timeMs = 0;
      state.clockRunning = false;
    }
  }

  function persistOptions() {
    try {
      localStorage.setItem('nevco-options', JSON.stringify(state.options));
    } catch (_) { /* ignore */ }
  }

  function swapHomeAndGuest() {
    const h = state.home;
    state.home = state.guest;
    state.guest = h;
  }

  function currentMenuItem() {
    const m = state.menu;
    if (!m) return null;
    const top = OPTIONS_MENU[m.topIdx];
    if (m.subIdx == null) return top;
    return top.items[m.subIdx];
  }

  function pressOptions() {
    // OPTIONS enters the menu, then scrolls inside it. While editing a
    // value it cancels the in-flight edit (matches the manual which only
    // documents YES / NO behaviour while editing).
    if (!state.menu) {
      state.menu = { topIdx: 0, subIdx: null, editing: null };
      state.buffer = '';
      return;
    }
    const m = state.menu;
    if (m.editing) {
      m.editing = null;
      state.buffer = '';
      return;
    }
    if (m.subIdx != null) {
      const top = OPTIONS_MENU[m.topIdx];
      m.subIdx = (m.subIdx + 1) % top.items.length;
      return;
    }
    m.topIdx = (m.topIdx + 1) % OPTIONS_MENU.length;
  }

  function pressMenuYes() {
    const m = state.menu;
    if (!m) return false;
    if (m.editing) { commitMenuEdit(); return true; }
    const item = currentMenuItem();
    if (m.subIdx == null) {
      // At a top-level entry.
      if (item.items) { m.subIdx = 0; return true; }
      if (item.type === 'cycle') {
        const cur = item.get();
        const i = item.values.indexOf(cur);
        item.set(item.values[(i + 1) % item.values.length]);
        persistOptions();
        return true;
      }
      if (item.type === 'action') { item.do(); return true; }
      return true;
    }
    // Inside a sub-menu.
    if (item.type === 'toggle' || item.type === 'arrow') {
      item.set(!item.get());
      persistOptions();
      return true;
    }
    if (item.type === 'time4' || item.type === 'time5' || item.type === 'digit' || item.type === 'numeric') {
      m.editing = item.type;
      state.buffer = '';
      return true;
    }
    if (item.type === 'action') { item.do(); return true; }
    return true;
  }

  // Buffer length each edit type requires. Auto-accept fires when reached.
  function editingMaxLen(kind) {
    if (kind === 'digit') return 1;
    if (kind === 'time4') return 4;
    if (kind === 'time5') return 5;
    return 4; // numeric: at most a few digits, no hard cap
  }

  function commitMenuEdit() {
    const m = state.menu;
    const item = currentMenuItem();
    const buf = state.buffer;
    if (m.editing === 'time4') {
      if (buf.length !== 4) { flashLed('NEED MMSS'); return; }
      const ms = parseTimeDigits(buf);
      if (ms == null || ms < 0) { flashLed('BAD TIME'); return; }
      item.set(ms);
    } else if (m.editing === 'time5') {
      if (buf.length !== 5) { flashLed('NEED MMSST'); return; }
      const ms = parseTimeDigits5(buf);
      if (ms == null || ms < 0) { flashLed('BAD TIME'); return; }
      item.set(ms);
    } else if (m.editing === 'digit') {
      if (buf.length !== 1) { flashLed('NEED DIGIT'); return; }
      const n = parseInt(buf, 10);
      if (Number.isNaN(n) || n < 0 || n > 9) { flashLed('BAD #'); return; }
      item.set(n);
    } else if (m.editing === 'numeric') {
      const n = parseInt(buf, 10);
      if (Number.isNaN(n)) { flashLed('BAD #'); return; }
      item.set(n);
    }
    persistOptions();
    m.editing = null;
    state.buffer = '';
  }

  function pressMenuCancel() {
    const m = state.menu;
    if (!m) return false;
    if (m.editing) { m.editing = null; state.buffer = ''; return true; }
    if (m.subIdx != null) { m.subIdx = null; state.buffer = ''; return true; }
    state.menu = null;
    state.buffer = '';
    return true;
  }

  function pressMenuNum(d) {
    const m = state.menu;
    if (!m || !m.editing) return false;
    const max = editingMaxLen(m.editing);
    if (state.buffer.length < max) state.buffer += d;
    // Per the manual: time entries auto-accept once the buffer is full.
    if (state.buffer.length === max && (m.editing === 'time4' || m.editing === 'time5' || m.editing === 'digit')) {
      commitMenuEdit();
    }
    return true;
  }

  function pressScrollProfiles() {
    flashLed('PROFILES');
  }

  function pressTimeOfDay() {
    flashLed(formatWallClock(), 2000);
  }

  function pressBlank() {
    state.blanked = !state.blanked;
    flashLed(state.blanked ? 'BLANK ON' : 'BLANK OFF');
  }

  function setHornManual(on) {
    state.hornManual = !!on;
  }

  // ---------------------------------------------------------------
  // Dispatcher
  // ---------------------------------------------------------------

  function doAction(action, val, team) {
    switch (action) {
      case 'set':              pressSet();                break;
      case 'time-on':          pressTimeOn();             break;
      case 'time-off':         pressTimeOff();            break;
      case 'time-field':       pressTimeField();          break;
      case 'period':           pressPeriod();             break;
      case 'score':            pressScore(team);          break;
      case 'goal-shots':       pressShots(team);          break;
      case 'goal-saves':       pressSaves(team);          break;
      case 'new-minor':        pressNewPenalty(team, 'minor'); break;
      case 'new-major':        pressNewPenalty(team, 'major'); break;
      case 'insert-penalty':   pressInsertPenalty();      break;
      case 'clear-penalty':    pressClearPenalty();       break;
      case 'view-penalty':     pressViewPenalty();        break;
      case 'edit-penalty':     pressEditPenalty();        break;
      case 'penalty-onoff':    pressPenaltyOnOff();       break;
      case 'team-home':        pressTeam('home');         break;
      case 'team-guest':       pressTeam('guest');        break;
      case 'num':              pressNum(val);             break;
      case 'enter':            pressEnter();              break;
      case 'cancel':           pressCancel();             break;
      case 'yes':              pressYes();                break;
      case 'no':               pressNo();                 break;
      case 'timeout-timer':    pressTimeoutTimer();       break;
      case 'goal-light-reset': pressGoalLightReset();     break;
      case 'options':          pressOptions();            break;
      case 'scroll-profiles':  pressScrollProfiles();     break;
      case 'time-of-day':      pressTimeOfDay();          break;
      case 'blank':            pressBlank();              break;
    }
  }

  // ---------------------------------------------------------------
  // Keypad layout (from hockey_keypad_coordinates.csv)
  // ---------------------------------------------------------------
  // The console photo is 2997 x 1498 px and each button is 145 x 55 px.
  // Positions are kept in source pixels and converted to % at build time so
  // the keypad scales with .ctrl-photo (which preserves the photo's
  // aspect ratio).

  const KEYPAD_IMAGE_W = 2997;
  const KEYPAD_IMAGE_H = 1498;
  const KEY_W = 145;
  const KEY_H = 55;

  // Function: passed to doAction(). team / val mirror the existing
  // [data-team] / [data-val] selectors used by app.js. id is set on the two
  // buttons whose state we need to toggle visually (HORN press, SET armed).
  // The YES key doubles as ENTER and NO doubles as CANCEL, matching the
  // physical labels and the CSV's Key_Label column.
  // text is the visible label printed on the black key face; \n is honoured
  // via white-space: pre-line in CSS.
  const KEYPAD_LAYOUT = [
    // Row 1
    { x: 524,  y: 378,  action: 'horn',             label: 'HORN',                text: 'HORN',                 id: 'horn-button' },
    { x: 714,  y: 378,  action: 'new-minor',        label: 'HOME NEW MINOR',      text: 'NEW\nMINOR',           team: 'home'  },
    { x: 904,  y: 378,  action: 'new-minor',        label: 'GUEST NEW MINOR',     text: 'NEW\nMINOR',           team: 'guest' },
    { x: 1094, y: 377,  action: 'set',              label: 'SET',                 text: 'SET',                  id: 'set-button' },
    { x: 1763, y: 377,  action: 'timeout-timer',    label: 'TIME OUT TIMER',      text: 'TIME OUT\nTIMER'       },
    { x: 1953, y: 377,  action: 'goal-light-reset', label: 'GOAL LIGHT RESET',    text: 'GOAL LIGHT\nRESET'     },
    { x: 2143, y: 377,  action: 'options',          label: 'OPTIONS',             text: 'OPTIONS'               },
    { x: 2333, y: 377,  action: 'enter',            label: 'YES / ENTER',         text: 'YES'                   },
    // Row 2
    { x: 524,  y: 567,  action: 'insert-penalty',   label: 'INSERT PENALTY',      text: 'INSERT\nPENALTY'       },
    { x: 714,  y: 568,  action: 'new-major',        label: 'HOME NEW MAJOR',      text: 'NEW\nMAJOR',           team: 'home'  },
    { x: 904,  y: 568,  action: 'new-major',        label: 'GUEST NEW MAJOR',     text: 'NEW\nMAJOR',           team: 'guest' },
    { x: 1094, y: 567,  action: 'time-field',       label: 'TIME',                text: 'TIME'                  },
    { x: 1763, y: 567,  action: 'num',              label: '7',                   text: '7',                    val: '7' },
    { x: 1953, y: 567,  action: 'num',              label: '8',                   text: '8',                    val: '8' },
    { x: 2143, y: 567,  action: 'num',              label: '9',                   text: '9',                    val: '9' },
    { x: 2333, y: 567,  action: 'cancel',           label: 'NO / CANCEL',         text: 'NO'                    },
    // Row 3
    { x: 524,  y: 757,  action: 'penalty-onoff',    label: 'PENALTY ON OFF',      text: 'PENALTY\nON/OFF'       },
    { x: 714,  y: 758,  action: 'view-penalty',     label: 'HOME VIEW PENALTY',   text: 'VIEW\nPENALTY',        team: 'home'  },
    { x: 904,  y: 758,  action: 'view-penalty',     label: 'GUEST VIEW PENALTY',  text: 'VIEW\nPENALTY',        team: 'guest' },
    { x: 1094, y: 758,  action: 'edit-penalty',     label: 'EDIT PENALTY',        text: 'EDIT\nPENALTY'         },
    { x: 1763, y: 757,  action: 'num',              label: '4',                   text: '4',                    val: '4' },
    { x: 1953, y: 757,  action: 'num',              label: '5',                   text: '5',                    val: '5' },
    { x: 2143, y: 757,  action: 'num',              label: '6',                   text: '6',                    val: '6' },
    { x: 2333, y: 758,  action: 'time-of-day',      label: 'TIME OF DAY',         text: 'TIME OF\nDAY'          },
    // Row 4
    { x: 524,  y: 947,  action: 'time-on',          label: 'TIME ON',             text: 'TIME ON'               },
    { x: 714,  y: 948,  action: 'goal-saves',       label: 'HOME GOAL SAVES',     text: 'GOAL\nSAVES',          team: 'home'  },
    { x: 904,  y: 948,  action: 'goal-saves',       label: 'GUEST GOAL SAVES',    text: 'GOAL\nSAVES',          team: 'guest' },
    { x: 1094, y: 947,  action: 'clear-penalty',    label: 'CLEAR PENALTY',       text: 'CLEAR\nPENALTY'        },
    { x: 1763, y: 947,  action: 'num',              label: '1',                   text: '1',                    val: '1' },
    { x: 1953, y: 947,  action: 'num',              label: '2',                   text: '2',                    val: '2' },
    { x: 2143, y: 947,  action: 'num',              label: '3',                   text: '3',                    val: '3' },
    { x: 2333, y: 948,  action: 'score',            label: 'HOME SCORE',          text: 'HOME\nSCORE',          team: 'home'  },
    // Row 5
    { x: 524,  y: 1137, action: 'time-off',         label: 'TIME OFF',            text: 'TIME OFF'              },
    { x: 714,  y: 1138, action: 'goal-shots',       label: 'HOME GOAL SHOTS',     text: 'GOAL\nSHOTS',          team: 'home'  },
    { x: 904,  y: 1137, action: 'goal-shots',       label: 'GUEST GOAL SHOTS',    text: 'GOAL\nSHOTS',          team: 'guest' },
    { x: 1094, y: 1137, action: 'period',           label: 'PERIOD',              text: 'PERIOD'                },
    { x: 1763, y: 1137, action: 'scroll-profiles',  label: 'SCROLL PROFILES',     text: 'SCROLL\nPROFILES'      },
    { x: 1953, y: 1137, action: 'num',              label: '0',                   text: '0',                    val: '0' },
    { x: 2143, y: 1137, action: 'blank',            label: 'BLANK',               text: 'BLANK'                 },
    { x: 2333, y: 1137, action: 'score',            label: 'GUEST SCORE',         text: 'GUEST\nSCORE',         team: 'guest' },
  ];

  function buildKeypad() {
    const container = document.getElementById('ctrl-buttons');
    if (!container) return;
    const widthPct  = (KEY_W / KEYPAD_IMAGE_W) * 100;
    const heightPct = (KEY_H / KEYPAD_IMAGE_H) * 100;

    for (const k of KEYPAD_LAYOUT) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hot';
      btn.setAttribute('aria-label', k.label);
      btn.dataset.action = k.action;
      if (k.team) btn.dataset.team = k.team;
      if (k.val != null) btn.dataset.val = k.val;
      if (k.id) btn.id = k.id;
      btn.style.left   = ((k.x / KEYPAD_IMAGE_W) * 100).toFixed(4) + '%';
      btn.style.top    = ((k.y / KEYPAD_IMAGE_H) * 100).toFixed(4) + '%';
      btn.style.width  = widthPct.toFixed(4) + '%';
      btn.style.height = heightPct.toFixed(4) + '%';
      container.appendChild(btn);
    }
  }

  // ---------------------------------------------------------------
  // UI bindings
  // ---------------------------------------------------------------

  function bindKeypad() {
    document.querySelectorAll('.hot').forEach(btn => {
      const action = btn.dataset.action;
      if (!action) return;

      if (action === 'horn') {
        const press = (e) => {
          e.preventDefault();
          ensureAudio();
          btn.classList.add('pressed');
          setHornManual(true);
        };
        const release = (e) => {
          e.preventDefault();
          btn.classList.remove('pressed');
          setHornManual(false);
        };
        btn.addEventListener('mousedown', press);
        btn.addEventListener('mouseup', release);
        btn.addEventListener('mouseleave', release);
        btn.addEventListener('touchstart', press, { passive: false });
        btn.addEventListener('touchend', release);
        btn.addEventListener('touchcancel', release);
        return;
      }

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        ensureAudio();
        // The MPCW-7 has no dedicated HOME / GUEST key. Team is encoded by
        // column: any column-2 key (data-team="home") selects HOME, any
        // column-3 key (data-team="guest") selects GUEST. While an action
        // is waiting for a team, route the press to pressTeam() and
        // suppress the key's own function.
        if (state.entry && state.entry.kind === 'await-team' && btn.dataset.team) {
          pressTeam(btn.dataset.team);
        } else {
          doAction(action, btn.dataset.val, btn.dataset.team);
        }
        btn.classList.add('pressed');
        setTimeout(() => btn.classList.remove('pressed'), 90);
      });
    });
  }

  function bindKeyboard() {
    let hornHeld = false;

    document.addEventListener('keydown', (e) => {
      // Don't capture keys when focus is on a real input
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;

      if (e.key === ' ' || e.code === 'Space') {
        // Space emulates the MPCW-7 toggle switch: start/stop the clock.
        // Auto-repeat would flap the state; ignore.
        e.preventDefault();
        if (e.repeat) return;
        ensureAudio();
        if (state.clockRunning) pressTimeOff(); else pressTimeOn();
        return;
      }
      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        if (!hornHeld) {
          hornHeld = true;
          ensureAudio();
          setHornManual(true);
          els.hornButton.classList.add('pressed');
        }
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        ensureAudio();
        pressEnter();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        pressCancel();
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        if (state.entry && state.buffer.length > 0) {
          state.buffer = state.buffer.slice(0, -1);
        }
        return;
      }
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        ensureAudio();
        pressNum(e.key);
        return;
      }
    });

    document.addEventListener('keyup', (e) => {
      if (e.key === 'h' || e.key === 'H') {
        hornHeld = false;
        setHornManual(false);
        els.hornButton.classList.remove('pressed');
      }
    });

    window.addEventListener('blur', () => {
      hornHeld = false;
      setHornManual(false);
      els.hornButton.classList.remove('pressed');
    });
  }

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------

  function init() {
    loadOptions();
    buildKeypad();
    // The HORN and SET buttons are created dynamically, so refresh refs that
    // were nulled by the initial getElementById calls.
    els.setBtn = document.getElementById('set-button');
    els.hornButton = document.getElementById('horn-button');
    bindKeypad();
    bindKeyboard();
    requestAnimationFrame((t) => { lastTick = t; tick(t); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
