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
      case 'subscribe':
        Logger.info("Received SUBSCRIBE from external source", message);
        if (session == null) {
          return;
        }

        const retRtp = await session.mcs.subscribe(session.userId,
          session.sharedScreens[voiceBridge],
          C.RTP,
          {
            descriptor: sdpOffer,
            keyframeInterval:2
          });

        this._bbbGW.publish(JSON.stringify({
          id: 'subscribe',
          type: C.SCREENSHARE_APP,
          role: 'recv',
          response: 'accepted',
          meetingId: meetingId,
          voiceBridge: voiceBridge,
          sessionId: retRtp.sessionId,
          answer: retRtp.answer
        }), C.FROM_SCREENSHARE);
        break;

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
              session.onIceCandidate(candidate, role, callerName);
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
          session.onIceCandidate(message.candidate, role, callerName);
        } else {
          Logger.info(this._logPrefix, "Queueing ice candidate for later in screenshare", message.voiceBridge);
          iceQueue.push(message.candidate);
        }
        break;

      case 'close':
        Logger.info(this._logPrefix, 'Connection ' + connectionId + ' closed');

        if (session && session.constructor == Screenshare) {
          if (role === C.SEND_ROLE && session) {
            Logger.info(this._logPrefix, "Stopping presenter " + voiceBridge);
            this._stopSession(voiceBridge);
          }
          if (role === C.RECV_ROLE && session) {
            Logger.info(this._logPrefix, "Stopping viewer " + voiceBridge);
            session.stopViewer(message.connectionId);
          }
        }
        break;

      default:
        const errorMessage = this._handleError(this._logPrefix, connectionId, null, null, errors.SFU_INVALID_REQUEST);
        this._bbbGW.publish(JSON.stringify({
          ...errorMessage,
        }), C.FROM_SCREENSHARE);
        break;
    }
  }
};
