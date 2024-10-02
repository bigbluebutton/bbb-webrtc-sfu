'use strict';

const Logger = require('../common/logger.js');

class LiveKitSipTrunkManager {
  constructor(
    liveKitSDK,
    host,
    key,
    secret, {
      inboundOptions = {},
    },
  ) {
    if (!liveKitSDK || !host || !key || !secret) {
      throw new Error('LiveKitSipTrunkManager: liveKitSDK, host, key, secret are required');
    }

    this._liveKitSDK = liveKitSDK;
    this._trunkRegister = new Map();
    this._dispatchRegister = new Map();
    this._inboundOptions = inboundOptions;

    this.host = host;
    this.key = key;
    this.secret = secret;
    this.sipClient = new this._liveKitSDK.SipClient(this.host, this.key, this.secret);
  }

  _registerTrunk(trunk) {
    const { name } = trunk;

    if (this._trunkRegister.has(name)) {
      Logger.warn('LiveKitSipTrunkManager: Trunk already registered', { name });
      return;
    }

    this._trunkRegister.set(name, trunk);
  }

  init() {
    // List all SIP trunks and register them
    this.sipClient.listSipInboundTrunk().then(trunks => {
      trunks.forEach(trunk => {
        Logger.debug('LiveKitSipTrunkManager: Registering SIP trunk', { trunk });
        this._registerTrunk(trunk);
      });
    }).then(() => {
      Logger.info('LiveKitSipTrunkManager initialized');
    }).catch(error => {
      Logger.error('LiveKitSipTrunkManager: Failed to list SIP trunks', error);
    });

    // List all dispatch rules and register them
    this.sipClient.listSipDispatchRule().then(dispatches => {
      dispatches.forEach(dispatch => {
        Logger.debug('LiveKitSipTrunkManager: Registering dispatch rule', { dispatch });
        this._dispatchRegister.set(dispatch.roomName, dispatch);
      });
    }).then(() => {
      Logger.info('LiveKitSipTrunkManager initialized');
    }).catch(error => {
      Logger.error('LiveKitSipTrunkManager: Failed to list dispatch rules', error);
    });
  }

  hasTrunk(name) {
    return this._trunkRegister.has(name);
  }

  async createInboundTrunk(name, numbers, options = {}) {
    const trunk = await this.sipClient.createSipInboundTrunk(name, numbers, {
      ...this._inboundOptions,
      ...options,
    });
    this._registerTrunk(trunk);
    Logger.debug('LiveKitSipTrunkManager: Inbound trunk created', { trunk });

    return trunk;
  }

  async deleteSipTrunk(name) {
    try {
      if (!this._trunkRegister.has(name)) {
        Logger.warn('LiveKitSipTrunkManager: Trunk not registered', { name });
        return;
      }

      const trunk = this._trunkRegister.get(name);
      await this.sipClient.deleteSipTrunk(trunk.sipTrunkId);
    } catch (error) {
      Logger.error('LiveKitSipTrunkManager: Failed to delete SIP trunk', error);
    } finally {
      this._trunkRegister.delete(name);
    }
  }

  hasDispatchRule(meetingId) {
    return this._dispatchRegister.has(meetingId);
  }

  async createDispatchRule(trunkName, meetingId, voiceConf, options = {}) {
    const rule = {
      pin: voiceConf,
      roomName: meetingId,
      type: 'direct',
    };

    const dispatch = await this.sipClient.createSipDispatchRule(rule, {
      ...this._inboundOptions,
      ...options,
      name: `bbb-${meetingId}:${voiceConf}`,
    });

    this._dispatchRegister.set(meetingId, dispatch);
    Logger.debug('LiveKitSipTrunkManager: Dispatch rule created', { dispatch, rule });
  }

  async deleteDispatchRule(meetingId) {
    try {
      if (!this._dispatchRegister.has(meetingId)) {
        Logger.warn('LiveKitSipTrunkManager: Dispatch rule not registered', { meetingId });
        return;
      }

      const dispatch = this._dispatchRegister.get(meetingId);
      await this.sipClient.deleteSipDispatchRule(dispatch.id);
      Logger.debug('LiveKitSipTrunkManager: Dispatch rule deleted', { meetingId });
    } catch (error) {
      Logger.error('LiveKitSipTrunkManager: Failed to delete dispatch rule', error);
    } finally {
      this._dispatchRegister.delete(meetingId);
    }
  }

  stop() {
    this._dispatchRegister.forEach(async (dispatch) => {
      try {
        await this.deleteDispatchRule(dispatch.roomName);
      } catch (error) {
        Logger.warn('LiveKitSipTrunkManager: Failed to delete dispatch rule', error);
      }
    });

    this._trunkRegister.forEach(async (trunk) => {
      try {
        await this.deleteSipTrunk(trunk.name);
      } catch (error) {
        Logger.warn('LiveKitSipTrunkManager: Failed to delete SIP trunk', error);
      }
    });

    Logger.info('LiveKitSipTrunkManager stopped');
  }
}

module.exports = LiveKitSipTrunkManager;
