'use strict';

const { v4: uuidv4 } = require('uuid');
const config = require('config');
const Logger = require('../common/logger.js');
const { hrTime } = require('../common/utils.js');
const {
  BBBWebRTCRecorder,
  DEFAULT_PUB_CHANNEL,
  DEFAULT_SUB_CHANNEL,
} = require('../common/bbb-webrtc-recorder.js');
const {
  getUserIdFromParticipant,
  isEgressParticipant,
  probeBBBRecordingStatus,
  writeAudioRecordingStartEvent,
  writeAudioRecordingStopEvent,
  writeVideoRecordingEvent,
  trackSourceToString,
} = require('./utils.js');
const { PrometheusAgent, SFULK_NAMES } = require('./metrics/livekit-metrics.js');

const RECORDING_DRY_RUN = config.has('recordingDryRun')
  ? config.get('recordingDryRun')
  : false;
const RECORDING_RETRY_DELAY = 3000; // 3 seconds delay between retries
const MAX_RECORDING_RETRIES = config.has('livekit.maxRecordingRetries')
  ? config.get('livekit.maxRecordingRetries')
  : 50;
const CAPTURE_ON_EXTERNAL_EVENTS_ENABLED = config.has('livekit.captureOnExternalEvents.enabled')
  ? config.get('livekit.captureOnExternalEvents.enabled') === true
  : false;
const UNRETRIABLE_START_ERRORS = [
  'no tracks available',
  'Failed to generate filename',
  'Track info not found',
];
const RECORDER_RECONNECT_TIMEOUT = 30000; // 30 seconds to wait for a reconnect

class LiveKitWebRTCRecorderManager {
  constructor(
    liveKitSDK,
    eventBus,
    roomRecordingStatusMap,
    bbbGW,
    roomMap,
    participantMap,
  ) {
    if (!liveKitSDK
      || !eventBus
      || !roomRecordingStatusMap
      || !bbbGW
      || !roomMap
      || !participantMap
    ) {
      throw new Error('LiveKitWebRTCRecorderManager: liveKitSDK, eventBus, roomRecordingStatusMap, bbbGW, roomMap, and participantMap are required');
    }

    this._liveKitSDK = liveKitSDK;
    this._eventBus = eventBus;
    this._roomRecordingStatusMap = roomRecordingStatusMap;
    this._bbbGW = bbbGW;
    this._roomMap = roomMap;
    this._participantMap = participantMap;

    // TrackInfo is: {
    //   roomName: string,
    //   roomSid: string,
    //   participantId: string,
    //   participantSid: string,
    //   trackId: string,
    //   trackSource: string,
    // }
    // RecordingInfo is: TrackInfo + {
    //   recordingSessionId: string,
    //   filename: string,
    //   recordFullDurationMedia: boolean,
    //   startEventSent: boolean, // Whether the start recording event was sent for this filename
    //   retryCount: number, // Number of retry attempts for the current start request
    // }

    // Map<trackId, TrackInfo>
    this._activeTracks = new Map();
    // Map<roomId, Map<trackId, TrackInfo>>
    this._activeRoomTracks = new Map();
    // Map<trackId, timeout>
    this._recordingRetryTimeouts = new Map();
    this._activeRecordings = new Map();
    this._orphanedRecordings = new Map();
    // Map<meetingId, boolean> - external-event (transcription artifact) capture toggle per meeting
    this._artifactCaptureStatusMap = new Map();
    this._recorderReconnectTimeout = null;
    this._crashTimestampUTC = null;
    this._crashTimestampHR = null;

    this._handleParticipantLeft = this._handleParticipantLeft.bind(this);
    this._handleTrackPublished = this._handleTrackPublished.bind(this);
    this._handleTrackUnpublished = this._handleTrackUnpublished.bind(this);
    this._handleRecordingStoppedEvt = this._handleRecordingStoppedEvt.bind(this);
    this._handleRecordingRtpStatusChanged = this._handleRecordingRtpStatusChanged.bind(this);
    this._handleRecorderCrash = this._handleRecorderCrash.bind(this);

    this.recorder = new BBBWebRTCRecorder(DEFAULT_PUB_CHANNEL, DEFAULT_SUB_CHANNEL, {
      notifyRecordingStopOnCrash: false,
    });
    this._trackRecorderEvents();
    this.recorder.start();
  }

  _trackRecorderEvents() {
    this.recorder.on('recorderInstanceStarted', () => {
      PrometheusAgent.set(SFULK_NAMES.RECORDER_STATUS, 1);
      // This serves as a sync trigger for both boot and recorder restarts
      this.synchronizeRecordings();
    });
    this.recorder.on('recorderInstanceStopped', this._handleRecorderCrash);
    this.recorder.on('incomingMessage', (msg) => {
      PrometheusAgent.increment(SFULK_NAMES.RECORDER_IN_REQUESTS, {
        method: msg?.id || 'unknown',
      });
    });
    this.recorder.on('outgoingMessage', (msg) => {
      PrometheusAgent.increment(SFULK_NAMES.RECORDER_OUT_REQUESTS, {
        method: msg?.id || 'unknown',
      });
    });
  }

  getActiveTracksInRoom(meetingId) {
    return this._activeRoomTracks.get(meetingId);
  }

  setActiveTrackInRoom(trackInfo, roomId) {
    const { trackId } = trackInfo;

    if (!roomId) return;

    const roomTracks = this._activeRoomTracks.get(roomId);

    if (!roomTracks) {
      this._activeRoomTracks.set(roomId, new Map([[trackId, trackInfo]]));
    } else {
      roomTracks.set(trackId, trackInfo);
    }
  }

