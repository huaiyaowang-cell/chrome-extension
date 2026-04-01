/** SDK 桩脚本（与 download-poki-game / download-mini-game 行为对齐，供本地 file:// 运行） */

export function getPokiSdkStub() {
  return `(function() {
  var _oeSetter = null;
  Object.defineProperty(window, "onerror", {
    configurable: true,
    set: function(fn) { _oeSetter = fn; },
    get: function() {
      return function(msg, url, line, col, err) {
        console.error("[game-dl] onerror:", msg, url, line);
        return true;
      };
    }
  });

  var _pn = function() {};
  var _pp = function() { return Promise.resolve(); };

  var _loadingGone = false;
  var _loadingIds = [
    "loading-screen-container", "loader", "loading", "progress-container",
    "splash", "defold-progress", "unity-loading-bar", "application-splash-wrapper"
  ];

  function _hideLoading() {
    if (_loadingGone) return;
    var found = false;
    for (var i = 0; i < _loadingIds.length; i++) {
      var el = document.querySelector("#" + CSS.escape(_loadingIds[i]) + ":not([data-poki-placeholder])");
      if (el && el.parentElement) {
        el.parentElement.removeChild(el);
        found = true;
      }
    }
    try {
      if (typeof ProgressView !== "undefined"
          && ProgressView.progress
          && ProgressView.progress.parentElement
          && !ProgressView.progress.dataset.pokiPlaceholder) {
        ProgressView.progress.parentElement.removeChild(ProgressView.progress);
        found = true;
      }
    } catch (e) {}
    if (found) {
      _loadingGone = true;
      console.log("[game-dl] loading overlay removed");
    }
  }

  var _hlTimer = setInterval(function() {
    _hideLoading();
    if (_loadingGone) clearInterval(_hlTimer);
  }, 2000);
  setTimeout(function() { clearInterval(_hlTimer); }, 30000);

  var _pokiStub = {
    init: function() {
      window.PokiSDK_OK = true;
      return Promise.resolve();
    },
    gameplayStart: _pn,
    gameplayStop: _pn,
    commercialBreak: _pp,
    rewardedBreak: function() { return Promise.resolve(true); },
    displayAd: _pn,
    destroyAd: _pn,
    setDebug: _pn,
    getURLParam: function() { return ""; },
    shareableURL: function() { return Promise.resolve(""); },
    isAdBlocked: function() { return false; },
    gameLoadingStart: _pn,
    gameLoadingFinished: _hideLoading,
    gameLoadingProgress: _pn,
    gameInteractive: _hideLoading,
    customEvent: _pn,
    happyTime: _pn,
    logError: _pn,
    roundStart: _pn,
    roundEnd: _pn,
    muteAd: _pn,
    sendHighscore: _pn,
    togglePlayerAdvertisingConsent: _pn,
    disableDOMChangeObservation: _pn
  };
  try { Object.freeze(_pokiStub); } catch (e) {}
  try {
    Object.defineProperty(window, "PokiSDK", {
      value: _pokiStub,
      writable: false,
      configurable: false
    });
  } catch (e) {
    window.PokiSDK = _pokiStub;
  }
  console.log("[game-dl] PokiSDK stub active (sealed)");

  var _origGBI = Document.prototype.getElementById;
  Document.prototype.getElementById = function(id) {
    var el = _origGBI.call(this, id);
    if (!el) {
      var sid = (id || "").toLowerCase();
      var isCanvasLike = sid.indexOf("canvas") >= 0 || sid === "gl" || sid === "webgl"
        || sid === "renderer" || sid === "three" || sid === "gl-canvas"
        || sid === "webgl-canvas";
      el = document.createElement(isCanvasLike ? "canvas" : "div");
      el.id = id;
      if (!isCanvasLike) el.style.display = "none";
      if (isCanvasLike) { el.width = 800; el.height = 600; el.style.display = "block"; }
      el.dataset.pokiPlaceholder = "1";
      if (document.body) document.body.appendChild(el);
    }
    return el;
  };
})();`;
}

