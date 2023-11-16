/*
 * Lucas Fialho Zawacki
 * Paulo Renato Lanzarin
 * (C) Copyright 2017 Bigbluebutton
 *
 */

"use strict";

const Screenshare = require('./screenshare');
const BaseManager = require('../base/base-manager.js');
const C = require('../bbb/messages/Constants');
const Logger = require('../common/logger.js');
const errors = require('../base/errors');
const config = require('config');
const {
  getScreenBroadcastPermission, getScreenSubscribePermission
} = require('./screen-perm-utils.js');
const Messaging = require('../bbb/messages/Messaging');
const { PrometheusAgent, SFUS_NAMES } = require('./metrics/screenshare-metrics.js');

const EJECT_ON_USER_LEFT = config.get('ejectOnUserLeft');
const SCREENSHARE_MEDIA_SERVER = config.get('screenshareMediaServer');
const WS_STRICT_HEADER_PARSING = config.get('wsStrictHeaderParsing');

module.exports = class ScreenshareManager extends BaseManager {
  constructor (connectionChannel, additionalChannels, logPrefix) {
    super(connectionChannel, additionalChannels, logPrefix);
    this.sfuApp = C.SCREENSHARE_APP;
    this._meetings = {}
    this.messageFactory(this._onMessage.bind(this));
    this._trackMeetingEvents();
    this.mcs.on(C.MCS_CONNECTED, () => {
      this.mcs.onEvent('roomCreated', 'all', this._handleRoomCreated.bind(this));
    });
    this._trackScreenBroadcastStopSysMsg();
    this._trackBBBRecordingStatusChanged();
    this._setMetrics();
  }

  static _getLifecycleQueueId (message) {
    const { role, voiceBridge, connectionId = '' } = message;
    if (role === C.SEND_ROLE) {
      return `${voiceBridge}`;
    } else {
      return `${voiceBridge}:${connectionId}`;
    }
  }

  static getMetadataFromMessage (message) {
    return {
      sfuMessageId: message.id,
      connectionId: message.connectionId,
      internalMeetingId: message.internalMeetingId,
      roomId: message.voiceBridge,
      userId: message.callerName || message.userId,
      role: message.role,
      reason: message.id === 'error' ? message.reason : undefined,
    };
  }

  static explodeUserInfoHeader (message) {
    if (typeof message === 'object' &&  typeof message.sfuUserHeader === 'object') {
      if (typeof message.sfuUserHeader.userId === 'string'
        && typeof message.sfuUserHeader.voiceBridge === 'string'
        && typeof message.sfuUserHeader.meetingId === 'string'
      ) {
        // TODO refactor callerName, internalMeetingId to be consistent with
        // other modules
        message.callerName = message.sfuUserHeader.userId;
        message.internalMeetingId = message.sfuUserHeader.meetingId;
        message.userId = message.sfuUserHeader.userId;
        message.meetingId = message.sfuUserHeader.meetingId;
        message.voiceBridge = message.sfuUserHeader.voiceBridge;

        return message;
      }
    }

    throw errors.SFU_INVALID_REQUEST;
  }

  _registerQueueFailure (reason) {
    PrometheusAgent.increment(SFUS_NAMES.QUEUE_FAILURES, { reason });
  }

  _setMetrics() {
    PrometheusAgent.setCollectorWithGenerator(
      SFUS_NAMES.SESSIONS,
      this.getNumberOfSessions.bind(this)
    );

    PrometheusAgent.setCollectorWithGenerator(
      SFUS_NAMES.QUEUED_REQUESTS,
      this.getNumberOfQueuedRequests.bind(this),
    );
  }

  _trackMediaServerOfflineEvent (session, connectionId, voiceBridge, userId, role) {
    session.once(C.MEDIA_SERVER_OFFLINE, () => {
      // Media server died. Force-close this thing and notify the client
      const errorMessage = this._handleError(this._logPrefix, connectionId, userId, role, errors.MEDIA_SERVER_OFFLINE);
      this.sendToClient({
        ...errorMessage
      }, C.FROM_SCREENSHARE);
      PrometheusAgent.increment(SFUS_NAMES.ERRORS, {
        method: 'event', errorCode: errorMessage.code
      });
      const queue = this._fetchLifecycleQueue(voiceBridge);
      queue.push(() => {
        return this.closeSession(session, voiceBridge, connectionId);
      });
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

  _trackBBBRecordingStatusChanged () {
    this._bbbGW.on(C.RECORDING_STATUS_CHANGED_EVT_MSG, (payload) => {
      const meetingId = payload[C.MEETING_ID_2x];
      const sessionId = this._meetings[meetingId];
      const session = this.getSession(sessionId);
      const recording = payload[C.RECORDING];

      if (session) {
        session.setBBBRecordingStatus(recording);
      }
    })
  }

  _trackScreenBroadcastStopSysMsg () {
    this._bbbGW.on(C.SCREEN_BROADCAST_STOP_SYS_MSG, (payload) => {
      const meetingId = payload[C.MEETING_ID_2x];
      const streamId = payload[C.STREAM_ID];
      const voiceBridge = payload[C.VOICE_CONF_2x];
      const sessionId = this._meetings[meetingId];
      const session = this.getSession(sessionId);

      if (session) {
        if (session._presenterEndpoint == streamId) {
          Logger.info("Acting on ScreenBroadcastStopSysMsg",
            { ...session._getFullPresenterLogMetadata() });
          const queue = this._fetchLifecycleQueue(sessionId);
          queue.push(() => {
            return this._terminatePresenterSession(session, sessionId);
          });
          this.sendToClient({
            connectionId: session._connectionId,
            type: C.SCREENSHARE_APP,
            id : 'close',
          }, C.FROM_SCREENSHARE);
        }
      } else {
        Logger.info("Acting on ScreenBroadcastStopSysMsg, but no session", {
              meetingId, streamId, voiceBridge,
        })
        const timestamp = Math.floor(new Date());
        const dsrstom = Messaging.generateScreenshareRTMPBroadcastStoppedEvent2x(
          voiceBridge, voiceBridge, streamId, 0, 0, timestamp,
        );
        this._bbbGW.publish(dsrstom, C.TO_AKKA_APPS);
      }
    });
  }

  _handleStartFailure (error, request) {
    const { connectionId, role, callerName: userId } = request;
    // Start error. Send an error message and then send a socket close
    // message. The error one will notify the client, the close one will
    // forcefully close this sad piece of screensharing attempt and clean things
    // up no matter what.
    Logger.error( 'Screenshare session start failed', {
      errorMessage: error.message,
      errorCode: error.code,
      ...ScreenshareManager.getMetadataFromMessage(request),
    });

    const errorMessage = this._handleError(this._logPrefix, connectionId, userId, role, error);
    const closeMessage = this._handleError(this._logPrefix, connectionId, userId, role, error);
    closeMessage.id = 'close';
    this.sendToClient({
      ...errorMessage
    }, C.FROM_SCREENSHARE);
    this.sendToClient({
      ...closeMessage
    }, C.FROM_SCREENSHARE);

    PrometheusAgent.increment(SFUS_NAMES.ERRORS, {
      method: request.id, errorCode: errorMessage.code
    });
  }

  async _handlePresenterStart (request) {
    let session;
    const {
      internalMeetingId,
      voiceBridge,
      connectionId,
      role,
      sdpOffer,
      callerName: userId,
      bitrate,
      vh = 0, vw = 0,
      hasAudio,
      mediaServer = SCREENSHARE_MEDIA_SERVER,
      contentType,
      recordingAdapter,
    } = request;

    // Throws SFU_UNAUTHORIZED on failure
    await getScreenBroadcastPermission(
      this._bbbGW, internalMeetingId, voiceBridge, userId, connectionId
    );

    session = this.getSession(voiceBridge);

    if (session) {
      await this.closeSession(session, voiceBridge, session._connectionId);
    }

    session = new Screenshare(
      connectionId,
      this._bbbGW,
      voiceBridge,
      userId,
      vh, vw,
      internalMeetingId,
      this.mcs,
      hasAudio,
      contentType,
    );

    this.storeSession(voiceBridge, session);
    this._meetings[internalMeetingId] = voiceBridge;

    const options = {
      bitrate,
      mediaServer,
      recordingAdapter,
    };

    const sdpAnswer = await session.start(connectionId, userId, role, sdpOffer, options);

    return { sdpAnswer, session };
  }

  async _handleViewerStart (request) {
    const {
      internalMeetingId,
      voiceBridge,
      connectionId,
      role,
      sdpOffer,
      callerName: userId,
      bitrate,
      mediaServer = SCREENSHARE_MEDIA_SERVER,
    } = request;

    const session = this.getSession(voiceBridge);

    if (!session) {
      throw errors.SFU_INVALID_REQUEST;
    }

    // Throws SFU_UNAUTHORIZED on failure
    await getScreenSubscribePermission(
      this._bbbGW,
      internalMeetingId,
      voiceBridge,
      userId,
      session._presenterEndpoint,
      connectionId
    );

    const options = {
      bitrate,
      mediaServer,
    };

    const sdpAnswer = await session.start(connectionId, userId, role, sdpOffer, options);

    return { sdpAnswer, session };
  }

  async handleStart (request) {
    let sdpAnswer, session;
    const {
      voiceBridge,
      connectionId,
      role,
      callerName: userId,
    } = request;

    try {
      switch (role) {
        case C.SEND_ROLE:
          ({ sdpAnswer, session } = await this._handlePresenterStart(request));
          break;
        case C.RECV_ROLE:
          ({ sdpAnswer, session } = await this._handleViewerStart(request));
          break;
        default:
          throw errors.SFU_INVALID_REQUEST;
      }

      Logger.debug("Screensharing session started",
        ScreenshareManager.getMetadataFromMessage(request));

      // Empty ice queue after starting session
      const iceQueue = this._fetchIceQueue(voiceBridge);
      if (iceQueue) {
        let candidate;
        while((candidate = iceQueue.pop())) {
          session.onIceCandidate(candidate, role, userId, connectionId);
        }
      }

      this.sendToClient({
        connectionId,
        type: C.SCREENSHARE_APP,
        role,
        id: 'startResponse',
        response: 'accepted',
        sdpAnswer,
      }, C.FROM_SCREENSHARE);

      this._trackMediaServerOfflineEvent(
        session, connectionId, voiceBridge, userId, role,
      );
    } catch (error) {
      this._handleStartFailure(error, request)
    }
  }

  handleSubscriberAnswer (message) {
    const {
      voiceBridge,
      answer,
      role,
      callerName: userId,
      connectionId,
    } = message;

    const session = this.getSession(voiceBridge);

    if (session && session.constructor === Screenshare) {
      const metadata = ScreenshareManager.getMetadataFromMessage(message);
      return session.processAnswer(answer, role, userId, connectionId).then(() => {
        Logger.debug('Screensharing remote description processed',
          metadata
        );
      }).catch(error => {
        Logger.error( 'Remote description processing failed', {
          errorMessage: error.message,
          errorCode: error.code,
          metadata,
        });
        const normalizedError = this._handleError(
          this._logPrefix,
          connectionId,
          userId,
          role,
          error,
        );
        PrometheusAgent.increment(SFUS_NAMES.ERRORS, {
          method: message.id, errorCode: normalizedError.code
        });
      });
    } else return Promise.resolve();
  }

  handleIceCandidate (message) {
    const {
      voiceBridge,
      candidate,
      role,
      connectionId,
    } = message;

    let iceQueue, session;

    session = this.getSession(voiceBridge);
    iceQueue = this._fetchIceQueue(voiceBridge);

    if (session && session.constructor === Screenshare) {
      session.onIceCandidate(candidate, role, connectionId);
      Logger.debug("Screensharing ICE candidate added",
        ScreenshareManager.getMetadataFromMessage(message));
    } else {
      iceQueue.push(candidate);
    }
  }

  handleClose (message) {
    const { voiceBridge, connectionId, } = message;

    let session;

    session = this.getSession(voiceBridge);

    Logger.info('Connection closed',
      ScreenshareManager.getMetadataFromMessage(message));
    return this.closeSession(session, voiceBridge, connectionId);
  }

  _handleUpstreamError (message = {}) {
    Logger.error('Received error event from upstream',
      ScreenshareManager.getMetadataFromMessage(message));
  }

  _handleInvalidRequest(message = {}) {
    const errorMessage = this._handleError(this._logPrefix, message.connectionId, null, null, errors.SFU_INVALID_REQUEST);
    PrometheusAgent.increment(SFUS_NAMES.ERRORS, {
      method: message.id || 'event', errorCode: errorMessage.code
    });
    this.sendToClient({
      ...errorMessage,
    }, C.FROM_SCREENSHARE);
  }

  async _onMessage(message = {}) {
    let queue;

    PrometheusAgent.increment(SFUS_NAMES.REQS);

    try {
      ScreenshareManager.explodeUserInfoHeader(message);
    } catch (error) {
      if (WS_STRICT_HEADER_PARSING) {
        Logger.debug('Invalid user info header', { header: message.sfuUserHeader });
        this._handleInvalidRequest(message);
        return;
      }
    }

    Logger.trace('Received message', message);

    switch (message.id) {
      case 'start':
        queue = this._fetchLifecycleQueue(ScreenshareManager._getLifecycleQueueId(message));
        queue.push(() => { return this.handleStart(message) });
        break;

      case 'subscriberAnswer':
        queue = this._fetchLifecycleQueue(ScreenshareManager._getLifecycleQueueId(message));
        queue.push(() => { this.handleSubscriberAnswer(message) });
        break;

      case 'iceCandidate':
        this.handleIceCandidate(message);
        break;

      case 'close':
        queue = this._fetchLifecycleQueue(ScreenshareManager._getLifecycleQueueId(message));
        queue.push(() => { return this.handleClose(message) });
        break;

      case 'error':
        this._handleUpstreamError(message);
        break;

      default:
        this._handleInvalidRequest(message);
        break;
    }
  }

  _handleRoomCreated (event) {
    const { room } = event;
    this.mcs.onEvent('roomDestroyed', room, () => {
      try {
        const session = this.getSession(room);
        const queue = this._fetchLifecycleQueue(room);
        queue.push(() => {
          return this._terminatePresenterSession(session, room);
        });
      } catch (error) {
        Logger.error(`Screensharing session stop failed at room destroyed handler`,
          { error: this._handleError(this._logPrefix, null, null, null, error), roomId: room });
      }
    });
    this.mcs.onEvent('contentFloorChanged', room, this._handleContentFloorChanged.bind(this));
  }

  async _handleContentFloorChanged (event) {
    const { roomId, floor } = event;

    try {
      if (floor == null) {
        // Content floor was released, forcibly stop the session if it wasn't yet
        const session = this.getSession(roomId);
        const queue = this._fetchLifecycleQueue(roomId);
        queue.push(() => {
          return this._terminatePresenterSession(session, roomId);
        });
      }
    } catch (error) {
      Logger.error(`Screensharing session stop failed at content floor changed handler`,
        { error: this._handleError(this._logPrefix, null, null, null, error), roomId });
    }
  }

  _terminatePresenterSession (session, sessionId) {
    if (session && session.constructor == Screenshare) {
      Logger.info(`Stopping screensharing presenter session ${sessionId}`,
        session._getPartialLogMetadata());

      const internalMeetingId = session.meetingId;

      return this._stopSession(sessionId).then(() => {
        this._deleteIceQueue(sessionId);
        delete this._meetings[internalMeetingId];
      }).catch(error => {
        this._deleteIceQueue(sessionId);
        delete this._meetings[internalMeetingId];
        Logger.error("Screensharing session stop failed at closeSession",
          { error: this._handleError(this._logPrefix, null, null, null, error)});
      });
    } else {
      return Promise.resolve();
    }
  }

  closeSession (session, sessionId, connectionId) {
    if (session && session.constructor == Screenshare && connectionId) {
      if (session._connectionId === connectionId) {
        return this._terminatePresenterSession(session, sessionId)
      } else {
        Logger.info("Stopping screensharing viewer",
          session._getFullViewerLogMetadata(connectionId));
        return session.stopViewer(connectionId);
      }
    } else {
      return Promise.resolve();
    }
  }

  disconnectAllUsers(meetingId) {
    const voiceBridge = this._meetings[meetingId];
    if (typeof voiceBridge !== 'undefined') {
      const session = this.getSession(voiceBridge);
      if (session) {
        Logger.info("Disconnecting all screenshare sessions, meeting end", {
          meetingId,
          voiceBridge,
        });
        this._stopSession(voiceBridge);
      }
      delete this._meetings[meetingId]
    }
  }

  disconnectUser(meetingId, userId) {
    const voiceBridge = this._meetings[meetingId]
    if (voiceBridge) {
      const session = this.getSession(voiceBridge);
      if (session) {
        const connectionIdsAndRoles  = session.getConnectionIdAndRolesFromUser(userId) || [];
        connectionIdsAndRoles.forEach(({ connectionId, role }) => {
          if (connectionId && role) {
            Logger.info('Disconnect a screen share on UserLeft*', {
              meetingId,
              userId,
              voiceBridge,
              connectionId,
              role: role,
            });

            this.closeSession(session, voiceBridge, connectionId);
            this.sendToClient({
              connectionId,
              type: C.SCREENSHARE_APP,
              id : 'close',
              role,
            }, C.FROM_SCREENSHARE);
          }
        });
      }
    }
  }
}
