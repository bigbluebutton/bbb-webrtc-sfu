'use strict';

const path = require('path');
const config = require('config');
const { v4: uuidv4 } = require('uuid');
const C = require('../bbb/messages/Constants');
const Logger = require('../common/logger.js');
const { delay, hrTime } = require('../common/utils.js');
const Messaging = require('../bbb/messages/Messaging');
const BaseProvider = require('../base/base-provider.js');
const SHOULD_RECORD = config.get('recordWebcams');
const errors = require('../base/errors');
const {
  BBBWebRTCRecorder,
  DEFAULT_PUB_CHANNEL,
  DEFAULT_SUB_CHANNEL,
} = require('../common/bbb-webrtc-recorder.js');
const { PrometheusAgent, SFUV_NAMES } = require('./metrics/video-metrics.js');
const { addBwToSpecMainType } = require('../common/utils.js');

const DEFAULT_MEDIA_SPECS = config.get('conference-media-specs');
const SUBSCRIBER_SPEC_SLAVE = config.has('videoSubscriberSpecSlave')
  ? config.get('videoSubscriberSpecSlave')
  : false;
const KURENTO_REMB_PARAMS = config.util.cloneDeep(config.get('kurentoRembParams'));
const EJECT_ON_USER_LEFT = config.get('ejectOnUserLeft');
const IGNORE_THRESHOLDS = config.has('videoIgnoreMediaThresholds')
  ? config.get('videoIgnoreMediaThresholds')
  : false;
const DEFAULT_RECORDING_ADAPTER = config.get('recordingAdapter');
const FALLBACK_RECORDING_ADAPTER = config.has('recordingFallbackAdapter')
  ? config.get('recordingFallbackAdapter')
  : null;
const RECORDING_CARBON_COPY = config.has('recordingCarbonCopy')
  ? config.get('recordingCarbonCopy')
  : false;
const RECORDING_DRY_RUN = config.has('recordingDryRun')
  ? config.get('recordingDryRun')
  : false;
const RECORDING_FALLBACK_ON_FAILURE = config.has('recordingFallbackOnFailure')
  ? config.get('recordingFallbackOnFailure')
  : false;
const RECORDING_PLI_ON_NOT_FLOWING = config.has('recordingPliOnNotFlowing')
  ? config.get('recordingPliOnNotFlowing')
  : false;
const PLI_ON_CONNECT = config.has('pliOnConnect')
  ? config.get('pliOnConnect')
  : null;

const LOG_PREFIX = "[video]";
const RECORDING_MAX_RETRIES = 4;
const RECORDING_RETRY_DELAY = 2000;
const REC_PLI_SHOTS = 3;
const REC_PLI_FREQ = 2000;
const REC_FLOW_TIMER = 500;
const Recorder = (new BBBWebRTCRecorder(DEFAULT_PUB_CHANNEL, DEFAULT_SUB_CHANNEL)).start();

Recorder.on('recorderInstanceStopped', () => {
  PrometheusAgent.set(SFUV_NAMES.RECORDER_STATUS, 0);
  PrometheusAgent.increment(SFUV_NAMES.RECORDER_RESTARTS);
});

Recorder.on('recorderInstanceStarted', () => {
  PrometheusAgent.set(SFUV_NAMES.RECORDER_STATUS, 1);
});

const VIDEO_SOURCES = new Map();