export function getMinigameSdkStub() {
  return `(function() {
  var _oeSetter = null;
  Object.defineProperty(window, "onerror", {
    configurable: true,
    set: function(fn) { _oeSetter = fn; },
    get: function() {
      return function(msg, url, line, col, err) {
        console.error("[game-dl] onerror:", msg, url, line);
        return true;
      };
    }
  });

  var _noop = function() {};
  var _pp = function() { return Promise.resolve(); };
  var _adStub = function() {
    return Promise.resolve({
      loadAsync: function() { return Promise.resolve(); },
      showAsync: function() { return Promise.resolve(); }
    });
  };

  var _fbStorageKey = "game_dl_fbinstant_player_data";
  function _fbGetData() {
    try { var s = localStorage.getItem(_fbStorageKey); return s ? JSON.parse(s) : {}; } catch (e) { return {}; }
  }
  function _fbSetData(obj) {
    try {
      var cur = _fbGetData();
      for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) cur[k] = obj[k];
      localStorage.setItem(_fbStorageKey, JSON.stringify(cur));
    } catch (e) {}
  }

  var _loadingGone = false;
  var _loadingIds = [
    "loading-screen-container", "loader", "loading", "progress-container",
    "splash", "defold-progress", "unity-loading-bar", "application-splash-wrapper"
  ];

  function _hideLoading() {
    if (_loadingGone) return;
    var found = false;
    for (var i = 0; i < _loadingIds.length; i++) {
      var el = document.querySelector("#" + CSS.escape(_loadingIds[i]) + ":not([data-mg-placeholder])");
      if (el && el.parentElement) {
        el.parentElement.removeChild(el);
        found = true;
      }
    }
    if (found) {
      _loadingGone = true;
      console.log("[game-dl] loading overlay removed");
    }
  }

  var _hlTimer = setInterval(function() {
    _hideLoading();
    if (_loadingGone) clearInterval(_hlTimer);
  }, 2000);
  setTimeout(function() { clearInterval(_hlTimer); }, 30000);

  window.FBInstant = {
    initializeAsync: _pp,
    startGameAsync: _pp,
    setLoadingProgress: _noop,
    player: {
      getID: function() { return "local_player_001"; },
      getName: function() { return "Local Player"; },
      getPhoto: function() { return ""; },
      getDataAsync: function(keys) { return Promise.resolve(_fbGetData()); },
      setDataAsync: function(data) { _fbSetData(data); return Promise.resolve(); },
      flushDataAsync: _pp,
      getStatsAsync: function() { return Promise.resolve({}); },
      setStatsAsync: _pp,
      incrementStatsAsync: function() { return Promise.resolve({}); },
      getConnectedPlayersAsync: function() { return Promise.resolve([]); },
      canSubscribeBotAsync: function() { return Promise.resolve(false); },
      subscribeBotAsync: function() { return Promise.resolve(); }
    },
    context: {
      getID: function() { return null; },
      getType: function() { return "SOLO"; },
      chooseAsync: _pp,
      switchAsync: _pp,
      createAsync: _pp,
      getPlayersAsync: function() { return Promise.resolve([]); }
    },
    getLocale: function() { return "en_US"; },
    getPlatform: function() { return "WEB"; },
    getSDKVersion: function() { return "7.1"; },
    getSupportedAPIs: function() { return ["loadBannerAdAsync","getInterstitialAdAsync","getRewardedVideoAsync"]; },
    getEntryPointData: function() { return null; },
    getEntryPointAsync: function() { return Promise.resolve("admin_message"); },
    logEvent: _noop,
    shareAsync: _pp,
    updateAsync: _pp,
    switchGameAsync: _pp,
    canCreateShortcutAsync: function() { return Promise.resolve(false); },
    createShortcutAsync: _pp,
    getInterstitialAdAsync: _adStub,
    getRewardedVideoAsync: _adStub,
    loadBannerAdAsync: _pp,
    hideBannerAdAsync: _pp,
    getLeaderboardAsync: function() {
      return Promise.resolve({
        setScoreAsync: _pp,
        getEntriesAsync: function() { return Promise.resolve({ getEntries: function() { return []; } }); },
        getPlayerEntryAsync: function() { return Promise.resolve(null); },
        getEntryCountAsync: function() { return Promise.resolve(0); }
      });
    },
    onPause: _noop,
    quit: _noop
  };
  window.minigame = window.FBInstant;
  window.minigameLoader = window.FBInstant;

  window.MiniGameAds = {
    showInterstitial: _pp, showRewardedVideo: _pp,
    showBanner: _pp, hideBanner: _pp,
    isRewardvideoReady: function() { return true; },
    isInterstitialReady: function() { return true; },
    isBannerReady: function() { return false; },
    load: _noop
  };
  window.MinigameAds = window.MiniGameAds;
  window.MiniGameAnalytics = { init: _noop, onGameEvent: _pp };
  window.Analytics = window.MiniGameAnalytics;
  window.MiniGameInfo = { commonInfo: null, init: _pp };
  window.MiniGameEvent = {
    init: _noop,
    onLevelStart: _noop,
    onLevelFinished: function() { return Promise.resolve(); }
  };
  window.minigamePlatform = "minigame";
  window.minigameConfig = {};

  window.sendBugLog = {
    bugInfoHttp: _noop,
    updateGameErrorType: _noop
  };

  console.log("[game-dl] FBInstant & MiniGame SDK stubs active");

  var _origGBI = Document.prototype.getElementById;
  Document.prototype.getElementById = function(id) {
    var el = _origGBI.call(this, id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.style.display = "none";
      el.dataset.mgPlaceholder = "1";
      if (document.body) document.body.appendChild(el);
    }
    return el;
  };

  if (typeof window.sdkName === "undefined") window.sdkName = "FaceBook";
  if (typeof window.gameServerVersion === "undefined") window.gameServerVersion = "1.0.0";
  if (typeof window.loadProgress === "undefined") window.loadProgress = 0;
  if (typeof window.loadRealProgress === "undefined") window.loadRealProgress = 0;
  if (typeof window.isLoadComplete === "undefined") window.isLoadComplete = false;
  if (typeof window.updateProgress === "undefined") window.updateProgress = null;
  if (typeof window.facebookPlayerid === "undefined") window.facebookPlayerid = null;
})();`;
}