  deleteActiveTrackInRoom(trackId, roomId) {
    if (!roomId) return;

    const roomTracks = this._activeRoomTracks.get(roomId);

    if (roomTracks) {
      roomTracks.delete(trackId);

      if (roomTracks.size === 0) this._activeRoomTracks.delete(roomId);
    }
  }

  isTrackActiveInRoom(trackId, roomId) {
    if (!roomId) return false;

    const roomTracks = this._activeRoomTracks.get(roomId);

    return roomTracks && roomTracks.has(trackId);
  }

  setActiveTrack(trackInfo, { roomId }) {
    const { trackId } = trackInfo;
    this._activeTracks.set(trackId, trackInfo);
    this.setActiveTrackInRoom(trackInfo, roomId);
  }

  isTrackActive(trackId, { roomId }) {
    return this._activeTracks.has(trackId) ||
      this.isTrackActiveInRoom(trackId, roomId);
  }

  deleteActiveTrack(trackId, { roomId }) {
    this._activeTracks.delete(trackId);
    this.deleteActiveTrackInRoom(trackId, roomId);
  }

  _evaluateCapture(
    meetingId,
    recordableMeeting,
    recordFullDurationMedia,
    trackSource, {
      recordUserAudio = true,
      recordUserCameras = true,
      recordUserScreenShare = true,
      trackId = null,
  } = {}) {
    const meetingIsRecording = this._roomRecordingStatusMap.get(meetingId);
    // If trackId is provided, check if the track is active - otherwise, ignore it
    const trackIsActive = trackId ? this.isTrackActive(trackId, { roomId: meetingId }) : true;
    let recordTrackSource = true;

    switch (trackSource) {
      case 'microphone':
        recordTrackSource = recordUserAudio;
        break;

      case 'camera':
        recordTrackSource = recordUserCameras;
        break;

      case 'screen_share':
      case 'screen_share_audio':
        recordTrackSource = recordUserScreenShare;
        break;

      default:
        Logger.warn('LiveKitWebRTCRecorderManager: Unknown track source, assuming recordable', {
          meetingId,
          trackSource,
        });
        recordTrackSource = true;
    }

    // Config matrix that defines whether a track should be recorded based on BBB's recording logic:
    // - recordableMeeting: `record` flag
    // - recordFullDurationMedia
    // - meetingIsRecording: recording is in progress
    // - recordTrackSource: based on track source and corresponding recordUser* flag
    const bbbRecordingMatrix = !!(
      recordableMeeting
        && (recordFullDurationMedia || meetingIsRecording)
        && recordTrackSource
    );

    // Capture condition based on external events (e.g.: transcription artifacts)
    // This is independent of BBB's recording logic and can be on even if the
    // meeting is not being recorded by BBB.
    // Meeting-wide; intentionally ignores recordableMeeting and recordUserAudio.
    // Microphone only for now.
    const artifactCapture = !!(
      CAPTURE_ON_EXTERNAL_EVENTS_ENABLED
        && this._artifactCaptureStatusMap.get(meetingId) === true
        && trackSource === 'microphone'
    );

    const shouldRecord = (
      (bbbRecordingMatrix || artifactCapture) && trackIsActive
    ) || RECORDING_DRY_RUN;

    return { shouldRecord, bbbRecordingMatrix, artifactCapture };
  }

  _shouldRecord(
    meetingId,
    recordableMeeting,
    recordFullDurationMedia,
    trackSource,
    options = {}) {
    return this._evaluateCapture(
      meetingId,
      recordableMeeting,
      recordFullDurationMedia,
      trackSource,
      options,
    ).shouldRecord;
  }

  _generateFilename(source, meetingId, userId, trackId, suffix) {
    switch (source) {
      case 'microphone':
        return `audio/${meetingId}/${source}-${userId}-${trackId}-${suffix}.webm`;

      case 'camera': {
        return `recordings/${meetingId}/${source}-${userId}-${trackId}-${suffix}.webm`;
      }

      case 'screen_share': {
        return `screenshare/${meetingId}/${source}-${userId}-${trackId}-${suffix}.webm`;
      }

      case 'screen_share_audio': {
        return `audio/${meetingId}/${source}-${userId}-${trackId}-${suffix}.webm`;
      }

      default:
        Logger.warn('LiveKitWebRTCRecorderManager: Unknown track source, filename generation skipped', { source });
        return null;
    }
  }

  async shouldRecordParticipantTrack(roomName, participantId, trackSource, {
    recordingInfo = {},
  } = {}) {
    const {
      recorded,
      recording,
      recordFullDurationMedia,
      recordUserCameras,
      recordUserAudio,
      recordUserScreenShare,
    } = await probeBBBRecordingStatus(
      this._bbbGW,
      roomName,
      participantId,
    );

    const { shouldRecord, bbbRecordingMatrix, artifactCapture } = this._evaluateCapture(
      roomName,
      recorded,
      recordFullDurationMedia,
      trackSource,
      { recordUserCameras, recordUserAudio, recordUserScreenShare },
    );
    const externalEventCapture = artifactCapture && !bbbRecordingMatrix;

    if (!shouldRecord) {
      Logger.info('LiveKitWebRTCRecorderManager: Recording not required', {
        roomName,
        participantId,
        trackSource,
        recorded,
        recording,
        recordFullDurationMedia,
        recordUserCameras,
        recordUserAudio,
        recordUserScreenShare,
        recordingInfo,
      });

      return {
        shouldRecord: false,
        recorded,
        recordFullDurationMedia,
        recordUserCameras,
        recordUserAudio,
        recordUserScreenShare,
        externalEventCapture,
      };
    }

    return {
      shouldRecord: true,
      recorded,
      recordFullDurationMedia,
      recordUserCameras,
      recordUserAudio,
      recordUserScreenShare,
      externalEventCapture,
    };
  }

