/* ============================================================
   Poker core: deck, hand evaluation, draws, Chen score, equity
   Works in the browser and in Node (for tests / simulations).
   ============================================================ */
(function (global) {
  'use strict';

  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const RANK_VALUE = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 13, A: 14 };
  const SUITS = {
    s: { key: 's', symbol: '♠', name: '黑桃', color: 'black' },
    h: { key: 'h', symbol: '♥', name: '红桃', color: 'red' },
    d: { key: 'd', symbol: '♦', name: '方片', color: 'red' },
    c: { key: 'c', symbol: '♣', name: '梅花', color: 'black' }
  };
  const CATEGORY_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];

  function rankLabel(value) {
    if (value === 10) return '10';
    return RANKS[value - 2] || String(value);
  }

  function makeCard(rank, suit) {
    const key = String(rank).toUpperCase();
    const normal = key === 'T' ? '10' : key;
    const value = RANK_VALUE[normal];
    if (!value || !SUITS[suit]) throw new Error('Invalid card: ' + rank + suit);
    return { r: normal, s: suit, v: value, id: normal + suit };
  }

  function parseCard(text) {
    if (text && typeof text === 'object') return text;
    const raw = String(text).trim();
    const suit = raw.slice(-1).toLowerCase();
    const rank = raw.slice(0, -1).toUpperCase();
    return makeCard(rank, suit);
  }

  function parseCards(list) {
    return list.map(parseCard);
  }

  function createDeck() {
    const deck = [];
    for (const suit of Object.keys(SUITS)) {
      for (const rank of RANKS) deck.push(makeCard(rank, suit));
    }
    return deck;
  }

  const FULL_DECK = createDeck();

  function shuffle(deck, rng) {
    const random = rng || Math.random;
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const tmp = deck[i];
      deck[i] = deck[j];
      deck[j] = tmp;
    }
    return deck;
  }

  function cardText(card) {
    return card.r + SUITS[card.s].symbol;
  }

  function cardsText(cards) {
    return cards.map(cardText).join(' ');
  }

  /* ---------- fast score ---------- */

  function encodeScore(category, tiebreak) {
    let score = category;
    for (let i = 0; i < 5; i++) score = score * 15 + (tiebreak[i] || 0);
    return score;
  }

  function uniqueDesc(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
      if (!seen.has(value)) {
        seen.add(value);
        out.push(value);
      }
    }
    return out;
  }

  function straightHigh(values) {
    const set = new Set(values);
    if (set.has(14)) set.add(1);
    for (let high = 14; high >= 5; high--) {
      let ok = true;
      for (let n = 0; n < 5; n++) {
        if (!set.has(high - n)) { ok = false; break; }
      }
      if (ok) return high;
    }
    return 0;
  }

  /**
   * Fast evaluator for 5, 6 or 7 cards. Returns a numeric score.
   * Higher score wins; equal scores are exact ties.
   */
  function score(cards) {
    if (!cards || cards.length < 5 || cards.length > 7) throw new Error('score needs 5-7 cards');
    const values = cards.map(function (c) { return c.v; }).sort(function (a, b) { return b - a; });
    const counts = new Uint8Array(15);
    const suitCounts = { s: 0, h: 0, d: 0, c: 0 };
    const suitValues = { s: [], h: [], d: [], c: [] };
    for (const card of cards) {
      counts[card.v]++;
      suitCounts[card.s]++;
      suitValues[card.s].push(card.v);
    }

    let flushSuit = null;
    for (const suit of Object.keys(suitCounts)) {
      if (suitCounts[suit] >= 5) { flushSuit = suit; break; }
    }

    // Straight flush
    if (flushSuit) {
      const flushHigh = straightHigh(suitValues[flushSuit]);
      if (flushHigh) return encodeScore(8, [flushHigh]);
    }

    // Four of a kind
    for (let r = 14; r >= 2; r--) {
      if (counts[r] === 4) {
        let kicker = 0;
        for (let k = 14; k >= 2; k--) {
          if (k !== r && counts[k] > 0) { kicker = k; break; }
        }
        return encodeScore(7, [r, kicker]);
      }
    }

    // Full house / trips / pairs
    const trips = [];
    const pairs = [];
    for (let r = 14; r >= 2; r--) {
      if (counts[r] === 3) trips.push(r);
      else if (counts[r] === 2) pairs.push(r);
    }
    if (trips.length >= 2) return encodeScore(6, [trips[0], trips[1]]);
    if (trips.length === 1 && pairs.length >= 1) return encodeScore(6, [trips[0], pairs[0]]);

    // Flush
    if (flushSuit) {
      const flushValues = suitValues[flushSuit].sort(function (a, b) { return b - a; }).slice(0, 5);
      return encodeScore(5, flushValues);
    }

    // Straight
    const high = straightHigh(uniqueDesc(values));
    if (high) return encodeScore(4, [high]);

    // Three of a kind
    if (trips.length === 1) {
      const kickers = [];
      for (let r = 14; r >= 2 && kickers.length < 2; r--) {
        if (r !== trips[0] && counts[r] > 0) kickers.push(r);
      }
      return encodeScore(3, [trips[0], kickers[0] || 0, kickers[1] || 0]);
    }

    // Two pair
    if (pairs.length >= 2) {
      let kicker = 0;
      for (let r = 14; r >= 2; r--) {
        if (r !== pairs[0] && r !== pairs[1] && counts[r] > 0) { kicker = r; break; }
      }
      return encodeScore(2, [pairs[0], pairs[1], kicker]);
    }

    // One pair
    if (pairs.length === 1) {
      const kickers = [];
      for (let r = 14; r >= 2 && kickers.length < 3; r--) {
        if (r !== pairs[0] && counts[r] > 0) kickers.push(r);
      }
      return encodeScore(1, [pairs[0], kickers[0] || 0, kickers[1] || 0, kickers[2] || 0]);
    }

    // High card
    return encodeScore(0, uniqueDesc(values).slice(0, 5));
  }

  const COMBOS_5 = (function () {
    const out = [];
    for (let a = 0; a < 3; a++)
      for (let b = a + 1; b < 4; b++)
        for (let c = b + 1; c < 5; c++)
          for (let d = c + 1; d < 6; d++)
            for (let e = d + 1; e < 7; e++) out.push([a, b, c, d, e]);
    return out;
  })();

  function detailFromFive(cards, scoreValue) {
    const base = 759375; // 15^5
    const category = Math.floor(scoreValue / base);
    const tiebreak = [];
    let rest = scoreValue - category * base;
    for (let divisor = 50625; divisor >= 1; divisor = Math.floor(divisor / 15)) {
      const digit = Math.floor(rest / divisor);
      tiebreak.push(digit);
      rest -= digit * divisor;
    }
    return { category, catName: CATEGORY_NAMES[category], score: scoreValue, tiebreak, cards };
  }

  function evaluate5(cards) {
    const parsed = cards.map(parseCard);
    if (parsed.length !== 5) throw new Error('evaluate5 needs 5 cards');
    const value = score(parsed);
    return detailFromFive(parsed, value);
  }

  function bestHand(cards) {
    const parsed = cards.map(parseCard);
    if (parsed.length === 5) return evaluate5(parsed);
    if (parsed.length < 5) throw new Error('bestHand needs at least 5 cards');
    let best = null;
    const combos = parsed.length === 7 ? COMBOS_5 : generateCombos(parsed.length, 5);
    for (const combo of combos) {
      const five = combo.map(function (index) { return parsed[index]; });
      const value = score(five);
      if (!best || value > best.score) best = detailFromFive(five, value);
    }
    return best;
  }

  function generateCombos(n, k) {
    const out = [];
    const current = [];
    function walk(start) {
      if (current.length === k) { out.push(current.slice()); return; }
      for (let i = start; i <= n - (k - current.length); i++) {
        current.push(i);
        walk(i + 1);
        current.pop();
      }
    }
    walk(0);
    return out;
  }

  function compareHands(a, b) {
    return a.score - b.score;
  }

  function handName(hand) {
    const t = hand.tiebreak;
    switch (hand.category) {
      case 8:
        return t[0] === 14 ? '皇家同花顺' : rankLabel(t[0]) + ' 高同花顺';
      case 7:
        return '四条 ' + rankLabel(t[0]);
      case 6:
        return '葫芦 ' + rankLabel(t[0]) + ' 带 ' + rankLabel(t[1]);
      case 5:
        return rankLabel(t[0]) + ' 高同花';
      case 4:
        return rankLabel(t[0]) + ' 高顺子';
      case 3:
        return '三条 ' + rankLabel(t[0]);
      case 2:
        return '两对 ' + rankLabel(t[0]) + ' / ' + rankLabel(t[1]);
      case 1:
        return '一对 ' + rankLabel(t[0]);
      default:
        return '高牌 ' + rankLabel(t[0]);
    }
  }

  function handNameShort(hand) {
    const t = hand.tiebreak;
    switch (hand.category) {
      case 8: return t[0] === 14 ? '皇家同花顺' : '同花顺';
      case 7: return '四条';
      case 6: return '葫芦';
      case 5: return '同花';
      case 4: return '顺子';
      case 3: return '三条';
      case 2: return '两对';
      case 1: return '一对';
      default: return '高牌';
    }
  }

  /* ---------- Chen formula ---------- */

  function chenScore(cards) {
    const parsed = cards.map(parseCard);
    const sorted = parsed.slice().sort(function (a, b) { return b.v - a.v; });
    const a = sorted[0], b = sorted[1];
    let high;
    if (a.v === 14) high = 10;
    else if (a.v === 13) high = 8;
    else if (a.v === 12) high = 7;
    else if (a.v === 11) high = 6;
    else high = a.v / 2;

    let value = high;
    const pair = a.v === b.v;
    if (pair) value = Math.max(5, high * 2);
    if (a.s === b.s) value += 2;

    if (!pair) {
      const gap = a.v - b.v - 1;
      if (gap === 1) value -= 1;
      else if (gap === 2) value -= 2;
      else if (gap === 3) value -= 4;
      else if (gap >= 4) value -= 5;
      if (gap <= 1 && a.v < 12) value += 1;
    }
    return Math.ceil(value);
  }

  function startingHandTag(cards) {
    const parsed = cards.map(parseCard).slice().sort(function (a, b) { return b.v - a.v; });
    const a = parsed[0], b = parsed[1];
    const pair = a.v === b.v;
    const suited = a.s === b.s;
    const connected = Math.abs(a.v - b.v) === 1;
    const gap = Math.abs(a.v - b.v);
    let tag = rankLabel(a.v) + rankLabel(b.v) + (pair ? '' : suited ? 's' : 'o');
    let description = pair ? '口袋对子' : suited ? '同花' : '非同花';
    if (!pair && connected) description += ' · 连张';
    else if (!pair && gap === 2) description += ' · 隔一张';
    return { tag, description, score: chenScore(parsed) };
  }

  /* ---------- draws ---------- */

  function getDrawInfo(hole, board) {
    const result = {
      flushDraw: false,
      straightDraw: false,
      openEnded: false,
      gutshot: false,
      draw: false,
      label: ''
    };
    if (!hole || hole.length < 2 || !board || board.length >= 5) return result;

    const all = hole.concat(board);
    const made = all.length >= 5 ? bestHand(all) : null;
    const madeCat = made ? made.category : -1;

    // Flush draw: exactly four of a suit, and at least one hole card contributes.
    if (madeCat < 5) {
      const suitCounts = { s: 0, h: 0, d: 0, c: 0 };
      for (const card of all) suitCounts[card.s]++;
      const holeSuits = { s: 0, h: 0, d: 0, c: 0 };
      for (const card of hole) holeSuits[card.s]++;
      for (const suit of Object.keys(suitCounts)) {
        if (suitCounts[suit] === 4 && holeSuits[suit] > 0) {
          result.flushDraw = true;
          break;
        }
      }
    }

    // Straight draw: four cards to a straight in a five-rank window.
    if (madeCat < 4) {
      const values = [];
      for (const card of all) values.push(card.v);
      if (values.indexOf(14) !== -1) values.push(1);
      const set = new Set(values);
      let windows = 0;
      for (let high = 14; high >= 5; high--) {
        let present = 0;
        for (let n = 0; n < 5; n++) if (set.has(high - n)) present++;
        if (present === 4) windows++;
      }
      if (windows > 0) {
        result.straightDraw = true;
        result.openEnded = windows >= 2;
        result.gutshot = !result.openEnded;
      }
    }

    result.draw = result.flushDraw || result.straightDraw;
    if (result.flushDraw && result.straightDraw) result.label = '同花 + 顺子听牌';
    else if (result.flushDraw) result.label = '同花听牌';
    else if (result.straightDraw) result.label = result.openEnded ? '两头顺听牌' : '卡顺听牌';
    return result;
  }

  /* ---------- equity ---------- */

  /**
   * Monte Carlo equity against one opponent.
   * @param {Array} hole - hero's two cards
   * @param {Array} board - 0..5 community cards
   * @param {Object} options - {iterations, rng, opponentMinChen}
   */
  function estimateEquity(hole, board, options) {
    const opts = options || {};
    const iterations = Math.max(20, opts.iterations || 400);
    const rng = opts.rng || Math.random;
    const minChen = opts.opponentMinChen || 0;
    const known = new Set();
    for (const card of hole) known.add(card.id);
    for (const card of board) known.add(card.id);
    const baseDeck = FULL_DECK.filter(function (card) { return !known.has(card.id); });

    let range = null;
    if (minChen > 0) {
      range = [];
      for (let i = 0; i < baseDeck.length; i++) {
        for (let j = i + 1; j < baseDeck.length; j++) {
          if (chenScore([baseDeck[i], baseDeck[j]]) >= minChen) {
            range.push([baseDeck[i], baseDeck[j]]);
          }
        }
      }
      if (!range.length) range = null;
    }

    const boardNeed = 5 - board.length;
    let wins = 0, ties = 0, losses = 0;
    const pickedBoard = [];

    for (let iter = 0; iter < iterations; iter++) {
      // Partial shuffle enough cards to give us a random board.
      const need = boardNeed + (range ? 0 : 2);
      for (let i = 0; i < need; i++) {
        const j = i + Math.floor(rng() * (baseDeck.length - i));
        const tmp = baseDeck[i];
        baseDeck[i] = baseDeck[j];
        baseDeck[j] = tmp;
      }

      pickedBoard.length = 0;
      for (let i = 0; i < boardNeed; i++) pickedBoard.push(baseDeck[i]);

      let oppCards;
      if (range) {
        let tries = 0;
        while (tries < 80) {
          const pair = range[Math.floor(rng() * range.length)];
          const blocked = pickedBoard.some(function (card) { return card === pair[0] || card === pair[1]; });
          if (!blocked) { oppCards = pair; break; }
          tries++;
        }
        if (!oppCards) {
          oppCards = [baseDeck[boardNeed], baseDeck[boardNeed + 1]];
        }
      } else {
        oppCards = [baseDeck[boardNeed], baseDeck[boardNeed + 1]];
      }

      const fullBoard = board.concat(pickedBoard);
      const heroScore = score(hole.concat(fullBoard));
      const oppScore = score(oppCards.concat(fullBoard));
      if (heroScore > oppScore) wins++;
      else if (heroScore === oppScore) ties++;
      else losses++;
    }

    return {
      equity: (wins + ties / 2) / iterations,
      winRate: wins / iterations,
      tieRate: ties / iterations,
      lossRate: losses / iterations,
      samples: iterations
    };
  }

  const API = {
    RANKS,
    SUITS,
    FULL_DECK,
    CATEGORY_NAMES,
    rankLabel,
    makeCard,
    parseCard,
    parseCards,
    createDeck,
    shuffle,
    cardText,
    cardsText,
    score,
    evaluate5,
    bestHand,
    compareHands,
    handName,
    handNameShort,
    chenScore,
    startingHandTag,
    getDrawInfo,
    estimateEquity
  };

  global.Poker = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