/**
 * CrazyGames SDK v3 本地桩（平台 crazygames 唯一来源）。
 * `background.js` 生成 HTML 时会写入 `${folder}/crazygames-sdk-stub.js`，内容即本函数返回值。
 * 对齐官方 https://sdk.crazygames.com/crazygames-sdk-v3.js：SDK.game / SDK.ad 等顶层 getter、requestAd 回调。
 */
export function getCrazyGamesSdkStub() {
  return `(function() {
  var _noop = function() {};
  var _pp = function() { return Promise.resolve(); };
  var _ppTrue = function() { return Promise.resolve(true); };
  var _ppFalse = function() { return Promise.resolve(false); };
  var _adPlaying = false;
  var _adRequestInProgress = false;
  var _adblockListeners = [];

  function _localData() {
    try {
      var k = "game_dl_crazygames_data";
      var s = localStorage.getItem(k);
      return s ? JSON.parse(s) : {};
    } catch (e) { return {}; }
  }
  function _setLocalData(d) {
    try { localStorage.setItem("game_dl_crazygames_data", JSON.stringify(d)); } catch (e) {}
  }

  function _wrapCb(fn, arg) {
    try { if (typeof fn === "function") fn(arg); } catch (e) { console.warn("[game-dl] ad callback error:", e); }
  }

  function _requestAd(adType, callbacks) {
    var cbs = callbacks || {};
    var errCb = cbs.adError || cbs.adFinished;
    if (_adRequestInProgress) {
      var msg = "An ad request is already in progress";
      console.warn("[game-dl] stub ad:", msg);
      _wrapCb(errCb, { code: "other", message: msg });
      return Promise.resolve(false);
    }
    _adRequestInProgress = true;
    _adPlaying = true;
    _wrapCb(cbs.adStarted);
    return new Promise(function(resolve) {
      setTimeout(function() {
        _adPlaying = false;
        _adRequestInProgress = false;
        _wrapCb(cbs.adFinished);
        resolve(true);
      }, 80);
    });
  }

  function _makeInstance() {
    return {
      environment: "local",
      isQaTool: false,
      postMessage: _noop,
      ad: {
        prefetchAd: function() { return _pp(); },
        requestAd: function(adType, callbacks) { return _requestAd(adType, callbacks); },
        hasAdblock: function() { return _ppFalse(); },
        addAdblockPopupListener: function(fn) {
          if (typeof fn === "function") _adblockListeners.push(fn);
        },
        removeAdblockPopupListener: function(fn) {
          _adblockListeners = _adblockListeners.filter(function(x) { return x !== fn; });
        },
        get isAdPlaying() { return _adPlaying; }
      },
      banner: {
        prefetchBanner: function() { return _ppTrue(); },
        requestBanner: function() { return _ppTrue(); },
        requestResponsiveBanner: function() { return _ppTrue(); },
        prefetchResponsiveBanner: function() { return _ppTrue(); },
        renderPrefetchedBanner: function() { return _ppTrue(); },
        hideBanner: function() { return _pp(); },
        clearBanner: function() { return _pp(); },
        clearAllBanners: function() { return _pp(); },
        requestOverlayBanners: function() { return _pp(); },
        activeBannersCount: 0
      },
      game: {
        link: typeof location !== "undefined" ? location.href.split("?")[0] : "",
        id: "local",
        gameplayStart: _noop,
        gameplayStop: _noop,
        loadingStart: _noop,
        loadingStop: _noop,
        happyTime: _noop,
        happytime: _noop,
        inviteLink: function() { return ""; },
        getInviteParameter: function() { return null; },
        getInviteParam: function() { return null; },
        showInviteButton: function() { return ""; },
        hideInviteButton: _noop,
        addSettingsChangeListener: _noop,
        removeSettingsChangeListener: _noop,
        addJoinRoomListener: _noop,
        removeJoinRoomListener: _noop,
        updateRoom: _noop,
        leftRoom: _noop,
        settings: { disableChat: false, muteAudio: false },
        isInstantJoin: false,
        isInstantMultiplayer: false
      },
      user: {
        isUserAccountAvailable: true,
        systemInfo: {
          browser: { name: "local", version: "1" },
          countryCode: "US",
          locale: "en-US",
          os: { name: "local", version: "1" },
          device: { type: "desktop" },
          applicationType: "web"
        },
        getUser: function() { return Promise.resolve(null); },
        showAuthPrompt: function() { return Promise.resolve(null); },
        showAccountLinkPrompt: function() { return Promise.resolve({ response: "no" }); },
        addAuthListener: _noop,
        removeAuthListener: _noop,
        getUserToken: function() { return Promise.resolve("local-token"); },
        getXsollaUserToken: function() { return Promise.resolve("local-xsolla-token"); },
        submitScore: _noop,
        addScore: _noop,
        addScoreEncrypted: _noop,
        listFriends: function() { return Promise.resolve({ friends: [], page: 1, size: 0, hasMore: false, total: 0 }); }
      },
      data: {
        clear: function() { _setLocalData({}); },
        getItem: function(key) { return _localData()[key] || null; },
        setItem: function(key, val) {
          var o = _localData();
          o[key] = val;
          _setLocalData(o);
        },
        removeItem: function(key) {
          var o = _localData();
          delete o[key];
          _setLocalData(o);
        },
        syncUnityGameData: _noop
      },
      analytics: {
        trackEvent: _noop,
        trackOrder: _noop
      }
    };
  }

  var CrazySDKClass = function() {};
  CrazySDKClass.prototype.init = function() {
    console.log("[game-dl] CrazyGames CrazySDK.init (stub)");
    return _pp();
  };
  CrazySDKClass.prototype._inst = null;
  Object.defineProperty(CrazySDKClass.prototype, "instance", {
    get: function() {
      if (!this._inst) this._inst = _makeInstance();
      return this._inst;
    }
  });
  Object.defineProperty(CrazySDKClass.prototype, "ad", {
    get: function() { return this.instance.ad; }
  });
  Object.defineProperty(CrazySDKClass.prototype, "banner", {
    get: function() { return this.instance.banner; }
  });
  Object.defineProperty(CrazySDKClass.prototype, "game", {
    get: function() { return this.instance.game; }
  });
  Object.defineProperty(CrazySDKClass.prototype, "user", {
    get: function() { return this.instance.user; }
  });
  Object.defineProperty(CrazySDKClass.prototype, "data", {
    get: function() { return this.instance.data; }
  });
  Object.defineProperty(CrazySDKClass.prototype, "analytics", {
    get: function() { return this.instance.analytics; }
  });
  Object.defineProperty(CrazySDKClass.prototype, "environment", {
    get: function() { return this.instance.environment; }
  });
  Object.defineProperty(CrazySDKClass.prototype, "isQaTool", {
    get: function() { return this.instance.isQaTool; }
  });

  var _sdkSingleton = new CrazySDKClass();
  function _attachCrazyGamesApi(obj) {
    if (!obj || typeof obj !== "object") return;
    obj.SDK = _sdkSingleton;
    obj.CrazySDK = CrazySDKClass;
    obj.CrazySDKInstance = _sdkSingleton;
    if (!obj.instance) {
      Object.defineProperty(obj, "instance", {
        configurable: true,
        get: function() { return _sdkSingleton.instance; }
      });
    }
  }

  var _cgObj = (window.CrazyGames && typeof window.CrazyGames === "object") ? window.CrazyGames : {};
  _attachCrazyGamesApi(_cgObj);
  Object.defineProperty(window, "CrazyGames", {
    configurable: true,
    get: function() { return _cgObj; },
    set: function(v) {
      _cgObj = (v && typeof v === "object") ? v : {};
      _attachCrazyGamesApi(_cgObj);
    }
  });
  window.CrazyGamesSDK = _sdkSingleton;

  console.log("[game-dl] CrazyGames SDK stub active");
})();`;
}

