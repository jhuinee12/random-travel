declare global {
  interface Window {
    kakao?: any;
  }
}

let kakaoLoadPromise: Promise<any> | null = null;

function getKakaoJavascriptKey(): string {
  const key = import.meta.env.VITE_KAKAO_JAVASCRIPT_KEY?.trim();
  if (!key) {
    throw new Error("missing_kakao_javascript_key");
  }
  return key;
}

function loadScriptWithKey(appKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-kakao-sdk="1"]') as HTMLScriptElement | null;
    if (existing) {
      if (window.kakao?.maps) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("kakao_sdk_load_failed")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(appKey)}&autoload=false&libraries=services`;
    script.async = true;
    script.setAttribute("data-kakao-sdk", "1");
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("kakao_sdk_load_failed"));
    document.head.appendChild(script);
  });
}

export async function loadKakaoMapsSdk(): Promise<any> {
  if (window.kakao?.maps?.services) return window.kakao;
  if (!kakaoLoadPromise) {
    kakaoLoadPromise = (async () => {
      const key = getKakaoJavascriptKey();
      await loadScriptWithKey(key);
      if (!window.kakao?.maps) throw new Error("kakao_sdk_missing_maps");
      await new Promise<void>((resolve) => {
        window.kakao.maps.load(() => resolve());
      });
      if (!window.kakao?.maps?.services) throw new Error("kakao_sdk_missing_services");
      return window.kakao;
    })().catch((err) => {
      kakaoLoadPromise = null;
      throw err;
    });
  }
  return kakaoLoadPromise;
}

export {};
