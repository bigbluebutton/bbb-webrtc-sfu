'use strict';

const path = require('path');

// node-config reads this once, on the first require('config').
process.env.NODE_CONFIG_DIR = path.join(__dirname, 'config');

const { EventEmitter } = require('events');
const {
  BBBWebRTCRecorder,
  DEFAULT_PUB_CHANNEL,
  DEFAULT_SUB_CHANNEL,
} = require('../lib/common/bbb-webrtc-recorder.js');
const LiveKitWebRTCRecorderManager = require('../lib/livekit/livekit-recorder-manager.js');
const { LiveKitPrometheusAgent } = require('../lib/livekit/metrics/index.js');
const C = require('../lib/bbb/messages/Constants.js');

// The metrics module listens on load, even with metrics disabled.
LiveKitPrometheusAgent.metricsServer.getServerObject().unref();

const MEETING_ID = 'meeting-1';
const USER_ID = 'w_user1';

// The real recorder client with Redis swapped out.
class TestRecorderClient extends BBBWebRTCRecorder {
  constructor (options) {
    super(DEFAULT_PUB_CHANNEL, DEFAULT_SUB_CHANNEL, options);
    this.published = [];
    this.onPublish = null;
  }

  _addSubscribeChannel () {}

  _publish (message) {
    this.published.push(message);
    this.emit('outgoingMessage', message);
    if (this.onPublish) setImmediate(() => this.onPublish(message));
  }

  deliver (message) {
    this.incomingMessage(JSON.stringify(message));
  }
}

// recordingStopped as bbb-webrtc-recorder sends it.
const recorderStopped = (recordingSessionId, fields = {}) => ({
  id: 'recordingStopped',
  recordingSessionId,
  reason: 'stopped',
  timestampUTC: new Date().toISOString(),
  timestampHR: 1500,
  ...fields,
});

// Plays bbb-webrtc-recorder.
const createFakeRecorder = ({
  capabilities,
  recordings = [],
  notifyRecordingStopOnCrash = false,
} = {}) => {
  const client = new TestRecorderClient({ notifyRecordingStopOnCrash });
  const fake = {
    client,
    recordings,
    // The session ids the recorder holds. getRecordings lists only these. It
    // refuses a start for a held id and does not answer a stop for any other.
    sessions: new Set(recordings.map(({ recordingSessionId }) => recordingSessionId)),
    // Extra fields for the recordingStopped reply to stopRecording.
    stopFields: {},
    // When true, stopRecording gets no reply and the session stays held.
    silentStop: false,
  };

  // The recorder frees a session id once it has sent its recordingStopped.
  // A restarted recorder, with a new instanceId, holds none.
  const deliver = client.deliver.bind(client);
  let instanceId = null;
  client.deliver = (message) => {
    if (message.id === 'recordingStopped') fake.sessions.delete(message.recordingSessionId);
    if (message.id === 'recorderStatus') {
      if (instanceId && message.instanceId !== instanceId) fake.sessions.clear();
      ({ instanceId } = message);
    }
    deliver(message);
  };

  client.onPublish = (message) => {
    switch (message.id) {
      case 'getRecorderStatus':
        client.deliver({
          id: 'recorderStatus',
          instanceId: 'recorder-1',
          appVersion: 'test',
          ...(capabilities ? { capabilities } : {}),
        });
        break;
      case 'getRecordings':
        client.deliver({
          id: 'getRecordingsResponse',
          requestId: message.requestId,
          recordings: fake.recordings
            .filter(({ recordingSessionId }) => fake.sessions.has(recordingSessionId)),
        });
        break;
      case 'startRecording':
        if (fake.sessions.has(message.recordingSessionId)) {
          client.deliver({
            id: 'startRecordingResponse',
            recordingSessionId: message.recordingSessionId,
            status: 'failed',
            error: `session ${message.recordingSessionId} already exists`,
          });
          break;
        }
        fake.sessions.add(message.recordingSessionId);
        client.deliver({
          id: 'startRecordingResponse',
          recordingSessionId: message.recordingSessionId,
          status: 'ok',
          fileName: message.fileName,
        });
        break;
      case 'stopRecording':
        if (fake.silentStop || !fake.sessions.has(message.recordingSessionId)) break;
        client.deliver(recorderStopped(message.recordingSessionId, fake.stopFields));
        break;
      default:
        break;
    }
  };

  return fake;
};

