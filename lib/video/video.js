'use strict';

const config = require('config');
const { v4: uuidv4 } = require('uuid');
const C = require('../bbb/messages/Constants');
const Logger = require('../common/logger.js');
const { hrTime } = require('../common/utils.js');
const Messaging = require('../bbb/messages/Messaging');
const BaseProvider = require('../base/base-provider.js');
const SHOULD_RECORD = config.get('recordWebcams');
const errors = require('../base/errors');
const {
  BBBWebRTCRecorder,
  DEFAULT_PUB_CHANNEL,
  DEFAULT_SUB_CHANNEL,
} = require('../common/bbb-webrtc-recorder.js');

const DEFAULT_MEDIA_SPECS = config.get('conference-media-specs');
const SUBSCRIBER_SPEC_SLAVE = config.has('videoSubscriberSpecSlave')
  ? config.get('videoSubscriberSpecSlave')
  : false;
const KURENTO_REMB_PARAMS = config.util.cloneDeep(config.get('kurentoRembParams'));
const EJECT_ON_USER_LEFT = config.get('ejectOnUserLeft');
const IGNORE_THRESHOLDS = config.has('videoIgnoreMediaThresholds')
  ? config.get('videoIgnoreMediaThresholds')
  : false;
const RECORDING_ADAPTER = config.has('recordingAdapter')
  ? config.get('recordingAdapter')
  : 'native'
const GENERATE_TS_ON_RECORDING_EVT = config.has('recordingGenerateTsOnRecEvt')
  ? config.get('recordingGenerateTsOnRecEvt')
  : false;
const RECORDING_PLI_ON_NOT_FLOWING = config.has('recordingPliOnNotFlowing')
  ? config.get('recordingPliOnNotFlowing')
  : false;
const PLI_ON_CONNECT = config.has('pliOnConnect')
  ? config.get('pliOnConnect')
  : null;

const LOG_PREFIX = "[video]";
const RECORDING_MAX_RETRIES = 3;
const RECORDING_RETRY_DELAY = 2000;
const REC_PLI_SHOTS = 3;
const REC_PLI_FREQ = 2000;
const REC_FLOW_TIMER = 500;
const Recorder = new BBBWebRTCRecorder(DEFAULT_PUB_CHANNEL, DEFAULT_SUB_CHANNEL);

let sources = {};

