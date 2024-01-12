const EventEmitter = require('events').EventEmitter;
const config = require('config');
const RedisWrapper = require('../bbb/pubsub/RedisWrapper.js');
const Logger = require('./logger');

const {
  channels: CHANNELS,
  heartbeatInterval: REC_HEARTBEAT_INTERVAL = 5000,
  heartbeatDelay: REC_HEARTBEAT_DELAY = 1000,
  connectionTimeout: REC_CONNECTION_TIMEOUT = 5000,
} = config.get('bbbWebrtcRecorder')

const DEFAULT_PUB_CHANNEL = CHANNELS.publish;
const DEFAULT_SUB_CHANNEL = CHANNELS.subscribe;

// TODO centralize gateway and wrapper in commons
class BBBWebRTCRecorder extends EventEmitter {
  constructor(pubChannel, subChannel) {
    super();
    this.started = false;
    this.pubChannel = pubChannel;
    this.subscribers = {};
    this.publisher = null;
    this.recorderInstanceId = null;
    this._recordingSessions = new Set();

    this._addSubscribeChannel(subChannel);

    this._healthCheckInterval = null;
    this._lastHeardFromRecorder = 0;
  }

  set recorderInstanceId (instanceId) {
    if (!instanceId) {
      if (this._recorderInstanceId) {
        Logger.warn('Recorder instance ID reset (probable crash)', { oldInstanceId: this._recorderInstanceId });
        this._notifyCrash();
      }

      this._recorderInstanceId = null;
      this.started = false;
      return;
    }

    if (this._recorderInstanceId) {
      if (this._recorderInstanceId !== instanceId) {
        this._recorderInstanceId = instanceId;
        Logger.warn('Recorder instance ID changed (restart)', { instanceId, oldInstanceId: this._recorderInstanceId });
        this._notifyCrash();
        this.started = true;
        this.emit('recorderInstanceStarted', { instanceId: this.recorderInstanceId });
      }
    } else {
      this._recorderInstanceId = instanceId;
      this.started = true;
      Logger.info('Recorder instance ID set', { instanceId, appVersion: this.appVersion || "Unknown" });
      this.emit('recorderInstanceStarted', { instanceId: this.recorderInstanceId });
    }
  }

  get recorderInstanceId () {
    return this._recorderInstanceId;
  }

  start () {
    if (this.started) {
      Logger.warn('Recorder already started');
    } else {
      this._setupHeartbeat();
      this._publish(JSON.stringify({ id: 'getRecorderStatus' }), this.pubChannel);
    }

    return this;
  }

  _notifyCrash() {
    this._recordingSessions.forEach((recordingSessionId) => {
      this.emit(`recordingStopped:${recordingSessionId}`, {
        recordingSessionId,
        reason: 'recorderCrash'
      });
    });
    this.emit('recorderInstanceStopped', { instanceId: this.recorderInstanceId });
  }

  _clearHealthCheck () {
    if (this._healthCheckInterval) {
      clearInterval(this._healthCheckInterval);
      this._healthCheckInterval = null;
    }
  }

  _handleRecorderStatus ({ instanceId, appVersion }) {
    this.appVersion = appVersion;
    this.recorderInstanceId = instanceId;
    Logger.trace('Recorder status received', { instanceId, appVersion });
  }

  _updateLastMsgTime(timestamp) {
    if (typeof timestamp !== 'number'
      || (typeof timestamp === 'string' && isNaN(timestamp))
      || timestamp < this._lastHeardFromRecorder) {
      return;
    }

    this._lastHeardFromRecorder = timestamp;
  }

  _getTimeSinceLastMsg() {
    return Date.now() - this._lastHeardFromRecorder;
  }

  _setupHeartbeat () {
    if (REC_HEARTBEAT_INTERVAL === 0) return;

    this._isAlive = true;

    this.pingRoutine = setInterval(() => {
      if (this._isAlive === false) {
        this.recorderInstanceId = null;
      }

      if (this._getTimeSinceLastMsg() < REC_HEARTBEAT_INTERVAL) {
        return;
      }

      this._isAlive = false;

      setTimeout(() => {
        this._publish(JSON.stringify({ id: 'getRecorderStatus' }), this.pubChannel);
      }, REC_HEARTBEAT_DELAY);
    }, REC_HEARTBEAT_INTERVAL);
  }

  checkPublisher() {
    if (!this.publisher) {
      this.publisher = new RedisWrapper();
      this.publisher.startPublisher();
    }
  }

  _addSubscribeChannel (channel) {
    if (this.subscribers[channel]) {
      return this.subscribers[channel];
    }

    let wrobj = new RedisWrapper(channel);
    this.subscribers[channel] = {};
    this.subscribers[channel] = wrobj;
    try {
      wrobj.startSubscriber();
      wrobj.on('redis_message', this.incomingMessage.bind(this));
      return Promise.resolve(wrobj);
    } catch (error) {
      Logger.error("Redis channel subscribe failed", { channel, errorMessage: error.message });
      return Promise.reject(error);
    }
  }

  _deserialize (message) {
    if (typeof message === 'object') return message;

    try {
      const dmsg = JSON.parse(message);
      return dmsg;
    } catch (error) {
      Logger.error("Failed to deserialize message, use it raw", { errorMessage: error.message });
      return message;
    }
  }

  _parseResponse(msg) {
    const { id, ...rest } = msg;

    return {
      id,
      payload: rest,
    };
  }

  _publish (message, channel) {
    this.checkPublisher();

    if (typeof this.publisher.publishToChannel === 'function') {
      this.publisher.publishToChannel(message, channel);
    }
  }

