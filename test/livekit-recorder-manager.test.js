'use strict';

const {
  createManager,
  publishTrack,
  unpublishTrack,
  waitFor,
  settle,
  shortRequestTimeout,
  dispose,
  recorderStopped,
  trackEvent,
  MEETING_ID,
  USER_ID,
} = require('./helpers.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { hrTime } = require('../lib/common/utils.js');

const flowing = (recordingSessionId) => ({
  id: 'recordingRtpStatusChanged',
  recordingSessionId,
  status: 'flowing',
  timestampUTC: new Date().toISOString(),
  timestampHR: 900,
});

const now = () => ({ hr: hrTime(), utc: Date.now() });

const assertSfuTime = (event, before, after = now()) => {
  assert.ok(event.timestamp >= before.hr && event.timestamp <= after.hr,
    `timestamp ${event.timestamp} is not SFU time`);
  assert.ok(event.timestampUTC >= before.utc && event.timestampUTC <= after.utc,
    `timestampUTC ${event.timestampUTC} is not SFU time`);
};

// hrTime() counts whole ms, so an SFU time taken right after `since` can
// still equal it. A check then cannot tell the two apart.
const clockTick = (since) => waitFor(() => hrTime() > since.hr, { what: 'hrTime to move' });

const writesFor = (ctx, filename) => ctx.gateway.writes
  .filter((write) => write.filename === filename);

// A recording as getRecordings lists it.
const listedRecording = (recording, fields = {}) => ({
  recordingSessionId: recording.recordingSessionId,
  fileName: recording.filename,
  adapter: 'livekit',
  adapterOptions: { livekit: { room: MEETING_ID, trackIds: [recording.trackId] } },
  metadata: { participantId: USER_ID, trackSource: recording.trackSource },
  ...fields,
});

describe('LiveKit recorder manager, recorder without mediaTimestamps', () => {
  it('writes the Start on flowing with the SFU time', async (t) => {
    const ctx = await createManager();
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    const before = now();

    ctx.fake.client.deliver(flowing(recording.recordingSessionId));
    await settle();

    const starts = ctx.gateway.events('StartWebRTCShareEvent');
    assert.equal(starts.length, 1);
    assertSfuTime(starts[0], before);
    assert.equal(starts[0].filename, recording.filename);
  });

  it('writes one Stop with the SFU time when the SFU stops it', async (t) => {
    const ctx = await createManager();
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'microphone');
    ctx.fake.client.deliver(flowing(recording.recordingSessionId));
    await settle();
    const before = now();

    unpublishTrack(ctx, 'microphone');
    await waitFor(() => ctx.gateway.events('AudioTrackUnpublishedEvent').length > 0,
      { what: 'Stop event' });
    await settle();

    const stops = ctx.gateway.events('AudioTrackUnpublishedEvent');
    assert.equal(stops.length, 1);
    assertSfuTime(stops[0], before);
  });

  it('writes no Start and no Stop for a capture declined on flowing', async (t) => {
    const ctx = await createManager();
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    ctx.roomRecordingStatusMap.set(recording.roomName, false);

    ctx.fake.client.deliver(flowing(recording.recordingSessionId));
    await waitFor(() => !ctx.manager._activeRecordings.has(recording.trackId),
      { what: 'recording removal' });
    await settle();

    assert.deepEqual(ctx.gateway.writes, []);
  });
});

const CAPABLE = { capabilities: ['mediaTimestamps'] };

// Recorder media times on this host's clocks, agoMs in the past. The HR is
// 250 ms before the UTC mapped into hrTime(), still within MAX_HR_SKEW_MS.
// A test can then tell an event time taken from the recorder HR from one
// mapped from the UTC.
const mediaTimes = (prefix, agoMs) => {
  const t = now();

  return {
    [`${prefix}UTC`]: t.utc - agoMs,
    [`${prefix}HR`]: t.hr - agoMs - 250,
  };
};

const mediaStarted = (recordingSessionId, times) => ({
  id: 'recordingMediaStarted',
  recordingSessionId,
  ...times,
});

// Recorder media times from another host, agoMs in the past. Its HR is
// unrelated to the SFU's, and its wall clock is offsetMs ahead (negative:
// behind).
const otherHost = (prefix, offsetMs, agoMs = 0) => ({
  [`${prefix}UTC`]: Date.now() + offsetMs - agoMs,
  [`${prefix}HR`]: 42,
});

// For a recorder time whose HR is not used: the event HR is the UTC mapped
// into hrTime().
const assertMappedTime = (event, utc, at) => {
  const expected = at.hr - (at.utc - utc);
  assert.ok(Math.abs(event.timestamp - expected) <= 20,
    `timestamp ${event.timestamp} is not ${expected}`);
  assert.equal(event.timestampUTC, utc);
};

// The file's first two writes are its Start and a Stop no earlier than it.
const assertNoStopBeforeStart = (ctx) => {
  const [start, stop] = ctx.gateway.writes;
  assert.equal(stop.eventName, 'StopWebRTCShareEvent');
  assert.ok(stop.timestamp >= start.timestamp, `Stop ${stop.timestamp} is before Start ${start.timestamp}`);
  assert.ok(stop.timestampUTC >= start.timestampUTC);
};

