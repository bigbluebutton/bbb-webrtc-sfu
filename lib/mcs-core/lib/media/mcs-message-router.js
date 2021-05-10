'use strict'

const C = require('../constants/constants');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter');
const MediaController = require('./media-controller');
const Logger = require('../utils/logger');
const {
  MCSPrometheusAgent,
  METRIC_NAMES,
  registerMediaSessionTypeMetrics,
} = require('../metrics/index.js');

let instance = null;
let clientId = 0;

const MR = class MCSRouter {
  constructor() {
    if (instance == null) {
      this.emitter = GLOBAL_EVENT_EMITTER;
      this._mcs = null;
      this._mediaController = new MediaController();
      this.clients = {};
      // This is a hash map of client arrays for which the keys are the available
      // events implemented by the API augmented by the event identifier (if it's necessary).
      // The keys are in the following format: <event-name:(identifier? identifier : 'all')>
      this.clientEventMap = {};
      instance = this;
    }

    return instance;
  }

  start (address, port, secure) {
    this._mediaController.start();
    this._dispatchEvents();
  }

  stop () {
    return this._mediaController.stop();
  }

  join (roomId, type, params) {
    try {
      return this._mediaController.join(roomId, type, params);
    }
    catch (error) {
      throw (this._handleError(error, 'join', { roomId, type, params }));
    }
  }

  leave (roomId, userId, params = {}) {
    try {
      return this._mediaController.leave(roomId, userId, params);
    }
    catch (error) {
      throw (this._handleError(error, 'leave', { userId, roomId, }));
    }
  }

  publishnsubscribe (args) {
    const { user, room, type, source, params } = args;
    try {
      return this._mediaController.publishAndSubscribe(room, user, source, type, params);
    }
    catch (error) {
      throw (this._handleError(error, 'publishnsubscribe', { room, user, source, type, params }));
    }
  }

  publish (args) {
    const { user, room, type, params } = args;
    try {
      return this._mediaController.publish(user, room, type, params);
    }
    catch (error) {
      throw (this._handleError(error, 'publish', { user, room, type }));
    }
  }

  unpublish (args) {
    const { userId, mediaId } = args;
    try {
      return this._mediaController.unpublish(userId, mediaId);
    }
    catch (error) {
      throw (this._handleError(error, 'unpublish', { userId, mediaId }));
    }
  }

  subscribe (args) {
    const { user, source, type, params } = args;
    try {
      return this._mediaController.subscribe(user, source, type, params);
    }
    catch (error) {
      throw (this._handleError(error, 'subscribe', { user, source, type }));
    }
  }

  unsubscribe (args) {
    const { userId, mediaId } = args;
    try {
      return this._mediaController.unsubscribe(userId, mediaId);
    }
    catch (error) {
      throw (this._handleError(error, 'unsubscribe',  { userId, mediaId }));
    }
  }

  startRecording (args) {
    const { userId, mediaId, recordingPath, params } = args;
    try {
      return this._mediaController.startRecording(userId, mediaId, recordingPath, params);
    }
    catch (error) {
      throw (this._handleError(error, 'startRecording', { userId, mediaId, recordingPath }));
    }
  }

  stopRecording (args) {
    const { userId, recordingId } = args;
    try {
      return this._mediaController.stopRecording(userId, recordingId);
    }
    catch (error) {
      throw (this._handleError(error, 'stopRecording', { userId, recordingId }));
    }
  }

  async connect (args) {
    const { source_id, sink_ids, type } = args;
    try {
      let cPromises = sink_ids.map((sink) => {
        this._mediaController.connect(source_id, sink, type);
      });

      await Promise.all(cPromises).then(() => {
        return;
      }).catch((err) => {
        throw (this._handleError(err, 'connect', { source_id, sink_ids, type }));
      });
    }
    catch (error) {
      throw (this._handleError(error, 'connect', { source_id, sink_ids, type }));
    }
  }

  async disconnect (args) {
    const { source_id, sink_ids, type } = args;
    try {
      let dcPromises = sink_ids.map((sink) => {
        this._mediaController.disconnect(source_id, sink, type);
      });

      await Promise.all(dcPromises).then(() => {
        return;
      }).catch((err) => {
        throw (this._handleError(err, 'disconnect', { source_id, sink_ids, type }));
      });
    }
    catch (error) {
      throw (this._handleError(error, 'disconnect', { source_id, sink_ids, type }));
    }
  }

  async onEvent (args) {
    const { eventName, identifier } = args;
    try {
      this._mediaController.onEvent(eventName, identifier);
    }
    catch (error) {
      throw (this._handleError(error, 'onEvent', { eventName, identifier }));
    }
  }

  async addIceCandidate (args) {
    const { mediaId, candidate } = args;
    try {
      await this._mediaController.addIceCandidate(mediaId, candidate);
      return;
    }
    catch (error) {
      throw (this._handleError(error, 'addIceCandidate', { mediaId, candidate }));
    }
  }

  getUserMedias (args) {
    const { userId } = args;
    try {
      return this._mediaController.getUserMedias(userId);
    }
    catch (error) {
      throw (this._handleError(error, 'getUserMedias', { userId }));
    }
  }

  getUsers (args) {
    const { roomId } = args;
    try {
      return this._mediaController.getUsers(roomId);
    }
    catch (error) {
      throw (this._handleError(error, 'getUsers', { roomId }));
    }
  }

  getRooms () {
    try {
      return this._mediaController.getRooms();
    }
    catch (error) {
      throw (this._handleError(error, 'getRooms', {}));
    }
  }

  setConferenceFloor (args) {
    const { mediaId, roomId } = args
    try {
      return this._mediaController.setConferenceFloor(roomId, mediaId);
    }
    catch (error) {
      throw (this._handleError(error, 'setConferenceFloor', { roomId, mediaId }))
    }
  }

  setContentFloor (args) {
    const { roomId, mediaId } = args
    try {
      return this._mediaController.setContentFloor(roomId, mediaId);
    }
    catch (error) {
      throw (this._handleError(error, 'setContentFloor', { roomId, mediaId }))
    }
  }

  releaseConferenceFloor (args) {
    const { roomId } = args
    try {
      return this._mediaController.releaseConferenceFloor(roomId);
    }
    catch (error) {
      throw (this._handleError(error, 'releaseConferenceFloor', { roomId }))
    }
  }

  releaseContentFloor (args) {
    const { roomId } = args
    try {
      return this._mediaController.releaseContentFloor(roomId);
    }
    catch (error) {
      throw (this._handleError(error, 'releaseContentFloor', { roomId }))
    }
  }

  getConferenceFloor (args) {
    const { roomId } = args
    try {
      return this._mediaController.getConferenceFloor(roomId);
    }
    catch (error) {
      throw (this._handleError(error, 'getConferenceFloor', { roomId }))
    }
  }

  getContentFloor (args) {
    const { roomId } = args
    try {
      return this._mediaController.getContentFloor(roomId);
    }
    catch (error) {
      throw (this._handleError(error, 'getContentFloor', { roomId }))
    }
  }

  setVolume (args) {
    const { mediaId, volume } = args
    try {
      return this._mediaController.setVolume(mediaId, volume);
    }
    catch (error) {
      throw (this._handleError(error, 'setVolume', { mediaId, volume }))
    }
  }

  mute (args) {
    const { mediaId } = args
    try {
      return this._mediaController.mute(mediaId);
    }
    catch (error) {
      throw (this._handleError(error, 'mute', { mediaId }))
    }
  }

  unmute (args) {
    const { mediaId } = args
    try {
      return this._mediaController.unmute(mediaId);
    }
    catch (error) {
      throw (this._handleError(error, 'unmute', { mediaId }))
    }
  }

  setStrategy ({ identifier, strategy, params = {} }) {
    try {
      this._mediaController.setStrategy(identifier, strategy, params);
    }
    catch (error) {
      throw (this._handleError(error, 'setStrategy', { identifier, strategy, params }));
    }
  }

  getStrategy ({ identifier }) {
    try {
      return this._mediaController.getStrategy(identifier);
    }
    catch (error) {
      throw (this._handleError(error, 'getStrategy', { identifier }));
    }
  }

  dtmf (args) {
    const { mediaId, tone } = args
    try {
      return this._mediaController.dtmf(mediaId, tone)
    }
    catch (error) {
      throw (this._handleError(error, 'dtmf', { mediaId, tone }));
    }
  }

  requestKeyframe (args) {
    const { mediaId } = args
    try {
      return this._mediaController.requestKeyframe(mediaId)
    }
    catch (error) {
      throw (this._handleError(error, 'requestKeyframe', { mediaId }));
    }
  }

  getMedias (args) {
    const { memberType, identifier, options } = args
    try {
      return this._mediaController.getMedias(memberType, identifier, options)
    }
    catch (error) {
      throw (this._handleError(error, 'getMedias', { memberType, identifier }));
    }
  }

  _notifyMethodError (client, error, method, transactionId = null) {
    client.error(error, { transactionId });
    if (method) MCSPrometheusAgent.increment(METRIC_NAMES.REQUEST_ERRORS_TOTAL, { method, errorCode: error.code });
  }

  _handleError (error, operation) {
    const { code, message, details, stack } = error;
    const response = { type: 'error', code, message, details, operation };
    Logger.error("[mcs-router] Reject operation", response.operation, "with", { response, rawError: error });

    return response;
  }

  _trackClientSessions (client, userId, roomId) {
    if (client.userSessions == null) {
      client.userSessions = {};
    }

    client.userSessions[userId] = roomId;
  }

  _closeClientSession (client, userId) {
    try {
      const roomId = client.userSessions[userId];
      this.leave(roomId, userId);
    } catch (e) {
      // Silent. Probably just a trailing leave request with a NOT_FOUND error
    } finally {
      delete client.userSessions[userId];
    }
  }

  _disconnectAllClientSessions (client) {
    Object.keys(client.userSessions).forEach(userId => {
      this._closeClientSession(client, userId);
    });
  };

  /**
   * Setup a new client.
   * After calling this method, the server will be able to handle
   * all MCS messages coming from the given client
   * @param  {external:MCSResponseClient} client Client reference
   */
  setupClient(client) {
    const id = clientId++;
    this.clients[id] = client;
    client.trackingId = id;
    client.userSessions = {};

    client.on('api', (method) => {
      MCSPrometheusAgent.increment(METRIC_NAMES.REQUESTS_TOTAL, { method });
    })

    client.on('close', () => {
      this._removeClientFromEventMap(client);
      this._removeClientFromTracking(client);
      this._disconnectAllClientSessions(client);
    });

    client.on('error', () => {
      this._removeClientFromEventMap(client);
      this._removeClientFromTracking(client);
      this._disconnectAllClientSessions(client);
    });

    client.on('join', (args) =>  {
      let transactionId, room_id, type, params;
      try {
        ({ transactionId, room_id, type, params } = args);
        const userId = this.join(room_id, type, params);
        client.joined(userId, { transactionId });
        this._trackClientSessions(client, userId, room_id);
      } catch (error) {
        this._notifyMethodError(client, error, 'join', transactionId);
      }
    });

    client.on('publishAndSubscribe', async (args) => {
      let transactionId;
      try {
        ({ transactionId } = args);
        const { descriptor, mediaId } = await this.publishnsubscribe(args);
        client.publishedAndSubscribed(mediaId, descriptor, { transactionId });
      } catch (error) {
        this._notifyMethodError(client, error, 'publishAndSubscribe', transactionId);
      }
    });

    client.on('unpublishAndUnsubscribe', async (args) => {
      let userId, mediaId, transactionId;
      try {
        ({ userId, mediaId, transactionId } = args);
        await this.unpublishAndUnsubscribe(args);
        client.unpublishedAndUnsubscribed(userId, mediaId, { transactionId });
      } catch (error) {
        this._notifyMethodError(client, error, 'unpublishAndUnsubscribe', transactionId);
      }
    });

    client.on('publish', async (args) => {
      let transactionId;
      try {
        ({ transactionId } = args);
        const { descriptor, mediaId } = await this.publish(args);
        client.published(mediaId, descriptor, { transactionId });
      } catch (error) {
        this._notifyMethodError(client, error, 'publish', transactionId);
      }
    });

    client.on('unpublish', async (args) => {
      let userId, mediaId, transactionId;
      try {
        ({ userId, mediaId, transactionId } = args);
        await this.unpublish(args);
        client.unpublished(userId, mediaId, { transactionId });
      } catch (error) {
        this._notifyMethodError(client, error, 'unpublish', transactionId);
      }
    });

    client.on('subscribe', async (args) => {
      let transactionId;
      try {
        ({ transactionId } = args);
        const { descriptor, mediaId } = await this.subscribe(args);
        client.subscribed(mediaId, descriptor, { transactionId });
      } catch (error) {
        this._notifyMethodError(client, error, 'subscribe', transactionId);
      }
    });

    client.on('unsubscribe', async (args) => {
      let userId, mediaId, transactionId;
      try {
        ({ userId, mediaId, transactionId } = args);
        await this.unsubscribe(args);
        client.unsubscribed(userId, mediaId, { transactionId });
      } catch (error) {
        this._notifyMethodError(client, error, 'unsubscribe', transactionId);
      }
    });

    client.on('addIceCandidate', async (args) => {
      let mediaId, transactionId;
      try {
        ({ mediaId, transactionId } = args);
        await this.addIceCandidate(args);
        client.iceCandidateAdded(mediaId, { transactionId });
      } catch (error) {
        this._notifyMethodError(client, error, 'addIceCandidate', transactionId);
      }
    });

    client.on('connect', async (args) => {
      let transactionId, source_id, sink_ids;
      try {
        ({ transactionId, source_id, sink_ids } = args);
        await this.connect(args);
        client.connected(source_id, sink_ids, { transactionId });
      } catch (error) {
        this._notifyMethodError(client, error, 'connect', transactionId);
      }
    });

    client.on('disconnect', async (args) => {
      let transactionId, source_id, sink_ids;
      try {
        ({ transactionId, source_id, sink_ids } = args);
        await this.disconnect(args);
        client.disconnected(source_id, sink_ids, { transactionId });
      } catch (error) {
        this._notifyMethodError(client, error, 'disconnect', transactionId);
      }
    });

    client.on('getRooms', (args) => {
      let transactionId;
      try {
        ({ transactionId } = args);
        const rooms = this.getRooms();
        client.roomsList(rooms, { transactionId });
      } catch (error) {
        this._notifyMethodError(client, error, 'getRooms', transactionId);
      }
    });

    client.on('getUsers', (args) => {
      let transactionId;
      try {
        ({ transactionId } = args);
        const users = this.getUsers(args);
        client.usersList(users, { transactionId });
      } catch (error) {
        this._notifyMethodError(client, error, 'getUsers', transactionId);
      }
    });

    client.on('getUserMedias', (args) => {
      let transactionId;
      try {
        ({ transactionId } = args);
        const medias = this.getUserMedias(args);
        client.userMedias(medias, { transactionId });
      } catch (error) {
        this._notifyMethodError(client, error, 'getUserMedias', transactionId);
      }
    });

    client.on('leave', (args) => {
      let userId, roomId, transactionId, params;
      try {
        ({ userId, roomId, transactionId, params } = args);
        this.leave(roomId, userId, params);
        delete client.userSessions[userId];
        client.left(userId, { transactionId });
      } catch (error) {
        this._notifyMethodError(client, error, 'leave', transactionId);
      }
    });

    client.on('onEvent', async (args) => {
      try {
        Logger.trace("[mcs-router] Client", client.trackingId, "subscribing to event", args);
        this._addToClientEventMap(args, client);
        await this.onEvent(args);
      } catch (error) {
        Logger.error('[mcs-router] OnEvent error', error);
      }
    });

    client.on('startRecording', async (args) => {
      let transactionId;
      try {
        ({ transactionId } = args);
        const recordingId = await this.startRecording(args);
        client.recordingStarted(recordingId, { transactionId });
      } catch (error) {
        this._notifyMethodError(client, error, 'startRecording', transactionId);
      }
    });

    client.on('stopRecording', async (args) => {
      let recordingId, transactionId;
      try {
        ({ recordingId, transactionId } = args);
        await this.stopRecording(args);
        client.recordingStopped(recordingId, { transactionId });
      } catch (error) {
        this._notifyMethodError(client, error, 'stopRecording', transactionId);
      }
    });

    client.on('setConferenceFloor', (args) => {
      let transactionId, mediaId, roomId;
      try {
        ({transactionId, mediaId, roomId } = args);
        const { floor, previousFloor } = this.setConferenceFloor(args)
        client.conferenceFloorChanged(roomId, { floor, previousFloor, transactionId })
      } catch (error) {
        this._notifyMethodError(client, error, 'setConferenceFloor', transactionId);
      }
    });

    client.on('setContentFloor', (args) => {
      let transactionId, mediaId, roomId;
      try {
        ({ transactionId, mediaId, roomId } = args);
        const { floor, previousFloor } = this.setContentFloor(args)
        client.contentFloor(roomId, { floor, previousFloor, transactionId })
      } catch (error) {
        this._notifyMethodError(client, error, 'setContentFloor', transactionId);
      }
    });

    client.on('releaseConferenceFloor', (args) => {
      let transactionId, roomId;
      try {
        ({ transactionId, roomId} = args);
        const previousFloorMedia = this.releaseConferenceFloor(args)
        const previousFloorInfo = previousFloorMedia ? previousFloorMedia.getMediaInfo() : undefined;
        client.conferenceFloorChanged(roomId, { previousFloor: previousFloorInfo , transactionId })
      } catch (error) {
        this._notifyMethodError(client, error, 'releaseConferenceFloor', transactionId);
      }
    });

    client.on('releaseContentFloor', (args) =>{
      let transactionId, roomId;
      try {
        ({ transactionId, roomId} = args);
        const previousFloorMedia = this.releaseContentFloor(args)
        const previousFloorInfo = previousFloorMedia ? previousFloorMedia.getMediaInfo() : undefined;
        client.contentFloorChanged(roomId, { previousFloor: previousFloorInfo , transactionId })
      } catch (error) {
        this._notifyMethodError(client, error, 'releaseContentFloor', transactionId);
      }
    });

    client.on('getContentFloor', (args) =>{
      let transactionId, roomId;
      try {
        ({ transactionId, roomId } = args);
        const { floor, previousFloor }  = this.getContentFloor(args)
        client.contentFloor(roomId, { floor, previousFloor, transactionId })
      } catch (error) {
        this._notifyMethodError(client, error, 'getContentFloor', transactionId);
      }
    });

    client.on('getConferenceFloor', (args) => {
      let transactionId, roomId;
      try {
        ({ transactionId, roomId } = args);
        const { floor, previousFloor } = this.getConferenceFloor(args)
        client.conferenceFloor(roomId, { floor, previousFloor, transactionId })
      } catch (error) {
        this._notifyMethodError(client, error, 'getConferenceFloor', transactionId);
      }
    });

    client.on('setVolume', async (args) => {
      let transactionId, mediaId, volume;
      try {
        ({ transactionId, mediaId, volume} = args);
        await this.setVolume(args)
        client.volumeChanged(mediaId, volume, { transactionId })
      } catch (error) {
        this._notifyMethodError(client, error, 'setVolume', transactionId);
      }
    });

    client.on('mute', async (args) => {
      let transactionId, mediaId;
      try {
        ({ transactionId, mediaId} = args);
        await this.mute(args)
        client.muted(mediaId, {}, { transactionId })
      } catch (error) {
        this._notifyMethodError(client, error, 'mute', transactionId);
      }
    });

    client.on('unmute', async (args) => {
      let transactionId, mediaId;
      try {
        ({ transactionId, mediaId} = args);
        await this.unmute(args)
        client.unmuted(mediaId, {}, { transactionId })
      } catch (error) {
        this._notifyMethodError(client, error, 'unmute', transactionId);
      }
    });

    client.on('setStrategy', (args) => {
      let transactionId, identifier, strategy;
      try {
        ({ transactionId, identifier, strategy } = args);
        this.setStrategy(args)
        client.currentStrategy(identifier, strategy, { transactionId })
      } catch (error) {
        this._notifyMethodError(client, error, 'setStrategy', transactionId);
      }
    });

    client.on('getStrategy', (args) => {
      let transactionId, identifier;
      try {
        ({ transactionId, identifier } = args);
        const strategy = this.getStrategy(args)
        client.currentStrategy(identifier, strategy, { transactionId })
      } catch (error) {
        this._notifyMethodError(client, error, 'getStrategy', transactionId);
      }
    });

    client.on('dtmf', async (args) =>{
      let transactionId, mediaId, tone;
      try {
        ({ transactionId, mediaId, tone } = args);
        await this.dtmf(args);
        client.dtmfSent(mediaId, tone, { transactionId });
      } catch (error) {
        this._notifyMethodError(client, error, 'dtmf', transactionId);
      }
    });

    client.on('requestKeyframe', async (args) =>{
      let transactionId, mediaId;
      try {
        ({ transactionId, mediaId } = args);
        await this.requestKeyframe(args);
        client.keyframeRequested(mediaId, { transactionId });
      } catch (error) {
        this._notifyMethodError(client, error, 'requestKeyframe', transactionId);
      }
    });

    client.on('getMedias', (args) =>{
      let transactionId;
      try {
        ({ transactionId } = args);
        const medias = this.getMedias(args);
        client.getMediasResponse(medias, { transactionId });
      } catch (error) {
        this._notifyMethodError(client, error, 'getMedias', transactionId);
      }
    });
  }

  _addToClientEventMap (eventSubscription, client) {
    const { identifier, eventName } = eventSubscription;
    const index = `${eventName}:${identifier}`
    let map = this.clientEventMap[index];
    if (!map) {
      map = [];
      this.clientEventMap[index] = map;
    }
    map.push(client);
  }

  _removeEventFromClientEventMap (identifier, eventName) {
    const index = `${eventName}:${identifier}`
    delete this.clientEventMap[index];
  }

  _removeClientFromEventMap (client) {
    Logger.trace('[mcs-router]', "Removing client", client.trackingId, "from event map");
    Object.keys(this.clientEventMap).forEach(idx => {
      const map = this.clientEventMap[idx].filter(c => c.trackingId !== client.trackingId);
      if (map.length <= 0)  {
        delete this.clientEventMap[idx];
      } else {
        this.clientEventMap[idx] = map;
      }
    });
  }

  _removeClientFromTracking (client) {
    const { trackingId } = client;
    if (trackingId && this.clients[trackingId]) {
      Logger.trace('[mcs-router]', "Removing client", trackingId, "from tracking");
      delete this.clients[trackingId];
    }
  }

  _getClientToDispatch (identifier, eventName) {
    const index = `${eventName}:${identifier}`
    return this.clientEventMap[index] || [];
  }

  _dispatchEvents() {
    this.emitter.on(C.EVENT.MEDIA_STATE.ICE, event => {
      const { mediaId, candidate } = event;
      const clients = this._getClientToDispatch(mediaId, C.EMAP[C.EVENT.MEDIA_STATE.ICE]);

      clients.forEach(client => {
        client.onIceCandidate(mediaId, candidate);
      });
    });

    this.emitter.on(C.EVENT.MEDIA_STATE.MEDIA_EVENT, event => {
      let { mediaId, state, timestampHR, timestampUTC, rawEvent } = event;
      state = { ...state, timestampHR, timestampUTC, rawEvent };
      const clients = this._getClientToDispatch(mediaId, C.EMAP[C.EVENT.MEDIA_STATE.MEDIA_EVENT]);

      clients.forEach(client => {
        client.mediaState(mediaId, state);
      });
    });

    this.emitter.on(C.EVENT.ROOM_CREATED, ({ id }) => {
      const clients = this._getClientToDispatch('all', C.EVENT.ROOM_CREATED);
      Logger.trace('[mcs-router] Room created event', id);
      clients.forEach(client => {
        client.roomCreated(id);
      });
    });

    this.emitter.on(C.EVENT.ROOM_DESTROYED, ({ roomId }) => {
      const clients = this._getClientToDispatch(roomId, C.EVENT.ROOM_DESTROYED);
      this._removeEventFromClientEventMap(roomId, C.EVENT.MEDIA_CONNECTED);
      this._removeEventFromClientEventMap(roomId, C.EVENT.USER_JOINED);
      this._removeEventFromClientEventMap(roomId, C.EVENT.USER_LEFT);
      this._removeEventFromClientEventMap(roomId, C.EVENT.ROOM_DESTROYED);
      this._removeEventFromClientEventMap(roomId, C.EVENT.CONTENT_FLOOR_CHANGED);
      this._removeEventFromClientEventMap(roomId, C.EVENT.CONFERENCE_FLOOR_CHANGED);
      Logger.trace('[mcs-router] Room destroyed event', roomId);
      clients.forEach(client => {
        client.roomDestroyed(roomId);
      });
    });

    this.emitter.on(C.EVENT.MEDIA_CONNECTED, event => {
      const { roomId, memberType } = event;
      const clients = this._getClientToDispatch(roomId, C.EVENT.MEDIA_CONNECTED);

      clients.forEach(client => {
        client.mediaConnected(roomId, event);
      });

      if (memberType === C.MEMBERS.MEDIA_SESSION) {
        registerMediaSessionTypeMetrics('increment', event);
      }
    });

    this.emitter.on(C.EVENT.MEDIA_DISCONNECTED, event => {
      const { roomId, mediaId, memberType } = event;
      const clients = this._getClientToDispatch(mediaId, C.EVENT.MEDIA_DISCONNECTED);

      this._removeEventFromClientEventMap(mediaId, C.EMAP[C.EVENT.MEDIA_STATE.MEDIA_EVENT]);
      this._removeEventFromClientEventMap(mediaId, C.EMAP[C.EVENT.MEDIA_STATE.ICE]);
      this._removeEventFromClientEventMap(mediaId, C.EVENT.MEDIA_DISCONNECTED);
      this._removeEventFromClientEventMap(mediaId, C.EVENT.MEDIA_RENEGOTIATED);
      this._removeEventFromClientEventMap(mediaId, C.EVENT.MEDIA_VOLUME_CHANGED);
      this._removeEventFromClientEventMap(mediaId, C.EVENT.MEDIA_START_TALKING);
      this._removeEventFromClientEventMap(mediaId, C.EVENT.MEDIA_STOP_TALKING);
      this._removeEventFromClientEventMap(mediaId, C.EVENT.MEDIA_MUTED);
      this._removeEventFromClientEventMap(mediaId, C.EVENT.MEDIA_UNMUTED);
      this._removeEventFromClientEventMap(mediaId, C.EVENT.KEYFRAME_NEEDED);
      this._removeEventFromClientEventMap(mediaId, C.EVENT.SUBSCRIBED_TO);

      clients.forEach(client => {
        Logger.trace('[mcs-router] Emitting media disconnected for', mediaId, "at client", client.trackingId);
        client.mediaDisconnected(roomId, mediaId);
      })

      if (memberType === C.MEMBERS.MEDIA_SESSION) {
        registerMediaSessionTypeMetrics('decrement', event);
      }
    });

    this.emitter.on(C.EVENT.USER_JOINED, event => {
      const { roomId, userId } = event;
      const clients = this._getClientToDispatch(roomId, C.EVENT.USER_JOINED);

      clients.forEach(client => {
        client.userJoined(roomId, event);
      })
    });

    this.emitter.on(C.EVENT.USER_LEFT, event => {
      const { roomId , userId } = event;
      const clients = this._getClientToDispatch(roomId, C.EVENT.USER_LEFT);

      clients.forEach(client => {
        client.userLeft(roomId, userId);
      });
    });

    this.emitter.on(C.EVENT.CONTENT_FLOOR_CHANGED, event => {
      const { roomId, floor, previousFloor } = event;
      const clients = this._getClientToDispatch(roomId, C.EVENT.CONTENT_FLOOR_CHANGED);

      clients.forEach(client => {
        client.contentFloorChanged(roomId, { floor, previousFloor });
      })
    });

    this.emitter.on(C.EVENT.CONFERENCE_FLOOR_CHANGED, event => {
      const { roomId, floor, previousFloor } = event;
      const clients = this._getClientToDispatch(roomId, C.EVENT.CONFERENCE_FLOOR_CHANGED);

      clients.forEach(client => {
        client.conferenceFloorChanged(roomId, { floor, previousFloor });
      })
    });

    this.emitter.on(C.EVENT.MEDIA_VOLUME_CHANGED, event => {
      const { mediaId, volume } = event;
      const clients = this._getClientToDispatch(mediaId, C.EVENT.MEDIA_VOLUME_CHANGED);

      clients.forEach(client => {
        client.volumeChanged(mediaId, volume);
      })
    });

    this.emitter.on(C.EVENT.MEDIA_MUTED, event => {
      const { mediaId } = event;
      const clients = this._getClientToDispatch(mediaId, C.EVENT.MEDIA_MUTED);

      clients.forEach(client => {
        client.muted(mediaId);
      })
    });

    this.emitter.on(C.EVENT.MEDIA_UNMUTED, event => {
      const { mediaId } = event;
      const clients = this._getClientToDispatch(mediaId, C.EVENT.MEDIA_UNMUTED);

      clients.forEach(client => {
        client.unmuted(mediaId);
      })
    });

    this.emitter.on(C.EVENT.MEDIA_RENEGOTIATED, event => {
      const { mediaId } = event;
      const clients = this._getClientToDispatch(mediaId, C.EVENT.MEDIA_RENEGOTIATED);

      clients.forEach(client => {
        client.mediaRenegotiated(mediaId, event);
      })
    });

    this.emitter.on(C.EVENT.MEDIA_START_TALKING, event => {
      const { mediaId, roomId, userId } = event;
      const clients = this._getClientToDispatch(mediaId, C.EVENT.MEDIA_START_TALKING);
      if (clients.length > 0) {
        clients.forEach(client => {
          client.startTalking(roomId, userId, mediaId);
        })
      }
    });

    this.emitter.on(C.EVENT.MEDIA_STOP_TALKING, event => {
      const { mediaId, roomId, userId } = event;
      const clients = this._getClientToDispatch(mediaId, C.EVENT.MEDIA_STOP_TALKING);
      if (clients.length > 0) {
        clients.forEach(client => {
          client.stopTalking(roomId, userId, mediaId);
        })
      }
    });

    this.emitter.on(C.EVENT.SUBSCRIBED_TO, ({ mediaId, sourceMediaInfo }) => {
      const clients = this._getClientToDispatch(mediaId, C.EVENT.SUBSCRIBED_TO);

      clients.forEach(client => {
        client.subscribedTo(mediaId, sourceMediaInfo);
      });
    });

    this.emitter.on(C.EVENT.KEYFRAME_NEEDED, mediaId => {
      const clients = this._getClientToDispatch(mediaId, C.EVENT.KEYFRAME_NEEDED);

      clients.forEach(client => {
        client.keyframeNeeded(mediaId);
      });
    });
  }
}

module.exports = new MR();
