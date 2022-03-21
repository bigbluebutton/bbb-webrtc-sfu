'use strict'

const config = require('config');
const C = require('../constants/constants');
const Logger = require('../utils/logger');
const User = require('../model/user');
const Room = require('../model/room');
const GLOBAL_EVENT_EMITTER = require('../../../common/emitter.js');
const { handleError } = require('../utils/util');
const Balancer = require('./balancer');
const AdapterFactory = require('../adapters/adapter-factory');
const MediaFactory = require('./media-factory.js');
const { global: GLOBAL_MEDIA_THRESHOLD } = config.get('mediaThresholds');
const ALLOW_DUPLICATE_EXT_USER_ID = config.has('allowDuplicateExtUserId')
  ? config.get('allowDuplicateExtUserId')
  : true;
const {
  MCSPrometheusAgent,
  METRIC_NAMES,
} = require('../metrics/index.js');

const LOG_PREFIX = "[mcs-controller]";

// Fire that balancer
Balancer.upstartHosts();

class MediaControllerC {
  constructor() {
    this.emitter = GLOBAL_EVENT_EMITTER;
    this.rooms = new Map();
    this.users = new Map();
    // TODO Centralize in per meeting models
    this.mediaSessions = new Map();
    // TODO Centralize in per meeting models
    this.medias = new Map();
    this._ejectUser = this._ejectUser.bind(this);
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

    GLOBAL_EVENT_EMITTER.on(C.EVENT.ROOM_EMPTY, this.removeRoom.bind(this));
    GLOBAL_EVENT_EMITTER.on(C.EVENT.ROOM_DESTROYED, this._handleRoomDestroyed.bind(this));
    GLOBAL_EVENT_EMITTER.on(C.EVENT.CONFERENCE_NEW_VIDEO_FLOOR, this._handleNewVideoFloor.bind(this));
  }