describe('LiveKit recorder manager, recorder with mediaTimestamps', () => {
  for (const [source, startEvent, stopEvent] of [
    ['camera', 'StartWebRTCShareEvent', 'StopWebRTCShareEvent'],
    ['microphone', 'AudioTrackPublishedEvent', 'AudioTrackUnpublishedEvent'],
    ['screen_share', 'StartWebRTCDesktopShareEvent', 'StopWebRTCDesktopShareEvent'],
  ]) {
    it(`writes one ${source} Start from recordingMediaStarted, none on flowing, and the Stop from the media end`, async (t) => {
      const ctx = await createManager(CAPABLE);
      t.after(() => dispose(ctx.manager));
      const recording = await publishTrack(ctx, source);

      ctx.fake.client.deliver(flowing(recording.recordingSessionId));
      await settle();
      assert.equal(ctx.gateway.events(startEvent).length, 0);

      const start = mediaTimes('mediaStart', 400);
      ctx.fake.client.deliver(mediaStarted(recording.recordingSessionId, start));
      ctx.fake.client.deliver(flowing(recording.recordingSessionId));
      await settle();

      const starts = ctx.gateway.events(startEvent);
      assert.equal(starts.length, 1);
      assert.equal(starts[0].timestamp, start.mediaStartHR);
      assert.equal(starts[0].timestampUTC, start.mediaStartUTC);
      assert.equal(starts[0].filename, recording.filename);

      const end = mediaTimes('mediaEnd', 100);
      ctx.fake.client.deliver(recorderStopped(recording.recordingSessionId, { ...start, ...end }));
      await settle();
      assert.deepEqual(ctx.gateway.writes.map((write) => [write.eventName, write.timestamp]), [
        [startEvent, start.mediaStartHR],
        [stopEvent, end.mediaEndHR],
      ]);
    });
  }

  it('maps mediaStartUTC when mediaStartHR comes from another clock', async (t) => {
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    const start = mediaTimes('mediaStart', 400);
    const before = now();

    ctx.fake.client.deliver(mediaStarted(recording.recordingSessionId, {
      mediaStartUTC: start.mediaStartUTC,
      mediaStartHR: 42,
    }));
    await settle();

    const [event] = ctx.gateway.events('StartWebRTCShareEvent');
    assertMappedTime(event, start.mediaStartUTC, before);
  });

  it('writes Start and Stop for a recorder whose clock is 5 s behind', async (t) => {
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    const start = otherHost('mediaStart', -5000);
    const before = now();

    ctx.fake.client.deliver(mediaStarted(recording.recordingSessionId, start));
    ctx.fake.client.deliver(recorderStopped(recording.recordingSessionId, {
      ...start,
      ...otherHost('mediaEnd', -5000, -100),
    }));
    await settle();

    assert.deepEqual(ctx.gateway.writes.map((write) => write.eventName),
      ['StartWebRTCShareEvent', 'StopWebRTCShareEvent']);
    assertMappedTime(ctx.gateway.writes[0], start.mediaStartUTC, before);
  });

  it('writes one Stop with the media end when the SFU stops it', async (t) => {
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    const start = mediaTimes('mediaStart', 500);
    ctx.fake.client.deliver(mediaStarted(recording.recordingSessionId, start));
    const end = mediaTimes('mediaEnd', 100);
    ctx.fake.stopFields = { ...start, ...end };

    unpublishTrack(ctx, 'camera');
    await waitFor(() => ctx.gateway.events('StopWebRTCShareEvent').length > 0,
      { what: 'Stop event' });
    await settle();

    const stops = ctx.gateway.events('StopWebRTCShareEvent');
    assert.equal(stops.length, 1);
    assert.equal(stops[0].timestamp, end.mediaEndHR);
    assert.equal(stops[0].timestampUTC, end.mediaEndUTC);
    assert.equal(ctx.gateway.events('StartWebRTCShareEvent').length, 1);
  });

  it('writes the Stop with the media end when the recorder stops on its own', async (t) => {
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'screen_share');
    const start = mediaTimes('mediaStart', 500);
    ctx.fake.client.deliver(mediaStarted(recording.recordingSessionId, start));
    const end = mediaTimes('mediaEnd', 100);

    ctx.fake.client.deliver(recorderStopped(recording.recordingSessionId, { ...start, ...end }));
    await settle();

    const stops = ctx.gateway.events('StopWebRTCDesktopShareEvent');
    assert.equal(stops.length, 1);
    assert.equal(stops[0].timestamp, end.mediaEndHR);
  });

  it('writes the Start from recordingStopped when recordingMediaStarted was lost', async (t) => {
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'microphone');
    ctx.fake.client.deliver(flowing(recording.recordingSessionId));
    const start = mediaTimes('mediaStart', 500);
    const end = mediaTimes('mediaEnd', 100);

    ctx.fake.client.deliver(recorderStopped(recording.recordingSessionId, { ...start, ...end }));
    await settle();

    assert.deepEqual(ctx.gateway.writes.map((write) => [write.eventName, write.timestamp]), [
      ['AudioTrackPublishedEvent', start.mediaStartHR],
      ['AudioTrackUnpublishedEvent', end.mediaEndHR],
    ]);
  });

  for (const [message, flowed, events] of [
    ['recordingMediaStarted', true, ['StartWebRTCShareEvent']],
    ['recordingMediaStarted', false, ['StartWebRTCShareEvent']],
    ['recordingStopped', true, ['StartWebRTCShareEvent', 'StopWebRTCShareEvent']],
  ]) {
    const startAt = flowed ? 'flowing' : 'the SFU time';
    it(`writes the Start at ${startAt} when the media start in ${message} cannot be mapped`, async (t) => {
      const ctx = await createManager(CAPABLE);
      t.after(() => dispose(ctx.manager));
      const recording = await publishTrack(ctx, 'camera');
      const before = now();
      if (flowed) ctx.fake.client.deliver(flowing(recording.recordingSessionId));
      await settle();
      const beforeMessage = now();
      await clockTick(beforeMessage);

      // A recorder clock this far ahead: mapRecorderTimestamps rejects its times.
      const times = { ...mediaTimes('mediaStart', -10000), ...mediaTimes('mediaEnd', -10100) };
      ctx.fake.client.deliver(message === 'recordingStopped'
        ? recorderStopped(recording.recordingSessionId, times)
        : mediaStarted(recording.recordingSessionId, times));
      await settle();

      assert.deepEqual(ctx.gateway.writes.map((write) => write.eventName), events);
      if (flowed) assertSfuTime(ctx.gateway.writes[0], before, beforeMessage);
      else assertSfuTime(ctx.gateway.writes[0], beforeMessage);
    });
  }

  it('writes the Start at flowing for a lost recording that had no media start', async (t) => {
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    const before = now();
    ctx.fake.client.deliver(flowing(recording.recordingSessionId));
    await settle();
    const afterFlowing = now();
    await clockTick(afterFlowing);

    ctx.manager._handleLostRecordings(new Map([[recording.trackId, recording]]));

    assert.deepEqual(ctx.gateway.writes.map((write) => write.eventName),
      ['StartWebRTCShareEvent', 'StopWebRTCShareEvent']);
    assertSfuTime(ctx.gateway.writes[0], before, afterFlowing);
  });

  it('writes no Start and no Stop when no frame was written', async (t) => {
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    ctx.fake.client.deliver(flowing(recording.recordingSessionId));

    unpublishTrack(ctx, 'camera');
    await waitFor(() => !ctx.manager._activeRecordings.has(recording.trackId),
      { what: 'recording removal' });
    await settle();

    assert.deepEqual(ctx.gateway.writes, []);
  });

  it('writes no Start and no Stop for a capture declined on flowing', async (t) => {
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    const start = mediaTimes('mediaStart', 300);
    ctx.fake.stopFields = { ...start, ...mediaTimes('mediaEnd', 10) };
    ctx.roomRecordingStatusMap.set(recording.roomName, false);

    ctx.fake.client.deliver(flowing(recording.recordingSessionId));
    // Sent before the recorder handled the stop.
    ctx.fake.client.deliver(mediaStarted(recording.recordingSessionId, start));
    await waitFor(() => !ctx.manager._activeRecordings.has(recording.trackId),
      { what: 'recording removal' });
    await settle();

    assert.deepEqual(ctx.gateway.writes, []);
  });

  it('writes no Start and no Stop for a capture declined on media start', async (t) => {
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    const start = mediaTimes('mediaStart', 300);
    ctx.fake.stopFields = { ...start, ...mediaTimes('mediaEnd', 10) };
    ctx.roomRecordingStatusMap.set(recording.roomName, false);

    ctx.fake.client.deliver(mediaStarted(recording.recordingSessionId, start));
    await waitFor(() => !ctx.manager._activeRecordings.has(recording.trackId),
      { what: 'recording removal' });
    await settle();

    assert.equal(ctx.fake.client.published.some((message) => message.id === 'stopRecording'), true);
    assert.deepEqual(ctx.gateway.writes, []);
  });

  it('writes no Stop before the Start of a lost recording whose recorder clock is ahead', async (t) => {
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    ctx.fake.client.deliver(mediaStarted(recording.recordingSessionId, otherHost('mediaStart', 4000)));
    await settle();

    ctx.manager._handleLostRecordings(new Map([[recording.trackId, recording]]));

    assertNoStopBeforeStart(ctx);
  });

  it('writes the Stop of a lost recording at the crash time', async (t) => {
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    ctx.fake.client.deliver(mediaStarted(recording.recordingSessionId, mediaTimes('mediaStart', 300)));
    await settle();
    const before = now();
    ctx.fake.client.recorderInstanceId = null;
    const crashed = now();
    await clockTick(crashed);

    // A new instance that lists no recordings.
    ctx.fake.client.deliver({ id: 'recorderStatus', instanceId: 'recorder-2', ...CAPABLE });
    await waitFor(() => ctx.gateway.events('StopWebRTCShareEvent').length > 0, { what: 'Stop event' });

    assertSfuTime(ctx.gateway.events('StopWebRTCShareEvent')[0], before, crashed);
  });

  it('writes the Stop of a lost recording with no crash time at the SFU time', async (t) => {
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    ctx.fake.client.deliver(mediaStarted(recording.recordingSessionId, mediaTimes('mediaStart', 300)));
    await settle();
    const before = now();

    ctx.manager._handleLostRecordings(new Map([[recording.trackId, recording]]));

    assertSfuTime(ctx.gateway.events('StopWebRTCShareEvent')[0], before);
  });
});

