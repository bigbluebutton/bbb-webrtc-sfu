'use strict';

const { EventEmitter } = require('events');
const config = require('config');
const C = require('../bbb/messages/Constants');
const Logger = require('../common/logger.js');
const errors = require('../base/errors.js');

const GLOBAL_AUDIO_PREFIX = "GLOBAL_AUDIO_";
const GLOBAL_AUDIO_CONNECTION_TIMEOUT = config.get('mediaFlowTimeoutDuration');
const BRIDGE_MODE = config.has('fsBridgeMode') ? config.get('fsBridgeMode') : 'RTP';
const VALID_BRIDGE_MODES = ['RTP', 'WebRTC'];
const RESTART_DELAY = 10000;

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
    this._restarting = false;
    this._restartRoutine = null;

    this.fsMediaId = null;
    this.bridgeMediaId = null;
    this.bridgeMediaStatus = C.MEDIA_STOPPED;
    this.ignoreMCSMediaEvents = false;
    this.subscribers = new Set();

    this.handleMCSCoreDisconnection = this._handleMCSCoreDisconnection.bind(this);
    this._onBridgeMediaStateChange = this._onBridgeMediaStateChange.bind(this);
    this._onGAStateChange = this._onGAMediaStateChange.bind(this);
    this._onProxyStateChange = this._onProxyMediaStateChange.bind(this);
    this._onGADisconnection = this._onGADisconnection.bind(this);

    this.mcs.on(C.MCS_DISCONNECTED, this.handleMCSCoreDisconnection);
  }

  _handleMCSCoreDisconnection () {
    this.emit(C.MEDIA_SERVER_OFFLINE);
  }

  _untrackMCSEvents () {
    this.mcs.removeListener(C.MCS_DISCONNECTED, this.handleMCSCoreDisconnection);
    // MCS api level events do not support manual removal of listeners yet
    // so we need to bypass them.
    this.ignoreMCSMediaEvents = true
  }

  set ignoreMCSMediaEvents (value) {
    Logger.debug("FS consumer bridge: ignoreMCSMediaEvents", {
      ...this.getFullLogMetadata(),
      ignore: value,
    });

    this._ignoreMCSMediaEvents = value;
  }

  get ignoreMCSMediaEvents () {
    return this._ignoreMCSMediaEvents;
  }

  set bridgeMediaStatus (status) {
    this._bridgeMediaStatus = status;
    this.emit(this._bridgeMediaStatus);
  }

  get bridgeMediaStatus () {
    return this._bridgeMediaStatus;
  }

  addSubscriber (subscriberSessionId) {
    this.subscribers.add(subscriberSessionId);
  }

  removeSubscriber (subscriberSessionId) {
    this.subscribers.delete(subscriberSessionId);
  }

  getNumberOfSubscribers () {
    return this.subscribers.size;
  }

  isExpired () {
    return this.bridgeMediaStatus === C.MEDIA_STOPPED
      || this.bridgeMediaStatus === C.MEDIA_NEGOTIATION_FAILED;
  }

  isIdle () {
    return this.isExpired() || this.getNumberOfSubscribers() === 0;
  }

  isRunning () {
    return this.bridgeMediaStatus === C.MEDIA_STARTED;
  }

  getFullLogMetadata () {
    return {
      roomId: this.voiceBridge,
      status: this.bridgeMediaStatus,
      bridgeMediaIdId: this.bridgeMediaId,
      fsMediaId: this.fsMediaId,
    };
  }

  /* ======= MEDIA STATE HANDLERS ======= */

  _setRestartRoutine () {
    if (this._restartRoutine) return;

    this._restartRoutine = setTimeout(async () => {
      try {
        await this.start();
      } catch (error) {
        Logger.error('FS consumer bridge: global audio restart failure',
          { ...this.getFullLogMetadata(), errorMessage: error.message });
      }
    }, RESTART_DELAY);
  }

  _clearRestartRoutine () {
    if (this._restartRoutine) {
      clearTimeout(this._restartRoutine);
      this._restartRoutine = null;
    }
  }

  async _onGADisconnection (event) {
    if (this.ignoreMCSMediaEvents) return;

    Logger.warn('FS consumer bridge: global audio disconnected',
      { ...this.getFullLogMetadata(), event });
    this.ignoreMCSMediaEvents = true;
    this.bridgeMediaStatus = C.MEDIA_RESTARTING;
    this._restarting = true;
    await this.stop();
    this._restartRoutine = this._setRestartRoutine();
  }

  _onGAMediaStateChange (event) {
    if (this.ignoreMCSMediaEvents) return;

    this._onBridgeMediaStateChange(event, this.fsMediaId);
  }

  _onProxyMediaStateChange (event) {
    if (this.ignoreMCSMediaEvents) return;

    this._onBridgeMediaStateChange(event, this.bridgeMediaId);
  }

  _onBridgeMediaStateChange (event, endpoint) {
    if (this.ignoreMCSMediaEvents) return;

    const { mediaId, state } = event;
    const { name } = state;

    if (mediaId !== endpoint) {
      return;
    }

    switch (name) {
      case "MediaFlowOutStateChange":
      case "MediaFlowInStateChange":
        Logger.debug('FS consumer bridge received MediaFlow state',
          { ...this.getFullLogMetadata(), state });
        break;

      case C.MEDIA_SERVER_OFFLINE:
        Logger.error('CRITICAL: FS consumer bridge received MEDIA_SERVER_OFFLINE',
          { ...this.getFullLogMetadata(), event });
        this.emit(C.MEDIA_SERVER_OFFLINE, event);
        break;

      default: return;
    }
  }

  /* ======= START/CONNECTION METHODS ======= */

  _waitForGlobalAudio () {
    this._clearRestartRoutine();

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
        case C.MEDIA_RESTARTING:
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

      if (!this._negotiated
        && (this.bridgeMediaStatus === C.MEDIA_STOPPED
          || this.bridgeMediaStatus === C.MEDIA_RESTARTING)) {
        this.bridgeMediaStatus = C.MEDIA_STARTING;
        this.ignoreMCSMediaEvents = false;

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
        this.bridgeMediaId = proxyId;
        this.mcs.onEvent(C.MEDIA_STATE, proxyId, this._onProxyStateChange);

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
        this.fsMediaId = gaMediaId;

        this.mcs.onEvent(C.MEDIA_STATE, gaMediaId, this._onGAMediaStateChange);
        this.mcs.onEvent(C.MEDIA_DISCONNECTED, gaMediaId, this._onGADisconnection);

        // Step 3
        // Send back the answer from #2 (FS) to the publisher created in #1
        // (client proxy/relay)
        await this.mcs.publish(
          this.userId,
          this.voiceBridge,
          transportType,
          { ...proxyOptions, mediaId: proxyId, descriptor: globalAudioAnswer }
        );

        this._negotiated = true;

        if (this._restarting) {
          this.emit(C.MEDIA_RESTARTED);
          this._restarting = false;
        }

        this.emit(C.MEDIA_STARTED);
        this.bridgeMediaStatus = C.MEDIA_STARTED;

        Logger.info('FS consumer bridge started', this.getFullLogMetadata());
      }
    } catch (error) {
      Logger.error('FS consumer bridge: start failure',
        { ...this.getFullLogMetadata(), errorMessage: error.message });
      this.bridgeMediaStatus = C.MEDIA_NEGOTIATION_FAILED;
      // Rollback
      this.stop();
      throw (error);
    }
  }

  async start () {
    return this._waitForGlobalAudio();
  }

  finalDetachEventListeners () {
    this._clearRestartRoutine();
    this._untrackMCSEvents();
    this.removeAllListeners();

  }

  stop () {
    this._untrackMCSEvents();

    if (this.userId == null) return Promise.resolve();

    return this.mcs.leave(this.voiceBridge, this.userId).catch(error => {
      Logger.warn('Failed to stop consumer bridge; this may cause a leak', {
        ...this.getFullLogMetadata(), errorMessage: error.message,
      });
    }).finally(() => {
      this._negotiated = false;
      this.bridgeMediaStatus = C.MEDIA_STOPPED;
    });
  }
};
