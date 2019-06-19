'use strict'

const config = require('config');
const C = require('../constants/constants');
const util = require('util');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter');
const MediaController = require('./media-controller');
const Logger = require('../utils/logger');
const MCS = require('mcs-js');
const LOG_PREFIX = "[mcs-router]"

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
    this._mediaController.start();
    this._dispatchEvents();
  }

  async stop () {
    return this._mediaController.stop();
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
    const { userId, recordingId } = args;
    try {
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
      throw (this._handleError(error, 'connect', { ...args }));
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
      const floorInfo = await this._mediaController.setConferenceFloor(roomId, mediaId)
      return floorInfo;
    }
    catch (error) {
      throw (this._handleError(error, 'setConferenceFloor', {}))
    }
  }

  async setContentFloor(args) {
    try {
      const { roomId, mediaId } = args
      const floorInfo = await this._mediaController.setContentFloor(roomId, mediaId)
      return floorInfo;
    }
    catch (error) {
      throw (this._handleError(error, 'setContentFloor', {}))
    }
  }

  async releaseConferenceFloor(args) {
    try {
      const { roomId } = args
      const previousFloor = await this._mediaController.releaseConferenceFloor(roomId)
      return previousFloor;
    }
    catch (error) {
      throw (this._handleError(error, 'releaseConferenceFloor', {}))
    }
  }

  async releaseContentFloor(args) {
    try {
      const { roomId } = args
      const previousFloor = await this._mediaController.releaseContentFloor(roomId)
      return previousFloor;
    }
    catch (error) {
      throw (this._handleError(error, 'releaseContentFloor', {}))
    }
  }

  async getConferenceFloor(args) {
    const { roomId } = args
    try {
      const floorInfo = await this._mediaController.getConferenceFloor(roomId)
      return floorInfo;
    }
    catch (error) {
      throw (this._handleError(error, 'getConferenceFloor', {}))
    }
  }

  async getContentFloor(args) {
    const { roomId } = args
    try {
      const floorInfo = await this._mediaController.getContentFloor(roomId)
      return floorInfo;
    }
    catch (error) {
      throw (this._handleError(error, 'getContentFloor', {}))
    }
  }

  async setVolume(args) {
    const { mediaId, volume } = args
    try {
      await this._mediaController.setVolume(mediaId,volume)
    }
    catch (error) {
      throw (this._handleError(error, 'setVolume', { mediaId, volume }))
    }
  }

  async mute(args) {
    const { mediaId } = args
    try {
      await this._mediaController.mute(mediaId)
    }
    catch (error) {
      throw (this._handleError(error, 'mute', { mediaId }))
    }
  }

  async unmute(args) {
    const { mediaId } = args
    try {
      await this._mediaController.unmute(mediaId)
    }
    catch (error) {
      throw (this._handleError(error, 'unmute', {mediaId}))
    }
  }

  async dtmf (args) {
    const { mediaId, tone } = args
    try {
      await this._mediaController.dtmf(mediaId, tone)
    }
    catch (error) {
      throw (this._handleError(error, 'dtmf', { mediaId, tone }))
    }
  }

  _notifyMethodError (client, error, transactionId = null) {
    client.error(error, { transactionId });
  }

  _handleError (error, operation) {
    const { code, message, details, stack } = error;
    const response = { type: 'error', code, message, details, operation };
    Logger.trace(LOG_PREFIX, "Error stack", stack);
    Logger.error("[mcs-router] Reject operation", response.operation, "with", { error: response });

    return response;
  }

  _disconnectAllClientSessions (client) {
    client.userSessions.forEach(async s => {
      try {
        await this.leave(s);
      } catch (e) {
        this._handleError(e, 'leave');
      }
    });
    client.userSessions = [];
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
    client.userSessions = [];

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

    client.on('join', async (args) =>  {
      let transactionId, room_id;
      try {
        ({ transactionId, room_id } = args);
        const userId = await this.join(args);
        client.joined(userId, { transactionId });
        client.userSessions.push({ userId, roomId: room_id });
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
        client.disconnected(source_id, sink_ids, { transactionId });
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
        Logger.trace("[mcs-router] Client", client.trackingId, "subscribing to event", args);
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
        const { floor, previousFloor } = await this.setConferenceFloor(args)
        client.conferenceFloorChanged(roomId, { floor, previousFloor, transactionId })
      }
      catch (e) {
        this._notifyMethodError(client, e, transactionId)
      }
    });

    client.on('setContentFloor', async (args) =>{
      let transactionId, mediaId, roomId;
      try {
        ({ transactionId, mediaId, roomId } = args);
        const { floor, previousFloor } = await this.setContentFloor(args)
        client.contentFloor(roomId, { floor, previousFloor, transactionId })
      }
      catch (e) {
        this._notifyMethodError(client, e, transactionId)
      }
    });

    client.on('releaseConferenceFloor', async (args) => {
      let transactionId, roomId;
      try {
        ({ transactionId, roomId} = args);
        const previousFloor = await this.releaseConferenceFloor(args)
        client.conferenceFloorChanged(roomId, { previousFloor, transactionId })
      }
      catch (e) {
        this._notifyMethodError(client, e, transactionId)
      }
    });

    client.on('releaseContentFloor', async (args) =>{
      let transactionId, roomId;
      try {
        ({ transactionId, roomId} = args);
        const previousFloor = await this.releaseContentFloor(args)
        client.contentFloorChanged(roomId, { previousFloor, transactionId })
      }
      catch (e) {
        this._notifyMethodError(client, e, transactionId)
      }
    });

    client.on('getContentFloor', async (args) =>{
      let transactionId, roomId;
      try {
        ({ transactionId, roomId } = args);
        const { floor, previousFloor }  = await this.getContentFloor(args)
        client.contentFloor(roomId, { floor, previousFloor, transactionId })
      }
      catch (e) {
        this._notifyMethodError(client, e, transactionId)
      }
    });

    client.on('getConferenceFloor', async (args) =>{
      let transactionId, roomId;
      try {
        ({ transactionId, roomId } = args);
        const { floor, previousFloor } = await this.getConferenceFloor(args)
        client.conferenceFloor(roomId, { floor, previousFloor, transactionId})
      }
      catch (e) {
        this._notifyMethodError(client, e, transactionId)
      }
    });

    client.on('setVolume', async (args) =>{
      let transactionId, mediaId, volume;
      try {
        ({ transactionId, mediaId, volume} = args);
        await this.setVolume(args)
        client.volumeChanged(mediaId, volume, {transactionId})
      }
      catch (e) {
        this._notifyMethodError(client, e, transactionId)
      }
    });

    client.on('mute', async (args) =>{
      let transactionId, mediaId;
      try {
        ({ transactionId, mediaId} = args);
        await this.mute(args)
        client.muted(mediaId, {}, {transactionId})
      }
      catch (e) {
        this._notifyMethodError(client, e, transactionId)
      }
    });

    client.on('unmute', async (args) =>{
      let transactionId, mediaId;
      try {
        ({ transactionId, mediaId} = args);
        await this.unmute(args)
        client.unmuted(mediaId, {}, {transactionId})
      }
      catch (e) {
        this._notifyMethodError(client, e, transactionId)
      }
    });

    client.on('dtmf', async (args) =>{
      let transactionId, mediaId, tone;
      try {
        ({ transactionId, mediaId, tone } = args);
        await this.dtmf(args);
        client.dtmfSent(mediaId, tone, { transactionId });
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
    this.clientEventMap = this.clientEventMap.filter(c => !(c.identifier === identifier && c.eventName === eventName));
  }

  _removeClientFromEventMap (client) {
    Logger.trace('[mcs-router]', "Removing client", client.trackingId, "from event map");
    this.clientEventMap = this.clientEventMap.filter(c => c.client.trackingId !== client.trackingId);
  }

  _removeClientFromTracking (client) {
    const { trackingId } = client;
    if (trackingId && this.clients[trackingId]) {
      Logger.trace('[mcs-router]', "Removing client", trackingId, "from tracking");
      delete this.clients[trackingId];
    }
  }

  _getClientToDispatch (identifier, eventName) {
    const clientMap = this.clientEventMap.filter(c => c.identifier === identifier && c.eventName === eventName);

    if (clientMap.length > 0 ) {
      Logger.trace('[mcs-router] Found', clientMap.length, 'clients', clientMap.map(c => [c.identifier, c.eventName, c.client.trackingId]))
    }

    const clients = clientMap.map(cm => cm.client);
    return clients;
  }

  _dispatchEvents() {
    this.emitter.on(C.EVENT.MEDIA_STATE.ICE, event => {
      const { mediaId, candidate } = event;
      const clients = this._getClientToDispatch(mediaId, C.EMAP[C.EVENT.MEDIA_STATE.ICE]);

      if (clients.length > 0) {
        clients.forEach(client => {
          client.onIceCandidate(mediaId, candidate);
        });
      }
    });

    this.emitter.on(C.EVENT.MEDIA_STATE.MEDIA_EVENT, event => {
      const { mediaId, state } = event;
      const clients = this._getClientToDispatch(mediaId, C.EMAP[C.EVENT.MEDIA_STATE.MEDIA_EVENT]);

      if (clients.length > 0) {
        clients.forEach(client => {
          client.mediaState(mediaId, state);
        })
      }
    });

    this.emitter.on(C.EVENT.ROOM_CREATED, roomId => {
      const clients = this._getClientToDispatch('all', C.EVENT.ROOM_CREATED);

      Logger.trace('[mcs-router] Room created event', roomId);

      if (clients.length > 0) {
        clients.forEach(client => {
          client.roomCreated(roomId);
        })
      }
    });

    this.emitter.on(C.EVENT.ROOM_DESTROYED, roomId => {
      const clients = this._getClientToDispatch(roomId, C.EVENT.ROOM_DESTROYED);

      Logger.trace('[mcs-router] Room destroyed event', roomId);

      this._removeFromClientEventMap(roomId, C.EVENT.MEDIA_CONNECTED);
      this._removeFromClientEventMap(roomId, C.EVENT.USER_JOINED);
      this._removeFromClientEventMap(roomId, C.EVENT.USER_LEFT);

      if (clients.length > 0) {
        clients.forEach(client => {
          client.roomDestroyed(roomId);
        })
      }
    });

    this.emitter.on(C.EVENT.MEDIA_CONNECTED, event => {
      const { roomId } = event;
      const clients = this._getClientToDispatch(roomId, C.EVENT.MEDIA_CONNECTED);

      //this.clientEventMap.forEach(c => Logger.trace("Mapped client", c.identifier, c.eventName, typeof c.client));

      if (clients.length > 0) {
        clients.forEach(client => {
          client.mediaConnected(roomId, event);
        })
      }
    });

    this.emitter.on(C.EVENT.MEDIA_DISCONNECTED, event => {
      const { roomId, mediaId } = event;
      const clients = this._getClientToDispatch(mediaId, C.EVENT.MEDIA_DISCONNECTED);
      this._removeFromClientEventMap(mediaId, C.EMAP[C.EVENT.MEDIA_STATE.MEDIA_EVENT]);
      this._removeFromClientEventMap(mediaId, C.EMAP[C.EVENT.MEDIA_STATE.ICE]);

      if (clients.length > 0) {
        clients.forEach(client => {
          Logger.trace('[mcs-router] Emitting media disconnected for', mediaId, "at client", client.trackingId);
          client.mediaDisconnected(roomId, mediaId);
        })
      }
    });

    this.emitter.on(C.EVENT.USER_JOINED, event => {
      const { roomId, userId } = event;
      const clients = this._getClientToDispatch(roomId, C.EVENT.USER_JOINED);

      if (clients.length > 0) {
        clients.forEach(client => {
          client.userJoined(roomId, event);
        })
      }
    });

    this.emitter.on(C.EVENT.USER_LEFT, event => {
      const { roomId , userId } = event;
      const clients = this._getClientToDispatch(roomId, C.EVENT.USER_LEFT);

      if (clients.length > 0) {
        clients.forEach(client => {
          client.userLeft(roomId, userId);
        })
      }
    });

    this.emitter.on(C.EVENT.CONTENT_FLOOR_CHANGED, event => {
      const { roomId, floor, previousFloor } = event;
      const clients = this._getClientToDispatch(roomId, C.EVENT.CONTENT_FLOOR_CHANGED);

      if (clients.length > 0) {
        clients.forEach(client => {
          client.contentFloorChanged(roomId, { floor, previousFloor });
        })
      }
    });

    this.emitter.on(C.EVENT.CONFERENCE_FLOOR_CHANGED, event => {
      const { roomId, floor, previousFloor } = event;
      const clients = this._getClientToDispatch(roomId, C.EVENT.CONFERENCE_FLOOR_CHANGED);

      if (clients.length > 0) {
        clients.forEach(client => {
          client.conferenceFloorChanged(roomId, { floor, previousFloor });
        })
      }
    });

    this.emitter.on(C.EVENT.MEDIA_VOLUME_CHANGED, event => {
      const { mediaId, volume } = event;
      const clients = this._getClientToDispatch(mediaId, C.EVENT.MEDIA_VOLUME_CHANGED);

      if (clients.length > 0) {
        clients.forEach(client => {
          client.volumeChanged(mediaId, volume);
        })
      }
    });

    this.emitter.on(C.EVENT.MEDIA_MUTED, event => {
      const { mediaId } = event;
      const clients = this._getClientToDispatch(mediaId, C.EVENT.MEDIA_MUTED);

      if (clients.length > 0) {
        clients.forEach(client => {
          client.muted(mediaId);
        })
      }
    });

    this.emitter.on(C.EVENT.MEDIA_UNMUTED, event => {
      const { mediaId } = event;
      const clients = this._getClientToDispatch(mediaId, C.EVENT.MEDIA_UNMUTED);

      if (clients.length > 0) {
        clients.forEach(client => {
          client.unmuted(mediaId);
        })
      }
    });
  }
}

module.exports = new MR();
