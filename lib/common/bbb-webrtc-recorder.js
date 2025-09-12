const EventEmitter = require('events').EventEmitter;
const config = require('config');
const RedisWrapper = require('../bbb/pubsub/RedisWrapper.js');
const Logger = require('./logger');

const {
  channels: CHANNELS,
  heartbeatInterval: REC_HEARTBEAT_INTERVAL = 5000,
  connectionTimeout: REC_CONNECTION_TIMEOUT = 5000,
  debug: { heartbeatResponseDelay: HEARTBEAT_RESPONSE_DELAY = 0 } = {},
} = config.get('bbbWebrtcRecorder')

const DEFAULT_PUB_CHANNEL = CHANNELS.publish;
const DEFAULT_SUB_CHANNEL = CHANNELS.subscribe;

// TODO centralize gateway and wrapper in commons
class BBBWebRTCRecorder extends EventEmitter {
  static REQUEST_TIMEOUT = 5000;

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
    this._pingTimeout = null;
  }

  set recorderInstanceId (instanceId) {
    if (!instanceId) {
      if (this._recorderInstanceId) {
        Logger.warn('bbb-webrtc-recorder: Recorder instance ID reset (probable crash)', {
          oldInstanceId: this._recorderInstanceId,
          newInstanceId: instanceId,
        });
        this._notifyCrash();
      }

      this._recorderInstanceId = null;
      this.started = false;
      return;
    }

    if (this._recorderInstanceId) {
      if (this._recorderInstanceId !== instanceId) {
        this._recorderInstanceId = instanceId;
        Logger.warn('bbb-webrtc-recorder: Recorder instance ID changed (restart)', {
          instanceId,
          oldInstanceId: this._recorderInstanceId,
        });
        this._notifyCrash();
        this.started = true;
        this.emit('recorderInstanceStarted', { instanceId: this.recorderInstanceId });
      }
    } else {
      this._recorderInstanceId = instanceId;
      this.started = true;
      Logger.info('bbb-webrtc-recorder: Recorder instance ID set', {
        instanceId,
        appVersion: this.appVersion || 'Unknown',
      });
      this.emit('recorderInstanceStarted', { instanceId: this.recorderInstanceId });
    }
  }

  get recorderInstanceId () {
    return this._recorderInstanceId;
  }

  start () {
    if (this.started) {
      Logger.warn('bbb-webrtc-recorder: Recorder already started', {
        instanceId: this.recorderInstanceId,
      });
    } else {
      this._setupHeartbeat();
      this._publish({ id: 'getRecorderStatus' }, this.pubChannel);
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
    if (this._pingTimeout) {
      clearTimeout(this._pingTimeout);
      this._pingTimeout = null;
    }
    Logger.trace('bbb-webrtc-recorder: Recorder status received', { instanceId, appVersion });
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

    this.pingRoutine = setInterval(() => {
      // If a ping is already in flight waiting for a response, do nothing.
      if (this._pingTimeout) {
        return;
      }

      // If we've heard from the recorder recently, do nothing.
      if (this._getTimeSinceLastMsg() < REC_HEARTBEAT_INTERVAL) {
        return;
      }

      // If we haven't heard, send a ping and set a timeout for the response.
      Logger.trace('bbb-webrtc-recorder: Heartbeat check expired, sending ping', {
        instanceId: this.recorderInstanceId,
      });
      this._publish({ id: 'getRecorderStatus' }, this.pubChannel);

      this._pingTimeout = setTimeout(() => {
        Logger.warn('bbb-webrtc-recorder: Heartbeat ping timed out, resetting connection', {
          instanceId: this.recorderInstanceId,
        });

        this.recorderInstanceId = null;
        // Important: clear the reference after the timeout has fired.
        this._pingTimeout = null;
      }, REC_CONNECTION_TIMEOUT);
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
      Logger.error('bbb-webrtc-recorder: Redis channel subscribe failed', {
        channel,
        errorMessage: error.message,
      });
      return Promise.reject(error);
    }
  }

  _deserialize (message) {
    if (typeof message === 'object') return message;

    try {
      const dmsg = JSON.parse(message);
      return dmsg;
    } catch (error) {
      Logger.error('bbb-webrtc-recorder: Failed to deserialize message, use it raw', {
        errorMessage: error.message,
        instanceId: this.recorderInstanceId,
        message,
      });
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

  _reqToStr(message) {
    if (typeof message === 'object') {
      return JSON.stringify(message);
    }

    return message;
  }

  _publish (message, channel) {
    try {
      this.checkPublisher();
      const strMessage = this._reqToStr(message);

      if (typeof this.publisher.publishToChannel === 'function') {
        this.publisher.publishToChannel(strMessage, channel);
        this.emit('outgoingMessage', message);
      } else {
        throw new Error('Invalid publisher');
      }
    } catch (error) {
      Logger.error('bbb-webrtc-recorder: Failed to publish message', {
        instanceId: this.recorderInstanceId,
        errorMessage: error.message,
        errorStack: error.stack,
        message,
        channel,
      });
    }
  }

  incomingMessage (message) {
    const msg = this._deserialize(message);
    const { id, payload } = this._parseResponse(msg);
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
        case 'recorderStatus': {
          // {
          //   id: ‘recorderStatus’,
          //   appVersion: <String>, // app version
          //   instanceId: <String>, // unique instance id
          //   timestamp: <Number>, // boot time
          // }
          const _processRecStatus = () => {
            this._handleRecorderStatus(payload);
            this.emit(id, payload);
          };

          // Heart response delay is a debug measure used to test heartbeat
          // resiliency in testing environments.
          if (HEARTBEAT_RESPONSE_DELAY === 0 || !HEARTBEAT_RESPONSE_DELAY) {
            _processRecStatus();
          } else {
            Logger.debug(`[TEST] Delaying recorderStatus message for ${HEARTBEAT_RESPONSE_DELAY}ms`, {
              instanceId: this.recorderInstanceId,
            });
            setTimeout(() => {
              Logger.debug('[TEST] Processing delayed recorderStatus message', {
                instanceId: this.recorderInstanceId,
              });
              _processRecStatus();
            }, HEARTBEAT_RESPONSE_DELAY);
          }
          break;
        }
        default:
          this.emit(id, { ...payload });
      }
    }

    this.emit('incomingMessage', msg);
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

  _processMediasoupAdapterOptions(adapterOptions) {
    // SDP needs to be base64 encoded
    if (adapterOptions?.mediasoup?.sdp) {
      adapterOptions.mediasoup.sdp = Buffer
        .from(JSON.stringify({ type: 'offer', sdp: adapterOptions.mediasoup.sdp }))
        .toString('base64');
    } else {
      throw new Error('SDP is required for mediasoup adapter');
    }

    return adapterOptions;
  }

  _processLivekitAdapterOptions (adapterOptions) {
    if (!adapterOptions?.livekit?.room) {
      throw new Error('Room is required for livekit adapter');
    }

    if (!adapterOptions?.livekit?.trackIds || !Array.isArray(adapterOptions.livekit.trackIds)) {
      throw new Error('Track IDs are required for livekit adapter');
    }

    return adapterOptions;
  }

  _processAdapterOptions (adapter, adapterOptions) {
    switch (adapter) {
      case 'mediasoup':
        return this._processMediasoupAdapterOptions(adapterOptions);
      case 'livekit':
        return this._processLivekitAdapterOptions(adapterOptions);
      default:
        throw new Error(`Unsupported adapter: ${adapter}`);
    }
  }

  // {
  //   id: 'startRecording',
  //   recordingSessionId: <String>, // requester-defined - error out if collision
  //   fileName: <String>, // file name INCLUDING format (.webm)
  //   adapter: <String>, // "mediasoup" or "livekit" - defaults to "mediasoup" if not specified
  //   adapterOptions: {
  //     // Mediasoup-specific options
  //     mediasoup?: {
  //         sdp: <String>, // required for mediasoup adapter if legacy sdp is not provided
  //     },
  //     // LiveKit-specific options
  //     livekit?: {
  //         room: <String>, // required for livekit adapter
  //         trackIds: <String[]>, // required for livekit adapter - array of track IDs to record
  //     }
  //   },
  //   // Legacy field for backward compatibility
  //   sdp?: <String>, // offer - required for mediasoup adapter if adapterOptions.mediasoup.sdp is not provided
  // }
  //
  startRecording (recordingSessionId, fileName, {
    adapter = 'mediasoup',
    adapterOptions = {},
    rtpStatusChangedHdlr = () => {},
    recordingStoppedHdlr = () => {},
  } = {}) {
    return this._waitForConnection().then((connected) => {
      if (!connected) {
        throw new Error('Recorder connection timeout');
      }
      const processedAdapterOptions = this._processAdapterOptions(adapter, adapterOptions);

      return new Promise((resolve, reject) => {
        try {
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
              if (!b64Answer && adapter === 'livekit') {
                resolve({ answer: null, responseFileName });
                return;
              }

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
            reject(new Error('Recording could not be started'));
          }

          if (typeof rtpStatusChangedHdlr === 'function') {
            this.on(`recordingRtpStatusChanged:${recordingSessionId}`, rtpStatusChangedHdlr);
          }

          this._recordingSessions.add(recordingSessionId)
          this.once(`recordingStopped:${recordingSessionId}`, _stopHdlr);
          this._publish({
            id: 'startRecording',
            recordingSessionId,
            adapter,
            adapterOptions: processedAdapterOptions,
            // Legacy field for backward compatibility
            sdp: adapter === 'mediasoup' ? adapterOptions.mediasoup.sdp : null,
            fileName,
          }, this.pubChannel);
          Logger.debug('bbb-webrtc-recorder: startRecording', {
            instanceId: this.recorderInstanceId,
            recordingSessionId,
            adapter,
            adapterOptions: processedAdapterOptions,
            fileName,
          });
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
        const requestTimeout = setTimeout(() => {
          this.removeAllListeners(`recordingStopped:${recordingSessionId}`);
          reject(new Error('Recording stop request timeout'));
        }, BBBWebRTCRecorder.REQUEST_TIMEOUT);

        try {
          this.once(`recordingStopped:${recordingSessionId}`, ({
            reason,
            timestampUTC,
            timestampHR,
          }) => {
            this.removeAllListeners(`recordingStopped:${recordingSessionId}`);
            clearTimeout(requestTimeout);
            // TODO use this upstream.
            resolve({ reason, timestampUTC, timestampHR });
          });

          this.removeAllListeners(`startRecordingResponse:${recordingSessionId}`);
          this.removeAllListeners(`recordingRtpStatusChanged:${recordingSessionId}`);
          this._publish({
            id: 'stopRecording',
            recordingSessionId,
          }, this.pubChannel);
        } catch (error) {
          clearTimeout(requestTimeout);
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
