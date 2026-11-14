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

const assertSfuTime = (event, before) => {
  assert.ok(event.timestamp >= before.hr && event.timestamp <= hrTime(),
    `timestamp ${event.timestamp} is not SFU time`);
  assert.ok(event.timestampUTC >= before.utc && event.timestampUTC <= Date.now(),
    `timestampUTC ${event.timestampUTC} is not SFU time`);
};

const now = () => ({ hr: hrTime(), utc: Date.now() });

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
});

// Recording off with a stop that times out, then on again. lateMessages
// are the first file's messages that the recorder sends while the second
// startRecording is on its way, before that start's reply.
const startSecondFile = async (t, lateMessages) => {
  shortRequestTimeout(t);
  const ctx = await createManager();
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
