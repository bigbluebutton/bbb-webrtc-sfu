'use strict';

const ListenOnlyManager = require('./listen-only-manager.js');
const BaseProcess = require('../base/BaseProcess');
const C = require('../bbb/messages/Constants');

const manager = new ListenOnlyManager(C.TO_LISTEN_ONLY, [C.FROM_AKKA_APPS], C.LISTENONLY_MANAGER_PREFIX);
const newProcess = new BaseProcess(manager, C.LISTENONLY_PROCESS_PREFIX);

newProcess.start();