// Plays akka-apps (recording status probe) and Redis (writeMeetingKey).
class FakeGateway extends EventEmitter {
  constructor () {
    super();
    this.recordingStatus = {
      recorded: true,
      recording: true,
      recordFullDurationMedia: false,
    };
    this.writes = [];
  }

  publish (message) {
    const { core } = JSON.parse(message);
    const meetingId = core.header.meetingId;
    const reply = {
      ...this.recordingStatus,
      requestedBy: core.body[C.REQUESTED_BY],
    };

    setImmediate(() => this.emit(C.RECORDING_STATUS_REPLY_MESSAGE_2x + meetingId, reply));
  }

  writeMeetingKey (meetingId, message) {
    this.writes.push(message);
  }

  events (eventName) {
    return this.writes.filter((write) => write.eventName === eventName);
  }
}

const waitFor = async (predicate, { timeout = 2000, what = 'condition' } = {}) => {
  const deadline = Date.now() + timeout;

  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

const settle = async (rounds = 5) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const shortRequestTimeout = (t) => {
  const timeout = BBBWebRTCRecorder.REQUEST_TIMEOUT;
  BBBWebRTCRecorder.REQUEST_TIMEOUT = 50;
  t.after(() => { BBBWebRTCRecorder.REQUEST_TIMEOUT = timeout; });
};

const createManager = async (recorderOptions = {}) => {
  const fake = createFakeRecorder(recorderOptions);
  const gateway = new FakeGateway();
  const roomRecordingStatusMap = new Map([[MEETING_ID, true]]);
  const manager = new LiveKitWebRTCRecorderManager(
    {},
    new EventEmitter(),
    roomRecordingStatusMap,
    gateway,
    new Map(),
    new Map(),
    { recorder: fake.client },
  );

  await waitFor(
    () => fake.client.published.some((message) => message.id === 'getRecordings'),
    { what: 'getRecordings' },
  );
  await settle();

  return { manager, fake, gateway, roomRecordingStatusMap };
};

const trackEvent = (source, trackId = `TR_${source}`) => ({
  room: { name: MEETING_ID, sid: 'RM_1' },
  participant: { identity: USER_ID, sid: 'PA_1', kind: 0 },
  track: { sid: trackId, source },
});

// Publishes a track and waits until the recorder accepted the start.
const publishTrack = async ({ manager, fake }, source) => {
  const event = trackEvent(source);
  manager._handleTrackPublished(event);
  await waitFor(
    () => fake.client.published.some((message) => message.id === 'startRecording'
      && message.adapterOptions.livekit.trackIds[0] === event.track.sid),
    { what: 'startRecording' },
  );
  await settle();

  return manager._activeRecordings.get(event.track.sid);
};

const unpublishTrack = ({ manager }, source) => {
  manager._handleTrackUnpublished(trackEvent(source));
};

const dispose = (manager) => {
  for (const trackId of [...manager._recordingRetryTimeouts.keys()]) {
    manager._deleteRecordingRetryTimeout(trackId);
  }
  manager._clearRecorderReconnectTimeout();
};

module.exports = {
  MEETING_ID,
  USER_ID,
  BBBWebRTCRecorder,
  TestRecorderClient,
  FakeGateway,
  createFakeRecorder,
  createManager,
  recorderStopped,
  publishTrack,
  unpublishTrack,
  trackEvent,
  waitFor,
  settle,
  shortRequestTimeout,
  dispose,
};
