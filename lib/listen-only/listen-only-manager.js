/*
 * Lucas Fialho Zawacki
 * Paulo Renato Lanzarin
 * (C) Copyright 2017 Bigbluebutton
 *
 */

"use strict";

const ListenOnly = require('./listen-only.js');
const BaseManager = require('../base/BaseManager');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');
const errors = require('../base/errors');
const config = require('config');
const ERRORS = require('../base/errors.js');

const { handleExternalConnections : FS_HANDLE_EXTERNAL_CONNECTIONS } = config.get('freeswitch');
const EJECT_ON_USER_LEFT = config.get('ejectOnUserLeft');
const LISTENONLY_MEDIA_SERVER = config.get('listenOnlyMediaServer');
const WS_STRICT_HEADER_PARSING = config.get('wsStrictHeaderParsing');

module.exports = class ListenOnlyManager extends BaseManager {
  constructor (connectionChannel, additionalChannels, logPrefix) {
    super(connectionChannel, additionalChannels, logPrefix);
    this.sfuApp = C.LISTEN_ONLY_APP;
    this._meetings = {};
    this._trackMeetingEvents();
    this.messageFactory(this._onMessage.bind(this));
  }

  static getMetadataFromMessage (message = {}) {
    return {
      sfuMessageId: message.id,
      connectionId: message.connectionId,
      internalMeetingId: message.internalMeetingId,
      roomId: message.voiceBridge,
      userId: message.userId,
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

  _trackMeetingEvents () {
    this._bbbGW.on(C.DISCONNECT_ALL_USERS_2x, (payload) => {
      const meetingId = payload[C.MEETING_ID_2x];
      this._disconnectAllUsers(meetingId);
    });
    this._bbbGW.on(C.USER_JOINED_VOICE_CONF_MESSAGE_2x, this._handleUserJoinedVoiceConf.bind(this));
    if (EJECT_ON_USER_LEFT) {
      this._bbbGW.on(C.USER_LEFT_MEETING_2x, (payload) => {
        let meetingId = payload[C.MEETING_ID_2x];
        let userId = payload[C.USER_ID_2x];
        this._disconnectUser(meetingId, userId);
      });
    }
  }

  async _handleUserJoinedVoiceConf (payload) {
    const { userId, voiceConf, listenOnly } = payload;
    try {
      if (FS_HANDLE_EXTERNAL_CONNECTIONS && !listenOnly && userId.startsWith("w_")) {
        await this.mcs.join(voiceConf, 'SFU', { userId, externalUserId: userId, autoLeave: true });
      }
    } catch (error) {
      Logger.warn(this._logPrefix, `Failed to pre-start audio user`,
        { userId, voiceConf, errorMessage: error.message, errorCode: error.code });
    }
  }

  // FIXME enqueue stop
  _disconnectAllUsers(meetingId) {
    const sessionId = this._meetings[meetingId];
    if (typeof sessionId !== 'undefined') {
      const session = this._fetchSession(sessionId);
      if (session) {
        Logger.info(this._logPrefix, 'Disconnecting all listen only sessions',
          { roomId: sessionId, internalMeetingId: meetingId });
        this._stopSession(sessionId);
      }
      delete this._meetings[meetingId];
    }
  }

  _disconnectUser(meetingId, userId) {
    const sessionId = this._meetings[meetingId];
    const session = this._fetchSession(sessionId);
    if (session) {
      const connectionIds = session.getConnectionIdsFromUser(userId) || [];
      connectionIds.forEach(connectionId => {
        if (connectionId) {
          Logger.info(this._logPrefix, 'Disconnect listen only session on UserLeft*', {
            meetingId,
            userId,
            sessionId,
            connectionId,
          });
          return this._closeListener(sessionId, connectionId, {
            userId, meetingId, roomId: sessionId, connectionId,
          }).finally(() => {
            this.sendToClient({
              connectionId,
              type: C.LISTEN_ONLY_APP,
              id : 'close',
            }, C.FROM_LISTEN_ONLY);
          });
        }
      });
    }
  }

  _handleSessionWideError (error, sessionId, rawMessage) {
    Logger.error(this._logPrefix, `Listen only session wide fatal failure`, {
        errorMessage: error.message,
        errorCode: error.code,
        ...ListenOnlyManager.getMetadataFromMessage(rawMessage),
    });

    error.id = 'webRTCAudioError';
    this._stopSession(sessionId);
    this.sendToClient({
      type: 'audio',
      ...error,
    }, C.FROM_LISTEN_ONLY);
  }

  _handleListenerStartError (session, userConnectionId, error, rawMessage) {
    Logger.error(this._logPrefix, `Listen only listener failure`, {
      errorMessage: error.message,
      errorCode: error.code,
      ...ListenOnlyManager.getMetadataFromMessage(rawMessage),
    });

    error.id = 'webRTCAudioError';
    if (session) session.stopListener(userConnectionId);
    this.sendToClient(({
      type: 'audio',
      ...error,
    }), C.FROM_LISTEN_ONLY);
  }

  async handleStart (message) {
    const {
      connectionId,
      voiceBridge: sessionId,
      internalMeetingId,
      sdpOffer,
      userId,
      mediaServer = LISTENONLY_MEDIA_SERVER,
    } = message;

    let session = this._fetchSession(sessionId);
    const iceQueue = this._fetchIceQueue(this._getReqIdentifier(sessionId, connectionId));

    if (session == null) {
      session = new ListenOnly(this._bbbGW, sessionId, this.mcs, internalMeetingId, mediaServer);
      this._sessions[sessionId] = {}
      this._sessions[sessionId] = session;
    }

    this._meetings[internalMeetingId] = sessionId;

    // starts audio session by sending sessionID, websocket and sdpoffer
    return session.start(sessionId, connectionId, sdpOffer, userId)
      .then(sdpAnswer => {
        // Empty ice queue after starting audio
        this._flushIceQueue(session, iceQueue);

        session.once(C.MEDIA_SERVER_OFFLINE, async () => {
          const errorMessage = this._handleError(this._logPrefix, connectionId, session.globalAudioBridge, C.RECV_ROLE, errors.MEDIA_SERVER_OFFLINE);
          return this._handleSessionWideError(errorMessage, sessionId, message);
        });

        this.sendToClient({
          type: 'audio',
          connectionId,
          id : 'startResponse',
          response : 'accepted',
          sdpAnswer : sdpAnswer
        }, C.FROM_LISTEN_ONLY);

        Logger.info(this._logPrefix, `Started listen only session for user ${userId}`,
          ListenOnlyManager.getMetadataFromMessage(message));
      })
      .catch(error => {
        const normalizedError = this._handleError(this._logPrefix, connectionId, null, C.RECV_ROLE, error);
        // Global audio bridge startup error; notify the listener and roll back session creation
        if (error.code=== ERRORS.SFU_GLOBAL_AUDIO_FAILED.code) {
          this._handleSessionWideError(normalizedError, sessionId, message);
        } else {
          // Listener-bound errors; rollback is done internally, just notify the user
          this._handleListenerStartError(session, connectionId, normalizedError, message);
        }
      });
  }

  _getReqIdentifier (sessionId, connectionId) {
    return `${sessionId}:${connectionId}`;
  }

  _closeListener (sessionId, connectionId, metadata = {}) {
    const session = this._fetchSession(sessionId);

    if (session) {
      return session.stopListener(connectionId)
        .then(() => {
          this._deleteIceQueue(this._getReqIdentifier(sessionId, connectionId));
          Logger.info(this._logPrefix, 'Listen only listener destroyed',
            metadata);
        })
        .catch((error) => {
          this._deleteIceQueue(this._getReqIdentifier(sessionId, connectionId));
          Logger.error(this._logPrefix, 'Listen only listener stop failed', {
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
    const logMetadata = ListenOnlyManager.getMetadataFromMessage(message);

    return this._closeListener(sessionId, connectionId, logMetadata);
  }

  handleClose (message) {
    const {
      voiceBridge: sessionId,
      connectionId,
    } = message;
    const logMetadata = ListenOnlyManager.getMetadataFromMessage(message);

    Logger.info(this._logPrefix, 'Connection closed', logMetadata)

    return this._closeListener(sessionId, connectionId, logMetadata);
  }

  handleSubscriberAnswer (message) {
    const {
      voiceBridge: sessionId,
      connectionId,
      sdpOffer: answer,
    } = message;

    const session = this._fetchSession(sessionId);

    if (session) {
      const metadata = ListenOnlyManager.getMetadataFromMessage(message);
      session.processAnswer(answer, connectionId).then(() => {
        Logger.debug(this._logPrefix, 'Listen only remote description processed',
          metadata
        );
      }).catch(error => {
        Logger.error(this._logPrefix,  'Remote description processing failed', {
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

    const session = this._fetchSession(sessionId);
    const iceQueue = this._fetchIceQueue(this._getReqIdentifier(sessionId, connectionId));

    if (session) {
      session.onIceCandidate(candidate, connectionId);
    } else {
      iceQueue.push(candidate);
    }
  }

  _handleInvalidRequest (message) {
    const { connectionId }  = message;
    const errorMessage = this._handleError(this._logPrefix, connectionId, null, null, errors.SFU_INVALID_REQUEST);
    this.sendToClient({
      type: 'audio',
      ...errorMessage,
    }, C.FROM_LISTEN_ONLY);
  }

  async _onMessage(message) {
    Logger.trace(this._logPrefix, `Received message from ${message.connectionId}: ${message.id}`);

    let queue;

    try {
      ListenOnlyManager.explodeUserInfoHeader(message);
    } catch (error) {
      if (WS_STRICT_HEADER_PARSING) {
        Logger.debug(this._logPrefix, 'Invalid user info header', { header: message.sfuUserHeader });
        return this._handleInvalidRequest(message)
      }
    }

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