describe('LiveKit recorder manager, resynced recordings', () => {
  const RESYNCED_TRACK = 'TR_resynced';
  const remoteRecording = (fields = {}) => listedRecording({
    recordingSessionId: 'resynced-session',
    filename: '/var/lib/bbb-webrtc-recorder/recordings/meeting-1/camera-x.webm',
    trackId: RESYNCED_TRACK,
    trackSource: 'camera',
  }, fields);

  const createResynced = async (fields, recorderOptions = CAPABLE) => {
    const ctx = await createManager({ ...recorderOptions, recordings: [remoteRecording(fields)] });
    await waitFor(() => ctx.manager._activeRecordings.has(RESYNCED_TRACK),
      { what: 'resync' });

    return ctx;
  };

  // A resynced recording's Start was written before the resync.
  it('writes only the Stop when the recorder stops a resynced recording', async (t) => {
    const start = mediaTimes('mediaStart', 5000);
    const ctx = await createResynced({ startTimeUTC: start.mediaStartUTC, ...start });
    t.after(() => dispose(ctx.manager));
    const end = mediaTimes('mediaEnd', 100);

    ctx.fake.client.deliver(mediaStarted('resynced-session', start));
    ctx.fake.client.deliver(flowing('resynced-session'));
    ctx.fake.client.deliver(recorderStopped('resynced-session', { ...start, ...end }));
    await settle();

    assert.deepEqual(ctx.gateway.writes.map((write) => [write.eventName, write.timestamp]), [
      ['StopWebRTCShareEvent', end.mediaEndHR],
    ]);
    assert.equal(ctx.manager._activeRecordings.has(RESYNCED_TRACK), false);
  });

  // The session listener writes the Stop from the recorder's reply. With no
  // listener left, stopRecording writes it.
  for (const listener of ['kept', 'removed']) {
    it(`writes only the Stop when the SFU stops a resynced recording, session listener ${listener}`, async (t) => {
      const start = mediaTimes('mediaStart', 5000);
      const ctx = await createResynced({ startTimeUTC: start.mediaStartUTC, ...start });
      t.after(() => dispose(ctx.manager));
      const stopped = 'recordingStopped:resynced-session';
      if (listener === 'removed') ctx.fake.client.removeAllListeners(stopped);
      assert.equal(ctx.fake.client.listenerCount(stopped) > 0, listener === 'kept');
      const end = mediaTimes('mediaEnd', 100);
      ctx.fake.stopFields = { ...start, ...end };

      await ctx.manager.stopRecording('resynced-session');
      await settle();

      assert.deepEqual(ctx.gateway.writes.map((write) => [write.eventName, write.timestamp]), [
        ['StopWebRTCShareEvent', end.mediaEndHR],
      ]);
    });
  }

  it('writes the Start of a resynced recording that had no media yet', async (t) => {
    const ctx = await createResynced({ startTimeUTC: Date.now() - 1000 });
    t.after(() => dispose(ctx.manager));
    const start = mediaTimes('mediaStart', 200);

    ctx.fake.client.deliver(mediaStarted('resynced-session', start));
    await settle();

    const starts = ctx.gateway.events('StartWebRTCShareEvent');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].timestamp, start.mediaStartHR);
  });

  it('keeps a resynced recording when it reports flowing, and writes its Start for an old recorder', async (t) => {
    // No startTimeUTC: the recording had not flowed before the resync.
    const ctx = await createResynced({}, {});
    t.after(() => dispose(ctx.manager));
    const before = now();

    ctx.fake.client.deliver(flowing('resynced-session'));
    await settle();

    assert.equal(ctx.fake.client.published.some((message) => message.id === 'stopRecording'), false);
    assert.equal(ctx.manager._activeRecordings.has(RESYNCED_TRACK), true);
    const starts = ctx.gateway.events('StartWebRTCShareEvent');
    assert.equal(starts.length, 1);
    assertSfuTime(starts[0], before);
  });

  it('writes no second Start on flowing for a resynced recording of an old recorder', async (t) => {
    const ctx = await createResynced({ startTimeUTC: Date.now() - 5000 }, {});
    t.after(() => dispose(ctx.manager));

    ctx.fake.client.deliver(flowing('resynced-session'));
    ctx.fake.client.deliver(recorderStopped('resynced-session'));
    await settle();

    assert.deepEqual(ctx.gateway.writes.map((write) => write.eventName), ['StopWebRTCShareEvent']);
  });

  it('keeps a resynced recording across a later heartbeat flap', async (t) => {
    const start = mediaTimes('mediaStart', 5000);
    const ctx = await createResynced({ startTimeUTC: start.mediaStartUTC, ...start });
    t.after(() => dispose(ctx.manager));

    ctx.fake.client.recorderInstanceId = null;
    ctx.fake.client.deliver({
      id: 'recorderStatus',
      instanceId: 'recorder-1',
      capabilities: CAPABLE.capabilities,
    });
    await waitFor(() => ctx.manager._activeRecordings.has(RESYNCED_TRACK),
      { what: 'second resync' });
    await settle();

    assert.equal(ctx.fake.client.published.some((message) => message.id === 'stopRecording'), false);
    assert.equal(ctx.manager._activeRecordings.get(RESYNCED_TRACK).resynced, true);
    assert.deepEqual(ctx.gateway.writes, []);
  });

  it('writes the Start at startTimeUTC when the stop gets no reply and no media start came', async (t) => {
    shortRequestTimeout(t);
    const flowingUTC = Date.now() - 1000;
    const ctx = await createResynced({ startTimeUTC: flowingUTC });
    t.after(() => dispose(ctx.manager));
    ctx.fake.silentStop = true;
    const before = now();

    await ctx.manager.stopRecording('resynced-session');
    await settle();

    assert.deepEqual(ctx.gateway.writes.map((write) => write.eventName),
      ['StartWebRTCShareEvent', 'StopWebRTCShareEvent']);
    assertMappedTime(ctx.gateway.writes[0], flowingUTC, before);
    assertSfuTime(ctx.gateway.writes[1], before);
  });
});

