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
    this.mcs.on(C.MCS_CONNECTED, () => {
      this.mcs.onEvent('roomCreated', 'all', this._handleRoomCreated.bind(this));
    });
  }

  static getMetadataFromMessage (message) {
    return {
      sfuMessageId: message.id,
      connectionId: message.connectionId,
      internalMeetingId: message.internalMeetingId,
      roomId: message.voiceBridge,
      userId: message.userId,
      role: message.role,
    };
  }

  handleStart (message) {
    const {
      internalMeetingId,
      voiceBridge,
      connectionId,
      role,
      sdpOffer,
      callerName,
      userName
    } = message;

    let iceQueue, session;

    session = this._fetchSession(voiceBridge);
    iceQueue = this._fetchIceQueue(voiceBridge);

    if (!session) {
      const { vh, vw } = message;
      session = new Screenshare(connectionId, this._bbbGW,
        voiceBridge, connectionId, vh, vw,
        internalMeetingId, this.mcs);
      this._sessions[voiceBridge] = session;
    }

    return session.start(voiceBridge, connectionId, sdpOffer, callerName, role, userName)
      .then(sdpAnswer => {
        Logger.debug(this._logPrefix, `Screensharing session started`,
          ScreenshareManager.getMetadataFromMessage(message));

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

          const queue = this._fetchLifecycleQueue(voiceBridge);
          queue.push(() => {
            return this.closeSession(session, role, voiceBridge, connectionId);
          });
        });

        // listen for presenter change to avoid inconsistent states on reconnection
        if (role === C.SEND_ROLE) {
          this._bbbGW.once(C.PRESENTER_ASSIGNED_2x+internalMeetingId, async (payload) => {
            Logger.info(this._logPrefix, `Presenter changed, forcibly closing screensharing session`,
              ScreenshareManager.getMetadataFromMessage(message));

            const queue = this._fetchLifecycleQueue(voiceBridge);
            queue.push(() => {
              return this.closeSession(session, role, voiceBridge, connectionId);
            });

            this._bbbGW.publish(JSON.stringify({
              connectionId: connectionId,
              type: C.SCREENSHARE_APP,
              id : 'close',
            }), C.FROM_SCREENSHARE);
          });
        }
      })
      .catch(error => {
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
      });
  }

  handleIceCandidate (message) {
    const {
      voiceBridge,
      candidate,
      role,
      callerName,
      connectionId,
    } = message;

    let iceQueue, session;

    session = this._fetchSession(voiceBridge);
    iceQueue = this._fetchIceQueue(voiceBridge);

    if (session && session.constructor === Screenshare) {
      session.onIceCandidate(candidate, role, callerName, connectionId);
      Logger.debug(this._logPrefix, `Screensharing ICE candidate added`,
        ScreenshareManager.getMetadataFromMessage(message));
    } else {
      Logger.info(this._logPrefix, `Screensharing ICE candidate queued`,
        ScreenshareManager.getMetadataFromMessage(message));
      iceQueue.push(candidate);
    }
  }

  handleStop (message) {
    const {
      voiceBridge,
    } = message;

    this._stopSession(voiceBridge).then(() => {
      this._deleteIceQueue(voiceBridge);
      Logger.info(this._logPrefix, `Screensharing session destroyed`,
        ScreenshareManager.getMetadataFromMessage(message));
    }).catch(error => {
      Logger.error(this._logPrefix, `Screensharing session stop failed`,
        {
          errorMessage: error.message,
          errorCode: error.code,
          ...ScreenshareManager.getMetadataFromMessage(message)
        });
    });
  }

  handleClose (message) {
    const {
      voiceBridge,
      candidate,
      role,
      connectionId,
    } = message;

    let session;

    session = this._fetchSession(voiceBridge);

    Logger.info(this._logPrefix, 'Connection closed',
      ScreenshareManager.getMetadataFromMessage(message));
    return this.closeSession(session, role, voiceBridge, connectionId);
  }

  _getLifecycleQueueId (message) {
    const { role, voiceBridge, connectionId = '' } = message;
    if (role === C.SEND_ROLE) {
      return `${voiceBridge}`;
    } else {
      return `${voiceBridge}:${connectionId}`;
    }
  }

  async _onMessage(message = {}) {
    Logger.debug(this._logPrefix, `Received message from ${message.connectionId}: ${message.id}`);
    let queue;

    switch (message.id) {
      case 'start':
        queue = this._fetchLifecycleQueue(this._getLifecycleQueueId(message));
        queue.push(() => { return this.handleStart(message) });
        break;

      case 'stop':
        queue = this._fetchLifecycleQueue(this._getLifecycleQueueId(message));
        queue.push(() => { return this.handleStop(message) });
        break;

      case 'iceCandidate':
        this.handleIceCandidate(message);
        break;

      case 'close':
        queue = this._fetchLifecycleQueue(this._getLifecycleQueueId(message));
        queue.push(() => { return this.handleClose(message) });
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
      try {
        Logger.info(this._logPrefix, `Room destroyed, stopping screensharing`, { roomId: room });
        const session = this._fetchSession(room);
        const queue = this._fetchLifecycleQueue(room);
        queue.push(() => {
          return this.closeSession(session, C.SEND_ROLE, room);
        });
      } catch (error) {
        Logger.error(this._logPrefix, `Screensharing session stop failed at room destroyed handler`,
          { error: this._handleError(this._logPrefix, null, null, null, error), roomId: room });
      }
    });
    this.mcs.onEvent('contentFloorChanged', room, this._handleContentFloorChanged.bind(this));
  }

  async _handleContentFloorChanged (event) {
    const { roomId, floor, previousFloor } = event;

    try {
      if (floor == null) {
        // Content floor was released, forcibly stop the session if it wasn't yet
        Logger.info(this._logPrefix, `Content floor released, stopping screensharing`, { roomId });
        const session = this._fetchSession(roomId);
        const queue = this._fetchLifecycleQueue(roomId);
        queue.push(() => {
          return this.closeSession(session, C.SEND_ROLE, roomId);
        });
      }
    } catch (error) {
      Logger.error(this._logPrefix, `Screensharing session stop failed at content floor changed handler`,
        { error: this._handleError(this._logPrefix, null, null, null, error), roomId: room });
    }
  }

  closeSession (session, role, sessionId, connectionId = '') {
    if (session && session.constructor == Screenshare) {
      if (role === C.SEND_ROLE) {
        if (session) {
          Logger.info(this._logPrefix, `Stopping screensharing presenter session ${sessionId}`,
            session._getPartialLogMetadata());
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
        Logger.info(this._logPrefix, `Stopping screensharing viewer with connectionId ${connectionId}`,
          session._getFullViewerLogMetadata(connectionId));
        return session.stopViewer(connectionId);
      }
    }

    return Promise.resolve();
  }
}