  async _startRecording(recordingInfo) {
    const {
      trackId,
      participantId: userId,
      trackSource: source,
      recordingSessionId,
    } = recordingInfo;
    let {
      roomName: meetingId,
    } = recordingInfo;

    // LiveKit sometimes doesn't provide the roomName in the track_published webhook.
    // This is a fallback for that case. Once the bug is fixed in LK, the code
    // below can be removed.
    if (meetingId == null) {
      const participant = this._participantMap.get(userId);
      meetingId = participant?.roomName;

      if (meetingId) {
        Logger.warn('LiveKitWebRTCRecorderManager: track_published webhook missing roomName attribute, recovered via participant map', {
          trackId,
          userId,
          roomName: meetingId,
        });

        PrometheusAgent.increment(SFULK_NAMES.HOOKS_MISSING_ATTRIBUTE, {
          attribute: 'roomName',
        });

        // Update recordingInfo so subsequent logic has the correct meetingId.
        recordingInfo.roomName = meetingId;
      }
    }

    if (trackId == null
      || meetingId == null
      || userId == null
      || source == null
      || recordingSessionId == null) {
      Logger.warn('LiveKitWebRTCRecorderManager: Track info not found, won\'t record', { recordingInfo });
      throw new Error('Track info not found');
    }

    if (!this.isTrackActive(trackId, { roomId: meetingId })) {
      Logger.warn('LiveKitWebRTCRecorderManager: Track not active, won\'t record', { recordingInfo });
      return null;
    }

    const suffix = Date.now();
    const {
      shouldRecord,
      recorded,
      recordFullDurationMedia,
      recordUserCameras,
      recordUserAudio,
      recordUserScreenShare,
      externalEventCapture,
    } = await this.shouldRecordParticipantTrack(
      meetingId,
      userId,
      source,
      { recordingInfo },
    );

    if (!shouldRecord) return null;

    const filename = this._generateFilename(
      source,
      meetingId,
      userId,
      trackId,
      suffix
    );

    if (!filename) {
      Logger.warn('LiveKitWebRTCRecorderManager: Failed to generate filename', {
        recordingSessionId,
        recordingInfo,
      });
      throw new Error('Failed to generate filename');
    }

    recordingInfo.recorded = recorded;
    recordingInfo.recordFullDurationMedia = recordFullDurationMedia;
    recordingInfo.recordUserCameras = recordUserCameras;
    recordingInfo.recordUserAudio = recordUserAudio;
    recordingInfo.recordUserScreenShare = recordUserScreenShare;
    recordingInfo.externalEventCapture = externalEventCapture;
    recordingInfo.filename = `/var/lib/bbb-webrtc-recorder/${filename}`;
    recordingInfo.startEventSent = false;
    recordingInfo.retryCount = recordingInfo.retryCount || 0;

    Logger.debug('LiveKitWebRTCRecorderManager: Starting recording', {
      recordingInfo,
      filename,
    });

    this._addActiveRecording(trackId, recordingInfo);

    await this.recorder.startRecording(
      recordingSessionId,
      filename, {
        adapter: 'livekit',
        adapterOptions: {
          livekit: {
            room: meetingId,
            trackIds: [trackId],
          },
        },
        metadata: {
          participantId: userId,
          trackSource: source,
        },
        recordingStoppedHdlr: this._handleRecordingStoppedEvt,
        rtpStatusChangedHdlr: this._handleRecordingRtpStatusChanged,
      }
    );
    Logger.info('LiveKitWebRTCRecorderManager: Recording started', {
      recordingInfo,
    });
    this._resetRetryCount(trackId);

    return recordingInfo;
  }

  async _startRecordingRetriable(recordingInfo) {
    try {
      await this._startRecording(recordingInfo);
    } catch (error) {
      Logger.error('LiveKitWebRTCRecorderManager: Failed to start recording', {
        recordingInfo,
        errorMessage: error.message,
        errorStack: error.stack,
      });

      if (!this._retriableStartError(error.message)) {
        // These are errors where retries won't help, so we just skip
        if (recordingInfo?.trackId) {
          this._deleteActiveRecording(recordingInfo.trackId);
          this._deleteRecordingRetryTimeout(recordingInfo.trackId);
        }

        // Increment the error metric for this error as it won't even be retried
        PrometheusAgent.increment(SFULK_NAMES.RECORDING_ERRORS, {
          error: error.message || 'unknown',
        });

        return;
      }

      // If the error is retriable, we schedule a retry through the
      // stopped event handler
      this._handleRecordingStoppedEvt({
        recordingSessionId: recordingInfo.recordingSessionId,
        reason: 'startFailed',
      });
    }
  }

  async _handleTrackPublished(event) {
    Logger.debug('LiveKitWebRTCRecorderManager: _handleTrackPublished', { event });
    const source = trackSourceToString(this._liveKitSDK, event.track?.source);
    const participantId = getUserIdFromParticipant(event.participant);
    const recordingSessionId = uuidv4();
    const trackInfo = {
      recordingSessionId,
      roomName: event.room?.name,
      roomSid: event.room?.sid,
      participantId,
      participantSid: event.participant?.sid,
      trackId: event.track?.sid,
      trackSource: source,
    };

    trackInfo.retryCount = 0;
    this.setActiveTrack(trackInfo, { roomId: trackInfo.roomName });
    this._startRecordingRetriable(trackInfo);
  }

  _reEvaluateActiveRecording(meetingId, recordingInfo) {
    const { shouldRecord, bbbRecordingMatrix, artifactCapture } = this._evaluateCapture(
      meetingId,
      recordingInfo.recorded,
      recordingInfo.recordFullDurationMedia,
      recordingInfo.trackSource,
      {
        trackId: recordingInfo.trackId,
        recordUserCameras: recordingInfo.recordUserCameras,
        recordUserAudio: recordingInfo.recordUserAudio,
        recordUserScreenShare: recordingInfo.recordUserScreenShare,
      },
    );

    recordingInfo.externalEventCapture = artifactCapture && !bbbRecordingMatrix;

    return shouldRecord;
  }

