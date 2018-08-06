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
      this.mediaClientMap = {};
      this._dispatchEvents();
      instance = this;
    }

    return instance;
  }

  async start (address, port, secure) {
    return new Promise((resolve, reject) => {
      try {
        const client = new MCS('ws://' + address + ':' + port + '/mcs');
        client.on('open', () => {
          this._mcs = client;
          Logger.info("[MCS-SIP] Connected to MCS.");
          resolve();
        });
      } catch(error) {
        throw (this._handleError(error, 'connect', {}));
      }
    })
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
    try {
      const { userId, roomId } = args;
      const answer = await this._mediaController.leave(roomId, userId);
      return (answer);
    }
    catch (error) {
      throw (this._handleError(error, 'leave', { roomId, userId}));
    }
  }

  async publishnsubscribe (room, user, sourceId, type, params) {
    try {
      const answer = await this._mediaController.publishAndSubscribe(room, user, sourceId, type, params);
      //const answer = await this._mediaController.publishnsubscribe(user, sourceId, sdp, params);
      return (answer);
    }
    catch (error) {
      throw (this._handleError(error, 'publishnsubscribe', { room, user, sourceId, type, params }));
    }
  }

  async publish (args) {
    try {
      const { user, room, type, params } = args;
      const answer = await this._mediaController.publish(user, room, type, params);
      return (answer);
    }
    catch (error) {
      throw (this._handleError(error, 'publish', { user, room, type, params }));
    }
  }

  async unpublish (user, mediaId) {
    try {
      await this._mediaController.unpublish(mediaId);
      //await this._mediaController.unpublish(mediaId);
      return ;
    }
    catch (error) {
      throw (this._handleError(error, 'unpublish', { user, mediaId }));
    }
  }

  async subscribe (args) {
    try {
      const { user, source, type, params } = args;
      const answer = await this._mediaController.subscribe(user, source, type, params);
      return (answer);
    }
    catch (error) {
      throw (this._handleError(error, 'subscribe', { user, source, type, params }));
    }
  }

  async unsubscribe (user, mediaId) {
    try {
      await this._mediaController.unsubscribe(user, mediaId);
      //await this._mediaController.unsubscribe(user, mediaId);
      return ;
    }
    catch (error) {
      throw (this._handleError(error, 'unsubscribe', { user, mediaId }));
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

  async onEvent (eventName, mediaId) {
    try {
      const eventTag = this._mediaController.onEvent(eventName, mediaId);
      this._mediaController.on(eventTag, (event) => {
        this.emitter.emit(eventTag, event);
      });

      return (eventTag);
    }
    catch (error) {
      throw (this._handleError(error, 'onEvent', { eventName, mediaId }));
    }
  }

  async addIceCandidate (args) {
    try {
      const { mediaId, candidate } = args;
      await this._mediaController.addIceCandidate(mediaId, candidate);
      return;
    }
    catch (error) {
      throw (this._handleError(error, 'addIceCandidate', { mediaId, candidate }));
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
        const userId = await this.join(args);
        client.joined(userId, { transactionId });
      });

      client.on('unpublishAndUnsubscribe', async (args) => {
        this.unpublishnsubscribe(...args);
      });

      client.on('publish', async (args) => {
        const { transactionId } = args;
        const { descriptor, mediaId } = await this.publish(args);
        this.mediaClientMap[mediaId] = client;
        client.published(mediaId, descriptor, { transactionId });
      });

      client.on('unpublish', async (args) => {
        this.unpublish(...args);
      });

      client.on('subscribe', async (args) => {
        const { transactionId } = args;
        const { descriptor, mediaId } = await this.subscribe(args);
        this.mediaClientMap[mediaId] = client;
        client.subscribed(mediaId, descriptor, { transactionId });
      });

      client.on('unsubscribe', async (args) => {
        this.unsubscribe(...args);
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

      client.on('getUsers', (args) => {
        this.getUsers(...args);
      });

      client.on('getUserMedias', (args) => {
        this.getUserMedias(...args);
      });

      client.on('leave', async (args) => {
        const { userId, transactionId } = args;
        await this.leave(args);
        client.left(userId, { transactionId });
      });


    } catch (err) {
      Logger.error('[mcs-router]', err);
    }
  }

  _dispatchEvents() {
    this.emitter.on(C.EVENT.MEDIA_STATE.ICE, event => {
      const { mediaId, candidate } = event;
      const client = this.mediaClientMap[mediaId];

      if (client) {
        client.onIceCandidate(mediaId, candidate);
      }
    });

    this.emitter.on(C.EVENT.MEDIA_STATE.MEDIA_EVENT, event => {
      const { mediaId, state } = event;
      const client = this.mediaClientMap[mediaId];

      if (client) {
        client.mediaState(mediaId, state);
      }
    });
  }
}

module.exports = new MR();
