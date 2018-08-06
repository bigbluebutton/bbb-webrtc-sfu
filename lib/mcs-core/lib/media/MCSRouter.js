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

  async leave (room, user) {
    try {
      const answer = await this._mediaController.leave(room, user);
      //const answer = await this._mediaController.leave(room, user);
      return (answer);
    }
    catch (error) {
      throw (this._handleError(error, 'leave', { room, user }));
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

  async subscribe (user, sourceId, type, params) {
    try {
      const answer = await this._mediaController.subscribe(user, sourceId, type, params);
      //const answer = await this._mediaController.subscribe(user, sourceId, type, params);

      return (answer);
    }
    catch (error) {
      throw (this._handleError(error, 'subscribe', { user, sourceId, type, params }));
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

  async connect (source, sink, type) {
    try {
      await this._mediaController.connect(source, sink, type);
      //await this._mediaController.connect(source, sink, type);
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

  async addIceCandidate (mediaId, candidate) {
    try {
      await this._mediaController.addIceCandidate(mediaId, candidate);
      //await this._mediaController.addIceCandidate(mediaId, candidate);
      return ;
    }
    catch (error) {
      throw (this._handleError(error, 'addIceCandidate', { mediaId, candidate }));
    }
  }

  setStrategy (strategy) {
    // TODO
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
        console.log("EITA CARA", descriptor, mediaId);
        client.published(mediaId, descriptor, { transactionId });
      });

      client.on('unpublish', async (args) => {
        this.unpublish(...args);
      });

      client.on('subscribe', async (args) => {
        this.subscribe(...args);
      });

      client.on('unsubscribe', async (args) => {
        this.unsubscribe(...args);
      });

      client.on('connect', async (args) => {
        this.connect(...args);
      });

      client.on('disconnect', async (args) => {
        this.disconnect(...args);
      });

      client.on('getUsers', (args) => {
        this.getUsers(...args);
      });

      client.on('getUserMedias', (args) => {
        this.getUserMedias(...args);
      });

      client.on('leave', async (args) => {
        this.leave(...args);
      });
    } catch (err) {
      Logger.error("OWA BOY", err);
    }
  }
}

module.exports = new MR();
