/* ============================================================
   Game controller + rendering + sound + interaction
   ============================================================ */
(function () {
  'use strict';

  const P = window.Poker;
  const AI = window.PokerAI;
  const HoldemTable = window.HoldemTable;

  const DIFFICULTY_LABELS = { easy: '简单', medium: '中等', hard: '困难' };
  const PHASE_LABELS = {
    preflop: '翻牌前',
    flop: '翻牌圈',
    turn: '转牌圈',
    river: '河牌圈',
    handover: '本手结束',
    idle: '等待'
  };
  const STREET_HINTS = {
    preflop: '按钮位兼小盲，翻牌前先行动',
    flop: '翻牌圈 · 非按钮位先行动',
    turn: '转牌圈 · 非按钮位先行动',
    river: '河牌圈 · 非按钮位先行动'
  };

  function $(id) { return document.getElementById(id); }
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function fmt(value) { return Math.round(value).toLocaleString('zh-CN'); }
  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (error) { return null; }
  }
  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (error) { /* file:// may be restricted */ }
  }
  function roundChips(value) {
    if (value >= 200) return Math.round(value / 10) * 10;
    if (value >= 50) return Math.round(value / 5) * 5;
    return Math.round(value);
  }

  function emptyPlayerStats() {
    return {
      hands: 0,
      actions: 0,
      raises: 0,
      folds: 0,
      checks: 0,
      calls: 0,
      facedBet: 0,
      foldsToBet: 0,
      callsToBet: 0
    };
  }

  /* ============================================================
     SOUND
     ============================================================ */

  class SoundFX {
    constructor() {
      this.enabled = true;
      this.ctx = null;
    }

    ensure() {
      if (!this.enabled) return null;
      if (!this.ctx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return null;
        try { this.ctx = new AudioContextClass(); } catch (error) { return null; }
      }
      if (this.ctx.state === 'suspended') {
        try { this.ctx.resume(); } catch (error) { /* ignore */ }
      }
      return this.ctx;
    }

    tone(frequency, duration, type, volume, delay, endFrequency) {
      const ctx = this.ensure();
      if (!ctx) return;
      const start = ctx.currentTime + (delay || 0);
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = type || 'sine';
      oscillator.frequency.setValueAtTime(Math.max(20, frequency), start);
      if (endFrequency) {
        oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), start + duration);
      }
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.03);
    }

    noise(duration, volume, delay) {
      const ctx = this.ensure();
      if (!ctx) return;
      const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1800;
      filter.Q.value = 0.7;
      const gain = ctx.createGain();
      const start = ctx.currentTime + (delay || 0);
      gain.gain.setValueAtTime(volume, start);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      source.start(start);
    }

    play(kind) {
      if (!this.enabled) return;
      if (kind === 'click') {
        this.tone(540, 0.055, 'triangle', 0.018, 0, 380);
      } else if (kind === 'deal') {
        this.noise(0.07, 0.022, 0);
        this.tone(260, 0.05, 'triangle', 0.012, 0.01);
      } else if (kind === 'flip') {
        this.tone(650, 0.045, 'triangle', 0.012, 0, 820);
      } else if (kind === 'chip') {
        this.tone(760, 0.05, 'sine', 0.016, 0);
        this.tone(1040, 0.065, 'sine', 0.014, 0.045);
      } else if (kind === 'check') {
        this.tone(430, 0.06, 'sine', 0.012, 0);
      } else if (kind === 'raise') {
        this.tone(620, 0.06, 'triangle', 0.018, 0);
        this.tone(920, 0.08, 'sine', 0.015, 0.05);
      } else if (kind === 'allin') {
        this.tone(120, 0.24, 'sine', 0.045, 0);
        this.tone(180, 0.22, 'triangle', 0.025, 0.02);
        this.noise(0.12, 0.018, 0.02);
      } else if (kind === 'win') {
        [523.25, 659.25, 783.99, 1046.5].forEach((note, index) => {
          this.tone(note, 0.24, 'sine', 0.022, index * 0.09);
        });
      } else if (kind === 'lose') {
        [329.63, 277.18, 220].forEach((note, index) => {
          this.tone(note, 0.28, 'sine', 0.018, index * 0.12);
        });
      } else if (kind === 'split') {
        this.tone(440, 0.2, 'sine', 0.018, 0);
        this.tone(554.37, 0.24, 'sine', 0.016, 0.1);
      }
    }
  }

  const Sound = new SoundFX();

  /* ============================================================
     CARD DOM HELPERS
     ============================================================ */

  function createCardNode() {
    const node = document.createElement('div');
    node.className = 'playing-card is-empty';
    node.innerHTML =
      '<div class="card-inner">' +
        '<div class="card-side card-back"></div>' +
        '<div class="card-side card-front">' +
          '<span class="card-corner top"><span class="rank"></span><span class="suit"></span></span>' +
          '<span class="card-pip"></span>' +
          '<span class="card-corner bottom"><span class="rank"></span><span class="suit"></span></span>' +
        '</div>' +
      '</div>';
    const front = node.querySelector('.card-front');
    node.__ui = {
      front: front,
      rankTop: front.querySelector('.card-corner.top .rank'),
      suitTop: front.querySelector('.card-corner.top .suit'),
      rankBottom: front.querySelector('.card-corner.bottom .rank'),
      suitBottom: front.querySelector('.card-corner.bottom .suit'),
      pip: front.querySelector('.card-pip')
    };
    return node;
  }

  function resetCardNode(node) {
    node.classList.add('is-empty');
    node.classList.remove('is-face-up', 'is-winning', 'is-dim', 'is-dealt');
    node.removeAttribute('data-card');
    node.style.animationDelay = '';
  }

  function setCardNode(node, card, faceUp, animate, delay) {
    if (!card) {
      resetCardNode(node);
      return;
    }
    const isNew = node.classList.contains('is-empty') || node.getAttribute('data-card') !== card.id;
    node.classList.remove('is-empty', 'is-dim');
    node.dataset.card = card.id;
    const suit = P.SUITS[card.s];
    const red = suit.color === 'red';
    const ui = node.__ui;
    ui.front.dataset.rank = card.r;
    ui.front.classList.toggle('is-red', red);
    ui.rankTop.textContent = card.r;
    ui.rankBottom.textContent = card.r;
    ui.suitTop.textContent = suit.symbol;
    ui.suitBottom.textContent = suit.symbol;
    ui.pip.textContent = suit.symbol;
    node.classList.toggle('is-face-up', !!faceUp);

    if (animate && isNew) {
      node.classList.remove('is-dealt');
      node.style.animationDelay = (delay || 0) + 'ms';
      void node.offsetWidth;
      node.classList.add('is-dealt');
      window.setTimeout(function () {
        node.classList.remove('is-dealt');
        node.style.animationDelay = '';
      }, 650 + (delay || 0));
    }
  }

  /* ============================================================
     APP
     ============================================================ */

  class PokerApp {
    constructor() {
      this.table = null;
      this.selectedDifficulty = storageGet('headsUpPoker.difficulty') || 'medium';
      this.soundOn = storageGet('headsUpPoker.sound') !== '0';
      this.epoch = 0;
      this.resolving = false;
      this.transitioning = false;
      this.actionPending = false;
      this.aiThinking = false;
      this.revealAI = false;
      this.result = null;
      this.resultVisible = false;
      this.resultShown = false;
      this.settledHand = 0;
      this.lastActions = { player: '', ai: '' };
      this.playerRaisedPreflop = false;
      this.playerStats = emptyPlayerStats();
      this.stats = { hands: 0, wins: 0, losses: 0, splits: 0, biggestPot: 0 };
      this.holeHand = 0;
      this.boardHand = 0;
      this.boardCount = 0;
      this.holeReveal = false;
      this.currentRaise = 0;
      this.timers = { ai: null, result: null, begin: null, toast: null, confetti: null };
      this.modalName = null;
      this.starting = false;
    }

    init() {
      this.cacheDom();
      this.buildCards();
      this.bindEvents();
      Sound.enabled = this.soundOn;
      this.updateSoundButton();
      this.selectDifficulty(this.selectedDifficulty, true);
      this.renderLobby();
      this.showScreen('lobby', true);
      window.PokerApp = this;
    }

    cacheDom() {
      const id = function (name) { return document.getElementById(name); };
      this.el = {
        lobby: id('lobby'),
        game: id('game'),
        startBtn: id('startBtn'),
        lobbyRulesBtn: id('lobbyRulesBtn'),
        difficultyCards: Array.from(document.querySelectorAll('.difficulty-card')),
        soundBtn: id('soundBtn'),
        helpBtn: id('helpBtn'),
        leaveBtn: id('leaveBtn'),
        blindDisplay: id('blindDisplay'),
        handDisplay: id('handDisplay'),
        difficultyPill: id('difficultyPill'),
        aiName: id('aiName'),
        aiStack: id('aiStack'),
        playerStack: id('playerStack'),
        aiBadge: id('aiBadge'),
        playerBadge: id('playerBadge'),
        aiDealer: id('aiDealer'),
        playerDealer: id('playerDealer'),
        aiBet: id('aiBet'),
        playerBet: id('playerBet'),
        aiBubble: id('aiBubble'),
        playerBubble: id('playerBubble'),
        aiSeat: id('aiSeat'),
        playerSeat: id('playerSeat'),
        aiCards: id('aiCards'),
        playerCards: id('playerCards'),
        board: id('board'),
        potAmount: id('potAmount'),
        streetLabel: id('streetLabel'),
        tableMessage: id('tableMessage'),
        playerHint: id('playerHint'),
        statusDot: id('statusDot'),
        controls: id('controls'),
        phasePill: id('phasePill'),
        infoBlinds: id('infoBlinds'),
        infoHand: id('infoHand'),
        infoButton: id('infoButton'),
        infoRecord: id('infoRecord'),
        rankHint: id('rankHint'),
        drawHint: id('drawHint'),
        potOddsHint: id('potOddsHint'),
        logList: id('logList'),
        logTag: id('logTag'),
        resultOverlay: id('resultOverlay'),
        resultKicker: id('resultKicker'),
        resultEmblem: id('resultEmblem'),
        resultTitle: id('resultTitle'),
        resultSubtitle: id('resultSubtitle'),
        resultHands: id('resultHands'),
        resultPot: id('resultPot'),
        resultNet: id('resultNet'),
        resultContinue: id('resultContinue'),
        resultView: id('resultView'),
        confetti: id('confetti'),
        modalLayer: id('modalLayer'),
        rulesModal: id('rulesModal'),
        leaveModal: id('leaveModal'),
        leaveCancel: id('leaveCancel'),
        leaveConfirm: id('leaveConfirm'),
        toast: id('toast')
      };
      this.el.difficultyLabel = this.el.difficultyPill.querySelector('span');
    }

    buildCards() {
      this.holeNodes = { player: [], ai: [] };
      for (let i = 0; i < 2; i++) {
        const playerNode = createCardNode();
        const aiNode = createCardNode();
        this.el.playerCards.appendChild(playerNode);
        this.el.aiCards.appendChild(aiNode);
        this.holeNodes.player.push(playerNode);
        this.holeNodes.ai.push(aiNode);
      }
      this.boardNodes = [];
      for (let i = 0; i < 5; i++) {
        const node = createCardNode();
        this.el.board.appendChild(node);
        this.boardNodes.push(node);
      }
    }

    bindEvents() {
      this.el.startBtn.addEventListener('click', () => {
        Sound.ensure();
        Sound.play('click');
        this.startNewMatch(this.selectedDifficulty);
      });

      this.el.difficultyCards.forEach((card) => {
        card.addEventListener('click', () => {
          Sound.play('click');
          this.selectDifficulty(card.dataset.difficulty);
        });
      });

      this.el.lobbyRulesBtn.addEventListener('click', () => this.openModal('rules'));
      this.el.helpBtn.addEventListener('click', () => this.openModal('rules'));
      this.el.leaveBtn.addEventListener('click', () => this.openModal('leave'));
      this.el.soundBtn.addEventListener('click', () => this.toggleSound());
      this.el.leaveCancel.addEventListener('click', () => this.closeModal());
      this.el.leaveConfirm.addEventListener('click', () => {
        this.closeModal();
        this.leaveToLobby();
      });

      this.el.resultContinue.addEventListener('click', () => this.continueFromResult());
      this.el.resultView.addEventListener('click', () => this.viewTableFromResult());

      document.querySelectorAll('[data-close-modal]').forEach((node) => {
        node.addEventListener('click', () => this.closeModal());
      });

      this.el.controls.addEventListener('click', (event) => {
        const button = event.target.closest('[data-action], [data-fraction], [data-allin]');
        if (!button) return;
        if (button.hasAttribute('data-allin')) {
          this.setRaiseTarget(this.maxRaiseTarget());
          Sound.play('click');
          return;
        }
        if (button.hasAttribute('data-fraction')) {
          const fraction = parseFloat(button.getAttribute('data-fraction'));
          this.setRaiseTarget(this.quickRaiseTarget(fraction));
          Sound.play('click');
          return;
        }
        const action = button.getAttribute('data-action');
        if (action === 'continue') {
          this.continueFromResult();
        } else if (action === 'fold') {
          this.playerAction('fold');
        } else if (action === 'check') {
          this.playerAction('check');
        } else if (action === 'call') {
          this.playerAction('call');
        } else if (action === 'raise') {
          this.playerAction('raise', this.currentRaise);
        }
      });

      this.el.controls.addEventListener('input', (event) => {
        if (event.target && event.target.id === 'raiseSlider') {
          this.setRaiseTarget(Number(event.target.value), false);
        }
      });

      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          if (this.modalName) { this.closeModal(); return; }
          if (this.resultVisible) { this.viewTableFromResult(); return; }
        }
        if (this.modalName || this.resultVisible) return;
        if (event.target && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
        if (event.repeat) return;
        if (!this.isPlayerTurn()) return;
        const key = event.key.toLowerCase();
        if (key === 'f') {
          event.preventDefault();
          this.playerAction('fold');
        } else if (key === 'c') {
          event.preventDefault();
          const legal = this.table.getLegalActions('player');
          this.playerAction(legal.canCheck ? 'check' : 'call');
        }
      });

      document.addEventListener('pointerdown', function once() {
        Sound.ensure();
        document.removeEventListener('pointerdown', once);
      });
    }

    /* ---------- lobby / screens ---------- */

    selectDifficulty(difficulty, silent) {
      if (!DIFFICULTY_LABELS[difficulty]) difficulty = 'medium';
      this.selectedDifficulty = difficulty;
      this.el.difficultyCards.forEach((card) => {
        const selected = card.dataset.difficulty === difficulty;
        card.classList.toggle('is-selected', selected);
        card.setAttribute('aria-pressed', selected ? 'true' : 'false');
      });
      storageSet('headsUpPoker.difficulty', difficulty);
      if (!silent) this.renderLobby();
    }

    renderLobby() {
      const profile = AI.PROFILES[this.selectedDifficulty];
      if (this.el.startBtn) {
        this.el.startBtn.querySelector('span').textContent = '挑战' + profile.name;
      }
      this.el.difficultyLabel.textContent = DIFFICULTY_LABELS[this.selectedDifficulty];
    }

    showScreen(name, immediate) {
      const lobbyActive = name === 'lobby';
      this.el.lobby.classList.toggle('is-active', lobbyActive);
      this.el.game.classList.toggle('is-active', !lobbyActive);
      if (immediate) {
        this.el.lobby.style.transition = 'none';
        this.el.game.style.transition = 'none';
        window.requestAnimationFrame(() => {
          this.el.lobby.style.transition = '';
          this.el.game.style.transition = '';
        });
      }
    }

    /* ---------- match lifecycle ---------- */

    startNewMatch(difficulty) {
      if (this.starting) return;
      this.starting = true;
      this.clearTimers();
      this.epoch++;
      this.selectDifficulty(difficulty, true);
      this.stats = { hands: 0, wins: 0, losses: 0, splits: 0, biggestPot: 0 };
      this.playerStats = emptyPlayerStats();
      this.playerRaisedPreflop = false;
      this.result = null;
      this.resultVisible = false;
      this.resultShown = false;
      this.settledHand = 0;
      this.revealAI = false;
      this.lastActions = { player: '', ai: '' };
      this.holeHand = 0;
      this.boardHand = 0;
      this.boardCount = 0;
      this.holeReveal = false;
      this._logLength = -1;
      this._logHand = -1;
      this.resolving = false;
      this.transitioning = false;
      this.actionPending = false;
      this.aiThinking = false;
      this.currentRaise = 0;
      this.el.resultOverlay.hidden = true;
      this.closeModal();
      this.table = new HoldemTable({
        startingStack: 1000,
        aiName: AI.PROFILES[difficulty].name,
        handsPerLevel: 10
      });
      this.renderAll();
      this.showScreen('game');
      Sound.play('click');
      this.timers.begin = window.setTimeout(() => {
        this.starting = false;
        this.beginHand();
      }, 280);
    }

    beginHand() {
      if (!this.table || this.table.matchOver) return;
      this.clearTimers();
      const epoch = ++this.epoch;
      this.hideResult();
      this.result = null;
      this.resultShown = false;
      this.settledHand = 0;
      this.revealAI = false;
      this.holeReveal = false;
      this.lastActions = { player: '', ai: '' };
      this.playerRaisedPreflop = false;
      this.transitioning = true;
      this.resolving = false;
      this.actionPending = false;
      this.aiThinking = false;
      this.currentRaise = 0;
      const started = this.table.startHand();
      if (!started.ok) {
        this.transitioning = false;
        if (this.table.matchOver) this.showMatchOverFallback();
        return;
      }
      this.renderAll();
      Sound.play('deal');
      this.timers.begin = window.setTimeout(() => {
        if (epoch !== this.epoch) return;
        this.transitioning = false;
        this.renderAll();
        if (this.table.handOver) {
          this.finishHand(this.table.result);
        } else if (this.table.streetComplete) {
          this.resolveRound();
        } else if (this.table.currentActor === 'ai') {
          this.scheduleAI();
        }
      }, 620);
    }

    showMatchOverFallback() {
      this.toast('比赛已经结束');
      this.showScreen('lobby');
    }

    leaveToLobby() {
      this.epoch++;
      this.clearTimers();
      this.table = null;
      this.starting = false;
      this.resolving = false;
      this.aiThinking = false;
      this.transitioning = false;
      this.currentRaise = 0;
      this.result = null;
      this.resultVisible = false;
      this.el.resultOverlay.hidden = true;
      this.closeModal();
      this.showScreen('lobby');
      this.renderLobby();
    }

    /* ---------- player action ---------- */

    isPlayerTurn() {
      return !!this.table &&
        !this.table.handOver &&
        !this.transitioning &&
        !this.actionPending &&
        this.table.currentActor === 'player' &&
        !this.table.streetComplete;
    }

    playerAction(type, amount) {
      if (!this.isPlayerTurn()) return;
      const legal = this.table.getLegalActions('player');
      if (!legal.available) return;
      if (type === 'check' && !legal.canCheck) return;
      if (type === 'call' && !legal.canCall) return;
      if (type === 'fold' && legal.canCheck && this.table.currentBet === 0) {
        // Standard rules permit folding at any time, but checking is free.
        // Keep the button available; no extra restriction.
      }
      if (type === 'raise' && !legal.canRaise) return;

      const phase = this.table.phase;
      const toCall = legal.toCall;
      let action;
      if (type === 'raise') {
        let target = Number(amount);
        if (!Number.isFinite(target)) target = legal.raise.min;
        target = clamp(Math.round(target), legal.raise.min, legal.raise.max);
        action = { type: 'raise', amount: target };
      } else {
        action = { type: type };
      }

      this.actionPending = true;
      const result = this.table.act('player', action);
      if (!result.ok) {
        this.actionPending = false;
        this.toast(result.error || '无效行动');
        this.renderAll();
        return;
      }

      this.updatePlayerStats(type, toCall, phase);
      this.recordLastAction('player');
      this.playActionSound(type, action.amount, legal);
      this.actionPending = false;

      if (result.handOver) {
        this.finishHand(result.result);
        return;
      }
      this.renderAll();
      if (result.streetComplete) {
        this.resolveRound();
      } else if (this.table.currentActor === 'ai') {
        this.scheduleAI();
      }
    }

    updatePlayerStats(type, toCall, phase) {
      const stats = this.playerStats;
      stats.actions++;
      if (type === 'raise') {
        stats.raises++;
        if (phase === 'preflop') this.playerRaisedPreflop = true;
      } else if (type === 'fold') {
        stats.folds++;
      } else if (type === 'check') {
        stats.checks++;
      } else if (type === 'call') {
        stats.calls++;
      }
      if (toCall > 0) {
        stats.facedBet++;
        if (type === 'fold') stats.foldsToBet++;
        if (type === 'call') stats.callsToBet++;
      }
    }

    playActionSound(type, amount, legal) {
      if (type === 'fold') Sound.play('click');
      else if (type === 'check') Sound.play('check');
      else if (type === 'call') Sound.play(legal && legal.callAmount >= this.table.stacks.player ? 'allin' : 'chip');
      else if (type === 'raise') {
        const isAllIn = amount >= legal.raise.max;
        Sound.play(isAllIn ? 'allin' : 'raise');
      }
    }

    recordLastAction(seat) {
      const last = this.table.lastAction;
      if (!last || last.seat !== seat) return;
      let label = '';
      if (last.type === 'fold') label = '弃牌';
      else if (last.type === 'check') label = '过牌';
      else if (last.type === 'call') label = '跟注 ' + fmt(last.amount) + (last.allIn ? ' · 全下' : '');
      else if (last.type === 'bet') label = '下注 ' + fmt(last.amount) + (last.allIn ? ' · 全下' : '');
      else if (last.type === 'raise') label = '加注到 ' + fmt(last.amount) + (last.allIn ? ' · 全下' : '');
      this.lastActions[seat] = label;
    }

    /* ---------- AI ---------- */

    scheduleAI() {
      if (!this.table || this.table.handOver) return;
      if (this.table.currentActor !== 'ai') return;
      const epoch = this.epoch;
      this.clearTimeout('ai');
      this.aiThinking = true;
      this.actionPending = true;
      this.renderSeats();
      this.renderBubbles();
      this.renderControls();
      this.renderStatus();
      const delay = 700 + Math.floor(Math.random() * 520);
      this.timers.ai = window.setTimeout(() => {
        if (epoch !== this.epoch || !this.table || this.table.handOver) return;
        if (this.table.currentActor !== 'ai') return;
        const legal = this.table.getLegalActions('ai');
        if (!legal.available) {
          this.aiThinking = false;
          this.actionPending = false;
          return;
        }
        const context = AI.makeContext(this.table, this.selectedDifficulty, this.playerStats, {
          playerRaisedPreflop: this.playerRaisedPreflop
        });
        let decision = AI.decide(context);
        this.aiThinking = false;
        this.actionPending = false;

        let result = this.table.act('ai', decision);
        if (!result.ok) {
          // Safety net: an AI should never wedge the table.
          const fallback = legal.canCheck
            ? { type: 'check' }
            : (legal.canCall ? { type: 'call' } : { type: 'fold' });
          result = this.table.act('ai', fallback);
          decision = fallback;
        }
        if (!result.ok) {
          this.toast('AI 行动异常，已为你跳过本手');
          console.error('AI action failed', decision, result);
          return;
        }
        this.recordLastAction('ai');
        const allIn = decision.type === 'raise' && decision.amount >= (legal.raise ? legal.raise.max : Infinity);
        Sound.play(decision.type === 'raise' ? (allIn ? 'allin' : 'raise') : decision.type === 'fold' ? 'click' : decision.type === 'check' ? 'check' : 'chip');
        this.renderAll();

        if (result.handOver) {
          this.finishHand(result.result);
        } else if (result.streetComplete) {
          this.resolveRound();
        } else {
          // Heads-up: after the AI acts, the player is next.
          this.renderAll();
        }
      }, delay);
    }

    /* ---------- street flow ---------- */

    async resolveRound() {
      if (!this.table || this.resolving) return;
      const epoch = this.epoch;
      this.resolving = true;
      this.transitioning = true;
      this.actionPending = false;
      this.aiThinking = false;
      this.lastActions = { player: '', ai: '' };
      this.renderAll();

      await sleep(620);
      if (epoch !== this.epoch || !this.table || this.table.handOver) {
        this.resolving = false;
        return;
      }

      if (this.table.isAllIn()) this.table.refundUncalled();

      if (this.table.board.length >= 5) {
        this.transitioning = false;
        this.resolving = false;
        const result = this.table.showdown();
        if (result.ok) this.finishHand(result.result);
        else {
          this.toast('摊牌异常');
          renderFallback(this);
        }
        return;
      }

      const next = this.table.nextStreet();
      if (!next.ok) {
        this.resolving = false;
        this.transitioning = false;
        this.toast(next.error || '发牌异常');
        this.renderAll();
        return;
      }
      this.renderAll();
      Sound.play('deal');

      await sleep(720);
      if (epoch !== this.epoch || !this.table) {
        this.resolving = false;
        return;
      }

      if (this.table.isAllIn()) {
        this.resolving = false;
        // Run out the remaining board, then showdown.
        await this.resolveRound();
        return;
      }

      this.transitioning = false;
      this.resolving = false;
      this.lastActions = { player: '', ai: '' };
      this.renderAll();
      if (this.table.currentActor === 'ai') this.scheduleAI();
    }

    finishHand(result) {
      if (!result || !this.table) return;
      if (this.settledHand === this.table.handNo) return;
      this.settledHand = this.table.handNo;
      this.clearTimeout('ai');
      this.aiThinking = false;
      this.actionPending = false;
      this.transitioning = false;
      this.resolving = false;
      this.result = result;
      this.revealAI = result.type === 'showdown';
      this.holeReveal = this.revealAI;

      this.stats.hands++;
      if (result.winner === 'player') this.stats.wins++;
      else if (result.winner === 'ai') this.stats.losses++;
      else this.stats.splits++;
      if (result.pot > this.stats.biggestPot) this.stats.biggestPot = result.pot;

      this.renderAll();
      if (result.type === 'showdown') Sound.play('flip');
      if (result.winner === 'player') Sound.play('win');
      else if (result.winner === 'ai') Sound.play('lose');
      else Sound.play('split');

      const epoch = this.epoch;
      this.clearTimeout('result');
      this.timers.result = window.setTimeout(() => {
        if (epoch !== this.epoch) return;
        this.showResult();
      }, 760);
    }

    /* ---------- result overlay ---------- */

    showResult() {
      if (!this.result || !this.table) return;
      const result = this.result;
      const matchOver = !!result.matchOver;
      this.resultVisible = true;
      this.resultShown = true;

      if (matchOver) {
        this.el.resultKicker.textContent = 'MATCH COMPLETE';
        this.el.resultTitle.textContent = result.playerStack > 0 ? '你赢下了整场比赛' : 'AI 赢下了整场比赛';
        this.el.resultEmblem.textContent = result.playerStack > 0 ? '♠' : '♣';
        this.el.resultSubtitle.textContent = '第 ' + this.table.handNo + ' 手结束 · 最终筹码 你 ' +
          fmt(result.playerStack) + ' / ' + this.table.aiName + ' ' + fmt(result.aiStack);
      } else {
        this.el.resultKicker.textContent = 'HAND COMPLETE';
        if (result.type === 'fold') {
          if (result.winner === 'player') {
            this.el.resultTitle.textContent = '对手弃牌';
            this.el.resultSubtitle.textContent = '你收下底池，牌面没有摊开。';
            this.el.resultEmblem.textContent = '♠';
          } else {
            this.el.resultTitle.textContent = '你已弃牌';
            this.el.resultSubtitle.textContent = '这手牌结束，调整节奏再战下一手。';
            this.el.resultEmblem.textContent = '♣';
          }
        } else if (result.winner === 'player') {
          this.el.resultTitle.textContent = '你赢了';
          this.el.resultSubtitle.textContent = result.reason;
          this.el.resultEmblem.textContent = '♠';
        } else if (result.winner === 'ai') {
          this.el.resultTitle.textContent = '你输了';
          this.el.resultSubtitle.textContent = result.reason;
          this.el.resultEmblem.textContent = '♣';
        } else {
          this.el.resultTitle.textContent = '平分底池';
          this.el.resultSubtitle.textContent = result.reason;
          this.el.resultEmblem.textContent = '♦';
        }
      }

      const rows = [];
      if (result.type === 'showdown' && result.hands) {
        const playerWin = result.winner === 'player' || result.winner === 'split';
        const aiWin = result.winner === 'ai' || result.winner === 'split';
        rows.push(
          '<div class="result-hand-row' + (playerWin ? ' is-winner' : '') + '">' +
            '<span class="result-hand-owner">你</span>' +
            '<span class="result-hand-name">' + escapeHtml(P.handName(result.hands.player)) + '</span>' +
          '</div>'
        );
        rows.push(
          '<div class="result-hand-row' + (aiWin ? ' is-winner' : '') + '">' +
            '<span class="result-hand-owner">' + escapeHtml(this.table.aiName) + '</span>' +
            '<span class="result-hand-name">' + escapeHtml(P.handName(result.hands.ai)) + '</span>' +
          '</div>'
        );
      } else if (result.type === 'fold') {
        rows.push(
          '<div class="result-hand-row">' +
            '<span class="result-hand-owner">摊牌</span>' +
            '<span class="result-hand-name">未摊牌 · ' + escapeHtml(result.reason) + '</span>' +
          '</div>'
        );
      }
      this.el.resultHands.innerHTML = rows.join('');

      this.el.resultPot.textContent = fmt(result.pot);
      if (matchOver) {
        this.el.resultNet.textContent = '最终筹码 ' + fmt(result.playerStack);
        this.el.resultNet.className = result.playerStack > 0 ? 'is-positive' : 'is-negative';
      } else {
        const net = result.net;
        this.el.resultNet.textContent = (net >= 0 ? '+' : '−') + fmt(Math.abs(net));
        this.el.resultNet.className = net > 0 ? 'is-positive' : net < 0 ? 'is-negative' : '';
      }

      if (matchOver) {
        this.el.resultContinue.textContent = '再来一局';
        this.el.resultView.textContent = '返回大厅';
      } else {
        this.el.resultContinue.textContent = '下一手';
        this.el.resultView.textContent = '查看牌桌';
      }

      this.el.resultOverlay.hidden = false;
      if ((result.winner === 'player' || result.winner === 'split') && !matchOver) {
        this.makeConfetti(result.winner === 'player' ? 34 : 18);
      } else if (matchOver && result.playerStack > 0) {
        this.makeConfetti(48);
      }
    }

    hideResult() {
      this.resultVisible = false;
      this.el.resultOverlay.hidden = true;
      this.el.confetti.innerHTML = '';
    }

    continueFromResult() {
      if (!this.result) return;
      Sound.play('click');
      if (this.result.matchOver) {
        this.hideResult();
        this.startNewMatch(this.selectedDifficulty);
      } else {
        this.hideResult();
        this.beginHand();
      }
    }

    viewTableFromResult() {
      if (!this.result) return;
      Sound.play('click');
      if (this.result.matchOver) {
        this.leaveToLobby();
        return;
      }
      this.hideResult();
      this.renderAll();
    }

    makeConfetti(count) {
      if (!window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const colors = ['#f2d696', '#d6b36a', '#b94a42', '#8fc6a2', '#f2e8d5'];
      this.el.confetti.innerHTML = '';
      for (let i = 0; i < count; i++) {
        const piece = document.createElement('i');
        piece.style.left = (Math.random() * 100) + '%';
        piece.style.background = colors[Math.floor(Math.random() * colors.length)];
        piece.style.animationDuration = (1.7 + Math.random() * 1.6) + 's';
        piece.style.animationDelay = (Math.random() * 0.5) + 's';
        piece.style.setProperty('--drift', (Math.random() * 180 - 90) + 'px');
        piece.style.width = (4 + Math.random() * 5) + 'px';
        piece.style.height = (7 + Math.random() * 7) + 'px';
        this.el.confetti.appendChild(piece);
      }
      this.clearTimeout('confetti');
      this.timers.confetti = window.setTimeout(() => { this.el.confetti.innerHTML = ''; }, 3800);
    }

    /* ---------- rendering ---------- */

    renderAll() {
      if (!this.table) return;
      this.renderHeader();
      this.renderSeats();
      this.renderHoles();
      this.renderBoard();
      this.renderPot();
      this.renderBubbles();
      this.renderStatus();
      this.renderControls();
      this.renderInfo();
      this.renderLog();
    }

    renderHeader() {
      const table = this.table;
      this.el.blindDisplay.textContent = table.smallBlind + ' / ' + table.bigBlind;
      this.el.handDisplay.textContent = String(table.handNo || 1);
      this.el.difficultyLabel.textContent = DIFFICULTY_LABELS[this.selectedDifficulty];
      this.el.aiName.textContent = table.aiName;
      this.el.infoBlinds.textContent = table.smallBlind + ' / ' + table.bigBlind;
      this.el.infoHand.textContent = '#' + (table.handNo || 1);
      this.el.infoButton.textContent = table.button === 'player' ? '你' : table.aiName;
      this.el.infoRecord.textContent = this.stats.wins + ' 胜 · ' + this.stats.losses + ' 负' +
        (this.stats.splits ? ' · ' + this.stats.splits + ' 平' : '');
      this.el.logTag.textContent = '#' + (table.handNo || 1);
    }

    renderSeats() {
      const table = this.table;
      const activePlayer = !this.transitioning && !table.handOver && table.currentActor === 'player';
      const activeAI = !this.transitioning && !table.handOver && table.currentActor === 'ai';
      this.el.playerSeat.classList.toggle('is-active', activePlayer);
      this.el.aiSeat.classList.toggle('is-active', activeAI);
      this.el.aiSeat.classList.toggle('is-thinking', this.aiThinking);
      this.el.playerSeat.classList.toggle('is-thinking', false);
      this.el.playerSeat.classList.toggle('is-folded', !!(this.result && this.result.folder === 'player'));
      this.el.aiSeat.classList.toggle('is-folded', !!(this.result && this.result.folder === 'ai'));
      this.el.playerSeat.classList.toggle('is-winner', !!(this.result && table.handOver && (this.result.winner === 'player' || this.result.winner === 'split')));
      this.el.aiSeat.classList.toggle('is-winner', !!(this.result && table.handOver && (this.result.winner === 'ai' || this.result.winner === 'split')));

      this.el.playerStack.textContent = fmt(table.stacks.player);
      this.el.aiStack.textContent = fmt(table.stacks.ai);
      this.el.playerBadge.textContent = table.smallBlindSeat === 'player' ? 'SB' : 'BB';
      this.el.aiBadge.textContent = table.smallBlindSeat === 'ai' ? 'SB' : 'BB';
      this.el.playerBadge.classList.toggle('is-button', table.button === 'player');
      this.el.aiBadge.classList.toggle('is-button', table.button === 'ai');
      this.el.playerDealer.hidden = table.button !== 'player';
      this.el.aiDealer.hidden = table.button !== 'ai';

      this.renderStreetBet('player');
      this.renderStreetBet('ai');
    }

    renderStreetBet(seat) {
      const node = seat === 'player' ? this.el.playerBet : this.el.aiBet;
      const amount = this.table.street[seat];
      if (amount > 0 && !this.table.handOver) {
        node.hidden = false;
        node.textContent = fmt(amount);
      } else {
        node.hidden = true;
      }
    }

    renderHoles() {
      const table = this.table;
      const newHand = this.holeHand !== table.handNo;
      if (newHand) {
        this.holeHand = table.handNo;
        this.holeNodes.player.forEach(resetCardNode);
        this.holeNodes.ai.forEach(resetCardNode);
        this.holeReveal = this.revealAI;
      }

      const playerCards = table.holes.player;
      const aiCards = table.holes.ai;
      const winning = this.winningCardIds();

      this.holeNodes.player.forEach((node, index) => {
        const card = playerCards[index];
        setCardNode(node, card, true, newHand, 35 + index * 90);
        if (card) node.classList.toggle('is-winning', winning.has(card.id));
      });
      this.holeNodes.ai.forEach((node, index) => {
        const card = aiCards[index];
        const faceUp = !!this.revealAI;
        setCardNode(node, card, faceUp, newHand, 10 + index * 90);
        if (card) node.classList.toggle('is-winning', faceUp && winning.has(card.id));
      });
      this.holeReveal = this.revealAI;
    }

    renderBoard() {
      const table = this.table;
      if (this.boardHand !== table.handNo) {
        this.boardHand = table.handNo;
        this.boardCount = 0;
        this.boardNodes.forEach(resetCardNode);
      }
      const board = table.board;
      const winning = this.winningCardIds();
      this.boardNodes.forEach((node, index) => {
        const card = board[index];
        if (!card) {
          resetCardNode(node);
          return;
        }
        const isNew = index >= this.boardCount;
        setCardNode(node, card, true, isNew, Math.max(0, index - this.boardCount) * 110);
        node.classList.toggle('is-winning', winning.has(card.id));
      });
      this.boardCount = board.length;
    }

    winningCardIds() {
      const set = new Set();
      if (!this.result || this.result.type !== 'showdown' || !this.result.hands) return set;
      if (this.result.winner === 'split') {
        this.result.hands.player.cards.forEach((card) => set.add(card.id));
        this.result.hands.ai.cards.forEach((card) => set.add(card.id));
      } else {
        const hand = this.result.hands[this.result.winner];
        if (hand) hand.cards.forEach((card) => set.add(card.id));
      }
      return set;
    }

    renderPot() {
      const table = this.table;
      const amount = table.handOver && this.result ? this.result.pot : table.pot;
      this.el.potAmount.textContent = fmt(amount);
      this.el.streetLabel.textContent = table.handOver
        ? (this.result && this.result.type === 'showdown' ? 'SHOWDOWN / 摊牌' : 'HAND OVER / 本手结束')
        : (STREET_HINTS[table.phase] ? PHASE_LABELS[table.phase] : table.streetName());
    }

    renderBubbles() {
      const table = this.table;
      const aiThinking = this.aiThinking && table.currentActor === 'ai' && !table.handOver;
      this.el.aiSeat.classList.toggle('is-thinking', aiThinking);

      if (aiThinking) {
        this.el.aiBubble.hidden = false;
        this.el.aiBubble.classList.add('is-thinking');
        this.el.aiBubble.innerHTML = '<span>思考中</span><span class="thinking-dots"><i></i><i></i><i></i></span>';
      } else if (this.lastActions.ai && !table.handOver) {
        this.el.aiBubble.hidden = false;
        this.el.aiBubble.classList.remove('is-thinking');
        this.el.aiBubble.textContent = this.lastActions.ai;
      } else {
        this.el.aiBubble.hidden = true;
      }

      if (this.lastActions.player && !table.handOver) {
        this.el.playerBubble.hidden = false;
        this.el.playerBubble.textContent = this.lastActions.player;
      } else {
        this.el.playerBubble.hidden = true;
      }
    }

    renderStatus() {
      const table = this.table;
      const dot = this.el.statusDot;
      dot.className = 'status-dot';
      let message = '等待发牌';
      let hint = STREET_HINTS[table.phase] || '标准无限注单挑规则';

      if (table.handOver) {
        message = '本手结束';
        hint = this.result && this.result.matchOver ? '比赛结束 · 查看结果' : '查看结果，准备下一手';
        dot.classList.add('is-live');
      } else if (this.transitioning) {
        message = '正在发牌…';
        hint = '底池已结算，继续发公共牌';
      } else if (this.aiThinking || table.currentActor === 'ai') {
        message = table.aiName + ' 正在思考…';
        hint = '观察下注尺度，判断对手范围';
        dot.classList.add('is-ai');
      } else if (table.currentActor === 'player') {
        const legal = table.getLegalActions('player');
        message = '轮到你行动';
        if (legal.available && legal.toCall > 0) {
          const odds = legal.toCall / (table.pot + legal.toCall);
          hint = '需跟注 ' + fmt(legal.callAmount) + ' · 底池赔率 ' + (odds * 100).toFixed(1) + '%';
        } else if (legal.available) {
          hint = '可以免费过牌，或主动下注施压';
        } else {
          hint = '准备行动';
        }
        dot.classList.add('is-live');
      } else if (table.phase === 'handover') {
        message = '本手结束';
        hint = '准备下一手';
      }

      this.el.tableMessage.textContent = message;
      this.el.playerHint.textContent = hint;
    }

    renderControls() {
      const table = this.table;
      if (!table) return;

      if (table.handOver) {
        const canContinue = true;
        const label = this.result && this.result.matchOver ? '再来一局' : '下一手';
        const copy = this.result && this.result.matchOver
          ? '比赛结束 · 最终筹码 ' + fmt(this.result.playerStack)
          : '本手结束 · 底池 ' + fmt(this.result ? this.result.pot : table.pot);
        this.el.controls.innerHTML =
          '<div class="continue-panel">' +
            '<div class="continue-copy"><strong>' + escapeHtml(copy) + '</strong><small>查看上方结果，或直接继续</small></div>' +
            '<div class="continue-actions">' +
              '<button class="ghost-button" type="button" data-action="continue">' + escapeHtml(label) + '</button>' +
            '</div>' +
          '</div>';
        return;
      }

      if (this.transitioning) {
        this.el.controls.innerHTML =
          '<div class="controls-waiting"><span class="waiting-orbit">♠</span>' +
          '<div class="waiting-copy"><strong>正在发牌</strong><small>公共牌落下后继续下注</small></div></div>';
        return;
      }

      if (this.aiThinking || table.currentActor === 'ai') {
        this.el.controls.innerHTML =
          '<div class="controls-waiting"><span class="waiting-orbit">♠</span>' +
          '<div class="waiting-copy"><strong>' + escapeHtml(table.aiName) + ' 正在思考</strong><small>对手正在权衡底池赔率与牌力</small></div></div>';
        return;
      }

      if (table.currentActor !== 'player') {
        this.el.controls.innerHTML =
          '<div class="controls-waiting"><span class="waiting-orbit">♠</span>' +
          '<div class="waiting-copy"><strong>等待行动</strong><small>牌局即将继续</small></div></div>';
        return;
      }

      const legal = table.getLegalActions('player');
      if (!legal.available) {
        this.el.controls.innerHTML =
          '<div class="controls-waiting"><span class="waiting-orbit">♠</span>' +
          '<div class="waiting-copy"><strong>准备行动</strong><small>刷新牌桌状态</small></div></div>';
        return;
      }

      const callLabel = legal.canCheck
        ? '过牌'
        : (legal.callAmount >= table.stacks.player
          ? '跟注全下 ' + fmt(legal.callAmount)
          : '跟注 ' + fmt(legal.callAmount));

      const foldButton = '<button class="action-btn fold-btn" type="button" data-action="fold">弃牌</button>';
      const callAction = legal.canCheck ? 'check' : 'call';
      const callClass = legal.canCheck ? 'call-btn is-check' : 'call-btn';
      const callButton = '<button class="action-btn ' + callClass + '" type="button" data-action="' + callAction + '">' + callLabel + '</button>';

      if (!legal.canRaise || !legal.raise) {
        this.el.controls.innerHTML =
          '<div class="controls-grid is-simple">' +
            '<div class="action-row">' + foldButton + callButton + '</div>' +
            '<div class="raise-hint">' + escapeHtml(table.stacks.player <= 0 || table.stacks.ai <= 0 ? '对手已全下，只能跟注或弃牌。' : '当前无法加注。') + '</div>' +
          '</div>';
        return;
      }

      const raise = legal.raise;
      this.currentRaise = this.defaultRaiseTarget(legal);
      const step = raise.max - raise.min > 220 ? 10 : 5;
      const verb = table.currentBet === 0 ? '下注' : '加注到';
      const sliderMarkup = raise.allInOnly
        ? '<input id="raiseSlider" class="raise-slider" type="range" min="' + raise.min + '" max="' + raise.max + '" step="1" value="' + raise.max + '" disabled>'
        : '<input id="raiseSlider" class="raise-slider" type="range" min="' + raise.min + '" max="' + raise.max + '" step="' + step + '" value="' + this.currentRaise + '">';

      this.el.controls.innerHTML =
        '<div class="controls-grid">' +
          '<div class="action-row">' + foldButton + callButton + '</div>' +
          '<div class="raise-panel">' +
            '<div class="raise-head"><span class="raise-head-label">' + verb + '</span><strong id="raiseAmount">' + fmt(this.currentRaise) + '</strong></div>' +
            '<div class="range-wrap">' + sliderMarkup + '</div>' +
            '<div class="raise-bottom">' +
              '<div class="quick-row">' +
                '<button class="quick-chip" type="button" data-fraction="0.5">½ 池</button>' +
                '<button class="quick-chip" type="button" data-fraction="0.67">⅔ 池</button>' +
                '<button class="quick-chip" type="button" data-fraction="1">满池</button>' +
                '<button class="quick-chip all-in" type="button" data-allin="true">全下</button>' +
              '</div>' +
              '<button id="raiseBtn" class="raise-btn" type="button" data-action="raise">' + verb + ' ' + fmt(this.currentRaise) + '</button>' +
            '</div>' +
            '<div class="raise-hint">最小 ' + fmt(raise.min) + ' · 你的筹码 ' + fmt(table.stacks.player) + '</div>' +
          '</div>' +
        '</div>';
      this.updateRaiseUI(this.currentRaise);
    }

    defaultRaiseTarget(legal) {
      const table = this.table;
      const raise = legal.raise;
      if (!raise) return 0;
      let target;
      if (table.phase === 'preflop') {
        if (table.currentBet > table.bigBlind) {
          target = table.currentBet * 2.7;
        } else {
          target = table.bigBlind * 3;
        }
      } else if (table.currentBet > 0) {
        target = table.currentBet + (table.pot + legal.toCall) * 0.66;
      } else {
        target = Math.max(table.bigBlind, table.pot * 0.66);
      }
      target = roundChips(target);
      return clamp(target, raise.min, raise.max);
    }

    maxRaiseTarget() {
      if (!this.table) return 0;
      const legal = this.table.getLegalActions('player');
      if (!legal.available || !legal.raise) return 0;
      return legal.raise.max;
    }

    quickRaiseTarget(fraction) {
      if (!this.table) return 0;
      const legal = this.table.getLegalActions('player');
      if (!legal.available || !legal.raise) return 0;
      const raise = legal.raise;
      const target = this.table.currentBet + (this.table.pot + legal.toCall) * fraction;
      return clamp(roundChips(target), raise.min, raise.max);
    }

    setRaiseTarget(value, syncSlider) {
      if (!this.table) return;
      const legal = this.table.getLegalActions('player');
      if (!legal.available || !legal.raise) return;
      const target = clamp(Math.round(Number(value) || legal.raise.min), legal.raise.min, legal.raise.max);
      this.currentRaise = target;
      const slider = this.el.controls.querySelector('#raiseSlider');
      if (slider && syncSlider !== false) slider.value = String(target);
      this.updateRaiseUI(target);
    }

    updateRaiseUI(value) {
      const table = this.table;
      if (!table) return;
      const legal = table.getLegalActions('player');
      if (!legal.available || !legal.raise) return;
      const raise = legal.raise;
      const amount = clamp(Math.round(value), raise.min, raise.max);
      const amountNode = this.el.controls.querySelector('#raiseAmount');
      const button = this.el.controls.querySelector('#raiseBtn');
      const slider = this.el.controls.querySelector('#raiseSlider');
      const verb = table.currentBet === 0 ? '下注' : '加注到';
      const allIn = amount >= raise.max;
      if (amountNode) amountNode.textContent = fmt(amount);
      if (button) {
        button.textContent = allIn ? '全下 ' + fmt(amount) : verb + ' ' + fmt(amount);
        button.dataset.amount = String(amount);
      }
      if (slider) {
        const min = Number(slider.min);
        const max = Number(slider.max);
        const pct = max > min ? ((amount - min) / (max - min)) * 100 : 100;
        slider.style.setProperty('--fill', pct.toFixed(1) + '%');
      }
    }

    renderInfo() {
      const table = this.table;
      this.el.phasePill.textContent = table.handOver ? '已结束' : (PHASE_LABELS[table.phase] || '等待');
      const hole = table.holes.player;
      const board = table.board;
      let rankText = '等待发牌';
      let drawText = '';
      let oddsText = '';

      if (hole && hole.length === 2) {
        if (board.length === 0) {
          const tag = P.startingHandTag(hole);
          const strength = tag.score >= 12 ? '强起手牌' : tag.score >= 8 ? '可游戏牌' : '边缘起手牌';
          rankText = P.cardsText(hole) + ' · ' + strength;
          drawText = tag.description;
        } else {
          const best = P.bestHand(hole.concat(board));
          rankText = P.handName(best);
          const draw = P.getDrawInfo(hole, board);
          drawText = draw.label || '已成牌型';
        }
      }

      if (!table.handOver && table.currentActor === 'player') {
        const legal = table.getLegalActions('player');
        if (legal.available && legal.toCall > 0) {
          const odds = legal.toCall / (table.pot + legal.toCall);
          oddsText = '需跟注 ' + fmt(legal.callAmount) + ' · 底池赔率 ' + (odds * 100).toFixed(1) + '%';
        } else if (legal.available) {
          oddsText = '可以免费过牌';
        }
      } else if (!table.handOver && table.currentActor === 'ai') {
        oddsText = '等待 ' + table.aiName + ' 行动';
      } else if (table.handOver && this.result) {
        oddsText = this.result.type === 'showdown' ? '本手已摊牌' : '本手未摊牌';
      }

      this.el.rankHint.textContent = rankText;
      this.el.drawHint.textContent = drawText;
      this.el.potOddsHint.textContent = oddsText;
    }

    renderLog() {
      const table = this.table;
      if (!table) return;
      if (this._logLength === table.log.length && this._logHand === table.handNo) return;
      this._logLength = table.log.length;
      this._logHand = table.handNo;
      const entries = table.log.slice(-70);
      const html = entries.map((entry) => {
        return '<div class="log-entry type-' + escapeHtml(entry.type) + '">' + escapeHtml(entry.text) + '</div>';
      }).join('');
      this.el.logList.innerHTML = html;
      this.el.logList.scrollTop = this.el.logList.scrollHeight;
    }

    /* ---------- misc UI ---------- */

    toggleSound() {
      this.soundOn = !this.soundOn;
      Sound.enabled = this.soundOn;
      if (this.soundOn) Sound.play('click');
      storageSet('headsUpPoker.sound', this.soundOn ? '1' : '0');
      this.updateSoundButton();
    }

    updateSoundButton() {
      this.el.soundBtn.classList.toggle('is-muted', !this.soundOn);
      this.el.soundBtn.setAttribute('aria-label', this.soundOn ? '关闭声音' : '开启声音');
      this.el.soundBtn.title = this.soundOn ? '关闭声音' : '开启声音';
    }

    openModal(name) {
      this.modalName = name;
      this.el.modalLayer.hidden = false;
      this.el.rulesModal.hidden = name !== 'rules';
      this.el.leaveModal.hidden = name !== 'leave';
      if (name === 'leave') {
        window.setTimeout(() => this.el.leaveCancel.focus(), 60);
      } else {
        window.setTimeout(() => {
          const close = this.el.rulesModal.querySelector('.modal-close');
          if (close) close.focus();
        }, 60);
      }
    }

    closeModal() {
      this.modalName = null;
      this.el.modalLayer.hidden = true;
      this.el.rulesModal.hidden = true;
      this.el.leaveModal.hidden = true;
    }

    toast(message) {
      this.el.toast.textContent = message;
      this.el.toast.classList.add('is-visible');
      this.clearTimeout('toast');
      this.timers.toast = window.setTimeout(() => {
        this.el.toast.classList.remove('is-visible');
      }, 2200);
    }

    clearTimeout(name) {
      if (this.timers[name]) {
        window.clearTimeout(this.timers[name]);
        this.timers[name] = null;
      }
    }

    clearTimers() {
      Object.keys(this.timers).forEach((name) => this.clearTimeout(name));
    }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function renderFallback(app) {
    if (!app.table) return;
    const remaining = app.table.board.length < 5 ? 5 - app.table.board.length : 0;
    for (let i = 0; i < remaining; i++) app.table.nextStreet();
    if (app.table.board.length === 5) {
      const result = app.table.showdown();
      if (result.ok) app.finishHand(result.result);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    const app = new PokerApp();
    app.init();
  });
})();