  handleRecordingStatusChanged(meetingId, recording) {
    this._roomRecordingStatusMap.set(meetingId, recording);

    Logger.debug('LiveKitWebRTCRecorderManager: Recording status changed', {
      meetingId,
      recording,
    });

    const roomMap = this.getActiveTracksInRoom(meetingId);

    if (!roomMap) return;

    // eslint-disable-next-line no-unused-vars
    for (const [_, trackInfo] of roomMap) {
      const recordingInfo = this._activeRecordings.get(trackInfo.trackId);

      if (recording) {
        if (!recordingInfo) {
          // Start recording for this track if not already recording
          this._startRecordingRetriable(trackInfo);
        }
      } else if (recordingInfo
        && !this._reEvaluateActiveRecording(meetingId, recordingInfo)
        && !RECORDING_DRY_RUN) {
        // Stop only if no capture condition (recording matrix OR external-event) still
        // justifies it - so an artifact capture survives "recording off".
        this.stopRecording(recordingInfo.recordingSessionId);
        this._deleteRecordingRetryTimeout(trackInfo.trackId);
      }
    }

    this._updateExternalCaptureMetrics();
  }

  handleExternalCaptureStatusChanged(meetingId, enabled, eventName) {
    this._artifactCaptureStatusMap.set(meetingId, enabled);

    Logger.debug('LiveKitWebRTCRecorderManager: Artifact capture status changed', {
      meetingId,
      enabled,
      eventName,
    });

    const roomMap = this.getActiveTracksInRoom(meetingId);

    if (!roomMap) return;

    // eslint-disable-next-line no-unused-vars
    for (const [_, trackInfo] of roomMap) {
      const recordingInfo = this._activeRecordings.get(trackInfo.trackId);

      if (enabled) {
        // Start microphone tracks not already capturing. _startRecording ->
        // shouldRecordParticipantTrack -> _evaluateCapture makes the final decision.
        if (!recordingInfo && trackInfo.trackSource === 'microphone') {
          this._startRecordingRetriable(trackInfo);
        }
      } else if (recordingInfo
        && !this._reEvaluateActiveRecording(meetingId, recordingInfo)
        && !RECORDING_DRY_RUN) {
        // Stop captures no longer justified by any condition once artifacts are disabled.
        this.stopRecording(recordingInfo.recordingSessionId);
        this._deleteRecordingRetryTimeout(trackInfo.trackId);
      }
    }

    this._updateExternalCaptureMetrics();
  }

  async _handleTrackUnpublished(event) {
    Logger.debug('LiveKitWebRTCRecorderManager: _handleTrackUnpublished', { event });
    const trackId = event.track?.sid;
    const roomId = event.room?.name;

    if (!trackId) return;

    this.deleteActiveTrack(trackId, { roomId });
    this._deleteRecordingRetryTimeout(trackId);

    const recordingInfo = this._activeRecordings.get(trackId);

    if (!recordingInfo) return;

    this.stopRecording(recordingInfo.recordingSessionId);
    this._deleteRecordingRetryTimeout(trackId);
  }

  async _handleParticipantLeft(event) {
    const { kind } = event.participant;
    const participantId = getUserIdFromParticipant(event.participant);

    if (!isEgressParticipant(kind)) return;

    Logger.debug('LiveKitWebRTCRecorderManager: _handleParticipantLeft', { event });

    // Stop all recordings for this participant. This is can either be a
    // normal thing (e.g.: meeting end) or an abnormal thing.
    // Keep in mind there's a single egress participant per meeting when using
    // bbb-webrtc-recorder, so this will stop all recordings for the meeting.
    // TODO track participant reconnection and re-start recordings
    for (const [trackId, recordingInfo] of this._activeRecordings.entries()) {
      if (recordingInfo.participantId === participantId) {
          this.stopRecording(recordingInfo.recordingSessionId);
          this._deleteRecordingRetryTimeout(trackId);
      }
    }
  }

  _restartRecording(recordingInfo, reason = 'retriableFailure') {
    const { trackId, roomName: meetingId, recordingSessionId } = recordingInfo;
    const trackIsActive = this.isTrackActive(trackId, { roomId: meetingId });

    if (trackIsActive) {
      // Only increment the error metric if the track is still active -
      // otherwise, it's a false positive (e.g.: meeting end causes this because
      // LK's server-sdk-go disconnect reason is incorrectly normalized to "other
      // reasons" when the meeting ends - which ends up being reason=failed here)
      PrometheusAgent.increment(SFULK_NAMES.RECORDING_ERRORS, {
        error: reason,
      });

      Logger.error(`LiveKitWebRTCRecorderManager: Recording stopped abruptly: ${reason}`, {
        recordingInfo,
        reason,
        recordingSessionId,
        trackIsActive,
      });
    }

    // Only retry if the track is still active AND retry limit not reached
    if (trackIsActive && !this._retryExpired(recordingInfo)) {
      this._scheduleRecordingRetry(recordingInfo);
    } else if (!trackIsActive) {
      Logger.warn('LiveKitWebRTCRecorderManager: Track no longer active, skipping retry', {
        trackId,
        meetingId,
      });
      this._deleteActiveRecording(trackId);
      this._deleteRecordingRetryTimeout(trackId);
    } else {
      Logger.error('LiveKitWebRTCRecorderManager: Max recording retries reached, giving up.', {
        recordingInfo,
        maxRetries: MAX_RECORDING_RETRIES,
      });
      PrometheusAgent.increment(SFULK_NAMES.RECORDER_RETRY_FAILURES, {
        error: 'maxRetries',
      });
      this._deleteActiveRecording(trackId);
      this._deleteRecordingRetryTimeout(trackId);
    }
  }

