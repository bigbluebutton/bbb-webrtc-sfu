'use strict';

const config = require('config');
const C = require('../bbb/messages/Constants');
const Logger = require('../common/logger.js');
const BaseProvider = require('../base/base-provider.js');
const SFUErrors = require('../base/errors.js');
const FSConsumerBridge = require('./fs-consumer-bridge.js');
const ClientAudioStTransceiver = require('./client-static-transceiver.js');
const ClientAudioConsumer = require('./client-audio-consumer.js');
const {
  getConsumerBridge,
  storeConsumerBridge,
} = require('./consumer-bridge-storage.js');

const LOG_PREFIX = "[audio-session]";
const EJECT_ON_USER_LEFT = config.get('ejectOnUserLeft');
const FULLAUDIO_ENABLED = config.has('fullAudioEnabled')
  ? config.get('fullAudioEnabled')
  : false;

module.exports = class AudioSession extends BaseProvider {
  constructor(
    bbbGW,
    meetingId,
    voiceBridge,
    userId,
    connectionId,
    callerId,
    role,
    mcs,
    mediaServer,
    extension,
  ) {
    super(bbbGW);
    this.sfuApp = C.AUDIO_APP;
    this.meetingId = meetingId;
    this.voiceBridge = voiceBridge;
    this.userId = userId;
    this.connectionId = connectionId;
    this.callerId = callerId;
    this.role = role;
    this.mcs = mcs;
    this.mediaServer = mediaServer;
    this.extension = extension;

    this.clientEndpoint = null;
    this.mcsUserId = null;

    this.disconnectUser = this.disconnectUser.bind(this);
    this.handleMCSCoreDisconnection = this.handleMCSCoreDisconnection.bind(this);

    this._trackMeetingEvents();
    this.mcs.on(C.MCS_DISCONNECTED, this.handleMCSCoreDisconnection);
  }

  get id() {
    return this.connectionId;
  }

  _getFullLogMetadata () {
    return {
      roomId: this.voiceBridge,
      meetingId: this.meetingId,
      userId: this.userId,
      role: this.role,
      connectionId: this.connectionId,
    };
  }

  _trackClientEndpointEvents () {
    if (this.clientEndpoint) {
      this.clientEndpoint.once(C.MEDIA_SERVER_OFFLINE, (event) => {
        this.emit(C.MEDIA_SERVER_OFFLINE, event);
      });
    }

  }

  _clearClientEndpointEvents () {
    if (this.clientEndpoint) {
      this.clientEndpoint.removeAllListeners();
    }
  }

  _trackMeetingEvents () {
    if (EJECT_ON_USER_LEFT) {
      this.bbbGW.once(C.USER_LEFT_MEETING_2x+this.bbbUserId, this.disconnectUser);
    }
  }

  /* ======= ICE HANDLERS ======= */

  onIceCandidate (candidate) {
    if (this.clientEndpoint) {
      this.clientEndpoint.onIceCandidate(candidate);
    }
  }

  _flushCandidatesQueue () {
    if (this.clientEndpoint) {
      this.clientEndpoint._flushCandidatesQueue();
    }
  }

  /* ======= START/CONNECTION METHODS ======= */

  async transceive(sdpOffer) {
    if (!FULLAUDIO_ENABLED) throw SFUErrors.SFU_INVALID_REQUEST;

    this.clientEndpoint = new ClientAudioStTransceiver(
      this.bbbGW,
      this.meetingId,
      this.voiceBridge,
      this.userId,
      this.connectionId,
      this.callerId,
      this.mcs, {
        mediaServer: this.mediaServer,
        extension: this.extension,
      }
    );

    return this.clientEndpoint.start(sdpOffer);
  }

  async _startConsumerBridge () {
    let bridge = getConsumerBridge(this.meetingId);

    if (bridge) {
      if (bridge.isRunning()) return bridge;
      await bridge.start();
      return bridge;
    }

    bridge = new FSConsumerBridge(
      this.mcs,
      this.voiceBridge,
      this.mediaServer,
    );
    storeConsumerBridge(bridge, this.meetingId);

    await bridge.start();

    return bridge;
  }

  async listen (sdpOffer) {
    const consumerBridge = await this._startConsumerBridge();
    const clientConsumer = new ClientAudioConsumer(
      this.bbbGW,
      this.meetingId,
      this.voiceBridge,
      this.userId,
      this.connectionId,
      this.mcs,
      consumerBridge,
    );

    this.clientEndpoint = clientConsumer;
    return clientConsumer.start(sdpOffer);
  }

  processAnswer (answer) {
    Logger.debug(LOG_PREFIX, 'Audio session: processing answer',
      this._getFullLogMetadata()
    );

    if (this.clientEndpoint && typeof this.clientEndpoint.processAnswer === 'function') {
      return this.clientEndpoint.processAnswer(answer);
    }

    return Promise.resolve();
  }

  async dtmf (tones) {
    let sentDigits = '';

    if (this.clientEndpoint && typeof this.clientEndpoint.dtmf === 'function') {
      sentDigits = await this.clientEndpoint.dtmf(tones);
    }

    return sentDigits;
  }

  async start (sdpOffer) {
    Logger.info(LOG_PREFIX, 'Starting audio session', this._getFullLogMetadata());

    try {
      const sdpAnswer = (this.role === 'sendrecv')
        ? await this.transceive(sdpOffer)
        : await this.listen(sdpOffer);

      this._trackClientEndpointEvents();

      return sdpAnswer;
    } catch (error) {
      const normalizedError = this._handleError(LOG_PREFIX, error, this.role, this.userId);
      Logger.error(LOG_PREFIX, 'Audio session: start failure', {
        ...this._getFullLogMetadata(),
        error: normalizedError
      });
      throw normalizedError;
    }
  }

  /* ======= STOP METHODS ======= */

  async stop () {
    this._clearClientEndpointEvents();

    if (this.clientEndpoint && typeof this.clientEndpoint.stop) {
      await this.clientEndpoint.stop();
      Logger.info(LOG_PREFIX, 'Audio session stopped',
        this._getFullLogMetadata(this.connectionId));
    }

    this.clientEndpoint = null;
  }

  async disconnectUser() {
    try {
      await this.stop();
    } catch (error) {
      Logger.error(LOG_PREFIX, 'Audio session: failure to stop on UserLeft*',
        { ...this._getFullLogMetadata(this.connectionId), errorMessage: error.message });
    } finally {
      this.sendToClient({
        connectionId: this.connectionId,
        type: C.AUDIO_APP,
        id : 'close',
      }, C.FROM_AUDIO);
    }
  }
};
