/*
 * Lucas Fialho Zawacki
 * (C) Copyright 2017 Bigbluebutton
 *
 */

'use strict';

const Video = require('./video');
const BaseManager = require('../base/base-manager.js');
const C = require('../bbb/messages/Constants');
const Logger = require('../common/logger.js');
const errors = require('../base/errors');
const config = require('config');
const { addBwToSpecMainType } = require('../common/utils.js');
const {
  getCamBroadcastPermission, getCamSubscribePermission
} = require('./video-perm-utils.js');

const VIDEO_MEDIA_SERVER = config.get('videoMediaServer');
// Unfreeze the config's default media specs
const DEFAULT_MEDIA_SPECS = config.util.cloneDeep(config.get('conference-media-specs'));
const WS_STRICT_HEADER_PARSING = config.get('wsStrictHeaderParsing');

const BW_UNCAPPED = 0;

module.exports = class VideoManager extends BaseManager {
  constructor (connectionChannel, additionalChannels, logPrefix) {
    super(connectionChannel, additionalChannels, logPrefix);
    this.sfuApp = C.VIDEO_APP;
    this.messageFactory(this._onMessage.bind(this));
    this._trackExternalWebcamSources();
  }

  static getCameraId (message = {}) {
    return message.cameraId;
  }

  static getSessionId (message = {}) {
    return `${message.userId}-${VideoManager.getCameraId(message)}-${message.role}`;
  }

  static getVideoSpecsFromRequest (message) {
    const role = message.role;
    // Only apply bitrate cap to publishers.
    const bitrate = role === 'share' ? message.bitrate : BW_UNCAPPED;
    // Create a new spec for this instance
    const spec = { ...DEFAULT_MEDIA_SPECS };

    if (bitrate != null) {
      addBwToSpecMainType(spec, bitrate);
    }

    return spec;
  }

  static getMetadataFromMessage (message) {
    return {
      sfuMessageId: message.id,
      connectionId: message.connectionId,
      sessionId: VideoManager.getSessionId(message),
      internalMeetingId: message.meetingId,
      roomId: message.voiceBridge,
      userId: message.userId,
      role: message.role,
    };
  }

  static isVideoInstanceReady (video) {
    return video
      && video.constructor === Video
      && (video.status !== C.MEDIA_STOPPED || video.status !== C.MEDIA_STOPPING);
  }

  _trackExternalWebcamSources() {
    this._bbbGW.on(C.USER_CAM_BROADCAST_STARTED_2x, payload => {
      const { stream, userId } = payload;
      if (userId.match(/^v_*/ig)) {
        const normalizedStreamName = stream.replace(/\|SIP/ig, '');
        Video.setSource(stream, normalizedStreamName);
        Video.setSource(userId, normalizedStreamName);
      }
    });
  }

  _trackMediaServerOfflineEvent (session) {
    session.once(C.MEDIA_SERVER_OFFLINE, () => {
      // Media server died. Notify the client. The client will either directly
      // stop it or close the websocket conn, which will trigger a stop.
      const errorMessage = this._handleError(
        this._logPrefix,
        session.connectionId,
        session.id,
        session.role,
        errors.MEDIA_SERVER_OFFLINE
      );
      this.sendToClient({
        ...errorMessage,
      }, C.FROM_VIDEO);
    });
  }

  _killConnectionSessions (connectionId) {
    // FIXME extremely inefficient
    Object.keys(this._sessions).forEach((sessionId) => {
      const session = this._fetchSession(sessionId);
      if (session && session.connectionId === connectionId) {
        const queue = this._fetchLifecycleQueue(sessionId);
        queue.push(() => {
          return this._closeSession(sessionId, session._getLogMetadata());
        });
      }
    });
  }

  _getPermission (request) {
    const {
      userId, meetingId, connectionId, cameraId, role,
    } = request;

    switch (role) {
      case 'share':
        return getCamBroadcastPermission(
          this._bbbGW,
          meetingId,
          userId,
          cameraId,
          connectionId,
        );
      case 'viewer':
        return getCamSubscribePermission(
          this._bbbGW,
          meetingId,
          userId,
          cameraId,
          connectionId,
        );
      default:
        throw errors.SFU_INVALID_REQUEST;
    }
  }

  async handleStart (request) {
    const sessionId = VideoManager.getSessionId(request);
    const {
      userId,
      voiceBridge,
      meetingId,
      connectionId,
      sdpOffer,
      cameraId,
      record = true,
      mediaServer = VIDEO_MEDIA_SERVER,
      role,
    } = request;

    try {
      let video;

      await this._getPermission(request);
      video = this._fetchSession(sessionId);
      const iceQueue = this._fetchIceQueue(sessionId);

      if (video) {
        Logger.warn(this._logPrefix, 'Shutting down stale video session',
          video._getLogMetadata());
        await this._closeSession(sessionId, video._getLogMetadata());
      }

      video = new Video(
        this._bbbGW,
        meetingId,
        cameraId,
        role,
        connectionId,
        this.mcs,
        voiceBridge,
        userId,
        sessionId,
        record,
        mediaServer,
      );

      this._sessions[sessionId] = video;

      const mediaSpecs = VideoManager.getVideoSpecsFromRequest(request);
      const sdpAnswer = await video.start(sdpOffer, mediaSpecs)
      Logger.info(this._logPrefix, "Video session started",
        VideoManager.getMetadataFromMessage(request));
      this._flushIceQueue(video, iceQueue);
      this._trackMediaServerOfflineEvent(video);
      this.sendToClient({
        connectionId: connectionId,
        type: 'video',
        role: role,
        id : 'startResponse',
        cameraId,
        sdpAnswer : sdpAnswer
      }, C.FROM_VIDEO);

    } catch(error) {
      const errorMessage = this._handleError(this._logPrefix, connectionId, cameraId, role, error);
      return this.sendToClient({
        ...errorMessage
      }, C.FROM_VIDEO);
    }
  }

  _closeSession (sessionId, logMetadata = {}) {
    return this._stopSession(sessionId).then(() => {
      this._deleteIceQueue(sessionId);
    }).catch(error => {
      Logger.error(this._logPrefix, "Video session stop failed", {
        errorMessage: error.message,
        errorCode: error.code,
        ...logMetadata,
      });
      this._deleteIceQueue(sessionId);
    });
  }

  handleStop (message) {
    return this._closeSession(
      VideoManager.getSessionId(message),
      VideoManager.getMetadataFromMessage(message)
    );
  }

  handleIceCandidate (message) {
    const { candidate } = message;
    const sessionId = VideoManager.getSessionId(message);
    const video = this._fetchSession(sessionId);
    const iceQueue = this._fetchIceQueue(sessionId);

    if (VideoManager.isVideoInstanceReady(video)) {
      video.onIceCandidate(candidate);
      Logger.debug(this._logPrefix, 'Video ICE candidate added',
        VideoManager.getMetadataFromMessage(message));
    } else {
      iceQueue.push(candidate);
    }
  }

  async handleSubscriberAnswer (message) {
    const { answer } = message;
    const sessionId = VideoManager.getSessionId(message);
    const video = this._fetchSession(sessionId);

    try {
      await video.processAnswer(answer);
    } catch (error) {
      const metadata = video ? video._getLogMetadata() : {};
      Logger.error(this._logPrefix,  'Answer processing failed', {
        errorMessage: error.message,
        errorCode: error.code,
        metadata,
      });
    }
  }

  handleClose (message) {
    const { connectionId } = message;
    Logger.info(this._logPrefix, 'Connection closed',
      VideoManager.getMetadataFromMessage(message));
    this._killConnectionSessions(connectionId);
  }

  _handleInvalidRequest (message) {
    const errorMessage = this._handleError(this._logPrefix, message.connectionId, message.cameraId, message.role, errors.SFU_INVALID_REQUEST);
    this.sendToClient({
      ...errorMessage,
    }, C.FROM_VIDEO);
  }

  _onMessage (message) {
    let queue;

    Logger.debug(this._logPrefix, `Received message from ${message.connectionId}: ${message.id}`);

    try {
      this.explodeUserInfoHeader(message);
    } catch (error) {
      if (WS_STRICT_HEADER_PARSING) {
        Logger.debug(this._logPrefix, 'Invalid user info header', { header: message.sfuUserHeader });
        return this._handleInvalidRequest(message)
      }
    }

    switch (message.id) {
      case 'start':
        queue = this._fetchLifecycleQueue(VideoManager.getSessionId(message));
        queue.push(() => { return this.handleStart(message) });
        break;

      case 'subscriberAnswer':
        this.handleSubscriberAnswer(message);
        break;

      case 'stop':
        queue = this._fetchLifecycleQueue(VideoManager.getSessionId(message));
        queue.push(() => { return this.handleStop(message) });
        break;

      case 'onIceCandidate':
        this.handleIceCandidate(message);
        break;

      case 'close':
        this.handleClose(message);
        break;

      default:
        this._handleInvalidRequest(message);
        break;
    }
  }
}
