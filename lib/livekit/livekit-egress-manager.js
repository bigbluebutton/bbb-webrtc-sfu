const config = require('config');
const Logger = require('../common/logger.js');
const {
  probeBBBRecordingStatus,
  writeAudioRecordingStartEvent,
  writeAudioRecordingStopEvent,
  writeVideoRecordingEvent,
} = require('./utils.js');
const { hrTime } = require('../common/utils.js');
const RECORDING_DRY_RUN = config.has('recordingDryRun')
  ? config.get('recordingDryRun')
  : false;

class LiveKitEgressManager {
  constructor(
    liveKitSDK,
    host,
    key,
    secret,
    eventBus,
    roomRecordingStatusMap,
    bbbGW,
  ) {
    if (!liveKitSDK || !host || !key || !secret) {
      throw new Error('LiveKitEgressManager: liveKitSDK, host, key, secret are required');
    }

    this._liveKitSDK = liveKitSDK;
    this._trackEgressRegister = new Map();

    this.host = host;
    this.key = key;
    this.secret = secret;
    this.egressClient = new this._liveKitSDK.EgressClient(this.host, this.key, this.secret);
    this._eventBus = eventBus;
    this._roomRecordingStatusMap = roomRecordingStatusMap;
    this._bbbGW = bbbGW;

    this._handleTrackPublished = this._handleTrackPublished.bind(this);
    this._handleEgressEnded = this._handleEgressEnded.bind(this);
    this._handleEgressUpdated = this._handleEgressUpdated.bind(this);
    this._handleEgressActive = this._handleEgressActive.bind(this);
  }

  _shouldRecord (meetingId, recordableMeeting, recordFullDurationMedia) {
    const meetingIsRecording = this._roomRecordingStatusMap.get(meetingId);

    return RECORDING_DRY_RUN || (
      recordableMeeting && (recordFullDurationMedia || meetingIsRecording)
    );
  }

  _registerTrackEgress(egress, metadata = {}) {
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

    Logger.debug('LiveKitEgressManager: Registering Egress', { egress });
    this._trackEgressRegister.set(egressId, { ...egress, bbbMetadata: metadata });
  }

  async _handleTrackPublished(event) {
    Logger.debug('LiveKitEgressManager: _handleTrackPublished', { event });

    try {
      const {
        recorded,
        recording,
        recordFullDurationMedia,
      } = await probeBBBRecordingStatus(
        this._bbbGW,
        event.room?.name,
        event.participant?.identity,
      );

      if (!this._shouldRecord(event.room?.name, recorded, recordFullDurationMedia)) {
        Logger.debug('LiveKitEgressManager: Recording not required', {
          room: event.room?.name,
          recorded,
          recording,
          recordFullDurationMedia,
        });
        return;
      }

      const source = this._liveKitSDK.trackSourceToString(event.track?.source);

      const metadata = {
        meetingId: event.room?.name,
        roomSid: event.room?.sid,
        participantSid: event.participant?.sid,
        userId: event.participant?.identity,
        trackId: event.track?.sid,
        source,
      };

      const trackId = event.track?.sid;
      let output;

      switch (source) {
        case 'microphone':
          output = new this._liveKitSDK.DirectFileOutput({
            filepath: `/var/lib/bbb-webrtc-recorder/audio/${event.room?.name}/${source}-${event.participant?.identity}-${trackId}.ogg`,
          });
          break;

        case 'camera': {
          output = new this._liveKitSDK.DirectFileOutput({
            filepath: `/var/lib/bbb-webrtc-recorder/recordings/${event.room?.name}/${source}-${event.participant?.identity}-${trackId}.webm`,
          });
          break;
        }

        case 'screen_share': {
          output = new this._liveKitSDK.DirectFileOutput({
            filepath: `/var/lib/bbb-webrtc-recorder/screenshare/${event.room?.name}/${source}-${event.participant?.identity}-${trackId}.webm`,
          });
          break;
        }

        case 'screen_share_audio': {
          output = new this._liveKitSDK.DirectFileOutput({
            filepath: `/var/lib/bbb-webrtc-recorder/audio/${event.room?.name}/${source}-${event.participant?.identity}-${trackId}.ogg`,
          });
          break;
        }

        default:
          return;
      }

      if (output && trackId) {
        await this.startTrackEgress(
          event.room?.name,
          output,
          trackId,
          metadata,
        );
      }
    } catch (error) {
      Logger.error('LiveKitEgressManager: _handleTrackPublished ERROR', error);
    }
  }

  async _handleEgressEnded(event) {
    Logger.debug('LiveKitEgressManager: _handleEgressEnded', { event });

    try {
      const { egressInfo } = event;
      const { egressId } = event.egressInfo;

      if (this._trackEgressRegister.has(egressId)) {
        const { fileResults, endedAt } = egressInfo;
        const { bbbMetadata } = this._trackEgressRegister.get(egressId);

        if (!bbbMetadata?.meetingId || !bbbMetadata?.userId || !bbbMetadata?.source) {
          Logger.warn('LiveKitEgressManager.stop: Egress metadata not found', { egressId, egressInfo });
        } else {

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
    } catch (error) {
      Logger.error('LiveKitEgressManager: _handleEgressEnded ERROR', error);
    }
  }

  _handleEgressActive(egress, eventEgressInfo) {
    const { egressId, bbbMetadata } = egress;

    if (!bbbMetadata?.meetingId || !bbbMetadata?.userId || !bbbMetadata?.source) {
      Logger.warn('LiveKitEgressManager: Egress metadata not found', { egressId, egress });
      return;
    }

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
        break;
      }

      default:
        return;
    }
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

    switch (egressInfo?.status) {
      case statuses.EGRESS_ACTIVE:
        this._handleEgressActive(egress, egressInfo);
        break;
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
            // FIXME missing metadata
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

    this._eventBus.on('track_published', this._handleTrackPublished);
    this._eventBus.on('egress_ended', this._handleEgressEnded);
    this._eventBus.on('egress_updated', this._handleEgressUpdated);
  }

  hasEgress(name) {
    return this._trackEgressRegister.has(name);
  }

  async startTrackEgress(room, output, trackId, metadata) {
    const egress = await this.egressClient.startTrackEgress(room, output, trackId);
    this._registerTrackEgress(egress, metadata);
    Logger.debug('LiveKitEgressManager: Inbound egress created', { egress });

    return egress;
  }

  async deleteEgress(egressId) {
    return this._trackEgressRegister.delete(egressId);
  }

  async stopEgress(egressId) {
    try {
      if (!this._trackEgressRegister.has(egressId)) {
        Logger.warn('LiveKitEgressManager: Egress not registered', { egressId });
        return;
      }

      const egress = this._trackEgressRegister.get(egressId);
      const { bbbMetadata } = egress;
      await this.egressClient.stopEgress(egress.egressId);

      Logger.debug('LiveKitEgressManager: Egress stopped', { egressId, bbbMetadata });
    } catch (error) {
      Logger.error('LiveKitEgressManager: Failed to delete Egress', error);
    } finally {
      this.deleteEgress(egressId);
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
