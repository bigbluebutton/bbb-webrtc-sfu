/*
 * Lucas Fialho Zawacki
 * (C) Copyright 2017 Bigbluebutton
 *
 */

'use strict';

const BigBlueButtonGW = require('../bbb/pubsub/bbb-gw');
const Video = require('./video');
const BaseManager = require('../base/BaseManager');
const C = require('../bbb/messages/Constants');
const { Logger } = require('../utils/Logger');
const errors = require('../base/errors');
const config = require('config');
const Utils = require('../utils/Utils.js');

const VIDEO_MEDIA_SERVER = config.get('videoMediaServer');
// Unfreeze the config's default media specs
const DEFAULT_MEDIA_SPECS = config.util.cloneDeep(config.get('conference-media-specs'));

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

  static getRole (message = {}) {
    return message.role ? message.role : 'share';
  }

  static getSessionId (message = {}) {
    return `${message.connectionId}-${VideoManager.getCameraId(message)}-${VideoManager.getRole(message)}`;
  }

  static getVideoSpecsFromRequest (message) {
    const role = VideoManager.getRole(message);
    // Only apply bitrate cap to publishers.
    const bitrate = role === 'share' ? message.bitrate : BW_UNCAPPED;
    // Create a new spec for this instance
    const spec = { ...DEFAULT_MEDIA_SPECS };

    if (bitrate != null) {
      Utils.addBwToSpecMainType(spec, bitrate);
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
    session.once(C.MEDIA_SERVER_OFFLINE, (event) => {
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
    Object.keys(this._sessions).forEach((sessionId) => {
      const session = this._fetchSession(sessionId);
      if (session && session.connectionId === connectionId) {
        const queue = this._fetchLifecycleQueue(sessionId);
        queue.push(() => {
          const metadata = session._getLogMetadata();
          return this._stopSession(sessionId).then(() => {
            this._deleteIceQueue(sessionId);
          }).catch(error => {
            Logger.error(this._logPrefix, "Video session stop failed at connection closed", {
              errorMessage: error.message,
              errorCode: error.code,
              metadata,
            });
            this._deleteIceQueue(sessionId);
          });
        });
      }
    });
  }

  async handleStart (message) {
    let video, iceQueue;
    const sessionId = VideoManager.getSessionId(message);
    const role = VideoManager.getRole(message);
    const {
      userId,
      voiceBridge,
      meetingId,
      connectionId,
      sdpOffer,
      cameraId,
      record = true,
      mediaServer = VIDEO_MEDIA_SERVER,
    } = message;

    video = this._fetchSession(sessionId);
    iceQueue = this._fetchIceQueue(sessionId);

    if (video) {
      Logger.warn(this._logPrefix, `Aborted trailing start request for video session`,
        video._getLogMetadata());
      return;
    } else {
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
    }

    const mediaSpecs = VideoManager.getVideoSpecsFromRequest(message);

    return video.start(sdpOffer, mediaSpecs)
      .then(sdpAnswer => {
        Logger.info(this._logPrefix, "Video session started",
          VideoManager.getMetadataFromMessage(message));
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
      })
      .catch(error => {
        const errorMessage = this._handleError(this._logPrefix, connectionId, cameraId, role, error);
        return this.sendToClient({
          ...errorMessage
        }, C.FROM_VIDEO);
      });
  }

  handleStop (message) {
    const sessionId = VideoManager.getSessionId(message);

    return this._stopSession(sessionId).then(() => {
      this._deleteIceQueue(sessionId);
    }).catch(error => {
      Logger.error(this._logPrefix, "Video session stop failed", {
        errorMessage: error.message,
        errorCode: error.code,
        ...VideoManager.getMetadataFromMessage(message)
      });
      this._deleteIceQueue(sessionId);
    });
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

  handlePause (message) {
    const sessionId = VideoManager.getSessionId(message);
    const video = this._fetchSession(sessionId);

    if (video) {
      video.pause(message.state);
    }
  }

  handleClose (message) {
    const { connectionId } = message;
    Logger.info(this._logPrefix, 'Connection closed',
      VideoManager.getMetadataFromMessage(message));
    this._killConnectionSessions(connectionId);
  }

  _onMessage (message) {
    let queue;

    Logger.debug(this._logPrefix, `Received message from ${message.connectionId}: ${message.id}`);

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

      case 'pause':
        this.handlePause(message);
        break;

      case 'onIceCandidate':
        this.handleIceCandidate(message);
        break;

      case 'close':
        this.handleClose(message);
        break;

      default:
        const errorMessage = this._handleError(this._logPrefix, message.connectionId, null, null, errors.SFU_INVALID_REQUEST);
        this.sendToClient({
          ...errorMessage,
        }, C.FROM_VIDEO);
        break;
    }
  }
}
