/**
 * @classdesc
 * Model class for external devices
 */

'use strict'


const rid = require('readable-id');
const C = require('../constants/constants.js');
const Logger = require('../utils/logger');
const MediaFactory = require('../media/media-factory');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter');
const { handleError } = require('../utils/util');

const LOG_PREFIX = "[mcs-user]";

module.exports = class User {
  constructor(roomId, type, params = {}) {
    this.id = rid();
    this.roomId = roomId;
    this.type = type;
    this.name = params.name ? params.name : this.id;
    this._mediaSessions = {}
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
        await this.stopSession(sessionId);
        return reject(this._handleError(err));
      }
    });
  }

  createMediaSession (descriptor, type, params = {}) {
    const { mediaId } = params;
    if (mediaId && this._mediaSessions[mediaId]) {
      Logger.debug("[mcs-sfu-user] Endpoint", mediaId, "should be renegotiated");
      this._mediaSessions[mediaId].setOffer(descriptor);
      return this._mediaSessions[mediaId];
    }

    const mediaSession = MediaFactory.createMediaSession(descriptor, type, this.roomId, this.id, params);

    this._trackMediaDisconnection(mediaSession);
    this._mediaSessions[mediaSession.id] = mediaSession;

    Logger.info("[mcs-sfu-user] Added new SDP session", mediaSession.id, "to user", this.id);

    return mediaSession;
  };

  subscribe (sdp, type, source, params = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        // If there's not source media specs, fetch the source's media specs to
        // make the subscriber match it
        if (params.mediaSpecs == null) {
          params.mediaSpecs = source.mediaSpecs;
        }

        const session = this.createMediaSession(sdp, type, params);
        const answer = await this.startSession(session.id);

        let connectionType;
        if (params.content) {
          connectionType = C.MEDIA_PROFILE.CONTENT;
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
        const session = this.createMediaSession(sdp, type, params);
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

  async startRecording (recordingPath, type, source, params = {}) {
    params.sourceMedia = source;
    const recordingSession = this.createMediaSession(recordingPath, type, params);
    const answer = await this.startSession(recordingSession.id);

    return ({ recordingSession, answer });
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
    Logger.info("[mcs-sfu-user] User", this.id, "wants to leave and its media sessions will be killed");

    try {
      sessions.forEach(async sk => {
        try {
          await this.stopSession(sk);
        } catch (e) {
          // Error on stopping, it was probably a MEDIA_NOT_FOUND error, hence
          // we just delete the session if it's still allocated
          this._handleError(e);
          if (this._mediaSessions[sk]) {
            delete this._mediaSessions[sk];
          }
        }
      });

      return Promise.resolve(sessions);
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

  _trackMediaDisconnection(mediaSession) {
    const deleteMedia = async ({ mediaSessionId }) => {
      if (mediaSessionId === mediaSession.id) {
        Logger.info("[mcs-user] Media", mediaSessionId, "stopped.");
        try {
          await mediaSession.stop();
        } catch (e) {
          Logger.error(LOG_PREFIX, "Failed to stop session", mediaSessionId, "on child media disconnection. Cleaning it and emitting the disconnection event on its behalf");
          GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_DISCONNECTED, {
            roomId: mediaSession.roomId,
            mediaId: mediaSession.id,
            mediaSessionId: mediaSession.id
          });
        }

        delete this._mediaSessions[mediaSessionId] ;
        GLOBAL_EVENT_EMITTER.removeListener(C.EVENT.MEDIA_DISCONNECTED, deleteMedia);
      }
    };

    GLOBAL_EVENT_EMITTER.on(C.EVENT.MEDIA_DISCONNECTED, deleteMedia);
  }

  _handleError (error) {
    return handleError(LOG_PREFIX, error);
  }
}
