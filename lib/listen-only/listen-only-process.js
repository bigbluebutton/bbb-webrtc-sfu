'use strict';

const ListenOnlyManager = require('./listen-only-manager.js');
const BaseProcess = require('../common/base-process');
const C = require('../bbb/messages/Constants');

const LISTENONLY_PROCESS_PREFIX = '[listen-only-process]';

const manager = new ListenOnlyManager(
  C.TO_LISTEN_ONLY,
  [C.FROM_AKKA_APPS, C.TO_SFU],
  C.LISTENONLY_MANAGER_PREFIX
);
const newProcess = new BaseProcess(manager, LISTENONLY_PROCESS_PREFIX);

newProcess.start();
