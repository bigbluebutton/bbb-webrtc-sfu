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
      instance = this;
    }
    return instance;
  }

  start () {
    // Initialize media server adapters. The empty object is used to start the
    // default ones
    AdapterFactory.getAdapters({});

    this.strategyManager.start();

    GLOBAL_EVENT_EMITTER.on(C.EVENT.ROOM_EMPTY, (roomId) => {
      this.removeRoom(roomId);
    });

    GLOBAL_EVENT_EMITTER.on(C.EVENT.CONFERENCE_NEW_VIDEO_FLOOR, (event) => {
      const { roomId, mediaId } = event;
      try {
        this.setConferenceFloor(roomId, mediaId);
      } catch (e) {
        Logger.error(LOG_PREFIX, "Error setting conference floor", e);
      }
    });

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

  join (roomId, type, clientTrackingId, params) {
    try {
      const room = this.createRoom(roomId);
      // Inherit strategy from room unless it was directly specified
      params.strategy = params.strategy || room.strategy;
      const user = this.createUser(roomId, type, clientTrackingId, params);
      room.addUser(user);
      Logger.info(LOG_PREFIX, `User ${user.id} joined room ${roomId} as ${type}`);
      return user.id;
    } catch (e) {
      throw (this._handleError(e));
    }

  }

  _leave (room, user) {
    try {
      const killedMedias = user.leave();
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
    } catch (err) {
      throw (this._handleError(err));
    }
  }

  leave (roomId, userId, clientTrackingId) {
    Logger.info(LOG_PREFIX, `User wants to leave room`, { userId, roomId, clientTrackingId });
    let user, room;
    try {
      room = this.getRoom(roomId);
      user = this.getUser(userId);
    } catch (error) {
      // User or room were already closed or not found, resolving as it is
      const normalizedError = this._handleError(error);
      Logger.warn(LOG_PREFIX, `Leave for ${userId} failed due to ${error.message}`, { roomId, userId, error });
      throw (normalizedError);
    }

    const remainingClients = user.deleteClientTrackingId(clientTrackingId);
    Logger.info(LOG_PREFIX, `There are ${remainingClients.length} clients tethered to ${userId} on leave`);
    if (remainingClients.length <= 0) {
      try  {
        this._leave(room, user);
      } catch (error) {
        Logger.warn(LOG_PREFIX, `Leave for ${userId} failed due to ${error.message}`, { roomId, userId, error });
        throw error;
      }
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

  publishAndSubscribe (roomId, userId, sourceId, type, params = {}) {
    return new Promise(async (resolve, reject) => {
      Logger.info(LOG_PREFIX, `PublishAndSubscribe from user ${userId} to source ${sourceId}`);
      Logger.trace("[mcs-controler] PublishAndSubscribe descriptor is", params.descriptor);

      try {
        let source;
        type = C.EMAP[type];
        const user = await this.getUser(userId);
        const room = await this.getRoom(user.roomId);

        if (!params.ignoreThresholds && this.isAboveMediaThresholds(room, user)) {
          return reject(this._handleError({
            ...C.ERROR.MEDIA_SERVER_NO_RESOURCES,
            details: `Threshold exceeded. Threshold: ${GLOBAL_MEDIA_THRESHOLD}`,
          }));
        }

        switch (type) {
          case C.MEDIA_TYPE.RTP:
          case C.MEDIA_TYPE.WEBRTC:
          case C.MEDIA_TYPE.URI:
            const { session, answer } = await user.publish(params.descriptor, type, params);
            this.addMediaSession(session);
            room.addMediaSession(session);
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
        const room = await this.getRoom(user.roomId);
        type = C.EMAP[type];

        if (!params.ignoreThresholds && this.isAboveMediaThresholds(room, user)) {
          return reject(this._handleError({
            ...C.ERROR.MEDIA_SERVER_NO_RESOURCES,
            details: `Threshold exceeded. Threshold: ${GLOBAL_MEDIA_THRESHOLD}`,
          }));
        }

        switch (type) {
          case C.MEDIA_TYPE.RTP:
          case C.MEDIA_TYPE.WEBRTC:
          case C.MEDIA_TYPE.URI:
            const { session, answer } = await user.publish(params.descriptor, type, params);
            this.addMediaSession(session);
            room.addMediaSession(session);
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
      Logger.info(LOG_PREFIX, `Subscribe from user ${userId} to source ${sourceId}`);
      Logger.trace(LOG_PREFIX, "Subscribe descriptor is", params.descriptor);
      let source, user, room;
      type = C.EMAP[type];

      try {
        user = await this.getUser(userId);
        room = await this.getRoom(user.roomId);
        if (sourceId === C.MEDIA_PROFILE.CONTENT) {
          source = this.getMediaSession(room._contentFloor.id);
          params.content = true;
        } else {
          source = this.getMediaSession(sourceId);
        }
      } catch (e) {
        return reject(this._handleError(e));
      }

      if (!params.ignoreThresholds && this.isAboveMediaThresholds(room, user)) {
        return reject(this._handleError({
          ...C.ERROR.MEDIA_SERVER_NO_RESOURCES,
          details: `Threshold exceeded. Threshold: ${GLOBAL_MEDIA_THRESHOLD}`,
        }));
      }

      switch (type) {
        case C.MEDIA_TYPE.RTP:
        case C.MEDIA_TYPE.WEBRTC:
        case C.MEDIA_TYPE.URI:
          try {
            const  { session, answer } = await user.subscribe(params.descriptor, type, source, params);
            this.addMediaSession(session);
            room.addMediaSession(session);
            resolve({descriptor: answer, mediaId: session.id});
            session.sessionStarted();
          } catch (e) {
            return reject(this._handleError(e));
          }
          break;
        default:
          return reject(this._handleError(C.ERROR.MEDIA_INVALID_TYPE));
      }
    });
  }

  async unpublish (userId, mediaId) {
    try {
      Logger.info(LOG_PREFIX, `Unpublishing media ${mediaId} of user ${userId}`);
      const user = this.getUser(userId);
      const room = await this.getRoom(user.roomId);
      const answer = await user.unpublish(mediaId);
      this.removeMediaSession(mediaId);
      room.removeMediaSession(mediaId);
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
      Logger.info(LOG_PREFIX, `Unsubscribing media ${mediaId} of user ${userId}`);
      const user = this.getUser(userId);
      const room = await this.getRoom(user.roomId);
      const media = this.getMediaSession(mediaId);
      const answer = await user.unsubscribe(mediaId);
      this.removeMediaSession(mediaId);
      room.removeMediaSession(mediaId);
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
        const room = await this.getRoom(user.roomId);
        const sourceSession = this.getMediaSession(sourceId);

        const { recordingSession, answer } = await user.startRecording(
          recordingPath,
          C.MEDIA_TYPE.RECORDING,
          sourceSession,
          params
        );

        this.addMediaSession(recordingSession);
        room.addMediaSession(recordingSession);

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
        const room = await this.getRoom(user.roomId);
        const recSession = this.getMediaSession(recId);
        const answer = await user.stopSession(recSession.id);
        user.unsubscribe(recSession.id);
        this.removeMediaSession(recId);
        room.removeMediaSession(recId);
        return resolve(answer);
      }
      catch (err) {
        return reject(this._handleError(err));
      }
    });
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
    Logger.info(LOG_PREFIX, "Creating new room with ID", roomId);

    let room = this.rooms.find(r => r.id === roomId);

    if (room == null) {
      room = new Room(roomId);
      this.rooms.push(room);
      this.emitter.emit(C.EVENT.ROOM_CREATED, room);
    }

    return room;
  }

  /**
   * Creates an {User} of type @type
   * @param {String} roomId
   */
  createUser (roomId, type, clientTrackingId, params)  {
    Logger.info(LOG_PREFIX, "Creating a new", type, "user at room", roomId);
    const { userId }  = params;
    let user;

    if (userId) {
      try {
        user = this.getUser(userId);
        user.addClientTrackingId(clientTrackingId);
        return user;
      } catch (e) {
        // User was not found, just ignore it and create a new one
      }
    }

    // No pre-existing userId sent in the join procedure, create a new one
    user = new User(roomId, type, clientTrackingId, params);
    this.users.push(user);
    // This event handler will be get rid of once the user is destroyed, so it's
    // no biggie it isn't explicitly removed
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

      this.strategyManager.removeFromHandler(r.id, r.strategy);

      this.emitter.emit(C.EVENT.ROOM_DESTROYED, r.getInfo());

      r.destroy();

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
    return new Promise(async (resolve, reject) => {
      try {
        const room = await this.getRoom(roomId);
        const media = this.getMediaSession(mediaId);
        const mediaInfo = room.setContentFloor(media);
        resolve(mediaInfo);
      } catch (error) {
        reject(this._handleError(error));
      }
    })
  }

  setConferenceFloor (roomId, mediaId) {
    return new Promise(async (resolve, reject) => {
      try {
        const room = await this.getRoom(roomId);
        const media = this.getMediaSession(mediaId);
        const mediaInfo = room.setConferenceFloor(media);
        resolve(mediaInfo);
      } catch (error) {
        reject(this._handleError(error))
      }
    })
  }

  releaseContentFloor (roomId) {
    return new Promise(async (resolve, reject) => {
      try {
        const room = await this.getRoom(roomId);
        room.releaseContentFloor();
        resolve();
      } catch (error) {
        reject(this._handleError(error));
      }
    })
  }

  releaseConferenceFloor (roomId) {
    return new Promise(async (resolve, reject) => {
      try {
        const room = await this.getRoom(roomId);
        room.releaseConferenceFloor();
        resolve();
      } catch (error) {
        reject(this._handleError(error));
      }
    })
  }

  getContentFloor (roomId) {
    return new Promise(async (resolve, reject) => {
      try {
        const room = await this.getRoom(roomId);
        resolve(room.getContentFloor());
      } catch (error) {
        reject(this._handleError(error));
      }
    })
  }

  getConferenceFloor (roomId) {
    return new Promise(async (resolve, reject) => {
      try {
        const room = await this.getRoom(roomId);
        resolve(room.getConferenceFloor());
      } catch (error) {
        reject(this._handleError(error));
      }
    })
  }

  setVolume (mediaId, volume) {
    return new Promise(async (resolve, reject) => {
      try {
        const mediaSession = this.getMediaSession(mediaId);
        await mediaSession.setVolume(volume);
        resolve();
      } catch (error) {
        reject(this._handleError(error));
      }
    })
  }

  mute (mediaId) {
    return new Promise(async (resolve, reject) => {
      try {
        const mediaSession = this.getMediaSession(mediaId);
        await mediaSession.mute();
        resolve();
      } catch (error) {
        reject(this._handleError(error));
      }
    })
  }

  unmute (mediaId) {
    return new Promise(async (resolve, reject) => {
      try {
        const mediaSession = this.getMediaSession(mediaId);
        await mediaSession.unmute();
        resolve();
      } catch (error) {
        reject(this._handleError(error));
      }
    })
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

  // FIXME
  // this is temporary workaround to create a media that joined freeswitch externally
  async _handleExternalAudioMediaConnected (event) {
    try {
      const { roomId, userId, userName, sdpOffer, sdpAnswer, media } = event;
      const room = await this.createRoom(roomId);
      const user = await this.createUser(roomId, C.USERS.SFU, C.USERS.INTERNAL_TRACKING_ID, { userId, name: userName });
      const session = user.createMediaSession(sdpOffer, C.MEDIA_TYPE.WEBRTC);
      session.sessionStarted();
      room.addMediaSession(session);
      media.mediaSessionId = session.id;
      session.medias = session.medias.concat(media);
      session.localDescriptor = sdpAnswer;
      session.fillMediaTypes();
      session.createAndSetMediaNames();
      this.addMediaSession(session);
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

  _handleError (error) {
    return handleError(LOG_PREFIX, error);
  }
}
