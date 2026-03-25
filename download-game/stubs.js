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

  window.PokiSDK = {
    init: _pp,
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
  console.log("[game-dl] PokiSDK stub active");

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

/** CrazyGames SDK v3 本地桩：模拟 CrazySDK.init / instance（参考 sdk.crazygames.com 公开 API） */
export function getCrazyGamesSdkStub() {
  return `(function() {
  var _noop = function() {};
  var _pp = function() { return Promise.resolve(); };
  var _ppTrue = function() { return Promise.resolve(true); };
  var _ppFalse = function() { return Promise.resolve(false); };

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

  function _makeInstance() {
    return {
      environment: "local",
      isQaTool: false,
      ad: {
        requestAd: function() { return _ppTrue(); },
        hasAdblock: function() { return _ppFalse(); }
      },
      banner: {
        requestBanner: function() { return _ppTrue(); },
        hideBanner: function() { return _pp(); }
      },
      game: {
        gameplayStart: _noop,
        gameplayStop: _noop,
        loadingStart: _noop,
        loadingStop: _noop,
        happyTime: _noop,
        inviteLink: function() { return ""; },
        getInviteParameter: function() { return null; }
      },
      user: {
        getUser: function() { return Promise.resolve(null); },
        showAuthPrompt: function() { return Promise.resolve(null); }
      },
      data: {
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
        }
      },
      analytics: {
        trackEvent: _noop
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

  window.CrazyGames = window.CrazyGames || {};
  window.CrazyGames.CrazySDK = CrazySDKClass;

  if (typeof window.CrazyGamesSDK === "undefined") {
    window.CrazyGamesSDK = window.CrazyGames;
  }

  console.log("[game-dl] CrazyGames SDK stub active");
})();`;
}