  async _handleRecordingStoppedEvt({ recordingSessionId, reason } = {}) {
    let recordingInfo = null;

    for (const info of this._activeRecordings.values()) {
      if (info.recordingSessionId === recordingSessionId) {
        recordingInfo = info;
        break;
      }
    }

    if (!recordingInfo) {
      Logger.warn('LiveKitWebRTCRecorderManager: recording info not found on recording stopped event', {
        recordingSessionId,
        reason,
      });
      return;
    }

    const { trackId } = recordingInfo;
    const timestampHR = hrTime();
    const timestampUTC = Date.now();

    // Always remove from active recordings map upon stop notification from recorder
    // Do this early to prevent race conditions with new start attempts.
    this._deleteActiveRecording(trackId);
    this._sendStopEvent(recordingInfo, { timestampUTC, timestampHR, reason });

    switch (reason) {
      case 'stopped':
      case 'stop requested':
      case 'session not found':
        // These are expected terminal stop reasons, no further action needed.
        this._deleteRecordingRetryTimeout(trackId);
        break;

      case 'closed':
      case 'disconnected':
      case 'recorderCrash':
      case 'startFailed':
      case 'application_shutdown':
      default: {
        // Treat unknown reasons as potential failures requiring retry check
        this._restartRecording(recordingInfo, reason);
        break;
      }
    }
  }

  _scheduleRecordingRetry(recordingInfo) {
    const {
      trackId,
      roomName: meetingId,
      recorded,
      recordFullDurationMedia,
      recordUserCameras,
      recordUserAudio,
      recordUserScreenShare,
      trackSource,
    } = recordingInfo;
    const trackAndRoomActive = () => this._shouldRecord(
      meetingId,
      recorded,
      recordFullDurationMedia,
      trackSource,
      { trackId, recordUserCameras, recordUserAudio, recordUserScreenShare }
    );

    this._deleteRecordingRetryTimeout(trackId);

    if (!trackId || !meetingId) {
      Logger.warn('LiveKitWebRTCRecorderManager: Retry info not found', { recordingInfo });
      return;
    }

    if (!trackAndRoomActive()) {
      Logger.warn('LiveKitWebRTCRecorderManager: Track or room not active, skip retry', { recordingInfo });
      return;
    }

    Logger.debug('LiveKitWebRTCRecorderManager: Scheduling recording retry', {
      trackId,
      recordingInfo,
      retryCount: recordingInfo.retryCount + 1, // Log the upcoming retry count
      delay: RECORDING_RETRY_DELAY,
    });

    PrometheusAgent.increment(SFULK_NAMES.RECORDER_RETRIES);

    const timeout = setTimeout(() => {
      const shouldRetryNow = trackAndRoomActive();

      if (!shouldRetryNow) {
        Logger.warn('LiveKitWebRTCRecorderManager: status changed before retry execution, cancelling retry', {
          trackId,
          meetingId,
          recordingInfo,
          isTrackActive: this.isTrackActive(trackId, { roomId: meetingId }),
          isRoomRecording: this._roomRecordingStatusMap.get(meetingId),
        });
        this._deleteActiveRecording(trackId);
        this._deleteRecordingRetryTimeout(trackId);
        return;
      }

      recordingInfo.retryCount = (recordingInfo.retryCount || 0) + 1;

      this._startRecording(recordingInfo).catch((error) => {
        Logger.error('LiveKitWebRTCRecorderManager: Recording retry failed', {
          trackId,
          recordingInfo,
          errorMessage: error.message,
          errorStack: error.stack,
        });

        const retryExpired = this._retryExpired(recordingInfo);
        const retriableError = this._retriableStartError(error.message);

        if (!retryExpired && retriableError) {
          this._scheduleRecordingRetry(recordingInfo);
        } else {
          Logger.error('LiveKitWebRTCRecorderManager: recording retry failed, giving up', {
            recordingInfo,
            retryExpired,
            retriableError,
            errorMessage: error.message,
          });
          this._deleteActiveRecording(trackId);
          this._deleteRecordingRetryTimeout(trackId);
          PrometheusAgent.increment(SFULK_NAMES.RECORDER_RETRY_FAILURES, {
            error: retryExpired ? 'maxRetries' : error.message,
          });
        }
      });
    }, RECORDING_RETRY_DELAY);

    this._addRecordingRetryTimeout(trackId, timeout);
  }

