'use strict';

const C = require('../bbb/messages/Constants');
const Logger = require('../common/logger.js');
const BaseProvider = require('../base/BaseProvider');
const errors = require('../base/errors.js');
const FSConsumerBridge = require('../audio/fs-consumer-bridge.js');
const ClientAudioConsumer = require('../audio/client-audio-consumer.js');

const LOG_PREFIX = C.LISTENONLY_PROVIDER_PREFIX;

module.exports = class ListenOnly extends BaseProvider {
  constructor(bbbGW, voiceBridge, mcs, meetingId, mediaServer) {
    super(bbbGW);
    this.sfuApp = C.LISTEN_ONLY_APP;
    this.voiceBridge = voiceBridge;
    this.mcs = mcs;
    this.meetingId = meetingId;
    this.mediaServer = mediaServer;

    this.audioEndpoints = {};
    this.gaBridge = new FSConsumerBridge(
      this.mcs,
      this.voiceBridge,
      this.mediaServer,
    );

    this.handleMCSCoreDisconnection = this.handleMCSCoreDisconnection.bind(this);
    this.mcs.on(C.MCS_DISCONNECTED, this.handleMCSCoreDisconnection);
  }

  _getPartialLogMetadata () {
    return {
      roomId: this.voiceBridge,
      internalMeetingId: this.meetingId,
      status: this.gaBridge.bridgeMediaStatus,
      bridgeMediaId: this.gaBridge.bridgeMediaId,
      globalAudioId: this.globalAudioId,
    };
  }

  _getFullLogMetadata (connectionId) {
    const endpoint  = this.audioEndpoints[connectionId] || {};
    return {
      roomId: this.voiceBridge,
      internalMeetingId: this.meetingId,
      mcsUserId: endpoint.mcsUserId,
      userId: endpoint.userId,
      mediaId: endpoint.mediaId,
      status: this.gaBridge.bridgeMediaStatus,
      connectionId,
      bridgeMediaId: this.gaBridge.bridgeMediaId,
      globalAudioId: this.globalAudioId,
    };
  }

  /* ======= ICE HANDLERS ======= */

  onIceCandidate (_candidate, connectionId) {
    const endpoint = this.audioEndpoints[connectionId];

    if (endpoint) {
      endpoint.onIceCandidate(_candidate);
    }
  }

  async _flushCandidatesQueue (connectionId) {
    const endpoint = this.audioEndpoints[connectionId];

    if (endpoint) {
      endpoint._flushCandidatesQueue();
    }
  }

  /* ======= USER STATE MANAGEMENT ======= */

  getConnectionIdsFromUser(userId) {
    // FIXME inefficient
    return Object.keys(this.audioEndpoints).filter(connectionId => {
      const endpoint = this.audioEndpoints[connectionId];
      return (endpoint && endpoint.userId === userId);
    });
  }

  /* ======= START/CONNECTION METHODS ======= */

  startGlobalAudioBridge () {
    return this.gaBridge.start();
  }

  async start (sessionId, connectionId, sdpOffer, userId) {
    const isConnected = await this.mcs.waitForConnection();

    if (!isConnected) {
      throw this._handleError(LOG_PREFIX, errors.MEDIA_SERVER_OFFLINE, "recv", userId);
    }

    try {
      await this.startGlobalAudioBridge();
    } catch (error) {
      const normalizedError = this._handleError(LOG_PREFIX, error, "recv", userId);
      Logger.error(LOG_PREFIX, `New listen only session failed: GLOBAL_AUDIO unavailable`,
        { ...this._getPartialLogMetadata(), error: normalizedError });
      throw errors.SFU_GLOBAL_AUDIO_FAILED;
    }

    const clientConsumer = new ClientAudioConsumer(
      this.bbbGW,
      this.meetingId,
      this.voiceBridge,
      userId,
      connectionId,
      this.mcs,
      this.gaBridge
    );

    this.audioEndpoints[connectionId] = clientConsumer;

    return clientConsumer.start(sdpOffer);
  }

  processAnswer (answer, connectionId) {
    const endpoint = this.audioEndpoints[connectionId];

    Logger.debug(LOG_PREFIX, 'Processing listen only answer',
      this._getFullLogMetadata(connectionId));

    if (endpoint) {
      return endpoint.processAnswer(answer);
    }

    // FIXME - should we throw or turn a blind eye
    return Promise.resolve();
  }

  /* ======= STOP METHODS ======= */

  async stopListener(connectionId) {
    const listener = this.audioEndpoints[connectionId];

    if (listener) {
      try {
        await listener.stop();
        Logger.info(LOG_PREFIX, 'Listen only session stopped',
          this._getFullLogMetadata(connectionId));
      } catch (error) {
        Logger.warn(LOG_PREFIX, `Error on unsubscribing listener media ${listener.mediaId}`,
          { ...this._getFullLogMetadata(connectionId), error});
      }

      if (this.audioEndpoints && Object.keys(this.audioEndpoints).length === 1) {
        this._stopSourceAudio();
      }

      delete this.audioEndpoints[connectionId];
    }
  }

  async stop () {
    Logger.info(LOG_PREFIX, `Listen only session-wide stop for room ${this.voiceBridge}, releasing everything`,
      this._getPartialLogMetadata());
    this.mcs.removeListener(C.MCS_DISCONNECTED, this.handleMCSCoreDisconnection);
    try {
      const nofConnectedUsers = Object.keys(this.audioEndpoints).length;
      if (nofConnectedUsers <= 0) {
        return this._stopSourceAudio();
      }

      // TODO refactor
      for (var connectionId in this.audioEndpoints) {
        try {
          await this.stopListener(connectionId);
        } catch (error) {
          Logger.error(LOG_PREFIX, `Listen only session stop failed`,
            { ...this._getFullLogMetadata(connectionId), error });
        }
      }
      return Promise.resolve();
    }
    catch (error) {
      Logger.error(LOG_PREFIX, `Error on session-wide stop for room ${this.voiceBridge}}`,
        { ...this._getPartialLogMetadata(), error });
      return Promise.reject(this._handleError(LOG_PREFIX, error, "recv"));
    }
  }

  async _stopSourceAudio () {
    if (this.gaBridge && typeof this.gaBridge.stop === 'function') {
      return this.gaBridge.stop();
    }

    return Promise.resolve();
  }
};