describe('LiveKit recorder manager, stop request pending', () => {
  it('writes the Start from a media start that arrives during the stop', async (t) => {
    shortRequestTimeout(t);
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    ctx.fake.client.deliver(flowing(recording.recordingSessionId));
    ctx.fake.silentStop = true;

    unpublishTrack(ctx, 'camera');
    await waitFor(() => ctx.fake.client.published.some((message) => message.id === 'stopRecording'),
      { what: 'stopRecording' });
    const start = mediaTimes('mediaStart', 300);
    ctx.fake.client.deliver(mediaStarted(recording.recordingSessionId, start));
    const before = now();
    await waitFor(() => ctx.gateway.events('StopWebRTCShareEvent').length > 0,
      { what: 'Stop event' });

    assert.deepEqual(ctx.gateway.writes.map((write) => write.eventName),
      ['StartWebRTCShareEvent', 'StopWebRTCShareEvent']);
    assert.equal(ctx.gateway.writes[0].timestamp, start.mediaStartHR);
    assertSfuTime(ctx.gateway.writes[1], before);
  });

  it('writes the Start at the first flowing when the stop gets no reply and no media start came', async (t) => {
    shortRequestTimeout(t);
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    const before = now();
    ctx.fake.client.deliver(flowing(recording.recordingSessionId));
    await settle();
    const afterFlowing = now();
    await clockTick(afterFlowing);
    ctx.fake.client.deliver({ ...flowing(recording.recordingSessionId), status: 'not_flowing' });
    ctx.fake.client.deliver(flowing(recording.recordingSessionId));
    ctx.fake.silentStop = true;

    unpublishTrack(ctx, 'camera');
    await waitFor(() => !ctx.manager._activeRecordings.has(recording.trackId),
      { what: 'recording removal' });
    await settle();

    assert.deepEqual(ctx.gateway.writes.map((write) => write.eventName),
      ['StartWebRTCShareEvent', 'StopWebRTCShareEvent']);
    assertSfuTime(ctx.gateway.writes[0], before, afterFlowing);
    assertSfuTime(ctx.gateway.writes[1], afterFlowing);
  });

  it('writes nothing when the stop of a capture declined on media start gets no reply', async (t) => {
    shortRequestTimeout(t);
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    ctx.fake.client.deliver(flowing(recording.recordingSessionId));
    await settle();
    ctx.roomRecordingStatusMap.set(recording.roomName, false);
    ctx.fake.silentStop = true;

    ctx.fake.client.deliver(mediaStarted(recording.recordingSessionId, mediaTimes('mediaStart', 300)));
    await waitFor(() => !ctx.manager._activeRecordings.has(recording.trackId),
      { what: 'recording removal' });
    await settle();

    assert.deepEqual(ctx.gateway.writes, []);
  });

  it('writes nothing when the stop gets no reply and only the previous file flowed', async (t) => {
    shortRequestTimeout(t);
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    ctx.fake.client.deliver(flowing(recording.recordingSessionId));
    await settle();
    // The first file wrote no frame, so its stop reply has no media times.
    ctx.manager.handleRecordingStatusChanged(MEETING_ID, false);
    await waitFor(() => !ctx.manager._activeRecordings.has(recording.trackId),
      { what: 'first file stop' });
    ctx.manager.handleRecordingStatusChanged(MEETING_ID, true);
    await waitFor(() => ctx.manager._activeRecordings.has(recording.trackId),
      { what: 'second file start' });
    await settle();
    ctx.fake.silentStop = true;

    unpublishTrack(ctx, 'camera');
    await waitFor(() => !ctx.manager._activeRecordings.has(recording.trackId),
      { what: 'recording removal' });
    await settle();

    assert.deepEqual(ctx.gateway.writes, []);
  });
});

