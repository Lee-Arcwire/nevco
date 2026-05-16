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
  // Bumped when the persisted state.options shape changes in a way old
  // saves shouldn't carry forward. On load, a mismatch triggers a one-shot
  // migration that overwrites segments / time-outs / currentSegIdx /
  // currentTimeOutIdx with the latest factory defaults (currently the
  // interval-horn segment config).
  const OPTIONS_VERSION = 3;
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
    // Segment timer runs alongside the game clock so the operator can use
    // an interval horn during live play. Disp On Board controls which one
    // is shown on the scoreboard / LED.
    segmentTimeMs: 0,
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
      optionsVersion:       OPTIONS_VERSION,
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
      //
      // Default configuration is the manual's "Interval Horn" example:
      // one segment of 1:00 with Auto Horn and Auto Advance both on, the
      // remaining 19 slots empty (treated as unused per the manual: the
      // project length is determined by the first contiguous run of
      // non-zero segments). Toggling Segment Timer > Enable starts firing
      // a horn every minute out of the box.
      segmentEnabled:       false,
      segmentDispOnBoard:   false,
      currentSegIdx:        0,
      segments: Array.from({ length: 20 }, (_, i) => i === 0
        ? { timeMs: 60 * 1000, autoHorn: true,  autoAdvance: true  }
        : { timeMs: 0,         autoHorn: false, autoAdvance: false }),
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
  //   { kind: 'add',     team, field: 'score'|'shots'|'saves' }
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

  // Left-to-right fixed-width MMSS preview used during edits that the
  // manual documents as fixed-width fills (segment time, penalty time,
  // time-out timer "Time N" / "Warn N"). Unfilled positions show as
  // dashes. e.g. ""=>"--:--", "5"=>"5-:--", "50"=>"50:--", "503"=>"50:3-",
  // "5030"=>"50:30". (Different from previewTime() which is for the
  // flexible MSS/MMSS game-clock entry.)
  function previewMMSS(digits) {
    const d = (digits || '').padEnd(4, '-');
    return `${d[0]}${d[1]}:${d[2]}${d[3]}`;
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

  // Left-to-right MM:SS.s preview for fixed-width 5-digit menu entries.
  function previewMMSS5(digits) {
    const d = (digits || '').padEnd(5, '-');
    return `${d[0]}${d[1]}:${d[2]}${d[3]}.${d[4]}`;
  }

  // SET + TIME clock-entry preview. Manual uses "MM:SS.s" letters as the
  // placeholders (tens-of-min, units-of-min, tens-of-sec, units-of-sec,
  // tenths-of-sec) so the operator can see which position each digit will
  // land in. Letters get replaced left-to-right by typed digits.
  function previewClockMMSSS(digits) {
    const ph = ['M', 'M', 'S', 'S', 's'];
    const d  = digits || '';
    const c  = (i) => i < d.length ? d[i] : ph[i];
    return `${c(0)}${c(1)}:${c(2)}${c(3)}.${c(4)}`;
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
      // Disp On Board: dedicate the scoreboard time to the segment timer.
      const showSegment = state.options.segmentEnabled && state.options.segmentDispOnBoard;
      const displayMs   = showSegment ? state.segmentTimeMs : state.timeMs;
      els.time.textContent       = formatClock(displayMs);
      els.timeBg.textContent     = displayMs < 60 * 1000 ? '88.8' : '88:88';
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
      case 'add': {
        const action = entry.field === 'score' ? 'score'
                     : entry.field === 'shots' ? 'goal-shots'
                     : 'goal-saves';
        return `[data-action="${action}"][data-team="${entry.team}"]`;
      }
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
      const showSegment = state.options.segmentEnabled && state.options.segmentDispOnBoard;
      return formatClock(showSegment ? state.segmentTimeMs : state.timeMs);
    }
    const e = state.entry;
    const buf = state.buffer || '';
    switch (e.kind) {
      case 'clock':   return `Time: ${previewClockMMSSS(buf)}◄`;
      case 'period':  return `PER ${buf || '-'}`;
      case 'score':   return `${e.team === 'home' ? 'HSC' : 'GSC'} ${buf.padStart(3, '-')}`;
      case 'shots':   return `${e.team === 'home' ? 'HSH' : 'GSH'} ${buf.padStart(3, '-')}`;
      case 'saves':   return `${e.team === 'home' ? 'HSV' : 'GSV'} ${buf.padStart(3, '-')}`;
      case 'tol':     return `${e.team === 'home' ? 'HTO' : 'GTO'} ${buf || '-'}`;
      // Manual: ##+ Score ## (home) / ## Score +## (guest). Reuse short
      // labels for our small LED window: SC/SH/SV with a side-coded +.
      // Manual: pressing HOME SCORE shows '## + Score ##' (home value on
      // the left, + indicating home is being added to); pressing GUEST
      // SCORE shows '## Score + ##' (+ on the right side). Same shape for
      // Shots and Saves. The next digit (0-9) is added to the side with
      // the '+'.
      case 'add': {
        const h    = pad2(state.home[e.field]);
        const g    = pad2(state.guest[e.field]);
        const word = e.field.charAt(0).toUpperCase() + e.field.slice(1);
        return e.team === 'home'
          ? `${h} + ${word} ${g}`
          : `${h} ${word} + ${g}`;
      }
      case 'penalty':
        // Player phase: "New <defaultTime> ##◄" with the typed digits
        // filling the # placeholders left to right. The default time is
        // 2:00 for NEW MINOR / 5:00 for NEW MAJOR (or whatever the
        // operator has configured under Penalties > Minor Pen / Major Pen
        // - we just read whichever ms value pressNewPenalty captured).
        if (e.phase === 'player') {
          const def = e.defaultMs != null ? formatPenaltyTime(e.defaultMs) : '#:##';
          return `New ${def} ${buf.padEnd(2, '#')}◄`;
        }
        // Time phase: "Pen <playerNum> MM:SS◄" with # placeholders.
        {
          const td = buf.padEnd(4, '#');
          return `Pen ${pad2(e.player)} ${td[0]}${td[1]}:${td[2]}${td[3]}◄`;
        }
      case 'await-team':
        return 'SEL TEAM';
      case 'clear-slot':
        return `CLR ${e.team === 'home' ? 'H' : 'G'} ${buf || '?'}`;
    }
    return 'READY';
  }

  function menuLedText() {
    const m = state.menu;
    const item = currentMenuItem();
    const lbl = itemLabel(item);
    const buf = state.buffer || '';
    // Sub-menu suffix on items-bearing nodes - matches the manual's "Penalties >>"
    const arrow = (it) => it.items ? ` >>` : '';

    if (m.editing === 'time4')   return `${lbl} ${previewMMSS(buf)}◄`;
    if (m.editing === 'time5')   return `${lbl} ${previewMMSS5(buf)}◄`;
    if (m.editing === 'digit')   return `${lbl}: ${buf || '_'}◄`;
    if (m.editing === 'numeric') return `${lbl} ${buf || '_'}◄`;

    if (item.items)              return `${lbl}${arrow(item)}`;
    if (item.type === 'cycle')   return `${lbl}: ${item.get()}`;

    if (item.type === 'toggle')  return item.get() ? `${lbl}*` : lbl;
    if (item.type === 'radio')   return item.get() ? `${lbl}*` : lbl;
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
      // Segment clock (always counts down per the manual; the Main Time
      // Direction option doesn't apply to segments).
      if (state.options.segmentEnabled && state.segmentTimeMs > 0) {
        state.segmentTimeMs -= dt;
        if (state.segmentTimeMs <= 0) {
          state.segmentTimeMs = 0;
          handleSegmentEnd();
        }
      }

      // Game clock - paused while Disp On Board is on so the scoreboard
      // is dedicated to segment display (practice mode). Also paused (not
      // re-triggering end-of-period) once already at 0 - otherwise a stale
      // 0:00 main time would re-fire the period horn AND stop the segment
      // clock the moment TIME ON is pressed.
      const segmentOnly = state.options.segmentEnabled && state.options.segmentDispOnBoard;
      if (!segmentOnly) {
        if (state.options.countDown) {
          if (state.timeMs > 0) {
            state.timeMs -= dt;
            if (state.timeMs <= 0) {
              state.timeMs = 0;
              // Only stop the master clockRunning if the segment timer
              // isn't carrying the session - otherwise we'd cut the
              // segment off mid-interval.
              if (!state.options.segmentEnabled) state.clockRunning = false;
              if (state.options.autoHorn) state.autoHornUntil = Date.now() + AUTO_HORN_MS;
            }
          }
        } else {
          state.timeMs += dt;
        }
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

  // Segment Timer: load the current segment's time into state.segmentTimeMs.
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
        state.segmentTimeMs = segs[j].timeMs;
        return true;
      }
    }
    return false;
  }

  // Called when the segment clock reaches 0:00. Fires Auto Horn for that
  // segment if enabled, then advances to the next non-zero segment if
  // Auto Advance is enabled (otherwise leaves the segment paused at 0;
  // the game clock keeps running if it has time and Disp On Board is off).
  function handleSegmentEnd() {
    const seg = state.options.segments[state.options.currentSegIdx];
    if (seg.autoHorn) state.autoHornUntil = Date.now() + AUTO_HORN_MS;
    if (!seg.autoAdvance) {
      // Leave segmentTimeMs at 0; next TIME ON loads the next non-zero seg.
      return;
    }
    const segs = state.options.segments;
    for (let i = 1; i <= segs.length; i++) {
      const idx = (state.options.currentSegIdx + i) % segs.length;
      if (segs[idx].timeMs > 0) {
        state.options.currentSegIdx = idx;
        state.segmentTimeMs = segs[idx].timeMs;
        persistOptions();
        return;
      }
    }
    // No other non-zero segment in the project - hold at 0.
  }

  function pressTimeOn() {
    cancelEntry();
    state.setMode = false;
    // Segment Timer: pre-load the active segment if its clock has run down
    // (or this is a fresh start).
    if (state.options.segmentEnabled && state.segmentTimeMs <= 0) {
      loadActiveSegment();
    }
    // In segment-only mode (Disp On Board on) the game clock is dormant;
    // the segment alone must have time. Otherwise the game clock has to
    // have time or there's nothing to count.
    const segmentOnly = state.options.segmentEnabled && state.options.segmentDispOnBoard;
    const segReady    = state.options.segmentEnabled && state.segmentTimeMs > 0;
    const gameReady   = state.timeMs > 0;
    if (segmentOnly ? !segReady : (!segReady && !gameReady)) {
      flashLed(segmentOnly ? 'NO SEG' : 'NO TIME');
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
    // Manual behaviour: HOME SCORE / GUEST SCORE puts the controller in
    // "add mode" - the NEXT digit pressed is added to the score (not a
    // direct +1). SET + SCORE arms a direct entry (1-3 digits).
    if (state.setMode) {
      arm({ kind: 'score', team });
      return;
    }
    cancelEntry();
    arm({ kind: 'add', team, field: 'score' });
  }

  function pressShots(team) {
    if (state.setMode) {
      arm({ kind: 'shots', team });
      return;
    }
    cancelEntry();
    arm({ kind: 'add', team, field: 'shots' });
  }

  function pressSaves(team) {
    if (state.setMode) {
      arm({ kind: 'saves', team });
      return;
    }
    cancelEntry();
    arm({ kind: 'add', team, field: 'saves' });
  }

  function pressNewPenalty(team, kind /* 'minor' | 'major' */) {
    if (state[team].penalties.length >= MAX_PENALTY_QUEUE) {
      flashLed('PEN FULL');
      return;
    }
    // Operator types the penalty in order:
    //   (1) 2-digit player # (leading zero required for single-digit #).
    //   (2) After two digits, ENTER commits with the default time for the
    //       minor / major variant (state.options.minorPenaltyMs /
    //       majorPenaltyMs). If instead the operator presses another digit
    //       the entry transitions to a 4-digit time entry.
    //   (3) In the time phase, ENTER zero-pads the partial buffer and
    //       commits. A full 4-digit buffer auto-commits.
    const defaultMs = kind === 'major'
      ? state.options.majorPenaltyMs
      : state.options.minorPenaltyMs;
    arm({
      kind: 'penalty',
      team,
      phase: 'player',
      kindType: kind,
      defaultMs,
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
        // INSERT shares the new-penalty flow. Default time falls back to
        // the configured minor penalty length so the operator can still
        // ENTER after a 2-digit player # if they don't want to type a
        // custom time.
        arm({ kind: 'penalty', team, phase: 'player', player: null,
              defaultMs: state.options.minorPenaltyMs });
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
    // "Add mode" entry: the digit pressed is added to the stat with the +,
    // then the entry is consumed - per the manual: "To add more start from
    // step 1" (i.e., press SCORE / SHOTS / SAVES again).
    if (e.kind === 'add') {
      const n = parseInt(d, 10);
      if (!Number.isNaN(n) && n >= 0 && n <= 9) {
        const max = e.field === 'score' ? MAX_SCORE
                  : e.field === 'shots' ? MAX_SHOTS
                  : MAX_SAVES;
        const prev = state[e.team][e.field];
        state[e.team][e.field] = Math.min(max, prev + n);
        if (e.field === 'score' && n > 0) {
          state.goalLightUntil = Date.now() + GOAL_LIGHT_MS;
          flashLed(`${e.team === 'home' ? 'H' : 'G'}-GOAL`);
        }
      }
      cancelEntry();
      return;
    }
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
    // Penalty entry:
    //   * phase 'player' holds up to 2 digits. After two are typed the
    //     entry waits for the operator's next action (ENTER -> default
    //     time, or another digit -> jump to time entry with that digit
    //     as the first time-position digit).
    //   * phase 'time' holds up to 4 MMSS digits, auto-commits on the
    //     fourth.
    if (e.kind === 'penalty') {
      if (e.phase === 'player') {
        if (state.buffer.length < 2) {
          state.buffer += d;
        } else {
          // Two player digits already buffered: the new digit is the
          // first digit of a custom MMSS time. Promote phase.
          e.player = parseInt(state.buffer, 10);
          e.phase = 'time';
          state.buffer = d;
        }
        return;
      }
      // phase === 'time'
      if (state.buffer.length < 4) state.buffer += d;
      if (state.buffer.length === 4) pressEnter();
      return;
    }
    const max = numericMaxLen(e);
    if (state.buffer.length < max) state.buffer += d;
    // Per the manual: SET + TIME auto-accepts when all 5 digits are filled.
    if (e.kind === 'clock' && state.buffer.length === max) {
      pressEnter();
    }
  }

  function numericMaxLen(e) {
    switch (e.kind) {
      case 'clock':   return 5;
      case 'period':  return 1;
      // SET-mode stat entries: up to 3 digits (e.g. set score to 0-999;
      // ENTER commits early at 1 or 2 digits per the manual).
      case 'score':   return 3;
      case 'shots':   return 3;
      case 'saves':   return 3;
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
        // Manual: SET + TIME takes 5 digits MM:SS.s. Auto-accept fires when
        // the buffer fills (see pressNum). On YES with a partial buffer:
        // "zeros will be placed in the unfilled digits and the time will be
        // accepted" (page 8 example: 1,2,YES -> 12:00.0). Empty buffer +
        // YES is treated as a clean back-out so a stray YES doesn't zero
        // the clock.
        if (buf.length === 0) {
          cancelEntry();
          state.setMode = false;
          return;
        }
        const padded = buf.padEnd(5, '0');
        const ms = parseTimeDigits5(padded);
        if (ms == null) { flashLed('BAD TIME'); return; }
        state.timeMs = ms;
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
          // Need two player digits before we can commit; default-time-on-
          // enter only applies once the player # is filled.
          if (buf.length !== 2) { flashLed('NEED PLR'); return; }
          const player = parseInt(buf, 10);
          const ms = e.defaultMs;
          if (e.edit) {
            const arr = state[e.team].penalties;
            if (arr.length) arr[0].remainingMs = ms;
          } else if (ms != null && ms > 0) {
            state[e.team].penalties.push({ player, remainingMs: ms });
          }
          cancelEntry();
          return;
        }
        // phase === 'time'
        if (buf.length === 0) {
          // Reached for EDIT PENALTY (which starts in time phase) when the
          // operator backs out without typing anything. Leave the existing
          // value alone.
          cancelEntry();
          return;
        }
        // Manual-style partial commit: pad MMSS to the right with zeros.
        const padded = buf.padEnd(4, '0');
        const ms = parseTimeDigits(padded);
        if (ms == null || ms <= 0) { flashLed('BAD TIME'); return; }
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
  // Structure follows the MPC7 hockey manual (MPC7_Hockey_135-0222.PDF).
  // Page 23 lists exactly 13 top-level OPTIONS in this order:
  //   1.  Brightness          6.  Segment Timer    11. Wireless
  //   2.  Team Names          7.  Time Out Timer   12. Scoreboard Model
  //   3.  Profiles            8.  Swap Home & Guests
  //   4.  Main Time           9.  Aux Display      13. Time of Day
  //   5.  Aux Time            10. Horn Settings
  // Navigation: OPTIONS = next, YES = drill / toggle / edit / commit,
  // NO/CANCEL = exit edit / back up / close. Persisted via localStorage
  // (key 'nevco-options').

  const OPTIONS_MENU = [
    // 1. Brightness ----------------------------------------------------
    {
      label: 'Brightness', type: 'cycle', values: ['High', 'Low'],
      get: () => state.options.brightness,
      set: (v) => state.options.brightness = v,
    },
    // 2. Team Names ----------------------------------------------------
    // Real device uses an alphanumeric keypad mode to enter names;
    // sub-items are action stubs until that mode is implemented.
    {
      label: 'Team Names',
      items: [
        { label: 'Guest Name', type: 'action',
          do: () => flashLed('STUB: enter guest', 1500) },
        { label: 'Home Name',  type: 'action',
          do: () => flashLed('STUB: enter home', 1500) },
      ],
    },
    // 3. Profiles ------------------------------------------------------
    // Load / save (each takes a 2-digit profile #) and Default Lock.
    // The load/save flows are stubbed - profile persistence is a separate
    // feature on the real device.
    {
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
    // 4. Main Time -----------------------------------------------------
    {
      label: 'Main Time',
      items: [
        { label: 'Direction',  type: 'arrow',
          get: () => state.options.countDown,
          set: (v) => state.options.countDown = v },
        { label: 'Auto Horn',  type: 'toggle',
          get: () => state.options.autoHorn,
          set: (v) => state.options.autoHorn = v },
        { label: 'Disable .1', type: 'toggle',
          get: () => state.options.disableTenths,
          set: (v) => state.options.disableTenths = v },
      ],
    },
    // 5. Aux Time ------------------------------------------------------
    // Stubbed - the 4760 emulator doesn't display an auxiliary timer.
    {
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
    // 6. Segment Timer -------------------------------------------------
    // Manual: Main Menu has 3 items (Enable, Display on Scoreboard,
    // Edit Segment). Edit Segment is a sub-menu with 6 items: Segment
    // Main Time (MMSS), Auto Horn, Auto Advance, Next Segment, Insert
    // Segment, Delete Segment. Per-segment leaves operate on the slot
    // at state.options.currentSegIdx; Next/Insert/Delete change which
    // slot that is.
    //
    // Defaults seed the manual's interval-horn project (one segment of
    // 1:00 with Auto Horn + Auto Advance on; segments 2-20 are 0:00 and
    // skipped per the manual's "project length less than 20" note).
    {
      label: 'Segment Timer',
      items: [
        { label: 'Enable', type: 'toggle',
          get: () => state.options.segmentEnabled,
          set: (v) => {
            state.options.segmentEnabled = v;
            // Drop any in-flight segment time so the next TIME ON loads a
            // fresh segment.
            state.segmentTimeMs = 0;
          } },
        { label: 'Disp On Board', type: 'toggle',
          get: () => state.options.segmentDispOnBoard,
          set: (v) => state.options.segmentDispOnBoard = v },
        {
          label: 'Edit Segment',
          items: [
            // Segment Main Time: 4-digit MMSS, auto-accepts on the 4th digit.
            { labelFn: () => `Seg: ${state.options.currentSegIdx + 1}`, type: 'time4',
              get: () => state.options.segments[state.options.currentSegIdx].timeMs,
              set: (ms) => state.options.segments[state.options.currentSegIdx].timeMs = ms },
            // Auto Horn / Auto Adv read & write the current segment.
            { labelFn: () => `Seg: ${state.options.currentSegIdx + 1} Auto Hrn`, type: 'toggle',
              get: () => state.options.segments[state.options.currentSegIdx].autoHorn,
              set: (v) => state.options.segments[state.options.currentSegIdx].autoHorn = v },
            { labelFn: () => `Seg: ${state.options.currentSegIdx + 1} Auto Adv`, type: 'toggle',
              get: () => state.options.segments[state.options.currentSegIdx].autoAdvance,
              set: (v) => state.options.segments[state.options.currentSegIdx].autoAdvance = v },
            // Next Segment: increments the index, wraps at 20 per manual.
            { labelFn: () => `Seg: ${state.options.currentSegIdx + 1} Next Seg`, type: 'action',
              do: () => {
                state.options.currentSegIdx = (state.options.currentSegIdx + 1) % state.options.segments.length;
                persistOptions();
                flashLed(`SEG ${state.options.currentSegIdx + 1}`, 800);
              } },
            // Insert: push a fresh 0:00 segment in at the current position,
            // shift the tail forward, drop anything past slot 20. Caller
            // can then OPTIONS back to Segment Main Time to set the new
            // segment's duration.
            { label: 'Insert Segment', type: 'action',
              do: () => {
                const segs = state.options.segments;
                const idx  = state.options.currentSegIdx;
                segs.splice(idx, 0, { timeMs: 0, autoHorn: false, autoAdvance: false });
                if (segs.length > 20) segs.length = 20;
                persistOptions();
                flashLed('INSERTED', 800);
              } },
            // Delete: remove the current segment, slide the tail back, pad
            // the end with a 0:00 slot to keep the array at 20.
            { label: 'Delete Segment', type: 'action',
              do: () => {
                const segs = state.options.segments;
                const idx  = state.options.currentSegIdx;
                segs.splice(idx, 1);
                while (segs.length < 20) segs.push({ timeMs: 0, autoHorn: false, autoAdvance: false });
                if (state.options.currentSegIdx >= segs.length) state.options.currentSegIdx = Math.max(0, segs.length - 1);
                persistOptions();
                flashLed('DELETED', 800);
              } },
          ],
        },
      ],
    },
    // 7. Time Out Timer ------------------------------------------------
    // 5 individually settable timers, each with its own warning time.
    // "Next TO" cycles which slot is currently edited.
    {
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
    // 8. Swap Home & Guests --------------------------------------------
    {
      label: 'Swap Home&Guest', type: 'action',
      do: () => { swapHomeAndGuest(); flashLed('SWAPPED'); },
    },
    // 9. Aux Display ---------------------------------------------------
    {
      // Auxiliary timer source. Manual: sub-menu with 3 radio entries
      // (Display Main / Display Aux / Display TOD); the active one shows
      // an asterisk and selecting another moves the asterisk.
      label: 'Aux Display',
      items: [
        { label: 'Display Main', type: 'radio',
          get:    () => state.options.auxDisplay === 'Main',
          select: () => state.options.auxDisplay = 'Main' },
        { label: 'Display Aux',  type: 'radio',
          get:    () => state.options.auxDisplay === 'Aux',
          select: () => state.options.auxDisplay = 'Aux' },
        { label: 'Display TOD',  type: 'radio',
          get:    () => state.options.auxDisplay === 'TOD',
          select: () => state.options.auxDisplay = 'TOD' },
      ],
    },
    // 10. Horn Settings ------------------------------------------------
    // Tone selection (0-9) for each event horn and overall volume.
    // Stubbed - the emulator's web-audio horn doesn't pick tones; values
    // persist for future use.
    {
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
    // 11. Wireless -----------------------------------------------------
    // Link / add / delete receivers. Hardware-only on the real device;
    // stubbed.
    {
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
    // 12. Scoreboard Model ---------------------------------------------
    {
      label: 'Scoreboard Model', type: 'action',
      do: () => flashLed('STUB: model', 1500),
    },
    // 13. Time of Day --------------------------------------------------
    {
      label: 'Time of Day', type: 'action',
      do: () => flashLed(formatWallClock(), 3000),
    },
  ];

  // Pull the visible label off a menu node (label OR labelFn).
  function itemLabel(item) {
    return typeof item.labelFn === 'function' ? item.labelFn() : item.label;
  }

  // Factory defaults for the segment timer: manual's interval-horn example -
  // segment 1 = 1:00 with Auto Horn + Auto Advance on, segments 2-20 = 0:00
  // (treated as unused, per the manual's "project less than 20" note).
  function makeDefaultSegments() {
    return Array.from({ length: 20 }, (_, i) => i === 0
      ? { timeMs: 60 * 1000, autoHorn: true,  autoAdvance: true  }
      : { timeMs: 0,         autoHorn: false, autoAdvance: false });
  }

  function makeDefaultTimeOuts() {
    return Array.from({ length: 5 }, () => ({
      timeMs: 60 * 1000, warningMs: 5 * 1000,
    }));
  }

  function loadOptions() {
    // Stash the stored version BEFORE the Object.assign, otherwise the merge
    // leaves the default OPTIONS_VERSION in place when the stored payload
    // didn't include the field, and the migration check below would never
    // trigger.
    let storedVersion;
    try {
      const raw = localStorage.getItem('nevco-options');
      if (raw) {
        const stored = JSON.parse(raw);
        storedVersion = stored.optionsVersion;
        Object.assign(state.options, stored);
      }
    } catch (_) { /* ignore: incognito / blocked storage */ }

    // Version migration: when OPTIONS_VERSION is bumped, overwrite the
    // segment timer + time-out timer block with the latest factory defaults
    // (and reset their current-slot pointers). One-shot - subsequent loads
    // see the matching version and keep customised values.
    if (storedVersion !== OPTIONS_VERSION) {
      state.options.segments           = makeDefaultSegments();
      state.options.currentSegIdx      = 0;
      state.options.segmentEnabled     = false;
      state.options.segmentDispOnBoard = false;
      state.options.timeOuts           = makeDefaultTimeOuts();
      state.options.currentTimeOutIdx  = 0;
      state.options.optionsVersion     = OPTIONS_VERSION;
      persistOptions();
    }

    // Belt-and-braces: if something else corrupted the array shape after a
    // matching version, restore the factory defaults so per-slot menu leaves
    // don't dereference undefined.
    if (!Array.isArray(state.options.segments) || state.options.segments.length !== 20) {
      state.options.segments = makeDefaultSegments();
    }
    if (!Array.isArray(state.options.timeOuts) || state.options.timeOuts.length !== 5) {
      state.options.timeOuts = makeDefaultTimeOuts();
    }
    // segmentTimeMs is transient (not persisted); always start at 0 so the
    // first TIME ON after a page load pulls the active segment fresh.
    state.segmentTimeMs = 0;
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

  // Walk OPTIONS_MENU using state.menu.path. The path holds the index at
  // each level so menus can nest arbitrarily deep.
  function currentMenuItem() {
    const m = state.menu;
    if (!m || m.path.length === 0) return null;
    let node = { items: OPTIONS_MENU };
    for (const i of m.path) {
      if (!node.items) return null;
      node = node.items[i];
    }
    return node;
  }

  function currentMenuSiblings() {
    const m = state.menu;
    if (!m || m.path.length === 0) return null;
    let node = { items: OPTIONS_MENU };
    for (let i = 0; i < m.path.length - 1; i++) node = node.items[m.path[i]];
    return node.items;
  }

  function pressOptions() {
    // OPTIONS enters the menu, then scrolls inside it at the current depth.
    // While editing a value it cancels the edit (manual is silent on this
    // - the YES / NO docs cover it; OPTIONS just gets out of edit mode).
    if (!state.menu) {
      state.menu = { path: [0], editing: null };
      state.buffer = '';
      return;
    }
    const m = state.menu;
    if (m.editing) {
      m.editing = null;
      state.buffer = '';
      return;
    }
    const siblings = currentMenuSiblings();
    if (!siblings) return;
    const depth = m.path.length - 1;
    m.path[depth] = (m.path[depth] + 1) % siblings.length;
  }

  function pressMenuYes() {
    const m = state.menu;
    if (!m) return false;
    if (m.editing) { commitMenuEdit(); return true; }
    const item = currentMenuItem();
    if (!item) return true;
    // Drill into a sub-menu.
    if (item.items) {
      m.path.push(0);
      return true;
    }
    // Cycle through preset values.
    if (item.type === 'cycle') {
      const cur = item.get();
      const i = item.values.indexOf(cur);
      item.set(item.values[(i + 1) % item.values.length]);
      persistOptions();
      return true;
    }
    // Toggle a flag.
    if (item.type === 'toggle' || item.type === 'arrow') {
      item.set(!item.get());
      persistOptions();
      return true;
    }
    // Radio (mutually exclusive): selecting always sets this option,
    // even if it's already the active one.
    if (item.type === 'radio') {
      item.select();
      persistOptions();
      return true;
    }
    // Start a value edit.
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
      // Empty buffer: treat ENTER as a clean back-out (don't zap the
      // current value with 00:00).
      if (buf.length === 0) { m.editing = null; state.buffer = ''; return; }
      // Anything other than a full MMSS is rejected. Auto-commit already
      // covers the all-four-digits case; intermediate states ('1' meaning
      // 10:00, '30' meaning 30:00) are too easy to misread and have caused
      // users to accidentally set segments to unintended lengths.
      if (buf.length !== 4) { flashLed('NEED 4 DIGITS'); return; }
      const ms = parseTimeDigits(buf);
      if (ms == null || ms < 0) { flashLed('BAD TIME'); return; }
      item.set(ms);
    } else if (m.editing === 'time5') {
      if (buf.length === 0) { m.editing = null; state.buffer = ''; return; }
      if (buf.length !== 5) { flashLed('NEED 5 DIGITS'); return; }
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
    // Pop one level. Empty path means the menu closes.
    m.path.pop();
    state.buffer = '';
    if (m.path.length === 0) state.menu = null;
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
