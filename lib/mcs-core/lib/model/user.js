/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const config = require('config');
const rid = require('readable-id');
const C = require('../constants/constants.js');
const Logger = require('../utils/logger.js');
const MediaFactory = require('../media/media-factory.js');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter');
const { handleError } = require('../utils/util.js');
const StrategyManager = require('../media/strategy-manager.js');
const { perUser: USER_MEDIA_THRESHOLD } = config.get('mediaThresholds');

const LOG_PREFIX = "[mcs-user]";

module.exports = class User {
  constructor(roomId, type, clientTrackingId, params = {}) {
    this.id = params.userId? params.userId : rid();
    this.roomId = roomId;
    this.type = type;
    this.name = params.name ? params.name : this.id;
    this.mediaSessions = {}
    this._strategy = params.strategy || C.STRATEGIES.FREEWILL;
    this._clientTrackingIds = {};
    this.addClientTrackingId(clientTrackingId);

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

  addClientTrackingId (clientTrackingId = C.USERS.INTERNAL_TRACKING_ID) {
    if (this._clientTrackingIds[clientTrackingId] == null) {
      this._clientTrackingIds[clientTrackingId] = 1;
      return;
    }

    this._clientTrackingIds[clientTrackingId] += 1

  }

  hasClientTrackingId (clientTrackingId) {
    return this._clientTrackingIds[clientTrackingId];
  }

  deleteClientTrackingId (clientTrackingId) {
    if (this._clientTrackingIds[clientTrackingId]) {
      const numberOfBindedClients = --this._clientTrackingIds[clientTrackingId];
      if (numberOfBindedClients <= 0) {
        delete this._clientTrackingIds[clientTrackingId];
      }
    }
    const remainingClients = Object.keys(this._clientTrackingIds);
    return remainingClients;
  }

  _startSession (sessionId) {
    const session = this.mediaSessions[sessionId];
    try {
      session.start();
      return session.process();
    } catch (error) {
      this.stopSession(sessionId).catch(error => {
        Logger.error(LOG_PREFIX, `CRITICAL: error when rolling back failed session start`,
          { mediaSessionId: sessionId, coreUserInfo: this.getUserInfo() })
      });
      throw error;
    }
  }

  isAboveThreshold () {
    if (USER_MEDIA_THRESHOLD > 0) {
      const nofMediaUnits = Object.keys(this.mediaSessions).map(key => {
        let mi = this.mediaSessions[key].getMediaInfo();
        return mi;
      }).length;
      if (nofMediaUnits >= USER_MEDIA_THRESHOLD) {
        Logger.error(LOG_PREFIX, `User has exceeded the media threshold`,
          { userId: this.id, threshold: USER_MEDIA_THRESHOLD, current: nofMediaUnits }
        );
        return true;
      }
    }
    return false;
  }

  createMediaSession (descriptor, type, params = {}) {
    const { mediaId } = params;

    // A mediaId was passed as an optional parameter. This means we're probably
    // handling a media that already exists. Fetch it, set the remote descriptor
    // for processing and let it handle itself.
    // If it doesn't exist, just create a new one since it's an optional parameter
    // which should be ignored in case it doesn't make sense
    if (mediaId) {
      const targetMediaSession = this.mediaSessions[mediaId];
      if (targetMediaSession) {
        Logger.debug("[mcs-sfu-user] Endpoint", mediaId, "should be renegotiated", descriptor);
        targetMediaSession.remoteDescriptor = descriptor;
        return targetMediaSession;
      }
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
        // If there's no source media specs, fetch the source's media specs to
        // make the subscriber match it
        if (source.mediaSpecs && (params.mediaSpecs == null || params.mediaSpecSlave)) {
          Logger.info(LOG_PREFIX, `Subscribe from user ${this.id} to source ${source.id} has media spec slaved`);
          params.mediaSpecs = source.mediaSpecs;
        }

        const session = this.createMediaSession(sdp, type, params);
        const answer = await this._startSession(session.id);

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

  async publish (sdp, type, params) {
    try {
      const session = this.createMediaSession(sdp, type, params);
      const answer = await this._startSession(session.id);
      return ({ session, answer });
    }
    catch (error) {
      Logger.error(LOG_PREFIX, `Publish failed`,
        { coreUserInfo: this.getUserInfo(), error });
      throw (this._handleError(error));
    }
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
    const answer = await this._startSession(recordingSession.id);
    return ({ recordingSession, answer });
  }

  stopSession (sessionId) {
    const session = this.mediaSessions[sessionId];
    try {
      if (session) {
        Logger.info(LOG_PREFIX, `Stopping media session ${sessionId}`);
        delete this.mediaSessions[sessionId];
        return session.stop();
      }
      return Promise.resolve();
    }
    catch (err) {
      throw (this._handleError(err));
    }
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

  leave () {
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

      return sessions;
    }
    catch (err) {
      throw (this._handleError(err));
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

  _trackMediaDisconnection (mediaSession) {
    const deleteMedia = async (mediaInfo) => {
      const { memberType, mediaSessionId } = mediaInfo;
      if (memberType === C.MEMBERS.MEDIA_SESSION && mediaSessionId === mediaSession.id) {
        Logger.info(LOG_PREFIX, `User's media session stopped due to an internal trigger.`,
          { userId: this.id, mediaSessionId });
        try {
          await mediaSession.stop();
        } catch (e) {
          Logger.error(LOG_PREFIX, `Failed to stop session ${mediaSessionId} on child media disconnection. Cleaning it and emitting the disconnection event on its behalf`);
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
