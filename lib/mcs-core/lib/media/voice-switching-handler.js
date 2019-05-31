'use strict';

const config = require('config');
const Logger = require('../utils/logger.js');
const C = require('../constants/constants.js');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter.js');
const BaseStrategyHandler = require('./base-strategy-handler.js');

const LOG_PREFIX = "[mcs-voice-switching-handler]";

class VoiceSwitchingHandler extends BaseStrategyHandler {
  constructor (room, name) {
    super(room, name);
    this.conferenceFloor;
    this.contentFloor;
    this.previousConferenceFloors = [];
    this.previousContentFloors = [];

    this._handleConferenceFloorChanged = this._handleConferenceFloorChanged.bind(this);
    this._handleConferenceFloorChanged = this._handleConferenceFloorChanged.bind(this);
  }

  start () {
    GLOBAL_EVENT_EMITTER.on(C.EVENT.CONFERENCE_FLOOR_CHANGED, this._handleConferenceFloorChanged);
    this.registerEvent(C.EVENT.CONFERENCE_FLOOR_CHANGED, this._handleConferenceFloorChanged)
    GLOBAL_EVENT_EMITTER.on(C.EVENT.CONTENT_FLOOR_CHANGED, this._handleContentFloorChanged);
    this.registerEvent(C.EVENT.CONTENT_FLOOR_CHANGED, this._handleContentFloorChanged)
  }

  stop () {
    this.room = null;
    this.conferenceFloor = null;
    this.contentFloor = null;
    this.previousConferenceFloors = null;
    this.previousContentFloors = null;
    this._registeredEvents.forEach(({ event, callback }) => {
      GLOBAL_EVENT_EMITTER.removeListener(event, callback);
    });

    this._registeredEvents = [];
  }

  runStrategy () {
    return this._floorJanitor();
  }

  async _handleConferenceFloorChanged (event) {
    const { roomId, floor, previousFloors } = event;

    // Not supposed to be handled by this handler, skip
    if (roomId !== this.room.id) {
      return;
    }

    Logger.info(LOG_PREFIX, "Conference floor for room", roomId, "changed");

    // Reassign conference floors and re-run the strategy
    this.conferenceFloor = this.room.getMediaSession(floor.mediaSessionId);
    this.previousConferenceFloors = previousFloors || [];

    try {
      await this.runStrategy();
    } catch (e) {
      // TODO decide what the frick to do with this error
      Logger.error(e);
    }
  }

  async _handleContentFloorChanged (event) {
    const { roomId, floor, previousFloors } = event;

    // Not supposed to be handled by this handler, skip
    if (roomId !== this.room.id) {
      return;
    }

    Logger.info(LOG_PREFIX, "Content floor for room", roomId, "changed");

    // Reassign content floors and re-run the strategy
    this.contentFloor = floor;
    this.previousContentFloors = previousFloors || [];

    try {
      await this.runStrategy();
    } catch (e) {
      // TODO decide what the frick to do with this error
      Logger.error(e);
    }
  }

  async _floorJanitor () {
    const hasContent = !!this.contentFloor;

    // Check if content is in place. If so, avoid running the floor connection procedure.
    // Subscribe any orphaned endpoints to the content stream
    // The voice floors are accounted for and preserver in the meantime
    if (hasContent) {
      return this._reviewMeetingFloors(this.contentFloor, this.previousConferenceFloors);
    }

    // Get a floor registered as talker OR one of the previous talkers OR the first one
    // to join the room, short-circuit
    const floor = this.conferenceFloor ||
      this.previousConferenceFloors[0] ||
      this.room.mediaSessions[0];

    // Filter the chosen floor from above out of the fallback floors.
    const fallbackFloors = this.previousConferenceFloors
      .concat(this.room.mediaSessions)
      .filter(ms => ms.id !== floor.id);

    if (floor) {
      Logger.info(LOG_PREFIX, "Found floor for", this.room.id, floor.mediaSessionId);
      this._reviewMeetingFloors(floor, fallbackFloors);
    }
  }

  _reviewMeetingFloors (floor, previousFloors) {
    // We need to work only over media sessions with this handler, so ignore
    // users, rooms and medias as those can be inferred
    const mediaSessions = this.members.filter(m => m.memberType === C.MEMBERS.MEDIA_SESSION);

    // Group sink medias by user as to not duplicate connections among a same user
    // that negotiates multiple media sessions
    const userSinkMedias = mediaSessions.reduce((acc, msInfo) => {
      const { userId, mediaSessionId } = msInfo;
      if (!acc[userId]) {
        acc[userId] = [];
      }

      const mediaSession = this.room.getMediaSession(mediaSessionId);

      if (mediaSession) {
        acc[userId].push(...mediaSession.medias);
      }
      return acc;
    }, {});

    Object.keys(userSinkMedias).forEach(userId => {
      const sinkMedias = userSinkMedias[userId];
      this._connectMediaFloors(sinkMedias, floor, previousFloors);
    });
  }

  _connectMediaFloors (sinkMedias, floorMediaSession, previousFloors) {
    if (sinkMedias) {
      // Get only the video medias from the session  that are capable of receiving
      let availableSinkMedias = sinkMedias.filter(sm => {
        const { mediaTypes } = sm;
        if (mediaTypes.video && (mediaTypes.video === 'sendrecv' ||
          mediaTypes.video === 'recvonly')) {
          return true;
        }

        return false;
      });

      // Deep copy the floor medias array
      const floorMedias = [...floorMediaSession.medias];

      const numberOfSinkMedias = availableSinkMedias.length;
      const floorsInRange = floorMedias.splice(0, numberOfSinkMedias);

      const mishMashConnect = (floors, sinks) => {
        floors.forEach(fm => {
          const mediasToConnect = sinks
            .filter(sm => sm.subscribedTo !== fm.id &&
              sm.id !== fm.id &&
              sm.mediaSessionId !== fm.mediaSessionId
            );

          if (mediasToConnect.length > 0) {
            fm.connect(mediasToConnect[0], 'VIDEO');
            Logger.info(LOG_PREFIX, "Connecting", fm.id, "to", mediasToConnect[0].id);
            sinks = sinks.filter(sm => sm.id !== mediasToConnect[0].id);
          }
        });

        return sinks;
      }

      availableSinkMedias = mishMashConnect(floorsInRange, availableSinkMedias);

      // There are still unconnected floors, search for the remaining things
      if (availableSinkMedias.length > 0 && floorMedias.length > 0) {
        mishMashConnect(floorMedias, availableSinkMedias);
      }
    }
  }
}


module.exports = VoiceSwitchingHandler;
