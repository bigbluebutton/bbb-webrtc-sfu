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
const Messaging = require('../bbb/messages/Messaging.js');
const { PrometheusAgent, SFUA_NAMES } = require('./metrics/audio-metrics.js');

const EJECT_ON_USER_LEFT = config.get('ejectOnUserLeft');
const FULLAUDIO_ENABLED = config.has('fullAudioEnabled')
  ? config.get('fullAudioEnabled')
  : false;
const TRANSPARENT_LISTEN_ONLY = config.has('transparentListenOnly')
  ? config.get('transparentListenOnly')
  : false;
const DYNAMIC_GLOBAL_AUDIO = config.has('dynamicGlobalAudio')
  ? config.get('dynamicGlobalAudio')
  : false;

module.exports = class AudioSession extends BaseProvider {
  constructor(
    bbbGW,
    sessionId,
    meetingId,
    voiceBridge,
    userId,
    connectionId,
    callerId,
    role,
    mcs,
    mediaServer,
    extension,
    options = {}
  ) {
    super(bbbGW);
    this.sfuApp = C.AUDIO_APP;
    this.id = sessionId;
    this.meetingId = meetingId;
    this.voiceBridge = voiceBridge;
    this.userId = userId;
    this.connectionId = connectionId;
    this.callerId = callerId;
    this.role = role;
    this.mcs = mcs;
    this.mediaServer = mediaServer;
    this.extension = extension;
    this.transparentListenOnlyAllowed = TRANSPARENT_LISTEN_ONLY
      && (options?.transparentListenOnly ?? false);
    // This flag is used to block the transparent listen only mode under
    // certain (internal) conditions. It is not meant to be set by the client.
    this.blockTransparentListenOnly = false;

    this.clientEndpoint = null;
    this.mcsUserId = null;

    this.disconnectUser = this.disconnectUser.bind(this);
    this.toggleListenOnlyMode = this.toggleListenOnlyMode.bind(this);
    this.handleMCSCoreDisconnection = this.handleMCSCoreDisconnection.bind(this);
    this._handleVoiceConfCallState = this._handleVoiceConfCallState.bind(this);

    this._trackMeetingEvents();
    this.mcs.on(C.MCS_DISCONNECTED, this.handleMCSCoreDisconnection);
  }

  set id (id) {
    this._id = id;
  }

  get id () {
    return this._id;
  }

  set clientEndpoint (endpoint) {
    if (endpoint == null && this._clientEndpoint) {
      this._clearClientEndpointEvents();
    }

    this._clientEndpoint = endpoint;
  }

  get clientEndpoint () {
    return this._clientEndpoint;
  }

  isTransparentListenOnlyCapable () {
    return this.transparentListenOnlyAllowed && !this.blockTransparentListenOnly;
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
      this._clientEndpoint.finalDetachEventListeners();
    }
  }

  _handleVoiceConfCallState (event) {
    const { voiceConf, userId, callState, origCalledDest } = event;

    // If callState transitioned to IN_CONFERENCE and voiceConf
    // is different from the current voiceBridge + origCalledDest is equal
    // to the current voiceBridge, then the user has been transferred to
    // a breakout room. In this case, we need to block the transparent
    // listen only mode.
    if (this.userId === userId && callState === 'IN_CONFERENCE') {
      if (voiceConf === this.voiceBridge) {
        this.blockTransparentListenOnly = false;
      } else {
        if (origCalledDest === this.voiceBridge) {
          Logger.info('Audio session: user transferred to breakout room', {
            ...this._getFullLogMetadata(),
            voiceConf,
            origCalledDest,
          });
          this.blockTransparentListenOnly = true;
          this.toggleListenOnlyMode({
            meetingId: this.meetingId,
            voiceConf: this.voiceBridge,
            enabled: false,
            force: true,
          });
        }
      }
    }
  }

  _trackMeetingEvents () {
    if (EJECT_ON_USER_LEFT) {
      this.bbbGW.once(C.USER_LEFT_MEETING_2x+this.userId, this.disconnectUser);
    }

    if (this.isTransparentListenOnlyCapable()) {
      // Track voice conference events to detect audio tranfers between breakout
      // rooms and main room. Only necessary when transparentListenOnly is enabled
      // and the user is in sendrecv mode because the consumerBridge is only
      // currently pinned to the original voice conference of a session.
      this.bbbGW.on(
        C.VOICE_CONF_CALLSTATE_EVT_MSG+this.userId,
        this._handleVoiceConfCallState
      );
      this.bbbGW.on(
        C.TOGGLE_LISTEN_ONLY_MODE_SYS_MSG+this.userId,
        this.toggleListenOnlyMode
      );
    }
  }

  _untrackMeetingEvents () {
    this.bbbGW.removeListener(C.USER_LEFT_MEETING_2x+this.userId, this.disconnectUser);
    this.bbbGW.removeListener(
      C.TOGGLE_LISTEN_ONLY_MODE_SYS_MSG+this.userId,
      this.toggleListenOnlyMode,
    );
    this.bbbGW.removeListener(
      C.VOICE_CONF_CALLSTATE_EVT_MSG+this.userId,
      this._handleVoiceConfCallState,
    );
  }

  _untrackMCSEvents () {
    this.mcs.removeListener(C.MCS_DISCONNECTED, this.handleMCSCoreDisconnection);
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
    let consumerBridge;
    if (!FULLAUDIO_ENABLED) throw SFUErrors.SFU_INVALID_REQUEST;
    if (this.isTransparentListenOnlyCapable() && !DYNAMIC_GLOBAL_AUDIO) {
      consumerBridge = await this._startConsumerBridge();
    }

    this.clientEndpoint = new ClientAudioStTransceiver(
      this.bbbGW,
      this.meetingId,
      this.voiceBridge,
      this.id,
      this.userId,
      this.connectionId,
      this.callerId,
      this.mcs, {
        mediaServer: this.mediaServer,
        extension: this.extension,
        consumerBridge,
        getConsumerBridge: this._startConsumerBridge.bind(this),
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
      this.id,
      this.userId,
      this.connectionId,
      this.mcs,
      consumerBridge,
    );

    this.clientEndpoint = clientConsumer;
    return clientConsumer.start(sdpOffer);
  }

  processAnswer (answer) {
    Logger.debug('Audio session: processing answer',
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

  restartIce () {
    Logger.debug('Audio session: restarting ICE',
      this._getFullLogMetadata()
    );

    if (this.clientEndpoint && typeof this.clientEndpoint.restartIce === 'function') {
      return this.clientEndpoint.restartIce();
    }

    return Promise.resolve();
  }

  async start (sdpOffer) {
    Logger.info('Audio session: starting', this._getFullLogMetadata());

    try {
      const sdpAnswer = (this.role === 'sendrecv')
        ? await this.transceive(sdpOffer)
        : await this.listen(sdpOffer);

      this._trackClientEndpointEvents();

      return sdpAnswer;
    } catch (error) {
      const normalizedError = this._handleError(null, error, this.role, this.userId);
      Logger.error('Audio session: start failure', {
        ...this._getFullLogMetadata(),
        error: normalizedError
      });
      throw normalizedError;
    }
  }

  /* ======= STOP METHODS ======= */
  finalDetachEventListeners () {
    this._clearClientEndpointEvents();
    this._untrackMeetingEvents();
    this._untrackMCSEvents();
    this.removeAllListeners();
  }

  async stop (reason = 'normal_clearing') {
    this._clearClientEndpointEvents();
    this._untrackMeetingEvents();
    this._untrackMCSEvents();

    if (this.clientEndpoint && typeof this.clientEndpoint.stop) {
      await this.clientEndpoint.stop();
      Logger.info('Audio session stopped', {
        reason,
        ...this._getFullLogMetadata(this.connectionId),
      })

      if (this.role === 'sendrecv'
        && this.isTransparentListenOnlyCapable()
        && this.clientEndpoint.mode === C.RECV_ROLE) {
        PrometheusAgent.decrement(SFUA_NAMES.HELD_SESSIONS);
      }
    }

    this.clientEndpoint = null;
  }

  async disconnectUser () {
    try {
      await this.stop('user_left');
    } catch (error) {
      Logger.error('Audio session: failure to stop on UserLeft*',
        { ...this._getFullLogMetadata(this.connectionId), errorMessage: error.message });
    } finally {
      this.sendToClient({
        connectionId: this.connectionId,
        type: C.AUDIO_APP,
        id : 'close',
      }, C.FROM_AUDIO);
    }
  }

  _notifyRecvOnlyModeToggled (enabled) {
    const msg = Messaging.generateListenOnlyModeToggledEvtMsg(
      this.meetingId,
      this.voiceBridge,
      this.userId,
      enabled
    );
    this.bbbGW.publish(msg, C.TO_AKKA_APPS_CHAN_2x);
  }

  async toggleListenOnlyMode ({ meetingId, voiceConf, enabled, force = false }) {
    if (this.clientEndpoint == null
      || this.role !== 'sendrecv'
      || this.clientEndpoint instanceof ClientAudioConsumer
      || this.meetingId !== meetingId
      || this.voiceBridge !== voiceConf
      || (!this.isTransparentListenOnlyCapable() && !force)
    ) {
      Logger.warn('Audio session: toggle recv-only mode: not applicable', {
        ...this._getFullLogMetadata(this.connectionId),
      });
      return;
    }

    if (this.clientEndpoint.consumerBridge == null) {
      const consumerBridge = await this._startConsumerBridge();
      this.clientEndpoint.consumerBridge = consumerBridge;
    }

    this.clientEndpoint.toggleListenOnlyMode(enabled).then((changed) => {
      if (changed) {
        this._notifyRecvOnlyModeToggled(enabled);
        if (enabled) {
          PrometheusAgent.increment(SFUA_NAMES.HELD_SESSIONS);
        } else {
          PrometheusAgent.decrement(SFUA_NAMES.HELD_SESSIONS);
        }
      }
    }).catch((error) => {
      PrometheusAgent.increment(SFUA_NAMES.LISTEN_ONLY_TOGGLE_ERRORS, {
        errorCode: this._handleError(null, error, this.role, this.userId)?.code ?? 0
      });

      Logger.error('Audio session: failure to toggle recv-only mode', {
        ...this._getFullLogMetadata(this.connectionId),
        errorMessage: error.message,
        errorCode: error.code
      });
    });
  }
}
