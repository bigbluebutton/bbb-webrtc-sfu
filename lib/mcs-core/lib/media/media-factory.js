'use strict';

const EventEmitter = require('events').EventEmitter;
const Logger = require('../utils/logger.js');
const C = require('../constants/constants.js');

let instance = null;

class MediaFactory extends EventEmitter {
  constructor () {
    super();
    if (instance == null) {
      this.medias = [];
      this.mediaSessions = [];
      instance = this;
    }
    return instance;
  }

  getMediaSession (mediaId) {
    let media = this.mediaSessions.find(({ id }) => id === mediaId);

    // Not found by ID, try fetching the father session of a media unit
    if (media == null) {
      media = this.getMedia(mediaId);
    }

    return media;
  }

  getMedia (mediaId) {
    return this.medias.find(({ id }) => id === mediaId);
  }

  addMediaSession (mediaSession) {
    if (!this.mediaSessions.find(ms => ms.id === mediaSession.id)) {
      this.mediaSessions.push(mediaSession);
    }
  }

  addMedia (media) {
    if (!this.medias.find(mu => mu.id === media.id)) {
      this.medias.push(media);
    }
  }

  removeMediaSession (mediaSessionId) {
    const mediaSession = this.getMediaSession(mediaSessionId);
    mediaSession.medias.forEach(this.removeMedia.bind(this));
    this.mediaSessions = this.mediaSessions.filter(({ id }) => id !== mediaSessionId);
  }

  removeMedia (media) {
    this.medias = this.medias.filter(({ id }) => id !== media.id);
  }

  createMediaSession (descriptor, type, roomId, userId, params) {
    let mediaSession;

    switch (type) {
      case C.MEDIA_TYPE.WEBRTC:
      case C.MEDIA_TYPE.RTP:
        mediaSession = this._createSDPSession(descriptor, type, roomId, userId, params);
        break;
      case C.MEDIA_TYPE.RECORDING:
        mediaSession = this._createRecordingSession(descriptor, type, roomId, userId, params);
        break;
      default:
        throw C.ERROR.MEDIA_INVALID_TYPE;
    }

    return mediaSession;
  }

  createMedia (descriptor, type, roomId, userId, params) {
    let mediaSession;

    switch (type) {
      case C.MEDIA_TYPE.WEBRTC:
      case C.MEDIA_TYPE.RTP:
        mediaSession = this._createSDPMedia(descriptor, type, roomId, userId, params);
        break;
      case C.MEDIA_TYPE.RECORDING:
        mediaSession = this._createRecordingMedia(descriptor, type, roomId, userId, params);
        break;
      default:
        throw C.ERROR.MEDIA_INVALID_TYPE;
    }
  }

  connect (sourceId, sinkId, type) {
    const source = this.getMediaSession(id);
    if (source == null) {
      throw C.ERROR.MEDIA_NOT_FOUND;
    }
    const sink = this.getMediaSession(id);
    if (sink == null) {
      throw C.ERROR.MEDIA_NOT_FOUND;
    }

    return source.connect(sink, type);
  }

  _createSDPSession (sdp, type, roomId, userId, params) {
    return new SDPSession(sdp, roomId, userId, type, params);
  }

  _createRecordingSession (recordingPath, type, roomId, userId, params) {
    return new RecordingSession(roomId, userId, recordingPath, params);
  }

  _createSDPMedia (sdp, type, roomId, userId, params) {
    return new SDPMedia(sdp, roomId, userId, type, params);
  }

  _createRecordingMedia (recordingPath, type, roomId, userId, params) {
    return new RecordingMedia(roomId, userId, recordingPath, params);
  }
}

const MF = new MediaFactory();

module.exports = MF;

const SDPSession = require('../model/sdp-session.js');
const RecordingSession = require('../model/recording-session.js');
const SDPMedia = require('../model/sdp-media.js');
const RecordingMedia = require('../model/recording-media.js');
