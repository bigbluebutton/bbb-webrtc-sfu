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

module.exports = class ScreenshareManager extends BaseManager {
  constructor (connectionChannel, additionalChannels, logPrefix) {
    super(connectionChannel, additionalChannels, logPrefix);
    this.sfuApp = C.SCREENSHARE_APP;
    this.messageFactory(this._onMessage);
    this._iceQueues = {};
    this.mcs.on(C.MCS_CONNECTED, () => {
      this.mcs.onEvent('roomCreated', 'all', this._handleRoomCreated.bind(this));
    });
  }

  async _onMessage(message) {
    Logger.debug(this._logPrefix, 'Received message [' + message.id + '] from connection', message.connectionId);

    const {
      voiceBridge,
      connectionId,
      role,
      sdpOffer,
      callerName
    } = message;

    let iceQueue, session;

    session = this._fetchSession(voiceBridge);
    iceQueue = this._fetchIceQueue(voiceBridge);

    switch (message.id) {
      case 'start':
        if (!session) {
          const { vh, vw, internalMeetingId} = message;
          session = new Screenshare(connectionId, this._bbbGW,
            voiceBridge, connectionId, vh, vw,
            internalMeetingId, this.mcs);
          this._sessions[voiceBridge] = session;
        }

        // starts screenshare peer with role by sending sessionID, websocket and sdpoffer
        try {
          const sdpAnswer = await session.start(voiceBridge, connectionId, sdpOffer, callerName, role)
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

          session.once(C.MEDIA_SERVER_OFFLINE, (event) => {
            this._stopSession(voiceBridge);
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
          let errorMessage = this._handleError(this._logPrefix, connectionId, callerName, role, error);
          this._bbbGW.publish(JSON.stringify({
            ...errorMessage
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
        await this._stopSession(roomId);
      }
    } catch (e) {
      Logger.error(LOG_PREFIX, this._handleError(this._logPrefix, null, null, null, e));
    }
  }

  async closeSession (session, connectionId, role, sessionId) {
    if (session && session.constructor == Screenshare) {
      if (role === C.SEND_ROLE && session) {
        Logger.info(this._logPrefix, "Stopping presenter " + sessionId);
        await this._stopSession(sessionId);
        return;
      }
      if (role === C.RECV_ROLE && session) {
        Logger.info(this._logPrefix, "Stopping viewer " + sessionId);
        await session.stopViewer(connectionId);
      }
    }
  }
};