/**
 * GamePush 本地兜底：
 * - 避免 onGPInit 中抛错导致 _gpAwaiter 永不 resolve
 * - 避免外部 gamepush.js 无响应导致 Unity 一直等待
 */
export function getGamePushFailsafeScript() {
  return `(function() {
  var MAX_WAIT_MS = 5000;
  var TICK_MS = 100;
  var startedAt = Date.now();
  var originalOnGPInit = null;

  function makeNoopGamePush() {
    function def(name) {
      if (typeof name !== "string") return "";
      if (name.indexOf("Is") === 0 || name.indexOf("Can") === 0 || name.indexOf("Has") === 0) return "false";
      if (/Is[A-Z]/.test(name)) return "false";
      if (name.indexOf("Get") === 0 || name.indexOf("Fetch") === 0 || name.indexOf("List") === 0) return "";
      return "";
    }
    return new Proxy({}, {
      get: function(target, prop) {
        if (typeof prop !== "string") return target[prop];
        if (prop in target) return target[prop];
        var fn = function() { return def(prop); };
        target[prop] = fn;
        return fn;
      }
    });
  }

  function tryResolveGpAwaiter() {
    try {
      if (window._gpAwaiter && typeof window._gpAwaiter.done === "function") {
        window._gpAwaiter.done();
        return true;
      }
    } catch (e) {}
    return false;
  }

  function wrapOnGPInit(fn) {
    if (typeof fn !== "function") return fn;
    return async function(gp) {
      try {
        return await fn(gp);
      } catch (e) {
        console.warn("[game-dl] onGPInit failed, fallback to local mode:", e);
        tryResolveGpAwaiter();
      }
    };
  }

  try {
    Object.defineProperty(window, "onGPInit", {
      configurable: true,
      get: function() { return originalOnGPInit; },
      set: function(fn) { originalOnGPInit = wrapOnGPInit(fn); }
    });
  } catch (e) {}

  if (typeof window.GamePush === "undefined") {
    window.GamePush = makeNoopGamePush();
    console.warn("[game-dl] GamePush global stub enabled");
  }

  var timer = setInterval(function() {
    if (tryResolveGpAwaiter()) {
      clearInterval(timer);
      return;
    }
    if (Date.now() - startedAt >= MAX_WAIT_MS) {
      clearInterval(timer);
      if (tryResolveGpAwaiter()) {
        console.warn("[game-dl] GamePush wait timed out, continue without SDK");
      }
    }
  }, TICK_MS);

  (function patchToUnity() {
    var n = 0;
    var iv = setInterval(function() {
      n++;
      var C = window.GamePushUnity;
      if (C && C.prototype && typeof C.prototype.toUnity === "function") {
        clearInterval(iv);
        if (C.prototype.__gameDlToUnityPatched) return;
        C.prototype.__gameDlToUnityPatched = true;
        var _t = C.prototype.toUnity;
        C.prototype.toUnity = function(e) {
          var r = _t.call(this, e);
          if (r === undefined || r === null) return "";
          return r;
        };
        console.log("[game-dl] GamePushUnity.toUnity patched (undefined -> empty string)");
      }
      if (n > 120) clearInterval(iv);
    }, 50);
  })();
})();`;
}
