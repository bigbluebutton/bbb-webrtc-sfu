'use strict';

const {
  createManager,
  publishTrack,
  unpublishTrack,
  waitFor,
  settle,
  shortRequestTimeout,
  dispose,
  MEETING_ID,
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
});

const CAPABLE = { capabilities: ['mediaTimestamps'] };

// Recorder media times on this host's clocks, agoMs in the past.
const mediaTimes = (prefix, agoMs) => {
  const t = now();

  return {
    [`${prefix}UTC`]: t.utc - agoMs,
    [`${prefix}HR`]: t.hr - agoMs,
  };
};

const mediaStarted = (recordingSessionId, times) => ({
  id: 'recordingMediaStarted',
  recordingSessionId,
  ...times,
});

const recorderStopped = (recordingSessionId, fields = {}) => ({
  id: 'recordingStopped',
  recordingSessionId,
  reason: 'stopped',
  timestampUTC: new Date().toISOString(),
  timestampHR: 1500,
  ...fields,
});

// For a recorder time whose HR is not used: the event HR is the UTC mapped
// into hrTime().
const assertMappedTime = (event, utc, at) => {
  const expected = at.hr - (at.utc - utc);
  assert.ok(Math.abs(event.timestamp - expected) <= 20,
    `timestamp ${event.timestamp} is not ${expected}`);
  assert.equal(event.timestampUTC, utc);
};

describe('LiveKit recorder manager, recorder with mediaTimestamps', () => {
  for (const [source, startEvent, stopEvent] of [
    ['camera', 'StartWebRTCShareEvent', 'StopWebRTCShareEvent'],
    ['microphone', 'AudioTrackPublishedEvent', 'AudioTrackUnpublishedEvent'],
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
    // Another host: its HR is unrelated to the SFU's.
    const skewed = (prefix, agoMs) => ({
      [`${prefix}UTC`]: Date.now() - 5000 - agoMs,
      [`${prefix}HR`]: 42,
    });
    const start = skewed('mediaStart', 0);
    const before = now();

    ctx.fake.client.deliver(mediaStarted(recording.recordingSessionId, start));
    ctx.fake.client.deliver(recorderStopped(recording.recordingSessionId, {
      ...start,
      ...skewed('mediaEnd', -100),
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
    ctx.fake.stopFields = { ...mediaTimes('mediaStart', 300), ...mediaTimes('mediaEnd', 10) };
    ctx.roomRecordingStatusMap.set(recording.roomName, false);

    ctx.fake.client.deliver(flowing(recording.recordingSessionId));
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

  it('writes numeric Stop times for a lost recording with no crash time', async (t) => {
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const recording = await publishTrack(ctx, 'camera');
    ctx.fake.client.deliver(mediaStarted(recording.recordingSessionId, mediaTimes('mediaStart', 300)));
    await settle();

    ctx.manager._handleLostRecordings(new Map([[recording.trackId, recording]]));

    const [stop] = ctx.gateway.events('StopWebRTCShareEvent');
    assert.equal(typeof stop.timestamp, 'number');
    assert.equal(typeof stop.timestampUTC, 'number');
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

describe('LiveKit recorder manager, reused recording session id', () => {
  // Recording off with a stop that times out, then on again. The second
  // file reuses the session id; the first file's late messages come before
  // the second start's reply.
  const startSecondFile = async (t, lateMessages) => {
    shortRequestTimeout(t);
    const ctx = await createManager(CAPABLE);
    t.after(() => dispose(ctx.manager));
    const first = await publishTrack(ctx, 'camera');
    const sessionId = first.recordingSessionId;
    const firstFile = first.filename;
    // The first file started 4 s ago and its media 1 s later. Its media
    // start is valid for it, and stale for a second file started now.
    first.startRequestedHR -= 4000;
    const firstStart = mediaTimes('mediaStart', 3000);
    ctx.fake.client.deliver(mediaStarted(sessionId, firstStart));
    ctx.fake.silentStop = true;
    const beforeStop = now();
    ctx.manager.handleRecordingStatusChanged(MEETING_ID, false);
    await waitFor(() => ctx.manager._activeRecordings.size === 0, { what: 'stop timeout' });
    ctx.fake.silentStop = false;

    const reply = ctx.fake.client.onPublish;
    let second;
    ctx.fake.client.onPublish = (message) => {
      if (message.id === 'startRecording') {
        second = ctx.manager._activeRecordings.get(first.trackId);
        lateMessages(sessionId, firstStart).forEach((late) => ctx.fake.client.deliver(late));
      }
      reply(message);
    };
    ctx.manager.handleRecordingStatusChanged(MEETING_ID, true);
    await waitFor(() => second, { what: 'second startRecording' });
    await settle();
    assert.equal(second.recordingSessionId, sessionId);
    assert.notEqual(second.filename, firstFile);
    const firstWrites = writesFor(ctx, firstFile);
    assert.deepEqual(firstWrites.map((write) => write.eventName),
      ['StartWebRTCShareEvent', 'StopWebRTCShareEvent']);
    assert.equal(firstWrites[0].timestamp, firstStart.mediaStartHR);
    // No reply brings a media end: the Stop has the SFU time.
    assertSfuTime(firstWrites[1], beforeStop);

    return { ctx, sessionId, secondFile: second.filename };
  };

  const writesFor = (ctx, filename) => ctx.gateway.writes
    .filter((write) => write.filename === filename);

  it('ignores the media times of a late recordingStopped from the previous file', async (t) => {
    const { ctx, secondFile } = await startSecondFile(t, (id, firstStart) => [
      recorderStopped(id, { ...firstStart, ...mediaTimes('mediaEnd', 100) }),
    ]);

    assert.deepEqual(writesFor(ctx, secondFile), []);
  });

  it('ignores a late recordingMediaStarted from the previous file', async (t) => {
    const { ctx, sessionId, secondFile } = await startSecondFile(t, (id, firstStart) => [
      mediaStarted(id, firstStart),
    ]);
    assert.deepEqual(writesFor(ctx, secondFile), []);

    const secondStart = mediaTimes('mediaStart', 0);
    ctx.fake.client.deliver(mediaStarted(sessionId, secondStart));
    await settle();
    assert.deepEqual(writesFor(ctx, secondFile).map((write) => write.timestamp),
      [secondStart.mediaStartHR]);
  });
});