  _handleRecordingRtpStatusChanged(event) {
    const { recordingSessionId, status } = event;

    let recordingInfo = null;
    for (const info of this._activeRecordings.values()) {
      if (info.recordingSessionId === recordingSessionId) {
        recordingInfo = info;
        break;
      }
    }

    if (!recordingInfo) {
      Logger.warn('LiveKitWebRTCRecorderManager: Recording info not found on RTP status change', {
        recordingSessionId,
        status,
      });
      return;
    }

    Logger.debug('LiveKitWebRTCRecorderManager: Recording RTP status changed', {
      recordingInfo,
      status,
    });

    const {
      roomName: meetingId,
      participantId: userId,
      trackSource: source,
      filename,
      trackId,
      recorded,
      recordFullDurationMedia,
      trackSource,
      recordUserCameras,
      recordUserAudio,
      recordUserScreenShare,
    } = recordingInfo;
    const timestampHR = hrTime();
    const timestampUTC = Date.now();

    switch (status) {
      case 'flowing': {
        // Second param: recordableMeeting - always true if we reached this point
        const shouldStillRecord = this._shouldRecord(
          meetingId,
          recorded,
          recordFullDurationMedia,
          trackSource,
          { trackId, recordUserCameras, recordUserAudio, recordUserScreenShare }
        );
        this._resetRetryCount(trackId);

        if (!shouldStillRecord) {
          Logger.info('LiveKitWebRTCRecorderManager: trailing RTP status changed, stopping recording', {
            recordingInfo,
          });
          this.stopRecording(recordingSessionId);
          this._deleteRecordingRetryTimeout(trackId);
          return;
        }

        if (!recordingInfo.startEventSent && shouldStillRecord) {
          switch (source) {
            case 'microphone':
            case 'screen_share_audio': {
              writeAudioRecordingStartEvent(
                this._bbbGW,
                meetingId,
                userId,
                filename,
                source,
                timestampHR,
                timestampUTC,
              );
              break;
            }

            case 'camera': {
              writeVideoRecordingEvent(
                'StartWebRTCShareEvent',
                this._bbbGW,
                meetingId,
                filename,
                timestampHR,
                timestampUTC,
                userId,
              );
              break;
            }

            case 'screen_share': {
              writeVideoRecordingEvent(
                'StartWebRTCDesktopShareEvent',
                this._bbbGW,
                meetingId,
                filename,
                timestampHR,
                timestampUTC,
                userId,
              );
              break;
            }

            default:
              return;
          }

          recordingInfo.startEventSent = true;
          this._addActiveRecording(recordingInfo.trackId, recordingInfo);
          PrometheusAgent.increment(SFULK_NAMES.RECORDER_START_EVENTS, { source });
        }
        break;
      }

      case 'not_flowing': {
        Logger.warn('LiveKitWebRTCRecorderManager: Recording RTP not flowing', {
          recordingInfo,
          status,
        });
        break;
      }

      default:
        return;
    }
  }

  async stopRecording(recordingSessionId) {
    try {
      const { timestampUTC, timestampHR } = await this.recorder.stopRecording(recordingSessionId);
      return { timestampUTC, timestampHR };
    } catch (error) {
      Logger.error('LiveKitWebRTCRecorderManager: Failed to stop recording', {
        recordingSessionId,
        errorMessage: error.message,
        errorStack: error.stack,
      });
      this._handleRecordingStoppedEvt({
        recordingSessionId,
        reason: 'stopped',
      });
      return { timestampUTC: Date.now(), timestampHR: hrTime() };
    }
  }

  async synchronizeRecordings() {
    const handleSyncFailure = (error) => {
      Logger.error('LiveKitWebRTCRecorderManager: Failed to synchronize recordings', {
        errorMessage: error.message,
        errorStack: error.stack,
      });

      if (this._orphanedRecordings.size > 0) {
        this._handleLostRecordings(this._orphanedRecordings);
        this._clearOrphanedRecordings();
      }
    };

    Logger.info('LiveKitWebRTCRecorderManager: Starting recording synchronization', {
      activeRecordings: this._activeRecordings.size,
      orphanedRecordings: this._orphanedRecordings.size,
    });
    this._clearRecorderReconnectTimeout();

    try {
      const { recordings } = await this.recorder.getRecordings();

      if (!recordings) {
        Logger.error('LiveKitWebRTCRecorderManager: getRecordings is missing recordings array, clearing everything', {
          activeRecordings: this._activeRecordings.size,
          orphanedRecordings: this._orphanedRecordings.size,
        });

        // If sync fails during limbo, trigger lost recordings scenario.
        handleSyncFailure(new Error('getRecordings returned invalid response'));

        return;
      }

      Logger.info(`LiveKitWebRTCRecorderManager: getRecordings returned ${recordings.length} recordings`, {
        activeRecordings: this._activeRecordings.size,
        orphanedRecordings: this._orphanedRecordings.size,
      });

      // Assemble all recordings active on the recorder
      const remoteRecordingsMap = new Map();
      recordings.forEach(r => {
        if (r.adapter === 'livekit' && r.adapterOptions?.livekit?.trackIds?.length > 0) {
          const trackId = r.adapterOptions.livekit.trackIds[0];
          remoteRecordingsMap.set(trackId, r);
        }
      });

      // Create a unified map of all locally tracked recordings
      const allLocalRecordings = new Map([
        ...this._activeRecordings,
        ...this._orphanedRecordings,
      ]);
      // Deduplicate
      const localIds = new Set(allLocalRecordings.keys());
      const remoteIds = new Set(remoteRecordingsMap.keys());

      // 1. Handle recordings that are on the recorder.
      // This covers both survived recordings (from orphaned) and untracked (boot-up)
      remoteRecordingsMap.forEach((remoteRecording) => {
        this._resyncRecording(remoteRecording);
      });

      // 2. Handle recordings that were tracked locally but are now gone from the recorder.
      const lostRecordingIds = [...localIds].filter(id => !remoteIds.has(id));

      if (lostRecordingIds.length > 0) {
        const lostRecordings = new Map();
        lostRecordingIds.forEach(id => {
          lostRecordings.set(id, allLocalRecordings.get(id));
        });
        this._handleLostRecordings(lostRecordings);
      }

      // 3. Cleanup
      this._clearOrphanedRecordings();

      Logger.info('LiveKitWebRTCRecorderManager: Recording synchronization finished');
    } catch (error) {
      handleSyncFailure(error);
    }
  }

  init() {
    this._eventBus.on('participant_left', this._handleParticipantLeft);
    this._eventBus.on('track_published', this._handleTrackPublished);
    this._eventBus.on('track_unpublished', this._handleTrackUnpublished);

    Logger.info('LiveKitWebRTCRecorderManager initialized');
  }

