'use strict';

const Logger = require('../common/logger.js');

class LiveKitSipTrunkManager {
  constructor(
    liveKitSDK,
    host,
    key,
    secret, {
    trunkOptions = {},
    dispatchOptions = {},
  } = {},
  ) {
    if (!liveKitSDK || !host || !key || !secret) {
      throw new Error('LiveKitSipTrunkManager: liveKitSDK, host, key, secret are required');
    }

    this._liveKitSDK = liveKitSDK;
    this._trunkRegister = new Map();
    this._dispatchRegister = new Map();
    this._trunkOptions = trunkOptions;
    this._dispatchOptions = dispatchOptions;

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
        Logger.debug('LiveKitSipTrunkManager: Cleaning stale SIP trunk', { trunk });
        this.deleteInboundTrunk({ trunkObject: trunk });
      });
    }).catch(error => {
      Logger.error('LiveKitSipTrunkManager: Failed to list SIP trunks', error);
    });

    // List all dispatch rules and register them
    this.sipClient.listSipDispatchRule().then(dispatches => {
      dispatches.forEach(dispatch => {
        Logger.debug('LiveKitSipTrunkManager: Cleaning stale dispatch rule', { dispatch });
        this.deleteDispatchRule({ dispatchObject: dispatch });
      });
    }).catch(error => {
      Logger.error('LiveKitSipTrunkManager: Failed to list dispatch rules', error);
    });
  }

  hasTrunk(name) {
    return this._trunkRegister.has(name);
  }

  getTrunk(name) {
    return this._trunkRegister.get(name);
  }

  async createInboundTrunk(name, numbers, options = {}) {
    const trunk = await this.sipClient.createSipInboundTrunk(name, numbers, {
      ...this._trunkOptions,
      ...options,
    });
    this._registerTrunk(trunk);
    Logger.info('LiveKitSipTrunkManager: Inbound trunk created', { name, numbers, options });

    return trunk;
  }

  async deleteInboundTrunk({ name, trunkObject = null } = {}) {
    try {
      if (!trunkObject && (!name || !this._trunkRegister.has(name))) {
        Logger.warn('LiveKitSipTrunkManager: Trunk not registered', { name });
        return;
      }

      const trunk = trunkObject || this._trunkRegister.get(name);
      const id = trunk.sipTrunkId || trunk.id;
      await this.sipClient.deleteSipTrunk(id);

      Logger.info('LiveKitSipTrunkManager: SIP trunk deleted', { trunkId: id });
    } catch (error) {
      Logger.error('LiveKitSipTrunkManager: Failed to delete SIP trunk', error);
    } finally {
      this._trunkRegister.delete(name);
    }
  }

  hasDispatchRule(meetingId) {
    return this._dispatchRegister.has(meetingId);
  }

  async createDispatchRule(meetingId, voiceConf, options = { requirePin: false }) {
    const trunkIds = this.hasTrunk(voiceConf) ? [this.getTrunk(voiceConf).sipTrunkId] : [];
    const rule = {
      roomName: meetingId,
      type: 'direct',
    };

    if (options.requirePin) rule.pin = voiceConf;

    const dispatch = await this.sipClient.createSipDispatchRule(rule, {
      ...this._dispatchOptions,
      trunkIds,
      metadata: options.metadata,
      name: `bbb-${meetingId}`,
    });

    this._dispatchRegister.set(meetingId, dispatch);

    Logger.info('LiveKitSipTrunkManager: Dispatch rule created', {
      meetingId,
      voiceConf,
      requirePin: options.requirePin,
      rule,
      trunkIds,
    });
  }

  async deleteDispatchRule({ id, dispatchObject = null } = {}) {
    try {
      if (!dispatchObject && (!id || !this._dispatchRegister.has(id))) {
        Logger.warn('LiveKitSipTrunkManager: Dispatch rule not registered', { id });
        return;
      }

      const dispatch = dispatchObject || this._dispatchRegister.get(id);
      const sipDispatchRuleId = dispatch.sipDispatchRuleId || dispatch.id;
      await this.sipClient.deleteSipDispatchRule(sipDispatchRuleId);
      Logger.info('LiveKitSipTrunkManager: Dispatch rule deleted', { dispatchId: sipDispatchRuleId });
    } catch (error) {
      Logger.error('LiveKitSipTrunkManager: Failed to delete dispatch rule', error);
    } finally {
      this._dispatchRegister.delete(id);
    }
  }

  async stop() {
    this._dispatchRegister.forEach(async (dispatch) => {
      try {
        await this.deleteDispatchRule({ dispatchObject: dispatch });
      } catch (error) {
        Logger.warn('LiveKitSipTrunkManager: Failed to delete dispatch rule', error);
      }
    });

    this._trunkRegister.forEach(async (trunk) => {
      try {
        await this.deleteInboundTrunk({ trunkObject: trunk });
      } catch (error) {
        Logger.warn('LiveKitSipTrunkManager: Failed to delete SIP trunk', error);
      }
    });

    Logger.info('LiveKitSipTrunkManager stopped');
  }
}

module.exports = LiveKitSipTrunkManager;