  stop () {
    return new Promise((resolve) => {
      try {
        Logger.info(LOG_PREFIX, "Stopping everything!");

        this.users.forEach(async u => {
          try {
            const { roomId, id } = u;
            this.leave(roomId, id);
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
      const user = this.createUser(room, type, params);
      Logger.debug(LOG_PREFIX, 'User joined room', { userId: user.id, roomId, type });
      return user.id;
    } catch (e) {
      throw (this._handleError(e));
    }
  }

  _ejectUser (userInfo) {
    const { userId, externalUserId, roomId } = userInfo;
    try {
      this.leave(roomId, userId);
      Logger.info(LOG_PREFIX, "User ejected", { userId, externalUserId, roomId });
    } catch (error) {
      if (error === C.ERROR.USER_NOT_FOUND) {
        Logger.debug(LOG_PREFIX, 'User with already left the room', {
          userId, externalUserId, roomId,
        });
      } else {
        Logger.error(LOG_PREFIX, 'Auto eject failed', {
          userId, externalUserId, roomId, errorMessage: error.message, error,
        });
      }
    }
  }

  leave (roomId, userId) {
    let room;
    const user = this.getUser(userId);

    if (user) {
      room = this.getRoom(user.roomId);
      const { id: userId, externalUserId } = user;
      user.leave().then((killedMedias) => {
        Logger.info(LOG_PREFIX, "User left", { userId, externalUserId });
        killedMedias.forEach((mediaId) => {
          try {
            this.removeMediaSession(mediaId);
            if (room) {
              room.removeMediaSession(mediaId);
            }
          } catch (error) {
            // Media was probably not found, just log it here and go on
            this._handleError(error);
          }
        });

        this.removeUser(user);
      }).catch(error => {
        Logger.error(LOG_PREFIX, "CRITICAL: exception on user leave cleanup", {
          roomId, userId, errorMessage: error.message, errorCode: error.code,
        })
      });
    }

    if (room) {
      room.destroyUser(userId);
    }
  }

  isAboveGlobalMediaThreshold ({ mediaId, ignoreThresholds = false }) {
    if (GLOBAL_MEDIA_THRESHOLD > 0 && !ignoreThresholds) {
      const preExistantMedia = mediaId ? this.hasMediaSession(mediaId) : false;

      if (!preExistantMedia && this.medias.size >= GLOBAL_MEDIA_THRESHOLD) {
        Logger.error(LOG_PREFIX, `Server has exceeded the media threshold`,
          { threshold: GLOBAL_MEDIA_THRESHOLD, current: this.medias.size }
        );
        return true;
      }
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

  _validateAdapterFromOptions (options) {
    // Default adapter, short circuit
    if (options.adapter == null) return true;

    return AdapterFactory.isValidAdapter(options.adapter);
  }

  async publishAndSubscribe (roomId, userId, sourceId, type, params = {}) {
    let user, source, session, answer;
    type = C.EMAP[type];

    Logger.trace(LOG_PREFIX, 'Publish/Subscribe request', {
      userId, roomId, sourceId, descriptor: params.descriptor,
    });

    if (!MediaControllerC.isValidMediaType(type)) {
      throw (this._handleError(C.ERROR.MEDIA_INVALID_TYPE));
    }

    if (!this._validateAdapterFromOptions(params)) {
      throw (this._handleError(C.ERROR.MEDIA_ADAPTER_OBJECT_NOT_FOUND));
    }

    if (this.isAboveGlobalMediaThreshold(params)) {
      throw (this._handleError({
        ...C.ERROR.MEDIA_SERVER_NO_RESOURCES,
        details: `Threshold exceeded. Threshold: ${GLOBAL_MEDIA_THRESHOLD}`,
      }));
    }

    try {
      user = this.getUserThrowable(userId);
      this.getRoomThrowable(user.roomId);
      ({ session, answer } = await user.publish(params.descriptor, type, params));
    } catch (error) {
      Logger.error(LOG_PREFIX, 'PublishAndSubscribe failed: publish phase', {
        userId, roomId, sourceId, type, errorMessage: error.message,
      });
      throw (this._handleError(error));
    }

    this.addMediaSession(session);

    if (source) {
      try {
        await user.connect(source.id, session.id);
      } catch (error) {
        Logger.warn(LOG_PREFIX, 'PublishAndSubscribe subscription failed', {
          roomId, userId, sourceId, sinkId: session.id,
          errorMessage: error.message, errorCode: error.code
        });
      }
    }

    session.sessionStarted();
    return ({ descriptor: answer, mediaId: session.id });
  }

  async publish (userId, roomId, type, params = {}) {
    let session, answer;
    type = C.EMAP[type];

    Logger.trace(LOG_PREFIX, 'Publish request', { userId, roomId, descriptor: params.descriptor });

    if (!MediaControllerC.isValidMediaType(type)) {
      throw (this._handleError(C.ERROR.MEDIA_INVALID_TYPE));
    }

    if (!this._validateAdapterFromOptions(params)) {
      throw (this._handleError(C.ERROR.MEDIA_ADAPTER_OBJECT_NOT_FOUND));
    }

    if (this.isAboveGlobalMediaThreshold(params)) {
      throw (this._handleError({
        ...C.ERROR.MEDIA_SERVER_NO_RESOURCES,
        details: `Threshold exceeded. Threshold: ${GLOBAL_MEDIA_THRESHOLD}`,
      }));
    }

    try {
      const user = this.getUserThrowable(userId);
      this.getRoomThrowable(user.roomId);

      ({ session, answer } = await user.publish(params.descriptor, type, params));
    } catch (error) {
      Logger.error(LOG_PREFIX, 'Publish failed', {
        userId, roomId, type, errorMessage: error.message,
      });
      throw (this._handleError(error));
    }

    this.addMediaSession(session);
    session.sessionStarted();
    return ({ descriptor: answer, mediaId: session.id });
  }

  async subscribe (userId, sourceId, type, params = {}) {
    let source, session, answer;
    type = C.EMAP[type];

    Logger.trace(LOG_PREFIX, 'Subscribe request', {
      userId, sourceId, descriptor: params.descriptor,
    });

    if (!MediaControllerC.isValidMediaType(type)) {
      throw (this._handleError(C.ERROR.MEDIA_INVALID_TYPE));
    }

    if (!this._validateAdapterFromOptions(params)) {
      throw (this._handleError(C.ERROR.MEDIA_ADAPTER_OBJECT_NOT_FOUND));
    }

    if (this.isAboveGlobalMediaThreshold(params)) {
      throw (this._handleError({
        ...C.ERROR.MEDIA_SERVER_NO_RESOURCES,
        details: `Threshold exceeded. Threshold: ${GLOBAL_MEDIA_THRESHOLD}`,
      }));
    }

    try {
      const user = this.getUserThrowable(userId);
      const room = this.getRoomThrowable(user.roomId);

      if (sourceId === C.MEDIA_PROFILE.CONTENT) {
        source = this.getMediaSessionThrowable(room._contentFloor.id);
        params.content = true;
      } else {
        source = this.getMediaSessionThrowable(sourceId);
      }

      ({ session, answer } = await user.subscribe(params.descriptor, type, source, params));
    } catch (error) {
      Logger.error(LOG_PREFIX, 'Subscribe failed', {
        userId, sourceId, type, errorMessage: error.message,
      });
      throw (this._handleError(error));
    }

    this.addMediaSession(session);
    session.sessionStarted();
    return ({ descriptor: answer, mediaId: session.id });
  }

  unpublish (userId, mediaId) {
    const user = this.getUser(userId);

    this.removeMediaSession(mediaId);

    if (user) {
      const room = this.getRoom(user.roomId);
      if (room) room.removeMediaSession(mediaId);
      return user.unpublish(mediaId);
    }

    return Promise.resolve();
  }

  unsubscribe (userId, mediaId) {
    const user = this.getUser(userId);

    this.removeMediaSession(mediaId);

    if (user) {
      const room = this.getRoom(user.roomId);
      if (room) room.removeMediaSession(mediaId);
      return user.unsubscribe(mediaId);
    }

    return Promise.resolve();
  }

  async startRecording (userId, sourceId, recordingPath, params = {}) {
    let recordingSession, answer;

    if (!this._validateAdapterFromOptions(params)) {
      throw (this._handleError(C.ERROR.MEDIA_ADAPTER_OBJECT_NOT_FOUND));
    }

    if (this.isAboveGlobalMediaThreshold(params)) {
      throw (this._handleError({
        ...C.ERROR.MEDIA_SERVER_NO_RESOURCES,
        details: `Threshold exceeded. Threshold: ${GLOBAL_MEDIA_THRESHOLD}`,
      }));
    }

    try {
      const user = this.getUserThrowable(userId);
      this.getRoomThrowable(user.roomId);
      const sourceSession = this.getMediaSessionThrowable(sourceId);

      ({ recordingSession, answer } = await user.startRecording(
        recordingPath,
        C.MEDIA_TYPE.RECORDING,
        sourceSession,
        params
      ));
    } catch (error) {
      Logger.warn(LOG_PREFIX, 'startRecording failed', {
        userId, sourceId, recordingPath, errorMessage: error.message
      });
      throw (this._handleError(error));
    }

    this.addMediaSession(recordingSession);
    recordingSession.sessionStarted();
    return answer;
  }

  stopRecording (userId, recId) {
    const user = this.getUser(userId);

    this.removeMediaSession(recId);

    if (user) {
      const room = this.getRoom(user.roomId);
      if (room) room.removeMediaSession(recId);
      return user.unsubscribe(recId);
    }

    return Promise.resolve();
  }

  async connect (sourceId, sinkId, type = 'ALL') {
    try {
      const sourceSession = this.getMediaSessionThrowable(sourceId);
      const sinkSession = this.getMediaSessionThrowable(sinkId);
      await sourceSession.connect(sinkSession, type);
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  async disconnect (sourceId, sinkId, type = 'ALL') {
    try {
      const sourceSession = this.getMediaSessionThrowable(sourceId);
      const sinkSession = this.getMediaSessionThrowable(sinkId);
      await sourceSession.disconnect(sinkSession, type);
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  async addIceCandidate (mediaId, candidate) {
    try {
      const session = this.getMediaSessionThrowable(mediaId);
      await session.addIceCandidate(candidate);
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  onEvent (eventName, identifier) {
    try {
      const mappedEvent = C.EMAP[eventName]? C.EMAP[eventName] : eventName;
      switch (mappedEvent) {
        case C.EVENT.MEDIA_STATE.MEDIA_EVENT:
        case C.EVENT.MEDIA_STATE.ICE: {
          const session = this.getMediaSession(identifier);
          if (session) session.onEvent(mappedEvent);
          break;
        }
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
    let room;

    if (roomId) {
      room = this.getRoom(roomId);
    }

    if (room == null) {
      room = new Room(roomId);
      this.rooms.set(room.id, room);
      MCSPrometheusAgent.set(METRIC_NAMES.ROOMS, this.getNumberOfRooms());
      Logger.info(LOG_PREFIX, 'New room created', { coreRoomInfo: room.getInfo() });
      this.emitter.emit(C.EVENT.ROOM_CREATED, room);
    }

    return room;
  }

  getRoomThrowable (roomId) {
    const room = this.getRoom(roomId);

    if (room) return room;

    throw C.ERROR.ROOM_NOT_FOUND;
  }

  getRoom (roomId) {
    return this.rooms.get(roomId);
  }

  getRooms () {
    return [...this.rooms.keys()];
  }

  getNumberOfRooms () {
    return this.rooms.size;
  }

  hasRoom (userId) {
    return this.rooms.has(userId);
  }

  _handleRoomDestroyed ({ roomId }) {
    const room = this.getRoom(roomId);

    if (room) {
      room.getUsers().forEach(user => {
        this.leave(roomId, user.userId);
      });
      this.rooms.delete(roomId);
      Logger.info(LOG_PREFIX, "Room destroyed", { roomId });
    }

    MCSPrometheusAgent.set(METRIC_NAMES.ROOMS, this.getNumberOfRooms());
  }

  removeRoom (roomId) {
    let removed = false;
    try {
      const room = this.getRoom(roomId);

      if (room == null) {
        this.emitter.emit(C.EVENT.ROOM_DESTROYED, Room.ROOM_INFO(roomId));
        return true;
      }

      room.destroy();

      return true;
    } catch (error) {
      Logger.error(LOG_PREFIX, "CRITICAL: Room deletion failed",
        { roomId, errorMessage: error.message, errorCode: error.code });
      // Try to roll back, but this is a critical error
      if (!removed) {
        if (this.rooms.delete(roomId)) {
          MCSPrometheusAgent.set(METRIC_NAMES.ROOMS, this.getNumberOfRooms());
          Logger.info(LOG_PREFIX, "CRITICAL: room destruction cleanup", { roomId });
        }
      }
      return false;
    }
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
      user = this.getUser(externalUserId);
      if (user) {
        // If user is found and duplicate EXT_USER_IDs aren't allowed, throw error
        if (!ALLOW_DUPLICATE_EXT_USER_ID) {
          throw this._handleError({
            ...C.ERROR.MEDIA_INVALID_OPERATION,
            details: `externalUserId specified on join and duplicate externalUserId is not allowed`,
          });
        }
        return user;
      }
    }

    // No pre-existing externalUserId sent in the join procedure, create a new one
    user = new User(room, type, params);
    this.users.set(user.id, user);
    if (user.externalUserId !== user.id) this.users.set(user.externalUserId, user);
    MCSPrometheusAgent.set(METRIC_NAMES.USERS, this.getNumberOfUsers());
    room.addUser(user);
    Logger.info(LOG_PREFIX, 'New user joined', {
      roomId, userId: user.id, externalUserId: user.externalUserId,
    });
    // This event handler will be get rid of once the user is destroyed, so it's
    // no biggie it isn't explicitly removed
    if (user.autoLeave) {
      user.once(C.EVENT.EJECT_USER, this._ejectUser);
    }
    return user;
  }

  hasUser (userId) {
    return this.users.has(userId);
  }

  removeUser (user) {
    if (this.users.delete(user.id) | this.users.delete(user.externalUserId)) {
      MCSPrometheusAgent.set(METRIC_NAMES.USERS, this.getNumberOfUsers());
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.USER_LEFT, user.getUserInfo());
    }
  }

  getUserThrowable (userId) {
    const user = this.getUser(userId)

    if (user) return user;

    throw C.ERROR.USER_NOT_FOUND;
  }

  getUser (userId) {
    return this.users.get(userId)
  }

  getNumberOfUsers () {
    return this.users.size;
  }

  getUsers (roomId) {
    try {
      const room = this.getRoomThrowable(roomId);
      return room.getUsers();
    } catch (error) {
      Logger.error(LOG_PREFIX, `getUsers failed for room ${roomId} due to ${error.message}`,
        { roomId, error });
      throw (this._handleError(error));
    }
  }

  getUserMedias (userId) {
    const user = this.getUserThrowable(userId);
    return user.getMediaInfos();
  }

  getRoomMedias (roomId) {
    const room = this.getRoomThrowable(roomId);
    return room.getMediaInfos();
  }

  hasMediaSession (mediaSessionId) {
    return this.mediaSessions.has(mediaSessionId);
  }

  addMediaSession (mediaSession) {
    if (!this.hasMediaSession(mediaSession.id)) {
      this.mediaSessions.set(mediaSession.id, mediaSession);
      MCSPrometheusAgent.set(METRIC_NAMES.MEDIA_SESSIONS, this.getNumberOfMediaSessions());

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
    // FIXME get rid of this ... really - prlanzarin feb 22
    if (mediaId == 'default') {
      return mediaId;
    }

    const mediaSession = this.mediaSessions.get(mediaId);
    if (mediaSession) return mediaSession;

    // Session not found by ID, fallback to media units.
    // This is kind of aberrational; media units were an afterthought. Review
    // soon. - prlanzarin feb 22
    return this.getMedia(mediaId);
  }

  getMediaSessionThrowable (mediaId) {
    const mediaSession = this.getMediaSession(mediaId);

    if (mediaSession) return mediaSession;

    throw this._handleError({
      ...C.ERROR.MEDIA_NOT_FOUND,
      details: `mediaId: ${mediaId}`,
    });
  }

  getNumberOfMediaSessions () {
    return this.mediaSessions.size;
  }

  removeMediaSession (mediaSessionId) {
    const mediaSession = this.getMediaSession(mediaSessionId);
    if (mediaSession) {
      mediaSession.medias.forEach(this.removeMedia.bind(this));
    }

    if (this.mediaSessions.delete(mediaSessionId)) {
      MCSPrometheusAgent.set(METRIC_NAMES.MEDIA_SESSIONS, this.getNumberOfMediaSessions());
    }

    MediaFactory.removeMediaSession(mediaSessionId);
  }

  hasMedia (mediaId) {
    return this.mediaSessions.has(mediaId);
  }

  addMedia (media) {
    if (!this.hasMedia(media.id)) {
      this.medias.set(media.id, media);
    }
    MediaFactory.addMedia(media);
  }

  getMedia (mediaId) {
    return this.medias.get(mediaId);
  }

  removeMedia (media) {
    return this.medias.delete(media.id);
  }

  setContentFloor (roomId, mediaId) {
    try {
      const room = this.getRoomThrowable(roomId);
      const media = this.getMediaSessionThrowable(mediaId);
      return room.setContentFloor(media);
    } catch (error) {
      Logger.error(LOG_PREFIX, `setContentFloor for room ${roomId} as media ${mediaId} failed due to ${error.message}`,
        { roomId, mediaId, error });
      throw (this._handleError(error));
    }
  }

  setConferenceFloor (roomId, mediaId) {
    try {
      const room = this.getRoomThrowable(roomId);
      const media = this.getMediaSessionThrowable(mediaId);
      return room.setConferenceFloor(media);
    } catch (error) {
      Logger.error(LOG_PREFIX, `setConferenceFloor for room ${roomId} as media ${mediaId} failed due to ${error.message}`,
        { roomId, mediaId, error });
      throw (this._handleError(error));
    }
  }

  releaseContentFloor (roomId) {
    const room = this.getRoom(roomId);
    if (room) return room.releaseContentFloor();
  }

  releaseConferenceFloor(roomId, preserve = true) {
    const room = this.getRoom(roomId);
    if (room) return room.releaseConferenceFloor(preserve);
  }

  getContentFloor (roomId) {
    try {
      const room = this.getRoomThrowable(roomId);
      return room.getContentFloor();
    } catch (error) {
      Logger.error(LOG_PREFIX, `getContentFloor for room ${roomId} failed due to ${error.message}`,
        { roomId, error });
      throw (this._handleError(error));
    }
  }

  getConferenceFloor (roomId) {
    try {
      const room = this.getRoomThrowable(roomId);
      return room.getConferenceFloor();
    } catch (error) {
      Logger.error(LOG_PREFIX, `getConferenceFloor for room ${roomId} failed due to ${error.message}`,
        { roomId, error });
      throw (this._handleError(error));
    }
  }

  setVolume (mediaId, volume) {
    try {
      const mediaSession = this.getMediaSessionThrowable(mediaId);
      return mediaSession.setVolume(volume);
    } catch (error) {
      Logger.error(LOG_PREFIX, `setVolume for media$ ${mediaId} failed due to ${error.message}`,
        { mediaId, volume, error });
      throw (this._handleError(error));
    }
  }

  mute (mediaId) {
    try {
      const mediaSession = this.getMediaSessionThrowable(mediaId);
      return mediaSession.mute();
    } catch (error) {
      Logger.error(LOG_PREFIX, `mute for media$ ${mediaId} failed due to ${error.message}`,
        { mediaId, error });
      throw (this._handleError(error));
    }
  }

  unmute (mediaId) {
    try {
      const mediaSession = this.getMediaSessionThrowable(mediaId);
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
  setStrategy () {
    throw this._handleError({
      ...C.ERROR.MEDIA_INVALID_OPERATION,
      details: 'setStrategy is not implemented',
    });
  }

  /*
   * Given a generic identifier that can represent a room, user, media session
   * or media unit, return the current strategy set for the member
   * @param {String} identifier
   */
  getStrategy () {
    throw this._handleError({
      ...C.ERROR.MEDIA_INVALID_OPERATION,
      details: 'getStrategy is not implemented',
    });
  }

  /*
   * Given a generic identifier that can represent a room, user, media session
   * or media unit, probe the models for one of those and return it if found
   * @param {String} identifier
   */
  _getMemberByIdentifier (identifier) {
    try {
      const media = this.getMediaSessionThrowable(identifier);
      return media;
    } catch (e) {
      Logger.debug(LOG_PREFIX, "Media not found, falling back to user", e);
    }

    try {
      const user = this.getUserThrowable(identifier);
      return user;
    } catch (e) {
      Logger.debug(LOG_PREFIX, "User not found, falling back to room", e);
    }

    try {
      const room = this.getRoomThrowable(identifier);
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
      case C.MEMBERS.MEDIA_SESSION: {
        const mediaSession = this.getMediaSession(identifier);
        if (mediaSession) return mediaSession.getMediaInfo();
        return {};
      }
      case C.MEMBERS.MEDIA: {
        const media = this.getMedia(identifier);
        if (media) return media.getMediaInfo();
        return {};
      }
      default:
        throw (this._handleError({
          ...C.ERROR.MEDIA_INVALID_TYPE,
          details: `getMedias memberType is invalid: ${memberType}`,
        }));
    }
  }

  dtmf (mediaId, tone, options) {
    try {
      Logger.debug(LOG_PREFIX, "Sending DTMF tone", { mediaId, tone });
      const mediaSession = this.getMediaSessionThrowable(mediaId);
      return mediaSession.dtmf(tone, options);
    }
    catch (error) {
      throw (this._handleError(error));
    }
  }

  requestKeyframe (mediaId) {
    try {
      Logger.debug(LOG_PREFIX, "Requesting keyframe from media", { mediaId });
      const mediaSession = this.getMediaSessionThrowable(mediaId);
      return mediaSession.requestKeyframe();
    }
    catch (error) {
      throw (this._handleError(error));
    }
  }

  // FIXME this API method is simply broken
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

        mediaSessions.forEach(ms => {
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

  async consume (sourceId, sinkId, type = 'ALL') {
    try {
      const sourceSession = this.getMediaSessionThrowable(sourceId);
      const sinkSession = this.getMediaSessionThrowable(sinkId);

      return sinkSession.consume(sourceSession, type);
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  _handleError (error) {
    return handleError(LOG_PREFIX, error);
  }
}

const MediaController = new MediaControllerC();

module.exports = MediaController;
