/* ====================================================================
   Nevco 4770 Hockey Scoreboard Emulator — MPCW-7 controller logic.

   Control model (matches the real MPCW-7):
     - SET key toggles SET mode. In SET mode pressing a field key
       (TIME / PERIOD / HOME SCORE / GUEST SCORE / GOAL SHOTS / GOAL SAVES)
       arms a numeric entry. Type digits, then ENTER to apply, CANCEL
       to abort.
     - Outside SET mode the same field keys directly increment.
     - TIME ON / TIME OFF start / stop the game clock (separate keys).
     - NEW MINOR / NEW MAJOR add a 2:00 / 5:00 penalty for that team;
       you are then asked for the player number (digits + ENTER).
     - INSERT PENALTY waits for a team key (HOME / GUESTS), then
       player # ENTER, then duration MMSS or MSS ENTER.
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
  const MINOR_MS = 2 * 60 * 1000;
  const MAJOR_MS = 5 * 60 * 1000;
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
    autoHorn: true,
    autoHornUntil: 0,
    setMode: false,         // true when SET has been pressed (awaits a field)
    entry: null,            // current numeric-entry context
    buffer: '',             // digits typed
    penaltyPaused: false,
    blanked: false,
    goalLightUntil: 0,
    flash: null,            // transient LED message
    flashUntil: 0,
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
    homeTol:    $('home-tol'),
    guestTol:   $('guest-tol'),
    period:     $('period'),
    time:       $('time'),
    timeBg:     $('time-bg'),
    hornInd:    $('horn-indicator'),
    goalLight:  $('goal-light'),
    led:        $('led-text'),
    ledHint:    $('led-hint'),
    setLed:     $('set-led'),
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
    if (ms >= 60 * 1000) {
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
    if (ms <= 0) return '00:00';
    const total = Math.ceil(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${pad2(m)}:${pad2(s)}`;
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

  function formatWallClock() {
    const d = new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}.${pad2(d.getSeconds())}`;
  }

  // ---------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------

  function renderScoreboard() {
    if (state.blanked) {
      els.homeScore.textContent  = '';
      els.guestScore.textContent = '';
      els.homeShots.textContent  = '';
      els.guestShots.textContent = '';
      els.homeTol.textContent    = '';
      els.guestTol.textContent   = '';
      els.period.textContent     = '';
      els.time.textContent       = '';
      els.homePen.forEach(p => { p.player.textContent = ''; p.time.textContent = ''; });
      els.guestPen.forEach(p => { p.player.textContent = ''; p.time.textContent = ''; });
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
      renderPenaltySlots(els.homePen,  state.home.penalties);
      renderPenaltySlots(els.guestPen, state.guest.penalties);
    }
    els.hornInd.classList.toggle('on', state.hornOn && !state.blanked);
    els.goalLight.classList.toggle('on', Date.now() < state.goalLightUntil && !state.blanked);
  }

  function renderPenaltySlots(slots, penalties) {
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
    // SET LED
    els.setLed.classList.toggle('on', state.setMode);
    els.setBtn.classList.toggle('armed', state.setMode && !state.entry);

    // Mode hint
    let hint;
    if (state.entry) {
      hint = entryHint(state.entry);
    } else if (state.setMode) {
      hint = 'SET MODE · press a field to edit';
    } else if (state.penaltyPaused) {
      hint = 'PENALTY OFF · countdown paused';
    } else {
      hint = state.clockRunning ? 'RUN' : 'READY';
    }
    els.ledHint.textContent = hint;

    // LED text
    els.led.textContent = ledText();

    // Highlight armed dedicated key
    document.querySelectorAll('.key.armed').forEach(k => {
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
        if (entry.minor) return `[data-action="new-minor"][data-team="${entry.team}"]`;
        if (entry.major) return `[data-action="new-major"][data-team="${entry.team}"]`;
        return '[data-action="insert-penalty"]';
      case 'await-team':  return `[data-action="${entry.then}"]`;
      case 'clear-slot':  return '[data-action="clear-penalty"]';
      default: return null;
    }
  }

  function entryHint(e) {
    switch (e.kind) {
      case 'clock':   return 'TIME · enter MMSS / MSS, ENTER';
      case 'period':  return 'PERIOD · enter 1-9, ENTER';
      case 'score':   return `${e.team.toUpperCase()} SCORE · enter, ENTER`;
      case 'shots':   return `${e.team.toUpperCase()} SHOTS · enter, ENTER`;
      case 'saves':   return `${e.team.toUpperCase()} SAVES · enter, ENTER`;
      case 'tol':     return `${e.team.toUpperCase()} T.O.L. · enter, ENTER`;
      case 'penalty':
        if (e.phase === 'player') {
          const tag = e.minor ? 'MINOR' : (e.major ? 'MAJOR' : 'PEN');
          return `${e.team.toUpperCase()} ${tag} · player # ENTER`;
        }
        return `${e.team.toUpperCase()} PEN · MMSS / MSS, ENTER`;
      case 'await-team':
        return `Press HOME or GUESTS to select team`;
      case 'clear-slot':
        return `${e.team.toUpperCase()} CLEAR · press 1 or 2`;
    }
    return '';
  }

  function ledText() {
    if (state.flash && Date.now() < state.flashUntil) return state.flash;
    if (state.blanked) return 'BLANK';
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

  // ---------------------------------------------------------------
  // Tick loop
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
        if (state.autoHorn) state.autoHornUntil = Date.now() + AUTO_HORN_MS;
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

  function pressTimeOn() {
    cancelEntry();
    state.setMode = false;
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
    arm({
      kind: 'penalty',
      team,
      phase: 'player',
      player: null,
      duration: kind === 'minor' ? MINOR_MS : MAJOR_MS,
      minor: kind === 'minor',
      major: kind === 'major',
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
    if (state.entry) {
      cancelEntry();
    } else if (state.setMode) {
      state.setMode = false;
    }
  }

  function pressEnter() {
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
          const player = parseInt(buf, 10);
          if (Number.isNaN(player) || player < 0 || player > 99) {
            flashLed('BAD #');
            return;
          }
          if (e.duration != null) {
            state[e.team].penalties.push({ player, remainingMs: e.duration });
            cancelEntry();
            flashLed(`${e.team === 'home' ? 'H' : 'G'}-PEN`);
            return;
          }
          state.entry = { kind: 'penalty', team: e.team, phase: 'time', player };
          state.buffer = '';
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

  function pressOptions() {
    flashLed('OPTIONS');
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
  // UI bindings
  // ---------------------------------------------------------------

  function bindKeypad() {
    document.querySelectorAll('.key').forEach(btn => {
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
        doAction(action, btn.dataset.val, btn.dataset.team);
        btn.classList.add('pressed');
        setTimeout(() => btn.classList.remove('pressed'), 90);
      });
    });
  }

  function bindKeyboard() {
    let hornHeld = false;
    let setHeld = false;

    document.addEventListener('keydown', (e) => {
      // Don't capture keys when focus is on a real input
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;

      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (!setHeld) {
          setHeld = true;
          ensureAudio();
          pressSet();
        }
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
      if (e.key === ' ' || e.code === 'Space') {
        setHeld = false;
      } else if (e.key === 'h' || e.key === 'H') {
        hornHeld = false;
        setHornManual(false);
        els.hornButton.classList.remove('pressed');
      }
    });

    window.addEventListener('blur', () => {
      hornHeld = false;
      setHeld = false;
      setHornManual(false);
      els.hornButton.classList.remove('pressed');
    });
  }

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------

  function init() {
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
