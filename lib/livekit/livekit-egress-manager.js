const config = require('config');
const Logger = require('../common/logger.js');
const { DisconnectReason } = require('@livekit/protocol');
const {
  isEgressParticipant,
  probeBBBRecordingStatus,
  writeAudioRecordingStartEvent,
  writeAudioRecordingStopEvent,
  writeVideoRecordingEvent,
  trackSourceToString,
} = require('./utils.js');
const { hrTime } = require('../common/utils.js');
const { PrometheusAgent, SFULK_NAMES } = require('./metrics/livekit-metrics.js');

const RECORDING_DRY_RUN = config.has('recordingDryRun')
  ? config.get('recordingDryRun')
  : false;
const EGRESS_START_TIMEOUT = 5000;
const EGRESS_RETRY_INTERVAL = 1000;

class LiveKitEgressManager {
  constructor(
    liveKitSDK,
    host,
    key,
    secret,
    eventBus,
    roomRecordingStatusMap,
    bbbGW, {
      startTimeout = EGRESS_START_TIMEOUT,
      retryInterval = EGRESS_RETRY_INTERVAL,
    } = {},
  ) {
    if (!liveKitSDK || !host || !key || !secret) {
      throw new Error('LiveKitEgressManager: liveKitSDK, host, key, secret are required');
    }

    this._liveKitSDK = liveKitSDK;
    this.host = host;
    this.key = key;
    this.secret = secret;
    this._eventBus = eventBus;
    this._roomRecordingStatusMap = roomRecordingStatusMap;
    this._bbbGW = bbbGW;
    this._startTimeout = startTimeout;
    this._retryInterval = retryInterval;

    // Map<trackId, TrackInfo>
    // TrackInfo is: {
    //    roomName: string,
    //    roomSid: string,
    //    participantId: string,
    //    participantSid: string,
    //    trackId: string,
    //    trackSource: string,
    //  }
    this._activeTracks = new Map();
    // Map<roomId, Map<trackId, TrackInfo>>
    this._activeRoomTracks = new Map();
    this._trackEgressRegister = new Map();
    // Map<trackId, timeout>
    this._egressRetryTimeouts = new Map();
    this.egressClient = new this._liveKitSDK.EgressClient(this.host, this.key, this.secret);

    this._handleParticipantLeft = this._handleParticipantLeft.bind(this);
    this._handleTrackPublished = this._handleTrackPublished.bind(this);
    this._handleTrackUnpublished = this._handleTrackUnpublished.bind(this);
    this._handleEgressEnded = this._handleEgressEnded.bind(this);
    this._handleEgressUpdated = this._handleEgressUpdated.bind(this);
    this._handleEgressActive = this._handleEgressActive.bind(this);

    Logger.info('LiveKitEgressManager created', {
      host,
      startTimeout,
      retryInterval,
    });
  }

  _shouldRecord (meetingId, recordableMeeting, recordFullDurationMedia) {
    const meetingIsRecording = this._roomRecordingStatusMap.get(meetingId);

    return RECORDING_DRY_RUN || (
      recordableMeeting && (recordFullDurationMedia || meetingIsRecording)
    );
  }

  _clearEgressRetryTimeout(trackId) {
    if (this._egressRetryTimeouts.has(trackId)) {
      Logger.debug('LiveKitEgressManager: Clearing egress retry timeout', { trackId });
      clearTimeout(this._egressRetryTimeouts.get(trackId));
      this._egressRetryTimeouts.delete(trackId);
    }
  }

  _registerTrackEgress(egress, seedInfo, metadata = {}) {
    const { egressId } = egress;

    if (!egressId) {
      Logger.warn('LiveKitEgressManager: Egress ID not found', { egress });
      return;
    }

    if (this._trackEgressRegister.has(egressId)) {
      Logger.warn('LiveKitEgressManager: Egress already registered', {
        egressId,
        trackId: metadata?.trackId,
      });
      return;
    }

    const payload = {
      ...egress,
      bbbMetadata: metadata,
      seedInfo,
      startEventSent: false,
    };

    Logger.debug('LiveKitEgressManager: Registering Egress', payload);
    this._trackEgressRegister.set(egressId, payload);
  }

