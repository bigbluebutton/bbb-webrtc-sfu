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
    this._handleRecordingStopped = this._handleRecordingStopped.bind(this);
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

  _shouldRecord(meetingId, recordableMeeting, recordFullDurationMedia) {
    const meetingIsRecording = this._roomRecordingStatusMap.get(meetingId);

    return RECORDING_DRY_RUN || (
      recordableMeeting && (recordFullDurationMedia || meetingIsRecording)
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

  async _handleTrackPublished(event) {
    Logger.debug('LiveKitWebRTCRecorderManager: _handleTrackPublished', { event });
    const source = this._liveKitSDK.trackSourceToString(event.track?.source);
    const participantId = getUserIdFromParticipant(event.participant);
    const trackInfo = {
      roomName: event.room?.name,
      roomSid: event.room?.sid,
      participantId,
      participantSid: event.participant?.sid,
      trackId: event.track?.sid,
      trackSource: source,
    };


    try {
      const {
        recorded,
        recording,
        recordFullDurationMedia,
      } = await probeBBBRecordingStatus(
        this._bbbGW,
        trackInfo.roomName,
        trackInfo.participantId,
      );

      this.setActiveTrack(trackInfo, { roomId: trackInfo.roomName });

      if (!this._shouldRecord(trackInfo.roomName, recorded, recordFullDurationMedia)) {
        Logger.debug('LiveKitWebRTCRecorderManager: Recording not required on track publish', {
          roomName: trackInfo.roomName,
          recorded,
          recording,
          recordFullDurationMedia,
        });
        return;
      }

      if (!trackInfo?.trackId) {
        Logger.warn('LiveKitWebRTCRecorderManager: Track info not found, won\'t record yet', { event });
        return;
      }

      const recordingSessionId = uuidv4();
      const suffix = Date.now();

      const filename = this._generateFilename(
        source,
        trackInfo.roomName,
        trackInfo.participantId,
        trackInfo.trackId,
        suffix
      );

      if (!filename) return;

      const { responseFileName } = await this.recorder.startRecording(
        recordingSessionId,
        filename, {
        adapter: 'livekit',
        adapterOptions: {
          livekit: {
            room: trackInfo.roomName,
            trackIds: [trackInfo.trackId],
          },
        },
        recordingStoppedHdlr: this._handleRecordingStopped,
        rtpStatusChangedHdlr: this._handleRecordingRtpStatusChanged,
      }
      );

      this._activeRecordings.set(trackInfo.trackId, {
        ...trackInfo,
        recordingSessionId,
        filename: responseFileName,
        recordFullDurationMedia,
      });

      Logger.info('LiveKitWebRTCRecorderManager: Recording started', {
        trackInfo,
        recordingSessionId,
        filename: responseFileName,
      });
    } catch (error) {
      Logger.error('LiveKitWebRTCRecorderManager: Failed to start recording', {
        trackInfo,
        errorMessage: error.message,
        errorStack: error.stack,
      });
    }
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
          this._startRecording(trackInfo).catch((error) => {
            Logger.error('LiveKitWebRTCRecorderManager: Failed to start recording on status change', {
              trackInfo,
              errorMessage: error.message,
              errorStack: error.stack,
            });
          });
        }
      } else {
        if (recordingInfo && !recordingInfo.recordFullDurationMedia) {
          this.stopRecording(recordingInfo.recordingSessionId).catch((error) => {
            Logger.error('LiveKitWebRTCRecorderManager: Failed to stop recording on status change', {
              recordingInfo,
              errorMessage: error.message,
              errorStack: error.stack,
            });
          });
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
    this._clearRecordingRetryTimeout(trackId);

    const recordingInfo = this._activeRecordings.get(trackId);

    if (!recordingInfo) return;

    try {
      await this.stopRecording(recordingInfo.recordingSessionId);
      this._activeRecordings.delete(trackId);
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
          this._activeRecordings.delete(trackId);
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

  async _handleRecordingStopped(payload) {
    const { recordingSessionId, reason } = payload;

    let recordingInfo = null;
    for (const info of this._activeRecordings.values()) {
      if (info.recordingSessionId === recordingSessionId) {
        recordingInfo = info;
        break;
      }
    }

    if (!recordingInfo) {
      Logger.warn('LiveKitWebRTCRecorderManager: Recording info not found', { recordingSessionId });
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

    switch (reason) {
      case 'closed':
      case 'disconnected':
      case 'recorderCrash': {
        PrometheusAgent.increment(SFULK_NAMES.RECORDING_ERRORS, {
          error: reason,
        });

        Logger.error(`LiveKitWebRTCRecorderManager: Recording stopped abruptly: ${reason}`, {
          recordingInfo,
          reason,
          recordingSessionId,
        });

        // Only retry if the track is still active
        if (this.isTrackActive(trackId, { roomId: meetingId })) {
          this._scheduleRecordingRetry(recordingInfo);
        } else {
          Logger.warn('LiveKitWebRTCRecorderManager: Track no longer active, skipping retry', {
            trackId,
            meetingId,
          });
        }
        break;
      }

      case 'stopped':
      case 'stop requested':
      case 'session not found':
        // These are expected stop reasons, continue with normal stop handling
        break;

      default:
        Logger.warn('LiveKitWebRTCRecorderManager: Unknown recording stop reason', {
          recordingInfo,
          reason,
        });
    }

    // Only send stop events if we sent start events
    if (recordingInfo.startEventSent) {
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

      this._activeRecordings.delete(trackId);
      this._clearRecordingRetryTimeout(trackId);
    }

    Logger.info('LiveKitWebRTCRecorderManager: Recording stopped', {
      recordingInfo,
      reason,
    });
  }

  _clearRecordingRetryTimeout(trackId) {
    if (this._recordingRetryTimeouts.has(trackId)) {
      Logger.debug('LiveKitWebRTCRecorderManager: Clearing recording retry timeout', { trackId });
      clearTimeout(this._recordingRetryTimeouts.get(trackId));
      this._recordingRetryTimeouts.delete(trackId);
    }
  }

  _scheduleRecordingRetry(recordingInfo) {
    const { trackId, roomName: meetingId } = recordingInfo;

    this._clearRecordingRetryTimeout(trackId);

    if (!trackId || !meetingId) {
      Logger.warn('LiveKitWebRTCRecorderManager: Retry info not found', { recordingInfo });
      return;
    }

    if (!this.isTrackActive(trackId, { roomId: meetingId })) {
      Logger.warn('LiveKitWebRTCRecorderManager: Track not active, skip retry', { trackId });
      this._clearRecordingRetryTimeout(trackId);
      return;
    }

    const timeout = setTimeout(() => {
      this._startRecording(recordingInfo).catch((error) => {
        Logger.error('LiveKitWebRTCRecorderManager: Recording retry failed', {
          trackId,
          recordingInfo,
          errorMessage: error.message,
          errorStack: error.stack,
        });
        this._scheduleRecordingRetry(recordingInfo);
      });
    }, RECORDING_RETRY_DELAY);

    this._recordingRetryTimeouts.set(trackId, timeout);
  }

  async _startRecording(recordingInfo) {
    const {
      trackId,
      roomName: meetingId,
      participantId: userId,
      trackSource: source,
    } = recordingInfo;
    const recordingSessionId = uuidv4();
    const suffix = Date.now();

    const filename = this._generateFilename(
      source,
      meetingId,
      userId,
      trackId,
      suffix
    );

    if (!filename) return null;

    const { responseFileName } = await this.recorder.startRecording(
      recordingSessionId,
      filename, {
        adapter: 'livekit',
        adapterOptions: {
          livekit: {
            room: meetingId,
            trackIds: [trackId],
          },
        },
        recordingStoppedHdlr: this._handleRecordingStopped,
        rtpStatusChangedHdlr: this._handleRecordingRtpStatusChanged,
      }
    );

    recordingInfo.recordingSessionId = recordingSessionId;
    recordingInfo.filename = responseFileName;
    recordingInfo.startEventSent = false;

    this._activeRecordings.set(trackId, recordingInfo);

    Logger.info('LiveKitWebRTCRecorderManager: Recording restarted', {
      recordingInfo,
    });

    return recordingInfo;
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
    } = recordingInfo;
    const timestampHR = hrTime();
    const timestampUTC = Date.now();

    switch (status) {
      case 'flowing': {
        if (!recordingInfo.startEventSent) {
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
    Logger.info('LiveKitWebRTCRecorderManager stopped');
  }
}

module.exports = LiveKitWebRTCRecorderManager;