  async stopAllFromMeeting(meetingId) {
    this._artifactCaptureStatusMap.delete(meetingId);
    const recordingsToStop = Array.from(this._activeRecordings.values())
      .filter(recordingInfo => recordingInfo.roomName === meetingId);
    const stopPromises = recordingsToStop.map(recordingInfo => {
      return Promise.race([
        this.stopRecording(recordingInfo.recordingSessionId),
        new Promise((resolve) => {
          setTimeout(() => resolve(), BBBWebRTCRecorder.REQUEST_TIMEOUT);
        }),
      ]);
    });
    await Promise.all(stopPromises);
  }

  async stop() {
    const stopPromises = Array.from(this._activeRecordings.values())
      .map(recordingInfo => {
        return Promise.race([
          this.stopRecording(recordingInfo.recordingSessionId),
          new Promise((resolve) => {
            setTimeout(() => resolve(), BBBWebRTCRecorder.REQUEST_TIMEOUT);
          }),
        ]);
      });

    await Promise.all(stopPromises);

    this._clearActiveRecordings();
    this._clearOrphanedRecordings();
    this._clearRecorderReconnectTimeout();
    for (const trackId of this._recordingRetryTimeouts.keys()) {
      this._deleteRecordingRetryTimeout(trackId);
    }
    this._recordingRetryTimeouts.clear(); // Ensure map is empty
    this._activeTracks.clear();
    this._activeRoomTracks.clear();
    this._artifactCaptureStatusMap.clear();

    PrometheusAgent.set(SFULK_NAMES.RECORDER_ACTIVE_RECORDINGS, 0);
    PrometheusAgent.set(SFULK_NAMES.RECORDER_PENDING_RETRY_TIMEOUTS, 0);
    PrometheusAgent.set(SFULK_NAMES.EXTERNAL_EVENT_CAPTURES, 0);

    Logger.info('LiveKitWebRTCRecorderManager stopped');
  }

  async _resyncRecording(recordingData) {
    const { fileName, recordingSessionId, metadata } = recordingData;
    const trackId = recordingData.adapterOptions.livekit.trackIds[0];
    const roomName = recordingData.adapterOptions.livekit.room;

    try {
      const { participantId, trackSource } = metadata || {};

      if (!participantId || !trackSource) {
        throw new Error(`Resynced recording missing essential metadata: ${recordingSessionId}`);
      }

      const {
        shouldRecord,
        recorded,
        recordFullDurationMedia,
        recordUserCameras,
        recordUserScreenShare,
        recordUserAudio,
        externalEventCapture,
      } = await this.shouldRecordParticipantTrack(
        roomName,
        participantId,
        trackSource,
        { recordingData }
      );
      const recordingInfo = {
        recordingSessionId,
        roomName,
        participantId,
        trackId,
        trackSource,
        filename: fileName,
        recorded,
        recordFullDurationMedia,
        recordUserCameras,
        recordUserScreenShare,
        recordUserAudio,
        externalEventCapture,
        // FIXME this local startEvent flag sucks. It really sucks. Just pull the
        // info from Redis. Check the regular stop handler as well. - prlanzarin
        startEventSent: !!recordingData.startTimeUTC,
        retryCount: 0,
      };

      if (!shouldRecord) {
        Logger.warn('LiveKitWebRTCRecorderManager: Resynced recording is no longer required, stopping it.', {
          recordingSessionId,
          recordingInfo,
        });
        await this.stopRecording(recordingSessionId);

        return;
      }

      this._addActiveRecording(trackId, recordingInfo);
      PrometheusAgent.increment(SFULK_NAMES.RECORDER_RESYNCED_RECORDINGS);
      Logger.info('LiveKitWebRTCRecorderManager: Resynced recording successfully', { recordingInfo });
    } catch (error) {
      Logger.error('LiveKitWebRTCRecorderManager: Failed to resync recording, stopping on recorder', {
        errorMessage: error.message,
        errorStack: error.stack,
        recordingData,
      });
      await this.stopRecording(recordingSessionId).catch((srErr) => {
        Logger.error('LiveKitWebRTCRecorderManager: Failed to stop dangling recording after resync failure', {
          recordingSessionId,
          errorMessage: srErr.message,
          errorStack: srErr.stack,
        });
      });
    }
  }

  _handleLostRecordings(lostRecordings) {
    lostRecordings.forEach((recordingInfo) => {
      Logger.warn('LiveKitWebRTCRecorderManager: Recording session confirmed lost', {
        recordingInfo,
        crashTimestampUTC: this._crashTimestampUTC,
        crashTimestampHR: this._crashTimestampHR,
      });

      // Send a stop event with the saved crash timestamp. It's our best guess
      // right now re. stop time - but ideally RAP would give us the actual stop
      // by inferring it from the track length.
      this._sendStopEvent(recordingInfo, {
        timestampUTC: this._crashTimestampUTC,
        timestampHR: this._crashTimestampHR,
      });

      // Check if a retry is warranted
      recordingInfo.retryCount = 0;
      this._restartRecording(recordingInfo, 'recorderCrash');
    });

    this._crashTimestampUTC = null;
    this._crashTimestampHR = null;

    PrometheusAgent.incrementBy(SFULK_NAMES.RECORDER_LOST_RECORDINGS, lostRecordings.size);
  }