  _findEgressWithParticipantId(participantId) {
    // eslint-disable-next-line no-unused-vars
    for (const [_, egress] of this._trackEgressRegister) {
      if (egress.bbbMetadata.userId === participantId) {
        return egress;
      }
    }

    return null;
  }

  _findEgressWithTrackId(trackId) {
    if (!trackId) return null;

    // eslint-disable-next-line no-unused-vars
    for (const [_, egress] of this._trackEgressRegister) {
      if (egress?.seedInfo?.trackId === trackId) return egress;
    }

    return null;
  }

  _getStartEventSentState(egressId) {
    const egress = this._trackEgressRegister.get(egressId);

    if (egress) return egress.startEventSent;

    return false;
  }

  _setStartEventSentState(egressId, state) {
    const egress = this._trackEgressRegister.get(egressId);

    if (egress) {
      egress.startEventSent = state;
      this._trackEgressRegister.set(egressId, egress);

      return egress;
    }

    return null;
  }

  handleRecordingStatusChanged(meetingId, recording) {
    this._roomRecordingStatusMap.set(meetingId, recording);

    Logger.debug('LiveKitEgressManager: Recording status changed', {
      meetingId,
      recording,
    });

    const roomMap = this.getActiveTracksInRoom(meetingId);

    if (!roomMap) return;

      // eslint-disable-next-line no-unused-vars
    for (const [_, trackInfo] of roomMap) {
      const egress = this._findEgressWithTrackId(trackInfo.trackId);

      if (recording) {
        if (!egress) this._recordTrack(trackInfo);
      } else {
        // Stop egress, but do not force-stop it. We want a clean stop
        // so that end events are correctly written
        if (egress && egress?.bbbMetadata?.recordFullDurationMedia === false) {
          this.stopEgress(egress?.egressId, { force: false });
        }
      }
    }
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

  getActiveTracksInRoom(roomId) {
    return this._activeRoomTracks.get(roomId);
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

  _handleTrackUnpublished(event) {
    Logger.debug('LiveKitEgressManager: _handleTrackUnpublished', { event });
    const trackId = event.track?.sid;
    const roomId = event.room?.name;

    if (trackId) {
      this.deleteActiveTrack(trackId, { roomId });
      this._clearEgressRetryTimeout(trackId);
    }
  }

  async _recordTrack({
    roomName,
    roomSid,
    participantId,
    participantSid,
    trackId,
    trackSource,
  }) {
    let metadata = {};
    let seedInfo = {};

    try {
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
        Logger.debug('LiveKitEgressManager: Recording not required on track publish', {
          roomName,
          recorded,
          recording,
          recordFullDurationMedia,
        });
        return;
      }

      const source = trackSourceToString(this._liveKitSDK, trackSource);

      metadata = {
        meetingId: roomName,
        roomSid,
        participantSid,
        userId: participantId,
        trackId,
        source,
        recordFullDurationMedia,
      };

      let output;
      const suffix = Date.now();

      switch (source) {
        case 'microphone':
          output = new this._liveKitSDK.DirectFileOutput({
            filepath: `/var/lib/bbb-webrtc-recorder/audio/${roomName}/${source}-${participantId}-${trackId}-${suffix}.ogg`,
          });
          break;

        case 'camera': {
          output = new this._liveKitSDK.DirectFileOutput({
            filepath: `/var/lib/bbb-webrtc-recorder/recordings/${roomName}/${source}-${participantId}-${trackId}-${suffix}.webm`,
          });
          break;
        }

        case 'screen_share': {
          output = new this._liveKitSDK.DirectFileOutput({
            filepath: `/var/lib/bbb-webrtc-recorder/screenshare/${roomName}/${source}-${participantId}-${trackId}-${suffix}.webm`,
          });
          break;
        }

        case 'screen_share_audio': {
          output = new this._liveKitSDK.DirectFileOutput({
            filepath: `/var/lib/bbb-webrtc-recorder/audio/${roomName}/${source}-${participantId}-${trackId}-${suffix}.ogg`,
          });
          break;
        }

        default:
          return;
      }

      seedInfo = { room: roomName, output, trackId };

      if (output && trackId) {
        await this.startTrackEgress(
          roomName,
          output,
          trackId,
          metadata,
        );
      }
    } catch (error) {
      Logger.error('LiveKitEgressManager: failed to start track egress', {
        trackId,
        errorMessage: error.message,
        errorStack: error.stack,
        metadata,
      });
      this._scheduleEgressRetry(seedInfo, metadata);
    }
  }

  async _handleTrackPublished(event) {
    Logger.debug('LiveKitEgressManager: _handleTrackPublished', { event });
    const trackInfo = {
      roomName:  event.room?.name,
      roomSid: event.room?.sid,
      participantId: event.participant?.identity,
      participantSid: event.participant?.sid,
      trackId: event.track?.sid,
      trackSource: event.track?.source,
    };

    if (trackInfo?.trackId) this.setActiveTrack(trackInfo, { roomId: trackInfo.roomName });

    this._recordTrack(trackInfo);
  }

  async _handleParticipantLeft(event) {
    const { identity, kind, disconnectReason } = event.participant;

    if (!isEgressParticipant(kind)) return;

    Logger.debug('LiveKitEgressManager: _handleParticipantLeft', { event });

    switch (disconnectReason) {
      case DisconnectReason.STATE_MISMATCH:
      case DisconnectReason.JOIN_FAILURE:
      case DisconnectReason.SERVER_SHUTDOWN: {
        const egress = this._trackEgressRegister.get(identity);

        if (!egress) return;

        // Retry starting the egress track
        const { seedInfo, bbbMetadata } = egress;

        Logger.error('LiveKitEgressManager: Participant left unexpectedly', {
          identity,
          kind,
          disconnectReason,
          seedInfo,
          bbbMetadata,
        });

        this._processEgressTermination(egress.egressId, egress);
        this._scheduleEgressRetry(seedInfo, bbbMetadata);
        break;
      }

      default:
        return;
    }
  }

  _processEgressTermination(egressId, egressInfo) {
    if (this._trackEgressRegister.has(egressId)) {
      const { bbbMetadata, seedInfo, startEventSent } = this._trackEgressRegister.get(egressId);
      const { fileResults, endedAt: eInfoEndTS } = egressInfo;
      const endedAt = eInfoEndTS || Date.now();

      if (seedInfo?.trackId) this._clearEgressRetryTimeout(seedInfo.trackId);

      if (!bbbMetadata?.meetingId || !bbbMetadata?.userId || !bbbMetadata?.source) {
        Logger.warn('LiveKitEgressManager.stop: Egress metadata not found', { egressId, egressInfo });
      } else if (startEventSent) {
        Logger.info('LiveKitEgressManager.stop: Egress terminated', { egressId, bbbMetadata, egressInfo });

        const { meetingId, userId, source } = bbbMetadata;
        const { filename } = fileResults[0];
        const timestampHR = hrTime();

        switch (source) {
          case 'microphone':
          case 'screen_share_audio': {
            writeAudioRecordingStopEvent(
              this._bbbGW,
              meetingId,
              userId,
              filename,
              source,
              timestampHR,
              endedAt,
            );
            break;
          }

          case 'camera': {
            writeVideoRecordingEvent(
              'StopWebRTCShareEvent',
              this._bbbGW,
              meetingId,
              filename,
              timestampHR,
              endedAt,
              userId,
            );
            break;
          }

          case 'screen_share': {
            writeVideoRecordingEvent(
              'StopWebRTCDesktopShareEvent',
              this._bbbGW,
              meetingId,
              filename,
              timestampHR,
              endedAt,
              userId,
            );
            break;
          }

          default:
            return;
        }
      }
    }

    this.deleteEgress(egressId);
  }

  _handleEgressEnded(event) {
    Logger.debug('LiveKitEgressManager: _handleEgressEnded', { event });

    try {
      const { egressInfo } = event;
      const { egressId } = event.egressInfo;

      this._processEgressTermination(egressId, egressInfo);
    } catch (error) {
      Logger.error('LiveKitEgressManager: _handleEgressEnded ERROR', error);
    }
  }

  _handleEgressActive(egress, eventEgressInfo) {
    const { egressId, bbbMetadata, seedInfo } = egress;
    const startEventSent = this._getStartEventSentState(egressId);

    if (startEventSent) {
      Logger.warn('LiveKitEgressManager: Start event already sent', {
        egressId,
        egress,
        startEventSent,
      });

      return;
    }

    if (seedInfo?.trackId) this._clearEgressRetryTimeout(seedInfo.trackId);

    if (!bbbMetadata?.meetingId || !bbbMetadata?.userId || !bbbMetadata?.source) {
      Logger.warn('LiveKitEgressManager: Egress metadata not found, wont handle active', {
        egressId,
        egress,
        startEventSent,
      });
      return;
    }

    Logger.info('LiveKitEgressManager: Egress active', {
      egressId,
      egress,
      bbbMetadata,
      startEventSent,
    });

    const { meetingId, userId, source } = bbbMetadata;
    const { fileResults } = eventEgressInfo;
    const { filename, startedAt } = fileResults[0];
    const timestampHR = hrTime();

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
          startedAt,
        );
        this._setStartEventSentState(egressId, true);
        break;
      }

