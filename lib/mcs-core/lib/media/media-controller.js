'use strict'

const config = require('config');
const C = require('../constants/constants');
const Logger = require('../utils/logger');
const User = require('../model/user');
const Room = require('../model/room');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter');
const { handleError } = require('../utils/util');
const Balancer = require('./balancer');
const AdapterFactory = require('../adapters/adapter-factory');
const StrategyManager = require('./strategy-manager.js');
const MediaFactory = require('./media-factory.js');
const { global: GLOBAL_MEDIA_THRESHOLD } = config.get('mediaThresholds');
const ALLOW_DUPLICATE_EXT_USER_ID = config.has('allowDuplicateExtUserId')
  ? config.get('allowDuplicateExtUserId')
  : true;

const LOG_PREFIX = "[mcs-controller]";

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
      this.strategyManager = new StrategyManager();
      this._ejectUser = this._ejectUser.bind(this);
      instance = this;
    }
    return instance;
  }

  static isValidMediaType (type) {
    return Object.keys(C.MEDIA_TYPE).some(validTypeKey =>
      C.MEDIA_TYPE[validTypeKey] === type);
  }

  _handleNewVideoFloor (event) {
    const { roomId, mediaId } = event;
    if (!mediaId) {
      try {
        this.releaseConferenceFloor(roomId, false);
      } catch (error) {
        Logger.error(LOG_PREFIX, `Error releasing conference floor at ${roomId}`,
          { errorMessage: error.message, errorCode: error.code });
      }
    } else {
      try {
        this.setConferenceFloor(roomId, mediaId);
      } catch (error) {
        Logger.error(LOG_PREFIX, `Error setting conference floor at ${roomId}`,
          { errorMessage: error.message, errorCode: error.code });
      }
    }
  }

  start () {
    // Initialize media server adapters. The empty object is used to start the
    // default ones
    AdapterFactory.getAdapters({});

    this.strategyManager.start();

    GLOBAL_EVENT_EMITTER.on(C.EVENT.ROOM_EMPTY, this.removeRoom.bind(this));
    GLOBAL_EVENT_EMITTER.on(C.EVENT.CONFERENCE_NEW_VIDEO_FLOOR, this._handleNewVideoFloor.bind(this));
    // FIXME remove this once all audio goes through mcs-core's API
    GLOBAL_EVENT_EMITTER.on(C.EVENT.MEDIA_EXTERNAL_AUDIO_CONNECTED, this._handleExternalAudioMediaConnected.bind(this));
  }

  stop () {
    return new Promise((resolve, reject) => {
      try {
        Logger.info(LOG_PREFIX, "Stopping everything!");

        this.strategyManager.stop();

        this.users.forEach(async u => {
          try {
            const { roomId, id } = u;
            await this.leave(roomId, id);
          } catch (e) {
            this._handleError(e);
          }
        });
        return resolve(0);
      } catch (e) {
        this._handleError(e);
        resolve(1);
      }
    });
  }

  join (roomId, type, params) {
    try {
      const room = this.createRoom(roomId);
      // Inherit strategy from room unless it was directly specified
      params.strategy = params.strategy || room.strategy;
      const user = this.createUser(room, type, params);
      Logger.info(LOG_PREFIX, `User ${user.id} joined room ${roomId} as ${type}`);
      return user.id;
    } catch (e) {
      throw (this._handleError(e));
    }

  }

  _leave (room, user) {
    const { id: userId, externalUserId } = user;
    Logger.info(LOG_PREFIX, `User ${userId}  actually leaving`, { userId, externalUserId });
    user.leave().then((killedMedias) => {
      killedMedias.forEach((mediaId) => {
        try {
          this.removeMediaSession(mediaId);
          room.removeMediaSession(mediaId);
        } catch (e) {
          // Media was probably not found, just log it here and go on
          this._handleError(e);
        }
      });

      room.destroyUser(user.id);
      this.removeUser(user.id);

      Logger.trace(LOG_PREFIX, 'Active media sessions', this.mediaSessions.map(ms => ms.id));
      Logger.trace(LOG_PREFIX, "Active users", this.users.map(u => u.id));
    }).catch(err => {
      throw (this._handleError(err));
    });
  }

  _ejectUser (userInfo) {
    const { userId, externalUserId, roomId } = userInfo;
    try {
      this.leave(roomId, userId, C.INTERNAL_TRACKING_ID)
    } catch (error) {
      Logger.error(LOG_PREFIX, `Auto eject for user ${userId} at ${roomId} failed due to ${error.message}`,
        { roomId, userId, externalUserId, error });
    }
  }

  leave (roomId, userId, params = {}) {
    let user, room;
    try {
      user = this.getUser(userId);
      Logger.info(LOG_PREFIX, `User ${userId}  wants to leave`, { userId, externalUserId: user.externalUserId });
      room = this.getRoom(user.roomId);
    } catch (error) {
      // User or room were already closed or not found, resolving as it is
      const normalizedError = this._handleError(error);
      Logger.warn(LOG_PREFIX, `Leave for ${userId} failed due to ${error.message}`, { roomId, userId, error });
      throw (normalizedError);
    }

    try  {
      this._leave(room, user);
    } catch (error) {
      Logger.warn(LOG_PREFIX, `Leave for ${userId} failed due to ${error.message}`, { roomId, userId, error });
      throw error;
    }

    return;
  }

  _isAboveThreshold () {
    if (GLOBAL_MEDIA_THRESHOLD > 0 && this.medias.length >= GLOBAL_MEDIA_THRESHOLD) {
      Logger.error(LOG_PREFIX, `Server has exceeded the media threshold`,
        { threshold: GLOBAL_MEDIA_THRESHOLD, current: this.medias.length}
      );
      return true;
    }
    return false;
  }

  isAboveMediaThresholds (room, user) {
    if (this._isAboveThreshold() ||
      room.isAboveThreshold() ||
      user.isAboveThreshold()) {
      return true;
    }
    return false;
  }

  async publishAndSubscribe (roomId, userId, sourceId, type, params = {}) {
    let user, room, source, session, answer;
    type = C.EMAP[type];

    Logger.info(LOG_PREFIX, `PublishAndSubscribe from user ${userId} to source ${sourceId} in room ${roomId}`);
    Logger.trace(LOG_PREFIX, `PublishAndSubscribe descriptor is`, params.descriptor);

    if (!MediaController.isValidMediaType(type)) {
      throw (this._handleError(C.ERROR.MEDIA_INVALID_TYPE));
    }

    try {
      user = this.getUser(userId);
      room = this.getRoom(user.roomId);
    } catch (error) {
      Logger.warn(LOG_PREFIX, `PublishAndSubscribe for ${userId} failed due to ${error.message}`, { roomId, userId, error });
      throw error;
    }

    if (!params.ignoreThresholds && this.isAboveMediaThresholds(room, user)) {
      throw (this._handleError({
        ...C.ERROR.MEDIA_SERVER_NO_RESOURCES,
        details: `Threshold exceeded. Threshold: ${GLOBAL_MEDIA_THRESHOLD}`,
      }));
    }

    try {
      ({ session, answer } = await user.publish(params.descriptor, type, params));
    } catch (error) {
      throw (this._handleError(error));
    }

    this.addMediaSession(session);
    room.addMediaSession(session);

    if (source) {
      try {
        await user.connect(source.id, session.id);
      } catch (error) {
        Logger.error(LOG_PREFIX, `Error on PublishAndSubscribe subscription to ${sourceId} from ${session.id}`, { error })
      }
    }

    session.sessionStarted();
    return ({ descriptor: answer, mediaId: session.id });
  }

  async publish (userId, roomId, type, params = {}) {
    let user, room, session, answer;
    type = C.EMAP[type];

    Logger.info(LOG_PREFIX, `Publish from user ${userId} in room ${roomId}`);
    Logger.trace(LOG_PREFIX,  `Publish descriptor is`, params.descriptor);

    if (!MediaController.isValidMediaType(type)) {
      throw (this._handleError(C.ERROR.MEDIA_INVALID_TYPE));
    }

    try {
      user = this.getUser(userId);
      room = this.getRoom(user.roomId);
    } catch (error) {
      Logger.warn(LOG_PREFIX, `Publish for ${userId} failed due to ${error.message}`, { roomId, userId, error });
      throw error;
    }

    if (!params.ignoreThresholds && this.isAboveMediaThresholds(room, user)) {
      throw (this._handleError({
        ...C.ERROR.MEDIA_SERVER_NO_RESOURCES,
        details: `Threshold exceeded. Threshold: ${GLOBAL_MEDIA_THRESHOLD}`,
      }));
    }

    try {
      ({ session, answer } = await user.publish(params.descriptor, type, params));
    } catch (error) {
      throw (this._handleError(error));
    }

    this.addMediaSession(session);
    room.addMediaSession(session);
    session.sessionStarted();
    return ({ descriptor: answer, mediaId: session.id });
  }

  async subscribe (userId, sourceId, type, params = {}) {
    let source, user, room, session, answer;
    type = C.EMAP[type];

    Logger.info(LOG_PREFIX, `Subscribe from user ${userId} to source ${sourceId}`);
    Logger.trace(LOG_PREFIX, "Subscribe descriptor is", params.descriptor);

    if (!MediaController.isValidMediaType(type)) {
      throw (this._handleError(C.ERROR.MEDIA_INVALID_TYPE));
    }

    try {
      user = this.getUser(userId);
      room = this.getRoom(user.roomId);
    } catch (error) {
      Logger.warn(LOG_PREFIX, `Subscribe for ${userId} failed due to ${error.message}`, { userId, error });
      throw error;
    }

    if (!params.ignoreThresholds && this.isAboveMediaThresholds(room, user)) {
      throw (this._handleError({
        ...C.ERROR.MEDIA_SERVER_NO_RESOURCES,
        details: `Threshold exceeded. Threshold: ${GLOBAL_MEDIA_THRESHOLD}`,
      }));
    }

    try {
      if (sourceId === C.MEDIA_PROFILE.CONTENT) {
        source = this.getMediaSession(room._contentFloor.id);
        params.content = true;
      } else {
        source = this.getMediaSession(sourceId);
      }
    } catch (error) {
      Logger.warn(LOG_PREFIX, `Subscribe for ${userId} failed due to ${error.message}`, { roomId: room.id, userId, error });
      throw error;
    }

    try {
      ({ session, answer } = await user.subscribe(params.descriptor, type, source, params));
    } catch (error) {
      throw (this._handleError(error));
    }

    this.addMediaSession(session);
    room.addMediaSession(session);
    session.sessionStarted();
    return ({descriptor: answer, mediaId: session.id});
  }

  unpublish (userId, mediaId) {
    let user, room;

    Logger.info(LOG_PREFIX, `Unpublishing media ${mediaId} of user ${userId}`);

    try {
      user = this.getUser(userId);
      room = this.getRoom(user.roomId);
    } catch (error) {
      Logger.warn(LOG_PREFIX, `Unpublish from user ${userId} for media ${mediaId} failed due to ${error.message}`,
        { userId, mediaId, error });
      throw (this._handleError(error));
    }

    try {
      this.removeMediaSession(mediaId);
      room.removeMediaSession(mediaId);
      Logger.trace(LOG_PREFIX, 'Active media sessions', this.mediaSessions.map(ms => ms.id));
      return user.unpublish(mediaId);
    } catch (error) {
      Logger.warn(LOG_PREFIX, `Unpublish from user ${userId} for media ${mediaId} failed due to ${error.message}`,
        { roomId: room.id, userId, mediaId, error })
      throw (this._handleError(error));
    }
  }

  unsubscribe (userId, mediaId) {
    let user, room;

    Logger.info(LOG_PREFIX, `Unsubscribing media ${mediaId} of user ${userId}`);
    try {
      user = this.getUser(userId);
      room = this.getRoom(user.roomId);
    } catch (error) {
      Logger.warn(LOG_PREFIX, `Unsubscribe from user ${userId} for media ${mediaId} failed due to ${error.message}`,
        { userId, mediaId, error });
      throw (this._handleError(error));
    }

    try {
      this.removeMediaSession(mediaId);
      room.removeMediaSession(mediaId);
      Logger.trace(LOG_PREFIX, 'Active media sessions', this.mediaSessions.map(ms => ms.id));
      return user.unsubscribe(mediaId);
    }
    catch (error) {
      Logger.warn(LOG_PREFIX, `Unsubscribe from user ${userId} for media ${mediaId} failed due to ${error.message}`,
        { roomId: room.id, userId, mediaId, error })
      throw (this._handleError(error));
    }
  }

  async startRecording (userId, sourceId, recordingPath, params = {}) {
    let user, room, sourceSession, recordingSession, answer;

    Logger.info(LOG_PREFIX, `startRecording of media ${sourceId} from user ${userId}`);

    try {
      user = this.getUser(userId);
      room = this.getRoom(user.roomId);
      sourceSession = this.getMediaSession(sourceId);
    } catch (error) {
      Logger.warn(LOG_PREFIX, `startRecording from user ${userId} of media ${sourceId} failed due to ${error.message}`,
        { userId, mediaId: sourceId, error });
      throw (this._handleError(error));
    }

    if (!params.ignoreThresholds && this.isAboveMediaThresholds(room, user)) {
      throw (this._handleError({
        ...C.ERROR.MEDIA_SERVER_NO_RESOURCES,
        details: `Threshold exceeded. Threshold: ${GLOBAL_MEDIA_THRESHOLD}`,
      }));
    }

    try {
      ({ recordingSession, answer } = await user.startRecording(
        recordingPath,
        C.MEDIA_TYPE.RECORDING,
        sourceSession,
        params
      ));
    } catch (error) {
      Logger.warn(LOG_PREFIX, `startRecording from user ${userId} of media ${sourceId} failed due to ${error.message}`,
        { userId, mediaId: sourceId, error });
      throw (this._handleError(error));
    }

    this.addMediaSession(recordingSession);
    room.addMediaSession(recordingSession);
    recordingSession.sessionStarted();
    return answer;
  }

  stopRecording (userId, recId) {
    let user, room, answer;

    Logger.info(LOG_PREFIX, `Stopping recording ${recId} from user ${userId}`);

    try {
      user = this.getUser(userId);
      room = this.getRoom(user.roomId);
    } catch (error) {
      Logger.warn(LOG_PREFIX, `stopRecording for user ${userId} of recording ${recId} failed due to ${error.message}`,
        { userId, mediaId: recId, error });
      throw (this._handleError(error));
    }

    try {
      //  const recSession = this.getMediaSession(recId);
      this.removeMediaSession(recId);
      room.removeMediaSession(recId);
      return user.unsubscribe(recId);
    } catch (error) {
      Logger.error(LOG_PREFIX, `stopRecording from user ${userId} of recording ${recId} failed due to ${error.message}`,
        { roomId: room.id, userId, mediaId: recId, error })
      throw (this._handleError(error));
    }
  }

  connect (sourceId, sinkId, type = 'ALL') {
    return new Promise(async (resolve, reject) => {
      Logger.info(LOG_PREFIX, `Connect ${sourceId} to ${sinkId} with type ${type}`);

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
        Logger.info(LOG_PREFIX, `Disconnect ${sourceId} from ${sinkId} with type ${type}`);
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
        case C.EVENT.MEDIA_RENEGOTIATED:
        case C.EVENT.MEDIA_MUTED:
        case C.EVENT.MEDIA_UNMUTED:
        case C.EVENT.MEDIA_VOLUME_CHANGED:
        case C.EVENT.MEDIA_START_TALKING:
        case C.EVENT.MEDIA_STOP_TALKING:
        case C.EVENT.USER_JOINED:
        case C.EVENT.USER_LEFT:
        case C.EVENT.ROOM_CREATED:
        case C.EVENT.ROOM_DESTROYED:
        case C.EVENT.CONTENT_FLOOR_CHANGED:
        case C.EVENT.CONFERENCE_FLOOR_CHANGED:
        case C.EVENT.SUBSCRIBED_TO:
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
  createRoom (roomId)  {
    let room = this.rooms.find(r => r.id === roomId);

    if (room == null) {
      room = new Room(roomId);
      this.rooms.push(room);
      Logger.info(LOG_PREFIX, `New room created: ${roomId}`,
        { coreRoomInfo: room.getInfo() });
      this.emitter.emit(C.EVENT.ROOM_CREATED, room);
    }

    return room;
  }


  /**
   * Creates an {User} of type @type
   * @param {String} roomId
   */
  createUser (room, type, params)  {
    const { externalUserId }  = params;
    const roomId = room.id;
    let user;

    if (externalUserId) {
      try {
        user = this.getUser(externalUserId);
        // If user is found and duplicate EXT_USER_IDs aren't allowed, throw error
        if (!ALLOW_DUPLICATE_EXT_USER_ID) {
          throw this._handleError({
            ...C.ERROR.MEDIA_INVALID_OPERATION,
            details: `externalUserId specified on join and duplicate externalUserId is not allowed`,
          });
        }
        return user;
      } catch (e) {
        // User was not found, just ignore it and create a new one
      }
    }

    // No pre-existing externalUserId sent in the join procedure, create a new one
    user = new User(roomId, type, params);
    this.users.push(user);
    room.addUser(user);
    Logger.info(LOG_PREFIX, `New user created at room ${roomId} with id ${user.id}`,
      { roomId, userId: user.id, externalUserId: user.externalUserId });
    // This event handler will be get rid of once the user is destroyed, so it's
    // no biggie it isn't explicitly removed
    if (user.autoLeave) {
      user.once(C.EVENT.EJECT_USER, this._ejectUser);
    }
    return user;
  }

  removeUser (userId) {
    this.users = this.users.filter(u => {
      if (u.id !== userId) {
        return true;
      }

      this.strategyManager.removeFromHandler(u.id, u.strategy);
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.USER_LEFT, u.getUserInfo());
      return false;
    });
  }

  getRoom (roomId) {
    const room = this.rooms.find(r => r.id === roomId);

    if (room == null) {
      throw C.ERROR.ROOM_NOT_FOUND;
    }

    return room;
  }

  getUser (userId) {
    const user = this.users.find(u => u.id === userId)
      || this.users.find(u => u.externalUserId === userId);

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

      this.strategyManager.removeFromHandler(r.id, r.strategy);

      this.emitter.emit(C.EVENT.ROOM_DESTROYED, r.getInfo());

      r.destroy();

      return false;
    });

    return roomId;
  }

  getRooms () {
    return this.rooms.map(r => r.id);
  }

  getUsers (roomId) {
    try {
      const room = this.getRoom(roomId);
      return room.getUsers();
    } catch (error) {
      Logger.error(LOG_PREFIX, `getUsers failed for room ${roomId} due to ${error.message}`,
        { roomId, error });
      throw (this._handleError(error));
    }
  }

  getUserMedias (userId) {
    try {
      const user = this.getUser(userId);
      return user.getMediaInfos();
    } catch (error) {
      Logger.error(LOG_PREFIX, `getUserMedias failed for user ${userId} due to ${error.message}`,
        { userId, error });
      throw (this._handleError(error));
    }
  }

  getRoomMedias (roomId) {
    try {
      const room = this.getRoom(roomId);
      return room.getMediaInfos();
    } catch (error) {
      Logger.error(LOG_PREFIX, `getRoomMedias failed for room ${roomId} due to ${error.message}`,
        { roomID, error });
      throw (this._handleError(error));
    }
  }

  addMediaSession (mediaSession) {
    if (!this.mediaSessions.find(ms => ms.id === mediaSession.id)) {
      this.mediaSessions.push(mediaSession);
      // Sad wart, but it needs to be kept due to both-ways SDP negotiation
      // Rationale: if we're the offerer of an RTP session, wait for the NEGOTIATED
      // event to fired in order to notify it as CONNECTED. If we're the answerer,
      // just fire CONNECTED already because it already went through the offer/answer
      // steps
      if (mediaSession.type === C.MEDIA_TYPE.RTP
        && mediaSession.negotiationRole === C.NEGOTIATION_ROLE.OFFERER) {
        GLOBAL_EVENT_EMITTER.once(`${C.EVENT.MEDIA_NEGOTIATED}:${mediaSession.id}`, (info) => {
          GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_CONNECTED, info);
        });
      } else {
        GLOBAL_EVENT_EMITTER.emit(C.EVENT.MEDIA_CONNECTED, mediaSession.getMediaInfo());
      }
    }
    mediaSession.medias.forEach(this.addMedia.bind(this));
    MediaFactory.addMediaSession(mediaSession);
  }

  getMediaSession (mediaId) {
    // Automatic source
    if (mediaId == 'default') {
      return mediaId;
    }

    let media = this.mediaSessions.find(ms => ms.id === mediaId);

    // Not found by ID, try fetching the father session of a media unit
    if (media == null) {
      media = this.getMedia(mediaId);
    }

    if (media == null) {
      throw this._handleError({
        ...C.ERROR.MEDIA_NOT_FOUND,
        details: `mediaId: ${mediaId}`,
      });
    }

    return media;
  }

  removeMediaSession (mediaSessionId) {
    const mediaSession = this.getMediaSession(mediaSessionId);
    mediaSession.medias.forEach(this.removeMedia.bind(this));
    this.mediaSessions = this.mediaSessions.filter(ms => ms.id !== mediaSessionId);
    MediaFactory.removeMediaSession(mediaSessionId);
  }

  addMedia (media) {
    if (!this.medias.find(mu => mu.id === media.id)) {
      this.medias.push(media);
    }
    MediaFactory.addMedia(media);
  }

  getMedia (mediaId) {
    return this.medias.find(m => m.id === mediaId);
  }

  removeMedia (media) {
    this.medias = this.medias.filter(m => {
      if (m.id !== media.id) {
        return true;
      }

      this.strategyManager.removeFromHandler(m.id, m.strategy);
      return false;
    });
  }

  setContentFloor (roomId, mediaId) {
    try {
      const room = this.getRoom(roomId);
      const media = this.getMediaSession(mediaId);
      return room.setContentFloor(media);
    } catch (error) {
      Logger.error(LOG_PREFIX, `setContentFloor for room ${roomId} as media ${mediaId} failed due to ${error.message}`,
        { roomId, mediaId, error });
      throw (this._handleError(error));
    }
  }

  setConferenceFloor (roomId, mediaId) {
    try {
      const room = this.getRoom(roomId);
      const media = this.getMediaSession(mediaId);
      return room.setConferenceFloor(media);
    } catch (error) {
      Logger.error(LOG_PREFIX, `setConferenceFloor for room ${roomId} as media ${mediaId} failed due to ${error.message}`,
        { roomId, mediaId, error });
      throw (this._handleError(error));
    }
  }

  releaseContentFloor (roomId) {
    try {
      const room = this.getRoom(roomId);
      return room.releaseContentFloor();
    } catch (error) {
      Logger.error(LOG_PREFIX, `releaseContentFloor for room ${roomId} failed due to ${error.message}`,
        { roomId, error });
      throw (this._handleError(error));
    }
  }

  releaseConferenceFloor (roomId, preserve = true) {
    try {
      const room = this.getRoom(roomId);
      return room.releaseConferenceFloor(preserve);
    } catch (error) {
      Logger.error(LOG_PREFIX, `releaseConferenceFloor for room ${roomId} failed due to ${error.message}`,
        { roomId, error });
      throw (this._handleError(error));
    }
  }

  getContentFloor (roomId) {
    try {
      const room = this.getRoom(roomId);
      return room.getContentFloor();
    } catch (error) {
      Logger.error(LOG_PREFIX, `getContentFloor for room ${roomId} failed due to ${error.message}`,
        { roomId, error });
      throw (this._handleError(error));
    }
  }

  getConferenceFloor (roomId) {
    try {
      const room = this.getRoom(roomId);
      return room.getConferenceFloor();
    } catch (error) {
      Logger.error(LOG_PREFIX, `getConferenceFloor for room ${roomId} failed due to ${error.message}`,
        { roomId, error });
      throw (this._handleError(error));
    }
  }

  setVolume (mediaId, volume) {
    try {
      const mediaSession = this.getMediaSession(mediaId);
      return mediaSession.setVolume(volume);
    } catch (error) {
      Logger.error(LOG_PREFIX, `setVolume for media$ ${mediaId} failed due to ${error.message}`,
        { mediaId, volume, error });
      throw (this._handleError(error));
    }
  }

  mute (mediaId) {
    try {
      const mediaSession = this.getMediaSession(mediaId);
      return mediaSession.mute();
    } catch (error) {
      Logger.error(LOG_PREFIX, `mute for media$ ${mediaId} failed due to ${error.message}`,
        { mediaId, error });
      throw (this._handleError(error));
    }
  }

  unmute (mediaId) {
    try {
      const mediaSession = this.getMediaSession(mediaId);
      return mediaSession.unmute();
    } catch (error) {
      Logger.error(LOG_PREFIX, `unmute for media$ ${mediaId} failed due to ${error.message}`,
        { mediaId, error });
      throw (this._handleError(error));
    }
  }

  /*
   * Given a generic identifier that can represent a room, user, media session
   * or media unit, set a new strategy for the member
   * @param {String} identifier
   * @param {String} strategy The name of the strategy to be set
   */
  setStrategy (identifier, strategy, params = {}) {
    try {
      const member = this._getMemberByIdentifier(identifier);
      member.setStrategy(strategy, params);
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  /*
   * Given a generic identifier that can represent a room, user, media session
   * or media unit, return the current strategy set for the member
   * @param {String} identifier
   */
  getStrategy (identifier) {
    try {
      const member = this._getMemberByIdentifier(identifier);
      return member.strategy;
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  /*
   * Given a generic identifier that can represent a room, user, media session
   * or media unit, probe the models for one of those and return it if found
   * @param {String} identifier
   */
  _getMemberByIdentifier (identifier) {
    try {
      const media = this.getMediaSession(identifier);
      return media;
    } catch (e) {
      Logger.debug(LOG_PREFIX, "Media not found, falling back to user", e);
    }

    try {
      const user = this.getUser(identifier);
      return user;
    } catch (e) {
      Logger.debug(LOG_PREFIX, "User not found, falling back to room", e);
    }

    try {
      const room = this.getRoom(identifier);
      return room;
    } catch (e) {
      Logger.debug(LOG_PREFIX, "Room not found, no valid member for", identifier);
      throw C.ERROR.MEDIA_NOT_FOUND;
    }
  }

  _getMediasByMemberIdentifier (memberType, identifier) {
    switch (memberType) {
      case C.MEMBERS.USER:
        return this.getUserMedias(identifier);
      case C.MEMBERS.ROOM:
        return this.getRoomMedias(identifier);
      case C.MEMBERS.MEDIA_SESSION:
        return this.getMediaSession(identifier).getMediaInfo();
      case C.MEMBERS.MEDIA:
        return this.getMedia(identifier).getMediaInfo();
      default:
        throw (this._handleError({
          ...C.ERROR.MEDIA_INVALID_TYPE,
          details: `getMedias memberType is invalid: ${memberType}`,
        }));
    }
  }

  // FIXME
  // this is temporary workaround to create a media that joined freeswitch externally
  _handleExternalAudioMediaConnected (event) {
    try {
      // User joined externally through FreeSWITCH. Create an user for it and
      // a media-session for its media, then index in the controller and room's
      // models
      const { roomId, userId, userName, sdpOffer, sdpAnswer, media } = event;
      const room = this.createRoom(roomId);
      const user = this.createUser(
        room,
        C.USERS.SFU,
        { externalUserId: userId, name: userName, autoLeave: true }
      );
      // Override the event's media userId with the internal userId because it comes
      // with the externalUserId set
      media.userId = user.id
      // Create media session to aggregate the external user media from the event
      const session = user.createMediaSession(sdpOffer, C.MEDIA_TYPE.WEBRTC);
      session._status = C.STATUS.STARTING;
      session.sessionStarted();
      room.addMediaSession(session);
      media.mediaSessionId = session.id;
      // Append event's media to session
      session.medias = session.medias.concat(media);
      session.localDescriptor = sdpAnswer;
      session.fillMediaTypes();
      session.createAndSetMediaNames();
      this.addMediaSession(session);
      media.once(`${C.EVENT.MEDIA_DISCONNECTED}:${media.id}`, () => {
        session.stop();
      });
    }
    catch (error) {
      // Just register the error without acting on it since this event callback
      // is a not-so-crucial workaround
      this._handleError(error);
    }
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

  requestKeyframe (mediaId) {
    try {
      Logger.info(LOG_PREFIX, `Requesting keyframe from media`, { mediaId });
      const mediaSession = this.getMediaSession(mediaId);
      return mediaSession.requestKeyframe();
    }
    catch (error) {
      throw (this._handleError(error));
    }
  }

  getMedias (memberType, identifier, options = {}) {
    try {
      Logger.info(LOG_PREFIX, `getMedias request for ${identifier}`, { memberType, identifier, options });
      let { types, mediaTypes } = options;

      if (types) {
        types = types.map(t => C.EMAP[t]);
      }

      let mediaSessions = this._getMediasByMemberIdentifier(memberType, identifier);

      if (types || mediaTypes) {
        mediaSessions = mediaSessions.filter(ms => {
          const msTypesMatch = !types || types.some(ms.type);
          const msMTypesMatch = !mediaTypes
            || !Object.keys(ms.mediaTypes).some(msk => {
              if (mediaTypes[msk] && !ms.mediaTypes[msk]) {
                return true;
              }
              return false;
            });

          return msTypesMatch && msMTypesMatch;
        });

        mediasSessions.forEach(ms => {
          ms.medias = ms.medias.filter(({ mediaTypes: msMediaTypes }) => {
            const msmtk = Object.keys(msMediaTypes);
            return msMediaTypes[msmtk] === mediaTypes[msmtk];
          });
        });
      }

      return mediaSessions;
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  _handleError (error) {
    return handleError(LOG_PREFIX, error);
  }
}
