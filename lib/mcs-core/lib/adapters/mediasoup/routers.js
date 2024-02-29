'use strict';

const C = require('../../constants/constants');
const { handleError } = require('./errors.js');
const Logger = require('../../utils/logger');
const { ROUTER_SETTINGS } = require('./configs.js');
const { replaceRouterCodecsWithSdpCodecs } = require('./utils.js');
const { v4: uuidv4 } = require('uuid');

const ROUTER_ID_S_TOKEN = '/roomId:';
// ROUTER_STORAGE: Map<routerId, MediaSoupRouter>. Registers thin
// wrappers for a Mediasoup router (=== pipeline for the jumentoheads)
const ROUTER_STORAGE = new Map();

const storeRouter = (id, router) => {
  if (!router) return false;

  if (hasRouter(id)) {
    Logger.error('mediasoup: Collision on router storage', {
      routerId: id,
    });

    // Might be an ID collision. Throw this peer out and let the client reconnect
    throw handleError({
      ...C.ERROR.MEDIA_ID_COLLISION,
      details: "MEDIASOUP_ROUTER_COLLISION"
    });
  }

  ROUTER_STORAGE.set(id, router);

  return true;
}

const getRouter = (id) => {
  return ROUTER_STORAGE.get(id);
}

const hasRouter = (id) => {
  return ROUTER_STORAGE.has(id);
}

const deleteRouter = (id) => {
  const deleted = ROUTER_STORAGE.delete(id);

  return deleted;
}

const assembleRouterId = (routerIdPrefix, routerIdSuffix) => {
  return `${routerIdPrefix}${ROUTER_ID_S_TOKEN}${routerIdSuffix}`;
}

const getRouterIdSuffix = (routerId) => {
  return routerId.split(ROUTER_ID_S_TOKEN)[1];
}

const _constructFilteredRouterCaps = (router, routerOptions) => {
  if (router) {
    // mediasoup's router.rtpCapabilities copies some codecs fields straight from
    // default values, ignoring what's provided during router creation. Filter
    // out the default values to avoid confusion when generating descriptions as
    // offerer.
    const rtpCapabilities = router.rtpCapabilities;
    const codecs = rtpCapabilities.codecs.forEach((codec) => {
      // Filter rtcpFeedback entries that are not present in the original
      // rtpCapabilities.
      if (routerOptions) {
        const originalCodec = routerOptions.mediaCodecs.find((c) => c.mimeType === codec.mimeType);
        if (originalCodec) {
          codec.rtcpFeedback = codec.rtcpFeedback.filter((fb) => {
            return originalCodec.rtcpFeedback.some((ofb) => {
              return ofb.type === fb.type && ofb.parameter === fb.parameter;
            });
          });
        }
      }
    });

    return { codecs };
  }

  return null;
}

const _createRouter = async (worker, {
  internalRouterId,
  routerOptions = ROUTER_SETTINGS,
}) => {
  try {
    const router = await worker.createRouter(routerOptions);
    router.workerId = worker.appData.internalAdapterId;
    router.appData.internalAdapterId = internalRouterId;
    router.appData.filteredRouterCaps = _constructFilteredRouterCaps(
      router,
      routerOptions,
    );
    router.once("workerclose", () => {_close(router, "workerclose")});

    return router;
  } catch (error) {
    Logger.error('mediasoup: Router creation failed', {
      errorMessage: error.message, internalRouterId,
    });
    throw error;
  }
}

const getOrCreateRouter = async (worker, {
  routerIdSuffix,
  routerOptions = ROUTER_SETTINGS,
  dedicatedRouter = false,
  overrideRouterCodecs = false,
  remoteDescriptor,
}) => {
  try {
    let router;
    const routerIdPrefix = !dedicatedRouter ? worker.appData.internalAdapterId : uuidv4();
    const routerId = assembleRouterId(routerIdPrefix, routerIdSuffix);
    const appData = {
      dedicatedRouter,
    };
    let finalRouterOptions = { ...routerOptions, appData };

    if (!dedicatedRouter || !overrideRouterCodecs) {
      router = getRouter(routerId);
      if (router) return router;
    }

    if (overrideRouterCodecs && remoteDescriptor) {
      finalRouterOptions = replaceRouterCodecsWithSdpCodecs(finalRouterOptions, remoteDescriptor);
    }

    router = await _createRouter(worker, {
      internalRouterId: routerId,
      routerOptions: finalRouterOptions,
    });
    storeRouter(routerId, router);
    Logger.info('mediasoup: Router created', {
      routerId: router.id, routerIntId: router.appData.internalAdapterId, roomId: routerIdSuffix,
    });

    return router;
  } catch (error) {
    Logger.error('mediasoup: Router fetch failed', {
      errorMessage: error.message, roomId: routerIdSuffix,
    });
    throw (handleError(error));
  }
}

const _close = (router, reason = 'normalclearing') => {
  if (router && typeof router.close === 'function') {
    Logger.info('mediasoup: Releasing router', {
      routerId: router.id, routerIntId: router.appData.internalAdapterId, reason
    });
    deleteRouter(router.appData.internalAdapterId);
    return router.close();
  }

  return Promise.resolve();
};

const releaseRouter = (routerId) => {
  const router = getRouter(routerId);
  return _close(router);
}

// TODO refactor: why are we iterating over the whole map...
const releaseAllRoutersWithIdSuffix = ({ roomId: routerIdSuffix }) => {
  ROUTER_STORAGE.forEach(async (router, routerId) => {
    const targetSuffix = getRouterIdSuffix(routerId);
    if (targetSuffix === routerIdSuffix) {
      try {
        await releaseRouter(routerId);
      } catch (error) {
        handleError(error);
      }
    }
  });
}

module.exports = {
  getOrCreateRouter,
  storeRouter,
  getRouter,
  hasRouter,
  deleteRouter,
  releaseRouter,
  releaseAllRoutersWithIdSuffix,
}
