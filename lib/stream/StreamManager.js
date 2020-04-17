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

const OAuth2 = require('../oauth2/server');

module.exports = class StreamManager extends BaseManager {
  constructor (connectionChannel, additionalChannels, logPrefix) {
    super(connectionChannel, additionalChannels, logPrefix);
    this.sfuApp = C.STREAM_APP;
    this._meetings = {};
    this._closeConnectionCallbacks = {};
    this._trackMeetingTermination();
    this.messageFactory(this._onMessage);
  }

  _getOAuth2Url(streamType, meetingId, userId, meetingName, callback) {
    let id = meetingId + userId;

    let adapter = OAuth2[streamType];

    adapter.getOAuth2Url(id, meetingId, userId, meetingName, streamType, (client, url) => {
      callback(url);

      adapter.onToken(client, (auth) => {

        // Setup a method to be called when streaming stops
        this._closeConnectionCallbacks[meetingId] = (cb) => {

          if (typeof adapter.closeOAuth2Connection === 'function') {
            Logger.info(this.log_prefix, "Close oauth2 connection");
            adapter.closeOAuth2Connection(id, auth, cb);
          } else {
            Logger.warn(this.log_prefix, "No oauth2 method to close connection");
          }
        };

        adapter.getStreamKey(auth, (err, key, videoId) => {
          Logger.info(this._logPrefix, 'Sharing oauth data for ', userId, key, videoId);

          if (err) {
            Logger.info(this._logPrefix, 'Stream API failed with err: ', err, ' userId: ', userId);
          }

          this._bbbGW.publish(
            Messaging.generateStreamOAuth2DataMessage(meetingId, userId, key, videoId, err), C.TO_HTML5);
        });
      });
    });
  };

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

  _onStart(meetingId, userId, streamUrl, streamType, streamId) {
    return () => {
      Logger.info(this._logPrefix, 'Stream is starting for', meetingId, userId, streamUrl, streamType, streamId);
      this._bbbGW.publish(
      Messaging.generateStreamEventMessage(meetingId, userId, C.STREAM_STARTED, streamUrl, streamType, streamId)
    , C.TO_AKKA_APPS_CHAN_2x);
    };
  }

  _onStop(meetingId, userId) {
    return (reason) => {
      Logger.info(this._logPrefix, 'Stream is stopping for', meetingId, userId);
      Logger.info(Messaging.generateStreamEventMessage(meetingId, userId, C.STREAM_STOPPED));
      this._bbbGW.publish(
        Messaging.generateStreamEventMessage(meetingId, userId, C.STREAM_STOPPED)
        , C.TO_AKKA_APPS_CHAN_2x);

      if (this._closeConnectionCallbacks[meetingId]) {
        this._closeConnectionCallbacks[meetingId]();
      }

      delete this._closeConnectionCallbacks[meetingId];
      delete this._sessions[meetingId];
      delete this._meetings[meetingId];
    };
  }

  _onMessage(message) {
    let session, meetingId, userId, name, streamUrl, streamType, streamId, extId, confname;

    if (message.core && message.core.header) {
      meetingId = message.core.header.meetingId;
      userId = message.core.header.userId;
      name = message.core.header.name;
    }

    if (message.core && message.core.body) {
      streamUrl = message.core.body.streamUrl;
      streamType = message.core.body.streamType;
      streamId = message.core.body.streamId;
      confname = message.core.body.confname;
      extId = message.core.body.extId;
    }

    session = this._sessions[meetingId];

    Logger.debug(this._logPrefix, 'Received message [' + name + '] from connection', meetingId);
    switch (name) {
      case 'StartStream':

        if (!session) {
          session = new Stream(this._bbbGW, meetingId, extId, confname, streamUrl, streamType);
        } else {
          Logger.warn(this._logPrefix, "Not starting stream again for ", meetingId);
          return;
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

          session.onStart(this._onStart(meetingId, userId, streamUrl, streamType, streamId));

          session.onStop(this._onStop(meetingId, userId));

          Logger.info(this._logPrefix, "Sending startResponse to meeting ", meetingId, "for connection", session._id);
        });
        break;

      case 'StopStream':
        Logger.info(this._logPrefix, 'Received stop message for session', meetingId);

        try {
          if (session) {
            session.stop();
          } else {
            Logger.warn(this._logPrefix, "There was no stream session on stop for", meetingId);
          }

          this._onStop(meetingId, userId)();
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

      case 'GetOAuth2Url':
        Logger.info(this._logPrefix, 'Received request for OAuth2 auth URL');

        try {
          this._getOAuth2Url(streamType, meetingId, userId, confname, (url) => {
            Logger.info(this._logPrefix, 'Sharing an', streamType, 'oauth url for ', meetingId, ' url is ', url);
            this._bbbGW.publish(
              Messaging.generateStreamOAuth2UrlMessage(meetingId, userId, url), C.TO_HTML5);
          });
        } catch (err) {
          Logger.error(this._logPrefix, "Error oauth2 in session ", meetingId, err);
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
