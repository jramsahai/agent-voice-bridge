// Server-free proof of turn-log.js's fixed record shape, its outcome vocabulary, and its
// structural inability to carry a secret or a transcript. Drives logTurnCompletion() directly
// by capturing console.log for the duration of each test — no server, no socket, no fake
// adapters.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { logTurnCompletion, TURN_LOG_EVENT, TURN_OUTCOMES } from '../packages/shared/logging/turn-log.js';

function captureLog(fn) {
  const originalLog = console.log;
  const lines = [];
  console.log = (line) => {
    lines.push(line);
  };
  try {
    fn(lines);
  } finally {
    console.log = originalLog;
  }
}

test('one logTurnCompletion call emits exactly one line, and that line parses as JSON', () => {
  captureLog((lines) => {
    logTurnCompletion({ client: 'alpha', outcome: TURN_OUTCOMES.OK });
    assert.equal(lines.length, 1);
    assert.doesNotThrow(() => JSON.parse(lines[0]));
  });
});

test("the parsed object's own key list deep-equals the fixed six, in that order", () => {
  captureLog((lines) => {
    logTurnCompletion({ client: 'alpha', outcome: TURN_OUTCOMES.OK });
    const parsed = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(parsed), ['event', 'ts', 'client', 'outcome', 'errorCode', 'durationsMs']);
  });
});

test("durationsMs's own key list deep-equals the fixed three, in that order", () => {
  captureLog((lines) => {
    logTurnCompletion({ client: 'alpha', outcome: TURN_OUTCOMES.OK });
    const parsed = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(parsed.durationsMs), ['transcribe', 'agent', 'speak']);
  });
});

test('a call passing no durationsMs at all yields all three members null', () => {
  captureLog((lines) => {
    logTurnCompletion({ client: 'alpha', outcome: TURN_OUTCOMES.OK });
    const parsed = JSON.parse(lines[0]);
    assert.deepEqual(parsed.durationsMs, { transcribe: null, agent: null, speak: null });
  });
});

test('a call passing transcribe: 0 yields the number 0, not null — D-07\'s distinction', () => {
  captureLog((lines) => {
    logTurnCompletion({ client: 'alpha', outcome: TURN_OUTCOMES.OK, durationsMs: { transcribe: 0 } });
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.durationsMs.transcribe, 0);
    assert.equal(parsed.durationsMs.speak, null);
  });
});

test('a call passing a non-numeric duration yields null for that member', () => {
  captureLog((lines) => {
    logTurnCompletion({
      client: 'alpha',
      outcome: TURN_OUTCOMES.OK,
      durationsMs: { transcribe: 'not-a-number', agent: NaN, speak: undefined },
    });
    const parsed = JSON.parse(lines[0]);
    assert.deepEqual(parsed.durationsMs, { transcribe: null, agent: null, speak: null });
  });
});

test('errorCode defaults to null and passes a supplied catalogue code straight through', () => {
  captureLog((lines) => {
    logTurnCompletion({ client: 'alpha', outcome: TURN_OUTCOMES.ERROR });
    assert.equal(JSON.parse(lines[0]).errorCode, null);
  });
  captureLog((lines) => {
    logTurnCompletion({ client: 'alpha', outcome: TURN_OUTCOMES.ERROR, errorCode: 'TRANSCRIPT_EMPTY' });
    assert.equal(JSON.parse(lines[0]).errorCode, 'TRANSCRIPT_EMPTY');
  });
});

test('each of the three TURN_OUTCOMES values round-trips; an unrecognised outcome string is written as the error outcome', () => {
  for (const outcome of Object.values(TURN_OUTCOMES)) {
    captureLog((lines) => {
      logTurnCompletion({ client: 'alpha', outcome });
      assert.equal(JSON.parse(lines[0]).outcome, outcome);
    });
  }
  captureLog((lines) => {
    logTurnCompletion({ client: 'alpha', outcome: 'not-a-real-outcome' });
    assert.equal(JSON.parse(lines[0]).outcome, TURN_OUTCOMES.ERROR);
  });
});

test('event equals TURN_LOG_EVENT and ts parses as a valid date', () => {
  captureLog((lines) => {
    logTurnCompletion({ client: 'alpha', outcome: TURN_OUTCOMES.OK });
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.event, TURN_LOG_EVENT);
    assert.ok(!Number.isNaN(new Date(parsed.ts).getTime()));
  });
});

test('extra properties on the argument object never reach the emitted line — the no-spread guarantee, driven adversarially with distinguishable sentinels', () => {
  const CREDENTIAL_SENTINEL = 'sentinel-credential-h3q9x2vk';
  const REPLY_TEXT_SENTINEL = 'sentinel-replytext-r5t1c8mn';
  captureLog((lines) => {
    logTurnCompletion({
      client: 'alpha',
      outcome: TURN_OUTCOMES.OK,
      token: CREDENTIAL_SENTINEL,
      replyText: REPLY_TEXT_SENTINEL,
    });
    assert.ok(!lines[0].includes(CREDENTIAL_SENTINEL));
    assert.ok(!lines[0].includes(REPLY_TEXT_SENTINEL));
  });
});

test('two calls in the same tick emit two separate lines', () => {
  captureLog((lines) => {
    logTurnCompletion({ client: 'alpha', outcome: TURN_OUTCOMES.OK });
    logTurnCompletion({ client: 'beta', outcome: TURN_OUTCOMES.OK });
    assert.equal(lines.length, 2);
    assert.notEqual(lines[0], lines[1]);
  });
});

test('G6 / OPS-01 / WR-05: logTurnCompletion with durationsMs: null does not throw and emits all null durations', () => {
  captureLog((lines) => {
    assert.doesNotThrow(() => {
      logTurnCompletion({ client: 'alpha', outcome: TURN_OUTCOMES.OK, durationsMs: null });
    });
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.deepEqual(parsed.durationsMs, { transcribe: null, agent: null, speak: null });
  });
});
