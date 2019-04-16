'use strict';

const config = require('config');
const Logger = require('../utils/logger.js');
const C = require('../constants/constants.js');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter.js');

class BaseStrategyHandler {
  constructor (strategyName) {
    this.strategyName = strategyName;
    this.members = [];
  }

  start () {
    // NO-OP MAY be implemented by strategy handlers
  }

  stop () {
    // NO-OP MAY be implemented by strategy handlers
  }

  runStrategy () {
    // NO-OP MUST be implemented by strategy handlers
  }

  addMember (member) {
    if (this.hasMember(member.id)) {
      return;
    }

    this.members.push(member);
    this.runStrategy();
  }

  getMember (id) {
    return this.members.find(m => m.id === id);
  }

  hasMember (id) {
    return this.members.some(m => m.id === id);
  }

  removeMember (id) {
    this.members = this.members.filter(m => m.id !=== id);
    this.runStrategy();
  }
}

module.exports = BaseStrategyHandler;
