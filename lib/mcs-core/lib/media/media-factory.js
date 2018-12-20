'use strict';

const Logger = require('../utils/logger');
const EventEmitter = require('events').EventEmitter;
const C = require('../constants/constants');
const SDPSession = require('../model/sdp-session');
const RecordingSession = require('../model/recording-session');
const URISession = require('../model/uri-session');

let instance = null;

class MediaFactory extends EventEmitter {
  constructor () {
    super();
    if (instance == null) {
      instance = this;
    }
    return instance;
  }

  createMediaSession (descriptor, type, roomId, userId, params) {
    switch (type) {
      case C.MEDIA_TYPE.WEBRTC:
      case C.MEDIA_TYPE.RTP:
        return this._createSDPSession(descriptor, type, roomId, userId, params);
        break;
      case C.MEDIA_TYPE.RECORDING:
        return this._createRecordingSession(descriptor, type, roomId, userId, params);
        break;
      case C.MEDIA_TYPE.URI:
        return this._createURISession(descriptor, type, roomId, userId, params);
        break;
      default:
        throw C.ERROR.MEDIA_INVALID_TYPE;
    }
  }

  _createSDPSession (sdp, type, roomId, userId, params) {
    const session = new SDPSession(sdp, roomId, userId, type, params);
    return session;
  }

  _createRecordingSession (recordingPath, type, roomId, userId, params) {
    const session = new RecordingSession(roomId, userId, recordingPath, params);
    return session;
  }

  _createURISession (uri, type, roomId, userId, params) {
    const session = new URISession(roomId, userId, recordingPath);
    return session;
  }
}

module.exports = new MediaFactory();
