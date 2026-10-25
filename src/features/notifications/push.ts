/** Web Push no navegador: suporte, inscrição e cancelamento. */

export type PushSupport =
  | { kind: "supported" }
  /** iPhone/iPad: push só funciona com o app instalado na Tela de Início (iOS 16.4+). */
  | { kind: "needs-install" }
  | { kind: "unsupported" };

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return { kind: "unsupported" };
  const hasApis = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (isIos() && !isStandalone()) return { kind: "needs-install" };
  return hasApis ? { kind: "supported" } : { kind: "unsupported" };
}

export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Sem service worker o app funciona; só o push fica indisponível.
    });
  });
}

export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (pushSupport().kind !== "supported") return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

export class PushPermissionDenied extends Error {
  constructor() {
    super("Permissão de notificação negada.");
  }
}

/** Pede permissão e inscreve este navegador com a chave VAPID pública. */
export async function subscribeToPush(vapidPublicKey: string): Promise<PushSubscriptionJSON> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new PushPermissionDenied();
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const key = urlBase64ToUint8Array(vapidPublicKey);
  let subscription = await registration.pushManager.getSubscription();
  // Inscrição feita com outra chave VAPID não recebe nada: refaz.
  const currentKey = subscription?.options.applicationServerKey;
  if (subscription && currentKey && !sameBytes(new Uint8Array(currentKey), key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  return subscription.toJSON();
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Nome curto do dispositivo para a lista ("Chrome no Android"). */
export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua) return "Navegador";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Navegador";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : null;
  return os ? `${browser} no ${os}` : browser;
}
