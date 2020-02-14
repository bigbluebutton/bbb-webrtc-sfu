/*
 * Lucas Fialho Zawacki
 * Paulo Renato Lanzarin
 * (C) Copyright 2017 Bigbluebutton
 *
 */

"use strict";

const BigBlueButtonGW = require('../bbb/pubsub/bbb-gw');
const Audio = require('./audio');
const BaseManager = require('../base/BaseManager');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');
const errors = require('../base/errors');

module.exports = class AudioManager extends BaseManager {
  constructor (connectionChannel, additionalChannels, logPrefix) {
    super(connectionChannel, additionalChannels, logPrefix);
    this.sfuApp = C.AUDIO_APP;
    this._meetings = {};
    this._trackMeetingEvents();
    this.messageFactory(this._onMessage);
    this._iceQueues = {};
  }

  _trackMeetingEvents () {
    switch (C.COMMON_MESSAGE_VERSION) {
      case "1.x":
        this._bbbGW.on(C.DISCONNECT_ALL_USERS, (payload) => {
          let meetingId = payload[C.MEETING_ID];
          this._disconnectAllUsers(meetingId);
        });
        this._bbbGW.on(C.DISCONNECT_USER, (payload) => {
          let meetingId = payload[C.MEETING_ID];
          let userId = payload[C.USERID];
          this._disconnectUser(meetingId, userId);
        });
        break;
      default:
        this._bbbGW.on(C.DISCONNECT_ALL_USERS_2x, (payload) => {
          let meetingId = payload[C.MEETING_ID_2x];
          this._disconnectAllUsers(meetingId);
        });
    }
  }

  _disconnectAllUsers(meetingId) {
    let sessionId = this._meetings[meetingId];
    if (typeof sessionId !== 'undefined') {
      Logger.debug(this._logPrefix, 'Disconnecting all users from', sessionId);
      delete this._meetings[meetingId];
      this._stopSession(sessionId);
    }
  }

  _disconnectUser(meetingId, userId) {
    let sessionId = this._meetings[meetingId];
    if (typeof sessionId !== 'undefined') {
      let session = this._sessions[sessionId];
      if (typeof session !== 'undefined') {
        let connectionId = session.getConnectionId(userId);
        if (connectionId) session.stopListener(connectionId);
      }
    }
  }

  async _onMessage(message) {
    Logger.debug(this._logPrefix, 'Received message [' + message.id + '] from connection', message.connectionId);
    const { connectionId, voiceBridge, internalMeetingId }  = message;
    const sessionId = voiceBridge;

    let session = this._fetchSession(sessionId);
    let iceQueue = this._fetchIceQueue(sessionId+connectionId);

    switch (message.id) {
      case 'start':
      const handleStartError = (errorMessage) => {
          errorMessage.id = 'webRTCAudioError';
          this._stopSession(sessionId);
          this._bbbGW.publish(JSON.stringify({
            ...errorMessage,
          }), C.FROM_AUDIO);
        }

        Logger.debug(this._logPrefix, 'Received start message', message, 'from connection', connectionId);

        if (session == null) {
          session = new Audio(this._bbbGW, voiceBridge, this.mcs);
          session.once(C.MEDIA_STOPPED, this._stopSession.bind(this));
          this._sessions[sessionId] = {}
          this._sessions[sessionId] = session;
          try {
            await session.upstartSourceAudio(message.sdpOffer, message.caleeName);
          } catch (error) {
            const errorMessage = this._handleError(this._logPrefix, connectionId, message.calleeName, C.RECV_ROLE, error);
            return handleStartError(errorMessage);
          }
        }

        this._meetings[message.internalMeetingId] = sessionId;

        // starts audio session by sending sessionID, websocket and sdpoffer
        session.start(sessionId, connectionId, message.sdpOffer, message.caleeName, message.userId, message.userName, (error, sdpAnswer) => {
          if (error) {
            const errorMessage = this._handleError(this._logPrefix, connectionId, null, C.RECV_ROLE, error);
            return handleStartError(errorMessage);
          }

          Logger.info(this._logPrefix, "Started presenter ", sessionId, " for connection", connectionId);
          Logger.debug(this._logPrefix, "SDP answer was", sdpAnswer);

          // Empty ice queue after starting audio
          this._flushIceQueue(session, iceQueue);

          session.once(C.MEDIA_SERVER_OFFLINE, async (event) => {
            const errorMessage = this._handleError(this._logPrefix, connectionId, message.caleeName, C.RECV_ROLE, errors.MEDIA_SERVER_OFFLINE);
            return handleStartError(errorMessage);
          });

          this._bbbGW.publish(JSON.stringify({
            connectionId: connectionId,
            id : 'startResponse',
            type: 'audio',
            response : 'accepted',
            sdpAnswer : sdpAnswer
          }), C.FROM_AUDIO);

          Logger.info(this._logPrefix, "Sending startResponse to user", sessionId, "for connection", session._id);
        });
        break;

      case 'stop':
        Logger.info(this._logPrefix, 'Received stop message for session', sessionId, "at connection", connectionId);

        if (session) {
          session.stopListener(connectionId);
        } else {
          Logger.warn(this._logPrefix, "There was no audio session on stop for", sessionId);
        }
        break;

      case 'iceCandidate':
        if (session) {
          session.onIceCandidate(message.candidate, connectionId);
        } else {
          Logger.info(this._logPrefix, "Queueing ice candidate for later in audio", connectionId);
          iceQueue.push(message.candidate);
        }
        break;

      case 'close':
        Logger.info(this._logPrefix, 'Connection ' + connectionId + ' closed');
        this._deleteIceQueue(sessionId+connectionId);
        if (typeof session !== 'undefined') {
          Logger.info(this._logPrefix, "Stopping viewer " + sessionId);
          session.stopListener(message.connectionId);
        }
        break;

      default:
        const errorMessage = this._handleError(this._logPrefix, connectionId, null, null, errors.SFU_INVALID_REQUEST);
        this._bbbGW.publish(JSON.stringify({
          ...errorMessage,
        }), C.FROM_AUDIO);
        break;
    }
  }
};