// Recording off with a stop that times out, then on again. lateMessages
// are the first file's messages that the recorder sends while the second
// startRecording is on its way, before that start's reply.
const startSecondFile = async (t, lateMessages, recorderOptions = {}) => {
  shortRequestTimeout(t);
  const ctx = await createManager(recorderOptions);
  t.after(() => dispose(ctx.manager));
  const first = { ...(await publishTrack(ctx, 'camera')) };
  ctx.fake.client.deliver(flowing(first.recordingSessionId));
  ctx.fake.silentStop = true;
  ctx.manager.handleRecordingStatusChanged(MEETING_ID, false);
  await waitFor(() => ctx.manager._activeRecordings.size === 0, { what: 'stop timeout' });
  ctx.fake.silentStop = false;

  const reply = ctx.fake.client.onPublish;
  let started = false;
  ctx.fake.client.onPublish = (message) => {
    if (message.id === 'startRecording' && !started) {
      started = true;
      lateMessages(first.recordingSessionId).forEach((late) => ctx.fake.client.deliver(late));
    }
    reply(message);
  };
  ctx.manager.handleRecordingStatusChanged(MEETING_ID, true);
  await waitFor(() => started, { what: 'second startRecording' });
  await settle();

  const second = ctx.manager._activeRecordings.get(first.trackId);
  assert.ok(second, 'the SFU tracks the second file');
  assert.notEqual(second.filename, first.filename);
  assert.ok(ctx.fake.sessions.has(second.recordingSessionId), 'the recorder records the second file');
  assert.equal(ctx.fake.client.listenerCount(`recordingStopped:${second.recordingSessionId}`), 1);
  assert.deepEqual(writesFor(ctx, first.filename).map((write) => write.eventName),
    ['StartWebRTCShareEvent', 'StopWebRTCShareEvent']);

  return { ctx, first, second };
};

describe('LiveKit recorder manager, files of one track', () => {
  it('keeps the second file when the first file\'s recordingStopped comes late', async (t) => {
    const { ctx, second } = await startSecondFile(t, (id) => [recorderStopped(id)]);

    assert.deepEqual(writesFor(ctx, second.filename), []);
  });

  it('ignores a late recordingMediaStarted from the previous file', async (t) => {
    const { ctx, second } = await startSecondFile(t, (id) => [
      mediaStarted(id, mediaTimes('mediaStart', 300)),
    ], CAPABLE);
    assert.deepEqual(writesFor(ctx, second.filename), []);

    const secondStart = mediaTimes('mediaStart', 0);
    ctx.fake.client.deliver(mediaStarted(second.recordingSessionId, secondStart));
    await settle();
    assert.deepEqual(writesFor(ctx, second.filename).map((write) => write.timestamp),
      [secondStart.mediaStartHR]);
  });

  it('starts one file when two starts of a track race', async (t) => {
    const ctx = await createManager();
    t.after(() => dispose(ctx.manager));
    const { trackId } = await publishTrack(ctx, 'camera');
    ctx.manager.handleRecordingStatusChanged(MEETING_ID, false);
    await waitFor(() => ctx.manager._activeRecordings.size === 0, { what: 'stop' });

    ctx.manager.handleRecordingStatusChanged(MEETING_ID, true);
    ctx.manager.handleRecordingStatusChanged(MEETING_ID, true);
    await waitFor(() => ctx.manager._activeRecordings.has(trackId), { what: 'start' });
    await settle();

    const { recordingSessionId } = ctx.manager._activeRecordings.get(trackId);
    assert.deepEqual([...ctx.fake.sessions], [recordingSessionId]);
    assert.equal(ctx.fake.client.listenerCount(`recordingStopped:${recordingSessionId}`), 1);
  });

  // The recorder can list an earlier file of the track that is still closing.
  for (const order of ['earlier', 'newer']) {
    it(`keeps the newest file of a track after an SFU restart, ${order} file listed first`, async (t) => {
      const file = (recordingSessionId, start) => listedRecording({
        recordingSessionId,
        filename: `/var/lib/bbb-webrtc-recorder/recordings/${MEETING_ID}/camera-${USER_ID}-TR_camera-${start}.webm`,
        trackId: 'TR_camera',
        trackSource: 'camera',
      });
      const files = [file('earlier', 1000), file('newer', 2000)];
      if (order === 'newer') files.reverse();
      const ctx = await createManager({ recordings: files });
      t.after(() => dispose(ctx.manager));
      await waitFor(() => ctx.manager._activeRecordings.has('TR_camera'), { what: 'resync' });
      await settle();

      assert.equal(ctx.manager._activeRecordings.get('TR_camera').recordingSessionId, 'newer');
      assert.deepEqual(ctx.fake.client.published.filter((message) => message.id === 'stopRecording')
        .map((message) => message.recordingSessionId), ['earlier']);
    });
  }
});

