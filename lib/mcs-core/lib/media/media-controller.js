'use strict'

const config = require('config');
const C = require('../constants/constants');
const Logger = require('../utils/logger');
const User = require('../model/user');
const Room = require('../model/room');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter');
const { handleError } = require('../utils/util');
const LOG_PREFIX = "[mcs-controller]";
const Balancer = require('./balancer');

// Fire that balancer
Balancer.upstartHosts();

let instance = null;

module.exports = class MediaController {
  constructor() {
    if (!instance) {
      this.emitter = GLOBAL_EVENT_EMITTER;
      this.rooms = [];
      this.users = [];
      this.mediaSessions = [];
      this.medias = [];
      instance = this;
    }

    return instance;
  }

  start () {
    GLOBAL_EVENT_EMITTER.on(C.EVENT.ROOM_EMPTY, (roomId) => {
      this.removeRoom(roomId);
    });
  }

  stop () {
    return new Promise((resolve, reject) => {
      try {
        Logger.info(LOG_PREFIX, "Stopping everything!");
        this.users.forEach(async u => {
          try {
            const { roomId, id } = u;
            await this.leave(roomId, id);
          } catch (e) {
            this._handleError(e);
          }
        })
        return resolve(0);
      } catch (e) {
        this._handleError(e);
        resolve(1);
      }
    });
  }

  async join (roomId, type, params) {
    Logger.info(LOG_PREFIX, "Join room => " + roomId + ' as ' + type);
    try {
      let session;
      const room = await this.createRoom(roomId);
      const user = this.createUser(roomId, type, params);
      room.setUser(user);

      Logger.info(LOG_PREFIX, "Resolving user " + user.id);
      return Promise.resolve(user.id);
    }
    catch (err) {
      return Promise.reject(this._handleError(err));
    }
  }

  async leave (roomId, userId) {
    Logger.info(LOG_PREFIX, "User", userId, "wants to leave.");
    let user, room;

    try {
      room = this.getRoom(roomId);
      user = this.getUser(userId);
    } catch (err) {
      // User or room were already closed or not found, resolving as it is
      Logger.warn(LOG_PREFIX, 'Leave for', userId, 'at', roomId, 'failed with error', this._handleError(err));
      return Promise.resolve(err);
    }

    try {
      const killedMedias = await user.leave();

      killedMedias.forEach((mediaId) => {
        try {
          this.removeMediaSession(mediaId);
        } catch (e) {
          // Media was probably not found, just log it here and go on
          this._handleError(e);
        }
      });

      room.destroyUser(user.id);
      this.removeUser(user.id);

      Logger.trace(LOG_PREFIX, 'Active media sessions', this.mediaSessions.map(ms => ms.id));
      Logger.trace(LOG_PREFIX, "Active users", this.users.map(u => u.id));

      return Promise.resolve();
    }
    catch (err) {
      return Promise.reject(this._handleError(err));
    }
  }

  publishAndSubscribe (roomId, userId, sourceId, type, params = {}) {
    return new Promise(async (resolve, reject) => {
      Logger.info(LOG_PREFIX, "PublishAndSubscribe from user", userId, "to source", sourceId);
      Logger.trace("[mcs-controler] PublishAndSubscribe descriptor is", params.descriptor);

      try {
        const user = await this.getUser(userId);
        let source;
        if (sourceId === 'default') {
          source = this.mediaSessions[0];
        }

        Logger.info(LOG_PREFIX, "Fetched user", user.id);

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
      Logger.info(LOG_PREFIX, "Publish from user", userId, "to room", roomId);
      Logger.trace("[mcs-controler] Publish descriptor is", params.descriptor);

      try {
        const user = await this.getUser(userId);

        Logger.info(LOG_PREFIX, "Fetched user", user.id);

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
      Logger.info(LOG_PREFIX, "Subscribe from user", userId, "to source", sourceId);
      Logger.trace("[mcs-controler] Subscribe descriptor is", params.descriptor);

      try {
        let source;
        const user = await this.getUser(userId);
        const room = await this.getRoom(user.roomId);
        if (sourceId === C.MEDIA_PROFILE.CONTENT) {
          source = this.getMediaSession(room._contentFloor.id);
          params.content = true;
        } else {
          source = this.getMediaSession(sourceId);
        }

        Logger.info(LOG_PREFIX, "Fetched user", user.id);

        type = C.EMAP[type];

        switch (type) {
          case C.MEDIA_TYPE.RTP:
          case C.MEDIA_TYPE.WEBRTC:
          case C.MEDIA_TYPE.URI:
            const  { session, answer } = await user.subscribe(params.descriptor, type, source, params);
            this.addMediaSession(session);
            resolve({descriptor: answer, mediaId: session.id});
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

  async unpublish (userId, mediaId) {
    try {
      const user = this.getUser(userId);
      const answer = await user.unpublish(mediaId);
      this.removeMediaSession(mediaId);
      Logger.trace(LOG_PREFIX, 'Active media sessions', this.mediaSessions.map(ms => ms.id));
      return Promise.resolve(answer);
    }
    catch (err) {
      err = this._handleError(err);
      return Promise.reject(this._handleError(err));
    }
  }

  async unsubscribe (userId, mediaId) {
    try {
      const user = this.getUser(userId);
      const media = this.getMediaSession(mediaId);
      const answer = await user.unsubscribe(mediaId);
      this.removeMediaSession(mediaId);
      Logger.trace(LOG_PREFIX, 'Active media sessions', this.mediaSessions.map(ms => ms.id));
      return Promise.resolve();
    }
    catch (err) {
      return Promise.reject(this._handleError(err));
    }
  }

  startRecording (userId, sourceId, recordingPath, params) {
    return new Promise(async (resolve, reject) => {
      try {
        Logger.info(LOG_PREFIX, "startRecording ", sourceId);
        const user = await this.getUser(userId);
        const sourceSession = this.getMediaSession(sourceId);

        const { recordingSession, answer } = await user.startRecording(recordingPath, C.MEDIA_TYPE.RECORDING, sourceSession, params);

        this.addMediaSession(recordingSession);

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
      Logger.info(LOG_PREFIX, "Stopping recording session", recId);
      try {
        const user = await this.getUser(userId);
        const recSession = this.getMediaSession(recId);

        const answer = await user.stopSession(recSession.id);
        user.unsubscribe(recSession.id);
        this.removeMediaSession(recId);
        return resolve(answer);
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
  }

  connect (sourceId, sinkId, type = 'ALL') {
    return new Promise(async (resolve, reject) => {
      Logger.info(LOG_PREFIX, "Connect", sourceId, "to", sinkId, "with type", type);

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

  disconnect (sourceId, sinkId, type = 'ALL') {
    return new Promise(async (resolve, reject) => {
      try {
        Logger.info(LOG_PREFIX, "Disconnect", sourceId, "from", sinkId, "with type", type);
        const sourceSession = this.getMediaSession(sourceId);
        const sinkSession = this.getMediaSession(sinkId);

        await sourceSession.disconnect(sinkSession, type);
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
        case C.EVENT.MEDIA_MUTED:
        case C.EVENT.MEDIA_UNMUTED:
        case C.EVENT.MEDIA_VOLUME_CHANGED:
        case C.EVENT.USER_JOINED:
        case C.EVENT.USER_LEFT:
        case C.EVENT.ROOM_CREATED:
        case C.EVENT.ROOM_DESTROYED:
        case C.EVENT.CONTENT_FLOOR_CHANGED:
        case C.EVENT.CONFERENCE_FLOOR_CHANGED:
          // TODO refactor
          break;
        default: Logger.trace(LOG_PREFIX, "Invalid event subscription", mappedEvent, identifier);
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
  async createRoom (roomId)  {
    Logger.info(LOG_PREFIX, "Creating new room with ID", roomId);

    let room = this.rooms.find(r => r.id === roomId);

    if (room == null) {
      room = new Room(roomId);
      this.rooms.push(room);
      this.emitter.emit(C.EVENT.ROOM_CREATED, room.id);
    }

    return room;
  }

  /**
   * Creates an {User} of type @type
   * @param {String} roomId
   */
  createUser (roomId, type, params)  {
    Logger.info(LOG_PREFIX, "Creating a new", type, "user at room", roomId);

    const user = new User(roomId, type, params);
    this.users.push(user);

    return user;
  }

  removeUser (userId) {
    this.users = this.users.filter(u => u.id !== userId);
  }

  getRoom (roomId) {
    const room = this.rooms.find(r => r.id === roomId);

    if (room == null) {
      throw C.ERROR.ROOM_NOT_FOUND;
    }

    return room;
  }

  getUser (userId) {
    const user = this.users.find(u => u.id === userId);

    if (user == null) {
      throw C.ERROR.USER_NOT_FOUND;
    }

    return user;
  }

  removeRoom (roomId) {
    this.rooms = this.rooms.filter(r => {
      if (r.id !== roomId) {
        return true;
      }

      Logger.debug(LOG_PREFIX, "Removing room", roomId);

      r.destroy();
      this.emitter.emit(C.EVENT.ROOM_DESTROYED, r.id);
      return false;
    });

    return roomId;
  }

  getRooms () {
    try {
      return this.rooms.map(r => r.id);
    } catch (err) {
      throw err;
    }
  }

  async getUsers (roomId) {
    try {
      const room = this.getRoom(roomId);
      const users = await room.getUsers();
      return users;
    } catch (err) {
      throw err;
    }
  }

  getUserMedias (userId) {
    try {
      const user = this.getUser(userId);
      const medias = user.getUserMedias();
      return medias;
    } catch (err) {
      throw err;
    }
  }

  addMediaSession (mediaSession) {
    this.mediaSessions.push(mediaSession);
    mediaSession.medias.forEach(this.addMedia.bind(this));
  }

  getMediaSession (mediaId) {
    // Automatic source
    if (mediaId == 'default') {
      return mediaId;
    }

    let media = this.mediaSessions.find(ms => ms.id === mediaId);

    // Not found by ID, try fetching the father session of a media unit
    if (media == null) {
      media = this.getMedia(mediaId) ;
    }

    if (media == null) {
      throw C.ERROR.MEDIA_NOT_FOUND;
    }

    return media;
  }

  removeMediaSession (mediaSessionId) {
    const mediaSession = this.getMediaSession(mediaSessionId);
    this.mediaSessions = this.mediaSessions.filter(ms => ms.id !== mediaSessionId);
    mediaSession.medias.forEach(this.removeMedia.bind(this));
  }

  addMedia (media) {
    this.medias.push(media);
  }

  getMedia (mediaId) {
    return this.medias.find(m => m.id === mediaId);
  }

  removeMedia (media) {
    this.medias = this.medias.filter(m => m.id !== media.id);
  }

  setContentFloor(roomId, mediaId) {
    return new Promise(async (resolve, reject) => {
      try {
        const room = await this.getRoom(roomId);
        const media = this.getMediaSession(mediaId);
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
        const room = await this.getRoom(roomId);
        const media = this.getMediaSession(mediaId);
        const mediaInfo = room.setConferenceFloor(media);
        resolve(mediaInfo);
      }
      catch (error) {
        reject(this._handleError(error))
      }
    })
  }

  releaseContentFloor(roomId) {
    return new Promise(async (resolve, reject) => {
      try {
        const room = await this.getRoom(roomId);
        room.releaseContentFloor();
        resolve();
      }
      catch (error) {
        reject(this._handleError(error));
      }
    })
  }

  releaseConferenceFloor(roomId) {
    return new Promise(async (resolve, reject) => {
      try {
        const room = await this.getRoom(roomId);
        room.releaseConferenceFloor();
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
        const room = await this.getRoom(roomId);
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
        const room = await this.getRoom(roomId);
        Logger.info(LOG_PREFIX, 'Fetched room', room.id);
        resolve(room.getConferenceFloor());
      }
      catch (error) {
        reject(this._handleError(error));
      }
    })
  }

  setVolume(mediaId, volume) {
    return new Promise(async (resolve, reject) => {
      try {
        const mediaSession = this.getMediaSession(mediaId);
        Logger.info(LOG_PREFIX,'Fetched media', mediaSession.id);
        await mediaSession.setVolume(volume);
        resolve();
      }
      catch (error) {
        reject(this._handleError(error));
      }
    })
  }

  mute(mediaId) {
    return new Promise(async (resolve, reject) => {
      try {
        const mediaSession = this.getMediaSession(mediaId);
        Logger.info(LOG_PREFIX,'Fetched media', mediaSession.id);
        await mediaSession.setVolume(0);
        resolve();
      }
      catch (error) {
        reject(this._handleError(error));
      }
    })
  }

  unmute(mediaId) {
    return new Promise(async (resolve, reject) => {
      try {
        const mediaSession = this.getMediaSession(mediaId);
        Logger.info(LOG_PREFIX,'Fetched media', mediaSession.id);
        await mediaSession.setVolume(mediaSession.volume);
        resolve();
      }
      catch (error) {
        reject(this._handleError(error));
      }
    })
  }

  dtmf (mediaId, tone) {
    try {
      Logger.info(LOG_PREFIX, `Sending DTMF tone`, { mediaId, tone });
      const mediaSession = this.getMediaSession(mediaId);
      return mediaSession.dtmf(tone);
    }
    catch (error) {
      throw (this._handleError(error));
    }
  }

  _handleError (error) {
    return handleError(LOG_PREFIX, error);
  }
}
