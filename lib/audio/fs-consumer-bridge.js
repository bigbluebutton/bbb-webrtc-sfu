'use strict';

const { EventEmitter } = require('events');
const config = require('config');
const C = require('../bbb/messages/Constants');
const Logger = require('../common/logger.js');
const errors = require('../base/errors.js');

const LOG_PREFIX = '[fs-consumer-bridge]';
const GLOBAL_AUDIO_PREFIX = "GLOBAL_AUDIO_";
const GLOBAL_AUDIO_CONNECTION_TIMEOUT = config.get('mediaFlowTimeoutDuration');
const BRIDGE_MODE = config.has('fsBridgeMode') ? config.get('fsBridgeMode') : 'RTP';
const VALID_BRIDGE_MODES = ['RTP', 'WebRTC'];

module.exports = class FSConsumerBridge extends EventEmitter {
  static isValidBridgeMode (bridgeMode) {
    return VALID_BRIDGE_MODES.some(targetMode => targetMode === bridgeMode);
  }

  constructor(mcs, voiceBridge, adapter) {
    super();
    this.mcs = mcs;
    this.voiceBridge = voiceBridge;
    this.adapter = adapter;

    this._bridgeMediaName = `${GLOBAL_AUDIO_PREFIX}${this.voiceBridge}`;
    this._negotiated = false;

    this.fsMediaId = null;
    this.bridgeMediaId = null;
    this.bridgeMediaStatus = C.MEDIA_STOPPED;

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

  isRunning () {
    return this.bridgeMediaStatus === C.MEDIA_STARTED;
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
        Logger.debug(LOG_PREFIX, 'FS consumer bridge received MediaFlow state',
          { ...this._getFullLogMetadata(), state });
        break;

      case C.MEDIA_SERVER_OFFLINE:
        Logger.error(LOG_PREFIX, 'CRITICAL: FS consumer bridge received MEDIA_SERVER_OFFLINE',
          { ...this._getFullLogMetadata(), event });
        this.emit(C.MEDIA_SERVER_OFFLINE, event);
        break;

      default: return;
    }
  }

  /* ======= START/CONNECTION METHODS ======= */

  _waitForGlobalAudio () {
    const waitForConnection = () => {
      return new Promise((resolve, reject) => {
        const onMediaStarted = () =>  {
          this.removeListener(C.MEDIA_NEGOTIATION_FAILED, onMediaFailed);
          this.removeListener(C.MEDIA_STOPPED, onMediaFailed);
          resolve(true)
        };
        const onMediaFailed = () =>  {
          this.removeListener(C.MEDIA_NEGOTIATION_FAILED, onMediaFailed);
          this.removeListener(C.MEDIA_STOPPED, onMediaFailed);
          this.removeListener(C.MEDIA_STARTED, onMediaStarted);
          reject(false)
        };

        this.once(C.MEDIA_STARTED, onMediaStarted);
        this.once(C.MEDIA_NEGOTIATION_FAILED, onMediaFailed);
        this.once(C.MEDIA_STOPPED, onMediaFailed);
      });
    };

    const connectionProbe = () => {
      switch (this.bridgeMediaStatus) {
        case C.MEDIA_STARTED:
          return Promise.resolve(true);
        case C.MEDIA_STOPPED:
          return this._startConsumerBridge(BRIDGE_MODE);
        default:
          return waitForConnection();
      }
    };

    const failOver = () => {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          return reject(errors.MEDIA_SERVER_REQUEST_TIMEOUT);
        }, GLOBAL_AUDIO_CONNECTION_TIMEOUT);
      });
    };

    return Promise.race([connectionProbe(), failOver()]);
  }

  async _startConsumerBridge (transportType) {
    if (!FSConsumerBridge.isValidBridgeMode(transportType)) {
      throw new TypeError('Invalid bridge mode');
    }

    try {
      // 1 - Generate a publisher/producer media session @client-facing adapterOptions
      //     (this one will relay audio from FS to browser clients)
      // 2 - Generate a publisher/producer media session in FS's adapter with
      //     the offer generated in #1 (this one will extract audio from FS's
      //     voice conf)
      // 3 - Send back the answer from #2 (FS) to the publisher created in #1
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

        // Step 1:
        // Add a publisher/proxy in the client-facing media server adapter that
        // will receive media from the GLOBAL_AUDIO endpoint in FS's adapter.
        // That publisher will act as the WebRTC relay/proxy for listen only
        // subscribers
        const proxyOptions = {
          adapter: this.adapter,
          name: `PROXY_${this._bridgeMediaName}|subscribe`,
          ignoreThresholds: true,
          hackForceActiveDirection: true,
          trickle: false,
          profiles: {
            audio: 'sendonly',
          },
          mediaProfile: 'audio',
          adapterOptions: {
            msHackRTPAVPtoRTPAVPF: true,
            overrideDirection: 'sendrecv',
          },
        }

        const { mediaId: proxyId, answer: proxyOffer } = await this.mcs.publish(
          this.userId,
          this.voiceBridge,
          transportType,
          proxyOptions,
        );

        this.mcs.onEvent(C.MEDIA_STATE, proxyId, (event) => {
          this._onBridgeMediaStateChange(event, proxyId);
        });

        // Step 2
        // Generate a publisher/producer media session in FS's adapter with
        // the offer generated in #1 (this one will extract audio from FS's
        // voice conf)
        const globalAudioOptions = {
          adapter: 'Freeswitch',
          name: this._bridgeMediaName,
          ignoreThresholds: true,
          descriptor: proxyOffer,
          profiles: {
            audio: 'sendonly',
          },
          mediaProfile: 'audio',
        }

        const { mediaId: gaMediaId, answer: globalAudioAnswer } = await this.mcs.publish(
          this.userId,
          this.voiceBridge,
          transportType,
          globalAudioOptions
        );

        // Step 3
        // Send back the answer from #2 (FS) to the publisher created in #1
        // (client proxy/relay)
        await this.mcs.publish(
          this.userId,
          this.voiceBridge,
          transportType,
          { ...proxyOptions, mediaId: proxyId, descriptor: globalAudioAnswer }
        );

        this.bridgeMediaId = proxyId;
        this.fsMediaId = gaMediaId;
        this._negotiated = true;
        this.bridgeMediaStatus = C.MEDIA_STARTED;
        this.emit(C.MEDIA_STARTED);

        Logger.info(LOG_PREFIX, 'FS consumer bridge started', this._getFullLogMetadata());
      }
    } catch (error) {
      Logger.error(LOG_PREFIX, 'FS consumer bridge: start failure',
        { ...this._getFullLogMetadata(), errorMessage: error.message });
      this.bridgeMediaStatus = C.MEDIA_NEGOTIATION_FAILED;
      // Rollback
      this.stop();
      throw (error);
    }
  }

  async start () {
    return this._waitForGlobalAudio();
  }

  stop () {
    if (this.userId == null) return Promise.resolve();

    return this.mcs.leave(this.voiceBridge, this.userId).catch(error => {
      Logger.warn(LOG_PREFIX, 'Failed to stop consumer bridge; this may cause a leak', {
        ...this._getFullLogMetadata(), errorMessage: error.message,
      });
    }).finally(() => {
      this._negotiated = false;
      this.bridgeMediaStatus = C.MEDIA_STOPPED;
    });
  }
};
