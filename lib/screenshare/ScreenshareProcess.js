'use strict';

const ScreenshareManager = require('./ScreenshareManager');
const BaseProcess = require('../common/base-process.js');
const C = require('../bbb/messages/Constants');

const SCREENSHARE_PROCESS_PREFIX = '[screenshare-process]';

const manager = new ScreenshareManager(
  C.TO_SCREENSHARE,
  [C.FROM_AKKA_APPS, C.TO_SFU],
  C.SCREENSHARE_MANAGER_PREFIX
);

const newProcess = new BaseProcess(manager, SCREENSHARE_PROCESS_PREFIX);

newProcess.start();
