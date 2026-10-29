'use strict';

const {
  BBBWebRTCRecorder,
  createManager,
  publishTrack,
  unpublishTrack,
  waitFor,
  settle,
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

const assertSfuTime = (event, before) => {
  assert.ok(event.timestamp >= before.hr && event.timestamp <= hrTime(),
    `timestamp ${event.timestamp} is not SFU time`);
  assert.ok(event.timestampUTC >= before.utc && event.timestampUTC <= Date.now(),
    `timestampUTC ${event.timestampUTC} is not SFU time`);
};

const now = () => ({ hr: hrTime(), utc: Date.now() });

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
    const expected = before.hr - (before.utc - start.mediaStartUTC);
    assert.ok(Math.abs(event.timestamp - expected) <= 20,
      `timestamp ${event.timestamp} is not ${expected}`);
    assert.equal(event.timestampUTC, start.mediaStartUTC);
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
    const expected = before.hr - (before.utc - start.mediaStartUTC);
    assert.ok(Math.abs(ctx.gateway.writes[0].timestamp - expected) <= 20,
      `timestamp ${ctx.gateway.writes[0].timestamp} is not ${expected}`);
    assert.equal(ctx.gateway.writes[0].timestampUTC, start.mediaStartUTC);
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
});

describe('LiveKit recorder manager, stop request pending', () => {
  it('writes the Start from a media start that arrives during the stop', async (t) => {
    const timeout = BBBWebRTCRecorder.REQUEST_TIMEOUT;
    BBBWebRTCRecorder.REQUEST_TIMEOUT = 50;
    const ctx = await createManager(CAPABLE);
    t.after(() => {
      BBBWebRTCRecorder.REQUEST_TIMEOUT = timeout;
      dispose(ctx.manager);
    });
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
});

describe('LiveKit recorder manager, reused recording session id', () => {
  // Recording off with a stop that times out, then on again. The second
  // file reuses the session id; the recorder may still report the first.
  const startSecondFile = async (t) => {
    const timeout = BBBWebRTCRecorder.REQUEST_TIMEOUT;
    BBBWebRTCRecorder.REQUEST_TIMEOUT = 50;
    const ctx = await createManager(CAPABLE);
    t.after(() => {
      BBBWebRTCRecorder.REQUEST_TIMEOUT = timeout;
      dispose(ctx.manager);
    });
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

    ctx.manager.handleRecordingStatusChanged(MEETING_ID, true);
    await waitFor(() => ctx.fake.client.published
      .filter((message) => message.id === 'startRecording').length === 2,
    { what: 'second startRecording' });
    await settle();
    const second = ctx.manager._activeRecordings.get(first.trackId);
    assert.equal(second.recordingSessionId, sessionId);
    assert.notEqual(second.filename, firstFile);
    const firstWrites = writesFor(ctx, firstFile);
    assert.deepEqual(firstWrites.map((write) => write.eventName),
      ['StartWebRTCShareEvent', 'StopWebRTCShareEvent']);
    assert.equal(firstWrites[0].timestamp, firstStart.mediaStartHR);
    // No reply brings a media end: the Stop has the SFU time.
    assertSfuTime(firstWrites[1], beforeStop);

    return { ctx, sessionId, firstStart, secondFile: second.filename };
  };

  const writesFor = (ctx, filename) => ctx.gateway.writes
    .filter((write) => write.filename === filename);

  it('ignores the media times of a late recordingStopped from the previous file', async (t) => {
    const { ctx, sessionId, firstStart, secondFile } = await startSecondFile(t);

    ctx.fake.client.deliver(recorderStopped(sessionId, {
      ...firstStart,
      ...mediaTimes('mediaEnd', 100),
    }));
    await settle();

    assert.deepEqual(writesFor(ctx, secondFile), []);
  });

  it('ignores a late recordingMediaStarted from the previous file', async (t) => {
    const { ctx, sessionId, firstStart, secondFile } = await startSecondFile(t);

    ctx.fake.client.deliver(mediaStarted(sessionId, firstStart));
    await settle();
    assert.deepEqual(writesFor(ctx, secondFile), []);

    const secondStart = mediaTimes('mediaStart', 0);
    ctx.fake.client.deliver(mediaStarted(sessionId, secondStart));
    await settle();
    assert.deepEqual(writesFor(ctx, secondFile).map((write) => write.timestamp),
      [secondStart.mediaStartHR]);
  });
});
