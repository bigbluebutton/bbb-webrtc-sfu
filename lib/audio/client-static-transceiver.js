'use strict';

const config = require('config');
const C = require('../bbb/messages/Constants');
const Logger = require('../common/logger.js');
const Messaging = require('../bbb/messages/Messaging');
const BaseProvider = require('../base/base-provider.js');
const errors = require('../base/errors.js');
const FSTransceiverBridge = require('./fs-transceiver-bridge.js');
const { getAudioRtpHdrExts } = require('./utils.js');

const LOG_PREFIX = '[client-audio-static-transceiver]';
const MEDIA_FLOW_TIMEOUT_DURATION = config.get('mediaFlowTimeoutDuration');
const MEDIA_STATE_TIMEOUT_DURATION = config.get('mediaStateTimeoutDuration');
const PERMISSION_PROBES = config.get('permissionProbes');
const AUDIO_RTP_HDR_EXTS = getAudioRtpHdrExts();

module.exports = class ClientAudioStTransceiver extends BaseProvider {
  constructor(
    bbbGW,
    meetingId,
    voiceBridge,
    userId,
    connectionId,
    callerId,
    mcs,
    options
  ) {
    super(bbbGW);
    this.sfuApp = C.AUDIO_APP;
    this.meetingId = meetingId;
    this.voiceBridge = voiceBridge;
    this.userId = userId;
    this.connectionId = connectionId;
    this.callerId = callerId;
    this.mcs = mcs;
    this.mediaServer = options.mediaServer;
    this.extension = options.extension;

    this.transceiverBridge = new FSTransceiverBridge(
      this.mcs,
      this.voiceBridge,
      this.callerId,
      this.mediaServer, {
        extension: this.extension,
      }
    );

    this.mcsUserId = null;
    this.connected = false;
    this.mediaId = null;
    this._mediaFlowingTimeout = null;
    this._mediaStateTimeout = null;
    this._candidatesQueue = [];

    this.handleMCSCoreDisconnection = this.handleMCSCoreDisconnection.bind(this);
    this.mcs.on(C.MCS_DISCONNECTED, this.handleMCSCoreDisconnection);
  }

  _getFullLogMetadata () {
    return {
      roomId: this.voiceBridge,
      meetingId: this.meetingId,
      userId: this.userId,
      connectionId: this.connectionId,
      mediaId: this.mediaId,
      bridgeStatus: this.transceiverBridge.bridgeMediaStatus,
      bridgeMediaId: this.transceiverBridge.bridgeMediaId,
    };
  }

  /* ======= ICE HANDLERS ======= */

  onIceCandidate (_candidate) {
    if (this.mediaId) {
      try {
        this._flushCandidatesQueue();
        this.mcs.addIceCandidate(this.mediaId, _candidate);
      } catch (error)   {
        Logger.error(LOG_PREFIX, 'ICE candidate failure', {
          ...this._getFullLogMetadata(), errorMessage: error.message
        });
      }
    } else {
      this._candidatesQueue.push(_candidate);
    }
  }

  _flushCandidatesQueue () {
    if (this.mediaId) {
      try {
        if (this._candidatesQueue) {
          this.flushCandidatesQueue(this.mcs, [...this._candidatesQueue], this.mediaId);
          this._candidatesQueue = [];
        }
      } catch (error) {
        Logger.error(LOG_PREFIX, 'ICE candidate failure', {
          ...this._getFullLogMetadata(), errorMessage: error.message
        });
      }
    }
  }

  /* ======= USER STATE MANAGEMENT ======= */

  getGlobalAudioPermission (meetingId, voiceBridge, userId) {
    if (!PERMISSION_PROBES) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onResp = (payload) => {
        if (meetingId === payload.meetingId
          && voiceBridge === payload.voiceConf
          && userId === payload.userId && payload.allowed) {
          return resolve();
        }

        return reject(errors.SFU_UNAUTHORIZED);
      }

      const msg = Messaging.generateGetGlobalAudioPermissionReqMsg(
        meetingId,
        voiceBridge,
        userId,
        this.connectionId
      );
      this.bbbGW.once(C.GET_GLOBAL_AUDIO_PERM_RESP_MSG+this.connectionId, onResp);
      this.bbbGW.publish(msg, C.TO_AKKA_APPS_CHAN_2x);
    });
  }

  /* ======= MEDIA TIMEOUT HANDLERS ===== */

  _onSubscriberMediaFlowing () {
    Logger.debug(LOG_PREFIX, 'Client audio transceiver is FLOWING',
      this._getFullLogMetadata());
    this.clearMediaFlowingTimeout();
    this.sendToClient({
      type: 'audio',
      connectionId: this.connectionId,
      id: "webRTCAudioSuccess",
      success: "MEDIA_FLOWING"
    }, C.FROM_AUDIO);
  }

  _onSubscriberMediaNotFlowing () {
    Logger.debug(LOG_PREFIX, 'Client audio transceiver is NOT_FLOWING',
      this._getFullLogMetadata());
    this.setMediaFlowingTimeout();
  }

  _onSubscriberMediaNotFlowingTimeout () {
    Logger.error(LOG_PREFIX, 'Client audio transceiver NOT_FLOWING timeout reached',
      this._getFullLogMetadata());
    this.sendToClient({
      type: 'audio',
      connectionId: this.connectionId,
      id: "webRTCAudioError",
      error: { code: 2211 , reason: errors[2211] },
    }, C.FROM_AUDIO);
  }

  setMediaFlowingTimeout () {
    if (!this._mediaFlowingTimeout) {
      Logger.debug(LOG_PREFIX, 'Client audio transceiver NOT_FLOWING timeout set',
        this._getFullLogMetadata());
      this._mediaFlowingTimeout = setTimeout(() => {
        this._onSubscriberMediaNotFlowingTimeout();
      }, MEDIA_FLOW_TIMEOUT_DURATION);
    }
  }

  clearMediaFlowingTimeout () {
    if (this._mediaFlowingTimeout) {
      clearTimeout(this._mediaFlowingTimeout);
      this._mediaFlowingTimeout = null;
    }
  }

  _onSubscriberMediaConnected () {
    Logger.info(LOG_PREFIX, 'Client audio transceiver is CONNECTED',
      this._getFullLogMetadata());
    this.clearMediaStateTimeout();
  }

  _onSubscriberMediaDisconnected () {
    Logger.warn(LOG_PREFIX, 'Client audio transceiver is DISCONNECTED',
      this._getFullLogMetadata());
    this.setMediaStateTimeout();
  }

  _onSubscriberMediaDisconnectedTimeout () {
    Logger.error(LOG_PREFIX, 'Client audio transceiver DISCONNECTED timeout reached',
      this._getFullLogMetadata());

    this.sendToClient({
      type: 'audio',
      connectionId: this.connectionId,
      id: "webRTCAudioError",
      error: { code: 2211 , reason: errors[2211] },
    }, C.FROM_AUDIO);
  }

  setMediaStateTimeout () {
    if (!this._mediaStateTimeout) {
      Logger.warn(LOG_PREFIX, 'Client audio transceiver media state timeout set',
        this._getFullLogMetadata());
      this._mediaStateTimeout = setTimeout(() => {
        this._onSubscriberMediaDisconnectedTimeout();
      }, MEDIA_STATE_TIMEOUT_DURATION);
    }
  }

  clearMediaStateTimeout () {
    if (this._mediaStateTimeout) {
      clearTimeout(this._mediaStateTimeout);
      this._mediaStateTimeout = null;
    }
  }

  /* ======= MEDIA STATE HANDLERS ======= */

  _onMCSIceCandidate (event, targetMediaId) {
    const { mediaId, candidate } = event;

    if (mediaId !== targetMediaId) {
      return;
    }

    this.sendToClient({
      type: 'audio',
      connectionId: this.connectionId,
      id : 'iceCandidate',
      candidate : candidate
    }, C.FROM_AUDIO);
  }

  _handleMediaStateChanged (state, logMetadata) {
    const { rawEvent, details } = state;
    const { source: elementId } = rawEvent;
    Logger.trace(LOG_PREFIX, 'Client audio transceiver media state changed', {
      ...logMetadata,
      elementId,
      mediaState: details,
    });

    if (details === 'CONNECTED') {
      this._onSubscriberMediaConnected();
    } else if (details === 'DISCONNECTED') {
      this._onSubscriberMediaDisconnected();
    }
  }

  _mediaStateWebRTC (event, targetMediaId) {
    const { mediaId , state } = event;
    const { name, details } = state;
    const logMetadata = this._getFullLogMetadata();

    if (mediaId !== targetMediaId) {
      return;
    }

    switch (name) {
      case "MediaStateChanged":
        this._handleMediaStateChanged(state, logMetadata);
        break;
      case "MediaFlowOutStateChange":
      case "MediaFlowInStateChange":
        Logger.trace(LOG_PREFIX, 'Client audio transceiver received MediaFlow state',
          { ...logMetadata, state });

        if (details === 'FLOWING') {
          this._onSubscriberMediaFlowing();
        } else {
          this._onSubscriberMediaNotFlowing();
        }
        break;

      case C.MEDIA_SERVER_OFFLINE:
        Logger.error(LOG_PREFIX, 'CRITICAL: Client audio transceiver received MEDIA_SERVER_OFFLINE',
          { ...logMetadata, event });
        this.emit(C.MEDIA_SERVER_OFFLINE, event);
        break;

      default: return;
    }
  }

  /* ======= START/CONNECTION METHODS ======= */

  async start (sdpOffer) {
    const isConnected = await this.mcs.waitForConnection();

    if (!isConnected) {
      throw this._handleError(LOG_PREFIX, errors.MEDIA_SERVER_OFFLINE, "sendrecv", this.userId);
    }

    try {
      await this.getGlobalAudioPermission(this.meetingId, this.voiceBridge, this.userId);
    } catch (error) {
      const normalizedError = this._handleError(LOG_PREFIX, error, "sendrecv", this.userId);
      Logger.error(LOG_PREFIX, 'Client audio transceiver failed: unauthorized',
        { ...this._getFullLogMetadata(), error: normalizedError });
      throw normalizedError;
    }

    try {
      this.mcsUserId = await this.mcs.join(
        this.voiceBridge,
        'SFU',
        { externalUserId: this.userId, autoLeave: true }
      );
    } catch (error) {
      const normalizedError = this._handleError(LOG_PREFIX, error, "sendrecv", this.userId);
      Logger.error(LOG_PREFIX, 'Client audio transceiver failure: mcs-core join', {
        ...this._getFullLogMetadata(),
        error: normalizedError
      });
      throw normalizedError;
    }

    try {
      const sdpAnswer = await this._negotiateTransceiver(sdpOffer);
      return sdpAnswer;
    } catch (error) {
      const normalizedError = this._handleError(LOG_PREFIX, error, "sendrecv", this.userId);
      Logger.error(LOG_PREFIX, 'Transceiver creation failed', {
        ...this._getFullLogMetadata(),
        error: normalizedError
      });
      throw normalizedError;
    }
  }

  async _negotiateTransceiver(sdpOffer) {
    const options = {
      descriptor: sdpOffer,
      adapter: this.mediaServer,
      name: this._assembleStreamName('publish', this.userId, this.meetingId),
      ignoreThresholds: true,
      profiles: {
        audio: 'sendrecv',
      },
      mediaProfile: 'audio',
      adapterOptions: {
        overrideRouterCodecs: true,
        dedicatedRouter: true,
        rtpHeaderExtensions: AUDIO_RTP_HDR_EXTS,
      }
    }

    let mediaId, answer;

    try {
      ({ mediaId } = await this.mcs.publish(
        this.mcsUserId,
        this.voiceBridge,
        C.WEBRTC,
        options,
      ));

      this.mediaId = mediaId;
      await this.transceiverBridge.start(this.mediaId);

      answer = await this.mcs.consume(
        this.transceiverBridge.bridgeMediaId,
        this.mediaId,
        'AUDIO'
      );

      this.mcs.connect(this.mediaId, [this.transceiverBridge.bridgeMediaId], 'AUDIO');
      this.mcs.connect(this.transceiverBridge.bridgeMediaId, [this.mediaId], 'AUDIO');
    } catch (error) {
      Logger.error(LOG_PREFIX, 'Client audio transceiver failure', {
        ...this._getFullLogMetadata(),
        error,
      });
      throw (this._handleError(LOG_PREFIX, error, "sendrecv", this.connectionId));
    }

    this.mcs.onEvent(C.MEDIA_STATE, mediaId, (event) => {
      this._mediaStateWebRTC(event, mediaId);
    });

    this.mcs.onEvent(C.MEDIA_STATE_ICE, mediaId, (event) => {
      this._onMCSIceCandidate(event, mediaId);
    });

    this._flushCandidatesQueue();
    Logger.info(LOG_PREFIX, 'Client audio transceiver started',
      this._getFullLogMetadata());
    return answer;
  }


  processAnswer (answer) {
    if (this.mediaId) {
      const options = {
        descriptor: answer,
        adapter: this.mediaServer,
        name: this._assembleStreamName('publish', this.userId, this.meetingId),
        ignoreThresholds: true,
        profiles: {
          audio: 'sendrecv',
        },
        mediaProfile: 'audio',
        adapterOptions: {
          overrideRouterCodecs: true,
          dedicatedRouter: true,
          rtpHeaderExtensions: AUDIO_RTP_HDR_EXTS,
        }
      }

      return this.mcs.publish(
        this.mcsUserId,
        this.voiceBridge,
        C.WEBRTC,
        options,
      );
    }

    return Promise.resolve();
  }

  async dtmf (tones) {
    if (this.transceiverBridge && typeof this.transceiverBridge.dtmf === 'function') {
      return this.transceiverBridge.dtmf(tones);
    }

    return '';
  }

  /* ======= STOP METHODS ======= */

  async stop () {
    this._candidatesQueue = [];
    this.clearMediaFlowingTimeout();
    this.clearMediaStateTimeout();
    this.mcs.removeListener(C.MCS_DISCONNECTED, this.handleMCSCoreDisconnection);

    if (this.mediaId && this.mcsUserId) {
      try {
        await this.mcs.unpublish(this.mcsUserId, this.mediaId);
        Logger.info(LOG_PREFIX, 'Client audio transceiver stopped',
          this._getFullLogMetadata());
      } catch (error) {
        Logger.warn(LOG_PREFIX, 'Error on unpublish',
          { ...this._getFullLogMetadata(), errorMessage: error.message });
      }
    }

    if (this.transceiverBridge) this.transceiverBridge.stop();

    return Promise.resolve();
  }
};
