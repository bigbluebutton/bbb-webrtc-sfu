'use strict';
const ScreenshareManager = require('./ScreenshareManager');
const BaseProcess = require('../base/BaseProcess');
const C = require('../bbb/messages/Constants');
const manager = new ScreenshareManager(C.TO_SCREENSHARE, [C.FROM_AKKA_APPS], C.SCREENSHARE_MANAGER_PREFIX);
const newProcess = new BaseProcess(manager, C.SCREENSHARE_PROCESS_PREFIX);
newProcess.start();