  incomingMessage (message) {
    const msg = this._deserialize(message);
    const { id, payload } = this._parseResponse(msg);
    this._isAlive = true;
    this._updateLastMsgTime(Date.now());

    if (id) {
      switch (id) {
        case 'startRecordingResponse':
          // {
          //   id: ‘startRecordingResponse’,
          //   recordingSessionId: <String>, // file name,
          //   status: ‘ok’ | ‘failed’,
          //   error: undefined | <String>,
          //   sdp: <String | undefined>, // answer
          // }
          //
          // falls through
        case 'recordingStopped':
          // {
          //   id: ‘recordingStopped’,
          //   recordingSessionId: <String>, // file name
          //   reason: <String>,
          //   timestampUTC: <Number>, // last written frame timestamp, UTC, wall clock
          //   timestampHR:  <Number> // last written frame timestamp, monotonic system time
          // }
          //
          // falls through
        case 'recordingRtpStatusChanged': {
          // {
          //   id: ‘recordingRtpStatusChanged’, // media started or stopped flowing
          //   status: ‘flowing’ | ‘not_flowing’,
          //   recordingSessionId: <String>, // file name
          //   timestampUTC: <Number>, // latest/trigger frame ts, UTC
          //   timestampHR: <Number>, monotonic system time (latest/trigger frame ts),
          // }
          const { recordingSessionId } = payload;
          this.emit(`${id}:${recordingSessionId}`, payload);
          break;
        }
        case 'recorderStatus':
          // {
          //   id: ‘recorderStatus’,
          //   appVersion: <String>, // app version
          //   instanceId: <String>, // unique instance id
          //   timestamp: <Number>, // boot time
          // }
          this._handleRecorderStatus(payload);
          this.emit(id, payload);
          break;
        default:
          this.emit(id, { ...payload });
      }
    } else {
      this.emit('redis_message', msg);
    }
  }

  _waitForConnection () {
    const onConnected = () => {
      return new Promise((resolve) => {
        if (this.started) {
          resolve(true);
        }
        this.once('recorderInstanceStarted', () => {
          resolve(true);
        });
      });
    }

    const failOver = () => {
      return new Promise((resolve) => {
        setTimeout(() => {
          return resolve(false)
        }, REC_CONNECTION_TIMEOUT);
      });
    };

    return Promise.race([onConnected(), failOver()]);
  }

  // {
  //   id: ‘startRecording’,
  //   recordingSessionId: <String> // requester-defined - error out if collision.
  //   sdp: <String>, // offer
  //   fileName: <String>, // file name INCLUDING format (.webm)
  // }
  //
  startRecording (recordingSessionId, fileName, sdp, {
    rtpStatusChangedHdlr = () => {},
    recordingStoppedHdlr = () => {},
  } = {}) {
    return this._waitForConnection().then((connected) => {
      if (!connected) {
        throw new Error('Recorder connection timeout');
      }
      return new Promise((resolve, reject) => {
        try {
          const b64Offer = Buffer
            .from(JSON.stringify({ type: 'offer', sdp }))
            .toString('base64');

          this.once(`startRecordingResponse:${recordingSessionId}`, ({
            status,
            error = 'Unknown recording error',
            sdp: b64Answer,
            fileName: responseFileName,
          }) => {
            if (status !== 'ok') {
              reject(new Error(error));
              return;
            }

            try {
              const { sdp: answer } = JSON.parse(Buffer.from(b64Answer, 'base64').toString());
              resolve({ answer, responseFileName });
            } catch (error) {
              reject(error);
            }
          });

          const _stopHdlr = (payload) => {
            if (typeof recordingStoppedHdlr === 'function') recordingStoppedHdlr(payload);
            this.removeListener(`recordingStopped:${recordingSessionId}`, _stopHdlr);
            if (typeof rtpStatusChangedHdlr === 'function') {
              this.removeListener(`recordingRtpStatusChanged:${recordingSessionId}`, rtpStatusChangedHdlr);
            }
            this._recordingSessions.delete(recordingSessionId);
          }

          if (typeof rtpStatusChangedHdlr === 'function') {
            this.on(`recordingRtpStatusChanged:${recordingSessionId}`, rtpStatusChangedHdlr);
          }

          this._recordingSessions.add(recordingSessionId)
          this.once(`recordingStopped:${recordingSessionId}`, _stopHdlr);
          this._publish(JSON.stringify({
            id: 'startRecording',
            recordingSessionId,
            sdp: b64Offer,
            fileName,
          }), this.pubChannel);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  // {
  //   id: ‘stopRecording’,
  //   recordingSessionId: <String>, // file name
  // }
  stopRecording (recordingSessionId) {
    return this._waitForConnection().then((connected) => {
      if (!connected) {
        throw new Error('Recorder connection timeout');
      }

      return new Promise((resolve, reject) => {
        try {
          this.once(`recordingStopped:${recordingSessionId}`, ({
            reason,
            timestampUTC,
            timestampHR,
          }) => {
            this.removeAllListeners(`recordingStopped:${recordingSessionId}`);
            // TODO use this upstream.
            resolve({ reason, timestampUTC, timestampHR });
          });

          this.removeAllListeners(`startRecordingResponse:${recordingSessionId}`);
          this.removeAllListeners(`recordingRtpStatusChanged:${recordingSessionId}`);
          this._publish(JSON.stringify({
            id: 'stopRecording',
            recordingSessionId,
          }), this.pubChannel);
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}

module.exports = {
  DEFAULT_PUB_CHANNEL,
  DEFAULT_SUB_CHANNEL,
  BBBWebRTCRecorder,
}
