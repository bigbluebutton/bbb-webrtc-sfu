/*
 * Lucas Fialho Zawacki
 * Paulo Renato Lanzarin
 * (C) Copyright 2017 Bigbluebutton
 *
 */

'use strict'

const config = require('config');
const { v4: uuidv4 } = require('uuid');
const C = require('../bbb/messages/Constants');
const { addBwToSpecContentType, hrTime } = require('../common/utils.js');
const Messaging = require('../bbb/messages/Messaging');
const Logger = require('../common/logger.js');
const BaseProvider = require('../base/base-provider.js');
const errors = require('../base/errors');
const { getScreenBroadcastPermission } = require('./screen-perm-utils.js');
const {
  BBBWebRTCRecorder,
  DEFAULT_PUB_CHANNEL,
  DEFAULT_SUB_CHANNEL,
} = require('../common/bbb-webrtc-recorder.js');

const SHOULD_RECORD = config.get('recordScreenSharing');
const DEFAULT_MEDIA_SPECS = config.get('conference-media-specs');
const SUBSCRIBER_SPEC_SLAVE = config.has('videoSubscriberSpecSlave')
  ? config.get('videoSubscriberSpecSlave')
  : false;
const KURENTO_REMB_PARAMS = config.util.cloneDeep(config.get('kurentoRembParams'));
const SCREENSHARE_PLAY_START_ENABLED = config.has(`screensharePlayStartEnabled`)
  ? config.get(`screensharePlayStartEnabled`)
  : false;
const SCREENSHARE_SERVER_AKKA_BROADCAST = config.has(`screenshareServerSideAkkaBroadcast`)
  ? config.get(`screenshareServerSideAkkaBroadcast`)
  : true;
const MEDIA_FLOW_TIMEOUT_DURATION = config.get('mediaFlowTimeoutDuration');
const IGNORE_THRESHOLDS = config.has('screenshareIgnoreMediaThresholds')
  ? config.get('screenshareIgnoreMediaThresholds')
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

const RECORDING_MAX_RETRIES = 3;
const RECORDING_RETRY_DELAY = 2000;
const REC_PLI_SHOTS = 3;
const REC_PLI_FREQ = 2000;
const REC_FLOW_TIMER = 500;
const LOG_PREFIX = "[screenshare]";
const Recorder = new BBBWebRTCRecorder(DEFAULT_PUB_CHANNEL, DEFAULT_SUB_CHANNEL);