  _sendStopEvent(recordingInfo, {
    timestampUTC = Date.now(),
    timestampHR = hrTime(),
    reason = 'recorderCrash',
   } = {}) {
    const {
      roomName: meetingId,
      participantId: userId,
      trackSource: source,
    } = recordingInfo;

    // Only send stop events if we sent start events
    if (recordingInfo.startEventSent) {
      PrometheusAgent.increment(SFULK_NAMES.RECORDER_STOP_EVENTS, { source });

      switch (source) {
        case 'microphone':
        case 'screen_share_audio': {
          writeAudioRecordingStopEvent(
            this._bbbGW,
            meetingId,
            userId,
            recordingInfo.filename,
            source,
            timestampHR,
            timestampUTC,
          );
          break;
        }

        case 'camera': {
          writeVideoRecordingEvent(
            'StopWebRTCShareEvent',
            this._bbbGW,
            meetingId,
            recordingInfo.filename,
            timestampHR,
            timestampUTC,
            userId,
          );
          break;
        }

        case 'screen_share': {
          writeVideoRecordingEvent(
            'StopWebRTCDesktopShareEvent',
            this._bbbGW,
            meetingId,
            recordingInfo.filename,
            timestampHR,
            timestampUTC,
            userId,
          );
          break;
        }

        default:
          return;
      }
    }

    Logger.info('LiveKitWebRTCRecorderManager: Recording stopped event sent', {
      recordingInfo,
      reason,
    });
  }

  _retriableStartError(errorMessage = '') {
    return !UNRETRIABLE_START_ERRORS.includes(errorMessage);
  }

  _retryExpired(recordingInfo) {
    return recordingInfo.retryCount >= MAX_RECORDING_RETRIES;
  }

  _resetRetryCount(trackId) {
    const recordingInfo = this._activeRecordings.get(trackId);

    if (recordingInfo) recordingInfo.retryCount = 0;

    this._deleteRecordingRetryTimeout(trackId);
  }

  _updateExternalCaptureMetrics() {
    let count = 0;

    for (const recordingInfo of this._activeRecordings.values()) {
      if (recordingInfo.externalEventCapture) count += 1;
    }

    PrometheusAgent.set(SFULK_NAMES.EXTERNAL_EVENT_CAPTURES, count);

    return count;
  }

  _addActiveRecording(trackId, recordingInfo) {
    this._activeRecordings.set(trackId, recordingInfo);
    PrometheusAgent.set(SFULK_NAMES.RECORDER_ACTIVE_RECORDINGS, this._activeRecordings.size);
    this._updateExternalCaptureMetrics();
  }

  _deleteActiveRecording(trackId) {
    const deleted = this._activeRecordings.delete(trackId);

    if (deleted) {
      PrometheusAgent.set(SFULK_NAMES.RECORDER_ACTIVE_RECORDINGS, this._activeRecordings.size);
      this._updateExternalCaptureMetrics();
    }

    return deleted;
  }

  _clearActiveRecordings() {
    this._activeRecordings.clear();
    PrometheusAgent.set(SFULK_NAMES.RECORDER_ACTIVE_RECORDINGS, 0);
    PrometheusAgent.set(SFULK_NAMES.EXTERNAL_EVENT_CAPTURES, 0);
  }

  _clearOrphanedRecordings() {
    this._orphanedRecordings.clear();
    PrometheusAgent.set(SFULK_NAMES.RECORDER_ORPHANED_RECORDINGS, 0);
  }

  _addRecordingRetryTimeout(trackId, timeout) {
    if (this._recordingRetryTimeouts.has(trackId)) {
      clearTimeout(this._recordingRetryTimeouts.get(trackId));
      this._recordingRetryTimeouts.delete(trackId);
    }

    this._recordingRetryTimeouts.set(trackId, timeout);
    PrometheusAgent.set(SFULK_NAMES.RECORDER_PENDING_RETRY_TIMEOUTS, this._recordingRetryTimeouts.size);
  }

  _deleteRecordingRetryTimeout(trackId) {
    if (this._recordingRetryTimeouts.has(trackId)) {
      clearTimeout(this._recordingRetryTimeouts.get(trackId));
      const deleted = this._recordingRetryTimeouts.delete(trackId);

      if (deleted) {
        PrometheusAgent.set(SFULK_NAMES.RECORDER_PENDING_RETRY_TIMEOUTS, this._recordingRetryTimeouts.size);
      }

      return deleted;
    }

    return false;
  }

  _clearRecorderReconnectTimeout() {
    if (this._recorderReconnectTimeout) {
      clearTimeout(this._recorderReconnectTimeout);
      this._recorderReconnectTimeout = null;
    }
  }

  _handleRecorderCrash() {
    PrometheusAgent.set(SFULK_NAMES.RECORDER_STATUS, 0);
    PrometheusAgent.increment(SFULK_NAMES.RECORDER_RESTARTS);
    Logger.error('LiveKitWebRTCRecorderManager: Recorder instance stopped, waiting for reconnect');

    if (this._activeRecordings.size === 0) {
      Logger.debug('LiveKitWebRTCRecorderManager: Recorder crashed but no active recordings to manage.');
      return;
    }

    // Save crash time to accurately report recording end times if they are lost
    this._crashTimestampUTC = Date.now();
    this._crashTimestampHR = hrTime();

    // Move all active recordings to a temporary "orphaned" state
    this._orphanedRecordings = new Map(this._activeRecordings);
    this._clearActiveRecordings();
    PrometheusAgent.set(SFULK_NAMES.RECORDER_ORPHANED_RECORDINGS, this._orphanedRecordings.size);

    // Start a timeout. If the recorder doesn't reconnect in time,
    // assume all orphaned recordings are lost.
    this._recorderReconnectTimeout = setTimeout(() => {
      Logger.error('LiveKitWebRTCRecorderManager: Reconnect timeout reached. Recorder did not reconnect in time.');
      this._handleLostRecordings(this._orphanedRecordings);
      this._clearOrphanedRecordings();
      this._recorderReconnectTimeout = null;
    }, RECORDER_RECONNECT_TIMEOUT);
  }
}

module.exports = LiveKitWebRTCRecorderManager;
