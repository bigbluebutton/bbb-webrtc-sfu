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
} = require('./utils.js');
const { PrometheusAgent, SFULK_NAMES } = require('./metrics/livekit-metrics.js');

const RECORDING_DRY_RUN = config.has('recordingDryRun')
  ? config.get('recordingDryRun')
  : false;
const RECORDING_RETRY_DELAY = 3000; // 3 seconds delay between retries
const MAX_RECORDING_RETRIES = config.has('livekit.maxRecordingRetries')
  ? config.get('livekit.maxRecordingRetries')
  : 50;

class LiveKitWebRTCRecorderManager {
  constructor(
    liveKitSDK,
    eventBus,
    roomRecordingStatusMap,
    bbbGW,
  ) {
    if (!liveKitSDK
      || !eventBus
      || !roomRecordingStatusMap
      || !bbbGW
    ) {
      throw new Error('LiveKitWebRTCRecorderManager: liveKitSDK, eventBus, roomRecordingStatusMap, and bbbGW are required');
    }

    this._liveKitSDK = liveKitSDK;
    this._eventBus = eventBus;
    this._roomRecordingStatusMap = roomRecordingStatusMap;
    this._bbbGW = bbbGW;

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

    this.recorder = new BBBWebRTCRecorder(DEFAULT_PUB_CHANNEL, DEFAULT_SUB_CHANNEL);
    this._trackRecorderEvents();
    this.recorder.start();

    this._handleParticipantLeft = this._handleParticipantLeft.bind(this);
    this._handleTrackPublished = this._handleTrackPublished.bind(this);
    this._handleTrackUnpublished = this._handleTrackUnpublished.bind(this);
    this._handleRecordingStoppedEvt = this._handleRecordingStoppedEvt.bind(this);
    this._handleRecordingRtpStatusChanged = this._handleRecordingRtpStatusChanged.bind(this);
  }

  _trackRecorderEvents() {
    this.recorder.on('recorderInstanceStarted', () => {
      PrometheusAgent.set(SFULK_NAMES.RECORDER_STATUS, 1);
    });
    this.recorder.on('recorderInstanceStopped', () => {
      PrometheusAgent.set(SFULK_NAMES.RECORDER_STATUS, 0);
      PrometheusAgent.increment(SFULK_NAMES.RECORDER_RESTARTS);
    });
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

    const roomMap = this._activeRoomTracks.get(roomId);

    if (!roomMap) {
      this._activeRoomTracks.set(roomId, new Map([[trackId, trackInfo]]));
    } else {
      roomMap.set(trackId, trackInfo);
    }
  }

  deleteActiveTrackInRoom(trackId, roomId) {
    if (!roomId) return;

    const roomMap = this._activeRoomTracks.get(roomId);

    if (roomMap) {
      roomMap.delete(trackId);

      if (roomMap.size === 0) this._activeRoomTracks.delete(roomId);
    }
  }

