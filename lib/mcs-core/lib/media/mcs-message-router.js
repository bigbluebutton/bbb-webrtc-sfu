'use strict'

const config = require('config');
const C = require('../constants/constants');
const util = require('util');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter');
const MediaController = require('./media-controller');
const Logger = require('../utils/logger');
const MCS = require('mcs-js');

let instance = null;
let clientId = 0;

const MR = class MCSRouter {
  constructor() {
    if (instance == null) {
      this.emitter = GLOBAL_EVENT_EMITTER;
      this._mcs = null;
      this._mediaController = new MediaController();
      this.clients = {};
      this.clientEventMap = [];
      instance = this;
    }

    return instance;
  }

  async start (address, port, secure) {
    this._dispatchEvents();
  }

  async join (args) {
    const { room_id, type, params } = args;
    try {
      const userId = await this._mediaController.join(room_id, type, params);
      return userId;
    }
    catch (error) {
      throw (this._handleError(error, 'join', { room_id , type, params}));
    }
  }

  async leave (args) {
    const { userId, roomId } = args;
    try {
      const answer = await this._mediaController.leave(roomId, userId);
      return (answer);
    }
    catch (error) {
      throw (this._handleError(error, 'leave', { ...arguments }));
    }
  }

  async publishnsubscribe (args) {
    const { user, room, type, source, params } = args;
    try {
      const answer = await this._mediaController.publishAndSubscribe(room, user, source, type, params);
      return (answer);
    }
    catch (error) {
      throw (this._handleError(error, 'publishnsubscribe', { room, user, source, type, params }));
    }
  }

  async publish (args) {
    const { user, room, type, params } = args;
    try {
      const answer = await this._mediaController.publish(user, room, type, params);
      return (answer);
    }
    catch (error) {
      throw (this._handleError(error, 'publish', { ...arguments }));
    }
  }

  async unpublish (args) {
    const { mediaId } = args;
    try {
      await this._mediaController.unpublish(mediaId);
      return ;
    }
    catch (error) {
      throw (this._handleError(error, 'unpublish', { ...arguments }));
    }
  }

  async subscribe (args) {
    const { user, source, type, params } = args;
    try {
      const answer = await this._mediaController.subscribe(user, source, type, params);
      return (answer);
    }
    catch (error) {
      throw (this._handleError(error, 'subscribe', { ...arguments }));
    }
  }

  async unsubscribe (args) {
    const { userId, mediaId } = args;
    try {
      await this._mediaController.unsubscribe(userId, mediaId);
      return ;
    }
    catch (error) {
      throw (this._handleError(error, 'unsubscribe',  { ...arguments }));
    }
  }

  async startRecording(args) {
    const { userId, mediaId, recordingPath } = args;
    try {
      const { userId, mediaId, recordingPath } = args;
      const answer = await this._mediaController.startRecording(userId, mediaId, recordingPath);
      return (answer);
    }
    catch (error) {
      throw (this._handleError(error, 'startRecording', { userId, mediaId, recordingPath}));
    }
  }

  async stopRecording(args) {
    try {
      const { userId, recordingId } = args;
      const answer = await this._mediaController.stopRecording(userId, recordingId);
      return (answer);
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

  async disconnect (source, sink, type) {
    try {
      await this._mediaController.disconnect(source, sink, type);
      //await this._mediaController.disconnect(source, sink, type);
      return ;
    }
    catch (error) {
      throw (this._handleError(error, 'disconnect', { source, sink, type }));
    }
  }

  async onEvent (args) {
    const { eventName, identifier } = args;
    try {
      this._mediaController.onEvent(eventName, identifier);
    }
    catch (error) {
      throw (this._handleError(error, 'onEvent', args));
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

  async getUserMedias (args) {
    const { userId } = args;
    try {
      const medias = await this._mediaController.getUserMedias(userId);
      return medias;
    }
    catch (error) {
      throw (this._handleError(error, 'getUserMedias', { userId }));
    }
  }

  async getUsers (args) {
    const { roomId } = args;
    try {
      const users = await this._mediaController.getUsers(roomId);
      return users;
    }
    catch (error) {
      throw (this._handleError(error, 'getUsers', { roomId }));
    }
  }

  async getRooms () {
    try {
      const rooms = this._mediaController.getRooms();
      return rooms;
    }
    catch (error) {
      throw (this._handleError(error, 'getRooms', {}));
    }
  }

  async setConferenceFloor(args) {
    try {
      const { mediaId, roomId } = args
      const mediaInfo = await this._mediaController.setConferenceFloor(roomId, mediaId)
      return mediaInfo;
    }
    catch (error) {
      throw (this._handleError(error, 'setConferenceFloor', {}))
    }
  }

  async setContentFloor(args) {
    try {
      const { roomId, mediaId } = args
      const mediaInfo = await this._mediaController.setContentFloor(roomId, mediaId)
      return mediaInfo;
    }
    catch (error) {
      throw (this._handleError(error, 'setContentFloor', {}))
    }
  }

  async releaseConferenceFloor(args) {
    try {
      const { mediaId, roomId } = args
      await this._mediaController.releaseConferenceFloor(roomId, mediaId)
    }
    catch (error) {
      throw (this._handleError(error, 'releaseConferenceFloor', {}))
    }
  }

  async releaseContentFloor(args) {
    try {
      const { roomId, mediaId } = args
      await this._mediaController.releaseContentFloor(roomId, mediaId)
    }
    catch (error) {
      throw (this._handleError(error, 'releaseContentFloor', {}))
    }
  }

  async getConferenceFloor(args) {
    const { roomId } = args
    try {
      await this._mediaController.getConferenceFloor(roomId)
    }
    catch (error) {
      throw (this._handleError(error, 'getConferenceFloor', {}))
    }
  }

  async getContentFloor(args) {
    const { roomId } = args
    try {
      await this._mediaController.getContentFloor(roomId)
    }
    catch (error) {
      throw (this._handleError(error, 'getContentFloor', {}))
    }
  }

  _notifyMethodError (client, error, transactionId = null) {
    client.error(error, { transactionId });
  }

  _handleError (error, operation) {
    const { code, message, details } = error;
    const response = { type: 'error', code, message, details, operation };
    Logger.error("[mcs-router] Reject operation", response.operation, "with", { error: response });

    return response;
  }

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

    client.on('close', () => {
      this._removeClientFromEventMap(client);
      this._removeClientFromTracking(client);
    });

    client.on('error', () => {
      this._removeClientFromEventMap(client);
      this._removeClientFromTracking(client);
    });

    client.on('join', async (args) =>  {
      let transactionId;
      try {
        ({ transactionId } = args);
        const userId = await this.join(args);
        client.joined(userId, { transactionId });
      } catch (e) {
        this._notifyMethodError(client, e, transactionId);
      }
    });

    client.on('publishAndSubscribe', async (args) => {
      let transactionId;
      try {
        ({ transactionId } = args);
        const { descriptor, mediaId } = await this.publishnsubscribe(args);
        client.publishedAndSubscribed(mediaId, descriptor, { transactionId });
      } catch (e) {
        this._notifyMethodError(client, e, transactionId);
      }
    });

    client.on('unpublishAndUnsubscribe', async (args) => {
      let userId, mediaId, transactionId;
      try {
        ({ userId, mediaId, transactionId } = args);
        await this.unpublishAndUnsubscribe(args);
        client.unpublishedAndUnsubscribed(userId, mediaId, { transactionId });
      } catch (e) {
        this._notifyMethodError(client, e, transactionId);
      }
    });

    client.on('publish', async (args) => {
      let transactionId;
      try {
        ({ transactionId } = args);
        const { descriptor, mediaId } = await this.publish(args);
        client.published(mediaId, descriptor, { transactionId });
      } catch (e) {
        this._notifyMethodError(client, e, transactionId);
      }
    });

    client.on('unpublish', async (args) => {
      let userId, mediaId, transactionId;
      try {
        ({ userId, mediaId, transactionId } = args);
        await this.unpublish(args);
        client.unpublished(userId, mediaId, { transactionId });
      } catch (e) {
        this._notifyMethodError(client, e, transactionId);
      }
    });

    client.on('subscribe', async (args) => {
      let transactionId;
      try {
        ({ transactionId } = args);
        const { descriptor, mediaId } = await this.subscribe(args);
        client.subscribed(mediaId, descriptor, { transactionId });
      } catch (e) {
        this._notifyMethodError(client, e, transactionId);
      }
    });

    client.on('unsubscribe', async (args) => {
      let userId, mediaId, transactionId;
      try {
        ({ userId, mediaId, transactionId } = args);
        await this.unsubscribe(args);
        client.unsubscribed(userId, mediaId, { transactionId });
      } catch (e) {
        this._notifyMethodError(client, e, transactionId);
      }
    });

    client.on('addIceCandidate', async (args) => {
      let mediaId, transactionId;
      try {
        ({ mediaId, transactionId } = args);
        await this.addIceCandidate(args);
        client.iceCandidateAdded(mediaId, { transactionId });
      } catch (e) {
        this._notifyMethodError(client, e, transactionId);
      }
    });

    client.on('connect', async (args) => {
      let transactionId, source_id, sink_ids;
      try {
        ({ transactionId, source_id, sink_ids } = args);
        await this.connect(args);
        client.connected(source_id, sink_ids, { transactionId });
      } catch (e) {
        this._notifyMethodError(client, e, transactionId);
      }
    });

    client.on('disconnect', async (args) => {
      let transactionId, source_id, sink_ids;
      try {
        ({ transactionId, source_id, sink_ids } = args);
        await this.disconnect(args);
        client.disconnected(sourceId, sink_ids, { transactionId });
      } catch (e) {
        this._notifyMethodError(client, e, transactionId);
      }
    });

    client.on('getRooms', async (args) => {
      let transactionId;
      try {
        ({ transactionId } = args);
        const rooms = await this.getRooms();
        client.roomsList(rooms, { transactionId });
      } catch (e) {
        this._notifyMethodError(client, e, transactionId);
      }
    });

    client.on('getUsers', async (args) => {
      let transactionId;
      try {
        ({ transactionId } = args);
        const users = await this.getUsers(args);
        client.usersList(users, { transactionId });
      } catch (e) {
        this._notifyMethodError(client, e, transactionId);
      }
    });

    client.on('getUserMedias', async (args) => {
      let transactionId;
      try {
        ({ transactionId } = args);
        const medias = await this.getUserMedias(args);
        client.userMedias(medias, { transactionId });
      } catch (e) {
        this._notifyMethodError(client, e, transactionId);
      }
    });

    client.on('leave', async (args) => {
      let userId, transactionId;
      try {
        ({ userId, transactionId } = args);
        await this.leave(args);
        client.left(userId, { transactionId });
      } catch (e) {
        this._notifyMethodError(client, e, transactionId);
      }
    });

    client.on('onEvent', async (args) => {
      try {
        Logger.trace("[mcs-router] Subscribing to event", args);
        const { eventName, identifier } = args;
        const eventMap = { identifier, eventName, client };
        this._addToClientEventMap(eventMap);
        await this.onEvent(args);
      } catch (e) {
        Logger.error('[mcs-router] OnEvent error', e);
      }
    });

    client.on('startRecording', async (args) => {
      let transactionId;
      try {
        ({ transactionId } = args);
        const recordingId = await this.startRecording(args);
        client.recordingStarted(recordingId, { transactionId });
      } catch (e) {
        this._notifyMethodError(client, e, transactionId);
      }
    });

    client.on('stopRecording', async (args) => {
      let recordingId, transactionId;
      try {
        ({ recordingId, transactionId } = args);
        await this.stopRecording(args);
        client.recordingStopped(recordingId, { transactionId });
      } catch (e) {
        this._notifyMethodError(client, e, transactionId);
      }
    });

    client.on('setConferenceFloor', async (args) => {
      let transactionId, mediaId, roomId;
      try {
        ({transactionId, mediaId, roomId } = args);
        const media = await this.setConferenceFloor(args)
        client.conferenceFloorChanged(roomId, media, {transactionId})
      }
      catch (e) {
        this._notifyMethodError(client, e, transactionId)
      }
    });

    client.on('setContentFloor', async (args) =>{
      let transactionId, mediaId, roomId;
      try {
        ({ transactionId, mediaId, roomId } = args);
        const media = await this.setContentFloor(args)
        client.contentFloorChanged(roomId, media, {transactionId})
      }
      catch (e) {
        this._notifyMethodError(client, e, transactionId)
      }
    });

    client.on('releaseConferenceFloor', async (args) => {
      let transactionId, mediaId, roomId;
      try {
        ({ transactionId, mediaId, roomId} = args);
        const media = await this.releaseConferenceFloor(args)
        client.conferenceFloorChanged(roomId, {}, {transactionId})
      }
      catch (e) {
        this._notifyMethodError(client, e, transactionId)
      }
    });

    client.on('releaseContentFloor', async (args) =>{
      let transactionId, mediaId, roomId;
      try {
        ({ transactionId, mediaId, roomId} = args);
        await this.releaseContentFloor(args)
        client.contentFloorChanged(roomId, {}, {transactionId})
      }
      catch (e) {
        this._notifyMethodError(client, e, transactionId)
      }
    });

    client.on('getContentFloor', async (args) =>{
      let transactionId, roomId
      try {
        ({ transactionId, roomId } = args);
        const mediaId = await this.getContentFloor(args)
        client.contentFloor(roomId, mediaId, {transactionId})
      }
      catch (e) {
        this._notifyMethodError(client, e, transactionId)
      }
    });

    client.on('getConferenceFloor', async (args) =>{
      let transactionId, roomId
      try {
        ({ transactionId, roomId } = args);
        const mediaId = await this.getConferenceFloor(args)
        client.conferenceFloor(roomId, mediaId, {transactionId})
      }
      catch (e) {
        this._notifyMethodError(client, e, transactionId)
      }
    });
  }

  _addToClientEventMap (map) {
    this.clientEventMap.push({ ...map });
    //this.clientEventMap.forEach(c => Logger.trace("Mapped client", c.identifier, c.eventName, typeof c.client));
  }

  _removeFromClientEventMap (identifier, eventName) {
    this.clientEventMap = this.clientEventMap.filter(c => c.identifier !== identifier && c.eventName !== eventName);
  }

  _removeClientFromEventMap (client) {
    Logger.trace('[mcs-router]', "Removing client", client.trackingId, "from event map");
    this.clientEventMap = this.clientEventMap.filter(c => c.trackingId == client.trackingId);
  }

  _removeClientFromTracking (client) {
    const { trackingId } = client;
    if (trackingId && this.clients[trackingId]) {
      Logger.trace('[mcs-router]', "Removing client", trackingId, "from tracking");
      delete this.clients[trackingId];
    }
  }

  _getClientToDispatch (identifier, eventName) {
    const clientMap = this.clientEventMap.find(c => c.identifier === identifier && c.eventName === eventName);

    if (clientMap) {
      Logger.trace('[mcs-router] Found client', clientMap.identifier, clientMap.eventName)
    }

    const client = clientMap ? clientMap.client : undefined;
    return client;
  }

  _dispatchEvents() {
    this.emitter.on(C.EVENT.MEDIA_STATE.ICE, event => {
      const { mediaId, candidate } = event;
      const client = this._getClientToDispatch(mediaId, C.EMAP[C.EVENT.MEDIA_STATE.ICE]);

      if (client) {
        client.onIceCandidate(mediaId, candidate);
      }
    });

    this.emitter.on(C.EVENT.MEDIA_STATE.MEDIA_EVENT, event => {
      const { mediaId, state } = event;
      const client = this._getClientToDispatch(mediaId, C.EMAP[C.EVENT.MEDIA_STATE.MEDIA_EVENT]);

      if (client) {
        client.mediaState(mediaId, state);
      }
    });

    this.emitter.on(C.EVENT.ROOM_CREATED, event => {
      const { roomId } = event;
      const client = this._getClientToDispatch('all', C.EVENT.ROOM_CREATED);

      Logger.trace('[mcs-router] Room created event', event, typeof client);

      if (client) {
        client.roomCreated(event);
      }
    });

    this.emitter.on(C.EVENT.ROOM_DESTROYED, event => {
      const { roomId } = event;
      const client = this._getClientToDispatch('all', C.EVENT.ROOM_DESTROYED);

      Logger.trace('[mcs-router] Room destroyed event', event, typeof client);

      this._removeFromClientEventMap(roomId, C.EVENT.MEDIA_CONNECTED);
      this._removeFromClientEventMap(roomId, C.EVENT.USER_JOINED);
      this._removeFromClientEventMap(roomId, C.EVENT.USER_LEFT);

      if (client) {
        client.roomDestroyed(event);
      }
    });

    this.emitter.on(C.EVENT.MEDIA_CONNECTED, event => {
      const { roomId } = event;
      const client = this._getClientToDispatch(roomId, C.EVENT.MEDIA_CONNECTED);

      //this.clientEventMap.forEach(c => Logger.trace("Mapped client", c.identifier, c.eventName, typeof c.client));

      if (client) {
        client.mediaConnected(roomId, event);
      }
    });

    this.emitter.on(C.EVENT.MEDIA_DISCONNECTED, event => {
      const { roomId, mediaId } = event;
      const client = this._getClientToDispatch(mediaId, C.EVENT.MEDIA_DISCONNECTED);
      this._removeFromClientEventMap(mediaId, C.EMAP[C.EVENT.MEDIA_STATE.MEDIA_EVENT]);
      this._removeFromClientEventMap(mediaId, C.EMAP[C.EVENT.MEDIA_STATE.ICE]);

      Logger.trace('[mcs-router] Emitting media disconnected for', mediaId, typeof client);

      if (client) {
        client.mediaDisconnected(roomId, mediaId);
      }
    });

    this.emitter.on(C.EVENT.USER_JOINED, event => {
      const { roomId, userId } = event;
      const client = this._getClientToDispatch(roomId, C.EVENT.USER_JOINED);

      if (client) {
        client.userJoined(roomId, event);
      }
    });

    this.emitter.on(C.EVENT.USER_LEFT, event => {
      const { roomId , userId } = event;
      const client = this._getClientToDispatch(roomId, C.EVENT.USER_LEFT);

      if (client) {
        client.userLeft(roomId, userId);
      }
    });

    this.emitter.on(C.EVENT.CONTENT_FLOOR_CHANGED, event => {
      const { roomId, media } = event;
      const client = this._getClientToDispatch(roomId, C.EVENT.CONTENT_FLOOR_CHANGED);

      if (client) {
        client.contentFloorChanged(roomId, media);
      }
    });

    this.emitter.on(C.EVENT.CONFERENCE_FLOOR_CHANGED, event => {
      const { roomId, media } = event;
      const client = this._getClientToDispatch(roomId, C.EVENT.CONFERENCE_FLOOR_CHANGED);

      if (client) {
        client.conferenceFloorChanged(roomId, media);
      }
    });
  }
}

module.exports = new MR();
