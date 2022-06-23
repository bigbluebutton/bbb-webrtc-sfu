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
} = require('./utils.js');

const AUDIO_MEDIA_SERVER = config.get('audioMediaServer');
const DTMF_DIGITS_CAP = '20';
const SESSID_STOK = '/';

module.exports = class AudioReqHdlr extends BaseManager {
  static getMetadataFromMessage (message = {}) {
    return {
      sfuMessageId: message.id,
      connectionId: message.connectionId,
      internalMeetingId: message.internalMeetingId,
      roomId: message.voiceBridge,
      userId: message.userId,
      role: message.role,
    };
  }

  static explodeUserInfoHeader (message) {
    if (typeof message === 'object' &&  typeof message.sfuUserHeader === 'object') {
      if (typeof message.sfuUserHeader.userId === 'string'
        && typeof message.sfuUserHeader.voiceBridge === 'string'
        && typeof message.sfuUserHeader.meetingId === 'string'
      ) {
        // TODO refactor internalMeetingId to be consistent with other modules
        message.internalMeetingId = message.sfuUserHeader.meetingId;
        message.meetingId = message.sfuUserHeader.meetingId;
        message.userId = message.sfuUserHeader.userId;
        message.voiceBridge = message.sfuUserHeader.voiceBridge;

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

  static isRoleValid (role) {
    return typeof role === 'string' && (role === 'sendrecv' || role === 'recvonly');
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

      const logMetadata = session?._getFullLogMetadata() ?? {};
      this._closeSession(session.id, logMetadata);
    });

    this._stopConsumerBridge(meetingId);
  }

  _handleFatalFailure (session, rawError, requesitionId = 'event') {
    const logMetadata = session?._getFullLogMetadata() ?? {};
    const error = this._handleError(
      this._logPrefix,
      session.connectionId,
      null,
      session.role,
      rawError,
    );

    this.sendToClient({
      type: 'audio',
      id: 'webRTCAudioError',
      ...error,
    }, C.FROM_AUDIO);

    Logger.error('Audio session: fatal failure', {
      errorMessage: error.message,
      errorCode: error.code,
      ...logMetadata
    });

    this._closeSession(session.id, logMetadata);

    PrometheusAgent.increment(SFUA_NAMES.ERRORS, {
      method: requesitionId, errorCode: error.code
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

      this._handleFatalFailure(session, normalizedMSOError, 'event');
    });
  }

  _getPermission (request) {
    const {
      userId, meetingId, voiceBridge, role,
    } = request;
    const sessionId = AudioReqHdlr.getSessionId(request);

    if (!AudioReqHdlr.isRoleValid(role)) {
      Logger.debug('Invalid role', {
        ...AudioReqHdlr.getMetadataFromMessage(request),
      });
      throw errors.SFU_INVALID_REQUEST;
    }

    if (role === 'sendrecv') {
      return getMicrophonePermission(
        this._bbbGW,
        meetingId,
        voiceBridge,
        userId,
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
    const {
      connectionId,
      voiceBridge,
      internalMeetingId,
      sdpOffer,
      userId,
      mediaServer = AUDIO_MEDIA_SERVER,
      role,
      caleeName,
      extension,
    } = message;
    const sessionId = AudioReqHdlr.getSessionId(message);
    let session = this.getSession(sessionId);

    if (session) {
      await this._closeSession(session.id, AudioReqHdlr.getMetadataFromMessage(message));
    }

    session = new AudioSession(
      this._bbbGW,
      sessionId,
      internalMeetingId,
      voiceBridge,
      userId,
      connectionId,
      caleeName,
      role,
      this.mcs,
      mediaServer,
      extension,
    );

    this.storeSession(sessionId, session);

    // starts audio session by sending sessionID, websocket and sdpoffer
    return session.start(sdpOffer).then(sdpAnswer => {
      // Empty ice queue after starting audio
      const iceQueue = this._fetchIceQueue(sessionId);
      this._flushIceQueue(session, iceQueue);
      this._trackFatalFailures(session);
      this.sendToClient({
        type: 'audio',
        connectionId,
        id : 'startResponse',
        response : 'accepted',
        sdpAnswer : sdpAnswer
      }, C.FROM_AUDIO);

      Logger.info('Audio session started',
        AudioReqHdlr.getMetadataFromMessage(message));
    }).catch(error => {
      this._handleFatalFailure(session, error, message.id);
    });
  }

  _closeSession (sessionId, metadata = {}) {
    const session = this.getSession(sessionId);

    if (session) {
      return this._stopSession(sessionId)
        .then(() => {
          this._deleteIceQueue(sessionId);
          Logger.info('Audio session destroyed',
            metadata);
        })
        .catch((error) => {
          this._deleteIceQueue(sessionId);
          Logger.error('CRITICAL: Audio session destroy failure', {
            errorMessage: error.message,
            errorCode: error.code,
            ...metadata,
          });
        });
    }

    return Promise.resolve();
  }

  handleStop (message) {
    const logMetadata = AudioReqHdlr.getMetadataFromMessage(message);
    const sessionId = AudioReqHdlr.getSessionId(message);

    return this._closeSession(sessionId, logMetadata);
  }

  handleClose (message) {
    const logMetadata = AudioReqHdlr.getMetadataFromMessage(message);
    const sessionId = AudioReqHdlr.getSessionId(message);
    Logger.info('Connection closed', logMetadata)

    return this._closeSession(sessionId, logMetadata);
  }

  handleSubscriberAnswer (message) {
    const {
      sdpOffer: answer,
    } = message;

    const sessionId = AudioReqHdlr.getSessionId(message);
    const session = this.getSession(sessionId);

    if (session) {
      const metadata = AudioReqHdlr.getMetadataFromMessage(message);
      return session.processAnswer(answer).catch(error => {
        Logger.error( 'Audio session: remote description processing failed', {
          errorMessage: error.message,
          errorCode: error.code,
          metadata,
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
      session.dtmf(tones);
    } else {
      this._handleInvalidRequest(message);
    }
  }

  _handleInvalidRequest (message = {}) {
    const { connectionId }  = message;
    const error = this._handleError(this._logPrefix, connectionId, null, null, errors.SFU_INVALID_REQUEST);
    Logger.debug('Invalid request', {
      ...AudioReqHdlr.getMetadataFromMessage(message),
      errorMessage: error.message,
    });

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

        case 'close':
          queue = this._fetchLifecycleQueue(sessionId);
          queue.push(() => { return this.handleClose(message) });
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
