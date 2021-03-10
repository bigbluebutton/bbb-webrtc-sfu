/*
 * Lucas Fialho Zawacki
 * Paulo Renato Lanzarin
 * (C) Copyright 2017 Bigbluebutton
 *
 */

"use strict";

const BigBlueButtonGW = require('../bbb/pubsub/bbb-gw');
const Screenshare = require('./screenshare');
const BaseManager = require('../base/BaseManager');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');
const errors = require('../base/errors');
const config = require('config');

const EJECT_ON_USER_LEFT = config.get('ejectOnUserLeft');

module.exports = class ScreenshareManager extends BaseManager {
  constructor (connectionChannel, additionalChannels, logPrefix) {
    super(connectionChannel, additionalChannels, logPrefix);
    this.sfuApp = C.SCREENSHARE_APP;
    this.messageFactory(this._onMessage);
    this._iceQueues = {};
    this._meetingSessionMap = {};

    this._trackMeetingEvents();
    this.mcs.on(C.MCS_CONNECTED, () => {
      this.mcs.onEvent('roomCreated', 'all', this._handleRoomCreated.bind(this));
    });
  }

  _trackMeetingEvents () {
    this._bbbGW.on(C.DISCONNECT_ALL_USERS_2x, (payload) => {
      let meetingId = payload[C.MEETING_ID_2x];
      this.disconnectAllUsers(meetingId);
    });

    if (EJECT_ON_USER_LEFT) {
      this._bbbGW.on(C.USER_LEFT_MEETING_2x, (payload) => {
        let meetingId = payload[C.MEETING_ID_2x];
        let userId = payload[C.USER_ID_2x];
        this.disconnectUser(meetingId, userId);
      });
    }
  }

  async _onMessage(message) {
    Logger.debug(this._logPrefix, 'Received message [' + message.id + '] from connection', message.connectionId);

    const {
      voiceBridge,
      connectionId,
      role,
      sdpOffer,
      callerName,
      userName,
      hasAudio,
    } = message;

    let iceQueue, session;

    session = this._fetchSession(voiceBridge);
    iceQueue = this._fetchIceQueue(voiceBridge);

    switch (message.id) {
      case 'start':
        if (!session) {
          const { vh = 0, vw = 0, internalMeetingId } = message;
          session = new Screenshare(connectionId, this._bbbGW,
            voiceBridge, connectionId, vh, vw,
            internalMeetingId, this.mcs, hasAudio);
          this._sessions[voiceBridge] = session;
          this._meetingSessionMap[internalMeetingId] = voiceBridge;
        }

        // starts screenshare peer with role by sending sessionID, websocket and sdpoffer
        try {
          const sdpAnswer = await session.start(voiceBridge, connectionId, sdpOffer, callerName, role, userName)
          Logger.debug(this._logPrefix, "Started peer", voiceBridge, " for connection", connectionId, "with SDP answer", sdpAnswer);

          // Empty ice queue after starting session
          if (iceQueue) {
            let candidate;
            while(candidate = iceQueue.pop()) {
              session.onIceCandidate(candidate, role, callerName, connectionId);
            }
          }

          this._bbbGW.publish(JSON.stringify({
            connectionId: connectionId,
            type: C.SCREENSHARE_APP,
            role: role,
            id : 'startResponse',
            response : 'accepted',
            sdpAnswer : sdpAnswer
          }), C.FROM_SCREENSHARE);

          session.once(C.MEDIA_SERVER_OFFLINE, async (event) => {
            // Media server died. Force-close this thing and notify the client
            let errorMessage = this._handleError(this._logPrefix, connectionId, callerName, role, errors.MEDIA_SERVER_OFFLINE);
            this._bbbGW.publish(JSON.stringify({
              ...errorMessage
            }), C.FROM_SCREENSHARE);
            await this.closeSession(session, connectionId, role, voiceBridge);
          });

          // listen for presenter change to avoid inconsistent states on reconnection
          if (role === C.SEND_ROLE) {
            this._bbbGW.once(C.PRESENTER_ASSIGNED_2x+message.internalMeetingId, async (payload) => {
              Logger.info(this._logPrefix, "Presenter changed, forcibly closing screensharing session at", message.internalMeetingId);
              await this.closeSession(session, connectionId, role, voiceBridge);
              this._bbbGW.publish(JSON.stringify({
                connectionId: connectionId,
                type: C.SCREENSHARE_APP,
                id : 'close',
              }), C.FROM_SCREENSHARE);
            });
          }

          Logger.info(this._logPrefix, "Sending startResponse to peer", voiceBridge, "for connection", session._id);
        }
        catch (error) {
          // Start error. Send an error message and then send a socket close
          // message. The error one will notify the client, the close one will
          // forcefully close this sad piece of screensharing attempt and clean things
          // up no matter what.
          const errorMessage = this._handleError(this._logPrefix, connectionId, callerName, role, error);
          const closeMessage = this._handleError(this._logPrefix, connectionId, callerName, role, error);
          closeMessage.id = 'close';
          this._bbbGW.publish(JSON.stringify({
            ...errorMessage
          }), C.FROM_SCREENSHARE);
          this._bbbGW.publish(JSON.stringify({
            ...closeMessage
          }), C.FROM_SCREENSHARE);
        }
        break;

      case 'stop':
        Logger.info(this._logPrefix, 'Received stop message for session', voiceBridge, "at connection", connectionId);

        if (session) {
          session._stop(voiceBridge);
        } else {
          Logger.warn(this._logPrefix, "There was no screensharing session on stop for", voiceBridge);
        }
        break;

      case 'iceCandidate':
        if (session && session.constructor === Screenshare) {
          session.onIceCandidate(message.candidate, role, callerName, connectionId);
        } else {
          Logger.info(this._logPrefix, "Queueing ice candidate for later in screenshare", message.voiceBridge);
          iceQueue.push(message.candidate);
        }
        break;

      case 'close':
        Logger.info(this._logPrefix, 'Connection ' + connectionId + ' closed');
        this.closeSession(session, connectionId, role, voiceBridge);
        break;

      default:
        const errorMessage = this._handleError(this._logPrefix, connectionId, null, null, errors.SFU_INVALID_REQUEST);
        this._bbbGW.publish(JSON.stringify({
          ...errorMessage,
        }), C.FROM_SCREENSHARE);
        break;
    }
  }

  _handleRoomCreated (event) {
    const { room } = event;
    this.mcs.onEvent('roomDestroyed', room, (event) => {
      Logger.debug(this._logPrefix, "Room", room, "destroyed");
      try {
        this._stopSession(room);
      } catch (e) {
        Logger.error(LOG_PREFIX, this._handleError(this._logPrefix, null, null, null, e));
      }
    });
    this.mcs.onEvent('contentFloorChanged', room, this._handleContentFloorChanged.bind(this));
  }

  async _handleContentFloorChanged (event) {
    const { roomId, floor, previousFloor } = event;

    Logger.debug(this._logPrefix, "Content floor changed", { roomId }, { floor });

    try {
      if (floor == null) {
        // Content floor was released, forcibly stop the session if it wasn't yet
        await this.closeSession(this._fetchSession(roomId), null, C.SEND_ROLE, roomId);
      }
    } catch (e) {
      Logger.error("[ScreenshareManager]", this._handleError(this._logPrefix, null, null, null, e));
    }
  }

  closeSession (session, connectionId, role, sessionId) {
    if (session && session.constructor == Screenshare) {
      if (role === C.SEND_ROLE) {
        if (session) {
          Logger.info(this._logPrefix, `Stopping screensharing presenter session ${sessionId}`);
          return this._stopSession(sessionId).then(() => {
            this._deleteIceQueue(sessionId);
          });
        }
        // Delete ice queue for main session async despite having a session or not
        // to avoid piling up ICE candidates from outdated sessions. This can happen
        // because this thing is a mess.
        this._deleteIceQueue(sessionId);
        return Promise.resolve();
      }

      if (role === C.RECV_ROLE && session) {
        Logger.info(this._logPrefix, `Stopping screensharing viewer at ${sessionId} with connectionId ${connectionId}`);
        return session.stopViewer(connectionId);
      }

      return Promise.resolve();
    }

    Logger.warn(this._logPrefix, `No screensharing session found for ${sessionId} with connectionId ${connectionId} and role ${role}`);
    return Promise.resolve();
  }

  disconnectAllUsers(meetingId) {
    const voiceBridge = this._meetingSessionMap[meetingId];
    if (typeof voiceBridge !== 'undefined') {
      const session = this._fetchSession(voiceBridge);
      if (session) {
        Logger.info(this._logPrefix, 'Disconnecting all screenshare sessions, meeting end', {
          meetingId,
          voiceBridge,
        });
        this._stopSession(voiceBridge);
      }
      delete this._meetingSessionMap[meetingId]
    }
  }

  disconnectUser(meetingId, userId) {
    const voiceBridge = this._meetingSessionMap[meetingId]
    if (typeof voiceBridge !== 'undefined') {
      const session = this._sessions[voiceBridge];
      if (typeof session !== 'undefined') {
        const found = session.getConnectionIdAndRole(userId);
        if (found && found.connectionId && found.role) {
          Logger.info(this._logPrefix, 'Disconnect a screen share on UserLeft*', {
            meetingId,
            userId,
            voiceBridge,
            connectionId: found.connectionId,
            role: found.role,
          });

          this.closeSession(session, found.connectionId, found.role, voiceBridge);
          this._bbbGW.publish(JSON.stringify({
            connectionId: found.connectionId,
            type: C.SCREENSHARE_APP,
            id : 'close',
          }), C.FROM_SCREENSHARE);
        }
      }
    }
  }
}
