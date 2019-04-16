'use strict';

const EventEmitter = require('events').EventEmitter;
const Logger = require('../utils/logger.js');
const C = require('../constants/constants.js');
const SDPSession = require('../model/sdp-session.js');
const RecordingSession = require('../model/recording-session.js');
const URISession = require('../model/uri-session.js');
const SDPMedia = require('../model/sdp-media.js');
const RecordingMedia = require('../model/recording-media.js');
const URIMedia = require('../model/uri-media.js');

let instance = null;

class MediaFactory extends EventEmitter {
  constructor () {
    super();
    if (instance == null) {
      instance = this;
      this.medias = [];
    }
    return instance;
  }

  getMedia (id) {
    return this.medias.find(m => m.id === id);
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
      case C.MEDIA_TYPE.URI:
        mediaSession = this._createURISession(descriptor, type, roomId, userId, params);
        break;
      default:
        throw C.ERROR.MEDIA_INVALID_TYPE;
    }

    this.medias.push(mediaSession);
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
      case C.MEDIA_TYPE.URI:
        mediaSession = this._createURIMedia(descriptor, type, roomId, userId, params);
        break;
      default:
        throw C.ERROR.MEDIA_INVALID_TYPE;
    }

    this.medias.push(mediaSession);
  }

  connect (sourceId, sinkId, type) {
    const source = this._getMedia(id);
    if (source == null) {
      throw C.ERROR.MEDIA_NOT_FOUND;
    }
    const sink = this._getMedia(id);
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

  _createURISession (uri, type, roomId, userId, params) {
    return new URISession(roomId, userId, recordingPath);
  }

  _createSDPMedia (sdp, type, roomId, userId, params) {
    return new SDPMedia(sdp, roomId, userId, type, params);
  }

  _createRecordingMedia (recordingPath, type, roomId, userId, params) {
    return new RecordingMedia(roomId, userId, recordingPath, params);
  }

  _createURIMedia (uri, type, roomId, userId, params) {
    return new URIMedia(roomId, userId, recordingPath);
  }
}

module.exports = new MediaFactory();
