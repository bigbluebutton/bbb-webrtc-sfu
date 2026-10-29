'use strict';

require('./helpers.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  mapRecorderTimestamps,
  sfuTimestamps,
} = require('../lib/livekit/recorder-timestamps.js');

const NOW_UTC = Date.UTC(2026, 9, 29, 12, 0, 0);
const NOW_HR = 5000000;
const clocks = { now: () => NOW_UTC, hrNow: () => NOW_HR };

describe('mapRecorderTimestamps', () => {
  it('keeps the recorder HR when it agrees with the UTC mapping', () => {
    const result = mapRecorderTimestamps({ utc: NOW_UTC - 2000, hr: NOW_HR - 2000 + 300 }, clocks);

    assert.deepEqual(result, {
      timestampHR: NOW_HR - 1700,
      timestampUTC: NOW_UTC - 2000,
      source: 'recorder-hr',
    });
  });

  it('maps the UTC into the SFU clock when the HR comes from another clock', () => {
    const result = mapRecorderTimestamps({ utc: NOW_UTC - 2000, hr: 123 }, clocks);

    assert.deepEqual(result, {
      timestampHR: NOW_HR - 2000,
      timestampUTC: NOW_UTC - 2000,
      source: 'recorder-utc',
    });
  });

  it('maps the UTC when the HR is missing or not a number', () => {
    for (const hr of [undefined, null, '4998000', NaN, Infinity]) {
      const result = mapRecorderTimestamps({ utc: NOW_UTC - 2000, hr }, clocks);
      assert.equal(result.source, 'recorder-utc', `hr=${hr}`);
      assert.equal(result.timestampHR, NOW_HR - 2000, `hr=${hr}`);
    }
  });

  it('accepts a UTC slightly ahead of the SFU clock', () => {
    const result = mapRecorderTimestamps({ utc: NOW_UTC + 500 }, clocks);

    assert.equal(result.timestampHR, NOW_HR + 500);
  });

  it('returns null for an invalid UTC', () => {
    const invalid = [
      undefined,
      null,
      '2026-10-29T12:00:00.000Z',
      NaN,
      Infinity,
      0,
      -62135596800000,
      Date.UTC(1999, 11, 31),
      NOW_UTC + 60000,
    ];

    for (const utc of invalid) {
      assert.equal(mapRecorderTimestamps({ utc, hr: NOW_HR }, clocks), null, `utc=${utc}`);
    }
    assert.equal(mapRecorderTimestamps(undefined, clocks), null);
  });

  it('returns null when the UTC maps before the SFU clock origin', () => {
    const result = mapRecorderTimestamps(
      { utc: NOW_UTC - 10000 },
      { now: () => NOW_UTC, hrNow: () => 4000 },
    );

    assert.equal(result, null);
  });

  it('rounds to integer milliseconds', () => {
    const result = mapRecorderTimestamps({ utc: NOW_UTC - 1000.6, hr: NOW_HR - 1000.4 }, clocks);

    assert.equal(result.timestampHR, NOW_HR - 1000);
    assert.equal(result.timestampUTC, NOW_UTC - 1001);
  });
});

describe('sfuTimestamps', () => {
  it('puts hrNow() in timestampHR and now() in timestampUTC, tagged sfu', () => {
    assert.deepEqual(sfuTimestamps(clocks), {
      timestampHR: NOW_HR,
      timestampUTC: NOW_UTC,
      source: 'sfu',
    });
  });
});
