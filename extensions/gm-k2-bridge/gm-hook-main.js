(function installK2GmCapture() {
  "use strict";
  if (window.__K2_GM_CAPTURE_INSTALLED__) return;
  window.__K2_GM_CAPTURE_INSTALLED__ = true;

  const allowed = /(?:^|\/)(?:datatables\/(?:position_book_list(?:_new|_forex)?)|ajaxfiles\/get_position_report_filter)\.php(?:[?#]|$)/i;
  const maximumBody = 4_000_000;

  function publish({ url, method, status, contentType, body, transport }) {
    let absolute;
    try { absolute = new URL(url, location.href).href; } catch { return; }
    if (!allowed.test(absolute)) return;
    const responseText = String(body || "").slice(0, maximumBody);
    window.postMessage({
      source: "k2-gm-extractor",
      type: "portfolio-response",
      payload: {
        url: absolute,
        method: String(method || "GET").toUpperCase(),
        status: Number(status) || 0,
        contentType: String(contentType || ""),
        transport,
        responseText,
        truncated: String(body || "").length > maximumBody,
        capturedAt: new Date().toISOString()
      }
    }, location.origin);
  }

  const OriginalXHR = window.XMLHttpRequest;
  if (OriginalXHR) {
    const originalOpen = OriginalXHR.prototype.open;
    const originalSend = OriginalXHR.prototype.send;
    OriginalXHR.prototype.open = function k2Open(method, url, ...rest) {
      this.__k2Method = method;
      this.__k2Url = url;
      return originalOpen.call(this, method, url, ...rest);
    };
    OriginalXHR.prototype.send = function k2Send(...args) {
      if (allowed.test(String(this.__k2Url || ""))) {
        this.addEventListener("load", () => {
          let body = "";
          try { if (!this.responseType || this.responseType === "text") body = this.responseText; } catch { body = ""; }
          publish({
            url: this.responseURL || this.__k2Url,
            method: this.__k2Method,
            status: this.status,
            contentType: this.getResponseHeader("content-type"),
            body,
            transport: "XMLHttpRequest"
          });
        }, { once: true });
      }
      return originalSend.apply(this, args);
    };
  }

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = async function k2Fetch(input, init) {
      const response = await originalFetch.apply(this, arguments);
      const url = typeof input === "string" ? input : input?.url;
      if (allowed.test(String(url || response.url || ""))) {
        response.clone().text().then((body) => publish({
          url: response.url || url,
          method: init?.method || "GET",
          status: response.status,
          contentType: response.headers.get("content-type"),
          body,
          transport: "fetch"
        })).catch(() => {});
      }
      return response;
    };
  }
})();
