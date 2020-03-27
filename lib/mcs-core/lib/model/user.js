/**
 * @classdesc
 * Model class for external devices
 */

'use strict'

const config = require('config');
const rid = require('readable-id');
const EventEmitter = require('events').EventEmitter;
const C = require('../constants/constants.js');
const Logger = require('../utils/logger.js');
const MediaFactory = require('../media/media-factory.js');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter');
const { handleError } = require('../utils/util.js');
const StrategyManager = require('../media/strategy-manager.js');
const { perUser: USER_MEDIA_THRESHOLD } = config.get('mediaThresholds');

const LOG_PREFIX = "[mcs-user]";

module.exports = class User extends EventEmitter  {
  constructor(roomId, type, params = {}) {
    super();
    this.id = rid();
    this.externalUserId = params.externalUserId || this.id;
    this.autoLeave = typeof params.autoLeave !== 'undefined'? params.autoLeave : false;
    this.roomId = roomId;
    this.type = type;
    this.name = params.name ? params.name : this.id;
    this.mediaSessions = {}
    this._strategy = params.strategy || C.STRATEGIES.FREEWILL;
    this._clientTrackingIds = {};
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

  async _startSession (sessionId) {
    const session = this.mediaSessions[sessionId];
    try {
      session.start();
      const answer = await session.process();
      return answer;
    } catch (error) {
      return this.stopSession(sessionId)
        .then(() => {
          Logger.info(LOG_PREFIX, `Media session ${sessionId} stopped and rolled back due to ${error.message}`,
            { userId: this.id, roomId: this.roomId, mediaSessionId: sessionId, error });
          throw error;
        })
        .catch(rollbackError => {
          Logger.error(LOG_PREFIX, `CRITICAL: stop and rollback for ${sessionId} failed due to ${rollbackError.message}`,
            { userId: this.id, roomId: this.roomId, mediaSessionId: sessionId, error: rollbackError});
          throw error;
        });
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
          { userId: this.id, roomId: this.roomId, threshold: USER_MEDIA_THRESHOLD, current: nofMediaUnits }
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
        const updatedParams = { ...targetMediaSession.options, ...params };
        targetMediaSession.remoteDescriptor = descriptor;
        targetMediaSession.processOptionalParameters(updatedParams);
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

  async subscribe (sdp, type, source, params = {}) {
    const connectionType = params.content? C.CONNECTION_TYPE.CONTENT : C.CONNECTION_TYPE.ALL;

    if (source.mediaSpecs && (params.mediaSpecs == null || params.mediaSpecSlave)) {
      Logger.info(LOG_PREFIX, `Subscribe from user ${this.id} has media spec slaved`);
      params.mediaSpecs = source.mediaSpecs;
    }

    try {
      // If there's no source media specs, fetch the source's media specs to
      // make the subscriber match it
      const session = this.createMediaSession(sdp, type, params);
      const answer = await this._startSession(session.id);

      // Connect must work in a subscribe, so it's shoved into the negotiation
      // try-catch to make the whole call fail if it fails
      if (source !== 'default') {
        await source.connect(session, connectionType);
      }

      return ({ session, answer });
    } catch (error) {
      Logger.error(LOG_PREFIX, `Subscribe from user ${this.id} failed due to ${error.message}`,
        { userId: this.id, roomId: this.roomId, error });
      throw (this._handleError(error));
    }
  }

  async publish (sdp, type, params) {
    try {
      const session = this.createMediaSession(sdp, type, params);
      const answer = await this._startSession(session.id);
      return ({ session, answer });
    } catch (error) {
      Logger.error(LOG_PREFIX, `Publish from user ${this.id} failed due to ${error.message}`,
        { error });
      throw (this._handleError(error));
    }
  }

  unsubscribe (mediaId) {
    return this.stopSession(mediaId);
  }

  unpublish (mediaId) {
    return this.stopSession(mediaId);
  }

  async startRecording (recordingPath, type, source, params = {}) {
    try {
      params.sourceMedia = source;
      const recordingSession = this.createMediaSession(recordingPath, type, params);
      const answer = await this._startSession(recordingSession.id);
      return ({ recordingSession, answer });
    } catch (error) {
      Logger.error(LOG_PREFIX, `startRecording from user ${this.id} of rec ${source.id} failed due to ${error.message}`,
        { userId: this.id, roomId: this.roomId, error });
      throw (this._handleError(error));
    }
  }

  _ejectIfNeeded () {
    if (this.autoLeave && Object.keys(this.mediaSessions).length <= 0) {
      Logger.info(LOG_PREFIX, `User ${this.id} has autoLeave on and no medias, will be ejected`,
        { userId: this.id, externalUserId: this.externalUserId, roomId: this.roomId });
      this.emit(C.EVENT.EJECT_USER, this.getUserInfo());
    }
  }

  stopSession (sessionId) {
    const session = this.mediaSessions[sessionId];
    try {
      if (session) {
        Logger.info(LOG_PREFIX, `Stopping media session ${sessionId}`);
        delete this.mediaSessions[sessionId];
        this._ejectIfNeeded();
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

    return sessions.reduce((promise, sk) => {
      return promise.then(() => {
        this.stopSession(sk).catch((e) => {
          // Error on stopping, it was probably a MEDIA_NOT_FOUND error, hence
          // we just delete the session if it's still allocated
          if (this.mediaSessions[sk]) {
            delete this.mediaSessions[sk];
          }
        });
      });
    }, Promise.resolve()).then(() => {
      return sessions;
    }).catch(error => {
      const normalizedError = this._handleError(error);
      Logger.error(LOG_PREFIX, `CRITICAL: unrecoverable error on leave for user ${this.id}: ${normalizedError.message}`,
        { error: normalizedError });
    });
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
      externalUserId: this.externalUserId,
      name: this.name,
      type: this.type,
      roomId: this.roomId,
      strategy: this.strategy,
      mediasList,
    };

    return userInfo;
  }

  getMediaInfos () {
    return Object.keys(this.mediaSessions).map(mk => this.mediaSessions[mk].getMediaInfo());
  }

  _trackMediaDisconnection (mediaSession) {
    const deleteMedia = async (mediaInfo) => {
      const { memberType, mediaSessionId } = mediaInfo;
      if (memberType === C.MEMBERS.MEDIA_SESSION && mediaSessionId === mediaSession.id) {
        Logger.info(LOG_PREFIX, `User's media session stopped due to an internal trigger.`,
          { userId: this.id, mediaSessionId });
        try {
          await mediaSession.stop();
        } catch (error) {
          Logger.error(LOG_PREFIX, `Failed to stop session ${mediaSessionId} on child media disconnection. Cleaning it and emitting the disconnection event on its behalf`,
            { userId: this.id, roomId: this.roomId, mediaSessionId });
          GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_DISCONNECTED, mediaSession.getMediaInfo());
        }

        delete this.mediaSessions[mediaSessionId];
        this._ejectIfNeeded();
        GLOBAL_EVENT_EMITTER.removeListener(C.EVENT.MEDIA_DISCONNECTED, deleteMedia);
      }
    };

    GLOBAL_EVENT_EMITTER.on(C.EVENT.MEDIA_DISCONNECTED, deleteMedia);
  }

  _handleError (error) {
    return handleError(LOG_PREFIX, error);
  }
}
