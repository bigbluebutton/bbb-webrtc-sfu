'use strict';

const EventEmitter = require('events').EventEmitter;
const C = require('../constants/constants.js');

let instance = null;

class MediaFactory extends EventEmitter {
  constructor () {
    super();
    if (instance == null) {
      this.mediaSessions = new Map();
      this.medias = new Map();
      instance = this;
    }
    return instance;
  }

  hasMediaSession (mediaSessionId) {
    return this.mediaSessions.has(mediaSessionId);
  }

  addMediaSession (mediaSession) {
    if (!this.hasMediaSession(mediaSession.id)) {
      this.mediaSessions.set(mediaSession.id, mediaSession);
    }
    mediaSession.medias.forEach(this.addMedia.bind(this));
  }

  getMediaSession (mediaSessionId) {
    return this.mediaSessions.get(mediaSessionId);
  }

  getMediaSessionOrUnit (mediaId) {
    let media = this.getMediaSession(mediaId);

    // Not found by ID, try fetching the father session of a media unit
    if (media == null) {
      return this.getMedia(mediaId);
    }
  }

  getNumberOfMediaSessions () {
    return this.mediaSessions.size;
  }

  removeMediaSession (mediaSessionId) {
    const mediaSession = this.getMediaSession(mediaSessionId);
    if (mediaSession) {
      mediaSession.medias.forEach(this.removeMedia.bind(this));
      this.mediaSessions.delete(mediaSessionId);
    }
  }

  hasMedia (mediaId) {
    return this.medias.has(mediaId);
  }

  addMedia (media) {
    if (!this.hasMedia(media.id)) {
      this.medias.set(media.id, media);
    }
  }

  getMedia (mediaId) {
    return this.medias.get(mediaId);
  }

  getNumberOfMedias () {
    return this.mediaSessions.size;
  }

  removeMedia (media) {
    return this.medias.delete(media.id);
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

    return mediaSession;
  }

  connect (sourceId, sinkId, type) {
    const source = this.getMediaSession(sourceId);
    if (source == null) {
      throw C.ERROR.MEDIA_NOT_FOUND;
    }
    const sink = this.getMediaSession(sinkId);
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
