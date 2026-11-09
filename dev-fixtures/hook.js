var ReflowHook = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/preload/hook-source.ts
  var hook_source_exports = {};
  __export(hook_source_exports, {
    installPageHooks: () => installPageHooks
  });
  function installPageHooks(nonce) {
    const report = (payload) => {
      try {
        window.postMessage({ __reflow: nonce, payload: { ...payload, ts: Date.now() } }, "*");
      } catch {
      }
    };
    const looksLikeJson = (text) => {
      const t = text.trim();
      return t.startsWith("{") && t.endsWith("}") || t.startsWith("[") && t.endsWith("]");
    };
    const safeParse = (text) => {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    };
    const RawXHR = window.XMLHttpRequest;
    const rawOpen = RawXHR.prototype.open;
    const rawSend = RawXHR.prototype.send;
    RawXHR.prototype.open = function(method, url, ...rest) {
      ;
      this.__reflow = {
        method: String(method).toUpperCase(),
        url: String(url)
      };
      return rawOpen.apply(this, [method, url, ...rest]);
    };
    RawXHR.prototype.send = function(...args) {
      const meta = this.__reflow;
      if (meta) {
        this.addEventListener("loadend", () => {
          try {
            const text = this.responseText;
            if (!text) return;
            report({
              kind: "xhr",
              url: meta.url,
              method: meta.method,
              status: this.status,
              body: looksLikeJson(text) ? safeParse(text) : text
            });
          } catch {
          }
        });
      }
      return rawSend.apply(this, args);
    };
    const rawFetch = window.fetch;
    window.fetch = function(input, init) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const promise = rawFetch.apply(window, [input, init]);
      promise.then((response) => {
        response.clone().text().then((text) => {
          if (!text) return;
          report({
            kind: "fetch",
            url,
            method,
            status: response.status,
            body: looksLikeJson(text) ? safeParse(text) : text
          });
        }).catch(() => void 0);
      }).catch(() => void 0);
      return promise;
    };
    const CALLBACK_PARAM = /[?&](?:callback|cb|jsonp|jsonpCallback)=([^&]+)/i;
    const wrapJsonpCallback = (script) => {
      const src = script.src;
      if (!src) return;
      const m = CALLBACK_PARAM.exec(src);
      if (!m) return;
      const cbName = decodeURIComponent(m[1]);
      const parts = cbName.split(".");
      let holder = window;
      for (let i = 0; i < parts.length - 1; i++) {
        holder = holder[parts[i]];
        if (!holder) return;
      }
      const leaf = parts[parts.length - 1];
      const original = holder[leaf];
      if (typeof original !== "function") return;
      const originalFn = original;
      let fired = false;
      holder[leaf] = function(...cbArgs) {
        if (!fired) {
          fired = true;
          report({ kind: "jsonp", url: src, body: cbArgs[0] });
        }
        return originalFn.apply(this, cbArgs);
      };
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLScriptElement) wrapJsonpCallback(node);
        }
      }
    });
    observer.observe(document, { childList: true, subtree: true });
    window.__reflowPageSdk = {
      /** 闲鱼/淘宝系 mtop：调用页面自带的 window.lib.mtop.request */
      mtopRequest: (options) => {
        const lib = window.lib;
        const request = lib?.mtop?.request;
        if (typeof request !== "function") {
          return Promise.reject(new Error("window.lib.mtop.request \u4E0D\u5B58\u5728\uFF08\u9875\u9762 SDK \u672A\u5C31\u7EEA\uFF09"));
        }
        return new Promise((resolve, reject) => {
          try {
            const maybePromise = request(
              options,
              (response) => resolve(response),
              (error) => reject(error)
            );
            if (maybePromise && typeof maybePromise.then === "function") {
              ;
              maybePromise.then(resolve).catch(reject);
            }
          } catch (error) {
            reject(error);
          }
        });
      }
    };
  }
  return __toCommonJS(hook_source_exports);
})();