  isTrackActiveInRoom(trackId, roomId) {
    if (!roomId) return false;

    const roomMap = this._activeRoomTracks.get(roomId);

    return roomMap && roomMap.has(trackId);
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

  _shouldRecord(meetingId, recordableMeeting, recordFullDurationMedia, {
    trackId = null,
  } = {}) {
    const meetingIsRecording = this._roomRecordingStatusMap.get(meetingId);
    // If trackId is provided, check if the track is active - otherwise, ignore it
    const trackIsActive = trackId ? this.isTrackActive(trackId, { roomId: meetingId }) : true;

    return RECORDING_DRY_RUN || (
      recordableMeeting && (recordFullDurationMedia || meetingIsRecording) && trackIsActive
    );
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

  async shouldRecordParticipantTrack(roomName, participantId) {
    const {
      recorded,
      recording,
      recordFullDurationMedia,
    } = await probeBBBRecordingStatus(
      this._bbbGW,
      roomName,
      participantId,
    );

    if (!this._shouldRecord(roomName, recorded, recordFullDurationMedia)) {
      Logger.debug('LiveKitWebRTCRecorderManager: Recording not required', {
        roomName,
        participantId,
        recorded,
        recording,
        recordFullDurationMedia,
      });

      return {
        shouldRecord: false,
        recordFullDurationMedia,
      };
    }

    return {
      shouldRecord: true,
      recordFullDurationMedia,
    };
  }

  async _startRecording(recordingInfo) {
    const {
      trackId,
      roomName: meetingId,
      participantId: userId,
      trackSource: source,
      recordingSessionId,
    } = recordingInfo;
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
    const { shouldRecord, recordFullDurationMedia } = await this.shouldRecordParticipantTrack(
      meetingId,
      userId,
    );

    if (!shouldRecord) {
      Logger.warn('LiveKitWebRTCRecorderManager: Recording not required', { recordingInfo });
      return null;
    }

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

    Logger.debug('LiveKitWebRTCRecorderManager: Starting recording', {
      recordingInfo,
      filename,
    });

    recordingInfo.recordFullDurationMedia = recordFullDurationMedia;
    recordingInfo.filename = `/var/lib/bbb-webrtc-recorder/${filename}`;
    recordingInfo.startEventSent = false;
    recordingInfo.retryCount = recordingInfo.retryCount || 0;

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

      switch (error.message) {
        case 'Failed to generate filename':
        case 'Track info not found':
          // These are errors where retries won't help, so we just skip
          if (recordingInfo?.trackId) {
            this._deleteActiveRecording(recordingInfo.trackId);
            this._deleteRecordingRetryTimeout(recordingInfo.trackId);
          }
          return;
        default:
          this._handleRecordingStoppedEvt({
            recordingSessionId: recordingInfo.recordingSessionId,
            reason: 'startFailed',
          });
      }
    }
  }

  async _handleTrackPublished(event) {
    Logger.debug('LiveKitWebRTCRecorderManager: _handleTrackPublished', { event });
    const source = this._liveKitSDK.trackSourceToString(event.track?.source);
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
      } else {
        if (recordingInfo && !recordingInfo.recordFullDurationMedia && !RECORDING_DRY_RUN) {
          this.stopRecording(recordingInfo.recordingSessionId).catch((error) => {
            Logger.error('LiveKitWebRTCRecorderManager: Failed to stop recording on status change', {
              recordingInfo,
              errorMessage: error.message,
              errorStack: error.stack,
            });
          });

          this._deleteRecordingRetryTimeout(trackInfo.trackId);
        }
      }
    }
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

