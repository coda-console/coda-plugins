// The main turns Kimi's ACP does not tell, from its main wire (observe.mjs `main`). Its ACP passes on only the turn its own
// prompt drives. While Kimi has a goal it begins a turn of its own after each turn ends, toward that goal; a prompt that
// reaches it while such a turn is going is queued, and its ACP answers it at once though it runs later.
// So the goal is told as a timer that fires again after each turn (docs/agent-protocol.md「_coda/wait」): `handling` through
// each of its turns, which Coda takes up as turns of their own, `waiting` between them, `done` once the goal is no longer
// active, `failed` with the reason when the last main turn before that failed (Kimi pauses its goal after a turn fails). A Coda prompt Kimi answered at once without running it is held: its answer waits for the turn that runs it, the
// first of Coda's prompts' turns that began after it was sent. A prompt whose turn failed is answered with that failure
// (errors.mjs), which Kimi's ACP answers as `end_turn`. What is said in a goal's turn or a held prompt's is told as
// this session's updates; a turn from before this agent process (`startedAt`) is another process's and is not told.
import { failedAnswer, turnFailure } from './errors.mjs';

const CONTINUES = '目标未完成前，每轮结束后自动继续';
// How Kimi's ACP answers a turn that ended so.
const STOPPED = { cancelled: 'cancelled', blocked: 'refusal' };

export class KimiTurns {
  constructor({ sessionId, startedAt = 0 }) {
    this.sessionId = sessionId; this.startedAt = startedAt;
    // The goal as told ({ id, active, state, turn, failure }) and as the wire last left it. Main turns going, those whose content is
    // told, the last Coda prompt's turn seen, and the prompts held.
    this.goal = null; this.latest = null; this.going = new Set(); this.telling = new Set(); this.user = null; this.held = [];
  }
  // Holds `answer`, Kimi's answer to the prompt sent at `sentAt`, when Kimi did not run that prompt yet: no turn of Coda's
  // prompts began since, or the one that did is still going, while some turn is. False when it is to be passed on now.
  hold(sentAt, answer) {
    const user = this.user && !this.user.claimed && this.user.time >= sentAt ? this.user : null;
    if (user ? user.ended : !this.going.size) return false;
    if (user) { user.claimed = true; this.telling.add(user.turnId); }
    this.held.push({ sentAt, answer, turnId: user?.turnId });
    return true;
  }
  // What `main` tells Coda, in order: the goal's waits, what its turns and held prompts' turns said, and held answers due.
  read(main = []) {
    const told = [];
    for (const entry of main) {
      if (entry.type === 'goal') this.noteGoal(entry, told);
      else if (entry.type === 'turn') this.begin(entry, told);
      else if (entry.type === 'ended') this.end(entry, told);
      else if (entry.type === 'update' && this.telling.has(entry.turnId)) told.push(update(this.sessionId, entry.update));
    }
    return told;
  }
  // The goal as the wire now leaves it. The one told goes on while it is this one and active; otherwise it ends, once its
  // turn did, and this one is told if active.
  noteGoal(entry, told) {
    this.latest = entry;
    const goal = this.goal;
    if (open(goal)) {
      goal.active = goal.id === entry.id && entry.active;
      if (goal.active || goal.turn !== undefined) return;
      this.finish(told);
    }
    this.start(told);
  }
  start(told) {
    const latest = this.latest;
    if (!latest?.active || this.goal?.id === latest.id) return;
    this.goal = { id: latest.id, active: true, state: 'waiting', turn: undefined, failure: null };
    told.push(wait({ sessionId: this.sessionId, waitId: latest.id, state: 'waiting', kind: 'timer', title: latest.title || 'Kimi 目标',
      detail: CONTINUES, recurring: true, stoppable: false }));
  }
  begin({ turnId, kind, time }, told) {
    if (time < this.startedAt || this.going.has(turnId)) return;
    this.going.add(turnId);
    if (kind === 'goal') {
      // The goal's turn before it ended, though Kimi writes that end after this start.
      if (open(this.goal) && this.goal.turn !== undefined) this.settle(told);
      if (!open(this.goal)) return;
      this.goal.turn = turnId;
      this.telling.add(turnId);
      this.say(told, 'handling');
    } else if (kind === 'user') {
      this.user = { turnId, time, ended: false, claimed: false, failure: null };
      const held = this.held.find(h => h.turnId === undefined && h.sentAt <= time);
      if (held) { held.turnId = turnId; this.user.claimed = true; this.telling.add(turnId); }
    }
  }
  end({ turnId, reason, error }, told) {
    if (!this.going.delete(turnId)) return;
    this.telling.delete(turnId);
    const failure = turnFailure(reason, error);
    if (this.user?.turnId === turnId) { this.user.ended = true; this.user.failure = failure; }
    if (open(this.goal)) this.goal.failure = failure;
    if (this.goal?.turn === turnId) this.settle(told);
    const i = this.held.findIndex(h => h.turnId === turnId);
    if (i >= 0) {
      const { answer } = this.held.splice(i, 1)[0];
      told.push(failure ? failedAnswer(answer, failure) : answered(answer, STOPPED[reason] ?? 'end_turn'));
    }
  }
  // How the turn of the prompt sent at `sentAt` failed, once it ended so; null otherwise. For an answer not held.
  failure(sentAt) {
    const user = this.user;
    return user && !user.claimed && user.ended && user.time >= sentAt ? user.failure : null;
  }
  // The goal's turn is over: it waits for the next, or ends, and the goal that replaced it is told.
  settle(told) {
    this.goal.turn = undefined;
    if (this.goal.active) this.say(told, 'waiting'); else this.finish(told);
    this.start(told);
  }
  // The goal is no longer active: done, or failed as the last main turn did.
  finish(told) {
    const failure = this.goal.failure;
    if (!failure) { this.say(told, 'done'); return; }
    this.say(told, 'failed', { ...(failure.quota ? { title: '额度不足' } : {}), detail: failure.message.slice(0, 4000) });
  }
  say(told, state, more = {}) {
    this.goal.state = state;
    told.push(wait({ sessionId: this.sessionId, waitId: this.goal.id, state, ...more }));
  }
  // Coda stopped: Kimi's ACP cannot stop a turn it does not drive, so a held prompt is answered as stopped now, and what its
  // turn says if it still runs is not told.
  cancel() {
    for (const held of this.held) this.telling.delete(held.turnId);
    return this.held.splice(0).map(held => answered(held.answer, 'cancelled'));
  }
  // The files no longer read as understood: the goal ends, and held answers are passed on as Kimi gave them.
  lost() {
    const told = [];
    if (open(this.goal)) { this.goal.turn = undefined; this.say(told, 'failed'); }
    this.going.clear(); this.telling.clear(); this.user = null;
    return [...told, ...this.held.splice(0).map(held => held.answer)];
  }
}

const open = goal => goal?.state === 'waiting' || goal?.state === 'handling';
const wait = params => ({ jsonrpc: '2.0', method: '_coda/wait', params });
const update = (sessionId, value) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } });
const answered = (answer, stopReason) => ({ ...answer, result: { ...answer.result, stopReason } });
