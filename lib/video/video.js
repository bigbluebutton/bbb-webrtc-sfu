'use strict';

const config = require('config');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');
const Messaging = require('../bbb/messages/Messaging');
const h264_sdp = require('../h264-sdp');
const BaseProvider = require('../base/BaseProvider');
const FORCE_H264 = config.get('webcam-force-h264');
const SHOULD_RECORD = config.get('recordWebcams');
const LOG_PREFIX = "[video]";
const emitter = require('../utils/emitter');

let sources = {};

module.exports = class Video extends BaseProvider {
  constructor(_bbbGW, _meetingId, _id, _shared, _connectionId, mcs, voiceBridge) {
    super();
    this.sfuApp = C.VIDEO_APP;
    this.mcs = mcs;
    this.bbbGW = _bbbGW;
    this.id = _id;
    this.connectionId = _connectionId;
    this.meetingId = _meetingId;
    this.voiceBridge = voiceBridge;
    this.shared = _shared;
    this.role = this.shared? 'share' : 'viewer'
    this.streamName = this.connectionId + this.id + "-" + this.role;
    this.mediaId = null;
    this.status = C.MEDIA_STOPPED;
    this.recording = {};
    this.isRecorded = false;
    this._recordingSubPath = 'recordings';
    this._cameraProfile = 'medium';
    this.candidatesQueue = [];
    this.notFlowingTimeout = null;
    this.pending = false;

    this.bbbGW.once(C.RECORDING_STATUS_REPLY_MESSAGE_2x+this.meetingId, (payload) => {
      Logger.info(LOG_PREFIX, "RecordingStatusReply userId:", payload.requestedBy, "recorded:", payload.recorded);

      if (payload.requestedBy === this.id && payload.recorded) {
        this.isRecorded = true;
      }
    });
  }

  static setSource (userId, stream) {
    Logger.info(LOG_PREFIX, "Setting new source media", userId, stream);
    sources[userId] = stream;
    emitter.emit(C.VIDEO_SOURCE_ADDED, userId);
  }

  static removeSource (event) {
    const { userId } = sourceMap;
    sources[userId] = null;
  }

  _randomTimeout (low, high) {
    return parseInt(Math.random() * (high - low) + low);
  }

  async onIceCandidate (_candidate) {
    if (this.mediaId) {
      try {
        await this.flushCandidatesQueue();
        await this.mcs.addIceCandidate(this.mediaId, _candidate);
      }
      catch (err)   {
        this._handleError(LOG_PREFIX, err, this.role, this.id);
        Logger.error(LOG_PREFIX, "ICE candidate could not be added to media controller.", err);
      }
    }
    else {
      this.candidatesQueue.push(_candidate);
      Logger.trace(LOG_PREFIX, "ICE candidate for", this.id, "is going to be queued", this.candidatesQueue);
    }
  };

  async flushCandidatesQueue () {
    return new Promise((resolve, reject) => {
      if (this.mediaId) {
        const iceProcedures = this.candidatesQueue.map((candidate) => {
          this.mcs.addIceCandidate(this.mediaId, candidate);
        });

        Logger.trace(LOG_PREFIX, "Flushing candidates queue for", this.mediaId, iceProcedures);

        return Promise.all(iceProcedures).then(() => {
          this.candidatesQueue = [];
          resolve();
        }).catch((err) => {
          Logger.error(LOG_PREFIX, "ICE candidate could not be added to media controller.", err);
          reject(this._handleError(LOG_PREFIX, err, this.role, this.id));
        });
      }
    });
  }

  serverState (event) {
    const { eventTag: { code }  } = { ...event };
    switch (code) {
      case C.MEDIA_SERVER_OFFLINE:
        Logger.error(LOG_PREFIX, "Video provider received MEDIA_SERVER_OFFLINE event");
        this.emit(C.MEDIA_SERVER_OFFLINE, event);
        break;

      default:
        Logger.warn(LOG_PREFIX, "Unknown server state", event);
    }
  }

  _onMCSIceCandidate (event, endpoint) {
    const { mediaId, candidate } = event;

    if (mediaId !== endpoint) {
      return;
    }

    Logger.debug(LOG_PREFIX, 'Received ICE candidate from mcs-core for media session', mediaId, '=>', candidate, "for connection", this.connectionId);

    this.bbbGW.publish(JSON.stringify({
      connectionId: this.connectionId,
      type: 'video',
      role: this.role,
      id : 'iceCandidate',
      cameraId: this.id,
      candidate: candidate
    }), C.FROM_VIDEO);
  }

  _mediaStateWebRTC (event, endpoint) {
    const { mediaId , state } = event;
    const { name, details } = state;

    if (mediaId !== endpoint) {
      return;
    }

    switch (name) {
      case "MediaStateChanged":
        break;

      case "MediaFlowOutStateChange":
      case "MediaFlowInStateChange":
        Logger.info(LOG_PREFIX, "Session with media", mediaId, "received state", state, "for video", this.streamName);
        if (details === 'NOT_FLOWING' && this.status !== C.MEDIA_PAUSED) {
          Logger.warn(LOG_PREFIX, "Setting up a timeout for", this.streamName);
          if (!this.notFlowingTimeout) {
            this.notFlowingTimeout = setTimeout(() => {
              if (this.shared) {
                this.sendPlayStop();
                this.status = C.MEDIA_STOPPED;
                clearTimeout(this.notFlowingTimeout);
                delete this.notFlowingTimeout;
              }
            }, config.get('mediaFlowTimeoutDuration') + this._randomTimeout(-2000, 2000));
          }
        }
        else if (details === 'FLOWING') {
          if (this.notFlowingTimeout) {
            Logger.warn(LOG_PREFIX, "Received a media flow before stopping", this.streamName);
            clearTimeout(this.notFlowingTimeout);
            delete this.notFlowingTimeout;
          }
          if (this.status !== C.MEDIA_STARTED) {

            // Record the video stream if it's the original being shared
            if (this.shouldRecord()) {
              this.startRecording();
            }

            this.sendPlayStart();

            this.status = C.MEDIA_STARTED;
          }

        }
        break;

      default: Logger.warn(LOG_PREFIX, "Unrecognized event", event);
    }
  }

  sendPlayStart () {
    this.bbbGW.publish(JSON.stringify({
       connectionId: this.connectionId,
       type: 'video',
       role: this.role,
       id : 'playStart',
       cameraId: this.id,
    }), C.FROM_VIDEO);
  }

  sendPlayStop () {
    let userCamEvent =
      Messaging.generateUserCamBroadcastStoppedEventMessage2x(this.meetingId, this.id, this.id);
    this.bbbGW.publish(userCamEvent, function(error) {});

    this.bbbGW.publish(JSON.stringify({
      connectionId: this.connectionId,
      type: 'video',
      role: this.role,
      id : 'playStop',
      cameraId: this.id,
    }), C.FROM_VIDEO);
  }

  sendGetRecordingStatusRequestMessage() {
    let req = Messaging.generateRecordingStatusRequestMessage(this.meetingId, this.id);

    this.bbbGW.publish(req, C.TO_AKKA_APPS);
  }

  shouldRecord () {
    return this.isRecorded && this.shared;
  }

  async startRecording() {
    return new Promise(async (resolve, reject) => {
      try {
        const recordingName = this._cameraProfile + '-' + this.id;
        const recordingPath = this.getRecordingPath(this.meetingId, this._recordingSubPath, recordingName);
        this.recording = await this.mcs.startRecording(this.userId, this.mediaId, recordingPath);
        this.mcs.on('MediaEvent' + this.recording.recordingId, this.recordingState.bind(this));
        this.sendStartShareEvent();
        resolve(this.recording);
      }
      catch (err) {
        Logger.error(LOG_PREFIX, "Error on start recording with message", err);
        reject(this._handleError(LOG_PREFIX, err, this.role, this.id));
      }
    });
  }

  async stopRecording() {
    await this.mcs.stopRecording(this.userId, this.mediaId, this.recording.recordingId);
    this.sendStopShareEvent();
    this.recording = {};
  }

  recordingState(event) {
    const msEvent = event.event;
    Logger.info('[Recording]', msEvent.type, '[', msEvent.state, ']', 'for recording session', event.id, 'for video', this.streamName);
  }

  start (sdpOffer) {
    return new Promise(async (resolve, reject) => {
      Logger.info(LOG_PREFIX, "Starting video instance for", this.streamName);
      this.status = C.MEDIA_STARTING;

      // Force H264
      if (FORCE_H264) {
        sdpOffer = h264_sdp.transform(sdpOffer);
      }

      // Start the recording process
      if (SHOULD_RECORD && this.shared) {
        this.sendGetRecordingStatusRequestMessage();
      }

      try {
        this.userId = await this.mcs.join(this.voiceBridge, 'SFU', {});
        Logger.info(LOG_PREFIX, "MCS join for", this.streamName, "returned", this.userId);
        const sdpAnswer = await this._addMCSMedia(C.WEBRTC, sdpOffer);

        this.mcs.onEvent(C.MEDIA_STATE, this.mediaId, (event) => {
          this._mediaStateWebRTC(event, this.mediaId);
        });

        this.mcs.onEvent(C.MEDIA_STATE_ICE, this.mediaId, (event) => {
          this._onMCSIceCandidate(event, this.mediaId);
        });

        await this.flushCandidatesQueue();
        Logger.info(LOG_PREFIX, "MCS call for user", this.userId, "returned", this.mediaId);
        return resolve(sdpAnswer);
      }
      catch (err) {
        reject(this._handleError(LOG_PREFIX, err, this.role, this.id));
      }
    });
  }

  _addMCSMedia (type, descriptor) {
    return new Promise(async (resolve, reject) => {
      try {
        if (this.shared) {
          const options = {
            descriptor,
            name: this._assembleStreamName('publish', this.id, this.voiceBridge),
          }

          const { mediaId, answer } = await this.mcs.publish(this.userId, this.voiceBridge, type, options);
          this.mediaId = mediaId;
          sources[this.id] = this.mediaId;
          return resolve(answer);
        }
        else {
          Logger.info(LOG_PREFIX, "Subscribing to", this.id, sources);
          if (sources[this.id]) {
            const answer = this._subscribeToMedia(descriptor);
            return resolve(answer);
          } else {
            const lazySubscribe = (id) => {
              Logger.info(LOG_PREFIX, "Lazily subscribing to", id, "in", this.id);
              if (id === this.id) {
                const answer = this._subscribeToMedia(descriptor);
                emitter.removeListener(C.VIDEO_SOURCE_ADDED, lazySubscribe);
                return resolve(answer);
              }
            }
            // Media not yet mapped, add it to pending list
            // TODO implement a timeout to drop inactive candidates
            emitter.on(C.VIDEO_SOURCE_ADDED, lazySubscribe);
          }
        }
      }
      catch (err) {
        err = this._handleError(LOG_PREFIX, err, this.role, this.id)
        reject(err);
      }
    });
  }

  async _subscribeToMedia (descriptor) {
    try {
      const options = {
        descriptor,
        name: this._assembleStreamName('subscribe', this.id, this.voiceBridge),
      }
      Logger.info(LOG_PREFIX, 'Subscribing to', sources[this.id], 'from', this.id);
      const { mediaId, answer } = await this.mcs.subscribe(this.userId, sources[this.id], C.WEBRTC, options);
      this.mediaId = mediaId;
      return answer;
    }
    catch (err) {
      throw err;
    }
  }

  async pause (state) {
    const sourceId = sources[this.id];
    const sinkId = this.mediaId;

    if (sourceId == null || sinkId == null) {
      Logger.error(LOG_PREFIX, "Source or sink is null.");
      return;
    }

    // We want to pause the stream
    try {
      if (state && (this.status !== C.MEDIA_STARTING || this.status !== C.MEDIA_PAUSED)) {
        await this.mcs.disconnect(sourceId, sinkId, 'VIDEO');
        this.status = C.MEDIA_PAUSED;
      }
      else if (!state && this.status === C.MEDIA_PAUSED) { //un-pause
        await this.mcs.connect(sourceId, sinkId, 'VIDEO');
        this.status = C.MEDIA_STARTED;
      }
    }
    catch (err) {
      this._handleError(LOG_PREFIX, err, this.role, this.id);
    }
  }

  sendStartShareEvent() {
    let shareCamEvent = Messaging.generateWebRTCShareEvent('StartWebRTCShareEvent', this.meetingId, this.recording.filename);
    this.bbbGW.writeMeetingKey(this.meetingId, shareCamEvent, function(error) {});
  }

  sendStopShareEvent () {
    let stopShareEvent =
      Messaging.generateWebRTCShareEvent('StopWebRTCShareEvent', this.meetingId, this.recording.filename);
    this.bbbGW.writeMeetingKey(this.meetingId, stopShareEvent, function(error) {});
  }

  async stop () {
    return new Promise(async (resolve, reject) => {
      if (this.status === C.MEDIA_STOPPING) {
        Logger.warn(LOG_PREFIX, 'Video session', this.streamName, this.userId, 'at room', this.meetingId, 'already stopping');
        emitter.once(C.VIDEO_STOPPED + this.streamName, resolve);
      } else {
        Logger.info(LOG_PREFIX, 'Stopping video session', this.streamName, this.userId, 'at room', this.meetingId);
        try {
          this.status = C.MEDIA_STOPPING;
          await this.mcs.leave(this.voiceBridge, this.userId);

          if (this.shouldRecord()) {
            this.sendStopShareEvent();
          }

          if (this.shared) {
            delete sources[this.id];
          }

          if (this.notFlowingTimeout) {
            clearTimeout(this.notFlowingTimeout);
            delete this.notFlowingTimeout;
          }

          delete this.candidatesQueue;
          emitter.emit(C.VIDEO_STOPPED + this.streamName);
          resolve();
        }
        catch (err) {
          reject(this._handleError(LOG_PREFIX, err, this.role, this.streamName));
        }
      }
    });
  }
};
