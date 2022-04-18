/*
 * Lucas Fialho Zawacki
 * Paulo Renato Lanzarin
 * Mario Gasparoni Junior
 * (C) Copyright 2017-2021 Bigbluebutton
 *
 */

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

const AUDIO_MEDIA_SERVER = config.get('audioMediaServer');
const DTMF_DIGITS_CAP = '20';

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

  constructor (connectionChannel, additionalChannels, logPrefix) {
    super(connectionChannel, additionalChannels, logPrefix);
    this.sfuApp = C.AUDIO_APP;
    this._meetings = {};
    this._trackMeetingEvents();
    this.messageFactory(this._onMessage.bind(this));

    this._handleFatalFailure = this._handleFatalFailure.bind(this);
  }

  _trackMeetingEvents () {
    this._bbbGW.on(C.DISCONNECT_ALL_USERS_2x, (payload) => {
      const meetingId = payload[C.MEETING_ID_2x];
      this._disconnectAllUsers(meetingId);
    });
  }

  _stopConsumerBridge (meetingId) {
    const bridge = getConsumerBridge(meetingId);

    if (bridge == null) return;

    deleteConsumerBridge(meetingId);
    bridge.stop();
  }

  // FIXME enqueue stop
  _disconnectAllUsers (meetingId) {
    Logger.info('Disconnecting all audio sessions: meeting end', {
      meetingId
    });

    this._getAudioSessionsInMeeting(meetingId).forEach((session) => {
      const logMetadata = session?._getFullLogMetadata() ?? {};
      this._closeSession(session.id, session.connectionId, logMetadata);
    });

    this._stopConsumerBridge(meetingId);

    delete this._meetings[meetingId];
  }

  _handleFatalFailure (session, rawError) {
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

    this._closeSession(session.id, session.connectionId, logMetadata);
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

      this._handleFatalFailure(session, normalizedMSOError);
    });
  }

  _getAudioSessionsInMeeting (meetingId) {
    if (!meetingId || !this._sessions) return [];

    // FIXME inefficient
    return Object.values(this._sessions).filter((session) => session.meetingId === meetingId);
  }

  async handleStart (message) {
    const {
      connectionId,
      voiceBridge: sessionId,
      internalMeetingId,
      sdpOffer,
      userId,
      mediaServer = AUDIO_MEDIA_SERVER,
      role,
      caleeName,
      extension,
    } = message;

    let session = this._fetchSession(connectionId);

    if (session == null) {
      session = new AudioSession(
        this._bbbGW,
        internalMeetingId,
        sessionId,
        userId,
        connectionId,
        caleeName,
        role,
        this.mcs,
        mediaServer,
        extension,
      );
      this._sessions[connectionId] = session;
    }

    this._meetings[internalMeetingId] = sessionId;

    // starts audio session by sending sessionID, websocket and sdpoffer
    return session.start(sdpOffer).then(sdpAnswer => {
      // Empty ice queue after starting audio
      const iceQueue = this._fetchIceQueue(this._getReqIdentifier(sessionId, connectionId));
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
      this._handleFatalFailure(session, error);
    });
  }

  _getReqIdentifier (sessionId, connectionId) {
    return `${sessionId}:${connectionId}`;
  }

  _closeSession (sessionId, connectionId, metadata = {}) {
    const session = this._fetchSession(connectionId);

    if (session) {
      return this._stopSession(connectionId)
        .then(() => {
          this._deleteIceQueue(this._getReqIdentifier(sessionId, connectionId));
          Logger.info('Audio session destroyed',
            metadata);
        })
        .catch((error) => {
          this._deleteIceQueue(this._getReqIdentifier(sessionId, connectionId));
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
    const {
      voiceBridge: sessionId,
      connectionId,
    } = message;
    const logMetadata = AudioReqHdlr.getMetadataFromMessage(message);

    return this._closeSession(sessionId, connectionId, logMetadata);
  }

  handleClose (message) {
    const {
      voiceBridge: sessionId,
      connectionId,
    } = message;
    const logMetadata = AudioReqHdlr.getMetadataFromMessage(message);

    Logger.info('Connection closed', logMetadata)

    return this._closeSession(sessionId, connectionId, logMetadata);
  }

  handleSubscriberAnswer (message) {
    const {
      connectionId,
      sdpOffer: answer,
    } = message;

    const session = this._fetchSession(connectionId);

    if (session) {
      const metadata = AudioReqHdlr.getMetadataFromMessage(message);
      session.processAnswer(answer).catch(error => {
        Logger.error( 'Audio session: remote description processing failed', {
          errorMessage: error.message,
          errorCode: error.code,
          metadata,
        });
      });
    }
  }

  handleIceCandidate (message) {
    const {
      voiceBridge: sessionId,
      connectionId,
      candidate,
    } = message;

    const session = this._fetchSession(connectionId);
    const iceQueue = this._fetchIceQueue(this._getReqIdentifier(sessionId, connectionId));

    if (session) {
      session.onIceCandidate(candidate, connectionId);
    } else {
      iceQueue.push(candidate);
    }
  }

  handleDtmf (message) {
    const {
      connectionId,
      tones,
    } = message;

    const session = this._fetchSession(connectionId);

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
  }

  async _onMessage(message) {
    let queue;

    try {
      AudioReqHdlr.explodeUserInfoHeader(message);
    } catch (error) {
      Logger.debug('Invalid user info header', { header: message.sfuUserHeader });
      return this._handleInvalidRequest(message)
    }

    Logger.trace('Received message', {
      message,
    });

    switch (message.id) {
      case 'start':
        queue = this._fetchLifecycleQueue(this._getReqIdentifier(message.voiceBridge, message.connectionId));
        queue.push(() => { return this.handleStart(message) });
        break;

      case 'stop':
        queue = this._fetchLifecycleQueue(this._getReqIdentifier(message.voiceBridge, message.connectionId));
        queue.push(() => { return this.handleStop(message) });
        break;

      case 'subscriberAnswer':
        this.handleSubscriberAnswer(message);
        break;

      case 'iceCandidate':
        this.handleIceCandidate(message);
        break;

      case 'dtmf':
        this.handleDtmf(message);
        break;

      case 'close':
        queue = this._fetchLifecycleQueue(this._getReqIdentifier(message.voiceBridge, message.connectionId));
        queue.push(() => { return this.handleClose(message) });
        break;

      default:
        this._handleInvalidRequest(message);
        break;
    }
  }
};
