/*
 * Lucas Fialho Zawacki
 * Paulo Renato Lanzarin
 * (C) Copyright 2017 Bigbluebutton
 *
 */

"use strict";

const BigBlueButtonGW = require('../bbb/pubsub/bbb-gw');
const Stream = require('./stream');
const BaseManager = require('../base/BaseManager');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');
const errors = require('../base/errors');

const Messaging = require('../bbb/messages/Messaging');

module.exports = class StreamManager extends BaseManager {
  constructor (connectionChannel, additionalChannels, logPrefix) {
    super(connectionChannel, additionalChannels, logPrefix);
    this.sfuApp = C.STREAM_APP;
    this._meetings = {};
    this._trackMeetingTermination();
    this.messageFactory(this._onMessage);
  }

  _trackMeetingTermination () {
    switch (C.COMMON_MESSAGE_VERSION) {
      case "1.x":
        this._bbbGW.on(C.DICONNECT_ALL_USERS, (payload) => {
          let meetingId = payload[C.MEETING_ID];


        });
        break;
      default:
        this._bbbGW.on(C.DICONNECT_ALL_USERS_2x, (payload) => {
          let meetingId = payload[C.MEETING_ID_2x];

        });
    }
  }

  _onMessage(message) {
    let session, meetingId, userId, name, streamUrl, confname;

    if (message.core && message.core.header) {
      meetingId = message.core.header.meetingId;
      userId = message.core.header.userId;
      name = message.core.header.name;
    }

    if (message.core && message.core.body) {
      streamUrl = message.core.body.streamUrl;
      confname = message.core.body.confname;
    }

    session = this._sessions[meetingId];

    Logger.debug(this._logPrefix, 'Received message [' + name + '] from connection', meetingId);
    switch (name) {
      case 'StartStream':

        if (!session) {
          session = new Stream(this._bbbGW, meetingId, confname, streamUrl);
        }

        this._meetings[meetingId] = meetingId;
        this._sessions[meetingId] = session;

        session.start((error) => {
          Logger.info(this._logPrefix, "Started stream ", meetingId);

          if (error) {
            const errorMessage = this._handleError(this._logPrefix, meetingId, error);
            return this._bbbGW.publish(JSON.stringify({
              ...errorMessage
            }), C.FROM_STREAM);
          }

          session.onStart(() => {
            Logger.info(this._logPrefix, 'Stream is starting for', meetingId); 
            this._bbbGW.publish(
	      Messaging.generateStreamEventMessage(meetingId, C.STREAM_STARTED)
	    , C.TO_HTML5);
	  });

	  session.onStop((reason) => {
            Logger.info(this._logPrefix, 'Stream is stopping for', meetingId);
            Logger.info(Messaging.generateStreamEventMessage(meetingId, C.STREAM_STOPPED));
	    Logger.info(C.STREAM_STOPPED);
	    Logger.info(C.TO_HTML5);
	    this._bbbGW.publish(
	      Messaging.generateStreamEventMessage(meetingId, C.STREAM_STOPPED)
	    , C.TO_HTML5);

	    delete this._sessions[meetingId];
            delete this._meetings[meetingId];

	  });
          Logger.info(this._logPrefix, "Sending startResponse to meeting ", meetingId, "for connection", session._id);
        });
        break;

      case 'StopStream':
        Logger.info(this._logPrefix, 'Received stop mey10yssage for session', meetingId);

	try {
          if (session) {

            session.stop();

	  } else {
            Logger.warn(this._logPrefix, "There was no stream session on stop for", meetingId);
          }
	} catch (err) {
          Logger.error(this._logPrefix, "Error stopping session for ", meetingId, err);
	}
        break;

      case 'StreamKeepAlive':
        Logger.info(this._logPrefix, 'Received ping  for session', meetingId);

	try {
          if (session) {
            session.ping();
          } else {
            Logger.warn(this._logPrefix, 'Could not find session for pinging', meetingId);
	  }
	} catch (err) {
          Logger.error(this._logPrefix, "Error pinging session for ", meetingId, err);
	}
        break;

      default:
        const errorMessage = this._handleError(this._logPrefix, meetingId, null, null, errors.SFU_INVALID_REQUEST);
        this._bbbGW.publish(JSON.stringify({
          ...errorMessage,
        }), C.FROM_STREAM);
        break;
    }
  }
};
