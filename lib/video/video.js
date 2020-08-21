'use strict';

const config = require('config');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');
const Utils = require('../utils/Utils.js');
const Messaging = require('../bbb/messages/Messaging');
const BaseProvider = require('../base/BaseProvider');
const SHOULD_RECORD = config.get('recordWebcams');
const LOG_PREFIX = "[video]";
const emitter = require('../utils/emitter');
const errors = require('../base/errors');
const DEFAULT_MEDIA_SPECS = config.get('conference-media-specs');
const SUBSCRIBER_SPEC_SLAVE = config.has('videoSubscriberSpecSlave')
  ? config.get('videoSubscriberSpecSlave')
  : false;
const KURENTO_REMB_PARAMS = config.util.cloneDeep(config.get('kurentoRembParams'));

let sources = {};

module.exports = class Video extends BaseProvider {
  constructor(
    bbbGW,
    _meetingId,
    _cameraId,
    _shared,
    _connectionId,
    mcs,
    voiceBridge,
    bbbUserId,
    bbbUserName,
    managerSessionId,
    record = true,
  ) {
    super(bbbGW);
    this.sfuApp = C.VIDEO_APP;
    this.mcs = mcs;
    this.id = _cameraId;
    this.bbbUserId = bbbUserId;
    this.bbbUserName = bbbUserName;
    this.connectionId = _connectionId;
    this.meetingId = _meetingId;
    this.voiceBridge = voiceBridge;
    this.shared = _shared;
    this.role = this.shared? 'share' : 'viewer'
    this.managerSessionId = managerSessionId;
    this.streamName = `${this.connectionId}${this.id}-${this.role}`;
    this.mediaId;
    this.status = C.MEDIA_STOPPED;
    this.recording = {};
    this.isRecorded = false;
    this._recordingSubPath = 'recordings';
    this._cameraProfile = 'medium';
    this.candidatesQueue = [];
    this.notFlowingTimeout;
    this.isRecording = false;
    this._startRecordingEventFired = false;
    this._stopRecordingEventFired = false;
    this._stopActionQueued = false;
    this.handleMCSCoreDisconnection = this.handleMCSCoreDisconnection.bind(this);
    this.mcs.on(C.MCS_DISCONNECTED, this.handleMCSCoreDisconnection);
    this.record = record;
  }

  _getLogMetadata () {
    return {
      userId: this.bbbUserId,
      roomId: this.voiceBridge,
      internalMeetingId: this.meetingId,
      streamName: this.streamName,
      mediaId: this.mediaId,
      status: this.status,
      role: this.shared ? 'share' : 'viewer',
    };
  }

  /* ======= EXTERNAL MEDIA SOURCE TRACKING ======= */

  static setSource (id, stream) {
    Logger.info(LOG_PREFIX, `Setting new source media ${stream} of session ${id}`);
    sources[id] = stream;
    emitter.emit(C.VIDEO_SOURCE_ADDED, id);
  }

  static getSource (id) {
    return sources[id];
  }

  static removeSource (id) {
    delete sources[id];
  }

  mediaUserJoined (id) {
    emitter.emit(C.MEDIA_USER_JOINED + id);
  }

  /* ======= ICE HANDLERS ======= */

  async onIceCandidate (_candidate) {
    if (this.mediaId) {
      try {
        await this.mcs.addIceCandidate(this.mediaId, _candidate);
      }
      catch (error)   {
        this._handleError(LOG_PREFIX, error, this.role, this.id);
        Logger.error(LOG_PREFIX, `ICE candidate failed to be added for ${this.streamName}`,
          { ...this._getLogMetadata(), error });
      }
    }
    else {
      try {
      this.candidatesQueue.push(_candidate);
      } catch (error) {
        Logger.error(LOG_PREFIX, `Error on queuing ICE candidate for ${this.streamName}`,
          { ...this._getLogMetadata(), error });
      }
      Logger.trace(LOG_PREFIX, `ICE candidate for ${this.id} is going to be queued`,
        this._getLogMetadata());
    }
  };

  _onMCSIceCandidate (event, endpoint) {
    const { mediaId, candidate } = event;

    if (mediaId !== endpoint) {
      return;
    }

    this.bbbGW.publish(JSON.stringify({
      connectionId: this.connectionId,
      type: 'video',
      role: this.role,
      id : 'iceCandidate',
      cameraId: this.id,
      candidate: candidate
    }), C.FROM_VIDEO);
  }

  /* ======= MEDIA STATE HANDLERS ======= */

  _handleIceComponentStateChange (state) {
    const { rawEvent } = state;
    const {
      componentId: iceComponentId,
      source: elementId,
      state: iceComponentState
    } = rawEvent;

    Logger.info(LOG_PREFIX, `Video ICE component state changed`, {
      ...this._getLogMetadata(),
      elementId,
      iceComponentId,
      iceComponentState
    });
  }

  _handleCandidatePairSelected (state) {
    const { rawEvent } = state;
    const { candidatePair, source: elementId } = rawEvent;
    const { localCandidate, remoteCandidate, componentID: iceComponentId } = candidatePair;
    Logger.info(LOG_PREFIX, `Video new candidate pair selected`, {
      ...this._getLogMetadata(),
      elementId,
      iceComponentId,
      localCandidate,
      remoteCandidate,
    });
  }

  _handleIceGatheringDone (state) {
    const { rawEvent } = state;
    const { source: elementId } = rawEvent;
    Logger.info(LOG_PREFIX, `Video ICE gathering done`, {
      ...this._getLogMetadata(),
      elementId,
    });
  }

  _handleMediaStateChanged (state) {
    const { rawEvent, details } = state;
    const { source: elementId } = rawEvent;
    Logger.info(LOG_PREFIX, `Video media state changed`, {
      ...this._getLogMetadata(),
      elementId,
      mediaState: details,
    });
  }

  _mediaStateWebRTC (event, endpoint) {
    const { mediaId , state } = event;
    const { name, details } = state;

    if (mediaId !== endpoint) {
      return;
    }

    switch (name) {
      case "IceComponentStateChange":
        this._handleIceComponentStateChange(state);
        break;
      case "NewCandidatePairSelected":
        this._handleCandidatePairSelected(state);
        break;
      case "IceGatheringDone":
        this._handleIceGatheringDone(state);
        break;
      case "MediaStateChanged":
        this._handleMediaStateChanged(state);
        break;
      case "MediaFlowOutStateChange":
      case "MediaFlowInStateChange":
        Logger.info(LOG_PREFIX, `Video media ${endpoint} of stream ${this.streamName} received media state event`,  { ...this._getLogMetadata(),  mediaStateEvent: state});
        if (details === 'NOT_FLOWING' && this.status !== C.MEDIA_PAUSED) {
          Logger.warn(LOG_PREFIX, `Media NOT_FLOWING, setting a timeout`, this._getLogMetadata());
          if (!this.notFlowingTimeout) {
            this.notFlowingTimeout = setTimeout(() => {
              if (this.shared) {
                Logger.warn(LOG_PREFIX, "Media NOT_FLOWING timeout hit, stopping media",
                  this._getLogMetadata());
                this.sendPlayStop();
                clearTimeout(this.notFlowingTimeout);
                delete this.notFlowingTimeout;
              }
            }, config.get('mediaFlowTimeoutDuration') + Utils.randomTimeout(-2000, 2000));
          }
        }
        else if (details === 'FLOWING') {
          if (this.notFlowingTimeout) {
            Logger.warn(LOG_PREFIX, "Media FLOWING received while timeout was set, clearing it.",
              this._getLogMetadata());
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

      case C.MEDIA_SERVER_OFFLINE:
        Logger.error(LOG_PREFIX, "Video provider received MEDIA_SERVER_OFFLINE event",
          { ...this._getLogMetadata(), event });
        event.sessionId = this.streamName;
        this.emit(C.MEDIA_SERVER_OFFLINE, event);
        break;

      default: Logger.warn(LOG_PREFIX, "Unrecognized event", event);
    }
  }

  _mediaStateRecording (event, endpoint) {
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
        Logger.info(LOG_PREFIX, `Recording media received media state event on endpoint ${endpoint}`,
          { ...this._getLogMetadata(), state });
        if (details === 'NOT_FLOWING' && this.status !== C.MEDIA_PAUSED) {
          Logger.warn(LOG_PREFIX, `Recording media STOPPED FLOWING on endpoint ${endpoint}`,
            this._getLogMetadata());
        } else if (details === 'FLOWING') {
          if (!this._startRecordingEventFired) {
            const { timestampHR, timestampUTC } = state;
            this.sendStartShareEvent(timestampHR, timestampUTC);
          }
        }
        break;

      default: Logger.trace(LOG_PREFIX, "Unhandled recording event", event);
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
    this.bbbGW.publish(userCamEvent, C.TO_AKKA_APPS_CHAN_2x);

    this.bbbGW.publish(JSON.stringify({
      connectionId: this.connectionId,
      type: 'video',
      role: this.role,
      id : 'playStop',
      cameraId: this.id,
    }), C.FROM_VIDEO);
  }

  /* ======= RECORDING METHODS ======= */

  shouldRecord () {
    return this.isRecorded && this.shared && this.record;
  }

  sendStartShareEvent(timestampHR, timestampUTC) {
    const shareCamEvent = Messaging.generateWebRTCShareEvent('StartWebRTCShareEvent', this.meetingId, this.recording.filename, timestampHR, timestampUTC);
    this.bbbGW.writeMeetingKey(this.meetingId, shareCamEvent, function(error) {});
    this._startRecordingEventFired = true;
  }

  sendStopShareEvent () {
    const timestampUTC = Date.now()
    const timestampHR = Utils.hrTime();
    const stopShareEvent =
      Messaging.generateWebRTCShareEvent('StopWebRTCShareEvent', this.meetingId, this.recording.filename, timestampHR, timestampUTC);
    this.bbbGW.writeMeetingKey(this.meetingId, stopShareEvent, function(error) {});
    this._stopRecordingEventFired = true;
  }

  async startRecording () {
    return new Promise(async (resolve, reject) => {
      try {
        const cameraCodec = DEFAULT_MEDIA_SPECS.codec_video_main;
        const recordingName = `${this._cameraProfile}-${this.bbbUserId}`;
        const recordingProfile = (cameraCodec === 'VP8' || cameraCodec === 'ANY')
          ? C.RECORDING_PROFILE_WEBM
          : C.RECORDING_PROFILE_MKV;
        const format = (cameraCodec === 'VP8' || cameraCodec === 'ANY')
          ? C.RECORDING_FORMAT_WEBM
          : C.RECORDING_FORMAT_MKV;
        const recordingPath = this.getRecordingPath(
          this.meetingId,
          this._recordingSubPath,
          recordingName,
          format
        );
        const recordingId = await this.mcs.startRecording(
          this.userId,
          this.mediaId,
          recordingPath,
          { recordingProfile, ignoreThresholds: true }
        );

        this.mcs.onEvent(C.MEDIA_STATE, recordingId, (event) => {
          this._mediaStateRecording(event, recordingId);
        });

        this.recording = { recordingId, filename: recordingPath, recordingPath };
        this.isRecording = true;
        resolve(this.recording);
      }
      catch (error) {
        Logger.error(LOG_PREFIX, "Error on recording start",
          { ...this._getLogMetadata(), error });
        reject(this._handleError(LOG_PREFIX, error, this.role, this.id));
      }
    });
  }

  async stopRecording () {
    if (!this._stopRecordingEventFired) {
      this.sendStopShareEvent();
    }

    return this.mcs.stopRecording(this.userId, this.recording.recordingId);
  }

  /* ======= START/CONNECTION METHODS ======= */

  start (sdpOffer, mediaSpecs) {
    return new Promise(async (resolve, reject) => {
      if (this.status !== C.MEDIA_STOPPING && this._status !== C.MEDIA_STOPPED) {
        Logger.info(LOG_PREFIX, `Starting video instance`, this._getLogMetadata());

        this.status = C.MEDIA_STARTING;

        try {
          const isConnected = await this.mcs.waitForConnection();

          if (!isConnected) {
            return reject(errors.MEDIA_SERVER_OFFLINE);
          }

          // Probe akka-apps to see if this is to be recorded
          if (SHOULD_RECORD && this.shared) {
            this.isRecorded = await this.probeForRecordingStatus(this.meetingId, this.id);
          }

          const userId = await this.mcs.join(
            this.voiceBridge,
            'SFU',
            { externalUserId: this.bbbUserId, name: this.bbbUserName, autoLeave: true });
          this.userId = userId;
          this.mediaUserJoined(this.streamName);
          const sdpAnswer = await this._addMCSMedia(C.WEBRTC, sdpOffer, mediaSpecs);
          // Status to indicate that the brokering with mcs-core was succesfull.
          // Don't mix with MEDIA_STARTED. MEDIA_STARTED means that media is
          // flowing through the server. This just means that the session was
          // negotiated properly.
          this.status = C.MEDIA_NEGOTIATED;
          // This event is used to handle stop requests that arrived while
          // the media was still being negotiated with mcs-core.
          // See Video#stop
          emitter.emit(C.VIDEO_NEGOTIATED + this.streamName);

          this.mcs.onEvent(C.MEDIA_STATE, this.mediaId, (event) => {
            this._mediaStateWebRTC(event, this.mediaId);
          });

          this.mcs.onEvent(C.MEDIA_STATE_ICE, this.mediaId, (event) => {
            this._onMCSIceCandidate(event, this.mediaId);
          });

          this.flushCandidatesQueue(this.mcs, [...this.candidatesQueue], this.mediaId);
          this.candidatesQueue = [];

          Logger.info(LOG_PREFIX, "Video start succeeded", this._getLogMetadata());
          return resolve(sdpAnswer);
        }
        catch (error) {
          Logger.error(LOG_PREFIX, `Video start procedure failed due to ${error.message}`,
            { ...this._getLogMetadata(), error });
          this.status = C.MEDIA_NEGOTIATION_FAILED;
          reject(this._handleError(LOG_PREFIX, error, this.role, this.id));
        }
      } else {
        const error = { code: 2200, reason: errors[2200] }
        reject(this._handleError(LOG_PREFIX, error, this.role, this.id));
      };
    });
  }

  _addMCSMedia (type, descriptor, mediaSpecs) {
    return new Promise(async (resolve, reject) => {
      try {
        if (this.shared) {
          // Get the REMB spec to be used. Video uses the default mixed in with
          // the custom bitrate sent when the profile is chosen. Fetching bitrate
          // by the VP8 codec is just an arbitrary choice that makes no difference.
          // The media specs format isn't flexible enough, so that's what we have
          const kurentoRembParams = { ...KURENTO_REMB_PARAMS };
          kurentoRembParams.rembOnConnect = mediaSpecs.VP8.as_main;
          const options = {
            descriptor,
            name: this._assembleStreamName('publish', this.id, this.voiceBridge),
            mediaSpecs,
            kurentoRembParams,
          }
          const { mediaId, answer } = await this.mcs.publish(this.userId, this.voiceBridge, type, options);
          this.mediaId = mediaId;
          Video.setSource(this.id, this.mediaId);
          return resolve(answer);
        }
        else {
          const stream = Video.getSource(this.id);
          if (stream) {
            const answer = this._subscribeToMedia(descriptor, mediaSpecs);
            return resolve(answer);
          } else {
            const error = { code: 2201, reason: errors[2201] };
            Logger.warn(LOG_PREFIX, `Publisher stream from ${this.id} isn't set yet. Rejecting with MEDIA_NOT_FOUND`,
              this._getLogMetadata());
            throw error;
          }
        }
      } catch (error) {
        return reject(error);
      }
    });
  }

  async _subscribeToMedia (descriptor, mediaSpecs) {
    try {
      // Get the REMB spec to be used. Video uses the default mixed in with
      // the custom bitrate sent when the profile is chosen. Fetching bitrate
      // by the VP8 codec is just an arbitrary choice that makes no difference.
      // The media specs format isn't flexible enough, so that's what we have
      const kurentoRembParams = { ...KURENTO_REMB_PARAMS };
      kurentoRembParams.rembOnConnect = mediaSpecs.VP8.as_main;
      const options = {
        descriptor,
        name: this._assembleStreamName('subscribe', this.id, this.voiceBridge),
        mediaSpecs,
        mediaSpecSlave: SUBSCRIBER_SPEC_SLAVE,
        kurentoRembParams,
      }
      const stream = Video.getSource(this.id);
      Logger.info(LOG_PREFIX, `Subscribing to stream ${stream} from user ${this.id}`,
        this._getLogMetadata());
      const { mediaId, answer } = await this.mcs.subscribe(this.userId, stream, C.WEBRTC, options);
      this.mediaId = mediaId;
      return answer;
    }
    catch (err) {
      throw err;
    }
  }

  async pause (state) {
    const stream = Video.getSource(this.id);
    const sinkId = this.mediaId;

    // TODO temporarily deactivated this procedure until the connection type param is fixed
    return;


    // We want to pause the stream
    try {
      if (state && (this.status !== C.MEDIA_STARTING || this.status !== C.MEDIA_PAUSED)) {
        await this.mcs.disconnect(stream, sinkId, 'VIDEO');
        this.status = C.MEDIA_PAUSED;
      }
      else if (!state && this.status === C.MEDIA_PAUSED) { //un-pause
        await this.mcs.connect(stream, sinkId, 'VIDEO');
        this.status = C.MEDIA_STARTED;
      }
    }
    catch (err) {
      this._handleError(LOG_PREFIX, err, this.role, this.id);
    }
  }

  /* ======= STOP METHODS ======= */

  async _finishVideoSession (resolver) {
    this.status = C.MEDIA_STOPPING;

    try {
      if (this.shouldRecord()
        && this.isRecording
        && this.state !== C.MEDIA_STOPPED) {
        await this.stopRecording();
      }
    } catch (error) {
      Logger.warn(LOG_PREFIX, `Error on stopping recording for user ${this.userId} with stream ${this.streamName}`,
        { ...this._getLogMetadata(), error });
    }

    if (this.mediaId) {
      if (this.shared) {
        try {
          await this.mcs.unpublish(this.userId, this.mediaId);
        } catch (error) {
          Logger.error(LOG_PREFIX, `Unpublish failed for user ${this.userId} with stream ${this.streamName}`,
            { ...this._getLogMetadata(), error });
        }
        Video.removeSource(this.id);
      } else {
        try {
          await this.mcs.unsubscribe(this.userId, this.mediaId);
        } catch (error) {
          Logger.error(LOG_PREFIX, `Unsubscribe failed for user ${this.userId} with stream ${this.streamName}`,
            { ...this._getLogMetadata(), error }); }
      }
    }

    if (this.notFlowingTimeout) {
      clearTimeout(this.notFlowingTimeout);
      delete this.notFlowingTimeout;
    }

    delete this.candidatesQueue;
    emitter.emit(C.VIDEO_STOPPED + this.streamName);
    this.status = C.MEDIA_STOPPED;
    Logger.info(LOG_PREFIX, `Stopped video session ${this.streamName}`, this._getLogMetadata());
    return resolver();
  }

  async stop () {
    return new Promise(async (resolve, reject) => {
      this.mcs.removeListener(C.MCS_DISCONNECTED, this.handleMCSCoreDisconnection);

      switch (this.status) {
        case C.MEDIA_STOPPED:
          Logger.warn(LOG_PREFIX, `Video session ${this.streamName} already stopped`,
            this._getLogMetadata());
          return resolve();
          break;

        case C.MEDIA_STOPPING:
          Logger.warn(LOG_PREFIX, `Video session ${this.streamName} already stopping`,
            this._getLogMetadata());
          emitter.once(C.VIDEO_STOPPED + this.streamName, () => {
            Logger.info(LOG_PREFIX, `Calling delayed stop resolution for queued stop call for ${this.streamName}`,
              this._getLogMetadata());
            return resolve();
          });
          break;

        case C.MEDIA_STARTING:
          Logger.warn(LOG_PREFIX, `Video session ${this.streamName} is still starting. Let it finish then stop it`,
            this._getLogMetadata());
          if (!this._stopActionQueued) {
            this._stopActionQueued = true;
            emitter.once(C.VIDEO_NEGOTIATED + this.streamName, () => {
              Logger.info(LOG_PREFIX, `Calling delayed MEDIA_STARTING stop action for queued stop call for ${this.streamName}`,
                this._getLogMetadata());
              this._finishVideoSession(resolve);
            });
          } else {
            emitter.once(C.VIDEO_STOPPED + this.streamName, () => {
              Logger.info(LOG_PREFIX, `Calling delayed stop resolution for queued stop call for ${this.streamName}`,
                this._getLogMetadata());
              return resolve();
            });
          }
          break;

        default:
          Logger.info(LOG_PREFIX, `Stopping video session ${this.streamName}`, this._getLogMetadata());
          if (this.userId == null) {
            Logger.info(LOG_PREFIX, `Video session ${this.streamName} stop glare`,
              this._getLogMetadata());
            emitter.once(C.MEDIA_USER_JOINED + this.streamName, () => {
              this._finishVideoSession(resolve);
            });
          } else {
            // This method resolves this method's wrapping promise
            this._finishVideoSession(resolve);
          }
      }
    });
  }
};
