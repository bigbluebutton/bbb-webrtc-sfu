'use strict';

const { EventEmitter } = require('events');
const config = require('config');
const C = require('../bbb/messages/Constants');
const Logger = require('../common/logger.js');
const errors = require('../base/errors.js');

const LOG_PREFIX = '[fs-transceiver-bridge]';
const BRIDGE_MODE = config.has('fsBridgeMode') ? config.get('fsBridgeMode') : 'RTP';
const VALID_BRIDGE_MODES = ['RTP', 'WebRTC'];
const PROXY_ACTIVE_DIRECTION = config.get('fullAudioProxyActiveDirection');

module.exports = class FSTransceiverBridge extends EventEmitter {
  static isValidBridgeMode (bridgeMode) {
    return VALID_BRIDGE_MODES.some(targetMode => targetMode === bridgeMode);
  }

  constructor(
    mcs,
    voiceBridge,
    bridgeName,
    adapter,
    options = {}
  ) {
    super();
    this.mcs = mcs;
    this.voiceBridge = voiceBridge;
    this.adapter = adapter;

    this._bridgeMediaName = bridgeName;
    this._negotiated = false;

    this.fsMediaId = null;
    this.bridgeMediaId = null;
    this.bridgeMediaStatus = C.MEDIA_STOPPED;
    this.extension = options.extension;

    this.handleMCSCoreDisconnection = this._handleMCSCoreDisconnection.bind(this);
    this.mcs.on(C.MCS_DISCONNECTED, this._handleMCSCoreDisconnection);
  }

  _handleMCSCoreDisconnection () {
    this.emit(C.MEDIA_SERVER_OFFLINE);
  }

  set bridgeMediaStatus (status) {
    this._bridgeMediaStatus = status;
    this.emit(this._bridgeMediaStatus);
  }

  get bridgeMediaStatus () {
    return this._bridgeMediaStatus;
  }

  _getFullLogMetadata () {
    return {
      roomId: this.voiceBridge,
      status: this.bridgeMediaStatus,
      bridgeMediaIdId: this.bridgeMediaId,
      fsMediaId: this.fsMediaId,
    };
  }

  /* ======= MEDIA STATE HANDLERS ======= */

  _onBridgeMediaStateChange (event, endpoint) {
    const { mediaId, state } = event;
    const { name } = state;

    if (mediaId !== endpoint) {
      return;
    }

    switch (name) {
      case "MediaFlowOutStateChange":
      case "MediaFlowInStateChange":
        Logger.debug(LOG_PREFIX, 'FS transceiver bridge received MediaFlow state',
          { ...this._getFullLogMetadata(), state });
        break;

      case C.MEDIA_SERVER_OFFLINE:
        Logger.error(LOG_PREFIX, 'CRITICAL: FS transceiver bridge received MEDIA_SERVER_OFFLINE',
          { ...this._getFullLogMetadata(), event });
        this.emit(C.MEDIA_SERVER_OFFLINE, event);
        break;

      default: return;
    }
  }

  /* ======= START/CONNECTION METHODS ======= */

  async _startTransceiverBridge (transceiverSourceId) {
    if (!FSTransceiverBridge.isValidBridgeMode(BRIDGE_MODE)) {
      throw new TypeError('Invalid bridge mode');
    }

    try {
      // 1 - Generate a pubsub/transceiver session via client-facing adapter
      //     (this one is the transceiver relay between the client and FS)
      // 2 - Generate a pubsub/transceiver session in FS's adapter with
      //     the offer generated in #1 (sendrecv)
      // 3 - Send back the answer from #2 (FS) to the transceiver created in #1
      //     (client proxy/relay)
      if (!this._negotiated && this.bridgeMediaStatus === C.MEDIA_STOPPED) {
        this.bridgeMediaStatus = C.MEDIA_STARTING;

        const isConnected = await this.mcs.waitForConnection();

        if (!isConnected) {
          throw (errors.MEDIA_SERVER_OFFLINE);
        }

        this.userId = await this.mcs.join(this.voiceBridge, 'SFU', {
          name: this._bridgeMediaName
        });

        // Step 1
        const proxyOptions = {
          adapter: this.adapter,
          name: `PROXY_${this._bridgeMediaName}|transceive`,
          ignoreThresholds: true,
          profiles: {
            audio: 'sendonly',
          },
          hackForceActiveDirection: PROXY_ACTIVE_DIRECTION,
          mediaProfile: 'audio',
          adapterOptions: {
            msHackRTPAVPtoRTPAVPF: true,
            consumeFrom: [ transceiverSourceId ],
            transportOptions: {
              comedia: PROXY_ACTIVE_DIRECTION,
            },
          },
        }

        const { mediaId: proxyId, answer: proxyOffer } = await this.mcs.publish(
          this.userId,
          this.voiceBridge,
          BRIDGE_MODE,
          proxyOptions,
        );

        this.mcs.onEvent(C.MEDIA_STATE, proxyId, (event) => {
          this._onBridgeMediaStateChange(event, proxyId);
        });

        // Step 2
        const fsOptions = {
          adapter: 'Freeswitch',
          name: this._bridgeMediaName,
          ignoreThresholds: true,
          descriptor: proxyOffer,
          profiles: {
            audio: 'sendrecv',
          },
          mediaProfile: 'audio',
          adapterOptions: {
            extension: this.extension ? `${this.extension}${this.voiceBridge}` : undefined,
          }
        }

        const { mediaId: fsMediaId, answer: fsAnswer } = await this.mcs.publish(
          this.userId,
          this.voiceBridge,
          BRIDGE_MODE,
          fsOptions,
        );

        // Step 3
        await this.mcs.publish(
          this.userId,
          this.voiceBridge,
          BRIDGE_MODE,
          { ...proxyOptions, mediaId: proxyId, descriptor: fsAnswer }
        );

        this.bridgeMediaId = proxyId;
        this.fsMediaId = fsMediaId;
        this._negotiated = true;
        this.bridgeMediaStatus = C.MEDIA_STARTED;
        this.emit(C.MEDIA_STARTED);

        Logger.info(LOG_PREFIX, 'FS transceiver bridge started', this._getFullLogMetadata());
      }
    } catch (error) {
      Logger.error(LOG_PREFIX, 'FS transceiver bridge: start failure',
        { ...this._getFullLogMetadata(), errorMessage: error.message });
      this.bridgeMediaStatus = C.MEDIA_NEGOTIATION_FAILED;
      // Rollback
      this.stop();
      throw (error);
    }
  }

  async dtmf (tones) {
    let sentDigits = '';

    if (this.fsMediaId) {
      try {
        sentDigits = await this.mcs.dtmf(this.fsMediaId, tones, {
          mode: 'info',
        });

        Logger.debug(LOG_PREFIX, 'Sent DTMF tones',
          { ...this._getFullLogMetadata(), tones }
        );
      } catch (error) {
        Logger.error(LOG_PREFIX, 'DTMF failed',
          { ...this._getFullLogMetadata(), error }
        );
      }
    }

    return sentDigits;
  }

  // transceiverSourceId: the mcs-core media session ID from which the bridge
  // should consume audio FROM to SEND towards FREESWITCH
  async start (transceiverSourceId) {
    return this._startTransceiverBridge(transceiverSourceId);
  }

  stop () {
    if (this.userId == null) return Promise.resolve();

    return this.mcs.leave(this.voiceBridge, this.userId).catch(error => {
      Logger.warn(LOG_PREFIX, 'Failed to stop transceiver bridge; this may cause a leak', {
        ...this._getFullLogMetadata(), errorMessage: error.message,
      });
    }).finally(() => {
      this._negotiated = false;
      this.bridgeMediaStatus = C.MEDIA_STOPPED;
    });
  }
};
