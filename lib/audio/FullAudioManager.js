/*
 * Lucas Fialho Zawacki
 * Paulo Renato Lanzarin
 * Mario Gasparoni Junior
 * (C) Copyright 2017-2021 Bigbluebutton
 *
 */

"use strict";

const BigBlueButtonGW = require('../bbb/pubsub/bbb-gw');
const Audio = require('./fullaudio');
const BaseManager = require('../base/BaseManager');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');
const errors = require('../base/errors');
const config = require('config');
const ERRORS = require('../base/errors.js');

const { handleExternalConnections : FS_HANDLE_EXTERNAL_CONNECTIONS }
  = config.get('freeswitch');
const EJECT_ON_USER_LEFT = config.get('ejectOnUserLeft');
const AUDIO_MEDIA_SERVER = config.get('fullAudioMediaServer');

module.exports = class AudioManager extends BaseManager {
  constructor (connectionChannel, additionalChannels, logPrefix) {
    super(connectionChannel, additionalChannels, logPrefix);
    this.sfuApp = C.AUDIO_APP;
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
    const { userId, callerName, voiceConf, listenOnly } = payload;
    try {
      if (FS_HANDLE_EXTERNAL_CONNECTIONS && !listenOnly && userId.startsWith("w_")) {
        await this.mcs.join(voiceConf, 'SFU', { userId, externalUserId: userId, name: callerName, autoLeave: true });
      }
    } catch (error) {
      Logger.warn(this._logPrefix, `Failed to pre-start audio user`,
        { userId, voiceConf, errorMessage: error.message, errorCode: error.code });
    }
  }

  // FIXME enqueue stop
  _disconnectAllUsers(meetingId) {
    const fullAudioSessions = this._getFullAudioSessionsInMeeting(meetingId);

    fullAudioSessions.forEach((fullAudioSession) => {
      this._stopSession(fullAudioSession.id);
    });

    Logger.info(this._logPrefix, 'Disconnecting all fullaudio sessions',
      { internalMeetingId: meetingId });

    delete this._meetings[meetingId];
  }

  _disconnectUser(meetingId, userId) {
    const sessionId = this._meetings[meetingId];
    const connectionId = session.getConnectionId(userId);

    const session = this._fetchSession(sessionId);
    if (session) {
      const connectionId = session.getConnectionId(userId);
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
          this._bbbGW.publish(JSON.stringify({
            connectionId,
            type: C.AUDIO_APP,
            id : 'close',
          }), C.FROM_AUDIO);
        });
      }
    }
  }

  _handleSessionWideError (error, sessionId, rawMessage) {
    Logger.error(this._logPrefix, `Full audio session wide fatal failure`, {
        errorMessage: error.message,
        errorCode: error.code,
        ...AudioManager.getMetadataFromMessage(rawMessage),
    });

    error.id = 'webRTCAudioError';
    this._stopSession(sessionId);
    this.sendToClient({
      type: 'audio',
      ...error,
    }, C.FROM_AUDIO);
  }

  _handleListenerStartError (session, userConnectionId, error, rawMessage) {
    Logger.error(this._logPrefix, `Listen only listener failure`, {
      errorMessage: error.message,
      errorCode: error.code,
      ...AudioManager.getMetadataFromMessage(rawMessage),
    });

    error.id = 'webRTCAudioError';
    if (session) session.stopListener(userConnectionId);
    this.sendToClient(({
      type: 'audio',
      ...error,
    }), C.FROM_AUDIO);
  }

  _getFullAudioSessionsInMeeting (meetingId) {
    if (!meetingId || !this._sessions) return [];

    return Object.values(this._sessions).filter((session) =>
      (session.role === "sendrecv") && (session.meetingId === meetingId)
    );
  }

  async handleStart (message) {
    const {
      connectionId,
      voiceBridge: sessionId,
      internalMeetingId,
      sdpOffer,
      userId,
      userName,
      mediaServer = AUDIO_MEDIA_SERVER,
      role,
      caleeName,
    } = message;

    let session = this._fetchSession(connectionId);
    const iceQueue = this._fetchIceQueue(this._getReqIdentifier(sessionId, connectionId));

    if ((session == null) || (role === 'sendrecv')) {
      session = new Audio(this._bbbGW, sessionId, this.mcs, internalMeetingId, mediaServer);
      this._sessions[connectionId] = session;
    }

    this._meetings[internalMeetingId] = sessionId;

    // starts audio session by sending sessionID, websocket and sdpoffer
    return session.start(sessionId, connectionId, sdpOffer, userId, userName,
      role, caleeName)
      .then(sdpAnswer => {
        // Empty ice queue after starting audio
        this._flushIceQueue(session, iceQueue);

        session.once(C.MEDIA_SERVER_OFFLINE, async (event) => {
          const errorMessage = this._handleError(this._logPrefix, connectionId, session.globalAudioBridge, C.RECV_ROLE, errors.MEDIA_SERVER_OFFLINE);
          return this._handleSessionWideError(errorMessage, sessionId, message);
        });

        this.sendToClient({
          type: 'audio',
          connectionId,
          id : 'startResponse',
          response : 'accepted',
          sdpAnswer : sdpAnswer
        }, C.FROM_AUDIO);

        Logger.info(this._logPrefix, `Started listen only session for user ${userId}`,
          AudioManager.getMetadataFromMessage(message));
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
    const session = this._fetchSession(connectionId);

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
    const logMetadata = AudioManager.getMetadataFromMessage(message);

    return this._closeListener(sessionId, connectionId, logMetadata);
  }

  handleClose (message) {
    const {
      voiceBridge: sessionId,
      connectionId,
    } = message;
    const logMetadata = AudioManager.getMetadataFromMessage(message);

    Logger.info(this._logPrefix, 'Connection closed', logMetadata)

    return this._closeListener(sessionId, connectionId, logMetadata);
  }

  handleSubscriberAnswer (message) {
    const {
      connectionId,
      sdpOffer: answer,
    } = message;

    const session = this._fetchSession(connectionId);

    if (session) {
      const metadata = AudioManager.getMetadataFromMessage(message);
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

    const session = this._fetchSession(connectionId);
    const iceQueue = this._fetchIceQueue(this._getReqIdentifier(sessionId, connectionId));

    if (session) {
      session.onIceCandidate(candidate, connectionId);
    } else {
      iceQueue.push(candidate);
    }
  }


  async _onMessage(message) {
    Logger.trace(this._logPrefix, `Received message from ${message.connectionId}: ${message.id}`);

    let queue;

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
        const { connectionId }  = message;
        const errorMessage = this._handleError(this._logPrefix, connectionId, null, null, errors.SFU_INVALID_REQUEST);
        this.sendToClient({
          type: 'audio',
          ...errorMessage,
        }, C.FROM_AUDIO);
        break;
    }
  }
};