      case 'camera': {
        writeVideoRecordingEvent(
          'StartWebRTCShareEvent',
          this._bbbGW,
          meetingId,
          filename,
          timestampHR,
          startedAt,
          userId,
        );
        this._setStartEventSentState(egressId, true);
        break;
      }

      case 'screen_share': {
        writeVideoRecordingEvent(
          'StartWebRTCDesktopShareEvent',
          this._bbbGW,
          meetingId,
          filename,
          timestampHR,
          startedAt,
          userId,
        );
        this._setStartEventSentState(egressId, true);

        break;
      }

      default:
        return;
    }
  }

  async _scheduleEgressRetry(seedInfo, bbbMetadata) {
    const { trackId, room, output } = seedInfo;

    this._clearEgressRetryTimeout(trackId);

    if (!trackId || !room || !output || !bbbMetadata || Object.keys(bbbMetadata).length === 0) {
      Logger.warn('LiveKitEgressManager: retry seed info not found', { seedInfo, bbbMetadata });
      return;
    }

    if (!this.isTrackActive(trackId, { roomId: room })) {
      Logger.warn('LiveKitEgressManager: Track not active, skip retry', { trackId });
      this._clearEgressRetryTimeout(trackId);
      return;
    }

    const timeout = setTimeout(() => {
      this.startTrackEgress(room, output, trackId, bbbMetadata).catch((error) => {
        Logger.error('LiveKitEgressManager: egress retry failed', {
          trackId,
          seedInfo,
          bbbMetadata,
          errorMessage: error.message,
          errorStack: error.stack,
        });
        this._scheduleEgressRetry(seedInfo, bbbMetadata);
      });
    } , EGRESS_RETRY_INTERVAL);

    this._egressRetryTimeouts.set(trackId, timeout);
  }

  async _handleEgressUpdated(event) {
    Logger.debug('LiveKitEgressManager: _handleEgressUpdated', { event });

    const { egressInfo } = event;
    const { egressId } = egressInfo;

    const egress = this._trackEgressRegister.get(egressId);

    if (!egress) {
      Logger.warn('LiveKitEgressManager: Egress not found when handling status update', { egressId });
      return;
    }

    const statuses = this._liveKitSDK.EgressStatus;

    Logger.debug('LiveKitEgressManager: Egress updated', { egressId, egressInfo });

    switch (egressInfo?.status) {
      case statuses.EGRESS_ACTIVE:
        this._handleEgressActive(egress, egressInfo);
        break;
      case statuses.EGRESS_FAILED:
      case statuses.EGRESS_LIMIT_REACHED: {
        // Retry starting the egress track
        const { seedInfo, bbbMetadata } = egress;

        if (!seedInfo || !bbbMetadata) {
          Logger.warn('LiveKitEgressManager: Seed info not found', { egressId });
          return;
        }

        this._scheduleEgressRetry(seedInfo, bbbMetadata);

        break;
      }
      // TODO review if aborted should be retried
      //case statuses.EGRESS_ABORTED:
      default:
        return;
    }
  }

  init() {
    // List all Egress instances and register them
    const statuses = this._liveKitSDK.EgressStatus;

    this.egressClient.listEgress().then(egress => {
      egress.forEach(egress => {
        switch (egress?.status) {
          case statuses.EGRESS_STARTING:
          case statuses.EGRESS_ACTIVE:
            // FIXME missing metadata and seedInfo, activeTracks
            this._registerTrackEgress(egress);
            break;
          default:
            // Ignore all the following as they're dead
            // EGRESS_ENDING
            // EGRESS_COMPLETE
            // EGRESS_FAILED
            // EGRESS_ABORTED
            // EGRESS_LIMIT_REACHED
            break;
        }
      })
    }).then(() => {
      Logger.info('LiveKitEgressManager initialized');
    }).catch(error => {
      Logger.error('LiveKitEgressManager: Failed to list Egress', error);
    });

    this._eventBus.on('participant_left', this._handleParticipantLeft);
    this._eventBus.on('track_published', this._handleTrackPublished);
    this._eventBus.on('track_unpublished', this._handleTrackUnpublished);
    this._eventBus.on('egress_ended', this._handleEgressEnded);
    this._eventBus.on('egress_updated', this._handleEgressUpdated);
  }

  hasEgress(name) {
    return this._trackEgressRegister.has(name);
  }

  async startTrackEgress(room, output, trackId, metadata) {
    const seedInfo = { room, output, trackId };

    // Wait EGRESS_START_TIMEOUT for egress to start
    // If it doesn't start, throw an error
    let egress = null;

    const start = async () => {
      egress = await this.egressClient.startTrackEgress(room, output, trackId);
      this._registerTrackEgress(egress, seedInfo, metadata);
      Logger.info('LiveKitEgressManager: Inbound egress created', {
        room,
        output,
        trackId,
        bbbMetadata: metadata,
        egress,
      });
    };

    const timeout = new Promise((resolve, reject) => {
      setTimeout(() => {
        reject(new Error('SFU_EGRESS_START_TIMEOUT'));
      }, EGRESS_START_TIMEOUT);
    });

    try {
      await Promise.race([start(), timeout]);

      return egress;
    } catch (error) {
      PrometheusAgent.increment(SFULK_NAMES.EGRESS_ERRORS, {
        errorMessage: error.message,
      });

      if (egress) await this.egressClient.stopEgress(egress.egressId);

      throw error;
    }
  }

  async deleteEgress(egressId) {
    return this._trackEgressRegister.delete(egressId);
  }

  async stopEgress(egressId, { force = true } = {}) {
    if (!this._trackEgressRegister.has(egressId)) {
      Logger.warn('LiveKitEgressManager: Egress not registered', { egressId });
      return;
    }

    const egress = this._trackEgressRegister.get(egressId);

    try {
      const { bbbMetadata } = egress;
      await this.egressClient.stopEgress(egress.egressId);

      Logger.info('LiveKitEgressManager: Egress stopped', { egressId, egress, bbbMetadata });
    } catch (error) {
      Logger.error('LiveKitEgressManager: Failed to delete Egress', error);
    } finally {
      if (force) {
        this._processEgressTermination(egressId, egress);
        this.deleteEgress(egressId);
      }
    }
  }

  stop() {
    this._trackEgressRegister.forEach(async (egress) => {
      try {
        await this.stopEgress(egress?.egressId);
      } catch (error) {
        Logger.warn('LiveKitEgressManager: Failed to delete Egress', error);
      }
    });

    Logger.info('LiveKitEgressManager stopped');
  }
}

module.exports = LiveKitEgressManager;
