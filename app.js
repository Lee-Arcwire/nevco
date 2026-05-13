/* ====================================================================
   Nevco 4770 Hockey Scoreboard Emulator (MPCW-7 controller)

   Operation summary
   - Toggle switch (Space): SET (up) <-> RUN (down)
       * RUN  : dedicated keys adjust values directly (Score/Shots +1,
                T.O.L. -1, Period +1)
       * SET  : dedicated keys ARM numeric entry, digits + ENTER apply
   - Horn (H key, or HORN button): held = horn on
   - Penalty entry works in either toggle position:
       PEN -> [player digits] ENTER -> [duration digits] ENTER
       digits for duration: MSS or MMSS (e.g. 200 = 2:00, 1000 = 10:00)
   - Clock display: MM:SS when >= 1 min, SS.T when < 1 min (with tenths)
   - Penalties tick down only while the game clock is running.
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
  const MAX_TOL = 9;
  const MAX_PENALTY_QUEUE = 6;

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------

  const state = {
    home:  { score: 0, shots: 0, tol: 1, penalties: [] },
    guest: { score: 0, shots: 0, tol: 1, penalties: [] },
    period: 1,
    timeMs: PERIOD_DEFAULT_MS,
    clockRunning: false,
    hornOn: false,
    hornManual: false,
    autoHorn: true,
    autoHornUntil: 0,
    toggle: 'down',         // 'up' = SET, 'down' = RUN
    entry: null,            // current numeric-entry context
    buffer: '',             // digits typed
    lampTestUntil: 0,
    flash: null,            // transient LED message
  };

  let flashUntil = 0;

  // Entry contexts:
  //   { kind: 'clock' }
  //   { kind: 'period' }
  //   { kind: 'score',  team: 'home'|'guest' }
  //   { kind: 'shots',  team: 'home'|'guest' }
  //   { kind: 'tol',    team: 'home'|'guest' }
  //   { kind: 'penalty', team, phase: 'player'|'time', player: number|null }

  // ---------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------

  const $ = (id) => document.getElementById(id);

  const els = {
    homeScore:        $('home-score'),
    guestScore:       $('guest-score'),
    homeShots:        $('home-shots'),
    guestShots:       $('guest-shots'),
    homeTol:          $('home-tol'),
    guestTol:         $('guest-tol'),
    period:           $('period'),
    time:             $('time'),
    timeBg:           $('time-bg'),
    hornInd:          $('horn-indicator'),
    led:              $('led-text'),
    ledHint:          $('led-hint'),
    toggle:           $('toggle-switch'),
    hornButton:       $('horn-button'),
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
    if (ms >= 60 * 1000) {
      const total = Math.ceil(ms / 1000);
      const m = Math.floor(total / 60);
      const s = total % 60;
      return `${pad2(m)}:${pad2(s)}`;
    } else {
      // sub-minute: show SS.T (seconds.tenths)
      const total = Math.floor(ms / 100); // tenths
      const s = Math.floor(total / 10);
      const t = total % 10;
      return `${pad2(s)}.${t}`;
    }
  }

  function formatPenaltyTime(ms) {
    if (ms <= 0) return '00:00';
    const total = Math.ceil(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${pad2(m)}:${pad2(s)}`;
  }

  // Parse a digit string like "2000" -> 20:00, "200" -> 2:00, "59" -> 0:59
  function parseTimeDigits(digits) {
    if (!digits) return null;
    const n = parseInt(digits, 10);
    if (Number.isNaN(n)) return null;
    let mins, secs;
    if (digits.length <= 2) {
      mins = 0;
      secs = n;
    } else if (digits.length === 3) {
      mins = Math.floor(n / 100);
      secs = n % 100;
    } else {
      mins = Math.floor(n / 100);
      secs = n % 100;
    }
    if (secs > 59) return null;
    return (mins * 60 + secs) * 1000;
  }

  function previewTime(digits) {
    if (!digits) return '-:--';
    const ms = parseTimeDigits(digits);
    if (ms == null) return '?:??';
    return formatPenaltyTime(ms);
  }

  // ---------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------

  function renderScoreboard() {
    const lamp = Date.now() < state.lampTestUntil;

    if (lamp) {
      els.homeScore.textContent  = '88';
      els.guestScore.textContent = '88';
      els.homeShots.textContent  = '88';
      els.guestShots.textContent = '88';
      els.homeTol.textContent    = '8';
      els.guestTol.textContent   = '8';
      els.period.textContent     = '8';
      els.time.textContent       = '88:88';
      els.homePen.forEach(p => { p.player.textContent = '88'; p.time.textContent = '88:88'; });
      els.guestPen.forEach(p => { p.player.textContent = '88'; p.time.textContent = '88:88'; });
    } else {
      els.homeScore.textContent  = pad2(state.home.score);
      els.guestScore.textContent = pad2(state.guest.score);
      els.homeShots.textContent  = pad2(state.home.shots);
      els.guestShots.textContent = pad2(state.guest.shots);
      els.homeTol.textContent    = String(state.home.tol);
      els.guestTol.textContent   = String(state.guest.tol);
      els.period.textContent     = String(state.period);
      els.time.textContent       = formatClock(state.timeMs);
      els.timeBg.textContent     = state.timeMs < 60 * 1000 ? '88.8' : '88:88';

      renderPenaltySlots('home', els.homePen, state.home.penalties);
      renderPenaltySlots('guest', els.guestPen, state.guest.penalties);
    }

    els.hornInd.classList.toggle('on', state.hornOn || lamp);
  }

  function renderPenaltySlots(team, slots, penalties) {
    for (let i = 0; i < slots.length; i++) {
      const p = penalties[i];
      if (p) {
        slots[i].player.textContent = pad2(p.player);
        slots[i].time.textContent   = formatPenaltyTime(p.remainingMs);
      } else {
        slots[i].player.textContent = '--';
        slots[i].time.textContent   = '00:00';
      }
    }
  }

  function renderController() {
    // Toggle position
    if (els.toggle) {
      els.toggle.dataset.pos = state.toggle === 'up' ? 'up' : 'down';
    }

    // Mode hint under LED
    const mode = state.toggle === 'up' ? 'SET' : 'RUN';
    const hint = state.entry
      ? entryHint(state.entry)
      : `Toggle ${state.toggle.toUpperCase()} · ${mode} mode`;
    els.ledHint.textContent = hint;

    // LED text
    els.led.textContent = ledText();

    // Highlight armed dedicated key
    document.querySelectorAll('.key.armed').forEach(k => k.classList.remove('armed'));
    if (state.entry) {
      const sel = entryToKey(state.entry);
      if (sel) {
        const el = document.querySelector(`.key[data-action="${sel}"]`);
        if (el) el.classList.add('armed');
      }
    }
  }

  function entryToKey(entry) {
    switch (entry.kind) {
      case 'clock':   return 'clock-set';
      case 'period':  return 'period';
      case 'score':   return entry.team === 'home' ? 'home-score' : 'guest-score';
      case 'shots':   return entry.team === 'home' ? 'home-shots' : 'guest-shots';
      case 'tol':     return entry.team === 'home' ? 'home-tol'   : 'guest-tol';
      case 'penalty': return entry.team === 'home' ? 'home-penalty' : 'guest-penalty';
      default: return null;
    }
  }

  function entryHint(entry) {
    switch (entry.kind) {
      case 'clock':   return 'Enter MMSS or MSS, ENTER';
      case 'period':  return 'Enter period (1-9), ENTER';
      case 'score':   return `Enter ${entry.team} score, ENTER`;
      case 'shots':   return `Enter ${entry.team} shots, ENTER`;
      case 'tol':     return `Enter ${entry.team} T.O.L., ENTER`;
      case 'penalty':
        return entry.phase === 'player'
          ? `Enter ${entry.team} player #, ENTER`
          : `Enter duration MMSS / MSS, ENTER`;
    }
    return '';
  }

  function ledText() {
    if (state.flash && Date.now() < flashUntil) return state.flash;
    if (Date.now() < state.lampTestUntil) return 'LAMP TEST';
    if (!state.entry) {
      // Idle: show clock or status
      if (state.clockRunning) return formatClock(state.timeMs);
      return 'READY';
    }
    const e = state.entry;
    const buf = state.buffer || '';

    switch (e.kind) {
      case 'clock': {
        const preview = buf ? previewTime(buf) : '--:--';
        return `CLK ${preview}`;
      }
      case 'period': {
        return `PER ${buf || '-'}`;
      }
      case 'score': {
        const tag = e.team === 'home' ? 'HSC' : 'GSC';
        return `${tag} ${buf.padStart(2, '-')}`;
      }
      case 'shots': {
        const tag = e.team === 'home' ? 'HSH' : 'GSH';
        return `${tag} ${buf.padStart(2, '-')}`;
      }
      case 'tol': {
        const tag = e.team === 'home' ? 'HTO' : 'GTO';
        return `${tag} ${buf || '-'}`;
      }
      case 'penalty': {
        const tag = e.team === 'home' ? 'HPN' : 'GPN';
        if (e.phase === 'player') {
          return `${tag} P ${buf.padStart(2, '-')}`;
        } else {
          return `${tag} ${pad2(e.player)} ${previewTime(buf)}`;
        }
      }
    }
    return 'READY';
  }

  // ---------------------------------------------------------------
  // Tick loop (clock + penalties + auto horn + auto-render)
  // ---------------------------------------------------------------

  let lastTick = performance.now();

  function tick(now) {
    const dt = now - lastTick;
    lastTick = now;

    if (state.clockRunning) {
      state.timeMs -= dt;
      if (state.timeMs <= 0) {
        state.timeMs = 0;
        state.clockRunning = false;
        if (state.autoHorn) {
          state.autoHornUntil = Date.now() + 3000;
        }
      }
      // tick penalties
      tickPenalties('home', dt);
      tickPenalties('guest', dt);
    }

    // horn state
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

  function tickPenalties(team, dt) {
    const arr = state[team].penalties;
    if (!arr.length) return;
    // Only the first two active penalties count down (typical hockey rule:
    // a third coincident penalty is queued and starts when an active one
    // expires).
    const active = Math.min(2, arr.length);
    for (let i = 0; i < active; i++) {
      arr[i].remainingMs -= dt;
    }
    // Remove expired
    while (arr.length && arr[0].remainingMs <= 0) {
      arr.shift();
    }
    // If we removed from front, the queued one (index 2) becomes active
  }

  // ---------------------------------------------------------------
  // Actions / control flow
  // ---------------------------------------------------------------

  function inSetMode() { return state.toggle === 'up'; }

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

  function pressClockToggle() {
    if (state.entry && state.entry.kind === 'clock') {
      // can't run while editing clock
      return;
    }
    if (state.timeMs <= 0) return;
    cancelEntry();
    state.clockRunning = !state.clockRunning;
  }

  function pressClockSet() {
    if (state.clockRunning) return; // clock must be stopped
    if (state.entry && state.entry.kind === 'clock') {
      cancelEntry();
    } else {
      arm({ kind: 'clock' });
    }
  }

  function pressPeriod() {
    if (inSetMode()) {
      arm({ kind: 'period' });
    } else {
      cancelEntry();
      state.period = Math.min(MAX_PERIOD, state.period + 1);
      state.timeMs = PERIOD_DEFAULT_MS; // reset clock for new period
      state.clockRunning = false;
    }
  }

  function pressScore(team) {
    if (inSetMode()) {
      arm({ kind: 'score', team });
    } else {
      cancelEntry();
      bump(team, 'score', +1, MAX_SCORE);
    }
  }

  function pressShots(team) {
    if (inSetMode()) {
      arm({ kind: 'shots', team });
    } else {
      cancelEntry();
      bump(team, 'shots', +1, MAX_SHOTS);
    }
  }

  function pressTol(team) {
    if (inSetMode()) {
      arm({ kind: 'tol', team });
    } else {
      cancelEntry();
      bump(team, 'tol', -1, MAX_TOL);
    }
  }

  function pressPenalty(team) {
    if (state[team].penalties.length >= MAX_PENALTY_QUEUE) return;
    arm({ kind: 'penalty', team, phase: 'player', player: null });
  }

  function pressNum(d) {
    if (!state.entry) return;
    const e = state.entry;
    const max = numericMaxLen(e);
    if (state.buffer.length < max) state.buffer += d;
  }

  function numericMaxLen(e) {
    switch (e.kind) {
      case 'clock':   return 4;
      case 'period':  return 1;
      case 'score':   return 2;
      case 'shots':   return 2;
      case 'tol':     return 1;
      case 'penalty':
        return e.phase === 'player' ? 2 : 4;
    }
    return 2;
  }

  function pressBack() {
    if (!state.entry) return;
    if (state.buffer.length > 0) {
      state.buffer = state.buffer.slice(0, -1);
    }
  }

  function pressClear() {
    cancelEntry();
  }

  function pressEnter() {
    if (!state.entry) return;
    const e = state.entry;
    const buf = state.buffer;

    switch (e.kind) {
      case 'clock': {
        const ms = parseTimeDigits(buf);
        if (ms != null) state.timeMs = ms;
        cancelEntry();
        return;
      }
      case 'period': {
        const n = parseInt(buf, 10);
        if (!Number.isNaN(n) && n >= 1 && n <= MAX_PERIOD) {
          state.period = n;
        }
        cancelEntry();
        return;
      }
      case 'score': {
        const n = parseInt(buf, 10);
        if (!Number.isNaN(n) && n >= 0 && n <= MAX_SCORE) {
          state[e.team].score = n;
        }
        cancelEntry();
        return;
      }
      case 'shots': {
        const n = parseInt(buf, 10);
        if (!Number.isNaN(n) && n >= 0 && n <= MAX_SHOTS) {
          state[e.team].shots = n;
        }
        cancelEntry();
        return;
      }
      case 'tol': {
        const n = parseInt(buf, 10);
        if (!Number.isNaN(n) && n >= 0 && n <= MAX_TOL) {
          state[e.team].tol = n;
        }
        cancelEntry();
        return;
      }
      case 'penalty': {
        if (e.phase === 'player') {
          const player = parseInt(buf, 10);
          if (Number.isNaN(player) || player < 0 || player > 99) {
            // ignore
            return;
          }
          state.entry = { kind: 'penalty', team: e.team, phase: 'time', player };
          state.buffer = '';
          return;
        } else {
          const ms = parseTimeDigits(buf);
          if (ms != null && ms > 0) {
            state[e.team].penalties.push({
              player: e.player,
              remainingMs: ms,
            });
          }
          cancelEntry();
          return;
        }
      }
    }
  }

  function pressReset() {
    if (!inSetMode()) return; // safety: only reset in SET mode
    state.home  = { score: 0, shots: 0, tol: 1, penalties: [] };
    state.guest = { score: 0, shots: 0, tol: 1, penalties: [] };
    state.period = 1;
    state.timeMs = PERIOD_DEFAULT_MS;
    state.clockRunning = false;
    state.autoHornUntil = 0;
    cancelEntry();
  }

  function pressLampTest() {
    state.lampTestUntil = Date.now() + 3000;
    cancelEntry();
  }

  function pressAutoHorn() {
    state.autoHorn = !state.autoHorn;
    // give a brief LED hint
    flashLed(state.autoHorn ? 'AUTO ON' : 'AUTO OFF');
  }

  function flashLed(msg) {
    state.flash = msg;
    flashUntil = Date.now() + 1100;
  }

  function setHornManual(on) {
    state.hornManual = !!on;
  }

  function toggleSwitch() {
    state.toggle = state.toggle === 'up' ? 'down' : 'up';
    // SET mode requires clock stopped if currently editing a value
    if (state.toggle === 'down') {
      // switching to RUN: cancel pending numeric entries that require SET
      // (but keep penalty/clock entries since those work in both modes)
      if (state.entry && !['penalty', 'clock'].includes(state.entry.kind)) {
        cancelEntry();
      }
    }
  }

  // ---------------------------------------------------------------
  // Dispatcher
  // ---------------------------------------------------------------

  function doAction(action, val) {
    switch (action) {
      case 'clock-toggle':  pressClockToggle();   break;
      case 'clock-set':     pressClockSet();      break;
      case 'period':        pressPeriod();        break;
      case 'home-score':    pressScore('home');   break;
      case 'guest-score':   pressScore('guest');  break;
      case 'home-shots':    pressShots('home');   break;
      case 'guest-shots':   pressShots('guest');  break;
      case 'home-tol':      pressTol('home');     break;
      case 'guest-tol':     pressTol('guest');    break;
      case 'home-penalty':  pressPenalty('home'); break;
      case 'guest-penalty': pressPenalty('guest');break;
      case 'num':           pressNum(val);        break;
      case 'enter':         pressEnter();         break;
      case 'clear':         pressClear();         break;
      case 'back':          pressBack();          break;
      case 'reset':         pressReset();         break;
      case 'lamp-test':     pressLampTest();      break;
      case 'auto-horn':     pressAutoHorn();      break;
    }
  }

  // ---------------------------------------------------------------
  // UI bindings
  // ---------------------------------------------------------------

  function bindKeypad() {
    document.querySelectorAll('.key').forEach(btn => {
      const action = btn.dataset.action;
      if (!action) return;

      if (action === 'horn') {
        // Press & hold semantics for horn button
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
        doAction(action, btn.dataset.val);
        // brief visual feedback
        btn.classList.add('pressed');
        setTimeout(() => btn.classList.remove('pressed'), 90);
      });
    });
  }

  function bindToggle() {
    els.toggle.addEventListener('click', (e) => {
      e.preventDefault();
      ensureAudio();
      toggleSwitch();
    });
  }

  function bindKeyboard() {
    // Avoid duplicate horn-on from key repeat
    let hornHeld = false;
    let spaceHeld = false; // prevent toggle on key-repeat

    document.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (!spaceHeld) {
          spaceHeld = true;
          ensureAudio();
          toggleSwitch();
        }
      } else if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        if (!hornHeld) {
          hornHeld = true;
          ensureAudio();
          setHornManual(true);
          els.hornButton.classList.add('pressed');
        }
      }
    });

    document.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.code === 'Space') {
        spaceHeld = false;
      } else if (e.key === 'h' || e.key === 'H') {
        hornHeld = false;
        setHornManual(false);
        els.hornButton.classList.remove('pressed');
      }
    });

    window.addEventListener('blur', () => {
      hornHeld = false;
      spaceHeld = false;
      setHornManual(false);
      els.hornButton.classList.remove('pressed');
    });
  }

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------

  function init() {
    bindKeypad();
    bindToggle();
    bindKeyboard();
    requestAnimationFrame((t) => { lastTick = t; tick(t); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