module.exports = class Video extends BaseProvider {
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
    this.isRecorded = false;
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
    this._untrackCamUnsubscribeSysMsg();
    this._untrackCamBroadcastStopSysMsg();
  }

  _trackBigBlueButtonEvents () {
    this.bbbGW.once(C.DISCONNECT_ALL_USERS_2x+this.meetingId, this.disconnectUser);
    if (EJECT_ON_USER_LEFT) {
      this.bbbGW.once(C.USER_LEFT_MEETING_2x+this.bbbUserId, this.disconnectUser);
    }

    this._trackCamUnsubscribeSysMsg();
    this._trackCamBroadcastStopSysMsg();
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

  static setSource (id, stream) {
    Logger.debug('New camera source set', { cameraId: id, mediaId: stream });
    sources[id] = stream;
  }

  static getSource (id) {
    return sources[id];
  }

  static removeSource (id) {
    Logger.debug('Camera source removed', { cameraId: id });
    delete sources[id];
  }

  /* ======= ICE HANDLERS ======= */

  processAnswer (answer) {
    const stream = Video.getSource(this.id);
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

  _handleIceComponentStateChange (state) {
    const { rawEvent } = state;
    const {
      componentId: iceComponentId,
      source: elementId,
      state: iceComponentState
    } = rawEvent;

    Logger.debug(`Video ICE component state changed`, {
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
    Logger.info(`Video new candidate pair selected`, {
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
    Logger.debug(`Video ICE gathering done`, {
      ...this._getLogMetadata(),
      elementId,
    });
  }

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
              this.startRecording().catch((error) => {
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

  _handleHGARecStateChange (event, endpoint) {
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
        }
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
    return this.isRecorded
      && this.shared
      && this.record
      && this.status === C.MEDIA_STARTED
      && this._recordingRetries < RECORDING_MAX_RETRIES;
  }

  sendStartShareEvent({
    filename,
    timestampHR = hrTime(),
    timestampUTC = Date.now(),
  } = {}) {
    if (filename == null) throw new Error('Invalid filename');

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
  }

  sendStopShareEvent ({
    timestampHR = hrTime(),
    timestampUTC = Date.now(),
  }) {
    if (this._stopRecordingEventFired || !this.isRecording || !this._startRecordingEventFired) return false;

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
          setTimeout(() => {
            if (this.shouldRecord()) {
              this.startRecording().catch((error) => {
                Logger.error('Recording start failed, unrecoverable', {
                  recordingSessionId,
                  retries: this._recordingRetries,
                  recordingAdapter: this._getRecordingAdapter(),
                  errorMessage: error?.message,
                  errorStack: error?.stack,
                  ...this._getLogMetadata(),
                });
              });
            } else {
              Logger.error('Recording retries expired', {
                recordingSessionId,
                recordingAdapter: this._getRecordingAdapter(),
                retries: this._recordingRetries,
                ...this._getLogMetadata(),
              });
            }
          }, RECORDING_RETRY_DELAY);
        });
        break;
      // Final
      case 'stop requested':
      case 'session not found':
      default:
        return;
    }
  }

  handleRecorderRtpStatusChange({ recordingSessionId, status, timestampUTC, timestampHR }) {
    switch (status) {
      case "flowing":
        Logger.debug(`Recording media FLOWING for ${recordingSessionId}`,
          this._getLogMetadata());
        if (!this._startRecordingEventFired) {
          Logger.debug('Firing recording event via flowing event',
            this._getLogMetadata());
          this.sendStartShareEvent({ filename: this.recording.filename, timestampHR, timestampUTC });
        }
        break;
      case "not_flowing":
        Logger.debug(`Recording media NOT FLOWING for ${recordingSessionId}`,
this._getLogMetadata());
        break;

      default: Logger.trace("Unhandled recording event", status);
    }
  }

  async _recordViaWebRTCRecorder (sourceMediaId, recordingPath, { filename }) {
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
        rtpStatusChangedHdlr: this.handleRecorderRtpStatusChange,
        recordingStoppedHdlr: this.handleRecordingStopped,
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
    //     (RECORDING_ADAPTER) with the offer from #1
    // 3 - Send back the answer from #2 to the native adapter
    // 4 - Call startRecording in the heterogeneous adapter (RECORDING_ADAPTER),
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
    this.hgaRecordingSet.nativeSubMediaId= nativeMediaId;

    // Step 2
    const hgaOptions = {
      descriptor: nativeDescriptor,
      adapter: this._getRecordingAdapter(),
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

    this.mcs.onEvent(C.MEDIA_STATE, hgaMediaId, (event) => {
      this._handleHGARecStateChange(event, hgaMediaId);
    });

    // Step 3
    nativeOptions.descriptor = hgaAnswer;
    nativeOptions.mediaId = nativeMediaId;
    await this.mcs.subscribe(this.userId, sourceMediaId, C.RTP, nativeOptions);

    // Step 4 - Hoo-ah!
    recordingOptions.adapter = this._getRecordingAdapter();
    return this._recordViaMCS(hgaMediaId, recordingPath, recordingOptions);
  }

  async _recordViaMCS (sourceMediaId, recordingPath, options) {
    if (options.adapter == null) {
      options.adapter = this.mediaServerAdapter;
    }

    const recordingId = await this.mcs.startRecording(
      this.userId, sourceMediaId, recordingPath, options,
    );
    this.sendStartShareEvent({ filename: recordingPath });

    return { recordingId, filename: recordingPath, recordingPath };
  }

  _getRecordingAdapter () {
    if (RECORDING_ADAPTER === 'native' || RECORDING_ADAPTER === this.mediaServerAdapter) {
      return this.mediaServerAdapter;
    }

    return RECORDING_ADAPTER;
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

  async startRecording () {
    this._recordingRetries++;
    const cameraCodec = DEFAULT_MEDIA_SPECS.codec_video_main;
    const recordingName = `${this._cameraProfile}-${this.bbbUserId}`;
    const recordingProfile = (cameraCodec === 'VP8' || cameraCodec === 'ANY')
      ? C.RECORDING_PROFILE_WEBM_VIDEO_ONLY
      : C.RECORDING_PROFILE_MKV_VIDEO_ONLY;
    const format = (cameraCodec === 'VP8' || cameraCodec === 'ANY')
      ? C.RECORDING_FORMAT_WEBM
      : C.RECORDING_FORMAT_MKV;
    const recordingAdapter = this._getRecordingAdapter();
    const proxiedStartRecording = this._getRecordingMethod(recordingAdapter);
    const filename = this.getRecordingFilePathSuffix(
      this.meetingId,
      this._recordingSubPath,
      recordingName,
      format
    );
    const recordingPath = this.getFullRecordingPath(this.getRecordingBaseDir(recordingAdapter), filename);
    const recordingOptions = { recordingProfile, ignoreThresholds: true, filename };
    this._startRecordingEventFired = false;
    this._stopRecordingEventFired = false;
    const recordingData = await proxiedStartRecording(
      this.mediaId,
      recordingPath,
      recordingOptions
    );
    this.recording = recordingData;
    this.isRecording = true;

    return recordingData;
  }

  async stopRecording () {
    const handleRecStopped = ({ timestampHR = hrTime(), timestampUTC = Date.now() } = {}) => {
      this.sendStopShareEvent({ timestampHR, timestampUTC });
    };

    const handleRecStopError = (error) => {
      Logger.warn(`stopRecordingFailed for ${this.userId}, stream ${this.streamName}`,
        { ...this._getLogMetadata(), error });
      // Send stop event anyways with estimated timestamps so the recording scripts
      // can _at least_ cut the file
      this.sendStopShareEvent();
    };

    if (this.isRecording) {
      if (this._getRecordingAdapter() === 'bbb-webrtc-recorder') {
        return this._stopWebRTCRecorder().then(handleRecStopped).catch(handleRecStopError);
      }

      return this._stopHGARecordingSet()
        .then(() => this.mcs.stopRecording(this.userId, this.recording.recordingId))
        .then(handleRecStopped)
        .catch(handleRecStopError);
    }

    return Promise.resolve();
  }

  /* ======= START/CONNECTION METHODS ======= */

  async start (sdpOffer, mediaSpecs) {
    try {
      if (this.status === C.MEDIA_STOPPED) {
        this.status = C.MEDIA_STARTING;
        const isConnected = await this.mcs.waitForConnection();

        if (!isConnected) {
          throw (errors.MEDIA_SERVER_OFFLINE);
        }

        // Probe akka-apps to see if this is to be recorded
        if (SHOULD_RECORD && this.shared) {
          this.isRecorded = await this.probeForRecordingStatus(this.meetingId, this.id);
        }

        const userId = await this.mcs.join(
          this.voiceBridge,
          'SFU',
          { externalUserId: this.bbbUserId, autoLeave: true });
        this.userId = userId;
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
        adapter: this.mediaServerAdapter,
        ignoreThresholds: IGNORE_THRESHOLDS,
        adapterOptions: {
          msHackStripSsrcs: true,
        },
      };

      const { mediaId, answer } = await this.mcs.publish(this.userId, this.voiceBridge, type, options);
      this.mediaId = mediaId;
      Video.setSource(this.id, this.mediaId);

      return answer;
    } else {
      const stream = Video.getSource(this.id);

      if (stream) {
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
      profiles: {
        video: 'recvonly',
      },
      mediaProfile: 'main',
      adapter: this.mediaServerAdapter,
      ignoreThresholds: IGNORE_THRESHOLDS
    }
    this.options = options;
    const stream = Video.getSource(this.id);
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
