/**
 * @classdesc
 * Model class for external devices
 */

'use strict'


const rid = require('readable-id');
const C = require('../constants/constants.js');
const Logger = require('../utils/logger');
const SdpSession = require('../model/sdp-session');
const RecordingSession = require('../model/recording-session');
const UriSession = require('../model/uri-session');
const { handleError } = require('../utils/util');

const LOG_PREFIX = "[mcs-user]";

module.exports = class User {
  constructor(roomId, type, emitter, name = 'default') {
    this.id = rid();
    this.roomId = roomId;
    this.type = type;
    this.name = name;
    this.emitter = emitter;
    this._mediaSessions = {}
  }

  addSdp (sdp, type, params) {
    // TODO switch from type to children SdpSessions (WebRTC|SDP)
    const { mediaId } = params;
    if (mediaId && this._mediaSessions[mediaId]) {
      Logger.debug("[mcs-sfu-user] Endpoint", mediaId, "should be renegotiated");
      this._mediaSessions[mediaId].setOffer(sdp);
      return this._mediaSessions[mediaId];
    }

    const session = new SdpSession(this.emitter, sdp, this.roomId, this.id, type, params);
    this._trackMediaDisconnection(session);
    this._mediaSessions[session.id] = session;

    Logger.info("[mcs-sfu-user] Added new SDP session", session.id, "to user", this.id);

    return session;
  }

  addRecording (recordingPath) {
    try {
      const session = new RecordingSession(this.emitter, this.roomId, this.id, recordingPath);
      this.emitter.emit(C.EVENT.NEW_SESSION+this.id, session.id);
      this._trackMediaDisconnection(session);
      this._mediaSessions[session.id] = session;
      Logger.info("[mcs-sfu-user] Added new recording session", session.id, "to user", this.id);

      return session;
    }
    catch (err) {
      this._handleError(err);
    }
  }


  startSession (sessionId) {
    const session = this._mediaSessions[sessionId];
    return new Promise(async (resolve, reject) => {
      try {
        const mediaElement = await session.start();
        const answer = await session.process();
        resolve(answer);
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  subscribe (sdp, type, source, params = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        const session = this.addSdp(sdp, type, params);
        const answer = await this.startSession(session.id);
        let connectionType;
        if (params.content) {
          connectionType = 'CONTENT';
        }

        if (source !== 'default') {
          await source.connect(session, connectionType);
        }
        resolve({ session, answer });
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  publish (sdp, type, params) {
    return new Promise(async (resolve, reject) => {
      try {
        const session = this.addSdp(sdp, type, params);
        const answer = await this.startSession(session.id);
        resolve({ session, answer });
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  unsubscribe (mediaId) {
    return new Promise(async (resolve, reject) => {
      try {
        await this.stopSession(mediaId);
        resolve(mediaId);
      }
      catch (err) {
        reject(this._handleError(err));
      }
    });
  }

  unpublish (mediaId) {
    return new Promise(async (resolve, reject) => {
      try {
        await this.stopSession(mediaId);
        resolve(mediaId);
      }
      catch (err) {
        reject(this._handleError(err));
      }
    });
  }

  stopSession (sessionId) {
    const session = this._mediaSessions[sessionId];

    return new Promise(async (resolve, reject) => {
      try {
        if (session) {
          Logger.info("[mcs-sfu-user] Stopping session => " + sessionId);
          await session.stop();
          delete this._mediaSessions[sessionId];
        }

        return resolve(sessionId);
      }
      catch (err) {
        reject(this._handleError(err));
      }
    });
  }

  connect (sourceId, sinkId) {
    const source = this._mediaSessions[sourceId];
    const sink = this._mediaSessions[sinkId];

    return new Promise(async (resolve, reject) => {
      try {
        if (source == null) {
          return reject(this._handleError(C.ERROR.MEDIA_NOT_FOUND));
        }
        Logger.info("[mcs-sfu-user] Connecting sessions " + sourceId + "=>" + sinkId);
        await source.connect(sink);
        return resolve();
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  async leave () {
    const sessions = Object.keys(this._mediaSessions);
    let stopProcedures = [];
    Logger.info("[mcs-sfu-user] User sessions will be killed");

    try {
      for (let i = 0; i < sessions.length; i++) {
        stopProcedures.push(this.stopSession(sessions[i]));
      }

      return Promise.all(stopProcedures);
    }
    catch (err) {
      err = this._handleError(err);
      Promise.reject(err);
    }
  }

  getUserInfo () {
    const mediasList = Object.keys(this._mediaSessions).map(key => {
      let mi = this._mediaSessions[key].getMediaInfo();
      return mi;
    });

    const userInfo = {
      userId: this.id,
      name: this.name,
      type: this.type,
      roomId: this.roomId,
      mediasList,
    };

    return userInfo;
  }

  getUserMedias () {
    const userMedias = Object.keys(this._mediaSessions).map(mk => this._mediaSessions[mk].getMediaInfo());
    return userMedias;
  }

  _trackMediaDisconnection(media) {
    media.emitter.once(C.EVENT.MEDIA_DISCONNECTED, (mediaId) => {
      if (mediaId === media.id) {
        Logger.info("[mcs-user] Media stopped.");
        delete this._mediaSessions[mediaId] ;
      }
    });
  }

  _handleError (error) {
    return handleError(LOG_PREFIX, error);
  }
}
