/**
 * @classdesc
 * Model class for external devices
 */

'use strict'


const rid = require('readable-id');
const C = require('../constants/constants.js');
const Logger = require('../utils/logger.js');
const MediaFactory = require('../media/media-factory.js');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter');
const { handleError } = require('../utils/util.js');
const StrategyManager = require('../media/strategy-manager.js');

const LOG_PREFIX = "[mcs-user]";

module.exports = class User {
  constructor(roomId, type, params = {}) {
    this.id = params.userId? params.userId : rid();
    this.roomId = roomId;
    this.type = type;
    this.name = params.name ? params.name : this.id;
    this.mediaSessions = {}
    this._strategy = params.strategy || C.STRATEGIES.FREEWILL;
  }

  set strategy (strategy) {
    if (!StrategyManager.isValidStrategy(strategy)) {
      throw C.ERROR.MEDIA_INVALID_TYPE;
    }

    this._strategy = strategy;

    GLOBAL_EVENT_EMITTER.emit(C.EVENT.STRATEGY_CHANGED, this.getUserInfo());
  }

  get strategy () {
    return this._strategy;
  }

  startSession (sessionId) {
    const session = this.mediaSessions[sessionId];
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
    if (mediaId && this.mediaSessions[mediaId]) {
      Logger.debug("[mcs-sfu-user] Endpoint", mediaId, "should be renegotiated");
      this.mediaSessions[mediaId].setOffer(descriptor);
      return this.mediaSessions[mediaId];
    }

    // Inherit strategy from user unless it was directly specified
    params.strategy = params.strategy || this.strategy;

    const mediaSession = MediaFactory.createMediaSession(
      descriptor,
      type,
      this.roomId,
      this.id,
      params
    );

    this._trackMediaDisconnection(mediaSession);
    this.mediaSessions[mediaSession.id] = mediaSession;

    Logger.info("[mcs-sfu-user] Added new SDP session", mediaSession.id, "to user", this.id);

    return mediaSession;
  };

  subscribe (sdp, type, source, params = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        // Fetch the source media specs to make the subscriber match it
        params.mediaSpecs = source.mediaSpecs;

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
    const session = this.mediaSessions[sessionId];

    return new Promise(async (resolve, reject) => {
      try {
        if (session) {
          Logger.info("[mcs-sfu-user] Stopping session => " + sessionId);
          await session.stop();
          delete this.mediaSessions[sessionId];
        }

        return resolve(sessionId);
      }
      catch (err) {
        reject(this._handleError(err));
      }
    });
  }

  connect (sourceId, sinkId) {
    const source = this.mediaSessions[sourceId];
    const sink = this.mediaSessions[sinkId];

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
    const sessions = Object.keys(this.mediaSessions);
    Logger.info("[mcs-sfu-user] User", this.id, "wants to leave and its media sessions will be killed");

    try {
      sessions.forEach(async sk => {
        try {
          await this.stopSession(sk);
        } catch (e) {
          // Error on stopping, it was probably a MEDIA_NOT_FOUND error, hence
          // we just delete the session if it's still allocated
          this._handleError(e);
          if (this.mediaSessions[sk]) {
            delete this.mediaSessions[sk];
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

  getMediaSession (id) {
    return this.mediaSessions[id];
  }

  getUserInfo () {
    const mediasList = Object.keys(this.mediaSessions).map(key => {
      let mi = this.mediaSessions[key].getMediaInfo();
      return mi;
    });

    const userInfo = {
      memberType: C.MEMBERS.USER,
      userId: this.id,
      name: this.name,
      type: this.type,
      roomId: this.roomId,
      strategy: this.strategy,
      mediasList,
    };

    return userInfo;
  }

  getUserMedias () {
    const userMedias = Object.keys(this.mediaSessions).map(mk => this.mediaSessions[mk].getMediaInfo());
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
          GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_DISCONNECTED, mediaSession.getMediaInfo());
        }

        delete this.mediaSessions[mediaSessionId] ;
        GLOBAL_EVENT_EMITTER.removeListener(C.EVENT.MEDIA_DISCONNECTED, deleteMedia);
      }
    };

    GLOBAL_EVENT_EMITTER.on(C.EVENT.MEDIA_DISCONNECTED, deleteMedia);
  }

  _handleError (error) {
    return handleError(LOG_PREFIX, error);
  }
}
