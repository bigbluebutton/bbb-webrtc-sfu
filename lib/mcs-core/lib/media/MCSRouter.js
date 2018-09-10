'use strict'

const config = require('config');
const C = require('../constants/Constants');
const util = require('util');
const EventEmitter = require('events').EventEmitter;
const MediaController = require('./MediaController.js');
const Logger = require('../../../utils/Logger');
const MCS = require('mcs-js');

let instance = null;
let clientId = 0;

const MR = class MCSRouter extends EventEmitter {
  constructor() {
    if (instance == null) {
      super();
      this.emitter = this;
      this._mcs = null;
      this._mediaController = new MediaController(this.emitter);
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

  async startRecording(userId, mediaId, recordingPath) {
    try {
      const answer = await this._mediaController.startRecording(userId, mediaId, recordingPath);
      //const answer = await this._mediaController.startRecording(userId, mediaId, recordingPath);
      return (answer);
    }
    catch (error) {
      throw (this._handleError(error, 'startRecording', { userId, mediaId, recordingPath}));
    }
  }

  async stopRecording(userId, sourceId, recId) {
    try {
      const answer = await this._mediaController.stopRecording(userId, sourceId, recId);
      //const answer = await this._mediaController.stopRecording(userId, sourceId, recId);
      return (answer);
    }
    catch (error) {
      throw (this._handleError(error, 'stopRecording', { userId, sourceId, recId }));
    }
  }

  async connect (source, sinks, type) {
    try {
      let cPromises = sinks.map((sink) => {
        this._mediaController.connect(source, sink, type);
      });

      await Promise.all(cPromises).then(() => {
        resolve();
      }).catch((err) => {
        Logger.error('[mcs-router] Could not connect all endpoints', err);
        reject(err);
      });

      return ;
    }
    catch (error) {
      throw (this._handleError(error, 'connect', { source, sink, type }));
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


  _handleError (error, operation, params) {
    const { code, message, details } = error;
    const response = { type: 'error', code, message, details, operation, params };
    Logger.error("[mcs-api] Reject operation", response.operation, "with", { error: response });

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

    try {
      client.on('join', async (args) =>  {
        const { transactionId } = args;
        const userId = await this.join(args);
        client.joined(userId, { transactionId });
      });

      client.on('publishAndSubscribe', async (args) => {
        const { transactionId } = args;
        const { descriptor, mediaId } = await this.publishnsubscribe(args);
        client.publishedAndSubscribed(mediaId, descriptor, { transactionId });
      });

      client.on('unpublishAndUnsubscribe', async (args) => {
        const  { userId, mediaId, transactionId } = args;
        await this.unpublishAndUnsubscribe(args);
        client.unpublishedAndUnsubscribed(userId, mediaId, { transactionId });
      });

      client.on('publish', async (args) => {
        const { transactionId } = args;
        const { descriptor, mediaId } = await this.publish(args);
        client.published(mediaId, descriptor, { transactionId });
      });

      client.on('unpublish', async (args) => {
        const  { userId, mediaId, transactionId } = args;
        await this.unpublish(args);
        client.unpublished(userId, mediaId, { transactionId });
      });

      client.on('subscribe', async (args) => {
        const { transactionId } = args;
        const { descriptor, mediaId } = await this.subscribe(args);
        client.subscribed(mediaId, descriptor, { transactionId });
      });

      client.on('unsubscribe', async (args) => {
        const  { userId, mediaId, transactionId } = args;
        await this.unsubscribe(args);
        client.unsubscribed(userId, mediaId, { transactionId });
      });

      client.on('addIceCandidate', async (args) => {
        const { mediaId, transactionId } = args;
        await this.addIceCandidate(args);
        client.iceCandidateAdded(mediaId, { transactionId });
      });

      client.on('connect', async (args) => {
        const { transactionId, source_id, sink_ids } = args;
        await this.connect(args);
        client.connected(sourceId, sink_ids, { transactionId });
      });

      client.on('disconnect', async (args) => {
        const { transactionId, source_id, sink_ids } = args;
        await this.disconnect(args);
        client.disconnected(sourceId, sink_ids, { transactionId });
      });

      client.on('getUsers', async (args) => {
        const { transactionId } = args;
        const users = await this.getUsers(args);
        client.usersList(users, { transactionId });
      });

      client.on('getUserMedias', async (args) => {
        const { transactionId } = args;
        const medias = await this.getUserMedias(args);
        client.userMedias(medias, { transactionId });
      });

      client.on('leave', async (args) => {
        const { userId, transactionId } = args;
        await this.leave(args);
        client.left(userId, { transactionId });
      });

      client.on('onEvent', async (args) => {
        Logger.trace("[mcs-router] Subscribing to event", args);
        const { eventName, identifier } = args;
        const eventMap = { identifier, eventName, client };
        this._addToClientEventMap(eventMap);
        await this.onEvent(args);
      });

    } catch (err) {
      Logger.error('[mcs-router]', err);
    }
  }

  _addToClientEventMap (map) {
    this.clientEventMap.push({ ...map });
    this.clientEventMap.forEach(c => Logger.trace("Mapped client", c.identifier, c.eventName, typeof c.client));
  }

  _removeFromClientEventMap (identifier, eventName) {
    this.clientEventMap = this.clientEventMap.filter(c => c.identifier !== identifier && c.eventName !== eventName);
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
    this.on(C.EVENT.MEDIA_STATE.ICE, event => {
      const { mediaId, candidate } = event;
      const client = this._getClientToDispatch(mediaId, C.EMAP[C.EVENT.MEDIA_STATE.ICE]);

      if (client) {
        client.onIceCandidate(mediaId, candidate);
      }
    });

    this.on(C.EVENT.MEDIA_STATE.MEDIA_EVENT, event => {
      const { mediaId, state } = event;
      const client = this._getClientToDispatch(mediaId, C.EMAP[C.EVENT.MEDIA_STATE.MEDIA_EVENT]);

      if (client) {
        client.mediaState(mediaId, state);
      }
    });

    this.on(C.EVENT.ROOM_CREATED, event => {
      const { roomId } = event;
      const client = this._getClientToDispatch('all', C.EVENT.ROOM_CREATED);

      Logger.trace('[mcs-router] Room created event', event, typeof client);

      if (client) {
        client.roomCreated(event);
      }
    });

    this.on(C.EVENT.ROOM_DESTROYED, event => {
      const { roomId } = event;
      const client = this._getClientToDispatch('all', C.EVENT.ROOM_DESTROYED);
      this._removeFromClientEventMap(roomId, C.EVENT.MEDIA_CONNECTED);
      this._removeFromClientEventMap(roomId, C.EVENT.USER_JOINED);
      this._removeFromClientEventMap(roomId, C.EVENT.USER_LEFT);

      if (client) {
        client.roomDestroyed(event);
      }
    });

    this.on(C.EVENT.MEDIA_CONNECTED, event => {
      const { roomId } = event;
      const client = this._getClientToDispatch(roomId, C.EVENT.MEDIA_CONNECTED);

      this.clientEventMap.forEach(c => Logger.trace("Mapped client", c.identifier, c.eventName, typeof c.client));

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
  }
}

module.exports = new MR();
