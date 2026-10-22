/* ============================================================
   Three heads-up No-Limit Hold'em opponents
   easy   - loose/passive, calls too much, almost never bluffs
   medium - pot odds, selective aggression, occasional bluff
   hard   - range-aware equity, balanced aggression, exploitative
   ============================================================ */
(function (global) {
  'use strict';

  const P = global.Poker || (typeof require === 'function' ? require('./poker.js') : null);

  const PROFILES = {
    easy: {
      key: 'easy',
      name: '新手小柯',
      title: '松而被动',
      blurb: '跟注偏多、极少诈唬，适合先熟悉标准规则与牌型。',
      iterations: 110,
      rangePenalty: 0,
      opponentMinChen: 0,
      callMargin: -0.105,
      valueBet: 0.80,
      valueFrequency: 0.38,
      raiseValue: 0.91,
      raiseFrequency: 0.24,
      semiBluff: 0.015,
      bluff: 0.006,
      bluffRaise: 0.004,
      allInLove: 0.04,
      callDown: true,
      preflopOpen: 8.7,
      preflopCall: 3.4,
      preflopThreeBet: 13.2,
      preflopCallRaise: 6.6,
      preflopBbRaise: 9.4,
      preflopSteal: 4.6,
      preflopStealFreq: 0.12,
      preflopBluff: 0.005,
      allInChen: 9.3,
      useAllInEquity: false,
      sizing: [0.42, 0.58],
      aggression: 0.35
    },
    medium: {
      key: 'medium',
      name: '牌桌老手',
      title: '稳健施压',
      blurb: '会计算底池赔率、按牌面调整下注，偶尔用听牌半诈唬。',
      iterations: 300,
      rangePenalty: 0.012,
      opponentMinChen: 0,
      callMargin: 0.012,
      valueBet: 0.63,
      valueFrequency: 0.70,
      raiseValue: 0.73,
      raiseFrequency: 0.58,
      semiBluff: 0.18,
      bluff: 0.085,
      bluffRaise: 0.045,
      allInLove: 0.16,
      callDown: false,
      preflopOpen: 9.4,
      preflopCall: 5.6,
      preflopThreeBet: 12.0,
      preflopCallRaise: 7.8,
      preflopBbRaise: 8.4,
      preflopSteal: 5.2,
      preflopStealFreq: 0.30,
      preflopBluff: 0.035,
      allInChen: 10.6,
      useAllInEquity: true,
      preflopSamples: 260,
      sizing: [0.52, 0.72],
      aggression: 0.52
    },
    hard: {
      key: 'hard',
      name: '冷面算法',
      title: '范围平衡',
      blurb: '模拟胜率、收紧对手范围，会针对你的弃牌率调整诈唬。',
      iterations: 620,
      rangePenalty: 0.006,
      opponentMinChen: 3,
      callMargin: 0.006,
      valueBet: 0.61,
      valueFrequency: 0.80,
      raiseValue: 0.71,
      raiseFrequency: 0.62,
      semiBluff: 0.24,
      bluff: 0.115,
      bluffRaise: 0.06,
      allInLove: 0.20,
      callDown: false,
      preflopOpen: 9.4,
      preflopCall: 5.6,
      preflopThreeBet: 11.8,
      preflopCallRaise: 7.8,
      preflopBbRaise: 8.4,
      preflopSteal: 5.2,
      preflopStealFreq: 0.38,
      preflopBluff: 0.055,
      allInChen: 10.6,
      useAllInEquity: true,
      preflopSamples: 520,
      sizing: [0.50, 0.70, 0.95],
      aggression: 0.64
    }
  };

  const NAMES = {
    easy: '新手小柯',
    medium: '牌桌老手',
    hard: '冷面算法'
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function chooseOne(list, rng) {
    return list[Math.floor(rng() * list.length)];
  }

  function roundChips(value) {
    if (value >= 200) return Math.round(value / 10) * 10;
    if (value >= 50) return Math.round(value / 5) * 5;
    return Math.round(value);
  }

  function safeRaise(ctx, target, forceAllIn) {
    const raise = ctx.legal && ctx.legal.raise;
    if (!raise) return null;
    let amount = Math.round(target);
    if (forceAllIn) amount = raise.max;
    amount = clamp(amount, raise.min, raise.max);
    amount = roundChips(amount);
    if (amount < raise.min) amount = raise.min;
    if (amount > raise.max) amount = raise.max;
    if (amount <= ctx.currentBet) {
      if (raise.max > ctx.currentBet) amount = raise.max;
      else return null;
    }
    return { type: 'raise', amount };
  }

  function actionFold() {
    return { type: 'fold' };
  }

  function actionCallOrCheck(ctx) {
    if (ctx.legal && ctx.legal.canCheck) return { type: 'check' };
    if (ctx.legal && ctx.legal.canCall) return { type: 'call' };
    return actionFold();
  }

  function preflopRaiseSize(ctx, rng) {
    const bb = ctx.bigBlind || 20;
    const facingRaise = ctx.currentBet > bb;
    let target;
    if (facingRaise) {
      target = ctx.currentBet * (2.6 + rng() * 0.5);
    } else if (ctx.toCall > 0) {
      target = bb * (2.7 + rng() * 0.7);
    } else {
      target = bb * (2.6 + rng() * 0.7);
    }
    return safeRaise(ctx, target, false);
  }

  function playerTendencies(stats) {
    const s = stats || {};
    const sample = s.facedBet || 0;
    const foldToBet = sample >= 5 ? (s.foldsToBet || 0) / sample : 0.42;
    const callToBet = sample >= 5 ? (s.callsToBet || 0) / sample : 0.40;
    const aggression = s.actions ? (s.raises || 0) / s.actions : 0.20;
    return {
      foldToBet: clamp(foldToBet, 0, 1),
      callToBet: clamp(callToBet, 0, 1),
      aggression: clamp(aggression, 0, 1),
      sample
    };
  }

  function chooseEquitySamples(profile, ctx) {
    if (profile.key === 'easy') return profile.iterations;
    if (profile.key === 'hard' && ctx.board.length >= 4) return Math.round(profile.iterations * 1.1);
    return profile.iterations;
  }

  function opponentRangeCutoff(profile, ctx, tendencies) {
    if (profile.key === 'easy') return 0;
    if (profile.key === 'medium') {
      if (ctx.playerRaisedPreflop) return 5;
      if (ctx.toCall > 0 && ctx.phase !== 'preflop') return 3;
      return 0;
    }
    let cutoff = profile.opponentMinChen || 0;
    if (ctx.playerRaisedPreflop) cutoff = Math.max(cutoff, 7);
    if (ctx.toCall > 0 && ctx.phase !== 'preflop') cutoff = Math.max(cutoff, 5);
    if (tendencies.aggression > 0.32) cutoff = Math.max(cutoff, 6);
    return cutoff;
  }

  function preflopDecision(ctx, profile, rng) {
    const legal = ctx.legal;
    const toCall = ctx.toCall;
    const bb = ctx.bigBlind || 20;
    const chen = P.chenScore(ctx.hole);
    const isButton = !!ctx.isButton;
    const positionBonus = isButton ? 0.6 : 0;
    const score = chen + positionBonus;
    const facingRaise = ctx.currentBet > bb;
    const facingAllIn = toCall > 0 && !legal.canRaise;
    const allInCall = toCall >= ctx.stack;

    if (allInCall || facingAllIn) {
      if (profile.useAllInEquity) {
        const odds = toCall / (ctx.pot + toCall);
        const cutoff = 8;
        const sims = Math.min(profile.preflopSamples || 300, 460);
        const equity = P.estimateEquity(ctx.hole, [], {
          iterations: sims,
          rng,
          opponentMinChen: cutoff
        }).equity;
        const adjusted = equity - profile.rangePenalty;
        if (adjusted >= odds + profile.callMargin - 0.01) return actionCallOrCheck(ctx);
        return actionFold();
      }
      if (chen >= profile.allInChen) return actionCallOrCheck(ctx);
      return actionFold();
    }

    // Big blind option after a limp.
    if (toCall <= 0) {
      if (!legal.canRaise) return { type: 'check' };
      if (score >= profile.preflopBbRaise) {
        const raise = preflopRaiseSize(ctx, rng);
        if (raise) return raise;
      }
      if (profile.key !== 'easy' && score >= profile.preflopSteal && rng() < profile.preflopBluff) {
        const raise = preflopRaiseSize(ctx, rng);
        if (raise) return raise;
      }
      return { type: 'check' };
    }

    if (facingRaise) {
      if (legal.canRaise && score >= profile.preflopThreeBet && rng() < 0.82) {
        const raise = preflopRaiseSize(ctx, rng);
        if (raise) return raise;
      }
      if (profile.key !== 'easy' && legal.canRaise && rng() < profile.preflopBluff * 0.7) {
        const raise = preflopRaiseSize(ctx, rng);
        if (raise) return raise;
      }
      if (score >= profile.preflopCallRaise) return actionCallOrCheck(ctx);
      return actionFold();
    }

    // Unraised pot: open or steal.
    if (legal.canRaise) {
      if (score >= profile.preflopOpen) {
        const raise = preflopRaiseSize(ctx, rng);
        if (raise) return raise;
      }
      if (isButton && score >= profile.preflopSteal && rng() < profile.preflopStealFreq) {
        const raise = preflopRaiseSize(ctx, rng);
        if (raise) return raise;
      }
    }
    if (score >= profile.preflopCall) return actionCallOrCheck(ctx);
    return actionFold();
  }

  function postflopSize(ctx, profile, rng, strong) {
    const fractions = profile.sizing;
    let fraction = chooseOne(fractions, rng);
    if (strong && profile.key === 'hard' && rng() < 0.2) fraction = 1.15;
    if (profile.key === 'easy') fraction = 0.38 + rng() * 0.2;

    let target;
    if (ctx.toCall > 0) {
      target = ctx.currentBet + (ctx.pot + ctx.toCall) * fraction;
    } else {
      target = ctx.pot * fraction;
    }
    const forceAllIn = strong && rng() < profile.allInLove;
    return safeRaise(ctx, target, forceAllIn);
  }

  function postflopDecision(ctx, profile, rng) {
    const legal = ctx.legal;
    const hole = ctx.hole;
    const board = ctx.board;
    const best = P.bestHand(hole.concat(board));
    const draw = P.getDrawInfo(hole, board);
    const tendencies = playerTendencies(ctx.playerStats);
    const cutoff = opponentRangeCutoff(profile, ctx, tendencies);

    const equityResult = P.estimateEquity(hole, board, {
      iterations: chooseEquitySamples(profile, ctx),
      rng,
      opponentMinChen: cutoff
    });
    let equity = equityResult.equity;

    // Opponent's betting range is stronger than a random hand. Harder
    // opponents account for this and also exploit clear player leaks.
    let penalty = 0;
    if (ctx.toCall > 0) penalty += profile.rangePenalty;
    if (ctx.playerRaisedPreflop) penalty += profile.rangePenalty * 0.55;
    if (profile.key === 'hard') {
      if (tendencies.aggression > 0.3) penalty += 0.008;
      if (tendencies.foldToBet > 0.58) penalty -= 0.006;
      if (tendencies.callToBet > 0.64) penalty += 0.008;
    }
    equity = clamp(equity - penalty, 0.01, 0.99);

    const pot = ctx.pot;
    const toCall = ctx.toCall;
    const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
    const implied = draw.draw ? (profile.key === 'hard' ? 0.035 : profile.key === 'medium' ? 0.022 : 0) : 0;
    const callThreshold = potOdds + profile.callMargin - implied;
    const canRaise = !!legal.canRaise;

    // Exploit a player who folds too often; bluff less against a station.
    let bluffChance = profile.bluff;
    let valueThreshold = profile.valueBet;
    if (profile.key === 'hard') {
      if (tendencies.sample >= 5 && tendencies.foldToBet > 0.58) bluffChance += 0.09;
      if (tendencies.sample >= 5 && tendencies.callToBet > 0.62) {
        bluffChance -= 0.07;
        valueThreshold -= 0.025;
      }
      if (tendencies.aggression > 0.35) bluffChance -= 0.02;
    } else if (profile.key === 'medium') {
      if (tendencies.sample >= 6 && tendencies.foldToBet > 0.65) bluffChance += 0.035;
      if (tendencies.sample >= 6 && tendencies.callToBet > 0.65) bluffChance -= 0.03;
    }
    bluffChance = clamp(bluffChance, 0, 0.35);

    if (toCall > 0) {
      // Value raise.
      if (canRaise && equity >= profile.raiseValue && rng() < profile.raiseFrequency) {
        const raise = postflopSize(ctx, profile, rng, true);
        if (raise) return raise;
      }

      // Semi-bluff with a draw; pure bluff against a folding opponent.
      if (canRaise && draw.draw && equity < profile.raiseValue && rng() < profile.semiBluff) {
        const raise = postflopSize(ctx, profile, rng, false);
        if (raise) return raise;
      }
      if (canRaise && equity < potOdds && rng() < profile.bluffRaise * (profile.key === 'hard' ? 1.4 : 1)) {
        const raise = postflopSize(ctx, profile, rng, false);
        if (raise) return raise;
      }

      if (equity >= callThreshold) return actionCallOrCheck(ctx);
      return actionFold();
    }

    // No bet to call: value bet, semi-bluff, or check.
    if (!canRaise) return { type: 'check' };

    if (equity >= valueThreshold && rng() < profile.valueFrequency) {
      const raise = postflopSize(ctx, profile, rng, true);
      if (raise) return raise;
    }
    if (draw.draw && rng() < profile.semiBluff) {
      const raise = postflopSize(ctx, profile, rng, false);
      if (raise) return raise;
    }
    if (rng() < bluffChance && equity < valueThreshold) {
      const raise = postflopSize(ctx, profile, rng, false);
      if (raise) return raise;
    }
    return { type: 'check' };
  }

  function decide(ctx) {
    const difficulty = ctx.difficulty || 'medium';
    const profile = PROFILES[difficulty] || PROFILES.medium;
    const rng = ctx.rng || Math.random;
    if (!ctx.legal || !ctx.legal.available) return { type: 'fold' };

    let action;
    try {
      action = ctx.phase === 'preflop'
        ? preflopDecision(ctx, profile, rng)
        : postflopDecision(ctx, profile, rng);
    } catch (error) {
      action = actionCallOrCheck(ctx);
    }

    // Final guard: never return an action the table will reject.
    if (!action) action = actionCallOrCheck(ctx);
    if (action.type === 'check' && !ctx.legal.canCheck) {
      action = ctx.legal.canCall ? { type: 'call' } : { type: 'fold' };
    }
    if (action.type === 'call' && !ctx.legal.canCall) {
      action = ctx.legal.canCheck ? { type: 'check' } : { type: 'fold' };
    }
    if (action.type === 'raise' && !ctx.legal.raise) {
      action = actionCallOrCheck(ctx);
    }
    if (action.type === 'raise') {
      const min = ctx.legal.raise.min;
      const max = ctx.legal.raise.max;
      action.amount = clamp(Math.round(action.amount), min, max);
    }
    action.profile = profile.key;
    return action;
  }

  function makeContext(table, difficulty, playerStats, options) {
    const legal = table.getLegalActions('ai');
    return {
      difficulty,
      hole: table.holes.ai,
      board: table.board,
      phase: table.phase,
      pot: table.pot,
      toCall: legal.toCall || 0,
      currentBet: table.currentBet,
      bigBlind: table.bigBlind,
      smallBlind: table.smallBlind,
      stack: table.stacks.ai,
      opponentStack: table.stacks.player,
      legal,
      isButton: table.button === 'ai',
      handNo: table.handNo,
      playerStats: playerStats || {},
      playerRaisedPreflop: !!(options && options.playerRaisedPreflop),
      rng: options && options.rng
    };
  }

  const API = { decide, makeContext, PROFILES, NAMES };
  global.PokerAI = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
