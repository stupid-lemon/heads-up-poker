/* ============================================================
   Heads-up No-Limit Hold'em table / betting engine
   - button is the small blind
   - acts first preflop, last postflop
   - supports all-ins, min-raises, split pots, uncalled-bet refunds
   ============================================================ */
(function (global) {
  'use strict';

  const P = global.Poker || (typeof require === 'function' ? require('./poker.js') : null);
  const OTHER = { player: 'ai', ai: 'player' };
  const BLINDS = [
    [10, 20], [15, 30], [25, 50], [40, 80], [60, 120],
    [100, 200], [150, 300], [250, 500], [400, 800], [600, 1200],
    [1000, 2000], [1500, 3000]
  ];
  const STREET_NAMES = { preflop: '翻牌前', flop: '翻牌圈', turn: '转牌圈', river: '河牌圈' };

  function other(seat) {
    return OTHER[seat];
  }

  function money(value) {
    return Math.round(value).toLocaleString('zh-CN');
  }

  class HoldemTable {
    constructor(options) {
      const opts = options || {};
      this.startingStack = opts.startingStack || 1000;
      this.aiName = opts.aiName || 'AI';
      this.rng = opts.rng || Math.random;
      this.blindSchedule = opts.blindSchedule || BLINDS;
      this.handsPerLevel = opts.handsPerLevel || 10;
      this.resetMatch();
    }

    resetMatch() {
      this.stacks = { player: this.startingStack, ai: this.startingStack };
      this.startingStacks = { player: this.startingStack, ai: this.startingStack };
      this.button = this.rng() < 0.5 ? 'player' : 'ai';
      this.handNo = 0;
      this.blindLevel = 0;
      this.smallBlind = this.blindSchedule[0][0];
      this.bigBlind = this.blindSchedule[0][1];
      this.phase = 'idle';
      this.streetComplete = true;
      this.currentActor = null;
      this.handOver = false;
      this.matchOver = false;
      this.result = null;
      this.log = [];
      this.history = [];
      this.board = [];
      this.holes = { player: [], ai: [] };
      this.deck = [];
      this.street = { player: 0, ai: 0 };
      this.total = { player: 0, ai: 0 };
      this.currentBet = 0;
      this.minRaise = this.bigBlind;
      this.acted = { player: false, ai: false };
      this.streetNumber = 0;
      this.lastAggressor = null;
      this.lastAction = null;
      this.smallBlindSeat = null;
      this.bigBlindSeat = null;
      this.stacksAtHandStart = { player: this.startingStack, ai: this.startingStack };
      this.handStartStacks = { player: this.startingStack, ai: this.startingStack };
    }

    get pot() {
      return this.total.player + this.total.ai;
    }

    get blinds() {
      return { sb: this.smallBlind, bb: this.bigBlind };
    }

    get aiDisplayName() {
      return this.aiName;
    }

    nameOf(seat) {
      return seat === 'player' ? '你' : this.aiName;
    }

    addLog(type, text) {
      this.log.push({ type, text, handNo: this.handNo });
      if (this.log.length > 140) this.log.shift();
    }

    dealHoleCards() {
      const first = this.bigBlindSeat;
      for (let round = 0; round < 2; round++) {
        this.holes[first].push(this.deck.pop());
        this.holes[other(first)].push(this.deck.pop());
      }
    }

    postBlind(seat, amount) {
      const paid = this.commit(seat, amount);
      if (paid < amount) {
        this.addLog('system', this.nameOf(seat) + ' 盲注全下 ' + money(paid));
      }
    }

    commit(seat, amount) {
      const paid = Math.min(amount, this.stacks[seat]);
      this.stacks[seat] -= paid;
      this.street[seat] += paid;
      this.total[seat] += paid;
      return paid;
    }

    startHand() {
      if (this.matchOver || this.stacks.player <= 0 || this.stacks.ai <= 0) {
        this.matchOver = true;
        this.phase = 'matchover';
        return { ok: false, error: '比赛已经结束' };
      }
      if (this.handNo > 0) this.button = other(this.button);
      this.handNo++;

      const previousLevel = this.blindLevel;
      this.blindLevel = Math.min(
        Math.floor((this.handNo - 1) / this.handsPerLevel),
        this.blindSchedule.length - 1
      );
      const level = this.blindSchedule[this.blindLevel];
      this.smallBlind = level[0];
      this.bigBlind = level[1];
      this.smallBlindSeat = this.button;
      this.bigBlindSeat = other(this.button);

      this.board = [];
      this.holes = { player: [], ai: [] };
      this.deck = P.shuffle(P.createDeck(), this.rng);
      this.street = { player: 0, ai: 0 };
      this.total = { player: 0, ai: 0 };
      this.currentBet = 0;
      this.minRaise = this.bigBlind;
      this.acted = { player: false, ai: false };
      this.streetComplete = false;
      this.currentActor = null;
      this.handOver = false;
      this.matchOver = false;
      this.result = null;
      this.streetNumber = 0;
      this.lastAggressor = null;
      this.lastAction = null;
      this.phase = 'preflop';
      this.stacksAtHandStart = { player: this.stacks.player, ai: this.stacks.ai };
      this.handStartStacks = { player: this.stacks.player, ai: this.stacks.ai };

      this.addLog('divider', '第 ' + this.handNo + ' 手 · 盲注 ' + this.smallBlind + '/' + this.bigBlind);
      if (this.blindLevel > previousLevel) {
        this.addLog('system', '盲注上涨至 ' + this.smallBlind + '/' + this.bigBlind);
      }

      this.postBlind(this.smallBlindSeat, this.smallBlind);
      this.postBlind(this.bigBlindSeat, this.bigBlind);
      this.currentBet = Math.max(this.street.player, this.street.ai);
      this.dealHoleCards();
      this.setInitialActor();
      return { ok: true };
    }

    setInitialActor() {
      const sbSeat = this.smallBlindSeat;
      const bbSeat = this.bigBlindSeat;
      if (this.stacks[sbSeat] > 0) {
        if (this.stacks[bbSeat] === 0 && this.street[sbSeat] >= this.street[bbSeat]) {
          this.currentActor = null;
          this.streetComplete = true;
        } else {
          this.currentActor = sbSeat;
          this.streetComplete = false;
        }
      } else {
        if (this.stacks[bbSeat] > 0 && this.street[bbSeat] < this.street[sbSeat]) {
          this.currentActor = bbSeat;
          this.streetComplete = false;
        } else {
          this.currentActor = null;
          this.streetComplete = true;
        }
      }
      if (this.currentActor && this.stacks[this.currentActor] <= 0) {
        this.currentActor = null;
        this.streetComplete = true;
      }
    }

    getToCall(seat) {
      return Math.max(0, this.currentBet - this.street[seat]);
    }

    getLegalActions(seat) {
      if (this.handOver || this.streetComplete || this.currentActor !== seat ||
          !this.phase || this.phase === 'idle' || this.phase === 'handover' || this.phase === 'matchover') {
        return { available: false };
      }
      const toCall = this.getToCall(seat);
      const maxTo = this.street[seat] + this.stacks[seat];
      const opponent = other(seat);
      const canRaise = this.stacks[opponent] > 0 && this.stacks[seat] > 0 && maxTo > this.currentBet;
      const standardMin = this.currentBet + this.minRaise;
      const minTo = Math.min(standardMin, maxTo);
      return {
        available: true,
        seat,
        toCall,
        callAmount: Math.min(toCall, this.stacks[seat]),
        canCheck: toCall <= 0,
        canCall: toCall > 0 && this.stacks[seat] > 0,
        canFold: true,
        canRaise,
        raise: canRaise ? {
          min: minTo,
          max: maxTo,
          standardMin,
          allInOnly: maxTo < standardMin
        } : null
      };
    }

    isAllIn() {
      return this.stacks.player <= 0 || this.stacks.ai <= 0;
    }

    act(seat, action) {
      if (!action || (seat !== 'player' && seat !== 'ai')) return { ok: false, error: '无效行动' };
      const legal = this.getLegalActions(seat);
      if (!legal.available) return { ok: false, error: '现在不是该玩家的行动轮次' };

      const opponent = other(seat);
      let consumed = false;

      if (action.type === 'fold') {
        this.lastAction = { seat, type: 'fold' };
        this.addLog(seat === 'player' ? 'player' : 'ai', this.nameOf(seat) + ' 弃牌');
        this.currentActor = null;
        this.streetComplete = true;
        this.finishByFold(opponent, seat);
        return { ok: true, handOver: true, result: this.result };
      }

      if (action.type === 'check') {
        if (!legal.canCheck) return { ok: false, error: '面对下注时不能过牌' };
        this.acted[seat] = true;
        this.lastAction = { seat, type: 'check' };
        this.addLog(seat === 'player' ? 'player' : 'ai', this.nameOf(seat) + ' 过牌');
        consumed = true;
      } else if (action.type === 'call') {
        if (!legal.canCall) return { ok: false, error: '当前无需跟注' };
        const paid = this.commit(seat, legal.callAmount);
        this.acted[seat] = true;
        const allIn = this.stacks[seat] === 0;
        this.lastAction = { seat, type: 'call', amount: paid, allIn };
        this.addLog(
          seat === 'player' ? 'player' : 'ai',
          this.nameOf(seat) + ' 跟注 ' + money(paid) + (allIn ? ' · 全下' : '')
        );
        consumed = true;
      } else if (action.type === 'raise' || action.type === 'bet') {
        if (!legal.canRaise || !legal.raise) return { ok: false, error: '当前不能加注' };
        const target = Math.round(Number(action.amount));
        if (!Number.isFinite(target)) return { ok: false, error: '下注额无效' };
        if (target > legal.raise.max) return { ok: false, error: '下注额超过筹码' };
        if (target <= this.currentBet) return { ok: false, error: '加注额必须高于当前下注' };
        if (target < legal.raise.standardMin && target !== legal.raise.max) {
          return { ok: false, error: '加注额低于最小加注' };
        }
        const previousBet = this.currentBet;
        const isOpen = previousBet === 0;
        const paid = this.commit(seat, target - this.street[seat]);
        if (paid <= 0) return { ok: false, error: '没有可下注的筹码' };
        const raiseSize = target - previousBet;
        if (raiseSize >= this.minRaise) this.minRaise = raiseSize;
        this.currentBet = target;
        this.lastAggressor = seat;
        this.acted[seat] = true;
        this.acted[opponent] = false;
        const allIn = this.stacks[seat] === 0;
        this.lastAction = {
          seat,
          type: isOpen ? 'bet' : 'raise',
          amount: target,
          paid,
          allIn
        };
        this.addLog(
          seat === 'player' ? 'player' : 'ai',
          this.nameOf(seat) + ' ' + (isOpen ? '下注 ' : '加注到 ') + money(target) +
            (allIn ? ' · 全下' : '')
        );
        consumed = true;
      } else {
        return { ok: false, error: '未知行动' };
      }

      if (!consumed) return { ok: false, error: '未知行动' };

      if (this.isRoundClosed()) {
        this.streetComplete = true;
        this.currentActor = null;
      } else {
        this.currentActor = opponent;
        this.streetComplete = false;
      }
      return {
        ok: true,
        handOver: false,
        streetComplete: this.streetComplete,
        currentActor: this.currentActor,
        playerStack: this.stacks.player,
        aiStack: this.stacks.ai
      };
    }

    isRoundClosed() {
      const p = this.street.player;
      const a = this.street.ai;
      if (p === a && this.acted.player && this.acted.ai) return true;
      if (this.stacks.player === 0 && this.stacks.ai === 0) return true;
      // A call that puts either player all-in ends the action. Any excess
      // beyond the shortest stack is uncalled and is refunded later.
      // An all-in bet/raise is different: the opponent must still call or fold.
      if (this.lastAction && this.lastAction.type === 'call' && this.isAllIn()) return true;
      return false;
    }

    nextStreet() {
      if (this.handOver) return { ok: false, error: '本手牌已经结束' };
      if (!this.streetComplete) return { ok: false, error: '下注轮尚未结束' };
      if (this.board.length >= 5) return { ok: false, error: '牌面已经完整' };
      if (this.phase === 'idle' || this.phase === 'handover' || this.phase === 'matchover') {
        return { ok: false, error: '当前无法发牌' };
      }

      this.street = { player: 0, ai: 0 };
      this.currentBet = 0;
      this.minRaise = this.bigBlind;
      this.acted = { player: false, ai: false };
      this.streetComplete = false;
      this.lastAggressor = null;
      this.streetNumber++;

      this.deck.pop(); // burn card

      let dealt = [];
      if (this.phase === 'preflop') {
        this.phase = 'flop';
        for (let i = 0; i < 3; i++) this.board.push(this.deck.pop());
        dealt = this.board.slice();
      } else if (this.phase === 'flop') {
        this.phase = 'turn';
        this.board.push(this.deck.pop());
        dealt = [this.board[this.board.length - 1]];
      } else if (this.phase === 'turn') {
        this.phase = 'river';
        this.board.push(this.deck.pop());
        dealt = [this.board[this.board.length - 1]];
      } else {
        return { ok: false, error: '未知的街道' };
      }

      this.currentActor = null;
      if (this.stacks.player > 0 && this.stacks.ai > 0) {
        const first = other(this.button);
        if (this.stacks[first] > 0) {
          this.currentActor = first;
          this.streetComplete = false;
        } else {
          const second = this.button;
          if (this.stacks[second] > 0) {
            this.currentActor = second;
            this.streetComplete = false;
          } else {
            this.streetComplete = true;
          }
        }
      } else {
        this.streetComplete = true;
      }

      this.addLog('system', STREET_NAMES[this.phase] + ' · ' + P.cardsText(dealt));
      return {
        ok: true,
        phase: this.phase,
        cards: dealt,
        board: this.board.slice(),
        currentActor: this.currentActor,
        streetComplete: this.streetComplete
      };
    }

    refundUncalled() {
      const p = this.total.player;
      const a = this.total.ai;
      let refund = 0;
      if (p > a) {
        refund = p - a;
        this.stacks.player += refund;
        this.total.player -= refund;
        this.street.player = Math.max(0, this.street.player - refund);
      } else if (a > p) {
        refund = a - p;
        this.stacks.ai += refund;
        this.total.ai -= refund;
        this.street.ai = Math.max(0, this.street.ai - refund);
      }
      if (refund > 0) {
        this.addLog('system', '退回未被跟注的 ' + money(refund) + ' 筹码');
      }
      return refund;
    }

    finishByFold(winner, folder) {
      this.refundUncalled();
      const pot = this.pot;
      this.stacks[winner] += pot;
      const result = {
        type: 'fold',
        winner,
        folder,
        pot,
        handNo: this.handNo,
        reason: this.nameOf(folder) + ' 弃牌',
        hands: null,
        winningCards: [],
        playerStack: this.stacks.player,
        aiStack: this.stacks.ai,
        net: this.stacks.player - this.handStartStacks.player,
        matchOver: false
      };
      this.completeHand(result);
      this.addLog('win', this.nameOf(winner) + ' 赢得 ' + money(pot) + '（' + this.nameOf(folder) + ' 弃牌）');
    }

    showdown() {
      if (this.handOver) return { ok: false, error: '本手牌已经结束' };
      if (this.board.length < 5) return { ok: false, error: '尚未发完公共牌' };
      this.refundUncalled();
      this.currentActor = null;
      this.streetComplete = true;

      const playerHand = P.bestHand(this.holes.player.concat(this.board));
      const aiHand = P.bestHand(this.holes.ai.concat(this.board));
      const pot = this.pot;
      let winner;
      let result;

      if (playerHand.score > aiHand.score) {
        winner = 'player';
        this.stacks.player += pot;
        result = {
          type: 'showdown',
          winner,
          pot,
          handNo: this.handNo,
          reason: '你以' + P.handName(playerHand) + ' 赢下底池',
          hands: { player: playerHand, ai: aiHand },
          winningCards: playerHand.cards.map(function (card) { return card.id; }),
          playerStack: this.stacks.player,
          aiStack: this.stacks.ai,
          net: this.stacks.player - this.handStartStacks.player,
          matchOver: false
        };
        this.addLog('win', '摊牌 · 你用' + P.handName(playerHand) + ' 赢得 ' + money(pot));
      } else if (aiHand.score > playerHand.score) {
        winner = 'ai';
        this.stacks.ai += pot;
        result = {
          type: 'showdown',
          winner,
          pot,
          handNo: this.handNo,
          reason: this.aiName + ' 以' + P.handName(aiHand) + ' 赢下底池',
          hands: { player: playerHand, ai: aiHand },
          winningCards: aiHand.cards.map(function (card) { return card.id; }),
          playerStack: this.stacks.player,
          aiStack: this.stacks.ai,
          net: this.stacks.player - this.handStartStacks.player,
          matchOver: false
        };
        this.addLog('win', '摊牌 · ' + this.aiName + ' 用' + P.handName(aiHand) + ' 赢得 ' + money(pot));
      } else {
        winner = 'split';
        const half = Math.floor(pot / 2);
        const odd = pot % 2;
        const oddSeat = other(this.button);
        this.stacks.player += half + (oddSeat === 'player' ? odd : 0);
        this.stacks.ai += half + (oddSeat === 'ai' ? odd : 0);
        result = {
          type: 'showdown',
          winner,
          pot,
          handNo: this.handNo,
          reason: '双方以' + P.handName(playerHand) + '平分底池',
          hands: { player: playerHand, ai: aiHand },
          winningCards: playerHand.cards.map(function (card) { return card.id; }),
          playerStack: this.stacks.player,
          aiStack: this.stacks.ai,
          net: this.stacks.player - this.handStartStacks.player,
          matchOver: false
        };
        this.addLog('split', '摊牌 · 双方平分 ' + money(pot));
      }

      this.completeHand(result);
      return { ok: true, result };
    }

    completeHand(result) {
      this.result = result;
      this.handOver = true;
      this.phase = 'handover';
      this.currentActor = null;
      this.streetComplete = true;
      this.total = { player: 0, ai: 0 };
      this.street = { player: 0, ai: 0 };
      this.matchOver = this.stacks.player <= 0 || this.stacks.ai <= 0;
      result.matchOver = this.matchOver;
      result.playerStack = this.stacks.player;
      result.aiStack = this.stacks.ai;
      this.history.push({
        handNo: this.handNo,
        winner: result.winner,
        type: result.type,
        pot: result.pot,
        playerStack: result.playerStack,
        aiStack: result.aiStack
      });
    }

    streetName() {
      return STREET_NAMES[this.phase] || '';
    }
  }

  const API = { HoldemTable, BLINDS, other, money, STREET_NAMES };
  global.HoldemTable = HoldemTable;
  global.PokerTableUtils = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
