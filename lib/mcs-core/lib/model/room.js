/**
 * @classdesc
 * Model class for rooms
 */

'use strict'

const config = require('config');
const C = require('../constants/constants');
const GLOBAL_EVENT_EMITTER = require('../../../common/emitter.js');
const Logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

const { perRoom: ROOM_MEDIA_THRESHOLD } = config.get('mediaThresholds');
const LOG_PREFIX = "[mcs-room]";
const MAX_PREVIOUS_FLOORS = 10;
const MCS_ROOM_DESTRUCTION_TIMER = config.has('mcsRoomDestructionTimer')
  ? config.get('mcsRoomDestructionTimer')
  : 90000; // 01m30s


module.exports = class Room {
  static ROOM_INFO (roomId) {
    return {
      memberType: C.MEMBERS.ROOM,
      roomId,
    };
  }

  constructor (id = uuidv4()) {
    this.id = id;
    this.users = {};
    this.mediaSessions = new Map();
    this.medias = new Map();
    this._conferenceFloor;
    this._previousConferenceFloors = [];
    this._contentFloor;
    this._previousContentFloors = [];
    this._registeredEvents = [];
    this._trackContentMediaDisconnection();
    this._trackConferenceMediaDisconnection();
  }

  getInfo () {
    return Room.ROOM_INFO(this.id);
  }

  getMediaInfos () {
    const mediaInfos = [];
    this.mediaSessions.forEach((mediaSession) => {
      if (mediaSession) {
        mediaInfos.push(mediaSession.getMediaInfo());
      }
    });

    return mediaInfos;
  }

  getUser (id) {
    return this.users[id];
  }

  getUsers () {
    return Object.keys(this.users).map(uk => this.users[uk].getUserInfo());
  }

  isAboveThreshold () {
    if (ROOM_MEDIA_THRESHOLD > 0 && this.getNumberOfMedias() >= ROOM_MEDIA_THRESHOLD) {
      Logger.error(LOG_PREFIX, `Room has exceeded the media threshold`, {
        roomId: this.id, threshold: ROOM_MEDIA_THRESHOLD,
        current: this.getNumberOfMedias(),
      });
      return true;
    }
    return false;
  }

  addUser (user) {
    const found = user.id in this.users;
    if (!found) {
      this.users[user.id] = user;
      if (this.destructionRoutine) this._clearEjectionTimeout();
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.USER_JOINED, { roomId: this.id, user: user.getUserInfo() });
    }
  }

  hasMediaSession (mediaSessionId) {
    return this.mediaSessions.has(mediaSessionId);
  }

  addMediaSession (mediaSession) {
    if (!this.hasMediaSession(mediaSession.id)) {
      this.mediaSessions.set(mediaSession.id, mediaSession);
    }
    mediaSession.medias.forEach(this.addMedia.bind(this));
  }

  getMediaSession (mediaSessionId) {
    return this.mediaSessions.get(mediaSessionId);
  }

  getNumberOfMediaSessions () {
    return this.mediaSessions.size;
  }

  removeMediaSession (mediaSessionId) {
    const mediaSession = this.getMediaSession(mediaSessionId);
    if (mediaSession) {
      mediaSession.medias.forEach(this.removeMedia.bind(this));
      this.mediaSessions.delete(mediaSessionId);
    }
  }

  hasMedia (mediaId) {
    return this.medias.has(mediaId);
  }

  addMedia (media) {
    if (!this.hasMedia(media.id)) {
      this.medias.set(media.id, media);
    }
  }

  getMedia (mediaId) {
    return this.medias.get(mediaId);
  }

  getNumberOfMedias () {
    return this.mediaSessions.size;
  }

  removeMedia (media) {
    return this.medias.delete(media.id);
  }

  getConferenceFloor () {
    const floor = this._conferenceFloor? this._conferenceFloor.getMediaInfo() : undefined;
    const previousFloor = this._previousConferenceFloors.length <= 0
      ? undefined
      : this._previousConferenceFloors.slice(0, MAX_PREVIOUS_FLOORS).map(m => m.getMediaInfo());


    const conferenceFloorInfo = {
      floor,
      previousFloor
    };

    return conferenceFloorInfo;
  }

  getContentFloor () {
    const floor = this._contentFloor ? this._contentFloor.getMediaInfo() : undefined;
    const previousFloor = this._previousContentFloors.length <= 0
      ? undefined
      : this._previousContentFloors.slice(0, MAX_PREVIOUS_FLOORS).map(m => m.getMediaInfo());


    const contentFloorInfo = {
      floor,
      previousFloor
    };

    return contentFloorInfo;
  }

  _setPreviousConferenceFloor () {
    this._previousConferenceFloors = this._previousConferenceFloors.filter(pcf => pcf.id !== this._conferenceFloor.id);
    this._previousConferenceFloors.unshift(this._conferenceFloor);
  }

  setConferenceFloor (media) {
    let tentativeFloor;

    // Check if the media is audio-only. If it is, check the parent media session for
    // video medias If we can't find it there too, fetch the user's media list
    // and look for a valid video media and set it as the floor.
    // If even then there isn't one, do nothing. This is a case where the user
    // is audio only. We could consider implementing a backlog list in case those
    // users join with video later on and lift them from the backlog back
    // to the conference floors
    if (!media.mediaTypes.video) {
      const { mediaSessionId, userId } = media;
      const floorMediaSession = this.getMediaSession(mediaSessionId);
      const findMediaWithVideo = (mediaSession) => {
        return mediaSession.medias.find(m => {
          return m.mediaTypes.video === 'sendrecv' || m.mediaTypes.video === 'sendonly';
        });
      };

      tentativeFloor = findMediaWithVideo(floorMediaSession);

      if (tentativeFloor == null) {
        const floorUser = this.getUser(userId);
        const userMediaSessions = Object.keys(floorUser.mediaSessions).map(msk => floorUser.getMediaSession(msk));

        tentativeFloor = userMediaSessions.find(ms => {
          const msWV = findMediaWithVideo(ms)
          return !!msWV;
        });
      }
    } else {
      tentativeFloor = media;
    }

    if (tentativeFloor == null) {
      return;
    }

    // Rotate the current floor the the previous floors' list
    if (this._conferenceFloor && tentativeFloor.id !== this._conferenceFloor.id) {
      this._setPreviousConferenceFloor();
    }

    this._conferenceFloor = tentativeFloor;
    this._previousConferenceFloors = this._previousConferenceFloors.filter(m => m.id !== tentativeFloor.id);
    const conferenceFloorInfo = this.getConferenceFloor();
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.CONFERENCE_FLOOR_CHANGED, { roomId: this.id, ...conferenceFloorInfo });

    return conferenceFloorInfo;
  }

  _setPreviousContentFloor () {
    this._previousContentFloors = this._previousContentFloors.filter(pcf => pcf.id !== this._contentFloor.id);
    this._previousContentFloors.unshift(this._contentFloor);
  }

  setContentFloor (media) {
    if (this._contentFloor && this._previousContentFloors[0] && this._previousContentFloors[0].id !== this._contentFloor.id) {
      this._setPreviousContentFloor();
    }

    this._contentFloor = media.getContentMedia();
    const contentFloorInfo = this.getContentFloor();
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.CONTENT_FLOOR_CHANGED, { roomId: this.id, ...contentFloorInfo });
    return contentFloorInfo;
  }

  releaseConferenceFloor (preserve = true) {
    if (this._conferenceFloor) {
      const nextFloor = this._previousConferenceFloors.shift();
      if (preserve) {
        this._setPreviousConferenceFloor();
      } else {
        this._previousConferenceFloors = this._previousConferenceFloors.filter(pcf => pcf.id !== this._conferenceFloor.id);
      }
      this._conferenceFloor = nextFloor;
      const conferenceFloorInfo = this.getConferenceFloor();
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.CONFERENCE_FLOOR_CHANGED, { roomId: this.id, ...conferenceFloorInfo});
    }

    return this._previousConferenceFloors[0];
  }

  releaseContentFloor () {
    if (this._contentFloor) {
      this._setPreviousContentFloor();
      this._contentFloor = null;
      const contentFloorInfo = this.getContentFloor();
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.CONTENT_FLOOR_CHANGED, { roomId: this.id, ...contentFloorInfo }) ;
    }

    return this._previousContentFloors[0];
  }

  _registerEvent (event, callback) {
    this._registeredEvents.push({ event, callback });
  }

  _trackContentMediaDisconnection () {
    // Listen for media disconnections and clear the content floor state when needed
    // Used when devices ungracefully disconnect from the system
    const clearContentFloor = (event) => {
      const { mediaId, roomId, mediaSessionId } = event;
      if (roomId === this.id) {
        const { floor } = this.getContentFloor();
        if (floor && (mediaId === floor.mediaId || mediaSessionId === floor.mediaId)) {
          this.releaseContentFloor();
        }

        this._previousContentFloors = this._previousContentFloors.filter(pcf => pcf.id !== mediaId);
      }
    };

    GLOBAL_EVENT_EMITTER.on(C.EVENT.MEDIA_DISCONNECTED, clearContentFloor);
    this._registerEvent(C.EVENT.MEDIA_DISCONNECTED, clearContentFloor);
  }

  _trackConferenceMediaDisconnection () {
    // Listen for media disconnections and clear the conference floor state when needed
    // Used when devices ungracefully disconnect from the system
    const clearConferenceFloor = (event) => {
      const { mediaId, roomId, mediaSessionId } = event;
      if (roomId === this.id) {
        const { floor } = this.getContentFloor();

        if (floor && (mediaId === floor.mediaId || mediaSessionId === floor.mediaId)) {
          this.releaseConferenceFloor(false);
        }
      }
    };

    GLOBAL_EVENT_EMITTER.on(C.EVENT.MEDIA_DISCONNECTED, clearConferenceFloor);
    this._registerEvent(C.EVENT.MEDIA_DISCONNECTED, clearConferenceFloor);
  }

  destroyUser (userId) {
    if (this.users[userId]) {
      delete this.users[userId];
      if (Object.keys(this.users).length <= 0) {
        this._setupDestructionRoutine();
        GLOBAL_EVENT_EMITTER.emit(C.EVENT.ROOM_EMPTY, this.id);
      }
    }
  }

  _clearDestructionRoutine () {
    clearTimeout(this.destructionRoutine);
    this.destructionRoutine = null;
  }

  _setupDestructionRoutine () {
    if (this.destructionRoutine == null) {
      this.destructionRoutine = setTimeout(this._destroy.bind(this), MCS_ROOM_DESTRUCTION_TIMER);
    }
  }

  _destroy () {
    this._registeredEvents.forEach(({ event, callback }) => {
      GLOBAL_EVENT_EMITTER.removeListener(event, callback);
    });
    this._registeredEvents = [];
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.ROOM_DESTROYED, this.getInfo());
  }

  destroy () {
    this._setupDestructionRoutine();
  }
}
