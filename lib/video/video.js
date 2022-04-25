'use strict';

const config = require('config');
const C = require('../bbb/messages/Constants');
const Logger = require('../common/logger.js');
const { hrTime } = require('../common/utils.js');
const Messaging = require('../bbb/messages/Messaging');
const BaseProvider = require('../base/base-provider.js');
const SHOULD_RECORD = config.get('recordWebcams');
const LOG_PREFIX = "[video]";
const errors = require('../base/errors');
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
    this._stopActionQueued = false;
    this.record = record;
    this.mediaServerAdapter = mediaServer;
    this.hgaRecordingSet = {
      nativeSubMediaId: null, // ?: string (<T>)
      hgaPubMediaId: null, // ?: string (<T>)
    };

    this._bindEventHandlers();
    this._trackBigBlueButtonEvents();
    this._trackMCSEvents();
  }

  _bindEventHandlers () {
    this.handleMCSCoreDisconnection = this.handleMCSCoreDisconnection.bind(this);
    this.disconnectUser = this.disconnectUser.bind(this);
    this._handleCamUnsubscribeSysMsg = this._handleCamUnsubscribeSysMsg.bind(this);
    this._handleCamBroadcastStopSysMsg = this._handleCamBroadcastStopSysMsg.bind(this);
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
    this.bbbGW.removeListener(C.CAM_STREAM_UNSUBSCRIBE_SYS_MSG, this._handleCamUnsubscribeSysMsg);
    this.bbbGW.removeListener(C.CAM_BROADCAST_STOP_SYS_MSG, this._handleCamBroadcastStopSysMsg);
  }

  _trackBigBlueButtonEvents () {
    this.bbbGW.on(C.DISCONNECT_ALL_USERS_2x+this.meetingId, this.disconnectUser);
    if (EJECT_ON_USER_LEFT) {
      this.bbbGW.on(C.USER_LEFT_MEETING_2x+this.bbbUserId, this.disconnectUser);
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

  async processAnswer (answer) {
    const stream = Video.getSource(this.id);
    await this.mcs.subscribe(this.userId, stream, C.WEBRTC, { ...this.options, descriptor: answer, mediaId: this.mediaId });
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
            // Record the video stream if it's the original being shared
            if (this.shouldRecord()) {
              this.startRecording().catch(error => {
                Logger.error('Recording start failed', {
                  ...this._getLogMetadata(), error,
                });
              });
            }

            this.sendPlayStart();
            this.status = C.MEDIA_STARTED;
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
        if (details === 'NOT_FLOWING' && this.status !== C.MEDIA_PAUSED) {
          Logger.warn(`Recording media STOPPED FLOWING on endpoint ${endpoint}`,
            this._getLogMetadata());
        } else if (details === 'FLOWING') {
          if (!this._startRecordingEventFired && !GENERATE_TS_ON_RECORDING_EVT) {
            Logger.debug('Firing recording event via flowing event',
              this._getLogMetadata());
            const { timestampHR, timestampUTC } = state;
            this.sendStartShareEvent(timestampHR, timestampUTC);
          }
        }
        break;
      case "Recording":
        if (!this._startRecordingEventFired && GENERATE_TS_ON_RECORDING_EVT) {
          Logger.debug('Firing recording event via experimental event',
            this._getLogMetadata());
          const { timestampHR, timestampUTC } = state;
          this.sendStartShareEvent(timestampHR, timestampUTC);
        }
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

  shouldRecord () {
    return this.isRecorded && this.shared && this.record;
  }

  sendStartShareEvent(timestampHR, timestampUTC) {
    if (timestampHR == null) {
      timestampHR = hrTime();
    }

    if (timestampUTC == null) {
      timestampUTC = Date.now()
    }

    const shareEvent = Messaging.generateWebRTCShareEvent(
      'StartWebRTCShareEvent',
      this.meetingId,
      this.recording.filename,
      timestampHR,
      timestampUTC,
      this.bbbUserId,
    );
    this.bbbGW.writeMeetingKey(this.meetingId, shareEvent, function() {});
    this._startRecordingEventFired = true;
  }

  sendStopShareEvent () {
    const timestampUTC = Date.now()
    const timestampHR = hrTime();
    const stopShareEvent = Messaging.generateWebRTCShareEvent(
      'StopWebRTCShareEvent',
      this.meetingId,
      this.recording.filename,
      timestampHR,
      timestampUTC,
      this.bbbUserId,
    );
    this.bbbGW.writeMeetingKey(this.meetingId, stopShareEvent, function() {});
    this._stopRecordingEventFired = true;
  }

  async _stopHGARecordingSet () {
    const { nativeSubMediaId, hgaPubMediaId } = this.hgaRecordingSet;

    if (nativeSubMediaId) {
      try {
        await this.mcs.unsubscribe(this.userId, nativeSubMediaId);
      } catch(error) {
        Logger.error("HGA: native recording subscriber cleanup failure?",
          { ...this._getLogMetadata(), error, recordingAdapter: RECORDING_ADAPTER });
      } finally {
        this.hgaRecordingSet.nativeSubMediaId = null;
      }
    }

    if (hgaPubMediaId) {
      try {
        await this.mcs.unpublish(this.userId, hgaPubMediaId);
      } catch(error) {
        Logger.error("HGA: hga recording publisher cleanup failure?",
          { ...this._getLogMetadata(), error, recordingAdapter: RECORDING_ADAPTER });
      } finally {
        this.hgaRecordingSet.hgaPubMediaId = null;
      }
    }
  }

  // Hoo-ah! - prlanzarin july 26 2021
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
      adapter: RECORDING_ADAPTER,
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

    // Step 3
    nativeOptions.descriptor = hgaAnswer;
    nativeOptions.mediaId = nativeMediaId;
    await this.mcs.subscribe(this.userId, sourceMediaId, C.RTP, nativeOptions);

    // Step 4 - Hoo-ah!
    recordingOptions.adapter = RECORDING_ADAPTER;
    return this._record(hgaMediaId, recordingPath, recordingOptions);
  }

  async _record (sourceMediaId, recordingPath, options) {
    if (options.adapter == null) {
      options.adapter = this.mediaServerAdapter;
    }

    const recordingId = await this.mcs.startRecording(
      this.userId, sourceMediaId, recordingPath, options,
    );

    return { recordingId, filename: recordingPath, recordingPath };
  }

  _getRecordingAdapter () {
    if (RECORDING_ADAPTER === 'native' || RECORDING_ADAPTER === this.mediaServerAdapter) {
      return this.mediaServerAdapter;
    }

    return RECORDING_ADAPTER;
  }

  _getRecordingMethod () {
    // Specifying that the rec adapter should be the same as the source media's
    // adapter is the same that specifying native; just don't do it.
    if (RECORDING_ADAPTER === 'native' || RECORDING_ADAPTER === this.mediaServerAdapter) {
      return this._record.bind(this);
    } else {
      // Hoo-ah! - prlanzarin july 26 2021
      return this._recordViaHGAdapter.bind(this);
    }
  }

  async startRecording () {
    try {
      const cameraCodec = DEFAULT_MEDIA_SPECS.codec_video_main;
      const recordingName = `${this._cameraProfile}-${this.bbbUserId}`;
      const recordingProfile = (cameraCodec === 'VP8' || cameraCodec === 'ANY')
        ? C.RECORDING_PROFILE_WEBM_VIDEO_ONLY
        : C.RECORDING_PROFILE_MKV_VIDEO_ONLY;
      const format = (cameraCodec === 'VP8' || cameraCodec === 'ANY')
        ? C.RECORDING_FORMAT_WEBM
        : C.RECORDING_FORMAT_MKV;
      const proxiedStartRecording = this._getRecordingMethod();
      const recordingPath = this.getRecordingPath(
        this.meetingId,
        this._recordingSubPath,
        recordingName,
        format,
        this._getRecordingAdapter(),
      );

      const recordingOptions = { recordingProfile, ignoreThresholds: true };
      const recordingData = await proxiedStartRecording(
        this.mediaId, recordingPath, recordingOptions
      );
      this.recording = recordingData;
      this.sendStartShareEvent();
      this.isRecording = true;

      return recordingData;
    } catch (error) {
      throw (this._handleError(LOG_PREFIX, error, this.role, this.id));
    }
  }

  async stopRecording () {
    if (!this._stopRecordingEventFired) {
      this.sendStopShareEvent();
    }

    return this.mcs.stopRecording(this.userId, this.recording.recordingId);
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
      if (this.shouldRecord()
        && this.isRecording
        && this.state !== C.MEDIA_STOPPED) {
        await this.stopRecording();
        this._stopHGARecordingSet();
      }
    } catch (error) {
      Logger.warn(`Error on stopping recording for user ${this.userId} with stream ${this.streamName}`,
        { ...this._getLogMetadata(), error });
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

  async stop () {
    return new Promise((resolve) => {
      this._untrackBigBlueButtonEvents();

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
