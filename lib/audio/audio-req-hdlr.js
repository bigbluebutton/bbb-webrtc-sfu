"use strict";

const AudioSession = require('./audio-session.js');
const BaseManager = require('../base/base-manager.js');
const C = require('../bbb/messages/Constants');
const Logger = require('../common/logger.js');
const errors = require('../base/errors');
const config = require('config');
const {
  getConsumerBridge,
  deleteConsumerBridge,
} = require('./consumer-bridge-storage.js');
const { PrometheusAgent, SFUA_NAMES } = require('./metrics/audio-metrics.js');
const {
  getMicrophonePermission,
  getGlobalAudioPermission,
  isRoleValid,
  isClientSessNumberValid,
} = require('./utils.js');

const AUDIO_MEDIA_SERVER = config.get('audioMediaServer');
const ICE_RESTART = config.has('audioIceRestartEnabled')
  ? config.get('audioIceRestartEnabled')
  : false;

const DTMF_DIGITS_CAP = '20';
const SESSID_STOK = '/';

module.exports = class AudioReqHdlr extends BaseManager {
  static validateStartReq (message) {
    const { role, clientSessionNumber } = message;
    if (!isClientSessNumberValid(clientSessionNumber)) {
      Logger.debug('Invalid clientSessionNumber', AudioReqHdlr.getMetadataFromMessage(message));
      throw errors.SFU_INVALID_REQUEST;
    }
    if (!isRoleValid(role)) {
      Logger.debug('Invalid role', AudioReqHdlr.getMetadataFromMessage(message));
      throw errors.SFU_INVALID_REQUEST;
    }
  }

  static genCallerIdNum (request = {}) {
    const { userId, clientSessionNumber, role, userName } = request;
    const suffix = role === 'sendrecv' ? userName : 'GLOBAL_AUDIO';

    return `${userId}_${clientSessionNumber}-bbbID-${suffix}`;
}

  static getMetadataFromMessage (message = {}) {
    return {
      sessionId: AudioReqHdlr.getSessionId(message),
      sfuMessageId: message.id,
      connectionId: message.connectionId,
      meetingId: message.meetingId,
      roomId: message.voiceBridge,
      userId: message.userId,
      role: message.role,
      reason: message.id === 'error' ? message.reason : undefined,
    };
  }

  static explodeUserInfoHeader (message) {
    if (typeof message === 'object' &&  typeof message.sfuUserHeader === 'object') {
      if (typeof message.sfuUserHeader.userId === 'string'
        && typeof message.sfuUserHeader.voiceBridge === 'string'
        && typeof message.sfuUserHeader.meetingId === 'string'
        && typeof message.sfuUserHeader.userName === 'string'
      ) {
        message.meetingId = message.sfuUserHeader.meetingId;
        message.userId = message.sfuUserHeader.userId;
        message.voiceBridge = message.sfuUserHeader.voiceBridge;
        message.userName = message.sfuUserHeader.userName;

        return message;
      }
    }

    throw errors.SFU_INVALID_REQUEST;
  }

  static getSessionId (message = {}) {
    return `${message.meetingId}${SESSID_STOK}` +
      `${message.voiceBridge}${SESSID_STOK}` +
      `${message.userId}${SESSID_STOK}` +
      `${message.connectionId}`;
  }

  constructor (connectionChannel, additionalChannels, logPrefix) {
    super(connectionChannel, additionalChannels, logPrefix);
    this.sfuApp = C.AUDIO_APP;

    this._handleFatalFailure = this._handleFatalFailure.bind(this);

    this._trackMeetingEvents();
    this.messageFactory(this._onMessage.bind(this));
    this._setMetrics();
  }

  _trackMeetingEvents () {
    this._bbbGW.on(C.DISCONNECT_ALL_USERS_2x, (payload) => {
      const meetingId = payload[C.MEETING_ID_2x];
      this._disconnectAllUsers(meetingId);
    });
  }

  _setMetrics() {
    PrometheusAgent.setCollectorWithGenerator(
      SFUA_NAMES.SESSIONS,
      this.getNumberOfSessions.bind(this)
    );
  }

  _stopConsumerBridge (meetingId) {
    const bridge = getConsumerBridge(meetingId);

    if (bridge == null) return;

    deleteConsumerBridge(meetingId);
    bridge.stop();
  }

  _disconnectAllUsers (meetingId) {
    if (!meetingId || !this.getNumberOfSessions()) return;

    Logger.info('Disconnecting all audio sessions: meeting end', {
      meetingId
    });

    // FIXME inefficient
    this.sessions.forEach(session => {
      if (session.meetingId !== meetingId) return;

      const sessionMetadata = session?._getFullLogMetadata() ?? {};
      this._closeSession(session.id, sessionMetadata);
    });

    this._stopConsumerBridge(meetingId);
  }

  _handleFatalFailure (sessionId, connectionId, role, rawError, reqId = 'event') {
    const sessionMetadata = this.getSession(sessionId)?._getFullLogMetadata() ?? {};
    const error = this._handleError(
      this._logPrefix,
      connectionId,
      null,
      role,
      rawError,
    );

    this.sendToClient({
      type: 'audio',
      id: 'webRTCAudioError',
      ...error,
    }, C.FROM_AUDIO);

    this._closeSession(sessionId, sessionMetadata);

    PrometheusAgent.increment(SFUA_NAMES.ERRORS, {
      method: reqId, errorCode: error.code
    });
  }

  _trackFatalFailures(session) {
    session.once(C.MEDIA_SERVER_OFFLINE, () => {
      const normalizedMSOError = this._handleError(
        this._logPrefix,
        session.connectionId,
        null,
        session.role,
        errors.MEDIA_SERVER_OFFLINE
      );

      Logger.error('Audio session: media server offline', {
        errorMessage: normalizedMSOError.message,
        errorCode: normalizedMSOError.code,
        sessionMetadata: session?._getFullLogMetadata() ?? {},
      });

      this._handleFatalFailure(
        session.id,
        session.connectionId,
        session.role,
        normalizedMSOError,
        'event'
      );
    });
  }

  _getPermission  (credentials = {}) {
    const {
      userId,
      meetingId,
      voiceBridge,
      role,
      sessionId,
    } = credentials;

    if (role === 'sendrecv') {
      return getMicrophonePermission(
        this._bbbGW,
        meetingId,
        voiceBridge,
        userId,
        credentials.callerIdNum,
        sessionId,
      );
    }

    return getGlobalAudioPermission(
      this._bbbGW,
      meetingId,
      voiceBridge,
      userId,
      sessionId,
    );
  }

  async handleStart (message) {
    const sessionId = AudioReqHdlr.getSessionId(message);
    const {
      connectionId,
      voiceBridge,
      meetingId,
      sdpOffer,
      userId,
      mediaServer = AUDIO_MEDIA_SERVER,
      role,
      extension,
    } = message;

    try {
      // Throws SFU_INVALID_REQUEST
      AudioReqHdlr.validateStartReq(message);
      const callerIdNum = AudioReqHdlr.genCallerIdNum(message);

      // Throws SFU_UNAUTHORIZED
      await this._getPermission({
        userId,
        meetingId,
        voiceBridge,
        role,
        callerIdNum,
        sessionId,
      });

      let session = this.getSession(sessionId);

      if (session) {
        await this._closeSession(session.id, AudioReqHdlr.getMetadataFromMessage(message));
      }

      session = new AudioSession(
        this._bbbGW,
        sessionId,
        meetingId,
        voiceBridge,
        userId,
        connectionId,
        callerIdNum,
        role,
        this.mcs,
        mediaServer,
        extension,
      );

      this.storeSession(sessionId, session);
      const sdpAnswer = await session.start(sdpOffer);
      // Empty ice queue after starting audio
      const iceQueue = this._fetchIceQueue(sessionId);
      this._flushIceQueue(session, iceQueue);
      this._trackFatalFailures(session);
      this.sendToClient({
        type: 'audio',
        connectionId,
        id: 'startResponse',
        response: 'accepted',
        sdpAnswer,
      }, C.FROM_AUDIO);

      Logger.info('Audio session started', AudioReqHdlr.getMetadataFromMessage(message));
    } catch (error) {
      Logger.error('Audio session: start failure', {
        errorMessage: error.message,
        errorCode: error.code,
        sessionMetadata: AudioReqHdlr.getMetadataFromMessage(message),
      });
      this._handleFatalFailure(sessionId, connectionId, role, error, message.id);
    }
  }

  _closeSession (sessionId, sessionMetadata = {}) {
    const session = this.getSession(sessionId);

    if (session) {
      return this._stopSession(sessionId)
        .then(() => {
          this._deleteIceQueue(sessionId);
          Logger.info('Audio session destroyed', sessionMetadata);
        })
        .catch((error) => {
          this._deleteIceQueue(sessionId);
          Logger.error('CRITICAL: Audio session destroy failure', {
            errorMessage: error.message,
            errorCode: error.code,
            sessionMetadata,
          });
        });
    }

    return Promise.resolve();
  }

  handleStop (message) {
    const sessionMetadata = AudioReqHdlr.getMetadataFromMessage(message);
    const sessionId = AudioReqHdlr.getSessionId(message);

    return this._closeSession(sessionId, sessionMetadata);
  }

  handleClose (message) {
    const sessionMetadata = AudioReqHdlr.getMetadataFromMessage(message);
    const sessionId = AudioReqHdlr.getSessionId(message);
    Logger.info('Connection closed', sessionMetadata)

    return this._closeSession(sessionId, sessionMetadata);
  }

  handleSubscriberAnswer (message) {
    const {
      sdpOffer: answer,
    } = message;

    const sessionId = AudioReqHdlr.getSessionId(message);
    const session = this.getSession(sessionId);

    if (session) {
      const sessionMetadata = AudioReqHdlr.getMetadataFromMessage(message);
      return session.processAnswer(answer).catch(error => {
        Logger.error( 'Audio session: remote description processing failed', {
          errorMessage: error.message,
          errorCode: error.code,
          sessionMetadata,
        });

        const normalizedError = this._handleError(
          this._logPrefix,
          session.connectionId,
          null,
          session.role,
          error,
        );
        PrometheusAgent.increment(SFUA_NAMES.ERRORS, {
          method: message.id, errorCode: normalizedError.code
        });
      });
    } else return Promise.resolve();
  }

  handleRestartIce (message) {
    const { connectionId } = message;
    const sessionId = AudioReqHdlr.getSessionId(message);
    const session = this.getSession(sessionId);

    if (session && ICE_RESTART) {
      const sessionMetadata = AudioReqHdlr.getMetadataFromMessage(message);
      return session.restartIce().then(offer => {
        this.sendToClient({
          type: 'audio',
          connectionId,
          id: 'iceRestarted',
          offer,
      }, C.FROM_AUDIO);

      }).catch(error => {
        Logger.error('Audio session: ICE restart failed', {
          errorMessage: error.message,
          errorCode: error.code,
          sessionMetadata,
        });

        const normalizedError = this._handleError(
          this._logPrefix,
          session.connectionId,
          null,
          session.role,
          error,
        );
        PrometheusAgent.increment(SFUA_NAMES.ERRORS, {
          method: message.id, errorCode: normalizedError.code
        });
      });
    } else return Promise.resolve();
  }

  handleIceCandidate (message) {
    const {
      candidate,
    } = message;
    const sessionId = AudioReqHdlr.getSessionId(message);
    const session = this.getSession(sessionId);

    if (session) {
      session.onIceCandidate(candidate);
    } else {
      const iceQueue = this._fetchIceQueue(sessionId);
      iceQueue.push(candidate);
    }
  }

  handleDtmf (message) {
    const {
      tones,
    } = message;
    const sessionId = AudioReqHdlr.getSessionId(message);
    const session = this.getSession(sessionId);

    if (session && typeof tones === 'string' && tones.length <= DTMF_DIGITS_CAP) {
      return session.dtmf(tones);
    } else {
      throw errors.SFU_INVALID_REQUEST;
    }
  }

  _handleUpstreamError (message = {}) {
    Logger.error('Received error event from upstream', AudioReqHdlr.getMetadataFromMessage(message));
  }

  _handleInvalidRequest (message = {}) {
    const { connectionId }  = message;
    const error = this._handleError(this._logPrefix, connectionId, null, null, errors.SFU_INVALID_REQUEST);

    Logger.debug('Invalid request', AudioReqHdlr.getMetadataFromMessage(message));
    this.sendToClient({
      type: 'audio',
      ...error,
    }, C.FROM_AUDIO);
    PrometheusAgent.increment(SFUA_NAMES.ERRORS, {
      method: message.id || 'event', errorCode: error.code
    });
  }

  async _onMessage(message) {
    let queue;

    PrometheusAgent.increment(SFUA_NAMES.REQS);

    try {
      AudioReqHdlr.explodeUserInfoHeader(message);
    } catch (error) {
      Logger.debug('Invalid user info header', { header: message.sfuUserHeader });
      this._handleInvalidRequest(message)
      return;
    }

    Logger.trace('Received message', message);
    const sessionId = AudioReqHdlr.getSessionId(message)

    try {
      switch (message.id) {
        case 'start':
          queue = this._fetchLifecycleQueue(sessionId);
          queue.push(() => { return this.handleStart(message) });
          break;

        case 'stop':
          queue = this._fetchLifecycleQueue(sessionId);
          queue.push(() => { return this.handleStop(message) });
          break;

        case 'subscriberAnswer':
          queue = this._fetchLifecycleQueue(sessionId);
          queue.push(() => { return this.handleSubscriberAnswer(message) });
          break;

        case 'iceCandidate':
          this.handleIceCandidate(message);
          break;

        case 'dtmf':
          queue = this._fetchLifecycleQueue(sessionId);
          queue.push(() => { return this.handleDtmf(message) });
          break;

        case 'restartIce':
          queue = this._fetchLifecycleQueue(sessionId);
          queue.push(() => { return this.handleRestartIce(message) });
          break;

        case 'close':
          queue = this._fetchLifecycleQueue(sessionId);
          queue.push(() => { return this.handleClose(message) });
          break;

        case 'error':
          this._handleUpstreamError(message);
          break;

        default:
          this._handleInvalidRequest(message);
          break;
      }
    } catch (error) {
      Logger.debug('Failed to process request', { error });
      this._handleInvalidRequest(message)
    }
  }
};
