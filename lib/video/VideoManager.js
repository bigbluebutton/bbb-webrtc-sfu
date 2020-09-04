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
const Logger = require('../utils/Logger');
const errors = require('../base/errors');
const config = require('config');
// Unfreeze the config's default media specs
const DEFAULT_MEDIA_SPECS = config.util.cloneDeep(config.get('conference-media-specs'));

const BW_UNCAPPED = 0;

module.exports = class VideoManager extends BaseManager {
  constructor (connectionChannel, additionalChannels, logPrefix) {
    super(connectionChannel, additionalChannels, logPrefix);
    this.sfuApp = C.VIDEO_APP;
    this.messageFactory(this._onMessage);
    this._trackExternalWebcamSources();
  }

  static isVideoInstanceReady (video) {
    return video
      && video.constructor === Video
      && (video.status !== C.MEDIA_STOPPED || video.status !== C.MEDIA_STOPPING);
  }

  async _onMessage (_message) {
    let message = _message;
    let connectionId = message.connectionId;
    let sessionId;
    let video;
    let role = message.role? message.role : 'share';
    let cameraId = message.cameraId;
    let shared = role === 'share' ? true : false;
    let iceQueue;
    let record = message.record;

    Logger.debug(this._logPrefix, 'Received message =>', message);

    if (cameraId == null && message.id !== 'close') {
      Logger.warn(this._logPrefix, 'Ignoring message with undefined.cameraId', message);
      return;
    }

    // !!!!!>>> BE AWARE OF THIS CODE. IT'S THE INDEX ASSEMBLY. MEDDLE WITH CARE <<<!!!!!
    cameraId = `${cameraId}-${role}`;
    sessionId = `${connectionId}-${cameraId}`;
    // !!!!!>>> BE AWARE OF THIS CODE. IT'S THE INDEX ASSEMBLY. MEDDLE WITH CARE <<<!!!!!

    if (message.cameraId) {
      video = this._fetchSession(sessionId);
      iceQueue = this._fetchIceQueue(sessionId);
    }

    switch (message.id) {
      case 'start':
        Logger.info(this._logPrefix, 'Received message [' + message.id + '] from connection ' + sessionId);

        const { userId, userName } = message;

        if (video) {
          if (video.status !== C.MEDIA_STARTING) {
            await this._stopSession(sessionId);
            const { voiceBridge } = message;
            video = new Video(
              this._bbbGW,
              message.meetingId,
              message.cameraId,
              shared,
              message.connectionId,
              this.mcs, voiceBridge,
              userId,
              userName,
              sessionId,
              record,
            );
            this._sessions[sessionId] = video;
          } else {
           return;
          }
        } else {
          const { voiceBridge } = message;
          video = new Video(
            this._bbbGW,
            message.meetingId,
            message.cameraId,
            shared,
            message.connectionId,
            this.mcs,
            voiceBridge,
            userId,
            userName,
            sessionId,
            record,
          );
          this._sessions[sessionId] = video;
        }

        try {
          // Only apply bitrate cap to publishers.
          const bitrate = shared? message.bitrate : BW_UNCAPPED;
          // Create a new spec for this instance
          let mediaSpecs = { ...DEFAULT_MEDIA_SPECS };

          if (bitrate != null) {
            this._addBwToSpec(mediaSpecs, bitrate);
          }

          const sdpAnswer = await video.start(message.sdpOffer, mediaSpecs);

          // Empty ice queue after starting video
          this._flushIceQueue(video, iceQueue);

          video.once(C.MEDIA_SERVER_OFFLINE, async (event) => {
            const errorMessage = this._handleError(this._logPrefix, connectionId, message.cameraId, role, errors.MEDIA_SERVER_OFFLINE);
            this._bbbGW.publish(JSON.stringify({
              ...errorMessage,
            }), C.FROM_VIDEO);
          });

          this._bbbGW.publish(JSON.stringify({
            connectionId: connectionId,
            type: 'video',
            role: role,
            id : 'startResponse',
            cameraId: message.cameraId,
            sdpAnswer : sdpAnswer
          }), C.FROM_VIDEO);
        }
        catch (err) {
          const errorMessage = this._handleError(this._logPrefix, connectionId, message.cameraId, role, err);
          return this._bbbGW.publish(JSON.stringify({
            ...errorMessage
          }), C.FROM_VIDEO);
        }
        break;

      case 'stop':
        this._stopSession(sessionId).then(() => {
          Logger.info(this._logPrefix, `Session ${sessionId} stopped.`);
          this._deleteIceQueue(sessionId);
        }).catch(error => {
          Logger.info(this._logPrefix, `Stopping session ${sessionId} failed due to ${error.message}.`,
            { error });
          this._deleteIceQueue(sessionId);
        });
        break;

      case 'pause':
        if (video) {
          video.pause(message.state);
        }
        break;

      case 'onIceCandidate':
        if (VideoManager.isVideoInstanceReady(video)) {
          video.onIceCandidate(message.candidate);
        } else {
          Logger.info(this._logPrefix, "Queueing ice candidate for later in video", sessionId);
          iceQueue.push(message.candidate);
        }
        break;

      case 'close':
        Logger.info(this._logPrefix, "Closing sessions of connection", connectionId);
        this._killConnectionSessions(connectionId);
        break;

      default:
        const errorMessage = this._handleError(this._logPrefix, connectionId, null, null, errors.SFU_INVALID_REQUEST);
        this._bbbGW.publish(JSON.stringify({
          ...errorMessage,
        }), C.FROM_VIDEO);
        break;
    }
  }

  _trackExternalWebcamSources() {
    this._bbbGW.on(C.USER_CAM_BROADCAST_STARTED_2x, payload => {
      const { stream, userId } = payload;
      if (userId.match(/^v_*/ig)) {
        Logger.info(this._logPrefix, "Tracking external video source", payload);
        const normalizedStreamName = stream.replace(/\|SIP/ig, '');
        Video.setSource(stream, normalizedStreamName);
        Video.setSource(userId, normalizedStreamName);
      }
    });
  }

  _addBwToSpec (spec, bitrate) {
    spec['H264'].as_main = bitrate;
    spec['H264'].tias_main = (bitrate >>> 0) * 1000;
    spec['VP8'].as_main = bitrate;
    spec['VP8'].tias_main = (bitrate >>> 0) * 1000;
    return spec;
  }
}
