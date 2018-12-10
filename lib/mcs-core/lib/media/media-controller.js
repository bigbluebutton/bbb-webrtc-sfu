'use strict'

const config = require('config');
const C = require('../constants/constants');
const Logger = require('../utils/logger');
const User = require('../model/user');
const Room = require('../model/room');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter');
const { handleError } = require('../utils/util');
const LOG_PREFIX = "[mcs-controller]";

/* PUBLIC ELEMENTS */

let instance = null;

module.exports = class MediaController {
  constructor() {
    if (!instance) {
      this.emitter = GLOBAL_EVENT_EMITTER;
      this._rooms = {};
      this._users = {};
      this._mediaSessions = {};
      instance = this;
    }

    return instance;
  }

  start (_kurentoClient, _kurentoToken, callback) {
    // TODO
    return callback(null);
  }

  stop (callback) {
    // TODO
  }

  async join (roomId, type, params) {
    Logger.info("[mcs-controller] Join room => " + roomId + ' as ' + type);
    try {
      let session;
      const room = await this.createRoomMCS(roomId);
      const user = await this.createUserMCS(roomId, type, params);
      room.setUser(user);

      if (params.sdp) {
        session = user.addSdp(params.sdp);
      }
      if (params.uri) {
        session = user.addUri(params.sdp);
      }

      Logger.info("[mcs-controller] Resolving user " + user.id);
      return Promise.resolve(user.id);
    }
    catch (err) {
      return Promise.reject(this._handleError(err));
    }
  }

  async leave (roomId, userId) {
    Logger.info("[mcs-controller] User => " + userId + " wants to leave ");
    let user, room;

    try {
      room = this.getRoomMCS(roomId);
      user = this.getUserMCS(userId);
    } catch (err) {
      // User or room were already closed or not found, resolving as it is
      Logger.warn('[mcs-controller] Leave for', userId, 'at', roomId, 'failed with error', this._handleError(err));
      return Promise.resolve(err);
    }

    try {
      const killedMedias = await user.leave();

      killedMedias.forEach((mediaId) => {
        delete this._mediaSessions[mediaId];
      });

      room.destroyUser(user.id);
      delete this._users[user.id];

      Logger.trace('[mcs-controller] Active media sessions', Object.keys(this._mediaSessions));
      Logger.trace("[mcs-controller] Active users", Object.keys(this._users));

      return Promise.resolve();
    }
    catch (err) {
      return Promise.reject(this._handleError(err));
    }
  }

  publishAndSubscribe (roomId, userId, sourceId, type, params = {}) {
    return new Promise(async (resolve, reject) => {
      Logger.info("[mcs-controller] PublishAndSubscribe from user", userId, "to source", sourceId);
      Logger.trace("[mcs-controler] PublishAndSubscribe descriptor is", params.descriptor);

      try {
        const user = await this.getUserMCS(userId);
        let source;
        if (sourceId === 'default') {
          source = this._mediaSessions[Object.keys(this._mediaSessions)[0]];
        }

        Logger.info("[mcs-controller] Fetched user", user.id);

        type = C.EMAP[type];

        switch (type) {
          case C.MEDIA_TYPE.RTP:
          case C.MEDIA_TYPE.WEBRTC:
          case C.MEDIA_TYPE.URI:
            const { session, answer } = await user.publish(params.descriptor, type, params);
            this.addMediaSession(session);

            resolve({ descriptor: answer, mediaId: session.id });
            session.sessionStarted();
            if (source) {
              await user.connect(source.id, session.id);
            }
            break;

          default:
            return reject(this._handleError(C.ERROR.MEDIA_INVALID_TYPE));
        }
      }
      catch (err) {
        reject(this._handleError(err));
      }
    });
  }

  publish (userId, roomId, type, params = {}) {
    return new Promise(async (resolve, reject) => {
      Logger.info("[mcs-controller] Publish from user", userId, "to room", roomId);
      Logger.trace("[mcs-controler] Publish descriptor is", params.descriptor);

      try {
        const user = await this.getUserMCS(userId);

        Logger.info("[mcs-controller] Fetched user", user.id);

        type = C.EMAP[type];

        switch (type) {
          case C.MEDIA_TYPE.RTP:
          case C.MEDIA_TYPE.WEBRTC:
          case C.MEDIA_TYPE.URI:
            const { session, answer } = await user.publish(params.descriptor, type, params);
            this.addMediaSession(session);
            resolve({ descriptor: answer, mediaId: session.id });
            session.sessionStarted();
            break;

          default:
            return reject(this._handleError(C.ERROR.MEDIA_INVALID_TYPE));
        }
      }
      catch (err) {
        reject(this._handleError(err));
      }
    });
  }

  subscribe (userId, sourceId, type, params = {}) {
    return new Promise(async (resolve, reject) => {
      Logger.info("[mcs-controller] Subscribe from user", userId, "to source", sourceId);
      Logger.trace("[mcs-controler] Subscribe descriptor is", params.descriptor);

      try {
        let source;
        const user = await this.getUserMCS(userId);
        const room = await this.getRoomMCS(user.roomId);
        if (sourceId === 'content') {
          source = this.getMediaSession(room._contentFloor.id);
          params.content = true;
        } else {
          source = this.getMediaSession(sourceId);
        }

        Logger.info("[mcs-controller] Fetched user", user.id);

        type = C.EMAP[type];

        switch (type) {
          case C.MEDIA_TYPE.RTP:
          case C.MEDIA_TYPE.WEBRTC:
          case C.MEDIA_TYPE.URI:
            const  { session, answer } = await user.subscribe(params.descriptor, type, source, params);
            this.addMediaSession(session);
            source.subscribedSessions.push(session.id);
            resolve({descriptor: answer, mediaId: session.id});
            session.sessionStarted();
            Logger.trace("[mcs-controller] Updated", source.id,  "subscribers list to", source.subscribedSessions);
            break;
          default:
            return reject(this._handleError(C.ERROR.MEDIA_INVALID_TYPE));
        }
      }
      catch (err) {
        reject(this._handleError(err));
      }
    });
  }

  async unpublish (userId, mediaId) {
    try {
      const user = this.getUserMCS(userId);
      const answer = await user.unpublish(mediaId);
      delete this._mediaSessions[mediaId];
      Logger.trace('[mcs-controller] Active media sessions', Object.keys(this._mediaSessions));
      return Promise.resolve(answer);
    }
    catch (err) {
      err = this._handleError(err);
      return Promise.reject(this._handleError(err));
    }
  }

  async unsubscribe (userId, mediaId) {
    try {
      const user = this.getUserMCS(userId);
      const answer = await user.unsubscribe(mediaId);
      delete this._mediaSessions[mediaId];
      Logger.trace('[mcs-controller] Active media sessions', Object.keys(this._mediaSessions));
      return Promise.resolve();
    }
    catch (err) {
      return Promise.reject(this._handleError(err));
    }
  }

  startRecording (userId, sourceId, recordingPath, params) {
    return new Promise(async (resolve, reject) => {
      try {
        Logger.info("[mcs-controller] startRecording ", sourceId);
        const user = await this.getUserMCS(userId);
        const sourceSession = this.getMediaSession(sourceId);

        const { recordingSession, answer } = await user.startRecording(recordingPath, C.MEDIA_TYPE.RECORDING, sourceSession, params);

        sourceSession.subscribedSessions.push(recordingSession.id);
        this._mediaSessions[recordingSession.id] = recordingSession;

        resolve(answer);
        recordingSession.sessionStarted();
      }
      catch (err) {
        reject(this._handleError(err));
      }
    });
  }

  async stopRecording (userId, recId) {
    return new Promise(async (resolve, reject) => {
      Logger.info("[mcs-controller] Stopping recording session", recId);
      try {
        const user = await this.getUserMCS(userId);
        const recSession = this.getMediaSession(recId);

        const answer = await user.stopSession(recSession.id);
        user.unsubscribe(recSession.id);
        this._mediaSessions[recId] = null;
        return resolve(answer);
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  connect (sourceId, sinkId, type) {
    return new Promise(async (resolve, reject) => {
      Logger.info("[mcs-controller] Connect", sourceId, "to", sinkId, "with type", type);

      try {
        const sourceSession = this.getMediaSession(sourceId);
        const sinkSession = this.getMediaSession(sinkId);

        await sourceSession.connect(sinkSession, type);
        return resolve();
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  disconnect (sourceId, sinkId, type) {
    return new Promise(async (resolve, reject) => {
      try {
        Logger.info("[mcs-controller] Disconnect", sourceId, "to", sinkId, "with type", type);
        const sourceSession = this.getMediaSession(sourceId);
        const sinkSession = this.getMediaSession(sinkId);

        await sourceSession.disconnect(sinkSession._mediaElement, type);
        return resolve();
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  addIceCandidate (mediaId, candidate) {
    return new Promise(async (resolve, reject) => {
      try {
        const session = this.getMediaSession(mediaId);
        await session.addIceCandidate(candidate);

        return resolve();
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  onEvent (eventName, identifier) {
    try {
      const mappedEvent = C.EMAP[eventName]? C.EMAP[eventName] : eventName;
      switch (mappedEvent) {
        case C.EVENT.MEDIA_STATE.MEDIA_EVENT:
        case C.EVENT.MEDIA_STATE.ICE:
          const session = this.getMediaSession(identifier);
          session.onEvent(mappedEvent);
          break;
        case C.EVENT.MEDIA_CONNECTED:
        case C.EVENT.MEDIA_DISCONNECTED:
        case C.EVENT.USER_JOINED:
        case C.EVENT.USER_LEFT:
        case C.EVENT.ROOM_CREATED:
        case C.EVENT.ROOM_DESTROYED:
        case C.EVENT.CONTENT_FLOOR_CHANGED:
        case C.EVENT.CONFERENCE_FLOOR_CHANGED:
          // TODO refactor
          break;
        default: Logger.trace("[mcs-controller] Invalid event subscription", mappedEvent, identifier);
      }
    }
    catch (err) {
      throw this._handleError(err);
    }
  }

  /**
   * Creates an empty {Room} room and indexes it
   * @param {String} roomId
   */
  async createRoomMCS (roomId)  {
    Logger.info("[mcs-controller] Creating new room with ID", roomId);

    if (this._rooms[roomId] == null) {
      this._rooms[roomId] = new Room(roomId);
      this.emitter.emit(C.EVENT.ROOM_CREATED, this._rooms[roomId].id);
    }

    return Promise.resolve(this._rooms[roomId]);
  }

  /**
   * Creates an {User} of type @type
   * @param {String} roomId
   */
  createUserMCS (roomId, type, params)  {
    let user;
    Logger.info("[mcs-controller] Creating a new", type, "user at room", roomId);

    user  = new User(roomId, type);

    if(this._users[user.id] == null) {
      this._users[user.id] = user;
    }

    return Promise.resolve(user);
  }

  getRoomMCS (roomId) {
    const room = this._rooms[roomId];

    if (room == null) {
      throw C.ERROR.ROOM_NOT_FOUND;
    }

    return room;
  }

  getUserMCS (userId) {
    const user = this._users[userId];

    if (user == null) {
      throw C.ERROR.USER_NOT_FOUND;
    }

    return user;
  }

  destroyRoomMCS (roomId) {
    const room = this._rooms[roomId];

    if (room == null) {
      throw C.ERROR.ROOM_NOT_FOUND;
    }

    this.emitter.emit(C.EVENT.ROOM_DESTROYED, room.id);
    this._rooms[roomId] = undefined;

    return room;
  }

  getRooms () {
    try {
      return Object.keys(this._rooms);
    } catch (err) {
      throw err;
    }
  }

  async getUsers (roomId) {
    try {
      const room = this.getRoomMCS(roomId);
      const users = await room.getUsers();
      return users;
    } catch (err) {
      throw err;
    }
  }

  getMediaSession (mediaId) {
    const media = this._mediaSessions[mediaId];

    // Automatic source
    if (mediaId == 'default') {
      return mediaId;
    }

    if (media == null) {
      throw C.ERROR.MEDIA_NOT_FOUND;
    }

    return media;
  }

  getUserMedias (userId) {
    try {
      const user = this.getUserMCS(userId);
      const medias = user.getUserMedias();
      return medias;
    } catch (err) {
      throw err;
    }
  }

  addMediaSession (session) {
    this._mediaSessions[session.id] = session;
  }

  setContentFloor(roomId, mediaId) {
    return new Promise(async (resolve, reject) => {
      try {
        const room = await this.getRoomMCS(roomId);
        const media = this.getMediaSession(mediaId);
        Logger.info('[mcs-controller] Fetched room', room.id, 'and media', media.id);
        const mediaInfo = room.setContentFloor(media);
        resolve(mediaInfo);
      }
      catch (error) {
        reject(this._handleError(error));
      }
    })
  }

  setConferenceFloor(roomId, mediaId) {
    return new Promise(async (resolve, reject) => {
      try {
        const room = await this.getRoomMCS(roomId);
        const media = this.getMediaSession(mediaId);
        Logger.info('[mcs-controller] Fetched room', room.id, 'and media', media.id);
        const mediaInfo = room.setConferenceFloor(media);
        resolve(mediaInfo);
      }
      catch (error) {
        reject(this._handleError(error))
      }
    })
  }

  releaseContentFloor(roomId, mediaId) {
    return new Promise(async (resolve, reject) => {
      try {
        const room = await this.getRoomMCS(roomId);
        Logger.info('[mcs-controller] Fetched room', room.id);
        room.releaseContentFloor(mediaId);
        resolve();
      }
      catch (error) {
        reject(this._handleError(error));
      }
    })
  }

  releaseConferenceFloor(roomId, mediaId) {
    return new Promise(async (resolve, reject) => {
      try {
        const room = await this.getRoomMCS(roomId);
        Logger.info('[mcs-controller] Fetched room', room.id);
        room.releaseConferenceFloor(mediaId);
        resolve();
      }
      catch (error) {
        reject(this._handleError(error));
      }
    })
  }

  getContentFloor(roomId) {
    return new Promise(async (resolve, reject) => {
      try {
        const room = await this.getRoomMCS(roomId);
        Logger.info('[mcs-controller] Fetched room', room.id);
        resolve(room.getContentFloor());
      }
      catch (error) {
        reject(this._handleError(error));
      }
    })
  }

  getConferenceFloor(roomId) {
    return new Promise(async (resolve, reject) => {
      try {
        const room = await this.getRoomMCS(roomId);
        Logger.info('[mcs-controller] Fetched room', room.id);
        resolve(room.getConferenceFloor());
      }
      catch (error) {
        reject(this._handleError(error));
      }
    })
  }

  _handleError (error) {
    return handleError(LOG_PREFIX, error);
  }
}
