'use strict';

const { TestRecorderClient, BBBWebRTCRecorder, settle } = require('./helpers.js');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const SESSION = 'session-1';

const connectedClient = (status = {}) => {
  const client = new TestRecorderClient();
  client.deliver({ id: 'recorderStatus', instanceId: 'recorder-1', ...status });

  return client;
};

const startLiveKit = (client, handlers = {}) => client.startRecording(SESSION, 'audio/m/f.webm', {
  adapter: 'livekit',
  adapterOptions: { livekit: { room: 'm', trackIds: ['TR_1'] } },
  ...handlers,
});

const sessionListeners = (client) => [
  'recordingStopped',
  'recordingRtpStatusChanged',
  'recordingMediaStarted',
].map((id) => client.listenerCount(`${id}:${SESSION}`));

describe('BBBWebRTCRecorder capabilities', () => {
  it('stores the capabilities from recorderStatus', () => {
    const client = connectedClient({ capabilities: ['mediaTimestamps'] });

    assert.deepEqual(client.capabilities, ['mediaTimestamps']);
    assert.equal(client.supports('mediaTimestamps'), true);
    assert.equal(client.supports('other'), false);
  });

  it('has no capabilities when recorderStatus lists none', () => {
    assert.deepEqual(connectedClient().capabilities, []);
    assert.deepEqual(connectedClient({ capabilities: 'mediaTimestamps' }).capabilities, []);
    assert.equal(connectedClient().supports('mediaTimestamps'), false);
  });

  it('drops the capabilities when the recorder instance goes away or changes', () => {
    const client = connectedClient({ capabilities: ['mediaTimestamps'] });
    client.recorderInstanceId = null;
    assert.equal(client.supports('mediaTimestamps'), false);

    client.deliver({ id: 'recorderStatus', instanceId: 'recorder-1', capabilities: ['mediaTimestamps'] });
    client.deliver({ id: 'recorderStatus', instanceId: 'recorder-2' });
    assert.equal(client.supports('mediaTimestamps'), false);
  });
});

describe('BBBWebRTCRecorder session messages', () => {
  it('routes recordingMediaStarted to the session handler', async () => {
    const client = connectedClient();
    const received = [];
    startLiveKit(client, { mediaStartedHdlr: (payload) => received.push(payload) });
    await settle();

    client.deliver({
      id: 'recordingMediaStarted',
      recordingSessionId: SESSION,
      mediaStartUTC: 1793234406557,
      mediaStartHR: 4000,
    });

    assert.deepEqual(received, [{
      recordingSessionId: SESSION,
      mediaStartUTC: 1793234406557,
      mediaStartHR: 4000,
    }]);
  });

  it('removes the session listeners when the recording stops', async () => {
    const client = connectedClient();
    startLiveKit(client, { mediaStartedHdlr: () => {} }).catch(() => {});
    await settle();

    client.deliver({ id: 'recordingStopped', recordingSessionId: SESSION, reason: 'closed' });

    assert.deepEqual(sessionListeners(client), [0, 0, 0]);
  });

  it('resolves stopRecording with the whole recordingStopped payload', async () => {
    const client = connectedClient();
    const stopped = {
      recordingSessionId: SESSION,
      reason: 'stopped',
      timestampUTC: '2026-10-29T12:00:00.000Z',
      timestampHR: 1500,
      mediaStartUTC: 1793234406557,
      mediaStartHR: 4000,
      mediaEndUTC: 1793234408057,
      mediaEndHR: 5500,
    };
    client.onPublish = (message) => {
      if (message.id === 'stopRecording') client.deliver({ id: 'recordingStopped', ...stopped });
    };

    assert.deepEqual(await client.stopRecording(SESSION), stopped);
  });

  it('removes the media started listener when a stop times out', async (t) => {
    const timeout = BBBWebRTCRecorder.REQUEST_TIMEOUT;
    BBBWebRTCRecorder.REQUEST_TIMEOUT = 20;
    t.after(() => { BBBWebRTCRecorder.REQUEST_TIMEOUT = timeout; });
    const client = connectedClient();
    startLiveKit(client, { mediaStartedHdlr: () => {} }).catch(() => {});
    await settle();

    await assert.rejects(client.stopRecording(SESSION), /timeout/);
    assert.deepEqual(sessionListeners(client), [0, 0, 0]);
  });
});

describe('BBBWebRTCRecorder attachSession', () => {
  it('registers the session handlers of a recording it did not start', () => {
    const client = connectedClient();
    const calls = [];
    client.attachSession(SESSION, {
      recordingStoppedHdlr: (payload) => calls.push(['stopped', payload.reason]),
      rtpStatusChangedHdlr: (payload) => calls.push(['rtp', payload.status]),
      mediaStartedHdlr: (payload) => calls.push(['media', payload.mediaStartHR]),
    });

    client.deliver({ id: 'recordingRtpStatusChanged', recordingSessionId: SESSION, status: 'flowing' });
    client.deliver({ id: 'recordingMediaStarted', recordingSessionId: SESSION, mediaStartUTC: 1, mediaStartHR: 2 });
    client.deliver({ id: 'recordingStopped', recordingSessionId: SESSION, reason: 'closed' });
    client.deliver({ id: 'recordingStopped', recordingSessionId: SESSION, reason: 'closed' });

    assert.deepEqual(calls, [['rtp', 'flowing'], ['media', 2], ['stopped', 'closed']]);
    assert.deepEqual(sessionListeners(client), [0, 0, 0]);
  });

  it('adds only the handlers a session lacks', async () => {
    const client = connectedClient();
    startLiveKit(client, {
      recordingStoppedHdlr: () => {},
      rtpStatusChangedHdlr: () => {},
      mediaStartedHdlr: () => {},
    }).catch(() => {});
    await settle();

    client.attachSession(SESSION, {
      recordingStoppedHdlr: () => {},
      rtpStatusChangedHdlr: () => {},
      mediaStartedHdlr: () => {},
    });

    assert.deepEqual(sessionListeners(client), [1, 1, 1]);
  });
});
