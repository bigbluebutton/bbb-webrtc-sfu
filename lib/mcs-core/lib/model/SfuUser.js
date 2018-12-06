/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const User = require('./User');
const C = require('../constants/Constants');
const SdpWrapper = require('../utils/SdpWrapper');
const SdpSession = require('../model/SdpSession');
const RecordingSession = require('../model/RecordingSession');
const UriSession = require('../model/UriSession');
const Logger = require('../../../utils/Logger');
const isError = require('../utils/util').isError;

module.exports = class SfuUser extends User {
  constructor(roomId, type, emitter) {
    super(roomId, type, emitter);
  }

  // TODO switch from type to children UriSessions (RTSP|HTTP|etc)
  async addUri (uri, type) {
    const session = new UriSession(uri, type);
    this.emitter.emit(C.EVENT.NEW_SESSION+this.id, session.id);
    this._trackMediaDisconnection(session);
    this._mediaSessions[session.id] = session;

    Logger.info("[mcs-sfu-user] Added new URI session", session.id, "to user", this.id);

    return session;
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
}