describe('LiveKit recorder manager, heartbeat flap', () => {
  // others: recordings the recorder lists after this one.
  const flapAndResync = async (ctx, recording, fields, others = []) => {
    // Read before the flap, which clears them.
    const { capabilities } = ctx.fake.client;
    // A ping timeout moves every recording to the orphaned map.
    ctx.fake.client.recorderInstanceId = null;
    assert.equal(ctx.manager._orphanedRecordings.size, 1);
    ctx.fake.recordings = [
      listedRecording(recording, { startTimeUTC: Date.now() - 500, ...fields }),
      ...others,
    ];

    return () => {
      ctx.fake.client.deliver({
        id: 'recorderStatus',
        instanceId: 'recorder-1',
        capabilities,
      });
      return waitFor(() => ctx.manager._activeRecordings.has(recording.trackId),
        { what: 'resync' }).then(() => settle());
    };
  };

  it('writes the Start a flap dropped from the recorder media start', async (t) => {
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    const start = mediaTimes('mediaStart', 300);
    const resync = await flapAndResync(ctx, recording, start);

    ctx.fake.client.deliver(mediaStarted(recording.recordingSessionId, start));
    await settle();
    await resync();
    // Check before the stop. The stop also carries the media start, so it
    // would write a missing Start and hide a resync that wrote none.
    assert.deepEqual(ctx.gateway.writes.map((write) => [write.eventName, write.timestamp]),
      [['StartWebRTCShareEvent', start.mediaStartHR]]);
    const end = mediaTimes('mediaEnd', 10);
    ctx.fake.client.deliver(recorderStopped(recording.recordingSessionId, { ...start, ...end }));
    await settle();

    assert.deepEqual(ctx.gateway.writes.map((write) => [write.eventName, write.timestamp]), [
      ['StartWebRTCShareEvent', start.mediaStartHR],
      ['StopWebRTCShareEvent', end.mediaEndHR],
    ]);
  });

  it('keeps the Start written before a flap', async (t) => {
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'microphone');
    const start = mediaTimes('mediaStart', 300);
    ctx.fake.client.deliver(mediaStarted(recording.recordingSessionId, start));
    await settle();
    const resync = await flapAndResync(ctx, recording, start);

    await resync();
    ctx.fake.client.deliver(mediaStarted(recording.recordingSessionId, start));
    ctx.fake.client.deliver(recorderStopped(recording.recordingSessionId, {
      ...start,
      ...mediaTimes('mediaEnd', 10),
    }));
    await settle();

    assert.deepEqual(ctx.gateway.writes.map((write) => write.eventName),
      ['AudioTrackPublishedEvent', 'AudioTrackUnpublishedEvent']);
  });

  it('writes the Start and Stop of a file whose track went away during a flap', async (t) => {
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    const start = mediaTimes('mediaStart', 300);
    const end = mediaTimes('mediaEnd', 10);
    await flapAndResync(ctx, recording, start);

    ctx.fake.client.deliver(mediaStarted(recording.recordingSessionId, start));
    unpublishTrack(ctx, 'camera');
    ctx.fake.stopFields = { ...start, ...end };
    ctx.fake.client.deliver({
      id: 'recorderStatus',
      instanceId: 'recorder-1',
      capabilities: CAPABLE.capabilities,
    });
    await waitFor(() => ctx.gateway.events('StopWebRTCShareEvent').length > 0,
      { what: 'Stop event' });
    await settle();

    assert.equal(ctx.fake.client.published.filter((message) => message.id === 'stopRecording').length, 1);
    assert.deepEqual(ctx.gateway.writes.map((write) => [write.eventName, write.timestamp]), [
      ['StartWebRTCShareEvent', start.mediaStartHR],
      ['StopWebRTCShareEvent', end.mediaEndHR],
    ]);
  });

  const recordingOffDuringFlap = async (t, { startBeforeFlap }) => {
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    const start = mediaTimes('mediaStart', 300);
    const end = mediaTimes('mediaEnd', 10);
    if (startBeforeFlap) ctx.fake.client.deliver(mediaStarted(recording.recordingSessionId, start));
    await settle();
    await flapAndResync(ctx, recording, start);

    if (!startBeforeFlap) ctx.fake.client.deliver(mediaStarted(recording.recordingSessionId, start));
    ctx.manager.handleRecordingStatusChanged(MEETING_ID, false);
    ctx.fake.stopFields = { ...start, ...end };
    ctx.fake.client.deliver({
      id: 'recorderStatus',
      instanceId: 'recorder-1',
      capabilities: CAPABLE.capabilities,
    });
    await waitFor(() => ctx.gateway.events('StopWebRTCShareEvent').length > 0,
      { what: 'Stop event' });
    await settle();

    assert.equal(ctx.fake.client.published.filter((message) => message.id === 'stopRecording').length, 1);
    assert.deepEqual(ctx.gateway.writes.map((write) => [write.eventName, write.timestamp]), [
      ['StartWebRTCShareEvent', start.mediaStartHR],
      ['StopWebRTCShareEvent', end.mediaEndHR],
    ]);
  };

  it('writes the Stop of a file whose recording was turned off during a flap', async (t) => {
    await recordingOffDuringFlap(t, { startBeforeFlap: true });
  });

  it('writes the Start and Stop when recording is off and the media start was dropped', async (t) => {
    await recordingOffDuringFlap(t, { startBeforeFlap: false });
  });

  it('writes the Start at flowing when the stop gets no reply after a flap', async (t) => {
    shortRequestTimeout(t);
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    const before = now();
    ctx.fake.client.deliver(flowing(recording.recordingSessionId));
    await settle();
    const afterFlowing = now();
    const resync = await flapAndResync(ctx, recording);
    await resync();
    ctx.fake.silentStop = true;

    unpublishTrack(ctx, 'camera');
    await waitFor(() => !ctx.manager._activeRecordings.has(recording.trackId),
      { what: 'recording removal' });
    await settle();

    assert.deepEqual(ctx.gateway.writes.map((write) => write.eventName),
      ['StartWebRTCShareEvent', 'StopWebRTCShareEvent']);
    assertSfuTime(ctx.gateway.writes[0], before, afterFlowing);
  });

  it('writes no Stop before the Start after a flap when the recorder clock is ahead', async (t) => {
    shortRequestTimeout(t);
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    const start = otherHost('mediaStart', 4000);
    ctx.fake.client.deliver(mediaStarted(recording.recordingSessionId, start));
    await settle();
    const resync = await flapAndResync(ctx, recording, start);
    await resync();
    ctx.fake.silentStop = true;

    await ctx.manager.stopRecording(recording.recordingSessionId);

    assertNoStopBeforeStart(ctx);
  });

  it('keeps the first resync\'s state when a second flap resyncs the file again', async (t) => {
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = { ...(await publishTrack(ctx, 'camera')) };
    await flapAndResync(ctx, recording);
    // akka-apps holds its answers to the status probes.
    const held = [];
    ctx.gateway.publish = (message) => held.push(message);
    ctx.fake.client.deliver({ id: 'recorderStatus', instanceId: 'recorder-1', ...CAPABLE });
    await waitFor(() => held.length === 1, { what: 'status probe' });

    // The media start comes while the file has no entry, so the SFU drops
    // it, and the next getRecordings reports it.
    const start = mediaTimes('mediaStart', 300);
    ctx.fake.client.deliver(mediaStarted(recording.recordingSessionId, start));
    ctx.fake.recordings = [listedRecording(recording, { startTimeUTC: Date.now() - 500, ...start })];
    ctx.fake.client.recorderInstanceId = null;
    ctx.fake.client.deliver({ id: 'recorderStatus', instanceId: 'recorder-1', ...CAPABLE });
    await waitFor(() => held.length === 2, { what: 'second status probe' });
    delete ctx.gateway.publish;
    held.forEach((message) => ctx.gateway.publish(message));
    await waitFor(() => ctx.manager._activeRecordings.has(recording.trackId), { what: 'resync' });
    await settle();
    ctx.fake.client.deliver(recorderStopped(recording.recordingSessionId, {
      ...start,
      ...mediaTimes('mediaEnd', 10),
    }));
    await settle();

    assert.deepEqual(ctx.gateway.writes.map((write) => write.eventName),
      ['StartWebRTCShareEvent', 'StopWebRTCShareEvent']);
  });

  // The first flowing comes while the entry is orphaned, so the SFU drops it.
  // Only the recorder's startTimeUTC keeps its time.
  const flowingDuringFlap = async (ctx) => {
    const recording = await publishTrack(ctx, 'camera');
    const flowingUTC = Date.now() - 200;
    const resync = await flapAndResync(ctx, recording, { startTimeUTC: flowingUTC });
    ctx.fake.client.deliver(flowing(recording.recordingSessionId));
    await settle();
    await resync();

    return { recording, flowingUTC };
  };

  it('writes the Start at startTimeUTC when a flap dropped the first flowing and the stop gets no reply', async (t) => {
    shortRequestTimeout(t);
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const { recording, flowingUTC } = await flowingDuringFlap(ctx);
    ctx.fake.silentStop = true;
    const before = now();

    unpublishTrack(ctx, 'camera');
    await waitFor(() => !ctx.manager._activeRecordings.has(recording.trackId),
      { what: 'recording removal' });
    await settle();

    assert.deepEqual(ctx.gateway.writes.map((write) => write.eventName),
      ['StartWebRTCShareEvent', 'StopWebRTCShareEvent']);
    assertMappedTime(ctx.gateway.writes[0], flowingUTC, before);
  });

  it('writes the Start at startTimeUTC when a flap dropped the first flowing of a recorder without mediaTimestamps', async (t) => {
    const ctx = await createManager();
    t.after(() => dispose(ctx.manager));
    const { flowingUTC } = await flowingDuringFlap(ctx);
    const before = now();

    unpublishTrack(ctx, 'camera');
    await waitFor(() => ctx.gateway.events('StopWebRTCShareEvent').length > 0,
      { what: 'Stop event' });

    assert.deepEqual(ctx.gateway.writes.map((write) => write.eventName),
      ['StartWebRTCShareEvent', 'StopWebRTCShareEvent']);
    assertMappedTime(ctx.gateway.writes[0], flowingUTC, before);
  });

  it('keeps the new file and stops the earlier one when a flap finds both', async (t) => {
    // The recorder is still closing the first file.
    const { ctx, first, second } = await startSecondFile(t, () => []);

    const resync = await flapAndResync(ctx, second, {}, [listedRecording(first)]);
    await resync();

    assert.equal(ctx.manager._activeRecordings.get(first.trackId)?.recordingSessionId,
      second.recordingSessionId);
    assert.equal(ctx.fake.client.published.filter((message) => message.id === 'stopRecording'
      && message.recordingSessionId === first.recordingSessionId).length, 2);
    assert.deepEqual(writesFor(ctx, first.filename).map((write) => write.eventName),
      ['StartWebRTCShareEvent', 'StopWebRTCShareEvent']);
  });

  it('writes the Stop of a file the recorder lost while it closes an earlier one', async (t) => {
    const { ctx, first, second } = await startSecondFile(t, () => []);
    ctx.fake.client.deliver(flowing(second.recordingSessionId));
    await settle();
    // The recorder ended the second file, and its recordingStopped was lost.
    ctx.fake.sessions.delete(second.recordingSessionId);

    await flapAndResync(ctx, second, {}, [listedRecording(first)]);
    ctx.fake.client.deliver({ id: 'recorderStatus', instanceId: 'recorder-1' });
    await waitFor(() => writesFor(ctx, second.filename).length === 2, { what: 'Stop event' });

    assert.deepEqual(writesFor(ctx, second.filename).map((write) => write.eventName),
      ['StartWebRTCShareEvent', 'StopWebRTCShareEvent']);
    assert.equal(ctx.manager._recordingRetryTimeouts.has(second.trackId), true);
  });

  it('stops, and does not adopt, a file the SFU ended that a flap finds still closing', async (t) => {
    shortRequestTimeout(t);
    const ctx = await createManager();
    t.after(() => dispose(ctx.manager));
    const recording = { ...(await publishTrack(ctx, 'camera')) };
    ctx.fake.client.deliver(flowing(recording.recordingSessionId));
    ctx.fake.silentStop = true;
    unpublishTrack(ctx, 'camera');
    await waitFor(() => ctx.gateway.events('StopWebRTCShareEvent').length > 0, { what: 'Stop event' });
    ctx.fake.silentStop = false;

    // A ping timeout, then the recorder answers and still lists the file.
    ctx.fake.client.recorderInstanceId = null;
    ctx.fake.recordings = [listedRecording(recording)];
    ctx.fake.client.deliver({ id: 'recorderStatus', instanceId: 'recorder-1' });
    await waitFor(() => !ctx.fake.sessions.has(recording.recordingSessionId), { what: 'stop at the sync' });
    await settle();

    assert.equal(ctx.manager._activeRecordings.has(recording.trackId), false);
    assert.deepEqual(ctx.gateway.writes.map((write) => write.eventName),
      ['StartWebRTCShareEvent', 'StopWebRTCShareEvent']);
  });

  it('keeps a file whose resync waits for the recording status when a second flap comes', async (t) => {
    const ctx = await createManager();
    t.after(() => dispose(ctx.manager));
    const recording = { ...(await publishTrack(ctx, 'camera')) };
    ctx.fake.client.deliver(flowing(recording.recordingSessionId));
    await flapAndResync(ctx, recording);
    // akka-apps holds its answers to the status probes.
    const held = [];
    ctx.gateway.publish = (message) => held.push(message);
    ctx.fake.client.deliver({ id: 'recorderStatus', instanceId: 'recorder-1' });
    await waitFor(() => held.length === 1, { what: 'status probe' });

    ctx.fake.client.recorderInstanceId = null;
    ctx.fake.client.deliver({ id: 'recorderStatus', instanceId: 'recorder-1' });
    await settle();
    delete ctx.gateway.publish;
    held.forEach((message) => ctx.gateway.publish(message));
    await waitFor(() => ctx.manager._activeRecordings.has(recording.trackId), { what: 'resync' });
    await settle();

    assert.equal(ctx.fake.client.published.some((message) => message.id === 'stopRecording'), false);
    assert.equal(ctx.manager._activeRecordings.get(recording.trackId).recordingSessionId,
      recording.recordingSessionId);
  });

  it('records a track once the recorder is back after its start and a retry time out', async (t) => {
    const ctx = await createManager();
    t.after(() => dispose(ctx.manager));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => t.mock.timers.reset());
    // A ping timeout: the recorder is down when the track is published.
    ctx.fake.client.recorderInstanceId = null;
    ctx.manager._handleTrackPublished(trackEvent('camera'));
    // The start times out, a retry runs and times out, a second retry runs.
    for (const ms of [5000, 3000, 5000, 3000]) {
      await settle(20);
      t.mock.timers.tick(ms);
    }
    await settle(20);

    ctx.fake.client.deliver({ id: 'recorderStatus', instanceId: 'recorder-1' });
    await settle(20);
    t.mock.timers.tick(3000);
    await settle(20);

    assert.equal(ctx.fake.sessions.size, 1);
    assert.equal(ctx.fake.sessions.has(ctx.manager._activeRecordings.get('TR_camera')?.recordingSessionId), true);
  });

  // The recorder lists a start while its Init runs, so a flap resyncs it.
  // Init then fails, and the recorder sends no recordingStopped.
  for (const attempt of ['start', 'retry']) {
    it(`records a track once a ${attempt} that a flap resynced fails`, async (t) => {
      const ctx = await createManager();
      t.after(() => dispose(ctx.manager));
      t.mock.timers.enable({ apis: ['setTimeout'] });
      t.after(() => t.mock.timers.reset());
      const fail = ({ recordingSessionId }) => ctx.fake.client.deliver({
        id: 'startRecordingResponse', recordingSessionId, status: 'failed', error: 'Init failed',
      });
      const reply = ctx.fake.client.onPublish;
      let failFirst = attempt === 'retry';
      let held = null;
      ctx.fake.client.onPublish = (message) => {
        if (message.id !== 'startRecording' || held) return reply(message);
        if (failFirst) {
          failFirst = false;
          return fail(message);
        }
        held = message;
        ctx.fake.sessions.add(held.recordingSessionId);
        ctx.fake.recordings = [listedRecording({
          recordingSessionId: held.recordingSessionId,
          filename: held.fileName,
          trackId: 'TR_camera',
          trackSource: 'camera',
        })];
        return undefined;
      };
      ctx.manager._handleTrackPublished(trackEvent('camera'));
      await settle(20);
      if (attempt === 'retry') {
        t.mock.timers.tick(3000);
        await settle(20);
      }
      assert.ok(held, 'a start waits for its Init');

      ctx.fake.client.recorderInstanceId = null;
      ctx.fake.client.deliver({ id: 'recorderStatus', instanceId: 'recorder-1' });
      await settle(20);
      ctx.fake.sessions.delete(held.recordingSessionId);
      fail(held);
      await settle(20);
      t.mock.timers.tick(3000);
      await settle(20);

      assert.equal(ctx.fake.sessions.size, 1);
    });
  }

  it('starts no second file of a track when recording is turned on during a flap', async (t) => {
    const ctx = await createManager();
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    const { recordingSessionId } = recording;
    ctx.fake.client.deliver(flowing(recordingSessionId));
    const resync = await flapAndResync(ctx, recording);

    ctx.manager.handleRecordingStatusChanged(MEETING_ID, true);
    await settle();
    await resync();
    unpublishTrack(ctx, 'camera');
    await waitFor(() => ctx.gateway.events('StopWebRTCShareEvent').length > 0, { what: 'Stop event' });

    assert.equal(ctx.fake.client.published.filter((message) => message.id === 'startRecording').length, 1);
    assert.deepEqual(ctx.gateway.writes.map((write) => [write.eventName, write.filename]), [
      ['StartWebRTCShareEvent', recording.filename],
      ['StopWebRTCShareEvent', recording.filename],
    ]);
    assert.deepEqual([...ctx.fake.sessions], []);
  });

  it('keeps one set of session handlers once a file lost in a recorder restart is retried', async (t) => {
    const ctx = await createManager();
    t.after(() => dispose(ctx.manager));
    await publishTrack(ctx, 'camera');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => t.mock.timers.reset());

    ctx.fake.client.deliver({ id: 'recorderStatus', instanceId: 'recorder-2' });
    await settle(20);
    t.mock.timers.tick(3000);
    await settle(20);

    const handlers = (event) => ctx.fake.client.eventNames()
      .filter((name) => String(name).startsWith(`${event}:`))
      .reduce((sum, name) => sum + ctx.fake.client.listenerCount(name), 0);
    assert.equal(ctx.fake.client.published.filter((message) => message.id === 'startRecording').length, 2);
    assert.equal(handlers('recordingStopped'), 1);
    assert.equal(handlers('recordingRtpStatusChanged'), 1);
  });

  // The start waits for the recorder. The resync's getRecordings does not
  // list the file yet, so the sync finds it lost while its start is on its way.
  it('writes the Start of a file whose start waited out a heartbeat flap', async (t) => {
    const ctx = await createManager();
    t.after(() => dispose(ctx.manager));
    ctx.fake.client.recorderInstanceId = null;
    ctx.manager._handleTrackPublished(trackEvent('microphone'));
    await settle();

    ctx.fake.client.deliver({ id: 'recorderStatus', instanceId: 'recorder-1' });
    await waitFor(() => ctx.fake.client.published.some((message) => message.id === 'startRecording'),
      { what: 'startRecording' });
    await settle();
    const recording = ctx.manager._activeRecordings.get('TR_microphone');
    ctx.fake.client.deliver(flowing(recording.recordingSessionId));
    await settle();

    assert.equal(ctx.gateway.events('AudioTrackPublishedEvent').length, 1);
  });
});
