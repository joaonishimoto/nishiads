/*
 * Nishistack Ads: rastreamento de cadastros e outros eventos por anúncio.
 *
 * Cole no <head> de todas as páginas (o código pronto está em Integrações › Rastreamento):
 *   <script>window.nishistack=window.nishistack||function(){(nishistack.q=nishistack.q||[]).push(arguments)};</script>
 *   <script async src="https://ads.nishistack.com/nishistack-ads.js" data-key="CHAVE" data-endpoint="URL"></script>
 *
 * Quando alguém chega com UTM ou fbclid na URL, a origem fica guardada por 90 dias num
 * cookie do domínio principal (vale para site.com e app.site.com). Depois, no app:
 *   nishistack('cadastro', { id: usuario.id })
 * manda o evento com essa origem, e o Nishistack Ads liga ao anúncio.
 */
(function () {
  "use strict";
  var script =
    document.currentScript || document.querySelector('script[src*="nishistack-ads"][data-key]');
  var key = script && script.getAttribute("data-key");
  var endpoint = script && script.getAttribute("data-endpoint");
  var queued = (window.nishistack && window.nishistack.q) || [];
  var TOUCH = "nsads_touch";
  var VISITOR = "nsads_vid";
  var MAX_AGE = 90 * 24 * 60 * 60;
  var FIELDS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"];

  function readCookie(name) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Grava no domínio mais curto que o navegador aceitar (.site.com), como o Google Analytics.
  function writeCookie(name, value) {
    var parts = location.hostname.split(".");
    var base =
      "; path=/; max-age=" +
      MAX_AGE +
      "; SameSite=Lax" +
      (location.protocol === "https:" ? "; Secure" : "");
    var encoded = name + "=" + encodeURIComponent(value);
    for (var i = Math.max(parts.length - 2, 0); i >= 0; i--) {
      document.cookie = encoded + base + "; domain=." + parts.slice(i).join(".");
      if (readCookie(name) === value) return;
    }
    document.cookie = encoded + base;
  }

  function read(name) {
    var value = readCookie(name);
    if (value) return value;
    try {
      return localStorage.getItem(name);
    } catch (e) {
      return null;
    }
  }

  function save(name, value) {
    writeCookie(name, value);
    try {
      localStorage.setItem(name, value);
    } catch (e) {
      /* modo privado */
    }
  }

  function randomId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  // Chegou pelo anúncio: guarda a origem (o último anúncio clicado vale).
  function capture() {
    var params;
    try {
      params = new URLSearchParams(location.search);
    } catch (e) {
      return;
    }
    var touch = null;
    for (var i = 0; i < FIELDS.length; i++) {
      var value = params.get(FIELDS[i]);
      if (value) {
        touch = touch || {};
        touch[FIELDS[i]] = value.slice(0, 300);
      }
    }
    if (!touch) return;
    touch.url = (location.origin + location.pathname).slice(0, 300);
    touch.at = new Date().toISOString();
    save(TOUCH, JSON.stringify(touch));
  }

  function visitor() {
    var id = read(VISITOR);
    if (!id) {
      id = randomId();
      save(VISITOR, id);
    }
    return id;
  }

  function storedTouch() {
    try {
      return JSON.parse(read(TOUCH) || "null");
    } catch (e) {
      return null;
    }
  }

  function send(event, props) {
    if (!key || !endpoint || !event) return;
    var body = JSON.stringify({
      key: key,
      event: String(event),
      id: props && props.id != null ? String(props.id) : undefined,
      event_id: randomId(),
      visitor: visitor(),
      touch: storedTouch(),
    });
    // text/plain não dispara preflight de CORS; sendBeacon sobrevive à troca de página.
    var blob = new Blob([body], { type: "text/plain" });
    if (navigator.sendBeacon && navigator.sendBeacon(endpoint, blob)) return;
    if (window.fetch) {
      fetch(endpoint, {
        method: "POST",
        body: body,
        keepalive: true,
        headers: { "Content-Type": "text/plain" },
      }).catch(function () {});
    }
  }

  capture();
  visitor();
  window.nishistack = function (event, props) {
    send(event, props);
  };
  for (var i = 0; i < queued.length; i++) send(queued[i][0], queued[i][1]);
})();