    try {
      await this.stopRecording(recordingInfo.recordingSessionId);
      this._deleteRecordingRetryTimeout(trackId);
    } catch (error) {
      Logger.error('LiveKitWebRTCRecorderManager: Failed to stop recording', {
        trackId,
        recordingInfo,
        errorMessage: error.message,
        errorStack: error.stack,
      });
    }
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
        try {
          await this.stopRecording(recordingInfo.recordingSessionId);
          this._deleteRecordingRetryTimeout(trackId);
        } catch (error) {
          Logger.error('LiveKitWebRTCRecorderManager: Failed to stop recording', {
            trackId,
            recordingInfo,
            errorMessage: error.message,
            errorStack: error.stack,
          });
        }
      }
    }
  }

  _handleRetriableFailure(recordingInfo, reason) {
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
        error: 'max_retries',
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

    const {
      roomName: meetingId,
      participantId: userId,
      trackSource: source,
      trackId,
    } = recordingInfo;
    const timestampHR = hrTime();
    const timestampUTC = Date.now();

    // Always remove from active recordings map upon stop notification from recorder
    // Do this early to prevent race conditions with new start attempts.
    // The sending of the BBB stop event depends on startEventSent below.
    this._deleteActiveRecording(trackId);

    switch (reason) {
      case 'stopped':
      case 'stop requested':
      case 'session not found':
        // These are expected stop reasons, continue with normal stop handling
        this._deleteRecordingRetryTimeout(trackId);
        break;

      case 'closed':
      case 'disconnected':
      case 'recorderCrash':
      case 'startFailed':
      case 'application_shutdown': {
        this._handleRetriableFailure(recordingInfo, reason);
        break;
      }

      default:
        // Treat unknown reasons as potential failures requiring retry check
        Logger.error('LiveKitWebRTCRecorderManager: Unknown recording stop reason, checking for retry', {
          recordingInfo,
          reason,
        });
        this._handleRetriableFailure(recordingInfo, reason);
        break;
    }

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

    Logger.info('LiveKitWebRTCRecorderManager: Recording stopped', {
      recordingInfo,
      reason,
    });
  }

  _scheduleRecordingRetry(recordingInfo) {
    const {
      trackId,
      roomName: meetingId,
      recordFullDurationMedia,
    } = recordingInfo;
    // Second param: recordableMeeting - always true if we reached this point
    const trackAndRoomActive = () => this._shouldRecord(meetingId, true, recordFullDurationMedia, { trackId });

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

        if (!this._retryExpired(recordingInfo)) {
          this._scheduleRecordingRetry(recordingInfo);
        } else {
          Logger.error('LiveKitWebRTCRecorderManager: Max recording retries reached after failed retry attempt, giving up.', {
            recordingInfo,
            maxRetries: MAX_RECORDING_RETRIES,
          });
          this._deleteActiveRecording(trackId);
          this._deleteRecordingRetryTimeout(trackId);
          PrometheusAgent.increment(SFULK_NAMES.RECORDER_RETRY_FAILURES, {
            error: 'max_retries',
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
      recordFullDurationMedia,
    } = recordingInfo;
    const timestampHR = hrTime();
    const timestampUTC = Date.now();

    switch (status) {
      case 'flowing': {
        // Second param: recordableMeeting - always true if we reached this point
        const shouldStillRecord = this._shouldRecord(meetingId, true, recordFullDurationMedia, { trackId });
        this._resetRetryCount(trackId);

        if (!shouldStillRecord) {
          Logger.info('LiveKitWebRTCRecorderManager: trailing RTP status changed, stopping recording', {
            recordingInfo,
          });
          this.stopRecording(recordingSessionId).catch((error) => {
            Logger.error('LiveKitWebRTCRecorderManager: Failed to stop recording on RTP status change', {
              recordingInfo,
              errorMessage: error.message,
              errorStack: error.stack,
            });
          });
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
          this._activeRecordings.set(recordingInfo.trackId, recordingInfo);
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

      throw error;
    }
  }

  init() {
    this._eventBus.on('participant_left', this._handleParticipantLeft);
    this._eventBus.on('track_published', this._handleTrackPublished);
    this._eventBus.on('track_unpublished', this._handleTrackUnpublished);

    Logger.info('LiveKitWebRTCRecorderManager initialized');
  }

  stop() {
    for (const recordingInfo of this._activeRecordings.values()) {
      this.stopRecording(recordingInfo.recordingSessionId).catch(error => {
        Logger.error('LiveKitWebRTCRecorderManager: Failed to stop recording', {
          recordingInfo,
          errorMessage: error.message,
          errorStack: error.stack,
        });
      });
    }

    this._activeRecordings.clear();
    for (const trackId of this._recordingRetryTimeouts.keys()) {
      this._deleteRecordingRetryTimeout(trackId);
    }
    this._recordingRetryTimeouts.clear(); // Ensure map is empty
    this._activeTracks.clear();
    this._activeRoomTracks.clear();
    PrometheusAgent.set(SFULK_NAMES.RECORDER_ACTIVE_RECORDINGS, 0);
    PrometheusAgent.set(SFULK_NAMES.RECORDER_PENDING_RETRY_TIMEOUTS, 0);
    Logger.info('LiveKitWebRTCRecorderManager stopped');
  }

  _retryExpired(recordingInfo) {
    return recordingInfo.retryCount >= MAX_RECORDING_RETRIES;
  }

  _resetRetryCount(trackId) {
    const recordingInfo = this._activeRecordings.get(trackId);

    if (recordingInfo) recordingInfo.retryCount = 0;

    this._deleteRecordingRetryTimeout(trackId);
  }

  _addActiveRecording(trackId, recordingInfo) {
    this._activeRecordings.set(trackId, recordingInfo);
    PrometheusAgent.set(SFULK_NAMES.RECORDER_ACTIVE_RECORDINGS, this._activeRecordings.size);
  }

  _deleteActiveRecording(trackId) {
    const deleted = this._activeRecordings.delete(trackId);

    if (deleted) {
      PrometheusAgent.set(SFULK_NAMES.RECORDER_ACTIVE_RECORDINGS, this._activeRecordings.size);
    }

    return deleted;
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
}

module.exports = LiveKitWebRTCRecorderManager;
