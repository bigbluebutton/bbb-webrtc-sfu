'use strict';

const { hrTime } = require('../common/utils.js');

const MIN_UTC = Date.UTC(2000, 0, 1);
// Clocks on one host can still disagree by a few ms. A recorder clock past
// these limits is wrong or on another host.
const MAX_UTC_AHEAD_MS = 5000;
const MAX_HR_SKEW_MS = 1000;

const SFU_CLOCKS = { now: Date.now, hrNow: hrTime };

const sfuTimestamps = ({ now, hrNow } = SFU_CLOCKS) => ({
  timestampHR: hrNow(),
  timestampUTC: now(),
  source: 'sfu',
});

/*
 * Maps a media instant reported by bbb-webrtc-recorder ({ utc, hr }: epoch
 * ms and CLOCK_MONOTONIC ms) into the clocks of the SFU's recording events.
 * The recorder HR is kept when it agrees with the UTC mapped into hrTime;
 * otherwise the mapped value is used. Returns null on an invalid UTC so the
 * caller can fall back to sfuTimestamps().
 */
const mapRecorderTimestamps = ({ utc, hr } = {}, { now, hrNow } = SFU_CLOCKS) => {
  if (!Number.isFinite(utc)) return null;

  // Both clocks are read together so that the SFU's own handling delay
  // cancels out of the mapping.
  const nowUTC = now();
  const nowHR = hrNow();

  if (utc < MIN_UTC || utc > nowUTC + MAX_UTC_AHEAD_MS) return null;

  const mappedHR = nowHR - (nowUTC - utc);

  if (mappedHR < 0) return null;

  const timestampUTC = Math.round(utc);

  if (Number.isFinite(hr) && Math.abs(hr - mappedHR) <= MAX_HR_SKEW_MS) {
    return { timestampHR: Math.round(hr), timestampUTC, source: 'recorder-hr' };
  }

  return { timestampHR: Math.round(mappedHR), timestampUTC, source: 'recorder-utc' };
};

module.exports = {
  mapRecorderTimestamps,
  sfuTimestamps,
};