module.exports = class Video extends BaseProvider {
  static processRecordingAdapter (adapter) {
    switch (adapter) {
      case 'bbb-webrtc-recorder':
      case 'native':
      case 'Kurento':
        return adapter;
      default:
        return DEFAULT_RECORDING_ADAPTER;
    }
  }

  constructor(
    bbbGW,
    meetingId,
    cameraId,
    role,
    connectionId,
    mcs,
    voiceBridge,
    bbbUserId,
    managerSessionId,
    record,
    mediaServer,
    recordingAdapter,
  ) {
    super(bbbGW);
    this.sfuApp = C.VIDEO_APP;
    this.mcs = mcs;
    this.id = cameraId;
    this.bbbUserId = bbbUserId;
    this.connectionId = connectionId;
    this.meetingId = meetingId;
    this.voiceBridge = voiceBridge;
    this.role = role;
    this.shared = this.role === 'share' ? true : false;
    this.managerSessionId = managerSessionId;
    this.streamName = `${this.connectionId}${this.id}-${this.role}`;
    this.mediaId;
    this.status = C.MEDIA_STOPPED;
    this.recording = {};
    this.recordingCopyData = null;
    this.isMeetingRecorded = false;
    this.isMeetingRecording = false;
    this.recordFullDurationMedia = false;
    this._recordingSubPath = 'recordings';
    this._cameraProfile = 'medium';
    this.candidatesQueue = [];
    this.notFlowingTimeout;
    this.isRecording = false;
    this._startRecordingEventFired = false;
    this._stopRecordingEventFired = false;
    this._recordingRetries = 0;
    this._stopActionQueued = false;
    this.record = record;
    this.mediaServerAdapter = mediaServer;
    this.recordingAdapter = Video.processRecordingAdapter(recordingAdapter);
    this.hgaRecordingSet = {
      nativeSubMediaId: null, // ?: string (<T>)
      hgaPubMediaId: null, // ?: string (<T>)
    };
    this.bbbWebRTCRecorderSet = {
      nativeSubMediaId: null, // ?: string (<T>)
      recordingSessionId: null, // ?: string (<T>)
    };
    this._pliInterval = null;

    this._bindEventHandlers();
    this._trackBigBlueButtonEvents();
    this._trackMCSEvents();
  }

  _bindEventHandlers () {
    this.handleMCSCoreDisconnection = this.handleMCSCoreDisconnection.bind(this);
    this.disconnectUser = this.disconnectUser.bind(this);
    this._handleCamUnsubscribeSysMsg = this._handleCamUnsubscribeSysMsg.bind(this);
    this._handleCamBroadcastStopSysMsg = this._handleCamBroadcastStopSysMsg.bind(this);
    this.handleRecorderRtpStatusChange = this.handleRecorderRtpStatusChange.bind(this);
    this.handleRecordingStopped = this.handleRecordingStopped.bind(this);
    this._handleBBBRecordingStatusChanged = this._handleBBBRecordingStatusChanged.bind(this);
  }

  _trackMCSEvents () {
    this.mcs.on(C.MCS_DISCONNECTED, this.handleMCSCoreDisconnection);
  }

  _untrackMCSEvents () {
    this.mcs.removeListener(C.MCS_DISCONNECTED, this.handleMCSCoreDisconnection);
  }

  _untrackBigBlueButtonEvents () {
    this.bbbGW.removeListener(C.DISCONNECT_ALL_USERS_2x+this.meetingId, this.disconnectUser);
    this.bbbGW.removeListener(C.USER_LEFT_MEETING_2x+this.bbbUserId, this.disconnectUser);
    this.bbbGW.removeListener(C.RECORDING_STATUS_CHANGED_EVT_MSG+this.meetingId, this._handleBBBRecordingStatusChanged);
    this._untrackCamUnsubscribeSysMsg();
    this._untrackCamBroadcastStopSysMsg();
  }

  _trackBigBlueButtonEvents () {
    if (EJECT_ON_USER_LEFT) {
      this.bbbGW.once(C.USER_LEFT_MEETING_2x+this.bbbUserId, this.disconnectUser);
    }
    this.bbbGW.once(C.DISCONNECT_ALL_USERS_2x+this.meetingId, this.disconnectUser);
    this.bbbGW.on(C.RECORDING_STATUS_CHANGED_EVT_MSG+this.meetingId, this._handleBBBRecordingStatusChanged);

    this._trackCamUnsubscribeSysMsg();
    this._trackCamBroadcastStopSysMsg();
  }

  _handleBBBRecordingStatusChanged ({ recording }) {
    this.isMeetingRecording = recording;

    if (!this.isRecording && this.shouldRecord()) {
      Logger.info('BBB recording status changed to true, starting recording', {
        isMeetingRecording: this.isMeetingRecording,
        isMeetingRecorded: this.isMeetingRecorded,
        recordFullDurationMedia: this.recordFullDurationMedia,
        recordingAdapter: this._getRecordingAdapter(),
      });

      this.startRecording({ eventOnFlow: true }).catch(error => {
        Logger.error('Recording start failed', {
          recordingAdapter: this._getRecordingAdapter(),
          errorMessage: error?.message,
          errorStack: error?.stack,
          ...this._getLogMetadata(),
        });
      });
    } else if (this.isRecording && !this.shouldRecord()) {
      Logger.info('BBB recording status changed to false, stopping recording', {
        isMeetingRecording: this.isMeetingRecording,
        isMeetingRecorded: this.isMeetingRecorded,
        recordFullDurationMedia: this.recordFullDurationMedia,
        recordingAdapter: this._getRecordingAdapter(),
      });

      this.stopRecording().catch((error) => {
        Logger.error('Recording stop failed', {
          recordingAdapter: this._getRecordingAdapter(),
          errorMessage: error?.message,
          errorStack: error?.stack,
          ...this._getLogMetadata(),
        });
      });
    }
  }

  async _handleCamUnsubscribeSysMsg () {
    try {
      Logger.info('Disconnecting a subscriber session on CamStreamUnsubscribeSysMsg',
        this._getLogMetadata());
      await this.stop();
    } catch (error) {
      Logger.warn('Failed to disconnect subscriber session on CamStreamUnsubscribeSysMsg',
        { ...this._getLogMetadata(), error });
    }
  }

  _trackCamUnsubscribeSysMsg () {
    const eventName = `${C.CAM_STREAM_UNSUBSCRIBE_SYS_MSG}-${this.bbbUserId}-${this.id}`;
    this.bbbGW.once(eventName, this._handleCamUnsubscribeSysMsg);
  }

  _untrackCamUnsubscribeSysMsg () {
    const eventName = `${C.CAM_STREAM_UNSUBSCRIBE_SYS_MSG}-${this.bbbUserId}-${this.id}`;
    this.bbbGW.removeListener(eventName, this._handleCamUnsubscribeSysMsg);
  }

  async _handleCamBroadcastStopSysMsg () {
    try {
      Logger.info('Disconnecting a publisher session on CamBroadcastStopSysMsg',
        this._getLogMetadata());
      await this.stop();
    } catch (error) {
      Logger.warn('Failed to disconnect publisher session on CamBroadcastStopSysMsg',
        { ...this._getLogMetadata(), error });
    }
  }

  _trackCamBroadcastStopSysMsg () {
    const eventName = `${C.CAM_BROADCAST_STOP_SYS_MSG}-${this.bbbUserId}-${this.id}`;
    this.bbbGW.once(eventName, this._handleCamBroadcastStopSysMsg);
  }

  _untrackCamBroadcastStopSysMsg () {
    const eventName = `${C.CAM_BROADCAST_STOP_SYS_MSG}-${this.bbbUserId}-${this.id}`;
    this.bbbGW.removeListener(eventName, this._handleCamBroadcastStopSysMsg);
  }

  _getMediaSpecs (suggestedBitrate) {
    try {
      const baseSpecs = this.role === 'share'
        ? DEFAULT_MEDIA_SPECS
        : (Video.getSource(this.id)?.mediaSpecs || DEFAULT_MEDIA_SPECS);
      const extensibleSpecs = config.util.cloneDeep(baseSpecs);

      if (this.role === 'share' && suggestedBitrate != null && suggestedBitrate > 0) {
        return addBwToSpecMainType(extensibleSpecs, suggestedBitrate);
      }

      return extensibleSpecs;
    } catch (error) {
      Logger.warn('Error on getting media specs', { ...this._getLogMetadata(), error });
      return DEFAULT_MEDIA_SPECS;
    }
  }

  set status (status) {
    this._status = status;
    this.emit(status);
  }

  get status () {
    return this._status;
  }

  _getLogMetadata () {
    return {
      userId: this.bbbUserId,
      roomId: this.voiceBridge,
      internalMeetingId: this.meetingId,
      streamName: this.streamName,
      mediaId: this.mediaId,
      status: this.status,
      role: this.role,
      cameraId: this.id,
      connectionId: this.connectionId,
      sessionId: this.managerSessionId,
    };
  }

  /* ======= EXTERNAL MEDIA SOURCE TRACKING ======= */

  static setSource (id, source) {
    if (source == null) {
      Logger.warn('Camera source set with null source', { cameraId: id });
      return false;
    }

    Logger.debug('New camera source set', { cameraId: id, mediaId: source?.mediaId });
    VIDEO_SOURCES.set(id, source);

    return true;
  }

  static getSource (id) {
    return VIDEO_SOURCES.get(id);
  }

  static hasSource (id) {
    return VIDEO_SOURCES.has(id);
  }

  static removeSource (id) {
    Logger.debug('Camera source removed', { cameraId: id });
    return VIDEO_SOURCES.delete(id);
  }

  /* ======= ICE HANDLERS ======= */

  processAnswer (answer) {
    const { mediaId: stream } = Video.getSource(this.id);
    return this.mcs.subscribe(this.userId, stream, C.WEBRTC, { ...this.options, descriptor: answer, mediaId: this.mediaId });
  }

  async onIceCandidate (_candidate) {
    if (this.mediaId) {
      try {
        await this.mcs.addIceCandidate(this.mediaId, _candidate);
      }
      catch (error)   {
        this._handleError(LOG_PREFIX, error, this.role, this.id);
        Logger.error(`ICE candidate failed to be added for ${this.streamName}`,
          { ...this._getLogMetadata(), error });
      }
    }
    else {
      try {
      this.candidatesQueue.push(_candidate);
      } catch (error) {
        Logger.error(`Error on queuing ICE candidate for ${this.streamName}`,
          { ...this._getLogMetadata(), error });
      }
    }
  }

  _onMCSIceCandidate (event, endpoint) {
    const { mediaId, candidate } = event;

    if (mediaId !== endpoint) {
      return;
    }

    this.sendToClient({
      connectionId: this.connectionId,
      type: 'video',
      role: this.role,
      id : 'iceCandidate',
      cameraId: this.id,
      candidate: candidate
    }, C.FROM_VIDEO);
  }

  /* ======= MEDIA STATE HANDLERS ======= */

  _handleMediaStateChanged (state) {
    const { rawEvent, details } = state;
    const { source: elementId } = rawEvent;
    Logger.info(`Video media state changed`, {
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
      case "MediaStateChanged":
        this._handleMediaStateChanged(state);
        break;
      case "MediaFlowOutStateChange":
      case "MediaFlowInStateChange":
        if (details === 'NOT_FLOWING' && this.status !== C.MEDIA_PAUSED) {
          if (!this.notFlowingTimeout) {
            Logger.debug("Media NOT_FLOWING, setting a timeout", this._getLogMetadata());
            this.notFlowingTimeout = setTimeout(() => {
              if (this.shared) {
                Logger.warn("Media NOT_FLOWING timeout hit, stopping media",
                  this._getLogMetadata());
                this.sendPlayStop();
                clearTimeout(this.notFlowingTimeout);
                delete this.notFlowingTimeout;
              }
            }, config.get('mediaFlowTimeoutDuration'));
          }
        }
        else if (details === 'FLOWING') {
          if (this.notFlowingTimeout) {
            Logger.debug("Media FLOWING received while timeout was set, clearing it",
              this._getLogMetadata());
            clearTimeout(this.notFlowingTimeout);
            delete this.notFlowingTimeout;
          }
          if (this.status !== C.MEDIA_STARTED) {
            this.status = C.MEDIA_STARTED;
            this.sendPlayStart();
            // Record the video stream if it's the original being shared
            if (this.shouldRecord()) {
              this.startRecording({ eventOnFlow: false }).catch(error => {
                Logger.error('Recording start failed', {
                  recordingAdapter: this._getRecordingAdapter(),
                  errorMessage: error?.message,
                  errorStack: error?.stack,
                  ...this._getLogMetadata(),
                });
              });
            }
          }
        }
        break;

      case C.MEDIA_SERVER_OFFLINE:
        Logger.error("Video provider received MEDIA_SERVER_OFFLINE event",
          { ...this._getLogMetadata(), event });
        event.sessionId = this.streamName;
        this.emit(C.MEDIA_SERVER_OFFLINE, event);
        break;

      default: Logger.trace("Unrecognized event", event);
    }
  }

  _handleHGARecStateChange (event, endpoint, {
    filename = this.recording?.filename,
  } = {}) {
    const { mediaId , state } = event;
    const { name, details, rawEvent } = state;

    if (mediaId !== endpoint) {
      return;
    }

    switch (name) {
      case "MediaStateChanged":
        break;
      case "MediaFlowOutStateChange":
      case "MediaFlowInStateChange":
        if (details === 'NOT_FLOWING' && this.status !== C.MEDIA_PAUSED) {
          Logger.warn(`Recording media STOPPED FLOWING on endpoint ${endpoint}`,
            this._getLogMetadata());

          if (RECORDING_PLI_ON_NOT_FLOWING && this.hgaRecordingSet.flowTracker == null) {
            this.hgaRecordingSet.flowTracker = setTimeout(() => {
              this._pliSalvo(
                this.hgaRecordingSet.nativeSubMediaId,
                REC_PLI_SHOTS,
                REC_PLI_FREQ, {
                  fastStart: true,
                },
              );
            }, REC_FLOW_TIMER);
          }
        } else if (details === 'FLOWING') {
          Logger.debug(`Recording media STARTED FLOWING on endpoint ${endpoint}`,
            this._getLogMetadata());
          this._clearPliSalvo();

          if (this.hgaRecordingSet.flowTracker) {
            clearTimeout(this.hgaRecordingSet.flowTracker);
            this.hgaRecordingSet.flowTracker = null;
          }

          if (this.recordFullDurationMedia === false && !this._startRecordingEventFired) {
            this.sendStartShareEvent({
              filename,
              timestampHR: state?.timestampHR,
              timestampUTC: rawEvent?.timestampMillis,
            });
          }
        }
        break;

      case C.MEDIA_SERVER_OFFLINE:
        Logger.error('Recording stopped abruptly: MEDIA_SERVER_OFFLINE', {
          ...this._getLogMetadata(),
          reason: C.MEDIA_SERVER_OFFLINE,
          recordingAdapter: this._getRecordingAdapter(),
        });
        PrometheusAgent.increment(SFUV_NAMES.RECORDING_ERRORS, {
          recordingAdapter: this._getRecordingAdapter(),
          error: C.MEDIA_SERVER_OFFLINE,
        });
        // Cleanup and restart
        this.stopRecording().finally(() => {
          setTimeout(() => {
            this.startRecording({ eventOnFlow: true }).catch((error) => {
              Logger.error('Recording recovery failed,', {
                retries: this._recordingRetries,
                recordingAdapter: this._getRecordingAdapter(),
                errorMessage: error?.message,
                errorStack: error?.stack,
                ...this._getLogMetadata(),
              });
            });
          }, RECORDING_RETRY_DELAY);
        });
        break;

      case "Recording":
        break;

      default: Logger.trace("Unhandled recording event", event);
    }
  }

  sendPlayStart () {
    if (!this.shared) {
      this.sendCamStreamSubscribedInSfuEvtMsg(
        this.meetingId,
        this.bbbUserId,
        this.id,
        this.mediaId,
        this.streamName,
      )
    }

    this.sendToClient({
       connectionId: this.connectionId,
       type: 'video',
       role: this.role,
       id : 'playStart',
       cameraId: this.id,
    }, C.FROM_VIDEO);
  }

  sendBroadcastCamStop () {
    // TODO move parameter checking to the messaging interface
    if (typeof this.meetingId === 'string'
      && typeof this.bbbUserId === 'string'
      && typeof this.id === 'string') {
      const userCamEvent = Messaging.generateUserCamBroadcastStoppedEventMessage2x(
        this.meetingId,
        this.bbbUserId,
        this.id
      );

      this.bbbGW.publish(userCamEvent, C.TO_AKKA_APPS_CHAN_2x);
    }
  }

  sendCamBroadcastStoppedInSfuEvtMsg (meetingId, userId, streamId) {
    const msg = Messaging.generateCamBroadcastStoppedInSfuEvtMsg(
      meetingId, userId, streamId,
    );

    this.bbbGW.publish(msg, C.FROM_SFU);
  }

  sendCamStreamSubscribedInSfuEvtMsg (
    meetingId, userId, streamId, subscriberStreamId, sfuSessionId,
  ) {
    const msg = Messaging.generateCamStreamSubscribedInSfuEvtMsg(
      meetingId, userId, streamId, subscriberStreamId, sfuSessionId
    );

    this.bbbGW.publish(msg, C.FROM_SFU);
  }

  sendCamStreamUnsubscribedInSfuEvtMsg (
    meetingId, userId, streamId, subscriberStreamId, sfuSessionId,
  ) {
    const msg = Messaging.generateCamStreamUnsubscribedInSfuEvtMsg(
      meetingId, userId, streamId, subscriberStreamId, sfuSessionId
    );

    this.bbbGW.publish(msg, C.FROM_SFU);
  }

  sendPlayStop () {
    this.sendToClient({
      connectionId: this.connectionId,
      type: 'video',
      role: this.role,
      id : 'playStop',
      cameraId: this.id,
    }, C.FROM_VIDEO);

    // This is a stop request
    this.sendBroadcastCamStop();
  }

  /* ======= RECORDING METHODS ======= */

  _requestKeyframe (mediaId) {
    return this.mcs.requestKeyframe(mediaId).catch((error) => {
      Logger.warn(`requestKeyframe failed for ${mediaId}: ${error.message}`, {
        ...this._getLogMetadata(),
        error,
      });
    });
  }

  _pliSalvo (endpoint, shots, freq, { fastStart = false } = {}) {
    if (this._pliInterval || endpoint == null) return;
    let iterations = 0;

    Logger.warn(`Firing recording PLI salvo: ${endpoint}`, this._getLogMetadata());

    if (fastStart) {
      this._requestKeyframe(endpoint);
      iterations++;
    }

    this._pliInterval = setInterval(() => {
      if (iterations >= shots) {
        this._clearPliSalvo();
      } else {
        iterations++;
        this._requestKeyframe(endpoint);
      }
    }, freq);
  }

  _clearPliSalvo () {
    if (this._pliInterval) {
      clearInterval(this._pliInterval);
      this._pliInterval = null;
    }
  }

  shouldRecord () {
    const recordable = RECORDING_DRY_RUN || (
      this.isMeetingRecorded
      && (this.isMeetingRecording || this.recordFullDurationMedia)
      && this.record
    );

    return recordable
      && this.shared
      && this.status === C.MEDIA_STARTED
      && this._recordingRetries < RECORDING_MAX_RETRIES;
  }

  sendStartShareEvent({
    filename,
    timestampHR = hrTime(),
    timestampUTC = Date.now(),
  } = {}) {
    if (RECORDING_DRY_RUN) return false;

    if (filename == null) {
      Logger.warn('Filename is required to send start share event', {
        ...this._getLogMetadata(),
        recordingAdapter: this._getRecordingAdapter(),
      });
      return false;
    }

    if (timestampHR == null) {
      timestampHR = hrTime();
    }

    if (timestampUTC == null) {
      timestampUTC = Date.now()
    }

    // Reset recording retries - it worked
    this._recordingRetries = 0;
    const shareEvent = Messaging.generateWebRTCShareEvent(
      'StartWebRTCShareEvent',
      this.meetingId,
      filename,
      timestampHR,
      timestampUTC,
      this.bbbUserId,
    );
    this.bbbGW.writeMeetingKey(this.meetingId, shareEvent, function() {});
    this._startRecordingEventFired = true;

    return true;
  }

  sendStopShareEvent ({
    timestampHR = hrTime(),
    timestampUTC = Date.now(),
  } = {}) {
    if (this._stopRecordingEventFired
      || !this.isRecording
      || !this._startRecordingEventFired
      || RECORDING_DRY_RUN) {
      return false;
    }

    const stopShareEvent = Messaging.generateWebRTCShareEvent(
      'StopWebRTCShareEvent',
      this.meetingId,
      this.recording.filename,
      timestampHR,
      timestampUTC,
      this.bbbUserId,
    );
    this.bbbGW.writeMeetingKey(this.meetingId, stopShareEvent, function() {});
    this._startRecordingEventFired = false;
    this._stopRecordingEventFired = true;
    this.isRecording = false;

    return true;
  }

  async _stopWebRTCRecorder () {
    const { nativeSubMediaId, recordingSessionId } = this.bbbWebRTCRecorderSet;

    if (nativeSubMediaId) {
      try {
        await this.mcs.unsubscribe(this.userId, nativeSubMediaId);
      } catch(error) {
        Logger.error("bbb-webrtc-recorder: native recording subscriber cleanup failure",
          { ...this._getLogMetadata(), error, recordingAdapter: this._getRecordingAdapter() });
      } finally {
        this.bbbWebRTCRecorderSet.nativeSubMediaId = null;
      }
    }

    if (recordingSessionId) {
      try {
        // TODO use reason
        const { timestampUTC, timestampHR } = await Recorder.stopRecording(recordingSessionId);
        return { timestampUTC, timestampHR };
      } catch(error) {
        Logger.error("bbb-webrtc-recorder: recorder stop failure",
          { ...this._getLogMetadata(), error, recordingAdapter: this._getRecordingAdapter() });
      } finally {
        this.bbbWebRTCRecorderSet.recordingSessionId = null;
      }
    }

    return { timestampHR: hrTime(), timestampUTC: Date.now() };
  }

  handleRecordingStopped ({ reason, recordingSessionId }) {
    if (recordingSessionId !== this.bbbWebRTCRecorderSet.recordingSessionId) return;

    switch (reason) {
      // Retry
      case 'closed':
      case 'disconnected':
      case 'recorderCrash':
        PrometheusAgent.increment(SFUV_NAMES.RECORDING_ERRORS, {
          recordingAdapter: this._getRecordingAdapter(),
          error: reason,
        });
        Logger.error(`bbb-webrtc-recorder: stopped abruptly: ${reason}`, {
          ...this._getLogMetadata(),
          reason,
          recordingAdapter: this._getRecordingAdapter(),
          recordingSessionId,
        });
        // Recording session ceased to be
        this.bbbWebRTCRecorderSet.recordingSessionId = null;
        // Cleanup and restart
        this.stopRecording().finally(() => {
          this.startRecording({ eventOnFlow: true }).catch((error) => {
            Logger.error('Recording recovery failed,', {
              reason,
              recordingSessionId,
              retries: this._recordingRetries,
              recordingAdapter: this._getRecordingAdapter(),
              errorMessage: error?.message,
              errorStack: error?.stack,
              ...this._getLogMetadata(),
            });
          });
        });
        break;
      // Final
      case 'stop requested':
      case 'session not found':
      default:
        return;
    }
  }

  handleRecorderRtpStatusChange(event) {
    const {
      recordingSessionId,
      status,
      timestampUTC,
      timestampHR,
      filename = this.recording?.filename,
    } = event;

    switch (status) {
      case "flowing":
        Logger.debug(`Recording media FLOWING for ${recordingSessionId}`,
          this._getLogMetadata());
        if (!this._startRecordingEventFired) {
          Logger.debug('Firing recording event via flowing event',
            this._getLogMetadata());
          this.sendStartShareEvent({ filename });
        }
        break;
      case "not_flowing":
        Logger.debug(`Recording media NOT FLOWING for ${recordingSessionId}`,
this._getLogMetadata());
        break;

      default: Logger.trace("Unhandled recording event", status);
    }
  }

  async _recordViaWebRTCRecorder (sourceMediaId, recordingPath, {
    filename,
    carbonCopy = false,
  }) {
    const recordingSessionId = uuidv4();

    // Step 1
    const nativeOptions = {
      mediaSpecSlave: SUBSCRIBER_SPEC_SLAVE,
      profiles: {
        video: 'recvonly',
      },
      mediaProfile: 'main',
      adapter: this.mediaServerAdapter,
      ignoreThresholds: true,
    };

    const {  mediaId: nativeMediaId, answer: nativeDescriptor } = await this.mcs.subscribe(
      this.userId, sourceMediaId, C.WEBRTC, nativeOptions
    );
    this.bbbWebRTCRecorderSet.nativeSubMediaId = nativeMediaId;

    // Step 2
    // Notice that we're ignoring the full file path (_recordingPath)
    // because the base directory is pre-set in bbb-webrtc-recorder
    const { answer, responseFileName } = await Recorder.startRecording(
      recordingSessionId,
      filename,
      nativeDescriptor, {
        recordingStoppedHdlr: !carbonCopy ? this.handleRecordingStopped : null,
        rtpStatusChangedHdlr: !carbonCopy
          ? (event) => { this.handleRecorderRtpStatusChange({ ...event, filename: responseFileName }); }
          : null,
      },
    );
    this.bbbWebRTCRecorderSet.recordingSessionId = recordingSessionId;

    // Step 3
    nativeOptions.descriptor = answer;
    nativeOptions.mediaId = nativeMediaId;
    await this.mcs.subscribe(this.userId, sourceMediaId, C.WEBRTC, nativeOptions);

    return {
      recordingId: recordingSessionId,
      filename: responseFileName,
      recordingPath,
    };
  }

  // Stop recordings via eg Kurento
  async _stopHGARecordingSet () {
    const { nativeSubMediaId, hgaPubMediaId, flowTracker } = this.hgaRecordingSet;

    if (flowTracker) {
      clearTimeout(flowTracker);
      this.hgaRecordingSet.flowTracker = null;
    }

    if (nativeSubMediaId) {
      try {
        await this.mcs.unsubscribe(this.userId, nativeSubMediaId);
      } catch(error) {
        Logger.error("HGA: native recording subscriber cleanup failure?",
          { ...this._getLogMetadata(), error, recordingAdapter: this._getRecordingAdapter() });
      } finally {
        this.hgaRecordingSet.nativeSubMediaId = null;
      }
    }

    if (hgaPubMediaId) {
      try {
        await this.mcs.unpublish(this.userId, hgaPubMediaId);
      } catch(error) {
        Logger.error("HGA: hga recording publisher cleanup failure?",
          { ...this._getLogMetadata(), error, recordingAdapter: this._getRecordingAdapter() });
      } finally {
        this.hgaRecordingSet.hgaPubMediaId = null;
      }
    }
  }
  // eg Record via Kurento
  async _recordViaHGAdapter (sourceMediaId, recordingPath, recordingOptions) {
    // 1 - Generate a subscriber/consumer media session in the native adapter
    // 2 - Generate a publisher media session in the heterogeneous adapter
    //     (this.recordingAdapter) with the offer from #1
    // 3 - Send back the answer from #2 to the native adapter
    // 4 - Call startRecording in the heterogeneous adapter (this.recordingAdapter),
    //     specifying the source to be the mediaSessionId obtained in #2

    // Step 1
    const nativeOptions = {
      mediaSpecSlave: SUBSCRIBER_SPEC_SLAVE,
      profiles: {
        video: 'sendrecv',
      },
      mediaProfile: 'main',
      adapter: this.mediaServerAdapter,
      ignoreThresholds: true,
      adapterOptions: {
        transportOptions: {
          rtcpMux: false,
          comedia: false,
        },
        // Up the chances that rtcp-fb is signaled on the remote end
        msHackRTPAVPtoRTPAVPF: true,
      }
    };

    const {  mediaId: nativeMediaId, answer: nativeDescriptor } = await this.mcs.subscribe(
      this.userId, sourceMediaId, C.RTP, nativeOptions
    );
    this.hgaRecordingSet.nativeSubMediaId = nativeMediaId;

    // Step 2
    const hgaOptions = {
      descriptor: nativeDescriptor,
      adapter: recordingOptions.adapter || this._getRecordingAdapter(),
      ignoreThresholds: true,
      profiles: {
        video: 'sendonly',
      },
      mediaProfile: 'main',
      // Disable REMB for recordings; unless there are buffer issues, we don't
      // need it because the connection is internal
      adapterOptions: {
        kurentoRemoveRembRtcpFb: true,
      }
    };

    const { mediaId: hgaMediaId, answer: hgaAnswer } = await this.mcs.publish(
      this.userId, this.voiceBridge, C.RTP, hgaOptions,
    );
    this.hgaRecordingSet.hgaPubMediaId = hgaMediaId;

    if (!recordingOptions.carbonCopy) {
      this.mcs.onEvent(C.MEDIA_STATE, hgaMediaId, (event) => {
        this._handleHGARecStateChange(event, hgaMediaId, {
          filename: recordingPath,
        });
      });
    }

    // Step 3
    nativeOptions.descriptor = hgaAnswer;
    nativeOptions.mediaId = nativeMediaId;
    await this.mcs.subscribe(this.userId, sourceMediaId, C.RTP, nativeOptions);

    // Step 4 - Hoo-ah!
    if (recordingOptions.adapter == null) {
      recordingOptions.adapter = this._getRecordingAdapter();
    }

    return this._recordViaMCS(hgaMediaId, recordingPath, recordingOptions);
  }

  async _recordViaMCS (sourceMediaId, recordingPath, options) {
    if (options.adapter == null) {
      options.adapter = this.mediaServerAdapter;
    }

    const recordingId = await this.mcs.startRecording(
      this.userId, sourceMediaId, recordingPath, options,
    );

    if (this.hgaRecordingSet.nativeSubMediaId) {
      this._pliSalvo(
        this.hgaRecordingSet.nativeSubMediaId,
        1,
        REC_PLI_FREQ, {
          fastStart: true,
        },
      );
    }

    if ((this.recordFullDurationMedia || (!options.eventOnFlow && !this._startRecordingEventFired))
      && options.carbonCopy !== true) {
      this.sendStartShareEvent({ filename: recordingPath });
    }

    return { recordingId, filename: recordingPath, recordingPath };
  }

  _getRecordingAdapter () {
    if (this.recordingAdapter === 'native' || this.recordingAdapter === this.mediaServerAdapter) {
      return this.mediaServerAdapter;
    }

    return this.recordingAdapter;
  }

  _getRecordingMethod (adapter) {
    // Native == use the source media adapter (eg cam in Kurento, record via Kurento)
    // bbb-webrtc-recorder == use bbb-webrtc-recorder (works outside the mcs-core scope)
    // default => it's a regular heterogeneous adapter, ie recording adapter !== source
    //   adapter. e.g.: cam in mediasoup, record via Kurento
    switch (adapter) {
      case 'native':
      case this.mediaServerAdapter:
        return this._recordViaMCS.bind(this);
      case 'bbb-webrtc-recorder':
        return this._recordViaWebRTCRecorder.bind(this);
      default:
        return this._recordViaHGAdapter.bind(this);
    }
  }

  async _startRecording (options = {}) {
    this._recordingRetries++;
    const { eventOnFlow = false } = options;
    const cameraCodec = DEFAULT_MEDIA_SPECS.codec_video_main;
    const recordingName = `${this._cameraProfile}-${this.bbbUserId}`;
    const recordingProfile = (cameraCodec === 'VP8' || cameraCodec === 'ANY')
      ? C.RECORDING_PROFILE_WEBM_VIDEO_ONLY
      : C.RECORDING_PROFILE_MKV_VIDEO_ONLY;
    const format = (cameraCodec === 'VP8' || cameraCodec === 'ANY')
      ? C.RECORDING_FORMAT_WEBM
      : C.RECORDING_FORMAT_MKV;
    const recordingAdapter = this._getRecordingAdapter();
    const _startRecording = this._getRecordingMethod(recordingAdapter);
    const filename = this.getRecordingFilePathSuffix(
      this.meetingId,
      this._recordingSubPath,
      recordingName,
      format
    );
    const recordingPath = this.getFullRecordingPath(this.getRecordingBaseDir(recordingAdapter), filename);
    const recordingOptions = {
      recordingProfile,
      ignoreThresholds: true,
      filename,
      eventOnFlow,
      carbonCopy: false,
    };
    this._startRecordingEventFired = false;
    this._stopRecordingEventFired = false;

    if (RECORDING_CARBON_COPY) {
      this._startRecordingCopy(
        this.mediaId,
        filename,
        format,
        recordingOptions,
      );
    }

    const recordingData = await _startRecording(
      this.mediaId,
      recordingPath,
      recordingOptions
    );
    this.recording = recordingData;
    this.isRecording = true;

    return recordingData;
  }

  async startRecording (options = {}) {
    return this._startRecording(options).catch((error) => {
      PrometheusAgent.increment(SFUV_NAMES.RECORDING_ERRORS, {
        recordingAdapter: this._getRecordingAdapter(),
        error: error?.message || 'unknown',
      });

      return this.stopRecording().finally(() => {
        return delay((RECORDING_RETRY_DELAY * Math.max(1, this._recordingRetries))).then(() => {
          if (this.shouldRecord()) {
            Logger.error('Recording start failed, retrying', {
              retries: this._recordingRetries,
              recordingAdapter: this._getRecordingAdapter(),
              errorMessage: error?.message,
              errorStack: error?.stack,
              ...this._getLogMetadata(),
            });
            return this.startRecording({ eventOnFlow: true });
          } else {
            if (RECORDING_FALLBACK_ON_FAILURE && this._isFallbackAdapterValid()) {
              Logger.error('Recording retries expired, falling back to alternative adapter', {
                recordingAdapter: this._getRecordingAdapter(),
                fallbackAdapter: FALLBACK_RECORDING_ADAPTER,
                retries: this._recordingRetries,
                ...this._getLogMetadata(),
              });
              this._recordingRetries = 0;
              this._originalRecordingAdapter = this._getRecordingAdapter();
              this.recordingAdapter = FALLBACK_RECORDING_ADAPTER;
              return this.startRecording({ eventOnFlow: true });
            } else {
              Logger.error('Recording retries expired', {
                recordingAdapter: this._getRecordingAdapter(),
                retries: this._recordingRetries,
                ...this._getLogMetadata(),
              });

              if (this._originalRecordingAdapter) {
                this.recordingAdapter = this._originalRecordingAdapter;
                this._originalRecordingAdapter = null;
              }

              return Promise.reject('Recording retries expired');
            }
          }
        });
      });
    });
  }

  _isFallbackAdapterValid () {
    const recordingMethod = this._getRecordingMethod(FALLBACK_RECORDING_ADAPTER);

    return !(
      FALLBACK_RECORDING_ADAPTER == null
      || FALLBACK_RECORDING_ADAPTER === this._getRecordingAdapter()
      || recordingMethod === this._getRecordingMethod(this._getRecordingAdapter())
    );
  }

  _shouldDoCarbonCopy  () {
    return RECORDING_CARBON_COPY && this._isFallbackAdapterValid();
  }

  _startRecordingCopy(sourceMediaId, filename, recordingFormat, recordingOptions) {
    try {
      if (!this._shouldDoCarbonCopy()) return;

      const extension = path.extname(filename);
      const dirname = path.dirname(filename);
      const baseFileName = path.basename(filename, extension);
      const copyFileName = `${baseFileName}-copy${extension}`;
      const _startRecording = this._getRecordingMethod(FALLBACK_RECORDING_ADAPTER);

      const copyPath = this.getFullRecordingPath(
        this.getRecordingBaseDir(FALLBACK_RECORDING_ADAPTER),
        path.join(dirname, copyFileName),
      );
      const copyOptions = {
        ...recordingOptions,
        filename: copyFileName,
        carbonCopy: true,
        adapter: FALLBACK_RECORDING_ADAPTER,
      };

      _startRecording(sourceMediaId, copyPath, copyOptions).then((recordingData) => {
        this.recordingCopyData = recordingData;
        Logger.info('Recording copy started', { file: copyPath, ...this._getLogMetadata() });
      }).catch((error) => {
        Logger.warn('Error starting recording copy',
          { ...this._getLogMetadata(), FALLBACK_RECORDING_ADAPTER, filename, error });
      });
    } catch (error) {
      Logger.warn('Error starting recording copy',
        { ...this._getLogMetadata(), FALLBACK_RECORDING_ADAPTER, filename, error });
    }
  }

  _stopRecordingCopy() {
    if (!this._shouldDoCarbonCopy() || this.recordingCopyData == null) return;

    if (FALLBACK_RECORDING_ADAPTER === 'bbb-webrtc-recorder') {
      this._stopWebRTCRecorder().catch((error) => {
        Logger.warn('Error stopping recording copy', {
          ...this._getLogMetadata(), adapter: FALLBACK_RECORDING_ADAPTER, error,
        });
      });
    } else {
      this.mcs.stopRecording(this.userId, this.recordingCopyData.recordingId)
        .then(this._stopHGARecordingSet.bind(this))
        .catch((error) => {
          Logger.warn('Error stopping recording copy', {
            ...this._getLogMetadata(), adapter: FALLBACK_RECORDING_ADAPTER, error,
          });
        })
        .finally(() => {
          this.recordingCopyData = null;
        });
    }
  }

  async stopRecording () {
    const handleRecStopped = ({ timestampHR = hrTime(), timestampUTC = Date.now() } = {}) => {
      this.sendStopShareEvent();
    };

    const handleRecStopError = (error) => {
      // Send stop event anyways with estimated timestamps so the recording scripts
      // can _at least_ cut the file
      if (this.sendStopShareEvent()) {
        Logger.warn(`stopRecordingFailed for ${this.userId}, stream ${this.streamName}`,
          { ...this._getLogMetadata(), error });
      }
    };

    this._stopRecordingCopy();

    if (this._getRecordingAdapter() === 'bbb-webrtc-recorder') {
      return this._stopWebRTCRecorder().then(handleRecStopped).catch(handleRecStopError);
    }

    return this.mcs.stopRecording(this.userId, this.recording.recordingId)
      .then(this._stopHGARecordingSet.bind(this))
      .then(handleRecStopped)
      .catch(handleRecStopError);
  }

  /* ======= START/CONNECTION METHODS ======= */

  async start (sdpOffer, options = {}) {
    try {
      if (this.status === C.MEDIA_STOPPED) {
        this.status = C.MEDIA_STARTING;
        const isConnected = await this.mcs.waitForConnection();

        if (!isConnected) {
          throw (errors.MEDIA_SERVER_OFFLINE);
        }

        // Probe akka-apps to see if this is to be recorded
        if (SHOULD_RECORD && this.shared) {
          const {
            recorded,
            recording,
            recordFullDurationMedia,
          } = await this.probeForRecordingStatus(this.meetingId, this.id);

          this.isMeetingRecorded = recorded;
          this.isMeetingRecording = recording;

          // If recordFullDurationMedia is undefined, it means BBB is older and
          // doesn't implement it. Default to the old behavior (record full duration)
          if (typeof recordFullDurationMedia === 'boolean') {
            this.recordFullDurationMedia = recordFullDurationMedia;
          } else {
            this.recordFullDurationMedia = this.isMeetingRecorded;
          }

          Logger.debug('BBB recording status probed', {
            isMeetingRecording: this.isMeetingRecording,
            isMeetingRecorded: this.isMeetingRecorded,
            recordFullDurationMedia: this.recordFullDurationMedia,
            recordingAdapter: this._getRecordingAdapter(),
          });
        }

        const userId = await this.mcs.join(
          this.voiceBridge,
          'SFU',
          { externalUserId: this.bbbUserId, autoLeave: true });
        this.userId = userId;
        const mediaSpecs = this._getMediaSpecs(options?.bitrate);
        const sdpAnswer = await this._addMCSMedia(C.WEBRTC, sdpOffer, mediaSpecs);
        // Status to indicate that the brokering with mcs-core was succesfull.
        // Don't mix with MEDIA_STARTED. MEDIA_STARTED means that media is
        // flowing through the server. This just means that the session was
        // negotiated properly.
        this.status = C.MEDIA_NEGOTIATED;
        this.mcs.onEvent(C.MEDIA_STATE, this.mediaId, (event) => {
          this._mediaStateWebRTC(event, this.mediaId);
        });

        this.mcs.onEvent(C.MEDIA_STATE_ICE, this.mediaId, (event) => {
          this._onMCSIceCandidate(event, this.mediaId);
        });

        this.flushCandidatesQueue(this.mcs, [...this.candidatesQueue], this.mediaId);
        this.candidatesQueue = [];
        Logger.info("Video start succeeded", this._getLogMetadata());

        return sdpAnswer;
      } else {
        Logger.warn(`Video rejected due to invalid status`,
          this._getLogMetadata());
        throw new TypeError('Invalid video status');
      }
    } catch (error) {
      Logger.error(`Video start procedure failed due to ${error.message}`,
        { ...this._getLogMetadata(), error });
      this.status = C.MEDIA_NEGOTIATION_FAILED;
      throw (this._handleError(LOG_PREFIX, error, this.role, this.id));
    }
  }

  async _addMCSMedia (type, descriptor, mediaSpecs) {
    if (this.shared) {
      // Specify initial bandwidth estimations for adapters (Kurento - REMB,
      // mediasoup - TWCC via "formalized" adapterOptions)
      // Video uses the default media spec merged with the custom bitrate sent
      // when the profile is chosen. Fetching bitrate by the VP8 codec is just
      // an arbitrary choice that makes no difference.
      // The media specs format isn't flexible enough, so that's what we have
      const bitrate = mediaSpecs.VP8.as_main;
      const kurentoRembParams = { ...KURENTO_REMB_PARAMS };
      kurentoRembParams.rembOnConnect = bitrate;
      const options = {
        descriptor,
        name: this._assembleStreamName('publish', this.id, this.voiceBridge),
        mediaSpecs,
        kurentoRembParams,
        adapter: this.mediaServerAdapter,
        ignoreThresholds: IGNORE_THRESHOLDS,
        adapterOptions: {
          msHackStripSsrcs: true,
          transportOptions: {
            // See mediasoup's initialAvailableOutgoingBitrate config (bps)
            initialAvailableOutgoingBitrate: bitrate * 1000,
          },
        },
      };

      const { mediaId, answer } = await this.mcs.publish(this.userId, this.voiceBridge, type, options);
      this.mediaId = mediaId;
      const videoSource = {
        mediaId: this.mediaId,
        mediaSpecs,
      };
      Video.setSource(this.id, videoSource);

      return answer;
    } else {
      if (Video.hasSource(this.id)) {
        const answer = await this._subscribeToMedia(descriptor, mediaSpecs);
        return answer;
      } else {
        const error = { code: 2201, reason: errors[2201] };
        Logger.warn(`Publisher stream from ${this.id} isn't set yet. Rejecting with MEDIA_NOT_FOUND`,
          this._getLogMetadata());
        throw error;
      }
    }
  }

  async _subscribeToMedia (descriptor, mediaSpecs) {
    // Specify initial bandwidth estimations for adapters (Kurento - REMB,
    // mediasoup - TWCC via "formalized" adapterOptions)
    // Video uses the default media spec merged with the custom bitrate sent
    // when the profile is chosen. Fetching bitrate by the VP8 codec is just
    // an arbitrary choice that makes no difference.
    // The media specs format isn't flexible enough, so that's what we have
    const bitrate = mediaSpecs.VP8.as_main;
    const kurentoRembParams = { ...KURENTO_REMB_PARAMS };
    kurentoRembParams.rembOnConnect = bitrate;
    const options = {
      descriptor,
      name: this._assembleStreamName('subscribe', this.id, this.voiceBridge),
      mediaSpecs,
      mediaSpecSlave: SUBSCRIBER_SPEC_SLAVE,
      kurentoRembParams,
      profiles: {
        video: 'recvonly',
      },
      mediaProfile: 'main',
      adapter: this.mediaServerAdapter,
      ignoreThresholds: IGNORE_THRESHOLDS,
      adapterOptions: {
        transportOptions: {
          // See mediasoup's initialAvailableOutgoingBitrate config (bps)
          initialAvailableOutgoingBitrate: bitrate * 1000,
        },
      },
    }
    this.options = options;
    const { mediaId: stream } = Video.getSource(this.id);
    const { mediaId, answer } = await this.mcs.subscribe(this.userId, stream, C.WEBRTC, options);
    this.mediaId = mediaId;

    if (PLI_ON_CONNECT && PLI_ON_CONNECT.amount > 0) {
      this._pliSalvo(this.mediaId, PLI_ON_CONNECT.amount, PLI_ON_CONNECT.interval);
    }

    return answer;
  }

  /* ======= STOP METHODS ======= */

  clearSessionListeners () {
    this.eventNames().forEach(event => {
      this.removeAllListeners(event);
    });
  }

  async _finishVideoSession (resolver) {
    this.status = C.MEDIA_STOPPING;

    try {
      await this.stopRecording();
    } catch (error) {
      // Send stop event anyways with estimated timestamps so the recording scripts
      // can _at least_ cut the file
      this.sendStopShareEvent();
    }

    if (this.mediaId) {
      if (this.shared) {
        try {
          await this.mcs.unpublish(this.userId, this.mediaId);
        } catch (error) {
          Logger.error(`Unpublish failed for user ${this.userId} with stream ${this.streamName}`,
            { ...this._getLogMetadata(), error });
        }
        Video.removeSource(this.id);
      } else {
        try {
          await this.mcs.unsubscribe(this.userId, this.mediaId);
        } catch (error) {
          Logger.error(`Unsubscribe failed for user ${this.userId} with stream ${this.streamName}`,
            { ...this._getLogMetadata(), error });
        } finally {
          this.sendCamStreamUnsubscribedInSfuEvtMsg(
            this.meetingId,
            this.bbbUserId,
            this.id,
            this.mediaId,
            this.streamName,
          )
        }
      }
    }

    if (this.shared) {
      this.sendCamBroadcastStoppedInSfuEvtMsg(
        this.meetingId, this.bbbUserId, this.id,
      )
    }

    if (this.notFlowingTimeout) {
      clearTimeout(this.notFlowingTimeout);
      delete this.notFlowingTimeout;
    }

    this.candidatesQueue = [];
    this.status = C.MEDIA_STOPPED;
    this.clearSessionListeners();

    Logger.info(`Stopped video session ${this.streamName}`, this._getLogMetadata());
    return resolver();
  }

  finalDetachEventListeners () {
    this._untrackMCSEvents();
    this._untrackBigBlueButtonEvents();
    this.removeAllListeners();
  }

  async stop () {
    return new Promise((resolve) => {
      this._untrackBigBlueButtonEvents();
      this._untrackMCSEvents();
      this._clearPliSalvo();

      switch (this.status) {
        case C.MEDIA_STOPPED: {
          Logger.debug('Video session already stopped',
            this._getLogMetadata());
          return resolve();
        }

        case C.MEDIA_STOPPING: {
          Logger.warn('Video session already stopping',
            this._getLogMetadata());

          this.once(C.MEDIA_STOPPED, () => {
            Logger.info(`Calling delayed stop resolution for queued stop call for ${this.streamName}`,
              this._getLogMetadata());
            return resolve();
          });
          break;
        }

        case C.MEDIA_STARTING: {
          Logger.warn('Video session is still starting. Let it finish then stop it',
            this._getLogMetadata());

          if (!this._stopActionQueued) {
            this._stopActionQueued = true;
            const handleNegotiationEnd = () => {
              Logger.info('Video session: running delayed MEDIA_STARTING stop action',
                this._getLogMetadata());
              this.removeListener(C.MEDIA_NEGOTIATED, handleNegotiationEnd);
              this.removeListener(C.MEDIA_NEGOTIATION_FAILED, handleNegotiationEnd);
              this._finishVideoSession(resolve);
            };

            this.once(C.MEDIA_NEGOTIATED, handleNegotiationEnd);
            this.once(C.MEDIA_NEGOTIATION_FAILED, handleNegotiationEnd);
          } else {
            this.once(C.MEDIA_STOPPED, () => {
              Logger.info('Video session: delayed stop action executed',
                this._getLogMetadata());
              return resolve();
            });
          }
          break;
        }

        default:
          Logger.info('Stopping video session',
            this._getLogMetadata());
          // This method resolves this method's wrapping promise
          this._finishVideoSession(resolve);
      }
    });
  }

  async disconnectUser() {
    try {
      Logger.info('Disconnect a video session on UserLeft*/DisconnectAll',
        this._getLogMetadata());
      await this.stop();
    } catch (error) {
      Logger.warn('Failed to disconnect video session on UserLeft*/DisconnectAll',
        { ...this._getLogMetadata(), error });
    } finally {
      this.sendToClient({
        connectionId: this.connectionId,
        type: C.VIDEO_APP,
        id : 'close',
      }, C.FROM_VIDEO);
    }
  }
};
