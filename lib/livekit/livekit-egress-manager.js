const Logger = require('../common/logger.js');

class LiveKitEgressManager {
  constructor(
    liveKitSDK,
    host,
    key,
    secret,
    eventBus,
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

    this._handleTrackPublished = this._handleTrackPublished.bind(this);
    this._handleTrackUnpublished = this._handleTrackUnpublished.bind(this);
    this._handleEgressEnded = this._handleEgressEnded.bind(this);
  }

  _registerTrackEgress(egress) {
    if (this._trackEgressRegister.has(egress?.track?.trackId)) {
      Logger.warn('LiveKitEgressManager: Egress already registered', {
        egressId: egress.egressId,
        trackId: egress?.track?.trackId,
        filepath: egress?.track?.file?.filepath,
      });
      return;
    }

    Logger.debug('LiveKitEgressManager: Registering Egress', { egress });
    this._trackEgressRegister.set(egress?.track?.trackId, egress);
  }

  async _handleTrackUnpublished(event) {
    Logger.debug('LiveKitEgressManager: _handleTrackUnpublished', { event });

    try {
      switch (this._liveKitSDK.trackSourceToString(event.track?.source)) {
        case 'camera':
        case 'screen_share': {
          const trackId = event.track?.sid;
          await this.stopEgress(trackId);
          break;
        }

        default:
          return;
      }
    } catch (error) {
      Logger.error('LiveKitEgressManager: _handleTrackUnpublished ERROR', error);
    }

  }

  async _handleTrackPublished(event) {
    Logger.debug('LiveKitEgressManager: _handleTrackPublished', { event });

    try {
      switch (this._liveKitSDK.trackSourceToString(event.track?.source)) {
        case 'camera': {
          const trackId = event.track?.sid;
          const output = new this._liveKitSDK.DirectFileOutput({
            filepath: `/var/lib/bbb-webrtc-recorder/recordings/${event.room?.name}/medium-${event.participant?.identity}-${trackId}.webm`,
          });

          await this.startTrackEgress(
            event.room?.name,
            output,
            trackId,
          );
          break;
        }

        case 'screen_share': {
          const trackId = event.track?.sid;
          const output = new this._liveKitSDK.DirectFileOutput({
            filepath: `/var/lib/bbb-webrtc-recorder/screenshare/${event.room?.name}/-${event.participant?.identity}-${trackId}.webm`,
          });

          await this.startTrackEgress(
            event.room?.name,
            output,
            trackId,
          );
          break;
        }

        default:
          return;
      }
    } catch (error) {
      Logger.error('LiveKitEgressManager: _handleTrackPublished ERROR', error);
    }
  }

  async _handleEgressEnded(event) {
    Logger.debug('LiveKitEgressManager: _handleEgressEnded', { event });

    try {
      await this.stopEgress(event.egress?.name);
    } catch (error) {
      Logger.error('LiveKitEgressManager: _handleEgressEnded ERROR', error);
    }
  }

  init() {
    // List all Egress instances and register them
    this.egressClient.listEgress().then(egress => {
      egress.forEach(egress => {

        switch (egress?.status) {
          case "EGRESS_STARTING":
          case "EGRESS_ACTIVE":
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
    this._eventBus.on('track_upublished', this._handleTrackUnpublished);
    this._eventBus.on('egress_ended', this._handleEgressEnded);
  }

  hasEgress(name) {
    return this._trackEgressRegister.has(name);
  }

  async startTrackEgress(room, output, trackId) {
    const egress = await this.egressClient.startTrackEgress(room, output, trackId);
    this._registerTrackEgress(egress);
    Logger.debug('LiveKitEgressManager: Inbound egress created', { egress });

    return egress;
  }

  async stopEgress(name) {
    try {
      if (!this._trackEgressRegister.has(name)) {
        Logger.warn('LiveKitEgressManager: Egress not registered', { name });
        return;
      }

      const egress = this._trackEgressRegister.get(name);
      await this.egressClient.stopEgress(egress.egressId);
    } catch (error) {
      Logger.error('LiveKitEgressManager: Failed to delete Egress', error);
    } finally {
      this._trackEgressRegister.delete(name);
    }
  }

  stop() {
    this._trackEgressRegister.forEach(async (egress) => {
      try {
        await this.stopEgress(egress.name);
      } catch (error) {
        Logger.warn('LiveKitEgressManager: Failed to delete Egress', error);
      }
    });

    Logger.info('LiveKitEgressManager stopped');
  }
}

module.exports = LiveKitEgressManager;