module.exports = class Screenshare extends BaseProvider {
  static getCustomMediaSpec (bitrate) {
    if (bitrate != null) {
      const extensibleSpecs = config.util.cloneDeep(DEFAULT_MEDIA_SPECS);

      return addBwToSpecContentType(extensibleSpecs, bitrate);
    }

    return DEFAULT_MEDIA_SPECS;
  }

  static buildSubscriberMCSOptions (descriptor, streamName, hasAudio, adapter) {
    // Get the REMB spec to be used. Screenshare uses the default mixed in with
    // the default spec bitrate. Fetching bitrate by the VP8 codec is just an
    // arbitrary choice that makes no difference.
    // The media specs format isn't flexible enough, so that's what we have
    const kurentoRembParams = { ...KURENTO_REMB_PARAMS };
    kurentoRembParams.rembOnConnect = DEFAULT_MEDIA_SPECS.VP8.as_content;
    return {
      descriptor,
      name: streamName,
      mediaProfile: 'content',
      mediaSpecSlave: SUBSCRIBER_SPEC_SLAVE,
      kurentoRembParams,
      profiles: {
        audio: hasAudio ? 'recvonly' : undefined,
        content: 'recvonly',
      },
      adapter,
      ignoreThresholds: IGNORE_THRESHOLDS,
    }
  }

  constructor(
    id,
    bbbGW,
    voiceBridge,
    userId,
    vh,
    vw,
    meetingId,
    mcs,
    hasAudio,
    contentType,
  ) {
    super(bbbGW);
    this.sfuApp = C.SCREENSHARE_APP;
    this.mcs = mcs;
    this.presenterMCSUserId;
    this.userId = userId;
    this._connectionId = id;
    this._presenterEndpoint = null;
    this._voiceBridge = voiceBridge;
    this.meetingId = meetingId;
    this._streamUrl = "";
    this._vw = vw;
    this._vh = vh;
    this._presenterCandidatesQueue = [];
    this._viewerUsers = {};
    this._viewerEndpoints = [];
    this._viewersCandidatesQueue = [];
    this.status = C.MEDIA_STOPPED;
    this._rtmpBroadcastStarted = false;
    this.recording = {};
    this.isMeetingRecorded = false;
    this.isMeetingRecording = false;
    this.recordFullDurationMedia = false;
    this._recordingSubPath = 'screenshare';
    this._startRecordingEventFired = false;
    this._stopRecordingEventFired = false;
    this._recordingRetries = 0;
    this.hasAudio = hasAudio;
    this.contentType = contentType;
    this._mediaFlowingTimeouts = {};
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
    this._trackMCSEvents();
  }

  set status (status) {
    this._status = status;
    this.emit(status);
  }

  get status () {
    return this._status;
  }

  _bindEventHandlers () {
    this.handleMCSCoreDisconnection = this.handleMCSCoreDisconnection.bind(this);
    this.handleRecorderRtpStatusChange = this.handleRecorderRtpStatusChange.bind(this);
    this.handleRecordingStopped = this.handleRecordingStopped.bind(this);
  }

  _getPartialLogMetadata () {
    return {
      roomId: this._voiceBridge,
      internalMeetingId: this.meetingId,
      status: this.status,
    };
  }

  _getFullPresenterLogMetadata (connectionId) {
    return {
      ...this._getPartialLogMetadata(),
      userId: this.presenterMCSUserId,
      mediaId: this._presenterEndpoint,
      connectionId,
      role: `presenter`,
    };
  }

  _getFullViewerLogMetadata (connectionId) {
    const { userId } = this._viewerUsers[connectionId] || {};
    const mediaId = this._viewerEndpoints[connectionId];
    return {
      ...this._getPartialLogMetadata(),
      userId,
      mediaId,
      connectionId,
      role: `viewer`,
    };
  }

  _trackMCSEvents () {
    this.mcs.on(C.MCS_DISCONNECTED, this.handleMCSCoreDisconnection);
  }

  _untrackMCSEvents () {
    this.mcs.removeListener(C.MCS_DISCONNECTED, this.handleMCSCoreDisconnection);
  }

  setBBBRecordingStatus (isMeetingRecording) {
    this.isMeetingRecording = isMeetingRecording;

    if (!this.isSFURecording() && this.shouldRecord()) {
      Logger.info('BBB recording status changed to true, starting recording', {
        isMeetingRecording,
        isMeetingRecorded: this.isMeetingRecorded,
        recordFullDurationMedia: this.recordFullDurationMedia,
        recordingAdapter: this._getRecordingAdapter(),
      });

      this.startRecording().catch(error => {
        Logger.error('Recording start failed', {
          retries: this._recordingRetries,
          recordingAdapter: this._getRecordingAdapter(),
          errorMessage: error?.message,
          errorStack: error?.stack,
          ...this._getFullPresenterLogMetadata(),
        });
      });
    } else if (this.isSFURecording() && !this.shouldRecord()) {
      Logger.info('BBB recording status changed to false, stopping recording', {
        isMeetingRecording,
        isMeetingRecorded: this.isMeetingRecorded,
        recordFullDurationMedia: this.recordFullDurationMedia,
        recordingAdapter: this._getRecordingAdapter(),
      });

      this._stopRecording().catch(error => {
        Logger.error('Recording stop failed', {
          retries: this._recordingRetries,
          recordingAdapter: this._getRecordingAdapter(),
          errorMessage: error?.message,
          errorStack: error?.stack,
          ...this._getFullPresenterLogMetadata(),
        });
      });
    }
  }

  getConnectionIdAndRolesFromUser (userId) {
    const cIDsAndRoles = Object.keys(this._viewerUsers).filter(connectionId => {
      const user = this._viewerUsers[connectionId];
      return (user && user.userId === userId);
    }).map(connectionId => ({ connectionId, role: C.RECV_ROLE }));

    if (this.presenterMCSUserId === userId) {
      cIDsAndRoles.push({ connectionId: this._connectionId, role: C.RECV_ROLE });
    }

    return cIDsAndRoles;
  }

  /* ======= ICE HANDLERS ======= */

  async onIceCandidate (candidate, role, connectionId) {
    switch (role) {
      case C.SEND_ROLE:
        if (this._presenterEndpoint) {
          try {
            this.flushCandidatesQueue(this.mcs, [...this._presenterCandidatesQueue], this._presenterEndpoint);
            this._presenterCandidatesQueue = [];

            await this.mcs.addIceCandidate(this._presenterEndpoint, candidate);
          } catch (error) {
            Logger.error(`ICE candidate could not be added to media controller due to ${error.message}.`,
              { ...this._getFullPresenterLogMetadata(connectionId), error });
          }
        } else {
          this._presenterCandidatesQueue.push(candidate);
        }
        break;
      case C.RECV_ROLE: {
        let endpoint = this._viewerEndpoints[connectionId];
        if (endpoint) {
          try {
            this.flushCandidatesQueue(this.mcs, [...this._viewersCandidatesQueue[connectionId]], endpoint);
            this._viewersCandidatesQueue[connectionId] = [];

            await this.mcs.addIceCandidate(endpoint, candidate);
          } catch (error) {
            Logger.error(`ICE candidate could not be added to media controller due to ${error.message}.`,
              { ...this._getFullViewerLogMetadata(connectionId), error });
          }
        } else {
          this._viewersCandidatesQueue[connectionId] = [];
          this._viewersCandidatesQueue[connectionId].push(candidate);
        }
        break;
      }
      default:
        Logger.warn("Unknown role", role);
      }
  }

  _onMCSIceCandidate (event, connectionId, endpoint) {
    const { mediaId, candidate } = event;
    if (mediaId !== endpoint) {
      return;
    }
    const isPresenter = this.connectionId === connectionId;
    const logMetadata = isPresenter
      ? this._getFullPresenterLogMetadata(connectionId)
      : this._getFullViewerLogMetadata(connectionId);

    Logger.debug("Received ICE candidate from mcs-core",
      { ...logMetadata, candidate });

    this.sendToClient({
      connectionId,
      type: C.SCREENSHARE_APP,
      id : 'iceCandidate',
      candidate : candidate
    }, C.FROM_SCREENSHARE);
  }

  /* ======= MEDIA STATE HANDLERS ======= */

  setMediaFlowingTimeout (connectionId) {
    if (!this._mediaFlowingTimeouts[connectionId]) {
      Logger.debug(`Presenter NOT_FLOWING timeout set`,
        { ...this._getFullPresenterLogMetadata(connectionId), MEDIA_FLOW_TIMEOUT_DURATION });
      this._mediaFlowingTimeouts[connectionId] = setTimeout(() => {
        this._onPresenterMediaNotFlowingTimeout(connectionId);
      }, MEDIA_FLOW_TIMEOUT_DURATION);
    }
  }

  clearMediaFlowingTimeout (connectionId) {
    if (this._mediaFlowingTimeouts[connectionId]) {
      Logger.debug(`clearMediaFlowingTimeout for presenter ${connectionId}`,
        this._getFullPresenterLogMetadata(connectionId));
      clearTimeout(this._mediaFlowingTimeouts[connectionId]);
      delete this._mediaFlowingTimeouts[connectionId]
    }
  }

  _onPresenterMediaNotFlowingTimeout (connectionId) {
    Logger.error(`Presenter WebRTC media NOT_FLOWING timeout reached`,
      this._getFullPresenterLogMetadata(connectionId));
    this.sendToClient({
      type: C.SCREENSHARE_APP,
      id : 'stopSharing',
      connectionId,
      error: { code: 2211 , reason: errors[2211] },
    }, C.FROM_SCREENSHARE);
  }

  _onPresenterMediaFlowing (connectionId) {
    if (!this._rtmpBroadcastStarted) {
      Logger.info("Presenter WebRTC session began FLOWING",
        this._getFullPresenterLogMetadata(connectionId));
      this._startRtmpBroadcast();

      if (this.status != C.MEDIA_STARTED) {
        this.status = C.MEDIA_STARTED;
        this.sendPlayStart(C.SEND_ROLE, connectionId);

        if (this.shouldRecord()) {
          this.startRecording().catch(error => {
            Logger.error('Recording start failed', {
              retries: this._recordingRetries,
              recordingAdapter: this._getRecordingAdapter(),
              errorMessage: error?.message,
              errorStack: error?.stack,
              ...this._getFullPresenterLogMetadata(connectionId),
            });
          });
        }
      }
    }

    this.clearMediaFlowingTimeout(connectionId);
  }

  _onPresenterMediaNotFlowing (connectionId) {
    Logger.debug(`Presenter WebRTC session is NOT_FLOWING`,
      this._getFullPresenterLogMetadata(connectionId));
    this.setMediaFlowingTimeout(connectionId);
  }

  sendPlayStart (role, connectionId) {
    if (SCREENSHARE_PLAY_START_ENABLED) {
      this.sendToClient({
        type: C.SCREENSHARE_APP,
        id : 'playStart',
        connectionId,
        role,
      }, C.FROM_SCREENSHARE);
    }
  }

  _onViewerWebRTCMediaFlowing (connectionId) {
    const viewerUser = this._viewerUsers[connectionId];

    if (viewerUser && !viewerUser.started) {
      Logger.info(`Viewer WebRTC session began FLOWING`,
        this._getFullViewerLogMetadata(connectionId));
      this.sendPlayStart(C.RECV_ROLE, connectionId);
      viewerUser.started = true;
    }
  }

  _onViewerWebRTCMediaNotFlowing (connectionId) {
    Logger.debug(`Viewer WebRTC session is NOT_FLOWING`,
      this._getFullViewerLogMetadata(connectionId));
    // TODO properly implement a handler when we have a client-side reconnection procedure
  }

  _handleIceComponentStateChange (state, logMetadata) {
    const { rawEvent } = state;
    const {
      componentId: iceComponentId,
      source: elementId,
      state: iceComponentState
    } = rawEvent;

    Logger.debug("Screenshare ICE component state changed", {
      ...logMetadata,
      elementId,
      iceComponentId,
      iceComponentState
    });
  }

  _handleCandidatePairSelected (state, logMetadata) {
    const { rawEvent } = state;
    const { candidatePair, source: elementId } = rawEvent;
    const { localCandidate, remoteCandidate, componentID: iceComponentId } = candidatePair;
    Logger.info("Screenshare new candidate pair selected", {
      ...logMetadata,
      elementId,
      iceComponentId,
      localCandidate,
      remoteCandidate,
    });
  }

  _handleIceGatheringDone (state, logMetadata) {
    const { rawEvent } = state;
    const { source: elementId } = rawEvent;
    Logger.debug("Screenshare ICE gathering done", {
      ...logMetadata,
      elementId,
    });
  }

  _handleMediaStateChanged (state, logMetadata) {
    const { rawEvent, details } = state;
    const { source: elementId } = rawEvent;
    Logger.debug(`Screenshare media state changed`, {
      ...logMetadata,
      elementId,
      mediaState: details,
    });
  }

  _mediaStateWebRTC (event, endpoint, connectionId, flowingCallback, notFlowingCallback) {
    const { mediaId , state } = event;
    if (mediaId !== endpoint) {
      return;
    }
    const { name, details } = state;
    const isPresenter = connectionId === this._connectionId;
    const logMetadata = isPresenter
      ? this._getFullPresenterLogMetadata(connectionId)
      : this._getFullViewerLogMetadata(connectionId);

    switch (name) {
      case "IceComponentStateChange":
        this._handleIceComponentStateChange(state, logMetadata);
        break;
      case "NewCandidatePairSelected":
        this._handleCandidatePairSelected(state, logMetadata);
        break;
      case "IceGatheringDone":
        this._handleIceGatheringDone(state, logMetadata);
        break;
      case "MediaStateChanged":
        this._handleMediaStateChanged(state, logMetadata);
        break;
      case "MediaFlowOutStateChange":
      case "MediaFlowInStateChange":
        if (details === 'FLOWING') {
          flowingCallback(connectionId);
        } else {
          notFlowingCallback(connectionId);
        }
        break;
      case C.MEDIA_SERVER_OFFLINE:
        if (isPresenter) {
          Logger.error("Presenter WebRTC screensharing session received MEDIA_SERVER_OFFLINE event",
            { ...logMetadata, event });
        } else {
          Logger.error("Viewer WebRTC screensharing session received MEDIA_SERVER_OFFLINE event",
            { ...logMetadata, event });
        }
        this.emit(C.MEDIA_SERVER_OFFLINE, event);
        break;
      default: Logger.trace("Unrecognized event", event);
    }
  }

  /* ======= RECORDING METHODS ======= */

  shouldRecord () {
    return this.isMeetingRecorded
      && (this.isMeetingRecording || this.recordFullDurationMedia)
      && this.status === C.MEDIA_STARTED
      && this._recordingRetries < RECORDING_MAX_RETRIES;
  }

  isSFURecording () {
    return this.recording && this.recording.recordingId;
  }

  async _stopWebRTCRecorder () {
    const { nativeSubMediaId, recordingSessionId } = this.bbbWebRTCRecorderSet;

    if (nativeSubMediaId) {
      try {
        await this.mcs.unsubscribe(this.userId, nativeSubMediaId);
      } catch(error) {
        Logger.error("bbb-webrtc-recorder: native recording subscriber cleanup failure",
          { ...this._getFullPresenterLogMetadata(), error, recordingAdapter: this._getRecordingAdapter() });
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
          { ...this._getFullPresenterLogMetadata(), error, recordingAdapter: this._getRecordingAdapter() });
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
          ...this._getFullPresenterLogMetadata(this._connectionId),
          retries: this._recordingRetries,
          reason,
          recordingAdapter: this._getRecordingAdapter(),
          recordingSessionId,
        });
        // Recording session ceased to be
        this.bbbWebRTCRecorderSet.recordingSessionId = null;
        // Cleanup and restart
        this._stopRecording().finally(() => {
          setTimeout(() => {
            if (this.shouldRecord()) {
              this.startRecording().catch((error) => {
                Logger.error('Recording start failed, unrecoverable', {
                  recordingSessionId,
                  retries: this._recordingRetries,
                  recordingAdapter: this._getRecordingAdapter(),
                  errorMessage: error?.message,
                  errorStack: error?.stack,
                  ...this._getFullPresenterLogMetadata(this._connectionId),
                });
              });
            } else {
              Logger.error('Recording retries expired', {
                recordingSessionId,
                recordingAdapter: this._getRecordingAdapter(),
                retries: this._recordingRetries,
                ...this._getFullPresenterLogMetadata(this._connectionId),
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
            this._getFullPresenterLogMetadata(this._connectionId));

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
            this._getFullPresenterLogMetadata(this._connectionId));
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

  handleRecorderRtpStatusChange({ recordingSessionId, status, timestampUTC, timestampHR }) {
    switch (status) {
      case "flowing":
        Logger.debug(`Recording media FLOWING for ${recordingSessionId}`,
          this._getFullPresenterLogMetadata(this._connectionId));
        if (!this._startRecordingEventFired) {
          Logger.debug('Firing recording event via flowing event',
            this._getFullPresenterLogMetadata(this._connectionId));
          this.sendStartShareEvent({ filename: this.recording.filename });
        }
        break;
      case "not_flowing":
        Logger.debug(`Recording media NOT FLOWING for ${recordingSessionId}`,
          this._getFullPresenterLogMetadata(this._connectionId));
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
        audio: this.hasAudio ? 'recvonly' : undefined,
        content: 'recvonly',
      },
      mediaProfile: 'content',
      adapter: this.presenterAdapter,
      ignoreThresholds: true,
    }

    const {  mediaId: nativeMediaId, answer: nativeDescriptor } = await this.mcs.subscribe(
      this.presenterMCSUserId, sourceMediaId, C.WEBRTC, nativeOptions
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
    await this.mcs.subscribe(this.presenterMCSUserId, sourceMediaId, C.WEBRTC, nativeOptions);

    return {
      recordingId: recordingSessionId,
      // bbb-webrtc-recorder... deduplicate
      filename: responseFileName,
      recordingPath,
    };
  }

  _requestKeyframe (mediaId) {
    return this.mcs.requestKeyframe(mediaId).catch((error) => {
      Logger.warn(`requestKeyframe failed for ${mediaId}: ${error.message}`, {
        ...this._getFullPresenterLogMetadata(this._connectionId),
        error,
      });
    });
  }

  _pliSalvo (endpoint, shots, freq, { fastStart = false } = {}) {
    if (this._pliInterval || endpoint == null) return;
    let iterations = 0;

    Logger.warn(
      `Firing recording PLI salvo: ${endpoint}`,
      this._getFullPresenterLogMetadata(this._connectionId)
    );

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

  async _stopHGARecordingSet () {
    const { nativeSubMediaId, hgaPubMediaId, flowTracker } = this.hgaRecordingSet;

    if (flowTracker) {
      clearTimeout(flowTracker);
      this.hgaRecordingSet.flowTracker = null;
    }

    if (nativeSubMediaId) {
      try {
        await this.mcs.unsubscribe(this.presenterMCSUserId, nativeSubMediaId);
      } catch(error) {
        Logger.error("HGA: native recording subscriber cleanup failure?", {
          ...this._getFullPresenterLogMetadata(this._connectionId),
          error,
          recordingAdapter: this._getRecordingAdapter()
        });
      } finally {
        this.hgaRecordingSet.nativeSubMediaId = null;
      }
    }

    if (hgaPubMediaId) {
      try {
        await this.mcs.unpublish(this.presenterMCSUserId, hgaPubMediaId);
      } catch(error) {
        Logger.error("HGA: hga recording publisher cleanup failure?", {
            ...this._getFullPresenterLogMetadata(this._connectionId),
          error,
          recordingAdapter: this._getRecordingAdapter()
        });
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
        audio: this.hasAudio ? 'sendrecv' : undefined,
        content: 'sendrecv',
      },
      mediaProfile: 'content',
      adapter: this.presenterAdapter,
      ignoreThresholds: true,
      adapterOptions: {
        transportOptions: {
          rtcpMux: false,
          comedia: false,
        },
        // Split transport is a mediasoup-specific adapter option which means the
        // RTP element will have one transport per media type. This is necessary
        // because, otherwise, mediasoup will bundle streams in the same port in
        // the plain transport. This is OK, but neither FS nor KMS support that with
        // plain RTP endpoints.
        splitTransport: this.hasAudio,
        // Up the chances that rtcp-fb is signaled on the remote end
        msHackRTPAVPtoRTPAVPF: true,
      },
    };

    const {  mediaId: nativeMediaId, answer: nativeDescriptor } = await this.mcs.subscribe(
      this.presenterMCSUserId, sourceMediaId, C.RTP, nativeOptions
    );
    this.hgaRecordingSet.nativeSubMediaId = nativeMediaId;

    // Step 2
    const hgaOptions = {
      descriptor: nativeDescriptor,
      adapter: this._getRecordingAdapter(),
      ignoreThresholds: true,
      profiles: {
        audio: this.hasAudio ? 'sendonly' : undefined,
        content: 'sendonly',
      },
      mediaProfile: 'content',
      // Disable REMB for recordings; unless there are buffer issues, we don't
      // need it because the connection is internal
      adapterOptions: {
        kurentoRemoveRembRtcpFb: true,
      }
    };

    const { mediaId: hgaMediaId, answer: hgaAnswer } = await this.mcs.publish(
      this.presenterMCSUserId, this._voiceBridge, C.RTP, hgaOptions,
    );
    this.hgaRecordingSet.hgaPubMediaId = hgaMediaId;

    this.mcs.onEvent(C.MEDIA_STATE, hgaMediaId, (event) => {
      this._handleHGARecStateChange(event, hgaMediaId);
    });

    // Step 3
    nativeOptions.descriptor = hgaAnswer;
    nativeOptions.mediaId = nativeMediaId;
    await this.mcs.subscribe(this.presenterMCSUserId, sourceMediaId, C.RTP, nativeOptions);

    // Step 4
    recordingOptions.adapter = this._getRecordingAdapter();
    return this.recordViaMCS(hgaMediaId, recordingPath, recordingOptions);
  }

  async recordViaMCS (sourceMediaId, recordingPath, options) {
    if (options.adapter == null) {
      options.adapter = this.presenterAdapter;
    }

    const recordingId = await this.mcs.startRecording(
      this.presenterMCSUserId, sourceMediaId, recordingPath, options,
    );
    this.sendStartShareEvent({ filename: recordingPath });

    return { recordingId, filename: recordingPath, recordingPath };
  }

  _getRecordingAdapter () {
    if (RECORDING_ADAPTER === 'native' || RECORDING_ADAPTER === this.presenterAdapter) {
      return this.presenterAdapter;
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
    const contentCodec = DEFAULT_MEDIA_SPECS.codec_video_content;
    const recordingProfile = (contentCodec === 'VP8' || contentCodec === 'ANY')
      ? this.hasAudio
      ? C.RECORDING_PROFILE_WEBM_FULL
      : C.RECORDING_PROFILE_WEBM_VIDEO_ONLY
      : this.hasAudio
      ? C.RECORDING_PROFILE_MKV_FULL
      : C.RECORDING_PROFILE_MKV_VIDEO_ONLY;
    const format = (contentCodec === 'VP8' || contentCodec === 'ANY')
      ? C.RECORDING_FORMAT_WEBM
      : C.RECORDING_FORMAT_MKV;
    const recordingAdapter = this._getRecordingAdapter();
    const _startRecording = this._getRecordingMethod(recordingAdapter);
    const filename = this.getRecordingFilePathSuffix(
      this.meetingId,
      this._recordingSubPath,
      this._voiceBridge,
      format
    );
    const recordingPath = this.getFullRecordingPath(this.getRecordingBaseDir(recordingAdapter), filename);
    const recordingOptions = {
      recordingProfile,
      mediaProfile: 'content',
      ignoreThresholds: true,
      filename
    };
    this._startRecordingEventFired = false;
    this._stopRecordingEventFired = false;
    const recordingData = await _startRecording(
      this._presenterEndpoint,
      recordingPath,
      recordingOptions,
    );
    this.recording = recordingData;

    return recordingData;
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
      'StartWebRTCDesktopShareEvent',
      this.meetingId,
      filename,
      timestampHR,
      timestampUTC,
      this.userId,
    );
    this.bbbGW.writeMeetingKey(this.meetingId, shareEvent, function() {});
    this._startRecordingEventFired = true;
  }

  /* ======= START PROCEDURES ======= */

  async start (connectionId, bbbUserId, role, descriptor, options = {}) {
    const isConnected = await this.mcs.waitForConnection();

    if (!isConnected) {
      throw errors.MEDIA_SERVER_OFFLINE;
    }

    // Probe akka-apps to see if this is to be recorded
    if (SHOULD_RECORD && role === C.SEND_ROLE) {
      const {
        recorded,
        recording,
        recordFullDurationMedia,
      } = await this.probeForRecordingStatus(this.meetingId, bbbUserId);

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

    if (role === C.RECV_ROLE) {
      try {
        Logger.info(`Starting viewer screensharing session`,
          this._getFullViewerLogMetadata(connectionId));
        const sdpAnswer = await this._startViewer(
          connectionId,
          this._voiceBridge,
          descriptor,
          bbbUserId,
          this._presenterEndpoint,
          options,
        );
        return sdpAnswer;
      } catch (error) {
        throw (this._handleError(LOG_PREFIX, error, role, bbbUserId));
      }
    }

    if (role === C.SEND_ROLE) {
      try {
        Logger.info(`Starting presenter screensharing session`,
          this._getFullPresenterLogMetadata(connectionId));
        const sdpAnswer = await this._startPresenter(descriptor, bbbUserId, connectionId, options);
        return sdpAnswer;
      } catch (error) {
        throw (this._handleError(LOG_PREFIX, error, role, bbbUserId));
      }
    }
  }

  async _startPresenter (descriptor, userId, connectionId, options = {}) {
    try {
      this.status = C.MEDIA_STARTING;
      const presenterMCSUserId = await this.mcs.join(
        this._voiceBridge,
        'SFU',
        { externalUserId: userId, autoLeave: true });
      this.presenterMCSUserId = presenterMCSUserId;
      const presenterSdpAnswer = await this._publishPresenterWebRTCStream(descriptor, options);
      await this.mcs.setContentFloor(this._voiceBridge, this._presenterEndpoint);
      return presenterSdpAnswer;
    } catch (error) {
      Logger.error(`Error on starting screensharing presenter`,
        { ...this._getFullPresenterLogMetadata(this._connectionId), error });
      throw (this._handleError(LOG_PREFIX, error));
    }
  }

  async _publishPresenterWebRTCStream (descriptor, options = {}) {
    try {
      let mediaSpecs;

      if (options.bitrate) {
        mediaSpecs = Screenshare.getCustomMediaSpec(options.bitrate);
      }

      // Get the REMB spec to be used. Screenshare uses the default mixed in with
      // the default spec bitrate. Fetching bitrate by the VP8 codec is just an
      // arbitrary choice that makes no difference.
      // The media specs format isn't flexible enough, so that's what we have
      const kurentoRembParams = { ...KURENTO_REMB_PARAMS };
      this.presenterAdapter = options.mediaServer;
      kurentoRembParams.rembOnConnect = DEFAULT_MEDIA_SPECS.VP8.as_content;
      const mcsOptions = {
        descriptor,
        name: this._assembleStreamName('publish', this.userId, this._voiceBridge),
        mediaProfile: 'content',
        kurentoRembParams,
        adapter: this.presenterAdapter,
        mediaSpecs,
        ignoreThresholds: IGNORE_THRESHOLDS,
        adapterOptions: {
          msHackStripSsrcs: true,
        },
      };

      const { mediaId, answer } = await this.mcs.publish(
        this.presenterMCSUserId,
        this._voiceBridge,
        C.WEBRTC, mcsOptions
      );

      this._presenterEndpoint = mediaId;

      this.mcs.onEvent(C.MEDIA_STATE, this._presenterEndpoint, (event) => {
        this._mediaStateWebRTC(
          event,
          this._presenterEndpoint,
          this._connectionId,
          this._onPresenterMediaFlowing.bind(this),
          this._onPresenterMediaNotFlowing.bind(this)
        );
      });

      this.mcs.onEvent(C.MEDIA_STATE_ICE, this._presenterEndpoint, (event) => {
        this._onMCSIceCandidate(event, this._connectionId, this._presenterEndpoint);
      });

      const presenterSdpAnswer = answer;
      this.flushCandidatesQueue(this.mcs, [...this._presenterCandidatesQueue], this._presenterEndpoint);
      this._presenterCandidatesQueue = [];
      Logger.info(`Presenter WebRTC stream was successfully published`,
        this._getFullPresenterLogMetadata(this._connectionId));

      this.status = C.MEDIA_NEGOTIATED;

      return presenterSdpAnswer;
    }
    catch (err) {
      // Handled in caller @_startPresenter
      this.status = C.MEDIA_NEGOTIATION_FAILED;
      throw err;
    }
  }

  async _fetchContentFloor () {
    const { floor } = await this.mcs.getContentFloor(this._voiceBridge);
    Logger.debug(`Content floor fetched`, { floor, ...this._getPartialLogMetadata()});
    return floor;
  }

  async _startViewer(connectionId, voiceBridge, descriptor, userId, presenterEndpoint, options = {}) {
    this._viewersCandidatesQueue[connectionId] = [];

    try {
      const mcsUserId = await this.mcs.join(
        this._voiceBridge,
        'SFU',
        { externalUserId: userId, autoLeave: true });
      this._viewerUsers[connectionId] = {
        userId,
        connectionId,
        started: false,
      };

      const streamName = this._assembleStreamName('subscribe', userId, this._voiceBridge);
      const mcsOptions = Screenshare.buildSubscriberMCSOptions(
        descriptor, streamName, this.hasAudio, options.mediaServer,
      );

      if (this._presenterEndpoint == null) {
        const floor = await this._fetchContentFloor();
        this._presenterEndpoint = floor? floor.mediaId : null
      }

      const { mediaId, answer } = await this.mcs.subscribe(mcsUserId,
        this._presenterEndpoint, C.WEBRTC, mcsOptions);
      this._viewerEndpoints[connectionId] = mediaId;
      this.flushCandidatesQueue(this.mcs, [...this._viewersCandidatesQueue[connectionId]], this._viewerEndpoints[connectionId]);
      this._viewersCandidatesQueue[connectionId] = [];
      this.mcs.onEvent(C.MEDIA_STATE, mediaId, (event) => {
        this._mediaStateWebRTC(
          event,
          mediaId,
          connectionId,
          this._onViewerWebRTCMediaFlowing.bind(this),
          this._onViewerWebRTCMediaNotFlowing.bind(this),
        );
      });
      this.mcs.onEvent(C.MEDIA_STATE_ICE, mediaId, (event) => {
        this._onMCSIceCandidate(event, connectionId, mediaId);
      });
      Logger.info(`Viewer WebRTC stream was successfully created`,
        this._getFullViewerLogMetadata(connectionId));

      if (PLI_ON_CONNECT && PLI_ON_CONNECT.amount > 0) {
        this._pliSalvo(mediaId, PLI_ON_CONNECT.amount, PLI_ON_CONNECT.interval);
      }

      return answer;
    } catch (error) {
      Logger.error(`Viewer subscribe failed for ${userId} due to ${error.message}`,
        { ...this._getFullViewerLogMetadata(connectionId), error: this._handleError(LOG_PREFIX, error) });
      throw (this._handleError(LOG_PREFIX, error));
    }
  }

  async _startRtmpBroadcast () {
    if (SCREENSHARE_SERVER_AKKA_BROADCAST) {
      try {
        await getScreenBroadcastPermission(
          this.bbbGW, this.meetingId, this._voiceBridge, this.userId, this._connectionId
        );
        this._streamUrl = this._presenterEndpoint;
        const timestamp = Math.floor(new Date());
        const dsrbstam = Messaging.generateScreenshareRTMPBroadcastStartedEvent2x(
          this._voiceBridge,
          this._voiceBridge,
          this._streamUrl,
          this._vw,
          this._vh,
          timestamp, {
            hasAudio: this.hasAudio,
            contentType: this.contentType,
          }
        );
        this.bbbGW.publish(dsrbstam, C.TO_AKKA_APPS);
        this._rtmpBroadcastStarted = true;
        Logger.debug("Sent startRtmpBroadcast", this._getPartialLogMetadata());
      } catch (error) {
        Logger.error("Screenshare won't be broadcasted", {
          ...this._getFullPresenterLogMetadata(this._connectionId), error,
        });
      }
    }
  }

  processAnswer (answer, role, userId, connectionId) {
    const endpoint = this._viewerEndpoints[connectionId];
    if (endpoint) {
      const streamName = this._assembleStreamName('subscribe', userId, this._voiceBridge);
      // If we don't include the cslides spec mcs-core will misread it as a plain
      // video stream...
      const answerWithCSlides = answer + "a=content:slides\r\n";
      const mcsOptions = {
        mediaId: endpoint,
        ...Screenshare.buildSubscriberMCSOptions(answerWithCSlides, this.hasAudio, streamName),
      };

      return this.mcs.subscribe(userId, this._presenterEndpoint, C.WEBRTC, mcsOptions);
    } else return Promise.resolve();
  }

  /* ======= STOP PROCEDURES ======= */

  clearSessionListeners () {
    this.eventNames().forEach(event => {
      this.removeAllListeners(event);
    });
  }

  _sendStopShareEvent ({
    timestampHR = hrTime(),
    timestampUTC = Date.now(),
  }) {
    if (this._stopRecordingEventFired || !this._startRecordingEventFired) return false;

    const shareEvent = Messaging.generateWebRTCShareEvent(
      'StopWebRTCDesktopShareEvent',
      this.meetingId,
      this.recording.filename,
      timestampHR,
      timestampUTC,
      this.userId,
    );
    this.bbbGW.writeMeetingKey(this.meetingId, shareEvent, function(){});
    this._startRecordingEventFired = false;
    this._stopRecordingEventFired = true;

    return true
  }

  async _stopRecording () {
    const handleRecStopped = ({ timestampHR = hrTime(), timestampUTC = Date.now() } = {}) => {
      this._sendStopShareEvent({ timestampHR, timestampUTC });
      this.recording = {};
    };

    const handleRecStopError = (error) => {
      Logger.warn(`stopRecordingFailed for ${this.presenterMCSUserId}`,
        { ...this._getFullPresenterLogMetadata(this._connectionId), error });
      // Send stop event anyways with estimated timestamps so the recording scripts
      // can _at least_ cut the file
      this._sendStopShareEvent();
      this.recording = {};
    };

    // Check if properly started the recording before trying to stop it
    if (this.isSFURecording()) {
      if (this._getRecordingAdapter() === 'bbb-webrtc-recorder') {
        return this._stopWebRTCRecorder().then(handleRecStopped).catch(handleRecStopError);
      }

      return this._stopHGARecordingSet()
        .then(() => this.mcs.stopRecording(this.presenterMCSUserId, this.recording.recordingId))
        .then(handleRecStopped)
        .catch(handleRecStopError);
    }

    return Promise.resolve();
  }

  async _releaseContentFloorIfNeeded () {
    try {
      const currentFloor = await this._fetchContentFloor(this._voiceBridge);
      if (currentFloor && (currentFloor.mediaId === this._presenterEndpoint
        || currentFloor.mediaSessionId === this._presenterEndpoint)) {
        await this.mcs.releaseContentFloor(this._voiceBridge);
      } else {
        return Promise.resolve();
      }
    } catch (error) {
      Logger.error(`Content floor release failed for room ${this._voiceBridge}`,
        { ...this._getPartialLogMetadata(), error });
    }
  }

  stopViewer (id) {
    const viewerUser = this._viewerUsers[id];
    if (viewerUser == null) {
      // User doesn't exist. Probably a stop request glare
      delete this._viewersCandidatesQueue[id];
      delete this._viewerEndpoints[id];
      return Promise.resolve();
    }

    const { userId } = viewerUser;
    const viewerMediaId = this._viewerEndpoints[id];
    Logger.info(`Stopping screenshare viewer ${userId}`,
      this._getFullViewerLogMetadata(id));

    if (viewerMediaId) {
      return this.mcs.unsubscribe(userId, viewerMediaId)
        .then(() => {
          Logger.debug(`Screenshare viewer ${userId} stopped`,
            this._getFullViewerLogMetadata(id));
          delete this._viewersCandidatesQueue[id];
          delete this._viewerEndpoints[id];
          delete this._viewerUsers[id];
        })
        .catch(error => {
          Logger.error(`Viewer unsubscribe failed for ${userId} due to ${error.message}`,
            { ...this._getFullViewerLogMetadata(id), error });
          delete this._viewersCandidatesQueue[id];
          delete this._viewerEndpoints[id];
          delete this._viewerUsers[id];
        });
    } else {
      Logger.warn(`Screenshare viewer ${userId} media ID not found, probably already released`,
        this._getFullViewerLogMetadata(id));
      return Promise.resolve();
    }
  }

  _stopAllViewers () {
    Object.keys(this._viewerUsers).forEach(async connectionId => {
      await this.stopViewer(connectionId);
    });
  }

  // FIXME tether resolve to the Resp even from akka-apps
  _stopRtmpBroadcast () {
    return new Promise((resolve) => {
      if (!SCREENSHARE_SERVER_AKKA_BROADCAST) return resolve();
      const timestamp = Math.floor(new Date());
      const dsrstom = Messaging.generateScreenshareRTMPBroadcastStoppedEvent2x(this._voiceBridge,
        this._voiceBridge, this._streamUrl, this._vw, this._vh, timestamp);
      this.bbbGW.publish(dsrstom, C.TO_AKKA_APPS);
      Logger.debug("Sent stopRtmpBroadcast", this._getPartialLogMetadata());
      resolve();
    });
  }

  // TODO review this one
  _notifyScreenshareEndToBBB () {
    this._stopRtmpBroadcast(this.meetingId).catch(error => {
      // This is an unrecoverable error that should NEVER happen
      Logger.error(`CRITICAL: failed to send stopRtmpBroadcast`,
        { ...this._getFullPresenterLogMetadata(this._connectionId), error });
    });
  }

  async stopPresenter () {
    // Set this right away to avoid trailing stops
    this.status = C.MEDIA_STOPPING;
    // Clear PLI interval if presenter
    this._clearPliSalvo();
    // Stop the recording procedures if needed.
    try {
      await this._stopRecording();
    } catch (error) {
      // Send stop event anyways with estimated timestamps so the recording scripts
      // can _at least_ cut the file
      this._sendStopShareEvent();
      this.recording = {};
    }
    // Send stopRtmpBroadcast message to akka-apps
    this._notifyScreenshareEndToBBB();
    // Check if the presenter user ID is set. If it is, it means this has
    // been started through this process, so clean things up. If it isn't
    // it means this is a viewer-only session and content has been started
    // externally; so don't try to clean presenter stuff here because that's
    // the job of who started it.
    if (this.presenterMCSUserId) {
      if (this._presenterEndpoint) {
        await this._releaseContentFloorIfNeeded();
        try {
          await this.mcs.unpublish(this.presenterMCSUserId, this._presenterEndpoint);
        } catch (error) {
          Logger.error(`Unpublish failed for presenter ${this.presenterMCSUserId} due to ${error.message}`,
            { ...this._getFullPresenterLogMetadata(this._connectionId), error });
        }
      } else {
        Logger.warn(`Screenshare presenter mediaId not set on stop`,
          this._getFullPresenterLogMetadata());
      }
    } else {
      Logger.warn(`Screenshare presenter MCS userId not set on stop`,
        this._getFullPresenterLogMetadata());
    }

    this._stopAllViewers();
    this._presenterEndpoint = null;
    this._candidatesQueue = null;
    this.status = C.MEDIA_STOPPED;
    this.clearSessionListeners();
    this.clearMediaFlowingTimeout(this._connectionId);
  }

  finalDetachEventListeners () {
    this._untrackMCSEvents();
    this.removeAllListeners();
  }

  stop () {
    return new Promise((resolve) => {
      this._untrackMCSEvents();

      switch (this.status) {
        case C.MEDIA_STOPPED:
          Logger.warn(`Screenshare session already stopped`,
            this._getFullPresenterLogMetadata());
          return resolve();

        case C.MEDIA_STOPPING:
          Logger.warn(`Screenshare session already stopping`,
            this._getFullPresenterLogMetadata());
          this.once(C.MEDIA_STOPPED, () => {
            Logger.info(`Screenshare delayed stop resolution for queued stop call`,
              this._getFullPresenterLogMetadata());
            return resolve();
          });
          break;

        case C.MEDIA_STARTING:
          Logger.warn(`Screenshare session still starting on stop, wait.`,
            this._getFullPresenterLogMetadata());
          if (!this._stopActionQueued) {
            this._stopActionQueued = true;
            this.once(C.MEDIA_NEGOTIATED, () => {
              Logger.info(`Screenshare delayed MEDIA_STARTING stop resolution`,
                this._getFullPresenterLogMetadata());
              this.stopPresenter().then(resolve).catch(error => {
                Logger.info(`Screenshare delayed MEDIA_STARTING stop failed`,
                  { errorMessage: error.message, errorCode: error.code, ...this._getFullPresenterLogMetadata });
                return resolve();
              });
            });
          } else {
            this.once(C.MEDIA_STOPPED, () => {
              Logger.info(`Screenshare delayed stop resolution for queued stop call`,
                this._getFullPresenterLogMetadata());
              return resolve();
            });
          }
          break;

        default:
          this.stopPresenter().then(resolve).catch(error => {
            Logger.info(`Screenshare stop failed`,
              { errorMessage: error.message, errorCode: error.code, ...this._getFullPresenterLogMetadata });
            return resolve();
          });
      }
    });
  }
};
